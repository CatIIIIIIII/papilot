import test from 'node:test';
import assert from 'node:assert/strict';
import type { PendingRequest, Snapshot, Task } from '../src/shared.ts';
import { NOTIFICATION_EVENTS, taskAlerts, type NotificationEvents } from '../src/web/notifications.ts';

const base: Task = { id: 'a', projectId: 'p', name: 'p-a', title: 'Tighten the abstract', instructions: '', worktree: '/tmp/a', threadId: null, turnId: null, model: null, status: 'running', createdAt: 1, updatedAt: 1, feedbackCursor: 0, error: null, review: null };
const snapshot = (tasks: Partial<Task>[], requests: PendingRequest[] = []): Snapshot => ({ projects: [], tasks: tasks.map(task => ({ ...base, ...task })), requests, runtime: { connected: true, authenticated: true, account: null, error: null, models: [] }, version: 'test' });
const request = (method: string): PendingRequest => ({ id: 'r1', taskId: 'a', method, params: {}, createdAt: 1 });

test('a new question or approval request asks for the author', () => {
  assert.deepEqual(taskAlerts(snapshot([{}]), snapshot([{ status: 'waiting_input', agent: 'claude' }], [request('item/tool/requestUserInput')])), [{ taskId: 'a', event: 'input', title: 'Claude needs your input', body: 'Tighten the abstract' }]);
  assert.equal(taskAlerts(snapshot([{}]), snapshot([{ status: 'waiting_input' }], [request('item/commandExecution/requestApproval')]))[0].title, 'Codex is waiting for your approval');
  // A request already seen is not announced again.
  assert.deepEqual(taskAlerts(snapshot([{ status: 'waiting_input' }], [request('item/tool/requestUserInput')]), snapshot([{ status: 'waiting_input' }], [request('item/tool/requestUserInput')])), []);
});

test('a finished build announces the review, or that the agent finished without changes', () => {
  const ready = taskAlerts(snapshot([{ status: 'building' }]), snapshot([{ status: 'reviewing', review: { state: 'reviewing', round: 1, counts: { pending: 3 } } }]));
  assert.equal(ready[0].title, 'Review ready · 3 changes to decide');
  const one = taskAlerts(snapshot([{ status: 'building' }]), snapshot([{ status: 'reviewing', review: { state: 'reviewing', round: 1, counts: { pending: 1 } } }]));
  assert.equal(one[0].title, 'Review ready · 1 change to decide');
  const none = taskAlerts(snapshot([{ status: 'building' }]), snapshot([{ status: 'reviewing', review: { state: 'done', round: 1, counts: { pending: 0 } } }]));
  assert.equal(none[0].title, 'Codex finished');
});

test('errors are announced once; pausing and unchanged or new tasks are not', () => {
  const failed = taskAlerts(snapshot([{}]), snapshot([{ status: 'failed', error: '\nlatexmk exited with code 12\nmore' }]));
  assert.deepEqual(failed, [{ taskId: 'a', event: 'error', title: 'A task needs attention', body: 'Tighten the abstract\nlatexmk exited with code 12' }]);
  assert.deepEqual(taskAlerts(snapshot([{ status: 'failed' }]), snapshot([{ status: 'failed' }])), []);
  assert.deepEqual(taskAlerts(snapshot([{}]), snapshot([{ status: 'interrupted' }])), []);
  assert.equal(taskAlerts(snapshot([{}]), snapshot([{ status: 'interrupted', error: 'Codex disconnected.' }])).length, 1);
  assert.deepEqual(taskAlerts(snapshot([]), snapshot([{ status: 'failed' }])), []);
});

test('completion still notifies when a fast build falls between snapshots', () => {
  for (const status of ['running', 'queued', 'waiting_input'] as const) {
    const done = snapshot([{ status: 'reviewing', review: { state: 'done', round: 1, counts: { pending: 0 } } }]);
    assert.equal(taskAlerts(snapshot([{ status }]), done)[0].event, 'finished');
    assert.deepEqual(taskAlerts(done, done), []);
  }
});

test('recovering a review decision does not announce another task completion', () => {
  const previous = snapshot([{ status: 'uncertain', pendingReview: { route: '/api/tasks/p-a/accept', body: {}, previousStatus: 'reviewing' } }]);
  const recovered = snapshot([{ status: 'reviewing', pendingReview: null, review: { state: 'done', round: 1, counts: { pending: 0 } } }]);
  assert.deepEqual(taskAlerts(previous, recovered), []);
});

test('each notification scenario can be muted independently', () => {
  const all: NotificationEvents = { input: true, approval: true, review: true, finished: true, error: true };
  const cases = {
    input: [snapshot([{}]), snapshot([{ status: 'waiting_input' }], [request('item/tool/requestUserInput')])],
    approval: [snapshot([{}]), snapshot([{ status: 'waiting_input' }], [request('item/commandExecution/requestApproval')])],
    review: [snapshot([{ status: 'building' }]), snapshot([{ status: 'reviewing', review: { state: 'reviewing', round: 1, counts: { pending: 3 } } }])],
    finished: [snapshot([{ status: 'building' }]), snapshot([{ status: 'reviewing', review: { state: 'done', round: 1, counts: { pending: 0 } } }])],
    error: [snapshot([{}]), snapshot([{ status: 'failed', error: 'Build failed' }])],
  };
  for (const muted of NOTIFICATION_EVENTS) {
    for (const event of NOTIFICATION_EVENTS) {
      const [previous, next] = cases[event];
      assert.deepEqual(taskAlerts(previous, next, { ...all, [muted]: false }).map(alert => alert.event), event === muted ? [] : [event], `${muted} disabled, ${event} triggered`);
    }
  }
  const none: NotificationEvents = { input: false, approval: false, review: false, finished: false, error: false };
  for (const [previous, next] of Object.values(cases)) assert.deepEqual(taskAlerts(previous, next, none), []);
  for (const status of ['uncertain', 'interrupted'] as const) {
    assert.deepEqual(taskAlerts(snapshot([{}]), snapshot([{ status, error: 'Agent disconnected' }]), { ...all, error: false }), []);
  }
});

test('muting questions does not hide a simultaneous approval request', () => {
  const next = snapshot([{ status: 'waiting_input' }], [request('item/tool/requestUserInput'), { ...request('item/commandExecution/requestApproval'), id: 'r2' }]);
  const events: NotificationEvents = { input: false, approval: true, review: true, finished: true, error: true };
  assert.deepEqual(taskAlerts(snapshot([{}]), next, events).map(alert => alert.event), ['approval']);
  assert.deepEqual(taskAlerts(next, next, events), []);
});
