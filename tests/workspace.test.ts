import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/server/store.ts';
import { Workspace, accountUsage, acceptedFiles, agentModel, lightModel } from '../src/server/workspace.ts';
import { findSkill } from '../src/server/skills.ts';
import { reviewInstructions } from '../src/conversation.ts';
import { RpcResponseError, Codex } from '../src/server/codex.ts';
import type { ReviewClient } from '../src/server/review.ts';
import { AGENT_IDS, type PendingReview, type Run, type Task } from '../src/shared.ts';
import { visibleTimeline } from '../src/web/refresh.ts';
import { noteOptionsKey } from '../src/server/note-options.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
// The preparation a new task started, while it is still in progress.
const preparation = (f: { workspace: Workspace }, id: string) => {
  const job = (f.workspace as any).preparing.get(id) as Promise<Task> | undefined;
  assert.ok(job, 'The task is being prepared');
  return job;
};

test('publication stays building until all saved option comparisons are ready', async () => {
  const gate = deferred<unknown>(), started = deferred<void>();
  const detail = { round: 1, before: 'before', after: 'after', units: [{ id: 'word', file: 'main.tex', old_start: 1, old_end: 1, old_text: 'fast', new_text: 'efficient', text_ops: [['replace', 0, 4, 0, 9]] }], sections: [], loose: [{ kind: 'change', units: ['word'] }] };
  const f = fixture(async (_method, route) => {
    if (route.endsWith('/source/options/preview')) { started.resolve(); return gate.promise; }
    if (route.includes('/rounds/')) return detail;
    if (route.includes('/state?')) return { latest: 1, closed: false, decisions: { word: 'pending' } };
    if (route.endsWith('/publish')) return { job: 'job' };
    if (route.includes('/jobs/')) return { status: 'done', phase: 'render', outcome: 'published', round: 1 };
    if (route.includes('/feedback')) return feedback;
    return summary;
  });
  try {
    const run = { id: 'prepared-run', taskId: f.task.id, requestKey: 'prepared-run', prompt: '', status: 'completed', createdAt: 1, reviewRound: 0, noteOptions: [{ note: 1 }] } as Run;
    f.store.saveRun(run);
    f.store.saveItem({ id: run.id, taskId: f.task.id, type: 'user', text: '', createdAt: 1, meta: { notes: [{ where: 'main.tex line 1', quote: 'fast', comment: 'Clarify speed.' }] } });
    f.store.savePreference(noteOptionsKey(f.task.id, run.id + ':0', 1), { round: 1, key: run.id + ':0', selected: 'current', options: [
      { id: 'current', label: 'Current', edits: [{ unit: 'word', text: 'efficient' }] },
      { id: 'quick', label: 'Concise', reason: 'A familiar term.', edits: [{ unit: 'word', text: 'quick' }] },
    ] });
    const published = f.workspace.publish(f.task.id, run);
    await started.promise;
    assert.equal(f.store.task(f.task.id).status, 'building');
    assert.equal(f.store.task(f.task.id).review?.job?.phase, 'options');
    assert.deepEqual(f.store.task(f.task.id).review?.job?.options, { completed: 0, total: 1 });
    assert.ok(f.store.task(f.task.id).pendingBuild, 'The preparation can recover after restart');
    gate.resolve({});
    await published;
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
    assert.equal(f.store.task(f.task.id).pendingBuild, null);
    assert.equal(f.store.task(f.task.id).review?.job?.status, 'done');
  } finally { gate.resolve({}); f.close(); }
});

test('note alternatives are requested in the editing turn, respect the saved default, and preserve the original message', async () => {
  const f = fixture();
  try {
    f.codex.ready = false;
    const notes = [{ where: 'main.tex line 1', quote: 'The model is fast.', comment: 'Clarify speed.' }];
    // Off by default: no alternatives until the author turns them on.
    const unset = await f.workspace.enqueue(f.task.id, 'Keep the facts.', 'default-options', false, { reviewNotes: notes });
    assert.equal(unset.noteOptionsRequested, undefined);
    assert.doesNotMatch(unset.prompt, /papilot-note-options/);
    f.store.saveRun({ ...unset, status: 'completed' });
    f.store.savePreference('note-alternatives', true);
    const on = await f.workspace.enqueue(f.task.id, 'Keep the facts.', 'with-options', false, { reviewNotes: notes });
    assert.equal(on.noteOptionsRequested, true);
    assert.match(on.prompt, /aim for 1–2 extra alternatives/);
    assert.match(on.prompt, /papilot-note-options/);
    const original = f.store.items(f.task.id).find(item => item.id === on.id)!;
    assert.equal(original.text, 'Keep the facts.');
    assert.deepEqual(original.meta?.notes, notes);
    f.store.saveRun({ ...on, status: 'completed' });
    f.store.savePreference('note-alternative-range', 'many');
    const more = await f.workspace.enqueue(f.task.id, 'Keep the facts.', 'more-options', false, { reviewNotes: notes });
    assert.match(more.prompt, /aim for 3–5 extra alternatives/);
    assert.match(more.prompt, /target range, not a quota/);
    assert.match(f.store.runByKey('with-options')!.prompt, /aim for 1–2 extra alternatives/, 'Changing the preference affects only future requests');
    f.store.saveRun({ ...more, status: 'completed' });
    f.store.savePreference('note-alternatives', false);
    const off = await f.workspace.enqueue(f.task.id, 'Keep the facts.', 'without-options', false, { reviewNotes: notes });
    assert.equal(off.noteOptionsRequested, undefined);
    assert.doesNotMatch(off.prompt, /papilot-note-options/);
    f.store.saveRun({ ...off, status: 'completed' });
    f.store.savePreference('note-alternatives', true);
    const plain = await f.workspace.enqueue(f.task.id, 'Explain the result.', 'no-notes', false);
    assert.equal(plain.noteOptionsRequested, undefined);
  } finally { f.close(); }
});

test('the editing response carries prepared choices into publication without putting JSON in the conversation', async () => {
  const f = fixture();
  try {
    f.codex.ready = false;
    f.store.savePreference('note-alternatives', true);
    const run = await f.workspace.enqueue(f.task.id, 'Polish this.', 'prepared-response', false, { reviewNotes: [{ where: 'main.tex line 1', quote: 'fast', comment: 'Clarify.' }] });
    (f.workspace as any).active.set(f.task.id, run);
    f.store.updateTask(f.task.id, { status: 'running', turnId: 'editing-turn' });
    const choices = [{ note: 1, current: { label: 'Clear', reason: 'Clarify speed.' }, options: ['quick', 'efficient'].map(text => ({ label: text, reason: 'Use ' + text + '.', edits: [{ file: 'main.tex', find: 'fast', replace: text }] })) }];
    const reply = 'Clarified the wording.\n\n```papilot-note-options\n' + JSON.stringify({ notes: choices }) + '\n```';
    const params = { threadId: 'thread', turnId: 'editing-turn', itemId: 'reply' };
    await (f.workspace as any).notification({ method: 'item/agentMessage/delta', params: { ...params, delta: reply } });
    (f.workspace as any).flush();
    assert.equal(f.store.items(f.task.id).find(item => item.type === 'assistant')?.text, 'Clarified the wording.');
    await (f.workspace as any).notification({ method: 'item/completed', params: { ...params, item: { id: 'reply', type: 'agentMessage', text: reply } } });
    let published = false;
    f.workspace.publish = async (_id, submitted) => { published = true; assert.deepEqual(submitted?.noteOptions, choices); };
    await (f.workspace as any).notification({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'editing-turn', status: 'completed' } } });
    assert.equal(published, true);
    assert.deepEqual(f.store.runByKey('prepared-response')?.noteOptions, choices);
    const assistant = f.store.items(f.task.id).find(item => item.type === 'assistant')!;
    assert.equal(assistant.text, 'Clarified the wording.');
    assert.equal(assistant.rawText, reply);
  } finally { f.close(); }
});
const feedback = { cursor: 7, feedback: [{ body: 'Preserve the boundary condition.' }] };
const summary = { state: 'reviewing', round: 1, counts: { pending: 1 } };

class FakeCodex extends EventEmitter {
  permissionOptions = Codex.prototype.permissionOptions;
  async taskPermissionConfig(value: string, _cwd: string) {
    return { thread: { sandbox: value === 'full' ? 'danger-full-access' : 'workspace-write', approvalPolicy: value === 'full' ? 'never' : 'on-request' },
      turn: { sandboxPolicy: { type: value === 'full' ? 'dangerFullAccess' : 'workspaceWrite' }, approvalPolicy: value === 'full' ? 'never' : 'on-request' } };
  }
  ready = false;
  calls: { method: string; params: any }[] = [];
  replies: { id: string | number; result: unknown }[] = [];
  rejections: { id: string | number; message: string }[] = [];
  handler = async (method: string, _params: any): Promise<any> => method === 'turn/start' ? { turn: { id: 'turn-new' } } : { thread: { id: 'thread' } };
  async request(method: string, params: any) { this.calls.push({ method, params }); return this.handler(method, params); }
  respond(id: string | number, result: unknown) { this.replies.push({ id, result }); }
  reject(id: string | number, message: string) { this.rejections.push({ id, message }); }
  close() { this.ready = false; }
}

function fixture(reviewHandler?: (method: string, route: string, body?: unknown) => Promise<any>, options: { file?: string; reviewUrl?: string; claude?: FakeCodex } = {}) {
  const store = new Store(options.file || ':memory:');
  const codex = new FakeCodex();
  const calls: { method: string; route: string; body?: unknown }[] = [];
  const invoke = async (method: string, route: string, body?: unknown) => {
    calls.push({ method, route, body });
    if (reviewHandler) return reviewHandler(method, route, body);
    if (route.includes('/feedback')) return feedback;
    if (route.includes('/jobs/')) return { status: 'done' };
    if (route.endsWith('/publish')) return { job: 'job' };
    return summary;
  };
  const review: ReviewClient = { url: options.reviewUrl || 'http://unused', token: 'test', get: route => invoke('GET', route), post: (route, body) => invoke('POST', route, body) };
  const workspace = new Workspace(store, codex as unknown as Codex, async () => review, options.claude ? { claude: options.claude as unknown as Codex } : {});
  const task: Task = { id: 'task-id', projectId: 'paper', name: 'p-task', title: 'Task', instructions: 'Edit the introduction.', worktree: '/unused', threadId: 'thread', turnId: null, model: null, status: 'reviewing', createdAt: 1, updatedAt: 1, feedbackCursor: 0, error: null, review: null };
  store.saveProject({ id: task.projectId, name: 'Paper', path: '/unused', createdAt: 1 });
  store.saveTask(task);
  (workspace as any).loaded.add('thread');
  workspace.runtime.authenticated = true;
  return { store, codex, workspace, task, calls, close() { workspace.close(); store.close(); } };
}

function uncertainRun(f: ReturnType<typeof fixture>, active = true) {
  const run: Run = { id: 'pending-run', taskId: f.task.id, requestKey: 'pending-request', prompt: 'An uncertain revision.', feedbackCursor: 7, status: 'uncertain', createdAt: 1, finishedAt: null };
  f.store.saveRun(run);
  f.store.updateTask(f.task.id, { status: 'uncertain', turnId: null, pendingRunId: run.id, error: 'Check task status.' });
  if (active) (f.workspace as any).active.set(f.task.id, run);
  return run;
}

test('an older summary read that answers last cannot replace a newer one', async () => {
  const replies: { round: number; reply: ReturnType<typeof deferred<unknown>> }[] = [];
  let round = 1;
  const f = fixture(async (_method, route) => {
    if (route.includes('/feedback')) return { cursor: 0, feedback: [] };
    const reply = deferred<unknown>();
    replies.push({ round, reply });
    return reply.promise;
  });
  try {
    const first = f.workspace.refresh(f.task.id);
    await tick();
    round = 2;
    const second = f.workspace.refresh(f.task.id);
    for (let i = 0; i < 5; i++) await tick();
    // Whichever reads are in flight answer newest first.
    for (const { round, reply } of [...replies].reverse()) reply.resolve({ state: 'reviewing', round, counts: { pending: round } });
    for (let i = 0; i < 200 && replies.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
    for (const { round, reply } of [...replies].reverse()) reply.resolve({ state: 'reviewing', round, counts: { pending: round } });
    await Promise.all([first, second]);
    assert.equal(f.store.task(f.task.id).review?.round, 2);
    assert.ok(replies.length <= 2, 'reads of one task run one at a time');
  } finally { for (const { reply } of replies) reply.resolve(summary); f.close(); }
});

test('the last pending decision of a deferred task says the task is decided, once', async () => {
  let counts: Record<string, number> = { pending: 2, accepted: 1 };
  const f = fixture(async (_method, route) => route.includes('/feedback') ? { cursor: 0, feedback: [] } : { state: 'reviewing', round: 1, deferred: true, counts });
  const decided: string[] = [];
  f.workspace.on('decided', (id: string) => decided.push(id));
  try {
    await f.workspace.refresh(f.task.id);
    assert.deepEqual(decided, [], 'pending changes are not decided yet');
    counts = { pending: 0, accepted: 2, rejected: 1 };
    await f.workspace.refresh(f.task.id);
    assert.deepEqual(decided, [f.task.id], 'the last decision says so at once');
    await f.workspace.refresh(f.task.id);
    assert.deepEqual(decided, [f.task.id], 'reading the same decisions again says nothing');
    counts = { pending: 0, accepted: 3, rejected: 0 };
    await f.workspace.refresh(f.task.id);
    assert.equal(decided.length, 2, 'changed decisions with none pending say so again');
  } finally { f.close(); }
});

test('comparison progress reaches workspace snapshots and clears when the build finishes', async () => {
  const progress = { baseline: { step: 'tex', pass: 2, pages: 23, total: 180 } };
  let finished = false;
  const f = fixture(async (_method, route) => {
    if (route.endsWith('/publish')) return { job: 'job' };
    if (route.includes('/jobs/')) return finished ? { status: 'done', phase: 'render', round: 1 } : { status: 'running', phase: 'build', createdAt: 1234, progress };
    if (route.includes('/feedback')) return feedback;
    return summary;
  });
  try {
    const updated = new Promise<void>(resolve => f.workspace.on('change', () => {
      if (f.store.task(f.task.id).review?.job?.progress) resolve();
    }));
    const published = f.workspace.publish(f.task.id);
    await updated;
    assert.equal(f.workspace.snapshot().tasks[0].status, 'building');
    assert.deepEqual(f.workspace.snapshot().tasks[0].review?.job, { id: 'job', status: 'running', phase: 'build', createdAt: 1234, progress });
    finished = true;
    await published;
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
    assert.equal(f.store.task(f.task.id).pendingBuild, null);
    assert.equal(f.store.task(f.task.id).review?.job?.progress, undefined);
  } finally { f.close(); }
});

function identifiedTurn(run: Run, status = 'inProgress') {
  return { id: 'turn-confirmed', status, items: [{ type: 'userMessage', clientId: run.id }] };
}

const taskModels = [
  { id: 'deep', name: 'Deep', isDefault: true, efforts: ['low', 'high', 'xhigh'], defaultEffort: 'high', fastMode: { serviceTier: 'priority', description: '' } },
  { id: 'small', name: 'Small', isDefault: false, efforts: ['low', 'high'], defaultEffort: 'low' },
];

test('late agent events after shutdown never touch the closed database', async () => {
  const f = fixture();
  uncertainRun(f);
  f.close();
  assert.doesNotThrow(() => f.codex.emit('disconnected', new Error('Process exited after shutdown')));
  assert.doesNotThrow(() => f.codex.emit('request', { id: 'late', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread' } }));
  await (f.workspace as any).notification({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'late', status: 'interrupted' } } });
});

test('Claude streamed replies keep explicit state through completion, recovery and interruption', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-stream-state-')), file = path.join(dir, 'state.db');
  const f = fixture(undefined, { file, claude: new FakeCodex() });
  const notify = (method: string, params: object) => (f.workspace as any).notification({ method, params: { threadId: 'thread', turnId: 'turn-new', ...params } }, 'claude');
  const flush = () => (f.workspace as any).flush();
  try {
    f.store.updateTask(f.task.id, { agent: 'claude', status: 'running', turnId: 'turn-new' });
    await notify('item/agentMessage/delta', { itemId: 'msg_reply:1', delta: 'Checking the table.' });
    flush();
    assert.equal(f.store.items(f.task.id)[0].status, 'inProgress');
    await notify('item/completed', { item: { id: 'msg_reply:1', type: 'agentMessage', text: 'Checking the table.' } });
    const first = f.store.items(f.task.id)[0];
    assert.equal(first.status, 'completed');
    // A resumed block can already exist in storage without the new status.
    const second = { ...first, id: `${f.task.id}:turn-new:msg_reply:2`, text: 'Checking', status: undefined, createdAt: first.createdAt + 1 };
    f.store.saveItem(second);
    await notify('item/agentMessage/delta', { itemId: 'msg_reply:2', delta: ' the table.' });
    // Late deltas must not turn a completed item back into an unfinished one.
    await notify('item/agentMessage/delta', { itemId: 'msg_reply:1', delta: '' });
    flush();
    const items = f.store.items(f.task.id);
    assert.deepEqual(items.map(item => item.status), ['completed', 'inProgress']);
    assert.deepEqual(items.map(item => item.text), [first.text, first.text]);
    assert.deepEqual(visibleTimeline(items), items);
    f.store.updateTask(f.task.id, { status: 'interrupted', turnId: null });
    const reloaded = new Store(file);
    try { assert.deepEqual(visibleTimeline(reloaded.items(f.task.id)), items, 'interrupted replies remain visible from persisted data'); }
    finally { reloaded.close(); }
  } finally { f.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Codex defaults come from configuration, including profiles and models outside the catalog', async () => {
  const f = fixture();
  let config: any = { model: 'small' }, configFailure = false, catalogFailure = false;
  (f.codex as any).start = async () => { f.codex.ready = true; };
  f.codex.handler = async method => {
    if (method === 'account/read') return { requiresOpenaiAuth: false };
    if (method === 'config/read') {
      if (configFailure) throw new RpcResponseError('Unsupported method');
      return { config };
    }
    if (method === 'model/list') {
      if (catalogFailure) throw new Error('Catalog unavailable');
      return { data: taskModels.map(m => ({ model: m.id, displayName: m.name, isDefault: m.isDefault })) };
    }
    return {};
  };
  const reconnect = () => (f.workspace as any).connectAgent('codex');
  const defaults = () => f.workspace.runtime.models.filter(m => m.isDefault).map(m => m.id);
  try {
    await reconnect();
    assert.deepEqual(defaults(), ['small'], 'configured model overrides the catalog recommendation');
    assert.deepEqual(f.codex.calls.find(call => call.method === 'config/read')?.params, { includeLayers: false });
    config = { model: 'deep', profile: 'paper', profiles: { paper: { model: 'small' } } };
    await reconnect();
    assert.deepEqual(defaults(), ['small']);
    config = { model: 'custom-model' };
    await reconnect();
    assert.deepEqual(f.workspace.runtime.models.find(m => m.isDefault), { id: 'custom-model', name: 'custom-model', isDefault: true, efforts: [], defaultEffort: null });
    catalogFailure = true;
    await reconnect();
    assert.deepEqual(defaults(), ['custom-model'], 'configuration still works without a catalog');
    catalogFailure = false; config = { model: null };
    await reconnect();
    assert.deepEqual(defaults(), ['deep'], 'the catalog default applies when there is no configured override');
    configFailure = true;
    await reconnect();
    assert.deepEqual(defaults(), [], 'a failed read must not mislabel the catalog recommendation or retain stale defaults');
    assert.equal(f.workspace.runtime.models.length, 2);
    assert.equal(f.workspace.runtime.connected, true);
  } finally { f.close(); }
});

test('new tasks pin the resolved default and send it to both the thread and turn', async () => {
  const f = fixture(async (_method, route) => route === '/api/tasks' ? { worktree: '/unused' } : summary);
  try {
    f.workspace.runtime.models = taskModels.map(m => ({ ...m, isDefault: m.id === 'small' }));
    const input = { id: 'default-model-task-01', projectId: 'paper', title: 'Revise', instructions: 'Revise.', model: '' };
    const created = await f.workspace.createTask(input);
    assert.equal(created.model, 'small');
    const explicit = await f.workspace.createTask({ ...input, id: 'explicit-model-task-01', model: 'deep' });
    assert.equal(explicit.model, 'deep');
    f.workspace.runtime.models = taskModels;
    f.codex.ready = true;
    const run = f.store.runs().find(run => run.taskId === created.id)!;
    (f.workspace as any).active.set(created.id, run);
    await (f.workspace as any).startRun(run);
    assert.equal(f.codex.calls.find(call => call.method === 'thread/start' && !call.params.ephemeral)?.params.model, 'small');
    assert.equal(f.codex.calls.find(call => call.method === 'turn/start' && call.params.clientUserMessageId === run.id)?.params.model, 'small', 'a later default change cannot change the submitted model');
    assert.equal(f.workspace.updateTaskModel(created.id, { model: '' }).model, 'deep', 'resetting an existing task pins the current default');
  } finally { f.close(); }
});

test('task model settings persist, validate capabilities and clear incompatible options', () => {
  const f = fixture();
  try {
    f.workspace.runtime.models = taskModels;
    f.store.updateTask(f.task.id, { model: 'deep', effort: 'xhigh', serviceTier: 'priority', status: 'running', turnId: 'live-turn' });
    const changed = f.workspace.updateTaskModel(f.task.id, { model: 'small' });
    assert.deepEqual([changed.model, changed.effort, changed.serviceTier, changed.status, changed.threadId, changed.turnId], ['small', null, 'default', 'running', 'thread', 'live-turn']);
    assert.equal(f.codex.calls.length, 0, 'changing settings does not interrupt an active turn');
    assert.throws(() => f.workspace.updateTaskModel(f.task.id, { model: 'other-agent-model' }), /available model/);
    assert.throws(() => f.workspace.updateTaskModel(f.task.id, { effort: 'xhigh' }), /reasoning effort/);
    assert.throws(() => f.workspace.updateTaskModel(f.task.id, { serviceTier: 'priority' }), /Fast mode/);
    f.workspace.updateTaskModel(f.task.id, { effort: 'high' });
    assert.equal(f.workspace.updateTaskModel(f.task.id, { effort: '' }).effort, null);
    f.store.updateTask(f.task.id, { status: 'deleting' });
    assert.throws(() => f.workspace.updateTaskModel(f.task.id, { effort: 'low' }), /deleted/);
  } finally { f.close(); }
});

test('a task cannot reset to an unknown default and silently keep its previous model', () => {
  const f = fixture();
  try {
    f.workspace.runtime.models = taskModels.map(model => ({ ...model, isDefault: false }));
    f.store.updateTask(f.task.id, { model: 'small' });
    assert.throws(() => f.workspace.updateTaskModel(f.task.id, { model: '' }), /Choose an available model/);
    assert.equal(f.store.task(f.task.id).model, 'small');
    assert.equal(f.workspace.updateTaskModel(f.task.id, { effort: '' }).model, 'small', 'other settings remain editable');
    f.workspace.runtime.models = taskModels;
    assert.equal(f.workspace.updateTaskModel(f.task.id, { model: '' }).model, 'deep');
  } finally { f.close(); }
});

test('a loaded task uses its changed model and the selected model default effort', async () => {
  const f = fixture();
  try {
    f.workspace.runtime.models = taskModels;
    f.store.updateTask(f.task.id, { model: 'deep', effort: 'xhigh' });
    await f.workspace.enqueue(f.task.id, 'Continue.', 'model-change', false);
    f.workspace.updateTaskModel(f.task.id, { model: 'small', effort: '' });
    f.codex.ready = true;
    await tick();
    const call = f.codex.calls.find(call => call.method === 'turn/start');
    assert.equal(call?.params.model, 'small'); assert.equal(call?.params.effort, 'low');
    assert.equal(call?.params.threadId, 'thread');
    assert.ok(!f.codex.calls.some(call => call.method === 'thread/start' || call.method === 'thread/resume'));
  } finally { f.close(); }
});

test('changing settings during thread resume preserves the next turn choice', async () => {
  const f = fixture(), gate = deferred<any>();
  try {
    f.workspace.runtime.models = taskModels;
    f.store.updateTask(f.task.id, { model: 'deep', effort: 'xhigh' });
    (f.workspace as any).loaded.clear();
    f.codex.handler = async method => method === 'thread/resume' ? gate.promise : { turn: { id: 'turn-new' } };
    f.codex.ready = true;
    await f.workspace.enqueue(f.task.id, 'Continue.', 'resume-model-change', false);
    await tick();
    assert.ok(f.codex.calls.some(call => call.method === 'thread/resume'));
    f.workspace.updateTaskModel(f.task.id, { model: 'small', effort: 'low' });
    gate.resolve({ thread: { id: 'thread' }, model: 'deep' });
    await tick();
    assert.deepEqual([f.store.task(f.task.id).model, f.store.task(f.task.id).effort], ['small', 'low']);
    const turn = f.codex.calls.find(call => call.method === 'turn/start');
    assert.deepEqual([turn?.params.model, turn?.params.effort], ['deep', 'xhigh']);
  } finally { gate.resolve({ thread: { id: 'thread' } }); f.close(); }
});

const pendingReview: PendingReview = { route: '/api/tasks/p-task/decide', body: { id: 'decision-123', action: 'accept', round: 1, changes: ['change-1'] }, previousStatus: 'reviewing' };
const pageState = { csrf: 'test', task: 'p-task', title: 'Task', closed: false, state: 'reviewing', latest: 1, round: 1, revision: 'revision', decisions: { 'change-1': 'accepted' }, comments: {}, undo: null, job: null };

test('manual source saves track the existing build and never ask AI to repair compilation', async () => {
  const gate = deferred<{ status: string; error: string }>();
  const f = fixture(async (_method, route) => route.includes('/jobs/') ? gate.promise : summary);
  try {
    const state = { ...pageState, job: { id: 'source-job', status: 'queued' } };
    await f.workspace.reviewWrite(f.task.id, true, async () => state, { route: '/api/tasks/p-task/source', body: { id: 'source-save' } });
    assert.equal(f.store.task(f.task.id).status, 'building');
    assert.equal(f.store.task(f.task.id).pendingReview, null);
    assert.equal(f.store.task(f.task.id).pendingBuild?.job, 'source-job');
    assert.equal(f.store.task(f.task.id).pendingBuild?.sendBack, false);
    assert.equal(await f.workspace.reviewWrite(f.task.id, true, async () => 'reviewed'), 'reviewed');
    gate.resolve({ status: 'failed', error: 'The revised document could not be compiled.' });
    for (let i = 0; i < 20 && f.store.task(f.task.id).status === 'building'; i++) await tick();
    assert.equal(f.store.task(f.task.id).status, 'failed');
    assert.equal(f.store.runs().length, 0);
    assert.equal(f.calls.some(call => call.route.endsWith('/publish')), false);
  } finally { f.close(); }
});

test("undoing an accept of an earlier round tracks the build of the round it inserts; other undos build nothing", async () => {
  const gate = deferred<{ status: string; round: number }>();
  const f = fixture(async (_method, route) => route.includes('/jobs/') ? gate.promise : summary);
  try {
    const undo = { route: '/api/tasks/p-task/undo', body: { id: 'accept-before-round' } };
    await f.workspace.reviewWrite(f.task.id, true, async () => ({ ...pageState, restored: ['c001'] }), undo);
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
    assert.equal(f.store.task(f.task.id).pendingBuild ?? null, null);
    await f.workspace.reviewWrite(f.task.id, true, async () => ({ ...pageState, restored: ['c001'], republished: true, job: { id: 'undo-job', status: 'queued' } }), undo);
    assert.equal(f.store.task(f.task.id).status, 'building');
    assert.equal(f.store.task(f.task.id).pendingBuild?.job, 'undo-job');
    assert.equal(f.store.task(f.task.id).pendingBuild?.sendBack, false);
    gate.resolve({ status: 'done', round: 3 });
    for (let i = 0; i < 20 && f.store.task(f.task.id).status === 'building'; i++) await tick();
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
    assert.equal(f.calls.some(call => call.route.endsWith('/publish')), false);
  } finally { gate.resolve({ status: 'done', round: 3 }); f.close(); }
});

for (const status of ['done', 'failed']) test(`a source save during a build survives the older job becoming ${status}`, async () => {
  const old = deferred<unknown>(), next = deferred<unknown>(), started = deferred<void>(), followed = deferred<void>();
  const f = fixture(async (_method, route) => {
    if (route.endsWith('/publish')) return { job: 'old-job' };
    if (route.endsWith('/jobs/old-job')) { started.resolve(); return old.promise; }
    if (route.endsWith('/jobs/new-job')) { followed.resolve(); return next.promise; }
    if (route.includes('/feedback')) return feedback;
    return { ...summary, ready: 1 };
  });
  try {
    const publishing = f.workspace.publish(f.task.id);
    await started.promise;
    await f.workspace.reviewWrite(f.task.id, true, async () => ({ ...pageState, job: { id: 'new-job', status: 'queued' } }), { route: '/api/tasks/p-task/source', body: { id: 'new-save' } });
    old.resolve({ status, round: 1, error: 'The revised document could not be compiled.' });
    await followed.promise;
    assert.equal(f.store.task(f.task.id).pendingBuild?.job, 'new-job');
    assert.equal(f.store.task(f.task.id).status, 'building');
    assert.equal(f.store.task(f.task.id).review?.ready, 1);
    next.resolve({ status: 'done', round: 2 });
    await publishing;
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
    assert.equal(f.store.task(f.task.id).pendingBuild, null);
    assert.equal(f.calls.filter(call => call.route.endsWith('/publish')).length, 1);
  } finally { old.resolve({ status: 'done' }); next.resolve({ status: 'done' }); f.close(); }
});

for (const status of ['done', 'failed']) test(`a source save during the build after the agent's turn keeps that turn's result and repair (${status})`, async () => {
  const old = deferred<unknown>(), started = deferred<void>();
  const f = fixture(async (_method, route) => {
    if (route.endsWith('/publish')) return { job: 'old-job' };
    if (route.endsWith('/jobs/old-job')) { started.resolve(); return old.promise; }
    if (route.endsWith('/jobs/new-job')) return status === 'done' ? { status: 'done', outcome: 'published', round: 2 } : { status: 'failed', error: 'The revised document could not be compiled.', details: ['! Undefined control sequence.'] };
    if (route.includes('/feedback')) return feedback;
    return { ...summary, round: 2 };
  });
  try {
    const run: Run = { id: 'agent-run', taskId: f.task.id, requestKey: 'agent-request', prompt: 'Revise.', status: 'completed', createdAt: 1, finishedAt: 2, reviewRound: 0 };
    f.store.saveRun(run);
    const publishing = f.workspace.publish(f.task.id, run);
    await started.promise;
    await f.workspace.reviewWrite(f.task.id, true, async () => ({ ...pageState, job: { id: 'new-job', status: 'queued' } }), { route: '/api/tasks/p-task/source', body: { id: 'new-save' } });
    assert.deepEqual(f.store.task(f.task.id).pendingBuild?.runs, ['agent-run'], "the newer build still carries the agent's turn");
    assert.equal(f.store.task(f.task.id).pendingBuild?.sendBack, true);
    old.resolve({ status: 'done', outcome: 'published', round: 1 });
    await publishing;
    if (status === 'done') {
      assert.equal(f.store.runByKey('agent-request')?.reviewRound, 2, "the turn's result is the round that has its changes");
      assert.equal(f.store.task(f.task.id).status, 'reviewing');
    } else {
      assert.ok(f.store.runByKey('build-fix-new-job'), 'a build the turn broke goes back to the agent');
      assert.equal(f.store.task(f.task.id).status, 'queued');
    }
  } finally { old.resolve({ status: 'done' }); f.close(); }
});

test('recovering a lost source save resumes its build before queued agent work', async () => {
  const gate = deferred<{ status: string }>();
  const server = await reviewServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ...pageState, job: { id: 'source-job', status: 'running' } }));
  });
  const f = fixture(async (_method, route) => route.includes('/jobs/') ? gate.promise : summary, { reviewUrl: server.url });
  try {
    f.store.updateTask(f.task.id, { status: 'uncertain', pendingReview: { route: '/api/tasks/p-task/source', body: { id: 'saved-edit' }, previousStatus: 'reviewing' } });
    await f.workspace.reconcile(f.task.id);
    assert.equal(f.store.task(f.task.id).pendingReview, null);
    assert.equal(f.store.task(f.task.id).status, 'building');
    assert.equal(f.store.task(f.task.id).pendingBuild?.job, 'source-job');
    gate.resolve({ status: 'done' });
    for (let i = 0; i < 20 && f.store.task(f.task.id).status === 'building'; i++) await tick();
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
  } finally { f.close(); await server.close(); }
});

