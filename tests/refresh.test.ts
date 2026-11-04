import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadRequest, canStreamUpdates, mergeTimeline } from '../src/web/refresh.ts';
import { Store } from '../src/server/store.ts';

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
