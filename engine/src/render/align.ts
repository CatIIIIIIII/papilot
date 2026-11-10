import {
  compareDocuments,
  visualDifferences,
  type Comparison,
  type Words,
} from "./effects.ts";
import { textBounds, type Build } from "./locate.ts";
import { containsCenter, union } from "./pdf.ts";
import { mergeRects, pixelDifference, tokenGlyphs } from "./pdfdiff.ts";
import type { Mark, Position, Rect, SourceBox } from "../types.ts";
// One comparison of the whole documents decides everything a review shows.
// A word is marked when that comparison changed it, never because of where
// a crop happens to start. A change is cut so that the context strips with
// its old crop read as the old document and with its new crop as the new
// one: at its changed words when it changed words, otherwise at
// the same pair of equal lines on both sides. SyncTeX only says which part
// of the PDF belongs to which edit.
export type SideName = "old" | "new";
interface Line {
  page: number;
  rect: Rect;
  column: number;
}
interface Side {
  build: Build;
  words: Words;
  lines: Line[];
  /** Every physical row occupied by each logical line's tokens. */
  parts: Line[][];
  /** The line of every glyph. */
  glyphLine: Int32Array;
  /** The indices of each page's lines, in reading order. */
  byPage: Map<number, number[]>;
  /** The changed glyphs of each page, which marks cover. */
  changed: Map<number, number[]>;
  /** Equal words with different ink; required in crops, without text marks. */
  visual: Map<number, number[]>;
  /** The glyphs of each page that changed or moved, which crops show. */
  unpaired: Map<number, number[]>;
  /** The glyphs of each page that only moved. */
  moved: Map<number, number[]>;
  /** Lines holding a glyph that changed or moved. */
  changedLine: Uint8Array;
  /** Lines whose words all moved, unchanged. */
  movedLine: Uint8Array;
  /** The line of every word, and which words changed or moved. */
  tokenLine: Int32Array;
  changedToken: Uint8Array;
}
export interface Alignment {
  old: Side;
  new: Side;
  /** The equal line of the new document for each old line, or -1. */
  match: Int32Array;
  /** The equal line of the old document for each new line, or -1. */
  back: Int32Array;
  /** Equal lines a change may be cut at, in order on both sides. */
  anchors: { old: Int32Array; new: Int32Array };
  /** For each word of a side, the equal word of the other, or -1. */
  tokens: { old: Int32Array; new: Int32Array };
}
/** Lines [lo, hi] of a side that an edit touches; a fraction lies between lines. */
export type Touch = [number, number];
/** A change's stretch on each side, between two lines that are equal in both
 * documents and not part of it; -1 and the line count stand for the ends. */
export interface Gap {
  old: [number, number];
  new: [number, number];
}
const known = new WeakMap<Build, WeakMap<Build, Alignment>>();
// The alignment of two builds.
export function alignment(old: Build, next: Build): Alignment {
  const cached = known.get(old)?.get(next);
  if (cached !== undefined) return cached;
  const result = compareDocuments(old, next),
    value = build(old, next, result.old, result.new, result);
  if (!known.has(old)) known.set(old, new WeakMap());
  known.get(old)!.set(next, value);
  return value;
}
function sideOf(build: Build, w: Words): Side {
  const glyphLine = new Int32Array(w.glyphs.length).fill(-1),
    byPage = new Map<number, number[]>();
  const parts = w.lines.map(([i, j], index): Line[] => {
    const rows = new Map<number, Line>();
    for (const g of w.tokens.slice(i, j).flatMap((t) => tokenGlyphs(t))) {
      glyphLine[g] = index;
      const { pair, page, rect } = w.glyphs[g],
        row = rows.get(pair);
      if (row) row.rect = union(row.rect, rect);
      else rows.set(pair, { page, rect, column: -1 });
    }
    const parts = [...rows.values()];
    for (const part of parts)
      part.column = build.document.page(part.page).column(part.rect);
    for (const page of new Set(parts.map((part) => part.page))) {
      if (!byPage.has(page)) byPage.set(page, []);
      byPage.get(page)!.push(index);
    }
    return parts;
  });
  const tokenLine = new Int32Array(w.tokens.length).fill(-1);
  w.lines.forEach(([i, j], line) => tokenLine.fill(line, i, j));
  return {
    build,
    words: w,
    // Alignment addresses a logical line by its start; drawing and source
    // ownership use all of its physical rows, even across pages or columns.
    lines: parts.map((p) => p[0]),
    parts,
    glyphLine,
    byPage,
    changed: new Map(),
    visual: new Map(),
    unpaired: new Map(),
    moved: new Map(),
    changedLine: new Uint8Array(parts.length),
    movedLine: new Uint8Array(parts.length),
    tokenLine,
    changedToken: new Uint8Array(w.tokens.length),
  };
}
const lineText = (w: Words, [i, j]: [number, number]) =>
  w.tokens
    .slice(i, j)
    .map((t) => t.text)
    .join(" ");