async function reviewServer(handler: (request: IncomingMessage, response: ServerResponse, body: any) => void | Promise<void>) {
  const calls: { route: string; body: any; token: string | string[] | undefined }[] = [];
  const server = createServer(async (request, response) => {
    try {
      let text = '';
      for await (const chunk of request) text += chunk;
      const body = text ? JSON.parse(text) : undefined;
      calls.push({ route: request.url!, body, token: request.headers['x-review-token'] });
      await handler(request, response, body);
    } catch { response.destroy(); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The review fixture did not bind an HTTP port.');
  return { calls, url: `http://127.0.0.1:${address.port}`, async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

test('enqueue preserves a newer building status after feedback loading yields', async () => {
  const gate = deferred<typeof feedback>();
  const f = fixture(async () => gate.promise);
  try {
    const pending = f.workspace.enqueue(f.task.id, 'Revise the wording.', 'request');
    await tick();
    f.store.updateTask(f.task.id, { status: 'building' });
    gate.resolve(feedback);
    const run = await pending;
    assert.equal(f.store.task(f.task.id).status, 'building');
    assert.equal(f.store.runByKey(run.requestKey)?.status, 'queued');
  } finally { f.close(); }
});

test('concurrent retries with one request key persist only one run and message', async () => {
  const gate = deferred<typeof feedback>();
  const f = fixture(async () => gate.promise);
  try {
    const first = f.workspace.enqueue(f.task.id, 'Revise once.', 'same-request');
    const retry = f.workspace.enqueue(f.task.id, 'Revise once.', 'same-request');
    gate.resolve(feedback);
    const [a, b] = await Promise.all([first, retry]);
    assert.equal(a.id, b.id);
    assert.equal(f.store.runs().length, 1);
    assert.equal(f.store.items(f.task.id).length, 1);
  } finally { f.close(); }
});

test('parallel distinct messages cannot both occupy the one queued slot', async () => {
  const gate = deferred<typeof feedback>();
  const f = fixture(async () => gate.promise);
  try {
    const first = f.workspace.enqueue(f.task.id, 'First instruction.', 'first');
    const second = f.workspace.enqueue(f.task.id, 'Second instruction.', 'second');
    const results = Promise.allSettled([first, second]);
    gate.resolve(feedback);
    const settled = await results;
    assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(settled.filter(result => result.status === 'rejected').length, 1);
    assert.equal(f.store.runs().length, 1);
    assert.equal(f.store.items(f.task.id).length, 1);
  } finally { f.close(); }
});

test('a review write reserves the worktree until it finishes', async () => {
  const gate = deferred<void>();
  const f = fixture();
  try {
    f.codex.ready = true;
    const writing = f.workspace.reviewWrite(f.task.id, true, () => gate.promise);
    await f.workspace.enqueue(f.task.id, 'Next revision.', 'next', false);
    await tick();
    assert.equal(f.codex.calls.length, 0);
    assert.throws(() => f.workspace.publish(f.task.id));
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => {}));
    gate.resolve();
    await writing;
    await tick();
    assert.equal(f.codex.calls.filter(call => call.method === 'turn/start').length, 1);
    assert.equal(f.store.task(f.task.id).status, 'running');
  } finally { gate.resolve(); f.close(); }
});

test('publication rejects duplicate builds and delays the next agent turn while allowing review writes', async () => {
  const gate = deferred<{ status: string }>();
  const f = fixture(async (_method, route) => route.includes('/jobs/') ? gate.promise : route.endsWith('/publish') ? { job: 'job' } : summary);
  try {
    f.codex.ready = true;
    const building = f.workspace.publish(f.task.id);
    assert.throws(() => f.workspace.publish(f.task.id));
    assert.equal(await f.workspace.reviewWrite(f.task.id, true, async () => 'reviewed'), 'reviewed');
    await f.workspace.enqueue(f.task.id, 'Next revision.', 'next', false);
    await tick();
    assert.equal(f.codex.calls.length, 0);
    assert.equal(f.store.task(f.task.id).status, 'building');
    gate.resolve({ status: 'done' });
    await building;
    await tick();
    assert.equal(f.codex.calls.filter(call => call.method === 'turn/start').length, 1);
  } finally { gate.resolve({ status: 'done' }); f.close(); }
});

// A deferred task whose agent is in the middle of a turn.
async function agentTurn(f: ReturnType<typeof fixture>) {
  f.store.updateTask(f.task.id, { deferred: true });
  f.codex.ready = true;
  await f.workspace.enqueue(f.task.id, 'Revise the introduction.', 'turn', false);
  await tick(); await tick();
  assert.equal(f.store.task(f.task.id).status, 'running');
  return () => (f.workspace as any).notification({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-new', status: 'completed' } } });
}
const accept = { route: '/api/tasks/p-task/decide', body: { id: 'accept-during-turn', action: 'accept', round: 1, changes: ['change-1'] } };

test('accepting during the agent\'s turn leaves it running, and the build after the turn waits for the accept', async () => {
  const gate = deferred<typeof pageState>();
  const f = fixture();
  try {
    const complete = await agentTurn(f);
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => pageState, { ...accept, body: { ...accept.body, action: 'reject' } }), /agent is editing this task's files/);
    const accepting = f.workspace.reviewWrite(f.task.id, true, () => gate.promise, accept, true);
    assert.equal(f.store.task(f.task.id).status, 'running');
    assert.equal(f.store.task(f.task.id).pendingReview?.previousStatus, 'interrupted', 'a restart during the turn leaves it interrupted');
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => pageState, accept, true), /already in progress/);
    // The turn ends while the accept is still being written.
    const completed = complete();
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(f.store.task(f.task.id).status, 'building');
    assert.equal(f.calls.some(call => call.route.endsWith('/publish')), false, 'the build waits for the accept');
    gate.resolve(pageState);
    assert.deepEqual(await accepting, pageState);
    await completed;
    assert.equal(f.calls.filter(call => call.route.endsWith('/publish')).length, 1);
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
    assert.equal(f.store.task(f.task.id).pendingReview, null);
  } finally { gate.resolve(pageState); f.close(); }
});

test('an accept the review engine did not confirm during the turn holds the build until Check status replays it', async () => {
  const server = await reviewServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(pageState));
  });
  const f = fixture(undefined, { reviewUrl: server.url });
  try {
    const complete = await agentTurn(f);
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => { throw new Error('fetch failed'); }, accept, true));
    assert.equal(f.store.task(f.task.id).status, 'running', 'the agent keeps its turn');
    assert.ok(f.store.task(f.task.id).pendingReview);
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => pageState, { ...accept, body: { ...accept.body, id: 'another' } }, true), /already in progress/);
    await complete();
    assert.equal(f.store.task(f.task.id).status, 'uncertain');
    assert.equal(f.store.task(f.task.id).pendingReview?.previousStatus, 'building');
    assert.ok(f.store.task(f.task.id).pendingBuild, 'the build is kept for after the check');
    assert.equal(f.calls.some(call => call.route.endsWith('/publish')), false);
    await f.workspace.reconcile(f.task.id);
    assert.deepEqual(server.calls.map(call => call.body?.id), ['accept-during-turn'], 'Check status replays the same action');
    for (let i = 0; i < 20 && f.store.task(f.task.id).status !== 'reviewing'; i++) await tick();
    assert.equal(f.calls.filter(call => call.route.endsWith('/publish')).length, 1);
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
    assert.equal(f.store.task(f.task.id).pendingReview, null);
  } finally { f.close(); await server.close(); }
});

test('an unconfirmed accept from a turn that was interrupted asks for Check status, then returns to interrupted', async () => {
  const server = await reviewServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(pageState));
  });
  const f = fixture(undefined, { reviewUrl: server.url });
  try {
    await agentTurn(f);
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => { throw new Error('fetch failed'); }, accept, true));
    await (f.workspace as any).notification({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-new', status: 'interrupted' } } });
    assert.equal(f.store.task(f.task.id).status, 'uncertain');
    await f.workspace.reconcile(f.task.id);
    assert.equal(f.store.task(f.task.id).status, 'interrupted');
    assert.equal(f.store.task(f.task.id).pendingReview, null);
    assert.equal(f.calls.some(call => call.route.endsWith('/publish')), false);
  } finally { f.close(); await server.close(); }
});

// A build whose job finishes once `finish` resolves, with an engine that
// confirms a replayed review action.
async function buildWithReplay(outcome: { status: string; error?: string }) {
  const job = deferred<void>();
  let done = false;
  void job.promise.then(() => { done = true; });
  const server = await reviewServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(pageState));
  });
  const f = fixture(async (_method, route) => {
    if (route.endsWith('/publish')) return { job: 'job' };
    if (route.includes('/jobs/')) return done ? { ...outcome, round: 1 } : { status: 'running', phase: 'build' };
    if (route.includes('/feedback')) return feedback;
    return summary;
  }, { reviewUrl: server.url });
  const building = f.workspace.publish(f.task.id);
  await tick();
  assert.equal(f.store.task(f.task.id).status, 'building');
  return { f, server, building, finish: async () => { job.resolve(); await building; }, async close() { job.resolve(); await building.catch(() => {}); f.close(); await server.close(); } };
}
const decide = { route: '/api/tasks/p-task/decide', body: { id: 'during-build', action: 'accept', round: 1, changes: ['change-1'] } };

for (const outcome of [{ status: 'done' }, { status: 'failed', error: 'The revised document could not be compiled.' }]) test(`a decision the engine did not confirm during a build asks for Check status once the build is ${outcome.status}`, async () => {
  const b = await buildWithReplay(outcome);
  const { f } = b;
  try {
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => { throw new Error('fetch failed'); }, decide));
    assert.equal(f.store.task(f.task.id).status, 'building', 'the build keeps its status; its end asks to check the action');
    await b.finish();
    assert.equal(f.store.task(f.task.id).status, 'uncertain');
    assert.equal(f.store.task(f.task.id).pendingReview?.previousStatus, outcome.status === 'done' ? 'reviewing' : 'failed');
    await f.workspace.reconcile(f.task.id);
    assert.deepEqual(b.server.calls.map(call => call.body?.id), ['during-build'], 'Check status replays the same action');
    assert.equal(f.store.task(f.task.id).pendingReview, null);
    assert.equal(f.store.task(f.task.id).status, outcome.status === 'done' ? 'reviewing' : 'failed');
    if (outcome.error) assert.match(f.store.task(f.task.id).error || '', /could not be compiled/, 'the build error is shown again after the check');
    else assert.equal(f.store.task(f.task.id).error, null);
    assert.equal(await f.workspace.reviewWrite(f.task.id, true, async () => 'next decision'), 'next decision');
  } finally { await b.close(); }
});

test('a decision whose response is lost after the build ended returns to the status the build reached', async () => {
  const b = await buildWithReplay({ status: 'done' });
  const { f } = b;
  const lost = deferred<void>();
  try {
    const writing = f.workspace.reviewWrite(f.task.id, true, async () => { await lost.promise; throw new Error('fetch failed'); }, decide);
    await b.finish();
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
    lost.resolve();
    await assert.rejects(writing);
    assert.equal(f.store.task(f.task.id).status, 'uncertain');
    assert.equal(f.store.task(f.task.id).pendingReview?.previousStatus, 'reviewing', 'not the building status the write started in');
    await f.workspace.reconcile(f.task.id);
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
    assert.equal(f.store.task(f.task.id).pendingReview, null);
  } finally { lost.resolve(); await b.close(); }
});

for (const ending of ['disconnected', 'failed to start'] as const) test(`an accept the engine did not confirm asks for Check status when the agent ${ending}`, async () => {
  const server = await reviewServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(pageState));
  });
  const f = fixture(undefined, { reviewUrl: server.url });
  try {
    await agentTurn(f);
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => { throw new Error('fetch failed'); }, accept, true));
    assert.equal(f.store.task(f.task.id).status, 'running');
    const run = (f.workspace as any).active.get(f.task.id) as Run;
    if (ending === 'disconnected') f.codex.emit('disconnected', new Error('closed'));
    else (f.workspace as any).failRun(run, new Error('The agent could not start.'));
    const expected = ending === 'disconnected' ? 'interrupted' : 'failed';
    assert.equal(f.store.task(f.task.id).status, 'uncertain');
    assert.equal(f.store.task(f.task.id).pendingReview?.previousStatus, expected);
    await f.workspace.reconcile(f.task.id);
    assert.deepEqual(server.calls.map(call => call.body?.id), ['accept-during-turn']);
    assert.equal(f.store.task(f.task.id).status, expected);
    assert.equal(f.store.task(f.task.id).pendingReview, null);
    assert.match(f.store.task(f.task.id).error || '', ending === 'disconnected' ? /disconnected/ : /could not start/);
  } finally { f.close(); await server.close(); }
});

test('Check status replays an unconfirmed review action whatever the task status, once no write is in flight', async () => {
  const server = await reviewServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(pageState));
  });
  const f = fixture(undefined, { reviewUrl: server.url });
  try {
    f.store.updateTask(f.task.id, { status: 'reviewing', pendingReview });
    await f.workspace.reconcile(f.task.id);
    assert.deepEqual(server.calls.map(call => call.body?.id), ['decision-123']);
    assert.equal(f.store.task(f.task.id).pendingReview, null);
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
  } finally { f.close(); await server.close(); }
});

test('while a round compiles its changed chapters, its new version is announced once, so the whole paper compiles meanwhile', async () => {
  let polls = 0;
  const f = fixture(async (_method, route) => route.includes('/jobs/')
    ? ++polls < 3 ? { status: 'running', phase: 'build', revision: 'a1b2c3' } : { status: 'done', outcome: 'published', round: 1 }
    : route.endsWith('/publish') ? { job: 'job' } : summary);
  try {
    const announced: [string, string][] = [];
    f.workspace.on('publishing', (taskId: string, revision: string) => announced.push([taskId, revision]));
    await f.workspace.publish(f.task.id);
    assert.equal(polls, 3);
    assert.deepEqual(announced, [[f.task.id, 'a1b2c3']]);
  } finally { f.close(); }
});

test('a round lists indirect changes only when Settings track them', async () => {
  const f = fixture();
  try {
    const sent = () => f.calls.filter(call => call.route.endsWith('/publish')).map(call => (call.body as { indirect?: boolean }).indirect);
    await f.workspace.publish(f.task.id);
    f.workspace.indirectChanges = () => true;
    await f.workspace.publish(f.task.id);
    assert.deepEqual(sent(), [false, true]);
  } finally { f.close(); }
});

