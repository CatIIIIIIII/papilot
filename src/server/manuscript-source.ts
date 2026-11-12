import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ENGINE } from './paths.ts';
import type { SourceFile, SourcePlace, SourceSave } from '../shared.ts';
import type { Manuscripts } from './manuscript.ts';
import { placeLines } from './build-problems.ts';

// Manual LaTeX edits from the manuscript PDF. A click names a passage of the
// compiled snapshot; the author edits its file as it is now, beside the file's
// last commit, and a save writes the file, refusing when it moved meanwhile.

type Op = ['equal' | 'replace' | 'insert' | 'delete', number, number, number, number];
type Rect = [number, number, number, number];

const MAX_FILE = 2_000_000;
// How long a passage may grow when it is widened to its paragraph or kept whole.
const PARAGRAPH = 40, LARGEST = 200;
const exec = promisify(execFile);

async function engine() {
  const load = (file: string) => import(pathToFileURL(path.join(ENGINE, file)).href);
  const [{ opcodesWithin }, { splitLines, textOf }, { safePath }, { atomicWrite }, { sourceRange }, { PdfDocument }] = await Promise.all(
    ['src/core/diff.ts', 'src/core/changes.ts', 'src/core/review.ts', 'src/core/files.ts', 'src/render/locate.ts', 'src/render/pdf.ts'].map(load));
  return { opcodesWithin, splitLines, textOf, safePath, atomicWrite, paragraph: sourceRange, PdfDocument } as {
    opcodesWithin: (a: string[], b: string[], timeout: number) => Op[] | null;
    splitLines: (text: string) => string[]; textOf: (data: Buffer | null) => string | null;
    safePath: (root: string, file: string) => string;
    atomicWrite: (file: string, data: Uint8Array) => void;
    paragraph: (lines: string[], start: number, end: number) => [number, number];
    PdfDocument: any;
  };
}

const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });
export const revision = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Where lines [start, end) of a compiled snapshot are in the current file,
 *  given the line opcodes between the two. An edit that crosses either end
 *  widens the range rather than cutting the passage, and `drifted` says the
 *  passage is no longer the one that was compiled. Without opcodes (the
 *  comparison took too long) the same line numbers are kept. */
export function followRange(current: number, start: number, end: number, ops: Op[] | null): { start: number; end: number; drifted: boolean } {
  if (!ops) {
    const from = Math.min(start, current);
    return { start: from, end: Math.min(Math.max(end, from), current), drifted: true };
  }
  const drifted = ops.some(([kind, a, b]) => kind !== 'equal' && (a === b ? start < a && a < end : a < end && start < b));
  const boundary = (at: number, right: boolean) => {
    const positions: number[] = [];
    for (const [kind, a, b, x, y] of ops) {
      if (kind !== 'equal' && a < at && at < b) positions.push(right ? y : x);
      else if (a === at && a === b) positions.push(x, y);
      else if (at >= a && at <= b) positions.push(kind === 'equal' ? x + at - a : at === a ? x : y);
    }
    return positions.length ? (right ? Math.max(...positions) : Math.min(...positions)) : current;
  };
  const from = boundary(start, false);
  return { start: from, end: Math.max(from, boundary(end, true)), drifted };
}

/** The lines an author edits for a passage: its paragraph when that is
 *  short, the passage itself when it is long, and never more than LARGEST
 *  lines. `paragraph` takes and returns 1-based inclusive lines. */
export function editableRange(lines: string[], start: number, end: number, paragraph: (lines: string[], start: number, end: number) => [number, number]): [number, number] {
  if (!lines.length) return [0, 0];
  start = Math.min(start, lines.length - 1); end = Math.min(Math.max(end, start + 1), lines.length);
  if (end - start > PARAGRAPH) return [start, Math.min(end, start + LARGEST)];
  const [first, last] = paragraph(lines, start + 1, end);
  let from = Math.min(first - 1, start), to = Math.max(last, end);
  // A paragraph longer than the limit keeps the lines around the passage.
  if (to - from > PARAGRAPH) {
    const spare = PARAGRAPH - (end - start);
    from = Math.max(from, start - Math.floor(spare / 2));
    to = Math.min(to, from + PARAGRAPH);
    from = Math.max(Math.min(from, to - PARAGRAPH), first - 1, 0);
  }
  return [from, to];
}

