import fs from "node:fs";
import path from "node:path";
import { opcodes } from "./diff.ts";
import { splitLines, textOf, withHashesAsync } from "./changes.ts";
import { isFigure } from "./config.ts";
import { atomicWriteAsync, readJson } from "./files.ts";
import { bodyFiles, readingOrder, structuralSource, type ReadingOrder } from "./tex-source.ts";
import { revisionReaderAsync } from "./tasks.ts";
import type { App } from "../server.ts";
import type { ChangeBlock, PlaceView, RenderedRound, Round, Strip, Unit } from "../types.ts";

// A round is inserted before its PDF comparison is rendered. Until it is,
// a change whose exact version an earlier round already rendered can show
// that comparison, when nothing else the new round changed can have moved it.
// The round's own render replaces every carried comparison when it arrives.
//
// A passage that changed since the earlier round can move anything from its
// own page on: text pushes or pulls the text after it, floats and footnotes
// travel, and definitions, counters and settings apply to what follows. A
// change keeps its comparison only when it comes before every such passage
// in reading order and ends on an earlier page, outside the passage's
// paragraph, which TeX breaks into lines as a whole. A float, or a passage
// whose page is unknown, also holds the rest of its page run back to the
// previous forced page break.

export const roundFolder = (app: App, name: string, number: number) =>
  path.join(app.state, "rounds", name, String(number).padStart(3, "0"));

const empty = (): RenderedRound => ({ units: {}, sections: [], loose: [] });
// Strips saved by older releases as a single object.
const list = (value: Strip[] | Strip | undefined | null): Strip[] =>
  Array.isArray(value) ? value : value ? [value] : [];

// Page polls read a rendering round's comparisons every few seconds: keep
// each parsed round.json until the file is replaced. Callers must not modify it.
const cache = new Map<string, { stamp: string; value: RenderedRound }>();
export function rendered(app: App, name: string, number: number): RenderedRound {
  const file = path.join(roundFolder(app, name, number), "round.json");
  let stamp: string;
  try {
    const stat = fs.statSync(file);
    stamp = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return empty();
  }
  const hit = cache.get(file);
  if (hit?.stamp === stamp) return hit.value;
  const value = readJson<RenderedRound>(file, empty());
  cache.set(file, { stamp, value });
  if (cache.size > 64) cache.delete(cache.keys().next().value!);
  return value;
}

function changeBlocks(round: RenderedRound) {
  return [
    ...round.sections.flatMap((section, index) =>
      section.blocks.flatMap((block) => (block.kind === "change" ? [{ block, section: index }] : [])),
    ),
    ...round.loose.map((block) => ({ block, section: -1 })),
  ];
}

/** Whether a change of this round has a PDF comparison to decide with: its
 *  round is rendered, or it shows an earlier round's comparison meanwhile. */
export function comparable(round: Pick<Round, "visuals">, shown: RenderedRound, id: string) {
  return (round.visuals ?? "ready") === "ready" || Boolean(shown.carried?.[id]);
}

/** The round and change that rendered the comparison a change shows. */
export function origin(round: Pick<Round, "number" | "visuals">, shown: RenderedRound, id: string) {
  if ((round.visuals ?? "ready") === "ready") return { round: round.number, change: id };
  return shown.carried?.[id] ?? null;
}

type Side = "before" | "after";
type Pages = Record<Side, Set<number>>;
const SIDES: Side[] = ["before", "after"];
const pagesOf = (): Pages => ({ before: new Set(), after: new Set() });
/** The physical pages of a change's own lines, and of its places elsewhere,
 *  on each side. */
type Shown = { lines: Pages; places: Pages };
function unitPages(round: RenderedRound) {
  const pages = new Map<string, Shown>(),
    add = (id: string, kind: keyof Shown, before: Strip[], after: Strip[]) => {
      const entry = pages.get(id) ?? { lines: pagesOf(), places: pagesOf() };
      for (const strip of before) entry[kind].before.add(strip.page);
      for (const strip of after) entry[kind].after.add(strip.page);
      if (SIDES.some((side) => entry.lines[side].size || entry.places[side].size)) pages.set(id, entry);
    };
  for (const { block } of changeBlocks(round))
    if (!block.waiting) for (const id of block.units) add(id, "lines", list(block.before), list(block.after));
  for (const [id, unit] of Object.entries(round.units))
    for (const place of unit.effects?.shown ?? []) add(id, "places", list(place.before), list(place.after));
  return pages;
}

