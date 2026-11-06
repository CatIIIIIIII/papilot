import { sharedWords } from "./segments.ts";
import { paintChanges, type PaintAnchor } from "./paint.ts";
import { tokenDiff as opcodes } from "../core/sequence.ts";
import { JOIN_GAP, snap, type Strips } from "./inline.ts";
import { headingAt, laneAt, laneX, textBounds, type Build } from "./locate.ts";
import { containsCenter, union, type PdfDocument } from "./pdf.ts";
import {
  normalize,
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
  DocumentEffect,
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
  /** TeX flow baseline after retaining nested inline-box displacement. */
  baseline?: (glyph: Glyph) => number | undefined;
  segmentation?: object;
  original?: Words;
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
      let space = true;
      for (const char of line.chars)
        for (const text of normalize(char.text)) {
          if (/\s/u.test(text)) {
            space = true;
            continue;
          }
          target.push(glyphs.length);
          glyphs.push({
            text,
            rect: char.rect,
            origin: char.origin,
            appearance: char.appearance,
            space,
            pair,
            page,
          });
          space = false;
        }
      pair++;
    }
  function tokenize(ids: number[], flow: "body" | "edge") {
    const result: Token[] = [];
    let wasWord = false;
    ids.forEach((id, k) => {
      const g = glyphs[id],
        a = glyphs[ids[k - 1]],
        b = glyphs[ids[k + 1]];
      const endHyphen =
        flow === "body" &&
        g.text === "-" &&
        !g.space &&
        a &&
        a.pair === g.pair &&
        /\p{L}/u.test(a.text) &&
        (!b || g.pair !== b.pair);
      if (endHyphen) {
        const token = result.at(-1)!;
        (token.breaks ??= []).push(token.text.length);
      }
      const word = /[\p{L}\p{N}_]/u.test(g.text);
      if (result.length && word && wasWord && !g.space) {
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
          ...(endHyphen ? { hyphen: true } : {}),
          ...(result.at(-1)?.hyphen && word ? { afterHyphen: true } : {}),
        });
      wasWord = word;
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
  const baselineCache = new WeakMap<Glyph, number | undefined>();
  let baselineRows: Map<number, Glyph[]> | undefined;
  const result = {
    document,
    ...(build.locator?.baselines
      ? {
          baseline: (glyph: Glyph) => {
            if (!baselineCache.has(glyph)) {
              if (!baselineRows) {
                baselineRows = new Map();
                for (const g of glyphs) {
                  if (!baselineRows.has(g.pair)) baselineRows.set(g.pair, []);
                  baselineRows.get(g.pair)!.push(g);
                }
              }
              const row = baselineRows.get(glyph.pair)!;
              const values = build.locator.baselines(
                glyph.page,
                row.map((g) => g.origin),
              );
              row.forEach((g, i) => baselineCache.set(g, values[i]));
              baselineRows.delete(glyph.pair);
            }
            return baselineCache.get(glyph);
          },
        }
      : {}),
    glyphs,
    tokens: list,
    lines: ranges.filter(Boolean),
  };
  read.set(build, result);
  return result;
}
export interface Comparison {
  old: Words;
  new: Words;
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
const documentPairs = new WeakMap<Build, WeakMap<Build, Comparison>>();
/** The shared token domain for every stage of a rendered PDF comparison. */
export function compareDocuments(old: Build, next: Build): Comparison {
  const known = documentPairs.get(old)?.get(next);
  if (known) return known;
  const [a, b] = sharedWords(words(old), words(next)),
    result = comparison(a, b);
  if (!documentPairs.has(old)) documentPairs.set(old, new WeakMap());
  documentPairs.get(old)!.set(next, result);
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
      w.tokens.flatMap((t, i) => (edgeText.has(t.text) || t.hyphen ? [] : [i])),
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
    const left = Array.from(
        { length: i - previousA },
        (_, k) => previousA + k,
      ).filter((k) => !a.tokens[k].hyphen),
      right = Array.from(
        { length: j - previousB },
        (_, k) => previousB + k,
      ).filter((k) => !b.tokens[k].hyphen);
    for (const [kind, p, q, r] of opcodes(
      left.map((k) => ta[k]),
      right.map((k) => tb[k]),
    ))
      if (kind === "equal")
        for (let k = p; k < q; k++) tokenMatch[left[k]] = right[r + k - p];
    [previousA, previousB] = [i + 1, j + 1];
  }
  // Discretionary hyphens describe physical line breaks. They must not
  // choose which occurrence of a repeated sentence corresponds. Once its
  // words are paired, retain matching punctuation in the gaps; unmatched
  // hyphens still require the word-reconstruction check below.
  previousA = previousB = 0;
  for (const [i, j] of [
    ...Array.from(tokenMatch).flatMap((j, i) => (j >= 0 ? [[i, j]] : [])),
    [ta.length, tb.length],
  ]) {
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
  const wordParts = [a, b].map((w) => {
    const groups = new Map<number, number[]>();
    w.tokens.forEach((token, i) => {
      if (!token.part) return;
      const group = groups.get(token.part.word) ?? [];
      group.push(i);
      groups.set(token.part.word, group);
    });
    return groups;
  });
  const continuations = () => {
    const back = new Int32Array(tb.length).fill(-1);
    paired.forEach((j, i) => {
      if (j >= 0) back[j] = i;
    });
    const broken = (w: Words, i: number) => {
      const token = w.tokens[i];
      return !!(
        token.breaks?.length ||
        (token.part && w.original?.tokens[token.part.word].breaks?.length)
      );
    };
    return ([a, b] as const).map((w, side) => {
      const mapping = side ? back : paired,
        other = side ? a : b,
        anchored = new Set<number>();
      w.tokens.forEach((t, i) => {
        if (
          t.part &&
          mapping[i] >= 0 &&
          (broken(w, i) || broken(other, mapping[i]))
        )
          anchored.add(t.part.word);
      });
      return new Set(
        w.tokens.flatMap((t, i) =>
          t.part && mapping[i] < 0 && anchored.has(t.part.word) ? [i] : [],
        ),
      );
    });
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
    const [continuedOld, continuedNew] = continuations(),
      reversePaired = new Map<number, number>(),
      taken = new Set<number>();
    paired.forEach((other, at) => {
      if (other >= 0) reversePaired.set(other, at);
    });
    for (const [i, j] of removed.sort((p, q) => q[1] - q[0] - (p[1] - p[0]))) {
      if (
        !long(ta, i, j) &&
        !continuedNew.size &&
        !Array.from(continuedOld).some((t) => t >= i && t < j)
      )
        continue;
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
        const extra = new Map<number, number>(),
          reverseExtra = new Map<number, number>();
        for (const [kind, p, q, r] of ops)
          if (kind === "equal")
            for (let k = p; k < q; k++) {
              extra.set(i + k, x + r + k - p);
              reverseExtra.set(x + r + k - p, i + k);
            }
        const completeWord = (
          w: Words,
          t: number,
          mapping: (i: number) => number,
        ) => {
          const part = w.tokens[t].part;
          if (!part) return false;
          const targets = wordParts[w === a ? 0 : 1]
            .get(part.word)!
            .map(mapping);
          return targets.every(
            (target, index) =>
              target >= 0 && (!index || target > targets[index - 1]),
          );
        };
        // Refinement must not make a permutation of syllables look like a
        // moved word. New piece matches preserve each complete word's order.
        for (;;) {
          let removed = false;
          for (const [old, next] of extra)
            if (
              (a.tokens[old].part &&
                !completeWord(a, old, (t) => extra.get(t) ?? paired[t])) ||
              (b.tokens[next].part &&
                !completeWord(
                  b,
                  next,
                  (t) => reverseExtra.get(t) ?? reversePaired.get(t) ?? -1,
                ))
            ) {
              extra.delete(old);
              reverseExtra.delete(next);
              removed = true;
            }
          if (!removed) break;
        }
        const continuation = [...extra].some(
            ([old, next]) => continuedOld.has(old) || continuedNew.has(next),
          ),
          letters = [...extra.keys()].reduce(
            (n, at) => n + ta[at].replace(/[^\p{L}\p{N}]/gu, "").length,
            0,
          );
        if (!continuation && letters < MOVED) continue;
        for (const [old, next] of extra) {
          movedOld[old] = movedNew[next] = 1;
          paired[old] = next;
          reversePaired.set(next, old);
        }
        consumed += extra.size;
        taken.add(candidate);
        break;
      }
    }
    if (!consumed) break;
  }
  // A line-end hyphen is discretionary only when its surrounding pieces
  // reconstruct the other document's word. It never licenses a text match.
  const reverse = new Int32Array(tb.length).fill(-1);
  paired.forEach((j, i) => {
    if (j >= 0) reverse[j] = i;
  });
  for (const [w, other, mapping, back, moved] of [
    [a, b, paired, reverse, movedOld],
    [b, a, reverse, paired, movedNew],
  ] as const)
    w.tokens.forEach((token, i) => {
      if (!token.hyphen || !i || mapping[i - 1] < 0) return;
      const at = mapping[i - 1],
        part = other.tokens[at].part;
      if (!part || part.index + 1 === part.total) return;
      const pieces = wordParts[other === a ? 0 : 1].get(part.word)!;
      if (
        pieces.every(
          (k, n) => back[k] >= 0 && (!n || back[k] > back[pieces[n - 1]]),
        )
      )
        moved[i] = 1;
    });
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
  // Shared pieces still carry word boundaries. Equal letters do not make
  // inserting or removing an ordinary word space invisible. A physical
  // line-end hyphen can bridge a reading-flow interruption; a space cannot.
  const back = new Int32Array(tb.length).fill(-1);
  paired.forEach((j, i) => {
    if (j >= 0) back[j] = i;
  });
  const inside = (w: Words, left: number, right: number) =>
      !!w.tokens[left]?.part &&
      w.tokens[left].part!.word === w.tokens[right]?.part?.word,
    hyphenAfter = (w: Words, index: number) => {
      const glyphs = tokenGlyphs(w.tokens[index]),
        last = glyphs.at(-1);
      return (
        (last !== undefined && w.glyphs[last]?.text === "-") ||
        !!w.tokens[index + 1]?.hyphen
      );
    },
    bad = new Set<number>();
  paired.forEach((j, i) => {
    if (j < 0) return;
    if (
      i > 0 &&
      inside(a, i - 1, i) &&
      paired[i - 1] >= 0 &&
      !inside(b, paired[i - 1], j) &&
      !hyphenAfter(b, paired[i - 1])
    )
      bad.add(i);
    if (
      j > 0 &&
      inside(b, j - 1, j) &&
      back[j - 1] >= 0 &&
      !inside(a, back[j - 1], i) &&
      !hyphenAfter(a, back[j - 1])
    )
      bad.add(i);
  });
  const boundaries: Effect[] = [...bad].map((i) => {
    const j = paired[i];
    paired[i] = tokenMatch[i] = -1;
    a.lines.forEach(([start, end], line) => {
      if (start <= i && i < end) match[line] = -1;
    });
    return { old: [i, i + 1], new: [j, j + 1] };
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
    old: a,
    new: b,
    match,
    tokens: tokenMatch,
    paired,
    changes: [
      ...changed.flatMap(([, i, j, x, y]): Effect[] => {
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
      ...boundaries,
    ].sort((x, y) => x.old[0] - y.old[0] || x.new[0] - y.new[0]),
  };
}
const glyphsOf = (w: Words, [i, j]: [number, number], semantic = false) =>
  w.tokens
    .slice(i, j)
    .flatMap((t) => tokenGlyphs(t, semantic).map((g) => w.glyphs[g]));
const appearanceOf = (w: Words, range: [number, number]) =>
  glyphsOf(w, range, true).map((g) => g.appearance);
const appearances = new WeakMap<Words, WeakMap<Words, Effect[]>>();
const shifts = new WeakMap<Words, WeakMap<Words, Map<string, number>>>();
const rowKey = (a: Glyph, b: Glyph) => `${a.pair}:${b.pair}`;
const rounded = (n: number) => Math.round(n * 1000) / 1000;
// Align each pair of physical rows using corresponding glyphs. New/removed
// glyphs cannot change this reference, unlike independently inferred baselines.
function rowShifts(a: Words, b: Words) {
  const compared = comparison(a, b);
  a = compared.old;
  b = compared.new;
  const known = shifts.get(a)?.get(b);
  if (known) return known;
  const counts = new Map<
    string,
    Map<number, { count: number; delta: number }>
  >();
  comparison(a, b).paired.forEach((j, i) => {
    if (j < 0) return;
    const left = glyphsOf(a, [i, i + 1], true),
      right = glyphsOf(b, [j, j + 1], true);
    if (left.length !== right.length) return;
    left.forEach((x, k) => {
      const y = right[k];
      if (!x.origin || !y.origin) return;
      const key = rowKey(x, y),
        delta = y.origin[1] - x.origin[1],
        value = rounded(delta);
      if (!counts.has(key)) counts.set(key, new Map());
      const row = counts.get(key)!,
        entry = row.get(value) ?? { count: 0, delta };
      entry.count++;
      row.set(value, entry);
    });
  });
  const result = new Map(
    [...counts].map(([key, row]) => [
      key,
      [...row.values()].sort((a, b) => b.count - a.count)[0].delta,
    ]),
  );
  if (!shifts.has(a)) shifts.set(a, new WeakMap());
  shifts.get(a)!.set(b, result);
  return result;
}
function placementOf(
  a: Words,
  b: Words,
  old: [number, number],
  next: [number, number],
) {
  const left = glyphsOf(a, old, true),
    right = glyphsOf(b, next, true),
    shift = rowShifts(a, b);
  return left.map((x, k) => {
    const y = right[k];
    return x.origin && y?.origin
      ? rounded(y.origin[1] - x.origin[1] - displacement(a, b, x, y, shift))
      : 0;
  });
}
// Source layout removes flow displacement while preserving nested inline
// offsets. Without that structure, keep the matched-row reference.
function displacement(
  a: Words,
  b: Words,
  x: Glyph,
  y: Glyph,
  shifts: Map<string, number>,
) {
  const old = a.baseline?.(x),
    next = b.baseline?.(y);
  return old !== undefined && next !== undefined
    ? next - old
    : (shifts.get(rowKey(x, y)) ?? 0);
}
// Metadata proposes a change; aligned visible ink decides it. The shared
// row displacement preserves relative script placement and ignores reflow.
function inkDiffers(a: Words, b: Words, i: number, j: number) {
  const left = glyphsOf(a, [i, i + 1], true),
    right = glyphsOf(b, [j, j + 1], true),
    shift = rowShifts(a, b);
  if (!a.document || !b.document || left.length !== right.length) return true;
  return left.some((x, k) => {
    const y = right[k],
      delta = displacement(a, b, x, y, shift);
    if (
      x.appearance === y.appearance &&
      (!x.origin ||
        !y.origin ||
        rounded(y.origin[1] - x.origin[1] - delta) === 0)
    )
      return false;
    if (!x.origin || !y.origin) return true;
    const ax = x.origin,
      ay = [y.origin[0], x.origin[1] + delta],
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
  const compared = comparison(a, b);
  a = compared.old;
  b = compared.new;
  const cached = appearances.get(a)?.get(b);
  if (cached) return cached;
  const result: Effect[] = [];
  comparison(a, b).paired.forEach((j, i) => {
    if (
      j < 0 ||
      (JSON.stringify(appearanceOf(a, [i, i + 1])) ===
        JSON.stringify(appearanceOf(b, [j, j + 1])) &&
        placementOf(a, b, [i, i + 1], [j, j + 1]).every((d) => d === 0)) ||
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
// Reuse the text comparison's physical correspondences for compositing.
export function* paintAnchors(compared: Comparison): Generator<PaintAnchor> {
  const { old: a, new: b, paired } = compared;
  for (let i = 0; i < paired.length; i++) {
    const j = paired[i];
    if (j < 0) continue;
    const left = tokenGlyphs(a.tokens[i], true),
      right = tokenGlyphs(b.tokens[j], true);
    if (left.length !== right.length) continue;
    for (let k = 0; k < left.length; k++)
      yield { before: a.glyphs[left[k]], after: b.glyphs[right[k]] };
  }
}
// Every change between two builds, with the cards whose crops show it.
export function changesOf(old: Build, next: Build, cards: Card[]) {
  const compared = compareDocuments(old, next),
    { old: a, new: b } = compared,
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
  const text: { effect: DocumentEffect; within: string[] }[] = allDifferences(
    a,
    b,
  ).map((effect) => ({
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
  const paint = paintChanges(
    old.document,
    next.document,
    paintAnchors(compared),
  ).map((effect) => ({
    effect,
    within: cards
      .filter((card) =>
        (
          [
            ["old", effect.before],
            ["new", effect.after],
          ] as const
        ).every(([side, areas]) =>
          areas.every((area) =>
            card.pairs.some((pair) => {
              const at = pair[side];
              return (
                at &&
                at.page === area.page &&
                at.clip[0] <= area.clip[0] &&
                at.clip[1] <= area.clip[1] &&
                at.clip[2] >= area.clip[2] &&
                at.clip[3] >= area.clip[3]
              );
            }),
          ),
        ),
      )
      .map((card) => card.id),
  }));
  return [...text, ...paint];
}
// An overlap only identifies a candidate. A variant establishes an effect
// when it replaces exactly that old range with the final text AND appearance.
// Partial contributions remain available for joint attribution.
export function shownBy(
  old: Build,
  variant: Build,
  effects: DocumentEffect[],
  final: Build,
) {
  const original = compareDocuments(old, final),
    [a, b, c] = sharedWords(words(old), words(variant), words(final)),
    changes = allDifferences(a, b),
    finalChanges = allDifferences(a, c),
    rangeMap = (from: Words, to: Words) => {
      // Both views reference the same physical glyphs. Index them once,
      // rather than searching the entire target for every changed range.
      const first = new Int32Array(to.glyphs.length).fill(to.tokens.length),
        last = new Int32Array(to.glyphs.length).fill(-1),
        after = new Int32Array(to.glyphs.length + 1).fill(to.tokens.length);
      to.tokens.forEach((token, index) => {
        for (const glyph of tokenGlyphs(token)) {
          first[glyph] = Math.min(first[glyph], index);
          last[glyph] = Math.max(last[glyph], index);
        }
        after[token.start] = Math.min(after[token.start], index);
      });
      // Token reading order need not follow glyph offsets across a header.
      // Preserve findIndex(start >= boundary), including empty ranges.
      for (let glyph = after.length - 2; glyph >= 0; glyph--)
        after[glyph] = Math.min(after[glyph], after[glyph + 1]);
      return ([start, end]: [number, number]): [number, number] => {
        let low = to.tokens.length,
          high = -1;
        for (let i = start; i < end; i++)
          for (const glyph of tokenGlyphs(from.tokens[i])) {
            low = Math.min(low, first[glyph]);
            high = Math.max(high, last[glyph]);
          }
        if (high >= 0) return [low, high + 1];
        const boundary = from.tokens[start]?.start ?? from.glyphs.length,
          at = after[boundary];
        return [at, at];
      };
    },
    oldRangeIn = rangeMap(original.old, a),
    newRangeIn = rangeMap(original.new, c),
    identity = (w: Words, effect: Effect) =>
      JSON.stringify([
        w.tokens.slice(...effect.new).map((t) => t.text),
        appearanceOf(w, effect.new),
        effect.kind === "visual"
          ? placementOf(a, w, effect.old, effect.new)
          : [],
      ]);
  const drawings = effects.some((effect) => effect.kind === "paint")
    ? paintChanges(
        old.document,
        variant.document,
        paintAnchors(comparison(a, b)),
      )
    : [];
  return effects.map((effect) => {
    if (effect.kind === "paint")
      return drawings.some(
        (change) =>
          JSON.stringify(
            change.before.map(({ page, clip, signature }) => [
              page,
              clip,
              signature,
            ]),
          ) ===
            JSON.stringify(
              effect.before.map(({ page, clip, signature }) => [
                page,
                clip,
                signature,
              ]),
            ) &&
          JSON.stringify(
            change.after.map(({ page, clip, signature }) => [
              page,
              clip,
              signature,
            ]),
          ) ===
            JSON.stringify(
              effect.after.map(({ page, clip, signature }) => [
                page,
                clip,
                signature,
              ]),
            ),
      );
    const oldRange = oldRangeIn(effect.old),
      newRange = newRangeIn(effect.new),
      pieces = finalChanges.filter(
        (e) =>
          e.kind === effect.kind &&
          e.old[0] >= oldRange[0] &&
          e.old[1] <= oldRange[1] &&
          e.new[0] >= newRange[0] &&
          e.new[1] <= newRange[1],
      );
    return (
      pieces.length > 0 &&
      pieces.every((piece) =>
        changes.some(
          (change) =>
            change.kind === piece.kind &&
            change.old[0] === piece.old[0] &&
            change.old[1] === piece.old[1] &&
            identity(b, change) === identity(c, piece),
        ),
      )
    );
  });
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
  effects: DocumentEffect[],
  causes: string[][],
  within: string[][],
) {
  const { old: a, new: b } = compareDocuments(old, next),
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
    const left =
        effect.kind === "paint" ? effect.before : positions(old, a, effect.old),
      right =
        effect.kind === "paint" ? effect.after : positions(next, b, effect.new),
      removed =
        effect.kind === "visual" || effect.kind === "paint"
          ? []
          : glyphsOf(a, effect.old),
      added =
        effect.kind === "visual" || effect.kind === "paint"
          ? []
          : glyphsOf(b, effect.new);
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
      const lane = laneX(
          build.document,
          laneAt(build.document, at.page, at.clip),
        ),
        // A physical effect can extend into a margin or across columns.
        // The text lane supplies context, but never clips the effect itself.
        x: [number, number] = [
          Math.min(lane[0], at.clip[0]),
          Math.max(lane[1], at.clip[2]),
        ],
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
