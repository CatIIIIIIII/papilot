import fs from "node:fs";
import path from "node:path";
import { argument, buildOutline } from "../core/outline.ts";
import {
  bodyFiles,
  sourceInputs,
  structuralSource,
} from "../core/tex-source.ts";
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
// Resolve frame wrappers from the sources actually loaded by the document.
// An outer environment may contain many frames; its closing line is not a
// valid substitute for the closing line of the frame being edited.
function frameEnvironments(
  read: (name: string) => string | null,
  main: string,
) {
  const names = new Set(["frame"]),
    seen = new Set<string>(),
    definitions = new Map<string, string>(),
    parents = new Map<string, { file: string; line: number }[]>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = structuralSource(read(file) ?? "");
    for (const input of sourceInputs(text, main)) {
      if (!parents.has(input.file)) parents.set(input.file, []);
      parents.get(input.file)!.push({ file, line: input.line });
      walk(input.file);
    }
    // Wrapper environments are often defined in a project-local package.
    // Installed TeX packages need no filesystem search here: read() returns
    // null for dependencies outside the build's source tree.
    for (const match of text.matchAll(
      /\\(?:usepackage|RequirePackage|LoadClass|LoadClassWithOptions)\b/g,
    )) {
      const [packages] = argument(text, match.index + match[0].length);
      for (const name of packages?.split(",") ?? []) {
        const local = name.trim();
        if (!local || /[\\#]/.test(local) || path.posix.isAbsolute(local))
          continue;
        const child = path.posix.normalize(
          path.posix.join(
            path.posix.dirname(main),
            local + (match[0].includes("Class") ? ".cls" : ".sty"),
          ),
        );
        if (child !== ".." && !child.startsWith("../")) walk(child);
      }
    }
    for (const match of text.matchAll(
      /\\(newenvironment|renewenvironment|(?:New|Renew|Provide|Declare)DocumentEnvironment|NewEnviron|RenewEnviron)\*?\s*/g,
    )) {
      const [name, afterName] = argument(text, match.index! + match[0].length);
      if (!name) continue;
      const position = match[1].endsWith("DocumentEnvironment")
        ? argument(text, afterName)[1]
        : afterName;
      const [opening, afterOpening] = argument(text, position),
        closing = match[1].endsWith("Environ")
          ? ""
          : argument(text, afterOpening)[0];
      if (opening !== null) definitions.set(name, opening + (closing ?? ""));
    }
  };
  walk(main);
  let added = true;
  while (added) {
    added = false;
    for (const [name, body] of definitions) {
      if (names.has(name)) continue;
      if (
        /\\frame\b/.test(body) ||
        [...body.matchAll(/\\begin\s*\{([^}]+)\}/g)].some((m) =>
          names.has(m[1]),
        )
      ) {
        names.add(name);
        added = true;
      }
    }
  }
  return { names, parents };
}
export class Build {
  document: PdfDocument;
  locator: Locator;
  margins: Margins;
  figures: FigureLocator;
  outline: Heading[];
  bodyFiles: string[];
  slides: boolean;
  frameEnvironments: Set<string>;
  inputParents: Map<string, { file: string; line: number }[]>;
  constructor(
    public info: BuildInfo,
    public main: string,
    public sourceDir: string,
  ) {
    this.document = new PdfDocument(info.pdf);
    this.margins = new Margins(this.document);
    this.locator = new Locator(this);
    const outline = buildOutline((n) => this.read(n), main);
    this.outline = outline.nodes;
    this.bodyFiles = bodyFiles((name) => this.read(name), main);
    this.slides = /\\documentclass\s*(?:\[[^\]]*\]\s*)?\{beamer\}/.test(
      structuralSource(this.read(main) ?? ""),
    );
    const frames = this.slides
      ? frameEnvironments((name) => this.read(name), main)
      : null;
    this.frameEnvironments = frames?.names ?? new Set();
    this.inputParents = new Map(
      [...(frames?.parents ?? [])].map(([name, parents]) => [
        this.path(name),
        parents.map((parent) => ({ ...parent, file: this.path(parent.file) })),
      ]),
    );
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
  baseline(
    page: number,
    origin: [number, number],
    _row?: number,
  ): number | undefined {
    return this.baselines(page, [origin])[0];
  }
  baselines(
    page: number,
    origins: ([number, number] | undefined)[],
  ): (number | undefined)[] {
    this.index ??= new SynctexIndex(this.build.info.pdf);
    const candidates = origins.map((origin) =>
      origin ? this.index!.baseline(page + 1, origin[0], origin[1]) : [],
    );
    // An overflowing script may overlap the next line. Its rectangle alone
    // cannot own a glyph when the complete printed line corresponds to a
    // different TeX line. Intersect the candidates for the entire line first.
    let common: Set<number> | undefined;
    for (const boxes of candidates) {
      if (!boxes.length) continue;
      const rows = new Set(boxes.map((box) => box[0]));
      common = common
        ? new Set([...common].filter((value) => rows.has(value)))
        : rows;
    }
    const row = common?.size === 1 ? [...common][0] : undefined;
    return candidates.map((boxes, i) => {
      const box = boxes.find((box) => box[0] === row) ?? boxes[0];
      if (!box) return;
      // TeX records more coordinate precision than a PDF text matrix. Use
      // the drawn baseline for glyphs sitting on their own hbox baseline,
      // while retaining that box's accumulated inline displacement.
      const y = origins[i]![1];
      return box[0] + (Math.abs(y - box[1]) < 0.01 ? y - box[1] : 0);
    });
  }

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
  locate(
    name: string,
    start: number,
    end: number,
    whole = false,
    changed?: Span[],
  ): Position[] {
    const file = this.build.path(name);
    if (!fs.existsSync(file) || path.extname(file) !== ".tex") return [];
    const lines = fs.readFileSync(file, "utf8").split("\n");
    if (this.build.slides)
      return this.slidePages(file, lines, changed ?? [[start - 1, end]], whole);
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
  private slidePages(
    file: string,
    lines: string[],
    changed: Span[],
    whole: boolean,
    visited = new Set<string>(),
    enclosingOnly = false,
  ): Position[] {
    if (visited.has(file)) return [];
    visited = new Set(visited).add(file);
    // An input inside a frame belongs to that canvas, even when the input
    // also defines macros that contain frame syntax. Resolve the enclosing
    // frame before inspecting local boundaries or an empty diff side.
    const inherited = (this.build.inputParents.get(file) ?? []).flatMap(
      (parent) =>
        fs.existsSync(parent.file)
          ? this.slidePages(
              parent.file,
              fs.readFileSync(parent.file, "utf8").split("\n"),
              [[parent.line - 1, parent.line]],
              false,
              visited,
              true,
            )
          : [],
    );
    if (inherited.length)
      return [...new Map(inherited.map((at) => [at.page, at])).values()].sort(
        (a, b) => a.page - b.page,
      );
    // Beamer (and body-capturing frame wrappers) records the frame at its
    // closing line. Interior queries can instead resolve to the previous
    // frame. Query enclosing frame environments at their closing lines.
    const stack: { name: string; line: number }[] = [],
      blocks: Span[] = [],
      source = structuralSource(lines.join("\n")).split("\n");
    source.forEach((line, i) => {
      for (const match of line.matchAll(/\\(begin|end)\s*\{([^}]+)\}/g)) {
        if (match[2] === "document") continue;
        if (match[1] === "begin") stack.push({ name: match[2], line: i + 1 });
        else if (stack.at(-1)?.name === match[2]) {
          const opening = stack.pop()!;
          if (this.build.frameEnvironments.has(opening.name))
            blocks.push([opening.line, i + 1]);
        }
      }
    });
    const text = source.join("\n");
    for (const match of text.matchAll(/\\frame\b/g)) {
      let at = match.index + match[0].length;
      // Beamer accepts overlay specifications and frame options before its
      // braced body. Match the body braces, rather than guessing a nearby row.
      while (at < text.length) {
        while (/\s/.test(text[at] ?? "") && at < text.length) at++;
        const close = text[at] === "<" ? ">" : text[at] === "[" ? "]" : null;
        if (!close) break;
        const end = text.indexOf(close, at + 1);
        if (end < 0) break;
        at = end + 1;
      }
      const [body, end] = argument(text, at);
      if (body !== null)
        blocks.push([
          text.slice(0, match.index).split("\n").length,
          text.slice(0, end).split("\n").length,
        ]);
    }
    // Diff operations are zero-based, half-open. An empty side belongs to
    // a frame only when its insertion point is strictly inside that frame.
    // Deleting/inserting a whole frame must not select its unchanged neighbor.
    const selected = blocks.filter(
        ([a, b]) =>
          whole ||
          changed.some(([start, end]) =>
            start === end
              ? a - 1 < start && start < b
              : a - 1 < end && start < b,
          ),
      ),
      queries = selected.length
        ? selected.map(([, b]) => b)
        : enclosingOnly
          ? []
          : changed
              .flatMap(([start, end]) =>
                Array.from(
                  { length: Math.max(0, end - start) },
                  (_, i) => start + i + 1,
                ),
              )
              .filter((line) => source[line - 1]?.trim());
    this.index ??= new SynctexIndex(this.build.info.pdf);
    const pages = new Set<number>();
    for (const line of queries)
      for (const [number] of this.index.view(file, line))
        if (number >= 1 && number <= this.build.document.length)
          pages.add(number - 1);
    return [...pages]
      .sort((a, b) => a - b)
      .map((number) => {
        const page = this.build.document.page(number);
        return {
          page: number,
          clip: [0, 0, page.width, page.height] as Rect,
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
    // Gaps can belong to another lane, such as a band across both columns.
    // Union only overlapping intervals; presentation joins nearby changes.
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
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
/** Split a source footprint at the page's reading lanes without changing its
 * coverage. A wide source box can cover separate columns; only printed bands
 * across the gutter belong in one full-width fragment. */
export function readingParts(
  document: PdfDocument,
  position: Position,
): Position[] {
  const page = document.page(position.page);
  return stretches(page, position.clip[1], position.clip[3]).flatMap(
    ({ column, top, bottom }) => {
      const [left, right] = page.columnBounds(column),
        x0 = Math.max(left, position.clip[0]),
        x1 = Math.min(right, position.clip[2]);
      return x1 > x0
        ? [{ ...position, clip: [x0, top, x1, bottom] as Rect }]
        : [];
    },
  );
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
/** Display sections partition reading order at every heading. Source sections
 * remain hierarchical (sectionIntervals); using those nested ranges to place
 * display fragments lets a parent steal a child's changes and context. */
export function readingSections(build: Build) {
  const located = build.outline
    .flatMap((node) => {
      const at = headingAt(build, node);
      return at ? [{ node, at }] : [];
    })
    .sort((a, b) =>
      byReading(
        readingKey(build.document, lane(a.at[0], a.at[2]), a.at[1]),
        readingKey(build.document, lane(b.at[0], b.at[2]), b.at[1]),
      ),
    );
  return located.map(({ node, at }, i) => ({
    node,
    intervals: flow(build, at, located[i + 1]?.at ?? null),
  }));
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