const half = (value: number) => Math.round(value * 2) / 2;
// What a strip shows: its size, its words where they are, and its marks.
// Rendering the same region twice can number glyphs differently in the image,
// so the image itself counts only for strips without text, such as figures.
function stripPrint(strip: Strip) {
  const text = (strip.text ?? []).map((line) => line.chars.map((char) => [char.text, ...char.rect.map(half)]));
  return [
    half(strip.width),
    half(strip.height),
    text,
    (strip.marks ?? []).map((mark) => [mark.kind, ...mark.rect.map(half)]),
    text.length ? null : strip.src.replace(/^s\d+-/, ""),
  ];
}
/** What the comparison of a change shows, to tell whether a later render of
 *  the same change looks different. Null when the round shows none. */
export function fingerprint(round: RenderedRound, id: string): string | null {
  const blocks = changeBlocks(round).filter(({ block }) => !block.waiting && block.units.includes(id)),
    unit = round.units[id];
  if (!blocks.length && !unit) return null;
  return JSON.stringify([
    unit?.visual ?? null,
    blocks.map(({ block }) => [
      Boolean(block.identical),
      Boolean(block.reflow),
      Boolean(block.moved),
      block.units.length,
      list(block.before).map(stripPrint),
      list(block.after).map(stripPrint),
    ]),
    (unit?.effects?.shown ?? []).map((place) => [place.page, list(place.before).map(stripPrint), list(place.after).map(stripPrint)]),
  ]);
}

function preamble(text: string) {
  const opening = /\\begin\s*\{document\}/.exec(structuralSource(text));
  return opening ? text.slice(0, opening.index) : text;
}

export interface Provisional {
  rendered: RenderedRound;
  /** Strip images to bring over from the earlier round's folder. */
  files: string[];
  from: string | null;
}

/** The comparisons a new round shows until its own render arrives: those it
 *  carries from the previous round, and a waiting placeholder for each other
 *  change. `relaxed` carries every exactly matching change regardless of what
 *  else changed, for a round whose own render failed. */
