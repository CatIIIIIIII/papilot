import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { which } from "../../src/core/process.ts";
import { Fixture } from "./helpers.ts";

const latexmk = which("latexmk");
it.skipIf(!latexmk || !which("pdflatex"))("agent writes compile and render the round ahead, and the round reuses both", async () => {
  const f = new Fixture(), previousPath = process.env.PATH;
  try {
    f.write("paper/main.tex", String.raw`\documentclass{book}
\begin{document}
\include{chapters/one}
\include{chapters/two}
\end{document}
`);
    f.write("paper/chapters/one.tex", "\\chapter{One}\nFirst chapter.\n");
    f.write("paper/chapters/two.tex", "\\chapter{Two}\nSecond chapter.\n");
    f.repo.run(["add", "-A"]);
    f.repo.run(["commit", "-qm", "Chapters"]);
    const bin = path.join(f.base, "bin"), calls = path.join(f.base, "calls");
    fs.mkdirSync(bin);
    // Count actual compiler invocations, including cache misses during publish.
    fs.writeFileSync(path.join(bin, "latexmk"), `#!/bin/sh\nprintf '%s\\n' "$PWD" >> '${calls}'\nexec '${latexmk}' "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
    const app = f.app();
    await app.ready;
    const task = app.tasks.create("prefetch");
    f.edit(task, "paper/chapters/two.tex", "Second chapter.", "Second chapter, with a clearer explanation.");
    app.publisher.prefetch(task.name);
    await app.publisher.join();
    const before = fs.readFileSync(calls, "utf8").trim().split("\n");
    expect(before).toHaveLength(3); // full seed, chapter baseline, chapter revised
    // The comparison is rendered too, before the turn ends.
    const renders = path.join(app.state, "cache/renders"), ahead = fs.readdirSync(renders);
    expect(ahead).toHaveLength(1);
    const comparison = fs.readFileSync(path.join(renders, ahead[0], "round.json"), "utf8");
    const job = app.publisher.submit(task.name);
    await app.publisher.join();
    expect(app.publisher.job(job.id)).toMatchObject({ status: "done", result: { prefetch: "hit", outcome: "published" } });
    expect(fs.readFileSync(calls, "utf8").trim().split("\n")).toEqual(before);
    expect(app.review.latestRound(task.name)?.summary.targets).toEqual(["chapters/two"]);
    // The round shows the comparison rendered ahead, rendering nothing again.
    expect(fs.readdirSync(renders)).toEqual(ahead);
    expect(fs.readFileSync(path.join(app.state, "rounds", task.name, "001", "round.json"), "utf8")).toBe(comparison);
  } finally {
    await f.close();
    process.env.PATH = previousPath;
  }
});
