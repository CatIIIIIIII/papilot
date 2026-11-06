import { expect, it } from "vitest";
import { Fixture } from "./helpers.ts";
import { which } from "../../src/core/process.ts";
import { Builder } from "../../src/core/build.ts";
import { Build } from "../../src/render/locate.ts";
import { allDifferences, compareDocuments } from "../../src/render/effects.ts";

const tex = Boolean(which("latexmk") && which("pdflatex"));
const main = String.raw`\documentclass{article}
\usepackage{hyperref}
\input{style}
\begin{document}
\section{Signals}
The stable opening sentence stays in place.\par\vspace{30pt}
\noindent x\badge\par\vspace{30pt}
The stable closing sentence stays in place.
\end{document}
`;
const scenes = [
  ["script", String.raw`\scriptsize 2`, String.raw`x\badge`],
  ["ordinary text", "2", String.raw`x\badge`],
  ["operator", String.raw`\(\sum\)`, String.raw`x\badge`],
  [
    "adjacent minipages",
    String.raw`\scriptsize 2`,
    String.raw`\begin{minipage}{.4\linewidth}x\badge\end{minipage}\begin{minipage}{.4\linewidth}y\raisebox{-12pt}[0pt][0pt]{\scriptsize 3}\end{minipage}`,
  ],
  [
    "overlapping table rows",
    String.raw`\scriptsize 2`,
    String.raw`\begin{tabular}{cc}x\badge&y\\steady&stable\end{tabular}`,
  ],
  [
    "nested vertical boxes",
    String.raw`\scriptsize 2`,
    String.raw`\vbox{\hbox{x\badge}\hbox{steady}}\quad\vbox{\hbox{y}\hbox{stable}}`,
  ],
  ["fraction", String.raw`\(\frac{2}{3}\)`, String.raw`x\badge`, 12],
  ["shortstack", String.raw`\shortstack{2\\3}`, String.raw`x\badge`, 24],
  ["parbox", String.raw`\parbox{20pt}{2\\3}`, String.raw`x\badge`, 24],
] as const;
it.skipIf(!tex).each(scenes)(
  "publishes separately extracted raised/lowered text from a macro (%s)",
  async (name, content, scene, raise = 12) => {
    const f = new Fixture();
    f.write("paper/main.tex", main.replace(String.raw`x\badge`, scene));
    f.write(
      "paper/style.tex",
      `\\newcommand{\\badge}{\\raisebox{${raise}pt}[0pt][0pt]{${content}}}\n`,
    );
    f.repo.run(["add", "."]);
    f.repo.run(["commit", "-qm", "Source line layout fixture"]);
    const app = f.app();
    try {
      const task = app.tasks.create("scripts");
      f.edit(task, "paper/style.tex", `{${raise}pt}`, `{-${raise}pt}`);
      const job = app.publisher.submit(task.name, undefined, true);
      await app.publisher.join();
      expect(app.publisher.job(job.id).status).toBe("done");
      const detail = app.review.roundDetail(task.name, 1);
      expect(detail.units).toHaveLength(1);
      expect(detail.units[0].effects?.total).toBeGreaterThan(0);
      const place = detail.units[0].effects!.shown[0];
      expect(place.before.length).toBeGreaterThan(0);
      expect(place.after.length).toBeGreaterThan(0);
      if (["fraction", "shortstack", "parbox"].includes(name)) {
        // A moved fraction bar alone must not make this gate pass. Both
        // unchanged digits must have their own visual effects and survive
        // the actual published before/after crops; fixed x is not changed.
        const builder = new Builder(app.project, app.repo),
          builds = await Promise.all(
            [detail.before, detail.after].map(
              async (revision) =>
                new Build(
                  await builder.build(revision),
                  app.project.main,
                  app.project.source_dir,
                ),
            ),
          );
        try {
          const compared = compareDocuments(builds[0], builds[1]),
            visual = allDifferences(compared.old, compared.new).filter(
              (effect) => effect.kind === "visual",
            );
          for (const side of ["old", "new"] as const)
            expect(
              visual.flatMap((effect) =>
                compared[side].tokens
                  .slice(...effect[side])
                  .map((token) => token.text),
              ),
            ).toEqual(["2", "3"]);
          for (const side of ["before", "after"] as const) {
            const shown = detail.units[0]
              .effects!.shown.flatMap((place) => place[side])
              .flatMap((strip) => strip.text ?? [])
              .flatMap((line) => line.chars.map((char) => char.text));
            expect(shown).toContain("2");
            expect(shown).toContain("3");
          }
        } finally {
          builds.forEach((build) => build.close());
        }
      }
    } finally {
      await f.close();
    }
  },
);
it
  .skipIf(!tex)
  .each([
    String.raw`\vspace{40pt}`,
    String.raw`\vspace{40.123pt}`,
    String.raw`\newpage`,
  ])(
  "does not turn whole-line or page reflow into an indirect script change (%s)",
  async (gap) => {
    const f = new Fixture();
    f.write(
      "paper/main.tex",
      main
        .replace("\\begin{document}", "\\pagestyle{empty}\n\\begin{document}")
        .replace("\\vspace{30pt}", "\\gap"),
    );
    f.write(
      "paper/style.tex",
      String.raw`\newcommand{\badge}{\raisebox{12pt}[0pt][0pt]{\scriptsize 2}}
\newcommand{\gap}{\vspace{30pt}}
`,
    );
    f.repo.run(["add", "."]);
    f.repo.run(["commit", "-qm", "Source reflow fixture"]);
    const app = f.app();
    try {
      const task = app.tasks.create("reflow");
      f.edit(task, "paper/style.tex", String.raw`\vspace{30pt}`, gap);
      const job = app.publisher.submit(task.name, undefined, true);
      await app.publisher.join();
      expect(app.publisher.job(job.id).status).toBe("done");
      const detail = app.review.roundDetail(task.name, 1);
      expect(detail.units).toHaveLength(1);
      expect(detail.units[0].effects?.total ?? 0).toBe(0);
    } finally {
      await f.close();
    }
  },
);

