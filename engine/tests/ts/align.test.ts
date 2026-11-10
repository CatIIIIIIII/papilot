import { afterEach, expect, it } from "vitest";
import { mupdf, PdfDocument, containsCenter } from "../../src/render/pdf.ts";
import {
  alignedCrops,
  alignment,
  marksIn,
  printers,
} from "../../src/render/align.ts";
import {
  sectionIntervals,
  laneX,
  type Build,
} from "../../src/render/locate.ts";
import type { Heading, Position, Rect } from "../../src/types.ts";
const documents: PdfDocument[] = [];
afterEach(() => documents.splice(0).forEach((d) => d.close()));
const LINES = 26;
// Where the body starts and ends on a page, from the top.
const BODY = 40,
  END = 50 + LINES * 18;
// A PDF that prints the lines given, 26 to a page.
function pdf(lines: string[]) {
  const doc = new mupdf.PDFDocument(),
    font = new mupdf.Font("Helvetica"),
    resource = doc.addSimpleFont(font);
  for (let start = 0; start < Math.max(lines.length, 1); start += LINES) {
    // A running head, as a real page has: the first line of the body is
    // then never at the page's edge, where recurring lines are furniture.
    const content =
      `BT /F1 9 Tf 30 580 Td (Page ${start / LINES + 1}) Tj ET ` +
      "BT /F1 12 Tf 30 550 Td 18 TL " +
      lines
        .slice(start, start + LINES)
        .map(
          (line, i) =>
            (i ? "T* " : "") + "(" + line.replace(/[()\\]/g, "\\$&") + ") Tj",
        )
        .join("\n") +
      " ET";
    const page = doc.addPage(
      [0, 0, 600, 600],
      0,
      { Font: { F1: resource } },
      content,
    );
    doc.insertPage(-1, page);
    page.destroy();
  }
  const buffer = doc.saveToBuffer(""),
    result = new PdfDocument(buffer.asUint8Array());
  buffer.destroy();
  resource.destroy();
  font.destroy();
  doc.destroy();
  documents.push(result);
  return result;
}
// The engine's alignment needs only a build's document.
const build = (document: PdfDocument) => ({ document }) as unknown as Build;
it.each(["color", "script"])(
  "retains a %s change below a separate text edit in the same unit",
  (kind) => {
    function mixed(changed: boolean) {
      const raw = new mupdf.PDFDocument(),
        font = new mupdf.Font("Helvetica"),
        ref = raw.addSimpleFont(font),
        content =
          "BT /F 12 Tf 40 550 Td (The stable preceding anchor stays in place here) Tj ET " +
          `BT /F 12 Tf 40 520 Td (The result is ${changed ? "robust" : "stable"}.) Tj ET ` +
          "BT /F 12 Tf 40 490 Td (An unchanged line separates the two changes.) Tj ET " +
          (kind === "color"
            ? `BT /F 12 Tf ${changed ? "1 0 0" : "0 0 0"} rg 40 460 Td (Beacon visual signal) Tj ET `
            : `BT /F 12 Tf 40 460 Td (Beacon x) Tj /F 8 Tf ${changed ? -3 : 5} Ts (2) Tj 0 Ts /F 12 Tf ( visual signal) Tj ET `) +
          "0 0 0 rg BT /F 12 Tf 40 430 Td (The stable following anchor stays in place here) Tj ET",
        page = raw.addPage([0, 0, 600, 600], 0, { Font: { F: ref } }, content);
      raw.insertPage(-1, page);
      const buffer = raw.saveToBuffer(""),
        result = new PdfDocument(buffer.asUint8Array());
      buffer.destroy();
      page.destroy();
      ref.destroy();
      font.destroy();
      raw.destroy();
      documents.push(result);
      return result;
    }
    const old = mixed(false),
      next = mixed(true),
      al = alignment(build(old), build(next)),
      own: Position[] = [{ page: 0, clip: [0, 60, 600, 155], label: "1" }],
      groups = alignedCrops(al, own, own, false)!;
    for (const [doc, side] of [
      [old, "old"],
      [next, "new"],
    ] as const) {
      const crops = groups.flatMap((g) => (side === "old" ? g.left : g.right)),
        rects = doc.page(0).search("Beacon");
      expect(
        rects.every((r) => crops.some((p) => containsCenter(p.clip, r))),
      ).toBe(true);
      const changed = [...al[side].changed.values()]
        .flat()
        .map((g) => al[side].words.glyphs[g].text)
        .join("");
      expect(changed).toBe(side === "old" ? "stable" : "robust");
    }
  },
);
function wrap(words: string[], width: number) {
  const lines: string[] = [];
  let line: string[] = [];
  for (const word of words) {
    if (line.length && [...line, word].join(" ").length > width) {
      lines.push(line.join(" "));
      line = [];
    }
    line.push(word);
  }
  if (line.length) lines.push(line.join(" "));
  return lines;
}
// A deterministic generator, so a failure names its seed.
function random(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}
const SENTENCES = [
  "A replicated state machine records commands in a durable log.",
  "Each replica applies committed commands in order.",
  "The invariant remains valid while leadership changes.",
  "Leaders append entries and followers acknowledge them.",
  "Terms increase monotonically across elections.",
];
// Every word of the pages' bodies in reading order, with where it prints.
function printed(document: PdfDocument) {
  const result: { text: string; page: number; rect: Rect }[] = [];
  for (let page = 0; page < document.length; page++)
    for (const word of [...document.page(page).words].sort(
      (a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0],
    ))
      if (word.rect[1] > BODY - 15)
        result.push({ text: word.text, page, rect: word.rect });
  return result;
}
const middle = (r: Rect) => (r[1] + r[3]) / 2;
const before = (w: { page: number; rect: Rect }, at: Position) =>
  w.page < at.page || (w.page === at.page && middle(w.rect) < at.clip[1]);
