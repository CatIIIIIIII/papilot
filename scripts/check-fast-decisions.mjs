// Decisions move the review on at once and reach the server one at a time.
// Run after `npm --prefix engine run build`:
//   node --import tsx scripts/check-fast-decisions.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, webkit, expect } from './playwright.mjs';
import { annotateReviewState } from '../src/server/review.ts';

fs.mkdirSync('test-results', { recursive: true });
const server = Fastify();
await server.register(staticFiles, { root: path.resolve('engine/dist/web') });
await server.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.server.address().port}`;
// PAPILOT_BROWSER=webkit runs the same checks in Safari's engine.
const browser = process.env.PAPILOT_BROWSER === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const ids = ['c1', 'c2', 'c3', 'c4'];
const detail = {
  task: 'flow', round: 1, before: 'before', after: 'after', warnings: [], files: '/files/flow/1/', sections: [],
  loose: ids.map(id => ({ kind: 'change', units: [id], identical: false, before: [], after: [] })),
  units: ids.map((id, i) => ({ id, file: 'main.tex', status: 'modified', kind: 'text', whole_file: false, ops: [], old_start: i + 1, old_end: i + 1, new_start: i + 1, new_end: i + 1, old_text: `Original paragraph ${i + 1}`, new_text: `Revised paragraph ${i + 1}`, truncated: false })),
};
const DECIDED = { accept: 'accepted', reject: 'rejected', comment: 'commented' };
// The review engine: decisions keyed by action ID, applied once each.
let task, decisions, actions, applied, posts, held, hold, refuse, unreachable, lose, newest;
function reset(status = 'reviewing') {
  task = { id: 'flow-task', projectId: 'paper', name: 'flow', title: 'Flow', status, deferred: true, createdAt: 1, updatedAt: 1, feedbackCursor: 0, error: null, review: { state: 'reviewing', round: 1, counts: {}, unsent: 0, comments: 0, files: [] } };
  decisions = Object.fromEntries(ids.map(id => [id, 'pending']));
  actions = []; applied = new Map(); posts = []; held = []; hold = false; refuse = null; unreachable = 0; lose = 0; newest = 1;
}
const last = () => actions.at(-1);
const view = (extra = {}) => annotateReviewState({ task: 'flow', title: 'Flow', csrf: 'fixture', closed: false, state: 'reviewing', latest: newest, round: 1, revision: 'after', decisions: { ...decisions }, comments: {}, undo: last() ? { id: last().id, kind: last().kind, changes: last().changes } : null, job: null, ...extra }, [task]);
function apply(route, body) {
  if (route.endsWith('/decide')) {
    if (applied.has(body.id)) return {};
    const before = { ...decisions };
    for (const id of body.changes) decisions[id] = DECIDED[body.action];
    actions.push({ id: body.id, kind: body.action, changes: body.changes, before });
    applied.set(body.id, body);
    return {};
  }
  const action = actions.pop();
  decisions = action.before;
  return { restored: action.changes };
}

async function open(page) {
  await page.route('**/api/tasks/flow/**', async route => {
    const url = new URL(route.request().url());
    const round = /\/rounds\/(\d+)$/.exec(url.pathname);
    if (round) return route.fulfill({ json: { ...detail, round: Number(round[1]) } });
    if (route.request().method() !== 'POST') return route.fulfill({ json: view() });
    // Which view the page shows is no decision.
    if (url.pathname.endsWith('/look')) return route.fulfill({ json: { ok: true } });
    const body = route.request().postDataJSON();
    posts.push({ route: url.pathname.split('/').at(-1), ...body });
    if (hold) await new Promise(resolve => held.push(resolve));
    if (unreachable > 0) { unreachable--; return route.fulfill({ status: 503, json: { error: 'Papilot is restarting after an update. Please wait a moment.' } }); }
    const refusal = refuse?.(body);
    if (refusal) return route.fulfill({ status: 400, json: { error: refusal } });
    const extra = apply(url.pathname, body);
    // Applied, but the reply is lost on the way back.
    if (lose > 0) { lose--; return route.abort('connectionreset'); }
    return route.fulfill({ json: view(extra) });
  });
  await page.goto(`${origin}/?task=flow`);
  await expect(page.locator('.change.current')).toHaveAttribute('data-stop', '0');
}
const decides = () => posts.filter(post => post.route === 'decide');
const current = page => page.locator('.change.current');
const stateOf = (page, index) => page.locator(`.change[data-stop="${index}"]`);
const settle = () => new Promise(resolve => setTimeout(resolve, 400));
const undoKey = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';

try {
  let page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));

  // Fast successive decisions advance at once and go out one at a time.
  reset(); await open(page); hold = true;
  for (const next of ['1', '2', '3']) {
    await page.keyboard.press('a');
    await expect(current(page)).toHaveAttribute('data-stop', next);
  }
  await settle();
  assert.equal(decides().length, 1, 'Only the first decision is in flight');
  for (const index of [0, 1, 2]) await expect(stateOf(page, index)).toHaveAttribute('data-state', 'accepted');
  await expect(page.locator('.review-progress')).toHaveAttribute('aria-valuenow', '3');
  for (let sent = 2; sent <= 3; sent++) {
    held.shift()();
    await expect.poll(() => decides().length).toBe(sent);
  }
  held.shift()();
  await expect.poll(() => decisions.c3).toBe('accepted');
  assert.deepEqual(decides().map(post => post.changes[0]), ['c1', 'c2', 'c3'], 'Server confirmations follow the order of decisions');
  assert.equal(new Set(decides().map(post => post.id)).size, 3);
  await expect(current(page)).toHaveAttribute('data-stop', '3');
  await expect(stateOf(page, 3)).toHaveAttribute('data-state', 'pending');
  // A double click decides only the change it started on.
  hold = false;
  await reloadFresh(page);
  await current(page).locator('button.accept').dblclick();
  await expect(current(page)).toHaveAttribute('data-stop', '1');
  await settle();
  assert.equal(decides().length, 1);
  await expect(stateOf(page, 1)).toHaveAttribute('data-state', 'pending');
  console.log('PASS: fast successive decisions advance at once, reach the server in order, and a double click decides one change');

  // A failure mid-queue returns to that change and says what was not sent.
  await reloadFresh(page); hold = true;
  for (let i = 0; i < 3; i++) await page.keyboard.press('a');
  await expect(current(page)).toHaveAttribute('data-stop', '3');
  held.shift()();
  await expect.poll(() => decides().length).toBe(2);
  refuse = body => body.changes[0] === 'c2' ? "c2 can't be applied: main.tex changed in your manuscript since this round was published. Nothing was written. Comment on the change to have the agent redo it." : null;
  held.shift()();
  await expect(page.locator('.toast')).toContainText("c2 can't be applied");
  await expect(page.locator('.toast')).toContainText('1 later decision was not sent.');
  await expect(current(page)).toHaveAttribute('data-stop', '1');
  await expect(stateOf(page, 0)).toHaveAttribute('data-state', 'accepted');
  for (const index of [1, 2]) await expect(stateOf(page, index)).toHaveAttribute('data-state', 'pending');
  await settle();
  assert.equal(decides().length, 2, 'The decision after the failure was never sent');
  assert.deepEqual(decisions, { c1: 'accepted', c2: 'pending', c3: 'pending', c4: 'pending' });
  hold = false; refuse = null;
  await page.keyboard.press('r');
  await expect.poll(() => decisions.c2).toBe('rejected');
  await expect(current(page)).toHaveAttribute('data-stop', '2');
  console.log('PASS: a refused decision returns to its change with the error; later decisions are shown undecided and reported, not sent');

  // A request that may not have arrived is retried with the same ID.
  await reloadFresh(page);
  unreachable = 1; lose = 1;
  await page.keyboard.press('a');
  await expect(current(page)).toHaveAttribute('data-stop', '1');
  await expect.poll(() => decides().length, { timeout: 10000 }).toBe(3);
  assert.equal(new Set(decides().map(post => post.id)).size, 1, 'Every attempt carries the same action ID');
  assert.equal(actions.length, 1, 'The engine applied it once');
  await expect(stateOf(page, 0)).toHaveAttribute('data-state', 'accepted');
  await expect(page.locator('.toast')).toHaveCount(0);
  console.log('PASS: retries keep the action ID and apply the decision once');

  // Undo takes back a decision that is not sent yet at once, without the server.
  await reloadFresh(page); hold = true;
  await page.keyboard.press('a');
  await page.keyboard.press('a');
  await page.keyboard.press(undoKey);
  await expect(page.locator('.toast')).toContainText('Last decision undone');
  await expect(current(page)).toHaveAttribute('data-stop', '1');
  await expect(stateOf(page, 1)).toHaveAttribute('data-state', 'pending');
  held.shift()();
  await expect.poll(() => decisions.c1).toBe('accepted');
  await settle();
  assert.equal(decides().length, 1, 'The withdrawn decision never reached the server');
  assert.equal(posts.filter(post => post.route === 'undo').length, 0, 'Nothing was undone on the server');
  assert.deepEqual(decisions, { c1: 'accepted', c2: 'pending', c3: 'pending', c4: 'pending' });
  // The decision being sent cannot be withdrawn: Undo waits for it, then
  // undoes it on the server.
  await reloadFresh(page); hold = true;
  await page.keyboard.press('a');
  await expect.poll(() => decides().length).toBe(1);
  await page.keyboard.press(undoKey);
  await settle();
  assert.equal(posts.filter(post => post.route === 'undo').length, 0, 'Undo waits for the decision in flight');
  held.shift()();
  await expect.poll(() => posts.filter(post => post.route === 'undo').length).toBe(1);
  assert.equal(posts.at(-1).id, decides()[0].id, 'It undoes that decision');
  held.shift()();
  await expect(page.locator('.toast')).toContainText('Last decision undone');
  assert.deepEqual(decisions, { c1: 'pending', c2: 'pending', c3: 'pending', c4: 'pending' });
  // If the decision in flight fails, Undo has nothing of the author's to undo.
  await reloadFresh(page); hold = true;
  await page.keyboard.press('a');
  await expect.poll(() => decides().length).toBe(1);
  await page.keyboard.press(undoKey);
  refuse = body => body.changes?.[0] === 'c1' ? 'These changes were already decided. Reload the page.' : null;
  held.shift()();
  await expect(page.locator('.toast')).toContainText('already decided');
  await settle();
  assert.equal(posts.filter(post => post.route === 'undo').length, 0);
  assert.deepEqual(decisions, { c1: 'pending', c2: 'pending', c3: 'pending', c4: 'pending' });
  console.log('PASS: undo drops an unsent decision at once, waits for one in flight, and is dropped if that one fails');

  // Decisions not confirmed when the page goes away (a locked phone, a closed
  // tab) are sent by the next page, and each applies once.
  // One browser profile: the next page reads what the first one stored.
  refuse = null;
  const profile = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 } });
  const first = await profile.newPage();
  first.on('pageerror', error => errors.push(error.message));
  reset(); await open(first); hold = true;
  for (const next of ['1', '2', '3']) {
    await first.keyboard.press('a');
    await expect(current(first)).toHaveAttribute('data-stop', next);
  }
  hold = false;
  await first.close({ runBeforeUnload: true });
  for (const release of held.splice(0)) release();
  const again = await profile.newPage();
  again.on('pageerror', error => errors.push(error.message));
  await again.route('**/api/tasks/flow/**', async route => {
    const url = new URL(route.request().url());
    const round = /\/rounds\/(\d+)$/.exec(url.pathname);
    if (round) return route.fulfill({ json: { ...detail, round: Number(round[1]) } });
    if (route.request().method() !== 'POST') return route.fulfill({ json: view() });
    if (url.pathname.endsWith('/look')) return route.fulfill({ json: { ok: true } });
    // As Papilot's proxy does, a write needs the page's token.
    if (route.request().headers()['x-review-token'] !== 'fixture') return route.fulfill({ status: 403, json: { error: 'This review page has expired. Refresh it and try again.' } });
    const body = route.request().postDataJSON();
    posts.push({ route: url.pathname.split('/').at(-1), ...body });
    return route.fulfill({ json: view(apply(url.pathname, body)) });
  });
  await again.goto(`${origin}/?task=flow`);
  await expect.poll(() => [decisions.c1, decisions.c2, decisions.c3].join()).toBe('accepted,accepted,accepted');
  assert.equal(actions.length, 3, 'Each decision applied once');
  await expect.poll(() => again.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('latex-review:queue:')).length)).toBe(0);
  await profile.close();
  console.log('PASS: decisions a page left unconfirmed are sent by the next page, once each');

  // While the agent edits a deferred task, accepting and rejecting go on (a
  // reject waits in the engine for the turn to end); undoing an applied
  // rejection and editing source wait.
  hold = false; refuse = null;
  await reloadFresh(page, 'running');
  await expect(page.locator('#review-lock')).toContainText("The agent is editing this task's files");
  await expect(current(page).locator('button.accept')).toBeEnabled();
  await expect(current(page).locator('button.comment')).toBeEnabled();
  await expect(current(page).locator('button.reject')).toBeEnabled();
  await expect(page.locator('.reject-all')).toBeEnabled();
  await expect(page.locator('.accept-all')).toBeEnabled();
  await page.keyboard.press('r');
  await expect.poll(() => decisions.c1).toBe('rejected');
  await page.keyboard.press('a');
  await expect.poll(() => decisions.c2).toBe('accepted');
  await page.keyboard.press(undoKey);
  await expect.poll(() => decisions.c2).toBe('pending');
  // An undo of a rejection the engine already applied writes files: it waits.
  task.status = 'reviewing';
  await page.waitForTimeout(1700);
  await page.keyboard.press('r');
  await expect.poll(() => decisions.c2).toBe('rejected');
  task.status = 'running';
  await expect(page.locator('#review-lock')).toBeVisible({ timeout: 4000 });
  await page.keyboard.press(undoKey);
  await expect(page.locator('.toast')).toContainText('Pause it before editing changes or undoing a rejection');
  await settle();
  assert.equal(posts.filter(post => post.route === 'undo').length, 1, 'Undoing an applied rejection waits for the agent');
  await page.screenshot({ path: 'test-results/fast-decisions-agent-running.png' });
  console.log('PASS: during the agent turn accept, reject, comment and undoing an accept stay available; undoing an applied rejection says why it waits');

  // A comment written while a newer round arrives goes out on its own round.
  await reloadFresh(page);
  await current(page).locator('button.comment').click();
  await page.locator('#composer-text').fill('Keep the original wording here.');
  newest = 2;
  await expect(current(page).locator('button.accept')).toBeDisabled({ timeout: 4000 });
  await page.locator('.composer-send').click();
  await expect.poll(() => decides().length).toBe(1);
  assert.deepEqual([decides()[0].action, decides()[0].round, decides()[0].changes], ['comment', 1, ['c1']], 'The comment names the round it was written on');
  await expect(page.locator('.composer')).toHaveCount(0);
  await expect(page.locator('.toast')).toContainText('Changes are ready');
  console.log('PASS: a comment written while a newer round arrives is sent on the round it was written on');

  // The same flow by touch on a phone.
  const phone = await browser.newPage({ locale: 'en-US', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  phone.on('pageerror', error => errors.push(error.message));
  reset(); await open(phone); hold = true;
  for (const next of ['1', '2']) {
    await current(phone).locator('button.accept').tap();
    await expect(current(phone)).toHaveAttribute('data-stop', next);
  }
  await expect(current(phone).locator('button.accept')).toBeInViewport();
  await phone.screenshot({ path: 'test-results/fast-decisions-phone.png' });
  while (held.length || decides().length < 2) { if (held.length) held.shift()(); await new Promise(resolve => setTimeout(resolve, 50)); }
  await expect.poll(() => decisions.c2).toBe('accepted');
  const width = await phone.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  assert.ok(width[0] <= width[1], `No horizontal scroll at phone width (${width})`);
  console.log('PASS: on a 390×844 phone, taps advance at once and the next change\'s controls stay in view');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}

async function reloadFresh(page, status) {
  reset(status);
  await page.addInitScript(() => localStorage.clear());
  await page.reload();
  await expect(current(page)).toHaveAttribute('data-stop', '0');
}