function build(
  old: Build,
  next: Build,
  a: Words,
  b: Words,
  result: Comparison,
): Alignment {
  const sides = { old: sideOf(old, a), new: sideOf(next, b) },
    back = new Int32Array(b.tokens.length).fill(-1);
  result.tokens.forEach((j, i) => {
    if (j >= 0) back[j] = i;
  });
  const add = (map: Map<number, number[]>, w: Words, g: number) => {
    const page = w.glyphs[g].page;
    if (!map.has(page)) map.set(page, []);
    map.get(page)!.push(g);
  };
  // A word the comparison could not pair changed or moved. Crops show both
  // where text left and where it arrived; marks cover only the changed
  // words, since words that moved are the same text. A running head or a
  // page number left unpaired only turned with its page: unless its words
  // changed, it is neither moved text nor anything a crop must show.
  const edited = { old: new Uint8Array(a.tokens.length), new: new Uint8Array(b.tokens.length) };
  for (const effect of result.changes) {
    edited.old.fill(1, effect.old[0], effect.old[1]);
    edited.new.fill(1, effect.new[0], effect.new[1]);
  }
  for (const [name, w, map] of [
    ["old", a, result.tokens],
    ["new", b, back],
  ] as const) {
    const side = sides[name];
    map.forEach((other, t) => {
      if (other >= 0) return;
      if (w.tokens[t].flow === "edge" && !edited[name][t]) return;
      side.changedToken[t] = 1;
      for (const g of tokenGlyphs(w.tokens[t])) {
        add(side.unpaired, w, g);
        side.changedLine[side.glyphLine[g]] = 1;
      }
    });
  }
  for (const effect of result.changes)
    for (const [name, w, [i, j]] of [
      ["old", a, effect.old],
      ["new", b, effect.new],
    ] as const)
      for (let t = i; t < j; t++)
        for (const g of tokenGlyphs(w.tokens[t]))
          add(sides[name].changed, w, g);
  for (const side of [sides.old, sides.new]) {
    const changed = new Set([...side.changed.values()].flat()),
      // A line-end hyphen the comparison left unpaired marks where a line
      // broke, which reflow moves; its word did not move.
      hyphens = new Set(
        side.words.tokens.flatMap((t) => (t.hyphen ? tokenGlyphs(t) : [])),
      );
    for (const [page, glyphs] of side.unpaired) {
      const moved = glyphs.filter((g) => !changed.has(g) && !hyphens.has(g));
      if (moved.length) side.moved.set(page, moved);
    }
    side.words.lines.forEach(([i, j], line) => {
      let moved = j > i;
      for (let t = i; t < j && moved; t++) {
        moved =
          side.changedToken[t] === 1 &&
          tokenGlyphs(side.words.tokens[t]).every((g) => !changed.has(g));
      }
      side.movedLine[line] = Number(moved);
    });
  }
  for (const effect of visualDifferences(a, b))
    for (const [name, range] of [
      ["old", effect.old],
      ["new", effect.new],
    ] as const) {
      const side = sides[name],
        w = side.words;
      for (let t = range[0]; t < range[1]; t++) {
        side.changedToken[t] = 1;
        for (const g of tokenGlyphs(w.tokens[t])) {
          add(side.visual, w, g);
          side.changedLine[side.glyphLine[g]] = 1;
        }
      }
    }
  // An equal line may end a change when it pins the documents together: it
  // is unique in both, long, or one of a run of equal lines. A short line
  // that recurs, such as "1" or "Proof.", can pair with another occurrence
  // inside a rewritten passage and would split it.
  const texts = a.lines.map((l) => lineText(a, l)),
    counts = (list: string[]) => {
      const map = new Map<string, number>();
      for (const t of list) map.set(t, (map.get(t) ?? 0) + 1);
      return map;
    },
    oldCounts = counts(texts),
    newCounts = counts(b.lines.map((l) => lineText(b, l))),
    match = result.match,
    paired = (i: number) => i >= 0 && i < match.length && match[i] >= 0,
    oldAnchors: number[] = [],
    newAnchors: number[] = [];
  match.forEach((j, i) => {
    if (j < 0) return;
    const text = texts[i];
    if (
      (paired(i - 1) && match[i - 1] === j - 1) ||
      (paired(i + 1) && match[i + 1] === j + 1) ||
      (oldCounts.get(text) === 1 && newCounts.get(text) === 1) ||
      text.replace(/[^\p{L}\p{N}]/gu, "").length >= 12
    ) {
      oldAnchors.push(i);
      newAnchors.push(j);
    }
  });
  const lineBack = new Int32Array(b.lines.length).fill(-1);
  match.forEach((j, i) => {
    if (j >= 0) lineBack[j] = i;
  });
  return {
    ...sides,
    tokens: { old: result.tokens, new: back },
    match,
    back: lineBack,
    anchors: {
      old: Int32Array.from(oldAnchors),
      new: Int32Array.from(newAnchors),
    },
  };
}
// The changed and the moved words of a crop, as marks over whole words.
export function marksIn(al: Alignment, name: SideName, at: Position): Mark[] {
  const side = al[name],
    marks = (glyphs: number[], kind: Mark["kind"]): Mark[] => {
      const rects = glyphs
        .map((g) => side.words.glyphs[g].rect)
        .filter((rect) => containsCenter(at.clip, rect));
      if (!rects.length) return [];
      const boxes = side.build.document
        .page(at.page)
        .words.filter(
          (w) =>
            containsCenter(at.clip, w.rect) &&
            rects.some((r) => containsCenter(w.rect, r)),
        )
        .map((w) => w.rect);
      return mergeRects(boxes.length ? boxes : rects).map((rect) => ({
        kind,
        rect,
      }));
    };
  return [
    ...marks(
      side.changed.get(at.page) ?? [],
      name === "old" ? "removed" : "added",
    ),
    ...marks(side.moved.get(at.page) ?? [], "moved"),
  ];
}
// The most lines one SyncTeX record may cover and still say who printed them.
const BOX = 4;
// For each line of a side, the edits whose source printed it: of SyncTeX's
// unpadded records of every source line of each edit, the edits with the
// most records on the line. A file's first line often has a record where
// TeX stood when it began reading the file, on the line before its text,
// which a majority outvotes.
export function printers(
  al: Alignment,
  name: SideName,
  records: SourceBox[][],
): Map<number, number[]> {
  const side = al[name],
    votes = new Map<number, Map<number, number>>(),
    result = new Map<number, number[]>();
  records.forEach((boxes, edit) => {
    for (const [page, top, bottom, x0, x1] of boxes) {
      const covered = (side.byPage.get(page) ?? []).filter((line) =>
        side.parts[line].some((part) => {
          const rect = part.rect,
            across =
              x0 === undefined ||
              x1 === undefined ||
              !Number.isFinite(x0 + x1) ||
              (x1 > rect[0] && x0 < rect[2]);
          return (
            part.page === page &&
            across &&
            Math.min(bottom, rect[3]) - Math.max(top, rect[1]) >=
              0.5 * (rect[3] - rect[1])
          );
        }),
      );
      // A record over more than a few lines is a box around them, such as
      // a float, a paragraph or an image at its unscaled size, that TeX
      // files under one source line: it says nothing of who printed them.
      if (covered.length > BOX) continue;
      for (const line of covered) {
        if (!votes.has(line)) votes.set(line, new Map());
        const tally = votes.get(line)!;
        tally.set(edit, (tally.get(edit) ?? 0) + 1);
      }
    }
  });
  for (const [line, tally] of votes) {
    const most = Math.max(...tally.values());
    result.set(
      line,
      [...tally].filter(([, n]) => n === most).map(([edit]) => edit),
    );
  }
  return result;
}
/** Whether an edit's source printed a line of a side: undefined when no
 * edit's did. */
