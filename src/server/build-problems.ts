import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { countProblems, type BuildProblem } from '../shared.ts';

const exec = promisify(execFile);

// A problem as read from the log: `input` is the file as TeX named it, relative
// to the directory TeX ran in. It never leaves the server.
export interface LogProblem extends Omit<BuildProblem, 'file' | 'page' | 'rect'> { input?: string; occurrence?: number }
export interface StoredProblem extends BuildProblem { source?: string; occurrence?: number }
export { countProblems };

// Overfull lines narrower than this are invisible in print.
export const OVERFULL_MIN_PT = 1;
// Locating runs SyncTeX once or twice per problem; a paper with more problems
// lists the rest without a page, starting with the least important.
export const LOCATE_LIMIT = 300;
const WRAP = 79;
const utf8Length = (lead: number) => lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;

// TeX breaks every log line at 79 columns, even inside file names. pdfTeX
// counts bytes and may cut a character in two, LuaTeX breaks early rather than
// cut one, and XeTeX counts characters. Rejoin the pieces on the raw bytes,
// before decoding splits a character for good.
export function unwrapLog(input: string | Buffer) {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input, raw: Buffer[] = [];
  for (let start = 0, i = 0; i <= bytes.length; i++) {
    if (i < bytes.length && bytes[i] !== 0x0a) continue;
    raw.push(bytes.subarray(start, i > start && bytes[i - 1] === 0x0d ? i - 1 : i)); start = i + 1;
  }
  const out: string[] = [];
  let parts: Buffer[] = [];
  for (let k = 0; k < raw.length; k++) {
    const line = raw[k], next = raw[k + 1], text = line.toString('utf8');
    parts.push(line);
    const wrapped = next !== undefined && (line.length === WRAP || [...text].length === WRAP
      || (line.length < WRAP && next.length > 0 && next[0] >= 0xc0 && line.length + utf8Length(next[0]) > WRAP)
      // Text decoded earlier keeps each half of a cut character as U+FFFD.
      || (text.endsWith('�') && next.toString('utf8').startsWith('�')));
    if (!wrapped) { out.push(parts.length === 1 ? text : Buffer.concat(parts).toString('utf8')); parts = []; }
  }
  if (parts.length) out.push(Buffer.concat(parts).toString('utf8'));
  return out;
}

