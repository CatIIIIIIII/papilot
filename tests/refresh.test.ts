import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadRequest, canStreamUpdates, mergeTimeline, visibleTimeline } from '../src/web/refresh.ts';
import { Store, TASK_BY_THREAD } from '../src/server/store.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('simultaneous refresh triggers share one request and one update', async () => {
  const request = new ReadRequest<string>();
  const result = deferred<string>();
  let calls = 0;
  const values: string[] = [];
  const load = async () => { calls++; return result.promise; };
  const first = request.run('state', load, value => values.push(value));
  const second = request.run('state', load, value => values.push(value));
  assert.equal(first, second);
  result.resolve('latest');
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(values, ['latest']);
});

test('switching tasks aborts the old read and ignores late results', async () => {
  const request = new ReadRequest<string>();
  const oldResult = deferred<string>();
  const values: string[] = [];
  let oldSignal!: AbortSignal;
  const first = request.run('task-one', signal => { oldSignal = signal; return oldResult.promise; }, value => values.push(value));
  await Promise.resolve();
  const second = request.run('task-two', async () => 'new task', value => values.push(value));
  assert.equal(oldSignal.aborted, true);
  await second;
  oldResult.resolve('obsolete task');
  await first;
  assert.deepEqual(values, ['new task']);
});

test('cancellation suppresses stale failures and subsequent reads still succeed', async () => {
  const request = new ReadRequest<string>();
  let updates = 0;
  const pending = request.run('state', async signal => {
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    return 'stale';
  }, () => { updates++; });
  await Promise.resolve();
  request.cancel();
  await pending;
  await request.run('state', async () => 'fresh', () => { updates++; });
  assert.equal(updates, 1);
});

test('failed reads release their slot so reconnect can retry', async () => {
  const request = new ReadRequest<string>();
  await assert.rejects(request.run('state', async () => { throw new Error('offline'); }, () => {}), /offline/);
  let value = '';
  await request.run('state', async () => 'reconnected', next => { value = next; });
  assert.equal(value, 'reconnected');
});

test('only multiplexed HTTP connections use persistent event streams', () => {
  for (const protocol of ['', 'http/1.0', 'http/1.1', 'unknown']) assert.equal(canStreamUpdates(protocol), false);
  for (const protocol of ['h2', 'h3']) assert.equal(canStreamUpdates(protocol), true);
});

test('a partial timeline read replaces changed items, adds new ones in order, and keeps the rest', () => {
  const a = { id: 'a', createdAt: 1, text: 'first' }, b = { id: 'b', createdAt: 2, text: 'running' }, c = { id: 'c', createdAt: 4, text: 'later' };
  const items = [a, b, c];
  assert.equal(mergeTimeline(items, []), items, 'nothing changed keeps the same array');
  const merged = mergeTimeline(items, [{ ...b, text: 'done' }, { id: 'd', createdAt: 3, text: 'new' }]);
  assert.deepEqual(merged.map(item => [item.id, item.text]), [['a', 'first'], ['b', 'done'], ['d', 'new'], ['c', 'later']]);
  assert.equal(merged[0], a, 'an unchanged item keeps its identity');
  assert.equal(merged[3], c);
});