test('publication records each completed run result once and treats no new edits as no result', async () => {
  let round = 2, outcome = 'published';
  const f = fixture(async (_method, route) => route.includes('/jobs/') ? { status: 'done', outcome, round } : route.endsWith('/publish') ? { job: 'job' } : { ...summary, round });
  try {
    const run: Run = { id: 'finished-notes', taskId: f.task.id, requestKey: 'notes', prompt: 'Revise the notes.', status: 'completed', createdAt: 1, finishedAt: 2, reviewRound: 0 };
    f.store.saveRun(run);
    f.store.saveRun({ ...run, id: 'legacy-notes', requestKey: 'legacy', reviewRound: undefined });
    await f.workspace.publish(f.task.id);
    assert.equal(f.store.runByKey('notes')?.reviewRound, 2);
    assert.equal(f.store.runByKey('legacy')?.reviewRound, undefined, 'a new build cannot claim historical requests');
    round = 3;
    await f.workspace.publish(f.task.id);
    assert.equal(f.store.runByKey('notes')?.reviewRound, 2, 'later proposals cannot replace the original result');
    f.store.saveRun({ ...run, id: 'ignored-notes', requestKey: 'ignored' });
    outcome = 'unchanged';
    await f.workspace.publish(f.task.id);
    assert.equal(f.store.runByKey('ignored')?.reviewRound, null, 'an ignored request must not point at an older proposal');
  } finally { f.close(); }
});

test('comments remain available during an active turn while file decisions are blocked', async () => {
  const f = fixture();
  try {
    f.store.updateTask(f.task.id, { status: 'running', turnId: 'turn-new' });
    (f.workspace as any).active.set(f.task.id, { id: 'run' });
    assert.equal(await f.workspace.reviewWrite(f.task.id, false, async () => 'comment saved'), 'comment saved');
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => {}));
    assert.throws(() => f.workspace.publish(f.task.id));
  } finally { f.close(); }
});

test('a lost publish response retries the same persisted request and links its result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let submissions = 0;
  const f = fixture(async (_method, route, body) => {
    if (route.endsWith('/publish')) {
      assert.equal((body as any).requestId, f.store.task(f.task.id).pendingBuild?.requestId);
      if (++submissions === 1) throw new TypeError('fetch failed');
      return { job: 'recovered' };
    }
    if (route.includes('/jobs/')) return { status: 'done', round: 2 };
    return { ...summary, round: 2 };
  });
  try {
    f.store.saveRun({ id: 'run', taskId: f.task.id, requestKey: 'request', prompt: '', status: 'completed', createdAt: 1, finishedAt: 2, reviewRound: 0 });
    const publishing = f.workspace.publish(f.task.id);
    await tick();
    assert.equal(f.store.task(f.task.id).status, 'building');
    t.mock.timers.tick(1500);
    await publishing;
    const writes = f.calls.filter(call => call.route.endsWith('/publish'));
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0].body, writes[1].body);
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
    assert.equal(f.store.task(f.task.id).pendingBuild, null);
    assert.equal(f.store.runByKey('request')?.reviewRound, 2);
  } finally { f.close(); }
});

test('an extended connection outage preserves the job and Check status recovers without publishing again', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let online = false;
  const f = fixture(async (_method, route) => {
    if (route.endsWith('/publish')) return { job: 'existing' };
    if (route.includes('/jobs/')) {
      if (!online) throw new TypeError('fetch failed');
      return { status: 'done', round: 1 };
    }
    return summary;
  });
  try {
    const publishing = f.workspace.publish(f.task.id);
    for (const delay of [1500, 3000, 6000]) { await tick(); t.mock.timers.tick(delay); }
    await publishing;
    assert.equal(f.store.task(f.task.id).status, 'uncertain');
    assert.equal(f.store.task(f.task.id).pendingBuild?.job, 'existing');
    assert.match(f.store.task(f.task.id).error!, /Check status/);
    assert.throws(() => f.workspace.publish(f.task.id), /busy/);
    online = true;
    await f.workspace.reconcile(f.task.id);
    await tick();
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
    assert.equal(f.calls.filter(call => call.route.endsWith('/publish')).length, 1);
    assert.equal(f.codex.calls.length, 0);
  } finally { f.close(); }
});

test('restart recovery resumes a saved job and preserves original run links while allowing review writes', async () => {
  const gate = deferred<{ status: string; round: number }>();
  const f = fixture(async (_method, route) => route.includes('/jobs/') ? gate.promise : summary);
  try {
    f.store.saveRun({ id: 'old', taskId: f.task.id, requestKey: 'old', prompt: '', status: 'completed', createdAt: 1, finishedAt: 2, reviewRound: 0 });
    f.store.updateTask(f.task.id, { status: 'building', pendingBuild: { requestId: 'saved', job: 'existing', runs: ['old'], sendBack: false, restarts: 0 } });
    f.store.recover();
    const recovering = f.workspace.resumeBuild(f.task.id);
    await tick();
    assert.equal(await f.workspace.resumeBuild(f.task.id), false);
    assert.equal(await f.workspace.reviewWrite(f.task.id, true, async () => 'reviewed'), 'reviewed');
    gate.resolve({ status: 'done', round: 3 });
    assert.equal(await recovering, true);
    assert.equal(f.store.runByKey('old')?.reviewRound, 3);
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
    assert.equal(f.calls.some(call => call.method === 'POST'), false);
  } finally { gate.resolve({ status: 'done', round: 3 }); f.close(); }
});

test('legacy fetch-failed tasks recover their completed PDF round without rerunning the agent', async () => {
  const f = fixture();
  try {
    f.store.updateTask(f.task.id, { status: 'failed', error: 'fetch failed', review: { ...summary, round: null, job: { id: 'existing', status: 'running', phase: 'render' } } });
    assert.equal(await f.workspace.resumeBuild(f.task.id), true);
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
    assert.equal(f.store.task(f.task.id).review?.round, 1);
    assert.equal(f.calls.some(call => call.method === 'POST'), false);
    assert.equal(f.codex.calls.length, 0);
  } finally { f.close(); }
});

test('shutdown during polling leaves a durable job that a new workspace resumes', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-build-recovery-'));
  const file = path.join(folder, 'state.sqlite');
  const gate = deferred<{ status: string }>();
  const f = fixture(async (_method, route) => route.includes('/jobs/') ? gate.promise : route.endsWith('/publish') ? { job: 'durable-job' } : summary, { file });
  const publishing = f.workspace.publish(f.task.id);
  await tick();
  f.workspace.close();
  gate.resolve({ status: 'done' });
  await publishing;
  f.store.close();
  const store = new Store(file);
  const review: ReviewClient = { url: 'http://unused', token: '', get: async <T>(route: string) => (route.includes('/jobs/') ? { status: 'done' } : summary) as T, post: async () => { throw new Error('Must not republish'); } };
  const workspace = new Workspace(store, new FakeCodex() as unknown as Codex, async () => review);
  try {
    store.recover();
    assert.equal(store.task(f.task.id).pendingBuild?.job, 'durable-job');
    await workspace.resumeBuild(f.task.id);
    assert.equal(store.task(f.task.id).status, 'reviewing');
    assert.equal(store.task(f.task.id).pendingBuild, null);
  } finally { workspace.close(); store.close(); fs.rmSync(folder, { recursive: true, force: true }); }
});

test('a service-restart failure rebuilds only once; compiler errors never trigger a connection retry', async () => {
  for (const error of ['The review server restarted during the build.', 'The comparison baseline could not be compiled.']) {
    let submits = 0;
    const f = fixture(async (_method, route) => {
      if (route.endsWith('/publish')) return { job: `job-${++submits}` };
      if (route.includes('/jobs/')) return { status: 'failed', error };
      return summary;
    });
    try {
      await f.workspace.publish(f.task.id);
      assert.equal(submits, error.includes('restarted') ? 2 : 1);
      assert.equal(f.store.task(f.task.id).status, 'failed');
      assert.equal(f.store.task(f.task.id).pendingBuild, null);
      assert.equal(f.store.task(f.task.id).error, error);
      const writes = f.calls.filter(call => call.route.endsWith('/publish'));
      if (writes.length === 2) assert.notDeepEqual(writes[0].body, writes[1].body);
    } finally { f.close(); }
  }
});

test('canceling queued feedback leaves it available for the next submission', async () => {
  const f = fixture();
  try {
    await f.workspace.enqueue(f.task.id, 'Apply the review comments.', 'first');
    assert.equal(f.store.task(f.task.id).feedbackCursor, 0);
    await f.workspace.interrupt(f.task.id);
    assert.equal(f.store.runByKey('first')?.status, 'interrupted');
    const retry = await f.workspace.enqueue(f.task.id, 'Apply the review comments.', 'retry');
    assert.match(retry.prompt, /Preserve the boundary condition/);
    assert.equal(f.store.task(f.task.id).feedbackCursor, 0);
    const afters = f.calls.filter(call => call.route.includes('/feedback')).map(call => new URL(call.route, 'http://unused').searchParams.get('after'));
    assert.ok(afters.length >= 2 && afters.every(after => after === '0'), afters.join());
  } finally { f.close(); }
});

test('unsent review feedback includes decisions and excludes feedback already queued for Codex', async () => {
  const items = [{ id: 3, kind: 'comment' }, { id: 5, kind: 'reject' }, { id: 7, kind: 'comment' }];
  const f = fixture(async (_method, route) => {
    if (!route.includes('/feedback')) return summary;
    const after = Number(new URL(route, 'http://unused').searchParams.get('after'));
    const feedback = items.filter(item => item.id > after);
    return { cursor: feedback.at(-1)?.id ?? after, feedback };
  });
  try {
    await f.workspace.refresh(f.task.id);
    assert.equal(f.store.task(f.task.id).review?.unsent, 3);
    await f.workspace.enqueue(f.task.id, 'Address the comments.', 'send');
    await f.workspace.refresh(f.task.id);
    assert.equal(f.store.task(f.task.id).review?.unsent, 0);
    await f.workspace.interrupt(f.task.id);
    await f.workspace.refresh(f.task.id);
    assert.equal(f.store.task(f.task.id).review?.unsent, 3, 'Pausing a queued message returns its decisions and comments to the unsent count');
  } finally { f.close(); }
});

test('accept-only, reject-only and undo feedback can be sent without comments', async () => {
  for (const kind of ['accept', 'reject', 'undo', 'note']) {
    const items = [{ id: 7, kind, round: 1, changes: ['change-1'] }];
    const f = fixture(async (_method, route) => {
      if (!route.includes('/feedback')) return { state: 'done', round: 1, counts: { pending: 0, accepted: kind === 'accept' ? 1 : 0, rejected: kind === 'reject' ? 1 : 0, commented: 0 } };
      const after = Number(new URL(route, 'http://unused').searchParams.get('after'));
      return { cursor: Math.max(after, 7), feedback: items.filter(item => item.id > after) };
    });
    try {
      await f.workspace.refresh(f.task.id);
      assert.equal(f.store.task(f.task.id).review?.unsent, 1, kind);
      const run = await f.workspace.enqueue(f.task.id, 'Continue from the review decisions.', 'send-decisions');
      assert.match(run.prompt, new RegExp(`"kind": "${kind}"`));
      assert.equal(run.feedbackCursor, 7);
      assert.equal((await f.workspace.enqueue(f.task.id, 'Continue from the review decisions.', 'send-decisions')).id, run.id);
      await f.workspace.refresh(f.task.id);
      assert.equal(f.store.task(f.task.id).review?.unsent, 0, kind);
      await f.workspace.interrupt(f.task.id);
      f.store.updateTask(f.task.id, { feedbackCursor: 7 });
      await f.workspace.refresh(f.task.id);
      assert.equal(f.store.task(f.task.id).review?.unsent, 0, 'Delivered feedback stays hidden');
    } finally { f.close(); }
  }
});

test('renaming a task changes only its title and is blocked during deletion', () => {
  const f = fixture();
  try {
    const renamed = f.workspace.renameTask(f.task.id, 'Clarify the abstract');
    assert.equal(renamed.title, 'Clarify the abstract');
    assert.equal(f.store.task(f.task.id).instructions, f.task.instructions);
    f.store.updateTask(f.task.id, { status: 'deleting' });
    assert.throws(() => f.workspace.renameTask(f.task.id, 'Another title'), /being deleted/);
  } finally { f.close(); }
});

test('archiving survives a restart, retains task history and review, and restores idempotently', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-archive-'));
  const file = path.join(dir, 'state.db'), f = fixture(undefined, { file });
  try {
    f.store.updateTask(f.task.id, { review: summary, committed: { hash: 'abc', accepted: 'text', at: 1 } });
    f.store.saveItem({ id: 'message', taskId: f.task.id, type: 'user', text: 'Keep this conversation.', createdAt: 1 });
    const before = f.store.task(f.task.id), items = f.store.items(f.task.id);
    const archived = f.workspace.archiveTask(f.task.id, true);
    assert.ok(archived.archivedAt);
    assert.deepEqual({ ...archived, archivedAt: undefined, updatedAt: before.updatedAt }, { ...before, archivedAt: undefined });
    assert.deepEqual(f.workspace.archiveTask(f.task.id, true), archived);
    await f.workspace.refresh(f.task.id);
    assert.equal(f.store.task(f.task.id).archivedAt, archived.archivedAt, 'review updates preserve the archive');
    const reopened = new Store(file);
    try {
      reopened.recover();
      assert.equal(reopened.task(f.task.id).archivedAt, archived.archivedAt);
      assert.deepEqual(reopened.items(f.task.id), items);
      assert.deepEqual(reopened.task(f.task.id).committed, before.committed);
    } finally { reopened.close(); }
    const restored = f.workspace.archiveTask(f.task.id, false);
    assert.equal(restored.archivedAt, null);
    assert.deepEqual(f.workspace.archiveTask(f.task.id, false), restored);
    assert.deepEqual(f.store.items(f.task.id), items);
    assert.equal(f.calls.some(call => call.method === 'POST'), false, 'archiving never writes to the review engine');
    f.store.updateTask(f.task.id, { status: 'running' });
    assert.equal(f.workspace.archiveTask(f.task.id, true).status, 'running', 'archiving does not interrupt a running task');
    f.store.updateTask(f.task.id, { status: 'deleting' });
    assert.throws(() => f.workspace.archiveTask(f.task.id, false), /being deleted/);
  } finally { f.close(); fs.rmSync(dir, { recursive: true }); }
});

test('legacy navigation requests do not archive completed tasks; explicit archiving and follow-ups still work', async () => {
  const f = fixture();
  try {
    const finished = { state: 'done', round: 1, counts: { accepted: 1 }, unsent: 1, comments: 0, files: [] };
    f.store.updateTask(f.task.id, { review: { ...finished, state: 'revise', counts: { commented: 1 }, comments: 1 } });
    assert.equal(f.workspace.archiveTask(f.task.id, true, true).archivedAt, undefined, 'a comment still waits for the agent');
    f.store.updateTask(f.task.id, { review: finished });
    assert.equal(f.workspace.archiveTask(f.task.id, true, true).archivedAt, undefined);
    f.store.updateTask(f.task.id, { mode: 'review', review: { ...finished, round: null } });
    assert.equal(f.workspace.archiveTask(f.task.id, true, true).archivedAt, undefined, 'opening the PDF is not an archive action');
    f.store.updateTask(f.task.id, { mode: 'edit' });
    assert.ok(f.workspace.archiveTask(f.task.id, true).archivedAt);
    await f.workspace.enqueue(f.task.id, 'One more pass on the abstract.', 'follow-up');
    assert.equal(f.store.task(f.task.id).archivedAt, null, 'a follow-up brings the task back');
    assert.equal(f.store.task(f.task.id).status, 'queued');
    assert.equal(f.workspace.archiveTask(f.task.id, true, true).archivedAt, null, 'new work keeps it listed');
    assert.ok(f.workspace.archiveTask(f.task.id, true).archivedAt, 'the author can still archive it by hand');
  } finally { f.close(); }
});

test('renaming a paper changes only its display name', () => {
  const f = fixture();
  try {
    const renamed = f.workspace.renameProject(f.task.projectId, 'Small Steps');
    assert.equal(renamed.name, 'Small Steps');
    assert.deepEqual(f.store.project(f.task.projectId), { id: f.task.projectId, name: 'Small Steps', path: '/unused', createdAt: 1 });
    assert.throws(() => f.workspace.renameProject('missing', 'Other'), /not found/);
  } finally { f.close(); }
});

test('feedback is marked delivered only after turn start is acknowledged', async () => {
  const ack = deferred<{ turn: { id: string } }>();
  const f = fixture();
  try {
    f.codex.handler = async () => ack.promise;
    f.codex.ready = true;
    await f.workspace.enqueue(f.task.id, 'Apply the review comments.', 'request');
    await tick();
    assert.equal(f.store.task(f.task.id).feedbackCursor, 0);
    ack.resolve({ turn: { id: 'turn-new' } });
    await tick();
    assert.equal(f.store.task(f.task.id).feedbackCursor, 7);
  } finally { ack.resolve({ turn: { id: 'turn-new' } }); f.close(); }
});

