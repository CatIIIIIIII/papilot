import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, it, expect } from "vitest";
import { mupdf, PdfDocument, containsCenter } from "../../src/render/pdf.ts";
import { textChanges, pixelDifference } from "../../src/render/pdfdiff.ts";
import {
  Strips,
  textRows,
  balancedTextPairs,
  withoutMoves,
  changedLineBounds,
  foldContext,
  renderDocument,
  snap,
  trimmed,
} from "../../src/render/inline.ts";
import type { Build } from "../../src/render/locate.ts";
import { byReading, laneAt, readingKey } from "../../src/render/locate.ts";
import { typesetWords } from "../../src/render/round.ts";
import { sourcePairs } from "../../src/render/source-spans.ts";
import { textEdits } from "../../src/core/text-edits.ts";
import { opcodes } from "../../src/core/diff.ts";
import type { Card, Heading, Position, Strip, Unit } from "../../src/types.ts";
const documents: PdfDocument[] = [];
const folders: string[] = [];
it("keeps at least a page of context on each side of an isolated edit", () => {
  const plan = foldContext([
    { kind: "context", lane: 0, top: 0, bottom: 2000 },
    { kind: "change", lane: 0, top: 2000, bottom: 2050 },
    { kind: "context", lane: 0, top: 2050, bottom: 4000 },
  ]);
  const visible = plan.filter((p) => p.kind === "context");
  expect(visible).toHaveLength(2);
  for (const part of visible)
    if (part.kind === "context")
      expect(part.bottom - part.top).toBeGreaterThanOrEqual(720);
});
export function document(pages: string[]) {
  const doc = new mupdf.PDFDocument(),
    font = new mupdf.Font("Helvetica"),
    resource = doc.addSimpleFont(font);
  for (const text of pages) {
    const content =
      "BT /F1 12 Tf 30 550 Td 18 TL " +
      text
        .split("\n")
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
  const buffer = doc.saveToBuffer("");
  const result = new PdfDocument(buffer.asUint8Array());
  buffer.destroy();
  resource.destroy();
  font.destroy();
  doc.destroy();
  documents.push(result);
  return result;
}
function drawing(content: string) {
  const raw = new mupdf.PDFDocument(),
    page = raw.addPage([0, 0, 200, 200], 0, {}, content);
  raw.insertPage(-1, page);
  const buffer = raw.saveToBuffer(""),
    doc = new PdfDocument(buffer.asUint8Array().slice());
  documents.push(doc);
  buffer.destroy();
  page.destroy();
  raw.destroy();
  return doc;
}
const positions = (doc: PdfDocument): Position[] =>
  Array.from({ length: doc.length }, (_, page) => ({
    page,
    clip: [0, 0, 600, 600],
    label: String(page + 1),
  }));
const compare = (a: PdfDocument, b: PdfDocument) =>
  textChanges(a, b, positions(a), positions(b));
it("retains faint coloured drawings while omitting truly blank strips", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "review-faint-"));
  folders.push(folder);
  const strips = new Strips(folder);
  for (const color of ["1 0.99 0.99", "0.99 0.99 1", "1 1 1"]) {
    const doc = drawing(`${color} rg 40 40 20 20 re f`);
    const strip = strips.write(doc, 0, 139, 161, [], "", [39, 61]);
    if (color === "1 1 1") expect(strip).toBeNull();
    else expect(strip).not.toBeNull();
  }
});
it("keeps faint ink at both crop edges while trimming only blank rows", () => {
  const doc = drawing(
    "1 0.99 0.99 rg 40 158 20 2 re f " +
      "0 0 0 rg 40 148 20 2 re f " +
      "0.99 0.99 1 rg 40 138 20 2 re f",
  );
  // The three printed bands occupy y=40..42, 50..52, and 60..62.
  expect(trimmed(doc, 0, 35, 65, [35, 65])).toEqual([39, 63]);
  expect(snap(doc, 0, 41, 61, [35, 65])).toEqual([40, 62]);
  expect(trimmed(doc, 0, 70, 80, [35, 65])).toEqual([70, 80]);
});
it("keeps the raster scale when a fractional crop reaches the page edge", () => {
  const doc = drawing("0 0 0 rg 40 .7 20 10 re f");
  // Ink ends at y=199.3. A partial final raster row must not compress all
  // the preceding rows and move the bottom boundary back into that ink.
  expect(snap(doc, 0, 190, 195.3, [35, 65])[1]).toBeCloseTo(199.3);
});
afterEach(() => {
  documents.splice(0).forEach((d) => d.close());
  folders
    .splice(0)
    .forEach((f) => fs.rmSync(f, { recursive: true, force: true }));
});
function sectioned(doc: PdfDocument, lines: number[]): Build {
  const nodes: Heading[] = lines.map((line, i) => ({
      id: String(i),
      title: `Section ${i}`,
      number: String(i + 1),
      kind: "section",
      level: 1,
      file: "paper.tex",
      line,
      parent: null,
      labels: [],
      files: ["paper.tex"],
      ranges: {},
    })),
    build = {
      document: doc,
      outline: nodes,
      path: (name: string) => name,
      locator: {
        lookup: (_file: string, line: number) => [
          [0, 38 + line * 18, 52 + line * 18, 0, 600],
        ],
      },
      margins: { body: () => [32, 260] },
      figures: { locate: () => [] },
    } as unknown as Build;
  return build;
}
it("shares full PDF context while attributing each word highlight to its source edit", () => {
  const a = "The method is fast and the result is useful.",
    b = "The method is efficient and the result is practical.",
    old = sectioned(document([a]), [0]),
    next = sectioned(document([b]), [0]);
  old.read = () => a;
  next.read = () => b;
  const cards = textEdits(a, b).map((op, i): Card => {
    const unit = { file: "paper.tex", text_ops: [op] } as Unit,
      pairs = sourcePairs(
        old,
        next,
        unit,
        positions(old.document),
        positions(next.document),
      );
    expect(pairs).not.toBeNull();
    const shown = old.document
      .page(0)
      .lines[0].chars.filter((c) =>
        pairs![0].before_marks.some((m) => containsCenter(m.rect, c.rect)),
      )
      .map((c) => c.text)
      .join("");
    expect(shown).toBe(i === 0 ? "fast" : "useful");
    return {
      id: `c${i}`,
      file: unit.file,
      context_node: "0",
      comparison: "text",
      aligned: true,
      independent: true,
      pairs: pairs!,
    };
  });
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "review-fine-"));
  folders.push(folder);
  const result = renderDocument(
      old,
      next,
      cards,
      new Strips(folder),
      () => false,
    ),
    changes = [
      ...result.sections.flatMap((s) => s.blocks),
      ...result.loose,
    ].filter((b) => b.kind === "change");
  expect(changes.map(c => c.units)).toEqual([["c0", "c1"]]);
  expect(changes[0].before[0].text?.map(line => line.text.trim()).join(" ")).toBe(a);
  const words = (unit: string, side: "before" | "after") => changes[0][side].flatMap(strip =>
    strip.text?.flatMap(line => line.chars.filter(char => strip.marks?.some(mark => mark.unit === unit && containsCenter(mark.rect, char.rect))).map(char => char.text)) || []).join("").trim();
  expect(words("c0", "before")).toBe("fast");
  expect(words("c1", "before")).toBe("useful");
  expect(words("c0", "after")).toBe("efficient");
  expect(words("c1", "after")).toBe("practical");
});