interface Source { target: string; data: Buffer; bom: boolean; lines: string[] }
async function readSource(root: string, file: string): Promise<Source> {
  const { safePath, textOf, splitLines } = await engine();
  let target: string;
  try { target = safePath(root, file); }
  catch { throw new Error('This file cannot be edited here.'); }
  let stat: fs.Stats;
  try { stat = fs.statSync(target); }
  catch { throw Object.assign(new Error('This source file no longer exists.'), { statusCode: 404 }); }
  if (!stat.isFile()) throw new Error('This file cannot be edited here.');
  if (stat.size > MAX_FILE) throw new Error('This source file is too large to edit here.');
  const data = fs.readFileSync(target), text = textOf(data);
  if (text === null) throw new Error('This file is not text that can be edited here.');
  // The decoder drops a byte order mark; a save puts it back.
  return { target, data, bom: data.subarray(0, 3).equals(BOM), lines: splitLines(text) };
}

// The file as of the last commit, for showing what changed since. `./`
// resolves the path from the paper's folder, wherever the repository starts.
async function committed(root: string, file: string) {
  try {
    const { stdout } = await exec('git', ['show', `HEAD:./${file}`], { cwd: root, encoding: 'buffer', maxBuffer: MAX_FILE * 2, timeout: 15000 });
    const { textOf } = await engine(), text = stdout.length <= MAX_FILE ? textOf(stdout) : null;
    return text === null ? null : text;
  } catch { return null; }
}

async function sourceFile(root: string, file: string, source: Source, passage: [number, number], focus: [number, number], drifted: boolean): Promise<SourceFile> {
  return { file, revision: revision(source.data), text: source.lines.join(''), base: await committed(root, file), passage, focus, drifted };
}

/** The passage under a mark on the PDF named `key`, as it is on disk now. */
export async function locateSource(manuscripts: Manuscripts, projectId: string, root: string, key: string, page: number, rect: Rect, rects: Rect[], quote: string): Promise<{ source: SourceFile | null }> {
  // Where the mark is in the compiled copy of its file: followed here into
  // the file as it is now, keeping a passage edited since then.
  const source = (await manuscripts.locate(projectId, key, page, rect, rects, quote)).compiled;
  // Text a class or package printed, such as a title page, has no source in the paper.
  const relative = source && path.relative(manuscripts.compiled(projectId, key).root, source.input);
  if (!source || !relative || relative.startsWith('..') || path.isAbsolute(relative)) return { source: null };
  const { splitLines, opcodesWithin, paragraph } = await engine();
  let compiled: string;
  try { compiled = fs.readFileSync(source.input, 'utf8'); }
  catch { throw Object.assign(new Error('This PDF is out of date. Refresh it and try again.'), { statusCode: 404 }); }
  const before = splitLines(compiled.replace(/^\uFEFF/, '')), current = await readSource(root, source.file);
  const same = before.length === current.lines.length && before.every((line, index) => line === current.lines[index]);
  const ops: Op[] | null = same ? [['equal', 0, before.length, 0, before.length]] : opcodesWithin(before, current.lines, 1000);
  const found = followRange(current.lines.length, source.lines[0] - 1, source.lines[1], ops);
  const [start, end] = editableRange(current.lines, found.start, found.end, paragraph);
  const focus: [number, number] = [Math.max(start, Math.min(found.start, end)), Math.max(start, Math.min(found.end, end))];
  return { source: await sourceFile(root, source.file, current, [start, end], focus, found.drifted) };
}

const lineNumber = (value: unknown) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error('Invalid line range.');
  return number;
};
const fileName = (value: unknown) => {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\0')) throw new Error('Choose a source file.');
  return value;
};

/** A file as it is on disk, with its last commit. */
export async function readFile(root: string, file: unknown): Promise<SourceFile> {
  const name = fileName(file);
  return sourceFile(root, name, await readSource(root, name), [0, 0], [0, 0], false);
}

