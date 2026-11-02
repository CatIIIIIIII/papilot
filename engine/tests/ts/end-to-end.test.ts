import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, expect } from "vitest";
import { App } from "../../src/server.ts";
import { Builder, BuildError } from "../../src/core/build.ts";
import { more } from "../../src/core/publish.ts";
import { which } from "../../src/core/process.ts";
import { prepareDemo, applyDemo } from "../../examples/demo.ts";
import { Fixture, METHOD } from "./helpers.ts";
import type { Strip } from "../../src/types.ts";
const tex = Boolean(which("latexmk") && which("pdflatex"));
it.skipIf(!tex)(
  "retains shell-helper tracebacks in diagnostics and the saved build log",
  async () => {
    const f = new Fixture(),
      app = f.app(),
      previous = process.env.PATH;
    try {
      const tools = path.join(f.base, "tools");
      fs.mkdirSync(tools);
      fs.writeFileSync(
        path.join(tools, "latexmk"),
        `#!/bin/sh
cat >&2 <<'FAILURE'
Traceback (most recent call last):
  File "/tex/latexminted.py", line 372, in <module>
    main()
TypeError: ArgParser.__init__() got an unexpected keyword argument 'color'
FAILURE
exit 1
`,
        { mode: 0o755 },
      );
      process.env.PATH = tools + path.delimiter + previous;
      try {
        await new Builder(app.project, app.repo).build("HEAD");
        throw new Error("Expected the helper failure");
      } catch (error) {
        expect(error).toBeInstanceOf(BuildError);
        const failure = error as BuildError;
        expect(failure.details.join("\n")).toContain("latexminted: TypeError");
        expect(failure.details.join("\n")).toContain("compatible Python");
        expect(fs.readFileSync(failure.log!, "utf8")).toContain(
          "Traceback (most recent call last):",
        );
      }
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
      await f.close();
    }
  },
);
it.skipIf(!tex)(
  "renders KOMA acknowledgments and refreshes old renderer output without editing the paper",
  async () => {
    const f = new Fixture();
    f.write(
      "paper/main.tex",
      String.raw`\documentclass{scrbook}
\usepackage{hyperref}
\begin{document}
\frontmatter
\include{acknowledgments}
\mainmatter
\include{body}
\end{document}
`,
    );
    f.write(
      "paper/acknowledgments.tex",
      "\\addchap{Acknowledgments}\nThanks to my supervisor for the guidance.\n",
    );
    f.write(
      "paper/body.tex",
      "\\chapter{Introduction}\nAn unchanged chapter.\n",
    );
    f.repo.run(["add", "."]);
    f.repo.run(["commit", "-qm", "KOMA fixture"]);
    const app = f.app();
    try {
      const task = app.tasks.create("thanks", undefined, ["Acknowledgments"]);
      f.edit(
        task,
        "paper/acknowledgments.tex",
        "the guidance",
        "the patient guidance throughout my research",
      );
      const publish = async () => {
        const job = app.publisher.submit(task.name);
        await app.publisher.join();
        const done = app.publisher.job(job.id);
        expect(done.status, JSON.stringify(done.result)).toBe("done");
        return done.result;
      };
      expect((await publish()).outcome).toBe("published");
      const round = app.review.round(task.name, 1);
      const detail = app.review.roundDetail(task.name, 1);
      expect(detail.units).toHaveLength(1);
      expect(detail.units[0]).toMatchObject({
        visual: "text",
        section: "Acknowledgments",
      });
      expect(detail.sections[0].title).toBe("Acknowledgments");
      expect(detail.units[0].pages?.length).toBeGreaterThan(0);
      expect((await publish()).outcome).toBe("unchanged");

      // Simulate a round made before renderer versions were recorded.
      const { renderer: _oldRenderer, ...legacy } = round.summary;
      app.store.execute(
        "UPDATE rounds SET summary=? WHERE task=? AND number=1",
        JSON.stringify(legacy),
        task.name,
      );
      expect(await publish()).toMatchObject({ outcome: "published", round: 2 });
      const refreshed = app.review.round(task.name, 2);
      expect(refreshed.before).toBe(round.before);
      expect(app.repo.treeId(refreshed.after)).toBe(
        app.repo.treeId(round.after),
      );
      expect(app.review.roundDetail(task.name, 2).units[0].visual).toBe("text");
      expect((await publish()).outcome).toBe("unchanged");
      expect(f.read("paper/acknowledgments.tex")).not.toContain("patient");
    } finally {
      await f.close();
    }
  },
  120000,
);
it.skipIf(!tex)(
  "compiles the bundled paper, renders all seven edits and completes review",
  async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "latex-review-e2e-")),
      { root, plan } = prepareDemo(base),
      app = new App(root);
    try {
      const task = app.tasks.create(plan.task, plan.title, [plan.section]);
      applyDemo(task.worktree, plan);
      const job = app.publisher.submit(task.name);
      await app.publisher.join();
      const result = app.publisher.job(job.id);
      expect(result.status, JSON.stringify(result.result)).toBe("done");
      expect(result.result.changes).toBe(7);
      const detail = app.review.roundDetail(task.name, 1);
      expect(detail.units.some((u) => u.kind === "figure")).toBe(true);
      expect(detail.units.some((u) => u.visual === "identical")).toBe(true);
      expect(detail.units.every((u) => u.visual !== "unmapped")).toBe(true);
      const state = app.review.decide(task.name, {
        action: "accept",
        round: 1,
        changes: detail.units.map((u) => u.id),
      });
      expect(
        Object.values(state.decisions).every((d) => d === "accepted"),
      ).toBe(true);
      expect(app.review.summary(task.name).state).toBe("done");
      app.review.undo(task.name, state.undo!.id);
      expect(app.review.summary(task.name).state).toBe("reviewing");
    } finally {
      await app.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  },
  120000,
);
it.skipIf(!tex)(
  "shares a cached compilation and retains useful logs on failure",
  async () => {
    const f = new Fixture(),
      app = f.app();
    try {
      const builder = new Builder(app.project, app.repo),
        [a, b] = await Promise.all([
          builder.build("HEAD"),
          builder.build("HEAD"),
        ]);
      expect(a).toEqual(b);
      expect(fs.existsSync(a.pdf)).toBe(true);
      f.write(METHOD, "\\thiscommanddoesnotexist\n");
      const revision = app.repo.snapshot(["paper"]);
      try {
        await builder.build(revision);
        throw new Error("Should fail");
      } catch (error) {
        expect(error).toBeInstanceOf(BuildError);
        const e = error as BuildError;
        expect(e.details.join(" ")).toContain("Undefined control sequence");
        expect(fs.existsSync(e.log!)).toBe(true);
      }
    } finally {
      await f.close();
    }
  },
  120000,
);
it.skipIf(!tex)(
  "a decision arriving during compilation is included in the published round",
  async () => {
    const f = new Fixture(),
      app = f.app();
    const { vi } = await import("vitest"),
      { fakeRound } = await import("./helpers.ts");
    try {
      const task = app.tasks.create("during");
      f.edit(task, METHOD, "Method sentence 2.", "First proposal.");
      fakeRound(app, task.name);
      f.edit(task, METHOD, "Detail sentence 15.", "Second proposal.");
      const original = Builder.prototype.build;
      let decided = false;
      const spy = vi
        .spyOn(Builder.prototype, "build")
        .mockImplementation(async function (
          this: Builder,
          ...args: Parameters<Builder["build"]>
        ) {
          const result = await original.apply(this, args);
          if (!decided) {
            decided = true;
            app.review.decide(task.name, {
              action: "accept",
              round: 1,
              changes: ["c001"],
              id: "during-build",
            });
          }
          return result;
        });
      try {
        const job = app.publisher.submit(task.name);
        await app.publisher.join();
        expect(
          app.publisher.job(job.id).status,
          JSON.stringify(app.publisher.job(job.id).result),
        ).toBe("done");
        const round = app.review.round(task.name, 2);
        expect(round.before).toBe(app.tasks.get(task.name).accepted);
        expect(round.units).toHaveLength(1);
        expect(round.units[0].new_text).toContain("Second proposal.");
        expect(round.units[0].new_text).not.toContain("First proposal.");
      } finally {
        spy.mockRestore();
      }
    } finally {
      await f.close();
    }
  },
  120000,
);
it.skipIf(!tex)(
  "partial builds retain cross-chapter references and preload excluded macros",
  async () => {
    const f = new Fixture();
    f.write(
      "paper/main.tex",
      String.raw`\documentclass{book}
\usepackage{hyperref}
\begin{document}
\include{sections/one}
\include{sections/two}
\end{document}
`,
    );
    f.write(
      "paper/sections/one.tex",
      String.raw`\chapter{One}\label{one}
\input{macros/one}
First chapter.
`,
    );
    f.write(
      "paper/macros/one.tex",
      String.raw`\newcommand{\sharedmacro}{shared definition}`,
    );
    f.write(
      "paper/sections/two.tex",
      String.raw`\chapter{Two}
This uses the \sharedmacro{} from Chapter~\ref{one}.
`,
    );
    f.write(
      ".latex-review.json",
      JSON.stringify({ preload: { "sections/one": "macros/one.tex" } }),
    );
    f.repo.run(["add", "."]);
    f.repo.run(["commit", "-qm", "Book fixture"]);
    const app = f.app();
    try {
      const before = app.repo.rev("HEAD");
      f.write(
        "paper/sections/two.tex",
        f
          .read("paper/sections/two.tex")
          .replace("This uses", "This carefully uses"),
      );
      const after = app.repo.snapshot(["paper"]),
        builder = new Builder(app.project, app.repo),
        targets = builder.plan(before, after, ["paper/sections/two.tex"]);
      expect(targets).toEqual(["sections/two"]);
      const seed = await builder.build(before),
        partial = await builder.build(after, targets, seed);
      expect(partial.warnings).toEqual([]);
      expect(fs.existsSync(partial.pdf)).toBe(true);
      expect(
        fs.readFileSync(path.join(partial.cwd, "build/main.aux"), "utf8"),
      ).toContain("sections/one.aux");
    } finally {
      await f.close();
    }
  },
  120000,
);
it.skipIf(!tex)(
  "lists the places an edit changes away from its lines under that edit",
  async () => {
    const f = new Fixture();
    f.write("paper/macros.tex", "\\newcommand{\\method}{MacroNet}\n");
    // Each use on its own page, so each is a place of its own.
    const uses = ["Introduction", "Method", "Analysis", "Discussion", "Outlook"]
      .map((title) => `\\section{${title}}\nWe use \\method{} here.\n\\newpage`)
      .join("\n");
    f.write(
      "paper/main.tex",
      String.raw`\documentclass{article}
\usepackage{hyperref}
\input{macros}
\title{Where Macros Point}
\author{Test}
\begin{document}
\maketitle
${uses}
\section{Results}
The results follow.
\end{document}
`,
    );
    f.repo.run(["add", "."]);
    f.repo.run(["commit", "-qm", "macro fixture"]);
    const app = f.app();
    const publish = async (name: string) => {
      const job = app.publisher.submit(name);
      await app.publisher.join();
      const done = app.publisher.job(job.id);
      expect(done.status, JSON.stringify(done.result)).toBe("done");
    };
    const blocks = (name: string) => {
      const detail = app.review.roundDetail(name, 1);
      return [
        ...detail.sections.flatMap((s) =>
          s.blocks.flatMap((b) => (b.kind === "change" ? [b.units] : [])),
        ),
        ...detail.loose.map((b) => b.units),
      ];
    };
    try {
      // The definition prints nothing; it keeps the only card, and its
      // places are the five uses, the first three rendered.
      const single = app.tasks.create("rename");
      f.edit(single, "paper/macros.tex", "MacroNet", "MacroFormer");
      await publish(single.name);
      const [unit] = app.review.roundDetail(single.name, 1).units;
      expect(blocks(single.name)).toEqual([[unit.id]]);
      expect(unit.effects?.total).toBe(5);
      expect(unit.effects?.shown.map((p) => p.section)).toEqual([
        "1 Introduction",
        "2 Method",
        "3 Analysis",
      ]);
      const text = (strips: Strip[]) =>
        strips
          .flatMap((s) => s.text ?? [])
          .map((l) => l.text)
          .join(" ");
      expect(text(unit.effects!.shown[0].after)).toContain("MacroFormer");
      expect(text(unit.effects!.shown[0].before)).toContain("MacroNet");
      const folder = path.join(app.state, "rounds", single.name, "001"),
        rest = await more(folder, unit.id);
      expect(rest.map((p) => p.section)).toEqual(["4 Discussion", "5 Outlook"]);
      expect(rest.every((p) => p.after.length === 1)).toBe(true);

      // With other edits in the round, compiling the definition alone tells
      // its places apart from the other edits' own changes.
      const mixed = app.tasks.create("mixed");
      f.edit(mixed, "paper/macros.tex", "MacroNet", "MacroFormer");
      f.edit(
        mixed,
        "paper/main.tex",
        "Where Macros Point",
        "Where Do Macros Point",
      );
      f.edit(mixed, "paper/main.tex", "results follow", "results follow below");
      await publish(mixed.name);
      const units = app.review.roundDetail(mixed.name, 1).units,
        of = (file: string, line: number) =>
          units.find((u) => u.file === file && u.new_start === line)!;
      expect(of("paper/macros.tex", 1).effects?.total).toBe(5);
      expect(of("paper/main.tex", 4).effects).toBeUndefined();
      expect(units.filter((u) => u.effects).map((u) => u.file)).toEqual([
        "paper/macros.tex",
      ]);
    } finally {
      await f.close();
    }
  },
  300000,
);
