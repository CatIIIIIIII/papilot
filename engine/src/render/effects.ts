import { tokenDiff as opcodes } from "../core/sequence.ts";
import { JOIN_GAP, snap, type Strips } from "./inline.ts";
import { headingAt, laneAt, laneX, textBounds, type Build } from "./locate.ts";
import { containsCenter, union, type PdfDocument } from "./pdf.ts";
import {
  extract,
  mergeRects,
  pixelDifference,
  tokenGlyphs,
  tokens,
  type Glyph,
  type Token,
} from "./pdfdiff.ts";
import type {
  Card,
  Effect,
  Op,
  Mark,
  Pair,
  Place,
  PlaceView,
  Position,
  Rect,
  Strip,
} from "../types.ts";
// An edit can change the PDF away from its own lines: a redefined macro
// changes every use, a new equation renumbers the later ones and their
// references, a new citation adds a bibliography entry. The documents are
// therefore compared whole, word by word. Which edits cause each change is
// found by compiling (publish.ts), and every edit lists the places it changes
// away from its own crops under its own card.

// The words in a run that pins the documents together.
const SPAN = 8;
// A moved run is at least this many letters and digits, git's rule for moved
// blocks. Candidate discovery uses exact words, including long single words.
const MOVED = 20;
export interface Words {
  document?: PdfDocument;
  glyphs: Glyph[];
  tokens: ReturnType<typeof tokens>;
  /** The tokens of each printed line, as [start, end) ranges. */
  lines: [number, number][];
}
// Repeated edge lines suggest a separate reading flow, but may be body
// text. This is a pairing hint only: no line or glyph is excluded.
export function furniture(document: Pick<PdfDocument, "length" | "page">) {
  const edges = Array.from({ length: document.length }, (_, number) => {
      const page = document.page(number),
        lines = page.lines.filter((l) => l.text.trim());
      if (!lines.length) return [];
      const top = Math.min(...lines.map((l) => l.rect[1])),
        bottom = Math.max(...lines.map((l) => l.rect[3])),
        label = new RegExp(
          `(^|\\s)${page.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`,
          "g",
        );
      return lines
        .filter((l) => l.rect[1] - top < 2 || bottom - l.rect[3] < 2)
        .map((line) => ({
          rect: line.rect,
          key: `${Math.round(line.rect[1])}:${line.text.replace(label, " ").trim().replace(/\s+/g, " ")}`,
        }));
    }),
    pages = new Map<string, Set<number>>();
  edges.forEach((lines, number) =>
    lines.forEach(({ key }) =>
      pages.set(key, (pages.get(key) ?? new Set()).add(number)),
    ),
  );
  return edges.map((lines) =>
    lines
      .filter(({ key }) => key.endsWith(":") || pages.get(key)!.size > 1)
      .map(({ rect }) => rect),
  );
}
const read = new WeakMap<Build, Words>();
// Furniture is only a reading-flow hint. Every printed glyph is retained;
// a word split across pages can refer to glyphs on both sides of a header.
export function words(build: Build): Words {
  const known = read.get(build);
  if (known) return known;
  const document = build.document,
    edges = furniture(document),
    glyphs: Glyph[] = [],
    body: number[] = [],
    edge: number[] = [];
  let pair = 0;
  for (let page = 0; page < document.length; page++)
    for (const line of document.page(page).lines) {
      if (!line.text.trim()) continue;
      const target = edges[page].some((r) => containsCenter(r, line.rect))
        ? edge
        : body;
      for (const glyph of extract(document, [
        { page, clip: line.rect, label: document.page(page).label },
      ])[0]) {
        target.push(glyphs.length);
        glyphs.push({ ...glyph, pair });
      }
      pair++;
    }
  function tokenize(ids: number[], flow: "body" | "edge") {
    const result: Token[] = [];
    let wasWord = false,
      joinNext = false;
    ids.forEach((id, k) => {
      const g = glyphs[id],
        a = glyphs[ids[k - 1]],
        b = glyphs[ids[k + 1]];
      if (
        flow === "body" &&
        g.text === "-" &&
        a &&
        b &&
        /\p{L}/u.test(a.text) &&
        /\p{Ll}/u.test(b.text) &&
        a.pair !== b.pair
      ) {
        result.at(-1)!.glyphs!.push(id);
        result.at(-1)!.end = id + 1;
        joinNext = true;
        return;
      }
      const word = /[\p{L}\p{N}_]/u.test(g.text);
      if (result.length && word && wasWord && (!g.space || joinNext)) {
        const token = result.at(-1)!;
        token.text += g.text;
        token.glyphs!.push(id);
        token.semanticGlyphs!.push(id);
        token.end = id + 1;
      } else
        result.push({
          text: g.text,
          start: id,
          end: id + 1,
          glyphs: [id],
          semanticGlyphs: [id],
          flow,
        });
      wasWord = word;
      joinNext = false;
    });
    return result;
  }
  const list = [...tokenize(body, "body"), ...tokenize(edge, "edge")].sort(
      (a, b) => a.start - b.start,
    ),
    ranges: [number, number][] = [];
  list.forEach((token, i) => {
    const line = glyphs[token.start].pair;
    ranges[line] = [ranges[line]?.[0] ?? i, i + 1];
  });
  const result = {
    document,
    glyphs,
    tokens: list,
    lines: ranges.filter(Boolean),
  };
  read.set(build, result);
  return result;
}
export interface Comparison {
  /** For each line of the old document, the equal line of the new one, or -1. */
  match: Int32Array;
  /** For each word of the old document, the equal word of the new one, or -1. */
  tokens: Int32Array;
  /** All equal word pairs, including words that moved out of order. */
  paired: Int32Array;
  /** Changed words, without runs that only moved. */
  changes: Effect[];
}
const compared = new WeakMap<Words, WeakMap<Words, Comparison>>();
export function differences(a: Words, b: Words): Effect[] {
  return comparison(a, b).changes;
}
// The whole comparison of two documents, computed once per pair: the edits'
// crops, their marks and the effects elsewhere all come from it.
export function comparison(a: Words, b: Words): Comparison {
  const known = compared.get(a)?.get(b);
  if (known !== undefined) return known;
  const result = compare(a, b);
  if (!compared.has(a)) compared.set(a, new WeakMap());
  compared.get(a)!.set(b, result);
  return result;
}
// The longest chain of pairs increasing in both coordinates; pairs come
// sorted by the first.
function increasing(pairs: [number, number][]) {
  const tails: number[] = [],
    links = new Int32Array(pairs.length).fill(-1);
  pairs.forEach(([, j], k) => {
    let lo = 0,
      hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < j) lo = mid + 1;
      else hi = mid;
    }
    if (lo) links[k] = tails[lo - 1];
    tails[lo] = k;
  });
  const chain: [number, number][] = [];
  for (let k = tails.at(-1) ?? -1; k >= 0; k = links[k]) chain.push(pairs[k]);
  return chain.reverse();
}
// Monotone correspondence within one reading flow. Unique runs anchor the
// exact comparison without imposing any deadline or fallback result.
function monotone(ta: string[], tb: string[]): Int32Array {
  const gram = (list: string[], i: number) =>
      list.slice(i, i + SPAN).join("\u0000"),
    counts = (list: string[]) => {
      const map = new Map<string, number>();
      for (let i = 0; i + SPAN <= list.length; i++) {
        const key = gram(list, i);
        map.set(key, (map.get(key) ?? 0) + 1);
      }
      return map;
    },
    inA = counts(ta),
    inB = counts(tb),
    whereB = new Map<string, number>(),
    unique: [number, number][] = [];
  for (let j = 0; j + SPAN <= tb.length; j++) {
    const key = gram(tb, j);
    if (inB.get(key) === 1) whereB.set(key, j);
  }
  for (let i = 0; i + SPAN <= ta.length; i++) {
    const key = gram(ta, i);
    if (inA.get(key) === 1 && whereB.has(key))
      unique.push([i, whereB.get(key)!]);
  }
  const blocks: [number, number, number][] = [];
  let endA = 0,
    endB = 0;
  for (const [i, j] of increasing(unique)) {
    if (i < endA || j < endB) continue;
    let back = 0,
      ahead = SPAN;
    while (
      i - back > endA &&
      j - back > endB &&
      ta[i - back - 1] === tb[j - back - 1]
    )
      back++;
    while (
      i + ahead < ta.length &&
      j + ahead < tb.length &&
      ta[i + ahead] === tb[j + ahead]
    )
      ahead++;
    blocks.push([i - back, j - back, back + ahead]);
    [endA, endB] = [i + ahead, j + ahead];
  }
  const pairs = new Int32Array(ta.length).fill(-1);
  let previousA = 0,
    previousB = 0;
  for (const [i, j, n] of [...blocks, [ta.length, tb.length, 0]]) {
    for (const [kind, p, q, r] of opcodes(
      ta.slice(previousA, i),
      tb.slice(previousB, j),
    ))
      if (kind === "equal")
        for (let k = p; k < q; k++)
          pairs[previousA + k] = previousB + r + k - p;
    for (let k = 0; k < n; k++) pairs[i + k] = j + k;
    [previousA, previousB] = [i + n, j + n];
  }
  return pairs;
}
function compare(a: Words, b: Words): Comparison {
  const ta = a.tokens.map((t) => t.text),
    tb = b.tokens.map((t) => t.text),
    // A hint must give the same priority to equal text on both sides. A line
    // can cease to repeat after editing, without turning its punctuation into
    // a stronger anchor than the identical punctuation in the other PDF.
    edgeText = new Set(
      [...a.tokens, ...b.tokens]
        .filter((t) => t.flow === "edge")
        .map((t) => t.text),
    ),
    body = (w: Words) =>
      w.tokens.flatMap((t, i) => (edgeText.has(t.text) ? [] : [i])),
    ia = body(a),
    ib = body(b),
    tokenMatch = new Int32Array(ta.length).fill(-1),
    match = new Int32Array(a.lines.length).fill(-1),
    changed: Op[] = [];
  // Repeated headers may move past body text on reflow. Establish the main
  // reading flow first; margin hints never remove text from the comparison.
  const bodyPairs = monotone(
    ia.map((i) => ta[i]),
    ib.map((j) => tb[j]),
  );
  let run: [number, number][] = [],
    previous = -1;
  const pin = () => {
    if (run.length >= SPAN) for (const [i, j] of run) tokenMatch[i] = j;
    run = [];
  };
  bodyPairs.forEach((j, i) => {
    if (j < 0) {
      pin();
      return;
    }
    if (run.length && j !== previous + 1) pin();
    run.push([ia[i], ib[j]]);
    previous = j;
  });
  pin();
  const primary = Array.from(tokenMatch).flatMap((j, i) =>
    j >= 0 ? [[i, j]] : [],
  );
  let previousA = 0,
    previousB = 0;
  for (const [i, j] of [...primary, [ta.length, tb.length]]) {
    for (const [kind, p, q, r] of opcodes(
      ta.slice(previousA, i),
      tb.slice(previousB, j),
    ))
      if (kind === "equal")
        for (let k = p; k < q; k++)
          tokenMatch[previousA + k] = previousB + r + k - p;
    [previousA, previousB] = [i + 1, j + 1];
  }
  previousA = previousB = 0;
  for (const [i, j] of [
    ...Array.from(tokenMatch).flatMap((j, i) => (j >= 0 ? [[i, j]] : [])),
    [ta.length, tb.length],
  ]) {
    if (i > previousA || j > previousB)
      changed.push([
        i === previousA ? "insert" : j === previousB ? "delete" : "replace",
        previousA,
        i,
        previousB,
        j,
      ]);
    [previousA, previousB] = [i + 1, j + 1];
  }
  // A line is equal when its words pair, in order, with exactly the words of
  // one line of the other document.
  const lineOf = new Int32Array(b.tokens.length);
  b.lines.forEach(([x, y], line) => lineOf.fill(line, x, y));
  a.lines.forEach(([i, j], line) => {
    const first = tokenMatch[i];
    if (first < 0) return;
    const other = lineOf[first],
      [x, y] = b.lines[other];
    if (x !== first || y - x !== j - i) return;
    for (let k = i; k < j; k++) if (tokenMatch[k] !== first + k - i) return;
    match[line] = other;
  });
  // Words that left one place and arrived at another moved; pagination may
  // split such a run or hyphenate it anew, so a removed run and an added run
  // move together when enough of the removed run's runs of words recur in the
  // added one. Inside a moved pair, the words that pair up are not changes;
  // the rest of it, an edit made while moving the text, still is.
  // Exact words nominate candidates; the full comparison verifies a moved run.
  const paired = tokenMatch.slice();
  const seeds = (list: string[], i: number, j: number) => list.slice(i, j),
    long = (list: string[], i: number, j: number) =>
      list
        .slice(i, j)
        .join("")
        .replace(/[^\p{L}\p{N}]/gu, "").length >= MOVED,
    movedOld = new Uint8Array(ta.length),
    movedNew = new Uint8Array(tb.length);
  const remaining = (side: "old" | "new", moved: Uint8Array) => {
    const result: [number, number][] = [];
    for (const op of changed) {
      const [start, end] = side === "old" ? [op[1], op[2]] : [op[3], op[4]];
      let first = start;
      for (let t = start; t <= end; t++) {
        if (t < end && !moved[t]) continue;
        if (first < t) result.push([first, t]);
        first = t + 1;
      }
    }
    return result;
  };
  // Consume only equal token occurrences, not an entire compound run. A
  // residual run may move again within the same pair (for example AB -> BA).
  // Every successful pass consumes tokens, so this needs no retry budget.
  for (;;) {
    const removed = remaining("old", movedOld),
      added = remaining("new", movedNew),
      where = new Map<string, Map<number, number>>();
    added.forEach(([x, y], run) => {
      for (const key of seeds(tb, x, y)) {
        if (!where.has(key)) where.set(key, new Map());
        const counts = where.get(key)!;
        counts.set(run, (counts.get(run) ?? 0) + 1);
      }
    });
    let consumed = 0;
    const taken = new Set<number>();
    for (const [i, j] of removed.sort((p, q) => q[1] - q[0] - (p[1] - p[0]))) {
      if (!long(ta, i, j)) continue;
      const keys = seeds(ta, i, j),
        counts = new Map<string, number>(),
        votes = new Map<number, number>();
      for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
      for (const [key, count] of counts)
        for (const [run, occurrences] of where.get(key) ?? [])
          if (!taken.has(run))
            votes.set(run, (votes.get(run) ?? 0) + count * occurrences);
      // A seed ranks a candidate, never proves movement. Try every candidate
      // until an exact equal run satisfies the same length rule as discovery.
      for (const [candidate] of [...votes].sort((p, q) => q[1] - p[1])) {
        const [x, y] = added[candidate],
          ops = opcodes(ta.slice(i, j), tb.slice(x, y));
        if (
          ops.reduce(
            (n, [kind, p, q]) =>
              n +
              (kind === "equal"
                ? ta
                    .slice(i + p, i + q)
                    .join("")
                    .replace(/[^\p{L}\p{N}]/gu, "").length
                : 0),
            0,
          ) < MOVED
        )
          continue;
        for (const [kind, p, q, r] of ops)
          if (kind === "equal") {
            movedOld.fill(1, i + p, i + q);
            movedNew.fill(1, x + r, x + r + (q - p));
            for (let k = p; k < q; k++) paired[i + k] = x + r + k - p;
            consumed += q - p;
          }
        taken.add(candidate);
        break;
      }
    }
    if (!consumed) break;
  }
  // A margin can cross a body anchor, or become body text in the other
  // document. Recover its exact occurrences without weakening body movement.
  const residualA = remaining("old", movedOld).flatMap(([i, j]) =>
      Array.from({ length: j - i }, (_, k) => i + k),
    ),
    residualB = remaining("new", movedNew).flatMap(([i, j]) =>
      Array.from({ length: j - i }, (_, k) => i + k),
    );
  if (
    a.tokens.some((t) => t.flow === "edge") ||
    b.tokens.some((t) => t.flow === "edge")
  )
    monotone(
      residualA.map((i) => ta[i]),
      residualB.map((j) => tb[j]),
    ).forEach((j, i) => {
      if (j < 0) return;
      const x = residualA[i],
        y = residualB[j];
      if (a.tokens[x].flow !== "edge" && b.tokens[y].flow !== "edge") return;
      movedOld[x] = movedNew[y] = 1;
      paired[x] = y;
    });
  // The changed words of a side's range, in runs, without the moved ones.
  const runs = (moved: Uint8Array, from: number, to: number) => {
    const result: [number, number][] = [];
    for (let k = from, start = -1; k <= to; k++)
      if (k < to && !moved[k]) start = start < 0 ? k : start;
      else if (start >= 0) {
        result.push([start, k]);
        start = -1;
      }
    return result;
  };
  return {
    match,
    tokens: tokenMatch,
    paired,
    changes: changed.flatMap(([, i, j, x, y]): Effect[] => {
      const olds = runs(movedOld, i, j),
        news = runs(movedNew, x, y);
      if (olds.length <= 1 && news.length <= 1)
        return olds.length || news.length
          ? [{ old: olds[0] ?? [i, i], new: news[0] ?? [x, x] }]
          : [];
      return [
        ...olds.map((o): Effect => ({ old: o, new: [x, x] })),
        ...news.map((n): Effect => ({ old: [i, i], new: n })),
      ];
    }),
  };
}
const glyphsOf = (w: Words, [i, j]: [number, number], semantic = false) =>
  w.tokens
    .slice(i, j)
    .flatMap((t) => tokenGlyphs(t, semantic).map((g) => w.glyphs[g]));
