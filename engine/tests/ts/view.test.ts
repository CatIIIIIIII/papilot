import fs from "node:fs";
import path from "node:path";
import { it, expect } from "vitest";
import { which } from "../../src/core/process.ts";
import { view } from "../../src/core/view.ts";
import { Fixture, METHOD } from "./helpers.ts";
const tex = Boolean(which("latexmk") && which("pdflatex") && which("synctex"));
const png = (page: { file: string }) =>
  fs.readFileSync(page.file).subarray(1, 4).toString();
it.skipIf(!tex)(
  "draws the pages where source lines and printed page numbers are typeset",
  async () => {
    const f = new Fixture(),
      app = f.app();
    try {
      // Hyperref may omit /PageLabels for ordinary 1, 2, ... numbering.
      // Roman numbering makes this fixture exercise real label metadata.
      f.write("paper/main.tex", f.read("paper/main.tex").replace("\\begin{document}", "\\begin{document}\n\\pagenumbering{roman}"));
      const task = app.tasks.create("look");
      f.edit(task, METHOD, "Method sentence 3.", "Method sentence three, revised.");
      const shown = await view(app, task.name, {
        locations: [`${METHOD}:6`, path.join(task.worktree, METHOD) + ":7"],
        pages: ["i", "99"],
      });
      expect(shown.error).toBeUndefined();
      expect(shown.pages).toHaveLength(1);
      expect(shown.pages[0]).toMatchObject({ index: 1, label: "i" });
      expect(shown.pages[0].shows).toEqual([`${METHOD}:6`, path.join(task.worktree, METHOD) + ":7", "i"]);
      expect(png(shown.pages[0])).toBe("PNG");
      expect(path.basename(shown.pages[0].file)).toBe("page-i-1.png");
      expect(shown.pages[0].file.startsWith(path.join(app.project.state, "views", task.name))).toBe(true);
      expect(shown.missing).toEqual(["Page 99: no page has this printed number."]);
      // The accepted text can be seen too.
      const accepted = await view(app, task.name, { pages: ["i"], accepted: true });
      expect(accepted.pages.map((p) => p.label)).toEqual(["i"]);
      await expect(view(app, task.name, { locations: ["../outside.tex:1"] })).rejects.toThrow(
        /repository-relative path/,
      );
      await expect(view(app, task.name, {})).rejects.toThrow(/at least one/);
    } finally {
      await f.close();
    }
  },
);
it.skipIf(!tex)("reports a worktree that does not compile", async () => {
  const f = new Fixture(),
    app = f.app();
  try {
    const task = app.tasks.create("broken");
    fs.appendFileSync(path.join(task.worktree, METHOD), "\\undefinedcommand\n");
    const shown = await view(app, task.name, { locations: [`${METHOD}:3`] });
    expect(shown.pages).toEqual([]);
    expect(shown.error).toBe("The paper in the task worktree could not be compiled.");
    expect(shown.details!.join("\n")).toMatch(/Undefined control sequence/);
  } finally {
    await f.close();
  }
});

it.skipIf(!tex)("does not mistake physical positions for printed page numbers", async () => {
  const f = new Fixture();
  try {
    const source = String.raw`\documentclass{article}
\begin{document}
\pagenumbering{roman}
Front matter.
\newpage
\pagenumbering{arabic}
Main content.
\end{document}
`;
    f.write("paper/main.tex", source);
    const app = f.app(), task = app.tasks.create("numbering");
    const missing = await view(app, task.name, { pages: ["i", "1"] });
    expect(missing.pages).toEqual([]);
    expect(missing.missing.join(" ")).toMatch(/no page-label metadata.*source locations/);
    // Source locations still reach the right page, without claiming that
    // the second physical page has the printed number 2.
    const located = await view(app, task.name, { locations: ["paper/main.tex:7"] });
    expect(located.pages).toHaveLength(1);
    expect(located.pages[0]).toMatchObject({ index: 2, label: null });
    expect(png(located.pages[0])).toBe("PNG");
    // With numbering metadata, roman and reset arabic numbers work as before.
    f.write("paper/main.tex", source.replace("\\begin{document}", "\\usepackage{hyperref}\n\\begin{document}"), task.worktree);
    const labeled = await view(app, task.name, { pages: ["i", "1"] });
    expect(labeled.pages.map(({ index, label }) => ({ index, label }))).toEqual([
      { index: 1, label: "i" }, { index: 2, label: "1" },
    ]);
    expect(labeled.missing).toEqual([]);
  } finally {
    await f.close();
  }
});
