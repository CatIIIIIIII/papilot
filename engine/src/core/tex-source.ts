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

/** The document body in reading order, with its forced page breaks: text
 *  before a forced break never shares a page with text after it. */
export interface ReadingOrder {
  /** The files the body reads. */
  files: Set<string>;
  /** Where a line (counted from 0) of a body file comes in reading order, or
   *  null when that is unknown: a file read more than once, or a line that
   *  also reads another file. */
  at(file: string, line: number): number | null;
  /** Whether a forced page break lies strictly between two positions. */
  broken(from: number, to: number): boolean;
}

const ONE_COLUMN =
  /\\documentclass\s*(?:\[[^\]]*\])?\s*\{\s*(?:article|report|book|memoir|scrartcl|scrreprt|scrbook|amsart|amsbook)\s*\}/;

export function readingOrder(
  read: (file: string) => string | null | undefined,
  main: string,
): ReadingOrder {
  const lines = new Map<string, Map<number, number>>(),
    unclear = new Map<string, Set<number>>(),
    repeated = new Set<string>(),
    breaks: number[] = [];
  let position = 0,
    // titlesec and KOMA-Script can turn chapters into run-in headings, and
    // \newpage only ends a column in two-column layouts.
    chapters = true,
    newpage = false;
  const walk = (file: string) => {
    if (lines.has(file)) {
      repeated.add(file);
      return;
    }
    const text = read(file);
    if (text == null) return;
    const source = structuralSource(text);
    let start = 0,
      end = source.length;
    if (file === main) {
      const opening = /\\begin\s*\{document\}/.exec(source);
      if (!opening) return;
      const preamble = source.slice(0, opening.index);
      chapters = !/\\(?:titleclass|RedeclareSectionCommands?)(?![A-Za-z@])/.test(preamble);
      newpage = ONE_COLUMN.test(preamble) && !/twocolumn|multicol/.test(source);
      start = opening.index + opening[0].length;
      const ending = /\\end\s*\{document\}/.exec(source.slice(start));
      if (ending) end = start + ending.index;
    }
    const own = new Map<number, number>(),
      odd = new Set<number>();
    lines.set(file, own);
    unclear.set(file, odd);
    let line = 0,
      offset = 0,
      cursor = 0;
    const lineAt = (index: number) => {
      for (; offset < index; offset++) if (source[offset] === "\n") line++;
      return line;
    };
    const take = (last: number) => {
      for (; cursor <= last; cursor++) own.set(cursor, position++);
    };
    cursor = lineAt(start);
    const pattern =
      /\\(input|include|subfile)\s*\{([^}]+)\}|\\(chapter|clearpage|cleardoublepage|newpage)(?![A-Za-z@])/g;
    pattern.lastIndex = start;
    for (let match = pattern.exec(source); match && match.index < end; match = pattern.exec(source)) {
      const at = lineAt(match.index);
      take(at);
      if (match[1]) {
        // Text before and after an input on its line reads around the file.
        odd.add(at);
        const child = sourceInputs(match[0], main)[0]?.file,
          include = match[1] === "include";
        if (include) breaks.push(position++);
        if (child) walk(child);
        if (include) breaks.push(position++);
      } else if (match[3] === "chapter" ? chapters : match[3] === "newpage" ? newpage : true)
        breaks.push(own.get(at)!);
    }
    take(lineAt(end));
  };
  walk(main);
  return {
    files: new Set(lines.keys()),
    at: (file, line) =>
      repeated.has(file) || unclear.get(file)?.has(line) ? null : (lines.get(file)?.get(line) ?? null),
    broken: (from, to) => breaks.some((at) => from < at && at < to),
  };
}
