import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitOverview, parseWorktrees } from '../src/server/git-overview.ts';
import { graphRows } from '../src/web/git-graph.ts';
import type { GitGraphCommit } from '../src/shared.ts';

test('worktree porcelain preserves unusual paths, empty locks and detached/unborn HEADs', () => {
  const output = ['worktree /paper with\nnewline', 'HEAD abc', 'branch refs/heads/main', '', 'worktree /other', 'HEAD def', 'detached', 'locked', '', 'worktree /gone', 'HEAD 000000', 'branch refs/heads/new', 'prunable gitdir missing', '', ''].join('\0');
  const trees = parseWorktrees(output, '/paper with\nnewline');
  assert.deepEqual(trees.map(tree => [tree.path, tree.branch, tree.head, tree.current, tree.locked, tree.prunable]), [
    ['/paper with\nnewline', 'main', 'abc', true, undefined, undefined],
    ['/other', null, 'def', false, '', undefined],
    ['/gone', 'new', null, false, undefined, 'gitdir missing'],
  ]);
});

test('repository overview reads each worktree, detached tips, refs and merge parents without changing the index', async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-overview-'))), root = path.join(base, 'paper');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const commit = (cwd: string, name: string, text: string) => { fs.writeFileSync(path.join(cwd, name), text); git(cwd, 'add', name); git(cwd, 'commit', '-qm', text); return git(cwd, 'rev-parse', 'HEAD'); };
  try {
    git(base, 'init', '-q', '-b', 'main', root);
    for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@localhost'], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(base, 'no-hooks')]]) git(root, 'config', key, value);
    assert.deepEqual((await gitOverview(root)).commits, [], 'Unborn repositories have no fake history');
    const first = commit(root, 'main.tex', 'Initial');
    const other = path.join(base, 'other tree'), detached = path.join(base, 'detached'), gone = path.join(base, 'gone');
    git(root, 'worktree', 'add', '-q', '-b', 'revision', other);
    const branchTip = commit(other, 'revision.tex', 'Revise the paper');
    git(root, 'tag', '-a', 'reviewed', '-m', 'Reviewed', branchTip);
    git(root, 'worktree', 'lock', '--reason', 'Keep this proposal', other);
    const mainTip = commit(root, 'notes.md', 'Main changes');
    git(root, 'update-ref', 'refs/remotes/origin/main', mainTip);
    git(root, 'config', 'remote.origin.url', '/unused');
    git(root, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    git(root, 'branch', '--set-upstream-to=origin/main', 'main');
    git(root, 'merge', '--no-ff', '-m', 'Merge revision', 'revision');
    const mergeTip = git(root, 'rev-parse', 'HEAD');
    git(root, 'worktree', 'add', '-q', '--detach', detached, first);
    const detachedTip = commit(detached, 'experiment.tex', 'Detached experiment');
    git(root, 'worktree', 'add', '-q', '--detach', gone, first);
    fs.rmSync(gone, { recursive: true });
    fs.writeFileSync(path.join(other, 'revision.tex'), 'Staged edit'); git(other, 'add', 'revision.tex');
    fs.writeFileSync(path.join(other, 'revision.tex'), 'More unstaged edits');
    fs.writeFileSync(path.join(other, 'new.tex'), 'Untracked');
    const before = fs.readFileSync(path.join(git(other, 'rev-parse', '--absolute-git-dir'), 'index'));
    const alias = path.join(base, 'proposal-alias');
    fs.symlinkSync(other, alias, 'dir');
    const result = await gitOverview(root, [
      { id: 'proposal-task', worktree: alias },
      { id: 'detached-task', worktree: detached },
      { id: 'missing-task', worktree: gone },
      { id: 'unrelated-task', worktree: path.join(base, 'not-a-worktree') },
    ]);
    assert.equal(result.worktrees.length, 4);
    assert.equal(result.worktrees[0].current, true);
    assert.equal(result.worktrees[0].status?.ahead, 2);
    const proposal = result.worktrees.find(tree => tree.branch === 'revision')!;
    assert.equal(proposal.taskId, 'proposal-task', 'Task paths resolve through symlink aliases');
    assert.equal(result.worktrees.find(tree => tree.path === detached)?.taskId, 'detached-task');
    assert.equal(result.worktrees.find(tree => tree.path === gone)?.taskId, 'missing-task', 'Missing worktrees retain their task association');
    assert.equal(result.worktrees[0].taskId, undefined, 'The manuscript is not assigned another checkout’s task');
    assert.equal(proposal.locked, 'Keep this proposal');
    assert.deepEqual(proposal.status?.files.map(file => [file.path, file.staged, file.unstaged]), [['revision.tex', true, true], ['new.tex', false, true]]);
    assert.equal(result.worktrees.find(tree => tree.path === gone)?.status, null);
    assert.ok(result.worktrees.find(tree => tree.path === gone)?.error);
    assert.ok(result.worktrees.find(tree => tree.path === gone)?.prunable);
    assert.deepEqual(result.commits.find(commit => commit.hash === mergeTip)?.parents, [mainTip, branchTip]);
    assert.ok(result.commits.some(commit => commit.hash === detachedTip));
    const tip = result.commits.find(commit => commit.hash === branchTip);
    assert.deepEqual([tip?.refs, tip?.tags], [['revision'], ['reviewed']], 'Annotated tags point at the commit, apart from branches');
    assert.ok(result.commits.find(commit => commit.hash === mainTip)?.remotes?.includes('origin/main'));
    assert.ok(!result.commits.some(commit => commit.refs.includes('origin/main') || commit.remotes?.some(ref => ref.endsWith('/HEAD') || ref === 'origin')));
    assert.deepEqual(fs.readFileSync(path.join(git(other, 'rev-parse', '--absolute-git-dir'), 'index')), before);
    const linked = await gitOverview(other);
    assert.equal(linked.worktrees[0].path, other);
    assert.equal(linked.worktrees[0].current, true);
    assert.equal(linked.worktrees.filter(tree => tree.current).length, 1);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('commit graph follows forks, merges, shared tips and disconnected roots', () => {
  const commit = (hash: string, parents: string[]): GitGraphCommit => ({ hash, parents, subject: hash, author: 'Test', date: 1, refs: [] });
  const commits = [commit('merge', ['main', 'side']), commit('main', ['base']), commit('side', ['base']), commit('base', []), commit('unrelated', [])];
  const { rows, lanes } = graphRows(commits);
  assert.equal(lanes, 2);
  assert.equal(rows[0].edges.filter(edge => edge.parent).length, 2);
  for (const [index, row] of rows.entries()) {
    assert.ok(row.edges.every((edge): boolean => edge.to >= 0 && edge.to < lanes));
    for (const [parentIndex, parent] of row.commit.parents.entries()) {
      let lane: number = row.edges.filter(edge => edge.parent)[parentIndex].to;
      for (let next = index + 1; next < rows.length; next++) {
        const following = rows[next];
        if (following.commit.hash === parent) { assert.equal(lane, following.lane); break; }
        const continuation = following.edges.find(edge => !edge.parent && edge.from === lane);
        assert.ok(continuation, `The edge to ${parent} must continue through ${following.commit.hash}`);
        lane = continuation.to;
      }
    }
  }
  assert.equal(rows[4].incoming, false, 'Unrelated history starts a new root');
});
