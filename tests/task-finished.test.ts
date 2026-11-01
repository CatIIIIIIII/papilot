import test from 'node:test';
import assert from 'node:assert/strict';
import { taskFinished, type Task, type TaskStatus } from '../src/shared.ts';

const task = (overrides: Partial<Task> = {}): Task => ({
  id: 'task', projectId: 'paper', name: 'revision', title: 'Revise the paper', instructions: '',
  worktree: '/unused', threadId: null, turnId: null, model: null, status: 'reviewing',
  createdAt: 1, updatedAt: 1, feedbackCursor: 0, error: null,
  review: { state: 'done', round: 1, counts: { accepted: 2 }, unsent: 2, comments: 0, files: ['main.tex'] },
  ...overrides,
});
const isolated = (overrides: Partial<Task> = {}) => task({ deferred: true, review: { state: 'done', round: 1, counts: { accepted: 2 }, unsent: 2, comments: 0, files: [] }, delivery: { mode: 'workspace', accepted: 'accepted' }, ...overrides });

test('a decided review whose accepted changes left the task is finished', () => {
  assert.equal(taskFinished(task()), true, 'older tasks accept straight into the working directory');
  assert.equal(taskFinished(task({ committed: { hash: 'abc', accepted: 'accepted', at: 1, pushed: true } })), true);
  assert.equal(taskFinished(isolated()), true, 'applied to the working directory');
  assert.equal(taskFinished(isolated({ delivery: { mode: 'branch', accepted: 'accepted', branch: 'papilot/revision', commit: 'abc' } })), false, 'task branch still needs manuscript application');
  assert.equal(taskFinished(task({ review: { state: 'done', round: 1, counts: { accepted: 1, rejected: 1 }, unsent: 2, comments: 0, files: [] } })), true, 'a mixed review needs no feedback');
  assert.equal(taskFinished(task({ review: { state: 'done', round: null, counts: {}, unsent: 0, comments: 0 } })), true, 'an answer without manuscript changes');
});

test('work, decisions or feedback still waiting keep a task unfinished', () => {
  for (const status of ['idle', 'queued', 'running', 'waiting_input', 'building', 'interrupted', 'failed', 'uncertain', 'deleting'] as TaskStatus[]) assert.equal(taskFinished(task({ status })), false, status);
  const reviews: Task['review'][] = [
    null,
    { state: 'reviewing', round: 2, counts: { pending: 1, accepted: 1 }, unsent: 1, comments: 0, files: [] },
    { state: 'revise', round: 1, counts: { commented: 1 }, unsent: 1, comments: 1, files: [] },
    { state: 'done', round: 1, counts: { rejected: 3 }, unsent: 3, comments: 0, files: [] },
    { state: 'build_failed', round: null, counts: {}, unsent: 0, comments: 0 },
  ];
  for (const review of reviews) assert.equal(taskFinished(task({ review })), false, JSON.stringify(review));
  assert.equal(taskFinished(task({ pendingReview: { route: '/undo', body: {}, previousStatus: 'reviewing' } })), false);
  assert.equal(taskFinished(isolated({ review: { ...isolated().review!, files: ['main.tex'] }, delivery: null })), false, 'accepted changes still isolated');
  assert.equal(taskFinished(isolated({ review: { ...isolated().review!, files: undefined } })), false, 'unknown accepted files');
  assert.equal(taskFinished(isolated({ delivery: { mode: 'branch', accepted: 'accepted', pending: true } })), false, 'delivery in progress');
});
