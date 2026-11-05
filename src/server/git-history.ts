import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs, { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { GitDiff, GitHistory, GitVersion, GitVersionDetail } from '../shared.ts';
import { gitStatus } from './manuscript.ts';

const exec = promisify(execFile);
async function git(root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  try {
    return (await exec('git', args, { cwd: root, timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0', ...env } })).stdout;
  } catch (error) {
    const failure = error as { stderr?: string; message: string };
    throw new Error(failure.stderr?.trim() || failure.message);
  }
}
const format = '--format=%H%x00%an%x00%ct%x00%B';
function versions(output: string): GitVersion[] {
  const fields = output.split('\0'), result: GitVersion[] = [];
  for (let i = 0; i + 3 < fields.length; i += 4) result.push({ hash: fields[i], author: fields[i + 1], date: Number(fields[i + 2]) * 1000, message: fields[i + 3].trimEnd() });
  return result;
}
async function versionHash(root: string, hash: string) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash)) throw new Error('Choose a version from this manuscript’s history.');
  await git(root, ['merge-base', '--is-ancestor', hash, 'HEAD']);
  return hash;
}

// Follow the manuscript's first-parent history: a merged task is one version,
// rather than a second timeline of its intermediate worktree commits.
export async function gitHistory(root: string, before?: string): Promise<GitHistory> {
  let start = 'HEAD';
  if (before) start = await versionHash(root, before);
  else {
    try { await git(root, ['rev-parse', '--verify', 'HEAD']); }
    catch { return { versions: [], next: null }; }
  }
  const rows = versions(await git(root, ['log', '--first-parent', '-31', '-z', format, start, '--']));
  return { versions: rows.slice(0, 30), next: rows[30]?.hash || null };
}

export async function gitVersion(root: string, hash: string): Promise<GitVersionDetail> {
  await versionHash(root, hash);
  const [log, parents] = await Promise.all([
    git(root, ['log', '-1', '-z', format, hash, '--']),
    git(root, ['rev-list', '--parents', '-1', hash]),
  ]);
  const parent = parents.trim().split(' ')[1];
  const output = await git(root, parent ? ['diff', '--name-status', '-z', '--find-renames', parent, hash, '--']
    : ['diff-tree', '--root', '-r', '--no-commit-id', '--name-status', '-z', hash, '--']);
  const fields = output.split('\0'), files: GitVersionDetail['files'] = [];
  for (let i = 0; fields[i];) {
    const status = fields[i++][0], first = fields[i++];
    files.push(status === 'R' || status === 'C' ? { status, from: first, path: fields[i++] } : { status, path: first });
  }
  return { version: versions(log)[0], files };
}

export async function gitVersionDiff(root: string, hash: string, file: string): Promise<GitDiff> {
  const detail = await gitVersion(root, hash), entry = detail.files.find(item => item.path === file);
  if (!entry) throw Object.assign(new Error('This file did not change in this version.'), { statusCode: 404 });
  // --diff-merges=first-parent makes a merge's changes match the version list.
  const diff = await git(root, ['show', '--format=', '--no-color', '--diff-merges=first-parent', '--no-ext-diff', '--no-textconv', '--find-renames', hash, '--', ...(entry.from ? [entry.from, file] : [file])]);
  return { path: file, diff: diff.slice(0, 400_000), truncated: diff.length > 400_000 };
}

function overwritesIgnoredFiles(root: string, targets: string[], ignored: string[]) {
  if (!ignored.length) return false;
  const checkout = realpathSync.native(root);
  type Entry = { paths: string[]; directory: boolean };
  const cache = new Map<string, Entry | null>(), listings = new Map<string, string[]>();
  const entry = (parent: string, name: string) => {
    const filename = join(parent, name);
    if (!cache.has(filename)) {
      try {
        const stat = lstatSync(filename, { bigint: true });
        // Exact directory entries distinguish hardlinks. For case/Unicode
        // aliases, ask the filesystem which stored entries match instead of
        // assuming realpath canonicalizes spelling on every filesystem.
        const names = listings.get(parent) ?? readdirSync(parent);
        listings.set(parent, names);
        let paths = (names.includes(name) ? [name] : names.filter(candidate => {
          const other = lstatSync(join(parent, candidate), { bigint: true });
          return other.dev === stat.dev && other.ino === stat.ino;
        })).map(candidate => join(parent, candidate));
        if (paths.length > 1 && !stat.isSymbolicLink()) {
          const canonical = realpathSync.native(filename);
          // Some filesystems can also identify an aliased hardlink's name.
          // Otherwise keep all candidates, conservatively protecting them.
          if (paths.includes(canonical)) paths = [canonical];
        }
        if (!paths.length) throw Object.assign(new Error('The current version changed. Refresh the history and try again.'), { statusCode: 409 });
        cache.set(filename, { paths, directory: stat.isDirectory() });
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
        cache.set(filename, null);
      }
    }
    return cache.get(filename)!;
  };
  function* entries(name: string) {
    const parts = name.split('/');
    let parent = checkout;
    for (let i = 0; i < parts.length; i++) {
      const found = entry(parent, parts[i]);
      if (!found) return;
      yield { paths: found.paths, leaf: i === parts.length - 1 };
      // Git replaces a tracked file/link when a target needs a directory;
      // it does not write through that link into its destination.
      if (!found.directory) return;
      parent = found.paths[0];
    }
  }
  const ignoredFiles = new Set<string>(), ignoredParents = new Set<string>();
  for (const name of ignored) for (const item of entries(name)) {
    for (const filename of item.paths) (item.leaf ? ignoredFiles : ignoredParents).add(filename);
  }
  return targets.some(name => {
    for (const item of entries(name)) {
      if (item.paths.some(filename => ignoredFiles.has(filename) || (item.leaf && ignoredParents.has(filename)))) return true;
    }
    return false;
  });
}

// Do not follow a leading link when inspecting a checkout or rolling it back.
function checkoutEntry(root: string, name: string) {
  const parts = name.split('/');
  let filename = root;
  for (let i = 0; i < parts.length; i++) {
    filename = join(filename, parts[i]);
    const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
    if (!stat || (i < parts.length - 1 && !stat.isDirectory())) return null;
    if (i === parts.length - 1) return stat;
  }
  return null;
}
function copyCheckoutEntry(from: string, to: string, name: string) {
  const stat = checkoutEntry(from, name);
  if (!stat) return;
  const source = join(from, name), target = join(to, name);
  // mkdir on each component refuses existing files/links, including links
  // installed by a different process during a failed restore.
  let parent = to;
  for (const part of name.split('/').slice(0, -1)) {
    parent = join(parent, part);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent);
    if (!fs.lstatSync(parent).isDirectory()) throw new Error('Save current changes before restoring a version.');
  }
  if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), target);
  else if (stat.isFile()) { fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE); fs.chmodSync(target, stat.mode); }
  else throw new Error('Save current changes before restoring a version.');
}
function sameCheckoutEntry(one: string, two: string, name: string) {
  const a = checkoutEntry(one, name), b = checkoutEntry(two, name);
  if (!a || !b) return a === b;
  if (a.isSymbolicLink() || b.isSymbolicLink()) return a.isSymbolicLink() && b.isSymbolicLink() && fs.readlinkSync(join(one, name)) === fs.readlinkSync(join(two, name));
  if (!a.isFile() || !b.isFile() || a.size !== b.size || (a.mode & 0o777) !== (b.mode & 0o777)) return false;
  // Compare in bounded chunks: papers may contain large figures or data files.
  const first = fs.openSync(join(one, name), 'r');
  try {
    const second = fs.openSync(join(two, name), 'r');
    try {
      const left = Buffer.allocUnsafe(65536), right = Buffer.allocUnsafe(65536);
      for (;;) {
        const n = fs.readSync(first, left), m = fs.readSync(second, right);
        if (n !== m || !left.subarray(0, n).equals(right.subarray(0, m))) return false;
        if (!n) return true;
      }
    } finally { fs.closeSync(second); }
  } finally { fs.closeSync(first); }
}

