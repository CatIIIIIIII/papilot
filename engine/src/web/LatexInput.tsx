import { useLayoutEffect, useMemo, useRef, type RefObject, type TextareaHTMLAttributes } from "react";

type Token = { text: string; kind?: "command" | "comment" | "math" | "bracket" | "parameter" };
// A lexical view only: the textarea remains the source of truth. Commands
// consume escaped %, $ and braces before those can act as delimiters.
export function latexTokens(source: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\\verb\*?([^a-zA-Z\s])|\\(?:[a-zA-Z@]+\*?|[^\r\n])|%[^\r\n]*|\$\$?|#[1-9]|[{}\[\]&_^~]/g;
  let offset = 0, math = "";
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    if (match.index > offset) tokens.push({ text: source.slice(offset, match.index), ...(math ? { kind: "math" } : {}) });
    let text = match[0], kind: Token["kind"];
    if (text.startsWith("\\verb") && match[1]) {
      const end = source.indexOf(match[1], pattern.lastIndex);
      const line = source.indexOf("\n", pattern.lastIndex);
      const stop = end >= 0 && (line < 0 || end < line) ? end + 1 : line < 0 ? source.length : line;
      text = source.slice(match.index, stop); pattern.lastIndex = stop;
      kind = "command";
    } else if (text.startsWith("%")) kind = "comment";
    else if (text.startsWith("$") || ["\\(", "\\)", "\\[", "\\]"].includes(text)) {
      kind = "math";
      if (math === text || text === "\\)" || text === "\\]") math = "";
      else math = text;
    } else if (text.startsWith("\\")) kind = "command";
    else if (text.startsWith("#")) kind = "parameter";
    else kind = "bracket";
    tokens.push({ text, kind }); offset = pattern.lastIndex;
  }
  if (offset < source.length) tokens.push({ text: source.slice(offset), ...(math ? { kind: "math" } : {}) });
  return tokens;
}

export function LatexInput({ inputRef, value, ...props }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value"> & {
  inputRef: RefObject<HTMLTextAreaElement | null>; value: string;
}) {
  const backdrop = useRef<HTMLPreElement>(null);
  const tokens = useMemo(() => latexTokens(value), [value]);
  const sync = () => {
    const input = inputRef.current, pre = backdrop.current;
    if (!input || !pre) return;
    // Match the usable width exactly, including classic scrollbars. Native
    // resizing, line wrapping and scrolling then keep the caret aligned.
    pre.style.width = `${input.clientWidth}px`;
    pre.style.height = `${input.clientHeight}px`;
    pre.scrollTop = input.scrollTop; pre.scrollLeft = input.scrollLeft;
  };
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const observer = new ResizeObserver(sync); observer.observe(input); sync();
    return () => observer.disconnect();
  }, [inputRef]);
  useLayoutEffect(sync, [value]);
  return <div className="source-code latex-input">
    <pre ref={backdrop} className="latex-highlight" aria-hidden="true"><code>{tokens.map((token, index) => token.kind
      ? <span key={index} className={`latex-${token.kind}`}>{token.text}</span> : token.text)}{"\u200b"}</code></pre>
    <textarea {...props} ref={inputRef} value={value} onScroll={sync}/>
  </div>;
}
