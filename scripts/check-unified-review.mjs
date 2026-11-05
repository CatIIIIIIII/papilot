import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from '../engine/node_modules/@playwright/test/index.mjs';
import { annotateReviewState, rewriteReviewHtml } from '../src/server/review.ts';

fs.mkdirSync('test-results', { recursive: true });
const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15000);
const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error('PAGE ERROR', error.message); });
const prefix = '/review/paper';
const task = { id: 'review-flow-fixture', projectId: 'paper', name: 'flow', title: 'Review the new wording', status: 'reviewing', createdAt: 1, updatedAt: 1, review: { state: 'reviewing', round: 1, counts: {}, unsent: 0 } };
const snapshot = { version: 'test', csrf: 'fixture', projects: [{ id: 'paper', name: 'Paper', path: '/tmp/paper' }], tasks: [task], requests: [], runtime: { connected: true, authenticated: true, models: [] } };
let latest = 1, serial = 0, undo = null;
let failSend = false;
const sent = [];
let effectFixture = false, effectRequests = 0;
const rounds = { 1: { first: 'pending', second: 'pending', third: 'pending', fourth: 'pending' } };
const actions = [], writes = [], messageRequests = [], commitRequests = [], applyRequests = [], archiveRequests = [], deleteRequests = [];
let gitFiles = [];
let pushError, conflictOnApply = false, combinedOnCommit = false;
let timeline = [];
let noteResults = [];
const state = round => ({ task: 'flow', title: task.title, csrf: 'fixture', closed: false, state: task.review.state, latest, history: Object.keys(rounds).map(number => ({ number: Number(number), created: 1793322000 + Number(number) * 120 })), round, revision: `after-${round}`, decisions: rounds[round], comments: {}, undo, job: null });
function update() {
  const values = Object.values(rounds[latest]);
  task.review.counts = Object.fromEntries(['pending', 'accepted', 'rejected', 'commented'].map(value => [value, values.filter(v => v === value).length]));
  task.review.state = values.includes('pending') ? 'reviewing' : values.includes('commented') ? 'revise' : 'done';
}
update();
const image = (name, label) => ({ src: `${name}.svg`, clean: `${name}-clean.svg`, width: 600, height: 130, page: 0, label: '1', text: [{ chars: [{ text: label, rect: [60, 40, 500, 62] }] }] });
const effectPlace = name => ({ page: '2', section: 'Contents', before: [image(`${name}-old`, 'Section 2')], after: [image(`${name}-new`, 'Section 3')] });
function detail(round) {
  const ids = Object.keys(rounds[round]);
  const groups = round === 1 ? [['first'], ['second'], ['third', 'fourth']] : [['new']];
  const result = { task: 'flow', round, before: `before-${round}`, after: `after-${round}`, warnings: [], files: `${prefix}/files/flow/${round}/`,
    sections: [{ node: 'intro', title: 'Introduction', number: '1', blocks: groups.map((units, i) => ({ kind: 'change', units, identical: false, before: [image(`before-${i}`, `Original paragraph ${i + 1}.`)], after: [image(`after-${i}`, `Revised paragraph ${i + 1}.`)] })) }], loose: [],
    units: ids.map((id, i) => ({ id, file: 'main.tex', status: 'modified', kind: 'text', whole_file: false, ops: [], old_start: i + 1, old_end: i + 1, new_start: i + 1, new_end: i + 1, old_text: `Original paragraph ${i + 1}`, new_text: `Revised paragraph ${i + 1}`, truncated: false })) };
  if (effectFixture && round === 1) {
    for (const [i, visual] of ['text', 'unmapped', 'identical'].entries()) Object.assign(result.units[i], {
      visual, effects: { total: i === 0 ? 2 : 1, shown: [effectPlace(`effect-${i}`)] },
    });
    // A macro definition has no crop of its own; its uses are its preview.
    Object.assign(result.units[1], { file: 'macros.tex', old_text: '\\newcommand{\\term}{Old}', new_text: '\\newcommand{\\term}{New}' });
    Object.assign(result.sections[0].blocks[1], { before: [], after: [] });
  }
  return result;
}
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/indirect-changes') return route.fulfill({ json: { indirectChanges: false } });
  if (url.pathname === '/api/updates') return route.fulfill({ json: { currentVersion: snapshot.version, latestVersion: null, phase: 'idle', checkedAt: 1, error: null, canUpdate: true } });
  if (url.pathname === '/api/state') return route.fulfill({ json: snapshot });
  if (url.pathname.endsWith('/skills')) return route.fulfill({ json: { skills: [] } });
  if (url.pathname === '/api/tasks/question-fixture/items') return route.fulfill({ json: { items: [{ id: 'answer', taskId: 'question-fixture', type: 'assistant', text: 'This equation expresses conservation of mass.', createdAt: 1 }] } });
  if (url.pathname.endsWith('/items')) return route.fulfill({ json: { items: timeline } });
  if (url.pathname.endsWith('/note-results')) return route.fulfill({ json: { notes: noteResults } });
  if (url.pathname.endsWith('/delete')) {
    deleteRequests.push(route.request().postDataJSON());
    snapshot.tasks = snapshot.tasks.filter(item => item.id !== task.id);
    return route.fulfill({ json: { ok: true } });
  }
  if (url.pathname.endsWith('/archive')) {
    const body = route.request().postDataJSON(); archiveRequests.push(body);
    task.archivedAt = body.archived ? Date.now() : null;
    return route.fulfill({ json: task });
  }
  if (url.pathname.endsWith('/git')) return route.fulfill({ json: { branch: 'main', upstream: 'origin/main', remote: true, ahead: 0, behind: 0, head: null, files: gitFiles } });
  if (url.pathname.endsWith('/manuscript')) return route.fulfill({ json: { git: { branch: 'main', remote: true, ahead: 0, behind: 0, head: null, files: gitFiles }, build: { status: 'building', current: false }, annotations: [] } });
  if (url.pathname.endsWith('/git/message') || url.pathname.endsWith('/commit-message')) { messageRequests.push(route.request().postDataJSON()); return route.fulfill({ json: { message: 'Explain the method', agent: 'codex' } }); }
  if (url.pathname.endsWith('/apply')) {
    const body = route.request().postDataJSON();
    applyRequests.push(body);
    if (conflictOnApply) {
      conflictOnApply = false; task.status = 'queued';
      task.reconciliation = { id: 'merge-fixture', round: latest, files: ['main.tex'], ready: true, intent: { mode: body.mode, message: body.message || '' } };
      return route.fulfill({ json: { reconciliation: task.reconciliation } });
    }
    if (combinedOnCommit && body.mode === 'commit' && body.confirmation !== 'combined-version') return route.fulfill({ json: { commitReview: { token: 'combined-version', files: ['main.tex'], diff: '-Original title\n+Final reviewed title' } } });
    combinedOnCommit = false;
    task.review.files = []; task.reconciliation = null;
    task.delivery = { mode: body.mode || 'workspace', accepted: 'accepted', ...(body.mode === 'commit' ? { branch: 'main', commit: 'abc1234' } : {}) };
    if (body.mode === 'commit') commitRequests.push(body);
    return route.fulfill({ json: { delivery: task.delivery } });
  }
  if (url.pathname.endsWith('/commit')) {
    const body = route.request().postDataJSON();
    commitRequests.push(body); gitFiles = []; task.review.files = [];
    if (task.deferred) task.delivery = { mode: 'branch', branch: 'papilot/flow', commit: 'abc1234', accepted: 'accepted' };
    else task.committed = { hash: 'abc1234', accepted: `accepted-${commitRequests.length}`, at: Date.now(), pushed: body.push && !pushError };
    return route.fulfill({ json: { commit: 'abc1234', pushError, git: { branch: 'main', upstream: 'origin/main', remote: true, ahead: 0, behind: 0, head: { hash: 'abc1234', subject: 'Explain the method', date: 2 }, files: [] } } });
  }
  if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
  if (url.pathname.endsWith('/messages')) { const message = route.request().postDataJSON(); sent.push(message); if (failSend) return route.fulfill({ status: 503, json: { error: 'Try again.' } }); task.review.unsent = 0; task.review.comments = 0; return route.fulfill({ json: { ok: true } }); }
  throw Error(`Unexpected app request ${url.pathname}`);
});
await page.route('**/review/**', async route => {
  const url = new URL(route.request().url()), relative = url.pathname.slice(prefix.length);
  if (relative === '/') return route.fulfill({ contentType: 'text/html', body: rewriteReviewHtml(fs.readFileSync('engine/dist/web/index.html', 'utf8'), prefix) });
  if (relative.startsWith('/assets/')) return route.fulfill({ path: path.resolve('engine/dist/web' + relative), contentType: relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : 'font/otf' });
  if (relative.startsWith('/files/')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 130"><rect width="600" height="130" fill="white"/><text x="60" y="60" font-size="20">A paragraph in the review PDF.</text></svg>' });
  const round = Number(url.searchParams.get('round') || latest);
  if (/\/rounds\/\d+$/.test(relative)) return route.fulfill({ json: detail(Number(relative.split('/').at(-1))) });
  if (relative.endsWith('/effects/first')) { effectRequests++; return route.fulfill({ json: { places: [effectPlace('extra')] } }); }
  let restored;
  if (route.request().method() === 'POST') {
    const body = route.request().postDataJSON(); writes.push(body);
    if (relative.endsWith('/decide')) {
      actions.push({ decisions: structuredClone(rounds[latest]), undo });
      for (const id of body.changes) rounds[latest][id] = { accept: 'accepted', reject: 'rejected', comment: 'commented' }[body.action];
      undo = { id: `action-${++serial}`, kind: body.action, changes: body.changes };
      task.review.unsent++;
    } else if (relative.endsWith('/undo')) {
      restored = undo.changes;
      const previous = actions.pop(); rounds[latest] = previous.decisions; undo = previous.undo;
    }
    update();
  }
  return route.fulfill({ json: { ...annotateReviewState(state(round), [task]), ...(restored ? { restored } : {}) } });
});
const viewer = () => page.frameLocator('.review-frame');
const sync = async () => page.evaluate(() => window.dispatchEvent(new Event('online')));

const send = () => page.getByRole('button', { name: 'Send instructions', exact: true });
const input = () => page.getByRole('textbox', { name: 'Instructions for Codex', exact: true });
async function quote(side, offset = 8) {
  await viewer().locator(`.change[data-stop="0"] .${side} .pdf-glyph`).first().evaluate((el, offset) => {
    const range = document.createRange(); range.setStart(el.firstChild, 0); range.setEnd(el.firstChild, offset);
    const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }, offset);
  await viewer().locator('.review-add-note').click();
}
try {
  console.log('Opening fixture'); await page.goto(origin);
  await viewer().locator('.change.current').waitFor();
  await input().fill('Keep the examples.');
  console.log('Selecting before'); await quote('before');
  await expect(page.getByRole('textbox', { name: 'Comment 1', exact: true })).toBeFocused();
  await expect(page.locator('.review-draft-note')).toContainText('Before revision');
  await expect(page.locator('.review-draft-note blockquote')).toHaveText('Original');
  await expect(send()).toBeEnabled();
  await expect(page.locator('.composer-hint')).toHaveText('1 empty comment will stay in drafts');
  await input().fill('');
  await expect(send()).toBeDisabled();
  await input().fill('Keep the examples.');
  await page.getByRole('textbox', { name: 'Comment 1', exact: true }).fill('Keep this original term.');
  await quote('after', 7);
  await page.getByRole('textbox', { name: 'Comment 2', exact: true }).fill('Make this more precise.');
  await expect(page.locator('.review-draft-note').nth(1)).toContainText('After revision');
  await expect(input()).toHaveValue('Keep the examples.');
  await expect(viewer().locator('.composer')).toHaveCount(0);
  assert.equal(writes.length, 0, 'Comments do not accept or reject changes');
  await viewer().locator('.change[data-stop="0"] .comment').first().click();
  await page.getByRole('textbox', { name: 'Comment 3', exact: true }).fill('Keep the argument clear.');
  await expect(page.locator('.review-draft-note').nth(2)).toContainText('Whole change');
  assert.equal(writes.length, 0);
  await viewer().locator('.change[data-stop="0"] .comment').first().click();
  await viewer().locator('.change[data-stop="0"] .comment').first().click();
  await expect(page.locator('.review-draft-note')).toHaveCount(3);
  await expect(page.getByRole('textbox', { name: 'Comment 3', exact: true })).toHaveValue('Keep the argument clear.');
  await expect(page.getByRole('textbox', { name: 'Comment 3', exact: true })).toBeFocused();
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Comment 1', exact: true })).toHaveValue('Keep this original term.');
  await expect(input()).toHaveValue('Keep the examples.');
  await page.getByRole('textbox', { name: 'Comment 3', exact: true }).fill('');
  await expect(page.locator('.review-draft-note')).toHaveCount(3);
  await input().fill('');
  await expect(send()).toBeEnabled();
  fs.mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/unified-review-desktop.png' });
  failSend = true;
  await send().click(); await expect.poll(() => sent.length).toBe(1);
  await expect(send()).toBeEnabled();
  await page.reload();
  await expect(page.locator('.review-draft-note')).toHaveCount(3);
  failSend = false;
  await send().click(); await expect.poll(() => sent.length).toBe(2);
  assert.deepEqual(sent[0], sent[1], 'Failed combined submissions reuse their identity after reload');
  assert.equal(sent[1].text, ''); assert.equal(sent[1].notes[0].quote, 'Original');
  assert.match(sent[1].notes[0].where, /Before/); assert.match(sent[1].notes[1].where, /After/);
  assert.equal(sent[1].notes[0].anchor.round, 1);
  assert.equal(sent[1].notes.length, 2, 'Only written comments are included');
  await expect(page.locator('.review-draft-note')).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: 'Comment 1', exact: true })).toHaveValue('');
  await expect(send()).toBeDisabled();
  // A message can also be sent while keeping the empty quote in drafts.
  await input().fill('A follow-up without a comment on that quotation.');
  await expect(send()).toBeEnabled();
  await send().click(); await expect.poll(() => sent.length).toBe(3);
  assert.equal(sent[2].notes, undefined);
  await expect(page.locator('.review-draft-note')).toHaveCount(1);
  // An unwritten comment must not hide the save action after accepting everything.
  rounds[1] = { first: 'accepted', second: 'accepted', third: 'accepted', fourth: 'accepted' };
  task.review.unsent = 4; task.review.comments = 0; task.review.files = ['main.tex']; task.deferred = true; update();
  await page.reload();
  await expect(page.locator('.review-draft-note')).toHaveCount(1);
  await expect(send()).toBeDisabled();
  await expect(viewer().getByRole('button', { name: 'Apply to workspace', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Comment 1', exact: true }).fill('Revise this before saving.');
  await expect(viewer().getByRole('button', { name: 'Apply to workspace', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Comment 1', exact: true }).fill('');
  await expect(viewer().getByRole('button', { name: 'Apply to workspace', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete review note 1' }).click();
  await expect(page.locator('.review-draft')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send feedback', exact: true })).toHaveCount(0);
  // Pure acceptance has no pending-feedback nag and no spurious agent run.
  rounds[1] = { first: 'accepted', second: 'accepted', third: 'accepted', fourth: 'accepted' };
  task.review.unsent = 4; task.review.comments = 0; task.review.files = ['main.tex']; task.deferred = true; update();
  await page.reload();
  await expect(viewer().getByRole('button', { name: 'Apply to workspace', exact: true })).toBeVisible();
  await expect(page.locator('.review-draft')).toHaveCount(0); await expect(send()).toBeDisabled();
  // Rejection-only feedback can be sent without typing.
  rounds[1] = { first: 'rejected', second: 'rejected', third: 'rejected', fourth: 'rejected' }; update();
  task.review.unsent = 4; task.review.files = []; await sync();
  await expect(send()).toBeEnabled(); await send().click();
  await expect.poll(() => sent.length).toBe(4); assert.equal(sent[3].feedback, true);
  await expect(page.locator('.review-draft')).toHaveCount(0);
  // A comment can outlive a review round and navigate back to its exact source.
  rounds[1] = { first: 'pending', second: 'pending', third: 'pending', fourth: 'pending' }; update();
  await page.reload(); await quote('before');
  await page.getByRole('textbox', { name: 'Comment 1', exact: true }).fill('Compare this with the next round.');
  latest = 2; rounds[2] = { new: 'pending' }; task.review.round = 2; update(); await sync();
  await expect(page.locator('.review-draft-note small')).toContainText('round 1');
  await page.getByRole('button', { name: /Before revision.*Page 1/ }).click();
  await expect(page.locator('.review-frame')).toHaveAttribute('src', /round=1/);
  await expect(viewer().locator('.review-note-tag').first()).toBeVisible();
  // Draft quotations and sent-note results must take turns owning navigation.
  const linkedNote = sent[1].notes[0];
  timeline = [{ id: 'sent-note', taskId: task.id, type: 'user', text: '', createdAt: 2, meta: { notes: [linkedNote] } }];
  noteResults = [{ key: 'sent-note:0', itemId: 'sent-note', index: 0, note: linkedNote, round: 2, state: 'matched', changes: [{ round: 2, stop: 0, state: 'pending' }] }];
  task.updatedAt = 2; await sync();
  const resultLink = page.locator('[data-note-result="sent-note:0"]').getByRole('button', { name: /Change 1/ });
  for (let attempt = 0; attempt < 2; attempt++) {
    await resultLink.click();
    await expect(page.locator('.review-frame')).toHaveAttribute('src', /round=2/);
    await expect(viewer().locator('.papilot-linked-change[data-stop="0"]')).toBeVisible();
    await page.getByRole('button', { name: /Before revision.*Page 1/ }).click();
    await expect(page.locator('.review-frame')).toHaveAttribute('src', /round=1/);
    await expect(viewer().locator('.review-note-tag').first()).toBeVisible();
    await expect(viewer().locator('.papilot-linked-change')).toHaveCount(0);
  }
  // Phone: comment selection opens Chat, and the quote brings the PDF back.
  latest = 1; delete rounds[2]; task.review.round = 1; update();
  await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Comment 1', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/unified-review-mobile.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'test-results/unified-review-dark.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: unified quote and whole-change comments, before/after anchors, independent decisions, persisted drafts, notes-only send, retry identity, acceptance, rejection-only send, old rounds, mobile and dark mode');
} catch (error) { await page.screenshot({ path: 'test-results/unified-review-failure.png' }); console.error(await page.locator('body').innerText()); throw error; } finally { await browser.close(); await server.close(); }