const looksLikeFile = (name: string) => /^(?:\.{1,2}\/|\/|[A-Za-z]:[\\/])/.test(name) || /\.[A-Za-z][\w-]*$/.test(name);
const IGNORED = [
  /^There (?:were|was) (?:undefined|multiply)/, /^Rerun to get/, /Label\(s\) may have changed/, /^Please (?:\(re\))?run/i,
  /^Writing or overwriting file/, /^File [`'][^']+' already exists on the system/, /^Unused global option/,
];
// The source context TeX prints after an error or a pdfTeX warning: a line
// starting "<to be read again> " or "l.12 " quotes the source up to where TeX
// stopped, cut on the left, so its parentheses may be unmatched. The indented
// line below it continues the source and then TeX's own output, which can
// close and open files, so that one is read as usual.
const CONTEXT = /^(?:<[a-z*][a-z ]*>|l\.\d+) /;

// TeX reports which file it is reading with "(name" and ")" around everything
// that file prints. Only a "(" followed by a file that exists opens a file, so
// parentheses in messages and wrapped text keep the stack balanced but never
// change the current file. `opened` collects every file TeX read.
export function parseLatexLog(text: string | Buffer, isFile: (name: string) => boolean = () => true, opened?: Set<string>): LogProblem[] {
  const lines = unwrapLog(text), stack: (string | null)[] = [], found: LogProblem[] = [], seen = new Set<string>(), occurrences = new Map<string, number>();
  const current = () => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i]) return stack[i]!; return undefined; };
  const add = (problem: LogProblem) => {
    // Keep the position among all marks on the line, before repeated keys
    // collapse into one row. In a,a,b, b is still the third printed mark.
    if (problem.kind === 'reference' || problem.kind === 'citation') {
      const line = JSON.stringify([problem.input, problem.line, problem.kind]);
      problem.occurrence = occurrences.get(line) || 0;
      occurrences.set(line, problem.occurrence + 1);
    }
    const id = JSON.stringify([problem.kind, problem.key, problem.input, problem.line, problem.end, problem.message]);
    if (!seen.has(id)) { seen.add(id); found.push(problem); }
  };
  // pdfTeX prints a name with spaces unquoted, so the longest run of the line
  // that names an existing file wins.
  const fileAt = (rest: string): [string, number] | null => {
    const quoted = /^"([^"]+)"/.exec(rest);
    if (quoted) return isFile(quoted[1]) ? [quoted[1], quoted[0].length] : null;
    const run = /^[^()[\]{}<>"]*/.exec(rest.slice(0, 512))![0];
    if (!run || /^\s/.test(run)) return null;
    const cuts = [run.length];
    for (let at = run.lastIndexOf(' '); at > 0; at = run.lastIndexOf(' ', at - 1)) cuts.push(at);
    for (const cut of cuts) {
      const name = run.slice(0, cut).trimEnd();
      if (name && looksLikeFile(name) && isFile(name)) return [name, name.length];
    }
    return null;
  };
  const scan = (line: string) => {
    for (let j = 0; j < line.length; j++) {
      if (line[j] === ')') { stack.pop(); continue; }
      if (line[j] !== '(') continue;
      const file = fileAt(line.slice(j + 1));
      if (file) { stack.push(file[0]); opened?.add(file[0]); j += file[1]; } else stack.push(null);
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // file:line: message (from -file-line-error) or "! message". The file may
    // be one TeX generated, such as the .bbl, which a failed build has removed.
    const located = /^(.+?):(\d+): (.*)$/.exec(line);
    const errorFile = located && (located[1] === current() || looksLikeFile(located[1])) ? located : null;
    if (errorFile || line.startsWith('! ')) {
      let message = errorFile ? errorFile[3] : line.slice(2), last = line, end = i + 1;
      for (; end < lines.length && end < i + 20; end++) {
        const next = lines[end];
        if (!next.trim() || next.startsWith('! ') || /^(?:See |Type |l\.\d+ |\s*\.\.\.|\s*<)/.test(next) || /^(.+?):(\d+): /.test(next)) break;
        message += (last.length >= WRAP ? '' : ' ') + next; last = next;
      }
      let context = -1;
      for (let k = end; k < Math.min(lines.length, end + 12); k++) if (/^l\.\d+ /.test(lines[k])) { context = k; break; }
      message = message.replace(/\s+/g, ' ').trim();
      if (!/==> Fatal error occurred|^Emergency stop/.test(message)) {
        const missing = /File [`']([^']+)' not found/.exec(message);
        add({
          kind: missing ? 'missing-file' : 'error', severity: 'error', message, key: missing?.[1],
          input: errorFile ? errorFile[1] : current(), line: errorFile ? Number(errorFile[2]) : context >= 0 ? Number(/^l\.(\d+)/.exec(lines[context])![1]) : undefined,
        });
      }
      // Help text and the quoted source are TeX's commentary, not file events.
      i = context >= 0 ? context : end - 1;
      continue;
    }
    if (CONTEXT.test(line)) continue;
    const warning = /^(LaTeX|Package|Class|Module)(?: (\S+))? Warning: (.*)$|^(pdfTeX) warning(?: \([^)]*\))?: (.*)$/i.exec(line);
    if (warning) {
      const owner = warning[2] || '', isLatex = warning[1] === 'LaTeX';
      let message = warning[3] ?? warning[5], end = i + 1;
      // Continuation lines start with "(package)" or, for LaTeX, an indent.
      for (; end < lines.length; end++) {
        const next = lines[end], prefix = owner ? `(${owner})` : '';
        if (prefix && next.startsWith(prefix)) message += ' ' + next.slice(prefix.length).trim();
        else if (isLatex && !owner && /^\s{4,}\S/.test(next)) message += ' ' + next.trim();
        else break;
      }
      i = end - 1;
      message = message.replace(/\s+/g, ' ').trim();
      if (owner === 'Font' || IGNORED.some(pattern => pattern.test(message))) continue;
      const inputLine = /on input line (\d+)/.exec(message), at = inputLine ? Number(inputLine[1]) : undefined;
      const reference = /^Reference [`']([^']+)' on page \S+ undefined/.exec(message);
      const citation = /Citation [`']([^']+)'(?: on page \S+)? undefined/.exec(message);
      const label = /^Label [`']([^']+)' multiply defined/.exec(message);
      if (reference) add({ kind: 'reference', severity: 'warning', message, key: reference[1], input: current(), line: at });
      else if (citation) add({ kind: 'citation', severity: 'warning', message, key: citation[1], input: current(), line: at });
      // cleveref repeats every label as `name@cref`; the user's label is reported already.
      else if (label) { if (!label[1].includes('@')) add({ kind: 'label', severity: 'warning', message, key: label[1] }); }
      else add({ kind: 'other', severity: 'minor', message: `${owner && !isLatex ? owner + ': ' : ''}${message}`, input: current(), line: at });
      continue;
    }
    const box = /^(Overfull|Underfull) \\([hv])box \((?:badness \d+|([\d.]+)pt too (?:wide|high))\)(?: (?:in paragraph|in alignment|detected) at lines? (\d+)(?:--(\d+))?)?/.exec(line);
    if (box) {
      const amount = Number(box[3]);
      if (box[1] === 'Overfull' && amount >= OVERFULL_MIN_PT && box[4]) {
        const start = Number(box[4]), stop = box[5] ? Number(box[5]) : start;
        add({ kind: 'overfull', severity: 'minor', message: line.trim(), amount: Math.round(amount * 10) / 10, input: current(), line: start, end: stop > start ? stop : undefined });
      }
      // The box's contents follow until a blank line; their text has stray parentheses.
      while (i + 1 < lines.length && lines[i + 1].trim()) i++;
      continue;
    }
    const glyph = /^Missing character: There is no (.+?) in font (.+?)!/.exec(line);
    if (glyph) { add({ kind: 'glyph', severity: 'warning', message: line.trim(), key: glyph[1], input: current() }); continue; }
    scan(line);
  }
  // A remark repeated for many objects, such as pdfTeX's duplicate link
  // targets for every equation, is listed once with how often it occurred.
  const remarks = new Map<string, LogProblem>();
  return found.filter(problem => {
    if (problem.kind !== 'other') return true;
    const shape = problem.message.replace(/\{[^{}]*\}/g, '{}').replace(/[`'][^`']*'/g, "''").replace(/\d+/g, '#');
    const first = remarks.get(shape);
    if (!first) { remarks.set(shape, problem); return true; }
    first.count = (first.count || 1) + 1;
    return false;
  });
}

