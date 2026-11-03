import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { taskCaptionFrom } from '../src/task-caption.ts';
import { Store } from '../src/server/store.ts';
import { Workspace } from '../src/server/workspace.ts';
import type { AgentRuntime } from '../src/server/agents.ts';
import type { ReviewClient } from '../src/server/review.ts';
import type { Task } from '../src/shared.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
class CaptionAgent extends EventEmitter {
  ready = true;
  calls: { method: string; params: any }[] = [];
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: `${params.ephemeral ? 'caption' : 'editing'}-${this.calls.length}` } };
    return { turn: { id: `turn-${this.calls.length}` } };
  }
  respond() {} reject() {} close() { this.ready = false; }
  reply(text: string, status = 'completed') {
    const thread = this.calls.findLast(call => call.method === 'turn/start' && call.params.threadId.startsWith('caption-'))!.params.threadId;
    this.emit('notification', { method: 'item/completed', params: { threadId: thread, item: { type: 'agentMessage', text } } });
    this.emit('notification', { method: 'turn/completed', params: { threadId: thread, turn: { id: 'title-turn', status } } });
  }
}
function fixture() {
  const store = new Store(':memory:'), agent = new CaptionAgent();
  const review: ReviewClient = { url: 'http://unused', token: 'test', get: async () => ({ scope: { files: [] } }) as any, post: async () => ({ worktree: '/tmp' }) as any };
  const workspace = new Workspace(store, agent as unknown as AgentRuntime, async () => review);
  workspace.runtime.authenticated = true;
  workspace.runtime.models = [
    { id: 'large', name: 'Large', isDefault: true, efforts: ['low', 'high'], defaultEffort: 'high' },
    { id: 'small-mini', name: 'Small mini', isDefault: false, efforts: ['low'], defaultEffort: 'low' },
  ];
  store.saveProject({ id: 'paper', name: 'Paper', path: '/tmp', createdAt: 1 });
  const task: Task = { id: 'caption-task-0001', projectId: 'paper', name: 'p-caption', title: '改一下', titleSource: 'prompt', instructions: '请解释引言中的主要贡献。', worktree: '/tmp', threadId: null, turnId: null, model: null, status: 'reviewing', createdAt: 1, updatedAt: 1, feedbackCursor: 0, error: null, review: null };
  store.saveTask(task);
  return { store, agent, workspace, task, close() { workspace.close(); store.close(); } };
}

test('captions keep meaningful text, remove response formatting and reject unusable replies', () => {
  assert.equal(taskCaptionFrom('```text\n“明确引言中的研究贡献”\n```'), '明确引言中的研究贡献');
  assert.equal(taskCaptionFrom('Title: Clarify the contribution.'), 'Clarify the contribution');
  assert.throws(() => taskCaptionFrom('Here is a title:\nClarify the contribution'));
  assert.throws(() => taskCaptionFrom('""'));
  const long = taskCaptionFrom('🧪'.repeat(90));
  assert.equal([...long].length, 80);
  assert.ok(long.endsWith('…'));
  assert.ok(!long.includes('\uFFFD'));
});

