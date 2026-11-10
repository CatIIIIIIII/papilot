import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Builder } from "../../src/core/build.ts";
import { which } from "../../src/core/process.ts";
import { diffUnitsAsync, withHashesAsync } from "../../src/core/changes.ts";
import { fingerprint, provisional, rendered, roundFolder } from "../../src/core/carry.ts";
import { Fixture, fakeRound } from "./helpers.ts";
import type { App } from "../../src/server.ts";
import type { ChangeBlock, RenderedRound, Round, Task, Unit } from "../../src/types.ts";

// An inline edit of one change inserts a new round. The other changes keep
// their earlier comparison only when nothing the edit can move: they come
// before it and end on an earlier page, outside its paragraph.

const words = (unit: Unit, app: App, round: Pick<Round, "after">) =>
  app.repo.blob(round.after, unit.file)!.toString().split("\n").slice(unit.new_start - 1, unit.new_end).join("\n");
const label = (text: string) => /[A-Z]{3,}/.exec(text)?.[0] ?? text;
const strip = (page: number) => ({ src: `s-${page}.png`, clean: `c-${page}.png`, width: 100, height: 12, page, label: String(page) });

/** Proposes each label's word, renders the earlier round on the given
 *  [before, after] pages, applies the follow-up edit and returns the labels
 *  whose comparison the new round carries. */
async function carried(
  paper: Record<string, string>,
  proposals: [file: string, old: string, next: string][],
  pages: Record<string, [number[], number[]]>,
  followUp: [file: string, old: string, next: string][],
) {
  const f = new Fixture();
  try {
    for (const [file, text] of Object.entries(paper)) f.write(file, text);
    f.repo.run(["add", "-A"]);
    f.repo.run(["commit", "-qm", "paper"]);
    const app = f.app();
    await app.ready;
    const task = app.tasks.create("carry", "Carry", [], ["paper"], true);
    for (const [file, old, next] of proposals) f.edit(task, file, old, next);
    const round = fakeRound(app, task.name),
      image: RenderedRound = { units: {}, sections: [], loose: [] };
    for (const unit of round.units) {
      const name = label(words(unit, app, round)),
        [before, after] = pages[name] ?? [[], []];
      image.units[unit.id] = { visual: "text", pages: [], section: null };
      image.loose.push({ kind: "change", units: [unit.id], identical: false, before: before.map(strip), after: after.map(strip) } as ChangeBlock);
    }
    expect(round.units.map((unit) => label(words(unit, app, round))).sort()).toEqual(Object.keys(pages).sort());
    fs.mkdirSync(roundFolder(app, task.name, 1), { recursive: true });
    fs.writeFileSync(path.join(roundFolder(app, task.name, 1), "round.json"), JSON.stringify(image));
    for (const [file, old, next] of followUp) f.edit(task, file, old, next);
    const before = app.tasks.get(task.name).accepted,
      after = await app.tasks.snapshotAsync(task),
      units = await withHashesAsync(app.repo, before, after, await diffUnitsAsync(app.repo, before, after)),
      shown = await provisional(app, task.name, round, { before, after, units });
    return Object.keys(shown.rendered.carried ?? {}).map((id) => label(words(units.find((unit) => unit.id === id)!, app, { after }))).sort();
  } finally {
    await f.close();
  }
}

const ARTICLE = "\\documentclass{article}\n\\begin{document}\n\\input{body}\n\\end{document}\n";
const paragraphs = (...names: string[]) =>
  names.map((name) => `${name} opens this paragraph.\nIts middle line stays.\nIts last line stays too.\n`).join("\n");
const propose = (file: string, ...names: string[]): [string, string, string][] =>
  names.map((name) => [file, `${name} opens`, `${name} ${name.toUpperCase()} opens`]);
const inline = (file: string, name: string): [string, string, string] => [file, `${name.toUpperCase()} opens this paragraph.`, `${name.toUpperCase()} opens this corrected paragraph.`];

