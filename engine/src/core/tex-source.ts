import path from "node:path";

// A closing bracket inside a braced option value does not end the options.
function optionsEnd(text: string, start: number): number {
  let depth = 0;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "%") {
      const newline = text.indexOf("\n", i);
      if (newline < 0) return -1;
      i = newline;
    } else if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
    else if (text[i] === "]" && depth === 0) return i + 1;
  }
  return -1;
}

// Hide comments and literal examples while retaining source offsets and lines.
// The remaining text is for structural discovery, never for compiling TeX.
export function structuralSource(text: string): string {
  const chars = text.split("");
  const hide = (start: number, end: number) => {
    for (let i = start; i < end; i++)
      if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
  };
  for (let i = 0; i < text.length;) {
    if (text[i] === "%") {
      const end = text.indexOf("\n", i);
      hide(i, end < 0 ? text.length : end);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (text[i] !== "\\") {
      i++;
      continue;
    }
    const command = /^\\([A-Za-z@]+|[^\r\n])/.exec(text.slice(i));
    if (!command) {
      i++;
      continue;
    }
    if (command[1].length === 1 && !/[A-Za-z@]/.test(command[1])) {
      hide(i, i + command[0].length);
      i += command[0].length;
      continue;
    }
    const environment =
      /^\\begin\s*\{(verbatim\*?|Verbatim\*?|BVerbatim\*?|LVerbatim\*?|lstlisting|minted|comment)\}/.exec(
        text.slice(i),
      );
    if (environment) {
      const ending = new RegExp(
        "\\\\end\\s*\\{" + environment[1].replace("*", "\\*") + "\\}",
        "g",
      );
      ending.lastIndex = i + environment[0].length;
      const match = ending.exec(text),
        end = match ? ending.lastIndex : text.length;
      hide(i, end);
      i = end;
      continue;
    }
    if (["verb", "Verb", "lstinline"].includes(command[1])) {
      let at = i + command[0].length;
      if (text[at] === "*") at++;
      if (command[1] !== "verb") {
        while (at < text.length && /\s/.test(text[at])) at++;
        if (text[at] === "[") {
          const end = optionsEnd(text, at);
          if (end >= 0) at = end;
        }
        while (at < text.length && /\s/.test(text[at])) at++;
      }
      const delimiter = text[at];
      if (delimiter && !/\s/.test(delimiter)) {
        // Only lstinline has a braced form. verb and Verb close with the
        // same delimiter they opened with, including an opening brace.
        const closing =
            command[1] === "lstinline" && delimiter === "{" ? "}" : delimiter,
          close = text.indexOf(closing, at + 1),
          newline = text.indexOf("\n", at + 1);
        const end =
          close >= 0 && (newline < 0 || close < newline)
            ? close + 1
            : newline < 0
              ? text.length
              : newline;
        hide(i, end);
        i = end;
        continue;
      }
    }
    i += command[0].length;
  }
  return chars.join("");
}

export function sourceInputs(source: string, main: string) {
  const result: { file: string; line: number }[] = [];
  for (const match of source.matchAll(
    /\\(?:input|include|subfile)\s*\{([^}]+)\}/g,
  )) {
    const value = match[1].trim();
    if (!value || /[\\#]/.test(value) || path.posix.isAbsolute(value)) continue;
    let file = path.posix.normalize(
      path.posix.join(path.posix.dirname(main), value),
    );
    if (file === ".." || file.startsWith("../")) continue;
    if (!path.posix.extname(file)) file += ".tex";
    result.push({
      file,
      line: source.slice(0, match.index).split("\n").length,
    });
  }
  return result;
}

// Body membership is independent of the optional section outline. Inputs may
// occur after text, several times on one line, or inside a frame command.
export function bodyFiles(
  read: (file: string) => string | null | undefined,
  main: string,
): string[] {
  const files = new Set<string>();
  const walk = (file: string) => {
    if (files.has(file)) return;
    const text = read(file);
    if (text == null) return;
    let source = structuralSource(text);
    if (file === main) {
      const opening = /\\begin\s*\{document\}/.exec(source);
      if (!opening) return;
      source = source.slice(opening.index + opening[0].length);
      const ending = /\\end\s*\{document\}/.exec(source);
      if (ending) source = source.slice(0, ending.index);
    }
    files.add(file);
    for (const input of sourceInputs(source, main)) walk(input.file);
  };
  walk(main);
  return [...files].sort();
}
