import type { Rect } from "../types.ts";

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