const after = (w: { page: number; rect: Rect }, at: Position) =>
  w.page > at.page || (w.page === at.page && middle(w.rect) > at.clip[3]);
const inside = (w: { page: number; rect: Rect }, crops: Position[]) =>
  crops.some((at) => at.page === w.page && containsCenter(at.clip, w.rect));
it.each(Array.from({ length: 120 }, (_, seed) => seed))(
  "marks exactly the changed words and cuts both crops at the same lines (seed %i)",
  (seed) => {
    const next = random(seed + 1),
      pick = <T>(list: T[]) => list[Math.floor(next() * list.length)];
    // Paragraphs of repeated sentences, so that lines and runs of words
    // recur; a paragraph rewraps up to its end and no further.
    const paragraphs = Array.from({ length: 6 + Math.floor(next() * 8) }, () =>
        Array.from({ length: 2 + Math.floor(next() * 3) }, () =>
          pick(SENTENCES),
        )
          .join(" ")
          .split(" "),
      ),
      changed = paragraphs.map((p) => [...p]),
      removed: string[] = [],
      added: string[] = [];
    // One edit, or two with at least two paragraphs between them: a line or
    // two of context between changes joins them into one region.
    const count = pick([1, 1, 2]),
      first = Math.floor(next() * (paragraphs.length - 3)),
      spots =
        count === 1
          ? [first]
          : [
              first,
              first + 3 + Math.floor(next() * (paragraphs.length - first - 3)),
            ];
    // Or, once in a while, the same words in a paragraph set narrower: a
    // change of layout alone, with nothing to mark.
    const narrow = new Set<number>(),
      relayout = count === 1 && next() < 0.2;
    for (const [k, p] of spots.entries()) {
      if (relayout) {
        narrow.add(p);
        continue;
      }
      const kind = pick(["insert", "delete", "replace", "replace"]),
        length = 1 + Math.floor(next() * 3),
        at = Math.floor(next() * (paragraphs[p].length - length)),
        // New words are unique, so the smallest difference is the edit itself.
        fresh = Array.from({ length }, (_, n) => `Zq${seed}x${k}y${n}`);
      if (kind === "insert") {
        changed[p].splice(at, 0, ...fresh);
        added.push(...fresh);
      } else if (kind === "delete") {
        // Deleting from a repeated text is ambiguous only in which copy
        // goes; a unique word keeps the expected marks exact.
        paragraphs[p].splice(
          at,
          length,
          ...fresh.map((w) => w.replace("Zq", "Yq")),
        );
        changed[p].splice(at, length);
        removed.push(...paragraphs[p].slice(at, at + length));
      } else {
        removed.push(...changed[p].splice(at, length, ...fresh));
        added.push(...fresh);
      }
    }
    const width = 50 + Math.floor(next() * 30),
      lines = (list: string[][], set: Set<number> = new Set()) =>
        list.flatMap((p, k) => [
          ...wrap(p, set.has(k) ? width - 14 : width),
          "",
        ]),
      words = paragraphs.flat(),
      edited = changed.flat(),
      old = pdf(lines(paragraphs)),
      neu = pdf(lines(changed, narrow)),
      al = alignment(build(old), build(neu))!;
    expect(al).toBeTruthy();
    // SyncTeX's crops: around the edit, each side grown or shrunk on its
    // own by up to three lines, as float placement or padding would.
    // SyncTeX's crops cover the edit, each side reaching on its own up to
    // three lines further, as float placement or padding would: one crop
    // per page from the first changed word to the last.
    const around = (
      doc: PdfDocument,
      words: string[],
      index: number,
      count: number,
    ) => {
      const all = printed(doc),
        first = all[Math.min(index, all.length - 1)],
        last = all[Math.min(index + Math.max(count, 1) - 1, all.length - 1)],
        reach = () => Math.floor(next() * 4) * 18;
      // Within the body, as SyncTeX's crops are.
      const top = Math.max(BODY, first.rect[1] - reach()),
        bottom = Math.min(END, last.rect[3] + reach());
      return Array.from({ length: last.page - first.page + 1 }, (_, k) => ({
        page: first.page + k,
        clip: [
          0,
          k === 0 ? top : BODY,
          600,
          first.page + k === last.page ? bottom : END,
        ] as Rect,
        label: "",
      }));
    };
    // One SyncTeX crop over the whole edit: from the first changed word to
    // the last, on each side.
    // For a change of layout, the paragraph that was set again.
    const span = (doc: PdfDocument, list: string[], other: string[]) => {
      if (relayout) {
        const p = spots[0],
          start = paragraphs.slice(0, p).flat().length;
        return around(doc, list, start, paragraphs[p].length);
      }
      let a = 0,
        b = 0;
      while (list[a] === other[a]) a++;
      while (list[list.length - 1 - b] === other[other.length - 1 - b]) b++;
      return around(doc, list, a, Math.max(0, list.length - b - a));
    };
    const groups = alignedCrops(
      al,
      span(old, words, edited),
      span(neu, edited, words),
      false,
    )!;
    expect(groups.length).toBe(count);
    const crops = {
      left: groups.flatMap((g) => g.left),
      right: groups.flatMap((g) => g.right),
    };
    expect(groups.every((g) => g.left.length && g.right.length)).toBe(true);
    const marked = (doc: PdfDocument, list: Position[], side: "old" | "new") =>
      printed(doc)
        .filter((w) =>
          list.some(
            (p) =>
              p.page === w.page &&
              marksIn(al, side, p).some((m) => containsCenter(m.rect, w.rect)),
          ),
        )
        .map((w) => w.text.replace(/[.,]$/, ""));
    const clean = (list: string[]) =>
      list.map((w) => w.replace(/[.,]$/, "")).sort();
    expect(marked(old, crops.left, "old").sort()).toEqual(clean(removed));
    expect(marked(neu, crops.right, "new").sort()).toEqual(clean(added));
    // The new document outside the crops, with each region's old crops in
    // its place, reads as the old document; with its new crops, as the new.
    const compose = (doc: PdfDocument, side: "left" | "right") => {
      const result: string[] = [],
        entered = new Set<number>();
      for (const w of printed(neu)) {
        const g = groups.findIndex((group) => inside(w, group.right));
        if (g < 0) result.push(w.text);
        else if (!entered.has(g)) {
          entered.add(g);
          // Faded words of an old crop are the context strips' to show.
          const faded = side === "left" ? (groups[g].faded ?? []) : [];
          result.push(
            ...printed(doc)
              .filter(
                (x) =>
                  inside(x, groups[g][side]) &&
                  !faded.some(
                    (f) => f.page === x.page && containsCenter(f.rect, x.rect),
                  ),
              )
              .map((x) => x.text),
          );
        }
      }
      return result.join(" ");
    };
    expect(compose(old, "left")).toBe(words.join(" "));
    expect(compose(neu, "right")).toBe(edited.join(" "));
  },
);
it("leaves text that no edit printed out of an edit's crops when it only moved", () => {
  // An edit inserts two lines; next to them, two lines that it did not
  // touch now come before a table instead of after it, as when a float
  // settles elsewhere. The words did not change and no edit printed them.
  const opening = Array.from(
      { length: 6 },
      (_, i) => `Opening line ${i} about consensus protocols and their logs`,
    ),
    table = Array.from(
      { length: 6 },
      (_, i) => `Table row ${i} lists command ${100 * i} and its comment`,
    ),
    moved = [
      "Your figures should contain a caption describing them",
      "Figure captions are placed below every figure here",
    ],
    inserted = [
      "Inserted sentence explains the title command fully",
      "and why breaks in titles are not allowed at all",
    ],
    closing = Array.from(
      { length: 6 },
      (_, i) => `Closing line ${i} restates the invariant for leaders`,
    ),
    old = pdf([...opening, ...table, ...moved, ...closing]),
    neu = pdf([...opening, ...inserted, ...moved, ...table, ...closing]),
    al = alignment(build(old), build(neu))!,
    words = printed(neu),
    of = (line: string) =>
      words
        .filter((w) => line.split(" ").includes(w.text))
        .filter((w) =>
          neu
            .page(w.page)
            .lines.some(
              (l) => l.text.trim() === line && containsCenter(l.rect, w.rect),
            ),
        ),
    // SyncTeX's crop of the edit reaches over the lines after it.
    box = [...inserted, ...moved].flatMap(of).map((w) => w.rect),
    right: Position[] = [
      {
        page: 0,
        clip: [
          0,
          Math.min(...box.map((r) => r[1])) - 2,
          600,
          Math.max(...box.map((r) => r[3])) + 2,
        ],
        label: "",
      },
    ],
    text = (i: number) => {
      const [a, b] = al.new.words.lines[i];
      return al.new.words.tokens
        .slice(a, b)
        .map((t) => t.text)
        .join(" ");
    },
    ours = (i: number) => (/Inserted|titles/.test(text(i)) ? true : undefined),
    shown = (mine?: Parameters<typeof alignedCrops>[4]) => {
      const crops = alignedCrops(al, [], right, false, mine)!.flatMap(
        (g) => g.right,
      );
      return (line: string) => of(line).every((w) => inside(w, crops));
    };
  const owned = shown({ old: () => undefined, new: ours });
  expect(inserted.every(owned)).toBe(true);
  expect(owned(moved[1])).toBe(false);
  // Without knowing who printed what, every moved line counts.
  expect(shown()(moved[1])).toBe(true);
});
it("bounds a move's source by its words when SyncTeX reaches another edit", () => {
  const opening = Array.from(
      { length: 4 },
      (_, i) => `Opening ${i} keeps the starting context stable`,
    ),
    moved =
      "A relocated sentence explains how replicas commit durable commands",
    middle = Array.from(
      { length: 10 },
      (_, i) => `Middle ${i} remains unchanged between the independent edits`,
    ),
    destination = "Destination discusses a different part of the protocol",
    closing = Array.from(
      { length: 4 },
      (_, i) => `Closing ${i} keeps the ending context stable`,
    ),
    old = pdf([...opening, moved, ...middle, destination, ...closing]),
    neu = pdf([
      ...opening,
      ...middle,
      moved,
      destination + " with new evidence",
      ...closing,
    ]),
    al = alignment(build(old), build(neu))!,
    lineOf = (name: "old" | "new", text: string) =>
      al[name].words.lines.findIndex(
        ([a, b]) =>
          al[name].words.tokens
            .slice(a, b)
            .map((t) => t.text)
            .join(" ") === text,
      ),
    source = lineOf("old", moved),
    target = lineOf("new", moved),
    neighbor = lineOf("new", middle[0]),
    crop = (name: "old" | "new", first: number, last: number): Position[] => [
      {
        page: 0,
        clip: [
          0,
          al[name].lines[first].rect[1] - 2,
          600,
          al[name].lines[last].rect[3] + 2,
        ],
        label: "",
      },
    ],
    groups = alignedCrops(
      al,
      crop("old", source - 1, source + 2),
      crop("new", neighbor - 1, target + 2),
      false,
      {
        old: (line) =>
          line === source
            ? true
            : line === lineOf("old", destination)
              ? false
              : undefined,
        new: (line) =>
          line === neighbor ? true : line >= target ? false : undefined,
      },
    )!,
    left = groups.flatMap((g) => g.left),
    shown = printed(old)
      .filter((w) => inside(w, left))
      .map((w) => w.text)
      .join(" ");
  expect(shown).toContain(moved);
  expect(shown).not.toContain("Middle 5");
  expect(shown).not.toContain("Destination");
  expect(
    groups
      .flatMap((g) => g.right)
      .every((at) => at.clip[3] < al.new.lines[neighbor + 3].rect[1]),
  ).toBe(true);
});
// A PDF of rows, each printed as pieces at the x positions given, as an
// inline formula prints apart from the words around it.
function rows(list: [number, string][][], columnOrder = false) {
  const doc = new mupdf.PDFDocument(),
    font = new mupdf.Font("Helvetica"),
    resource = doc.addSimpleFont(font),
    content = list
      .flatMap((row, i) => row.map(([x, text]) => ({ x, text, i })))
      .sort((a, b) => (columnOrder ? a.x - b.x : 0))
      .map(
        ({ x, text, i }) =>
          `BT /F1 12 Tf ${x} ${550 - 18 * i} Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`,
      )
      .join("\n"),
    page = doc.addPage(
      [0, 0, 600, 600],
      0,
      { Font: { F1: resource } },
      content,
    );
  doc.insertPage(-1, page);
  page.destroy();
  const buffer = doc.saveToBuffer(""),
    result = new PdfDocument(buffer.asUint8Array());
  buffer.destroy();
  resource.destroy();
  font.destroy();
  doc.destroy();
  documents.push(result);
  return result;
}
it.each(["line", "page", "column"] as const)(
  "preserves every changed glyph when a word crosses a %s boundary",
  (boundary) => {
    const prefix = Array.from(
        { length: boundary === "page" ? LINES - 1 : 4 },
        (_, i) => `Stable preceding sentence ${i} stays in place`,
      ),
      suffix = [
        "The following stable sentence remains in place",
        "Another independent anchor sentence follows it",
      ],
      columns = (split: boolean) =>
        rows(
          Array.from({ length: 20 }, (_, i): [number, string][] => [
            [
              30,
              i === 19
                ? `Opening ${split ? "inter-" : "connectivity"}`
                : `Left anchor ${i} keeps the reading order`,
            ],
            [
              330,
              i === 0
                ? split
                  ? "operability"
                  : ""
                : `Right anchor ${i} keeps the reading order`,
            ],
          ]),
          true,
        ),
      split =
        boundary === "column"
          ? columns(true)
          : pdf([...prefix, "Opening inter-", "operability", ...suffix]),
      joined =
        boundary === "column"
          ? columns(false)
          : pdf([...prefix, "Opening connectivity", "", ...suffix]),
      own = (doc: PdfDocument): Position[] =>
        printed(doc)
          .filter((w) =>
            ["inter-", "operability", "connectivity"].includes(w.text),
          )
          .map(({ page, rect }) => ({
            page,
            clip: [rect[0] - 1, rect[1] - 1, rect[2] + 1, rect[3] + 1],
            label: String(page + 1),
          }));
    if (boundary === "column") expect(split.page(0).twoColumns).toBe(true);
    for (const [old, next] of [
      [split, joined],
      [joined, split],
    ]) {
      const al = alignment(build(old), build(next))!,
        groups = alignedCrops(al, own(old), own(next), false)!;
      const side = old === split ? "old" : "new",
        pieces = al[side].words.tokens.filter((t) =>
          ["inter", "operability"].includes(t.text),
        );
      expect(pieces.map((t) => t.text).join("")).toBe("interoperability");
      const word = pieces.at(-1)!,
        tail = al[side].words.glyphs[word.end - 1];
      // A source record at the continuation identifies its segment's line.
      // Both segments must retain every changed glyph below.
      expect(
        printers(al, side, [
          [[tail.page, tail.rect[1], tail.rect[3], tail.rect[0], tail.rect[2]]],
        ]).get(al[side].glyphLine[word.end - 1]),
      ).toEqual([0]);
      expect(groups).not.toBeNull();
      for (const side of ["old", "new"] as const) {
        const crops = groups.flatMap((g) =>
            side === "old" ? g.left : g.right,
          ),
          missing = [...al[side].changed].flatMap(([page, glyphs]) =>
            glyphs
              .filter(
                (g) =>
                  !crops.some(
                    (p) =>
                      p.page === page &&
                      al[side].words.glyphs[g].rect.every((edge, index) =>
                        index < 2
                          ? edge >= p.clip[index]
                          : edge <= p.clip[index],
                      ),
                  ),
              )
              .map((g) => al[side].words.glyphs[g].text),
          );
        expect(missing.join(""), `${boundary}: ${side}`).toBe("");
      }
    }
  },
);
it.each([false, true])(
  "keeps visual changes where logical lines share a physical row (wide %s)",
  (wide) => {
    const colored = (change: boolean) => {
        const raw = new mupdf.PDFDocument(),
          font = new mupdf.Font("Helvetica"),
          resource = raw.addSimpleFont(font),
          pages = [
            "BT /F1 12 Tf 30 530 Td (The stable preceding anchor sentence remains in place) Tj ET " +
              "BT /F1 12 Tf 30 100 Td (Opening inter-) Tj ET",
            "BT /F1 12 Tf 30 530 Td (operability ) Tj " +
              (change ? "1 0 0 rg " : "") +
              "(trailing material remains) Tj ET 0 0 0 rg " +
              "BT /F1 12 Tf 30 500 Td (An unchanged intervening sentence remains here) Tj ET " +
              (change ? "0 0 1 rg " : "") +
              "BT /F1 12 Tf 30 470 Td (Another visual change remains in this source unit) Tj ET 0 0 0 rg " +
              "BT /F1 12 Tf 30 440 Td (The stable following anchor sentence remains in place) Tj ET",
          ];
        for (const content of pages) {
          const page = raw.addPage(
            [0, 0, 600, 600],
            0,
            { Font: { F1: resource } },
            content,
          );
          raw.insertPage(-1, page);
          page.destroy();
        }
        const buffer = raw.saveToBuffer(""),
          result = new PdfDocument(buffer.asUint8Array());
        buffer.destroy();
        resource.destroy();
        font.destroy();
        raw.destroy();
        documents.push(result);
        return result;
      },
      old = colored(false),
      next = colored(true),
      al = alignment(build(old), build(next))!,
      own: Position[] = [{ page: 1, clip: [0, 50, 600, 145], label: "2" }],
      groups = alignedCrops(al, own, own, wide)!;
    // The continuation of one logical line and the following line occupy the
    // same physical row. Its color change must survive context tightening.
    for (const [doc, crops] of [
      [old, groups.flatMap((g) => g.left)],
      [next, groups.flatMap((g) => g.right)],
    ] as const)
      for (const text of [
        "trailing material remains",
        "Another visual change",
      ]) {
        const rects = doc.page(1).search(text);
        expect(rects.length, text).toBeGreaterThan(0);
        expect(
          rects.every((rect) =>
            crops.some(
              (p) =>
                p.page === 1 &&
                rect.every((edge, index) =>
                  index < 2 ? edge >= p.clip[index] : edge <= p.clip[index],
                ),
            ),
          ),
          text,
        ).toBe(true);
      }
  },
);
it.each([false, true])(
  "keeps both documents complete when continuation rows share words (chained %s)",
  (chained) => {
    const prefix = Array.from(
        { length: 4 },
        (_, i) => `Stable opening context ${i}`,
      ),
      suffix = Array.from(
        { length: 4 },
        (_, i) => `Stable closing context ${i}`,
      ),
      old = pdf([
        ...prefix,
        "Opening old interoperability",
        "extraordinary balance remains",
        ...suffix,
      ]),
      next = pdf([
        ...prefix,
        "Opening new inter-",
        ...(chained
          ? ["operability extraor-", "dinary balance remains"]
          : ["operability extraordinary balance remains"]),
        ...suffix,
      ]),
      al = alignment(build(old), build(next))!,
      at = (doc: PdfDocument, text: string): Position[] => {
        const w = printed(doc).find((w) => w.text === text)!;
        return [{ page: w.page, clip: w.rect, label: "" }];
      },
      groups = alignedCrops(al, at(old, "old"), at(next, "new"), false)!,
      right = groups.flatMap((g) => g.right),
      left = groups.flatMap((g) => g.left),
      visible = (name: "old" | "new", t: number, crops: Position[]) => {
        const w = al[name].words,
          token = w.tokens[t];
        return w.glyphs
          .slice(token.start, token.end)
          .some((g) => inside(g, crops));
      };
    for (const [t, token] of al.new.words.tokens.entries()) {
      if (!visible("new", t, right)) continue;
      // A shared physical row cannot end halfway through another word.
      for (const g of al.new.words.glyphs.slice(token.start, token.end))
        expect(
          right.some(
            (p) =>
              p.page === g.page &&
              p.clip[0] <= g.rect[0] &&
              p.clip[1] <= g.rect[1] &&
              p.clip[2] >= g.rect[2] &&
              p.clip[3] >= g.rect[3],
          ),
          token.text,
        ).toBe(true);
      const other = al.tokens.new[t];
      if (other >= 0)
        expect(visible("old", other, left), token.text).toBe(true);
    }
  },
);
it("identifies the words of an old row also shown in context, and only those", () => {
  const around = (n: number) =>
      Array.from({ length: 6 }, (_, i): [number, string][] => [
        [30, `Steady line ${n + i} about logs and replicas of the state`],
      ]),
    row: [number, string][] = [
      [30, "Context words before"],
      [250, "the formula"],
      [400, "alpha omega."],
    ],
    old = rows([...around(0), row, ...around(10)]),
    // The change now prints on a row of its own, as a display does, so the
    // words before it are on the row above, which the context shows.
    apart = rows([
      ...around(0),
      row.slice(0, 2),
      [[400, "alpha sigma."]],
      ...around(10),
    ]),
    // The change stays on its row, which the new crop shows whole.
    together = rows([
      ...around(0),
      [...row.slice(0, 2), [400, "alpha sigma."]],
      ...around(10),
    ]);
  const at = (doc: PdfDocument, text: string): Position[] => {
      const word = printed(doc).find((w) => w.text === text)!;
      return [
        {
          page: 0,
          clip: [0, word.rect[1] - 1, 600, word.rect[3] + 1],
          label: "",
        },
      ];
    },
    group = (neu: PdfDocument) =>
      alignedCrops(
        alignment(build(old), build(neu))!,
        at(old, "omega."),
        at(neu, "sigma."),
        false,
      )![0],
    faded = (g: ReturnType<typeof group>, text: string) =>
      printed(old)
        .filter((w) => w.text === text)
        .every((w) =>
          (g.faded ?? []).some(
            (f) => f.page === w.page && containsCenter(f.rect, w.rect),
          ),
        );
  const one = group(apart);
  expect(
    inside(
      printed(old).find((w) => w.text === "Context")!,
      one.left,
    ),
  ).toBe(true);
  for (const word of ["Context", "words", "before", "formula"])
    expect(faded(one, word)).toBe(true);
  expect(faded(one, "omega.")).toBe(false);
  const two = group(together);
  for (const word of ["Context", "formula", "omega."])
    expect(faded(two, word)).toBe(false);
});
it("takes a page for two columns only when most of its prose is in columns", () => {
  const prose = "Replicas apply committed commands in their order";
  // One column, with two displays set side by side.
  const one = rows([
    ...Array.from({ length: 12 }, (): [number, string][] => [
      [30, `${prose} and the leader keeps the log`],
    ]),
    ...Array.from({ length: 4 }, (): [number, string][] => [
      [30, prose],
      [330, prose],
    ]),
  ]);
  // Two columns from top to bottom.
  const two = rows(
    Array.from({ length: 20 }, (): [number, string][] => [
      [30, prose],
      [330, prose],
    ]),
  );
  expect(one.page(0).twoColumns).toBe(false);
  expect(two.page(0).twoColumns).toBe(true);
});
it("partitions a section without duplicating a narrow band across both columns", () => {
  const prose = "Replicas apply all commands in their order",
    document = rows(
      Array.from({ length: 20 }, (_, i): [number, string][] =>
        i === 8
          ? [
              [
                30,
                "This wide row crosses the gutter and belongs to both columns",
              ],
            ]
          : [
              [30, prose],
              [330, prose],
            ],
      ),
    ),
    node = {
      id: "section",
      file: "main.tex",
      line: 1,
      title: "Section",
      files: [],
    } as unknown as Heading,
    page = document.page(0),
    at = {
      document,
      outline: [node],
      path: (name: string) => name,
      locator: { lookup: () => [[0, 40, 60, 30, 280]] },
      margins: { body: () => [40, 500] },
    } as unknown as Build,
    [intervals] = sectionIntervals(at, node, () => false),
    rects = [...intervals].flatMap(([lane, spans]) => {
      const [x0, x1] = laneX(document, lane);
      return spans.map(([y0, y1]): Rect => [x0, y0, x1, y1]);
    });
  expect(page.twoColumns).toBe(true);
  expect(page.spanning).toHaveLength(1);
  expect(intervals.has(0)).toBe(true);
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i],
        b = rects[j];
      const width = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
      const height = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
      expect(width * height).toBe(0);
    }
});
it("does not call a word moved when reflow only hyphenates it elsewhere", () => {
  // One word changed early in the paragraph; the rest reflows, so the
  // same word breaks at another hyphen. Nothing moved: only the changed
  // word is marked.
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `Steady line ${i} of the unchanged paragraph text.`);
  const old = pdf([
      "The opening anchor sentence stays exactly where it was.",
      "Neither method uses the information of the other argu-",
      "ments when the compiler infers each type separately.",
      ...filler(30),
    ]),
    next = pdf([
      "The opening anchor sentence stays exactly where it was.",
      "Neither variant uses the information of the other ar-",
      "guments when the compiler infers each type separately.",
      ...filler(30),
    ]),
    al = alignment(build(old), build(next));
  for (const side of ["old", "new"] as const) {
    const moved = [...al[side].moved.values()].flat().map((g) => al[side].words.glyphs[g].text).join("");
    expect(moved).toBe("");
    const crop: Position = { page: 0, clip: [0, 0, 600, 600], label: "1" };
    expect(marksIn(al, side, crop).filter((m) => m.kind === "moved")).toEqual([]);
  }
  const changed = (side: "old" | "new") => [...al[side].changed.values()].flat().map((g) => al[side].words.glyphs[g].text).join("");
  expect(changed("old")).toBe("method");
  expect(changed("new")).toBe("variant");
});