test('old completion and failure callbacks cannot finalize a newer active run', async () => {
  const f = fixture();
  try {
    const run: Run = { id: 'new-run', taskId: f.task.id, requestKey: 'new-request', prompt: 'New instruction.', status: 'running', createdAt: 1, finishedAt: null };
    f.store.saveRun(run);
    f.store.updateTask(f.task.id, { status: 'running', turnId: 'turn-new' });
    (f.workspace as any).active.set(f.task.id, run);
    await (f.workspace as any).notification({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-old', status: 'completed' } } });
    (f.workspace as any).failRun({ ...run, id: 'old-run' }, new Error('Late failure'));
    assert.equal(f.store.task(f.task.id).status, 'running');
    assert.equal(f.store.task(f.task.id).turnId, 'turn-new');
    assert.equal(f.store.runByKey('new-request')?.status, 'running');
    assert.equal((f.workspace as any).active.get(f.task.id)?.id, run.id);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('a fast completion before the turn/start response is applied to its owning run', async () => {
  const ack = deferred<{ turn: { id: string } }>();
  const f = fixture();
  try {
    f.codex.handler = async () => ack.promise;
    f.codex.ready = true;
    await f.workspace.enqueue(f.task.id, 'Small revision.', 'request', false);
    await tick();
    await (f.workspace as any).notification({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-fast', status: 'completed' } } });
    assert.equal(f.store.runByKey('request')?.status, 'running');
    ack.resolve({ turn: { id: 'turn-fast' } });
    await tick();
    assert.equal(f.store.runByKey('request')?.status, 'completed');
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
    assert.equal(f.calls.filter(call => call.route.endsWith('/publish')).length, 1);
    assert.equal((f.workspace as any).active.has(f.task.id), false);
  } finally { ack.resolve({ turn: { id: 'turn-fast' } }); f.close(); }
});

test('pause invalidates a message still loading feedback before it reaches the queue', async () => {
  const gate = deferred<typeof feedback>();
  const f = fixture(async () => gate.promise);
  try {
    const pending = f.workspace.enqueue(f.task.id, 'Delayed instruction.', 'request');
    const rejected = assert.rejects(pending);
    await tick();
    await f.workspace.interrupt(f.task.id);
    gate.resolve(feedback);
    await rejected;
    assert.equal(f.store.task(f.task.id).status, 'interrupted');
    assert.equal(f.store.runs().length, 0);
    assert.equal(f.store.items(f.task.id).length, 0);
  } finally { gate.resolve(feedback); f.close(); }
});

test('an uncertain turn/start outcome retains its worktree reservation', async () => {
  const f = fixture();
  try {
    f.codex.handler = async () => { throw new Error('Codex request timed out: turn/start'); };
    f.codex.ready = true;
    const run = await f.workspace.enqueue(f.task.id, 'Possibly started instruction.', 'request', false);
    await tick();
    assert.equal(f.store.task(f.task.id).status, 'uncertain');
    assert.equal(f.store.runByKey('request')?.status, 'uncertain');
    assert.equal((f.store.task(f.task.id) as any).pendingRunId, run.id);
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => {}));
    assert.throws(() => f.workspace.publish(f.task.id));
    await assert.rejects(f.workspace.enqueue(f.task.id, 'A later instruction.', 'next', false));
    await tick();
    assert.equal(f.codex.calls.filter(call => call.method === 'turn/start').length, 1);
  } finally { f.close(); }
});

test('an explicit turn/start rejection safely releases its reservation', async () => {
  const f = fixture();
  try {
    f.codex.handler = async () => { throw new RpcResponseError('Model is unavailable.'); };
    f.codex.ready = true;
    await f.workspace.enqueue(f.task.id, 'Rejected revision.', 'request', false);
    await tick();
    assert.equal(f.store.task(f.task.id).status, 'failed');
    assert.equal(f.store.task(f.task.id).pendingRunId, null);
    assert.equal(f.store.runByKey('request')?.status, 'failed');
    assert.equal((f.workspace as any).active.has(f.task.id), false);
    assert.equal(await f.workspace.reviewWrite(f.task.id, true, async () => 'allowed'), 'allowed');
  } finally { f.close(); }
});

test('reconcile restores a persisted active turn by its message identity and replays its input request', async () => {
  const f = fixture();
  try {
    const run = uncertainRun(f, false);
    const request = { id: 23, method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn-confirmed', questions: [{ id: 'scope', question: 'Which section?' }] } };
    (f.workspace as any).earlyRequests.set(f.task.id, [request]);
    f.codex.handler = async () => ({ thread: { status: { type: 'active' }, turns: [identifiedTurn(run)] } });
    const task = await f.workspace.reconcile(f.task.id);
    assert.equal(task.status, 'waiting_input');
    assert.equal(task.turnId, 'turn-confirmed');
    assert.equal(task.pendingRunId, null);
    assert.equal(task.feedbackCursor, 7);
    assert.equal(f.store.runByKey(run.requestKey)?.status, 'running');
    assert.equal((f.workspace as any).active.get(f.task.id)?.id, run.id);
    assert.equal(f.workspace.requests.size, 1);
    assert.equal(f.codex.calls[0].method, 'thread/read');
    assert.equal(f.codex.calls[0].params.includeTurns, true);
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => {}));
  } finally { f.close(); }
});

test('reconcile finalizes an identified completed turn and builds its review once', async () => {
  const f = fixture();
  try {
    const run = uncertainRun(f);
    f.codex.handler = async () => ({ thread: { status: { type: 'idle' }, turns: [identifiedTurn(run, 'completed')] } });
    await Promise.all([f.workspace.reconcile(f.task.id), f.workspace.reconcile(f.task.id)]);
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
    assert.equal(f.store.task(f.task.id).turnId, null);
    assert.equal(f.store.task(f.task.id).pendingRunId, null);
    assert.equal(f.store.runByKey(run.requestKey)?.status, 'completed');
    assert.equal(f.calls.filter(call => call.route.endsWith('/publish')).length, 1);
    assert.equal((f.workspace as any).active.has(f.task.id), false);
  } finally { f.close(); }
});

test('reconcile cannot adopt an unrelated turn or unlock a missing pending turn', async () => {
  const f = fixture();
  try {
    const run = uncertainRun(f, false);
    f.codex.handler = async () => ({ thread: { status: { type: 'idle' }, turns: [identifiedTurn({ ...run, id: 'unrelated-run' }, 'completed')] } });
    await assert.rejects(f.workspace.reconcile(f.task.id), /not confirmed/);
    assert.equal(f.store.task(f.task.id).status, 'uncertain');
    assert.equal(f.store.task(f.task.id).pendingRunId, run.id);
    assert.equal(f.store.task(f.task.id).feedbackCursor, 0);
    assert.equal(f.store.runByKey(run.requestKey)?.status, 'uncertain');
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => {}));
    assert.throws(() => f.workspace.publish(f.task.id));
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('reconcile recognizes a persisted known turn even when its user item is absent', async () => {
  const f = fixture();
  try {
    const run = uncertainRun(f, false);
    f.store.updateTask(f.task.id, { turnId: 'known-turn' });
    f.codex.handler = async () => ({ thread: { status: { type: 'notLoaded' }, turns: [{ id: 'known-turn', status: 'inProgress', items: [] }] } });
    await f.workspace.reconcile(f.task.id);
    assert.equal(f.store.task(f.task.id).status, 'interrupted');
    assert.equal(f.store.runByKey(run.requestKey)?.status, 'interrupted');
    assert.equal((f.workspace as any).active.has(f.task.id), false);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('reconcile preserves a completion received while reading an older in-progress snapshot', async () => {
  const read = deferred<any>();
  const f = fixture();
  try {
    const run = uncertainRun(f);
    f.codex.handler = async () => read.promise;
    const checking = f.workspace.reconcile(f.task.id);
    await (f.workspace as any).notification({ method: 'turn/completed', params: { threadId: 'thread', turn: identifiedTurn(run, 'completed') } });
    read.resolve({ thread: { status: { type: 'active' }, turns: [identifiedTurn(run)] } });
    await checking;
    assert.equal(f.store.runByKey(run.requestKey)?.status, 'completed');
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
    assert.equal(f.calls.filter(call => call.route.endsWith('/publish')).length, 1);
  } finally { read.resolve({ thread: { turns: [] } }); f.close(); }
});

test('a stale request resolution cannot replace uncertain status with running', async () => {
  const f = fixture();
  try {
    uncertainRun(f);
    await (f.workspace as any).notification({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 999 } });
    assert.equal(f.store.task(f.task.id).status, 'uncertain');
    assert.equal(f.store.task(f.task.id).turnId, null);
    await assert.rejects(f.workspace.enqueue(f.task.id, 'Do not restart yet.', 'next', false));
  } finally { f.close(); }
});

test('an input request resolved before turn/start acknowledgement is not replayed', async () => {
  const ack = deferred<{ turn: { id: string } }>();
  const f = fixture();
  try {
    f.codex.handler = async () => ack.promise;
    f.codex.ready = true;
    await f.workspace.enqueue(f.task.id, 'Small revision.', 'request', false);
    await tick();
    (f.workspace as any).serverRequest({ id: 31, method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn-new', questions: [{ id: 'scope', question: 'Which section?' }] } });
    await (f.workspace as any).notification({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 31 } });
    ack.resolve({ turn: { id: 'turn-new' } });
    await tick();
    assert.equal(f.workspace.requests.size, 0);
    assert.equal(f.store.task(f.task.id).status, 'running');
  } finally { ack.resolve({ turn: { id: 'turn-new' } }); f.close(); }
});

test('an ambiguous review write keeps queued edits reserved until the decision is confirmed', async () => {
  const gate = deferred<void>();
  const f = fixture();
  try {
    f.codex.ready = true;
    const writing = f.workspace.reviewWrite(f.task.id, true, async () => { await gate.promise; throw new Error('Review response was lost.'); }, pendingReview);
    const rejected = assert.rejects(writing, /lost/);
    assert.deepEqual(f.store.task(f.task.id).pendingReview, pendingReview);
    const run = await f.workspace.enqueue(f.task.id, 'Next revision.', 'next', false);
    gate.resolve();
    await rejected;
    await tick();
    assert.equal(f.store.task(f.task.id).status, 'uncertain');
    assert.deepEqual(f.store.task(f.task.id).pendingReview, pendingReview);
    assert.equal(f.store.runByKey(run.requestKey)?.status, 'queued');
    assert.equal(f.codex.calls.length, 0);
    await assert.rejects(f.workspace.enqueue(f.task.id, 'Another revision.', 'later', false));
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => {}));
    assert.throws(() => f.workspace.publish(f.task.id));
    assert.equal(await f.workspace.reviewWrite(f.task.id, false, async () => 'comment saved'), 'comment saved');
  } finally { gate.resolve(); f.close(); }
});

test('restart recovery preserves the exact pending review and prevents a persisted queue from starting', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-review-recovery-'));
  const file = path.join(folder, 'state.sqlite');
  const f = fixture(undefined, { file });
  let restarted: Store | undefined;
  let workspace: Workspace | undefined;
  try {
    const queued = await f.workspace.enqueue(f.task.id, 'Waiting revision.', 'queued', false);
    f.store.updateTask(f.task.id, { pendingReview });
    f.close();
    restarted = new Store(file);
    restarted.recover();
    const codex = new FakeCodex();
    codex.ready = true;
    workspace = new Workspace(restarted, codex as unknown as Codex);
    workspace.runtime.authenticated = true;
    await (workspace as any).drain();
    assert.equal(restarted.task(f.task.id).status, 'uncertain');
    assert.deepEqual(restarted.task(f.task.id).pendingReview, pendingReview);
    assert.equal(restarted.runByKey(queued.requestKey)?.status, 'queued');
    assert.equal(codex.calls.length, 0);
    await assert.rejects(workspace.reviewWrite(f.task.id, true, async () => {}));
    assert.throws(() => workspace!.publish(f.task.id));
  } finally { workspace?.close(); restarted?.close(); fs.rmSync(folder, { recursive: true, force: true }); }
});

test('checking a lost review response replays its original identity exactly once and resumes queued work', async () => {
  const applied = new Set<string>();
  let mutations = 0;
  const server = await reviewServer((request, response, body) => {
    const fresh = !applied.has(body.id);
    if (fresh) { applied.add(body.id); mutations++; request.socket.destroy(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(pageState));
  });
  const f = fixture(undefined, { reviewUrl: server.url });
  try {
    const writing = f.workspace.reviewWrite(f.task.id, true, async () => {
      const response = await fetch(server.url + pendingReview.route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Review-Token': 'test' }, body: JSON.stringify(pendingReview.body) });
      return response.json();
    }, pendingReview);
    const rejected = assert.rejects(writing);
    await f.workspace.enqueue(f.task.id, 'Waiting revision.', 'queued', false);
    await rejected;
    assert.equal(f.store.task(f.task.id).status, 'uncertain');
    const task = await f.workspace.reconcile(f.task.id);
    assert.equal(task.pendingReview, null);
    assert.equal(task.status, 'queued');
    assert.equal(mutations, 1);
    assert.deepEqual(server.calls.map(call => ({ route: call.route, body: call.body, token: call.token })), Array(2).fill({ route: pendingReview.route, body: pendingReview.body, token: 'test' }));
    f.codex.ready = true;
    await (f.workspace as any).drain();
    await tick();
    assert.equal(f.store.task(f.task.id).status, 'running');
    assert.equal(f.codex.calls.filter(call => call.method === 'turn/start').length, 1);
  } finally { f.close(); await server.close(); }
});

test('every queued task starts at once, with no limit on how many run together', async () => {
  const f = fixture();
  try {
    const ids = [f.task.id];
    for (let i = 1; i < 5; i++) {
      const task = { ...f.task, id: `task-${i}`, name: `p-task-${i}`, threadId: `thread-${i}` };
      f.store.saveTask(task);
      (f.workspace as any).loaded.add(task.threadId);
      ids.push(task.id);
    }
    for (const id of ids) await f.workspace.enqueue(id, 'Revise this section.', `request-${id}`, false);
    f.codex.ready = true;
    await (f.workspace as any).drain();
    await tick();
    assert.deepEqual(ids.map(id => f.store.task(id).status), Array(5).fill('running'));
    assert.equal(f.codex.calls.filter(call => call.method === 'turn/start').length, 5);
  } finally { f.close(); }
});

test('concurrent review status checks cannot replay the decision twice', async () => {
  const received = deferred<void>(), release = deferred<void>();
  const server = await reviewServer(async (_request, response) => {
    received.resolve();
    await release.promise;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(pageState));
  });
  const f = fixture(undefined, { reviewUrl: server.url });
  try {
    f.store.updateTask(f.task.id, { status: 'uncertain', pendingReview });
    const checking = f.workspace.reconcile(f.task.id);
    await received.promise;
    await assert.rejects(f.workspace.reconcile(f.task.id), /still being checked/);
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => {}));
    release.resolve();
    await checking;
    assert.equal(server.calls.length, 1);
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
  } finally { release.resolve(); f.close(); await server.close(); }
});

test('an already-applied undo is checked using the same action ID without undoing another action', async () => {
  const pendingUndo: PendingReview = { route: '/api/tasks/p-task/undo', body: { id: 'already-undone-action' }, previousStatus: 'interrupted' };
  let otherUndone = false;
  const server = await reviewServer((_request, response, body) => {
    if (body.id === 'other-action') otherUndone = true;
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Nothing to undo here any more. Reload the page.' }));
  });
  const f = fixture(undefined, { reviewUrl: server.url });
  try {
    f.store.updateTask(f.task.id, { status: 'uncertain', pendingReview: pendingUndo });
    const task = await f.workspace.reconcile(f.task.id);
    assert.deepEqual(server.calls[0].body, pendingUndo.body);
    assert.equal(otherUndone, false);
    assert.equal(task.status, 'interrupted');
    assert.equal(task.pendingReview, null);
    assert.match(task.error!, /Nothing to undo/);
    assert.equal(await f.workspace.reviewWrite(f.task.id, true, async () => 'allowed'), 'allowed');
  } finally { f.close(); await server.close(); }
});

test('review status checks retain uncertainty for transport, authentication, and malformed responses', async t => {
  const cases = [
    { name: 'disconnected transport', status: 0, body: '' },
    { name: 'unauthenticated response', status: 401, body: JSON.stringify({ error: 'Sign in.' }) },
    { name: 'forbidden response', status: 403, body: JSON.stringify({ error: 'Expired token.' }) },
    { name: 'server failure', status: 500, body: JSON.stringify({ error: 'Internal error.' }) },
    { name: 'invalid JSON', status: 200, body: '<html>Unavailable</html>' },
    { name: 'unrecognized success', status: 200, body: '{}' },
    { name: 'wrong task success', status: 200, body: JSON.stringify({ ...pageState, task: 'another-task' }) },
    { name: 'unrecognized business error', status: 400, body: JSON.stringify({ message: 'Unavailable.' }) },
  ];
  for (const entry of cases) await t.test(entry.name, async () => {
    const server = await reviewServer((request, response) => {
      if (!entry.status) { request.socket.destroy(); return; }
      response.writeHead(entry.status, { 'Content-Type': 'application/json' });
      response.end(entry.body);
    });
    const f = fixture(undefined, { reviewUrl: server.url });
    try {
      f.store.updateTask(f.task.id, { status: 'uncertain', pendingReview });
      await assert.rejects(f.workspace.reconcile(f.task.id));
      assert.equal(f.store.task(f.task.id).status, 'uncertain');
      assert.deepEqual(f.store.task(f.task.id).pendingReview, pendingReview);
      await assert.rejects(f.workspace.enqueue(f.task.id, 'Do not start yet.', 'next', false));
      await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => {}));
      assert.throws(() => f.workspace.publish(f.task.id));
    } finally { f.close(); await server.close(); }
  });
});

const finishResponse = { task: 'p-task', finished: true, changed_files: [], discarded: {} };
const deletionReview = async (_method: string, route: string) => route.endsWith('/state') ? pageState : finishResponse;

test('deletion rejects active, queued, building, uncertain, and reserved tasks without engine writes', async t => {
  for (const status of ['running', 'waiting_input', 'queued', 'building', 'uncertain'] as const) await t.test(status, async () => {
    const f = fixture(deletionReview);
    try {
      f.store.updateTask(f.task.id, { status });
      await assert.rejects(f.workspace.deleteTask(f.task.id), /Pause the task/);
      assert.equal(f.store.task(f.task.id).status, status);
      assert.equal(f.calls.length, 0);
    } finally { f.close(); }
  });
  for (const reservation of ['active', 'publishing', 'reviewWrites', 'pendingReview', 'queued-run', 'preparing']) await t.test(reservation, async () => {
    const f = fixture(deletionReview);
    try {
      if (reservation === 'active') (f.workspace as any).active.set(f.task.id, { id: 'run' });
      else if (reservation === 'pendingReview') f.store.updateTask(f.task.id, { pendingReview });
      else if (reservation === 'queued-run') {
        await f.workspace.enqueue(f.task.id, 'Queued instruction.', 'queued', false);
        f.store.updateTask(f.task.id, { status: 'reviewing' });
      } else if (reservation === 'preparing') (f.workspace as any).preparing.set(f.task.id, new Promise(() => {}));
      else (f.workspace as any)[reservation].add(f.task.id);
      await assert.rejects(f.workspace.deleteTask(f.task.id));
      assert.equal(f.calls.length, 0);
    } finally { f.close(); }
  });
});

test('deletion waits for every pending comment and then removes only the selected task', async () => {
  const first = deferred<void>(), second = deferred<void>();
  const f = fixture(deletionReview);
  try {
    const other: Task = { ...f.task, id: 'other-task', name: 'p-other', threadId: 'other-thread' };
    f.store.saveTask(other);
    const run: Run = { id: 'old-run', taskId: f.task.id, requestKey: 'old-request', prompt: 'Earlier work.', status: 'completed', createdAt: 1, finishedAt: 2 };
    f.store.saveRun(run);
    f.store.saveRun({ ...run, id: 'other-run', taskId: other.id, requestKey: 'other-request' });
    f.store.saveItem({ id: 'old-item', taskId: f.task.id, type: 'assistant', text: 'Earlier answer.', createdAt: 1 });
    f.store.saveItem({ id: 'other-item', taskId: other.id, type: 'assistant', text: 'Keep this answer.', createdAt: 1 });
    (f.workspace as any).liveItems.set('late-item', { id: 'late-item', taskId: f.task.id, type: 'assistant', text: 'A late delta.', createdAt: 2 });
    const a = f.workspace.reviewWrite(f.task.id, false, () => first.promise);
    const b = f.workspace.reviewWrite(f.task.id, false, () => second.promise);
    await assert.rejects(f.workspace.deleteTask(f.task.id));
    first.resolve(); await a;
    await assert.rejects(f.workspace.deleteTask(f.task.id));
    second.resolve(); await b;
    assert.deepEqual(await f.workspace.deleteTask(f.task.id), { ok: true });
    (f.workspace as any).flush();
    assert.deepEqual(f.store.tasks().map(task => task.id), [other.id]);
    assert.deepEqual(f.store.runs().map(run => run.id), ['other-run']);
    assert.deepEqual(f.store.items(f.task.id), []);
    assert.equal(f.store.items(other.id)[0].text, 'Keep this answer.');
    assert.equal(f.store.projects().length, 1);
    assert.equal(f.store.taskDeleted(f.task.id), true);
    assert.deepEqual(f.calls.filter(call => call.method === 'POST'), [{ method: 'POST', route: '/api/tasks/p-task/finish', body: { force: true } }]);
    const callCount = f.calls.length;
    assert.deepEqual(await f.workspace.deleteTask(f.task.id), { ok: true });
    assert.equal(f.calls.length, callCount);
  } finally { first.resolve(); second.resolve(); f.close(); }
});

test('in-flight deletion blocks all task mutations and a duplicate deletion request', async () => {
  const gate = deferred<typeof finishResponse>();
  const f = fixture(async (_method, route) => route.endsWith('/state') ? pageState : gate.promise);
  try {
    const deleting = f.workspace.deleteTask(f.task.id);
    assert.equal(f.store.task(f.task.id).status, 'deleting');
    await assert.rejects(f.workspace.enqueue(f.task.id, 'Not allowed.', 'new', false));
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => {}));
    await assert.rejects(f.workspace.reviewWrite(f.task.id, false, async () => {}));
    await assert.rejects(f.workspace.interrupt(f.task.id));
    await assert.rejects(f.workspace.reconcile(f.task.id));
    assert.throws(() => f.workspace.publish(f.task.id));
    await assert.rejects(f.workspace.deleteTask(f.task.id), /already in progress/);
    await (f.workspace as any).notification({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'old-turn', itemId: 'late', delta: 'Ignore this stale output.' } });
    gate.resolve(finishResponse);
    await deleting;
    (f.workspace as any).flush();
    assert.equal(f.store.tasks().length, 0);
    assert.equal(f.store.items(f.task.id).length, 0);
  } finally { gate.resolve(finishResponse); f.close(); }
});

test('feedback that finishes after deletion cannot recreate runs or history', async () => {
  const gate = deferred<typeof feedback>();
  const f = fixture(async (method, route) => route.includes('/feedback') ? gate.promise : deletionReview(method, route));
  try {
    const queued = f.workspace.enqueue(f.task.id, 'Delayed instructions.', 'delayed');
    const rejected = assert.rejects(queued, /Task not found/);
    await tick();
    await f.workspace.deleteTask(f.task.id);
    gate.resolve(feedback);
    await rejected;
    assert.equal(f.store.tasks().length, 0);
    assert.equal(f.store.runs().length, 0);
    assert.equal(f.store.items(f.task.id).length, 0);
  } finally { gate.resolve(feedback); f.close(); }
});

test('lost finish responses stay reserved across restart and retry confirms closed identity', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-delete-recovery-'));
  const file = path.join(folder, 'state.sqlite');
  let closed = false, finishCalls = 0;
  const f = fixture(async (_method, route) => {
    if (route.endsWith('/state')) return { ...pageState, closed };
    finishCalls++; closed = true;
    throw new Error('The finish response was lost.');
  }, { file });
  let reopened: Store | undefined, workspace: Workspace | undefined;
  try {
    await assert.rejects(f.workspace.deleteTask(f.task.id), /lost/);
    assert.equal(f.store.task(f.task.id).status, 'deleting');
    f.close();
    reopened = new Store(file); reopened.recover();
    assert.equal(reopened.task(f.task.id).status, 'deleting');
    assert.match(reopened.task(f.task.id).error!, /restarted during deletion/);
    const review: ReviewClient = { url: 'http://unused', token: 'test', get: async <T>() => ({ ...pageState, closed }) as T, post: async () => { finishCalls++; throw new Error('A closed task must not be finished again.'); } };
    workspace = new Workspace(reopened, new FakeCodex() as unknown as Codex, async () => review);
    await assert.rejects(workspace.enqueue(f.task.id, 'Do not resume.', 'next', false));
    await workspace.deleteTask(f.task.id);
    assert.equal(reopened.tasks().length, 0);
    assert.equal(finishCalls, 1);
    assert.equal(reopened.taskDeleted(f.task.id), true);
  } finally { workspace?.close(); reopened?.close(); fs.rmSync(folder, { recursive: true, force: true }); }
});

test('unconfirmed deletion never treats a malformed or foreign engine response as completion', async t => {
  for (const entry of [
    { name: 'missing state identity', state: { closed: true } },
    { name: 'foreign closed state', state: { ...pageState, task: 'another-task', closed: true } },
    { name: 'invalid closed flag', state: { ...pageState, closed: 'true' } },
    { name: 'missing finish identity', state: pageState, finish: { finished: true } },
    { name: 'foreign finish identity', state: pageState, finish: { task: 'another-task', finished: true } },
    { name: 'explicit engine refusal', state: pageState, error: new Error('A round is still being built.') },
  ]) await t.test(entry.name, async () => {
    const f = fixture(async (_method, route) => {
      if (route.endsWith('/state')) return entry.state;
      if (entry.error) throw entry.error;
      return entry.finish;
    });
    try {
      await assert.rejects(f.workspace.deleteTask(f.task.id));
      assert.equal(f.store.task(f.task.id).status, 'deleting');
      assert.equal(f.store.taskDeleted(f.task.id), false);
      await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => {}));
    } finally { f.close(); }
  });
});

test('deleted task IDs cannot be recreated by a delayed create retry', async () => {
  const f = fixture(deletionReview);
  try {
    const id = 'deleted-task-000001';
    f.store.saveTask({ ...f.task, id });
    await f.workspace.deleteTask(id);
    const count = f.calls.length;
    await assert.rejects(f.workspace.createTask({ id, projectId: f.task.projectId, title: 'Stale create request', instructions: 'Do not recreate.' }), /was deleted/);
    assert.equal(f.calls.length, count);
    assert.deepEqual(f.store.tasks().map(task => task.id), [f.task.id]);
  } finally { f.close(); }
});

test('real engine deletion removes one temporary worktree while preserving accepted text and another task', async () => {
  const { Fixture, METHOD, fakeRound } = await import(new URL('../engine/tests/ts/helpers.ts', import.meta.url).href);
  const { createServer: createReviewServer } = await import(new URL('../engine/src/server.ts', import.meta.url).href);
  const disk = new Fixture();
  const app = disk.app();
  const engine = createReviewServer(app);
  let f: ReturnType<typeof fixture> | undefined;
  try {
    const target = app.tasks.create('p-task', 'Remove this task', [], ['paper']);
    const other = app.tasks.create('p-other', 'Keep this task', [], ['paper']);
    disk.edit(target, METHOD, 'Method sentence 2.', 'Accepted manuscript sentence.');
    disk.edit(target, METHOD, 'Detail sentence 15.', 'Unaccepted draft sentence.');
    const round = fakeRound(app, target.name);
    await app.review.decide(target.name, { id: 'accept-before-delete', action: 'accept', round: round.number, changes: [round.units[0].id] });
    const manuscript = disk.read(METHOD);
    assert.match(manuscript, /Accepted manuscript sentence/);
    assert.doesNotMatch(manuscript, /Unaccepted draft sentence/);
    const head = app.repo.rev('HEAD');
    const index = fs.readFileSync(path.join(disk.root, '.git/index'));
    const artifacts = path.join(app.state, 'rounds', target.name, '001');
    fs.mkdirSync(artifacts, { recursive: true }); fs.writeFileSync(path.join(artifacts, 'fixture.svg'), '<svg/>');
    app.url = await engine.listen({ port: 0, host: '127.0.0.1' });
    f = fixture(async (method, route, body) => {
      const response = await fetch(app.url + route, { method, headers: { 'Content-Type': 'application/json', 'X-Review-Token': app.csrf }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error);
      return value;
    });
    f.store.saveProject({ id: f.task.projectId, name: 'Temporary paper', path: disk.root, createdAt: 1 });
    f.store.updateTask(f.task.id, { worktree: target.worktree });
    await f.workspace.deleteTask(f.task.id);
    assert.equal(fs.existsSync(target.worktree), false);
    assert.equal(fs.existsSync(artifacts), false);
    assert.equal(fs.existsSync(other.worktree), true);
    assert.equal(app.tasks.get(other.name).closed, null);
    assert.equal(app.repo.text(['for-each-ref', `refs/latex-review/${target.name}/`]), '');
    assert.notEqual(app.repo.text(['for-each-ref', `refs/latex-review/${other.name}/`]), '');
    assert.equal(disk.read(METHOD), manuscript);
    assert.equal(app.repo.rev('HEAD'), head);
    assert.deepEqual(fs.readFileSync(path.join(disk.root, '.git/index')), index);
    const closedState = await fetch(app.url + '/api/tasks/p-task/state').then(response => response.json());
    assert.equal(closedState.task, target.name);
    assert.equal(closedState.closed, true);
    assert.equal(f.store.tasks().length, 0);
  } finally { f?.close(); await engine.close(); await disk.close(); }
});

test('Codex models list their reasoning efforts, and a task runs every turn at its effort', async () => {
  assert.deepEqual(agentModel({ model: 'gpt-x', displayName: 'GPT X', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }, { reasoningEffort: 'xhigh', description: 'Deep' }, { description: 'malformed' }] }),
    { id: 'gpt-x', name: 'GPT X', isDefault: true, efforts: ['low', 'xhigh'], defaultEffort: 'medium' });
  assert.deepEqual(agentModel({ id: 'plain' }), { id: 'plain', name: 'plain', isDefault: false, efforts: [], defaultEffort: null });
  const f = fixture();
  try {
    f.codex.ready = true;
    f.store.updateTask(f.task.id, { effort: 'xhigh' });
    await f.workspace.enqueue(f.task.id, 'Next revision.', 'next', false);
    await tick();
    const turn = f.codex.calls.find(call => call.method === 'turn/start');
    assert.equal(turn?.params.effort, 'xhigh');
  } finally { f.close(); }
  const plain = fixture();
  try {
    plain.codex.ready = true;
    await plain.workspace.enqueue(plain.task.id, 'Next revision.', 'next', false);
    await tick();
    assert.equal('effort' in plain.codex.calls.find(call => call.method === 'turn/start')!.params, false);
  } finally { plain.close(); }
});