export async function provisional(
  app: App,
  name: string,
  previous: Round | null,
  next: { before: string; after: string; units: Unit[] },
  relaxed = false,
): Promise<Provisional> {
  const result: RenderedRound = { units: {}, sections: [], loose: [], carried: {} },
    prior = previous ? rendered(app, name, previous.number) : null,
    project = app.project,
    order = new Map(next.units.map((unit, index) => [unit.id, index])),
    // Earlier change → the new change showing its comparison.
    back = new Map<string, string>(),
    sectionOf = new Map<string, number>();
  let earlier: Unit[] = [];
  const unique = (units: Unit[]) => {
    const counts = new Map<string, number>();
    for (const unit of units) counts.set(unit.hash!, (counts.get(unit.hash!) ?? 0) + 1);
    return counts;
  };
  if (previous && prior) {
    for (const { block, section } of changeBlocks(prior))
      for (const id of block.units) if (!sectionOf.has(id)) sectionOf.set(id, section);
    earlier = await withHashesAsync(app.repo, previous.before, previous.after, previous.units);
  }
  const older = unique(earlier),
    newer = unique(next.units),
    byHash = new Map(earlier.map((unit) => [unit.hash!, unit])),
    match = (unit: Unit) =>
      older.get(unit.hash!) === 1 && newer.get(unit.hash!) === 1 ? byHash.get(unit.hash!)! : null;
  if (previous && prior && Object.keys(prior.units).length) {
    const pages = unitPages(prior);
    let local: (file: string) => boolean = () => true,
      changed: Changed | null = null;
    if (!relaxed) {
      const [now, then] = await Promise.all([next.after, previous.after].map((rev) => revisionReaderAsync(app.repo, rev, project.doc_dir))),
        current = version(now, project.main),
        body = new Set([...current.order.files, ...bodyFiles(then, project.main)]);
      // Other files, such as packages, macros read in the preamble and
      // bibliographies, can change any page.
      local = (file) => isFigure(project, file) || (file.endsWith(".tex") && body.has(file));
      changed = await changedPassages(app, previous, earlier, pages, next, local, current);
    }
    for (const unit of next.units) {
      const found = match(unit),
        at = found && pages.get(found.id);
      if (!found || !at || !prior.units[found.id] || !local(unit.file)) continue;
      if (!relaxed && (!changed || SIDES.some((side) => movable(side, unit, at, changed![side])))) continue;
      back.set(found.id, unit.id);
    }
    // A comparison drawn for several changes together is carried only with
    // all of them.
    for (let changed = true; changed; ) {
      changed = false;
      for (const { block } of changeBlocks(prior))
        if (!block.waiting && block.units.some((id) => back.has(id)) && !block.units.every((id) => back.has(id)))
          for (const id of block.units) changed = back.delete(id) || changed;
    }
  }
  const files = new Set<string>(),
    remap = (id: string) => back.get(id) ?? id,
    from = (id: string) => prior!.carried?.[id] ?? { round: previous!.number, change: id },
    strip = (value: Strip): Strip => {
      files.add(value.src);
      files.add(value.clean);
      return value.marks ? { ...value, marks: value.marks.map((mark) => ({ ...mark, unit: remap(mark.unit) })) } : value;
    },
    place = (value: PlaceView): PlaceView => ({
      ...value,
      before: list(value.before).map(strip),
      after: list(value.after).map(strip),
      ...(value.with ? { with: value.with.map(remap) } : {}),
    });
  for (const [id, unit] of back) {
    const visual = prior!.units[id],
      shown = (visual.effects?.shown ?? []).filter((p) => (p.with ?? []).every((other) => back.has(other))).map(place);
    // Places past those shown render from the earlier round's builds; the
    // carried comparison offers only the shown ones.
    result.units[unit] = { ...visual, ...(visual.effects ? { effects: { ...visual.effects, shown, total: shown.length } } : {}) };
    result.carried![unit] = from(id);
  }
  const sections = (prior?.sections ?? []).map((section) => ({ node: section.node, number: section.number, title: section.title, blocks: [] as ChangeBlock[] })),
    loose: ChangeBlock[] = [];
  for (const { block, section } of prior ? changeBlocks(prior) : [])
    if (!block.waiting && block.units.length && block.units.every((id) => back.has(id)))
      (section < 0 ? loose : sections[section].blocks).push({
        ...block,
        units: block.units.map(remap),
        before: list(block.before).map(strip),
        after: list(block.after).map(strip),
        carried: from(block.units[0]).round,
      });
  const carried = new Set(back.values());
  for (const unit of next.units) {
    if (carried.has(unit.id)) continue;
    // Each other change waits in the section its earlier version, or the
    // nearest earlier change of its file, was shown in.
    const found = match(unit);
    let section = found && sectionOf.has(found.id) ? sectionOf.get(found.id)! : -1;
    if (!found || !sectionOf.has(found.id)) {
      let nearest = Infinity;
      for (const other of earlier)
        if (other.file === unit.file && sectionOf.has(other.id) && Math.abs(other.new_start - unit.new_start) < nearest) {
          nearest = Math.abs(other.new_start - unit.new_start);
          section = sectionOf.get(other.id)!;
        }
    }
    const block: ChangeBlock = { kind: "change", units: [unit.id], identical: false, before: [], after: [], waiting: true };
    (section >= 0 ? sections[section].blocks : loose).push(block);
  }
  const first = (block: ChangeBlock) => Math.min(...block.units.map((id) => order.get(id) ?? Infinity));
  for (const section of sections) section.blocks.sort((a, b) => first(a as ChangeBlock) - first(b as ChangeBlock));
  loose.sort((a, b) => first(a) - first(b));
  result.sections = sections.filter((section) => section.blocks.length);
  result.loose = loose;
  if (prior?.references) {
    const entries = prior.references.entries
        .filter((entry) => (entry.units ?? [entry.unit]).every((id) => back.has(id)))
        .map((entry) => ({ ...entry, unit: remap(entry.unit), ...(entry.units ? { units: entry.units.map(remap) } : {}) })),
      missing = prior.references.missing
        .filter((entry) => entry.unit && back.has(entry.unit))
        .map((entry) => ({ ...entry, unit: remap(entry.unit!) }));
    if (entries.length || missing.length) result.references = { entries, missing };
  }
  return { rendered: result, files: [...files], from: previous ? roundFolder(app, name, previous.number) : null };
}

