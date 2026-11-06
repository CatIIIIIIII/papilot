import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Strips } from "../../src/render/inline.ts";
import { changesOf, shownBy, renderPlace } from "../../src/render/effects.ts";
import type { Build } from "../../src/render/locate.ts";
import { afterEach, expect, it } from "vitest";
import { mupdf, PdfDocument } from "../../src/render/pdf.ts";
import { paintChanges } from "../../src/render/paint.ts";
const documents: PdfDocument[] = [];
function pdf(
  content: string,
  resources:
    | Record<string, unknown>
    | ((doc: mupdf.PDFDocument) => Record<string, unknown>) = {},
) {
  const doc = new mupdf.PDFDocument(),
    font = new mupdf.Font("Helvetica"),
    ref = doc.addSimpleFont(font),
    page = doc.addPage(
      [0, 0, 300, 300],
      0,
      {
        Font: { F: ref },
        ...(typeof resources === "function" ? resources(doc) : resources),
      },
      content,
    );
  doc.insertPage(-1, page);
  page.destroy();
  const buffer = doc.saveToBuffer("");
  const value = new PdfDocument(buffer.asUint8Array());
  buffer.destroy();
  ref.destroy();
  font.destroy();
  doc.destroy();
  documents.push(value);
  return value;
}
const text = (line: string, x = 20, y = 220) =>
  `BT /F 12 Tf ${x} ${y} Td (${line}) Tj ET\n`;
const red = "1 0 0 rg 40 120 100 10 re f\n",
  blue = "0 0 1 rg 40 120 100 10 re f\n";
afterEach(() => documents.splice(0).forEach((d) => d.close()));
it("detects a changed fill and exposes physical positions", () => {
  const result = paintChanges(
    pdf(text("Stable") + red),
    pdf(text("Stable") + blue),
  );
  expect(result).toHaveLength(1);
  expect(result[0].kind).toBe("paint");
  expect(result[0].before[0].clip).toEqual([39, 169, 141, 181]);
  expect(result[0].after).toHaveLength(1);
});
it.each([
  [
    "line width",
    "0 G 2 w 40 120 m 140 120 l S",
    "0 G 5 w 40 120 m 140 120 l S",
  ],
  ["shape", red, "1 0 0 rg 40 120 m 140 120 l 40 130 l h f"],
  ["pale paint", "0.95 g 40 120 100 10 re f", "0.99 g 40 120 100 10 re f"],
  [
    "drawing order",
    red + "0 0 1 rg 80 115 20 20 re f",
    "0 0 1 rg 80 115 20 20 re f\n" + red,
  ],
])("detects %s changes", (_name, before, after) =>
  expect(paintChanges(pdf(before), pdf(after))).not.toHaveLength(0),
);
it.each([
  [
    "plain text reflow",
    text("Alpha Beta", 20, 220) + red,
    text("Alpha", 20, 220) + text("Beta", 20, 200) + red,
  ],
  ["whole drawing translation", red, "q 1 0 0 1 15.25 27.5 cm\n" + red + "Q"],
  [
    "white full-page background",
    "1 g 0 0 300 300 re f\n" + red,
    "1 g 0 0 300 300 re f\nq 1 0 0 1 15.25 27.5 cm\n" + red + "Q",
  ],
  [
    "colored full-page background",
    "0.5 g 0 0 300 300 re f\n" + red,
    "0.5 g 0 0 300 300 re f\nq 1 0 0 1 15.25 27.5 cm\n" + red + "Q",
  ],
  [
    "clipped-away paint",
    "q 0 0 10 10 re W n\n" + red + "Q",
    "q 0 0 10 10 re W n\n" + blue + "Q",
  ],
  ["hidden paint", red + "1 g 0 0 300 300 re f", blue + "1 g 0 0 300 300 re f"],
  [
    "equivalent path",
    red,
    "1 0 0 rg 40 120 m 140 120 l 140 130 l 40 130 l h f",
  ],
  [
    "disjoint painting order",
    red + "0 0 1 rg 180 115 20 20 re f",
    "0 0 1 rg 180 115 20 20 re f\n" + red,
  ],
  [
    "white background addition",
    text("Stable") + red,
    "1 g 0 0 300 300 re f\n" + text("Stable") + red,
  ],
])("ignores %s", (_name, before, after) =>
  expect(paintChanges(pdf(before), pdf(after))).toEqual([]),
);

