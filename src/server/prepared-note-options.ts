import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PreparedNoteOptions, Run, Task } from '../shared.ts';
import { MAX_NOTE_ALTERNATIVES, NOTE_ALTERNATIVE_RANGES, noteAlternativeRange } from '../shared.ts';
import type { Store } from './store.ts';
import type { ReviewClient } from './review.ts';
import { noteOptionContext, noteOptionsKey, parseNoteOptions } from './note-options.ts';
import { taskNoteResults, type NoteRound } from './note-results.ts';
import { taskRoute } from './review.ts';
import { textEdits } from '../../engine/src/core/text-edits.ts';

const execute = promisify(execFile);
const marker = '```papilot-note-options';
export function preparedNoteOptionsInstructions(range: unknown = 'few') {
  const [min, max] = NOTE_ALTERNATIVE_RANGES[noteAlternativeRange(range)];
  return `For manuscript edits the author requests, prepare alternatives during this editing turn, together with the main revision, for the numbered PDF notes in this message. Apply only the preferred proposal to the source. Respect requests for discussion or explanation without editing; this preference does not authorize extra manuscript changes. For each edited note with a meaningful wording choice, aim for ${min}–${max} extra alternatives, excluding the main proposal, now; do not leave generation for the review UI. This is a target range, not a quota: fewer or more useful choices are fine, up to ${MAX_NOTE_ALTERNATIVES}. Never pad the response with repetitive or weak choices. Do not invent alternatives to factual corrections, deletions, or changes that have only one valid result.
After your normal concise summary, append one fenced block whose language is papilot-note-options, containing JSON in this shape:
{"notes":[{"note":1,"current":{"label":"short title","reason":"one concrete sentence"},"options":[{"label":"short title","reason":"one concrete sentence","edits":[{"file":"relative/path.tex","find":"exact source in the final proposed file","replace":"alternative source"}]},{"label":"another short title","reason":"one concrete sentence","edits":[{"file":"relative/path.tex","find":"exact source in the final proposed file","replace":"alternative source"}]}]}]}
The JSON shape above illustrates two alternatives; use the requested range for the actual options array. Use the note numbers in this message (1-based). Use short titles and specific reasons in the note's language, at most 80 and 180 characters respectively. Each find string must occur exactly once in the final source; include unchanged surrounding text to disambiguate it when needed and preserve that context verbatim in replace. Only vary source you changed for that note; keep all other notes' edits, whitespace, citations, facts, quantities, and mathematical meaning intact. Compare your main revision to the original source and keep every unchanged prefix and suffix unchanged in each alternative. For example, if you change "The estimates are stable." to "The estimates exhibit stability.", vary "exhibit stability"; do not add "resulting" before the unchanged word "estimates". For overlapping notes, prepare each note's alternatives against the same final proposed file. Do not apply alternatives or write metadata files. This block is application data shown as choices in the PDF pane, not part of the conversational summary. Omit notes with no meaningful alternatives.`;
}

// Keep the original response in rawText while streaming only the human summary.
// A partly received marker must not briefly flash JSON in the conversation.
export function noteOptionsSummary(text: string) {
  const at = text.indexOf(marker);
  if (at >= 0) return text.slice(0, at).trimEnd();
  const last = text.lastIndexOf('\n');
  const tail = text.slice(last + 1);
  return tail && marker.startsWith(tail) ? text.slice(0, last < 0 ? 0 : last).trimEnd() : text;
}

export function readPreparedNoteOptions(text: string, count: number): PreparedNoteOptions[] {
  const at = text.indexOf(marker);
  if (at < 0 || text.length > 1024 * 1024) return [];
  const body = text.slice(at + marker.length), end = body.indexOf('```');
  if (end < 0) return [];
  let value: any;
  try { value = JSON.parse(body.slice(0, end)); } catch { return []; }
  if (!Array.isArray(value?.notes) || value.notes.length > count) return [];
  const title = (entry: any) => typeof entry?.label === 'string' && Boolean(entry.label.trim()) && entry.label.length <= 80
    && typeof entry.reason === 'string' && Boolean(entry.reason.trim()) && entry.reason.length <= 180 && !entry.reason.includes('\0');
  const seen = new Set<number>();
  return value.notes.filter((entry: any) => {
    if (!Number.isInteger(entry?.note) || entry.note < 1 || entry.note > count || seen.has(entry.note)) return false;
    seen.add(entry.note);
    return title(entry.current) && Array.isArray(entry.options) && entry.options.length <= MAX_NOTE_ALTERNATIVES && entry.options.every((option: any) =>
      title(option) && Array.isArray(option.edits) && option.edits.length > 0 && option.edits.length <= 64 && option.edits.every((edit: any) =>
        typeof edit?.file === 'string' && edit.file.length <= 500 && typeof edit.find === 'string' && edit.find.length > 0 && edit.find.length <= 20000
        && typeof edit.replace === 'string' && edit.replace.length <= 20000 && ![edit.file, edit.find, edit.replace].some(text => text.includes('\0'))));
  });
}

