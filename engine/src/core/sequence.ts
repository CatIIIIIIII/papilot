import type { Op } from "../types.ts";

// Exact string-token correspondence. Unmatchable tokens retain their original
// indices; they become edits when the gaps between equal pairs are emitted.
// Each bit records an increase in an LCS row. Hirschberg reconstruction
// keeps only two rows at a time and chooses the earliest optimal split.
export function equalPairs(a: string[], b: string[]): [number, number][] {
  const out: [number, number][] = [];
  let lo = 0,
    ae = a.length,
    be = b.length;
  while (lo < ae && lo < be && a[lo] === b[lo]) {
    out.push([lo, lo]);
    lo++;
  }
  const suffix: [number, number][] = [];
  while (ae > lo && be > lo && a[ae - 1] === b[be - 1])
    suffix.push([--ae, --be]);
  const av = new Set(a.slice(lo, ae)),
    bv = new Set(b.slice(lo, be));
  const ai: number[] = [],
    bi: number[] = [];
  for (let i = lo; i < ae; i++) if (bv.has(a[i])) ai.push(i);
  for (let i = lo; i < be; i++) if (av.has(b[i])) bi.push(i);
  function row(
    al: number,
    ar: number,
    bl: number,
    br: number,
    reverse: boolean,
  ) {
    const width = br - bl,
      blocks = Math.ceil(width / 32),
      masks = new Map<string, Map<number, number>>();
    for (let j = 0; j < width; j++) {
      const word = b[bi[reverse ? br - 1 - j : bl + j]],
        block = j >>> 5;
      if (!masks.has(word)) masks.set(word, new Map());
      const mask = masks.get(word)!;
      mask.set(block, ((mask.get(block) ?? 0) | (1 << (j & 31))) >>> 0);
    }
    const state = new Uint32Array(blocks);
    for (let i = al; i < ar; i++) {
      const mask = masks.get(a[ai[reverse ? ar - 1 - (i - al) : i]]);
      let carry = 1,
        borrow = 0;
      for (let block = 0; block < blocks; block++) {
        const old = state[block],
          x = ((mask?.get(block) ?? 0) | old) >>> 0,
          y = ((old << 1) | carry) >>> 0;
        const d = x - y - borrow;
        carry = old >>> 31;
        borrow = Number(d < 0);
        state[block] = x & ~d;
      }
    }
    const counts = new Uint32Array(width + 1);
    for (let j = 0; j < width; j++)
      counts[j + 1] = counts[j] + ((state[j >>> 5] >>> (j & 31)) & 1);
    return counts;
  }
  function split(al: number, ar: number, bl: number, br: number): number {
    const mid = (al + ar) >>> 1,
      f = row(al, mid, bl, br, false),
      r = row(mid, ar, bl, br, true);
    let best = -1,
      at = 0;
    for (let j = 0; j <= br - bl; j++) {
      const score = f[j] + r[br - bl - j];
      if (score > best) {
        best = score;
        at = j;
      }
    }
    return bl + at;
  }
  function solve(al: number, ar: number, bl: number, br: number) {
    while (al < ar && bl < br && a[ai[al]] === b[bi[bl]])
      out.push([ai[al++], bi[bl++]]);
    let tail = 0;
    while (al < ar && bl < br && a[ai[ar - 1]] === b[bi[br - 1]]) {
      ar--;
      br--;
      tail++;
    }
    if (al < ar && bl < br) {
      if (ar - al === 1) {
        for (let j = bl; j < br; j++)
          if (a[ai[al]] === b[bi[j]]) {
            out.push([ai[al], bi[j]]);
            break;
          }
      } else {
        const mid = (al + ar) >>> 1,
          at = split(al, ar, bl, br);
        solve(al, mid, bl, at);
        solve(mid, ar, at, br);
      }
    }
    for (let k = 0; k < tail; k++) out.push([ai[ar + k], bi[br + k]]);
  }
  solve(0, ai.length, 0, bi.length);
  for (const pair of suffix.reverse()) out.push(pair);
  return out;
}

/** Complete opcodes, including every token excluded from the match search. */
export function tokenDiff(a: string[], b: string[]): Op[] {
  const result: Op[] = [];
  let i = 0,
    j = 0;
  for (const [x, y] of [...equalPairs(a, b), [a.length, b.length]]) {
    if (x > i || y > j)
      result.push([
        x > i ? (y > j ? "replace" : "delete") : "insert",
        i,
        x,
        j,
        y,
      ]);
    if (x < a.length && y < b.length) {
      const last = result.at(-1);
      if (last?.[0] === "equal" && last[2] === x && last[4] === y) {
        last[2]++;
        last[4]++;
      } else result.push(["equal", x, x + 1, y, y + 1]);
    }
    i = x + 1;
    j = y + 1;
  }
  return result;
}
