import { opcodesWithin } from "../core/diff.ts";
import { JOIN_GAP, snap, type Strips } from "./inline.ts";
import { headingAt, laneAt, laneX, textBounds, type Build } from "./locate.ts";
import { containsCenter, union, type PdfDocument } from "./pdf.ts";
import { extract, mergeRects, tokens, type Glyph } from "./pdfdiff.ts";
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
// blocks, and pairs with its new place by runs of this many words.
const MOVED = 20,
  WINDOW = 4;
export interface Words {
  glyphs: Glyph[];
  tokens: ReturnType<typeof tokens>;
  /** The tokens of each printed line, as [start, end) ranges. */
  lines: [number, number][];
}
// Running heads and page numbers belong to the page, not the text, and text
// that moves to another page passes them. A line at the top or bottom edge
// of a page is one when, without the page's own number, it is empty or
// recurs at that height on another page, as running heads do: "12 Chapter
// 1" and "14 Chapter 1" recur, while section numbers such as "1.3" and "2.7"
// that open two pages do not.
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
// Every word of the pages in reading order, line by line, without their
// furniture.
export function words(build: Build): Words {
  const known = read.get(build);
  if (known) return known;
  const document = build.document,
    edges = furniture(document),
    lines = Array.from({ length: document.length }, (_, number) => {
      const page = document.page(number);
      return page.lines
        .filter(
          (line) =>
            line.text.trim() &&
            !edges[number].some((rect) => containsCenter(rect, line.rect)),
        )
        .map((line) => ({ page: number, clip: line.rect, label: page.label }));
    }).flat(),
    // Each line is its own position, so a glyph's pair is its line.
    glyphs = extract(document, lines)[0],
    list = tokens(glyphs),
    ranges: [number, number][] = [];
  list.forEach((token, i) => {
    const line = glyphs[token.start].pair;
    ranges[line] = [ranges[line]?.[0] ?? i, i + 1];
  });
  const result = { glyphs, tokens: list, lines: ranges.filter(Boolean) };
  read.set(build, result);
  return result;
}
// The comparison gives up past this long, on documents changed throughout,
// and the round then lists no effects.
const PATIENCE = 5000;
export interface Comparison {
  /** For each line of the old document, the equal line of the new one, or -1. */
  match: Int32Array;
  /** For each word of the old document, the equal word of the new one, or -1. */
  tokens: Int32Array;
  /** Changed words, without runs that only moved. */
  changes: Effect[];
}
const compared = new WeakMap<Words, WeakMap<Words, Comparison | null>>();
export function differences(a: Words, b: Words): Effect[] | null {
  return comparison(a, b)?.changes ?? null;
}
// The whole comparison of two documents, computed once per pair: the edits'
// crops, their marks and the effects elsewhere all come from it.
export function comparison(a: Words, b: Words): Comparison | null {
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
function compare(a: Words, b: Words): Comparison | null {
  const text = (w: Words, i: number, j: number) =>
      w.tokens
        .slice(i, j)
        .map((t) => t.text)
        .join(" "),
    deadline = Date.now() + PATIENCE,
    within = <T>(x: T[], y: T[]) =>
      opcodesWithin(x, y, Math.max(1, deadline - Date.now()));
  // Runs of words that occur once in each document pin the two together,
  // in the longest chain that keeps their order (patience diff on words),
  // and each grows over the equal words around it. Words, not lines: a
  // paragraph that wraps differently prints the same words on other lines,
  // and a line that happens to recur elsewhere must not pin anything.
  const ta = a.tokens.map((t) => t.text),
    tb = b.tokens.map((t) => t.text),
    gram = (list: string[], i: number) =>
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
  // Between the pinned runs, the words compared in full.
  const match = new Int32Array(a.lines.length).fill(-1),
    tokenMatch = new Int32Array(ta.length).fill(-1),
    changed: Op[] = [];
  let previousA = 0,
    previousB = 0;
  for (const [i, j, n] of [
    ...blocks,
    [ta.length, tb.length, 0] as [number, number, number],
  ]) {
    if (i > previousA || j > previousB) {
      const ops = within(ta.slice(previousA, i), tb.slice(previousB, j));
      if (!ops) return null;
      for (const [kind, p, q, r, t] of ops)
        if (kind !== "equal")
          changed.push([
            kind,
            previousA + p,
            previousA + q,
            previousB + r,
            previousB + t,
          ]);
        else
          for (let k = 0; k < q - p; k++)
            tokenMatch[previousA + p + k] = previousB + r + k;
    }
    for (let k = 0; k < n; k++) tokenMatch[i + k] = j + k;
    [previousA, previousB] = [i + n, j + n];
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
  // A run's windows: its runs of four words, or the whole of a shorter run.
  const windows = (list: string[], i: number, j: number) =>
      Array.from({ length: Math.max(1, j - i - WINDOW + 1) }, (_, k) =>
        list.slice(i + k, Math.min(j, i + k + WINDOW)).join("\u0000"),
      ),
    long = (list: string[], i: number, j: number) =>
      list
        .slice(i, j)
        .join("")
        .replace(/[^\p{L}\p{N}]/gu, "").length >= MOVED,
    removedRuns = changed.filter((op) => op[2] > op[1]),
    addedRuns = changed.filter((op) => op[4] > op[3]),
    where = new Map<string, number[]>();
  addedRuns.forEach(([, , , x, y], run) => {
    for (const key of windows(tb, x, y)) {
      if (!where.has(key)) where.set(key, []);
      where.get(key)!.push(run);
    }
  });
  const movedOld = new Uint8Array(ta.length),
    movedNew = new Uint8Array(tb.length),
    taken = new Set<number>();
  for (const [, i, j] of [...removedRuns].sort(
    (p, q) => q[2] - q[1] - (p[2] - p[1]),
  )) {
    if (!long(ta, i, j)) continue;
    const keys = windows(ta, i, j),
      votes = new Map<number, number>();
    for (const key of keys)
      for (const run of where.get(key) ?? [])
        if (!taken.has(run)) votes.set(run, (votes.get(run) ?? 0) + 1);
    const [best, n] = [...votes].sort((p, q) => q[1] - p[1])[0] ?? [-1, 0];
    // A few shared runs of four words already tell a moved run from a new
    // one; pairing two that differ more marks their differences anyway.
    if (n < Math.min(2, keys.length) || n < keys.length / 4) continue;
    taken.add(best);
    const [, , , x, y] = addedRuns[best],
      ops = within(ta.slice(i, j), tb.slice(x, y));
    if (!ops) return null;
    for (const [kind, p, q, r] of ops)
      if (kind === "equal") {
        movedOld.fill(1, i + p, i + q);
        movedNew.fill(1, x + r, x + r + (q - p));
      }
  }
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
const glyphsOf = (w: Words, [i, j]: [number, number]) =>
  w.tokens.slice(i, j).flatMap((t) => w.glyphs.slice(t.start, t.end));
// Every change between two builds, with the cards whose crops show it.
export function changesOf(old: Build, next: Build, cards: Card[]) {
  const a = words(old),
    b = words(next),
    shows = (card: Card, glyphs: Glyph[], side: "old" | "new") =>
      glyphs.some((glyph) =>
        card.pairs.some((pair) => {
          const p = pair[side];
          return (
            p !== null &&
            p.page === glyph.page &&
            containsCenter(p.clip, glyph.rect)
          );
        }),
      );
  return (differences(a, b) ?? []).map((effect) => ({
    effect,
    within: cards
      .filter(
        (card) =>
          shows(card, glyphsOf(a, effect.old), "old") ||
          shows(card, glyphsOf(b, effect.new), "new"),
      )
      .map((card) => card.id),
  }));
}
// Two changes are at the same place when they touch the same words of the
// old document.
const meets = ([i, j]: [number, number], [a, b]: [number, number]) =>
  i < j && a < b ? a < j && b > i : a <= j && b >= i;
// Which changes a variant build also makes to the old build, or null when
// the comparison gave up.
export function shownBy(old: Build, variant: Build, effects: Effect[]) {
  const changes = differences(words(old), words(variant));
  return (
    changes &&
    effects.map((effect) =>
      changes.some((change) => meets(effect.old, change.old)),
    )
  );
}
// The lines a run of words occupies, one position per column of each page.
// A side with no words shows the line where they would be.
function positions(build: Build, w: Words, [i, j]: [number, number]) {
  let glyphs = glyphsOf(w, [i, j]);
  if (!glyphs.length) {
    const near = w.tokens[i - 1] ?? w.tokens[i];
    glyphs = near ? w.glyphs.slice(near.start, near.end) : [];
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
      removed = glyphsOf(a, effect.old),
      added = glyphsOf(b, effect.new);
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