function rollbackCheckout(root: string, backup: string, prepared: string, changed: string[], index: string, before: Buffer, installed: Buffer) {
  const lock = index + '.lock';
  let descriptor: number | undefined;
  let ownsLock = false;
  try {
    descriptor = fs.openSync(lock, 'wx');
    ownsLock = true;
    if (!fs.readFileSync(index).equals(installed)) return false;
    let complete = true;
    for (const name of changed) {
      if (sameCheckoutEntry(root, backup, name)) continue;
      const current = checkoutEntry(root, name);
      if (!current || current.isDirectory()) continue;
      // Remove only bytes we prepared. Preserve concurrent edits, even when
      // that means leaving the recovery copy for the author to inspect.
      if (sameCheckoutEntry(root, prepared, name)) fs.unlinkSync(join(root, name));
      else complete = false;
    }
    const directories = new Set(changed.flatMap(name => name.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
    for (const name of [...directories].sort((a, b) => b.split('/').length - a.split('/').length)) {
      if (!checkoutEntry(root, name)?.isDirectory()) continue;
      try { fs.rmdirSync(join(root, name)); }
      catch (error) { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code || '')) throw error; }
    }
    for (const name of changed) {
      if (sameCheckoutEntry(root, backup, name)) continue;
      if (checkoutEntry(root, name)) { complete = false; continue; }
      try { copyCheckoutEntry(backup, root, name); }
      catch { complete = false; }
    }
    fs.writeFileSync(descriptor, before); fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(lock, index);
    ownsLock = false;
    return complete;
  } catch { return false; }
  finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (ownsLock) fs.rmSync(lock, { force: true });
  }
}

