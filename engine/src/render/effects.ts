import { opcodesWithin } from "../core/diff.ts";
import { JOIN_GAP, snap, type Strips } from "./inline.ts";
import { entryFor, position, textBounds, type Build } from "./locate.ts";
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

// Removed words that come back elsewhere are moved, not changed, when the run
// is long enough to tell: git's rule for moved blocks, at least 20
// alphanumeric characters.
const MOVED = 20;
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
export function differences(a: Words, b: Words): Effect[] | null {
  const text = (w: Words, i: number, j: number) =>
      w.tokens
        .slice(i, j)
        .map((t) => t.text)
        .join(" "),
    long = (text: string) =>
      text.replace(/[^\p{L}\p{N}]/gu, "").length >= MOVED,
    deadline = Date.now() + PATIENCE,
    within = <T>(x: T[], y: T[]) =>
      opcodesWithin(x, y, Math.max(1, deadline - Date.now()));
  // Lines first, as the engine compares a section's rows: a whole printed
  // line rarely recurs, so the words of an inserted paragraph cannot pair
  // with like words pages away. Then words, within the lines that differ.
  const rows = within(
    a.lines.map(([i, j]) => text(a, i, j)),
    b.lines.map(([x, y]) => text(b, x, y)),
  );
  if (!rows) return null;
  const at = (w: Words, line: number) => w.lines[line]?.[0] ?? w.tokens.length,
    changed: Op[] = [];
  for (const [tag, i, j, x, y] of rows) {
    if (tag === "equal") continue;
    const [i0, j0, x0, y0] = [at(a, i), at(a, j), at(b, x), at(b, y)],
      ops = within(
        a.tokens.slice(i0, j0).map((t) => t.text),
        b.tokens.slice(x0, y0).map((t) => t.text),
      );
    if (!ops) return null;
    for (const [kind, p, q, r, t] of ops)
      if (kind !== "equal")
        changed.push([kind, i0 + p, i0 + q, x0 + r, x0 + t]);
  }
  const removed = new Map<string, number>(),
    added = new Map<string, number>(),
    count = (counts: Map<string, number>, key: string) =>
      counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const [tag, i, j, x, y] of changed) {
    if (tag === "delete" && long(text(a, i, j))) count(removed, text(a, i, j));
    if (tag === "insert" && long(text(b, x, y))) count(added, text(b, x, y));
  }
  // As many removals and additions of a run as pair up are moves.
  const pairs = (counts: Map<string, number>, other: Map<string, number>) =>
      new Map(
        [...counts].map(([key, n]) => [key, Math.min(n, other.get(key) ?? 0)]),
      ),
    left = pairs(removed, added),
    right = pairs(added, removed),
    moved = (budget: Map<string, number>, key: string) => {
      const n = budget.get(key) ?? 0;
      if (n > 0) budget.set(key, n - 1);
      return n > 0;
    };
  return changed
    .filter(([tag, i, j, x, y]) =>
      tag === "delete"
        ? !moved(left, text(a, i, j))
        : tag === "insert"
          ? !moved(right, text(b, x, y))
          : true,
    )
    .map(([, i, j, x, y]) => ({ old: [i, j], new: [x, y] }));
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
  const toc = build.document.outline;
  let found: [string, number, number] | null = null;
  for (const node of build.outline) {
    let page: number, top: number;
    try {
      [page, top] = position(build.document, toc[entryFor(node, toc)]);
    } catch {
      continue;
    }
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
      const image = strips.write(
        build.document,
        at.page,
        ...snap(build.document, at.page, at.clip[1], at.clip[3]),
        marks,
        side,
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
