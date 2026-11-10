import fs from "node:fs";
import path from "node:path";
import { it, expect } from "vitest";
import { Builder } from "../../src/core/build.ts";
import { loadProject } from "../../src/core/config.ts";
import { which } from "../../src/core/process.ts";
import { mupdf } from "../../src/render/pdf.ts";
import { Fixture } from "./helpers.ts";
import type { BuildInfo } from "../../src/types.ts";
const tex = Boolean(which("latexmk") && which("pdflatex"));
const text = (pdf: string) => {
  const document = mupdf.Document.openDocument(fs.readFileSync(pdf), "application/pdf");
  try {
    return Array.from({ length: document.countPages() }, (_, index) => {
      const page = document.loadPage(index), structured = page.toStructuredText("");
      try { return structured.asText(); } finally { structured.destroy(); page.destroy(); }
    }).join(" ").replace(/\s+/g, " ");
  } finally { document.destroy(); }
};
const runs = (build: BuildInfo) => {
  const log = fs.readFileSync(path.join(path.dirname(build.root), "latexmk.log"), "utf8");
  return { latex: (log.match(/^Running 'pdflatex/gm) ?? []).length, bibtex: (log.match(/^Running 'bibtex/gm) ?? []).length };
};
const output = (build: BuildInfo, file: string) => fs.readFileSync(path.join(path.dirname(build.pdf), file), "utf8");
// A package that keeps its own state in the output folder, as minted keeps
// its cache: starting from nothing, it settles in two runs.
const MAIN = String.raw`\documentclass{book}
\makeatletter
\InputIfFileExists{\jobname.stl}{}{\def\settled{none}}
\def\settleA{A}\def\settleB{B}
\ifx\settled\settleA\def\settlenext{B}\else\ifx\settled\settleB\def\settlenext{B}\else\def\settlenext{A}\fi\fi
\newwrite\settleout
\AtBeginDocument{\immediate\openout\settleout=\jobname.stl}
\AtEndDocument{\immediate\write\settleout{\string\def\string\settled{\settlenext}}\immediate\closeout\settleout}
\makeatother
\begin{document}
\frontmatter
State: \settled.
\tableofcontents
\mainmatter
\include{chapters/a}
\include{chapters/b}
\include{chapters/c}
\backmatter
\bibliographystyle{plain}
\bibliography{refs}
\end{document}
`;
const chapter = (name: string, other: string, cite: string, opening: string) => String.raw`\chapter{${name.toUpperCase()}}
\section{Start of ${name}}\label{sec:${name}}
${opening} See Section~\ref{sec:${other}} on page~\pageref{sec:${other}} and \cite{${cite}}.
${Array.from({ length: 40 }, (_, i) => `Body ${name} sentence ${i}.`).join(" ")}
`;
it.skipIf(!tex)(
  "the first chapter build of a round continues from its seed and typesets the same pages in fewer passes",
  async () => {
    const f = new Fixture();
    try {
      f.write("paper/main.tex", MAIN);
      f.write("paper/refs.bib", ["knuth", "lamport", "goossens"].map((key, i) => `@book{${key},author={Author ${key}},title={Title ${i}},year={${1980 + i}},publisher={P}}`).join("\n"));
      f.write("paper/chapters/a.tex", chapter("a", "b", "knuth", "First chapter."));
      f.write("paper/chapters/b.tex", chapter("b", "c", "lamport", "Middle chapter."));
      f.write("paper/chapters/c.tex", chapter("c", "a", "goossens", "Last chapter."));
      f.repo.run(["rm", "-q", "paper/sections/method.tex"]);
      f.repo.run(["add", "-A"]);
      f.repo.run(["commit", "-qm", "Book"]);
      const before = f.repo.rev("HEAD");
      f.write("paper/chapters/b.tex", chapter("b", "c", "lamport", "Middle chapter, revised with a longer opening."));
      f.repo.run(["commit", "-qam", "Revise"]);
      const after = f.repo.rev("HEAD"), builder = new Builder(loadProject(f.root), f.repo),
        targets = await builder.planAsync(before, after, ["paper/chapters/b.tex"]);
      expect(targets).toEqual(["chapters/b"]);
      const seed = await builder.buildSeed(before),
        date = { SOURCE_DATE_EPOCH: "1700000000", FORCE_SOURCE_DATE: "1" },
        sides = (force: boolean) => Promise.all([before, after].map((rev) => builder.build(rev, targets, seed, { date, force })));
      // Both sides of the round's first comparison, as published, and both
      // compiled clean, as every first chapter build was compiled before.
      const warm = await sides(false), cold = await sides(true);
      for (const [index, build] of warm.entries()) {
        expect(runs(build).latex).toBeLessThan(runs(cold[index]).latex);
        expect(runs(build).bibtex).toBeLessThanOrEqual(runs(cold[index]).bibtex);
        expect(text(build.pdf)).toBe(text(cold[index].pdf));
        for (const file of ["main.aux", "main.toc", "main.bbl", "main.stl", "chapters/b.aux"])
          expect(output(build, file)).toBe(output(cold[index], file));
      }
      const revised = text(warm[1].pdf);
      expect(revised).toContain("State: B.");
      expect(revised).toMatch(/revised with a longer opening\. See Section 3\.1 on page \d+ and \[3\]\./);
      // The chapter's own pages, not the seed's: other chapters stay out.
      expect(revised).not.toContain("Body a sentence 0.");
    } finally {
      await f.close();
    }
  },
  180000,
);
