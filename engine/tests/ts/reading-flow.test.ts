import { afterEach, expect, it } from "vitest";
import { mupdf, PdfDocument } from "../../src/render/pdf.ts";
import {
  allDifferences,
  shownBy,
  compareDocuments,
  comparison,
  words,
} from "../../src/render/effects.ts";
import { tokenGlyphs } from "../../src/render/pdfdiff.ts";
import { sharedWords } from "../../src/render/segments.ts";
import type { Build } from "../../src/render/locate.ts";

const documents: PdfDocument[] = [];
afterEach(() => documents.splice(0).forEach((document) => document.close()));
function build(pages: string[][]) {
  const raw = new mupdf.PDFDocument(),
    font = new mupdf.Font("Helvetica"),
    ref = raw.addSimpleFont(font);
  for (const lines of pages) {
    const content =
      "BT /F 12 Tf 40 500 Td 20 TL " +
      lines
        .map(
          (line, i) =>
            (i ? "T* " : "") + "(" + line.replace(/[()\\]/g, "\\$&") + ") Tj",
        )
        .join("\n") +
      " ET";
    const page = raw.addPage(
      [0, 0, 600, 600],
      0,
      { Font: { F: ref } },
      content,
    );
    raw.insertPage(-1, page);
    page.destroy();
  }
  const buffer = raw.saveToBuffer(""),
    document = new PdfDocument(buffer.asUint8Array());
  buffer.destroy();
  ref.destroy();
  font.destroy();
  raw.destroy();
  documents.push(document);
  return { document } as Build;
}
it("keeps a word unchanged when a floating block interrupts its page-break hyphenation", () => {
  const figure = [
      "Long diagram labels about distributed scheduling.",
      "Figure 1: A stable diagram caption.",
    ],
    old = build([
      [
        "Starting stable body with enough unchanged context.",
        "The system supports interoperability.",
      ],
      [...figure, "Ending stable body with enough unchanged context."],
    ]),
    next = build([
      [
        "Starting stable body with enough unchanged context.",
        "The system supports inter-",
      ],
      [
        ...figure,
        "operability.",
        "Ending stable body with enough unchanged context.",
      ],
    ]);
  expect(compareDocuments(old, next).changes).toEqual([]);
});
it.each(["Long", "long"])(
  "recovers interrupted fragments in both directions (%s)",
  (start) => {
    const figure = [
        `${start} diagram labels about distributed scheduling.`,
        "Figure 1: A stable diagram caption.",
      ],
      old = build([
        [
          "Starting stable body with enough unchanged context.",
          "The system supports interoperability.",
        ],
        [...figure, "Ending stable body with enough unchanged context."],
      ]),
      next = build([
        [
          "Starting stable body with enough unchanged context.",
          "The system supports inter-",
        ],
        [
          ...figure,
          "operability.",
          "Ending stable body with enough unchanged context.",
        ],
      ]);
    for (const pair of [
      [old, next],
      [next, old],
    ]) {
      const result = compareDocuments(pair[0], pair[1]);
      expect(result.changes).toEqual([]);
      for (const side of [result.old, result.new]) {
        const coverage = side.tokens.flatMap((token) => tokenGlyphs(token));
        expect(new Set(coverage).size).toBe(side.glyphs.length);
        expect(coverage.length).toBe(side.glyphs.length);
      }
    }
  },
);
it("retains a real edit to a continuation after a floating block", () => {
  const figure = [
      "Long diagram labels about distributed scheduling.",
      "Figure 1: A stable diagram caption.",
    ],
    old = build([
      [
        "Starting stable body with enough unchanged context.",
        "The system supports interoperability.",
      ],
      [...figure, "Ending stable body with enough unchanged context."],
    ]),
    next = build([
      [
        "Starting stable body with enough unchanged context.",
        "The system supports inter-",
      ],
      [
        ...figure,
        "operationality.",
        "Ending stable body with enough unchanged context.",
      ],
    ]),
    result = compareDocuments(old, next);
  expect(
    result.changes.flatMap((e) =>
      result.old.tokens.slice(...e.old).map((t) => t.text),
    ),
  ).toContain("operability");
  expect(
    result.changes.flatMap((e) =>
      result.new.tokens.slice(...e.new).map((t) => t.text),
    ),
  ).toContain("operationality");
});
it("does not erase an unmatched literal line-end hyphen because another word shares its prefix", () => {
  const old = build([
      [
        "Starting stable body with enough unchanged context.",
        "Literal inter-",
        "UPPER case heading.",
        "An unrelated interoperability example.",
      ],
    ]),
    next = build([
      [
        "Starting stable body with enough unchanged context.",
        "Literal inter",
        "UPPER case heading.",
        "An unrelated interoperability example.",
      ],
    ]),
    result = compareDocuments(old, next);
  expect(
    result.changes.flatMap((e) =>
      result.old.tokens.slice(...e.old).map((t) => t.text),
    ),
  ).toEqual(["-"]);
});
it("extracts a glyph once when independently positioned text lines overlap", () => {
  const raw = new mupdf.PDFDocument(),
    font = new mupdf.Font("Helvetica"),
    ref = raw.addSimpleFont(font),
    page = raw.addPage(
      [0, 0, 600, 600],
      0,
      { Font: { F: ref } },
      "BT /F 12 Tf 40 520 Td (The preceding line reaches the small script) Tj ET " +
        "BT /F 12 Tf 40 500 Td (The base x) Tj ET " +
        "BT /F 8 Tf 105 520 Td (2) Tj ET",
    );
  raw.insertPage(-1, page);
  const buffer = raw.saveToBuffer(""),
    document = new PdfDocument(buffer.asUint8Array());
  documents.push(document);
  buffer.destroy();
  page.destroy();
  ref.destroy();
  font.destroy();
  raw.destroy();
  expect(
    words({ document } as Build).glyphs.filter((g) => g.text === "2"),
  ).toHaveLength(1);
});
it("keeps low-level effect indices in the exact Words objects supplied by the caller", () => {
  const a = words(
      build([
        [
          "The preceding stable context stays in place.",
          "The word inter-",
          "operability stays.",
        ],
      ]),
    ),
    b = words(
      build([
        [
          "The preceding stable context stays in place.",
          "The word connectivity stays.",
        ],
      ]),
    ),
    result = comparison(a, b);
  expect(result.old).toBe(a);
  expect(result.new).toBe(b);
  expect(
    result.changes.flatMap((e) => a.tokens.slice(...e.old).map((t) => t.text)),
  ).toContain("operability");
});
it("rebuilds one common segmentation when combining views from different comparisons", () => {
  const a = words(build([["Prefix inter-", "operability."]])),
    b = words(build([["Prefix interoperability."]])),
    c = words(build([["Prefix interoperability."]])),
    d = words(build([["Prefix interoper-", "ability."]])),
    [left] = sharedWords(a, b),
    [right] = sharedWords(c, d),
    [one, two] = sharedWords(left, right);
  expect(one.segmentation).toBe(two.segmentation);
  expect(comparison(one, two).changes).toEqual([]);
});
it("uses one segmentation for several observed break positions and their continuations", () => {
  const figure = [
      "Long diagram labels about distributed scheduling.",
      "Figure 1: A stable diagram caption.",
    ],
    old = build([
      [
        "Starting stable body with enough unchanged context.",
        "The system supports interoperability.",
      ],
      [
        ...figure,
        "Another interoperability and operability example.",
        "Ending stable body with enough unchanged context.",
      ],
    ]),
    next = build([
      [
        "Starting stable body with enough unchanged context.",
        "The system supports inter-",
      ],
      [
        ...figure,
        "operability.",
        "Another interoper-",
        "ability and oper-",
        "ability example.",
        "Ending stable body with enough unchanged context.",
      ],
    ]);
  for (const pair of [
    [old, next],
    [next, old],
  ])
    expect(compareDocuments(pair[0], pair[1]).changes).toEqual([]);
});
it("keeps attribution in the final comparison's domain after joint segmentation", () => {
  const figure = [
      "Long diagram labels about distributed scheduling.",
      "Figure 1: A stable diagram caption.",
    ],
    old = build([
      [
        "Starting stable body with enough unchanged context.",
        "The system supports connectivity.",
      ],
      [...figure, "Ending stable body with enough unchanged context."],
    ]),
    final = build([
      [
        "Starting stable body with enough unchanged context.",
        "The system supports inter-",
      ],
      [
        ...figure,
        "operability.",
        "Ending stable body with enough unchanged context.",
      ],
    ]),
    wrong = build([
      [
        "Starting stable body with enough unchanged context.",
        "The system supports inter-",
      ],
      [
        ...figure,
        "operationality.",
        "Ending stable body with enough unchanged context.",
      ],
    ]),
    comparison = compareDocuments(old, final),
    effects = allDifferences(comparison.old, comparison.new);
  expect(effects.length).toBeGreaterThan(0);
  expect(shownBy(old, final, effects, final).every(Boolean)).toBe(true);
  expect(shownBy(old, wrong, effects, final).every(Boolean)).toBe(false);
});
it("does not turn ordinary whitespace edits into movement of broken-word pieces", () => {
  const common = [
      "Observe inter-",
      "operability elsewhere.",
      "Starting stable body with enough unchanged context.",
    ],
    old = build([[...common, "One interoperability sample follows here."]]),
    next = build([[...common, "One inter sample operability follows here."]]),
    result = compareDocuments(old, next);
  expect(result.changes.length).toBeGreaterThan(0);
});
it("retains reordered letters within a word that happens to cross a line break", () => {
  const common = [
      "Observe prefix-",
      "value elsewhere.",
      "Starting stable body with enough unchanged context.",
    ],
    old = build([[...common, "One prefixab-", "cd sample follows here."]]),
    next = build([[...common, "One prefixcd-", "ab sample follows here."]]),
    result = compareDocuments(old, next);
  expect(result.changes.length).toBeGreaterThan(0);
});
it("does not treat long syllable permutations inside a word as whole-word moves", () => {
  const common = [
      "Observe alpha-",
      "value elsewhere.",
      "Starting stable body with enough unchanged context.",
    ],
    old = build([
      [
        ...common,
        "One alphaextraordinarylongfragment-",
        "otherextraordinarylongfragment sample follows here.",
      ],
    ]),
    next = build([
      [
        ...common,
        "One alphaotherextraordinarylongfragment-",
        "extraordinarylongfragment sample follows here.",
      ],
    ]),
    result = compareDocuments(old, next);
  expect(result.changes.length).toBeGreaterThan(0);
});
it("preserves a spaced minus at the end of a physical line", () => {
  const old = build([
      ["Starting stable context remains here.", "value -", "amount"],
    ]),
    next = build([["Starting stable context remains here.", "valueamount"]]),
    result = compareDocuments(old, next);
  expect(
    result.changes.flatMap((e) =>
      result.old.tokens.slice(...e.old).map((t) => t.text),
    ),
  ).toContain("-");
});
it.each([false, true])(
  "retains an inserted or deleted word space despite an unrelated observed hyphen (%s)",
  (reverse) => {
    const common = [
        "Observe inter-",
        "operability elsewhere.",
        "Starting stable body with enough unchanged context.",
      ],
      joined = build([
        [...common, "One interoperability sample follows here."],
      ]),
      separated = build([
        [...common, "One inter operability sample follows here."],
      ]),
      result = reverse
        ? compareDocuments(separated, joined)
        : compareDocuments(joined, separated);
    expect(result.changes.length).toBeGreaterThan(0);
    expect(
      result.changes.flatMap((e) =>
        result.old.tokens.slice(...e.old).map((t) => t.text),
      ),
    ).toContain("operability");
    expect(
      result.changes.flatMap((e) =>
        result.new.tokens.slice(...e.new).map((t) => t.text),
      ),
    ).toContain("operability");
  },
);
it.each([false, true])(
  "distinguishes a real word space from physical line-end hyphenation (%s)",
  (reverse) => {
    const common = ["Starting stable body with enough unchanged context."],
      joined = build([
        [...common, "One inter-", "operability sample follows here."],
      ]),
      separated = build([
        [...common, "One inter operability sample follows here."],
      ]),
      result = reverse
        ? compareDocuments(separated, joined)
        : compareDocuments(joined, separated);
    expect(result.changes.length).toBeGreaterThan(0);
  },
);
it("compares different physical word breaks without requiring an unbroken occurrence", () => {
  const old = build([
      [
        "Starting stable context remains here.",
        "One inter-",
        "operability sample follows here.",
      ],
    ]),
    next = build([
      [
        "Starting stable context remains here.",
        "One interoper-",
        "ability sample follows here.",
      ],
    ]);
  expect(compareDocuments(old, next).changes).toEqual([]);
});
it.each([false, true])(
  "keeps repeated sentences aligned when their physical hyphens change (%s)",
  (reverse) => {
    const left = [
        "A replicated state machine records commands in a",
        "durable log. Each replica applies committed commands",
        "in order. The invariant remains valid while leadership changes.",
      ],
      right = [
        "A replicated state machine records com-",
        "mands in a durable log. Each replica applies commit-",
        "ted commands in order. The invariant remains valid while lead-",
        "ership changes.",
      ],
      old = build([
        [
          "Opening stable anchor.",
          "The protocol uses an old invari-",
          "ant.",
          ...left,
          ...left,
          ...left,
          "Closing stable anchor.",
        ],
      ]),
      next = build([
        [
          "Opening stable anchor.",
          "The protocol uses a stronger invariant.",
          ...right,
          ...right,
          ...right,
          "Closing stable anchor.",
        ],
      ]),
      result = reverse
        ? compareDocuments(next, old)
        : compareDocuments(old, next),
      changed = (side: "old" | "new") =>
        result.changes.flatMap((effect) =>
          result[side].tokens.slice(...effect[side]).map((token) => token.text),
        );
    expect(changed("old")).toEqual(reverse ? ["a", "stronger"] : ["an", "old"]);
    expect(changed("new")).toEqual(reverse ? ["an", "old"] : ["a", "stronger"]);
    expect(result.paired).toEqual(result.tokens);
  },
);