test('account usage keeps the limit windows, plan and credits Codex reports', () => {
  const window = { usedPercent: 83, windowDurationMins: 10080, resetsAt: 1_793_600_296 };
  assert.deepEqual(accountUsage({ ordinaryUsageAllowed: true, rateLimits: { planType: 'pro', primary: window, secondary: null, credits: { hasCredits: true, unlimited: false, balance: '12418.76' }, rateLimitReachedType: null } }),
    { plan: 'pro', windows: [{ usedPercent: 83, minutes: 10080, resetsAt: 1_793_600_296_000 }], credits: { unlimited: false, balance: 12418.76 }, reached: false });
  assert.equal(accountUsage({ ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 140, windowDurationMins: 300, resetsAt: null } } })!.reached, true);
  assert.equal(accountUsage({ ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 140, windowDurationMins: 300, resetsAt: null } } })!.windows[0].usedPercent, 100);
  assert.equal(accountUsage({ rateLimits: { primary: null, secondary: null, credits: { hasCredits: false, unlimited: false, balance: null } } }), null);
  assert.equal(accountUsage(undefined), null);
});

test('Fast mode uses the catalog tier and preserves older catalogs without inventing support', () => {
  assert.deepEqual(agentModel({ id: 'fast', serviceTiers: [{ id: 'priority', name: 'Fast', description: '2x speed' }] }).fastMode, { serviceTier: 'priority', description: '2x speed' });
  assert.deepEqual(agentModel({ id: 'older', additionalSpeedTiers: ['fast'] }).fastMode, { serviceTier: 'priority', description: '' });
  assert.equal(agentModel({ id: 'standard', serviceTiers: [], additionalSpeedTiers: ['fast'] }).fastMode, undefined);
  assert.equal(agentModel({ id: 'plain' }).fastMode, undefined);
});

test('tasks persist the chosen service tier, and reject unsupported Fast mode before creating a worktree', async () => {
  const f = fixture(async (_method, route) => route === '/api/tasks' ? { worktree: '/unused' } : summary);
  try {
    f.workspace.runtime.models = [agentModel({ id: 'model', isDefault: true, serviceTiers: [{ id: 'priority', name: 'Fast' }] })];
    const input = { id: 'fast-task-test-01', projectId: 'paper', title: 'Revise', instructions: 'Revise.', serviceTier: 'priority' };
    const created = await f.workspace.createTask(input);
    assert.equal(f.store.task(created.id).serviceTier, 'priority');
    const retry = await f.workspace.createTask({ ...input, serviceTier: 'default' });
    assert.equal(retry.serviceTier, 'priority', 'a retry cannot change an existing task');
    const before = f.calls.length;
    await assert.rejects(f.workspace.createTask({ ...input, id: 'fast-task-test-02', model: 'unsupported' }), /Fast mode is not available/);
    await assert.rejects(f.workspace.createTask({ ...input, id: 'fast-task-test-03', agent: 'claude' }), /only available for Codex/);
    await assert.rejects(f.workspace.createTask({ ...input, id: 'fast-task-test-04', serviceTier: 'unknown' }), /Fast mode is not available/);
    assert.equal(f.calls.length, before);
    const standard = await f.workspace.createTask({ ...input, id: 'fast-task-test-05', serviceTier: 'default' });
    assert.equal(standard.serviceTier, 'default');
  } finally { f.close(); }
});

test('Codex receives the saved Fast or explicit standard tier without changing reasoning', async () => {
  for (const serviceTier of ['priority', 'default', undefined]) {
    const f = fixture();
    try {
      f.codex.ready = true;
      f.store.updateTask(f.task.id, { effort: 'xhigh', serviceTier });
      await f.workspace.enqueue(f.task.id, 'Next revision.', 'next', false);
      await tick();
      const turn = f.codex.calls.find(call => call.method === 'turn/start')!;
      assert.equal(turn.params.effort, 'xhigh');
      assert.equal(turn.params.serviceTier, serviceTier);
      if (serviceTier === undefined) assert.equal('serviceTier' in turn.params, false, 'older tasks retain their host configuration');
    } finally { f.close(); }
  }
});

test('a question without an "Other" choice only accepts one of its options', async () => {
  const claude = new FakeCodex();
  const f = fixture(undefined, { claude });
  try {
    f.codex.ready = true; claude.ready = true;
    f.workspace.runtimes.claude.authenticated = true;
    f.store.updateTask(f.task.id, { agent: 'claude', threadId: 'claude-thread' });
    (f.workspace as any).loaded.add('claude-thread');
    await f.workspace.enqueue(f.task.id, 'Tighten the abstract.', 'choice-run', false);
    await tick();
    claude.emit('request', { id: 'choice-1', method: 'item/tool/requestUserInput', params: { threadId: 'claude-thread', turnId: 'turn-new', questions: [{ id: 'choice', question: 'Which section?', isOther: false, options: [{ label: 'Introduction' }, { label: 'Model' }] }] } });
    const [request] = f.workspace.snapshot().requests;
    assert.throws(() => f.workspace.answer(request.id, { answers: { choice: 'Both, model first' } }), /Choose one of the offered answers/);
    assert.deepEqual(claude.replies, []);
    assert.equal(f.workspace.snapshot().requests.length, 1);
    f.workspace.answer(request.id, { answers: { choice: 'Model' } });
    assert.deepEqual(claude.replies, [{ id: 'choice-1', result: { answers: { choice: { answers: ['Model'] } } } }]);
  } finally { f.close(); }
});

test('a task runs on its own agent: turns, approvals and pausing go to that agent only', async () => {
  const claude = new FakeCodex();
  const f = fixture(undefined, { claude });
  try {
    f.codex.ready = true; claude.ready = true;
    f.workspace.runtimes.claude.authenticated = true;
    f.store.updateTask(f.task.id, { agent: 'claude', threadId: 'claude-thread' });
    (f.workspace as any).loaded.add('claude-thread');
    await f.workspace.enqueue(f.task.id, 'Tighten the abstract.', 'claude-run', false);
    await tick();
    assert.equal(f.codex.calls.length, 0);
    assert.deepEqual(claude.calls.map(call => call.method), ['turn/start']);
    assert.equal(claude.calls[0].params.threadId, 'claude-thread');
    // An approval from Claude is answered through Claude, never Codex.
    claude.emit('request', { id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'claude-thread', turnId: 'turn-new', command: 'make' } });
    const [request] = f.workspace.snapshot().requests;
    assert.equal(request.taskId, f.task.id);
    f.workspace.answer(request.id, { decision: 'accept' });
    assert.deepEqual(claude.replies, [{ id: 'approval-1', result: { decision: 'accept' } }]);
    assert.deepEqual(f.codex.replies, []);
    // A request for this task that arrives from another agent is refused.
    f.codex.emit('request', { id: 'stray', method: 'item/commandExecution/requestApproval', params: { threadId: 'claude-thread', turnId: 'turn-new' } });
    assert.deepEqual(f.codex.rejections.map(r => r.id), ['stray']);
    await f.workspace.interrupt(f.task.id);
    assert.deepEqual(claude.calls.at(-1), { method: 'turn/interrupt', params: { threadId: 'claude-thread', turnId: 'turn-new' } });
    // Claude's turn completion is handled like Codex's.
    claude.emit('notification', { method: 'turn/completed', params: { threadId: 'claude-thread', turn: { id: 'turn-new', status: 'interrupted' } } });
    await tick();
    assert.equal(f.store.task(f.task.id).status, 'interrupted');
  } finally { f.close(); }
});

test('Antigravity instructions defer to its current native permission policy', () => {
  const f = fixture();
  try {
    const codex = (f.workspace as any).instructions(f.task) as string;
    const antigravity = (f.workspace as any).instructions({ ...f.task, agent: 'antigravity' }) as string;
    assert.match(codex, /You may run tools in the task worktree/);
    assert.match(antigravity, /^You are Antigravity running inside Papilot/);
    assert.match(antigravity, /Shell commands follow the current native permission policy/);
    assert.doesNotMatch(antigravity, /You may run tools/);
  } finally { f.close(); }
});

test('a skill runs as its instructions while the chat keeps the author\'s words', async () => {
  const f = fixture();
  try {
    const run = await f.workspace.enqueue(f.task.id, 'Only the abstract.', 'skill-run', false, { skill: findSkill('/unused', 'proofread') });
    assert.match(run.prompt, /^Use the "Proofread" skill below/);
    assert.match(run.prompt, /<skill name="Proofread">[\s\S]*typos[\s\S]*<\/skill>\n\nRequest: Only the abstract\.$/);
    const item = f.store.items(f.task.id).find(entry => entry.id === run.id)!;
    assert.equal(item.text, 'Only the abstract.');
    assert.deepEqual(item.meta, { skill: { id: 'proofread', name: 'Proofread' } });
  } finally { f.close(); }
});

test('a sent skill keeps its chosen icon in the stored conversation', async () => {
  const f = fixture();
  try {
    const skill = { ...findSkill('/unused', 'proofread'), icon: 'book' as const };
    const run = await f.workspace.enqueue(f.task.id, 'Only the abstract.', 'skill-icon-run', false, { skill });
    const item = f.store.items(f.task.id).find(entry => entry.id === run.id)!;
    assert.deepEqual(item.meta?.skill, { id: 'proofread', name: 'Proofread', icon: 'book' });
    assert.doesNotMatch(run.prompt, /icon: book/);
  } finally { f.close(); }
});

test('a failed preparation keeps its notes for Retry, and concurrent submissions cannot send the same note twice', async () => {
  const gate = deferred<void>();
  let fail = true;
  const f = fixture(async () => { await gate.promise; if (fail) throw new Error('Review service unavailable'); return { worktree: '/unused/notes-task' }; });
  try {
    const note = { id: 'draft-note', projectId: f.task.projectId, key: 'pdf', page: 0, rect: [0, 0, 1, 1] as [number, number, number, number], quote: 'A sentence.', comment: 'Clarify.', source: null, createdAt: 1 };
    f.store.saveAnnotation(note);
    const input = { id: 'notes-retry-task-01', projectId: f.task.projectId, title: 'Clarify', instructions: '', annotations: [note.id] };
    assert.equal((await f.workspace.createTask(input)).status, 'preparing');
    assert.equal(f.store.annotation(note.projectId, note.id).taskId, input.id, 'the note is claimed when the task is saved');
    await assert.rejects(f.workspace.createTask({ ...input, id: 'notes-other-task-01' }), /already being sent/);
    const failing = preparation(f, input.id);
    gate.resolve();
    await assert.rejects(failing, /Review service unavailable/);
    assert.equal(f.store.task(input.id).status, 'failed');
    assert.equal(f.store.task(input.id).error, 'Review service unavailable');
    assert.equal(f.store.annotation(note.projectId, note.id).taskId, input.id, 'Retry sends the same note');
    await assert.rejects(f.workspace.createTask({ ...input, id: 'notes-other-task-01' }), /no longer available/);
    fail = false;
    assert.equal((await f.workspace.createTask(input)).status, 'preparing', 'a retried request prepares the task again');
    const created = await preparation(f, input.id);
    assert.equal(created.status, 'queued');
    assert.equal(created.worktree, '/unused/notes-task');
    assert.equal(f.store.items(input.id).length, 1);
    assert.equal(f.store.runs().filter(run => run.taskId === input.id).length, 1);
    assert.equal((await f.workspace.createTask(input)).id, input.id);
    await assert.rejects(f.workspace.createTask({ ...input, id: 'notes-other-task-01' }), /no longer available/);
  } finally { f.close(); }
});

test('sent review feedback shows as decisions and comments, not as the prompt', async () => {
  const f = fixture(async (_method, route) => route.includes('/feedback') ? { cursor: 9, feedback: [
    { id: 8, kind: 'accept', round: 2, changes: ['a', 'b'] },
    { id: 9, kind: 'comment', round: 2, text: 'Clarify the bound.', changes: [{ id: 'c', file: 'main.tex', lines: [4, 6], old: '', new: '' }] },
  ] } : summary);
  try {
    const run = await f.workspace.enqueue(f.task.id, '', 'feedback-run', true, { feedback: true });
    assert.ok(run.prompt.startsWith(reviewInstructions));
    assert.match(run.prompt, /Clarify the bound/);
    const item = f.store.items(f.task.id).find(entry => entry.id === run.id)!;
    assert.equal(item.text, '');
    assert.deepEqual(item.meta, { sendsFeedback: true, feedback: { round: 2, accepted: 2, rejected: 0, undone: 0, comments: [{ where: 'main.tex:4', text: 'Clarify the bound.' }] } });
    await f.workspace.interrupt(f.task.id);
    const typed = await f.workspace.enqueue(f.task.id, 'Also shorten it.', 'typed-run', false);
    assert.equal(f.store.items(f.task.id).find(entry => entry.id === typed.id)!.meta, undefined);
  } finally { f.close(); }
});

test('accepting puts a change in the manuscript without a commit, and the review knows the files it touched', async () => {
  const { Fixture, METHOD, fakeRound } = await import(new URL('../engine/tests/ts/helpers.ts', import.meta.url).href);
  const disk = new Fixture();
  const app = disk.app();
  const f = fixture();
  try {
    const target = app.tasks.create('p-task', 'Accept into the manuscript', [], ['paper']);
    disk.edit(target, METHOD, 'Method sentence 2.', 'Accepted manuscript sentence.');
    f.store.saveProject({ id: f.task.projectId, name: 'Temporary paper', path: disk.root, createdAt: 1 });
    assert.doesNotMatch((f.workspace as any).instructions(f.store.task(f.task.id)), /commit message/i);
    assert.deepEqual(await acceptedFiles(disk.root, target.name), []);
    const head = app.repo.text(['rev-parse', 'HEAD']);
    const round = fakeRound(app, target.name);
    await app.review.decide(target.name, { id: 'accept', action: 'accept', round: round.number, changes: [round.units[0].id] });
    assert.match(fs.readFileSync(path.join(disk.root, METHOD), 'utf8'), /Accepted manuscript sentence\./);
    assert.equal(app.repo.text(['rev-parse', 'HEAD']), head);
    await f.workspace.refresh(f.task.id);
    assert.deepEqual(f.store.task(f.task.id).review?.files, [METHOD]);
  } finally { f.close(); await disk.close(); }
});

test('feedback alone cannot be sent when there is none, so the chat never shows an empty card', async () => {
  const f = fixture(async (_method, route) => route.includes('/feedback') ? { cursor: 3, feedback: [] } : summary);
  try {
    await assert.rejects(f.workspace.enqueue(f.task.id, '', 'empty-feedback', true, { feedback: true }), /no new review feedback/);
    assert.equal(f.store.runs().length, 0);
  } finally { f.close(); }
});

test('a commit message goes to the small model each agent offers, when it offers one', () => {
  const model = (id: string, name = id) => ({ id, name, isDefault: false, efforts: [], defaultEffort: null });
  assert.equal(lightModel([model('gpt-6.1-sol'), model('gpt-6-luna'), model('gpt-5.6-luna')])?.id, 'gpt-6-luna');
  assert.equal(lightModel([model('opus', 'Opus 5.5'), model('sonnet', 'Sonnet 5.5'), model('haiku', 'Haiku 5.5')])?.id, 'haiku');
  assert.equal(lightModel([model('gemini-4-argon', 'Gemini 4 Argon'), model('gemini-3.8-flash', 'Gemini 3.8 Flash')])?.id, 'gemini-3.8-flash');
  assert.equal(lightModel([model('gemini-4-argon', 'Gemini 4 Argon'), model('custom', 'Custom')]), undefined);
});