// A minimal diff can align a moved word with the wrong occurrence. When that
// crosses a unit boundary, project against the unchanged source between units
// instead. Only a unique placement of every unchanged gap is safe to use.
function projectPreparedSource(source: string, candidate: string, units: NoteRound['units']) {
  const ranges = units.map(unit => ({ unit, start: unit.text_ops![0][3], end: unit.text_ops![0][4] })).sort((a, b) => a.start - b.start);
  if (!ranges.length) throw new Error('The option changes source outside this note.');
  const prefix = source.slice(0, ranges[0].start), suffix = source.slice(ranges.at(-1)!.end);
  if (!candidate.startsWith(prefix) || !candidate.endsWith(suffix) || candidate.length < prefix.length + suffix.length)
    throw new Error('The option changes source outside this note.');
  const body = candidate.slice(prefix.length, candidate.length - suffix.length);
  const gaps = ranges.slice(1).map((range, i) => source.slice(ranges[i].end, range.start));
  const positions: number[] = [];
  let cursor = 0;
  for (const gap of gaps) {
    const at = body.indexOf(gap, cursor);
    if (at < 0) throw new Error('The option changes source outside this note.');
    positions.push(at); cursor = at + gap.length;
  }
  cursor = body.length;
  for (let i = gaps.length - 1; i >= 0; i--) {
    const at = body.lastIndexOf(gaps[i], cursor - gaps[i].length);
    if (at !== positions[i]) throw new Error('The option source is missing or ambiguous.');
    cursor = at;
  }
  return ranges.map(({ unit }, i) => ({ unit: unit.id, text: body.slice(i ? positions[i - 1] + gaps[i - 1].length : 0, i < gaps.length ? positions[i] : body.length) }));
}

// Resolve source patches to exactly the units linked to this note. Context may
// identify a patch, but it cannot authorize changing another note's source.
export function preparedOptionEdits(option: PreparedNoteOptions['options'][number], units: NoteRound['units'], files: Map<string, string>) {
  const changes = new Map<string, { start: number; end: number; text: string }[]>();
  for (const unit of units) {
    const op = unit.text_ops?.length === 1 && unit.text_ops[0], source = files.get(unit.file);
    if (!op || source === undefined || op[3] < 0 || op[4] < op[3] || op[4] > source.length || source.slice(op[3], op[4]) !== unit.new_text)
      throw new Error('The option source is missing or ambiguous.');
  }
  for (const patch of option.edits) {
    const source = files.get(patch.file);
    if (source === undefined) throw new Error('The option targets an unrelated source file.');
    const at = source.indexOf(patch.find);
    if (at < 0 || source.indexOf(patch.find, at + 1) >= 0) throw new Error('The option source is missing or ambiguous.');
    for (const [, i, j, x, y] of textEdits(patch.find, patch.replace)) {
      const start = at + i, end = at + j;
      const edits = changes.get(patch.file) || [];
      if (edits.some(edit => start <= edit.end && edit.start <= end)) throw new Error('The option has overlapping patches.');
      edits.push({ start, end, text: patch.replace.slice(x, y) });
      changes.set(patch.file, edits);
    }
  }
  const result = new Map(units.map(unit => [unit.id, unit.new_text]));
  for (const [file, edits] of changes) {
    const source = files.get(file)!, ranges = units.filter(unit => unit.file === file).sort((a, b) => a.text_ops![0][3] - b.text_ops![0][3]);
    if (ranges.some((unit, i) => i && ranges[i - 1].text_ops![0][4] > unit.text_ops![0][3])) throw new Error('The option source is missing or ambiguous.');
    edits.sort((a, b) => b.start - a.start);
    const owners = edits.map(edit => ranges.filter(unit => unit.text_ops![0][3] <= edit.start && edit.end <= unit.text_ops![0][4]));
    if (owners.every(matches => matches.length === 1)) {
      edits.forEach((edit, i) => {
        const unit = owners[i][0], offset = unit.text_ops![0][3], text = result.get(unit.id)!;
        result.set(unit.id, text.slice(0, edit.start - offset) + edit.text + text.slice(edit.end - offset));
      });
    } else {
      const candidate = edits.reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source);
      for (const edit of projectPreparedSource(source, candidate, ranges)) result.set(edit.unit, edit.text);
    }
  }
  return units.map(unit => ({ unit: unit.id, text: result.get(unit.id)! }));
}