/** A passage changed since the previous round, on one side. */
interface Passage {
  file: string;
  /** Its first line in the new version, counted from 0. */
  start: number;
  /** The pages its earlier changes showed on in the previous round, and the
   *  first page of their own lines, Infinity when no earlier change shows it. */
  pages: Set<number>;
  first: number;
  /** Inside a float, whose page TeX chooses. */
  float: boolean;
}
interface Version {
  order: ReadingOrder;
  lines: (file: string) => string[];
}
function version(read: (file: string) => string | null, main: string): Version {
  const cache = new Map<string, string[]>();
  return {
    order: readingOrder(read, main),
    lines: (file) => cache.get(file) ?? cache.set(file, splitLines(read(file) ?? "")).get(file)!,
  };
}
type Changed = Record<Side, { passages: Passage[]; version: Version | null }>;

// Commands whose count or arguments number, label or cite things across the
// document: changing them can change any page. References only read them.
const NUMBERED =
  /\\(?:begin|end)\s*\{[^}]*\}|\\[A-Za-z]*(?:cite|label)[A-Za-z]*\*?(?:\s*\[[^\]]*\])*\s*\{[^}]*\}|\\(?:part|chapter|(?:sub)*section|(?:sub)?paragraph|caption|footnote(?:mark|text)?|item|bibitem|tag|notag|nonumber|(?:ref)?stepcounter|addtocounter|setcounter|input|include|subfile)(?![A-Za-z@])\*?|\\\\/g;
const numbering = (text: string) => (structuralSource(text).match(NUMBERED) ?? []).map((token) => token.replace(/\s+/g, "")).join("\n");
const FLOAT = /figure|table|algorithm|listing/i;
// Whether `offset` of a file lies inside a float environment.
function inFloat(text: string, offset: number) {
  const open: string[] = [];
  for (const match of structuralSource(text).slice(0, offset).matchAll(/\\(begin|end)\s*\{([^}]*)\}/g)) {
    if (!FLOAT.test(match[2])) continue;
    if (match[1] === "begin") open.push(match[2]);
    else open.splice(open.lastIndexOf(match[2]), 1);
  }
  return open.length > 0;
}

// The passages that changed since the previous round, on each side, or null
// when some change can move any page: the preamble, a file outside the
// document body, a figure, or numbering.
async function changedPassages(
  app: App,
  previous: Round,
  earlier: Unit[],
  pages: Map<string, Shown>,
  next: { before: string; after: string },
  local: (file: string) => boolean,
  after: Version,
): Promise<Changed | null> {
  const result: Changed = { before: { passages: [], version: null }, after: { passages: [], version: null } },
    project = app.project;
  for (const [side, from, to] of [
    ["before", previous.before, next.before],
    ["after", previous.after, next.after],
  ] as const) {
    const files = await app.repo.changedFilesAsync(from, to);
    if (!files.length) continue;
    if (side === "after") result.after.version = after;
    else result.before.version = version(await revisionReaderAsync(app.repo, to, project.doc_dir), project.main);
    const [old, fresh] = await Promise.all([app.repo.blobsAsync(from, files), app.repo.blobsAsync(to, files)]);
    for (const file of files) {
      // A figure's size can move its float to any page from its anchor on.
      if (!local(file) || isFigure(project, file) || !fresh[file]) return null;
      const a = old[file] ? textOf(old[file]) : "",
        b = textOf(fresh[file]);
      if (a === null || b === null) return null;
      if (file === project.main && preamble(a) !== preamble(b)) return null;
      const before = splitLines(a),
        lines = splitLines(b);
      for (const [, i, j, x, y] of opcodes(before, lines).filter((op) => op[0] !== "equal")) {
        if (numbering(before.slice(i, j).join("")) !== numbering(lines.slice(x, y).join(""))) return null;
        // Line ranges of the earlier round's changes in this version.
        const found = earlier
          .filter((unit) => {
            if (unit.file !== file) return false;
            const [start, end] = side === "before" ? [unit.old_start - 1, unit.old_end] : [unit.new_start - 1, unit.new_end];
            return i <= end && start <= j;
          });
        const passage: Passage = {
          file,
          // A deletion lies after the line before it.
          start: y > x ? x : Math.max(0, x - 1),
          pages: new Set(),
          first: Infinity,
          float: inFloat(b, lines.slice(0, x).join("").length),
        };
        for (const unit of found) {
          const where = pages.get(unit.id);
          for (const page of where?.lines[side] ?? []) {
            passage.pages.add(page);
            passage.first = Math.min(passage.first, page);
          }
          for (const page of where?.places[side] ?? []) passage.pages.add(page);
        }
        result[side].passages.push(passage);
      }
    }
  }
  return result;
}

