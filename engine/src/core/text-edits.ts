import { opcodesWithin } from "./diff.ts";
import type { Op } from "../types.ts";

// Keep TeX arguments, math and comments atomic. Plain prose is compared by
// words (by character for CJK), with punctuation and spacing preserved exactly.
export function textTokens(text: string): string[] {
  const result: string[] = [];
  const groupEnd = (start: number, open: string, close: string) => {
    let depth = 1,
      i = start + 1;
    for (; i < text.length; i++) {
      if (text[i] === "\\") {
        i++;
        continue;
      }
      if (text[i] === open) depth++;
      else if (text[i] === close && --depth === 0) return i + 1;
    }
    return text.length;
  };
  const delimited = (start: number, delimiter: string) => {
    for (let i = start; i < text.length; i++) {
      if (text.startsWith(delimiter, i)) return i + delimiter.length;
      if (text[i] === "\\") i++;
    }
    return text.length;
  };
  for (let i = 0; i < text.length;) {
    const start = i;
    if (text[i] === "%") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end + 1;
    } else if (text[i] === "$") {
      const delimiter = text.startsWith("$$", i) ? "$$" : "$";
      i = delimited(i + delimiter.length, delimiter);
    } else if (text.startsWith("\\(", i) || text.startsWith("\\[", i))
      i = delimited(i + 2, text[i + 1] === "(" ? "\\)" : "\\]");
    else if (text[i] === "{") i = groupEnd(i, "{", "}");
    else if (text[i] === "\\") {
      const environment = text
        .slice(i)
        .match(
          /^\\begin\{((?:equation|align|alignat|gather|multline|flalign|eqnarray|displaymath|math|array|tabular|verbatim|Verbatim|lstlisting|minted|tikzpicture)\*?)\}/,
        );
      if (environment) {
        const delimiter = `\\end{${environment[1]}}`,
          end = text.indexOf(delimiter, i + environment[0].length);
        i = end < 0 ? text.length : end + delimiter.length;
        result.push(text.slice(start, i));
        continue;
      }
      const command =
        text.slice(i).match(/^\\(?:[a-zA-Z@]+\*?|[^])/u)?.[0] ?? "\\";
      i += command.length;
      if (
        /^\\(?:verb|lstinline)\*?$/.test(command) &&
        text[i] &&
        !/\s/.test(text[i])
      )
        i = delimited(i + 1, text[i]);
      else
        for (;;) {
          const next = i + (text.slice(i).match(/^\s*/)?.[0].length ?? 0);
          if (text[next] !== "{" && text[next] !== "[") break;
          i = groupEnd(next, text[next], text[next] === "{" ? "}" : "]");
        }
    } else {
      const token = text
        .slice(i)
        .match(
          /^(?:[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}_]+|\s+|[^])/u,
        )![0];
      i += token.length;
    }
    result.push(text.slice(start, i));
  }
  return result;
}

const offsets = (parts: string[]) => {
  const result = [0];
  for (const part of parts) result.push(result.at(-1)! + part.length);
  return result;
};

/** Exact UTF-16 ranges. An unchanged word separates independent decisions;
 * unchanged spaces inside a rewritten phrase do not. Bounded for large edits. */
export function textEdits(before: string, after: string): Op[] {
  // Anchor on unchanged logical lines first, without cutting a multiline TeX
  // token. A very large rewrite then falls back only for that passage.
  const chunks = (text: string) => {
    const result: string[] = [];
    let current = "";
    for (const token of textTokens(text)) {
      current += token;
      if (token.includes("\n")) {
        result.push(current);
        current = "";
      }
    }
    if (current) result.push(current);
    return result;
  };
  const a = chunks(before),
    b = chunks(after),
    left = offsets(a),
    right = offsets(b),
    ops = opcodesWithin(a, b, 100);
  if (!ops) return [["replace", 0, before.length, 0, after.length]];
  return ops.flatMap(([tag, i, j, x, y]) =>
    tag === "equal"
      ? []
      : wordEdits(a.slice(i, j).join(""), b.slice(x, y).join("")).map(
          ([kind, s, e, u, v]): Op => [
            kind,
            left[i] + s,
            left[i] + e,
            right[x] + u,
            right[x] + v,
          ],
        ),
  );
}

function wordEdits(before: string, after: string): Op[] {
  const a = textTokens(before),
    b = textTokens(after),
    words = (tokens: string[]) => tokens.filter(token => !/^\s+$/.test(token)),
    oldWords = words(a), newWords = words(b);
  // Rewrapping prose moves spaces/newlines, not its words. A token LCS may
  // otherwise match the newline and expose a word as an independent deletion
  // plus insertion. Keep the formatting-only rewrite together so accepting a
  // subset cannot silently remove or duplicate that word.
  if (oldWords.length === newWords.length && oldWords.every((word, i) => word === newWords[i])) {
    let start = 0, end = before.length, nextEnd = after.length;
    while (start < end && start < nextEnd && before[start] === after[start]) start++;
    while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd--; }
    if (start === end && start === nextEnd) return [];
    return [[start === end ? 'insert' : start === nextEnd ? 'delete' : 'replace', start, end, start, nextEnd]];
  }
  const left = offsets(a),
    right = offsets(b),
    ops = opcodesWithin(a, b, 100);
  if (!ops) return [["replace", 0, before.length, 0, after.length]];
  const result: Op[] = [];
  let join = false;
  for (const [tag, i, j, x, y] of ops) {
    if (tag === "equal") {
      const equal = a.slice(i, j).join("");
      join = !/[\p{L}\p{N}\n\\{}$]/u.test(equal);
      continue;
    }
    const edit: Op = [tag, left[i], left[j], right[x], right[y]],
      prior = result.at(-1);
    if (join && prior) {
      prior[2] = edit[2];
      prior[4] = edit[4];
      prior[0] =
        prior[1] === prior[2]
          ? "insert"
          : prior[3] === prior[4]
            ? "delete"
            : "replace";
    } else result.push(edit);
    join = false;
  }
  return result;
}

/** Merge disjoint word edits when Git's line merge cannot. A shared insertion
 * point or overlapping replacement remains a conflict; never pick a winner. */
export function mergeText(
  ours: Buffer,
  base: Buffer,
  theirs: Buffer,
): Buffer | null {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let a: string, b: string, c: string;
  try {
    [a, b, c] = [ours, base, theirs].map((data) => decoder.decode(data));
  } catch {
    return null;
  }
  const own = textEdits(b, a),
    incoming = textEdits(b, c);
  const changes = own.map((op) => ({
    start: op[1],
    end: op[2],
    text: a.slice(op[3], op[4]),
  }));
  for (const [, start, end, x, y] of incoming) {
    const text = c.slice(x, y);
    if (
      changes.some((e) => e.start === start && e.end === end && e.text === text)
    )
      continue;
    if (
      changes.some((e) =>
        start === end || e.start === e.end
          ? start <= e.end && e.start <= end
          : start < e.end && e.start < end,
      )
    )
      return null;
    changes.push({ start, end, text });
  }
  for (const edit of changes.sort((p, q) => q.start - p.start))
    b = b.slice(0, edit.start) + edit.text + b.slice(edit.end);
  return Buffer.from(b);
}
