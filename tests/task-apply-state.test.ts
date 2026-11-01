import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskApplyState } from '../src/web/task-apply-state.ts';

test('Chat and PDF share application progress, suppress concurrent clicks and permit retries', async () => {
  const state = new TaskApplyState();
  let release!: () => void, calls = 0;
  const first = state.apply(() => { calls++; return new Promise<void>(resolve => { release = resolve; }); });
  assert.equal(state.getSnapshot().busy, true);
  await state.apply(async () => { calls++; });
  assert.equal(calls, 1);
  release(); await first;
  await state.apply(async () => { calls++; });
  assert.equal(calls, 2, 'A stale UI or a later application can safely retry the idempotent endpoint');
  await state.apply(async () => { throw new Error('Connection lost'); });
  assert.equal(state.getSnapshot().error, 'Connection lost');
  assert.equal(state.getSnapshot().busy, false);
  await state.apply(async () => undefined);
  assert.equal(state.getSnapshot().error, '');
  assert.equal(state.getSnapshot().busy, false);
});


test('commit and apply share the same lock and generated messages never replace author edits', async () => {
  const state = new TaskApplyState('Task title');
  let finish!: (message: string) => void;
  const writing = state.write(() => new Promise(resolve => { finish = resolve; }));
  state.edit('Author message');
  finish('Generated message'); await writing;
  assert.equal(state.getSnapshot().message, 'Author message');
  let release!: () => void, applied = false;
  const commit = state.apply(() => new Promise<void>(resolve => { release = resolve; }), 'commit');
  await state.apply(async () => { applied = true; });
  assert.equal(applied, false);
  release(); await commit;
  assert.equal(state.getSnapshot().message, 'Author message');
  await state.apply(async () => { applied = true; });
  assert.equal(applied, true, 'A conflict response does not disable the confirmation');
});
