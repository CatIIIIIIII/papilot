import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { annotateReviewState } from '../src/server/review.ts';
import type { Task, TaskStatus } from '../src/shared.ts';
import type { PageState, RoundDetail } from '../engine/src/types.ts';

const task = (status: TaskStatus = 'reviewing'): Task => ({
  id: 'task-1', projectId: 'project-1', name: 'example', title: 'Example', instructions: '',
  worktree: '/tmp/example', threadId: null, turnId: null, model: null, status,
  createdAt: 1, updatedAt: 1, feedbackCursor: 0, error: null, review: null,
});
const state = (): PageState => ({
  task: 'example', title: 'Example', csrf: 'fixture', closed: false, state: 'reviewing',
  latest: 1, round: 1, revision: 'after', decisions: { first: 'pending', second: 'pending' },
  comments: {}, undo: { id: 'previous-action', kind: 'accept', changes: ['previous'] }, job: null,
});
const annotate = (tasks: Task[], value = state()) => annotateReviewState(value, tasks) as PageState;

test('viewer receives the agent lifecycle and remaining feedback separately from engine decisions', () => {
  const ready = { ...task(), review: { state: 'done', round: 1, counts: { accepted: 2 }, unsent: 2, comments: 1, files: ['main.tex'] } };
  const input = state();
  assert.deepEqual(annotate([ready], input).workspace, { status: 'reviewing', unsent: 2, comments: 1, accepted: 1 });
  assert.deepEqual(annotate([{ ...ready, status: 'running', review: { ...ready.review, unsent: 0, comments: 0 } }]).workspace, { status: 'running', unsent: 0, comments: 0, accepted: 1 });
  assert.deepEqual(annotate([task()]).workspace, { status: 'reviewing', unsent: 0, comments: 0, accepted: 0 });
  assert.equal(annotate([]).workspace, undefined);
  assert.equal(input.workspace, undefined);
});

test('active task state blocks every file decision while preserving comments', () => {
  for (const status of ['running', 'waiting_input', 'queued', 'building', 'uncertain'] as const) {
    const result = annotate([task(status)]);
    assert.ok(result.decisionLock, status);
    assert.equal(result.commentLock, null, status);
    assert.match(result.decisionLock, /accepting, rejecting, or undoing/);
  }
  assert.match(annotate([task('building')]).decisionLock!, /PDF build/);
  assert.match(annotate([task('uncertain')]).decisionLock!, /Check status/);
});

test('a pending review action remains locked and fresh ready state clears stale locks', () => {
  const pending = { ...task(), pendingReview: { route: '/decide', body: { id: 'decision-1' }, previousStatus: 'reviewing' as const } };
  assert.match(annotate([pending]).decisionLock!, /current review action/);
  for (const status of ['idle', 'reviewing', 'interrupted', 'failed'] as const) {
    const stale = { ...state(), decisionLock: 'Old lock', commentLock: 'Old lock' };
    const result = annotate([task(status)], stale);
    assert.equal(result.decisionLock, null, status);
    assert.equal(result.commentLock, null, status);
    assert.equal(stale.decisionLock, 'Old lock', 'Do not mutate the engine response');
  }
});

test('missing, unowned, deleting, and closed review pages cannot offer writes', () => {
  for (const tasks of [[], [{ ...task(), name: 'another-task' }], [task('deleting')]]) {
    const result = annotate(tasks);
    assert.ok(result.decisionLock);
    assert.equal(result.commentLock, result.decisionLock);
  }
  const result = annotate([task()], { ...state(), closed: true });
  assert.match(result.decisionLock!, /finished/);
  assert.equal(result.commentLock, result.decisionLock);
});

test('state annotation preserves decision response extras and ignores non-state payloads', () => {
  const response = { ...state(), restored: ['first'] };
  assert.deepEqual((annotateReviewState(response, [task()]) as typeof response).restored, ['first']);
  for (const value of [null, 'html', Buffer.from('asset'), [{ task: 'example' }], { task: 'example', round: 1, units: [] }, { error: 'Try again' }]) {
    assert.equal(annotateReviewState(value, [task('running')]), value);
  }
});

