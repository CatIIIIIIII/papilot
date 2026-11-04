import type { ReviewSnapshot } from './ai-review.ts';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ENGINE, ROOT } from './paths.ts';
import type { Annotation, BuildProblem, BuildProgress, GitFile, GitStatus, ManuscriptBuild, ManuscriptProblems } from '../shared.ts';
import { notesInstructions } from '../notes.ts';
import { ignorePattern } from '../commit.ts';
import { AnnotationPages, placeAnnotation } from './annotation-placement.ts';
import { annotatePdf, type ExportNote } from './annotated-pdf.ts';
import { collectProblems, countProblems, locateProblems, scrubLog, sortProblems, type StoredProblem } from './build-problems.ts';

type Rect = [number, number, number, number];

const exec = promisify(execFile);
async function git(root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return (await exec('git', args, { cwd: root, timeout: 30_000, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 })).stdout;
}

// Porcelain v2 keeps paths with spaces intact under -z and reports branch,
// upstream and ahead/behind counts without a second command.
export function parseStatus(output: string, numstat: string): Omit<GitStatus, 'head'> {
  const lines = new Map<string, [number, number]>();
  const stats = numstat.split('\0');
  for (let i = 0; i < stats.length; i++) {
    const [added, deleted, file] = stats[i].split('\t');
    if (!added) continue;
    // A rename lists an empty path followed by the old and new paths.
    const target = file || (i += 2, stats[i]);
    if (target && added !== '-') lines.set(target, [Number(added), Number(deleted)]);
  }
  const status: Omit<GitStatus, 'head'> = { branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const fields = output.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.startsWith('# branch.head ')) status.branch = field.slice(14) === '(detached)' ? null : field.slice(14);
    else if (field.startsWith('# branch.upstream ')) status.upstream = field.slice(18);
    else if (field.startsWith('# branch.ab ')) { const [ahead, behind] = field.slice(12).split(' '); status.ahead = Number(ahead); status.behind = -Number(behind); }
    else if (field.startsWith('? ')) status.files.push({ path: field.slice(2), status: '?', staged: false, unstaged: true });
    else if (/^[12u] /.test(field)) {
      const parts = field.split(' '), xy = parts[1], kind = field[0];
      const file = parts.slice(kind === '1' ? 8 : kind === '2' ? 9 : 10).join(' ');
      // A rename or copy is followed by its original path.
      const from = kind === '2' ? fields[++i] : undefined;
      const code = kind === 'u' ? 'U' : xy[1] !== '.' ? xy[1] : xy[0];
      // X is the index against HEAD, Y the working tree against the index. The
      // staged list shows X where it differs, such as a new file edited again.
      status.files.push({ path: file, status: code, staged: xy[0] !== '.', unstaged: xy[1] !== '.', lines: lines.get(file), ...(from ? { from } : {}), ...(xy[0] !== '.' && xy[0] !== code ? { index: xy[0] } : {}) });
    }
  }
  return status;
}

export async function gitStatus(root: string): Promise<GitStatus> {
  const [status, numstat, head, remotes] = await Promise.all([
    git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { GIT_OPTIONAL_LOCKS: '0' }),
    git(root, ['diff', '--numstat', '-z', 'HEAD']).catch(() => ''),
    git(root, ['log', '-1', '--format=%h%x00%s%x00%ct']).catch(() => ''),
    git(root, ['remote']).catch(() => ''),
  ]);
  const [hash, subject, time] = head.trim().split('\0');
  const parsed = parseStatus(status, numstat), dir = gitDir(root);
  // A merge in progress names the files whose conflict markers remain.
  const merging = dir && fs.existsSync(path.join(dir, 'MERGE_HEAD'))
    ? { message: readText(path.join(dir, 'MERGE_MSG')).split('\n')[0] || 'Merge', conflicts: parsed.files.filter(file => file.status === 'U' && conflictMarkers(root, file.path)).map(file => file.path) }
    : null;
  return { ...parsed, head: hash ? { hash, subject, date: Number(time) * 1000 } : null, remote: Boolean(remotes.trim()), merging };
}
const readText = (file: string) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
// The repository's Git directory: .git, or where a .git file points.
function gitDir(root: string) {
  try {
    const dot = path.join(root, '.git');
    return fs.statSync(dot).isFile() ? path.resolve(root, readText(dot).replace(/^gitdir:\s*/, '').trim()) : dot;
  } catch { return null; }
}
// Cheap evidence that Git's own state moved: the index, HEAD, the current
// branch, a fetch or a merge. Each changes when a commit, stage, checkout,
// fetch or merge happens, from Papilot or from a terminal.
export function gitStamp(root: string) {
  const dir = gitDir(root);
  if (!dir) return '';
  const common = path.resolve(dir, readText(path.join(dir, 'commondir')).trim() || '.');
  const branch = readText(path.join(dir, 'HEAD')).match(/^ref: (refs\/\S+)/)?.[1];
  // FETCH_HEAD belongs to the worktree that fetched, so a linked worktree checks
  // its own and the main one's.
  return [path.join(dir, 'index'), path.join(dir, 'HEAD'), path.join(dir, 'MERGE_HEAD'), path.join(dir, 'FETCH_HEAD'), common !== dir && path.join(common, 'FETCH_HEAD'), path.join(common, 'packed-refs'), branch && path.join(common, branch)]
    .map(file => { try { const stat = file && fs.statSync(file); return stat ? `${stat.mtimeMs}:${stat.size}` : '-'; } catch { return '-'; } }).join('|');
}
export function mergeInProgress(root: string) {
  const dir = gitDir(root);
  return Boolean(dir && fs.existsSync(path.join(dir, 'MERGE_HEAD')));
}
export const conflictMarkers = (root: string, file: string) => /^(?:<{7}|>{7})(?: |$)/m.test(readText(path.join(root, file)));

// Paths from the browser are matched against the changed files, and Git reads
// them literally, so a name cannot act as a pathspec pattern.
const literal = { GIT_LITERAL_PATHSPECS: '1' };
const DIFF_LIMIT = 400_000;

