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

test('restore checks ignored directory entries, including filesystem aliases and ancestors', async t => {
  const cases = [
    { name: 'case-only file alias', target: 'output.pdf', local: 'OUTPUT.PDF', probe: 'output.pdf', localProbe: 'OUTPUT.PDF' },
    { name: 'Unicode normalization alias', target: 'résumé.pdf', local: 're\u0301sume\u0301.pdf', probe: 'résumé.pdf', localProbe: 're\u0301sume\u0301.pdf' },
    { name: 'ignored file blocks a target directory alias', target: 'cache/report.tex', local: 'CACHE', probe: 'cache', localProbe: 'CACHE' },
    { name: 'ignored directory blocks a target file alias', target: 'cache', local: 'CACHE/output.pdf', probe: 'cache', localProbe: 'CACHE' },
    { name: 'unrelated ignored file in a shared directory', target: 'cache/report.tex', local: 'cache/preview.pdf', probe: 'cache/report.tex', localProbe: 'cache/preview.pdf' },
  ];
  for (const item of cases) await t.test(item.name, async t => {
    const { root, git, write, commit } = fixture(t);
    write('.gitignore', '*\n'); write('main.tex', 'First');
    fs.mkdirSync(path.dirname(path.join(root, item.target)), { recursive: true });
    write(item.target, 'Old version');
    git('add', '-f', '--', '.gitignore', 'main.tex', item.target);
    const first = commit('Old version');
    git('rm', '--', item.target); write('main.tex', 'Second'); const head = commit('Current version');
    fs.mkdirSync(path.dirname(path.join(root, item.local)), { recursive: true });
    write(item.local, 'Unsaved local content');
    // The safety check must reflect the real filesystem, even if Git's
    // case/Unicode preferences disagree. Both spellings are distinct on Linux.
    git('config', 'core.ignorecase', 'false'); git('config', 'core.precomposeUnicode', 'false');
    const aliases = fs.existsSync(path.join(root, item.probe))
      && fs.lstatSync(path.join(root, item.probe)).ino === fs.lstatSync(path.join(root, item.localProbe)).ino;
    assert.equal(git('status', '--porcelain'), '');
    const index = path.resolve(root, git('rev-parse', '--git-path', 'index')), before = fs.readFileSync(index);
    if (aliases) {
      await assert.rejects(gitRestoreVersion(root, first, head), /ignored files/);
      assert.equal(git('rev-parse', 'HEAD'), head);
      assert.deepEqual(fs.readFileSync(index), before, 'Refusing restore must preserve the index');
      assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), 'Second');
    } else {
      const restored = await gitRestoreVersion(root, first, head);
      assert.deepEqual(restored.git.files, []);
      assert.equal(fs.readFileSync(path.join(root, item.target), 'utf8'), 'Old version');
    }
    assert.equal(fs.readFileSync(path.join(root, item.local), 'utf8'), 'Unsaved local content');
  });
});

test('restoring a linked worktree changes only its branch and checkout', async t => {
  const { root, git, write, commit } = fixture(t);
  write('main.tex', 'First'); const first = commit('First'); write('main.tex', 'Second'); const head = commit('Second');
  const linked = path.join(root, '.git/linked-preview'); git('worktree', 'add', '-qb', 'preview', linked);
  await gitRestoreVersion(linked, first, head);
  assert.equal(git('rev-parse', 'HEAD'), head); assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), 'Second');
  assert.equal(fs.readFileSync(path.join(linked, 'main.tex'), 'utf8'), 'First');
});

test('restore preserves ignored hardlink backups while replacing the tracked entry', async t => {
  const { root, git, write, commit } = fixture(t);
  write('.gitignore', 'backup.tex\n'); write('main.tex', 'Old version\n');
  const first = commit('Old version'); write('main.tex', 'New version\n'); const head = commit('Current version');
  fs.linkSync(path.join(root, 'main.tex'), path.join(root, 'backup.tex'));
  const backup = fs.lstatSync(path.join(root, 'backup.tex'), { bigint: true });
  assert.equal(git('status', '--porcelain'), '');
  const restored = await gitRestoreVersion(root, first, head);
  assert.equal(git('rev-parse', 'HEAD^'), head);
  assert.deepEqual(restored.git.files, []);
  assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), 'Old version\n');
  assert.equal(fs.readFileSync(path.join(root, 'backup.tex'), 'utf8'), 'New version\n');
  assert.equal(fs.lstatSync(path.join(root, 'backup.tex'), { bigint: true }).ino, backup.ino);
});

