import type { Block, RoundDetail, Strip } from '../../engine/src/types.ts';

const focusedMarks = (image: Strip, focus: Set<string>) => (image.marks || []).filter(mark => mark.kind !== 'context' && focus.has(mark.unit));

/** Keep complete nearby text lines around the note's marks. Coordinates stay
 * in the original PDF strip so selection and highlighting remain aligned. */
export function noteComparisonCrop(image: Strip, focus: string[]) {
  const marks = focusedMarks(image, new Set(focus));
  if (!marks.length) return { top: 0, height: image.height };
  let top = Math.max(0, Math.min(...marks.map(mark => mark.rect[1])) - 24);
  let bottom = Math.min(image.height, Math.max(...marks.map(mark => mark.rect[3])) + 24);
  for (const line of image.text || []) {
    if (!line.chars.length) continue;
    const low = Math.min(...line.chars.map(char => char.rect[1])), high = Math.max(...line.chars.map(char => char.rect[3]));
    if (low < bottom && high > top) { top = Math.max(0, Math.min(top, low)); bottom = Math.min(image.height, Math.max(bottom, high)); }
  }
  return { top, height: Math.max(1, bottom - top) };
}

/** Use attributed marks to focus a note inside a shared PDF group. Older
 * comparisons without attribution retain their original groups and context. */
export function noteComparisonScope(detail: RoundDetail, focus: string[]) {
  const focused = new Set(focus);
  const all = [...detail.sections.flatMap(section => section.blocks), ...detail.loose];
  const precise = all.some(block => block.kind === 'change' && block.units.some(id => focused.has(id)) && [...block.before, ...block.after].some(image => focusedMarks(image, focused).length));
  const select = (blocks: Block[]) => {
    if (precise) return blocks.flatMap<Block>(block => {
      if (block.kind !== 'change' || !block.units.some(id => focused.has(id))) return [];
      const before = block.before.filter(image => focusedMarks(image, focused).length), after = block.after.filter(image => focusedMarks(image, focused).length);
      return before.length || after.length ? [{ ...block, units: block.units.filter(id => focused.has(id)), before, after }] : [];
    });
    const included = new Set<number>();
    blocks.forEach((block, index) => {
      if (block.kind !== 'change' || !block.units.some(id => focused.has(id))) return;
      // Source-only changes have no PDF content; they remain in LaTeX view.
      if (!block.before.length && !block.after.length) return;
      included.add(index);
      if (blocks[index - 1]?.kind === 'context') included.add(index - 1);
      if (blocks[index + 1]?.kind === 'context') included.add(index + 1);
    });
    return blocks.filter((_, index) => included.has(index));
  };
  const groups = [...detail.sections.flatMap(section => section.blocks), ...detail.loose]
    .filter(block => block.kind === 'change' && block.units.some(id => focused.has(id)));
  const sourceIds = new Set([...focus, ...(precise ? [] : groups.flatMap(block => block.kind === 'change' ? block.units : []))]);
  return {
    sections: detail.sections.map(section => ({ ...section, blocks: select(section.blocks) })).filter(section => section.blocks.length),
    loose: select(detail.loose),
    units: detail.units.filter(unit => sourceIds.has(unit.id)),
  };
}
