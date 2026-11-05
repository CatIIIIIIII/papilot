export const NOTE_GROUPS = ['yellow', 'green', 'purple', 'orange', 'red'] as const;
// Older saved annotations and review drafts keep their identity; blue is now
// displayed and described as yellow, and is no longer offered in the palette.
export type NoteGroup = typeof NOTE_GROUPS[number] | 'blue';
export type GroupInstructions = Partial<Record<typeof NOTE_GROUPS[number], string>>;
export const canonicalGroup = (group: NoteGroup): typeof NOTE_GROUPS[number] => group === 'blue' ? 'yellow' : group;
export const isNoteGroup = (value: unknown): value is NoteGroup => value === 'blue' || NOTE_GROUPS.includes(value as typeof NOTE_GROUPS[number]);
export function parseGroupInstructions(value: unknown): GroupInstructions {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Use valid instructions for each color group.');
  const result: GroupInstructions = {};
  for (const [key, text] of Object.entries(value)) {
    if (!isNoteGroup(key) || typeof text !== 'string' || text.length > 4000) throw new Error('Use valid instructions for each color group (up to 4000 characters).');
    const group = canonicalGroup(key);
    if (result[group] && result[group] !== text.trim()) throw new Error('Use one instruction for each color group.');
    if (text.trim()) result[group] = text.trim();
  }
  return result;
}
// A deletion says what to do by itself, so its group needs no instruction for it.
export const groupsWithoutInstructions = (notes: { group?: NoteGroup; comment: string; kind?: string }[], instructions: GroupInstructions) =>
  NOTE_GROUPS.filter(group => !instructions[group]?.trim() && notes.some(note => note.group && canonicalGroup(note.group) === group && !note.comment.trim() && note.kind !== 'delete'));
export const GROUP_COLORS: Record<NoteGroup, string> = { yellow: '#eab308', blue: '#eab308', green: '#16a34a', purple: '#a855f7', orange: '#ea860c', red: '#e05260' };
export const GROUP_NAMES: Record<NoteGroup, string> = { yellow: 'Yellow', blue: 'Yellow', green: 'Green', purple: 'Purple', orange: 'Orange', red: 'Red' };
export function noteGroups<T extends { group?: NoteGroup }>(notes: T[]) {
  return NOTE_GROUPS.flatMap(group => {
    const entries = notes.flatMap((note, index) => note.group && canonicalGroup(note.group) === group ? [{ note, index }] : []);
    return entries.length ? [{ group, entries }] : [];
  });
}
export const GROUP_INSTRUCTIONS = 'Color groups are labels only, with no built-in meaning. Apply the author\'s instructions for this message to every marked location in each named color group. Never infer an editing action from a color. If a group\'s intended treatment is unclear, ask the author.';