test('new tasks generate a caption from the request and PDF context without waiting or polluting the editing conversation', async () => {
  const f = fixture();
  try {
    f.store.saveAnnotation({ id: 'note', projectId: 'paper', key: 'pdf', page: 0, rect: [0, 0, 1, 1], comment: '明确这里的研究贡献', quote: 'Our contribution', source: null, createdAt: 1 });
    const input = { id: 'new-caption-task-01', projectId: 'paper', title: '改一下', instructions: '按批注修改', annotations: ['note'] };
    const created = await f.workspace.createTask(input);
    assert.equal(created.title, '改一下');
    assert.equal(created.titleGeneration, 'pending');
    await tick();
    assert.ok(f.agent.calls.some(call => call.method === 'turn/start' && call.params.threadId.startsWith('editing-')), 'Editing proceeds while the caption is pending');
    const start = f.agent.calls.find(call => call.method === 'thread/start' && call.params.ephemeral)!.params;
    assert.deepEqual([start.sandbox, start.approvalPolicy, start.ephemeral, start.model], ['read-only', 'never', true, 'small-mini']);
    const turn = f.agent.calls.find(call => call.method === 'turn/start' && call.params.threadId.startsWith('caption-'))!.params;
    assert.equal(turn.effort, 'low');
    assert.match(turn.input[0].text, /按批注修改/);
    assert.match(turn.input[0].text, /明确这里的研究贡献/);
    assert.match(start.developerInstructions, /language of the user's request/);
    const pending = f.workspace.generateTaskTitle(created.id);
    await f.workspace.createTask(input);
    assert.equal(f.agent.calls.filter(call => call.method === 'thread/start' && call.params.ephemeral).length, 1, 'Creation retries do not generate more titles');
    f.agent.reply('明确论文的研究贡献'); await pending;
    const updated = f.store.task(created.id);
    assert.equal(updated.title, '明确论文的研究贡献'); assert.equal(updated.titleSource, 'generated'); assert.equal(updated.titleGeneration, null);
    assert.equal(updated.status, 'running');
    assert.deepEqual(f.store.items(created.id).map(item => item.type), ['user']);
  } finally { f.close(); }
});

test('manual renames win over pending caption results, including changing back to the original title', async () => {
  const f = fixture();
  try {
    const pending = f.workspace.generateTaskTitle(f.task.id);
    assert.equal(f.workspace.generateTaskTitle(f.task.id), pending);
    await tick();
    f.workspace.renameTask(f.task.id, 'My title');
    f.workspace.renameTask(f.task.id, f.task.title);
    f.agent.reply('A late generated title'); await pending;
    assert.equal(f.store.task(f.task.id).title, f.task.title);
    assert.equal(f.store.task(f.task.id).titleSource, 'manual');
    assert.equal(f.store.task(f.task.id).titleGeneration, null);
    const requested = f.workspace.generateTaskTitle(f.task.id); await tick();
    f.agent.reply('Explicitly requested caption'); await requested;
    assert.equal(f.store.task(f.task.id).title, 'Explicitly requested caption', 'An explicit request can replace a manual title');
  } finally { f.close(); }
});

test('failed captioning preserves the title and task state and can be retried', async () => {
  const f = fixture();
  try {
    const pending = f.workspace.generateTaskTitle(f.task.id); await tick();
    const rejected = assert.rejects(pending, /empty title/);
    f.agent.reply(''); await rejected;
    assert.equal(f.store.task(f.task.id).title, f.task.title);
    assert.equal(f.store.task(f.task.id).titleGeneration, 'failed');
    assert.equal(f.store.task(f.task.id).status, 'reviewing'); assert.equal(f.store.task(f.task.id).error, null);
    f.store.saveItem({ id: 'result', taskId: f.task.id, type: 'assistant', text: 'Explained the main theorem.', createdAt: 2 });
    const retry = f.workspace.generateTaskTitle(f.task.id); await tick();
    assert.match(f.agent.calls.findLast(call => call.method === 'turn/start')!.params.input[0].text, /Explained the main theorem/);
    f.agent.reply('明确主要定理'); await retry;
    assert.equal(f.store.task(f.task.id).title, '明确主要定理');
  } finally { f.close(); }
});

test('captioning never recreates a deleted task or keeps helper listeners after shutdown', async () => {
  const f = fixture();
  try {
    const initial = f.agent.listenerCount('notification');
    const pending = f.workspace.generateTaskTitle(f.task.id); await tick();
    f.store.deleteTask(f.task.id); f.agent.reply('Too late');
    assert.equal(await pending, null);
    assert.equal(f.agent.listenerCount('notification'), initial);
    f.store.saveTask({ ...f.task, id: 'another-task' });
    const closing = f.workspace.generateTaskTitle('another-task'); await tick();
    const stopped = assert.rejects(closing, /shutting down/);
    f.workspace.close(); await stopped;
    assert.equal(f.agent.listenerCount('notification'), initial);
    f.store.recover();
    assert.equal(f.store.task('another-task').titleGeneration, 'failed');
    assert.equal(f.store.task('another-task').title, f.task.title);
  } finally { f.close(); }
});

test('a caption timeout is recoverable and an offline helper never prevents task creation', async t => {
  const f = fixture();
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = f.workspace.generateTaskTitle(f.task.id); await tick();
    const timedOut = assert.rejects(pending, /in time/);
    t.mock.timers.tick(45000); await timedOut;
    assert.equal(f.store.task(f.task.id).titleGeneration, 'failed');
    assert.ok(f.agent.calls.some(call => call.method === 'turn/interrupt'));
    f.agent.ready = false;
    const created = await f.workspace.createTask({ id: 'offline-caption-01', projectId: 'paper', title: 'Fallback', instructions: 'Explain the result.' });
    assert.equal(created.title, 'Fallback'); assert.equal(created.status, 'queued');
    assert.notEqual(created.titleGeneration, 'pending');
  } finally { f.close(); }
});