// Saves already applied, so that a retried request returns its result
// instead of reporting its own write as a conflict.
const applied = new Map<string, { request: string; revision: string; result: Omit<SourceSave, 'tree' | 'at'> }>();

/** Replaces a file, which must still be at `revision`, keeping its line
 *  endings and byte order mark. `changed` is the range of lines that differ. */
export async function saveSource(projectId: string, root: string, input: unknown): Promise<Omit<SourceSave, 'tree' | 'at'>> {
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const id = body.id, text = body.text, expected = body.revision;
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(id)) throw new Error('Invalid source edit.');
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) throw new Error('Invalid source edit.');
  if (typeof text !== 'string' || text.includes('\0') || text.length > MAX_FILE) throw new Error('Invalid source edit.');
  const file = fileName(body.file);
  const request = createHash('sha256').update(JSON.stringify([projectId, file, expected, text])).digest('hex');
  const source = await readSource(root, file), now = revision(source.data), done = applied.get(`${projectId}:${id}`);
  if (done) {
    if (done.request !== request) throw new Error('This edit ID was already used for another edit.');
    if (done.revision === now) return done.result;
  }
  if (now !== expected) throw conflict('The source changed while you were editing. Your draft is kept.');
  const eol = source.data.includes('\r\n') ? '\r\n' : '\n';
  const { splitLines, atomicWrite, opcodesWithin } = await engine();
  const lines = splitLines(text.replace(/\r\n/g, '\n').replace(/\n/g, eol));
  const data = Buffer.concat([source.bom ? BOM : Buffer.alloc(0), Buffer.from(lines.join(''), 'utf8')]);
  // The text's length counts characters; the file is the encoded bytes, which
  // multi-byte characters and CRLF line endings make longer. Refuse before
  // writing a file the editor could not read back.
  if (data.length > MAX_FILE) throw new Error('This source file is too large to edit here.');
  atomicWrite(source.target, data);
  const ops = opcodesWithin(source.lines, lines, 1000)?.filter(([kind]) => kind !== 'equal');
  const changed: [number, number] = !ops ? [0, lines.length] : ops.length ? [Math.min(...ops.map(op => op[3])), Math.max(...ops.map(op => op[4]))] : [0, 0];
  const result = { source: await sourceFile(root, file, { ...source, data, lines }, changed, changed, false), changed };
  applied.set(`${projectId}:${id}`, { request, revision: revision(data), result });
  if (applied.size > 50) applied.delete(applied.keys().next().value!);
  return result;
}

/** Where lines [start, end) of a file were printed in the PDF named `key`:
 *  the page nearest `near` that shows them, and the box around them there. */
export async function placeSource(manuscripts: Manuscripts, projectId: string, key: string, file: unknown, start: unknown, end: unknown, near: unknown): Promise<{ place: SourcePlace | null }> {
  const name = fileName(file), from = lineNumber(start), to = Math.max(from + 1, lineNumber(end));
  const build = manuscripts.compiled(projectId, key), input = path.join(build.root, path.posix.relative(build.sourceDir || '.', name));
  if (!fs.existsSync(input)) return { place: null };
  // SyncTeX reads its whole file per question; a long passage asks about a sample of its lines.
  const count = to - from, asked = Math.min(count, 6), lines = [...new Set(Array.from({ length: asked }, (_, index) => from + 1 + Math.round(index * (count - 1) / Math.max(1, asked - 1))))];
  const { PdfDocument } = await engine(), document = new PdfDocument(build.pdf);
  try {
    const place = await placeLines(build.pdf, input, lines, Number.isInteger(Number(near)) ? Number(near) : 0, page => {
      if (!Number.isInteger(page) || page < 0 || page >= document.length) return null;
      const raw = document.raw.loadPage(page);
      try { const bounds = raw.getBounds(); return { bounds, width: bounds[2] - bounds[0], height: bounds[3] - bounds[1] }; }
      finally { raw.destroy(); }
    });
    return { place };
  } finally { document.close(); }
}