describe("carried comparisons after an inline edit", () => {
  it("keeps changes on earlier pages and holds those the edit can push", async () => {
    const paper = { "paper/main.tex": ARTICLE, "paper/body.tex": paragraphs("Alpha", "Bravo", "Charlie", "Delta") };
    // Charlie moved to the next page in the proposal. Only the proposal
    // side changes, so Bravo, on Charlie's old page there, stays put.
    expect(await carried(paper, propose("paper/body.tex", "Alpha", "Bravo", "Charlie", "Delta"),
      { ALPHA: [[1], [1]], BRAVO: [[2], [2]], CHARLIE: [[2], [3]], DELTA: [[3], [4]] },
      [inline("paper/body.tex", "Charlie")])).toEqual(["ALPHA", "BRAVO"]);
    // A change on the edited change's page waits.
    expect(await carried(paper, propose("paper/body.tex", "Alpha", "Bravo", "Charlie", "Delta"),
      { ALPHA: [[1], [1]], BRAVO: [[2], [3]], CHARLIE: [[2], [3]], DELTA: [[3], [4]] },
      [inline("paper/body.tex", "Charlie")])).toEqual(["ALPHA"]);
  });

  it("holds the rest of the edited paragraph on earlier pages", async () => {
    const body = "Alpha opens a paragraph.\nIts second line stays.\nIts third line stays.\nCharlie closes the paragraph.\n\nDelta opens the next one.\n";
    expect(await carried({ "paper/main.tex": ARTICLE, "paper/body.tex": body }, [["paper/body.tex", "Alpha opens", "Alpha ALPHA opens"], ["paper/body.tex", "Charlie closes", "Charlie CHARLIE closes"]],
      { ALPHA: [[1], [1]], CHARLIE: [[2], [2]] }, [["paper/body.tex", "CHARLIE closes", "CHARLIE now closes"]])).toEqual([]);
  });

  it("holds everything after the edit, in later chapters too, and keeps what comes before", async () => {
    const paper = {
      "paper/main.tex": "\\documentclass{report}\n\\begin{document}\n\\include{one}\n\\include{two}\n\\include{three}\n\\end{document}\n",
      "paper/one.tex": "\\chapter{One}\n" + paragraphs("Alpha"),
      "paper/two.tex": "\\chapter{Two}\n" + paragraphs("Bravo", "Charlie", "Delta") + "\\clearpage\n" + paragraphs("Echo"),
      "paper/three.tex": "\\chapter{Three}\n" + paragraphs("Foxtrot", "Golf"),
    };
    const proposals = [...propose("paper/one.tex", "Alpha"), ...propose("paper/two.tex", "Bravo", "Charlie", "Delta", "Echo"), ...propose("paper/three.tex", "Foxtrot")],
      pages: Record<string, [number[], number[]]> = { ALPHA: [[1], [1]], BRAVO: [[3], [3]], CHARLIE: [[4], [4]], DELTA: [[5], [5]], ECHO: [[6], [6]], FOXTROT: [[7], [7]] };
    // Even past a forced page break, text that follows can move or change:
    // a definition or a setting in the edited passage applies to it, and
    // its page numbers can shift.
    expect(await carried(paper, proposals, pages, [inline("paper/two.tex", "Charlie")])).toEqual(["ALPHA", "BRAVO"]);
    expect(await carried(paper, proposals, pages, [["paper/two.tex", "Charlie CHARLIE opens this paragraph.", "\\newcommand{\\name}{Bar}Charlie CHARLIE opens this paragraph."]])).toEqual(["ALPHA", "BRAVO"]);
    // A passage no earlier change covers has a place in reading order but
    // no page: a forced break before it proves which changes come earlier.
    expect(await carried(paper, proposals, pages, [["paper/three.tex", "Golf opens", "Golf now opens"]])).toEqual(["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO"]);
  });

  it("holds every change when the edit can renumber the paper, but not for a reference", async () => {
    const paper = { "paper/main.tex": ARTICLE, "paper/body.tex": paragraphs("Alpha", "Bravo", "Charlie") + "\\clearpage\n" + paragraphs("Delta") },
      proposals = propose("paper/body.tex", "Alpha", "Bravo", "Charlie", "Delta"),
      pages: Record<string, [number[], number[]]> = { ALPHA: [[1], [1]], BRAVO: [[1], [1]], CHARLIE: [[2], [2]], DELTA: [[3], [3]] };
    expect(await carried(paper, proposals, pages, [["paper/body.tex", "CHARLIE opens this paragraph.", "CHARLIE opens this paragraph~\\cite{knuth}."]])).toEqual([]);
    expect(await carried(paper, proposals, pages, [["paper/body.tex", "CHARLIE opens this paragraph.", "CHARLIE opens this paragraph (Section~\\ref{one})."]])).toEqual(["ALPHA", "BRAVO"]);
  });

  it("holds a change that shows a page number from elsewhere", async () => {
    const paper = { "paper/main.tex": ARTICLE, "paper/body.tex": paragraphs("Alpha", "Bravo", "Charlie") };
    expect(await carried(paper, [["paper/body.tex", "Alpha opens", "Alpha ALPHA, see page~\\pageref{end}, opens"], ...propose("paper/body.tex", "Bravo", "Charlie")],
      { ALPHA: [[1], [1]], BRAVO: [[1], [1]], CHARLIE: [[2], [2]] }, [inline("paper/body.tex", "Charlie")])).toEqual(["BRAVO"]);
  });

  it("holds earlier pages of the run when the edit is in a float", async () => {
    const body = paragraphs("Alpha") + "\\begin{figure}\n\\centering\n\\caption{Charlie opens this caption.}\n\\end{figure}\n\n" + paragraphs("Delta");
    expect(await carried({ "paper/main.tex": ARTICLE, "paper/body.tex": body }, propose("paper/body.tex", "Alpha", "Charlie", "Delta"),
      { ALPHA: [[1], [1]], CHARLIE: [[3], [3]], DELTA: [[2], [2]] }, [["paper/body.tex", "CHARLIE opens this caption.", "CHARLIE opens this longer caption."]])).toEqual([]);
  });
});