// One changed file's diff against HEAD; an untracked file shows as all new.
export async function gitDiff(root: string, file: string) {
  const entry = (await gitStatus(root)).files.find(item => item.path === file);
  if (!entry) throw Object.assign(new Error('That file has no uncommitted changes.'), { statusCode: 404 });
  const diff = await fileDiff(root, entry);
  return { path: file, diff: diff.slice(0, DIFF_LIMIT), truncated: diff.length > DIFF_LIMIT };
}
// A file's diff against HEAD, or with staged, what its index holds.
function fileDiff(root: string, entry: GitFile, staged = false) {
  const names = ['--', ...(entry.from ? [entry.from] : []), entry.path];
  if (staged) return git(root, ['diff', '--cached', '--no-color', '--find-renames', ...names], literal);
  return entry.status === '?'
    // `git diff --no-index` exits with 1 when the files differ.
    ? exec('git', ['diff', '--no-index', '--no-color', '--', '/dev/null', entry.path], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).then(r => r.stdout, (e: { stdout?: string }) => e.stdout || '')
    : git(root, ['diff', '--no-color', '--find-renames', 'HEAD', ...names], literal);
}

// What a commit message is written from: the chosen files' diffs, or what is
// staged in them, each shortened so that a large change still fits, and the
// repository's recent commit subjects, whose style and language the message follows.
export async function commitChanges(root: string, paths: string[], staged = false) {
  const files = (await gitStatus(root)).files.filter(item => paths.includes(item.path) && (!staged || item.staged));
  if (!files.length) throw new Error(staged ? 'Stage at least one change.' : 'Select at least one changed file.');
  let patch = '';
  for (const [index, file] of files.entries()) {
    if (patch.length > 40_000) { patch += `\n[${files.length - index} more changed files are not shown.]\n`; break; }
    const diff = await fileDiff(root, file, staged);
    patch += diff.length > 8_000 ? `${diff.slice(0, 8_000)}\n[The rest of this file's diff is not shown.]\n` : diff;
  }
  const recent = (await git(root, ['log', '-8', '--format=%s']).catch(() => '')).split('\n').filter(Boolean);
  return { files, patch, recent };
}

// Adds the patterns for the chosen untracked build files to the repository's
// .gitignore, one per kind of file and each only once, so they leave the list
// of changes. The .gitignore is then a change to commit like any other.
export async function gitIgnore(root: string, paths: string[]) {
  const patterns = [...new Set((await gitStatus(root)).files.filter(item => item.status === '?' && paths.includes(item.path)).map(item => ignorePattern(item.path)).filter((pattern): pattern is string => Boolean(pattern)))];
  if (!patterns.length) throw new Error('None of the chosen files is build output that can be ignored.');
  const file = path.join(root, '.gitignore');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const present = new Set(current.split(/\r?\n/).map(line => line.trim()));
  const missing = patterns.filter(pattern => !present.has(pattern) && !present.has('/' + pattern));
  if (missing.length) fs.writeFileSync(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${current.trim() ? '\n' : ''}# Build output\n${missing.join('\n')}\n`);
  return gitStatus(root);
}

// Stage or unstage whole files, as the Git panel's checkboxes do. A rename
// moves with both of its paths.
export async function gitStage(root: string, paths: string[], stage: boolean) {
  const status = await gitStatus(root), files = status.files.filter(item => paths.includes(item.path));
  if (status.merging) throw new Error('Finish or abort the merge before staging other changes.');
  if (!files.length) throw new Error('Select at least one changed file.');
  const names = [...new Set(files.flatMap(item => item.from ? [item.from, item.path] : [item.path]))];
  if (stage) await gitAction(root, ['add', '-A', '--', ...names]);
  else await gitAction(root, status.head ? ['reset', '-q', 'HEAD', '--', ...names] : ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...names]);
  return gitStatus(root);
}

// Discard what the Changes list shows for these files, as an editor's source
// control does: a tracked file returns to its staged version, or the last
// commit, and an untracked file is deleted. Staged changes stay.
export async function gitDiscard(root: string, paths: string[]) {
  const status = await gitStatus(root);
  if (status.merging) throw new Error('Finish or abort the merge before discarding changes.');
  const files = status.files.filter(item => paths.includes(item.path) && item.unstaged);
  if (!files.length) throw new Error('Select at least one changed file.');
  const tracked = files.filter(item => item.status !== '?').map(item => item.path);
  if (tracked.length) await gitAction(root, ['checkout', '--', ...tracked]);
  for (const item of files.filter(item => item.status === '?')) {
    const file = path.resolve(root, item.path);
    if (!file.startsWith(root + path.sep)) throw new Error('Invalid file path.');
    fs.rmSync(file, { force: true });
  }
  return gitStatus(root);
}

// Commit what is staged, or with paths, exactly those files as they are on
// disk; changes staged for other files then stay staged and out of the commit.
export async function gitCommit(root: string, message: string, paths: string[] | null) {
  const status = await gitStatus(root);
  if (status.merging) throw new Error('Finish or abort the merge before committing other changes.');
  if (!paths) {
    if (!status.files.some(item => item.staged)) throw new Error('Stage at least one change to commit.');
    await gitAction(root, ['commit', '-m', message]);
    return (await git(root, ['rev-parse', '--short', 'HEAD'])).trim();
  }
  const files = status.files.filter(item => paths.includes(item.path));
  if (!files.length) throw new Error('Select at least one changed file to commit.');
  if (files.some(item => item.status === 'U')) throw new Error('Resolve the merge conflicts in the selected files before committing.');
  // A rename is already staged, so only its new path is added; the commit
  // names the old path too, so the removal is part of it.
  await gitAction(root, ['add', '-A', '--', ...files.map(item => item.path)]);
  await gitAction(root, ['commit', '--only', '-m', message, '--', ...new Set(files.flatMap(item => item.from ? [item.from, item.path] : [item.path]))]);
  return (await git(root, ['rev-parse', '--short', 'HEAD'])).trim();
}

