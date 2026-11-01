import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { DATA, ENGINE } from './paths.ts';
import type { PaperImport, Project } from '../shared.ts';
import type { Manuscripts } from './manuscript.ts';

const execute = promisify(execFile);
// These limits apply to uploads, not folders already on this computer.
const MAX_BYTES = 64 * 1024 * 1024, MAX_FILES = 5000;
const CONFIG = '.latex-review.json';
const skip = (name: string) => ['.git', '__macosx', '.ds_store', 'node_modules', '.papilot'].includes(name.toLowerCase()) || name.startsWith('._');
const git = async (root: string, ...args: string[]) => (await execute('git', ['-C', root, ...args], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
function safeName(name: unknown): string {
  if (typeof name !== 'string' || !name || name.length > 4000 || /[\\\x00-\x1f:]/.test(name) || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid file path in upload.');
  return name;
}
function bytes(value: unknown) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_BYTES / 3) * 4 || value.length % 4 || /[^A-Za-z0-9+/=]/.test(value) || /=/.test(value.slice(0, -2)) || /=[^=]$/.test(value)) throw new Error('Invalid upload data.');
  return Buffer.from(value, 'base64');
}
function config(root: string): Record<string, unknown> {
  const file = path.join(root, CONFIG);
  if (!fs.existsSync(file)) return {};
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('The paper configuration must not be a symbolic link.');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('The paper configuration must contain a JSON object.');
  return data;
}
export function texFiles(root: string) {
  const files: string[] = [], folders = [''];
  while (folders.length) {
    const folder = folders.pop()!;
    for (const item of fs.readdirSync(path.join(root, folder), { withFileTypes: true })) {
      if (skip(item.name) || ['build', 'out', 'output'].includes(item.name)) continue;
      const file = path.posix.join(folder, item.name);
      if (item.isDirectory()) folders.push(file);
      else if (item.isFile() && /\.tex$/i.test(file)) files.push(file);
    }
  }
  return files.sort();
}
function existingTex(root: string, file: unknown): file is string {
  if (typeof file !== 'string' || !/\.tex$/i.test(file)) return false;
  try {
    safeName(file);
    let current = root;
    for (const part of file.split('/')) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) return false;
    }
    return fs.statSync(current).isFile();
  } catch { return false; }
}
function sourceHead(file: string) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(300000);
    return buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8');
  } finally { fs.closeSync(fd); }
}
export async function inspectPaper(root: string) {
  let settings: Record<string, unknown> = {}, error: string | undefined;
  try { settings = config(root); } catch (failure) { error = (failure as Error).message; }
  let main = existingTex(root, settings.main) ? settings.main : '', engine = '';
  // Most papers already declare their main file or keep it near the root.
  // Do not enumerate caches, assets and supporting papers just to open them.
  if (!main) {
    try {
      const module = await import(pathToFileURL(path.join(ENGINE, 'src/core/config.ts')).href);
      const detected = module.detectMain(root);
      if (existingTex(root, detected)) main = detected;
    } catch { /* Unusual layouts fall back to a deeper search. */ }
  }
  let candidates = main ? [main] : [];
  if (!main) {
    const files = texFiles(root), roots = files.filter(file => {
      const text = sourceHead(path.join(root, file)).replace(/(?<!\\)%[^\n]*/g, '');
      return /\\documentclass\b/.test(text) && /\\begin\s*\{document\}/.test(text);
    });
    main = roots.length === 1 ? roots[0] : '';
    const found = new Set(roots);
    candidates = [...roots, ...files.filter(file => !found.has(file))];
  }
  try {
    // Engine detection also works before Git initialization by reading the source hints.
    if (main) {
      const text = sourceHead(path.join(root, main));
      engine = typeof settings.engine === 'string' ? settings.engine : '';
      const rc = [path.join(path.dirname(main), '.latexmkrc'), path.join(path.dirname(main), 'latexmkrc'), '.latexmkrc', 'latexmkrc'].find(file => fs.existsSync(path.join(root, file)));
      const mode = rc ? fs.readFileSync(path.join(root, rc), 'utf8').match(/^\s*\$pdf_mode\s*=\s*(\d)/m)?.[1] : undefined;
      if (!engine) engine = text.match(/^%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*(pdflatex|xelatex|lualatex)/im)?.[1].toLowerCase() || ({ '1': 'pdflatex', '4': 'lualatex', '5': 'xelatex' } as Record<string, string>)[mode || ''] || (/\\(?:usepackage(?:\[[^\]]*\])?\{[^}]*\b(?:fontspec|xeCJK|unicode-math|polyglossia)\b|documentclass(?:\[[^\]]*\])?\{ctex)/.test(text) ? 'xelatex' : 'pdflatex');
    }
  } catch (failure) { error = (failure as Error).message; }
  return { candidates, main, engine: engine || 'pdflatex', error };
}
async function repositoryRoot(root: string) {
  let top: string | undefined;
  try { top = await git(root, 'rev-parse', '--show-toplevel'); } catch { /* A plain folder needs Git. */ }
  if (top && fs.realpathSync(top) !== root) throw new Error('This folder belongs to a parent Git repository. Select its root folder, or upload a copy.');
  return top;
}
export async function prepareRepository(root: string) {
  const top = await repositoryRoot(root);
  if (!top) await git(root, 'init', '-q');
  try { await git(root, 'rev-parse', '--verify', 'HEAD'); return; } catch { /* Empty repositories need their first snapshot. */ }
  // Do not change the author's global identity or overwrite their ignore rules.
  if (!fs.existsSync(path.join(root, '.gitignore'))) fs.writeFileSync(path.join(root, '.gitignore'), '*.aux\n*.log\n*.fls\n*.fdb_latexmk\n*.synctex.gz\n*.toc\n*.out\n.DS_Store\n');
  await git(root, 'add', '--all');
  await git(root, '-c', 'user.name=Papilot', '-c', 'user.email=papilot@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Import paper into Papilot');
}
export async function extractZip(buffer: Buffer, root: string) {
  if (buffer.length > MAX_BYTES) throw new Error('Choose a ZIP smaller than 64 MB.');
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, value) => error ? reject(error) : resolve(value)));
  await new Promise<void>((resolve, reject) => {
    let count = 0, total = 0;
    const fail = (error: unknown) => { zip.close(); reject(error); };
    zip.on('error', fail); zip.on('end', resolve);
    zip.on('entry', (entry: yauzl.Entry) => { void (async () => {
      if (++count > MAX_FILES || (total += entry.uncompressedSize) > MAX_BYTES) throw new Error('The ZIP expands beyond 64 MB or 5,000 files.');
      const name = safeName(entry.fileName.replace(/\/$/, ''));
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (mode && mode !== 0o100000 && mode !== 0o040000) throw new Error('ZIP links and special files are not supported.');
      if (name.split('/').some(skip) || entry.fileName.endsWith('/')) { zip.readEntry(); return; }
      const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true });
      const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
      await pipeline(stream, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 })); zip.readEntry();
    })().catch(fail); });
    zip.readEntry();
  });
}

