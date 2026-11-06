import fs from "node:fs";
import path from "node:path";
import { it, expect } from "vitest";
import { Fixture } from "./helpers.ts";
import { which } from "../../src/core/process.ts";
import { mupdf, PdfDocument } from "../../src/render/pdf.ts";
import { pixelDifference } from "../../src/render/pdfdiff.ts";
const tex = Boolean(which("latexmk") && which("pdflatex"));
it.skipIf(!tex).each(["vector", "image"])(
  "publishes a %s change caused by a definition without its own printed crop",
  async (kind) => {
    const f = new Fixture();
    try {
      if (kind === "image")
        for (const [name, color] of [
          ["red", [255, 0, 0]],
          ["blue", [0, 0, 255]],
        ] as const) {
          const pixmap = new mupdf.Pixmap(
            mupdf.ColorSpace.DeviceRGB,
            [0, 0, 2, 2],
            false,
          );
          pixmap.clear(255);
          const pixels = pixmap.getPixels();
          for (let i = 0; i < pixels.length; i += 3) pixels.set(color, i);
          f.write("paper/" + name + ".png", Buffer.from(pixmap.asPNG()));
          pixmap.destroy();
        }
      f.write(
        "paper/definitions.tex",
        String.raw`\newcommand{\setting}{red}` + "\n",
      );
      f.write(
        "paper/main.tex",
        String.raw`\documentclass{article}
\usepackage{xcolor,graphicx}
\input{definitions.tex}
\begin{document}
\section{Synthetic graphics}
This opening sentence stays unchanged.

${kind === "vector" ? String.raw`\textcolor{\setting}{\rule{100pt}{8pt}}` : String.raw`\includegraphics[width=100pt]{\setting.png}`}

This closing sentence stays unchanged.
\end{document}
`,
      );
      f.repo.run(["add", "."]);
      f.repo.run(["commit", "-qm", "Synthetic graphics fixture"]);
      const app = f.app(),
        task = app.tasks.create("paint-" + kind);
      f.edit(task, "paper/definitions.tex", "{red}", "{blue}");
      const job = app.publisher.submit(task.name, undefined, true);
      await app.publisher.join();
      expect(app.publisher.job(job.id).status).toBe("done");
      const round = app.review.round(task.name, 1),
        detail = app.review.roundDetail(task.name, 1),
        build = (key: string) =>
          JSON.parse(
            fs.readFileSync(
              path.join(app.state, "cache/builds", key, "result.json"),
              "utf8",
            ),
          ),
        before = new PdfDocument(build(round.summary.builds![0]).pdf),
        after = new PdfDocument(build(round.summary.builds!.at(-1)!).pdf);
      try {
        expect(
          pixelDifference(
            before.page(0).raster(before.page(0).bounds),
            after.page(0).raster(after.page(0).bounds),
            Infinity,
            0,
          ),
        ).toBeGreaterThan(100);
      } finally {
        before.close();
        after.close();
      }
      const effects = detail.units[0].effects;
      expect(effects?.verified).toBe(true);
      expect(effects?.total).toBeGreaterThan(0);
      expect(effects!.shown[0].before.length).toBeGreaterThan(0);
      expect(effects!.shown[0].after.length).toBeGreaterThan(0);
    } finally {
      await f.close();
    }
  },
);
it.skipIf(!tex)(
  "publishes a verified joint combination for two indirect graphic edits",
  async () => {
    const f = new Fixture();
    try {
      f.write(
        "paper/first.tex",
        String.raw`\newcommand{\firstcolor}{red}` + "\n",
      );
      f.write(
        "paper/second.tex",
        String.raw`\newcommand{\secondcolor}{yellow}` + "\n",
      );
      f.write(
        "paper/main.tex",
        String.raw`\documentclass{article}
\usepackage{xcolor}
\input{first.tex}
\input{second.tex}
\begin{document}
\section{Synthetic combination}
This sentence stays unchanged.

\colorbox{\firstcolor!50!\secondcolor}{\rule{30pt}{0pt}\rule{0pt}{10pt}}

This final sentence stays unchanged.
\end{document}
`,
      );
      f.repo.run(["add", "."]);
      f.repo.run(["commit", "-qm", "Synthetic joint paint fixture"]);
      const app = f.app(),
        task = app.tasks.create("paint-joint");
      f.edit(task, "paper/first.tex", "{red}", "{blue}");
      f.edit(task, "paper/second.tex", "{yellow}", "{green}");
      const job = app.publisher.submit(task.name, undefined, true);
      await app.publisher.join();
      expect(app.publisher.job(job.id).status).toBe("done");
      const detail = app.review.roundDetail(task.name, 1);
      expect(detail.units).toHaveLength(2);
      for (const unit of detail.units) {
        expect(unit.effects?.verified).toBe(true);
        expect(unit.effects?.total).toBe(1);
        expect(unit.effects?.shown[0].with).toHaveLength(1);
        expect(unit.effects?.shown[0].before).toHaveLength(1);
        expect(unit.effects?.shown[0].after).toHaveLength(1);
      }
    } finally {
      await f.close();
    }
  },
);