it.each([
  ["addition", "", red],
  ["deletion", red, ""],
  [
    "white eraser",
    text("ERASE ME", 40, 120),
    text("ERASE ME", 40, 120) + "1 g 30 110 120 30 re f",
  ],
])("detects visible %s", (_name, a, b) =>
  expect(paintChanges(pdf(a), pdf(b))).not.toHaveLength(0),
);
it("detects changed pixels in an image and ignores unchanged image translations", () => {
  const image = (blue: boolean, shift = 0) =>
    pdf(`q 50 0 0 40 ${40 + shift} 100 cm /Im Do Q`, (doc) => {
      const pixmap = new mupdf.Pixmap(
        mupdf.ColorSpace.DeviceRGB,
        [0, 0, 2, 2],
        false,
      );
      pixmap.clear(255);
      pixmap.getPixels().set(blue ? [0, 0, 255] : [255, 0, 0]);
      const image = new mupdf.Image(pixmap),
        ref = doc.addImage(image);
      image.destroy();
      pixmap.destroy();
      return { XObject: { Im: ref } };
    });
  expect(paintChanges(image(false), image(true))).toHaveLength(1);
  expect(paintChanges(image(false), image(false, 20.25))).toEqual([]);
});
it("respects transparent groups and zero alpha without discarding their operations", () => {
  const group = (content: string, alpha: number) =>
    pdf("/G gs /Form Do", (doc) => {
      const form = doc.addStream(content, {
        Type: "XObject",
        Subtype: "Form",
        BBox: [0, 0, 300, 300],
        Resources: {},
        Group: { S: "Transparency", CS: "DeviceRGB", I: true },
      });
      return {
        XObject: { Form: form },
        ExtGState: { G: { ca: alpha, CA: alpha } },
      };
    });
  expect(paintChanges(group(red, 0.5), group(blue, 0.5))).toHaveLength(1);
  expect(paintChanges(group(red, 0), group(blue, 0))).toEqual([]);
});
it("finds a changed clip but ignores paint outside an unchanged clip", () => {
  const shape = "1 0 0 rg 40 110 100 30 re f";
  expect(
    paintChanges(
      pdf("q 40 110 30 30 re W n " + shape + " Q"),
      pdf("q 40 110 50 30 re W n " + shape + " Q"),
    ),
  ).toHaveLength(1);
  expect(
    paintChanges(
      pdf("q 40 110 30 30 re W n " + shape + " Q"),
      pdf("q 40 110 30 30 re W n 1 0 0 rg 40 110 160 30 re f Q"),
    ),
  ).toEqual([]);
});

it("compares final soft-mask coverage and suppresses fully masked paint changes", () => {
  const masked = (content: string, coverage: number) =>
    pdf("/G gs " + content, (doc) => {
      const mask = doc.addStream(`${coverage} g 0 0 300 300 re f`, {
        Type: "XObject",
        Subtype: "Form",
        BBox: [0, 0, 300, 300],
        Resources: {},
        Group: { S: "Transparency", CS: "DeviceRGB", I: true },
      });
      return { ExtGState: { G: { SMask: { S: "Luminosity", G: mask } } } };
    });
  expect(paintChanges(masked(red, 1), masked(blue, 1))).toHaveLength(1);
  expect(paintChanges(masked(red, 0), masked(blue, 0))).toEqual([]);
  expect(paintChanges(masked(red, 0.25), masked(red, 0.75))).toHaveLength(1);
});
it("handles unbounded axial shading within finite page bounds", () => {
  const shaded = (end: number[]) =>
    pdf("/Sh sh", (doc) => ({
      Shading: {
        Sh: {
          ShadingType: 2,
          ColorSpace: "DeviceRGB",
          Coords: [0, 0, 300, 300],
          Extend: [true, true],
          Function: {
            FunctionType: 2,
            Domain: [0, 1],
            C0: [1, 0, 0],
            C1: end,
            N: 1,
          },
        },
      },
    }));
  expect(paintChanges(shaded([0, 0, 1]), shaded([0, 1, 0]))).toHaveLength(1);
});

it.each([
  [40, 90],
  [90, 95],
])("detects relative overlap changes from %i to %i", (before, after) => {
  const scene = (x: number, shift = 0) =>
    `q 1 0 0 1 ${shift} ${shift} cm 1 0 0 rg ${x} 100 20 20 re f 0 0 1 rg 100 100 20 20 re f Q`;
  expect(paintChanges(pdf(scene(before)), pdf(scene(after)))).not.toHaveLength(
    0,
  );
  expect(paintChanges(pdf(scene(before)), pdf(scene(before, 25)))).toEqual([]);
});