export async function savePreparedNoteOptions(store: Store, task: Task, run: Run, client: ReviewClient) {
  if (!run.reviewRound || !run.noteOptions?.length) return;
  for (const prepared of run.noteOptions) {
    const key = `${run.id}:${prepared.note - 1}`, cacheKey = noteOptionsKey(task.id, key, run.reviewRound);
    if (store.preference(cacheKey)) continue;
    try {
      const context = await noteOptionContext(store, task, key, client);
      if (context.options.locked || context.options.round !== run.reviewRound || !context.detail.after || !/^[a-f0-9]{40,64}$/.test(context.detail.after)) continue;
      const files = new Map<string, string>();
      for (const file of new Set(context.units.map(unit => unit.file))) {
        const { stdout } = await execute('git', ['-C', task.worktree, 'cat-file', 'blob', `${context.detail.after}:${file}`], { maxBuffer: 8 * 1024 * 1024 });
        files.set(file, stdout);
      }
      const current = { ...context.options.options[0], ...prepared.current };
      const projected = prepared.options.flatMap(option => {
        try { return [{ ...option, edits: preparedOptionEdits(option, context.units, files) }]; }
        catch (error) {
          console.warn('Could not use prepared note option:', task.name, prepared.note, option.label, (error as Error).message);
          return [];
        }
      });
      const alternatives = parseNoteOptions(JSON.stringify({ options: projected }), current, true);
      // Stable IDs and cache survive retries, restarts and later option choices.
      store.savePreference(cacheKey, { ...context.options, options: [current, ...alternatives] });
    } catch (error) {
      // A malformed optional choice must not discard the author's main review.
      console.warn('Could not use prepared note options:', task.name, prepared.note, (error as Error).message);
    }
  }
}

/** Finish the saved choices before the task becomes reviewable. Also covers
 * rebased choices after a local acceptance publishes the next round. */
export async function prepareNoteComparisons(store: Store, task: Task, client: ReviewClient,
  progress: (completed: number, total: number) => void = () => {}, stopped = () => false) {
  const runs = store.runs().filter(run => run.taskId === task.id);
  if (!runs.some(run => run.noteOptions?.length)) return;
  const notes = await taskNoteResults(task, store.items(task.id), runs, client);
  const contexts = [];
  for (const note of notes) {
    if (stopped()) return;
    if (note.round !== task.review?.round || !note.changes.length) continue;
    const context = await noteOptionContext(store, task, note.key, client);
    if (!context.options.locked) contexts.push(context.options);
  }
  const total = contexts.reduce((n, options) => n + options.options.filter(option => option.id !== options.selected).length, 0);
  let completed = 0;
  if (total) progress(completed, total);
  // Keep compilers bounded; each candidate already reuses the published baseline.
  for (const options of contexts) for (const option of options.options) {
    if (stopped()) return;
    if (option.id === options.selected) continue;
    try {
      await client.post(`${taskRoute(task.name)}/source/options/preview`, { id: option.id, round: options.round, edits: option.edits }, 1850000);
      delete option.previewError;
    } catch (error) {
      // A broken optional choice must not discard the main review or spin on
      // every tab switch. An explicit Retry can try rendering it again.
      option.previewError = (error as Error).message;
      console.warn('Could not prepare note comparison:', task.name, option.label, option.previewError);
    }
    if (stopped()) return;
    store.savePreference(noteOptionsKey(task.id, options.key, options.round), options);
    progress(++completed, total);
  }
}