// The log without the build folder's path or the home directory.
export function scrubLog(text: string, folder?: string, home = os.homedir()) {
  if (folder && folder.length > 1) text = text.split(folder).join('…');
  if (home && home.length > 1) text = text.split(home + path.sep).join('~' + path.sep);
  return text;
}

const stripComments = (line: string) => line.replace(/(^|[^\\])%.*$/, '$1');
// Files TeX writes for itself: the build folder and auxiliary files. A problem
// reported in one has no place in the manuscript to show.
const GENERATED = new Set(['.aux', '.bbl', '.toc', '.lof', '.lot', '.loa', '.out', '.ind', '.idx', '.gls', '.glo', '.nls', '.brf', '.nav', '.snm', '.vrb', '.bcf']);

// Where every problem is in the manuscript. TeX names files relative to the
// directory it ran in; the paper shows them relative to its repository, like
// note sources. A label defined twice is listed at each definition among the
// files TeX read.
export function collectProblems(log: string | Buffer, { cwd, root, sourceDir, outDir = path.join(cwd, 'build') }: { cwd: string; root: string; sourceDir: string; outDir?: string }): StoredProblem[] {
  const resolve = (name: string) => path.resolve(cwd, name), known = new Map<string, boolean>(), opened = new Set<string>();
  const isFile = (name: string) => {
    let result = known.get(name);
    if (result === undefined) { try { result = fs.statSync(resolve(name)).isFile(); } catch { result = false; } known.set(name, result); }
    return result;
  };
  const parsed = parseLatexLog(log, isFile, opened);
  const display = (absolute: string) => {
    const relative = path.relative(root, absolute);
    return relative.startsWith('..') || path.isAbsolute(relative) ? undefined : path.posix.join(sourceDir || '', relative.split(path.sep).join('/'));
  };
  const generated = (absolute: string) => {
    const inside = path.relative(outDir, absolute);
    return (!inside.startsWith('..') && !path.isAbsolute(inside)) || GENERATED.has(path.extname(absolute)) || absolute.endsWith('.run.xml');
  };
  let sources: { file: string; lines: string[] }[] | null = null;
  const output: StoredProblem[] = [];
  for (const { input, ...problem } of parsed) {
    if (problem.kind === 'label' && problem.key) {
      sources ??= [...opened].map(resolve).filter(file => file.endsWith('.tex') && display(file) !== undefined && !generated(file)).flatMap(file => {
        try { return [{ file, lines: fs.readFileSync(file, 'utf8').split('\n') }]; } catch { return []; }
      });
      const needle = `\\label{${problem.key}}`, places: StoredProblem[] = [];
      for (const { file, lines } of sources) lines.forEach((text, index) => {
        if (stripComments(text).includes(needle)) places.push({ ...problem, file: display(file), line: index + 1, source: file });
      });
      output.push(...(places.length ? places : [problem]));
      continue;
    }
    const absolute = input ? resolve(input) : undefined;
    if (absolute && generated(absolute)) {
      // An error in, say, the .bbl names that file so its cause can be traced.
      const named = problem.severity === 'error' ? { message: `${path.basename(absolute)}${problem.line ? ':' + problem.line : ''}: ${problem.message}` } : {};
      output.push({ ...problem, ...named, line: undefined, end: undefined });
      continue;
    }
    const file = absolute ? display(absolute) : undefined;
    output.push(file ? { ...problem, file, source: absolute } : { ...problem, line: undefined, end: undefined });
  }
  return output;
}