it("retains a translucent shape changing appearance over a non-uniform backdrop", () => {
  const scene = (x: number) =>
    pdf(`/Sh sh /G gs 1 0 0 rg ${x} 100 20 20 re f`, () => ({
      ExtGState: { G: { ca: 0.5, CA: 0.5 } },
      Shading: {
        Sh: {
          ShadingType: 2,
          ColorSpace: "DeviceRGB",
          Coords: [0, 0, 300, 0],
          Extend: [true, true],
          Function: {
            FunctionType: 2,
            Domain: [0, 1],
            C0: [0, 0, 1],
            C1: [0, 1, 0],
            N: 1,
          },
        },
      },
    }));
  expect(paintChanges(scene(40), scene(120))).not.toHaveLength(0);
});
it("ignores splitting an equivalent compound path while text reflows", () => {
  const a = "1 0 0 rg 40 100 20 20 re 100 100 20 20 re f",
    b = "1 0 0 rg 40 100 20 20 re f 100 100 20 20 re f";
  expect(
    paintChanges(
      pdf(text("Alpha Beta") + a),
      pdf(text("Alpha") + text("Beta", 20, 200) + b),
    ),
  ).toEqual([]);
});

it("ignores equivalent compound-path splitting together with a large translation", () => {
  const a = "1 0 0 rg 40 100 20 20 re 100 100 20 20 re f",
    b = "q 1 0 0 1 150 80 cm 1 0 0 rg 40 100 20 20 re f 100 100 20 20 re f Q";
  expect(paintChanges(pdf(a), pdf(b))).toEqual([]);
});