// Restore the selected tree as a NEW child of HEAD. No reset, lost history,
// stash, or remote write. Check ignored files explicitly: Git's two-tree
// merge protects ordinary edits but may overwrite ignored build output.
export async function gitRestoreVersion(root: string, hash: string, expectedHead: string) {
  await versionHash(root, hash);
  const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
  if (head !== expectedHead) throw Object.assign(new Error('The current version changed. Refresh the history and try again.'), { statusCode: 409 });
  const status = await gitStatus(root);
  if (status.merging || status.files.length) throw Object.assign(new Error('Save current changes before restoring a version.'), { statusCode: 409 });
  if (!status.branch) throw Object.assign(new Error('Check out a branch before restoring a version.'), { statusCode: 409 });
  // Rebase and cherry-pick can have a clean working tree between steps.
  for (const marker of ['rebase-merge', 'rebase-apply', 'sequencer', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    const filename = (await git(root, ['rev-parse', '--git-path', marker])).trim();
    if (existsSync(resolve(root, filename))) throw Object.assign(new Error('Finish the current Git operation before restoring a version.'), { statusCode: 409 });
  }
  const [tree, currentTree] = await Promise.all([git(root, ['rev-parse', `${hash}^{tree}`]), git(root, ['rev-parse', `${head}^{tree}`])]);
  if (tree === currentTree) throw Object.assign(new Error('The manuscript already matches this version.'), { statusCode: 409 });
  const entries = await git(root, ['ls-tree', '-r', hash]);
  const currentEntries = await git(root, ['ls-tree', '-r', head]);
  if (/^160000 /m.test(entries + currentEntries)) throw new Error('Restore repositories with submodules using Git.');
  const targetPaths = (await git(root, ['ls-tree', '-r', '-z', '--name-only', hash])).split('\0').filter(Boolean);
  const ignored = (await git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  if (overwritesIgnoredFiles(root, targetPaths, ignored)) {
    throw Object.assign(new Error('Move local ignored files out of the way before restoring this version.'), { statusCode: 409 });
  }
  const gitDir = (await git(root, ['rev-parse', '--absolute-git-dir'])).trim();
  const index = resolve(root, (await git(root, ['rev-parse', '--git-path', 'index'])).trim());
  const currentPaths = (await git(root, ['ls-tree', '-r', '-z', '--name-only', head])).split('\0').filter(Boolean);
  const changed = (await git(root, ['diff', '--name-only', '--no-renames', '-z', head, hash, '--'])).split('\0').filter(Boolean);
  const folder = fs.mkdtempSync(join(gitDir, 'papilot-restore-')), backup = join(folder, 'before'), prepared = join(folder, 'prepared');
  let keep = false;
  try {
    fs.mkdirSync(backup); fs.mkdirSync(prepared);
    for (const name of currentPaths) { copyCheckoutEntry(root, backup, name); copyCheckoutEntry(backup, prepared, name); }
    const env = { GIT_DIR: gitDir, GIT_WORK_TREE: prepared, GIT_INDEX_FILE: join(folder, 'index') };
    // Git filters/LFS and file-type transitions must succeed in a disposable
    // checkout before any real manuscript file is replaced.
    await git(prepared, ['read-tree', head], env);
    await git(prepared, ['update-index', '--refresh'], env);
    await git(prepared, ['read-tree', '-m', '-u', head, hash], env);
    if ((await git(root, ['rev-parse', 'HEAD'])).trim() !== head) throw Object.assign(new Error('The current version changed. Refresh the history and try again.'), { statusCode: 409 });
    if ((await gitStatus(root)).files.length || changed.some(name => !sameCheckoutEntry(root, backup, name) && currentPaths.includes(name))) throw Object.assign(new Error('Save current changes before restoring a version.'), { statusCode: 409 });
    const localIgnored = (await git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
    if (overwritesIgnoredFiles(root, targetPaths, localIgnored)) throw Object.assign(new Error('Move local ignored files out of the way before restoring this version.'), { statusCode: 409 });
    const subject = (await git(root, ['log', '-1', '--format=%s', hash])).trim();
    const commit = (await git(root, ['commit-tree', tree.trim(), '-p', head, '-m', `Restore version: ${subject}`, '-m', `Restores ${hash}. Previous versions remain in history.`])).trim();
    const before = fs.readFileSync(index);
    let installed = before;
    try {
      await git(root, ['read-tree', '-m', '-u', head, hash]);
      installed = fs.readFileSync(index);
      await git(root, ['update-ref', '-m', `Restore version ${hash.slice(0, 7)}`, 'HEAD', commit, head]);
    } catch (error) {
      let unchangedHead = false;
      try { unchangedHead = (await git(root, ['rev-parse', 'HEAD'])).trim() === head; } catch { /* Preserve the backup if Git cannot confirm ownership. */ }
      keep = !unchangedHead || !rollbackCheckout(root, backup, prepared, changed, index, before, installed);
      if (keep) throw new Error(`Restore failed. Previous files are saved at ${backup}.`, { cause: error });
      throw error;
    }
    return { commit, git: await gitStatus(root) };
  } finally { if (!keep) fs.rmSync(folder, { recursive: true, force: true }); }
}
