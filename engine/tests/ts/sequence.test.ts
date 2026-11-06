import { expect, it } from "vitest";
import { equalPairs, tokenDiff } from "../../src/core/sequence.ts";

function lcs(a: string[], b: string[]) {
  let previous = Array(b.length + 1).fill(0);
  for (const word of a) {
    const row = [0];
    for (let j = 0; j < b.length; j++)
      row.push(
        word === b[j] ? previous[j] + 1 : Math.max(previous[j + 1], row[j]),
      );
    previous = row;
  }
  return previous[b.length];
}
function verify(a: string[], b: string[]) {
  const pairs = equalPairs(a, b);
  expect(pairs.length).toBe(lcs(a, b));
  pairs.forEach(([i, j], k) => {
    expect(a[i]).toBe(b[j]);
    if (k) {
      expect(i).toBeGreaterThan(pairs[k - 1][0]);
      expect(j).toBeGreaterThan(pairs[k - 1][1]);
    }
  });
  let old = 0,
    next = 0,
    cost = 0;
  const reconstructed: string[] = [];
  for (const [kind, i, j, x, y] of tokenDiff(a, b)) {
    expect([i, x]).toEqual([old, next]);
    if (kind === "equal") {
      expect(a.slice(i, j)).toEqual(b.slice(x, y));
      reconstructed.push(...a.slice(i, j));
    } else {
      cost += j - i + y - x;
      reconstructed.push(...b.slice(x, y));
    }
    old = j;
    next = y;
  }
  expect([old, next]).toEqual([a.length, b.length]);
  expect(reconstructed).toEqual(b);
  expect(cost).toBe(a.length + b.length - 2 * pairs.length);
}
it("reconstructs both sides and minimizes edits for every short binary sequence", () => {
  const lists: string[][] = [[]];
  for (let length = 1; length <= 4; length++)
    for (let bits = 0; bits < 2 ** length; bits++)
      lists.push(Array.from({ length }, (_, i) => String((bits >>> i) & 1)));
  for (const a of lists) for (const b of lists) verify(a, b);
});
it("propagates carries and borrows across bitset word boundaries", () => {
  let seed = 71429;
  const random = () => (seed = (1664525 * seed + 1013904223) >>> 0);
  for (const length of [31, 32, 33, 63, 64, 65, 127, 128, 129, 255, 256, 257]) {
    const a = Array.from({ length }, () => String(random() % 7)),
      b = Array.from({ length: length + 3 }, () => String(random() % 7));
    verify(a, b);
  }
});
