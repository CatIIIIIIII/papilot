import { afterEach, expect, it, vi } from "vitest";
import { mupdf, PdfDocument } from "../../src/render/pdf.ts";
import {
  allDifferences,
  differences,
  shownBy,
  words,
} from "../../src/render/effects.ts";
import type { Build } from "../../src/render/locate.ts";

const documents: PdfDocument[] = [];
afterEach(() => documents.splice(0).forEach((document) => document.close()));

function build(
  pages: string[][],
  color = "0 0 0",
  fontName = "Helvetica",
  paint = 0,
) {
  const raw = new mupdf.PDFDocument(),
    font = new mupdf.Font(fontName),
    ref = raw.addSimpleFont(font);
  for (const lines of pages) {
    const content =
        `BT /F 12 Tf ${paint} Tr ${color} rg 40 500 Td 20 TL ` +
        lines
          .map(
            (line, i) =>
              (i ? "T* " : "") + "(" + line.replace(/[()\\]/g, "\\$&") + ") Tj",
          )
          .join("\n") +
        " ET",
      page = raw.addPage([0, 0, 600, 600], 0, { Font: { F: ref } }, content);
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
const changedText = (a: Build, b: Build) => {
  const left = words(a),
    right = words(b);
  return differences(left, right).map((e) => ({
    old: left.tokens
      .slice(...e.old)
      .map((t) => t.text)
      .join(" "),
    new: right.tokens
      .slice(...e.new)
      .map((t) => t.text)
      .join(" "),
  }));
};
it.each([false, true])(
  "retains repeated edge body text, including page-label-like numbers (%s)",
  (numbered) => {
    const pages = (word: string) =>
      [1, 2].map((n) => [
        `Statement ${numbered ? n + " " : ""}${word}.`,
        "Distinct body context.",
      ]);
    expect(changedText(build(pages("holds")), build(pages("fails")))).toEqual([
      { old: "holds", new: "fails" },
      { old: "holds", new: "fails" },
    ]);
  },
);
it("retains the unchanged page when repeated body text stops recurring", () => {
  expect(
    changedText(
      build([["The statement holds."], ["The statement holds."]]),
      build([["The statement fails."], ["The statement holds."]]),
    ),
  ).toEqual([{ old: "holds", new: "fails" }]);
});
it("keeps exact marks when an edge-like body line changes classification", () => {
  expect(
    changedText(
      build([
        ["Statement 1 holds.", "Alpha body."],
        ["Statement 2 holds.", "Beta body."],
      ]),
      build([
        ["Statement 1 fails.", "Alpha body."],
        ["Statement 2 holds.", "Beta body."],
      ]),
    ),
  ).toEqual([{ old: "holds", new: "fails" }]);
});
it("compares running-header edits instead of deleting their text", () => {
  expect(
    changedText(
      build([
        ["1 OLD", "First body."],
        ["2 OLD", "Second body."],
      ]),
      build([
        ["1 NEW", "First body."],
        ["2 NEW", "Second body."],
      ]),
    ),
  ).toEqual([
    { old: "OLD", new: "NEW" },
    { old: "OLD", new: "NEW" },
  ]);
});
it("requires the exact final effect when assigning an indirect change", () => {
  const old = build([["The statement is stable."]]),
    variant = build([["The statement is broken."]]),
    final = build([["The statement is final."]]),
    effects = allDifferences(words(old), words(final));
  expect(shownBy(old, variant, effects, final)).toEqual([false]);
  expect(shownBy(old, final, effects, final)).toEqual([true]);
});
it("reports color and font changes independently of unchanged words and wrapping", () => {
  const old = build([["The statement remains readable."]]);
  expect(
    allDifferences(
      words(old),
      words(build([["The statement", "remains readable."]])),
    ),
  ).toEqual([]);
  for (const next of [
    build([["The statement", "remains readable."]], "1 0 0"),
    build([["The statement", "remains readable."]], "0 0 0", "Helvetica-Bold"),
  ]) {
    const effects = allDifferences(words(old), words(next));
    expect(effects.length).toBeGreaterThan(0);
    expect(effects.every((e) => e.kind === "visual")).toBe(true);
  }
});
it("checks actual glyphs when distinct fonts report the same name", () => {
  const old = build([["The statement remains readable."]]),
    next = build(
      [["The statement remains readable."]],
      "0 0 0",
      "Helvetica-Bold",
    ),
    name = vi
      .spyOn(mupdf.Font.prototype, "getName")
      .mockReturnValue("SharedFont");
  try {
    expect(
      allDifferences(words(old), words(next)).some((e) => e.kind === "visual"),
    ).toBe(true);
  } finally {
    name.mockRestore();
  }
});
it("does not report a font change when the visible ink is unchanged", () => {
  expect(
    allDifferences(
      words(build([["Invisible words."]], "1 1 1")),
      words(build([["Invisible words."]], "1 1 1", "Helvetica-Bold")),
    ),
  ).toEqual([]);
});
it("retains small visible color changes without a contrast cutoff", () => {
  expect(
    allDifferences(
      words(build([["A small color change."]])),
      words(build([["A small color change."]], "0.01 0.01 0.01")),
    ).some((e) => e.kind === "visual"),
  ).toBe(true);
});
it("retains text paint changes even when the words and font are identical", () => {
  const old = build([["The visible statement remains here."]]),
    next = build(
      [["The visible statement remains here."]],
      "0 0 0",
      "Helvetica",
      1,
    );
  expect(
    allDifferences(words(old), words(next)).some((e) => e.kind === "visual"),
  ).toBe(true);
});
