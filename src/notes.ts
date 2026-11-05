import { canonicalGroup, GROUP_INSTRUCTIONS, GROUP_NAMES, NOTE_GROUPS, type GroupInstructions } from './note-groups.ts';
import type { Annotation, NoteAnchor, NoteSummary } from './shared.ts';
export type { NoteSummary } from './shared.ts';

// PDF notes reach the agent as one plain-text message. The chat shows that
// message as the notes again, so the format and its reader live together.
const PREAMBLE = 'Revise the manuscript according to these notes the author marked on the compiled PDF.';
const QUOTE = '   PDF text: "', POINT = '   Marked point (‸) in this PDF line: "', REGION = '   Marked region: a figure, equation or other non-text area', NOTE = '\n   Note: ';
const DELETE = 'Delete the marked text.', REPLACE = 'Replace the marked text with: ';
const MARKS = 'A note headed "Delete" or "Replace" asks you to remove exactly the marked text, or to put the given text in its place; change nothing else beyond what grammar and LaTeX then require. A marked point is a place rather than a passage: ‸ shows where it falls in that line.';
const marks = (notes: Pick<NoteSummary, 'kind'>[]) => notes.some(note => note.kind) ? ` ${MARKS}` : '';
// A note's heading ends with its color group, quick note name and kind, in that order.
const heading = (note: NoteSummary) => `${note.where}${note.group ? ` · Color group: ${GROUP_NAMES[note.group]}` : ''}${note.stamp ? ` · Quick note: ${note.stamp}` : ''}${note.kind === 'delete' ? note.comment.trim() ? ' · Replace' : ' · Delete' : ''}`;
const marked = (note: Pick<NoteSummary, 'kind' | 'quote'>) => note.kind === 'point' ? `${POINT}${note.quote}"` : note.quote ? `${QUOTE}${note.quote}"` : REGION;
const comment = (note: Pick<NoteSummary, 'kind' | 'comment'>) => (note.kind === 'delete' ? note.comment.trim() ? REPLACE + note.comment.trim() : DELETE : note.comment.trim()).replace(/\n/g, '\n   ');

const noteWhere = (note: Annotation) => [`Page ${note.page + 1}`, note.source ? `${note.source.file} ${note.source.lines[0] === note.source.lines[1] ? `line ${note.source.lines[0]}` : `lines ${note.source.lines[0]}–${note.source.lines[1]}`}` : '', note.author ? `from ${note.author.name}` : ''].filter(Boolean).join(' · ');
export const summarizeNotes = (notes: Annotation[]): NoteSummary[] => notes.map(note => ({ ...(note.group ? { group: note.group } : {}), ...(note.kind ? { kind: note.kind } : {}), ...(note.stamp ? { stamp: note.stamp } : {}), id: note.id, where: noteWhere(note), quote: note.quote, comment: note.comment, anchor: { sources: note.source ? [{ file: note.source.file, lines: note.source.lines }] : [] } }));

// Also recover anchors from older messages, whose locations were only text.
export function noteAnchor(note: NoteSummary): NoteAnchor {
  if (note.anchor) return note.anchor;
  const round = note.where.match(/^Round (\d+)\b/), sources: NoteAnchor['sources'] = [];
  for (const place of note.where.split(/ · |; /)) {
    const match = place.match(/^(.+?)(?::| lines? )(\d+(?:[–-]\d+)?(?:,\s*\d+(?:[–-]\d+)?)*)$/);
    if (!match) continue;
    for (const range of match[2].split(/,\s*/)) {
      const [start, end] = range.split(/[–-]/).map(Number);
      sources.push({ file: match[1], lines: [start, end ?? start] });
    }
  }
  return { sources, ...(round ? { round: Number(round[1]) } : {}) };
}

export function reviewNotesInstructions(notes: NoteSummary[], request = '') {
  const items = notes.map((note, index) => `${index + 1}. ${heading(note)}\n${marked(note)}${NOTE}${comment(note)}`);
  return `${PREAMBLE}${notes.some(note => note.group) ? ` ${GROUP_INSTRUCTIONS}` : ''}${marks(notes)}${request.trim() ? ` Overall request: ${request.trim()}\n\n` : ''} These notes refer to the displayed review round and its Before, After or Unchanged text. Region coordinates are percentages of the displayed PDF strip (left, top, right, bottom); any quoted text for a region is nearby context. Read the current source before editing. Preserve accepted changes and do not reintroduce rejected edits unless a note explicitly asks for it.\n\n${items.join('\n\n')}`;
}