test('the store returns only the timeline items written since a revision', () => {
  const store = new Store(':memory:');
  const item = (id: string, createdAt: number, text: string) => ({ id, taskId: 't', type: 'command', text, createdAt });
  store.saveItem(item('a', 1, 'one')); store.saveItem(item('b', 2, 'two'));
  const first = store.itemsSince('t');
  assert.deepEqual(first.items.map(i => i.id), ['a', 'b']);
  assert.equal(first.partial, undefined, 'a first read is the whole timeline');
  assert.deepEqual(store.itemsSince('t', first.revision), { items: [], revision: first.revision, partial: true });
  store.saveItem({ ...item('b', 2, 'two'), detail: 'output' }); store.saveItem(item('c', 3, 'three'));
  const next = store.itemsSince('t', first.revision);
  assert.equal(next.partial, true);
  assert.deepEqual(next.items.map(i => [i.id, i.detail]), [['b', 'output'], ['c', undefined]]);
  assert.notEqual(next.revision, first.revision);
  assert.equal(store.itemsSince('t', 'other-run:0').partial, undefined, 'a revision from another run reads everything');
  assert.equal(store.itemsSince('t', 'nonsense').items.length, 3);
  const boot = first.revision.split(':')[0];
  for (const malformed of [`${boot}:`, `${boot}:1:x`, `${boot}:-1`, `${boot}:1.5`, `${boot}: 1`]) assert.equal(store.itemsSince('t', malformed).partial, undefined, `${malformed} reads everything`);
});

test('removing a paper or deleting a task forgets its timeline revisions', () => {
  const store = new Store(':memory:'), tracked = () => [...(store as unknown as { itemRevisions: Map<string, unknown> }).itemRevisions.keys()].sort();
  store.saveProject({ id: 'paper', name: 'Paper', path: '/unused/paper', createdAt: 1 });
  for (const id of ['kept', 'gone', 'removed']) store.saveTask({ id, projectId: id === 'removed' ? 'other' : 'paper', name: id, title: id, instructions: 'Edit.', worktree: '/unused', threadId: null, turnId: null, model: null, status: 'reviewing', createdAt: 1, updatedAt: 1, feedbackCursor: 0, error: null, review: null });
  for (const taskId of ['kept', 'gone', 'removed']) store.saveItem({ id: taskId + '-item', taskId, type: 'assistant', text: 'Done.', createdAt: 1 });
  assert.deepEqual(tracked(), ['gone', 'kept', 'removed']);
  store.deleteTask('gone');
  assert.deepEqual(tracked(), ['kept', 'removed']);
  store.removeProject('paper');
  assert.deepEqual(tracked(), ['removed'], "another paper's task keeps its revisions");
});

test('old Claude streamed duplicates disappear without hiding legitimate repeated replies', () => {
  const stream = { id: 'task:turn:msg_reply:1', type: 'assistant', text: 'Checking the table.', createdAt: 1 };
  const final = { ...stream, id: 'task:turn:msg_reply:0', status: 'completed', createdAt: 2 };
  const again = { ...final, id: 'task:turn:msg_next:0', createdAt: 3 };
  const otherTurn = { ...stream, id: 'task:other:msg_reply:1' };
  const tool = { ...stream, type: 'command' };
  const different = { ...stream, id: 'task:turn:msg_reply:3', text: 'Different reply' };
  const full = [stream, final, again, otherTurn, tool, different];
  assert.deepEqual(visibleTimeline(full), [final, again, otherTurn, tool, different]);
  assert.equal(full.length, 6, 'historical data is not modified');
  assert.deepEqual(visibleTimeline([stream]), [stream], 'live streaming remains visible');
  assert.deepEqual(visibleTimeline(mergeTimeline([stream], [final])), [final]);
  assert.deepEqual(visibleTimeline([{ ...stream, status: 'completed' }, final]).length, 2, 'real repeated completed blocks are retained');
  const live = { ...stream, id: 'task:turn:msg_reply:2', status: 'inProgress', createdAt: 4 };
  assert.deepEqual(visibleTimeline([...full, live]), [final, again, otherTurn, tool, different, live], 'a later block is not a legacy duplicate');
});

