import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitHistory, gitVersion, gitVersionDiff, gitRestoreVersion } from '../src/server/git-history.ts';

function fixture(t: test.TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-versions-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git('init', '-q', '-b', 'main');
  for (const [key, value] of [['user.name', 'Writer'], ['user.email', 'writer@localhost'], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(root, '.git/no-hooks')]]) git('config', key, value);
  const write = (name: string, text: string | Buffer) => fs.writeFileSync(path.join(root, name), text);
  const commit = (message: string) => { git('add', '-A'); git('commit', '--allow-empty', '-qm', message); return git('rev-parse', 'HEAD'); };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, git, write, commit };
}

test('version history paginates without losing messages and follows the manuscript through merges', async t => {
  const { root, git, write, commit } = fixture(t);
  assert.deepEqual(await gitHistory(root), { versions: [], next: null });
  write('main.tex', 'Initial\n'); const first = commit('First draft\n\nA full explanation.\nSecond paragraph.');
  for (let i = 0; i < 30; i++) commit(`Revision ${i}`);
  const one = await gitHistory(root), two = await gitHistory(root, one.next!);
  assert.equal(one.versions.length, 30); assert.equal(two.versions.length, 1); assert.equal(two.next, null);
  assert.equal(two.versions[0].message, 'First draft\n\nA full explanation.\nSecond paragraph.');
  assert.equal(two.versions[0].author, 'Writer'); assert.ok(two.versions[0].date > 0);
  git('config', 'color.ui', 'always');
  const firstDiff = (await gitVersionDiff(root, first, 'main.tex')).diff;
  assert.match(firstDiff, /\+Initial/);
  assert.ok(!firstDiff.includes('\x1b['), 'Host Git colors must not corrupt the source diff');
  git('config', 'color.ui', 'auto');
  git('checkout', '-qb', 'task'); write('results.tex', 'Result\n'); const task = commit('Task intermediate step');
  git('checkout', '-q', 'main'); commit('Other manuscript change'); git('merge', '--no-ff', '-qm', 'Apply results', 'task');
  const merge = git('rev-parse', 'HEAD'), history = await gitHistory(root);
  assert.equal(history.versions[0].hash, merge); assert.ok(!history.versions.some(version => version.hash === task));
  assert.deepEqual((await gitVersion(root, merge)).files, [{ path: 'results.tex', status: 'A' }]);
  assert.match((await gitVersionDiff(root, merge, 'results.tex')).diff, /\+Result/);
  await assert.rejects(gitVersion(root, '--all'), /Choose a version/);
  await assert.rejects(gitVersionDiff(root, merge, '../main.tex'), /did not change/);
});

test('restoring a snapshot creates a new version and preserves later history, renames, binary files and symlinks', async t => {
  const { root, git, write, commit } = fixture(t);
  write('main.tex', 'Original\n'); write('image.bin', Buffer.from([0, 1, 2, 255]));
  fs.symlinkSync('main.tex', path.join(root, 'link.tex'));
  const original = commit('Before results');
  git('mv', 'main.tex', 'results\tfinal.tex'); write('results\tfinal.tex', 'Original\nMore results\n'); write('new.tex', 'New');
  fs.unlinkSync(path.join(root, 'image.bin')); const latest = commit('Add results');
  assert.ok((await gitVersion(root, latest)).files.some(file => file.path === 'results\tfinal.tex'));
  const restored = await gitRestoreVersion(root, original, latest);
  assert.equal(git('rev-parse', 'HEAD^'), latest);
  assert.equal(git('rev-parse', 'HEAD^{tree}'), git('rev-parse', `${original}^{tree}`));
  assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), 'Original\n');
  assert.equal(fs.existsSync(path.join(root, 'new.tex')), false);
  assert.equal(fs.readlinkSync(path.join(root, 'link.tex')), 'main.tex');
  assert.deepEqual(fs.readFileSync(path.join(root, 'image.bin')), Buffer.from([0, 1, 2, 255]));
  assert.deepEqual(restored.git.files, []);
  assert.match((await gitHistory(root)).versions[0].message, /^Restore version: Before results/);
  await gitRestoreVersion(root, latest, restored.commit);
  assert.equal(git('rev-parse', 'HEAD^{tree}'), git('rev-parse', `${latest}^{tree}`), 'A restoration can itself be undone through history');
});

test('restoring refuses stale versions, dirty index/worktree, untracked files and in-progress operations without touching them', async t => {
  const { root, git, write, commit } = fixture(t);
  write('main.tex', 'First'); const first = commit('First'); write('main.tex', 'Second'); const head = commit('Second');
  await assert.rejects(gitRestoreVersion(root, first, first), /current version changed/);
  for (const mode of ['unstaged', 'staged', 'untracked']) {
    write(mode === 'untracked' ? 'notes.tex' : 'main.tex', mode);
    if (mode === 'staged') git('add', 'main.tex');
    const before = git('status', '--porcelain=v2');
    await assert.rejects(gitRestoreVersion(root, first, head), /Save current changes/);
    assert.equal(git('status', '--porcelain=v2'), before); assert.equal(git('rev-parse', 'HEAD'), head);
    if (mode === 'untracked') fs.unlinkSync(path.join(root, 'notes.tex')); else git('restore', '--staged', '--worktree', 'main.tex');
  }
  fs.mkdirSync(path.join(root, '.git/rebase-merge'));
  await assert.rejects(gitRestoreVersion(root, first, head), /Finish the current Git operation/);
  fs.rmdirSync(path.join(root, '.git/rebase-merge'));
  git('checkout', '--detach', '-q'); await assert.rejects(gitRestoreVersion(root, first, head), /Check out a branch/);
  git('checkout', '-q', 'main'); await assert.rejects(gitRestoreVersion(root, head, head), /already matches/);
});

test('ignored files that collide with an old version are protected', async t => {
  const { root, git, write, commit } = fixture(t);
  write('main.tex', 'First'); write('output.pdf', 'Original PDF'); const first = commit('Tracked output');
  git('rm', '-q', 'output.pdf'); write('.gitignore', '*.pdf\n'); write('main.tex', 'Second'); const head = commit('Ignore output');
  write('output.pdf', 'New local PDF');
  await assert.rejects(gitRestoreVersion(root, first, head), /ignored files/);
  assert.equal(git('rev-parse', 'HEAD'), head); assert.equal(git('status', '--porcelain'), '');
  assert.equal(fs.readFileSync(path.join(root, 'output.pdf'), 'utf8'), 'New local PDF');
  assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), 'Second');
});

test('restoring a linked worktree changes only its branch and checkout', async t => {
  const { root, git, write, commit } = fixture(t);
  write('main.tex', 'First'); const first = commit('First'); write('main.tex', 'Second'); const head = commit('Second');
  const linked = path.join(root, '.git/linked-preview'); git('worktree', 'add', '-qb', 'preview', linked);
  await gitRestoreVersion(linked, first, head);
  assert.equal(git('rev-parse', 'HEAD'), head); assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), 'Second');
  assert.equal(fs.readFileSync(path.join(linked, 'main.tex'), 'utf8'), 'First');
});
