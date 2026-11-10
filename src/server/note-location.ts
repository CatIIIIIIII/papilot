// Where a note on the PDF comes from in the LaTeX source. Reading the page
// takes a long paper hundreds of milliseconds, so this runs in the PDF
// reader's worker thread (see pdf-reader.ts), never on the server's event loop.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

type Rect = [number, number, number, number];
const exec = promisify(execFile);

// `synctex edit` maps a PDF position (big points from the top-left corner) to
// the source file and line that produced it.
export function parseSynctex(output: string) {
  const input = /^Input:(.*)$/m.exec(output)?.[1], line = Number(/^Line:(\d+)$/m.exec(output)?.[1]);
  return input && line > 0 ? { input: path.normalize(input), line } : null;
}

// The LaTeX the marked region came from, read from the exact tree that was
// compiled. Long ranges keep their first lines.
// Where one end of a selection sits in its printed line: the line's letters and
// the index of the marked letter among them.
export interface Anchor { line: string; at: number }
const letters = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// The printed line around a marked character, for settleLines.
export function anchor(chars: { text: string }[], index: number, end: boolean): Anchor | null {
  const line = letters(chars.map(c => c.text).join(''));
  if (!line) return null;
  const at = end ? letters(chars.slice(0, index + 1).map(c => c.text).join('')).length - 1 : letters(chars.slice(0, index).map(c => c.text).join('')).length;
  return { line, at: Math.min(Math.max(at, 0), line.length - 1) };
}

// SyncTeX records spaces and boxes rather than characters, so a word that
// starts a printed line is often credited to the source line before it, whose
// line break made the space. Settle each end of the selection by finding its
// printed line among the source lines around SyncTeX's answer; text that does
// not match, such as formulas, keeps SyncTeX's lines.
export function settleLines(source: string[], [start, end]: [number, number], first: Anchor | null, last: Anchor | null): [number, number] {
  const low = Math.max(1, start - 4), high = Math.min(source.length, end + 4);
  let text = '';
  const owner: number[] = [];
  for (let number = low; number <= high; number++) {
    const plain = letters(source[number - 1].replace(/(^|[^\\])%.*$/, '$1').replace(/\\[a-zA-Z@]+\*?/g, ' '));
    text += plain; owner.push(...Array<number>(plain.length).fill(number));
  }
  const distance = (line: number) => Math.max(0, start - line, line - end);
  const locate = (mark: Anchor | null) => {
    if (!mark) return null;
    // The whole printed line pins the place best; shorter context around the
    // mark still matches when part of the line does not appear in the source.
    for (const reach of [Infinity, 24, 10]) {
      const from = Math.max(0, mark.at - reach), needle = mark.line.slice(from, mark.at + reach + 1);
      let best: number | null = null;
      for (let index = text.indexOf(needle); index >= 0; index = text.indexOf(needle, index + 1)) {
        const line = owner[index + mark.at - from];
        if (best === null || distance(line) < distance(best)) best = line;
      }
      if (best !== null) return best;
    }
    return null;
  };
  const from = locate(first) ?? start, to = locate(last) ?? end;
  return from <= to ? [from, to] : [start, end];
}

export type LineOp = [string, number, number, number, number];
/** Lines `[start, end]` (1-based, inclusive) of `before`, followed into
 *  `after` through the opcodes between them. Edits elsewhere shift them; an
 *  edit inside stays inside, and lines added just outside stay outside. Null
 *  when the passage is gone, or when an edit crosses its first or last line:
 *  then the text that replaced it may be something else. */
export function followLines(ops: LineOp[], [start, end]: [number, number]): [number, number] | null {
  const map = (at: number, right: boolean) => {
    const places: number[] = [];
    for (const [kind, a, b, x, y] of ops) {
      if (at < a || at > b) continue;
      if (kind === 'equal') places.push(x + at - a);
      else if (a < at && at < b) return null;
      else places.push(...(a === b ? [x, y] : [at === a ? x : y]));
    }
    return places.length ? (right ? Math.min(...places) : Math.max(...places)) : null;
  };
  const from = map(start - 1, false), to = map(end, true);
  return from === null || to === null || to <= from ? null : [from + 1, to];
}

export function sourceExcerpt(file: string, [start, end]: [number, number], limit = 20) {
  if (!fs.existsSync(file)) return undefined;
  const lines = fs.readFileSync(file, 'utf8').split('\n').slice(start - 1, end).map(line => line.trimEnd());
  return (lines.length > limit ? [...lines.slice(0, limit), '…'] : lines).join('\n');
}

