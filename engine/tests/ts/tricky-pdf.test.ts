import fs from "node:fs";
import path from "node:path";
import { it, expect } from "vitest";
import { Fixture } from "./helpers.ts";
import { applyUnits, revertUnits } from "../../src/core/changes.ts";
import { run, which } from "../../src/core/process.ts";
import { containsCenter, PdfDocument } from "../../src/render/pdf.ts";
import { ROOT } from "../../src/runtime.ts";
import type { ChangeBlock, Strip, Rect } from "../../src/types.ts";
const tex = Boolean(which("latexmk") && which("pdflatex"));
const paragraph =
  "A replicated state machine records commands in a durable log. Each replica applies committed commands in order. The invariant remains valid while leadership changes. ";
const CUT =
  "This obsolete passage explains an earlier design that the revision drops entirely, together with its long justification about timeouts, retries and the order of acknowledgements. ";
interface Case {
  name: string;
  body: string;
  from: string;
  to: string;
  options?: string;
  packages?: string;
  before?: string;
  after?: string;
  removed?: string;
  added?: string;
  visual?: string;
  minimumPages?: number;
  relocated?: boolean;
  completeDisplay?: boolean;
  outside?: string[];
}
const cases: Case[] = [
  {
    name: "a frame does not join separate paragraphs into one text change",
    body: String.raw`\section{Framed text}
\noindent\fbox{\begin{minipage}{300pt}
Opening sentinel stays in the context.\par
${paragraph.repeat(3)}\par
\medskip
The protocol keeps oldvalue before committing.\par
\medskip
${paragraph.repeat(3)}\par
Closing sentinel stays in the context.
\end{minipage}}`,
    from: "oldvalue",
    to: "newvalue",
    removed: "oldvalue",
    added: "newvalue",
    outside: ["Opening sentinel", "Closing sentinel"],
  },
  {
    name: "matrix outlines stay whole when a word on the middle row changes",
    packages: "amsmath",
    body: String.raw`\section{Matrix}
Above sentinel stays in the context.
\[
 V = \begin{pmatrix}
 s & 0 & 0 \\
 0 & -s & 0 \\
 -s x_0 & s y_1 & 1
 \end{pmatrix},\qquad
 (u\ v\ 1) = (x\ y\ 1)V.
\]
Below sentinel stays in the context.`,
    from: "(x\\ y\\ 1)",
    to: "(z\\ y\\ 1)",
    completeDisplay: true,
  },
  {
    name: "large operators and their limits stay whole around a changed relation",
    packages: "amsmath",
    body: String.raw`\section{Operators}
Above sentinel stays in the context.
\[
 \sum_{i=0}^{\infty} x_i = \int_0^{\pi+2} f
\]
Below sentinel stays in the context.`,
    from: "x_i =",
    to: "x_i \\leq",
    completeDisplay: true,
  },
  {
    name: "two columns with a repeated sentence",
    options: "twocolumn",
    body: String.raw`\section{Columns}
Left column sentinel. The protocol uses an old invariant.
${paragraph.repeat(14)}
\newpage
Right column sentinel. The protocol uses an old invariant.
${paragraph.repeat(4)}`,
    from: "Right column sentinel. The protocol uses an old invariant.",
    to: "Right column sentinel. The protocol uses a stronger invariant.",
    before: "old invariant",
    after: "stronger invariant",
    removed: "old",
    added: "stronger",
  },
  {
    name: "footnote wraps at the bottom of a page",
    body: String.raw`\section{Footnotes}
${paragraph.repeat(6)}
The theorem has a caveat\footnote{The old caveat assumes reliable delivery. ${paragraph.repeat(2)}}.
${paragraph.repeat(2)}`,
    from: "The old caveat assumes",
    to: "The revised caveat assumes",
    before: "old caveat",
    after: "revised caveat",
    removed: "old",
    added: "revised",
  },
  {
    name: "ligatures and forced hyphenation",
    body: String.raw`\section{Words}
\begin{minipage}{130pt}
An efficient implementation supports affinity and offers effective synchronization.
\end{minipage}`,
    from: "efficient implementation",
    to: "flexible implementation",
    before: "efficient",
    after: "flexible",
    removed: "efficient",
    added: "flexible",
  },
  {
    name: "aligned formulas with a changed exponent",
    packages: "amsmath",
    body: String.raw`\section{Formula}
The bound follows from
\begin{align}
 f(x)&=x^2 + y^2,\\
 g(x)&=\frac{x+1}{y+1}.
\end{align}
The second formula remains unchanged.`,
    from: "x^2 + y^2",
    to: "x^3 + y^2",
    before: "2",
    after: "3",
    removed: "2",
    added: "3",
  },
  {
    name: "pure deletion at the end of a section",
    body: String.raw`\section{Deletion}
The protocol preserves the invariant.

This obsolete sentence should disappear.

\section{Next}
This unrelated sentinel must remain.`,
    from: "This obsolete sentence should disappear.\n",
    to: "",
    before: "obsolete sentence",
    removed: "obsolete",
  },
  {
    name: "duplicate paragraphs claim only their own source",
    body: String.raw`\section{Ownership}
First sentinel: The old invariant implies safety.
${paragraph}

${paragraph}

${paragraph}

Second sentinel: The old invariant implies safety.
${paragraph}`,
    from: "Second sentinel: The old invariant",
    to: "Second sentinel: The revised invariant",
    before: "Second sentinel",
    after: "Second sentinel",
    removed: "old",
    added: "revised",
  },
  {
    name: "a large float changes position after reflow",
    body: String.raw`\section{Floating}
${paragraph.repeat(35)}
\begin{figure}[tbp]
\centering\fbox{\rule{0pt}{220pt}\rule{250pt}{0pt}}
\caption{An unchanged floating diagram.}\label{fig:box}
\end{figure}
The old protocol accepts a command only after a majority confirms its entry.
${paragraph.repeat(6)}`,
    from: "The old protocol accepts a command only after a majority confirms its entry.",
    to: "The revised protocol accepts a command after a majority confirms it, keeping the safety invariant explicit even when a leader fails.",
    before: "old protocol",
    after: "revised protocol",
    removed: "old",
    added: "revised",
    minimumPages: 2,
  },
  {
    name: "explicit cross-page replacement",
    body: String.raw`\section{Page move}
${paragraph.repeat(3)}
The old protocol is safe.
`,
    from: "The old protocol is safe.",
    to: "\\newpage\nThe revised protocol is safe.",
    before: "old protocol",
    after: "revised protocol",
    removed: "old",
    added: "revised",
    relocated: true,
  },
  {
    name: "caption-only edit beside an unchanged drawing",
    body: String.raw`\section{Caption}
See Figure~\ref{fig:caption}.
\begin{figure}[h]
\centering\fbox{A diagram with unchanged labels}
\caption{The old protocol.}\label{fig:caption}
\end{figure}`,
    from: "\\caption{The old protocol.}",
    to: "\\caption{The revised protocol.}",
    before: "old protocol",
    after: "revised protocol",
    removed: "old",
    added: "revised",
  },
  {
    name: "color-only figure change",
    packages: "xcolor",
    body: String.raw`\section{Color}
\begin{figure}[h]
\centering{\color{red}\rule{100pt}{40pt}}
\caption{The same caption.}
\end{figure}`,
    from: "\\color{red}",
    to: "\\color{blue}",
    visual: "layout",
  },
  {
    name: "verbatim whitespace changes layout",
    body: String.raw`\section{Code}
\begin{verbatim}
if ready:
  commit()
\end{verbatim}`,
    from: "  commit()",
    to: "      commit()",
    visual: "layout",
  },
  {
    name: "restyled table keeps the sentence above it out of the crop",
    packages: "booktabs",
    body: String.raw`\section{Experiments}
We evaluate on three benchmarks: NarrativeQA, Qasper and a synthetic needle-in-a-haystack task.

\begin{table}[h]
\centering
\begin{tabular}{lccc}
\hline
Method & NarrativeQA & Qasper & Needle \\
\hline
Dense & 24.1 & 41.3 & 99.8 \\
Longformer & 21.7 & 38.9 & 92.1 \\
\hline
\end{tabular}
\caption{Results on three benchmarks.}
\end{table}

As shown in Table~1, our method is close to dense attention.`,
    from: String.raw`\hline
Method & NarrativeQA & Qasper & Needle \\
\hline
Dense & 24.1 & 41.3 & 99.8 \\
Longformer & 21.7 & 38.9 & 92.1 \\
\hline`,
    to: String.raw`\toprule
Method & NarrativeQA & Qasper & Needle \\
\midrule
Dense & \textbf{24.1} & \textbf{41.3} & \textbf{99.8} \\
Longformer & 21.7 & 38.9 & 92.1 \\
\bottomrule`,
    visual: "layout",
  },
  {
    name: "shortened paragraph leaves the next page",
    body: String.raw`\section{Break}
Opening sentinel line.

\vspace{580pt}

Final sentinel begins. ${paragraph.repeat(2)}${CUT.repeat(3)}Ending sentinel concludes.`,
    from: CUT.repeat(3),
    to: "",
  },
  {
    name: "swapped paragraphs show the moved one on both sides",
    body: String.raw`\section{Order}
${paragraph.repeat(2)}

Moved paragraph sentinel explains why replicas vote before they apply a command, and why the leader waits for a quorum.

Staying paragraph sentinel describes how followers acknowledge entries and how terms increase across elections.

${paragraph.repeat(2)}`,
    from: "Moved paragraph sentinel explains why replicas vote before they apply a command, and why the leader waits for a quorum.\n\nStaying paragraph sentinel describes how followers acknowledge entries and how terms increase across elections.",
    to: "Staying paragraph sentinel describes how followers acknowledge entries and how terms increase across elections.\n\nMoved paragraph sentinel explains why replicas vote before they apply a command, and why the leader waits for a quorum.",
    before: "Moved paragraph sentinel",
    after: "Moved paragraph sentinel",
  },
  {
    name: "paragraph boundary is not a no-op",
    body: String.raw`\section{Paragraphs}
The first paragraph states the invariant.

The second paragraph proves the invariant.`,
    from: "invariant.\n\nThe second",
    to: "invariant. The second",
    visual: "layout",
  },
  {
    name: "a table row on a later page",
    packages: "longtable",
    body: String.raw`\section{Long table}
\begin{longtable}{ll}
Index & State \\
\hline
${Array.from({ length: 85 }, (_, i) => `${i} & ${i === 70 ? "oldstate" : "unchanged"} \\\\`).join("\n")}
\end{longtable}`,
    from: "70 & oldstate",
    to: "70 & newstate",
    before: "oldstate",
    after: "newstate",
    removed: "oldstate",
    added: "newstate",
    minimumPages: 2,
  },
];
const normalized = (text: string) =>
  text
    .normalize("NFKC")
    .replace(/-\s*\n\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
function marked(strip: Strip, folder: string) {
  const svg = fs.readFileSync(path.join(folder, strip.src), "utf8"),
    rects = [
      ...svg.matchAll(
        /<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" fill="[^"]+" fill-opacity=".18"\/>/g,
      ),
    ].map((m) => [+m[1], +m[2], +m[1] + +m[3], +m[2] + +m[4]] as Rect);
  return (strip.text ?? [])
    .map((line) =>
      line.chars
        .map((c) =>
          rects.some((r) => containsCenter(r, c.rect)) ? c.text : " ",
        )
        .join(""),
    )
    .join("\n");
}
for (const scenario of cases)
  it.skipIf(!tex)(
    scenario.name,
    async () => {
      const f = new Fixture();
      const source = String.raw`\documentclass[${scenario.options ?? ""}]{article}
\usepackage[margin=50pt]{geometry}
${scenario.packages ? `\\usepackage{${scenario.packages}}` : ""}
\usepackage{hyperref}
\begin{document}
${scenario.body}
\end{document}
`;
      f.write("paper/main.tex", source);
      f.repo.run(["add", "."]);
      f.repo.run(["commit", "-qm", "Adversarial fixture"]);
      const app = f.app();
      try {
        const task = app.tasks.create("tricky");
        f.edit(task, "paper/main.tex", scenario.from, scenario.to);
        const job = app.publisher.submit(task.name);
        await app.publisher.join();
        const result = app.publisher.job(job.id);
        expect(result.status, JSON.stringify(result.result)).toBe("done");
        const detail = app.review.roundDetail(task.name, 1);
        const expected = Buffer.from(source.replace(scenario.from, scenario.to));
        expect(detail.units.length).toBeGreaterThan(0);
        expect(applyUnits(Buffer.from(source), expected, detail.units)).toEqual(expected);
        expect(revertUnits(Buffer.from(source), expected, detail.units)).toEqual(Buffer.from(source));
        for (const unit of detail.units) {
          expect(unit.visual).not.toBe("unmapped");
          if (scenario.visual) expect(unit.visual).toBe(scenario.visual);
        }
        const blocks = [
            ...detail.sections.flatMap((s) =>
              s.blocks.filter((b): b is ChangeBlock => b.kind === "change"),
            ),
            ...detail.loose,
          ],
          before = blocks.flatMap((b) => b.before),
          after = blocks.flatMap((b) => b.after),
          text = (strips: Strip[]) =>
            normalized(
              strips
                .flatMap((s) => s.text?.map((l) => l.text) ?? [])
                .join("\n"),
            ),
          folder = path.join(app.state, "rounds/tricky/001");
        expect(new Set(blocks.flatMap(block => block.units))).toEqual(new Set(detail.units.map(unit => unit.id)));
        if (scenario.before) expect(text(before)).toContain(scenario.before);
        if (scenario.after) expect(text(after)).toContain(scenario.after);
        for (const outside of scenario.outside ?? []) {
          expect(text(before)).not.toContain(outside);
          expect(text(after)).not.toContain(outside);
        }
        if (scenario.removed)
          expect(
            normalized(before.map((s) => marked(s, folder)).join("\n")),
          ).toContain(scenario.removed);
        if (scenario.added)
          expect(
            normalized(after.map((s) => marked(s, folder)).join("\n")),
          ).toContain(scenario.added);
        if (scenario.name.startsWith("two columns")) {
          expect(
            normalized(before.map((s) => marked(s, folder)).join("\n")),
          ).toBe("an old");
          expect(
            normalized(after.map((s) => marked(s, folder)).join("\n")),
          ).toBe("a stronger");
          // A page with two columns is cropped one column at a time.
          const context = detail.sections.flatMap((s) =>
            s.blocks.flatMap((b) => (b.kind === "context" ? [b.image] : [])),
          );
          for (const strip of [...before, ...after, ...context])
            expect(strip.width).toBeLessThan(320);
          for (const strip of after) expect(strip.left).toBeGreaterThan(280);
        }
        if (scenario.name.startsWith("swapped paragraphs")) {
          // Text that moved is shown where it was and where it is now; it
          // is not a reflow, which would hide the old side.
          for (const strips of [before, after]) {
            expect(text(strips)).toContain("Moved paragraph sentinel");
            expect(text(strips)).toContain("Staying paragraph sentinel");
          }
          expect(blocks.some((b) => "reflow" in b && b.reflow)).toBe(false);
          // It is drawn in blue on both sides, and the block says it moved.
          const blue = (strips: Strip[]) =>
            strips.some((s) =>
              fs
                .readFileSync(path.join(folder, s.src), "utf8")
                .includes('fill="#2563c9"'),
            );
          expect(blue(before)).toBe(true);
          expect(blue(after)).toBe(true);
          expect(blocks.some((b) => "moved" in b && b.moved)).toBe(true);
          for (const [side, strips] of [['old_text', before], ['new_text', after]] as const) {
            const unit = detail.units.find(unit => unit[side].includes('Moved paragraph sentinel'))!;
            const marks = strips.flatMap(strip => strip.marks ?? []).filter(mark => mark.unit === unit.id);
            expect(marks.length).toBeGreaterThan(0);
            expect(marks.every(mark => mark.kind === 'moved')).toBe(true);
          }
        }
        if (scenario.relocated)
          expect(before.some((a) => after.some((b) => a.page !== b.page))).toBe(
            true,
          );
        if (scenario.removed)
          expect(
            normalized(before.map((s) => marked(s, folder)).join("\n")).split(
              scenario.removed,
            ).length - 1,
          ).toBe(1);
        if (scenario.added)
          expect(
            normalized(after.map((s) => marked(s, folder)).join("\n")).split(
              scenario.added,
            ).length - 1,
          ).toBe(1);
        if (scenario.name.includes("duplicate")) {
          expect(text(before)).not.toContain("First sentinel");
          expect(text(after)).not.toContain("First sentinel");
        }
        if (scenario.name.startsWith("restyled table")) {
          expect(text(before)).not.toContain("We evaluate");
          expect(text(after)).not.toContain("We evaluate");
          // Restyled cells are the same words: no removed or added marks.
          expect(
            normalized(before.map((s) => marked(s, folder)).join("")),
          ).toBe("");
          expect(normalized(after.map((s) => marked(s, folder)).join(""))).toBe(
            "",
          );
        }
        if (scenario.name.startsWith("shortened paragraph")) {
          // The old paragraph ends on the next page; its review shows that
          // part too, though the new paragraph fits on one page.
          expect(before.some((s) => s.page === 2)).toBe(true);
          expect(after.every((s) => s.page === 1)).toBe(true);
          expect(text(before)).toContain("Ending sentinel concludes.");
          const removed = normalized(
            before.map((s) => marked(s, folder)).join("\n"),
          );
          expect(removed).toContain("obsolete");
          expect(removed).not.toContain("Ending");
        }
        if (scenario.name.includes("deletion"))
          expect(text(after)).not.toContain("obsolete");
        if (scenario.completeDisplay) {
          const builds = app.review.round(task.name, 1).summary.builds;
          for (const [key, strips] of [
            [builds[0], before],
            [builds.at(-1)!, after],
          ] as const) {
            const info = JSON.parse(
                fs.readFileSync(
                  path.join(app.state, "cache/builds", key, "result.json"),
                  "utf8",
                ),
              ),
              document = new PdfDocument(info.pdf);
            try {
              const page = document.page(0),
                above = page.lines.find((l) =>
                  l.text.includes("Above sentinel"),
                )!,
                below = page.lines.find((l) =>
                  l.text.includes("Below sentinel"),
                )!,
                top = above.rect[3] + 1,
                bottom = below.rect[1] - 1,
                scale = 4,
                image = page.raster(
                  [0, top, page.width, bottom],
                  scale,
                  true,
                  true,
                );
              // Count the actual painted pixels of the complete display,
              // independently of text boxes and the alignment's crop rules.
              let ink = 0,
                shown = 0;
              for (let y = 0; y < image.height; y++)
                for (let x = 0; x < image.width; x++) {
                  if (image.pixels[y * image.stride + x] >= 100) continue;
                  ink++;
                  const px = (x + 0.5) / scale,
                    py = top + (y + 0.5) / scale;
                  if (
                    strips.some(
                      (s) =>
                        s.page === 1 &&
                        px >= (s.left ?? 0) &&
                        px < (s.left ?? 0) + s.width &&
                        py >= (s.top ?? 0) &&
                        py < (s.top ?? 0) + s.height,
                    )
                  )
                    shown++;
                }
              expect(ink).toBeGreaterThan(0);
              expect(shown / ink).toBeGreaterThan(0.995);
              expect(text(strips)).not.toContain("sentinel");
            } finally {
              document.close();
            }
          }
        }
        // Independently extract both complete PDFs with Poppler, so an extraction mistake
        // in our MuPDF text layer cannot make a wrong expected phrase pass unnoticed.
        if (which("pdftotext")) {
          const builds = app.review.round(task.name, 1).summary.builds;
          for (const [key, expected] of [
            [builds[0], scenario.before],
            [builds.at(-1)!, scenario.after],
          ] as const) {
            const info = JSON.parse(
                fs.readFileSync(
                  path.join(app.state, "cache/builds", key, "result.json"),
                  "utf8",
                ),
              ),
              plain = run("pdftotext", [
                "-layout",
                info.pdf,
                "-",
              ]).stdout.toString();
            if (expected) expect(normalized(plain)).toContain(expected);
            if (scenario.minimumPages)
              expect(plain.split("\f").length - 1).toBeGreaterThanOrEqual(
                scenario.minimumPages,
              );
          }
        }
      } catch (error) {
        fs.cpSync(
          f.base,
          path.join(
            ROOT,
            ".cache/tricky-failures",
            scenario.name.replaceAll(" ", "-") + "-" + Date.now(),
          ),
          { recursive: true },
        );
        throw error;
      } finally {
        await f.close();
      }
    },
    120000,
  );