export type Mine = Record<SideName, (line: number) => boolean | undefined>;
const everything: Mine = { old: () => true, new: () => true };
// The lines of a side whose changed or moved words lie inside the crops and
// that are the edit's: an edit leaves to another the lines only that one
// printed. A changed word that no edit printed is every edit's to show, so
// that none goes unseen; a word that only moved is the edit's only where its
// source printed it, since text that no edit touched moves only as the
// pages settle, as when a float now comes after other lines.
function changedLines(
  al: Alignment,
  name: SideName,
  crops: Position[],
  mine: Mine[SideName],
): Touch[] {
  const side = al[name],
    lines = new Set<number>();
  for (const [map, strict] of [
    [side.changed, false],
    [side.visual, false],
    [side.moved, true],
  ] as const)
    for (const at of crops)
      for (const g of map.get(at.page) ?? []) {
        const line = side.glyphLine[g],
          owner = mine(line);
        if (
          containsCenter(at.clip, side.words.glyphs[g].rect) &&
          (strict ? owner === true : owner !== false)
        )
          lines.add(line);
      }
  return [...lines].sort((a, b) => a - b).map((line): Touch => [line, line]);
}
// The lines of a side that each crop covers. A crop without text, such as
// a figure, lies between the lines printed above and below it.
function touched(al: Alignment, name: SideName, crops: Position[]): Touch[] {
  const side = al[name],
    middle = (r: Rect) => (r[1] + r[3]) / 2;
  return crops.map((at): Touch => {
    const [x0, y0, x1, y1] = at.clip,
      onPage = side.byPage.get(at.page) ?? [],
      across = onPage.flatMap((line) =>
        side.parts[line]
          .filter((p) => p.page === at.page && p.rect[0] < x1 && p.rect[2] > x0)
          .map((p) => ({ line, rect: p.rect })),
      ),
      inside = across.filter(({ rect }) => {
        const y = middle(rect);
        return y >= y0 && y <= y1;
      });
    if (inside.length) return [inside[0].line, inside.at(-1)!.line];
    const above = across.filter(({ rect }) => middle(rect) < y0).at(-1)?.line,
      below = across.find(({ rect }) => middle(rect) > y1)?.line,
      before =
        above ?? (onPage.length ? onPage[0] - 1 : lastBefore(side, at.page)),
      after = below ?? (onPage.length ? onPage.at(-1)! + 1 : before + 1);
    return [before + 0.5, after - 0.5];
  });
}
function lastBefore(side: Side, page: number) {
  for (let p = page - 1; p >= 0; p--) {
    const lines = side.byPage.get(p);
    if (lines?.length) return lines.at(-1)!;
  }
  return -1;
}
const merge = (a: Touch | null, b: Touch | null): Touch | null =>
  a && b ? [Math.min(a[0], b[0]), Math.max(a[1], b[1])] : (a ?? b);