const span = (start: number, end: number): [number, number] => (end > start ? [start, end - 1] : [Math.max(0, start - 1), start]);
const blank = (line: string) => /^\s*$/.test(line);
// Whether TeX breaks the lines up to `end` of one file and from `start` of a
// later one as a single paragraph: no blank line separates them.
function oneParagraph(version: Version, file: string, end: number, later: string, start: number) {
  if (file === later) return !version.lines(file).slice(end + 1, start).some(blank);
  return !version.lines(file).slice(end + 1).some(blank) && !version.lines(later).slice(0, start).some(blank);
}

// Text that shows page numbers or titles from elsewhere in the paper, which
// any passage can change.
const VOLATILE = /\\(?:[A-Za-z]*pageref|[vV]ref(?:range)?|fullref|[nN]ameref|titleref|thepage)(?![A-Za-z@])/;

/** Whether a passage that changed on `side` since the previous round can
 *  change what the earlier comparison of `unit` shows on that side. */
function movable(side: Side, unit: Unit, shown: Shown, changed: Changed[Side]) {
  const lines = shown.lines[side],
    places = shown.places[side];
  if (!changed.passages.length || (!lines.size && !places.size)) return false;
  const version = changed.version!,
    order = version.order,
    [start, end] = side === "after" ? span(unit.new_start - 1, unit.new_end) : span(unit.old_start - 1, unit.old_end),
    from = order.at(unit.file, start),
    to = order.at(unit.file, end),
    last = Math.max(...lines, ...places);
  if (VOLATILE.test(version.lines(unit.file).slice(start, end + 1).join(""))) return true;
  for (const passage of changed.passages) {
    // A page the passage shows on, its own lines or places elsewhere.
    if ([...lines, ...places].some((page) => passage.pages.has(page))) return true;
    // Everything from the passage's first page on can move. When that page
    // is unknown, only a forced break between them, below, proves this
    // change's lines come earlier; its places elsewhere cannot be placed.
    if (passage.first === Infinity ? places.size > 0 : last >= passage.first) return true;
    const first = order.at(passage.file, passage.start);
    if (from === null || to === null || first === null || to >= first) return true;
    if (order.broken(to, first)) continue;
    if (passage.float || passage.first === Infinity) return true;
    if (oneParagraph(version, unit.file, end, passage.file, passage.start)) return true;
  }
  return false;
}

/** Writes a round's provisional comparisons into `folder`. */
export async function writeProvisional(folder: string, value: Provisional) {
  await fs.promises.mkdir(folder, { recursive: true });
  if (value.from)
    for (const file of value.files) {
      const source = path.join(value.from, file),
        target = path.join(folder, file);
      if (fs.existsSync(target) || !fs.existsSync(source)) continue;
      try {
        await fs.promises.link(source, target);
      } catch {
        await fs.promises.copyFile(source, target);
      }
    }
  await atomicWriteAsync(path.join(folder, "round.json"), JSON.stringify(value.rendered));
}