it("renders shared ink once across sections and floating edits, retaining every edit", () => {
  const doc = document([
      Array.from(
        { length: 12 },
        (_, i) => `Line ${i} has distinct words here`,
      ).join("\n"),
    ]),
    build = sectioned(doc, [0, 5]),
    cards: Card[] = [
      ["a", "0", 88, 128],
      ["b", "1", 110, 164],
      ["figure", null, 145, 182],
    ].map(([id, section, top, bottom]) => ({
      id: String(id),
      file: "paper.tex",
      context_node: section as string | null,
      comparison: "text",
      aligned: true,
      pairs: [
        {
          old: {
            page: 0,
            clip: [0, Number(top), 600, Number(bottom)],
            label: "1",
          },
          new: {
            page: 0,
            clip: [0, Number(top), 600, Number(bottom)],
            label: "1",
          },
          group: 0,
          before_marks: [],
          after_marks: [],
        },
      ],
    })),
    folder = fs.mkdtempSync(path.join(os.tmpdir(), "review-global-"));
  folders.push(folder);
  const rect = doc.page(0).search("Line 4")[0];
  cards[0].pairs[0].before_marks = [{ kind: "context", rect }];
  cards[1].pairs[0].before_marks = [
    { kind: "removed", rect },
    { kind: "removed", rect },
  ];
  const original = structuredClone(cards),
    result = renderDocument(
      build,
      build,
      cards,
      new Strips(folder),
      () => false,
    ),
    blocks = [...result.sections.flatMap((s) => s.blocks), ...result.loose],
    changes = blocks.filter((b) => b.kind === "change"),
    shown = (word: { rect: number[] }, strips: Strip[]) =>
      strips.filter((s) =>
        containsCenter(
          [s.left ?? 0, s.top!, (s.left ?? 0) + s.width, s.top! + s.height],
          word.rect as [number, number, number, number],
        ),
      ).length;
  expect(cards).toEqual(original);
  expect(changes.map((b) => b.units)).toEqual([
    ["a", "b", "figure"],
    ["a", "b", "figure"],
  ]);
  expect(changes.filter((b) => b.before.length)).toHaveLength(1);
  const svg = changes[0].before
    .map((s) => fs.readFileSync(path.join(folder, s.src), "utf8"))
    .join("");
  expect(svg).not.toContain('fill-opacity=".7"');
  expect(svg.match(/fill="#c72938"/g)).toHaveLength(1);
  for (const side of ["before", "after"] as const) {
    const strips = blocks.flatMap((b) =>
      b.kind === "change"
        ? b[side]
        : side === "after" && b.kind === "context"
          ? [b.image]
          : [],
    );
    for (const word of doc.page(0).words) {
      expect(shown(word, strips)).toBeLessThanOrEqual(1);
      if (
        original.some((c) =>
          containsCenter(
            c.pairs[0][side === "before" ? "old" : "new"]!.clip,
            word.rect,
          ),
        )
      )
        expect(shown(word, strips)).toBe(1);
    }
  }
});
it("keeps separated fragments and intervening context in reading order", () => {
  const doc = document([
      Array.from({ length: 12 }, (_, i) => `Line ${i} remains readable`).join(
        "\n",
      ),
    ]),
    build = sectioned(doc, [0]),
    position = (top: number, bottom: number): Position => ({
      page: 0,
      clip: [0, top, 600, bottom],
      label: "1",
    }),
    cards: Card[] = [
      {
        id: "a",
        file: "paper.tex",
        context_node: "0",
        comparison: "text",
        aligned: true,
        pairs: [
          {
            old: position(54, 75),
            new: position(54, 75),
            group: 0,
            before_marks: [],
            after_marks: [],
          },
          {
            old: null,
            new: position(180, 201),
            group: 0,
            before_marks: [],
            after_marks: [],
          },
        ],
      },
      {
        id: "b",
        file: "paper.tex",
        context_node: "0",
        comparison: "text",
        aligned: true,
        pairs: [
          {
            old: position(216, 237),
            new: position(108, 129),
            group: 0,
            before_marks: [],
            after_marks: [],
          },
        ],
      },
    ],
    folder = fs.mkdtempSync(path.join(os.tmpdir(), "review-order-"));
  folders.push(folder);
  const result = renderDocument(
      build,
      build,
      cards,
      new Strips(folder),
      () => false,
    ),
    blocks = result.sections.flatMap((s) => s.blocks),
    changes = blocks.filter((b) => b.kind === "change"),
    strips = blocks.flatMap((b) =>
      b.kind === "context" ? [b.image] : b.kind === "change" ? b.after : [],
    );
  expect(changes.map((b) => b.units)).toEqual([["a"], ["b"], ["a"]]);
  expect(changes.map((b) => b.before.length)).toEqual([1, 1, 0]);
  expect(strips.map((s) => s.top)).toEqual(
    strips.map((s) => s.top).sort((a, b) => a! - b!),
  );
  expect(
    strips
      .flatMap((s) => s.text ?? [])
      .map((l) => l.text)
      .join(" "),
  ).toContain("Line 6 remains readable");
});
it("partitions nested headings without losing child context or jumping back in reading order", () => {
  const doc = document([
      Array.from({ length: 12 }, (_, i) => `Line ${i} remains readable`).join(
        "\n",
      ),
    ]),
    build = sectioned(doc, [0, 5, 10]);
  build.outline[0].level = 0;
  build.outline[1].parent = build.outline[2].parent = "0";
  const cards: Card[] = [
      ["parent", "0", 54, 75],
      ["child", "1", 180, 237],
    ].map(([id, section, top, bottom]) => ({
      id: String(id),
      file: "paper.tex",
      context_node: String(section),
      comparison: "text",
      aligned: true,
      pairs: [
        {
          old: {
            page: 0,
            clip: [0, Number(top), 600, Number(bottom)],
            label: "1",
          },
          new: {
            page: 0,
            clip: [0, Number(top), 600, Number(bottom)],
            label: "1",
          },
          group: 0,
          before_marks: [],
          after_marks: [],
        },
      ],
    })),
    folder = fs.mkdtempSync(path.join(os.tmpdir(), "review-headings-"));
  folders.push(folder);
  const result = renderDocument(
      build,
      build,
      cards,
      new Strips(folder),
      () => false,
    ),
    child = result.sections.find((s) => s.node === "1")!,
    strips = result.sections.flatMap((s) =>
      s.blocks.flatMap((b) =>
        b.kind === "context" ? [b.image] : b.kind === "change" ? b.after : [],
      ),
    );
  expect(
    child.blocks.some((b) => b.kind === "change" && b.units.includes("child")),
  ).toBe(true);
  expect(
    child.blocks
      .flatMap((b) => (b.kind === "context" ? (b.image.text ?? []) : []))
      .map((l) => l.text)
      .join(" "),
  ).toContain("Line 6 remains readable");
  expect(strips.map((s) => s.top)).toEqual(
    strips.map((s) => s.top).sort((a, b) => a! - b!),
  );
  for (const word of doc.page(0).words)
    expect(
      strips.filter((s) =>
        containsCenter(
          [s.left ?? 0, s.top!, (s.left ?? 0) + s.width, s.top! + s.height],
          word.rect,
        ),
      ),
    ).toHaveLength(1);
  // Unaffected preceding sections must not push the first edit out of view.
  const onlyChild = structuredClone(cards.slice(1));
  for (const side of ["old", "new"] as const)
    onlyChild[0].pairs[0][side]!.clip = [0, 162, 600, 183];
  const scoped = renderDocument(
    build,
    build,
    onlyChild,
    new Strips(folder),
    () => false,
  );
  expect(scoped.sections.map((s) => s.node)).toEqual(["1"]);
});
it("splits a wide source crop into the page's reading lanes and sections", () => {
  const raw = new mupdf.PDFDocument(),
    font = new mupdf.Font("Helvetica"),
    resource = raw.addSimpleFont(font);
  let content = "";
  for (const [x, side] of [
    [30, "LEFT"],
    [330, "RIGHT"],
  ] as const)
    for (let line = 0; line < 12; line++)
      content += `BT /F1 10 Tf ${x} ${550 - line * 18} Td (${side} line ${line} has several readable words.) Tj ET\n`;
  const page = raw.addPage(
    [0, 0, 600, 600],
    0,
    { Font: { F1: resource } },
    content,
  );
  raw.insertPage(-1, page);
  page.destroy();
  const buffer = raw.saveToBuffer(""),
    doc = new PdfDocument(buffer.asUint8Array());
  documents.push(doc);
  buffer.destroy();
  resource.destroy();
  font.destroy();
  raw.destroy();
  const build = sectioned(doc, [0, 5]);
  build.locator.lookup = (_file, line) => [
    [0, 40 + line * 18, 52 + line * 18, 30, 260],
  ];
  expect(doc.page(0).twoColumns).toBe(true);
  expect(doc.page(0).spanning).toEqual([]);
  const position: Position = { page: 0, clip: [0, 88, 600, 128], label: "1" },
    card: Card = {
      id: "figure",
      file: "figure.tex",
      context_node: "0",
      comparison: "layout",
      aligned: true,
      pairs: [
        {
          old: position,
          new: position,
          group: 0,
          before_marks: [],
          after_marks: [],
        },
      ],
    },
    folder = fs.mkdtempSync(path.join(os.tmpdir(), "review-wide-"));
  folders.push(folder);
  const result = renderDocument(
      build,
      build,
      [card],
      new Strips(folder),
      () => true,
    ),
    changes = result.sections.flatMap((s) =>
      s.blocks.filter((b) => b.kind === "change"),
    ),
    shown = result.sections.flatMap((s) =>
      s.blocks.flatMap((b) =>
        b.kind === "context" ? [b.image] : b.kind === "change" ? b.after : [],
      ),
    ),
    key = (s: Strip) =>
      readingKey(
        doc,
        laneAt(doc, s.page! - 1, [
          s.left ?? 0,
          s.top!,
          (s.left ?? 0) + s.width,
          s.top! + s.height,
        ]),
        s.top!,
      );
  expect(result.loose).toEqual([]);
  for (let i = 1; i < shown.length; i++)
    expect(byReading(key(shown[i - 1]), key(shown[i]))).toBeLessThanOrEqual(0);
  expect(changes.map((b) => b.units)).toEqual([["figure"], ["figure"]]);
  expect(changes.filter((b) => b.before.length)).toHaveLength(1);
  expect(changes.flatMap((b) => b.after).every((s) => s.width <= 300)).toBe(
    true,
  );
  for (const word of doc.page(0).words)
    expect(
      shown.filter((s) =>
        containsCenter(
          [s.left ?? 0, s.top!, (s.left ?? 0) + s.width, s.top! + s.height],
          word.rect,
        ),
      ),
    ).toHaveLength(1);
});
it("marks whole words including deleted suffixes", () => {
  const old = document([
      "Since a type variable's meaning now depends on its bound,\nour two new guards must also be context-aware.",
    ]),
    next = document([
      "Since type variables now depend on their bounds, both guards must be context-aware.",
    ]),
    result = compare(old, next);
  const marked = next
    .page(0)
    .words.filter((w) =>
      result.new_marks[0].some((m) => containsCenter(m.rect, w.rect)),
    )
    .map((w) => w.text);
  expect(marked).toEqual(["variables", "depend", "their", "bounds,", "both"]);
});
it("does not mark unchanged words following a replacement", () => {
  const old = document(["The extensions add the following types."]),
    next = document(["We add the following types."]),
    result = compare(old, next);
  expect(result.edits).toEqual([
    { old: "The extensions", new: "We", truncated: false },
  ]);
  expect(
    result.new_marks[0].every(
      (m) => m.rect[2] <= next.page(0).search("We")[0][2] + 0.1,
    ),
  ).toBe(true);
});
it("ignores partial adjacent-line glyphs at crop edges", () => {
  const old = document(["Unchanged context\nThe old word."]),
    next = document(["Unchanged context\nThe new word."]),
    a = positions(old),
    b = positions(next);
  a[0].clip[1] = old.page(0).search("context")[0][3] - 0.5;
  b[0].clip[1] = next.page(0).search("context")[0][3] + 0.5;
  expect(textChanges(old, next, a, b).edits).toEqual([
    { old: "old", new: "new", truncated: false },
  ]);
});
it.each([
  ["the bounds", "the\nbounds"],
  ["A func-\ntion returns.", "A function returns."],
  ["alpha beta gamma delta", "alpha beta\ngamma delta"],
])("treats wrapping and hyphenation as movement", (a, b) => {
  const result = compare(document([a]), document([b]));
  expect(result.text_changed).toBe(false);
  expect(result.moved).toBe(true);
});
it.each([
  ["now here", "nowhere"],
  ["order-irrelevant", "orderirrelevant"],
  ["x + y", "x - y"],
])("detects semantic differences %s", (a, b) =>
  expect(compare(document([a]), document([b])).text_changed).toBe(true),
);
it("handles page relocation and empty sides", () => {
  const old = document(["alpha beta gamma delta"]),
    next = document(["alpha beta", "gamma delta"]);
  expect(compare(old, next).text_changed).toBe(false);
  const added = textChanges(null, next, [], positions(next));
  expect(added.old_marks).toEqual({});
  expect(added.new_marks[1]).toBeTruthy();
  expect(
    pixelDifference(null, next.page(0).raster([0, 20, 600, 100])),
  ).toBeGreaterThan(0);
});
it("detects pixel and color changes", () => {
  const raster = {
      width: 1,
      height: 1,
      channels: 3,
      stride: 3,
      pixels: new Uint8Array([255, 0, 0]),
    },
    other = { ...raster, pixels: new Uint8Array([0, 130, 0]) };
  expect(pixelDifference(raster, raster)).toBe(0);
  expect(pixelDifference(raster, other)).toBe(1);
});
it("distinguishes comments and rewrapping from paragraph changes", () => {
  expect(typesetWords("binds $x$, checks $e$.\n")).toEqual(
    typesetWords("binds $x$,\n  checks $e$.\n"),
  );
  expect(typesetWords("a % old note\nb\n")).toEqual(
    typesetWords("a % new note\nb\n"),
  );
  expect(typesetWords("one\n\ntwo\n")).not.toEqual(typesetWords("one two\n"));
});
it("emits vector strips with selectable text and unmarked clean version", () => {
  const doc = document(["A changed word"]),
    folder = fs.mkdtempSync(path.join(os.tmpdir(), "review-strip-"));
  folders.push(folder);
  const strip = new Strips(folder).write(
    doc,
    0,
    20,
    100,
    [{ kind: "added", rect: doc.page(0).search("changed")[0] }],
    "new",
  )!;
  expect(strip.text?.map((l) => l.text).join(" ")).toBe("A changed word");
  expect(strip.height).toBe(80);
  expect(fs.readFileSync(path.join(folder, strip.src), "utf8")).toContain(
    "<svg",
  );
  expect(fs.readFileSync(path.join(folder, strip.src), "utf8")).not.toBe(
    fs.readFileSync(path.join(folder, strip.clean), "utf8"),
  );
  expect(doc.page(0).text()).toBe("A changed word");
});
it("writes strips a browser can parse when a glyph maps to a control character", () => {
  const raw = new mupdf.PDFDocument(),
    font = raw.addObject(raw.newDictionary());
  font.put("Type", raw.newName("Font"));
  font.put("Subtype", raw.newName("Type1"));
  font.put("BaseFont", raw.newName("ZapfDingbats"));
  // ✓ and ✗, whose glyph names mupdf reads as U+0013 and U+0017.
  const page = raw.addPage(
    [0, 0, 200, 100],
    0,
    { Font: { F1: font } },
    "BT /F1 12 Tf 30 50 Td (37) Tj ET",
  );
  raw.insertPage(-1, page);
  page.destroy();
  const buffer = raw.saveToBuffer(""),
    doc = new PdfDocument(buffer.asUint8Array());
  buffer.destroy();
  documents.push(doc);
  const svg = doc.page(0).svg(0, 100);
  expect(svg).toContain("<use");
  expect(svg).not.toMatch(/&#x0*(?:[0-8bcef]|1[0-9a-f]);/i);
});
it("keeps a moved float outside the edit and pairs relocated sentences", () => {
  const unchanged = Array.from(
    { length: 6 },
    (_, i) => `Figure row ${i} with unchanged rules`,
  );
  const old = document([
      "Since a type variable's meaning now depends on its bound,\nour two new guards must also be context-aware.",
      unchanged.join("\n"),
    ]),
    next = document([
      unchanged.join("\n"),
      "Since type variables now depend on their bounds, both guards must be context-aware.",
    ]);
  // Lanes of pages 0 and 1, which have one column.
  const intervals = new Map([
      [0, [[0, 600] as [number, number]]],
      [3, [[0, 600] as [number, number]]],
    ]),
    a = textRows(old, intervals),
    b = textRows(next, intervals),
    ops = opcodes(
      a.map((r) => r.text),
      b.map((r) => r.text),
    );
  const card: Card = {
    id: "c001",
    file: "main.tex",
    comparison: "text",
    pairs: [
      {
        old: positions(old)[0],
        new: positions(next)[1],
        before_marks: [],
        after_marks: [],
      },
    ],
    own: { old: [[0, 35, 90]], new: [[1, 35, 70]] },
  };
  const pairs = balancedTextPairs(card, a, b, ops, old, next)!;
  expect(pairs).toHaveLength(1);
  expect(pairs[0].old?.page).toBe(0);
  expect(pairs[0].new?.page).toBe(1);
  expect(old.page(0).text(pairs[0].old!.clip)).toContain("context-aware.");
  expect(next.page(1).text(pairs[0].new!.clip)).not.toContain("Figure");
});
it("filters moved unchanged lines", () => {
  const a = ["a", "b", "moved 1", "moved 2", "float 1", "float 2", "edited"],
    b = ["a", "b", "float 1", "float 2", "moved 1", "moved 2", "edited, new"];
  expect(withoutMoves(opcodes(a, b), a, b)).toEqual([["replace", 6, 7, 6, 7]]);
});
it("does not expand a word edit into the preceding heading", () => {
  const doc = document(["Section heading\nWe changed this word."]);
  const [top, bottom] = changedLineBounds(doc, positions(doc)[0], [
    { kind: "added", rect: doc.page(0).search("changed")[0] },
  ]);
  expect(doc.page(0).text([0, top, 600, bottom])).toBe("We changed this word.");
});
it("comment-only lines neither create paragraphs nor introduce spaces", () => {
  expect(typesetWords("a\n% annotation\nb\n")).toEqual(typesetWords("a\nb\n"));
  expect(typesetWords("foo% annotation\n  bar")).toEqual(
    typesetWords("foobar"),
  );
  expect(typesetWords("100\\% sure")).not.toEqual(typesetWords("100% sure"));
  expect(typesetWords("a\\\\% comment\nb")).toEqual(typesetWords("a\\\\b"));
});
