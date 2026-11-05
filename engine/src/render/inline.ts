import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { opcodes as compare, similarity } from "../core/diff.ts";
import type {
  Block,
  Card,
  Heading,
  Mark,
  Op,
  Pair,
  Position,
  Rect,
  Span,
  Strip,
} from "../types.ts";
import {
  Build,
  byReading,
  laneAt,
  lanePage,
  laneX,
  readingKey,
  sectionIntervals,
  type Intervals,
} from "./locate.ts";
import { containsCenter, intersect, intersects, PdfDocument } from "./pdf.ts";
import { textChanges } from "./pdfdiff.ts";
const RUN_GAP = 3,
  MARGIN = 900;
// Changed regions closer than this share one crop.
export const JOIN_GAP = 90;
export interface Row {
  page: number;
  rect: Rect;
  text: string;
  column?: number;
}
type Region = [number, number, number, number];
type PairRef = [number, number];
interface Group {
  top: number;
  bottom: number;
  pairs: PairRef[];
}
// A stretch of a lane: its lane (see locate.ts), top and bottom.
type Part = [number, number, number];
interface Piece {
  kind: "context" | "change";
  lane: number;
  top: number;
  bottom: number;
  pairs?: PairRef[];
  parts?: Part[];
}
type Planned = Piece | { kind: "gap" };
export function textRows(document: PdfDocument, intervals: Intervals): Row[] {
  const rows: [number[], Row][] = [];
  for (const [id, spans] of intervals) {
    const number = lanePage(id),
      page = document.page(number);
    for (const line of page.lines) {
      const text = line.text.trim().replace(/\s+/g, " "),
        middle = (line.rect[1] + line.rect[3]) / 2;
      if (
        text &&
        laneAt(document, number, line.rect) === id &&
        spans.some(([a, b]) => a <= middle && middle <= b)
      )
        rows.push([
          [...readingKey(document, id, line.rect[1]), line.rect[0]],
          {
            page: number,
            rect: line.rect,
            text,
            column: page.column(line.rect),
          },
        ]);
    }
  }
  return rows
    .sort(([a], [b]) => byReading(a, b) || a[4] - b[4])
    .map(([, row]) => row);
}
export function pairRelocated(
  regions: Region[],
  oldRows: Row[],
  newRows: Row[],
) {
  const removed = regions.filter((r) => r[0] < r[1] && r[2] === r[3]),
    added = regions.filter((r) => r[0] === r[1] && r[2] < r[3]),
    result = regions.filter((r) => !removed.includes(r) && !added.includes(r));
  while (removed.length && added.length) {
    const candidates = removed
        .flatMap((a) =>
          added.map((b) => ({
            a,
            b,
            score: similarity(
              oldRows
                .slice(a[0], a[1])
                .map((r) => r.text)
                .join(" ")
                .split(/\s+/),
              newRows
                .slice(b[2], b[3])
                .map((r) => r.text)
                .join(" ")
                .split(/\s+/),
            ),
          })),
        )
        .sort((a, b) => b.score - a.score),
      { a, b } = candidates[0];
    removed.splice(removed.indexOf(a), 1);
    added.splice(added.indexOf(b), 1);
    let [i, j] = a,
      [, , x, y] = b;
    while (i < j && x < y && oldRows[i].text === newRows[x].text) {
      i++;
      x++;
    }
    while (i < j && x < y && oldRows[j - 1].text === newRows[y - 1].text) {
      j--;
      y--;
    }
    if (i < j || x < y) result.push([i, j, x, y]);
  }
  return [...result, ...removed, ...added].sort(
    (a, b) => a[2] - b[2] || a[0] - b[0],
  );
}
export function aligned(old: Row[], next: Row[]): [Row[], Row[]][] {
  const offsets = (rows: Row[]): [Span[], number] => {
    let total = 0;
    const result = rows.map((r) => {
      const span: Span = [total, total + r.text.length];
      total += r.text.length + 1;
      return span;
    });
    return [result, Math.max(total, 1)];
  };
  const [newOffsets, newTotal] = offsets(next),
    pieces: {
      page: number;
      rows: Row[];
      start: number;
      end: number;
      old: Row[];
    }[] = [];
  next.forEach((row, i) => {
    const [start, end] = newOffsets[i],
      previous = pieces.at(-1);
    if (previous?.page === row.page && previous.rows[0].column === row.column) {
      previous.rows.push(row);
      previous.end = end;
    } else pieces.push({ page: row.page, rows: [row], start, end, old: [] });
  });
  const [spans, oldTotal] = offsets(old);
  old.forEach((row, i) => {
    const middle = ((spans[i][0] + spans[i][1]) / 2 / oldTotal) * newTotal;
    (pieces.find((p) => middle < p.end + 1) ?? pieces.at(-1))?.old.push(row);
  });
  return pieces.map((p) => [p.old, p.rows]);
}
export function lineBefore(
  rows: Row[],
  index: number,
  previousPage = false,
): number | null {
  if (!index) return null;
  if (!previousPage) return index - 1;
  if (index >= rows.length) return null;
  let k = index - 1;
  while (k >= 0 && rows[k].page === rows[index].page) k--;
  return k >= 0 ? k : null;
}
export function balancedTextPairs(
  card: Card,
  oldRows: Row[],
  newRows: Row[],
  opcodes: Op[],
  oldDocument: PdfDocument,
  document: PdfDocument,
): Pair[] | null {
  const own = card.own;
  const touches = (rows: Row[], side: "old" | "new") => {
    if (own && (own.old.length || own.new.length))
      return rows.some((row) =>
        own[side].some(
          ([page, top, bottom, left, right]) =>
            row.page === page &&
            row.rect[1] < bottom &&
            row.rect[3] > top &&
            (left === undefined ||
              right === undefined ||
              !Number.isFinite(left + right) ||
              (row.rect[0] < right && row.rect[2] > left)),
        ),
      );
    return card.pairs.some((pair) => {
      const position = pair[side];
      if (!position) return false;
      const marks = pair[side === "old" ? "before_marks" : "after_marks"],
        rects = marks.length ? marks.map((m) => m.rect) : [position.clip];
      return rows.some(
        (row) =>
          row.page === position.page &&
          rects.some((r) => intersects(row.rect, r)),
      );
    });
  };
  const selected = pairRelocated(
      opcodes
        .filter(
          ([tag, i, j, x, y]) =>
            tag !== "equal" &&
            (touches(oldRows.slice(i, j), "old") ||
              touches(newRows.slice(x, y), "new")),
        )
        .map(([, i, j, x, y]) => [i, j, x, y]),
      oldRows,
      newRows,
    ),
    runs: Region[] = [];
  for (const [i, j, x, y] of selected) {
    const last = runs.at(-1);
    if (
      last &&
      i - last[1] >= 0 &&
      i - last[1] <= RUN_GAP &&
      x - last[3] >= 0 &&
      x - last[3] <= RUN_GAP
    ) {
      last[1] = j;
      last[3] = y;
    } else runs.push([i, j, x, y]);
  }
  if (!runs.length || runs.every(([, , x, y]) => x === y)) return null;
  const positions = (rows: Row[], doc: PdfDocument) => {
    const result: Position[] = [];
    for (const row of rows) {
      const previous = result.at(-1),
        page = doc.page(row.page),
        [left, right] = page.columnBounds(row.column ?? -1);
      if (
        previous?.page === row.page &&
        previous.clip[0] === left &&
        previous.clip[2] === right
      )
        previous.clip[3] = Math.max(previous.clip[3], row.rect[3] + 2);
      else
        result.push({
          page: row.page,
          clip: [left, row.rect[1] - 2, right, row.rect[3] + 2],
          label: page.label,
        });
    }
    return result;
  };
  const left: Position[] = [],
    right: Position[] = [],
    links: [number | null, number | null][] = [];
  for (const [i, j, x, y] of runs) {
    for (const previousPage of [false, true]) {
      const a = lineBefore(oldRows, i, previousPage),
        b = lineBefore(newRows, x, previousPage);
      if (
        (a !== null && oldRows[a].text.endsWith("-")) ||
        (b !== null && newRows[b].text.endsWith("-"))
      ) {
        left.push(
          ...positions(a === null ? [] : oldRows.slice(a, a + 1), oldDocument),
        );
        right.push(
          ...positions(b === null ? [] : newRows.slice(b, b + 1), document),
        );
        break;
      }
    }
    if (x === y) {
      const old = positions(oldRows.slice(i, j), oldDocument);
      links.push(...old.map((_, k): [number, null] => [left.length + k, null]));
      left.push(...old);
      continue;
    }
    for (const [old, next] of aligned(
      oldRows.slice(i, j),
      newRows.slice(x, y),
    )) {
      right.push(...positions(next, document));
      const olds = positions(old, oldDocument);
      links.push(
        ...(olds.length
          ? olds.map((_, k): [number, number] => [
              left.length + k,
              right.length - 1,
            ])
          : [[null, right.length - 1] as [null, number]]),
      );
      left.push(...olds);
    }
  }
  const marks = textChanges(oldDocument, document, left, right),
    shown = new Set<number | null>();
  return links.map(([a, b]) => {
    const pair: Pair = {
      old: a === null ? null : left[a],
      new: b === null ? null : right[b],
      before_marks: a === null ? [] : (marks.old_marks[a] ?? []),
      after_marks: b === null || shown.has(b) ? [] : (marks.new_marks[b] ?? []),
    };
    // Line-based balancing can stop at different occurrences of repeated text
    // in narrow columns. Retain the word marks from the complete source-local
    // paragraph, instead of treating unequal crop tails as new edits.
    for (const side of ["old", "new"] as const) {
      const position = pair[side],
        doc = side === "old" ? oldDocument : document;
      if (!position || !doc.page(position.page).twoColumns) continue;
      const field = side === "old" ? "before_marks" : "after_marks";
      pair[field] =
        side === "new" && shown.has(b)
          ? []
          : card.pairs
              .filter((p) => p[side]?.page === position.page)
              .flatMap((p) => p[field])
              .filter((mark) => containsCenter(position.clip, mark.rect));
    }
    shown.add(b);
    return pair;
  });
}
export function withoutMoves(
  opcodes: Op[],
  oldTexts: string[],
  newTexts: string[],
  minimum = 2,
): Op[] {
  const ops = opcodes.filter((o) => o[0] !== "equal").map((o) => [...o] as Op),
    equal = (a: string[], b: string[]) =>
      a.length === b.length && a.every((v, i) => v === b[i]);
  for (const a of ops)
    for (const b of ops) {
      if (a === b) continue;
      let moved = oldTexts.slice(b[1], b[2]);
      if (moved.length >= minimum && a[4] - a[3] >= moved.length) {
        if (equal(newTexts.slice(a[3], a[3] + moved.length), moved)) {
          a[3] += moved.length;
          b[2] = b[1];
        } else if (equal(newTexts.slice(a[4] - moved.length, a[4]), moved)) {
          a[4] -= moved.length;
          b[2] = b[1];
        }
      }
      moved = newTexts.slice(b[3], b[4]);
      if (moved.length >= minimum && a[2] - a[1] >= moved.length) {
        if (equal(oldTexts.slice(a[1], a[1] + moved.length), moved)) {
          a[1] += moved.length;
          b[4] = b[3];
        } else if (equal(oldTexts.slice(a[2] - moved.length, a[2]), moved)) {
          a[2] -= moved.length;
          b[4] = b[3];
        }
      }
    }
  return ops
    .filter(([, i, j, x, y]) => i < j || x < y)
    .map(([, i, j, x, y]) => [
      i < j && x < y ? "replace" : i < j ? "delete" : "insert",
      i,
      j,
      x,
      y,
    ]);
}
export function changedLineBounds(
  document: PdfDocument,
  position: Position,
  marks: Mark[],
): Span {
  const lines = document
    .page(position.page)
    .lines.filter((l) => marks.some((m) => intersects(l.rect, m.rect)));
  return lines.length
    ? [
        Math.max(
          position.clip[1],
          Math.min(...lines.map((l) => l.rect[1])) - 2,
        ),
        Math.min(
          position.clip[3],
          Math.max(...lines.map((l) => l.rect[3])) + 2,
        ),
      ]
    : [position.clip[1], position.clip[3]];
}
export function snap(
  document: PdfDocument,
  number: number,
  top: number,
  bottom: number,
  [x0, x1]: Span = [0, document.page(number).width],
): Span {
  const limit = 10,
    page = document.page(number),
    ink = (y0: number, y1: number): [Span, boolean[]] => {
      y0 = Math.max(0, y0);
      y1 = Math.min(page.height, y1);
      if (y1 - y0 < 1) return [[y0, y1], []];
      const image = page.raster([x0, y0, x1, y1], 2, true);
      return [
        [y0, y1],
        Array.from({ length: image.height }, (_, r) =>
          image.pixels
            .subarray(r * image.stride, r * image.stride + image.width)
            .some((p) => p < 200),
        ),
      ];
    };
  let [clip, rows] = ink(bottom, bottom + limit),
    index = rows.findIndex((filled) => !filled);
  if (index >= 0)
    bottom = clip[0] + (index * (clip[1] - clip[0])) / rows.length;
  else if (rows.length) bottom = clip[1];
  [clip, rows] = ink(top - limit, top);
  index = rows.findLastIndex((filled) => !filled);
  if (index >= 0)
    top = clip[0] + ((index + 1) * (clip[1] - clip[0])) / rows.length;
  else if (rows.length) top = clip[0];
  return [top, bottom];
}
// An aligned crop already ends between printed lines, so it never cuts a
// glyph; only the blank space at its ends goes. Growing it to the nearest
// blank row, as snap does, would take in the equal line it ends at.
export function trimmed(
  document: PdfDocument,
  number: number,
  top: number,
  bottom: number,
  [x0, x1]: Span = [0, document.page(number).width],
): Span {
  const page = document.page(number);
  top = Math.max(0, top);
  bottom = Math.min(page.height, bottom);
  if (bottom - top < 1) return [top, bottom];
  const image = page.raster([x0, top, x1, bottom], 2, true),
    rows = Array.from({ length: image.height }, (_, r) =>
      image.pixels
        .subarray(r * image.stride, r * image.stride + image.width)
        .some((p) => p < 200),
    ),
    scale = (bottom - top) / rows.length,
    // A sliver of ink at an end, apart from the rest, is the descender or
    // accent of the line beyond it.
    sliver = Math.ceil(1.5 / scale),
    edge = (list: boolean[]) => {
      const ink = list.indexOf(true),
        blank = list.indexOf(false, ink);
      return ink === 0 &&
        blank > 0 &&
        blank <= sliver &&
        list.indexOf(true, blank) > 0
        ? list.indexOf(true, blank)
        : ink;
    },
    first = edge(rows),
    last = first < 0 ? -1 : rows.length - 1 - edge([...rows].reverse());
  return first < 0
    ? [top, bottom]
    : [
        Math.max(top, top + first * scale - 1),
        Math.min(bottom, top + (last + 1) * scale + 1),
      ];
}
// The lanes a crop of a page falls in: those of the section's intervals on
// its page that hold most of its width, or most of whose width it holds.
function lanesOf(
  document: PdfDocument,
  intervals: Intervals,
  position: Position,
) {
  const [x0, , x1] = position.clip;
  return [...intervals.keys()].filter((id) => {
    if (lanePage(id) !== position.page) return false;
    const [a, b] = laneX(document, id);
    return Math.min(x1, b) - Math.max(x0, a) >= Math.min(x1 - x0, b - a) / 2;
  });
}
export function groupedRegions(
  document: PdfDocument,
  cards: [number, Card][],
  intervals: Intervals,
  snapped?: (lane: number, top: number, bottom: number, card: Card) => Span,
) {
  const result = new Map<number, Group[]>();
  for (const [index, card] of cards)
    card.pairs.forEach((pair, pairIndex) => {
      const position = pair.new;
      if (!position) return;
      for (const id of lanesOf(document, intervals, position))
        for (const [start, end] of intervals.get(id)!) {
          let top = Math.max(start, position.clip[1]),
            bottom = Math.min(end, position.clip[3]);
          if (bottom > top && snapped)
            [top, bottom] = snapped(id, top, bottom, card);
          if (bottom > top) {
            if (!result.has(id)) result.set(id, []);
            result.get(id)!.push({ top, bottom, pairs: [[index, pairIndex]] });
          }
        }
    });
  for (const [id, regions] of result) {
    const merged: Group[] = [];
    for (const region of regions.sort((a, b) => a.top - b.top)) {
      const last = merged.at(-1),
        shared =
          last && region.pairs.some(([i]) => last.pairs.some(([j]) => i === j));
      if (
        last &&
        (region.top <= last.bottom ||
          (shared && region.top - last.bottom <= JOIN_GAP))
      ) {
        last.bottom = Math.max(last.bottom, region.bottom);
        last.pairs.push(...region.pairs);
      } else merged.push(region);
    }
    result.set(id, merged);
  }
  return result;
}
export function contextPlan(
  document: PdfDocument,
  intervals: Intervals,
  groups: Map<number, Group[]>,
): Piece[] {
  const plan: [number[], Piece][] = [];
  for (const [lane, spans] of intervals)
    for (const [start, end] of spans) {
      const pieces: Piece[] = [];
      let cursor = start;
      for (const group of groups.get(lane) ?? []) {
        const top = Math.max(start, group.top),
          bottom = Math.min(end, group.bottom);
        if (bottom <= top) continue;
        if (top > cursor)
          pieces.push({ kind: "context", lane, top: cursor, bottom: top });
        pieces.push({ kind: "change", lane, top, bottom, pairs: group.pairs });
        cursor = bottom;
      }
      if (cursor < end)
        pieces.push({ kind: "context", lane, top: cursor, bottom: end });
      for (const piece of pieces)
        plan.push([readingKey(document, lane, piece.top), piece]);
    }
  return plan.sort(([a], [b]) => byReading(a, b)).map(([, piece]) => piece);
}
export function foldContext(plan: Piece[], margin = MARGIN): Planned[] {
  let total = 0;
  const offsets = plan.map((p) => {
      const offset = total;
      total += p.bottom - p.top;
      return offset;
    }),
    changes = plan.flatMap((p, i) =>
      p.kind === "change"
        ? [[offsets[i], offsets[i] + p.bottom - p.top] as Span]
        : [],
    );
  if (!changes.length) return plan;
  const result: Planned[] = [];
  plan.forEach((piece, i) => {
    if (piece.kind === "change") {
      result.push(piece);
      return;
    }
    const height = piece.bottom - piece.top,
      offset = offsets[i],
      keep = changes
        .map(([a, b]): Span => [
          Math.max(0, a - margin - offset),
          Math.min(height, b + margin - offset),
        ])
        .filter(([a, b]) => b > a)
        .sort((a, b) => a[0] - b[0]);
    let cursor = 0;
    for (let [low, high] of keep) {
      low = Math.max(low, cursor);
      if (high <= low) continue;
      if (low > cursor) result.push({ kind: "gap" });
      result.push({ ...piece, top: piece.top + low, bottom: piece.top + high });
      cursor = high;
    }
    if (cursor < height) result.push({ kind: "gap" });
  });
  return result.filter(
    (p, i) => p.kind !== "gap" || i === 0 || result[i - 1].kind !== "gap",
  );
}
export function acrossPages(plan: Planned[]) {
  const result: Planned[] = [];
  for (const original of plan) {
    let piece = original;
    if (piece.kind === "change") {
      let k = result.length;
      while (k) {
        const p = result[k - 1];
        if (p.kind !== "context" || p.bottom - p.top >= 12) break;
        k--;
      }
      const previous = k ? result[k - 1] : null;
      if (
        previous?.kind === "change" &&
        previous.parts!.at(-1)![0] !== piece.lane &&
        previous.pairs!.some(
          ([i]) =>
            piece.kind === "change" && piece.pairs!.some(([j]) => i === j),
        )
      ) {
        result.splice(k);
        previous.parts!.push([piece.lane, piece.top, piece.bottom]);
        previous.pairs!.push(...piece.pairs!);
        continue;
      }
      piece = { ...piece, parts: [[piece.lane, piece.top, piece.bottom]] };
    }
    result.push(piece);
  }
  return result;
}
// The marks a card's strips draw. Moved words are drawn only where the whole
// comparison found them: text that left one place for another. Compared
// alone, a card's crops call moved the words a paragraph only rewrapped.
export const drawn = (card: Card, marks: Mark[]) =>
  card.aligned ? marks : marks.filter((m) => m.kind !== "moved");