// The number of sorted values below `value` (or at most `value`).
function count(values: Int32Array, value: number, inclusive: boolean) {
  let lo = 0,
    hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < value || (inclusive && values[mid] === value))
      lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
// The anchors around what an edit touches: indices into `anchors`, -1 and
// its length standing for the ends of the documents.
function around(
  al: Alignment,
  old: Touch | null,
  next: Touch | null,
): [number, number] {
  const lists = al.anchors,
    from = Math.min(
      old ? count(lists.old, old[0], false) : Infinity,
      next ? count(lists.new, next[0], false) : Infinity,
    ),
    to = Math.max(
      old ? count(lists.old, old[1], true) : -Infinity,
      next ? count(lists.new, next[1], true) : -Infinity,
    );
  return [from - 1, to];
}
// The line of a side at an anchor index, with the document's ends.
function bound(al: Alignment, name: SideName, index: number) {
  const list = al.anchors[name];
  return index < 0
    ? -1
    : index >= list.length
      ? al[name].lines.length
      : list[index];
}
const gapAt = (al: Alignment, [from, to]: [number, number]): Gap => ({
  old: [bound(al, "old", from), bound(al, "old", to)],
  new: [bound(al, "new", from), bound(al, "new", to)],
});
// Each side keeps something to show, so a deletion shows where the text was:
// a side with nothing between its anchors takes in the anchors around it.
function widen(al: Alignment, gap: Gap): Gap {
  const before = count(al.anchors.old, gap.old[0], false) - 1,
    after = count(al.anchors.old, gap.old[1], true);
  return gapAt(al, [
    Math.max(-1, before),
    Math.min(al.anchors.old.length, after),
  ]);
}
// Lines at the ends of a stretch that are the same in both documents, print
// the same, and sit where they did relative to the line beyond them are
// context, however generously SyncTeX placed the edit: a crop that reaches
// into the paragraph above a restyled table leaves it out on both sides.
function tighten(al: Alignment, gap: Gap): Gap {
  const g: Gap = { old: [...gap.old], new: [...gap.new] };
  const step = (end: 0 | 1) => {
    const dir = end === 0 ? 1 : -1,
      i = g.old[end] + dir,
      j = g.new[end] + dir;
    if (i <= g.old[0] || i >= g.old[1] || j <= g.new[0] || j >= g.new[1])
      return false;
    if (al.match[i] !== j || al.old.changedLine[i] || al.new.changedLine[j])
      return false;
    if (!same(al, [g.old[end], i], [g.new[end], j], end)) return false;
    g.old[end] = i;
    g.new[end] = j;
    return true;
  };
  while (step(0));
  while (step(1));
  return g;
}
// Whether a line prints the same on both sides, together with the space
// that separates it from the line beyond it on its page, rules and colors
// included; where it shifted on the page does not matter.
function same(
  al: Alignment,
  [oldOuter, i]: [number, number],
  [newOuter, j]: [number, number],
  end: 0 | 1,
) {
  const bands = (side: Side, outer: number, line: number): (Rect | null)[] =>
    side.parts[line].map((l, index, parts) => {
      const o =
        end === 0
          ? (parts[index - 1] ?? side.parts[outer]?.at(-1))
          : (parts[index + 1] ?? side.parts[outer]?.[0]);
      // Across a page or column break the intervening space is pagination.
      if (!o || o.page !== l.page || o.column !== l.column) return null;
      const [x0, x1] = side.build.document.page(l.page).columnBounds(l.column);
      // Logical lines may share or overlap physical rows. The intervening
      // space may vanish, but the comparison must still include this row.
      return end === 0
        ? [x0, Math.min(o.rect[3], l.rect[1]), x1, l.rect[3]]
        : [x0, l.rect[1], x1, Math.max(o.rect[1], l.rect[3])];
    });
  const a = bands(al.old, oldOuter, i),
    b = bands(al.new, newOuter, j);
  return (
    a.length === b.length &&
    a.every((rect, index) => {
      const left = al.old.parts[i][index],
        right = al.new.parts[j][index],
        other = b[index];
      return identical(
        al,
        [left.page, rect && other ? rect : left.rect],
        [right.page, rect && other ? other : right.rect],
      );
    })
  );
}
function identical(
  al: Alignment,
  [p, r]: [number, Rect],
  [q, s]: [number, Rect],
) {
  if (
    Math.abs(r[3] - r[1] - (s[3] - s[1])) > 0.65 ||
    Math.abs(r[0] - s[0]) > 0.65
  )
    return false;
  return (
    pixelDifference(
      al.old.build.document.page(p).raster(r, 2, false, true),
      al.new.build.document.page(q).raster(s, 2, false, true),
      1,
    ) === 0
  );
}
// The crops of a side's parts, one per page and column: the column's width,
// running up to the end lines on their pages, and grown over any printed
// line they cut through, so a tall brace or a stacked display is never cut
// in half while the end lines stay outside.
type Part = { page: number; column: number; rect: Rect };
function framed(
  document: Build["document"],
  parts: Iterable<Part>,
  top: Line | null = null,
  end: Line | null = null,
): Position[] {
  const same = (a: number, b: number) => a === b || a === -1 || b === -1;
  return [...parts]
    .sort((a, b) => a.page - b.page || a.column - b.column)
    .map(({ page: number, column, rect }) => {
      const page = document.page(number),
        [left, right] = textBounds(page),
        [columnLeft, columnRight] = page.columnBounds(column),
        x0 = Math.max(left, columnLeft),
        x1 = Math.min(right, columnRight);
      let [y0, y1] = [rect[1] - 1, rect[3] + 1];
      if (top && top.page === number && same(top.column, column))
        y0 = Math.min(rect[1], top.rect[3]);
      if (end && end.page === number && same(end.column, column))
        y1 = Math.max(rect[3], end.rect[1]);
      // Overlapping glyph ink forms a band with no safe cut through its text.
      // Include every band touching the crop's text, and exclude bands in
      // its surrounding context. One ordered pass replaces edge-by-edge
      // growth. Rules and images keep the extent of their source crops;
      // a frame around several paragraphs does not bind their text together.
      const bands: [number, number][] = [];
      for (const [a, lo, b, hi] of page.textInk) {
        if (a >= x1 || b <= x0) continue;
        const last = bands.at(-1);
        if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
        else bands.push([lo, hi]);
      }
      for (const [lo, hi] of bands) {
        if (hi <= rect[1]) y0 = Math.max(y0, hi);
        else if (lo >= rect[3]) y1 = Math.min(y1, lo);
        else {
          y0 = Math.min(y0, lo);
          y1 = Math.max(y1, hi);
        }
      }
      return {
        page: number,
        clip: [x0, Math.max(0, y0), x1, Math.min(page.height, y1)] as Rect,
        label: page.label,
      };
    });
}
// Adds a rect to the part of its page and column.
function gather(
  parts: Map<string, Part>,
  page: number,
  column: number,
  rect: Rect,
) {
  const key = `${page}:${column}`,
    part = parts.get(key);
  parts.set(key, { page, column, rect: part ? union(part.rect, rect) : rect });
}
// The crops of one side of a gap: the lines between its ends, and the
// edit's own crops inside that stretch, which hold its figures and rules.
// A crop runs up to the end lines on its page, so nothing printed between
// an end and the first line of the change is left out of either side.
function cropsOf(
  al: Alignment,
  name: SideName,
  gap: Gap,
  own: Position[],
): Position[] {
  const side = al[name],
    document = side.build.document,
    [lo, hi] = gap[name],
    top = side.parts[lo]?.at(-1) ?? null,
    end = side.parts[hi]?.[0] ?? null,
    same = (a: number, b: number) => a === b || a === -1 || b === -1,
    parts = new Map<string, Part>();
  for (let i = lo + 1; i < hi; i++)
    for (const part of side.parts[i])
      gather(parts, part.page, part.column, part.rect);
  for (const at of own) {
    if ((top && at.page < top.page) || (end && at.page > end.page)) continue;
    const column = document.page(at.page).column(at.clip);
    let [x0, y0, x1, y1] = at.clip;
    if (top && top.page === at.page && same(top.column, column))
      y0 = Math.max(y0, top.rect[3]);
    if (end && end.page === at.page && same(end.column, column))
      y1 = Math.min(y1, end.rect[1]);
    if (y1 - y0 >= 1) gather(parts, at.page, column, [x0, y0, x1, y1]);
  }
  return framed(document, parts.values(), top, end);
}
// Where an edit changed the documents: the stretches between anchors around
// each line it touches on either side. Stretches that overlap, or that only
// one unchanged line separates, are one region; regions further apart are
// reviewed apart, so the unchanged text between them stays context.
interface Region {
  span: [number, number];
  old: Touch | null;
  next: Touch | null;
}
function regions(al: Alignment, old: Touch[], next: Touch[]): Region[] {
  const items: Region[] = [
    ...old.map((t): Region => ({
      span: around(al, t, null),
      old: t,
      next: null,
    })),
    ...next.map((t): Region => ({
      span: around(al, null, t),
      old: null,
      next: t,
    })),
  ].sort((a, b) => a.span[0] - b.span[0] || a.span[1] - b.span[1]);
  const result: Region[] = [];
  for (const item of items) {
    const last = result.at(-1);
    if (
      last &&
      (item.span[0] < last.span[1] ||
        bound(al, "new", item.span[0]) - bound(al, "new", last.span[1]) < 2)
    ) {
      last.span[1] = Math.max(last.span[1], item.span[1]);
      last.old = merge(last.old, item.old);
      last.next = merge(last.next, item.next);
    } else result.push({ ...item, span: [...item.span] });
  }
  return result;
}
// Whether an unpaired line at the end of an edit's crops stays: not when
// only other edits printed it, nor when its words only moved and the edit
// did not print it, as text that a float now comes after.
const kept = (al: Alignment, name: SideName, line: number, mine: Mine) =>
  al[name].movedLine[line]
    ? mine[name](line) === true
    : mine[name](line) !== false;
