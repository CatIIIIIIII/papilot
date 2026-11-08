import { expect, it } from "vitest";
import {
  bodyFiles,
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
