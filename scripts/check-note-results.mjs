import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium } from '../engine/node_modules/playwright/index.mjs';
import { expect } from '../engine/node_modules/@playwright/test/index.mjs';
import { taskNoteResults } from '../src/server/note-results.ts';
import { rewriteReviewHtml } from '../src/server/review.ts';

const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ locale: 'en-US', colorScheme: 'dark', viewport: { width: 1440, height: 900 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const task = { id: 'note-results-task', projectId: 'paper', name: 'p-note-results', title: 'Revise the introduction', status: 'reviewing', createdAt: 1, updatedAt: 1, review: { round: 2, state: 'reviewing', counts: { pending: 1 } } };
const snapshot = { version: 'test', csrf: 'fixture', projects: [{ id: 'paper', name: 'Thesis', path: '/tmp/paper' }], tasks: [task], requests: [], runtime: { connected: true, authenticated: true, models: [] } };
const note = (comment, start, quote) => ({ where: `Page 1 · main.tex line ${start}`, quote, comment, anchor: { sources: [{ file: 'main.tex', lines: [start, start + 2] }] } });
const items = [
  { id: 'request-1', taskId: task.id, type: 'user', text: '', createdAt: 1, meta: { notes: [note('Shorten the opening.', 10, 'The original technical sentence.'), note('Clarify the contribution.', 20, 'A second original sentence.'), note('Define the symbol in the equation.', 90, '')] } },
  { id: 'response-1', taskId: task.id, type: 'assistant', text: 'Revised the opening and contribution.', createdAt: 2 },
  { id: 'request-2', taskId: task.id, type: 'user', text: '', createdAt: 3, meta: { notes: [{ ...note('Keep the technical term.', 10, 'A shorter technical sentence.'), where: 'Round 1 · Page 1 · main.tex line 10', anchor: { round: 1, sources: [{ file: 'main.tex', lines: [10, 12] }] } }] } },
];
const runs = [{ id: 'request-1', taskId: task.id, reviewRound: 1, status: 'completed' }, { id: 'request-2', taskId: task.id, reviewRound: 2, status: 'completed' }];
const unit = (id, line, old, revised) => ({ id, file: 'main.tex', old_start: line, old_end: line + 2, old_text: old, new_text: revised });
const units = { 1: [unit('c1', 10, 'The original technical sentence.', 'A shorter technical sentence.'), unit('c2', 20, 'A second original sentence.', 'Our contribution is now explicit.')], 2: [unit('c1', 11, 'A shorter technical sentence.', 'A shorter sentence preserving the technical term.')] };
const rounds = Object.fromEntries([1, 2].map(round => [round, { round, units: units[round], sections: [], loose: units[round].map(unit => ({ kind: 'change', units: [unit.id], before: [{ text: [{ text: unit.old_text }] }] })) }]));
const decisions = { 1: { c1: 'pending', c2: 'rejected' }, 2: { c1: 'pending' } };
const client = { get: async route => route.includes('/rounds/') ? rounds[Number(route.split('/').at(-1))] : { decisions: decisions[Number(new URL(route, origin).searchParams.get('round'))] } };
let failResults = true;
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  if (url.pathname.startsWith('/review/')) return route.fallback();
  if (url.pathname === '/api/updates') return route.fulfill({ json: { currentVersion: snapshot.version, latestVersion: null, phase: 'idle', checkedAt: 1, error: null, canUpdate: true } });
  if (url.pathname === '/api/state') return route.fulfill({ json: snapshot });
  if (url.pathname.endsWith('/items')) return route.fulfill({ json: { items } });
  if (url.pathname.endsWith('/note-results')) return route.fulfill(failResults ? { status: 503, json: { error: 'Temporary failure' } } : { json: { notes: await taskNoteResults(task, items, runs, client) } });
  if (url.pathname.endsWith('/skills')) return route.fulfill({ json: { skills: [] } });
  if (url.pathname.endsWith('/git')) return route.fulfill({ json: { files: [], branch: 'main' } });
  if (url.pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
  throw new Error('Unexpected request: ' + url.pathname);
});
const css = fs.readFileSync('engine/src/web/style.css', 'utf8');
await page.route('**/review/**', async route => {
  const url = new URL(route.request().url());
  if (url.pathname.includes('/rounds/')) return route.fulfill({ json: rounds[Number(url.pathname.split('/').at(-1))] });
  const round = Number(url.searchParams.get('round')) || 2;
  const html = `<html><head><style>${css} .change{min-height:300px}.source-fixture{padding:24px;font-size:18px;line-height:1.6}</style></head><body><header class="bar"><div class="identity"><span>Round ${round}</span></div></header><main id="paper"><div class="document"><div class="sheet">${units[round].map((unit, index) => `<article class="change inline" data-stop="${index}" data-state="${decisions[round][unit.id]}" tabindex="-1"><header class="change-head"><span class="change-number" data-change="${index + 1}">Change ${index + 1}</span><span class="change-where" data-location="main.tex:${unit.old_start}–${unit.old_end}">main.tex:${unit.old_start}–${unit.old_end}</span></header><div class="source-fixture"><p>${unit.old_text}</p><p>${unit.new_text}</p></div></article>`).join('')}</div></div></main><script>fetch('/api/tasks/p-note-results/rounds/${round}');</script></body></html>`;
  return route.fulfill({ contentType: 'text/html', body: rewriteReviewHtml(html, '/review/paper') });
});
const frame = () => page.frameLocator('.review-frame');
const sent = index => page.locator(`[data-note-result="request-1:${index}"]`);
try {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Retry linking changes', exact: true }).first().waitFor();
  assert.equal(await page.getByText('No linked change', { exact: true }).count(), 0, 'failure must not look like an ignored note');
  failResults = false;
  await page.getByRole('button', { name: 'Retry linking changes', exact: true }).first().click();
  await sent(0).getByRole('button', { name: /Change 1/ }).waitFor();
  await sent(2).getByText('No linked change', { exact: true }).waitFor();
  assert.match(await sent(1).innerText(), /Rejected/);
  await frame().getByRole('button', { name: 'Show note 1: Keep the technical term.', exact: true }).waitFor();
  assert.equal(await frame().getByRole('button', { name: 'Show note 1: Shorten the opening.', exact: true }).count(), 0, 'an older note must not label a newer round');

  await sent(1).getByRole('button', { name: /Change 2/ }).click();
  await frame().locator('html[data-papilot-round="1"]').waitFor();
  await frame().locator('.papilot-linked-change[data-stop="1"]').waitFor();
  assert.match(await page.locator('.review-frame').getAttribute('src'), /round=1&history=1/);
  await frame().getByRole('button', { name: 'Show note 2: Clarify the contribution.', exact: true }).click();
  await expect(sent(1)).toBeFocused();

  decisions[1].c1 = 'accepted';
  await frame().locator('body').evaluate(element => element.ownerDocument.defaultView.dispatchEvent(new Event('latex-review:decided')));
  await sent(0).getByText('Accepted', { exact: true }).waitFor();
  const currentNote = page.locator('[data-note-result="request-2:0"]');
  await currentNote.getByRole('button', { name: /Change 1/ }).click();
  await frame().locator('html[data-papilot-round="2"]').waitFor();
  await frame().locator('.papilot-linked-change[data-stop="0"]').waitFor();
  assert.doesNotMatch(await page.locator('.review-frame').getAttribute('src'), /[?&]history=/);
  assert.match(await page.locator('.review-frame').getAttribute('src'), /round=2&change=0/);
  assert.doesNotMatch(await currentNote.innerText(), /Round \d+/);
  assert.doesNotMatch(await frame().locator('body').innerText(), /Round \d+/);
  await sent(0).getByRole('button', { name: /Change 1/ }).click();
  await frame().locator('.papilot-linked-change[data-stop="0"]').waitFor();
  fs.mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/note-results-desktop.png', fullPage: true });

  await page.reload();
  await sent(0).getByText('Accepted', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await sent(0).getByRole('button', { name: /Change 1/ }).click();
  await frame().locator('.papilot-linked-change[data-stop="0"]').waitFor();
  assert.equal(await page.locator('.review-frame').isVisible(), true);
  await frame().getByRole('button', { name: 'Show note 1: Shorten the opening.', exact: true }).click();
  await sent(0).waitFor({ state: 'visible' });
  await expect(sent(0)).toBeFocused();
  const noteBox = await sent(0).boundingBox(), composerBox = await page.locator('.composer-wrap').boundingBox(), messagesBox = await page.locator('.messages').boundingBox();
  assert.ok(noteBox.y >= messagesBox.y - 1 && noteBox.y + noteBox.height <= Math.min(messagesBox.y + messagesBox.height, composerBox.y) + 1, 'the complete selected note stays between the header and composer');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.screenshot({ path: 'test-results/note-results-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: Notes link to their own result rounds; unmatched notes; load retry; bidirectional navigation; decision updates; reload persistence; mobile navigation');
} finally { await browser.close(); await server.close(); }