test('restore replaces a tracked symlink ancestor without traversing into ignored files', async t => {
  const { root, git, write, commit } = fixture(t);
  write('.gitignore', 'cache/\n'); fs.mkdirSync(path.join(root, 'view')); write('view/paper.tex', 'Old version\n');
  const first = commit('Old version');
  git('rm', '-r', 'view'); fs.mkdirSync(path.join(root, 'cache')); write('cache/paper.tex', 'Private ignored content\n');
  fs.symlinkSync('cache', path.join(root, 'view'));
  const head = commit('Current version'), ignored = fs.lstatSync(path.join(root, 'cache/paper.tex'), { bigint: true });
  assert.equal(git('status', '--porcelain'), '');
  const restored = await gitRestoreVersion(root, first, head);
  assert.equal(git('rev-parse', 'HEAD^'), head);
  assert.deepEqual(restored.git.files, []);
  assert.ok(fs.lstatSync(path.join(root, 'view')).isDirectory());
  assert.equal(fs.readFileSync(path.join(root, 'view/paper.tex'), 'utf8'), 'Old version\n');
  assert.equal(fs.readFileSync(path.join(root, 'cache/paper.tex'), 'utf8'), 'Private ignored content\n');
  assert.equal(fs.lstatSync(path.join(root, 'cache/paper.tex'), { bigint: true }).ino, ignored.ino);
});

test('restore still protects ignored symlinks themselves, including dangling aliases', async t => {
  const cases = [
    { target: 'output.pdf', local: 'output.pdf', probe: 'output.pdf' },
    { target: 'output.pdf', local: 'OUTPUT.PDF', probe: 'output.pdf' },
    { target: 'résumé.pdf', local: 're\u0301sume\u0301.pdf', probe: 'résumé.pdf' },
    { target: 'cache/report.tex', local: 'CACHE', probe: 'cache' },
  ];
  for (const item of cases) await t.test(`${item.target} / ${item.local}`, async t => {
    const { root, git, write, commit } = fixture(t);
    write('.gitignore', '*\n'); write('main.tex', 'First');
    fs.mkdirSync(path.dirname(path.join(root, item.target)), { recursive: true }); write(item.target, 'Old version');
    git('add', '-f', '--', '.gitignore', 'main.tex', item.target); const first = commit('Old version');
    git('rm', '--', item.target); write('main.tex', 'Second'); const head = commit('Current version');
    fs.symlinkSync('missing-local-backup', path.join(root, item.local));
    git('config', 'core.ignorecase', 'false'); git('config', 'core.precomposeUnicode', 'false');
    assert.equal(git('status', '--porcelain'), '');
    const local = fs.lstatSync(path.join(root, item.local), { bigint: true });
    const probe = fs.lstatSync(path.join(root, item.probe), { bigint: true, throwIfNoEntry: false });
    const index = path.resolve(root, git('rev-parse', '--git-path', 'index')), before = fs.readFileSync(index);
    if (probe?.ino === local.ino) {
      await assert.rejects(gitRestoreVersion(root, first, head), /ignored files/);
      assert.equal(git('rev-parse', 'HEAD'), head);
      assert.deepEqual(fs.readFileSync(index), before);
      assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), 'Second');
    } else {
      const restored = await gitRestoreVersion(root, first, head);
      assert.deepEqual(restored.git.files, []);
      assert.equal(fs.readFileSync(path.join(root, item.target), 'utf8'), 'Old version');
    }
    assert.equal(fs.readlinkSync(path.join(root, item.local)), 'missing-local-backup');
    assert.equal(fs.lstatSync(path.join(root, item.local), { bigint: true }).ino, local.ino);
  });
});

