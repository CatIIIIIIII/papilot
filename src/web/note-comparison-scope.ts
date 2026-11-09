import type { Block, RoundDetail } from '../../engine/src/types.ts';

/** The drawer compares the current note's visual groups, not every change in
 * the round. Keep their native PDF context and neighboring edits within the
 * same crop, but only the note's own units receive highlights. */
export function noteComparisonScope(detail: RoundDetail, focus: string[]) {
  const focused = new Set(focus);
  const select = (blocks: Block[]) => {
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
  const sourceIds = new Set([...focus, ...groups.flatMap(block => block.kind === 'change' ? block.units : [])]);
  return {
    sections: detail.sections.map(section => ({ ...section, blocks: select(section.blocks) })).filter(section => section.blocks.length),
    loose: select(detail.loose),
    units: detail.units.filter(unit => sourceIds.has(unit.id)),
  };
}
