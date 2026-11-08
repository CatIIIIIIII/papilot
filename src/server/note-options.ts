import { createHash, randomUUID } from 'node:crypto';
import type { NoteOption, NoteOptions, Task } from '../shared.ts';
import type { Store } from './store.ts';
import { sameFragment, taskNoteResults, type NoteRound } from './note-results.ts';
import { taskRoute, type ReviewClient } from './review.ts';

export const noteOptionsKey = (task: string, key: string, round: number) => `note-options:${task}:${round}:${createHash('sha256').update(key).digest('hex')}`;

// Choices remain the same choices after a selection rebuilds the proposal.
// Match source fragments, never their ordinal IDs alone (IDs can be reused).
export function rebaseNoteOptions(options: NoteOption[], previous: NoteRound['units'], next: NoteRound['units'], sameBase = false): NoteOption[] {
  const mapping = new Map<string, string>();
  for (const unit of previous) {
    const matches = next.filter(candidate => sameFragment(unit, candidate, sameBase));
    if (matches.length === 1) mapping.set(unit.id, matches[0].id);
  }
  return options.filter(option => option.id !== 'latest').flatMap(option => {
    const edits = option.edits.map(edit => ({ ...edit, unit: mapping.get(edit.unit) || '' }));
    return edits.length === next.length && edits.every(edit => edit.unit) && new Set(edits.map(edit => edit.unit)).size === next.length ? [{ ...option, edits }] : [];
  });
}

export function selectedNoteOptions(choices: NoteOption[], current: NoteOption) {
  const selected = choices.find(option => option.edits.length === current.edits.length && option.edits.every(edit => current.edits.some(actual => actual.unit === edit.unit && actual.text === edit.text)));
  // Overlapping notes can produce a combination that is none of this note's
  // original choices. Show that actual combination without losing the choices.
  return selected ? { options: choices, selected: selected.id } : { options: [{ ...current, id: 'latest' }, ...choices], selected: 'latest' };
}

export function parseNoteOptions(text: string, current: NoteOption): NoteOption[] {
  const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
  if (!Array.isArray(value.options) || value.options.length !== 2) throw new Error('The agent did not return two usable options. Try again.');
  const signatures = new Set([JSON.stringify(current.edits)]);
  return value.options.map((entry: any) => {
    if (typeof entry?.label !== 'string' || !entry.label.trim() || entry.label.length > 80 || !Array.isArray(entry.edits)
      || entry.edits.length !== current.edits.length || new Set(entry.edits.map((edit: any) => edit?.unit)).size !== current.edits.length)
      throw new Error('The agent returned an incomplete option. Try again.');
    if (typeof entry.reason !== 'string' || !entry.reason.trim() || entry.reason.length > 180 || entry.reason.includes('\0'))
      throw new Error('Each option needs a brief, specific reason. Try again.');
    const edits = current.edits.map(original => {
      const edit = entry.edits.find((edit: any) => edit?.unit === original.unit);
      if (!edit || typeof edit.text !== 'string' || edit.text.includes('\0') || edit.text.length > 20000) throw new Error('The option includes an invalid change. Try again.');
      return { unit: original.unit, text: edit.text };
    });
    const signature = JSON.stringify(edits);
    if (signatures.has(signature)) throw new Error('The agent repeated an option. Try again.');
    signatures.add(signature);
    return { id: randomUUID(), label: entry.label.trim(), reason: entry.reason.trim(), edits };
  });
}

export async function noteOptionContext(store: Store, task: Task, key: string, client: ReviewClient) {
  const notes = await taskNoteResults(task, store.items(task.id), store.runs().filter(run => run.taskId === task.id), client);
  const note = notes.find(note => note.key === key);
  if (!note?.round || !note.changes.length) throw new Error('This note has no linked changes.');
  const [detail, state] = await Promise.all([
    client.get<NoteRound>(`${taskRoute(task.name)}/rounds/${note.round}`),
    client.get<{ decisions: Record<string, string>; latest: number; closed: boolean }>(`${taskRoute(task.name)}/state?round=${note.round}`),
  ]);
  const ids = new Set(note.changes.filter(change => change.round === note.round).flatMap(change => change.units)), units = detail.units.filter(unit => ids.has(unit.id));
  let locked: string | undefined;
  if (note.round !== state.latest || state.closed) locked = 'Options are available on the latest open review.';
  else if (note.changes.some(change => change.round !== note.round || change.state !== 'pending') || units.some(unit => state.decisions[unit.id] !== 'pending')) locked = 'This note includes a reviewed change. Undo that decision before replacing it.';
  else if (units.some(unit => unit.text_ops?.length !== 1 || unit.truncated || unit.whole_file || (unit.kind && unit.kind !== 'text'))) locked = 'Options are not available for this source range yet.';
  else if (task.status !== 'reviewing' || task.pendingReview || task.delivery?.pending || task.reconciliation) locked = 'Wait for the current task and review actions to finish.';
  const current: NoteOption = { id: 'current', label: 'Current proposal', edits: units.map(unit => ({ unit: unit.id, text: unit.new_text })) };
  const cacheKey = noteOptionsKey(task.id, key, note.round);
  let cached = store.preference<NoteOptions>(cacheKey);
  const origin = store.runs().find(run => run.id === note.itemId)?.noteRounds?.[note.index];
  if (!cached && origin) for (let number = note.round - 1; number >= origin; number--) {
    const previous = store.preference<NoteOptions>(noteOptionsKey(task.id, key, number));
    if (!previous) continue;
    const old = await client.get<NoteRound>(`${taskRoute(task.name)}/rounds/${number}`);
    const oldIds = new Set(previous.options.flatMap(option => option.edits.map(edit => edit.unit)));
    const original = { id: 'current', label: 'Initial proposal', edits: old.units.filter(unit => oldIds.has(unit.id)).map(unit => ({ unit: unit.id, text: unit.new_text })) };
    const choices = rebaseNoteOptions(previous.options.some(option => option.id === 'current') ? previous.options : [original, ...previous.options], old.units, units, Boolean(old.before && old.before === detail.before));
    if (choices.length) { cached = { ...previous, round: note.round, options: choices }; store.savePreference(cacheKey, cached); }
    break;
  }
  if (cached && !cached.options.some(option => option.id === 'current')) {
    const old = origin && origin < note.round ? await client.get<NoteRound>(`${taskRoute(task.name)}/rounds/${origin}`) : detail;
    const sameBase = Boolean(old.before && old.before === detail.before);
    const originalUnits = old.units.filter(unit => units.some(next => sameFragment(unit, next, sameBase)));
    const original = { id: 'current', label: 'Initial proposal', edits: originalUnits.map(unit => ({ unit: unit.id, text: unit.new_text })) };
    const initial = rebaseNoteOptions([original], old.units, units, sameBase);
    if (initial.length) { cached = { ...cached, options: [...initial, ...cached.options] }; store.savePreference(cacheKey, cached); }
  }
  const choices = cached?.options.filter(option => option.id === 'current' || (option.id !== 'latest' && typeof option.reason === 'string' && option.reason.trim())) || [current];
  const options: NoteOptions = { before: Object.fromEntries(units.map(unit => [unit.id, unit.old_text])), round: note.round, key, ...selectedNoteOptions(choices.length ? choices : [current], current), ...(locked ? { locked } : {}) };
  return { note, notes, units, options, detail };
}