interface SyncBox { page: number; x: number; y: number; h: number; v: number; W: number; H: number }
// `synctex view` lists one record per box: the point it names (x, y) and the
// box itself, h from the left and v at its baseline, W wide and H tall.
export function parseSynctexView(output: string): SyncBox[] {
  const boxes: Partial<SyncBox>[] = [];
  for (const line of output.split('\n')) {
    const match = /^(Page|x|y|h|v|W|H):(-?[\d.]+)\s*$/.exec(line);
    if (!match) continue;
    if (match[1] === 'Page') boxes.push({ page: Number(match[2]) - 1 });
    else if (boxes.length) (boxes[boxes.length - 1] as Record<string, number>)[match[1]] = Number(match[2]);
  }
  return boxes.filter((box): box is SyncBox => ['page', 'x', 'y', 'h', 'v', 'W', 'H'].every(key => Number.isFinite((box as Record<string, number>)[key])));
}

interface PageText { width: number; height: number; bounds: number[]; search(needle: string): number[][] }
// Put each problem on the page SyncTeX names. A missing reference or citation
// is narrowed to its "??" or "?" in that line; everything else marks its lines.
// Which problems get a place when there are more than `limit`: errors, then
// warnings, then typesetting, each in the order TeX reported them.
export function placementOrder(problems: Pick<BuildProblem, 'severity'>[], limit = LOCATE_LIMIT) {
  const rank = { error: 0, warning: 1, minor: 2 };
  return new Set(problems.map((problem, index) => index).sort((a, b) => rank[problems[a].severity] - rank[problems[b].severity] || a - b).slice(0, limit));
}

// The boxes one source line printed, as `synctex view` lists them.
const syncView = (pdf: string, file: string, line: number) =>
  exec('synctex', ['view', '-i', `${line}:0:${file}`, '-o', pdf], { timeout: 10000 }).then(result => parseSynctexView(result.stdout), () => [] as SyncBox[]);

// The box around what source lines printed on one page, in page points.
// Boxes taller than a good part of the page are whole floats or pages, so
// they count only when nothing else was printed there.
function boxRect(boxes: SyncBox[], page: number, text: Pick<PageText, 'bounds' | 'height'>) {
  const [x0, y0] = text.bounds;
  const onPage = boxes.filter(box => box.page === page), tidy = onPage.filter(box => box.H > 0 && box.H < text.height * 0.4);
  const rect = tidy.length
    ? [Math.min(...tidy.map(b => b.h)), Math.min(...tidy.map(b => b.v - b.H)), Math.max(...tidy.map(b => b.h + b.W)), Math.max(...tidy.map(b => b.v))]
    : [onPage[0].x - 6, onPage[0].y - 10, onPage[0].x + 6, onPage[0].y + 2];
  return { onPage, rect: [rect[0] + x0, rect[1] + y0, rect[2] + x0, rect[3] + y0] };
}

// A rectangle in page points as fractions of the page, as the PDF view places marks.
function pageFraction(rect: number[], text: Pick<PageText, 'bounds' | 'width' | 'height'>): [number, number, number, number] {
  const [x0, y0] = text.bounds, unit = (value: number) => Math.min(1, Math.max(0, Math.round(value * 10000) / 10000));
  return [unit((rect[0] - x0) / text.width), unit((rect[1] - y0) / text.height), unit((rect[2] - x0) / text.width), unit((rect[3] - y0) / text.height)];
}

/** Where source lines were printed: of the pages that show them, the one
 *  nearest `near` (a section title also prints in the contents), and the box
 *  around them there, as fractions of the page. */