it.each([20, 290])(
  "renders graphics of width %i with their entire physical footprint",
  (width) => {
    const columns = Array.from({ length: 5 }, (_, i) =>
        (
          text("one two three four five", 40, 250 - i * 18) +
          text("one two three four five", 170, 250 - i * 18)
        ).replaceAll("/F 12", "/F 9"),
      ).join(""),
      old = pdf(columns + `1 0 0 rg 5 100 ${width} 10 re f`),
      next = pdf(columns + `0 0 1 rg 5 100 ${width} 10 re f`),
      effect = paintChanges(old, next)[0],
      folder = fs.mkdtempSync(path.join(os.tmpdir(), "paint-strip-"));
    try {
      expect(next.page(0).twoColumns).toBe(true);
      const view = renderPlace(
        {
          page: "1",
          section: null,
          pairs: [
            {
              old: effect.before[0],
              new: effect.after[0],
              before_marks: [],
              after_marks: [],
            },
          ],
        },
        new Strips(folder),
        { document: old } as Build,
        { document: next } as Build,
      );
      expect(view.after).toHaveLength(1);
      const image = view.after[0];
      expect(image.left ?? 0).toBeLessThanOrEqual(5);
      expect((image.left ?? 0) + image.width).toBeGreaterThanOrEqual(5 + width);
      const svg = fs.readFileSync(path.join(folder, image.src), "utf8");
      expect(svg).toContain(
        'viewBox="0 0 ' + image.width + " " + image.height + '"',
      );
      const pixels = next
        .page(0)
        .raster(
          [
            image.left ?? 0,
            image.top ?? 0,
            (image.left ?? 0) + image.width,
            (image.top ?? 0) + image.height,
          ],
          2,
          false,
          true,
        );
      let blue = 0;
      for (let i = 0; i < pixels.pixels.length; i += pixels.channels)
        if (
          pixels.pixels[i] < 20 &&
          pixels.pixels[i + 1] < 20 &&
          pixels.pixels[i + 2] > 230
        )
          blue++;
      expect(blue).toBe(width * 10 * 4);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  },
);

it("retains relative positions of nonintersecting parts of a common drawing", () => {
  const axis = "0 G 1 w 40 180 m 40 40 l 200 40 l S\n",
    dot = (x: number, y: number, color = "1 0 0") =>
      `${color} rg ${x} ${y} 8 8 re f\n`,
    old = pdf(axis + dot(70, 80) + dot(150, 140)),
    next = pdf(axis + dot(100, 110) + dot(150, 140));
  expect(paintChanges(old, next)).not.toHaveLength(0);
  expect(
    paintChanges(
      old,
      pdf("q 1 0 0 1 15 20 cm " + axis + dot(70, 80) + dot(150, 140) + " Q"),
    ),
  ).toEqual([]);
  const recolor = paintChanges(
    old,
    pdf(axis + dot(70, 80, "0 0 1") + dot(150, 140)),
  );
  expect(recolor).toHaveLength(1);
  expect(recolor[0].before[0].clip).toEqual([69, 211, 79, 221]);
});
it.each(["eraser", "highlight"])(
  "retains a translated %s changing the visibility of fixed text",
  (kind) => {
    const scene = (x: number) => {
      const shape = `${kind === "eraser" ? "1 1 1" : "1 1 0"} rg ${x} 115 35 20 re f\n`;
      return pdf(
        kind === "eraser"
          ? text("LEFT RIGHT", 40, 120) + shape
          : shape + text("LEFT RIGHT", 40, 120),
      );
    };
    expect(paintChanges(scene(40), scene(70))).not.toHaveLength(0);
  },
);
it("pairs repeated objects in a translated common frame", () => {
  const scene = "1 0 0 rg 40 100 20 20 re f 100 100 20 20 re f";
  expect(
    paintChanges(pdf(scene), pdf("q 1 0 0 1 60 0 cm " + scene + " Q")),
  ).toEqual([]);
});
it("does not report an unchanged split path beside a real paint change", () => {
  const a = "1 0 0 rg 40 100 20 20 re 100 100 20 20 re f",
    b = "1 0 0 rg 40 100 20 20 re f 100 100 20 20 re f",
    result = paintChanges(
      pdf(a + " 0 1 0 rg 200 100 20 20 re f"),
      pdf(b + " 0 0 1 rg 200 100 20 20 re f"),
    );
  expect(result).toHaveLength(1);
  expect(result[0].before[0].clip).toEqual([199, 179, 221, 201]);
  expect(result[0].after[0].clip).toEqual([199, 179, 221, 201]);
});

it.each(["eraser", "highlight"])(
  "finds fixed %s compositing changes when only text moves",
  (kind) => {
    const shape = `${kind === "eraser" ? "1 1 1" : "1 1 0"} rg 40 115 35 20 re f\n`,
      scene = (x: number) =>
        pdf(
          kind === "eraser"
            ? text("LEFT RIGHT", x, 120) + shape
            : shape + text("LEFT RIGHT", x, 120),
        );
    const result = changesOf(
      { document: scene(40) } as Build,
      { document: scene(70) } as Build,
      [],
    );
    expect(result.some((item) => item.effect.kind === "paint")).toBe(true);
  },
);
it("ignores moving text and its background together", () => {
  const content =
      "1 1 0 rg 40 115 120 20 re f\n0 g " + text("LEFT RIGHT", 40, 120),
    old = pdf(content),
    next = pdf("q 1 0 0 1 25 25 cm " + content + " Q");
  expect(
    changesOf({ document: old } as Build, { document: next } as Build, []),
  ).toEqual([]);
});
it("ignores ordinary text reflow over a uniform page background", () => {
  const old = pdf("0.9 g 0 0 300 300 re f 0 g " + text("Alpha Beta")),
    next = pdf(
      "0.9 g 0 0 300 300 re f 0 g " + text("Alpha") + text("Beta", 20, 200),
    );
  expect(
    changesOf({ document: old } as Build, { document: next } as Build, []),
  ).toEqual([]);
});

it("lets independently clipped PDF coordinate frames reflow separately", () => {
  const forms = (dy: number) =>
    pdf(`q 1 0 0 1 0 ${dy} cm /A Do Q /B Do`, (doc) => ({
      XObject: {
        A: doc.addStream("1 0 0 rg 40 100 40 20 re f", {
          Type: "XObject",
          Subtype: "Form",
          BBox: [35, 95, 85, 125],
          Resources: {},
        }),
        B: doc.addStream("0 0 1 rg 180 100 40 20 re f", {
          Type: "XObject",
          Subtype: "Form",
          BBox: [175, 95, 225, 125],
          Resources: {},
        }),
      },
    }));
  expect(paintChanges(forms(0), forms(20))).toEqual([]);
});
it("requires a cause combination to reproduce both final appearance and placement", () => {
  const chart = (x: number, color: string) =>
      ({
        document: pdf(
          `0 G 1 w 40 180 m 40 40 l 200 40 l S ${color} rg ${x} 80 8 8 re f 0 1 0 rg 150 140 8 8 re f`,
        ),
      }) as Build,
    old = chart(70, "1 0 0"),
    final = chart(100, "0 0 1"),
    effects = changesOf(old, final, []).map((item) => item.effect);
  expect(shownBy(old, chart(70, "0 0 1"), effects, final)).toEqual([false]);
  expect(shownBy(old, chart(100, "1 0 0"), effects, final)).toEqual([false]);
  expect(shownBy(old, chart(100, "0 0 1"), effects, final)).toEqual([true]);
});
