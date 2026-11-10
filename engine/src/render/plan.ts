import type { Card, Position } from "../types.ts";
import { intersects } from "./pdf.ts";

import { partition } from "../core/rectangles.ts";
export { partition, type Tile } from "../core/rectangles.ts";

export interface Region {
  pairs: [number, number][];
  members: number[];
  old: Position[];
  new: Position[];
}

/** Whether two crops of one version, on the same page, are one place. */
export type SamePlace = (side: "old" | "new", a: Position, b: Position) => boolean;
/** Crops sharing space on either version are one region, across all edits
 * and sections. Corresponding crops stay together even across page breaks.
 * Each region owns the exact union of its footprints on each side. `same`
 * says what sharing space means; by default, overlapping at all. */
export function regions(
  cards: Card[],
  same: SamePlace = (_side, a, b) => intersects(a.clip, b.clip),
): Region[] {
  const groups: Region[] = [];
  cards.forEach((card, i) => {
    const byGroup = new Map<number, Region>();
    card.pairs.forEach((pair, j) => {
      const key = card.aligned ? (pair.group ?? j) : j;
      if (!byGroup.has(key))
        byGroup.set(key, { pairs: [], members: [i], old: [], new: [] });
      const group = byGroup.get(key)!;
      group.pairs.push([i, j]);
      for (const side of ["old", "new"] as const)
        if (pair[side]) group[side].push(pair[side]);
    });
    if (!byGroup.size)
      groups.push({ pairs: [], members: [i], old: [], new: [] });
    else groups.push(...byGroup.values());
  });
  const parents = groups.map((_, i) => i),
    root = (i: number): number => {
      while (parents[i] !== i) {
        parents[i] = parents[parents[i]];
        i = parents[i];
      }
      return i;
    };
  for (const side of ["old", "new"] as const) {
    const crops = groups
      .flatMap((g, i) => g[side].map((p) => ({ ...p, i })))
      .sort((a, b) => a.page - b.page || a.clip[1] - b.clip[1]);
    for (let i = 0; i < crops.length; i++)
      for (let j = i + 1; j < crops.length; j++) {
        const a = crops[i],
          b = crops[j];
        if (a.page !== b.page || b.clip[1] >= a.clip[3]) break;
        if (intersects(a.clip, b.clip) && same(side, a, b))
          parents[root(b.i)] = root(a.i);
      }
  }
  const merged = new Map<number, Region>();
  groups.forEach((group, i) => {
    const key = root(i);
    if (!merged.has(key))
      merged.set(key, { pairs: [], members: [], old: [], new: [] });
    const target = merged.get(key)!;
    target.pairs.push(...group.pairs);
    target.members.push(...group.members);
    target.old.push(...group.old);
    target.new.push(...group.new);
  });
  return [...merged.values()].map((region) => {
    region.members = [...new Set(region.members)].sort((a, b) => a - b);
    for (const side of ["old", "new"] as const) {
      const labels = new Map(region[side].map((p) => [p.page, p.label]));
      region[side] = partition(
        region[side].map((p) => ({ page: p.page, rect: p.clip, value: true })),
        () => true,
      ).map((r) => ({
        page: r.page,
        clip: r.rect,
        label: labels.get(r.page)!,
      }));
    }
    return region;
  });
}