export function notesInstructions(notes: Annotation[], request = '', groupInstructions: GroupInstructions = {}) {
  const items = notes.map((note, index) => {
    const where = noteWhere(note);
    const source = note.source?.excerpt ? ['   LaTeX source of the marked region:', '   ```latex', ...note.source.excerpt.split('\n').map(line => '   ' + line), '   ```'] : [];
    return [`${index + 1}. ${heading({ ...note, where })}`, ...source, marked(note), `${NOTE.slice(1)}${comment(note)}`].join('\n');
  });
  const scope = request.trim() ? `follow both the overall request and the notes.\n\nOverall request:\n${request.trim()}` : 'change only what the notes ask for.';
  const groups = NOTE_GROUPS.filter(group => groupInstructions[group]?.trim() && notes.some(note => note.group && canonicalGroup(note.group) === group));
  const directions = groups.length ? `\n\nInstructions for color groups (apply only to the attached locations in that group):\n${groups.map(group => `${GROUP_NAMES[group]}:\n   ${groupInstructions[group]!.trim().replace(/\n/g, '\n   ')}`).join('\n')}` : '';
  return `${PREAMBLE}${notes.some(note => note.group) ? ` ${GROUP_INSTRUCTIONS}` : ''}${marks(notes)} SyncTeX mapped each marked region to the LaTeX file and lines that produced it; the PDF text is what the author saw. Read the current source before editing, and ${scope}${directions}\n\n${items.join('\n\n')}`;
}

// The notes in a message written by notesInstructions, or null for any other message.
export function readNotesInstructions(text: string): NoteSummary[] | null {
  if (!text.startsWith(PREAMBLE)) return null;
  const notes: NoteSummary[] = [];
  for (const block of text.split(/\n\n(?=\d+\. )/).slice(1)) {
    const head = block.match(/^\d+\. (.*)\n/);
    if (!head) return null;
    let rest = block.slice(head[0].length);
    if (rest.startsWith('   LaTeX source of the marked region:\n   ```latex\n')) {
      // The excerpt may hold a fence of its own; the closing one is followed by the marked text.
      const end = rest.match(/\n {3}```\n(?= {3}(?:PDF text: "|Marked point \(‸\) in this PDF line: "|Marked region: ))/);
      if (!end) return null;
      rest = rest.slice(end.index! + end[0].length);
    }
    const note = rest.indexOf(NOTE);
    if (note < 0) return null;
    const mark = rest.slice(0, note), point = mark.startsWith(POINT) && mark.endsWith('"');
    if (mark !== REGION && !point && !(mark.startsWith(QUOTE) && mark.endsWith('"'))) return null;
    let where = head[1], text = rest.slice(note + NOTE.length).replace(/\n {3}/g, '\n');
    const deleting = where.endsWith(' · Delete') ? 'delete' : where.endsWith(' · Replace') ? 'replace' : null;
    if (deleting) {
      where = where.slice(0, -(deleting === 'delete' ? ' · Delete' : ' · Replace').length);
      if (deleting === 'delete' ? text !== DELETE : !text.startsWith(REPLACE)) return null;
      text = deleting === 'delete' ? '' : text.slice(REPLACE.length);
    }
    const stamp = where.match(/ · Quick note: ([^·\n]+)$/);
    if (stamp) where = where.slice(0, -stamp[0].length);
    const legacy = where.endsWith(' · Color group: Blue');
    const group = legacy ? 'blue' : NOTE_GROUPS.find(group => where.endsWith(` · Color group: ${GROUP_NAMES[group]}`));
    if (group) where = where.slice(0, -` · Color group: ${legacy ? 'Blue' : GROUP_NAMES[group]}`.length);
    notes.push({ ...(group ? { group } : {}), ...(deleting ? { kind: 'delete' as const } : point ? { kind: 'point' as const } : {}), ...(stamp ? { stamp: stamp[1] } : {}), where, quote: mark === REGION ? '' : mark.slice((point ? POINT : QUOTE).length, -1), comment: text });
  }
  return notes.length ? notes : null;
}
