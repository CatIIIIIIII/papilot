import type { ChangeBlock, RoundDetail, Unit } from '../types.ts';

export const whitespaceOnly = (unit: Pick<Unit, 'old_text' | 'new_text'>) =>
  /^[\t \r\n]+$/.test(unit.old_text) && /^[\t \r\n]+$/.test(unit.new_text);

/** Group invisible prose rewrapping with the closest substantive edit in its
 * paragraph. Unit IDs, exact patches and decisions remain intact, including
 * rounds saved by older versions. Never hide an edit or accept it implicitly. */
export function groupFormattingChanges(detail: RoundDetail, source: (file: string) => string | null): RoundDetail {
  if (!detail.loose.some(block => block.identical)) return detail;
  const sections = detail.sections.map(section => ({ ...section, blocks: section.blocks.map(block => block.kind === 'change' ? { ...block, units: [...block.units] } : block) }));
  const loose = detail.loose.map(block => ({ ...block, units: [...block.units] }));
  const blocks = [...sections.flatMap(section => section.blocks.filter((block): block is ChangeBlock => block.kind === 'change')), ...loose];
  const byId = new Map(detail.units.map(unit => [unit.id, unit]));
  const cache = new Map<string, string | null>();
  const read = (file: string) => { if (!cache.has(file)) cache.set(file, source(file)); return cache.get(file)!; };
  const removed = new Set<ChangeBlock>();
  const parents = new Map<string, string>();
  for (const block of loose) {
    if (!block.identical || block.units.length !== 1) continue;
    const unit = byId.get(block.units[0]);
    if (!unit || !whitespaceOnly(unit) || unit.text_ops?.length !== 1) continue;
    const text = read(unit.file), [, start, end] = unit.text_ops[0];
    if (text === null || /\\(?:verb\b|lstinline\b|mintinline\b|obeylines\b|obeyspaces\b|begin\{(?:verbatim\*?|Verbatim|lstlisting|minted)\})/.test(text)) continue;
    let a = start, b = end;
    while (a > 0 && /\s/.test(text[a - 1])) a--;
    while (b < text.length && /\s/.test(text[b])) b++;
    const paragraph = (value: string) => /\n[\t \r]*\n/.test(value);
    if (paragraph(text.slice(a, b)) || paragraph(text.slice(a, start) + unit.new_text + text.slice(end, b))) continue;
    let target: ChangeBlock | undefined, parent = '', nearest = Infinity;
    for (const candidate of blocks) {
      if (candidate.identical || candidate.reflow) continue;
      for (const id of candidate.units) {
        const other = byId.get(id);
        if (!other || other.file !== unit.file || whitespaceOnly(other) || other.text_ops?.length !== 1) continue;
        const [, x, y] = other.text_ops[0], low = Math.min(end, y), high = Math.max(start, x);
        const gap = text.slice(low, high);
        if (paragraph(gap) || /\\(?:begin|end|par|section|subsection|chapter)\b/.test(gap)) continue;
        const distance = Math.max(0, high - low);
        if (distance < nearest) { nearest = distance; target = candidate; parent = id; }
      }
    }
    if (target) { target.units.push(unit.id); removed.add(block); parents.set(unit.id, parent); }
  }
  return { ...detail, units: detail.units.map(unit => parents.has(unit.id) ? { ...unit, formattingFor: parents.get(unit.id) } : unit), sections, loose: loose.filter(block => !removed.has(block)) };
}