export async function placeLines(pdf: string, source: string, lines: number[], near: number, openPage: (page: number) => Pick<PageText, 'bounds' | 'width' | 'height'> | null) {
  const boxes = (await Promise.all(lines.map(line => syncView(pdf, source, line)))).flat();
  if (!boxes.length) return null;
  const pages = [...new Set(boxes.map(box => box.page))].sort((a, b) => Math.abs(a - near) - Math.abs(b - near) || a - b);
  const page = pages[0], text = openPage(page);
  if (!text) return null;
  return { page, rect: pageFraction(boxRect(boxes, page, text).rect, text) };
}

export async function locateProblems(problems: StoredProblem[], pdf: string, openPage: (page: number) => PageText | null, limit = LOCATE_LIMIT): Promise<BuildProblem[]> {
  // SyncTeX reads its whole file on every call, so each source line is asked once.
  const views = new Map<string, Promise<SyncBox[]>>();
  const view = (file: string, line: number) => {
    const id = `${line}:${file}`;
    if (!views.has(id)) views.set(id, syncView(pdf, file, line));
    return views.get(id)!;
  };
  // TeX warns about the missing references of one source line in reading
  // order, so the second warning for a line belongs to its second "??".
  const ordinal = new Map<StoredProblem, number>(), counted = new Map<string, number>();
  for (const problem of problems) {
    const id = JSON.stringify([problem.source, problem.line, problem.kind]), seen = counted.get(id) || 0;
    ordinal.set(problem, problem.occurrence ?? seen); counted.set(id, (problem.occurrence ?? seen) + 1);
  }
  const place = async (problem: StoredProblem): Promise<BuildProblem> => {
    const { source, occurrence: _occurrence, ...shown } = problem;
    if (!source || !problem.line) return shown;
    const lines = problem.end && problem.end !== problem.line ? [problem.line, problem.end] : [problem.line];
    const boxes = (await Promise.all(lines.map(line => view(source, line)))).flat();
    if (!boxes.length) return shown;
    const page = boxes[0].page, text = openPage(page);
    if (!text) return shown;
    const [x0, y0] = text.bounds, placed = boxRect(boxes, page, text), onPage = placed.onPage;
    let rect = placed.rect;
    if (problem.kind === 'reference' || problem.kind === 'citation') {
      // A citation prints "?" or its key; the "?" of a missing reference's "??" is not one.
      const pairs = text.search('??'), inside = (mark: number[], outer: number[]) => mark[0] >= outer[0] - 0.5 && mark[2] <= outer[2] + 0.5 && mark[1] >= outer[1] - 0.5 && mark[3] <= outer[3] + 0.5;
      const marks = (problem.kind === 'reference' ? pairs : [...text.search('?').filter(mark => !pairs.some(pair => inside(mark, pair))), ...(problem.key ? text.search(problem.key) : [])])
        .filter(mark => { const middle = (mark[1] + mark[3]) / 2; return onPage.some(box => middle >= box.v - box.H + y0 - 3 && middle <= box.v + y0 + 3); })
        .sort((a, b) => Math.abs(a[1] - b[1]) > 2 ? a[1] - b[1] : a[0] - b[0]);
      // SyncTeX's points sit on the nodes this source line printed, so a mark
      // that starts beside one came from this line, not from its neighbours.
      const gap = (mark: number[]) => Math.min(...onPage.map(box => Math.abs(mark[0] - (box.x + x0))));
      const own = marks.filter(mark => gap(mark) <= 6);
      let best: number[] | undefined = own[ordinal.get(problem) || 0];
      if (!best && marks.length) best = marks.reduce((a, b) => gap(b) < gap(a) ? b : a);
      if (best) rect = [best[0] - 2, best[1] - 1, best[2] + 2, best[3] + 1];
    }
    return { ...shown, page, rect: pageFraction(rect, text) };
  };
  const output: BuildProblem[] = new Array(problems.length), chosen = placementOrder(problems, limit);
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let index = next++; index < problems.length; index = next++) {
      if (!chosen.has(index)) { const { source: _source, occurrence: _occurrence, ...shown } = problems[index]; output[index] = shown; continue; }
      output[index] = await place(problems[index]);
    }
  }));
  return output;
}

// Errors first, then the paper's order: page, then position on the page.
export function sortProblems(problems: BuildProblem[]) {
  const rank = { error: 0, warning: 1, minor: 2 };
  return [...problems].sort((a, b) => rank[a.severity] - rank[b.severity]
    || (a.page ?? Infinity) - (b.page ?? Infinity) || (a.rect?.[1] ?? 0) - (b.rect?.[1] ?? 0)
    || (a.file || '').localeCompare(b.file || '') || (a.line ?? 0) - (b.line ?? 0));
}