// A gap gives up, at each end and on each side, the lines that only other
// edits printed, or that only moved: two rewritten sections with no equal
// line between them each keep their own text rather than both showing both.
function release(al: Alignment, gap: Gap, mine: Mine): Gap {
  const g: Gap = { old: [...gap.old], new: [...gap.new] };
  // An equal pair of lines leaves together, so both sides keep ending at the
  // same text; a changed line, which pairs with nothing, leaves on its own.
  for (const end of [0, 1] as const) {
    const step = end === 0 ? 1 : -1;
    for (;;) {
      const i = g.old[end] + step,
        j = g.new[end] + step,
        oldIn = i > g.old[0] && i < g.old[1],
        newIn = j > g.new[0] && j < g.new[1];
      if (oldIn && newIn && al.match[i] === j) {
        if (mine.old(i) !== false && mine.new(j) !== false) break;
        g.old[end] = i;
        g.new[end] = j;
        continue;
      }
      const old = oldIn && al.match[i] < 0 && !kept(al, "old", i, mine),
        next = newIn && al.back[j] < 0 && !kept(al, "new", j, mine);
      if (!old && !next) break;
      if (old) g.old[end] = i;
      if (next) g.new[end] = j;
    }
  }
  return g;
}
/** One region's crops. The legacy `faded` field records words also shown by
 * context strips; rendering preserves their original PDF colours. */