for (const fails of ['preparation', 'real checkout']) test(`restore preserves files, index and HEAD when a filter fails during ${fails}`, async t => {
  const { root, git, write, commit } = fixture(t);
  write('.gitignore', 'backup.tex\n'); write('.gitattributes', 'z.tex filter=restore-test\n');
  write('a.tex', 'Old a\n'); write('z.tex', 'Old z\n'); const first = commit('Old version');
  write('a.tex', 'Current a\n'); write('z.tex', 'Current z\n'); const head = commit('Current version');
  fs.linkSync(path.join(root, 'z.tex'), path.join(root, 'backup.tex'));
  const backupInode = fs.lstatSync(path.join(root, 'backup.tex')).ino;
  git('config', 'filter.restore-test.clean', 'cat'); git('config', 'filter.restore-test.required', 'true');
  if (fails === 'preparation') git('config', 'filter.restore-test.smudge', 'false');
  else {
    const script = path.join(root, '.git/smudge.cjs'), counter = path.join(root, '.git/smudge-count');
    fs.writeFileSync(script, `const fs = require('node:fs'); const counter = ${JSON.stringify(counter)};\nif (fs.existsSync(counter)) process.exit(1);\nfs.writeFileSync(counter, '1'); process.stdin.pipe(process.stdout);\n`);
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    git('config', 'filter.restore-test.smudge', `${quote(process.execPath)} ${quote(script)}`);
  }
  assert.equal(git('status', '--porcelain'), '');
  const before = fs.readFileSync(path.join(root, '.git/index'));
  await assert.rejects(gitRestoreVersion(root, first, head), /filter/);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.deepEqual(fs.readFileSync(path.join(root, '.git/index')), before);
  assert.equal(fs.readFileSync(path.join(root, 'a.tex'), 'utf8'), 'Current a\n');
  assert.equal(fs.readFileSync(path.join(root, 'z.tex'), 'utf8'), 'Current z\n');
  assert.equal(fs.readFileSync(path.join(root, 'backup.tex'), 'utf8'), 'Current z\n');
  assert.equal(fs.lstatSync(path.join(root, 'backup.tex')).ino, backupInode);
  assert.equal(git('status', '--porcelain'), '');
  assert.ok(!fs.readdirSync(path.join(root, '.git')).some(name => name.startsWith('papilot-restore-')));
  assert.ok(!fs.existsSync(path.join(root, '.git/index.lock')));
});

for (const concurrentEdit of [false, true]) test(`restore handles a rejected ref update${concurrentEdit ? ' without overwriting a concurrent edit' : ' by restoring file types and contents'}`, async t => {
  const { root, git, write, commit } = fixture(t);
  write('.gitignore', 'cache/\n'); write('main.tex', 'Old paper\n');
  fs.mkdirSync(path.join(root, 'view')); write('view/notes.tex', 'Old notes\n'); const first = commit('Old version');
  fs.rmSync(path.join(root, 'view'), { recursive: true }); fs.symlinkSync('cache', path.join(root, 'view'));
  write('main.tex', 'Current paper\n'); write('new.tex', 'Current addition\n'); const head = commit('Current version');
  fs.mkdirSync(path.join(root, 'cache')); write('cache/notes.tex', 'Private ignored notes\n');
  const hooks = path.join(root, '.git/failing-hooks'), script = path.join(hooks, 'reject.cjs');
  fs.mkdirSync(hooks);
  fs.writeFileSync(script, `if (process.argv[2] === 'prepared') {\n  ${concurrentEdit ? `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, 'main.tex'))}, 'Concurrent edit\\n');` : ''}\n  process.stderr.write('fixture: rejected reference transaction\\n');\n  process.exit(1);\n}\n`);
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  fs.writeFileSync(path.join(hooks, 'reference-transaction'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  git('config', 'core.hooksPath', hooks);
  const index = path.join(root, '.git/index'), before = fs.readFileSync(index);
  // Git versions phrase hook rejection differently; assert our fixture's
  // diagnostic, then verify the actual rollback below.
  await assert.rejects(gitRestoreVersion(root, first, head), concurrentEdit ? /Restore failed\. Previous files are saved at/ : /fixture: rejected reference transaction/);
  assert.equal(git('rev-parse', 'HEAD'), head); assert.deepEqual(fs.readFileSync(index), before);
  assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), concurrentEdit ? 'Concurrent edit\n' : 'Current paper\n');
  assert.equal(fs.readFileSync(path.join(root, 'new.tex'), 'utf8'), 'Current addition\n');
  assert.equal(fs.readlinkSync(path.join(root, 'view')), 'cache');
  assert.equal(fs.readFileSync(path.join(root, 'cache/notes.tex'), 'utf8'), 'Private ignored notes\n');
  const recoveries = fs.readdirSync(path.join(root, '.git')).filter(name => name.startsWith('papilot-restore-'));
  assert.equal(recoveries.length, concurrentEdit ? 1 : 0);
  if (concurrentEdit) assert.equal(fs.readFileSync(path.join(root, '.git', recoveries[0], 'before/main.tex'), 'utf8'), 'Current paper\n');
  else assert.equal(git('status', '--porcelain'), '');
  assert.ok(!fs.existsSync(index + '.lock'));
});