const appearanceOf = (w: Words, range: [number, number]) =>
  glyphsOf(w, range, true).map((g) => g.appearance);
const appearances = new WeakMap<Words, WeakMap<Words, Effect[]>>();
// Metadata proposes a change; aligned visible ink decides it. Baseline-relative
// clips retain script rise while ignoring whole-row translation and wrapping.
function inkDiffers(a: Words, b: Words, i: number, j: number) {
  const left = glyphsOf(a, [i, i + 1], true),
    right = glyphsOf(b, [j, j + 1], true);
  if (!a.document || !b.document || left.length !== right.length) return true;
  return left.some((x, k) => {
    const y = right[k];
    if (x.appearance === y.appearance) return false;
    if (
      !x.origin ||
      !y.origin ||
      x.baseline === undefined ||
      y.baseline === undefined
    )
      return true;
    const ax = [x.origin[0], x.baseline],
      ay = [y.origin[0], y.baseline],
      relative = (g: Glyph, at: number[]): Rect => [
        g.rect[0] - at[0],
        g.rect[1] - at[1],
        g.rect[2] - at[0],
        g.rect[3] - at[1],
      ],
      bounds = union(relative(x, ax), relative(y, ay)),
      clip = (at: number[]): Rect => [
        bounds[0] + at[0] - 1,
        bounds[1] + at[1] - 1,
        bounds[2] + at[0] + 1,
        bounds[3] + at[1] + 1,
      ];
    return (
      pixelDifference(
        a.document!.page(x.page).raster(clip(ax), 2, false, true),
        b.document!.page(y.page).raster(clip(ay), 2, false, true),
        1,
        0,
      ) > 0
    );
  });
}
// Text equality does not imply equal ink: color, typeface and script position
// survive independently of normalization and of pagination/line wrapping.
export function visualDifferences(a: Words, b: Words): Effect[] {
  const cached = appearances.get(a)?.get(b);
  if (cached) return cached;
  const result: Effect[] = [];
  comparison(a, b).paired.forEach((j, i) => {
    if (
      j < 0 ||
      JSON.stringify(appearanceOf(a, [i, i + 1])) ===
        JSON.stringify(appearanceOf(b, [j, j + 1])) ||
      !inkDiffers(a, b, i, j)
    )
      return;
    const last = result.at(-1);
    if (last && last.old[1] === i && last.new[1] === j) {
      last.old[1]++;
      last.new[1]++;
    } else result.push({ old: [i, i + 1], new: [j, j + 1], kind: "visual" });
  });
  if (!appearances.has(a)) appearances.set(a, new WeakMap());
  appearances.get(a)!.set(b, result);
  return result;
}
export function allDifferences(a: Words, b: Words): Effect[] {
  return [...differences(a, b), ...visualDifferences(a, b)];
}
// Every change between two builds, with the cards whose crops show it.
export function changesOf(old: Build, next: Build, cards: Card[]) {
  const a = words(old),
    b = words(next),
    shows = (card: Card, glyphs: Glyph[], side: "old" | "new") =>
      glyphs.length > 0 &&
      glyphs.every((glyph) =>
        card.pairs.some((pair) => {
          const p = pair[side];
          return (
            p !== null &&
            p.page === glyph.page &&
            containsCenter(p.clip, glyph.rect)
          );
        }),
      );
  return allDifferences(a, b).map((effect) => ({
    effect,
    within: cards
      .filter(
        (card) =>
          (effect.old[0] === effect.old[1] ||
            shows(card, glyphsOf(a, effect.old), "old")) &&
          (effect.new[0] === effect.new[1] ||
            shows(card, glyphsOf(b, effect.new), "new")),
      )
      .map((card) => card.id),
  }));
}
// An overlap only identifies a candidate. A variant establishes an effect
// when it replaces exactly that old range with the final text AND appearance.
// Partial contributions remain available for joint attribution.
export function shownBy(
  old: Build,
  variant: Build,
  effects: Effect[],
  final: Build,
) {
  const a = words(old),
    b = words(variant),
    c = words(final),
    changes = allDifferences(a, b),
    identity = (w: Words, range: [number, number]) =>
      JSON.stringify([
        w.tokens.slice(...range).map((t) => t.text),
        appearanceOf(w, range),
      ]);
  return effects.map((effect) =>
    changes.some(
      (change) =>
        change.kind === effect.kind &&
        change.old[0] === effect.old[0] &&
        change.old[1] === effect.old[1] &&
        identity(b, change.new) === identity(c, effect.new),
    ),
  );
}
// The lines a run of words occupies, one position per column of each page.
// A side with no words shows the line where they would be.
function positions(build: Build, w: Words, [i, j]: [number, number]) {
  let glyphs = glyphsOf(w, [i, j]);
  if (!glyphs.length) {
    const near = w.tokens[i - 1] ?? w.tokens[i];
    glyphs = near ? tokenGlyphs(near).map((g) => w.glyphs[g]) : [];
  }
  const parts = new Map<string, [number, number, Rect]>();
  for (const glyph of glyphs) {
    const column = build.document.page(glyph.page).column(glyph.rect),
      key = `${glyph.page}:${column}`,
      part = parts.get(key);
    parts.set(key, [
      glyph.page,
      column,
      part ? union(part[2], glyph.rect) : glyph.rect,
    ]);
  }
  return [...parts.values()].map(([number, column, rect]): Position => {
    const page = build.document.page(number),
      [left, right] = textBounds(page),
      [columnLeft, columnRight] = page.columnBounds(column),
      x0 = Math.max(left, columnLeft),
      x1 = Math.min(right, columnRight);
    // Take in every printed line the crop cuts through, so a tall brace or
    // a stacked display is never cut in half.
    let [top, bottom] = [rect[1], rect[3]],
      grown = true;
    while (grown) {
      grown = false;
      for (const line of page.lines) {
        const [a, y0, b, y1] = line.rect;
        if (
          a < x1 &&
          b > x0 &&
          y0 < bottom - 1 &&
          y1 > top + 1 &&
          (y0 < top || y1 > bottom)
        ) {
          [top, bottom] = [Math.min(top, y0), Math.max(bottom, y1)];
          grown = true;
        }
      }
    }
    return {
      page: number,
      clip: [x0, Math.max(0, top - 2), x1, Math.min(page.height, bottom + 2)],
      label: page.label,
    };
  });
}
// The section a point of the PDF belongs to: the last heading before it.
function sectionAt(build: Build, at: number, y: number) {
  let found: [string, number, number] | null = null;
  for (const node of build.outline) {
    const heading = headingAt(build, node);
    if (!heading) continue;
    const [page, top] = heading;
    const before = page < at || (page === at && top <= y);
    if (
      before &&
      (!found || page > found[1] || (page === found[1] && top >= found[2]))
    )
      found = [`${node.number} ${node.title}`.trim(), page, top];
  }
  return found?.[0] ?? null;
}
const near = (a: Position[], b: Position[]) =>
  a.length === b.length &&
  a.every(
    (p, i) =>
      p.page === b[i].page &&
      p.clip[1] <= b[i].clip[3] + JOIN_GAP &&
      b[i].clip[1] <= p.clip[3] + JOIN_GAP,
  );
