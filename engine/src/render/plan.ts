import type { Card, Position, Rect } from "../types.ts";
import { intersects } from "./pdf.ts";

export interface Tile<T> {
  page: number;
  rect: Rect;
  value: T;
}

/** Partition a rectangle overlay without growing or losing any of its area.
 * The selector resolves ownership where inputs overlap. Equal neighbours
 * coalesce, so boundaries inside one owner's area do not fragment its view. */
export function partition<T>(
  input: Tile<T>[],
  select: (values: T[]) => T | undefined,
): Tile<T>[] {
  const result: Tile<T>[] = [];
  for (const page of [...new Set(input.map((r) => r.page))].sort(
    (a, b) => a - b,
  )) {
    const rectangles = input.filter(
        (r) =>
          r.page === page && r.rect[2] > r.rect[0] && r.rect[3] > r.rect[1],
      ),
      ys = [...new Set(rectangles.flatMap((r) => [r.rect[1], r.rect[3]]))].sort(
        (a, b) => a - b,
      );
    let previous: Tile<T>[] = [];
    for (let y = 0; y + 1 < ys.length; y++) {
      const top = ys[y],
        bottom = ys[y + 1],
        active = rectangles.filter(
          (r) => r.rect[1] <= top && r.rect[3] >= bottom,
        ),
        xs = [...new Set(active.flatMap((r) => [r.rect[0], r.rect[2]]))].sort(
          (a, b) => a - b,
        ),
        row: Tile<T>[] = [];
      for (let x = 0; x + 1 < xs.length; x++) {
        const left = xs[x],
          right = xs[x + 1],
          values = active
            .filter((r) => r.rect[0] <= left && r.rect[2] >= right)
            .map((r) => r.value),
          value = values.length ? select(values) : undefined;
        if (value === undefined) continue;
        const last = row.at(-1);
        // Touching crops can be adjacent reading lanes. Join across their
        // seam only when an input footprint itself crosses it.
        if (
          last &&
          last.value === value &&
          last.rect[2] === left &&
          active.some((r) => r.rect[0] < left && r.rect[2] > left)
        )
          last.rect[2] = right;
        else row.push({ page, rect: [left, top, right, bottom], value });
      }
      previous = row.map((tile) => {
        const above = previous.find(
          (p) =>
            p.value === tile.value &&
            p.rect[0] === tile.rect[0] &&
            p.rect[2] === tile.rect[2] &&
            p.rect[3] === top,
        );
        if (above) {
          above.rect[3] = bottom;
          return above;
        }
        result.push(tile);
        return tile;
      });
    }
  }
  return result;
}

export interface Region {
  pairs: [number, number][];
  members: number[];
  old: Position[];
  new: Position[];
}

/** Crops sharing space on either version are one region, across all edits
 * and sections. Corresponding crops stay together even across page breaks.
 * Each region owns the exact union of its footprints on each side. */
export function regions(cards: Card[]): Region[] {
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
        if (intersects(a.clip, b.clip)) parents[root(b.i)] = root(a.i);
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