test('legacy duplicates stay hidden when a later final overwrote an earlier record', () => {
  const store = new Store(':memory:');
  try {
    const first = { id: 'task:turn:msg_reply:1', taskId: 'task', type: 'assistant', text: 'Checking the table.', createdAt: 1 };
    const final = { ...first, id: 'task:turn:msg_reply:0', status: 'completed', createdAt: 2 };
    const second = { ...first, id: 'task:turn:msg_reply:2', text: 'It is too wide.', createdAt: 3 };
    store.saveItem(first); store.saveItem(final); store.saveItem(second);
    // Workspace preserves the original createdAt when the old adapter reuses :0.
    store.saveItem({ ...final, text: second.text });
    const items = store.items('task');
    assert.deepEqual(items.map(item => item.id), [first.id, final.id, second.id]);
    assert.deepEqual(visibleTimeline(items), [first, { ...final, text: second.text }]);
  } finally { store.close(); }
});

for (const createdAt of [1, 2]) test(`a repeated Claude block stays visible while streaming, including timestamp ${createdAt}`, () => {
  const store = new Store(':memory:');
  try {
    const first = { id: 'task:turn:msg_reply:1', taskId: 'task', type: 'assistant', text: 'Checking the table.', status: 'completed', createdAt: 1 };
    const second = { id: 'task:turn:msg_reply:2', taskId: 'task', type: 'assistant', text: 'Checking', status: 'inProgress', createdAt };
    store.saveItem(first);
    const initial = store.itemsSince('task');
    store.saveItem(second);
    let revision = initial.revision, items = initial.items;
    const refresh = () => {
      const next = store.itemsSince('task', revision);
      revision = next.revision;
      items = mergeTimeline(items, next.items);
      assert.deepEqual(visibleTimeline(items), items, 'both distinct blocks remain visible after a partial read');
    };
    refresh();
    second.text = first.text;
    store.saveItem(second);
    refresh();
    assert.deepEqual(visibleTimeline(store.items('task')), items, 'reloading without a final event retains the unfinished block');
    second.text += ' It is too wide.';
    store.saveItem(second);
    refresh();
    store.saveItem({ ...second, status: 'completed' });
    refresh();
  } finally { store.close(); }
});

test('agent events find their task and message without reading the whole history', () => {
  const store = new Store(':memory:');
  const task = (id: string, threadId: string | null) => store.saveTask({ id, projectId: 'paper', name: id, title: id, instructions: '', worktree: '', threadId, turnId: null, model: null, status: 'reviewing', createdAt: 1 } as unknown as Parameters<Store['saveTask']>[0]);
  task('old', 'thread-a'); task('none', null); task('new', 'thread-b'); task('again', 'thread-a');
  assert.equal(store.taskByThread('thread-b')?.id, 'new');
  assert.equal(store.taskByThread('thread-a')?.id, 'old', 'the first task with the thread, as before');
  for (const missing of [undefined, null, '', 'thread-c', 7]) assert.equal(store.taskByThread(missing), undefined, `${String(missing)} names no task`);
  store.updateTask('old', { threadId: 'thread-c' });
  assert.equal(store.taskByThread('thread-a')?.id, 'again', 'a rebound thread follows the saved task');
  assert.equal(store.taskByThread('thread-c')?.id, 'old');
  store.deleteTask('again');
  assert.equal(store.taskByThread('thread-a'), undefined);
  const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${TASK_BY_THREAD}`).all('thread-a') as { detail: string }[];
  assert.ok(plan.some(row => row.detail.includes('task_threads')), 'the thread lookup uses its index');
  assert.equal(store.findTask('new')?.id, 'new'); assert.equal(store.findTask('gone'), undefined);
  assert.equal(store.taskProject('new'), 'paper'); assert.equal(store.taskProject('gone'), undefined);
  store.updateTask('new', { projectId: 'other-paper' });
  assert.equal(store.taskProject('new'), 'other-paper', 'the project lookup follows a saved task move');
  assert.equal(store.task('new').projectId, 'other-paper');
  store.saveItem({ id: 'new:1:a', taskId: 'new', type: 'command', text: 'ls', createdAt: 5, detail: 'x'.repeat(40000) });
  assert.equal(store.item('new', 'new:1:a')?.createdAt, 5);
  assert.equal(store.item('old', 'new:1:a'), undefined, 'messages stay with their task');
});