export class PaperImports {
  private sessions = new Map<string, PaperImport>();
  private active = new Set<string>();
  get busy() { return this.active.size > 0; }
  constructor(private manuscripts: Manuscripts, private directory = DATA, private registered: (root: string) => boolean = () => false) {
    const folder = path.join(directory, 'imports');
    if (fs.existsSync(folder)) for (const file of fs.readdirSync(folder)) {
      if (/^[a-f0-9-]{36}\.json$/.test(file)) try { this.get(file.slice(0, -5)); } catch { /* An unreadable receipt must not prevent other papers from opening. */ }
    }
  }
  private save(value: PaperImport) {
    fs.mkdirSync(path.join(this.directory, 'imports'), { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, 'imports', value.id + '.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 }); fs.renameSync(file + '.tmp', file);
    this.sessions.set(value.id, value); return { ...value };
  }
  get(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Import not found.');
    let value = this.sessions.get(id);
    if (!value) {
      value = JSON.parse(fs.readFileSync(path.join(this.directory, 'imports', id + '.json'), 'utf8')) as PaperImport;
      if (['building', 'repairing'].includes(value.phase)) Object.assign(value, { phase: 'failed', error: 'Papilot restarted. Retry compilation to continue this import.' });
      this.sessions.set(id, value);
    }
    return { ...value };
  }
  async create(input: { path?: unknown; name?: unknown; zip?: unknown; files?: unknown }) {
    const id = randomUUID(); let root = '', copied = false;
    if ([input.path, input.zip, input.files].filter(value => value !== undefined).length !== 1) throw new Error('Choose one folder or ZIP.');
    if (input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 120)) throw new Error('Paper name is too long.');
    try {
      if (input.path !== undefined) {
        if (typeof input.path !== 'string' || !input.path.trim()) throw new Error('Enter a folder path.');
        root = fs.realpathSync(input.path.startsWith('~/') ? path.join(os.homedir(), input.path.slice(2)) : input.path);
        if (!fs.statSync(root).isDirectory()) throw new Error('Select a folder containing the paper.');
      } else {
        root = path.join(this.directory, 'papers', id); copied = true; fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        if (input.zip !== undefined) await extractZip(bytes(input.zip), root);
        else {
          if (!Array.isArray(input.files) || !input.files.length || input.files.length > MAX_FILES) throw new Error('Choose between 1 and 5,000 files.');
          let total = 0;
          for (const file of input.files) {
            const name = safeName(file.path);
            if (name.split('/').some(skip)) continue;
            const data = bytes(file.data); total += data.length;
            if (total > MAX_BYTES) throw new Error('Choose a folder smaller than 64 MB.');
            const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data, { flag: 'wx', mode: 0o600 });
          }
        }
        // Unwrap export folders (Overleaf and GitHub ZIPs commonly have one).
        let children = fs.readdirSync(root).filter(name => !skip(name));
        while (children.length === 1 && fs.statSync(path.join(root, children[0])).isDirectory()) { root = path.join(root, children[0]); children = fs.readdirSync(root).filter(name => !skip(name)); }
      }
      if (this.registered(root)) throw new Error('This paper is already added. Open it from the paper list.');
      if (!copied && [...this.sessions.values()].some(item => item.path === root)) return this.get([...this.sessions.values()].find(item => item.path === root)!.id);
      const detected = await inspectPaper(root);
      const existing = !copied && [...this.sessions.values()].find(item => item.path === root);
      if (existing) return this.get(existing.id);
      return this.save({ id, path: root, copied, name: (input.name as string)?.trim() || path.basename(root), ...detected, phase: 'choose' });
    } catch (error) { if (copied) fs.rmSync(path.join(this.directory, 'papers', id), { recursive: true, force: true }); throw error; }
  }
  async build(id: string, input: { main?: unknown; engine?: unknown; name?: unknown }, repair?: (root: string, error: string) => Promise<string>) {
    const value = this.get(id);
    if (this.active.has(id)) return value;
    if (this.registered(value.path)) throw new Error('This paper is already added. Open it from the paper list.');
    const main = input.main ?? value.main, engine = input.engine ?? value.engine;
    if (!existingTex(value.path, main)) throw new Error('Choose an existing TeX main file.');
    if (!['pdflatex', 'xelatex', 'lualatex'].includes(engine as string)) throw new Error('Choose a supported LaTeX engine.');
    if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120)) throw new Error('Enter a paper name under 120 characters.');
    this.active.add(id);
    const previousError = value.error || '';
    Object.assign(value, { main, engine, ...(input.name ? { name: input.name } : {}), phase: repair ? 'repairing' : 'building', error: undefined });
    this.save(value);
    void (async () => {
      try {
        await repositoryRoot(value.path);
        if (!repair) {
          // Keep the author's settings, including a source folder that still
          // contains the main file; without one, the whole folder compiles.
          const settings = config(value.path), folder = typeof settings.source_dir === 'string' ? settings.source_dir.replace(/\/+$/, '') : null;
          const contains = folder === '' || (folder !== null && (main as string).startsWith(folder + '/'));
          const next = { ...settings, main, engine, ...(contains ? {} : { source_dir: '' }) };
          if (JSON.stringify(next) !== JSON.stringify(settings)) fs.writeFileSync(path.join(value.path, CONFIG), JSON.stringify(next, null, 2) + '\n');
        }
        await prepareRepository(value.path); value.versioned = true;
        if (repair) { value.summary = await repair(value.path, previousError); Object.assign(value, await inspectPaper(value.path)); }
        value.phase = 'building'; this.save(value);
        // A retry starts a new build without forcing a clean one, so the
        // opened paper finds this PDF in the cache instead of compiling again.
        this.manuscripts.forgetProject('import-' + id);
        let result = await this.manuscripts.state('import-' + id, value.path);
        while (result.build.status === 'building') { await new Promise(resolve => setTimeout(resolve, 400)); result = await this.manuscripts.state('import-' + id, value.path); }
        value.phase = result.build.status === 'ready' ? 'ready' : 'failed'; value.error = result.build.error;
      } catch (error) { value.phase = 'failed'; value.error = (error as Error).message; }
      finally { this.active.delete(id); this.save(value); }
    })();
    return this.get(id);
  }
  async finish(id: string, register: (root: string, name: string) => Promise<Project>) {
    const value = this.get(id);
    if (this.active.has(id) || !value.versioned) throw new Error('Wait for repository preparation to finish.');
    const project = await register(value.path, value.name);
    // Keep the receipt so a lost HTTP response can safely retry finalization.
    this.manuscripts.forgetProject('import-' + id); return project;
  }
}