export interface MarkPage {
  bounds: Rect;
  lines: { chars: { text: string; rect: Rect }[] }[];
  text(clip: Rect): string;
}
export interface MarkRequest {
  pdf: string; page: number; rect: Rect; rects: Rect[]; selected: string;
  // The compiled copy's source folder, the paper's source folder within the
  // project, and the working tree the lines are followed into.
  root?: string; sourceDir?: string; working?: string;
}
export interface Located { quote: string; source: { file: string; lines: [number, number]; excerpt?: string } | null }

/** The text under the marked region of a PDF page and the source lines it
 *  came from: SyncTeX's answer for the first and last marked character of
 *  every line, settled on the printed text and followed into the working
 *  tree when that moved on since the build. Null when the page does not exist. */
export async function locateMark(
  document: { length: number; page(index: number): MarkPage },
  request: MarkRequest,
  { containsCenter, opcodesWithin }: { containsCenter: (clip: Rect, rect: Rect) => boolean; opcodesWithin: (a: string[], b: string[], timeout: number) => LineOp[] | null },
): Promise<Located | null> {
  const { pdf, page, rect, rects, selected } = request;
  if (!Number.isInteger(page) || page < 0 || page >= document.length) return null;
  const current = document.page(page), [x0, y0, x1, y1] = current.bounds, width = x1 - x0, height = y1 - y0;
  const toPage = (r: Rect): Rect => [x0 + r[0] * width, y0 + r[1] * height, x0 + r[2] * width, y0 + r[3] * height];
  const clips = (rects.length ? rects : [rect]).map(toPage);
  const quote = (selected || clips.map(clip => current.text(clip)).join(' ')).replace(/�/g, '').replace(/\s+/g, ' ').trim();
  // Ask SyncTeX about the first and last marked character of every line, so
  // the source range covers the whole selection rather than its first line.
  const points: [number, number][] = [], centre = (r: Rect): [number, number] => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
  let first: Anchor | null = null, last: Anchor | null = null;
  for (const line of current.lines) {
    const marked = line.chars.flatMap((c, index) => clips.some(clip => containsCenter(clip, c.rect)) ? [index] : []);
    if (!marked.length) continue;
    if (!first && !last) first = anchor(line.chars, marked[0], false);
    last = anchor(line.chars, marked[marked.length - 1], true);
    if (points.length >= 24) continue;
    points.push(centre(line.chars[marked[0]].rect));
    if (marked.length > 1) points.push(centre(line.chars[marked[marked.length - 1]].rect));
  }
  if (!points.length) points.push(...clips.slice(0, 12).map(centre));
  const hits = (await Promise.all(points.map(([x, y]) => exec('synctex', ['edit', '-o', `${page + 1}:${(x - x0).toFixed(1)}:${(y - y0).toFixed(1)}:${pdf}`]).then(r => parseSynctex(r.stdout), () => null)))).filter(hit => hit !== null);
  const files = new Map<string, { input: string; lines: number[] }>();
  for (const hit of hits) {
    const relative = path.relative(request.root || path.dirname(hit.input), hit.input);
    const file = path.posix.join(request.sourceDir || '', (relative.startsWith('..') ? path.basename(hit.input) : relative).split(path.sep).join('/'));
    files.set(file, { input: hit.input, lines: [...(files.get(file)?.lines || []), hit.line] });
  }
  const [file, found] = [...files].sort((a, b) => b[1].lines.length - a[1].lines.length)[0] || [];
  if (!file || !found) return { quote, source: null };
  const source = fs.existsSync(found.input) ? fs.readFileSync(found.input, 'utf8').split('\n') : [];
  const lines = settleLines(source, [Math.min(...found.lines), Math.max(...found.lines)], first, last);
  // The build compiled a copy of the source; the working tree may have
  // moved on since, by later edits or because these are older pages.
  const working = request.working && path.join(request.working, ...file.split('/'));
  if (working && path.resolve(working) !== path.resolve(found.input)) {
    if (!fs.existsSync(working)) return { quote, source: null };
    const now = fs.readFileSync(working, 'utf8').split('\n');
    if (now.length !== source.length || now.some((line, index) => line !== source[index])) {
      const ops = opcodesWithin(source, now, 1000);
      // A timed-out comparison cannot establish current source coordinates.
      const followed = ops && followLines(ops, lines);
      return { quote, source: followed && { file, lines: followed, excerpt: sourceExcerpt(working, followed) } };
    }
  }
  return { quote, source: { file, lines, excerpt: sourceExcerpt(found.input, lines) } };
}
