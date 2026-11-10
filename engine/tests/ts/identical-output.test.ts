import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { Builder } from "../../src/core/build.ts";
import { loadProject } from "../../src/core/config.ts";
import { Repo } from "../../src/core/git.ts";
import { Cancelled, which } from "../../src/core/process.ts";
import { Fixture } from "./helpers.ts";
import type { BuildInfo } from "../../src/types.ts";

// Continuing from earlier builds, also after a cancelled one, only saves
// TeX passes: the PDF is byte for byte the PDF of a clean build of the same
// sources, for a chapter build and for the whole paper.
const tex = Boolean(which("latexmk") && which("pdflatex"));
const MAIN = String.raw`\documentclass{book}
\begin{document}
\tableofcontents
\include{chapters/a}
\include{chapters/b}
\include{chapters/c}
\bibliographystyle{plain}
\bibliography{refs}
\end{document}
`;
const chapter = (name: string, other: string, cite: string, opening: string) => String.raw`\chapter{${name.toUpperCase()}}
\section{Start of ${name}}\label{sec:${name}}
${opening} See Section~\ref{sec:${other}} on page~\pageref{sec:${other}} and \cite{${cite}}.
${Array.from({ length: 60 }, (_, i) => `Body ${name} sentence ${i}.`).join(" ")}
`;
const runs = (build: BuildInfo) => (fs.readFileSync(path.join(path.dirname(build.root), "latexmk.log"), "utf8").match(/^Running 'pdflatex/gm) ?? []).length;

it.skipIf(!tex)("an incremental build, also after a cancelled one, makes the same PDF as a clean build", async () => {
  const f = new Fixture(), clean = path.join(f.base, "clean");
  try {
    f.write("paper/main.tex", MAIN);
    f.write("paper/refs.bib", ["knuth", "lamport", "goossens"].map((key, i) => `@book{${key},author={Author ${key}},title={Title ${i}},year={${1980 + i}},publisher={P}}`).join("\n"));
    f.write("paper/chapters/a.tex", chapter("a", "b", "knuth", "First chapter."));
    f.write("paper/chapters/b.tex", chapter("b", "c", "lamport", "Middle chapter."));
    f.write("paper/chapters/c.tex", chapter("c", "a", "goossens", "Last chapter."));
    f.repo.run(["rm", "-q", "paper/sections/method.tex"]);
    f.repo.run(["add", "-A"]);
    f.repo.run(["commit", "-qm", "Book"]);
    const revisions = [f.repo.rev("HEAD")];
    // Edits that move text, add a section and a label, and cite more.
    for (const opening of ["Middle chapter, revised with a longer opening.", String.raw`Middle chapter.\section{Added}\label{sec:added} See Section~\ref{sec:added}.`, String.raw`Middle chapter, once more. \cite{knuth}`]) {
      f.write("paper/chapters/b.tex", chapter("b", "c", "lamport", opening));
      f.repo.run(["commit", "-qam", opening.slice(0, 20)]);
      revisions.push(f.repo.rev("HEAD"));
    }
    const date = { SOURCE_DATE_EPOCH: "1700000000", FORCE_SOURCE_DATE: "1" }, targets = ["chapters/b"];
    // The incremental path: each build continues from the closest earlier one.
    const builder = new Builder(loadProject(f.root), f.repo), seed = await builder.buildSeed(revisions[0]);
    await builder.build(revisions[1], targets, seed, { date });
    // A build cancelled midway leaves nothing to continue from.
    const stop = new AbortController(), cancelled = builder.build(revisions[2], targets, seed, { date, signal: stop.signal });
    setTimeout(() => stop.abort(), 150);
    await cancelled.then(() => undefined, (error) => expect(error).toBeInstanceOf(Cancelled));
    const chapterWarm = await builder.build(revisions[3], targets, seed, { date });
    await builder.build(revisions[1], ["full"], null, { date });
    const fullWarm = await builder.build(revisions[3], ["full"], null, { date });
    // A clean build of the same sources, in a copy of the paper with an
    // empty build cache.
    execFileSync("git", ["clone", "-q", f.root, clean]);
    const fresh = new Builder(loadProject(clean), new Repo(clean)), freshSeed = await fresh.buildSeed(revisions[0], { force: true });
    const chapterClean = await fresh.build(revisions[3], targets, freshSeed, { date, force: true });
    const fullClean = await fresh.build(revisions[3], ["full"], null, { date, force: true });
    expect(fs.readFileSync(chapterWarm.pdf).equals(fs.readFileSync(chapterClean.pdf))).toBe(true);
    expect(fs.readFileSync(fullWarm.pdf).equals(fs.readFileSync(fullClean.pdf))).toBe(true);
    // And it did save work.
    expect(runs(fullWarm)).toBeLessThan(runs(fullClean));
  } finally {
    await f.close();
  }
}, 240000);
