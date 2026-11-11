// Where words picked on the PDF are in the LaTeX source. The printed text
// and its source differ in commands, braces, comments, hyphenation, spacing
// and ligatures, so both are compared by their letters and digits only, and
// a match is mapped back to characters of the source.

const letter = /[\p{L}\p{N}]/u;
const lettersOf = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** The letters of source text [from, to) outside commands and comments,
 *  with the source offset each came from. */
export function readable(text: string, from: number, to: number) {
  let letters = '';
  const at: number[] = [];
  for (let i = from; i < to; i++) {
    const c = text[i];
    if (c === '%') { const end = text.indexOf('\n', i); i = end < 0 || end > to ? to : end; continue; }
    if (c === '\\') {
      let j = i + 1;
      while (j < to && /[A-Za-z@]/.test(text[j])) j++;
      // A control symbol such as \% or \, is one character after the backslash.
      i = j === i + 1 ? i + 1 : j - 1;
      continue;
    }
    for (const part of c.normalize('NFKC').toLowerCase()) if (letter.test(part)) { letters += part; at.push(i); }
  }
  return { letters, at };
}

/** Character offsets of a picked passage within source text [from, to): the
 *  selected words, or with `word`, the clicked word after its `context` (the
 *  words before it on its printed line). Long selections whose middle differs
 *  (formulas, symbols) match by their ends. */
export function findPicked(text: string, [from, to]: [number, number], pick: { quote: string; word?: { text: string; context: string } }): [number, number] | null {
  const source = readable(text, from, to);
  const span = (index: number, length: number): [number, number] => [source.at[index], source.at[index + length - 1] + 1];
  if (pick.word) {
    const word = lettersOf(pick.word.text), context = lettersOf(pick.word.context).slice(-24);
    if (!word) return null;
    for (const before of [context, context.slice(-8), '']) {
      const index = source.letters.indexOf(before + word);
      if (index >= 0) return span(index + before.length, word.length);
    }
    return null;
  }
  const needle = lettersOf(pick.quote);
  if (!needle) return null;
  const whole = source.letters.indexOf(needle);
  if (whole >= 0) return span(whole, needle.length);
  if (needle.length < 12) return null;
  const head = needle.slice(0, 12), tail = needle.slice(-12), start = source.letters.indexOf(head);
  if (start < 0) return null;
  const end = source.letters.indexOf(tail, start + head.length);
  return end < 0 ? span(start, head.length) : [source.at[start], source.at[end + tail.length - 1] + 1];
}

/** The character range of lines [from, to) (0-based, end excluded). */
export function lineSpan(text: string, [from, to]: [number, number]): [number, number] {
  const offset = (line: number) => {
    let at = 0;
    for (let n = 0; n < line; n++) {
      const next = text.indexOf('\n', at);
      if (next < 0) return text.length;
      at = next + 1;
    }
    return at;
  };
  return [offset(from), offset(Math.max(to, from + 1))];
}