const tex = Boolean(which("latexmk") && which("pdflatex"));
const sentence = (name: string, i: number) => `Sentence ${i} of ${name} takes up some room on the page so that the paragraph wraps.`;
const paragraph = (name: string) => `${name} opens this paragraph. ` + Array.from({ length: 6 }, (_, i) => sentence(name, i)).join(" ") + "\n";
const filler = (name: string, count: number) => Array.from({ length: count }, (_, i) => paragraph(`${name}${i}`)).join("\n");

it.skipIf(!tex)("an inline edit leaves earlier chapters and pages decidable with the comparisons they render to", async () => {
  const f = new Fixture();
  f.write("paper/main.tex", "\\documentclass{report}\n\\begin{document}\n\\include{chapters/one}\n\\include{chapters/two}\n\\include{chapters/three}\n\\end{document}\n");
  f.write("paper/chapters/one.tex", "\\chapter{One}\n" + paragraph("Alpha"));
  f.write("paper/chapters/two.tex", ["\\chapter{Two}", paragraph("Bravo"), filler("Filler", 6), paragraph("Charlie"), filler("Spacer", 6), paragraph("Delta")].join("\n"));
  f.write("paper/chapters/three.tex", "\\chapter{Three}\n" + paragraph("Echo"));
  f.repo.run(["add", "-A"]);
  f.repo.run(["commit", "-qm", "Chapters"]);
  const app = f.app();
  await app.ready;
  try {
    const task: Task = app.tasks.create("chapters", "Chapters", [], ["paper"], true);
    for (const name of ["Alpha", "Bravo", "Charlie", "Echo"]) f.edit(task, `paper/chapters/${name === "Alpha" ? "one" : name === "Echo" ? "three" : "two"}.tex`, `${name} opens`, `${name} ${name.toUpperCase()} opens`);
    // Delta rewrites its whole paragraph: its comparison spans many lines.
    f.edit(task, "paper/chapters/two.tex", paragraph("Delta").trim(), paragraph("Delta").trim().replace(/takes up some room/g, "fills DELTA space"));
    const job = app.publisher.submit(task.name);
    await app.publisher.join();
    expect(app.publisher.job(job.id).status, JSON.stringify(app.publisher.job(job.id).result)).toBe("done");
    const first = app.review.latestRound(task.name)!,
      labels = (round: Round) => new Map(round.units.map((unit) => [unit.id, label(words(unit, app, round))])),
      named = (round: Round, name: string) => [...labels(round)].filter(([, value]) => value === name).map(([id]) => id),
      pagesOf = (image: RenderedRound, ids: string[]) => [...new Set([...image.sections.flatMap((s) => s.blocks), ...image.loose]
        .flatMap((block) => (block.kind === "change" && block.units.some((id) => ids.includes(id)) ? block.after.map((s) => s.page) : [])))].sort(),
      image = rendered(app, task.name, 1);
    // The layout this test relies on: Bravo, Charlie and Delta on successive pages.
    const [bravo, charlie, delta] = ["BRAVO", "CHARLIE", "DELTA"].map((name) => pagesOf(image, named(first, name)));
    expect(Math.max(...bravo)).toBeLessThan(Math.min(...charlie));
    expect(Math.max(...charlie)).toBeLessThan(Math.min(...delta));
    const original = Builder.prototype.build;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(Builder.prototype, "build").mockImplementation(async function (this: Builder, ...args) {
      await gate;
      return original.apply(this, args);
    });
    // The correction adds most of a page, pushing the rest of its chapter on.
    const edited = named(first, "CHARLIE")[0],
      source = app.sourceEdits.read(task.name, 1, edited),
      growth = Array.from({ length: 30 }, (_, i) => sentence("the correction", i)).join(" ");
    await app.sourceEdits.save(task.name, { id: "grow", round: 1, change: edited, revision: source.revision, text: source.text.replace(/(\s*)$/, ` ${growth}$1`) });
    for (let i = 0; i < 200 && (app.review.latestRound(task.name)?.number ?? 0) < 2; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    const second = app.review.latestRound(task.name)!,
      now = labels(second),
      held = structuredClone(rendered(app, task.name, 2)),
      kept = Object.keys(held.carried ?? {});
    expect(second).toMatchObject({ number: 2, visuals: "pending" });
    expect([...new Set(kept.map((id) => now.get(id)))].sort()).toEqual(["ALPHA", "BRAVO"]);
    expect([...new Set((app.review.pageState(task.name).waiting ?? []).map((id) => now.get(id)))].sort()).toEqual(["CHARLIE", "DELTA", "ECHO"]);
    release();
    await app.publisher.join();
    const final = rendered(app, task.name, 2);
    // Each carried comparison is the one the round renders...
    for (const id of kept) expect(fingerprint(final, id), now.get(id)).toBe(fingerprint(held, id));
    // ...and the change that waited did move.
    expect(pagesOf(final, named(second, "DELTA"))).not.toEqual(delta);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
}, 300000);