// Opt in after building the engine's viewer:
// PAPILOT_REVIEW_BROWSER=1 npx tsx --test tests/review-state.test.ts
test('viewer locks buttons and keyboard decisions, permits comments, and follows lock changes', {
  skip: process.env.PAPILOT_REVIEW_BROWSER !== '1', timeout: 30000,
}, async () => {
  const [{ default: Fastify }, { default: staticFiles }] = await Promise.all([
    import('fastify'), import('@fastify/static'),
  ]);
  const { chromium, expect } = createRequire(import.meta.url)('../engine/node_modules/@playwright/test') as typeof import('../engine/node_modules/@playwright/test/index.js');
  const server = Fastify();
  await server.register(staticFiles, { root: new URL('../engine/dist/web', import.meta.url).pathname });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
    const page = await browser.newPage();
    await page.clock.install();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    let tasks = [task('running')];
    let standalone = false;
    let current = state();
    const writes: Record<string, unknown>[] = [];
    const detail: RoundDetail = {
      task: 'example', round: 1, before: 'before', after: 'after', warnings: [], files: '/files/example/1/', sections: [],
      loose: [{ kind: 'change', units: ['first', 'second'], identical: false, before: [], after: [] }],
      units: ['first', 'second'].map((id, i) => ({
        id, file: 'paper.tex', status: 'modified', kind: 'text', whole_file: false, ops: [],
        old_start: i + 1, old_end: i + 1, new_start: i + 1, new_end: i + 1,
        old_text: 'Before', new_text: 'After', truncated: false,
      })),
    };
    await page.route('**/api/tasks/example/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/rounds/1')) return route.fulfill({ json: detail });
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        writes.push(body);
        if (body.action === 'comment') current.comments.first = body.body;
      }
      return route.fulfill({ json: standalone ? current : annotate(tasks, current) });
    });
    await page.goto(`${origin}/?task=example`);
    await expect(page.locator('.change.current')).toBeVisible();
    await expect(page.locator('#review-lock')).toContainText('Pause this task');
    const decisions = page.locator('button.accept, button.reject, button.undo');
    assert.ok(await decisions.count() >= 6, 'Includes the dock, individual units, Accept all, and Undo');
    for (const button of await decisions.all()) await expect(button).toBeDisabled();
    for (const button of await page.locator('button.comment').all()) await expect(button).toBeEnabled();
    for (const key of ['a', 'r', 'u', process.platform === 'darwin' ? 'Meta+z' : 'Control+z']) await page.keyboard.press(key);
    assert.equal(writes.length, 0, 'Keyboard shortcuts do not bypass the lock');
    await page.keyboard.press('c');
    await page.locator('#composer-text').fill('Comment while the task runs');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.composer')).toHaveCount(0);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].action, 'comment');

    tasks = [task('reviewing')];
    await page.clock.fastForward(1600);
    await expect(page.locator('#review-lock')).toHaveCount(0);
    for (const button of await decisions.all()) await expect(button).toBeEnabled();
    await page.keyboard.press('a');
    await expect.poll(() => writes.length).toBe(2);
    assert.equal(writes[1].action, 'accept');
    await expect(page.locator('.accept-all')).toBeEnabled();

    await page.keyboard.press('c');
    await page.locator('#composer-text').fill('Keep this unsent draft');
    tasks = [];
    await page.clock.fastForward(1600);
    await expect(page.locator('#review-lock')).toContainText('no longer available');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    assert.equal(writes.length, 2, 'A stale composer cannot submit after task removal');
    await expect(page.locator('#composer-text')).toHaveValue('Keep this unsent draft');
    await page.keyboard.press('Escape');
    for (const button of await page.locator('button.comment').all()) await expect(button).toBeDisabled();

    standalone = true;
    current = state();
    await page.reload();
    await expect(page.locator('.change.current')).toBeVisible();
    await expect(page.locator('#review-lock')).toHaveCount(0);
    for (const button of await decisions.all()) await expect(button).toBeEnabled();
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); }
});