test('an agent writes a commit message from the chosen changes, in a read-only turn it does not keep', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-message-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const f = fixture();
  try {
    git('init', '-q', '-b', 'main');
    for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@localhost'], ['commit.gpgsign', 'false']]) git('config', key, value);
    fs.writeFileSync(path.join(root, 'main.tex'), 'Original opening.\n'); fs.writeFileSync(path.join(root, 'notes.md'), 'Notes.\n');
    git('add', '.'); git('commit', '-qm', 'Draft the introduction');
    fs.writeFileSync(path.join(root, 'main.tex'), 'Tighter opening.\n'); fs.writeFileSync(path.join(root, 'notes.md'), 'Not chosen.\n');
    f.store.saveProject({ id: f.task.projectId, name: 'Paper', path: root, createdAt: 1 });
    f.store.updateTask(f.task.id, { title: 'Tighten the opening', review: { state: 'done', round: 1, counts: {}, files: ['main.tex'] } });
    f.codex.ready = true;
    f.workspace.runtimes.codex.models = [
      { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', isDefault: true, efforts: ['low', 'high'], defaultEffort: 'high' },
      { id: 'gpt-6-luna', name: 'GPT-6-Luna', isDefault: false, efforts: ['low', 'medium'], defaultEffort: 'medium' },
    ];
    const replies = ['```\nTighten the opening sentence.\n```', 'Shorten the opening sentence'];
    f.codex.handler = async method => {
      if (method === 'thread/start') return { thread: { id: 'commit-thread' } };
      const text = replies.shift();
      setImmediate(() => {
        f.codex.emit('notification', { method: 'item/completed', params: { threadId: 'commit-thread', turnId: 'commit-turn', item: { id: 'reply', type: 'agentMessage', text } } });
        f.codex.emit('notification', { method: 'turn/completed', params: { threadId: 'commit-thread', turn: { id: 'commit-turn', status: 'completed' } } });
      });
      return { turn: { id: 'commit-turn' } };
    };
    assert.deepEqual(await f.workspace.commitMessage(f.task.projectId, ['main.tex'], { agent: 'claude' }), { message: 'Tighten the opening sentence', agent: 'codex' });
    const start = f.codex.calls.find(call => call.method === 'thread/start')!.params, turn = f.codex.calls.find(call => call.method === 'turn/start')!.params;
    assert.deepEqual([start.sandbox, start.approvalPolicy, start.ephemeral, start.model, turn.effort], ['read-only', 'never', true, 'gpt-6-luna', 'low']);
    // The helper runs in an empty folder of its own, never the manuscript, and the folder is removed.
    assert.notEqual(start.cwd, root); assert.equal(turn.cwd, start.cwd);
    assert.match(path.basename(start.cwd), /^papilot-helper-/); assert.equal(fs.existsSync(start.cwd), false);
    const prompt: string = turn.input[0].text;
    for (const part of ['- Draft the introduction', '- Tighten the opening', 'M main.tex', '+Tighter opening.']) assert.ok(prompt.includes(part), part);
    assert.ok(!prompt.includes('notes.md'), 'files that were not chosen stay out');
    // The reply belongs to no task, so no chat shows it.
    assert.deepEqual(f.store.items(f.task.id), []);
    // The same changes get the same message at once, unless a fresh one is asked for.
    const turns = () => f.codex.calls.filter(call => call.method === 'turn/start').length;
    assert.deepEqual(await f.workspace.commitMessage(f.task.projectId, ['main.tex']), { message: 'Tighten the opening sentence', agent: 'codex' });
    assert.equal(turns(), 1);
    assert.deepEqual(await f.workspace.commitMessage(f.task.projectId, ['main.tex'], { fresh: true }), { message: 'Shorten the opening sentence', agent: 'codex' });
    assert.equal(turns(), 2);
    assert.equal((await f.workspace.commitMessage(f.task.projectId, ['main.tex'])).message, 'Shorten the opening sentence');
    // Once the author has decided every change, the review's message is written ahead.
    fs.writeFileSync(path.join(root, 'main.tex'), 'An even tighter opening.\n');
    replies.push('Tighten the opening again');
    f.store.updateTask(f.task.id, { status: 'reviewing', review: { state: 'done', round: 1, counts: { pending: 1 }, files: ['main.tex'] } });
    await f.workspace.prepareCommitMessage(f.task.id);
    assert.equal(turns(), 2, 'a review with undecided changes waits');
    f.store.updateTask(f.task.id, { review: { state: 'done', round: 1, counts: { accepted: 1 }, files: ['main.tex'] } });
    await f.workspace.prepareCommitMessage(f.task.id);
    assert.equal(turns(), 3);
    assert.equal((await f.workspace.commitMessage(f.task.projectId, ['main.tex'], { agent: 'codex' })).message, 'Tighten the opening again');
    assert.equal(turns(), 3);
    f.codex.ready = false;
    await assert.rejects(f.workspace.commitMessage(f.task.projectId, ['main.tex']), /Sign in to an agent, such as Codex/);
  } finally { f.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a build the agent broke goes back to it once, and its instructions name what the review covers', async () => {
  const jobs: Record<string, object> = {
    'job-1': { status: 'failed', error: 'Some edits are outside the task scope: docs/coverage.md', details: ['Allowed: main'], next: 'Undo edits outside the scope, then publish again.' },
    'job-2': { status: 'failed', error: 'Some edits are outside the task scope: docs/coverage.md', details: ['Allowed: main'] },
  };
  let published = 0;
  const f = fixture(async (_method, route) => {
    if (route.endsWith('/publish')) return { job: `job-${++published}` };
    if (route.startsWith('/api/jobs/')) return jobs[route.slice('/api/jobs/'.length)];
    if (route.includes('/feedback')) return feedback;
    return { ...summary, scope: { sections: [], files: ['main'] } };
  });
  try {
    f.store.updateTask(f.task.id, { threadId: null });
    f.codex.ready = true;
    await f.workspace.enqueue(f.task.id, 'Address the notes.', 'request', false);
    await tick(); await tick();
    const start = f.codex.calls.find(call => call.method === 'thread/start')!.params;
    assert.match(start.developerInstructions, /The review covers only main in this worktree, and an edit to any other file stops the PDF build/);
    const complete = () => (f.workspace as any).notification({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-new', status: 'completed' } } });
    await complete();
    const fix = f.store.runByKey('build-fix-job-1')!;
    assert.ok(fix, 'the build error is queued for the agent');
    assert.ok(fix.prompt.includes('Some edits are outside the task scope: docs/coverage.md\nAllowed: main'));
    // The chat shows the error rather than the prompt, and the task carries on.
    const item = f.store.items(f.task.id).find(entry => entry.id === fix.id)!;
    assert.equal(item.text, '');
    assert.deepEqual(item.meta?.build, { error: 'Some edits are outside the task scope: docs/coverage.md', details: ['Allowed: main'] });
    assert.equal(f.store.task(f.task.id).error, null);
    await tick(); await tick();
    assert.equal(f.store.runByKey('build-fix-job-1')?.status, 'running');
    // The same failure after the fix turn stops for the author instead of looping.
    await complete();
    assert.equal(f.store.runByKey('build-fix-job-2'), undefined);
    assert.equal(f.store.task(f.task.id).status, 'failed');
    assert.match(f.store.task(f.task.id).error || '', /outside the task scope/);
  } finally { f.close(); }
});

test('Codex threads get the view_pdf tool, which Papilot answers with typeset pages', async () => {
  const views: unknown[] = [];
  const f = fixture(async (_method, route, body) => {
    if (route.endsWith('/view')) { views.push(body); return { pages: [{ index: 3, label: '1', shows: ['main.tex:12'], file: '/paper/.git/latex-review/views/p-task/1/page-1-3.png' }, { index: 4, label: null, shows: ['main.tex:20'], file: '/paper/.git/latex-review/views/p-task/1/page-4-4.png' }], missing: ['Page 99: no page has this printed number.'], targets: ['chapters/intro'] }; }
    if (route.includes('/feedback')) return feedback;
    return summary;
  });
  try {
    f.store.updateTask(f.task.id, { threadId: null });
    f.codex.ready = true;
    await f.workspace.enqueue(f.task.id, 'Fix the runt on page 1.', 'request', false);
    await tick(); await tick();
    const start = f.codex.calls.find(call => call.method === 'thread/start')!.params;
    assert.deepEqual(start.dynamicTools.map((tool: any) => tool.name), ['view_pdf']);
    assert.match(start.developerInstructions, /use the view_pdf tool and open the pages it draws with your image viewer/);
    assert.equal(f.store.task(f.task.id).viewPdf, true);
    // Papilot answers the call itself: the author is not asked.
    const call = (id: number, tool: string, args: object) => (f.workspace as any).serverRequest({ id, method: 'item/tool/call', params: { threadId: 'thread', turnId: 'turn-new', callId: `call-${id}`, tool, arguments: args } });
    const pages = Array.from({ length: 10 }, (_, index) => String(index + 1));
    call(41, 'view_pdf', { locations: ['main.tex:12'], pages: [...pages, 7], accepted: 'yes' });
    for (let i = 0; i < 20 && !f.codex.replies.length; i++) await tick();
    assert.deepEqual(views, [{ locations: ['main.tex:12'], pages }]);
    const reply = f.codex.replies[0] as { id: number; result: { success: boolean; contentItems: any[] } };
    assert.equal(reply.id, 41);
    assert.equal(reply.result.success, true);
    // Only text comes back: the page files, which the agent opens with its image viewer.
    assert.deepEqual(reply.result.contentItems, [{ type: 'inputText', text: 'Your worktree was compiled (only chapters/intro, so page positions differ from the full PDF while printed page numbers match).\nPage 1 shows main.tex:12: /paper/.git/latex-review/views/p-task/1/page-1-3.png\nPDF page 4 (printed page number unavailable) shows main.tex:20: /paper/.git/latex-review/views/p-task/1/page-4-4.png\nPage 99: no page has this printed number.\nOpen the page files you need with your image viewer (view_image).' }]);
    assert.equal(f.workspace.requests.size, 0);
    assert.equal(f.store.task(f.task.id).status, 'running');
    call(42, 'other_tool', {});
    for (let i = 0; i < 20 && f.codex.replies.length < 2; i++) await tick();
    assert.deepEqual(f.codex.replies[1], { id: 42, result: { success: false, contentItems: [{ type: 'inputText', text: 'Papilot has no tool named other_tool.' }] } });
    // The chat shows what the agent looked at.
    await (f.workspace as any).notification({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn-new', item: { id: 'look', type: 'dynamicToolCall', tool: 'view_pdf', arguments: { locations: ['main.tex:12'], pages: ['99'] }, status: 'completed', success: true } } });
    const item = f.store.items(f.task.id).find(entry => entry.id === `${f.task.id}:turn-new:look`)!;
    assert.deepEqual([item.type, item.text, item.status], ['pdf', 'main.tex:12, p. 99', 'completed']);
  } finally { f.close(); }
});

test('PDF tool replies are discarded after disconnect, reconnect, turn completion or shutdown', async t => {
  for (const scenario of ['disconnect', 'reconnect', 'completed', 'closed']) await t.test(scenario, async () => {
    const gate = deferred<any>();
    const f = fixture(async (_method, route) => route.endsWith('/view') ? gate.promise : summary);
    try {
      f.codex.ready = true;
      await f.workspace.enqueue(f.task.id, 'Inspect the PDF.', 'request', false);
      await tick(); await tick();
      const run = (f.workspace as any).active.get(f.task.id);
      const turnId = f.store.task(f.task.id).turnId;
      (f.workspace as any).serverRequest({ id: 91, method: 'item/tool/call', params: { threadId: 'thread', turnId, tool: 'view_pdf', arguments: { pages: ['1'] } } });
      await tick();
      assert.ok(f.calls.some(call => call.route.endsWith('/view')));
      let replies = 0;
      f.codex.respond = () => { replies++; throw new Error('Codex disconnected'); };
      if (scenario === 'closed') f.workspace.close();
      else if (scenario === 'completed') (f.workspace as any).active.delete(f.task.id);
      else {
        f.codex.ready = false;
        f.codex.emit('disconnected', new Error('Agent exited'));
        assert.equal(f.store.task(f.task.id).status, 'interrupted');
        if (scenario === 'reconnect') {
          // Even recovery of the same run/turn cannot revive an old RPC id.
          f.codex.ready = true;
          (f.workspace as any).active.set(f.task.id, run);
          f.store.updateTask(f.task.id, { status: 'running', turnId });
        }
      }
      gate.resolve({ pages: [], missing: [], targets: ['full'] });
      await tick(); await tick();
      assert.equal(replies, 0);
    } finally { gate.resolve({ pages: [], missing: [], targets: ['full'] }); f.close(); }
  });
});

test('a failed PDF tool response is caught without trying to reply a second time', async t => {
  const f = fixture(async () => ({ pages: [], missing: [], targets: ['full'] }));
  t.mock.method(console, 'error', () => {});
  try {
    f.codex.ready = true;
    await f.workspace.enqueue(f.task.id, 'Inspect the PDF.', 'request', false);
    await tick(); await tick();
    let attempts = 0;
    f.codex.respond = () => { attempts++; throw new Error('Broken pipe'); };
    (f.workspace as any).serverRequest({ id: 92, method: 'item/tool/call', params: { threadId: 'thread', turnId: f.store.task(f.task.id).turnId, tool: 'view_pdf', arguments: { pages: ['1'] } } });
    await tick(); await tick();
    assert.equal(attempts, 1);
    assert.equal(f.store.task(f.task.id).status, 'running');
  } finally { f.close(); }
});

test('a Codex without the experimental tool API starts threads without view_pdf', async () => {
  const f = fixture();
  try {
    f.codex.handler = async (method, params) => {
      if (method === 'thread/start' && params.dynamicTools) throw new RpcResponseError('Invalid request: thread/start.dynamicTools requires experimentalApi capability');
      return method === 'turn/start' ? { turn: { id: 'turn-new' } } : { thread: { id: 'thread' } };
    };
    f.store.updateTask(f.task.id, { threadId: null });
    f.codex.ready = true;
    await f.workspace.enqueue(f.task.id, 'Tighten the abstract.', 'request', false);
    for (let i = 0; i < 10 && !f.codex.calls.some(call => call.method === 'turn/start'); i++) await tick();
    const starts = f.codex.calls.filter(call => call.method === 'thread/start').map(call => call.params);
    assert.equal(starts.length, 2);
    assert.equal(starts[1].dynamicTools, undefined);
    assert.doesNotMatch(starts[1].developerInstructions, /view_pdf/);
    assert.equal(f.store.task(f.task.id).viewPdf, false);
    assert.equal(f.store.task(f.task.id).status, 'running');
  } finally { f.close(); }
});

test('a build that fails for reasons outside the agent\'s edits is not sent back to it', async () => {
  const f = fixture(async (_method, route) => {
    if (route.endsWith('/publish')) return { job: 'job' };
    if (route.startsWith('/api/jobs/')) return { status: 'failed', error: 'The comparison baseline could not be compiled.', details: ['! Undefined control sequence.'] };
    if (route.includes('/feedback')) return feedback;
    return summary;
  });
  try {
    f.codex.ready = true;
    await f.workspace.enqueue(f.task.id, 'Address the notes.', 'request', false);
    await tick(); await tick();
    await (f.workspace as any).notification({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-new', status: 'completed' } } });
    assert.equal(f.store.runs().length, 1);
    assert.equal(f.store.task(f.task.id).status, 'failed');
    assert.equal(f.store.task(f.task.id).error, 'The comparison baseline could not be compiled.\n! Undefined control sequence.');
  } finally { f.close(); }
});

test('an agent resolves a merge in the manuscript checkout, and review writes wait for the merge', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-resolve-'));
  const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const remote = path.join(base, 'remote.git'), root = path.join(base, 'paper'), other = path.join(base, 'other');
  const clone = (target: string) => { run(base, 'clone', '-q', remote, target); for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@localhost'], ['commit.gpgsign', 'false']]) run(target, 'config', key, value); };
  const edit = (cwd: string, text: string, message: string) => { fs.writeFileSync(path.join(cwd, 'main.tex'), text); run(cwd, 'commit', '-qam', message); };
  const f = fixture();
  try {
    run(base, 'init', '-q', '--bare', '-b', 'main', remote); clone(root);
    fs.writeFileSync(path.join(root, 'main.tex'), 'Opening.\n'); run(root, 'add', '.'); run(root, 'commit', '-qm', 'Start'); run(root, 'push', '-q', '-u', 'origin', 'main');
    clone(other); edit(other, 'Their opening.\n', 'Reword the opening'); run(other, 'push', '-q');
    edit(root, 'My opening.\n', 'Rewrite the opening'); run(root, 'fetch', '-q');
    try { run(root, 'merge', '--no-edit', 'origin/main'); } catch { /* The conflict is the point. */ }
    f.store.saveProject({ id: f.task.projectId, name: 'Paper', path: root, createdAt: 1 });
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => undefined), /Finish or abort the merge/);
    f.codex.ready = true;
    f.workspace.runtimes.codex.models = [{ id: 'deep', name: 'Deep', isDefault: true, efforts: ['low', 'high'], defaultEffort: 'high' }];
    f.codex.handler = async method => {
      if (method === 'thread/start') return { thread: { id: 'merge-thread' } };
      fs.writeFileSync(path.join(root, 'main.tex'), 'My opening, as reworded.\n');
      setImmediate(() => {
        f.codex.emit('notification', { method: 'item/completed', params: { threadId: 'merge-thread', item: { id: 'reply', type: 'agentMessage', text: 'Kept your rewrite and their wording.' } } });
        f.codex.emit('notification', { method: 'turn/completed', params: { threadId: 'merge-thread', turn: { id: 'merge-turn', status: 'completed' } } });
      });
      return { turn: { id: 'merge-turn' } };
    };
    const result = await f.workspace.resolveConflicts(f.task.projectId);
    assert.deepEqual([result.summary, result.remaining, result.agent, result.git.merging?.conflicts], ['Kept your rewrite and their wording.', [], 'codex', []]);
    const start = f.codex.calls.find(call => call.method === 'thread/start')!.params, turn = f.codex.calls.find(call => call.method === 'turn/start')!.params;
    assert.deepEqual([start.cwd, start.sandbox, start.approvalPolicy, start.ephemeral, turn.effort], [root, 'workspace-write', 'never', true, 'high']);
    for (const part of ['- main.tex', '- Rewrite the opening', '- Reword the opening', 'origin/main']) assert.ok(turn.input[0].text.includes(part), part);
    await assert.rejects(f.workspace.resolveConflicts(f.task.projectId), /No file has conflict markers left/);
  } finally { f.close(); fs.rmSync(base, { recursive: true, force: true }); }
});

for (const mode of ['workspace', 'commit'] as const) test(`tasks save to the manuscript using ${mode} without task branches`, async () => {
  const { Fixture, METHOD, fakeRound } = await import(new URL('../engine/tests/ts/helpers.ts', import.meta.url).href);
  const disk = new Fixture(), app = disk.app();
  const f = fixture(async (method, route, body: any) => {
    if (route.includes('/feedback')) return app.review.feedback('p-task');
    if (method === 'POST' && route.endsWith('/apply')) return await app.delivery.apply('p-task', body.keepCurrent, body.mode, body.message);
    return app.taskInfo('p-task');
  });
  try {
    const target = app.tasks.create('p-task', 'Isolated revision', [], ['paper'], true);
    disk.edit(target, METHOD, 'Method sentence 2.', 'Accepted isolated text.');
    const round = fakeRound(app, target.name);
    await app.review.decide(target.name, { id: 'accept-isolated', action: 'accept', round: round.number, changes: round.units.map((unit: any) => unit.id) });
    f.store.saveProject({ id: f.task.projectId, name: 'Paper', path: disk.root, createdAt: 1 });
    await f.workspace.refresh(f.task.id);
    assert.equal(f.store.task(f.task.id).deferred, true);
    assert.deepEqual(f.store.task(f.task.id).review?.files, [METHOD]);
    f.store.updateTask(f.task.id, { status: 'running' });
    await assert.rejects(f.workspace.applyTask(f.task.id), /Wait for the task/);
    f.store.updateTask(f.task.id, { status: 'reviewing' });
    const gate = deferred<void>();
    const writing = f.workspace.reviewWrite(f.task.id, true, () => gate.promise);
    await assert.rejects(f.workspace.applyTask(f.task.id), /current review action/);
    gate.resolve(); await writing;
    const result = await f.workspace.applyTask(f.task.id, false, mode === 'commit' ? { message: 'Reviewed task' } : undefined);
    assert.equal(result.delivery?.mode, mode);
    assert.equal(f.store.task(f.task.id).delivery?.mode, mode);
    assert.deepEqual(f.store.task(f.task.id).review?.files, []);
    assert.match(disk.read(METHOD), /Accepted isolated text/);
    assert.equal(result.git.files.length, mode === 'commit' ? 0 : 1);
    assert.equal(disk.repo.text(['for-each-ref', '--format=%(refname)', 'refs/heads/papilot/']), '');
    assert.equal(f.codex.calls.length, 0);
    if (mode === 'commit') {
      assert.equal(disk.repo.rev('HEAD'), result.delivery?.commit);
      assert.equal((await f.workspace.commitTask(f.task.id, 'Retry')).commit, result.delivery?.commit);
    } else assert.deepEqual((await f.workspace.applyTask(f.task.id)).delivery, result.delivery);
  } finally { f.close(); await disk.close(); }
});

test('application conflicts automatically queue one AI suggestion and require review before saving', async () => {
  const { Fixture, METHOD, fakeRound } = await import(new URL('../engine/tests/ts/helpers.ts', import.meta.url).href);
  const disk = new Fixture(), app = disk.app();
  const f = fixture(async (method, route, body: any) => {
    if (route.includes('/feedback')) return app.review.feedback('p-task');
    if (method === 'POST' && route.endsWith('/apply')) return await app.delivery.apply('p-task', body.keepCurrent, body.mode, body.message);
    return app.taskInfo('p-task');
  });
  try {
    const target = app.tasks.create('p-task', 'Conflicting revision', [], ['paper'], true);
    disk.edit(target, METHOD, 'Method sentence 2.', 'Accepted proposal.');
    const round = fakeRound(app, target.name);
    await app.review.decide(target.name, { id: 'accept-before-conflict', action: 'accept', round: round.number, changes: round.units.map((unit: any) => unit.id) });
    disk.write(METHOD, disk.read(METHOD).replace('Method sentence 2.', 'Latest manuscript.'));
    f.store.saveProject({ id: f.task.projectId, name: 'Paper', path: disk.root, createdAt: 1 });
    f.store.updateTask(f.task.id, { worktree: target.worktree });
    await f.workspace.refresh(f.task.id);
    const result = await f.workspace.applyTask(f.task.id);
    assert.ok(result.reconciliation);
    assert.match(disk.read(METHOD), /Latest manuscript/);
    assert.equal(f.store.task(f.task.id).status, 'queued');
    const run = f.store.runs()[0];
    await f.workspace.refresh(f.task.id);
    assert.equal(f.store.runs().length, 1, 'refresh does not duplicate the automatic suggestion');
    assert.match(run.prompt, /Do not guess which scientific statement is correct/);
    assert.match(run.prompt, /Resolve conflicts yourself whenever/);
    assert.match(run.prompt, /Only when the available context cannot determine/);
    assert.match(run.prompt, /Use the user-input tool when available/);
    assert.match(run.prompt, /continue the merge after the author answers/);
    assert.match(run.prompt, /ask before making any edits/);
    assert.ok(run.prompt.includes(result.reconciliation.sourceAccepted));
    assert.ok(run.prompt.includes(METHOD));
    assert.doesNotMatch(f.store.items(f.task.id)[0].text, /git show|refs\//, 'internal version identifiers stay out of the displayed request');
    await assert.rejects(f.workspace.applyTask(f.task.id), /Wait for the task/);
    f.store.saveRun({ ...run, status: 'completed' });
    f.store.updateTask(f.task.id, { status: 'reviewing' });
    await f.workspace.applyTask(f.task.id);
    assert.equal(f.store.runs().length, 1, 'retry cannot queue the same suggestion twice');
    disk.edit(target, METHOD, 'Latest manuscript.', 'Reviewed combined wording.');
    const next = fakeRound(app, target.name);
    await assert.rejects(f.workspace.applyTask(f.task.id), /Finish reviewing/);
    await app.review.decide(target.name, { id: 'accept-combination', action: 'accept', round: next.number, changes: next.units.map((unit: any) => unit.id) });
    const applied = await f.workspace.applyTask(f.task.id);
    assert.equal(applied.delivery?.mode, 'workspace');
    assert.equal(f.store.task(f.task.id).reconciliation, null);
    assert.match(disk.read(METHOD), /Reviewed combined wording/);
  } finally { f.close(); await disk.close(); }
});

for (const recovery of ['lost-response', 'restart', 'legacy-manual'] as const) test(`merge suggestions recover after ${recovery} without duplicate agent runs`, async () => {
  const { Fixture, METHOD, fakeRound } = await import(new URL('../engine/tests/ts/helpers.ts', import.meta.url).href);
  const disk = new Fixture(), app = disk.app();
  const f = fixture(async (method, route) => {
    if (route.includes('/feedback')) return app.review.feedback('p-task');
    if (method === 'POST' && route.endsWith('/apply')) { await app.delivery.apply('p-task'); throw new Error('Response lost'); }
    return app.taskInfo('p-task');
  });
  try {
    const target = app.tasks.create('p-task', 'Review', [], ['paper'], true);
    disk.edit(target, METHOD, 'Method sentence 2.', 'Accepted proposal.');
    const round = fakeRound(app, target.name);
    await app.review.decide(target.name, { id: crypto.randomUUID(), action: 'accept', round: round.number, changes: round.units.map((unit: any) => unit.id) });
    disk.write(METHOD, disk.read(METHOD).replace('Method sentence 2.', 'Latest text.'));
    f.store.saveProject({ id: f.task.projectId, name: 'Paper', path: disk.root, createdAt: 1 });
    f.store.updateTask(f.task.id, { worktree: target.worktree, deferred: true });
    if (recovery === 'lost-response') await f.workspace.applyTask(f.task.id);
    else {
      const merge = (await app.delivery.apply(target.name)).reconciliation!;
      if (recovery === 'legacy-manual') {
        // Older sessions could stop at the manual choice. Keep their edits
        // intact, but let AI finish instead of reopening the removed editor.
        app.store.execute('UPDATE reconciliations SET data=? WHERE task=?', JSON.stringify({ ...merge, resolution: 'manual' }), target.name);
        disk.edit(target, METHOD, 'Detail sentence 2.', 'Existing draft detail.');
      }
      await f.workspace.refresh(f.task.id);
      if (recovery === 'legacy-manual') assert.match(fs.readFileSync(path.join(target.worktree, METHOD), 'utf8'), /Existing draft detail/);
    }
    assert.equal(f.store.task(f.task.id).status, 'queued');
    assert.equal(f.store.runs().length, 1);
    await f.workspace.refresh(f.task.id);
    assert.equal(f.store.runs().length, 1);
    assert.match(disk.read(METHOD), /Latest text/);
  } finally { f.close(); await disk.close(); }
});

for (const stage of ['reviewed', 'interrupted', 'waiting_input'] as const) test(`automatic conflict recovery respects ${stage} tasks`, async () => {
  const { Fixture, METHOD, fakeRound } = await import(new URL('../engine/tests/ts/helpers.ts', import.meta.url).href);
  const disk = new Fixture(), app = disk.app();
  const f = fixture(async (_method, route) => route.includes('/feedback') ? app.review.feedback('p-task') : app.taskInfo('p-task'));
  try {
    const target = app.tasks.create('p-task', 'Review', [], ['paper'], true);
    disk.edit(target, METHOD, 'Method sentence 2.', 'Accepted proposal.');
    const round = fakeRound(app, target.name);
    await app.review.decide(target.name, { id: crypto.randomUUID(), action: 'accept', round: round.number, changes: round.units.map((unit: any) => unit.id) });
    disk.write(METHOD, disk.read(METHOD).replace('Method sentence 2.', 'Latest text.'));
    await app.delivery.apply(target.name);
    if (stage === 'reviewed') {
      disk.edit(target, METHOD, 'Latest text.', 'Combined proposal.');
      fakeRound(app, target.name);
    }
    f.store.saveProject({ id: f.task.projectId, name: 'Paper', path: disk.root, createdAt: 1 });
    f.store.updateTask(f.task.id, { worktree: target.worktree, deferred: true, status: stage === 'reviewed' ? 'reviewing' : stage });
    await f.workspace.refresh(f.task.id);
    assert.equal(f.store.runs().length, 0, 'do not replace a review or restart paused work');
    assert.match(disk.read(METHOD), /Latest text/);
  } finally { f.close(); await disk.close(); }
});

test('a task commits only what it accepted since its last commit, never during a review write, and can push', async () => {
  const { Fixture, METHOD, fakeRound } = await import(new URL('../engine/tests/ts/helpers.ts', import.meta.url).href);
  const disk = new Fixture();
  const app = disk.app();
  const f = fixture(undefined, { file: path.join(disk.base, 'state.db') });
  try {
    const target = app.tasks.create('p-task', 'Accept twice', [], ['paper']);
    disk.edit(target, METHOD, 'Method sentence 2.', 'First accepted sentence.');
    disk.edit(target, METHOD, 'Detail sentence 15.', 'Second accepted sentence.');
    disk.write('notes.txt', 'Not part of the task.');
    f.store.saveProject({ id: f.task.projectId, name: 'Temporary paper', path: disk.root, createdAt: 1 });
    await assert.rejects(f.workspace.commitTask(f.task.id, 'Nothing yet'), /no accepted changes/);
    const round = fakeRound(app, target.name);
    await app.review.decide(target.name, { id: 'accept-first', action: 'accept', round: round.number, changes: [round.units[0].id] });
    assert.deepEqual(await acceptedFiles(disk.root, target.name), [METHOD]);
    const first = await f.workspace.commitTask(f.task.id, 'Accept the first sentence', true);
    assert.equal(app.repo.text(['log', '-1', '--format=%s']).trim(), 'Accept the first sentence');
    assert.equal(app.repo.text(['show', '--name-only', '--format=', 'HEAD']).trim(), METHOD);
    assert.deepEqual(first.git.files.map((file: { path: string }) => file.path), ['notes.txt']);
    assert.match(first.pushError ?? '', /no remote/);
    assert.equal(f.store.task(f.task.id).committed?.hash, first.commit);
    assert.notEqual(f.store.task(f.task.id).committed?.pushed, true, 'a failed push leaves a local commit');
    // Someone edits the same file by hand: it is not this task's to commit.
    fs.writeFileSync(path.join(disk.root, METHOD), fs.readFileSync(path.join(disk.root, METHOD), 'utf8') + '\nA hand edit.\n');
    await f.workspace.refresh(f.task.id);
    assert.deepEqual(f.store.task(f.task.id).review?.files, []);
    await assert.rejects(f.workspace.commitTask(f.task.id, 'Not mine'), /no accepted changes left/);
    // Accepting more makes the file this task's again.
    await app.review.decide(target.name, { id: 'accept-second', action: 'accept', round: round.number, changes: [round.units[1].id] });
    await f.workspace.refresh(f.task.id);
    assert.deepEqual(f.store.task(f.task.id).review?.files, [METHOD]);
    // A review write in progress on the paper holds the commit back, and the reverse.
    const gate = deferred<void>();
    const write = f.workspace.reviewWrite(f.task.id, true, () => gate.promise);
    await assert.rejects(f.workspace.commitTask(f.task.id, 'Too early'), /review action/);
    gate.resolve(); await write;
    const committing = f.workspace.exclusiveCommit(f.task.projectId, () => new Promise(resolve => setTimeout(resolve, 20)));
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => undefined), /commit is in progress/);
    await committing;
    const remote = path.join(disk.base, 'remote.git');
    app.repo.run(['init', '--bare', remote]);
    app.repo.run(['remote', 'add', 'origin', remote]);
    const second = await f.workspace.commitTask(f.task.id, 'Accept the second sentence', true);
    assert.equal(second.pushError, undefined);
    assert.equal(f.store.task(f.task.id).committed?.hash, second.commit);
    assert.equal(f.store.task(f.task.id).committed?.pushed, true);
    assert.equal(app.repo.text(['rev-parse', '@{upstream}']).trim(), app.repo.rev('HEAD'));
    const reopened = new Store(f.store.file);
    try { assert.deepEqual(reopened.task(f.task.id).committed, f.store.task(f.task.id).committed); }
    finally { reopened.close(); }
    disk.edit(target, METHOD, 'Method sentence 7.', 'A later accepted sentence.');
    const next = fakeRound(app, target.name);
    await app.review.decide(target.name, { id: 'accept-next', action: 'accept', round: next.number, changes: next.units.map((unit: any) => unit.id) });
    const third = await f.workspace.commitTask(f.task.id, 'Keep the next revision local');
    assert.equal(third.pushError, undefined);
    assert.equal(f.store.task(f.task.id).committed?.hash, third.commit);
    assert.notEqual(f.store.task(f.task.id).committed?.pushed, true, 'a later local commit resets the previous push result');
    assert.equal(third.git.ahead, 1);
  } finally { f.close(); await disk.close(); }
});

test('agents that are not found on the host are neither started nor offered, and Reconnect looks again', async () => {
  const store = new Store(':memory:');
  class Detected extends FakeCodex {
    found = false; starts = 0;
    detect() { return this.found; }
    async start() { this.starts++; this.ready = true; }
    handler = async (method: string): Promise<any> => method === 'account/read' ? { account: { type: 'Local configuration' }, requiresOpenaiAuth: false } : method === 'model/list' ? { data: [] } : {};
  }
  const codex = new FakeCodex(); codex.handler = async (method: string) => method === 'account/read' ? { account: { email: 'me@example.com' }, requiresOpenaiAuth: false } : { data: [] };
  (codex as any).start = async () => { codex.ready = true; };
  const qwen = new Detected();
  const others = Object.fromEntries((['claude', 'cursor', 'copilot', 'grok', 'antigravity', 'kimi', 'glm', 'deepseek', 'opencode'] as const).map(id => [id, Object.assign(new Detected(), { found: false })]));
  const workspace = new Workspace(store, codex as unknown as Codex, async () => { throw new Error('unused'); }, { ...others, qwen } as any);
  try {
    await workspace.connect();
    assert.equal(qwen.starts, 0);
    assert.equal(workspace.runtimes.qwen.installed, false);
    assert.equal(workspace.runtimes.qwen.error, null);
    assert.equal(workspace.runtimes.codex.installed, true);
    qwen.found = true;
    await workspace.connect();
    assert.equal(qwen.starts, 1);
    assert.deepEqual([workspace.runtimes.qwen.installed, workspace.runtimes.qwen.connected, workspace.runtimes.qwen.authenticated], [true, true, true]);
    // A connected agent stays offered even if it can no longer be found.
    qwen.found = false;
    await workspace.connect();
    assert.equal(workspace.runtimes.qwen.installed, true);
  } finally { workspace.close(); store.close(); }
});

test('AI review uses normal agent tools and approvals, saves PDF notes, and never publishes or delivers edits', async () => {
  const f = fixture();
  try {
    f.store.updateTask(f.task.id, { mode: 'review', aiReview: { key: 'pdf-original' }, threadId: null });
    f.store.saveReviewInput(f.task.id, { key: 'pdf-original', lines: [{ id: 'p1-l1', page: 0, text: 'This always holds.', rect: [0.1, 0.2, 0.7, 0.25] }] });
    f.codex.ready = true;
    await f.workspace.enqueue(f.task.id, 'Check the assumptions.', 'ai-review-run');
    await tick(); await tick();
    const start = f.codex.calls.find(call => call.method === 'thread/start')!.params;
    assert.equal(start.sandbox, 'workspace-write');
    assert.equal(start.approvalPolicy, 'on-request');
    assert.equal(start.config.web_search, 'live');
    assert.equal(start.dynamicTools, undefined);
    assert.match(start.developerInstructions, /Do not edit the manuscript/);
    assert.match(f.codex.calls.find(call => call.method === 'turn/start')!.params.input[0].text, /p1-l1/);
    (f.workspace as any).serverRequest({ id: 100, method: 'item/fileChange/requestApproval', params: { threadId: 'thread', turnId: 'turn-new' } });
    assert.equal(f.codex.rejections.length, 0);
    assert.equal(f.workspace.requests.size, 1);
    await (f.workspace as any).notification({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn-new', item: { id: 'answer', type: 'agentMessage', text: JSON.stringify({ summary: 'Clarify the assumptions.', notes: [{ start: 'p1-l1', end: 'p1-l1', comment: 'Which assumptions are required?' }] }) } } });
    await (f.workspace as any).notification({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn-new', item: { id: 'denied', type: 'toolCall', status: 'declined', text: 'The CLI could not use Bash.' } } });
    const completion = { method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-new', status: 'completed' } } };
    await (f.workspace as any).notification(completion);
    await (f.workspace as any).notification(completion);
    assert.equal(f.store.items(f.task.id).find(item => item.id.endsWith(':denied'))?.type, 'tool');
    const notes = f.store.annotations(f.task.projectId);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].key, 'pdf-original');
    assert.deepEqual(notes[0].rects, [[0.1, 0.2, 0.7, 0.25]]);
    assert.equal(notes[0].taskId, undefined, 'Findings remain available for the author to choose');
    assert.deepEqual(notes[0].aiReview, { taskId: f.task.id, agent: 'codex' });
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
    assert.equal(f.store.task(f.task.id).aiReview?.notes, 1);
    assert.equal(f.store.runs()[0].reviewRound, null);
    await f.workspace.refresh(f.task.id);
    assert.equal(f.calls.length, 0, 'No engine feedback, publish, build or delivery requests');
    assert.throws(() => f.workspace.publish(f.task.id), /cannot publish/);
    await assert.rejects(f.workspace.deliverTask(f.task.id, 'workspace'), /no manuscript changes/);
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => {}), /PDF notes/);
    await assert.rejects(f.workspace.enqueue(f.task.id, 'Apply the notes', 'wrong-mode', true, { notes }), /editing task/);
    assert.equal(f.store.items(f.task.id).filter(item => item.type === 'assistant').at(-1)!.text, 'Clarify the assumptions.');
  } finally { f.close(); }
});

test('a review containing a 14-line suggestion completes and retains every finding', async () => {
  const f = fixture();
  try {
    const lines = Array.from({ length: 20 }, (_, index) => ({ id: `p13-l${index + 1}`, page: 12, text: `Line ${index + 1}`, rect: [0.1, index / 30, 0.8, (index + 1) / 30] as [number, number, number, number] }));
    f.store.updateTask(f.task.id, { mode: 'review', aiReview: { key: 'pdf' } });
    f.store.saveReviewInput(f.task.id, { key: 'pdf', lines });
    f.codex.ready = true;
    await f.workspace.enqueue(f.task.id, 'Review.', 'long-passage-review');
    await tick(); await tick();
    const text = JSON.stringify({ summary: 'Clarify the comparison.', notes: [{ start: 'p13-l1', end: 'p13-l1', comment: 'Define the term.' }, { start: 'p13-l7', end: 'p13-l20', comment: 'Explain the page reflow case.' }] });
    await (f.workspace as any).notification({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn-new', item: { id: 'answer', type: 'agentMessage', text } } });
    const completion = { method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-new', status: 'completed' } } };
    await (f.workspace as any).notification(completion);
    await (f.workspace as any).notification(completion);
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
    assert.equal(f.store.task(f.task.id).error, null);
    assert.equal(f.store.task(f.task.id).aiReview?.notes, 2);
    const notes = f.store.annotations(f.task.projectId);
    assert.equal(notes.length, 2);
    assert.deepEqual(notes[1].rects, lines.slice(6, 20).map(line => line.rect));
    assert.equal(f.store.items(f.task.id).at(-1)!.text, 'Clarify the comparison.');
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('an invalid AI response creates no partial notes and a follow-up can recover', async () => {
  const f = fixture();
  try {
    f.store.updateTask(f.task.id, { mode: 'review', aiReview: { key: 'pdf' } });
    f.store.saveReviewInput(f.task.id, { key: 'pdf', lines: [{ id: 'p1-l1', page: 0, text: 'A claim.', rect: [0, 0, 1, 1] }] });
    f.codex.ready = true;
    const finish = async (text: string, key: string) => {
      await f.workspace.enqueue(f.task.id, 'Review.', key);
      await tick(); await tick();
      await (f.workspace as any).notification({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn-new', item: { id: key, type: 'agentMessage', text } } });
      await (f.workspace as any).notification({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-new', status: 'completed' } } });
    };
    await finish(JSON.stringify({ summary: 'Review', notes: [{ start: 'p1-l1', end: 'p1-l1', comment: 'Valid' }, { start: 'missing', end: 'missing', comment: 'Invalid' }] }), 'invalid');
    assert.equal(f.store.annotations(f.task.projectId).length, 0);
    assert.equal(f.store.task(f.task.id).status, 'failed');
    await finish(JSON.stringify({ summary: 'No actionable issues.', notes: [] }), 'retry');
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
    assert.equal(f.store.task(f.task.id).aiReview?.notes, 0);
  } finally { f.close(); }
});

test('reconciling an AI review recovers annotations from the completed thread reply', async () => {
  const f = fixture();
  try {
    f.store.updateTask(f.task.id, { mode: 'review', aiReview: { key: 'pdf' } });
    f.store.saveReviewInput(f.task.id, { key: 'pdf', lines: [{ id: 'p1-l1', page: 0, text: 'A claim.', rect: [0, 0, 1, 1] }] });
    const run = uncertainRun(f);
    f.codex.handler = async () => ({ thread: { status: { type: 'loaded' }, turns: [{ ...identifiedTurn(run, 'completed'), items: [{ type: 'userMessage', clientId: run.id }, { id: 'reply', type: 'agentMessage', text: JSON.stringify({ summary: 'Needs evidence.', notes: [{ start: 'p1-l1', end: 'p1-l1', comment: 'Support this claim.' }] }) }] }] } });
    await f.workspace.reconcile(f.task.id);
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
    assert.equal(f.store.annotations(f.task.projectId)[0].comment, 'Support this claim.');
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('creating an AI review skill task persists its snapshot and queues review-only instructions once', async () => {
  const f = fixture(async (_method, route) => route === '/api/tasks' ? { worktree: '/isolated-review', deferred: true } : {});
  try {
    const reviewInput = { key: 'pdf-at-start', lines: [{ id: 'p1-l1', page: 0, text: 'Read this claim.', rect: [0.1, 0.2, 0.8, 0.3] as [number, number, number, number] }] };
    const input = { id: 'ai-review-task-0001', projectId: f.task.projectId, title: 'AI review', instructions: '', skill: 'ai-review', prepareReview: async () => reviewInput };
    assert.equal((await f.workspace.createTask(input)).status, 'preparing');
    const created = await f.workspace.prepareTask(input.id);
    assert.equal(created.mode, 'review');
    assert.equal(created.worktree, '/isolated-review');
    assert.equal(created.status, 'queued');
    assert.deepEqual(f.store.reviewInput(created.id), reviewInput);
    assert.match(f.store.runs().find(run => run.taskId === created.id)!.prompt, /Read this claim/);
    assert.match(f.store.runs().find(run => run.taskId === created.id)!.prompt, /do not edit, rewrite, commit, or apply changes/i);
    assert.equal(f.store.items(created.id)[0].meta?.skill?.id, 'ai-review');
    assert.equal(f.store.items(created.id)[0].text, '');
    assert.equal((await f.workspace.createTask(input)).id, created.id);
    assert.equal(f.calls.filter(call => call.route === '/api/tasks').length, 1);
    await assert.rejects(f.workspace.createTask({ ...input, prepareReview: undefined, instructions: 'Edit it.' }), /Invalid task ID/);
    for (const agent of AGENT_IDS) {
      const task = await f.workspace.createTask({ ...input, id: `ai-review-client-${agent}`, agent });
      assert.equal(task.agent, agent);
      assert.equal(task.mode, 'review');
      await f.workspace.prepareTask(task.id);
    }
  } finally { f.close(); }
});

test('an AI review whose manuscript copy cannot be read discards the copy, so a retry copies it again', async () => {
  const f = fixture(async (_method, route) => route === '/api/tasks' ? { worktree: '/task-copy', deferred: true } : route.endsWith('/finish') ? { task: 'p-ai-review-retry-task', finished: true } : {});
  try {
    const captured = { key: 'task-pdf', pdf: '/saved-review.pdf', lines: [{ id: 'p1-l1', page: 0, text: 'The fixed copy.', rect: [0.1, 0.2, 0.8, 0.3] as [number, number, number, number] }] };
    let fail = true;
    const input = { id: 'ai-review-retry-task', projectId: f.task.projectId, title: 'AI review', instructions: '', skill: 'ai-review', prepareReview: async () => { if (fail) throw new Error('The manuscript could not be compiled for AI review.'); return captured; } };
    await f.workspace.createTask(input);
    await assert.rejects(preparation(f, input.id), /could not be compiled/);
    assert.equal(f.store.task(input.id).status, 'failed');
    assert.match(f.store.task(input.id).error!, /could not be compiled/);
    assert.deepEqual(f.store.task(input.id).preparation, {}, 'the engine finished the copy, so deleting the task needs no engine');
    assert.deepEqual(f.calls.map(call => call.route), ['/api/tasks', '/api/tasks/p-ai-review-retry-task/finish']);
    assert.deepEqual(f.calls[1].body, { force: true });
    fail = false;
    await f.workspace.createTask(input);
    const created = await preparation(f, input.id);
    assert.equal(created.aiReview?.key, 'task-pdf');
    assert.match(f.store.runs().find(run => run.taskId === input.id)!.prompt, /The fixed copy/);
    assert.equal(f.calls.filter(call => call.route === '/api/tasks').length, 2);
  } finally { f.close(); }
});

test('AI review captures the task worktree before enqueueing and retries keep that snapshot', async () => {
  const f = fixture(async (_method, route) => route === '/api/tasks' ? { worktree: '/task-copy', deferred: true } : {});
  try {
    const captured = { key: 'task-pdf', pdf: '/saved-review.pdf', lines: [{ id: 'p1-l1', page: 0, text: 'The task copy.', rect: [0.1, 0.2, 0.8, 0.3] as [number, number, number, number] }] };
    let calls = 0;
    const input = { id: 'ai-review-copy-task', projectId: f.task.projectId, title: 'AI review', instructions: '', skill: 'ai-review', prepareReview: async (worktree: string) => { calls++; assert.equal(worktree, '/task-copy'); return captured; } };
    await f.workspace.createTask(input);
    const created = await f.workspace.prepareTask(input.id);
    assert.equal(created.aiReview?.key, 'task-pdf');
    assert.deepEqual(f.store.reviewInput(created.id), captured);
    assert.match(f.store.runs().find(run => run.taskId === created.id)!.prompt, /The task copy/);
    await f.workspace.createTask(input); assert.equal(calls, 1);
    f.store.saveAnnotation({ id: 'private-finding', projectId: f.task.projectId, key: 'task-pdf', page: 0, rect: [0, 0, 1, 1], comment: 'Clarify.', quote: 'Claim', source: null, createdAt: 1, aiReview: { taskId: created.id, agent: 'codex' } });
    await assert.rejects(f.workspace.createTask({ id: 'send-private-finding', projectId: f.task.projectId, title: 'Edit', instructions: '', annotations: ['private-finding'] }), /no longer available/);
  } finally { f.close(); }
});

for (const lifecycle of ['start', 'resume', 'loaded', 'fallback'] as const) {
  test(`editing network permissions survive ${lifecycle} without removing the file sandbox`, async () => {
    const f = fixture();
    try {
      if (lifecycle !== 'loaded') (f.workspace as any).loaded.clear();
      if (lifecycle === 'start' || lifecycle === 'fallback') f.store.updateTask(f.task.id, { threadId: null });
      if (lifecycle === 'fallback') f.codex.handler = async (method, params) => {
        if (method === 'thread/start' && params.dynamicTools) throw new RpcResponseError('unknown field dynamicTools');
        return method === 'turn/start' ? { turn: { id: 'turn-new' } } : { thread: { id: 'thread' } };
      };
      f.codex.ready = true;
      await f.workspace.enqueue(f.task.id, 'Find the cited paper online and correct the reference.', `network-${lifecycle}`, false);
      await tick(); await tick();
      const threads = f.codex.calls.filter(c => c.method === 'thread/start' || c.method === 'thread/resume');
      assert.equal(threads.length, lifecycle === 'loaded' ? 0 : lifecycle === 'fallback' ? 2 : 1);
      for (const call of threads) {
        assert.deepEqual(call.params.config, { web_search: 'live', 'sandbox_workspace_write.network_access': true });
        assert.equal(call.params.sandbox, 'workspace-write');
        assert.equal(call.params.approvalPolicy, 'on-request');
        assert.match(call.params.developerInstructions, /Cite source URLs/);
      }
      const turn = f.codex.calls.find(c => c.method === 'turn/start');
      assert.ok(turn);
      assert.equal(turn.params.sandboxPolicy.type, 'workspaceWrite', 'apply the runtime policy even to a loaded conversation');
      assert.equal(turn.params.approvalPolicy, 'on-request');
    } finally { f.close(); }
  });
}

test('review threads use normal network access and inherit the resolved sandbox', async () => {
  const f = fixture();
  try {
    (f.workspace as any).loaded.clear();
    f.store.updateTask(f.task.id, { mode: 'review', threadId: null, aiReview: { key: 'network-review' } });
    f.store.saveReviewInput(f.task.id, { key: 'network-review', lines: [{ id: 'p1-l1', page: 0, text: 'Review fixture.', rect: [0.1, 0.2, 0.7, 0.25] }] });
    f.codex.ready = true;
    await f.workspace.enqueue(f.task.id, 'Review the paper.', 'network-review', false);
    await tick(); await tick();
    const start = f.codex.calls.find(c => c.method === 'thread/start');
    assert.equal(start?.params.sandbox, 'workspace-write');
    assert.equal(start?.params.approvalPolicy, 'on-request');
    assert.deepEqual(start?.params.config, { web_search: 'live', 'sandbox_workspace_write.network_access': true });
    assert.equal(f.codex.calls.find(c => c.method === 'turn/start')?.params.sandboxPolicy, undefined);
  } finally { f.close(); }
});

for (const lifecycle of ['start', 'resume', 'loaded', 'fallback'] as const) {
  for (const permissions of ['workspace', 'full'] as const)
  test(`Codex ${lifecycle} inherits the task's configured approval reviewer with ${permissions} access`, async () => {
    for (const config of [
      { approvals_reviewer: 'auto_review' },
      { approvals_reviewer: 'user' },
      { approvals_reviewer: 'auto_review', profile: 'paper', profiles: { paper: { approvals_reviewer: 'user' } } },
      { approvals_reviewer: 'guardian_subagent' },
      { approvals_reviewer: null },
      { approvals_reviewer: 'unknown' },
      null,
    ]) {
      const f = fixture();
      try {
        if (lifecycle !== 'loaded') (f.workspace as any).loaded.clear();
        if (lifecycle === 'start' || lifecycle === 'fallback') f.store.updateTask(f.task.id, { threadId: null });
        f.store.updateTask(f.task.id, { permissions });
        f.codex.ready = true;
        f.codex.taskPermissionConfig = Codex.prototype.taskPermissionConfig.bind(f.codex);
        const sandbox = { type: 'workspaceWrite', writableRoots: ['/configured-root'], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
        f.codex.handler = async (method, params) => {
          if (method === 'config/read') {
            assert.deepEqual(params, { cwd: f.task.worktree, includeLayers: false });
            if (!config) throw new RpcResponseError('Unsupported method');
            return { config };
          }
          if (method === 'thread/start' && params.ephemeral) {
            assert.equal(params.cwd, f.task.worktree);
            assert.equal(params.sandbox, 'workspace-write');
            assert.equal(params.approvalPolicy, 'on-request');
            return { thread: { id: 'permission-probe' }, sandbox, approvalPolicy: 'on-request', approvalsReviewer: 'user' };
          }
          if (method === 'thread/unsubscribe') {
            assert.deepEqual(params, { threadId: 'permission-probe' });
            return {};
          }
          if (lifecycle === 'fallback' && method === 'thread/start' && params.dynamicTools) throw new RpcResponseError('unknown field dynamicTools');
          return method === 'turn/start' ? { turn: { id: 'turn-new' } } : { thread: { id: 'thread' } };
        };
        await f.workspace.enqueue(f.task.id, 'Revise this sentence.', `reviewer-${lifecycle}`, false);
        await tick(); await tick();
        const expected = config?.profiles?.paper.approvals_reviewer ?? (['user', 'auto_review', 'guardian_subagent'].includes(config?.approvals_reviewer || '') ? config?.approvals_reviewer : undefined);
        const calls = f.codex.calls.filter(c => ['thread/start', 'thread/resume', 'turn/start'].includes(c.method) && !c.params.ephemeral);
        assert.equal(calls.length, lifecycle === 'loaded' ? 1 : lifecycle === 'fallback' ? 3 : 2);
        assert.equal(f.codex.calls.filter(c => c.method === 'thread/unsubscribe').length, permissions === 'workspace' ? 1 : 0);
        for (const call of calls) {
          assert.equal(call.params.approvalsReviewer, expected);
          if (expected === undefined) assert.equal(Object.hasOwn(call.params, 'approvalsReviewer'), false);
          if (call.method === 'turn/start') {
            assert.deepEqual(call.params.sandboxPolicy, permissions === 'full' ? { type: 'dangerFullAccess' } : sandbox);
            assert.equal(call.params.approvalPolicy, permissions === 'full' ? 'never' : 'on-request');
            assert.match(call.params.additionalContext['papilot-task-access'].value, /replace earlier Papilot instructions about access outside the task worktree/);
          }
          else {
            assert.equal(call.params.sandbox, permissions === 'full' ? 'danger-full-access' : 'workspace-write');
            assert.equal(call.params.approvalPolicy, permissions === 'full' ? 'never' : 'on-request');
          }
        }
      } finally { f.close(); }
    }
  });
}

test('loaded Codex turns re-read reviewer changes while switching permissions without a reconnect', async () => {
  const f = fixture();
  let reviewer = 'auto_review', root = '/configured-first';
  try {
    f.codex.ready = true;
    f.codex.taskPermissionConfig = Codex.prototype.taskPermissionConfig.bind(f.codex);
    f.codex.handler = async (method, params) => {
      if (method === 'config/read') return { config: { approvals_reviewer: reviewer } };
      if (method === 'thread/start' && params.ephemeral) return {
        thread: { id: 'permission-probe' }, approvalPolicy: 'on-request',
        sandbox: { type: 'workspaceWrite', writableRoots: [root], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
      };
      return { turn: { id: 'turn-new' } };
    };
    for (const [permissions, configuredReviewer, configuredRoot] of [
      ['workspace', 'auto_review', '/configured-first'],
      ['full', 'guardian_subagent', '/configured-first'],
      ['workspace', 'user', '/configured-later'],
    ] as const) {
      reviewer = configuredReviewer; root = configuredRoot;
      f.workspace.updateTaskPermissions(f.task.id, permissions);
      await f.workspace.enqueue(f.task.id, 'Revise this sentence.', `reviewer-${reviewer}`, false);
      await tick(); await tick();
      const turn = f.codex.calls.findLast(c => c.method === 'turn/start')!.params;
      assert.equal(turn.approvalsReviewer, reviewer);
      assert.equal(turn.threadId, 'thread');
      assert.equal(turn.approvalPolicy, permissions === 'full' ? 'never' : 'on-request');
      assert.deepEqual(turn.sandboxPolicy, permissions === 'full' ? { type: 'dangerFullAccess' }
        : { type: 'workspaceWrite', writableRoots: [root], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
      await f.workspace.interrupt(f.task.id);
      await (f.workspace as any).notification({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-new', status: 'interrupted' } } });
    }
    assert.equal(f.codex.calls.some(c => c.method === 'thread/resume' || c.method === 'thread/start' && !c.params.ephemeral), false);
    assert.equal(f.codex.calls.filter(c => c.method === 'thread/unsubscribe').length, 2);
  } finally { f.close(); }
});

for (const permissions of ['full', 'workspace'] as const) {
  test(`task permission selector keeps the loaded conversation with ${permissions} access`, async () => {
    const f = fixture();
    try {
      f.store.updateTask(f.task.id, { permissions: permissions === 'full' ? 'workspace' : 'full' });
      const changed = f.workspace.updateTaskPermissions(f.task.id, permissions);
      assert.equal(changed.permissions, permissions);
      assert.equal(changed.threadId, 'thread');
      assert.equal((f.workspace as any).loaded.has('thread'), true);
      f.codex.ready = true;
      await f.workspace.enqueue(f.task.id, 'Inspect the remote results.', `permissions-${permissions}`, false);
      await tick(); await tick();
      const resume = f.codex.calls.find(call => call.method === 'thread/resume');
      assert.equal(resume, undefined, 'changing permissions does not reload a conversation with unchanged instructions');
      const turn = f.codex.calls.find(call => call.method === 'turn/start');
      assert.equal(turn?.params.sandboxPolicy.type, permissions === 'full' ? 'dangerFullAccess' : 'workspaceWrite');
      assert.equal(turn?.params.approvalPolicy, permissions === 'full' ? 'never' : 'on-request');
    } finally { f.close(); }
  });
}


for (const permissions of ['full', 'workspace'] as const) test(`loaded native conversations receive updated access context for ${permissions}`, async () => {
  const f = fixture();
  try {
    (f.workspace as any).agents.antigravity = f.codex;
    f.store.updateTask(f.task.id, { agent: 'antigravity', permissions });
    f.workspace.runtimes.antigravity.authenticated = true;
    f.codex.ready = true;
    const run = await f.workspace.enqueue(f.task.id, 'Inspect the remote results.', `native-context-${permissions}`, false);
    await tick(); await tick();
    assert.equal(f.codex.calls.some(call => call.method === 'thread/resume'), false);
    const text = f.codex.calls.find(call => call.method === 'turn/start')?.params.input[0].text;
    assert.match(text, /supersedes earlier Papilot messages fixing the access mode/);
    assert.match(text, /Keep manuscript edits in this isolated task worktree/);
    assert.match(text, permissions === 'full' ? /current permissions are Full access/ : /current permissions are Workspace access/);
    assert.ok(text.endsWith(run.prompt));
    assert.doesNotMatch(run.prompt, /Papilot settings update/, 'internal context must not alter the author’s stored message');
  } finally { f.close(); }
});

test('editing instructions keep manuscript boundaries without pinning mutable access permissions', () => {
  const f = fixture();
  try {
    for (const agent of ['codex', 'claude', 'glm', 'cursor', 'grok', 'antigravity'] as const) {
      const instructions = (permissions: 'workspace' | 'full') => (f.workspace as any).instructions({ ...f.task, agent, permissions });
      assert.equal(instructions('workspace'), instructions('full'));
      assert.match(instructions('workspace'), /Keep manuscript edits in this isolated task worktree/);
      assert.match(instructions('workspace'), /runtime's current sandbox and approval requirements/);
      assert.doesNotMatch(instructions('workspace'), /Only edit this isolated task worktree|The user selected full access/);
      assert.match(instructions('full'), /Never edit the manuscript checkout, other task worktrees, or Papilot's own source\/state/);
    }
  } finally { f.close(); }
});

test('task permission selector refuses active turns, unsupported providers, reviews and invalid values', () => {
  const f = fixture();
  try {
    for (const status of ['running', 'waiting_input', 'queued', 'uncertain', 'building', 'deleting'] as const) {
      f.store.updateTask(f.task.id, { status });
      assert.throws(() => f.workspace.updateTaskPermissions(f.task.id, 'full'), /Pause the task/);
    }
    f.store.updateTask(f.task.id, { status: 'reviewing', agent: 'kimi' });
    assert.throws(() => f.workspace.updateTaskPermissions(f.task.id, 'full'), /Invalid task permissions/);
    f.store.updateTask(f.task.id, { agent: 'codex', mode: 'review' });
    assert.throws(() => f.workspace.updateTaskPermissions(f.task.id, 'full'), /only available/);
    f.store.updateTask(f.task.id, { mode: 'edit' });
    assert.throws(() => f.workspace.updateTaskPermissions(f.task.id, 'unrestricted'), /Invalid task permissions/);
    assert.equal(f.store.task(f.task.id).permissions, undefined);
  } finally { f.close(); }
});

test('task permission selector persists the choice across reopening the task store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-permissions-'));
  const file = path.join(dir, 'state.sqlite'), f = fixture(undefined, { file });
  try {
    f.workspace.updateTaskPermissions(f.task.id, 'full');
    const reopened = new Store(file);
    try { assert.equal(reopened.task(f.task.id).permissions, 'full'); } finally { reopened.close(); }
  } finally { f.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const permissions of ['workspace', 'full'] as const) {
  test(`new task permission selector starts with the chosen ${permissions} policy`, async () => {
    const f = fixture(async (_method, route) => route === '/api/tasks' ? { worktree: '/unused' } : summary);
    try {
      const created = await f.workspace.createTask({ id: `permission-task-${permissions}`, projectId: 'paper', title: 'Revise', instructions: 'Inspect results.', permissions });
      assert.equal(created.permissions, permissions);
      const run = f.store.runs().find(run => run.taskId === created.id)!;
      f.codex.ready = true;
      (f.workspace as any).active.set(created.id, run);
      await (f.workspace as any).startRun(run);
      const start = f.codex.calls.find(call => call.method === 'thread/start' && !call.params.ephemeral);
      assert.equal(start?.params.sandbox, permissions === 'full' ? 'danger-full-access' : 'workspace-write');
    } finally { f.close(); }
  });
}

// Start task answers at once and makes the task's copy in the background.
const engineCopy = (worktree = '/unused/new-task') => ({ worktree, deferred: true });
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await tick();
  assert.ok(check());
}

test('Start task saves the task and its first message at once, then prepares it in the background', async () => {
  const copy = deferred<any>();
  const f = fixture(async (_method, route) => route === '/api/tasks' ? copy.promise : summary);
  try {
    f.codex.ready = true;
    const input = { id: 'instant-start-task-01', projectId: 'paper', title: 'Shorten', instructions: 'Shorten the abstract.' };
    const created = await f.workspace.createTask(input);
    assert.equal(created.status, 'preparing');
    assert.ok(created.preparation);
    assert.equal(created.worktree, '');
    assert.equal(f.workspace.snapshot().tasks.find(task => task.id === input.id)?.status, 'preparing', 'the task list shows it at once');
    assert.deepEqual(f.store.items(input.id).map(item => [item.type, item.text]), [['user', 'Shorten the abstract.']]);
    const run = f.store.runByKey('initial-' + input.id)!;
    assert.equal(run.status, 'queued');
    await until(() => f.calls.some(call => call.route === '/api/tasks'));
    assert.deepEqual(f.calls.find(call => call.route === '/api/tasks')!.body, { name: 'p-instant-start-task-01', title: 'Shorten', deferred: true });
    assert.equal(f.store.task(input.id).preparation?.submitted, true, 'saved before the engine is asked for the copy');
    await tick(); await tick();
    assert.ok(!f.codex.calls.some(call => call.method === 'turn/start' && call.params.clientUserMessageId === run.id), 'the first message waits for the copy');
    copy.resolve(engineCopy());
    const prepared = await f.workspace.prepareTask(input.id);
    assert.equal(prepared.preparation, null);
    assert.equal(prepared.worktree, '/unused/new-task');
    assert.equal(prepared.status, 'queued');
    await until(() => f.codex.calls.some(call => call.method === 'turn/start' && call.params.clientUserMessageId === run.id));
    assert.equal(f.codex.calls.find(call => call.method === 'turn/start' && call.params.clientUserMessageId === run.id)!.params.cwd, '/unused/new-task');
  } finally { copy.resolve(engineCopy()); f.close(); }
});

test('a task being prepared refuses more messages and pausing, keeps its archive and title, and permissions wait', async () => {
  const copy = deferred<any>();
  const f = fixture(async (_method, route) => route === '/api/tasks' ? copy.promise : summary);
  try {
    const input = { id: 'preparing-guards-01', projectId: 'paper', title: 'Shorten', instructions: 'Shorten the abstract.' };
    await f.workspace.createTask(input);
    await assert.rejects(f.workspace.enqueue(input.id, 'And the conclusion.', 'second-message', true), /still being prepared/);
    assert.equal(f.store.runByKey('initial-' + input.id)!.requestKey, 'initial-' + input.id, 'a retried first message is idempotent');
    assert.equal((await f.workspace.enqueue(input.id, 'Shorten the abstract.', 'initial-' + input.id, false)).requestKey, 'initial-' + input.id);
    await assert.rejects(f.workspace.interrupt(input.id), /not started yet/);
    assert.throws(() => f.workspace.updateTaskPermissions(input.id, 'full'), /Pause the task/);
    await assert.rejects(f.workspace.deleteTask(input.id), /Wait for task creation to finish/);
    f.workspace.archiveTask(input.id, true);
    f.workspace.renameTask(input.id, 'A shorter abstract');
    copy.resolve(engineCopy());
    const prepared = await f.workspace.prepareTask(input.id);
    assert.ok(prepared.archivedAt);
    assert.equal(prepared.title, 'A shorter abstract');
    assert.equal(prepared.status, 'queued');
    assert.equal(f.store.runs().filter(run => run.taskId === input.id).length, 1);
  } finally { copy.resolve(engineCopy()); f.close(); }
});

for (const stage of ['connect', 'engine', 'review'] as const) {
  test(`a failure while ${stage === 'connect' ? 'connecting' : stage === 'engine' ? 'making the copy' : 'reading the review PDF'} leaves the task for Retry`, async () => {
    let fail = true;
    const f = fixture(async (_method, route) => {
      if (route === '/api/tasks') { if (fail && stage === 'engine') throw new Error('The review engine is busy.'); return engineCopy(); }
      if (route.endsWith('/finish')) return { task: 'p-failed-stage-task', finished: true };
      return summary;
    });
    const connect = (f.workspace as any).connectReview;
    if (stage === 'connect') (f.workspace as any).connectReview = async (...args: any[]) => { if (fail) throw new Error('The review server failed to start.'); return connect(...args); };
    const snapshot = { key: 'review-pdf', lines: [{ id: 'p1-l1', page: 0, text: 'A claim.', rect: [0, 0, 1, 1] as [number, number, number, number] }] };
    f.workspace.prepareReview = async () => { if (fail) throw new Error('The manuscript could not be compiled for AI review.'); return snapshot; };
    try {
      f.codex.ready = true;
      const input = { id: 'failed-stage-task', projectId: 'paper', title: 'Revise', instructions: stage === 'review' ? '' : 'Revise.', ...(stage === 'review' ? { skill: 'ai-review', prepareReview: (worktree: string) => f.workspace.prepareReview(f.store.task('failed-stage-task'), worktree) } : {}) };
      await f.workspace.createTask(input);
      await assert.rejects(preparation(f, input.id), stage === 'connect' ? /failed to start/ : stage === 'engine' ? /engine is busy/ : /could not be compiled/);
      const failed = f.store.task(input.id);
      assert.equal(failed.status, 'failed');
      assert.ok(failed.error);
      assert.deepEqual(failed.preparation, stage === 'engine' ? { submitted: true } : {});
      assert.equal(f.store.runByKey('initial-' + input.id)!.status, 'queued');
      await tick(); await tick();
      assert.ok(!f.codex.calls.some(call => call.method === 'thread/start' && !call.params.ephemeral), 'the first message does not run without a copy');
      await assert.rejects(f.workspace.enqueue(input.id, 'More.', 'more-instructions', false), /Retry preparing/);
      fail = false;
      assert.equal(f.workspace.retryTask(input.id).status, 'preparing');
      assert.equal(f.workspace.retryTask(input.id).status, 'preparing', 'a second Retry joins the first');
      const prepared = await preparation(f, input.id);
      assert.equal(prepared.status, 'queued');
      assert.equal(prepared.error, null);
      assert.equal(prepared.worktree, '/unused/new-task');
      if (stage === 'review') {
        assert.deepEqual(f.store.reviewInput(input.id), snapshot);
        assert.equal(prepared.aiReview?.key, 'review-pdf');
        assert.match(f.store.runByKey('initial-' + input.id)!.prompt, /A claim\./);
      }
      assert.equal(f.store.runs().filter(run => run.taskId === input.id).length, 1);
      assert.equal(f.store.items(input.id).length, 1);
      await until(() => f.codex.calls.some(call => call.method === 'turn/start' && call.params.cwd === '/unused/new-task'));
    } finally { f.close(); }
  });
}

test('a restart resumes a preparation with the same engine task, or fails it cleanly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-prepare-')), file = path.join(dir, 'papilot.sqlite');
  const held = deferred<any>();
  const before = fixture(async (_method, route) => route === '/api/tasks' ? held.promise : summary, { file });
  try {
    for (const id of ['resumed-task-000001', 'failed-on-restart-01']) {
      await before.workspace.createTask({ id, projectId: 'paper', title: 'Revise', instructions: 'Revise.' });
      await until(() => before.calls.filter(call => call.route === '/api/tasks').length === (id === 'resumed-task-000001' ? 1 : 2));
    }
  } finally { before.close(); held.resolve(engineCopy()); }
  const after = fixture(async (_method, route, body: any) => {
    if (route !== '/api/tasks') return summary;
    if (body.name === 'p-failed-on-restart-01') throw new Error('The review engine is busy.');
    return engineCopy('/unused/resumed');
  }, { file });
  try {
    after.store.recover();
    assert.equal(after.store.task('resumed-task-000001').status, 'preparing', 'recovery keeps the task for start.ts to resume');
    const resumed = await after.workspace.prepareTask('resumed-task-000001');
    assert.equal(resumed.status, 'queued');
    assert.equal(resumed.worktree, '/unused/resumed');
    assert.deepEqual(after.calls.find(call => call.route === '/api/tasks')!.body, { name: 'p-resumed-task-000001', title: 'Revise', deferred: true });
    await assert.rejects(after.workspace.prepareTask('failed-on-restart-01'), /engine is busy/);
    assert.equal(after.store.task('failed-on-restart-01').status, 'failed');
    assert.equal(after.store.task('failed-on-restart-01').error, 'The review engine is busy.');
    assert.equal(after.store.runByKey('initial-failed-on-restart-01')!.status, 'queued');
  } finally { after.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a resumed preparation waits while the engine is still making the copy it asked for before', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let asked = 0;
  const f = fixture(async (_method, route, body: any) => {
    if (route !== '/api/tasks') return summary;
    // The engine kept running across the restart and is still checking out the copy.
    if (++asked < 3) throw new Error(`Task ${JSON.stringify(body.name)} is being created. Try again in a moment.`);
    return engineCopy('/unused/resumed');
  });
  try {
    const input = { id: 'still-creating-0001', projectId: 'paper', title: 'Revise', instructions: 'Revise.' };
    await f.workspace.createTask(input);
    const job = preparation(f, input.id);
    for (let i = 0; i < 2; i++) {
      await until(() => asked === i + 1);
      await tick(); await tick();
      assert.equal(f.store.task(input.id).status, 'preparing');
      t.mock.timers.tick(1000);
    }
    const prepared = await job;
    assert.equal(asked, 3);
    assert.equal(prepared.status, 'queued');
    assert.equal(prepared.worktree, '/unused/resumed');
    assert.equal(prepared.error, null);
  } finally { f.close(); }
});

test('attachments are claimed when the task is saved, and deleting a failed preparation returns its notes', async () => {
  let copied = false;
  const f = fixture(async (_method, route) => {
    if (route === '/api/tasks') { if (copied) return { ...engineCopy(), task: 'p-claims-task-000001' }; throw new Error('The review engine is busy.'); }
    if (route.endsWith('/finish')) return { task: 'p-claims-task-000001', finished: true };
    return summary;
  });
  try {
    const file = await f.workspace.attachments.upload('paper', 'results.csv', Buffer.from('x,y\n1,2'));
    const note = { id: 'claimed-note', projectId: 'paper', key: 'pdf', page: 0, rect: [0, 0, 1, 1] as [number, number, number, number], quote: 'A sentence.', comment: 'Clarify.', source: null, createdAt: 1 };
    f.store.saveAnnotation(note);
    const input = { id: 'claims-task-000001', projectId: 'paper', title: 'Use the data', instructions: 'Use the attached data.', attachments: [file.id], annotations: [note.id] };
    const created = await f.workspace.createTask(input);
    assert.equal(created.status, 'preparing');
    assert.deepEqual(f.store.items(input.id)[0].meta?.attachments?.map(item => item.id), [file.id]);
    assert.throws(() => f.workspace.attachments.resolve('paper', [file.id], 'other-task-000001'), /not available/);
    await assert.rejects(f.workspace.createTask({ ...input, id: 'other-task-000001', annotations: [] }), /not available/);
    f.workspace.attachments.discard('paper', file.id);
    assert.ok(fs.existsSync(f.workspace.attachments.path(file)), 'a claimed attachment cannot be discarded');
    await assert.rejects(preparation(f, input.id), /engine is busy/);
    // The engine made the copy, but its answer was lost.
    copied = true;
    await f.workspace.deleteTask(input.id);
    assert.ok(f.calls.some(call => call.route === '/api/tasks/p-claims-task-000001/finish'), 'a copy the engine made is finished');
    assert.equal(f.store.tasks().some(task => task.id === input.id), false);
    assert.equal(f.store.annotation('paper', note.id).taskId, undefined, 'the note goes back to the manuscript');
    assert.equal(fs.existsSync(f.workspace.attachments.path(file)), false);
  } finally { f.close(); }
});

test('deletion retains a failed preparation while the engine is still making its copy', async () => {
  const input = { id: 'lost-copy-reply-0001', projectId: 'paper', title: 'Revise', instructions: 'Revise.' };
  const name = 'p-' + input.id;
  let attempts = 0, creating = true, finished = false;
  const f = fixture(async (method, route) => {
    if (route === '/api/tasks' && method === 'GET') return { tasks: [] }; // No task is recorded until its copy is ready.
    if (route === '/api/tasks') {
      if (++attempts === 1) throw new Error('The create response was lost.');
      if (creating) throw new Error(`Task ${JSON.stringify(name)} is being created. Try again in a moment.`);
      return { ...engineCopy(), task: name };
    }
    if (route.endsWith('/finish')) { finished = true; return { task: name, finished: true }; }
    return summary;
  });
  try {
    await f.workspace.createTask(input);
    await assert.rejects(preparation(f, input.id), /response was lost/);
    await assert.rejects(f.workspace.deleteTask(input.id), /being created/);
    assert.equal(f.store.task(input.id).status, 'deleting', 'Keep the cleanup reservation until the engine confirms it');
    assert.equal(f.store.taskDeleted(input.id), false);
    assert.equal(finished, false);
    creating = false;
    await f.workspace.deleteTask(input.id);
    assert.equal(finished, true);
    assert.equal(f.store.taskDeleted(input.id), true);
  } finally { f.close(); }
});

test('deletion refuses malformed or foreign copy confirmations after a failed preparation', async t => {
  for (const info of [{}, { task: 'another-task', worktree: '/unused' }, { task: 'p-unconfirmed-copy-01' }, { task: 'p-unconfirmed-copy-01', worktree: '' }]) await t.test(JSON.stringify(info), async () => {
    let failed = false;
    const f = fixture(async (_method, route) => {
      if (route === '/api/tasks' && !failed) { failed = true; throw new Error('The create response was lost.'); }
      return info;
    });
    try {
      await f.workspace.createTask({ id: 'unconfirmed-copy-01', projectId: 'paper', title: 'Revise', instructions: 'Revise.' });
      await assert.rejects(preparation(f, 'unconfirmed-copy-01'), /response was lost/);
      await assert.rejects(f.workspace.deleteTask('unconfirmed-copy-01'), /could not confirm/);
      assert.equal(f.store.task('unconfirmed-copy-01').status, 'deleting');
      assert.equal(f.store.taskDeleted('unconfirmed-copy-01'), false);
      assert.ok(!f.calls.some(call => call.route.endsWith('/finish')));
    } finally { f.close(); }
  });
});

test('deleting a task the engine never saw needs no engine', async () => {
  const f = fixture();
  try {
    (f.workspace as any).connectReview = async () => { throw new Error('The review server failed to start.'); };
    await f.workspace.createTask({ id: 'never-submitted-01', projectId: 'paper', title: 'Revise', instructions: 'Revise.' });
    await assert.rejects(preparation(f, 'never-submitted-01'), /failed to start/);
    await f.workspace.deleteTask('never-submitted-01');
    assert.equal(f.store.tasks().some(task => task.id === 'never-submitted-01'), false);
    assert.equal(f.store.runByKey('initial-never-submitted-01'), undefined);
    await assert.rejects(f.workspace.createTask({ id: 'never-submitted-01', projectId: 'paper', title: 'Revise', instructions: 'Revise.' }), /was deleted/);
  } finally { f.close(); }
});

test('duplicate Start task requests save one task, one message and one copy', async () => {
  const f = fixture(async (_method, route) => route === '/api/tasks' ? engineCopy() : summary);
  try {
    const input = { id: 'duplicate-start-01', projectId: 'paper', title: 'Revise', instructions: 'Revise.' };
    const [first, second] = await Promise.all([f.workspace.createTask(input), f.workspace.createTask(input)]);
    assert.equal(first.id, second.id);
    await f.workspace.prepareTask(input.id);
    assert.equal((await f.workspace.createTask(input)).status, 'queued');
    assert.equal(f.store.tasks().filter(task => task.id === input.id).length, 1);
    assert.equal(f.store.runs().filter(run => run.taskId === input.id).length, 1);
    assert.equal(f.store.items(input.id).length, 1);
    assert.equal(f.calls.filter(call => call.route === '/api/tasks').length, 1);
    await assert.rejects(f.workspace.createTask({ ...input, projectId: 'other-paper' }), /Invalid task ID/);
  } finally { f.close(); }
});
