import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskCommitDraft } from '../src/web/task-commit-draft.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('automatic generation is shared across mounts and never overwrites edits made while waiting', async () => {
  const draft = new TaskCommitDraft(), gate = deferred<string>();
  let requests = 0;
  const generate = async () => { requests++; return gate.promise; };
  const writing = draft.write(generate);
  await draft.write(generate);
  draft.edit('My own summary');
  gate.resolve('Generated summary'); await writing;
  assert.equal(draft.getSnapshot().message, 'My own summary');
  await draft.write(generate);
  assert.equal(requests, 1);
  await draft.write(async fresh => { assert.equal(fresh, true); return 'A new summary'; }, true);
  assert.equal(draft.getSnapshot().message, 'A new summary');
});

test('manual commit can proceed during generation; duplicate sends and late replies are ignored', async () => {
  const draft = new TaskCommitDraft(), generation = deferred<string>(), submission = deferred<string>();
  const writing = draft.write(() => generation.promise);
  draft.edit('  My message  ');
  const messages: string[] = [];
  const send = async (message: string) => { messages.push(message); return submission.promise; };
  const submitting = draft.submit('commit', send);
  await draft.submit('commit', send);
  generation.resolve('Too late'); await writing;
  assert.equal(draft.getSnapshot().message, '  My message  ');
  submission.resolve('Committed abc1234'); await submitting;
  await draft.submit('commit', send);
  assert.deepEqual(messages, ['My message']);
  assert.equal(draft.getSnapshot().result, 'Committed abc1234');
});

test('generation and commit errors keep manual editing and retry available', async () => {
  const draft = new TaskCommitDraft();
  await draft.write(async () => { throw new Error('Agent unavailable'); });
  assert.equal(draft.getSnapshot().error, 'Agent unavailable');
  draft.edit('Manual summary');
  await draft.submit('commit', async () => { throw new Error('Commit failed'); });
  assert.equal(draft.getSnapshot().message, 'Manual summary');
  assert.equal(draft.getSnapshot().error, 'Commit failed');
  assert.equal(draft.getSnapshot().busy, '');
  await draft.submit('commit', async () => 'Committed');
  assert.equal(draft.getSnapshot().result, 'Committed');
});
