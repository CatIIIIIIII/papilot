import test from 'node:test';
import assert from 'node:assert/strict';
import type { Task, TaskStatus } from '../src/shared.ts';
import { taskSaveStatus } from '../src/web/task-save-status.ts';

const task = (overrides: Partial<Task> = {}): Task => ({
  id: 'task', projectId: 'paper', name: 'revision', title: 'Revise the paper', instructions: '',
  worktree: '/unused', threadId: null, turnId: null, model: null, status: 'reviewing',
  createdAt: 1, updatedAt: 1, feedbackCursor: 0, error: null,
  review: { state: 'done', round: 1, counts: { accepted: 1 }, files: [] },
  ...overrides,
});
const committed = { hash: 'commit', accepted: 'accepted', at: 1 };

test('saved task status distinguishes local commits, confirmed pushes and applied changes', () => {
  assert.equal(taskSaveStatus(task()), null);
  assert.equal(taskSaveStatus(task({ committed })), 'committed');
  assert.equal(taskSaveStatus(task({ committed: { ...committed, pushed: true } })), 'pushed');
  assert.equal(taskSaveStatus(task({ deferred: true, delivery: { mode: 'branch', accepted: 'accepted', commit: 'branch-commit' } })), null);
  assert.equal(taskSaveStatus(task({ deferred: true, delivery: { mode: 'commit', accepted: 'accepted', commit: 'main-commit', branch: 'main' } })), 'committed');
  assert.equal(taskSaveStatus(task({ deferred: true, delivery: { mode: 'workspace', accepted: 'accepted' } })), 'applied');
  assert.equal(taskSaveStatus(task({ deferred: true, committed })), null, 'isolated tasks use their own delivery');
});

test('new work and unfinished reviews take precedence over an earlier saved result', () => {
  const saved = task({ committed: { ...committed, pushed: true } });
  for (const status of ['running', 'queued', 'building', 'waiting_input', 'interrupted', 'failed', 'uncertain', 'deleting'] as TaskStatus[]) {
    assert.equal(taskSaveStatus({ ...saved, status }), null, status);
  }
  const reviews: Task['review'][] = [
    null,
    { ...saved.review!, state: 'reviewing', round: 2, counts: { pending: 1 } },
    { ...saved.review!, state: 'revise', counts: { commented: 1 } },
    { ...saved.review!, round: 2, files: ['main.tex'] },
    { ...saved.review!, files: undefined },
    { ...saved.review!, round: null },
  ];
  for (const review of reviews) assert.equal(taskSaveStatus({ ...saved, review }), null);
  assert.equal(taskSaveStatus({ ...saved, pendingReview: { route: '/undo', body: {}, previousStatus: 'reviewing' } }), null);
  assert.equal(taskSaveStatus({ ...saved, deferred: true, delivery: { mode: 'branch', accepted: 'accepted', commit: 'next', pending: true } }), null);
});