// Fetch, fast-forward pull and push use the host's Git credentials. Nothing
// may prompt, so a missing credential fails instead of hanging.
export async function gitRemote(root: string, action: 'fetch' | 'pull' | 'merge' | 'push') {
  const status = await gitStatus(root);
  if (!status.remote) throw new Error('This repository has no remote.');
  if (status.merging && action !== 'fetch') throw new Error('Finish or abort the merge first.');
  if (action === 'fetch') await gitAction(root, ['fetch', '--prune'], 120_000);
  else if (action === 'pull' || action === 'merge') {
    if (!status.upstream) throw new Error('This branch does not track a remote branch yet.');
    // Pull only fast-forwards. Merge also joins a branch that has diverged
    // from its upstream; conflicts leave the merge in progress to resolve.
    if (action === 'pull') await gitAction(root, ['pull', '--ff-only'], 120_000);
    else await gitAction(root, ['pull', '--no-rebase', '--ff', '--no-edit'], 120_000).catch(error => { if (!mergeInProgress(root)) throw error; });
  } else if (status.upstream) await gitAction(root, ['push'], 120_000);
  else {
    if (!status.branch) throw new Error('Check out a branch before pushing.');
    const remotes = (await git(root, ['remote'])).split('\n').filter(Boolean);
    await gitAction(root, ['push', '-u', remotes.includes('origin') ? 'origin' : remotes[0], status.branch], 120_000);
  }
}

// A merge in progress ends with its commit once no conflict markers remain,
// or is abandoned, restoring the files as they were before it.
export async function gitFinishMerge(root: string) {
  const status = await gitStatus(root);
  if (!status.merging) throw new Error('No merge is in progress.');
  if (status.merging.conflicts.length) throw new Error(`Resolve the conflicts in ${status.merging.conflicts.join(', ')} first.`);
  const resolved = status.files.filter(item => item.status === 'U').map(item => item.path);
  if (resolved.length) await gitAction(root, ['add', '-A', '--', ...resolved]);
  await gitAction(root, ['commit', '--no-edit']);
  return (await git(root, ['rev-parse', '--short', 'HEAD'])).trim();
}
export async function gitAbortMerge(root: string) {
  if (!mergeInProgress(root)) throw new Error('No merge is in progress.');
  await gitAction(root, ['merge', '--abort']);
}
// What an agent needs to resolve a merge's conflicts: the files with markers
// and the commits on each side.
export async function mergeConflicts(root: string) {
  const status = await gitStatus(root);
  if (!status.merging) throw new Error('No merge is in progress.');
  const subjects = async (range: string) => (await git(root, ['log', '-12', '--format=%s', range]).catch(() => '')).split('\n').filter(Boolean);
  return { files: status.merging.conflicts, branch: status.branch || 'HEAD', upstream: status.upstream || 'the remote branch', ours: await subjects('MERGE_HEAD..HEAD'), theirs: await subjects('HEAD..MERGE_HEAD') };
}

// Git's own message, without the usage noise, becomes the error the user sees.
async function gitAction(root: string, args: string[], timeout = 60_000) {
  try { return (await exec('git', args, { cwd: root, timeout, env: { ...process.env, ...literal, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 64 * 1024 * 1024 })).stdout; }
  catch (error) {
    const e = error as { stderr?: string; stdout?: string; killed?: boolean; message: string };
    const detail = (e.stderr || e.stdout || '').split('\n').map(line => line.trim()).filter(line => line && !/^(hint|To |From ):?/.test(line)).slice(-4).join(' ');
    throw new Error(e.killed ? `git ${args[0]} timed out.` : detail || e.message);
  }
}

// The preview shows the manuscript as it is on disk, including accepted but
// uncommitted review changes. A private index records it as a Git tree
// without touching the real index, branches or files. It starts from the
// previous snapshot's index, or the repository's, so Git rehashes only files
// whose size or modification time changed.
export async function workingTree(root: string) {
  const dir = gitDir(root), saved = dir && path.join(dir, 'latex-review', 'working-index');
  const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'papilot-index-')), index = path.join(folder, 'index'), env = { GIT_INDEX_FILE: index };
  const snapshot = async (seed: string | null | undefined) => {
    if (!seed || !await copyIndex(seed, index)) { await fs.promises.rm(index, { force: true }); await git(root, ['read-tree', 'HEAD'], env).catch(() => git(root, ['read-tree', '--empty'], env)); }
    await git(root, ['add', '-A'], env);
    return (await git(root, ['write-tree'], env)).trim();
  };
  try {
    let tree: string;
    try { tree = await snapshot(saved && fs.existsSync(saved) ? saved : dir && path.join(dir, 'index')); }
    catch { tree = await snapshot(null); }
    if (saved) {
      const temporary = `${saved}.${randomUUID()}.tmp`;
      try {
        await fs.promises.mkdir(path.dirname(saved), { recursive: true });
        if (await copyIndex(index, temporary)) await fs.promises.rename(temporary, saved);
      } catch { /* The next snapshot rehashes more files. */ }
      finally { await fs.promises.rm(temporary, { force: true }); }
    }
    return tree;
  } finally { await fs.promises.rm(folder, { recursive: true, force: true }); }
}
// Copies an index and keeps its modification time, which Git compares with
// each file's to catch edits made in the instant the index was written.
async function copyIndex(from: string, to: string) {
  try {
    const stat = await fs.promises.stat(from);
    await fs.promises.copyFile(from, to);
    await fs.promises.utimes(to, stat.atime, stat.mtime);
    return true;
  } catch { return false; }
}


// Each page's size in points. A long paper takes tens of milliseconds, so
// the event loop answers other requests every few pages.
async function pageSizes(mupdf: any, pdf: string) {
  const document = mupdf.Document.openDocument(await fs.promises.readFile(pdf), 'application/pdf'), pages: [number, number][] = [];
  try {
    for (let i = 0; i < document.countPages(); i++) {
      if (i && i % 32 === 0) await new Promise(resolve => setImmediate(resolve));
      const page = document.loadPage(i);
      try { const [x0, y0, x1, y1] = page.getBounds(); pages.push([Math.round(x1 - x0), Math.round(y1 - y0)]); }
      finally { page.destroy(); }
    }
  } finally { document.destroy(); }
  return pages;
}

async function engine() {
  const [{ Builder, BuildError }, { Repo, gitBinary }, { loadProject }, { mupdf, PdfDocument, containsCenter, walkText }] = await Promise.all([
    import(pathToFileURL(path.join(ENGINE, 'src/core/build.ts')).href),
    import(pathToFileURL(path.join(ENGINE, 'src/core/git.ts')).href),
    import(pathToFileURL(path.join(ENGINE, 'src/core/config.ts')).href),
    import(pathToFileURL(path.join(ENGINE, 'src/render/pdf.ts')).href),
  ]);
  return { Builder, BuildError, Repo, gitBinary, loadProject, mupdf, PdfDocument, containsCenter, walkText };
}