it.skipIf(!tex).each([
  ["minipage", "paragraph"],
  ["parbox", "paragraph"],
  ["minipage", "wrap"],
  ["parbox", "wrap"],
])("keeps ordinary %s %s reflow out of visual effects", async (box, change) => {
  const content =
      change === "paragraph"
        ? String.raw`PREFIXOpening sentence.\par Stable sentinel remains unchanged.\par Another entirely stable row.`
        : "This PREFIX word changes line wrapping in an otherwise unchanged paragraph with enough subsequent words.",
    wrapped =
      box === "minipage"
        ? `x\\begin{minipage}{80pt}${content}\\end{minipage} y`
        : `x\\parbox{80pt}{${content}} y`,
    document =
      String.raw`\documentclass{article}
\pagestyle{empty}\begin{document}
The stable opening sentence remains unchanged.\par\vspace{40pt}\noindent ` +
      wrapped +
      String.raw`\par\vspace{40pt}
The stable closing sentence remains unchanged.\end{document}`,
    before = change === "paragraph" ? "" : "small",
    after =
      change === "paragraph"
        ? "Additional inserted words that wrap into extra physical lines. "
        : "considerably longer",
    f = new Fixture(),
    builds: Build[] = [];
  f.write("paper/main.tex", document.replace("PREFIX", before));
  f.repo.run(["add", "."]);
  f.repo.run(["commit", "-qm", "Nested flow fixture"]);
  const app = f.app(),
    builder = new Builder(app.project, app.repo);
  try {
    builds.push(
      new Build(
        await builder.build("HEAD"),
        app.project.main,
        app.project.source_dir,
      ),
    );
    f.write("paper/main.tex", document.replace("PREFIX", after));
    builds.push(
      new Build(
        await builder.build(f.repo.snapshot(["paper"])),
        app.project.main,
        app.project.source_dir,
      ),
    );
    const compared = compareDocuments(builds[0], builds[1]),
      effects = allDifferences(compared.old, compared.new);
    expect(effects.filter((effect) => effect.kind === "visual")).toEqual([]);
    const added = effects.flatMap((effect) =>
      compared.new.tokens.slice(...effect.new).map((token) => token.text),
    );
    expect(added).toContain(change === "paragraph" ? "Additional" : "longer");
    expect(added).not.toContain("Stable");
    expect(added).not.toContain("unchanged");
  } finally {
    builds.forEach((build) => build.close());
    await f.close();
  }
});