const merge = (a: Position[], b: Position[]) =>
  a.map((p, i) => ({ ...p, clip: union(p.clip, b[i].clip) }));
// The places each edit changes outside its own crops, in reading order.
// Nearby changes with the same causes share a place.
export function placesOf(
  old: Build,
  next: Build,
  effects: Effect[],
  causes: string[][],
  within: string[][],
) {
  const a = words(old),
    b = words(next),
    drafts = new Map<
      string,
      {
        with: string[];
        left: Position[];
        right: Position[];
        removed: Glyph[];
        added: Glyph[];
      }[]
    >();
  effects.forEach((effect, index) => {
    const left = positions(old, a, effect.old),
      right = positions(next, b, effect.new),
      removed = effect.kind === "visual" ? [] : glyphsOf(a, effect.old),
      added = effect.kind === "visual" ? [] : glyphsOf(b, effect.new);
    for (const id of causes[index]) {
      if (within[index].includes(id)) continue;
      const others = causes[index].filter((other) => other !== id),
        list = drafts.get(id) ?? [],
        last = list.at(-1);
      if (
        last &&
        last.with.join() === others.join() &&
        near(last.left, left) &&
        near(last.right, right)
      ) {
        last.left = merge(last.left, left);
        last.right = merge(last.right, right);
        last.removed.push(...removed);
        last.added.push(...added);
      } else
        list.push({
          with: others,
          left,
          right,
          removed: [...removed],
          added: [...added],
        });
      drafts.set(id, list);
    }
  });
  // The marks are the words the whole comparison found; comparing the crops
  // alone could split a word that is hyphenated differently.
  const marks = (
    glyphs: Glyph[],
    at: Position | undefined,
    kind: Mark["kind"],
  ): Mark[] =>
    at
      ? mergeRects(
          glyphs
            .filter(
              (g) => g.page === at.page && containsCenter(at.clip, g.rect),
            )
            .map((g) => g.rect),
        ).map((rect) => ({ kind, rect }))
      : [];
  const result: Record<string, Place[]> = {};
  for (const [id, list] of drafts)
    result[id] = list.map((draft): Place => {
      const pairs: Pair[] = Array.from(
          { length: Math.max(draft.left.length, draft.right.length) },
          (_, i) => ({
            old: draft.left[i] ?? null,
            new: draft.right[i] ?? null,
            before_marks: marks(draft.removed, draft.left[i], "removed"),
            after_marks: marks(draft.added, draft.right[i], "added"),
          }),
        ),
        shown = draft.right.length ? draft.right : draft.left,
        // The section of the first changed word, which a crop can start
        // above or end below.
        first = draft.added[0] ?? draft.removed[0],
        anchor = first
          ? sectionAt(draft.added[0] ? next : old, first.page, first.rect[1])
          : shown[0]
            ? sectionAt(next, shown[0].page, shown[0].clip[1])
            : null;
      return {
        page: [...new Set(shown.map((p) => p.label))].join(", "),
        section: anchor,
        pairs,
        ...(draft.with.length ? { with: draft.with } : {}),
      };
    });
  return result;
}
export function renderPlace(
  place: Place,
  strips: Strips,
  old: Build,
  next: Build,
): PlaceView {
  const before: Strip[] = [],
    after: Strip[] = [];
  for (const pair of place.pairs)
    for (const [side, build, images, marks] of [
      ["old", old, before, pair.before_marks],
      ["new", next, after, pair.after_marks],
    ] as const) {
      const at = pair[side];
      if (!at) continue;
      const x = laneX(build.document, laneAt(build.document, at.page, at.clip)),
        image = strips.write(
          build.document,
          at.page,
          ...snap(build.document, at.page, at.clip[1], at.clip[3], x),
          marks,
          side,
          x,
        );
      if (image) images.push(image);
    }
  return {
    page: place.page,
    section: place.section,
    before,
    after,
    ...(place.with ? { with: place.with } : {}),
  };
}
