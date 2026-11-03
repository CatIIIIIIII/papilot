import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/server/store.ts';
import { Workspace } from '../src/server/workspace.ts';
import type { Codex } from '../src/server/codex.ts';
import type { Task } from '../src/shared.ts';

class Agent extends EventEmitter { ready = false; close() {} }
function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-projects-'))), store = new Store(path.join(dir, 'state.sqlite'));
  const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  function repo(name: string) {
    const root = path.join(dir, name); fs.mkdirSync(root); git(root, 'init');
    fs.writeFileSync(path.join(root, 'paper.tex'), 'Keep the manuscript.'); git(root, 'add', 'paper.tex');
    git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'Paper'); return root;
  }
  const root = repo('paper'), other = repo('other'), worktree = path.join(dir, 'task');
  git(root, 'worktree', 'add', '-b', 'revision', worktree);
  fs.writeFileSync(path.join(worktree, 'draft.txt'), 'Keep uncommitted work.');
  let taskInfo: any = { task: 'p-task', worktree };
  const calls: string[] = [];
  const workspace = new Workspace(store, new Agent() as unknown as Codex, async () => ({ url: '', token: '', get: async (route: string) => { calls.push(route); return (route === '/api/tasks' ? { tasks: [] } : taskInfo); }, post: async () => { throw new Error('Removal must never call review cleanup.'); } }), { claude: new Agent() as unknown as Codex, antigravity: new Agent() as unknown as Codex });
  store.saveProject({ id: 'paper', name: 'Paper', path: root, createdAt: 1 });
  store.saveProject({ id: 'other', name: 'Other', path: other, createdAt: 2 });
  const task: Task = { id: 'task', projectId: 'paper', name: 'p-task', title: 'Revise', instructions: 'Edit', worktree, threadId: null, turnId: null, model: null, status: 'reviewing', createdAt: 1, updatedAt: 1, feedbackCursor: 0, error: null, review: null };
  return { dir, store, workspace, root, other, worktree, task, git, repo, calls, setInfo(value: unknown) { taskInfo = value; }, close() { workspace.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('removing a paper drops only its Papilot records and keeps repositories and worktrees intact', () => {
  const f = fixture();
  try {
    f.store.saveTask(f.task);
    f.store.saveTask({ ...f.task, id: 'other-task', projectId: 'other' });
    f.store.saveItem({ id: 'message', taskId: 'task', type: 'user', text: 'Saved conversation', createdAt: 1 });
    f.store.saveRun({ id: 'run', taskId: 'task', requestKey: 'request', prompt: 'Edit', status: 'completed', createdAt: 1, finishedAt: 2 });
    f.store.saveAnnotation({ id: 'note', projectId: 'paper', key: 'pdf', page: 0, rect: [0,0,1,1], quote: 'text', comment: 'note', source: null, createdAt: 1 });
    f.store.db.prepare('INSERT INTO members VALUES(?,?)').run('paper', 'reader');
    const before = f.git(f.root, 'worktree', 'list', '--porcelain'), head = f.git(f.root, 'rev-parse', 'HEAD');
    assert.deepEqual(f.workspace.removeProject('paper'), { ok: true });
    assert.deepEqual(f.workspace.removeProject('paper'), { ok: true });
    assert.deepEqual(f.store.projects().map(p => p.id), ['other']);
    assert.deepEqual(f.store.tasks().map(t => t.id), ['other-task']);
    assert.deepEqual(f.store.items('task'), []); assert.deepEqual(f.store.runs(), []); assert.deepEqual(f.store.annotations('paper'), []);
    assert.equal(f.store.taskDeleted('task'), true);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM members WHERE project_id=?').get('paper')!.n, 0);
    assert.equal(f.git(f.root, 'worktree', 'list', '--porcelain'), before); assert.equal(f.git(f.root, 'rev-parse', 'HEAD'), head);
    assert.equal(fs.readFileSync(path.join(f.root, 'paper.tex'), 'utf8'), 'Keep the manuscript.');
    assert.equal(fs.readFileSync(path.join(f.worktree, 'draft.txt'), 'utf8'), 'Keep uncommitted work.');
    assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});

test('path changes validate repository roots and duplicate papers before saving', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.workspace.changeProjectPath('paper', path.join(f.dir, 'missing'), undefined, 'Do not save'));
    assert.equal(f.store.project('paper').name, 'Paper');
    await assert.rejects(f.workspace.changeProjectPath('paper', f.other), /already added/);
    fs.mkdirSync(path.join(f.root, 'subfolder'));
    await assert.rejects(f.workspace.changeProjectPath('paper', path.join(f.root, 'subfolder')), /root directory/);
    assert.equal(f.store.project('paper').path, f.root);
    const next = f.repo('replacement');
    assert.equal((await f.workspace.changeProjectPath('paper', next, undefined, 'Updated paper')).path, next);
    assert.equal(f.store.project('paper').name, 'Updated paper');
    assert.ok(fs.existsSync(path.join(f.root, 'paper.tex')));
  } finally { f.close(); }
});

test('existing task worktrees must belong to the selected repository', async () => {
  const f = fixture();
  try {
    f.store.saveTask(f.task);
    const unrelated = f.repo('unrelated');
    await assert.rejects(f.workspace.changeProjectPath('paper', unrelated), /task worktrees/);
    assert.equal(f.store.project('paper').path, f.root);
    const checkout = path.join(f.dir, 'new-main'); f.git(f.root, 'worktree', 'add', '-b', 'new-main', checkout);
    assert.equal((await f.workspace.changeProjectPath('paper', checkout)).path, checkout);
    assert.equal(f.store.task('task').worktree, f.worktree);
    f.setInfo({ task: 'different-task', worktree: f.worktree });
    await assert.rejects(f.workspace.changeProjectPath('paper', f.root), /task worktrees/);
    assert.equal(f.store.project('paper').path, checkout);
  } finally { f.close(); }
});

test('paper changes wait for active tasks and requests, and release reservations after failure', async () => {
  const f = fixture();
  try {
    f.store.saveTask({ ...f.task, status: 'running' });
    assert.throws(() => f.workspace.removeProject('paper'), /Pause/);
    await assert.rejects(f.workspace.changeProjectPath('paper', f.other), /Pause/);
    f.store.updateTask('task', { status: 'reviewing' });
    const release = f.workspace.enterProjectRequest('paper');
    assert.throws(() => f.workspace.removeProject('paper'), /Pause/); release(); release();
    const pending = f.workspace.changeProjectPath('paper', f.other);
    assert.throws(() => f.workspace.enterProjectRequest('paper'), /being updated/);
    await assert.rejects(pending, /already added/);
    const after = f.workspace.enterProjectRequest('paper'); after();
    assert.deepEqual(f.workspace.removeProject('paper'), { ok: true });
  } finally { f.close(); }
});
