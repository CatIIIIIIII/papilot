import { expect, it } from "vitest";
import {
  bodyFiles,
  readingOrder,
  sourceInputs,
  structuralSource,
} from "../../src/core/tex-source.ts";

it.each([
  String.raw`\Verb[fontsize=\small]|\frame{example}|`,
  String.raw`\verb{\frame{`,
  String.raw`\lstinline[language={[LaTeX]TeX}]|\frame{example}|`,
  String.raw`\lstinline{example}`,
])("preserves real commands after inline code: %s", (literal) => {
  const text = `${literal} \\end{itemize} \\input{actual}`;
  const source = structuralSource(text);
  expect(source.length).toBe(text.length);
  expect(source).not.toContain("\\frame");
  expect(source).toContain("\\end{itemize}");
  expect(sourceInputs(source, "paper/main.tex")).toEqual([
    { file: "paper/actual.tex", line: 1 },
  ]);
});

it("ignores literal commands while preserving source lines and offsets", () => {
  const text = String.raw`% \input{comment}
\verb|\frame{fake}| \lstinline[language=TeX]|\input{inline}|
\begin{verbatim}
\begin{frame}
\input{example}
\end{verbatim}
\begin{lstlisting}
\frame{example}
\end{lstlisting}
Text. \input{actual}`;
  const source = structuralSource(text);
  expect(source.length).toBe(text.length);
  expect([...source.matchAll(/\n/g)].map((m) => m.index)).toEqual(
    [...text.matchAll(/\n/g)].map((m) => m.index),
  );
  expect(source).not.toContain("\\frame");
  expect(source).not.toContain("\\begin");
  expect(sourceInputs(source, "paper/main.tex")).toEqual([
    { file: "paper/actual.tex", line: 10 },
  ]);
});

it("discovers inline and multiple inputs independently of headings, excluding preamble and examples", () => {
  const files: Record<string, string> = {
    "main.tex": String.raw`\input{preamble}
\begin{document} Prefix. \input{one}\input{two}
\verb|\input{example}|
\end{document}\input{after}`,
    "one.tex": "More text. \\input{two}",
    "two.tex": "\\input{one}",
    "preamble.tex": "Preamble.",
    "example.tex": "Example.",
    "after.tex": "After.",
  };
  expect(bodyFiles((file) => files[file], "main.tex")).toEqual([
    "main.tex",
    "one.tex",
    "two.tex",
  ]);
});

it("distinguishes escaped percent from a comment after a line break command", () => {
  const source =
    structuralSource(String.raw`\% visible \input{one} \\% \input{hidden}
\input{two}`);
  expect(sourceInputs(source, "main.tex").map((i) => i.file)).toEqual([
    "one.tex",
    "two.tex",
  ]);
});

it("orders the body's lines through its inputs and finds forced page breaks", () => {
  const files: Record<string, string> = {
    "paper/main.tex": "\\documentclass{report}\n\\newcommand{\\x}{\\clearpage}\n\\begin{document}\nFront.\n\\include{chapters/one}\n\\include{chapters/two}\n\\end{document}\n",
    "paper/chapters/one.tex": "\\chapter{One}\nFirst.\n\\input{chapters/one-a}\nAfter the input.\n\\newpage\nNext page.\n",
    "paper/chapters/one-a.tex": "Section text.\n% \\clearpage\nMore text.\n",
    "paper/chapters/two.tex": "Second.\n",
  };
  const order = readingOrder((file) => files[file], "paper/main.tex"),
    at = (file: string, line: number) => order.at(`paper/${file}`, line)!;
  expect([...order.files].sort()).toEqual(Object.keys(files).sort());
  // The preamble is not body text, and a line that reads a file has no single place.
  expect(order.at("paper/main.tex", 1)).toBeNull();
  expect(order.at("paper/chapters/one.tex", 2)).toBeNull();
  const sequence = [at("main.tex", 3), at("chapters/one.tex", 1), at("chapters/one-a.tex", 0), at("chapters/one-a.tex", 2),
    at("chapters/one.tex", 3), at("chapters/one.tex", 5), at("chapters/two.tex", 0)];
  expect([...sequence].sort((a, b) => a - b)).toEqual(sequence);
  expect(order.broken(at("main.tex", 3), at("chapters/one.tex", 1))).toBe(true);
  // A commented page break does not count.
  expect(order.broken(at("chapters/one.tex", 1), at("chapters/one.tex", 3))).toBe(false);
  expect(order.broken(at("chapters/one.tex", 3), at("chapters/one.tex", 5))).toBe(true);
  expect(order.broken(at("chapters/one.tex", 5), at("chapters/two.tex", 0))).toBe(true);
});

it("counts only page breaks the layout forces", () => {
  const breaks = (main: string, body: string) => {
    const order = readingOrder((file) => (file === "main.tex" ? `${main}\n\\begin{document}\nBefore.\n${body}\nAfter.\n\\end{document}\n` : null), "main.tex");
    const opening = main.split("\n").length;
    return order.broken(order.at("main.tex", opening + 1)!, order.at("main.tex", opening + 3)!);
  };
  expect(breaks("\\documentclass{article}", "\\newpage")).toBe(true);
  // \newpage ends only a column in two columns, and an unknown class may have them.
  expect(breaks("\\documentclass[twocolumn]{article}", "\\newpage")).toBe(false);
  expect(breaks("\\documentclass{IEEEtran}", "\\newpage")).toBe(false);
  expect(breaks("\\documentclass{IEEEtran}", "\\clearpage")).toBe(true);
  expect(breaks("\\documentclass{report}", "\\chapter{Next}")).toBe(true);
  expect(breaks("\\documentclass{report}\n\\usepackage{titlesec}\n\\titleclass{\\chapter}{straight}", "\\chapter{Next}")).toBe(false);
  // A file read twice has no single place.
  const twice = readingOrder((file) => (file === "main.tex" ? "\\begin{document}\n\\input{a}\n\\input{a}\n\\end{document}\n" : "Text.\n"), "main.tex");
  expect(twice.at("a.tex", 0)).toBeNull();
});
