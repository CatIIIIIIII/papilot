import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "../core/files.ts";
import { within } from "../core/git.ts";
import { deepestNode } from "../core/outline.ts";
import { referenceChanges } from "../core/bib.ts";
import { changesOf, placesOf, renderPlace } from "./effects.ts";
import {
  alignedCrops,
  alignment,
  marksIn,
  type Mine,
  printers,
  type Alignment,
} from "./align.ts";
import { Build } from "./locate.ts";
import { sourcePairs } from "./source-spans.ts";
import { renderDocument, Strips } from "./inline.ts";
import { pixelDifference, textChanges } from "./pdfdiff.ts";
import { containsCenter } from "./pdf.ts";
import type {
  Card,
  Mark,
  Pair,
  Place,
  Position,
  PlaceView,
  RenderedRound,
  RenderRequest,
  SourceBox,
  Unit,
} from "../types.ts";
export function typesetWords(text: string) {
  // TeX comments consume the end-of-line too. Keeping that newline would
  // turn a standalone comment into a paragraph break, or split foo%\nbar.
  const uncommented = (text.match(/[^\n]*\n|[^\n]+$/g) ?? [])
    .map((line) => {
      line = line.replace(/^[ \t]+/, "");
      for (let i = 0; i < line.length; i++) {
        if (line[i] === "\\") {
          i++;
          continue;
        }
        if (line[i] === "%") return line.slice(0, i);
      }
      return line;
    })
    .join("");
  return uncommented
    .split(/\n[ \t]*\n/)
    .filter((p) => p.trim())
    .map((p) => p.trim().replace(/\s+/g, " "));
}
export function classify(
  old: Build,
  next: Build,
  unit: Unit,
  body: Set<string>,
  figureFiles: (file: string) => boolean,
  mine?: Mine,
  sourceMoved = false,
): Pick<Card, "pairs" | "comparison" | "own" | "aligned" | "independent"> {
  const name = unit.file;
  // A changed line may be inside a whitespace-sensitive environment without
  // including its \begin in the hunk. Inspect the owning file before using
  // the source-only no-op shortcut; the PDF is the authority for these files.
  const whitespaceSensitive =
    /\\(?:verb\b|lstinline\b|mintinline\b|begin\{(?:verbatim\*?|Verbatim|lstlisting|minted)\})/.test(
      (old.read(name) ?? "") + (next.read(name) ?? ""),
    );
  const sameWords = (a: string, b: string) => JSON.stringify(typesetWords(a)) === JSON.stringify(typesetWords(b));
  let sourceIdentical = sameWords(unit.old_text, unit.new_text);
  if (sourceIdentical && unit.text_ops) {
    // Compare the edit in its full source context. A whitespace-only excerpt
    // cannot distinguish a line wrap from a joined word or paragraph break.
    const a = old.read(name), b = next.read(name);
    if (a !== null && b !== null) {
      const candidate = [...unit.text_ops].sort((p, q) => q[1] - p[1]).reduce(
        (text, [, i, j, x, y]) => text.slice(0, i) + b.slice(x, y) + text.slice(j), a,
      );
      sourceIdentical = sameWords(a, candidate);
    } else sourceIdentical = false;
  }
  // A .bib file is not typeset where it is written, and % in a URL is not
  // a comment there: its edits are compared in the PDF.
  if (
    unit.kind !== "binary" &&
    !name.endsWith(".bib") &&
    !whitespaceSensitive &&
    !unit.truncated &&
    unit.status === "modified" &&
    sourceIdentical
  )
    return { pairs: [], comparison: "identical" };
  const located =
      name.endsWith(".tex") && unit.kind !== "binary" && body.has(name),
    whole = unit.whole_file || figureFiles(name),
    own0 = {
      left:
        located && unit.status !== "added"
          ? old.locator.locate(
              name,
              unit.old_start,
              unit.old_end,
              whole,
              unit.ops.length
                ? unit.ops.map(([, start, end]) => [start, end])
                : undefined,
              unit.text_ops?.map(([, start, end]) => [start, end]),
            )
          : [],
      right:
        located && unit.status !== "deleted"
          ? next.locator.locate(
              name,
              unit.new_start,
              unit.new_end,
              whole,
              unit.ops.length
                ? unit.ops.map(([, , , start, end]) => [start, end])
                : undefined,
              unit.text_ops?.map(([, , , start, end]) => [start, end]),
            )
          : [],
    },
    precise =
      located &&
      !whole &&
      !(old.slides || next.slides) &&
      sourcePairs(old, next, unit, own0.left, own0.right),
    al =
      !(old.slides || next.slides) && (own0.left.length || own0.right.length)
        ? alignment(old, next)
        : null;
  if (precise) {
    // Exact source spans retain their own marks, but a deletion paired with an
    // insertion elsewhere is movement. Use the document alignment to classify
    // those same glyphs without borrowing marks from neighboring edits.
    for (const pair of precise) {
      for (const [side, at, marks] of [
        ['old', pair.old, pair.before_marks],
        ['new', pair.new, pair.after_marks],
      ] as const) {
        if (!at || !al) continue;
        const moved = marksIn(al, side, at).filter(mark => mark.kind === 'moved');
        for (const mark of marks)
          if (sourceMoved || moved.some(match => containsCenter(match.rect, mark.rect))) mark.kind = 'moved';
      }
    }
    return {
      pairs: precise,
      comparison: precise.some(pair => [...pair.before_marks, ...pair.after_marks].some(mark => mark.kind !== 'moved')) ? "text" : "position",
      aligned: true,
      independent: true,
    };
  }
  // Located edits use the whole comparison to crop between anchors around
  // changed lines, or keep their SyncTeX crops when no words changed.
  const groups = al && alignedCrops(al, own0.left, own0.right, whole, mine),
    pairs: Pair[] = [];
  let textChanged = false;
  for (const [index, group] of (
    groups ?? [{ left: own0.left, right: own0.right }]
  ).entries()) {
    const { left, right } = group,
      analysis = groups
        ? aligned(left, right, al!)
        : textChanges(old.document, next.document, left, right);
    textChanged ||= analysis.text_changed;
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const at = left[i] ?? null,
        context: Mark[] =
          "faded" in group && at
            ? (group.faded ?? [])
                .filter(
                  (f) => f.page === at.page && containsCenter(at.clip, f.rect),
                )
                .map((f) => ({ kind: "context", rect: f.rect }))
            : [];
      pairs.push({
        old: at,
        new: right[i] ?? null,
        before_marks: [...(analysis.old_marks[i] ?? []), ...context],
        after_marks: analysis.new_marks[i] ?? [],
        ...(groups ? { group: index } : {}),
      });
    }
  }
  const pixels = textChanged
    ? 0
    : pairs.reduce(
        (sum, { old: a, new: b }) =>
          sum +
          pixelDifference(
            a ? old.document.page(a.page).raster(a.clip, 2, false, true) : null,
            b
              ? next.document.page(b.page).raster(b.clip, 2, false, true)
              : null,
            1,
          ),
        0,
      );
  const own = {
      old:
        own0.left.length && !whole
          ? old.locator.boxes(name, unit.old_start, unit.old_end)
          : [],
      new:
        own0.right.length && !whole
          ? next.locator.boxes(name, unit.new_start, unit.new_end)
          : [],
    },
    moved = pairs.some(
      ({ old: a, new: b }) =>
        a &&
        b &&
        (a.page !== b.page ||
          a.label !== b.label ||
          a.clip.some((v, j) => Math.abs(v - b.clip[j]) > 1)),
    );
  return {
    pairs,
    comparison: !pairs.length
      ? "unmapped"
      : textChanged
        ? "text"
        : pixels
          ? "layout"
          : moved
            ? "position"
            : "identical",
    own,
    ...(groups ? { aligned: true } : {}),
  };
}
// Which edit each changed line belongs to. A line that some edits' source
// printed belongs to those edits, so a rewritten section next door does not
// lend its lines to an edit whose SyncTeX crops reach into it; for a line
// no edit printed, such as a renumbered reference, it says nothing (see
// changedLines in align.ts).
function owners(old: Build, next: Build, units: Unit[], body: Set<string>) {
  const al = alignment(old, next);
  const records = (build: Build, unit: Unit, start: number, end: number) => {
      const file = build.path(unit.file);
      if (
        !unit.file.endsWith(".tex") ||
        !body.has(unit.file) ||
        !fs.existsSync(file)
      )
        return [];
      const result: SourceBox[] = [];
      for (let line = Math.max(1, start); line <= end; line++)
        result.push(...build.locator.lookup(file, line));
      return result;
    },
    printed = {
      old: printers(
        al,
        "old",
        units.map((u) => records(old, u, u.old_start, u.old_end)),
      ),
      new: printers(
        al,
        "new",
        units.map((u) => records(next, u, u.new_start, u.new_end)),
      ),
    };
  return (index: number) => ({
    old: (line: number) => printed.old.get(line)?.includes(index),
    new: (line: number) => printed.new.get(line)?.includes(index),
  });
}
// The marks of aligned crops: the words the whole comparison changed.
function aligned(left: Position[], right: Position[], al: Alignment) {
  const old_marks = left.map((at) => marksIn(al, "old", at)),
    new_marks = right.map((at) => marksIn(al, "new", at));
  return {
    old_marks,
    new_marks,
    text_changed: [...old_marks, ...new_marks].some((marks) =>
      marks.some((m) => m.kind !== "moved"),
    ),
  };
}
// Places rendered with the round; the rest render when asked for.
export const SHOWN = 3;