it("finds one place only where two crops print a line in common", async () => {
  const { sharesLine } = await import("../../src/render/inline.ts");
  const doc = pdf(["The first printed line of the paragraph.", "The second printed line of the paragraph.", "The third printed line of the paragraph."]),
    lines = doc.page(0).lines.filter((l) => l.text.trim()),
    [first, second] = lines.map((l) => l.rect),
    same = sharesLine(doc),
    crop = (top: number, bottom: number): Position => ({ page: 0, clip: [0, top, 600, bottom], label: "1" });
  // A crop of the first line and one of the rest touch where their boxes do.
  expect(same(crop(first[1], first[3] + 1), crop(first[3] - 1, 600))).toBe(false);
  // Both crops hold the second line: one place.
  expect(same(crop(first[1], second[3]), crop(second[1], 600))).toBe(true);
});

it("does not move running heads or reach crops to them when pages turn elsewhere", () => {
  // Inserted lines push the body down a page break; each page's running
  // head then sits at another place in the reading order. The heads only
  // turned with the pages: they are not moved text, and nothing a crop shows.
  const body = Array.from({ length: 40 }, (_, i) => `Body line ${i} keeps its words in every version.`),
    old = pdf(body),
    next = pdf([...body.slice(0, 3), ...Array.from({ length: 10 }, (_, i) => `Inserted line ${i} adds new words here.`), ...body.slice(3)]),
    al = alignment(build(old), build(next));
  for (const side of ["old", "new"] as const) {
    const text = (map: Map<number, number[]>) => [...map.values()].flat().map((g) => al[side].words.glyphs[g].text).join("");
    expect(text(al[side].moved)).toBe("");
    expect(text(al[side].unpaired)).not.toContain("Page");
  }
});
