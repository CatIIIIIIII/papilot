import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GitDiff, GitHistory, GitVersion, GitVersionDetail } from '../shared.ts';
import { gitStatus } from './manuscript.ts';

const exec = promisify(execFile);
async function git(root: string, args: string[]) {
  try {
    return (await exec('git', args, { cwd: root, timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0' } })).stdout;
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
  const targetPaths = new Set((await git(root, ['ls-tree', '-r', '-z', '--name-only', hash])).split('\0').filter(Boolean));
  const ancestors = (name: string) => name.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));
  const targetParents = new Set([...targetPaths].flatMap(ancestors));
  const ignored = (await git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  if (ignored.some(name => targetPaths.has(name) || targetParents.has(name) || ancestors(name).some(parent => targetPaths.has(parent)))) {
    throw Object.assign(new Error('Move local ignored files out of the way before restoring this version.'), { statusCode: 409 });
  }
  const subject = (await git(root, ['log', '-1', '--format=%s', hash])).trim();
  // Constructing the object first checks author identity before touching files.
  const commit = (await git(root, ['commit-tree', tree.trim(), '-p', head, '-m', `Restore version: ${subject}`, '-m', `Restores ${hash}. Previous versions remain in history.`])).trim();
  await git(root, ['read-tree', '-m', '-u', head, hash]);
  try { await git(root, ['update-ref', '-m', `Restore version ${hash.slice(0, 7)}`, 'HEAD', commit, head]); }
  catch (error) {
    // Never force a rollback over concurrent edits. If it cannot be applied,
    // leave the restored files as pending changes; the old history still exists.
    await git(root, ['read-tree', '-m', '-u', hash, head]).catch(() => undefined);
    throw error;
  }
  return { commit, git: await gitStatus(root) };
}