export interface Group {
  left: Position[];
  right: Position[];
  faded?: { page: number; rect: Rect }[];
}
// The crops of a run of lines of a side, one per page and column, running
// up to the lines around the run, so a rule or space printed between them
// belongs to the crop.
function linesCrops(
  al: Alignment,
  name: SideName,
  first: number,
  last: number,
): Position[] {
  const side = al[name],
    parts = new Map<string, Part>();
  for (let i = first; i <= last; i++)
    for (const { page, column, rect } of side.parts[i])
      gather(parts, page, column, rect);
  return framed(
    side.build.document,
    parts.values(),
    side.parts[first - 1]?.at(-1) ?? null,
    side.parts[last + 1]?.[0] ?? null,
  );
}
// Words touched by the actual footprint, including words sharing a row
// with a continuation from an earlier logical line.
function visibleTokens(side: Side, crops: Position[]): Set<number> {
  const shown = new Set<number>(),
    w = side.words;
  for (const at of crops)
    for (const line of side.byPage.get(at.page) ?? []) {
      const [start, end] = w.lines[line];
      for (let t = start; t < end; t++)
        for (const g of tokenGlyphs(w.tokens[t]))
          if (
            w.glyphs[g].page === at.page &&
            containsCenter(at.clip, w.glyphs[g].rect)
          ) {
            shown.add(t);
            break;
          }
    }
  return shown;
}
// Preserve an already complete physical footprint. In particular, a large
// operator's font box can extend beyond its painted ink into another row.
function completeCrops(
  al: Alignment,
  name: SideName,
  first: number,
  last: number,
  required?: number[],
) {
  const side = al[name],
    w = side.words;
  for (;;) {
    const crops = linesCrops(al, name, first, last),
      shown = visibleTokens(side, crops);
    let lo = first,
      hi = last;
    for (const t of required ?? shown)
      for (const g of tokenGlyphs(w.tokens[t])) {
        const { page, rect } = w.glyphs[g];
        if (
          !crops.some((p) => p.page === page && containsCenter(p.clip, rect))
        ) {
          lo = Math.min(lo, side.tokenLine[t]);
          hi = Math.max(hi, side.tokenLine[t]);
          break;
        }
      }
    if (lo === first && hi === last) return { crops, shown, first, last };
    [first, last] = [lo, hi];
  }
}
// A region is cut at its words. Its new crop holds the lines from its first
// changed word to its last, and where only one side changed, the words on
// either side of the change, so that both crops show where it is; a region
// that changed no words, only how they print, holds the lines between its
// anchors less the unchanged lines at its ends. The old crop holds the old
// words between the last equal word above the new crop and the first below
// it, however differently the paragraphs wrap: with the context strips, each
// crop reads as its whole document. Its first and last lines may also hold
// words the context strips show; record that overlap separately from the
// changed words. The rest of a rewrapped paragraph stays in the context.
function cut(al: Alignment, region: Region, mine: Mine): Group | null {
  const words = (name: SideName, touch: Touch | null) => {
      const side = al[name],
        result: number[] = [];
      if (!touch) return result;
      for (
        let line = Math.ceil(touch[0]);
        line <= Math.floor(touch[1]);
        line++
      ) {
        const [i, j] = side.words.lines[line];
        for (let t = i; t < j; t++) if (side.changedToken[t]) result.push(t);
      }
      return result;
    },
    removed = words("old", region.old),
    added = words("new", region.next),
    count = {
      old: al.old.words.tokens.length,
      new: al.new.words.tokens.length,
    };
  // The equal word before or after a word of a side, on the other side.
  const equal = (name: SideName, t: number, step: 1 | -1) => {
    const map = al.tokens[name];
    for (let k = t + step; k >= 0 && k < count[name]; k += step)
      if (map[k] >= 0) return map[k];
    return step < 0 ? -1 : count[name === "old" ? "new" : "old"];
  };
  let first: number, last: number;
  if (removed.length || added.length) {
    const shown: number[] = [...added];
    for (const t of removed) {
      const counterpart = al.tokens.old[t];
      if (counterpart >= 0) shown.push(counterpart);
      else shown.push(equal("old", t, -1), equal("old", t, 1));
    }
    if (!removed.length) for (const t of added) shown.push(t - 1, t + 1);
    const inside = shown.filter((t) => t >= 0 && t < count.new);
    if (!inside.length) return null;
    first = al.new.tokenLine[Math.min(...inside)];
    last = al.new.tokenLine[Math.max(...inside)];
  } else {
    const gap = tighten(al, release(al, gapAt(al, region.span), mine));
    [first, last] = [gap.new[0] + 1, gap.new[1] - 1];
    if (first > last) return null;
  }
  // Close the footprint over whole words before selecting its counterpart.
  // A continuation row may share another word that continues in turn.
  const next = completeCrops(al, "new", first, last),
    right = next.crops,
    shownNew = next.shown;
  if (!shownNew.size) return null;
  const lines = al.new.words.lines,
    above = equal("new", Math.min(...shownNew), -1),
    below = equal("new", Math.max(...shownNew), 1);

  if (below - above < 2) return null;
  let oldFirst = al.old.tokenLine[equal("new", lines[next.first][0], -1) + 1],
    oldLast = al.old.tokenLine[equal("new", lines[next.last][1] - 1, 1) - 1];
  while (oldFirst < oldLast && !kept(al, "old", oldFirst, mine)) oldFirst++;
  while (oldLast > oldFirst && !kept(al, "old", oldLast, mine)) oldLast--;
  // The old crop shows its lines whole, and with them whatever prints on
  // the same rows, as the pieces of an inline formula. A word of it before
  // or after the change that equals a word the context strips show, outside
  // the new crop, fades: the context strips show it. Any other word is
  // read in the old crop.
  const w = al.old.words,
    needed = Array.from(
      { length: below - above - 1 },
      (_, i) => above + 1 + i,
    ).filter((t) => kept(al, "old", al.old.tokenLine[t], mine)),
    left = completeCrops(al, "old", oldFirst, oldLast, needed).crops,
    faded = new Map<number, Rect[]>();
  for (const at of left)
    for (const line of al.old.byPage.get(at.page) ?? []) {
      const [i, j] = w.lines[line];
      for (let t = i; t < j; t++) {
        const other = al.tokens.old[t];
        if ((t > above && t < below) || other < 0 || shownNew.has(other))
          continue;
        for (const g of tokenGlyphs(w.tokens[t])) {
          const { page, rect } = w.glyphs[g];
          if (page === at.page && containsCenter(at.clip, rect))
            faded.set(page, [...(faded.get(page) ?? []), rect]);
        }
      }
    }
  return {
    left,
    right,
    faded: [...faded].flatMap(([page, rects]) =>
      mergeRects(rects).map((rect) => ({ page, rect })),
    ),
  };
}
// An edit's crops, one group per region, cut at its words (above). A
// figure, where the picture matters as much as the words, is cut at the same
// equal lines on both sides: the stretch between anchors around its SyncTeX
// crops, less the unchanged lines at its ends, with the crops themselves. When an edit changed no words, its crops on
// both sides show the same source; if they lie in two places, one on each
// side, that source moved, as a float that now prints elsewhere, and its old
// and new crops face each other.
export function alignedCrops(
  al: Alignment,
  left: Position[],
  right: Position[],
  wide: boolean,
  mine: Mine = everything,
): Group[] | null {
  // Whether the edit changed words of its crops, rather than only moving
  // them, as a float that now prints elsewhere.
  const edited = (name: SideName, crops: Position[]) =>
      crops.some((at) =>
        (al[name].changed.get(at.page) ?? []).some(
          (g) =>
            containsCenter(at.clip, al[name].words.glyphs[g].rect) &&
            mine[name](al[name].glyphLine[g]) !== false,
        ),
      ),
    oldLines = changedLines(al, "old", left, mine.old),
    newLines = changedLines(al, "new", right, mine.new),
    text = edited("old", left) || edited("new", right),
    // Moved words also locate a text change. Only a purely visual change
    // needs the full SyncTeX extent, which may include unrelated paragraphs.
    narrow = !wide && (oldLines.length > 0 || newLines.length > 0),
    found = regions(
      al,
      narrow ? oldLines : [...oldLines, ...touched(al, "old", left)],
      narrow ? newLines : [...newLines, ...touched(al, "new", right)],
    );
  if (!found.length) return null;
  const crops = (gap: Gap) => ({
    left: cropsOf(al, "old", gap, left),
    right: cropsOf(al, "new", gap, right),
  });
  const settle = (region: Region) => {
    const gap = tighten(al, release(al, gapAt(al, region.span), mine)),
      result = crops(gap);
    return result.left.length && result.right.length
      ? result
      : crops(widen(al, gap));
  };
  if (
    !text &&
    found.length === 2 &&
    found.some((r) => !r.next) &&
    found.some((r) => !r.old)
  ) {
    const was = found.find((r) => !r.next)!,
      is = found.find((r) => !r.old)!,
      left = crops(tighten(al, release(al, gapAt(al, was.span), mine))).left,
      right = crops(tighten(al, release(al, gapAt(al, is.span), mine))).right;
    if (left.length && right.length) return [{ left, right }];
  }
  return found.map(
    (region) => (!wide && cut(al, region, mine)) || settle(region),
  );
}
