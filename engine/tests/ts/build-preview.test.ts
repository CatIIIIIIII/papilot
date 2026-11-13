import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Builder, type PassPreview } from "../../src/core/build.ts";
import { loadProject } from "../../src/core/config.ts";
import { Repo } from "../../src/core/git.ts";
import * as processTools from "../../src/core/process.ts";
import { Fixture } from "./helpers.ts";

const tex = Boolean(processTools.which("latexmk") && processTools.which("pdflatex"));
const version = tex ? /Version (\d+)\.(\d+)/.exec(processTools.run("latexmk", ["-version"]).stdout.toString()) : null;
const hooks = version && (Number(version[1]) > 4 || Number(version[1]) === 4 && Number(version[2]) >= 84);
afterEach(() => vi.restoreAllMocks());

it.skipIf(!hooks).each(["foreground", "background"] as const)(
  "keeps %s pass previews and project hooks without sending Perl code through the command line",
  async priority => {
    const f = new Fixture();
    try {
      const root = path.join(f.base, "论文 & spaces");
      fs.renameSync(f.root, root);
      f.root = root;
      f.repo = new Repo(root);
      f.write("paper/main.tex", String.raw`\documentclass{article}
\begin{document}
See section \ref{intro}.
\section{Introduction}\label{intro}
A paper that needs another pass to settle its reference.
\end{document}
`);
      f.write("paper/user config.latexmkrc", `print "Project rc loaded\\n";
add_hook('after_xlatex', sub { print "Project hook ran\\n"; return 0; });
`);
      // The generated config must not overwrite a paper's similarly named file.
      f.write("paper/papilot-pass.latexmkrc", "paper-owned file\n");
      f.write(".git/papilot/settings.json", JSON.stringify({ main: "paper/main.tex", engine: "pdflatex", latexmkrc: "paper/user config.latexmkrc" }));
      f.repo.run(["add", "."]);
      f.repo.run(["commit", "-qm", "Pass preview fixture"]);
      const run = vi.spyOn(processTools, "runAsync");
      const previews: PassPreview[] = [];
      const result = await new Builder(loadProject(root), f.repo).build("HEAD", ["full"], null, {
        priority,
        ...(priority === "foreground" ? { pass: (preview: PassPreview) => previews.push(preview) } : {}),
      });
      expect(fs.readFileSync(result.pdf).subarray(0, 5).toString()).toBe("%PDF-");
      const transcript = fs.readFileSync(path.join(path.dirname(result.root), "latexmk.log"), "utf8");
      expect(transcript).toContain("Project rc loaded");
      expect(transcript).toContain("Project hook ran");
      expect(transcript).toContain("Papilot: pass 1 output saved");
      expect(transcript).toContain("Papilot: pass 2 output saved");
      if (priority === "foreground") {
        expect(previews.map(preview => preview.pass)).toContain(1);
        for (const preview of previews) {
          expect(fs.readFileSync(preview.pdf).subarray(0, 5).toString()).toBe("%PDF-");
          expect(fs.existsSync(preview.pdf.replace(/\.pdf$/, ".synctex.gz"))).toBe(true);
        }
      }
      // MiKTeX reconstructs the command line without escaping embedded quotes.
      // Keep this launch boundary covered even when CI uses TeX Live.
      const calls = run.mock.calls.filter(([command]) => command === "latexmk");
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).not.toContain("-e");
      expect(f.read("paper/papilot-pass.latexmkrc")).toBe("paper-owned file\n");
      expect(fs.readFileSync(path.join(result.cwd, "papilot-pass.latexmkrc"), "utf8")).toBe("paper-owned file\n");
      expect(f.repo.run(["status", "--porcelain"]).toString()).toBe("");
    } finally {
      await f.close();
    }
  },
);