export class Strips {
  count = 0;
  constructor(public out: string) {}
  write(
    document: PdfDocument,
    number: number,
    top: number,
    bottom: number,
    marks: Mark[] = [],
    side = "",
    [left, right]: Span = [0, document.page(number).width],
  ): Strip | null {
    const page = document.page(number);
    top = Math.max(0, top);
    bottom = Math.min(page.height, bottom);
    left = Math.max(0, left);
    right = Math.min(page.width, right);
    if (bottom - top < 0.1 || right - left < 0.1) return null;
    const clip: Rect = [left, top, right, bottom];
    // A strip that shows nothing, such as the space above a band printed
    // across both columns, is not written.
    if (
      !page.lines.some((line) =>
        line.chars.some((char) => containsCenter(clip, char.rect)),
      ) &&
      page.raster(clip, 1, true).pixels.every((p) => p >= 250)
    )
      return null;
    // Red and green say that words were removed or added; a light blue,
    // that words moved here or away unchanged (see `drawn`).
    // Words of an old crop that the context strips also show are veiled in
    // every version of the strip, so that none reads twice.
    const veil = marks
      .map((mark) =>
        mark.kind === "context" ? intersect(mark.rect, clip) : null,
      )
      .filter((r): r is Rect => r !== null && r[2] > r[0] && r[3] > r[1])
      .map(
        (r) =>
          `<rect x="${r[0] - left - 0.5}" y="${r[1] - top - 0.5}" width="${r[2] - r[0] + 1}" height="${r[3] - r[1] + 1}" fill="#fff" fill-opacity=".7"/>`,
      )
      .join("");
    marks = marks.filter((mark) => mark.kind !== "context");
    const raw = page.svg(top, bottom, left, right),
      svg = veil ? raw.replace("</svg>", veil + "</svg>") : raw,
      digest = createHash("sha256")
        .update(svg)
        .update(JSON.stringify(marks))
        .update(side)
        .digest("hex")
        .slice(0, 12),
      name = `s${String(++this.count).padStart(4, "0")}-${digest}`,
      clean = marks.length ? name + "-clean.svg" : name + ".svg";
    fs.writeFileSync(path.join(this.out, clean), svg);
    if (marks.length) {
      const color = side === "old" ? "#c72938" : "#1f8c52",
        overlays = marks
          .map((mark) => {
            const r = intersect(mark.rect, clip);
            if (r[2] <= r[0] || r[3] <= r[1]) return "";
            const x = r[0] - left,
              y = r[1] - top,
              width = r[2] - r[0],
              height = r[3] - r[1],
              strike = y + height * 0.55;
            if (mark.kind === "moved")
              return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#2563c9" fill-opacity=".14"/>`;
            return (
              `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${color}" fill-opacity=".18"/>` +
              (side === "old"
                ? `<path d="M ${x} ${strike} H ${r[2] - left}" stroke="${color}" stroke-width=".45"/>`
                : "")
            );
          })
          .join("");
      fs.writeFileSync(
        path.join(this.out, name + ".svg"),
        svg.replace("</svg>", overlays + "</svg>"),
      );
    }
    const text = page.lines
      .map((line) => {
        const chars = line.chars
          .filter((char) => containsCenter(clip, char.rect))
          .map((char) => ({
            text: char.text,
            rect: [
              char.rect[0] - left,
              char.rect[1] - top,
              char.rect[2] - left,
              char.rect[3] - top,
            ] as Rect,
          }));
        return { text: chars.map((c) => c.text).join(""), chars };
      })
      .filter((line) => line.text.trim());
    return {
      src: name + ".svg",
      clean,
      width: Math.round((right - left) * 100) / 100,
      height: Math.round((bottom - top) * 100) / 100,
      top: Math.round(top * 100) / 100,
      ...(left > 0 ? { left: Math.round(left * 100) / 100 } : {}),
      page: number + 1,
      label: page.label,
      text,
    };
  }
}
export function renderSection(
  old: Build,
  next: Build,
  node: Heading,
  inputCards: [number, Card][],
  strips: Strips,
  figureFiles: (file: string) => boolean,
): [Block[], number[], number] {
  const [intervals, missing] = sectionIntervals(next, node, figureFiles),
    cards: [number, Card][] = structuredClone(inputCards);
  let oldRows: Row[] = [],
    newRows: Row[] = [],
    opcodes: Op[] = [];
  // Aligned cards already end at the same lines on both sides; the rows of
  // the section only balance the crops of the others.
  if (cards.some(([, card]) => card.comparison === "text" && !card.aligned)) {
    const oldNode = old.outline.find((n) => n.id === node.id);
    if (oldNode)
      try {
        const [oldIntervals] = sectionIntervals(old, oldNode, figureFiles);
        oldRows = textRows(old.document, oldIntervals);
        newRows = textRows(next.document, intervals);
        const a = oldRows.map((r) => r.text),
          b = newRows.map((r) => r.text);
        opcodes = withoutMoves(compare(a, b), a, b);
      } catch {
        /* Missing PDF heading: use the source-local crops. */
      }
  }
  for (const [, card] of cards) {
    if (card.comparison !== "text" || card.aligned || figureFiles(card.file))
      continue;
    if (opcodes.length) {
      const balanced = balancedTextPairs(
        card,
        oldRows,
        newRows,
        opcodes,
        old.document,
        next.document,
      );
      if (balanced) {
        card.pairs = balanced;
        continue;
      }
    }
    for (const pair of card.pairs)
      if (
        pair.old &&
        pair.new &&
        pair.before_marks.length &&
        pair.after_marks.length
      ) {
        [pair.old.clip[1], pair.old.clip[3]] = changedLineBounds(
          old.document,
          pair.old,
          pair.before_marks,
        );
        [pair.new.clip[1], pair.new.clip[3]] = changedLineBounds(
          next.document,
          pair.new,
          pair.after_marks,
        );
      }
  }
  const plan = acrossPages(
      foldContext(
        contextPlan(
          next.document,
          intervals,
          groupedRegions(next.document, cards, intervals, (id, a, b, card) =>
            (card.aligned ? trimmed : snap)(
              next.document,
              lanePage(id),
              a,
              b,
              laneX(next.document, id),
            ),
          ),
        ),
      ),
    ),
    byIndex = new Map(cards),
    blocks: Block[] = [],
    located = new Set<number>(),
    oldShown = new Set<string>();
  for (const piece of plan) {
    if (piece.kind === "gap") {
      blocks.push({ kind: "gap" });
      continue;
    }
    if (piece.kind === "context") {
      const image = strips.write(
        next.document,
        lanePage(piece.lane),
        piece.top,
        piece.bottom,
        [],
        "",
        laneX(next.document, piece.lane),
      );
      if (image) blocks.push({ kind: "context", image });
      continue;
    }
    const indices = [...new Set(piece.pairs!.map(([i]) => i))].sort(
      (a, b) => a - b,
    );
    indices.forEach((i) => located.add(i));
    const identical = indices.every(
      (i) => byIndex.get(i)!.comparison === "identical",
    );
    // An aligned card shows the whole old side of a region with the first
    // block that shows the region: the old side can break across pages
    // where the new side does not, so an old crop need not share its index
    // with a new one in this piece.
    const shown = ([i, j]: [number, number]): [Card, Pair][] => {
        const card = byIndex.get(i)!,
          group = card.pairs[j].group;
        if (!card.aligned) return [[card, card.pairs[j]]];
        const key = `${i}:${group}`;
        if (oldShown.has(key)) return [];
        oldShown.add(key);
        return card.pairs
          .filter((pair) => pair.group === group)
          .map((pair): [Card, Pair] => [card, pair]);
      },
      regions = identical
        ? []
        : piece.pairs!.flatMap(shown).flatMap(([card, pair]) => {
            return pair.old
              ? [
                  {
                    lane: laneAt(old.document, pair.old.page, pair.old.clip),
                    top: pair.old.clip[1],
                    bottom: pair.old.clip[3],
                    marks: drawn(card, pair.before_marks),
                    aligned: Boolean(card.aligned),
                  },
                ]
              : [];
          }),
      merged: typeof regions = [];
    for (const region of regions.sort((a, b) =>
      byReading(
        readingKey(old.document, a.lane, a.top),
        readingKey(old.document, b.lane, b.top),
      ),
    )) {
      const last = merged.at(-1);
      if (
        last &&
        region.lane === last.lane &&
        region.top <= last.bottom + JOIN_GAP
      ) {
        last.bottom = Math.max(last.bottom, region.bottom);
        last.marks.push(...region.marks);
        last.aligned &&= region.aligned;
      } else merged.push({ ...region, marks: [...region.marks] });
    }
    const before = merged
        .map((r) => {
          const page = lanePage(r.lane),
            x = laneX(old.document, r.lane);
          return strips.write(
            old.document,
            page,
            ...(r.aligned ? trimmed : snap)(
              old.document,
              page,
              r.top,
              r.bottom,
              x,
            ),
            r.marks,
            "old",
            x,
          );
        })
        .filter((s): s is Strip => s !== null),
      after = piece
        .parts!.map(([lane, top, bottom]) =>
          strips.write(
            next.document,
            lanePage(lane),
            top,
            bottom,
            piece.pairs!.flatMap(([i, j]) => {
              const card = byIndex.get(i)!,
                pair = card.pairs[j];
              return pair.new?.page === lanePage(lane)
                ? drawn(card, pair.after_marks)
                : [];
            }),
            "new",
            laneX(next.document, lane),
          ),
        )
        .filter((s): s is Strip => s !== null),
      // Text that the whole comparison found moved here is no reflow.
      kinds = new Set(
        piece.pairs!.flatMap(([i, j]) => {
          const card = byIndex.get(i)!,
            pair = card.pairs[j];
          return drawn(card, [...pair.before_marks, ...pair.after_marks]).map(
            (m) => m.kind,
          );
        }),
      ),
      edited = kinds.has("removed") || kinds.has("added") || kinds.has("moved");
    blocks.push({
      kind: "change",
      units: indices.map((i) => byIndex.get(i)!.id),
      identical,
      reflow:
        !identical &&
        !edited &&
        indices.every((i) => byIndex.get(i)!.comparison === "text"),
      ...(kinds.has("moved") ? { moved: true } : {}),
      before,
      after,
    });
  }
  return [
    blocks,
    cards.map(([i]) => i).filter((i) => !located.has(i)),
    missing.length,
  ];
}
