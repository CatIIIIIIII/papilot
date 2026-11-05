import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitCommit, gitDiff, gitStage, gitStatus, gitSync } from '../src/server/manuscript.ts';
import { parseGitDiff } from '../src/web/git-diff.ts';

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-sync-'));
  const remote = path.join(base, 'remote.git'), mine = path.join(base, 'mine'), other = path.join(base, 'other');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const write = (cwd: string, name: string, text: string) => fs.writeFileSync(path.join(cwd, name), text);
  function clone(target: string) {
    git(base, 'clone', '-q', remote, target);
    for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@localhost'], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(base, 'no-hooks')]]) git(target, 'config', key, value);
  }
  function edit(cwd: string, name: string, text: string) { write(cwd, name, text); git(cwd, 'add', '--', name); git(cwd, 'commit', '-qm', 'Edit ' + name); }
  git(base, 'init', '-q', '--bare', '-b', 'main', remote); clone(mine);
  write(mine, 'main.tex', 'Initial paper.\n'); write(mine, 'notes.md', 'Notes.\n');
  git(mine, 'add', '.'); git(mine, 'commit', '-qm', 'Initial'); git(mine, 'push', '-qu', 'origin', 'main'); clone(other);
  return { base, remote, mine, other, git, write, edit, close: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('incoming status decorates only files changed upstream, including renames and unusual paths', async () => {
  const f = fixture();
  try {
    f.edit(f.mine, 'local.tex', 'Local commit.\n');
    f.write(f.mine, 'main.tex', 'Pending local revision.\n');
    f.write(f.mine, 'notes.md', 'Local notes.\n'); f.git(f.mine, 'add', 'notes.md');
    f.write(f.mine, 'local.tex', 'Local worktree edit.\n');
    f.write(f.mine, 'new file\twith space.tex', 'Local new file.\n');
    f.edit(f.other, 'main.tex', 'Incoming revision.\n');
    f.git(f.other, 'mv', 'notes.md', 'renamed notes.md');
    f.git(f.other, 'commit', '-qm', 'Rename notes');
    f.edit(f.other, 'new file\twith space.tex', 'Incoming new file.\n');
    f.git(f.other, 'push', '-q');
    assert.ok((await gitStatus(f.mine)).files.every(file => !file.incoming), 'No guessed decorations before fetching');
    f.git(f.mine, 'fetch', '-q');
    const status = await gitStatus(f.mine);
    const incoming = Object.fromEntries(status.files.map(file => [file.path, file.incoming]));
    assert.deepEqual(incoming, { 'local.tex': undefined, 'main.tex': 'M', 'notes.md': 'R', 'new file\twith space.tex': 'A' });
    assert.equal(status.files.find(file => file.path === 'notes.md')?.staged, true);
    f.git(f.mine, 'remote', 'remove', 'origin');
    assert.ok((await gitStatus(f.mine)).files.every(file => !file.incoming), 'Removing the remote clears decorations');
  } finally { f.close(); }
});

test('staged and unstaged diff views show the actual content to commit or discard', async () => {
  const f = fixture();
  try {
    f.write(f.mine, 'main.tex', 'Staged revision.\n');
    await gitStage(f.mine, ['main.tex'], true);
    f.write(f.mine, 'main.tex', 'Later revision.\n');
    const staged = (await gitDiff(f.mine, 'main.tex', 'staged')).diff;
    const unstaged = (await gitDiff(f.mine, 'main.tex', 'unstaged')).diff;
    assert.match(staged, /^-Initial paper\.$/m); assert.match(staged, /^\+Staged revision\.$/m);
    assert.doesNotMatch(staged, /Later revision/);
    assert.match(unstaged, /^-Staged revision\.$/m); assert.match(unstaged, /^\+Later revision\.$/m);
    assert.doesNotMatch(unstaged, /Initial paper/);
    assert.match((await gitDiff(f.mine, 'main.tex')).diff, /^-Initial paper\.$/m);
    await gitStage(f.mine, ['main.tex'], false);
    await assert.rejects(gitDiff(f.mine, 'main.tex', 'staged'), /no uncommitted changes/);
    assert.equal(fs.readFileSync(path.join(f.mine, 'main.tex'), 'utf8'), 'Later revision.\n');
    f.write(f.mine, 'new.tex', 'New staged file.\n'); await gitStage(f.mine, ['new.tex'], true);
    f.write(f.mine, 'new.tex', 'New file, edited again.\n');
    assert.match((await gitDiff(f.mine, 'new.tex', 'staged')).diff, /^\+New staged file\.$/m);
    assert.match((await gitDiff(f.mine, 'new.tex', 'unstaged')).diff, /^-New staged file\.$/m);
  } finally { f.close(); }
});

test('sync fetches new remote commits and preserves staged, unstaged and untracked edits', async () => {
  const f = fixture();
  try {
    f.edit(f.other, 'remote.tex', 'Remote contribution.\n'); f.git(f.other, 'push', '-q');
    f.write(f.mine, 'main.tex', 'Uncommitted draft.\n');
    f.write(f.mine, 'notes.md', 'Staged notes.\n'); f.git(f.mine, 'add', 'notes.md');
    f.write(f.mine, 'scratch.tex', 'Private draft.\n');
    assert.equal((await gitStatus(f.mine)).behind, 0, 'The tracking ref has not fetched yet');
    const status = await gitSync(f.mine);
    assert.deepEqual([status.ahead, status.behind, status.merging], [0, 0, null]);
    assert.equal(f.git(f.mine, 'rev-parse', 'HEAD'), f.git(f.remote, 'rev-parse', 'main'));
    assert.deepEqual(status.files.map(file => [file.path, file.staged]), [['main.tex', false], ['notes.md', true], ['scratch.tex', false]]);
    assert.equal(fs.readFileSync(path.join(f.mine, 'main.tex'), 'utf8'), 'Uncommitted draft.\n');
    assert.equal(f.git(f.mine, 'show', ':notes.md'), 'Staged notes.');
    assert.equal(f.git(f.mine, 'show', 'HEAD:notes.md'), 'Notes.');
    assert.equal(f.git(f.mine, 'stash', 'list'), '');
  } finally { f.close(); }
});

test('sync merges diverged history before pushing, and stops at conflicts', async () => {
  const f = fixture();
  try {
    f.edit(f.mine, 'local.tex', 'Local.\n'); f.edit(f.other, 'remote.tex', 'Remote.\n'); f.git(f.other, 'push', '-q');
    const merged = await gitSync(f.mine);
    assert.deepEqual([merged.ahead, merged.behind, merged.merging], [0, 0, null]);
    assert.equal(f.git(f.mine, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
    assert.equal(f.git(f.remote, 'rev-parse', 'main'), f.git(f.mine, 'rev-parse', 'HEAD'));
    f.git(f.other, 'pull', '-q', '--ff-only');
    f.edit(f.mine, 'main.tex', 'Local interpretation.\n');
    f.edit(f.other, 'main.tex', 'Remote interpretation.\n'); f.git(f.other, 'push', '-q');
    const before = f.git(f.remote, 'rev-parse', 'main');
    const conflict = await gitSync(f.mine);
    assert.deepEqual(conflict.merging?.conflicts, ['main.tex']);
    assert.equal(f.git(f.remote, 'rev-parse', 'main'), before, 'Conflicts are never pushed');
    const index = fs.readFileSync(path.join(f.mine, '.git', 'index'));
    const contents = fs.readFileSync(path.join(f.mine, 'main.tex'), 'utf8');
    assert.match(f.git(f.mine, 'diff', '--', 'main.tex'), /^diff --cc /, 'The real unmerged index produces a combined diff');
    for (const scope of ['all', 'unstaged', 'staged'] as const) {
      const patch = (await gitDiff(f.mine, 'main.tex', scope)).diff;
      assert.match(patch, /^@@ /m); assert.doesNotMatch(patch, /^@@@/m);
      const parsed = parseGitDiff(patch), visible = parsed.lines.map(line => line.text).join('\n');
      assert.ok(parsed.changes.length > 0, 'A conflicted file must never appear as no textual changes');
      assert.match(visible, /^<<<<<<< HEAD$/m); assert.match(visible, /^=======$/m); assert.match(visible, /^>>>>>>> /m);
      assert.match(visible, /^Local interpretation\.$/m); assert.match(visible, /^Remote interpretation\.$/m);
      assert.deepEqual(parsed.lines.filter(line => line.after !== undefined && line.kind !== 'hunk').map(line => line.after), [1, 2, 3, 4, 5]);
    }
    assert.deepEqual(fs.readFileSync(path.join(f.mine, '.git', 'index')), index, 'Reading conflicts must not stage them');
    assert.equal(fs.readFileSync(path.join(f.mine, 'main.tex'), 'utf8'), contents);
    await assert.rejects(gitSync(f.mine), /Finish or abort the merge/);
  } finally { f.close(); }
});

test('sync fails without overwriting a local edit that the remote also changes', async () => {
  for (const diverged of [false, true]) {
    const f = fixture();
    try {
      if (diverged) f.edit(f.mine, 'local.tex', 'Local committed draft.\n');
      f.edit(f.other, 'main.tex', 'Remote edit.\n'); f.git(f.other, 'push', '-q');
      f.write(f.mine, 'main.tex', 'Unsaved in Git.\n');
      f.git(f.mine, 'config', 'merge.autoStash', 'true');
      const before = f.git(f.mine, 'rev-parse', 'HEAD');
      await assert.rejects(gitSync(f.mine), /overwritten|commit your changes|Aborting/i);
      assert.equal(fs.readFileSync(path.join(f.mine, 'main.tex'), 'utf8'), 'Unsaved in Git.\n');
      assert.equal(f.git(f.mine, 'rev-parse', 'HEAD'), before);
      assert.equal(f.git(f.mine, 'stash', 'list'), '');
    } finally { f.close(); }
  }
});

test('sync publishes a new branch, rejects detached HEAD and leaves commits after a rejected push', async () => {
  const f = fixture();
  try {
    f.git(f.mine, 'checkout', '-qb', 'revision');
    f.edit(f.mine, 'new.tex', 'Revision.\n');
    assert.equal((await gitSync(f.mine)).upstream, 'origin/revision');
    f.git(f.mine, 'checkout', '-q', '--detach');
    await assert.rejects(gitSync(f.mine), /Check out a branch/);
    f.git(f.mine, 'checkout', '-q', 'revision');
    f.edit(f.mine, 'new.tex', 'Local commit stays.\n');
    const before = f.git(f.mine, 'rev-parse', 'HEAD');
    const hook = path.join(f.remote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await assert.rejects(gitSync(f.mine), /rejected|failed to push/i);
    assert.equal(f.git(f.mine, 'rev-parse', 'HEAD'), before);
    assert.equal((await gitStatus(f.mine)).ahead, 1);
    f.git(f.mine, 'remote', 'remove', 'origin');
    await assert.rejects(gitSync(f.mine), /no remote/);
  } finally { f.close(); }
});

test('amend replaces the last commit using only the chosen files and keeps other staged changes', async () => {
  const f = fixture();
  try {
    f.edit(f.mine, 'main.tex', 'First revision.\n');
    const count = f.git(f.mine, 'rev-list', '--count', 'HEAD');
    f.write(f.mine, 'main.tex', 'Improved revision.\n');
    f.write(f.mine, 'notes.md', 'Keep staged.\n'); f.git(f.mine, 'add', 'notes.md');
    await gitCommit(f.mine, 'Refine the revision', ['main.tex'], true);
    assert.equal(f.git(f.mine, 'rev-list', '--count', 'HEAD'), count);
    assert.equal(f.git(f.mine, 'show', 'HEAD:main.tex'), 'Improved revision.');
    assert.equal(f.git(f.mine, 'show', 'HEAD:notes.md'), 'Notes.');
    assert.equal((await gitStatus(f.mine)).files[0].staged, true);
    await gitCommit(f.mine, 'Include notes', null, true);
    assert.equal(f.git(f.mine, 'rev-list', '--count', 'HEAD'), count);
    assert.equal(f.git(f.mine, 'show', 'HEAD:notes.md'), 'Keep staged.');
  } finally { f.close(); }
});
