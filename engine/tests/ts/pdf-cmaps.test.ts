import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { run, which } from "../../src/core/process.ts";
import { cMapData } from "../../src/web/pdf-cmaps.ts";
const xelatex = which("xelatex");
const cmaps = path.resolve(import.meta.dirname, "../../node_modules/pdfjs-dist/cmaps");
// The same shape as the bundles' import.meta.glob: path -> URL, here a file path.
const CMapData = cMapData(
  Object.fromEntries(fs.readdirSync(cmaps).map((name) => [`cmaps/${name}`, path.join(cmaps, name)])),
);
afterEach(() => {
  vi.unstubAllGlobals();
});
async function text(file: string, options: Record<string, unknown>) {
  const task = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0, ...options });
  try {
    const page = await (await task.promise).getPage(1);
    return (await page.getTextContent()).items.map((item) => ("str" in item ? item.str : "")).join("");
  } finally {
    await task.destroy();
  }
}
it("serves only pdf.js's CMaps, by file name", async () => {
  vi.stubGlobal("fetch", async (file: string) => new Response(fs.readFileSync(file)));
  const factory = new CMapData();
  expect((await factory.fetch({ kind: "cMapUrl", filename: "Adobe-GB1-UCS2.bcmap" })).length).toBeGreaterThan(0);
  await expect(factory.fetch({ kind: "cMapUrl", filename: "Missing.bcmap" })).rejects.toThrow("Unknown CMap");
  await expect(factory.fetch({ kind: "standardFontDataUrl", filename: "FoxitSerif.pfb" })).rejects.toThrow(
    "standardFontDataUrl",
  );
});
// xeCJK's Fandol fonts are embedded without a ToUnicode map, so pdf.js needs
// the Adobe-GB1 CMap to draw (and read) their characters.
it.skipIf(!xelatex)("reads Chinese set in xeCJK's default font", { timeout: 120000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-cmaps-"));
  try {
    fs.writeFileSync(
      path.join(directory, "cjk.tex"),
      String.raw`\documentclass{article}
\usepackage{xeCJK}
\setCJKmainfont{FandolSong-Regular.otf}
\begin{document}
中文批注
\end{document}
`,
    );
    run(xelatex!, ["-interaction=nonstopmode", "-halt-on-error", "cjk.tex"], { cwd: directory });
    const pdf = path.join(directory, "cjk.pdf");
    expect(await text(pdf, {})).not.toContain("中文批注");
    vi.stubGlobal("fetch", async (file: string) => new Response(fs.readFileSync(file)));
    expect(await text(pdf, { BinaryDataFactory: CMapData })).toContain("中文批注");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
