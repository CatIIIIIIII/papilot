import fs from "node:fs";
import path from "node:path";
import { argument, buildOutline } from "../core/outline.ts";
import { SynctexIndex } from "./synctex.ts";
import { listFiles } from "../core/files.ts";
import { PdfDocument, type PdfPage, type OutlineEntry } from "./pdf.ts";
import type {
  BuildInfo,
  Heading,
  Position,
  Rect,
  Span,
  SourceBox,
} from "../types.ts";
const MAX_LOOKUPS = 80;
const BOUNDARY =
  /^\s*\\(?:\[|\]|begin\{|end\{|input\{|include\{|(?:sub)*section\*?\{|chapter\*?\{|paragraph\{)/;
export type Box = SourceBox;
export type Intervals = Map<number, Span[]>;
export class Build {
  document: PdfDocument;
  locator: Locator;
  margins: Margins;
  figures: FigureLocator;
  outline: Heading[];
  constructor(
    public info: BuildInfo,
    public main: string,
    public sourceDir: string,
  ) {
    this.document = new PdfDocument(info.pdf);
    this.margins = new Margins(this.document);
    this.locator = new Locator(this);
    this.outline = buildOutline((n) => this.read(n), main).nodes;
    this.figures = new FigureLocator(this);
  }
  path(name: string) {
    return path.join(
      this.info.root,
      path.posix.relative(this.sourceDir || ".", name),
    );
  }
  read(name: string) {
    const file = this.path(name);
    return fs.existsSync(file) && fs.statSync(file).isFile()
      ? fs.readFileSync(file, "utf8")
      : null;
  }
  close() {
    this.document.close();
    this.locator.close();
  }
}
export function sourceRange(
  lines: string[],
  start: number,
  end: number,
  whole = false,
): Span {
  if (!lines.length) return [1, 0];
  if (whole) return [1, lines.length];
  start = Math.min(Math.max(1, start), lines.length);
  end = Math.min(Math.max(1, end), lines.length);
  const lower = Math.max(1, start - 60),
    upper = Math.min(lines.length, end + 60);
  while (
    start > lower &&
    lines[start - 2].trim() &&
    !BOUNDARY.test(lines[start - 2])
  )
    start--;
  while (end < upper && lines[end].trim() && !BOUNDARY.test(lines[end])) end++;
  return [start, end];
}
export function textBounds(page: PdfPage): Span {
  const blocks = page.blocks.filter((b) => b.text.trim());
  return blocks.length
    ? [
        Math.max(0, Math.min(...blocks.map((b) => b.rect[0])) - 8),
        Math.min(page.width, Math.max(...blocks.map((b) => b.rect[2])) + 8),
      ]
    : [0, page.width];
}
const textBlocks = (page: PdfPage) =>
  page.blocks
    .filter((b) => b.text.trim())
    .sort((a, b) => a.rect[1] - b.rect[1]);
export class Margins {
  header: number | null = null;
  footer: number | null = null;
  constructor(document: PdfDocument) {
    const sample =
        document.length > 40
          ? [
              ...new Set(
                Array.from({ length: 40 }, (_, i) =>
                  Math.round((i * (document.length - 1)) / 39),
                ),
              ),
            ]
          : Array.from({ length: document.length }, (_, i) => i),
      tops = new Map<number, number>(),
      bottoms = new Map<number, number>();
    const add = (counts: Map<number, number>, n: number) =>
      counts.set(n, (counts.get(n) ?? 0) + 1);
    for (const number of sample) {
      const blocks = textBlocks(document.page(number));
      if (blocks.length < 2) continue;
      if (blocks[1].rect[1] - blocks[0].rect[3] >= 8)
        add(tops, Math.round(blocks[0].rect[3]));
      if (
        blocks.at(-1)!.rect[1] -
          Math.max(...blocks.slice(0, -1).map((b) => b.rect[3])) >=
        8
      )
        add(bottoms, Math.round(blocks.at(-1)!.rect[1]));
    }
    const best = (counts: Map<number, number>) =>
        [...counts].sort((a, b) => b[1] - a[1])[0],
      top = best(tops),
      bottom = best(bottoms),
      needed = Math.max(3, 0.3 * sample.length);
    if (top && top[1] >= needed) this.header = top[0] + 1;
    if (bottom && bottom[1] >= needed) this.footer = bottom[0] - 1;
  }
  body(page: PdfPage): Span {
    const blocks = textBlocks(page).filter(
      (b) =>
        !(this.header !== null && b.rect[3] <= this.header + 1) &&
        !(this.footer !== null && b.rect[1] >= this.footer - 1),
    );
    return blocks.length
      ? [
          Math.max(0, Math.min(...blocks.map((b) => b.rect[1])) - 6),
          Math.min(page.height, Math.max(...blocks.map((b) => b.rect[3])) + 6),
        ]
      : [(this.header ?? 36) + 4, (this.footer ?? page.height - 36) - 4];
  }
}
// The CLI prints six decimals with printf, which rounds an exact half to
// even where toFixed rounds it up; matching it keeps every crop the same as
// with `synctex view`.
export function printed(value: number) {
  const exact = Math.abs(value).toFixed(30),
    cut = exact.indexOf(".") + 7,
    kept = exact.slice(0, cut);
  const magnitude =
    /^50*$/.test(exact.slice(cut)) && Number(kept.at(-1)) % 2 === 0
      ? Number(kept)
      : Number(Math.abs(value).toFixed(6));
  return value < 0 ? -magnitude : magnitude;
}
export class Locator {
  cache = new Map<string, Box[]>();
  private index: SynctexIndex | null = null;
  constructor(public build: Build) {}
  lookup(file: string, line: number): Box[] {
    const key = `${file}:${line}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    this.index ??= new SynctexIndex(this.build.info.pdf);
    const records: Box[] = [],
      shipped = new Set<number>(),
      margins = this.build.margins;
    for (const result of this.index.view(file, line)) {
      const [number, , y, h, v, W, height] = result.map(printed),
        page = number - 1,
        fields = { h, W };
      if (
        ![page, y, v, height].every(Number.isFinite) ||
        y < v - height - 4 ||
        y > v + 4
      )
        continue;
      if (
        (margins.header !== null && y < margins.header) ||
        (margins.footer !== null && y > margins.footer)
      )
        shipped.add(page);
      else
        records.push([
          page,
          Math.min(y, v - height),
          Math.max(y, v),
          fields.h,
          fields.h + fields.W,
        ]);
    }
    const filtered = records.filter((r) => !shipped.has(r[0]));
    this.cache.set(key, filtered);
    return filtered;
  }
  close() {
    this.index?.close();
    this.index = null;
  }
  boxes(name: string, start: number, end: number) {
    const file = this.build.path(name);
    if (!fs.existsSync(file) || path.extname(file) !== ".tex") return [];
    const result: Box[] = [];
    for (
      let line = Math.max(1, start);
      line <= end && line < Math.max(1, start) + MAX_LOOKUPS;
      line++
    )
      result.push(...this.lookup(file, line));
    return result;
  }
  locate(name: string, start: number, end: number, whole = false): Position[] {
    const file = this.build.path(name);
    if (!fs.existsSync(file) || path.extname(file) !== ".tex") return [];
    const lines = fs.readFileSync(file, "utf8").split("\n");
    [start, end] = sourceRange(lines, start, end, whole);
    let wanted = Array.from(
      { length: Math.max(0, end - start + 1) },
      (_, i) => i + start,
    ).filter(
      (n) => lines[n - 1].trim() && !lines[n - 1].trimStart().startsWith("%"),
    );
    if (wanted.length > MAX_LOOKUPS) {
      const step = wanted.length / MAX_LOOKUPS;
      wanted = [
        ...new Set([
          ...Array.from(
            { length: MAX_LOOKUPS },
            (_, i) => wanted[Math.floor(i * step)],
          ),
          wanted[0],
          wanted.at(-1)!,
        ]),
      ].sort((a, b) => a - b);
    }
    const positions = new Map<
      string,
      { page: number; column: number; points: Span[] }
    >();
    for (const n of wanted)
      for (const [page, y0, y1, x0, x1] of this.lookup(file, n))
        if (page >= 0 && page < this.build.document.length) {
          const column =
            !whole && x0 !== undefined && x1 !== undefined
              ? this.build.document.page(page).column([x0, y0, x1, y1])
              : -1;
          const key = `${page}:${column}`;
          if (!positions.has(key))
            positions.set(key, { page, column, points: [] });
          positions.get(key)!.points.push([y0, y1]);
        }
    return [...positions.values()]
      .sort((a, b) => a.page - b.page || a.column - b.column)
      .map(({ page: number, column, points }) => {
        const page = this.build.document.page(number),
          [columnLeft, columnRight] = page.columnBounds(column);
        let top = Math.max(0, Math.min(...points.map((p) => p[0])) - 14),
          bottom = Math.min(
            page.height,
            Math.max(...points.map((p) => p[1])) + 16,
          );
        for (const block of page.blocks)
          if (
            block.rect[1] < bottom &&
            block.rect[3] > top &&
            block.rect[0] < columnRight &&
            block.rect[2] > columnLeft &&
            block.rect[3] - block.rect[1] < 180
          ) {
            top = Math.min(top, block.rect[1] - 8);
            bottom = Math.max(bottom, block.rect[3] + 8);
          }
        const [bodyTop, bodyBottom] = this.build.margins.body(page);
        top = Math.max(
          top,
          Math.min(bodyTop, Math.min(...points.map((p) => p[0]))),
        );
        bottom = Math.min(
          bottom,
          Math.max(bodyBottom, Math.max(...points.map((p) => p[1]))),
        );
        const [left, right] = textBounds(page);
        return {
          page: number,
          clip: [
            Math.max(left, columnLeft),
            Math.max(0, top),
            Math.min(right, columnRight),
            Math.min(page.height, bottom),
          ],
          label: page.label,
        };
      });
  }
}
const FLOAT_STRUCTURE =
  /^\s*(%|\\(begin|end)\{(figure|table)\*?\}|\\(caption|label|centering)\b)/;
export const contentLines = (text: string) =>
  text
    .split("\n")
    .flatMap((line, i) =>
      line.trim() && !FLOAT_STRUCTURE.test(line) ? [i + 1] : [],
    );
export class FigureLocator {
  labels = new Map<string, [string, string]>();
  constructor(public build: Build) {
    for (const file of listFiles(path.dirname(build.info.pdf)).filter((f) =>
      f.endsWith(".aux"),
    ))
      for (const line of fs.readFileSync(file, "utf8").split("\n"))
        if (line.startsWith("\\newlabel")) {
          const [label, end] = argument(line, "\\newlabel".length),
            [value] = argument(line, end);
          if (!value || !label) continue;
          const fields: string[] = [];
          let i = 0;
          while (i < value.length) {
            const [field, next] = argument(value, i);
            if (field === null) break;
            fields.push(field);
            i = next;
          }
          if (fields.length >= 4)
            this.labels.set(label, [fields[0], fields[3]]);
        }
  }
  locate(name: string): Position[] {
    const text = this.build.read(name);
    if (text === null) return [];
    const result: Position[] = [];
    for (const match of text.matchAll(/\\label\{([^}]+)\}/g)) {
      const [number, anchor] = this.labels.get(match[1]) ?? ["", ""],
        destination = this.build.document.destination(
          "#nameddest=" + encodeURIComponent(anchor),
        );
      if (!destination || !anchor.startsWith("figure.")) continue;
      const page = this.build.document.page(destination.page);
      let top = destination.y;
      const captions = [
        "Figure ",
        "Fig. ",
        "Abbildung ",
        "Figure~",
        "图 ",
        "图",
      ].flatMap((prefix) =>
        [":", "："].flatMap((colon) => page.search(prefix + number + colon)),
      );
      if (!captions.length) continue;
      const caption = captions.sort(
          (a, b) => Math.abs(a[1] - top) - Math.abs(b[1] - top),
        )[0],
        bottom =
          Math.max(
            caption[3],
            ...page.blocks
              .filter((b) => b.rect[1] < caption[3] && b.rect[3] > caption[1])
              .map((b) => b.rect[3]),
          ) + 10;
      const content = contentLines(text)
        .slice(0, MAX_LOOKUPS)
        .flatMap((line) =>
          this.build.locator.lookup(this.build.path(name), line),
        )
        .filter(
          ([p, y0]) =>
            p === destination.page &&
            caption[1] - 0.8 * page.height < y0 &&
            y0 < caption[1],
        )
        .map(([, y0]) => y0);
      top = Math.min(top, ...content);
      const [left, right] = textBounds(page);
      result.push({
        page: destination.page,
        clip: [left, Math.max(0, top - 6), right, bottom],
        label: page.label,
      });
    }
    return result;
  }
}
export function entryFor(node: Heading, toc: OutlineEntry[]) {
  const names = [
    node.kind + "." + node.number,
    ...(["chapter", "section"].includes(node.kind)
      ? ["appendix." + node.number]
      : []),
  ];
  let matches = toc.flatMap((row, i) => (names.includes(row.name) ? [i] : []));
  if (!matches.length)
    matches = toc.flatMap((row, i) =>
      row.title.trim().toLowerCase() === node.title.trim().toLowerCase() ||
      row.title.trim().toLowerCase() ===
        `${node.number} ${node.title}`.trim().toLowerCase()
        ? [i]
        : [],
    );
  if (matches.length !== 1)
    throw new Error(
      `Heading ${node.number} ${JSON.stringify(node.title)} is not uniquely in the PDF outline.`,
    );
  return matches[0];
}
export function position(
  document: PdfDocument,
  row: OutlineEntry,
): [number, number] {
  if (row.page < 0 || row.page >= document.length)
    throw new Error("The heading is outside this PDF.");
  return [row.page, Math.max(0, row.y - 4)];
}
export function addInterval(
  intervals: Intervals,
  page: number,
  top: number,
  bottom: number,
) {
  if (bottom - top <= 2) return;
  const merged: Span[] = [];
  for (const [a, b] of [
    ...(intervals.get(page) ?? []),
    [top, bottom] as Span,
  ].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && a <= last[1] + 20) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  intervals.set(page, merged);
}
export function subtractInterval(
  intervals: Intervals,
  page: number,
  top: number,
  bottom: number,
) {
  intervals.set(
    page,
    (intervals.get(page) ?? []).flatMap(([a, b]) =>
      b <= top || a >= bottom
        ? [[a, b] as Span]
        : [
            ...(top - a > 2 ? [[a, top] as Span] : []),
            ...(b - bottom > 2 ? [[bottom, b] as Span] : []),
          ],
    ),
  );
}
// A lane is a stretch of a page that reads in order: the whole page, or, on
// a page with two columns, each column and the bands printed across the
// gutter. Intervals of a section are keyed by lane: page × 3 + column + 1.
export const lane = (page: number, column: number) => page * 3 + column + 1;
export const lanePage = (id: number) => Math.floor(id / 3);
export const laneColumn = (id: number) => (id % 3) - 1;
// The lane a rect of a page prints in.
export const laneAt = (document: PdfDocument, number: number, rect: Rect) =>
  lane(number, document.page(number).column(rect));
// The horizontal extent of a lane's crops: the page, or the printed width of
// a column.
export function laneX(document: PdfDocument, id: number): Span {
  const page = document.page(lanePage(id)),
    column = laneColumn(id);
  if (column < 0) return [0, page.width];
  const [a, b] = page.columnBounds(column),
    [left, right] = textBounds(page);
  return [Math.max(a, left), Math.min(b, right)];
}
// A page's stretches in reading order between two heights: the whole page,
// or, with two columns, each band across the gutter and, between bands, the
// left column and then the right.
function stretches(page: PdfPage, top: number, bottom: number) {
  if (!page.twoColumns) return [{ column: -1, top, bottom }];
  const result: { column: number; top: number; bottom: number }[] = [],
    columns = (a: number, b: number) =>
      b > a &&
      result.push(
        { column: 0, top: a, bottom: b },
        { column: 1, top: a, bottom: b },
      );
  let cursor = top;
  for (const [a, b] of page.spanning) {
    const from = Math.max(a, top),
      to = Math.min(b, bottom);
    if (to <= from) continue;
    columns(cursor, from);
    result.push({ column: -1, top: from, bottom: to });
    cursor = to;
  }
  columns(cursor, bottom);
  return result;
}
// Where a lane starts in reading order, for sorting: its page, the stretch
// it is in, and its column.
export function readingKey(document: PdfDocument, id: number, top: number) {
  const number = lanePage(id),
    column = laneColumn(id),
    page = document.page(number),
    above = page.twoColumns
      ? page.spanning.filter(([, b]) => b <= top + 1).length
      : 0;
  return [number, column < 0 ? 2 * above + 1 : 2 * above, column, top];
}
export const byReading = (a: number[], b: number[]) =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];
/** Where a heading prints: page, top and column (-1 across the page). */
export type Spot = [number, number, number];
// The column of the text at a height of a page, preferring a line with a word.
function columnAt(document: PdfDocument, number: number, y: number, word = "") {
  const page = document.page(number);
  if (!page.twoColumns) return -1;
  const near = page.lines
      .filter((l) => l.text.trim() && l.rect[1] >= y - 2 && l.rect[1] <= y + 30)
      .sort((a, b) => a.rect[1] - b.rect[1]),
    hit =
      near.find(
        (l) => word && l.text.toLowerCase().includes(word.toLowerCase()),
      ) ?? near[0];
  return hit ? page.column(hit.rect) : -1;
}
const spotOf = (
  document: PdfDocument,
  [page, y]: [number, number],
  title: string,
): Spot => [page, y, columnAt(document, page, y, title.split(/\s+/)[0])];
// Where a heading prints: its PDF bookmark, or, in a PDF without bookmarks
// (no hyperref, or a class that turns them off), where SyncTeX places the
// line of its command; its column from SyncTeX, or from the text there.
export function headingAt(build: Build, node: Heading): Spot | null {
  const document = build.document,
    toc = document.outline,
    boxes = build.locator
      .lookup(build.path(node.file), node.line)
      .filter((box) => box[0] >= 0 && box[0] < document.length),
    first = boxes.length
      ? boxes.reduce((a, b) =>
          b[0] < a[0] || (b[0] === a[0] && b[1] < a[1]) ? b : a,
        )
      : null,
    at = (place: [number, number]): Spot => {
      const [page, y] = place,
        x = first && first[0] === page ? [first[3], first[4]] : [];
      return x.length === 2 && Number.isFinite(Number(x[0]) + Number(x[1]))
        ? [
            page,
            y,
            document.page(page).column([x[0]!, first![1], x[1]!, first![2]]),
          ]
        : spotOf(document, place, node.title);
    };
  try {
    return at(position(document, toc[entryFor(node, toc)]));
  } catch {
    return first && at([first[0], Math.max(0, first[1] - 4)]);
  }
}
// The lanes of the PDF from one spot to another in reading order. A spot
// on a page with two columns whose column is unknown starts in the left
// column and ends in the right, so that nothing is left out.
function flow(build: Build, start: Spot, end: Spot | null): Intervals {
  const document = build.document,
    intervals: Intervals = new Map(),
    last = document.length - 1,
    to: Spot = end ?? [last, document.page(last).height - 60, 1];
  for (let number = start[0]; number <= to[0]; number++) {
    const page = document.page(number),
      parts = stretches(page, ...build.margins.body(page)),
      // The stretch a spot is in or before, by reading order.
      find = ([, y, column]: Spot, unknown: number) => {
        const c = page.twoColumns && column < 0 ? unknown : column,
          k = parts.findIndex(
            (p) => (p.column < 0 || p.column === c) && y <= p.bottom,
          );
        return k < 0 ? parts.length : k;
      },
      from = number === start[0] ? find(start, 0) : 0,
      until = number === to[0] ? find(to, 1) : parts.length;
    parts.forEach((p, k) => {
      if (k < from || k > until) return;
      const a =
          k === from && number === start[0]
            ? k
              ? Math.max(p.top, start[1])
              : start[1]
            : p.top,
        b =
          k === until && number === to[0]
            ? k < parts.length - 1
              ? Math.min(p.bottom, to[1])
              : to[1]
            : p.bottom;
      addInterval(intervals, lane(number, p.column), a, b);
    });
  }
  return intervals;
}
export function sectionIntervals(
  build: Build,
  node: Heading,
  figureFiles: (file: string) => boolean,
): [Intervals, string[]] {
  const document = build.document,
    toc = document.outline,
    start = headingAt(build, node);
  if (!start)
    throw new Error(
      `Heading ${node.number} ${JSON.stringify(node.title)} is not in the PDF outline.`,
    );
  // The section ends at the next bookmark of its level or above, or, without
  // bookmarks, at the next heading of its level or above.
  let boundary: Spot | null = null,
    following: Heading | null = null;
  try {
    const index = entryFor(node, toc),
      row = toc
        .slice(index + 1)
        .find((r) => r.level <= toc[index].level && r.page >= 0);
    if (row) {
      following =
        build.outline.find((candidate) => {
          try {
            return toc[entryFor(candidate, toc)] === row;
          } catch {
            return false;
          }
        }) ?? null;
      boundary =
        (following && headingAt(build, following)) ??
        spotOf(document, position(document, row), row.title);
    }
  } catch {
    const at = build.outline.findIndex((n) => n.id === node.id);
    following =
      build.outline.slice(at + 1).find((n) => n.level <= node.level) ?? null;
    boundary = following && headingAt(build, following);
  }
  const intervals = flow(build, start, boundary);
  const own = new Set(node.files.filter(figureFiles));
  if (following)
    for (const file of following.files)
      if (!own.has(file) && figureFiles(file))
        for (const r of build.figures.locate(file))
          subtractInterval(
            intervals,
            laneAt(document, r.page, r.clip),
            r.clip[1],
            r.clip[3],
          );
  const missing: string[] = [];
  for (const file of own) {
    const found = build.figures.locate(file);
    if (!found.length) missing.push(file);
    for (const r of found)
      addInterval(
        intervals,
        laneAt(document, r.page, r.clip),
        r.clip[1],
        r.clip[3],
      );
  }
  return [intervals, missing];
}
