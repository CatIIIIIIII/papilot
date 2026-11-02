import { it, expect } from "vitest";
import { progressReader } from "../../src/core/progress.ts";
import type { BuildProgress } from "../../src/types.ts";

// latexmk's output for a small book: bibtex, two XeLaTeX passes and the PDF
// conversion, in the shape TeX and latexmk print it.
const transcript = [
  "Latexmk: applying rule 'bibtex build/Thesis'...",
  "Run number 1 of rule 'bibtex build/Thesis'",
  "Database file #1: references.bib",
  "Latexmk: applying rule 'xelatex'...",
  "Run number 1 of rule 'xelatex'",
  "(./Thesis.tex (./chapters/intro.tex [1] [2{/usr/local/texlive/fonts/map/pdftex.map}]",
  "Overfull \\hbox (1.2pt too wide) in paragraph at lines 3--4",
  "[]\\TU/lmr/m/n/10 text",
  "[Loading MPS to PDF converter (version 2006.09.02).]",
  "[3 <./figures/plot.pdf>] [4]) [5.2] [6",
  "] )",
  "Output written on build/Thesis.xdv (6 pages, 1234 bytes).",
  "Run number 2 of rule 'bibtex build/Thesis'",
  "Run number 2 of rule 'xelatex'",
  "[1] [2] [3] [4] [5] [6] [7]",
  "Output written on build/Thesis.xdv (7 pages, 1300 bytes).",
  "Run number 1 of rule 'xdvipdfmx'",
  "",
].join("\n");

function events(chunks: string[], total: number | null) {
  const seen: BuildProgress[] = [];
  const read = progressReader((progress) => seen.push(progress), total);
  for (const chunk of chunks) read(Buffer.from(chunk));
  return seen;
}

const lines = transcript.split(/(?<=\n)/);

it("follows latexmk's steps, passes and pages", () => {
  const seen = events(lines, 6);
  expect(seen[0]).toEqual({ step: "tex", pass: 0, pages: 0, total: 6 });
  expect(seen.map((e) => e.step + e.pass).filter((s, i, a) => s !== a[i - 1])).toEqual(["tex0", "bibliography0", "tex1", "bibliography1", "tex2", "pdf2"]);
  // Pass 1 counts its six page markers, not boxes or notes in brackets.
  const first = seen.filter((e) => e.step === "tex" && e.pass === 1);
  expect(Math.max(...first.filter((e) => e.total === 6).map((e) => e.pages))).toBe(6);
  // TeX's own count then becomes the total for the next pass.
  expect(seen.find((e) => e.pass === 2 && e.step === "tex")).toMatchObject({ pages: 0, total: 6 });
  expect(seen.at(-1)).toEqual({ step: "pdf", pass: 2, pages: 7, total: 7 });
});

it("counts each page once however the output is split", () => {
  const whole = events(lines, 6).at(-1);
  for (const size of [1, 2, 3, 7, 13]) {
    const chunks = [];
    for (let at = 0; at < transcript.length; at += size) chunks.push(transcript.slice(at, at + size));
    const seen = events(chunks, 6);
    expect(seen.at(-1)).toEqual(whole);
    const first = seen.filter((e) => e.step === "tex" && e.pass === 1 && e.total === 6);
    expect(Math.max(...first.map((e) => e.pages))).toBe(6);
  }
});

it("reports a page as soon as TeX closes it, before the line ends", () => {
  const seen = events(["Run number 1 of rule 'pdflatex'\n", "(./main.tex [1] [2", "] [3"], null);
  expect(seen.at(-1)).toEqual({ step: "tex", pass: 1, pages: 2, total: null });
});
