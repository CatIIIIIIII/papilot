import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { opcodes as compare, similarity } from "../core/diff.ts";
import type {
  Block,
  Card,
  ChangeBlock,
  Heading,
  Mark,
  Op,
  Pair,
  Position,
  Rect,
  RenderedRound,
  Span,
  Strip,
} from "../types.ts";
import {
  Build,
  byReading,
  laneAt,
  laneColumn,
  lanePage,
  laneX,
  readingKey,
  readingParts,
  readingSections,
  sectionIntervals,
  type Intervals,
} from "./locate.ts";
import {
  containsCenter,
  intersect,
  intersects,
  union,
  PdfDocument,
  type Raster,
} from "./pdf.ts";
import { textChanges } from "./pdfdiff.ts";
import { partition, regions } from "./plan.ts";
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
interface Piece {
  kind: "context" | "change";
  lane: number;
  top: number;
  bottom: number;
}
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
// White is the page background. A contrast threshold would discard faint
// coloured ink at a crop edge even though the PDF comparison can see it.
function inkRows(image: Raster): boolean[] {
  return Array.from({ length: image.height }, (_, row) =>
    image.pixels
      .subarray(
        row * image.stride,
        row * image.stride + image.width * image.channels,
      )
      .some((channel) => channel !== 255),
  );
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
      return [[y0, y1], inkRows(page.raster([x0, y0, x1, y1], 2, false, true))];
    };
  let [clip, rows] = ink(bottom, bottom + limit),
    index = rows.findIndex((filled) => !filled);
  if (index >= 0)
    bottom = Math.min(clip[1], clip[0] + index / 2);
  else if (rows.length) bottom = clip[1];
  [clip, rows] = ink(top - limit, top);
  index = rows.findLastIndex((filled) => !filled);
  if (index >= 0)
    top = Math.min(clip[1], clip[0] + (index + 1) / 2);
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
  const rows = inkRows(page.raster([x0, top, x1, bottom], 2, false, true)),
    first = rows.indexOf(true),
    last = rows.lastIndexOf(true);
  return first < 0
    ? [top, bottom]
    : [
        Math.max(top, top + first / 2 - 1),
        Math.min(bottom, top + (last + 1) / 2 + 1),
      ];
}
export function foldContext<T extends Piece>(
  plan: T[],
  margin = MARGIN,
): (T | { kind: "gap" })[] {
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
  const result: (T | { kind: "gap" })[] = [];
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
      page.raster(clip, 2, false, true).pixels.every((p) => p === 255)
    )
      return null;
    // Red and green say that words were removed or added; a light blue,
    // that words moved here or away unchanged (see `drawn`).
    // Keep unchanged context readable in the PDF's original colours, even
    // when reflow makes it appear both in a crop and the surrounding text.
    marks = marks.filter((mark) => mark.kind !== "context");
    const svg = page.svg(top, bottom, left, right),
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
function balanceSection(
  old: Build,
  next: Build,
  node: Heading,
  cards: Card[],
  intervals: Intervals,
  figureFiles: (file: string) => boolean,
) {
  let oldRows: Row[] = [],
    newRows: Row[] = [],
    opcodes: Op[] = [];
  // Aligned cards already end at the same lines on both sides; the rows of
  // the section only balance the crops of the others.
  if (cards.some((card) => card.comparison === "text" && !card.aligned)) {
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
  for (const card of cards) {
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
}

function renderSlides(
  old: Build,
  next: Build,
  cards: Card[],
  strips: Strips,
): Pick<RenderedRound, "sections" | "loose"> {
  // A slide is a canvas. Keep its title, artwork and columns together;
  // paragraph/reading-lane crops would dismantle the layout under review.
  const areas = regions(
    cards.map((card) => ({
      ...card,
      aligned: true,
      pairs: card.pairs.map((pair) => ({ ...pair, group: 0 })),
    })),
  );
  const ordered = areas
    .filter((area) => area.new.length)
    .sort((a, b) => a.new[0].page - b.new[0].page);
  // Place deletions before the next surviving changed slide in the old
  // deck. Comparing old and new page numbers directly loses that order
  // when earlier slides have been inserted or removed.
  for (const area of areas
    .filter((area) => !area.new.length)
    .sort(
      (a, b) => (a.old[0]?.page ?? Infinity) - (b.old[0]?.page ?? Infinity),
    )) {
    const following = ordered
      .filter(
        (other) =>
          other.old.length &&
          other.old[0].page > (area.old[0]?.page ?? Infinity),
      )
      .sort((a, b) => a.old[0].page - b.old[0].page)[0];
    if (following) ordered.splice(ordered.indexOf(following), 0, area);
    else ordered.push(area);
  }
  return {
    sections: [],
    loose: ordered.map((area) => {
      const members = area.members.map((i) => cards[i]),
        identical = members.every((c) => c.comparison === "identical"),
        analysis = textChanges(old.document, next.document, area.old, area.new),
        images = (
          build: Build,
          positions: Position[],
          marks: Record<number, Mark[]>,
          side: string,
        ) =>
          positions
            .map((at, i) =>
              strips.write(
                build.document,
                at.page,
                at.clip[1],
                at.clip[3],
                (marks[i] ?? []).filter((m) => m.kind !== "moved"),
                side,
                [at.clip[0], at.clip[2]],
              ),
            )
            .filter((s): s is Strip => s !== null);
      return {
        kind: "change",
        units: members.map((c) => c.id),
        identical,
        reflow: false,
        before:
          identical && area.new.length
            ? []
            : images(old, area.old, analysis.old_marks, "old"),
        after: images(next, area.new, analysis.new_marks, "new"),
      };
    }),
  };
}

/** Plan the whole round before assigning sections. Source edits identify
 * regions; sections provide context, but never own a second copy of ink. */
// Whether a part of a page prints anything: a character or a dark shape or
// image, not merely the edge of a glyph next to it.
export function prints(document: PdfDocument, page: number, rect: Rect) {
  const p = document.page(page);
  return (
    p.lines.some((line) =>
      line.chars.some((c) => c.text.trim() && containsCenter(rect, c.rect)),
    ) ||
    p.drawings.some(
      (d) =>
        Math.min(d[2], rect[2]) - Math.max(d[0], rect[0]) > 0.5 &&
        Math.min(d[3], rect[3]) - Math.max(d[1], rect[1]) > 0.5,
    )
  );
}
// Two edits' crops are one place when they print a line in common. The boxes
// of adjacent lines touch or overlap by a point or two, which does not make
// separate edits one change. A crop without text, such as a figure, is one
// place with another when they overlap by much of the smaller one.
export function sharesLine(document: PdfDocument) {
  return (a: Position, b: Position) => {
    if (a.page !== b.page || !intersects(a.clip, b.clip)) return false;
    const lines = document
        .page(a.page)
        .lines.filter((l) => l.chars.some((c) => c.text.trim())),
      within = (p: Position) =>
        lines.filter((l) => {
          const middle = (l.rect[1] + l.rect[3]) / 2;
          return (
            middle > p.clip[1] &&
            middle < p.clip[3] &&
            l.rect[2] > p.clip[0] &&
            l.rect[0] < p.clip[2]
          );
        }),
      first = within(a),
      second = within(b);
    if (first.length && second.length)
      return first.some((line) => second.includes(line));
    const overlap =
      Math.min(a.clip[3], b.clip[3]) - Math.max(a.clip[1], b.clip[1]);
    return (
      overlap >=
      0.4 * Math.min(a.clip[3] - a.clip[1], b.clip[3] - b.clip[1])
    );
  };
}
export function renderDocument(
  old: Build,
  next: Build,
  inputCards: Card[],
  strips: Strips,
  figureFiles: (file: string) => boolean,
): Pick<RenderedRound, "sections" | "loose"> {
  if (old.slides || next.slides)
    return renderSlides(old, next, inputCards, strips);
  const cards = structuredClone(inputCards);
  for (const node of next.outline) {
    const members = cards.filter((c) => c.context_node === node.id);
    if (!members.some((c) => c.comparison === "text" && !c.aligned)) continue;
    try {
      const [intervals] = sectionIntervals(next, node, figureFiles);
      balanceSection(old, next, node, members, intervals, figureFiles);
    } catch (error) {
      if (
        !(error as Error).message.includes("PDF outline") &&
        !(error as Error).message.includes("outside this PDF")
      )
        throw error;
    }
  }
  const sections = readingSections(next);
  // Set the final footprint before grouping coarse crops. Precisely located
  // word edits may share a line of context without sharing a decision.
  for (const card of cards)
    for (const pair of card.pairs)
      for (const [side, build] of [
        ["old", old],
        ["new", next],
      ] as const) {
        const at = pair[side];
        if (!at) continue;
        const x = laneX(
            build.document,
            laneAt(build.document, at.page, at.clip),
          ),
          y = (card.aligned ? trimmed : snap)(
            build.document,
            at.page,
            at.clip[1],
            at.clip[3],
            x,
          );
        at.clip = [x[0], y[0], x[1], y[1]];
      }
  const order = (document: PdfDocument, a: Position, b: Position) =>
      byReading(
        readingKey(document, laneAt(document, a.page, a.clip), a.clip[1]),
        readingKey(document, laneAt(document, b.page, b.clip), b.clip[1]),
      ) || a.clip[0] - b.clip[0],
    lines = { old: sharesLine(old.document), new: sharesLine(next.document) },
    areas = regions(cards, (side, a, b) => lines[side](a, b)),
    sectionAreas = sections.flatMap(({ intervals }, value) =>
      [...intervals].flatMap(([id, spans]) =>
        spans.map(([top, bottom]) => {
          const [left, right] = laneX(next.document, id);
          return {
            page: lanePage(id),
            lane: id,
            rect: [left, top, right, bottom] as Rect,
            value,
          };
        }),
      ),
    ),
    // Section ownership covers the lane's margins too. Context retains the
    // narrower printed bounds above, but a source crop must not lose ink.
    boundaries = sectionAreas.map(({ page, lane, rect, value }) => {
      const [left, right] = next.document
        .page(page)
        .columnBounds(laneColumn(lane));
      return { page, rect: [left, rect[1], right, rect[3]] as Rect, value };
    }),
    affected = new Set(
      sectionAreas
        .filter((section) =>
          areas.some((area) =>
            area.new.some(
              (p) =>
                p.page === section.page && intersects(p.clip, section.rect),
            ),
          ),
        )
        .map((section) => section.value),
    ),
    context = sectionAreas.filter((section) => affected.has(section.value)),
    // Display sections are disjoint. Change regions take precedence over
    // all context, including floating figures.
    background = partition(
      [
        ...context,
        ...areas.flatMap((area) =>
          area.new.map((p) => ({ page: p.page, rect: p.clip, value: -1 })),
        ),
      ],
      (values) => (values.includes(-1) ? undefined : Math.min(...values)),
    );
  interface Display extends Piece {
    page: number;
    rect: Rect;
    region?: number;
    section: number;
  }
  const plan: Display[] = [],
    loosePlan: Display[] = [],
    oldShown = new Set<number>(),
    display = (
      position: Position,
      section: number,
      region?: number,
    ): Display => ({
      kind: region === undefined ? "context" : "change",
      page: position.page,
      rect: position.clip,
      lane: laneAt(next.document, position.page, position.clip),
      top: position.clip[1],
      bottom: position.clip[3],
      region,
      section,
    });
  for (const tile of background)
    plan.push(
      display({ page: tile.page, clip: tile.rect, label: "" }, tile.value),
    );
  areas.forEach((area, region) => {
    area.old = area.old
      .flatMap((p) => readingParts(old.document, p))
      .sort((a, b) => order(old.document, a, b));
    area.new = area.new
      .flatMap((p) => readingParts(next.document, p))
      .sort((a, b) => order(next.document, a, b));
    // Cut at both reading lanes and headings before assigning a section.
    // A fragment keeps its region's complete correspondence and source IDs.
    const pieces = area.new.flatMap((position) =>
        partition(
          [
            ...boundaries.filter(
              (c) =>
                c.page === position.page && intersects(c.rect, position.clip),
            ),
            { page: position.page, rect: position.clip, value: sections.length },
          ],
          (values) =>
            values.includes(sections.length) ? Math.min(...values) : undefined,
        ).map((piece) => ({ position, piece })),
      ),
      // The blank space a crop reaches into, such as the gap above a heading
      // that the next section owns, is no place of the change: on its own it
      // showed an empty strip as a separate change, in the section before or
      // under no section at all.
      printing = pieces.filter(({ position, piece }) =>
        prints(next.document, position.page, piece.rect),
      );
    for (const { position, piece } of printing.length ? printing : pieces) {
      const placed = piece.value < sections.length;
      (placed ? plan : loosePlan).push(
        display(
          { ...position, clip: piece.rect },
          placed ? piece.value : -1,
          region,
        ),
      );
    }
  });
  const change = (index: number, positions: Position[]): ChangeBlock => {
    const area = areas[index],
      members = area.members.map((i) => cards[i]),
      identical = members.every((c) => c.comparison === "identical"),
      marks = (side: "old" | "new", page: number) => {
        const all = area.pairs.flatMap(([i, j]) => {
            const card = cards[i],
              pair = card.pairs[j];
            return pair[side]?.page === page
              ? drawn(
                  card,
                  side === "old" ? pair.before_marks : pair.after_marks,
                )
              : [];
          }),
          unique = [
            ...new Map(all.map((m) => [JSON.stringify(m), m])).values(),
          ],
          edits = unique.filter((m) => m.kind !== "context");
        return unique.filter(
          (m) =>
            m.kind !== "context" ||
            !edits.some((e) => intersects(e.rect, m.rect)),
        );
      },
      images = (side: "old" | "new", build: Build, positions: Position[]) =>
        positions.flatMap(p => {
          const image = strips.write(build.document, p.page, p.clip[1], p.clip[3],
            marks(side, p.page), side, [p.clip[0], p.clip[2]]);
          if (!image) return [];
          image.marks = area.pairs.flatMap(([i, j]) => {
            const card = cards[i], pair = card.pairs[j];
            if (pair[side]?.page !== p.page) return [];
            return drawn(card, side === "old" ? pair.before_marks : pair.after_marks)
              .filter(m => m.kind !== "context" && intersects(m.rect, p.clip))
              .map(m => {
                const r = intersect(m.rect, p.clip);
                return { kind: m.kind, unit: card.id,
                  rect: [r[0] - (image.left || 0), r[1] - image.top!, r[2] - (image.left || 0), r[3] - image.top!] as Rect };
              });
          });
          image.marks = [...new Map(image.marks.map(mark => [JSON.stringify(mark), mark])).values()];
          return [image];
        }),
      kinds = new Set(
        area.pairs.flatMap(([i, j]) => {
          const card = cards[i],
            pair = card.pairs[j];
          return drawn(card, [...pair.before_marks, ...pair.after_marks]).map(
            (m) => m.kind,
          );
        }),
      ),
      edited = kinds.has("removed") || kinds.has("added") || kinds.has("moved"),
      before =
        oldShown.has(index) || (identical && area.new.length)
          ? []
          : images("old", old, area.old);
    oldShown.add(index);
    return {
      kind: "change",
      units: members.map((c) => c.id),
      identical,
      reflow:
        !identical && !edited && members.every((c) => c.comparison === "text"),
      ...(kinds.has("moved") ? { moved: true } : {}),
      before,
      after: images("new", next, positions),
    };
  };
  const compare = (a: Display, b: Display) =>
      byReading(
        readingKey(next.document, a.lane, a.top),
        readingKey(next.document, b.lane, b.top),
      ) || a.rect[0] - b.rect[0],
    kept: { section: number; pieces: (Display | { kind: "gap" })[] }[] = [];
  // Fold once in document order, so context can continue through a heading
  // without a second copy or a jump over a child section.
  if (plan.some((p) => p.kind === "change"))
    for (const piece of foldContext(plan.sort(compare))) {
      const last = kept.at(-1);
      if (piece.kind !== "gap" && last?.section !== piece.section)
        kept.push({ section: piece.section, pieces: [piece] });
      else last?.pieces.push(piece);
    }
  // One block per region, wherever its pieces print: a later piece joins the
  // region's block rather than starting a second block of the same edits.
  // Short context between two pieces in one section joins it too, so the
  // block reads straight through instead of jumping over those lines.
  const shown = new Map<number, ChangeBlock>(),
    JOIN = 120;
  const render = (pieces: (Display | { kind: "gap" })[]): Block[] => {
    const blocks: Block[] = [];
    for (const piece of pieces) {
      if (piece.kind === "gap") blocks.push({ kind: "gap" });
      else if (piece.region === undefined) {
        const image = strips.write(
          next.document,
          piece.page,
          piece.top,
          piece.bottom,
          [],
          "",
          [piece.rect[0], piece.rect[2]],
        );
        if (image) blocks.push({ kind: "context", image });
      } else {
        const block = change(piece.region, [
            { page: piece.page, clip: piece.rect, label: "" },
          ]),
          earlier = shown.get(piece.region);
        if (!earlier) {
          shown.set(piece.region, block);
          blocks.push(block);
          continue;
        }
        const at = blocks.indexOf(earlier),
          between = at < 0 ? [] : blocks.slice(at + 1);
        if (
          at >= 0 &&
          between.every((b) => b.kind === "context") &&
          between.reduce((sum, b) => sum + (b.kind === "context" ? b.image.height : 0), 0) <= JOIN
        ) {
          blocks.splice(at + 1);
          earlier.after.push(
            ...between.flatMap((b) => (b.kind === "context" ? [b.image] : [])),
          );
        }
        earlier.after.push(...block.after);
      }
    }
    return blocks;
  };
  const rendered = kept.map(({ section, pieces }) => {
      const { node } = sections[section];
      return {
        node: node.id,
        number: node.number,
        title: node.title,
        blocks: render(pieces),
      };
    }),
    loose = render(loosePlan.sort(compare)).filter(
      (b): b is ChangeBlock => b.kind === "change",
    );
  areas.forEach((area, index) => {
    if (!area.new.length) loose.push(change(index, []));
  });
  return linkBlocks(rendered, loose, cards);
}
// Blocks of the same edits are one block; edits that remain in several
// blocks say why. An edit is in several regions when its crops form
// separate groups: its source prints in several places, or its text left
// one place for another far from it.
function linkBlocks(
  sections: RenderedRound["sections"],
  loose: ChangeBlock[],
  cards: Card[],
): Pick<RenderedRound, "sections" | "loose"> {
  const all = [
      ...sections.flatMap((s) => s.blocks),
      ...loose,
    ].filter((b): b is ChangeBlock => b.kind === "change"),
    first = new Map<string, ChangeBlock>(),
    dropped = new Set<ChangeBlock>();
  for (const block of all) {
    const key = JSON.stringify(block.units),
      earlier = first.get(key);
    if (!earlier) {
      first.set(key, block);
      continue;
    }
    earlier.before.push(...block.before);
    earlier.after.push(...block.after);
    earlier.identical &&= block.identical;
    if (block.moved) earlier.moved = true;
    if (!block.reflow) delete earlier.reflow;
    dropped.add(block);
  }
  const kept = all.filter((b) => !dropped.has(b)),
    count = new Map<string, number>();
  for (const block of kept)
    for (const unit of block.units) count.set(unit, (count.get(unit) ?? 0) + 1);
  const reason = (unit: string): "places" | "moved" => {
    const groups = new Map<number, { old: boolean; new: boolean }>();
    for (const pair of cards.find((c) => c.id === unit)?.pairs ?? []) {
      const group = groups.get(pair.group ?? 0) ?? { old: false, new: false };
      group.old ||= Boolean(pair.old);
      group.new ||= Boolean(pair.new);
      groups.set(pair.group ?? 0, group);
    }
    const sides = [...groups.values()];
    return sides.some((g) => g.old && !g.new) && sides.some((g) => g.new && !g.old)
      ? "moved"
      : "places";
  };
  for (const block of kept) {
    const linked = block.units
      .filter((unit) => (count.get(unit) ?? 0) > 1)
      .map((unit) => ({ unit, reason: reason(unit) }));
    if (linked.length) block.linked = linked;
  }
  return {
    sections: sections.map((s) => ({
      ...s,
      blocks: s.blocks.filter((b) => b.kind !== "change" || !dropped.has(b)),
    })),
    loose: loose.filter((b) => !dropped.has(b)),
  };
}