// Source and PDF alignment can choose opposite sides of a paragraph swap as
// the moved run. Unique, substantial delete/insert pairs prove movement of
// their own text even when the PDF alignment keeps that run as an anchor.
function sourceMovements(units: Unit[]) {
  const groups = new Map<string, { old: string[]; next: string[] }>();
  for (const unit of units) {
    if (unit.text_ops?.length !== 1 || unit.truncated) continue;
    const old = unit.old_text.trim(), next = unit.new_text.trim();
    if (Boolean(old) === Boolean(next)) continue;
    const text = old || next;
    if ((text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < 20) continue;
    const key = unit.file + '\0' + text;
    if (!groups.has(key)) groups.set(key, { old: [], next: [] });
    groups.get(key)![old ? 'old' : 'next'].push(unit.id);
  }
  return new Set([...groups.values()].filter(group => group.old.length === 1 && group.next.length === 1).flatMap(group => [...group.old, ...group.next]));
}
// Renders the round. With more than one edit, when some edit prints nothing
// of its own or some change lies outside every edit's crops, it returns null
// after writing attribute.json: the caller compiles variants to find the
// edits behind each change and passes them back as `causes`.
export function renderRound(
  request: RenderRequest,
  out: string,
): RenderedRound | null {
  fs.mkdirSync(out, { recursive: true });
  const figureFiles = (name: string) => within(name, request.figures),
    old = new Build(request.old, request.main, request.source_dir),
    next = new Build(request.new, request.main, request.source_dir);
  try {
    const body = new Set([old, next].flatMap((b) => b.bodyFiles)),
      cards: Card[] = [],
      result: RenderedRound = { units: {}, sections: [], loose: [] };
    const mine =
      request.cards || old.slides || next.slides
        ? null
        : owners(old, next, request.units, body),
      moved = sourceMovements(request.units);
    for (const [index, unit] of request.units.entries()) {
      // The pass after variant builds reuses the first pass's cards rather
      // than asking SyncTeX again.
      const card: Card = request.cards?.[index] ?? {
          id: unit.id,
          file: unit.file,
          ...classify(old, next, unit, body, figureFiles, mine?.(index), moved.has(unit.id)),
        },
        node = card.pairs.length
          ? unit.status === "deleted"
            ? deepestNode(old.outline, unit.file, unit.old_start, unit.old_end)
            : deepestNode(next.outline, unit.file, unit.new_start, unit.new_end)
          : null;
      card.context_node = node?.id ?? null;
      cards.push(card);
      result.units[unit.id] = {
        visual: card.comparison,
        pages: [
          ...new Set(card.pairs.map((p) => (p.new ?? p.old)!.label)),
        ].sort(),
        section: node ? `${node.number} ${node.title}`.trim() : null,
      };
    }
    // Without indirect changes, an edit shows only its own lines: the whole
    // documents are not compared for places, and no variant is compiled.
    const changes = request.indirect ? changesOf(old, next, cards) : [],
      // An edit that prints nothing of its own, such as a macro definition,
      // changes the PDF only away from its lines. An edit of comments or
      // line breaks alone has no crop and changes nothing.
      silent = cards.filter(
        (c) =>
          c.comparison === "unmapped" ||
          (c.comparison === "identical" && c.pairs.length > 0),
      );
    if (
      request.indirect &&
      request.units.length > 1 &&
      !request.causes &&
      changes.length > 0
    ) {
      writeJson(path.join(out, "attribute.json"), {
        changes,
        silent: silent.map((c) => c.id),
        cards,
      });
      return null;
    }
    const causes =
        request.units.length === 1
          ? changes.map(() => [request.units[0].id])
          : (request.causes ?? changes.map(() => [])),
      places = request.indirect
        ? placesOf(
            old,
            next,
            changes.map((c) => c.effect),
            causes,
            changes.map((c) => c.within),
          )
        : {},
      strips = new Strips(out);
    for (const [id, list] of Object.entries(places))
      result.units[id].effects = {
        total: list.length,
        verified: true,
        shown: list
          .slice(0, SHOWN)
          .map((place) => renderPlace(place, strips, old, next)),
      };
    if (Object.values(places).some((list) => list.length > SHOWN))
      writeJson(path.join(out, "places.json"), {
        main: request.main,
        source_dir: request.source_dir,
        old: request.old,
        new: request.new,
        units: places,
      });
    Object.assign(
      result,
      renderDocument(old, next, cards, strips, figureFiles),
    );
    try {
      const references = referenceChanges(request.units, old, next);
      if (references) result.references = references;
    } catch (error) {
      // The PDF review stands without the bibliography's entry view.
      console.error("Could not read the bibliography changes:", error);
    }
    fs.writeFileSync(path.join(out, "round.json"), JSON.stringify(result));
    return result;
  } finally {
    old.close();
    next.close();
  }
}
// The places of an edit past the first SHOWN, rendered into the round's
// folder on the first request and kept there.
export function renderMore(out: string, unit: string): PlaceView[] {
  const file = path.join(out, `places-${unit}.json`);
  if (fs.existsSync(file)) return readJson<PlaceView[]>(file, []);
  const saved = readJson<{
    main: string;
    source_dir: string;
    old: RenderRequest["old"];
    new: RenderRequest["new"];
    units: Record<string, Place[]>;
  } | null>(path.join(out, "places.json"), null);
  const list = saved?.units[unit]?.slice(SHOWN) ?? [];
  if (!saved || !list.length) {
    writeJson(file, []);
    return [];
  }
  const old = new Build(saved.old, saved.main, saved.source_dir),
    next = new Build(saved.new, saved.main, saved.source_dir);
  try {
    const strips = new Strips(out),
      views = list.map((place) => renderPlace(place, strips, old, next));
    writeJson(file, views);
    return views;
  } finally {
    old.close();
    next.close();
  }
}