// `synctex edit` maps a PDF position (big points from the top-left corner) to
// the source file and line that produced it.
export function parseSynctex(output: string) {
  const input = /^Input:(.*)$/m.exec(output)?.[1], line = Number(/^Line:(\d+)$/m.exec(output)?.[1]);
  return input && line > 0 ? { input: path.normalize(input), line } : null;
}

// One task for every pending note, quoting the marked text and its source so
// the agent can find each place without guessing.
export function annotationTask(notes: Annotation[]) {
  const first = notes[0].comment.split('\n').find(line => line.trim())?.trim() || 'Address a PDF note';
  const title = notes.length === 1 ? (first.length > 80 ? first.slice(0, 79).replace(/\s+\S*$/, '') + '…' : first) : `Address ${notes.length} PDF notes`;
  return { title, instructions: notesInstructions(notes) };
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

export function sourceExcerpt(file: string, [start, end]: [number, number], limit = 20) {
  if (!fs.existsSync(file)) return undefined;
  const lines = fs.readFileSync(file, 'utf8').split('\n').slice(start - 1, end).map(line => line.trimEnd());
  return (lines.length > limit ? [...lines.slice(0, limit), '…'] : lines).join('\n');
}

// Every word on a page with its exact place, for the PDF view's selection
// layer: [text, left, baseline, font size, width, ends a line], in points from
// the page's top left. pdf.js lays a whole line out in a stand-in font and
// drifts from the printed words mid-line; per-word runs cannot drift.
export async function pdfWords(pdf: string, page: number) {
  const { PdfDocument, walkText } = await engine();
  const document = new PdfDocument(pdf);
  try {
    if (!Number.isInteger(page) || page < 0 || page >= document.length) throw Object.assign(new Error('That page is not part of the manuscript.'), { statusCode: 400 });
    const raw = document.raw.loadPage(page), [x0, y0, x1, y1] = raw.getBounds();
    const words: { text: string; left: number; right: number; baseline: number; size: number; eol: boolean }[] = [];
    let word: (typeof words)[number] | null = null;
    const text = raw.toStructuredText('preserve-whitespace');
    walkText(text, {
      beginLine: () => { word = null; },
      onChar: (c: string, origin: [number, number], _font: unknown, size: number, quad: number[]) => {
        if (/\s/u.test(c)) { word = null; return; }
        const left = Math.min(quad[0], quad[2], quad[4], quad[6]) - x0, right = Math.max(quad[0], quad[2], quad[4], quad[6]) - x0;
        if (!word) { word = { text: '', left, right, baseline: origin[1] - y0, size, eol: false }; words.push(word); }
        word.text += c; word.right = Math.max(word.right, right);
      },
      endLine: () => { if (words.length) words[words.length - 1].eol = true; },
    });
    text.destroy(); raw.destroy();
    const round = (value: number) => Math.round(value * 100) / 100;
    return { width: round(x1 - x0), height: round(y1 - y0), words: words.map(w => [w.text, round(w.left), round(w.baseline), round(w.size), round(w.right - w.left), w.eol ? 1 : 0] as [string, number, number, number, number, number]) };
  } finally { document.close(); }
}

// `problems` come from the last finished build. They are placed on the PDF
// named `problemsKey`; a failed build has no PDF of its own to place them on.
interface Build {
  tree: string; status: ManuscriptBuild['status']; key?: string; pdf?: string; root?: string; sourceDir?: string; pages?: [number, number][]; builtAt?: number; error?: string; progress?: BuildProgress;
  problems?: StoredProblem[]; problemsKey?: string; log?: string; logFolder?: string;
}



export class Manuscripts extends EventEmitter {
  private builds = new Map<string, Build>();
  private oldPdfs = new Map<string, string | null>();
  private placements = new Map<string, (Pick<Annotation, 'key' | 'page' | 'rect' | 'rects' | 'source'>) | null>();
  // Placed problems per problem list; a rebuild in progress shares its predecessor's list.
  private located = new WeakMap<StoredProblem[], Promise<BuildProblem[]>>();
  // Papers whose working tree changed while their manuscript compiled: they
  // compile again as soon as that build ends.
  private stale = new Set<string>();
  // One working-tree snapshot per paper at a time; a request made meanwhile
  // waits for the next one, which sees every edit made before it was asked.
  private snapshots = new Map<string, { current: Promise<string>; next?: Promise<string> }>();
  // Per paper, the speculative build that is running and the one wanted next.
  private speculation = new Map<string, { running: boolean; wanted?: { root: string; files: Record<string, Buffer | null> } }>();
  // Every open event stream listens for builds.
  constructor() { super(); this.setMaxListeners(0); }
  /** Stops every compiler this process started, also paused ones, so that
   *  nothing keeps running after Papilot quits. */
  async stop() {
    const { stopAll } = await import(pathToFileURL(path.join(ENGINE, 'src/core/process.ts')).href);
    stopAll();
  }
  /** Loads the PDF engine and reads Papilot's example paper with it once,
   *  before the server answers requests: compiling its WebAssembly and
   *  setting up color conversion take a few hundred milliseconds the first
   *  time, which would otherwise hold up the first PDF someone opens. */
  async warm() {
    try {
      const { PdfDocument, gitBinary } = await engine(), sample = path.join(ROOT, 'examples/papilot-paper/preview/main.pdf');
      gitBinary();
      if (!fs.existsSync(sample)) return;
      const document = new PdfDocument(sample);
      try { document.page(0); } finally { document.close(); }
    } catch { /* The first build pays for it instead. */ }
  }
  get busyForUpdate() { return [...this.builds.values()].some(build => build.status === 'building'); }
  busyForProject(id: string) { return this.builds.get(id)?.status === 'building'; }
  forgetProject(id: string) { this.builds.delete(id); this.stale.delete(id); this.speculation.delete(id); }

  // The caller verifies the example's source tree. An edit or explicit rebuild
  // uses Builder; the original PDF can be read before TeX is installed.
  async seedPreview(projectId: string, root: string, tree: string, pdf: string) {
    const { mupdf } = await engine(), bytes = await fs.promises.readFile(pdf), pages = await pageSizes(mupdf, pdf);
    const key = createHash('sha256').update(tree).update(bytes).digest('hex').slice(0, 16);
    this.builds.set(projectId, { tree, status: 'ready', key, pdf, root, sourceDir: '', pages,
      builtAt: (await fs.promises.stat(pdf)).mtimeMs, problems: [], problemsKey: key });
  }

  // The working tree as a Git tree. Requests made while a snapshot runs share
  // the next one, which starts when it ends and so sees every edit made
  // before they asked.
  private snapshot(root: string): Promise<string> {
    const entry = this.snapshots.get(root);
    if (entry) return entry.next ??= entry.current.then(() => undefined, () => undefined).then(() => this.takeSnapshot(root));
    return this.takeSnapshot(root);
  }
  private takeSnapshot(root: string) {
    const current = workingTree(root);
    this.snapshots.set(root, { current });
    void current.then(() => undefined, () => undefined).then(() => {
      const entry = this.snapshots.get(root);
      if (entry?.current === current && !entry.next) this.snapshots.delete(root);
    });
    return current;
  }

  // The view polls every second and a half while a build runs; Git's status
  // costs a walk of the working tree, which competes with TeX, so it is
  // read again at most every few seconds then, and after Papilot's own writes.
  // Between builds the view polls every five seconds to notice other editors:
  // the status is read again when the working tree or Git's own state moved,
  // and at least every half minute for what neither shows, such as a push
  // from a terminal changing how far the branch is ahead.
  private statuses = new Map<string, { at: number; value: Promise<GitStatus>; tree?: string; stamp?: string }>();
  private gitStatus(root: string, building: boolean, tree?: string) {
    const cached = this.statuses.get(root), age = cached ? Date.now() - cached.at : Infinity, stamp = building ? undefined : gitStamp(root);
    if (cached && (building ? age < 5000 : tree !== undefined && cached.tree === tree && cached.stamp === stamp && age < 30000)) return cached.value;
    const value = gitStatus(root);
    this.statuses.set(root, { at: Date.now(), value, tree, stamp });
    value.catch(() => { if (this.statuses.get(root)?.value === value) this.statuses.delete(root); });
    return value;
  }

  async state(projectId: string, root: string, rebuild = false): Promise<{ git: GitStatus; build: ManuscriptBuild }> {
    const current = this.builds.get(projectId), building = current?.status === 'building';
    // Polling an in-flight build needs its status, not another source snapshot.
    // Once it finishes, the next read checks for edits made during compilation.
    // The snapshot comes first so an unchanged tree can reuse the last status.
    const tree = building ? current.tree : await this.snapshot(root), status = await this.gitStatus(root, building, building ? undefined : tree);
    let build = this.builds.get(projectId);
    if (!build || (build.status !== 'building' && (build.tree !== tree || rebuild))) build = this.start(projectId, root, tree, build, rebuild);
    const { status: state, key, pages, builtAt, error } = build;
    return { git: status, build: { status: state, key, pages, builtAt, error, current: build.tree === tree && state === 'ready', problems: build.problems && countProblems(build.problems), ...(state === 'building' && build.progress ? { progress: build.progress } : {}) } };
  }

  /** Compiles the working tree if it changed, without waiting for anyone to
   *  look: after a commit, an applied task or a Git action, the PDF is on its
   *  way before the manuscript is opened. */
  async refresh(projectId: string, root: string) {
    this.statuses.delete(root);
    if (this.builds.get(projectId)?.status === 'building') { this.stale.add(projectId); return; }
    const tree = await this.snapshot(root), build = this.builds.get(projectId);
    if (build?.status === 'building') { if (build.tree !== tree) this.stale.add(projectId); return; }
    if (!build || build.tree !== tree) this.start(projectId, root, tree, build);
  }

  /** Compiles in the background what the manuscript will be once the given
   *  files are written into the working tree, such as a reviewed task that is
   *  about to be applied. When that happens, the build of the working tree is
   *  the same build, so its PDF is ready or already on its way. A build
   *  someone waits for always runs first. */
  async predict(projectId: string, root: string, files: Record<string, Buffer | null>) {
    let entry = this.speculation.get(projectId);
    if (!entry) this.speculation.set(projectId, entry = { running: false });
    entry.wanted = { root, files };
    if (entry.running) return;
    entry.running = true;
    try {
      while (entry.wanted && this.speculation.get(projectId) === entry) {
        const wanted: { root: string; files: Record<string, Buffer | null> } = entry.wanted;
        entry.wanted = undefined;
        try {
          const { Builder, Repo, loadProject } = await engine(), repo = new Repo(wanted.root);
          const tree = await this.snapshot(wanted.root), predicted = await repo.treeWithAsync(tree, wanted.files);
          if (predicted === tree) continue;
          await new Builder(loadProject(wanted.root), repo).build(predicted, ['full'], null, { priority: 'background' });
        } catch { /* A build that fails here fails again, and is reported, when it is needed. */ }
      }
    } finally { entry.running = false; }
  }

  // Keep the previous pages visible while a newer working tree compiles.
  private start(projectId: string, root: string, tree: string, previous?: Build, force = false) {
    if (previous?.key && previous.pdf) this.oldPdfs.set(`${root}:${previous.key}`, previous.pdf);
    const build: Build = { tree, status: 'building', key: previous?.key, pdf: previous?.pdf, root: previous?.root, sourceDir: previous?.sourceDir, pages: previous?.pages, builtAt: previous?.builtAt, problems: previous?.problems, problemsKey: previous?.problemsKey, log: previous?.log, logFolder: previous?.logFolder };
    this.builds.set(projectId, build);
    this.stale.delete(projectId);
    this.emit('change', projectId);
    void (async () => {
      let project: { source_dir?: string; doc_dir?: string; state: string } | undefined;
      try {
        const { Builder, Repo, loadProject, mupdf } = await engine();
        project = loadProject(root);
        const startedAt = Date.now();
        const sizes = (pdf: string) => pageSizes(mupdf, pdf);
        // A pass that latexmk follows with more work already shows the edit;
        // its pages replace the previous PDF while references settle.
        const pass = async (preview: { pdf: string; root: string }) => {
          if (this.builds.get(projectId) !== build || build.status !== 'building') return;
          const pages = await sizes(preview.pdf), key = createHash('sha256').update(preview.pdf).digest('hex').slice(0, 16);
          if (this.builds.get(projectId) !== build || build.status !== 'building') return;
          this.oldPdfs.set(`${root}:${key}`, preview.pdf);
          Object.assign(build, { key, pdf: preview.pdf, root: preview.root, sourceDir: project!.source_dir || '', pages, builtAt: Date.now() });
          this.emit('change', projectId);
        };
        const result = await new Builder(project, new Repo(root)).build(tree, ['full'], null, { force, priority: 'foreground', pass: (preview: { pdf: string; root: string }) => void pass(preview).catch(() => undefined), progress: (progress: Omit<BuildProgress, 'startedAt'>) => { if (this.builds.get(projectId) === build) build.progress = { ...progress, startedAt }; } });
        const pages = await sizes(result.pdf);
        const key = createHash('sha256').update(result.key + result.pdf).digest('hex').slice(0, 16);
        if (this.builds.get(projectId) !== build) return;
        const log = String(result.pdf).replace(/\.pdf$/, '.log');
        let problems: StoredProblem[] = [];
        try { problems = collectProblems(await fs.promises.readFile(log), { cwd: result.cwd, root: result.root, sourceDir: project!.source_dir || '', outDir: path.dirname(result.pdf) }); } catch { /* A build without a readable log reports no problems. */ }
        Object.assign(build, { status: 'ready', key, pdf: result.pdf, root: result.root, sourceDir: project!.source_dir || '', pages, builtAt: Date.now(), error: undefined, problems, problemsKey: key, log: fs.existsSync(log) ? log : undefined, logFolder: path.dirname(result.root) });
        // Place the problems now, so the list is ready when someone opens it.
        if (problems.length) void this.problems(projectId).catch(() => undefined);
      } catch (error) {
        if (this.builds.get(projectId) !== build) return;
        const detail = error as { message?: string; details?: string[]; log?: string };
        const message = [detail.message, ...(detail.details || [])].filter(Boolean).join('\n') || 'The manuscript could not be compiled.';
        // The engine keeps latexmk's transcript and the TeX log of a failed
        // build; its sources are gone, so files resolve in the working tree.
        let problems: StoredProblem[] = [];
        if (detail.log && project) try {
          const kept = await fs.promises.readFile(detail.log), marker = Buffer.from('\n\n--- TeX log ---\n'), at = kept.indexOf(marker);
          // TeX stopped in its first pass, before references resolve, so only
          // the errors of a failed run mean anything.
          if (at >= 0) problems = collectProblems(kept.subarray(at + marker.length), { cwd: path.join(root, project.doc_dir || '.'), root: path.join(root, project.source_dir || '.'), sourceDir: project.source_dir || '' })
            .filter(problem => problem.severity === 'error').map(({ source: _source, ...problem }) => problem);
        } catch { /* Fall back to the compiler's own message below. */ }
        // BibTeX, Biber, latexmk and helper programs fail outside the TeX log;
        // whatever the compiler said that the parsed errors do not cover stays.
        const plain = (text: string) => text.replace(/\s+/g, ' ').trim();
        const unexplained = (detail.details || []).filter(line => line.trim() && !/==> Fatal error occurred|^Emergency stop/.test(line) && !problems.some(problem => plain(line).includes(plain(problem.message).replace(/^[^:]+:\d+: /, ''))));
        const logFolder = detail.log && project ? path.join(project.state, 'cache/builds', path.basename(detail.log, '.log')) : undefined;
        if (!problems.length || unexplained.length) problems.push({ kind: 'error', severity: 'error', message: scrubLog([...(problems.length ? [] : [detail.message || 'The manuscript could not be compiled.']), ...unexplained].join('\n'), logFolder) });
        // The previous PDF stays on screen, and so do its warnings and places;
        // a pass of this build that was shown went with its folder.
        Object.assign(build, { key: previous?.key, pdf: previous?.pdf, root: previous?.root, sourceDir: previous?.sourceDir, pages: previous?.pages, builtAt: previous?.builtAt });
        const shown = build.problemsKey && build.problemsKey === build.key ? (build.problems || []).filter(problem => problem.severity !== 'error') : [];
        Object.assign(build, { status: 'failed', error: message, problems: [...problems, ...shown], problemsKey: shown.length ? build.problemsKey : undefined, log: detail.log && fs.existsSync(detail.log) ? detail.log : undefined, logFolder });
      }
      this.emit('change', projectId);
      // Edits made while this build ran are compiled next, right away.
      if (this.stale.delete(projectId)) void this.refresh(projectId, root).catch(() => undefined);
    })();
    return build;
  }

  // Old annotations keep their saved content. Only their proven PDF position
  // changes; ambiguous or missing content stays on the earlier version.
  async reanchor(projectId: string, root: string, notes: Annotation[]): Promise<Annotation[]> {
    const build = this.builds.get(projectId);
    if (!build?.pdf || !build.key || build.status !== 'ready' || !notes.some(note => note.key !== build.key)) return notes;
    // Every poll asks again; placements already checked need no PDF opened.
    const cacheKey = (note: Annotation) => JSON.stringify([projectId, build.key, note.key, note.page, note.rect, note.rects, note.quote]);
    if (notes.every(note => note.key === build.key || this.placements.has(cacheKey(note))))
      return notes.map(note => { const placement = note.key === build.key ? null : this.placements.get(cacheKey(note)); return placement ? { ...note, ...placement } : note; });
    // Placing reads every page of a long PDF between other requests; a poll
    // that arrives meanwhile shares the work instead of repeating it.
    const batch = JSON.stringify([projectId, build.key, notes.map(note => cacheKey(note))]);
    let placing = this.reanchoring.get(batch);
    if (!placing) {
      placing = this.place(projectId, root, notes, build.pdf, build.key, cacheKey);
      this.reanchoring.set(batch, placing);
      void placing.then(() => undefined, () => undefined).then(() => this.reanchoring.delete(batch));
    }
    return placing;
  }
  private reanchoring = new Map<string, Promise<Annotation[]>>();
  private async place(projectId: string, root: string, notes: Annotation[], pdfFile: string, buildKey: string, cacheKey: (note: Annotation) => string): Promise<Annotation[]> {
    const { PdfDocument } = await engine();
    const current = new PdfDocument(pdfFile), target = new AnnotationPages(current);
    const old = new Map<string, { document: InstanceType<typeof PdfDocument>; pages: AnnotationPages }>();
    try {
      const output: Annotation[] = [];
      for (const note of notes) {
        if (note.key === buildKey) { output.push(note); continue; }
        const key = cacheKey(note);
        if (!this.placements.has(key)) {
          let placement: Pick<Annotation, 'key' | 'page' | 'rect' | 'rects' | 'source'> | null = null;
          try {
            const pdf = await this.cachedPdf(root, note.key);
            if (pdf) {
              if (!old.has(pdf)) { const document = new PdfDocument(pdf); old.set(pdf, { document, pages: new AnnotationPages(document) }); }
              const match = await placeAnnotation(note, old.get(pdf)!.pages, target);
              if (match) {
                const { source } = await this.locate(projectId, buildKey, match.page, match.rect, match.rects, note.quote);
                placement = { ...match, key: buildKey, source };
              }
            }
          } catch { /* Keep the annotation intact when its position cannot be verified. */ }
          this.placements.set(key, placement);
        }
        const placement = this.placements.get(key);
        output.push(placement ? { ...note, ...placement } : note);
      }
      if (this.placements.size > 2000) this.placements.clear();
      if (this.oldPdfs.size > 500) this.oldPdfs.clear();
      return this.builds.get(projectId)?.key === buildKey ? output : notes;
    } finally { current.close(); for (const entry of old.values()) entry.document.close(); }
  }

  // Every problem of the last finished build, placed on its PDF when there is
  // one. Placing runs SyncTeX per problem, once per build.
  async problems(projectId: string): Promise<ManuscriptProblems> {
    const build = this.builds.get(projectId);
    if (!build?.problems) return { status: build?.status || 'building', problems: [], log: Boolean(build?.log) };
    const { problems, problemsKey: key, pdf } = build;
    if (!key || key !== build.key || !pdf) return { status: build.status, problems: sortProblems(problems.map(({ source: _source, occurrence: _occurrence, ...problem }) => problem)), log: Boolean(build.log) };
    let placed = this.located.get(problems);
    if (!placed) {
      placed = (async () => {
        const { PdfDocument } = await engine();
        // Most problems need only a page's size; its text, which takes up to
        // a hundred milliseconds to read on a busy page, is read when a
        // missing reference or citation is searched for on it.
        const document = new PdfDocument(pdf), pages = new Map<number, { destroy(): void; getBounds(): number[]; search(needle: string, options: object): number[][][] }>();
        try {
          return sortProblems(await locateProblems(problems, pdf, page => {
            if (!Number.isInteger(page) || page < 0 || page >= document.length) return null;
            if (!pages.has(page)) pages.set(page, document.raw.loadPage(page));
            const raw = pages.get(page)!, bounds = raw.getBounds();
            return {
              bounds, width: bounds[2] - bounds[0], height: bounds[3] - bounds[1],
              search: (needle: string) => raw.search(needle, {}).flat().map(q => [Math.min(q[0], q[2], q[4], q[6]), Math.min(q[1], q[3], q[5], q[7]), Math.max(q[0], q[2], q[4], q[6]), Math.max(q[1], q[3], q[5], q[7])]),
            };
          }));
        } finally { for (const page of pages.values()) page.destroy(); document.close(); }
      })();
      placed.catch(() => this.located.delete(problems));
      this.located.set(problems, placed);
    }
    return { status: build.status, key, problems: await placed, log: Boolean(build.log) };
  }

  log(projectId: string) {
    const build = this.builds.get(projectId);
    if (!build?.log || !fs.existsSync(build.log)) throw Object.assign(new Error('There is no compilation log yet.'), { statusCode: 404 });
    return scrubLog(fs.readFileSync(build.log, 'utf8'), build.logFolder);
  }

  // Compile the task's frozen source tree, then retain its PDF outside the build cache.
  // A preview build of the same tree is shared, not repeated.
  async captureReview(root: string, worktree: string, taskId: string): Promise<ReviewSnapshot> {
    const { Builder, BuildError, Repo, loadProject } = await engine();
    const tree = await workingTree(worktree);
    let result;
    try { result = await new Builder(loadProject(root), new Repo(root)).build(tree, ['full']); }
    catch (error) { throw error instanceof BuildError ? new Error('The manuscript could not be compiled for AI review. Fix the errors shown in the manuscript preview, then try again.') : error; }
    const key = createHash('sha256').update(fs.readFileSync(result.pdf)).digest('hex').slice(0, 16);
    const snapshot = await this.snapshotPdf(result.pdf, key);
    // The task does not exist yet, so a PDF kept by an earlier failed attempt is replaced.
    return { ...snapshot, pdf: await this.preserveReviewPdf(root, taskId, result.pdf, true) };
  }

  private async reviewPdfPath(root: string, taskId: string) {
    const { loadProject } = await engine();
    return path.join(loadProject(root).state, 'ai-reviews', createHash('sha256').update(taskId).digest('hex'), 'review.pdf');
  }

  async savedReviewPdf(root: string, taskId: string): Promise<string | null> {
    const pdf = await this.reviewPdfPath(root, taskId);
    return fs.existsSync(pdf) ? pdf : null;
  }

  async preserveReviewPdf(root: string, taskId: string, source: string, replace = false) {
    const pdf = await this.reviewPdfPath(root, taskId), folder = path.dirname(pdf);
    fs.mkdirSync(folder, { recursive: true });
    // A retry always uses the original task copy, even after its build cache is pruned.
    if (replace || !fs.existsSync(pdf)) { const temporary = path.join(folder, 'review.tmp'); fs.copyFileSync(source, temporary); fs.renameSync(temporary, pdf); }
    return pdf;
  }

  async cachedPdf(root: string, key: string): Promise<string | null> {
    const lookup = `${root}:${key}`;
    if (this.oldPdfs.has(lookup)) return this.oldPdfs.get(lookup)!;
    const { loadProject } = await engine();
    const cache = path.join(loadProject(root).state, 'cache/builds');
    let found: string | null = null;
    const entries = await fs.promises.readdir(cache, { withFileTypes: true }).catch(() => []);
    for (let at = 0; at < entries.length && !found; at += 32)
      await Promise.all(entries.slice(at, at + 32).map(async entry => {
        if (!entry.isDirectory() || entry.name.endsWith('.lock')) return;
        try {
          const folder = path.join(cache, entry.name), saved = JSON.parse(await fs.promises.readFile(path.join(folder, 'result.json'), 'utf8'));
          if (typeof saved.pdf !== 'string' || !path.resolve(saved.pdf).startsWith(path.resolve(folder) + path.sep)) return;
          if (createHash('sha256').update(saved.key + saved.pdf).digest('hex').slice(0, 16) === key && fs.existsSync(saved.pdf)) found = saved.pdf;
        } catch { /* Incomplete builds have no usable PDF. */ }
      }));
    this.oldPdfs.set(lookup, found); return found;
  }

  async placeReviewNote(projectId: string, root: string, note: Annotation, pdf: string): Promise<Annotation> {
    const state = await this.state(projectId, root);
    if (!state.build.current || !state.build.key) throw new Error('Wait for the current manuscript PDF to finish compiling, then copy the suggestion again.');
    const key = state.build.key, { PdfDocument } = await engine();
    const original = new PdfDocument(pdf), current = new PdfDocument(this.pdf(projectId, key));
    try {
      const match = await placeAnnotation(note, new AnnotationPages(original), new AnnotationPages(current));
      if (!match) throw new Error('This passage could not be located reliably in the current manuscript. The suggestion remains in the review task.');
      const { source } = await this.locate(projectId, key, match.page, match.rect, match.rects, note.quote);
      const latest = await this.state(projectId, root);
      if (!latest.build.current || latest.build.key !== key) throw new Error('The manuscript changed while copying this suggestion. Try again.');
      return { ...note, ...match, key, source };
    } finally { original.close(); current.close(); }
  }

  async snapshotPdf(pdf: string, key: string): Promise<ReviewSnapshot> {
    const { PdfDocument } = await engine();
    const document = new PdfDocument(pdf), lines: ReviewSnapshot['lines'] = [];
    let length = 0;
    try {
      for (let index = 0; index < document.length; index++) {
        const page = document.page(index), [left, top, right, bottom] = page.bounds;
        for (const [number, line] of page.lines.entries()) {
          const text = line.chars.map((char: { text: string }) => char.text).join('').trim();
          if (!text) continue;
          length += text.length;
          if (length > 180000) throw new Error('This PDF is too long for one AI review (180,000 characters maximum).');
          const [x0, y0, x1, y1] = line.rect;
          const rect = [(x0 - left) / (right - left), (y0 - top) / (bottom - top), (x1 - left) / (right - left), (y1 - top) / (bottom - top)].map(value => Math.max(0, Math.min(1, value))) as Rect;
          if (rect[2] <= rect[0] || rect[3] <= rect[1]) continue;
          lines.push({ id: `p${index + 1}-l${number + 1}`, page: index, text, rect });
        }
      }
      if (!lines.length) throw new Error('This PDF has no selectable text to review.');
      return { key, lines };
    } finally { document.close(); }
  }

  pdf(projectId: string, key: string) {
    const build = this.builds.get(projectId);
    if (!build?.pdf || build.key !== key) throw Object.assign(new Error('This manuscript preview is out of date. Refresh it and try again.'), { statusCode: 404 });
    return build.pdf;
  }

  // The PDF with the paper's notes drawn on it, to share with people outside Papilot.
  async annotatedPdf(projectId: string, key: string, notes: ExportNote[]) {
    const pdf = this.pdf(projectId, key), { mupdf } = await engine();
    return annotatePdf(mupdf, fs.readFileSync(pdf), notes);
  }

  // A note keeps the text under the marked region and its LaTeX source, so it
  // stays meaningful after the manuscript changes and the preview recompiles.
  // A text selection arrives as one rectangle per line plus the selected text;
  // a marked region arrives as one rectangle.
  // Word places for the PDF view's selection layer, cached per build and page.
  private wordCache = new Map<string, Awaited<ReturnType<typeof pdfWords>>>();
  async words(projectId: string, key: string, page: number) {
    const cacheKey = `${projectId}:${key}:${page}`, cached = this.wordCache.get(cacheKey);
    if (cached) return cached;
    const result = await pdfWords(this.pdf(projectId, key), page);
    if (this.wordCache.size > 200) this.wordCache.delete(this.wordCache.keys().next().value!);
    this.wordCache.set(cacheKey, result);
    return result;
  }

  async locate(projectId: string, key: string, page: number, rect: Rect, rects: Rect[] = [], selected = '') {
    const pdf = this.pdf(projectId, key), build = this.builds.get(projectId)!;
    const { PdfDocument, containsCenter } = await engine();
    const document = new PdfDocument(pdf);
    try {
      if (!Number.isInteger(page) || page < 0 || page >= document.length) throw Object.assign(new Error('That page is not part of the manuscript.'), { statusCode: 400 });
      const current = document.page(page), [x0, y0, x1, y1] = current.bounds, width = x1 - x0, height = y1 - y0;
      const toPage = (r: Rect) => [x0 + r[0] * width, y0 + r[1] * height, x0 + r[2] * width, y0 + r[3] * height];
      const clips = (rects.length ? rects : [rect]).map(toPage);
      const quote = (selected || clips.map(clip => current.text(clip)).join(' ')).replace(/\uFFFD/g, '').replace(/\s+/g, ' ').trim().slice(0, 600);
      // Ask SyncTeX about the first and last marked character of every line, so
      // the source range covers the whole selection rather than its first line.
      const points: [number, number][] = [], centre = (r: number[]): [number, number] => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
      let first: Anchor | null = null, last: Anchor | null = null;
      for (const line of current.lines as { chars: { text: string; rect: number[] }[] }[]) {
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
        const relative = path.relative(build.root || path.dirname(hit.input), hit.input);
        const file = path.posix.join(build.sourceDir || '', (relative.startsWith('..') ? path.basename(hit.input) : relative).split(path.sep).join('/'));
        files.set(file, { input: hit.input, lines: [...(files.get(file)?.lines || []), hit.line] });
      }
      const [file, found] = [...files].sort((a, b) => b[1].lines.length - a[1].lines.length)[0] || [];
      if (!file || !found) return { quote, source: null };
      const source = fs.existsSync(found.input) ? fs.readFileSync(found.input, 'utf8').split('\n') : [];
      const lines = settleLines(source, [Math.min(...found.lines), Math.max(...found.lines)], first, last);
      return { quote, source: { file, lines, excerpt: sourceExcerpt(found.input, lines) } };
    } finally { document.close(); }
  }

}
