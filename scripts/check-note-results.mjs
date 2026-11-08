import { readyRequirements } from './required-tools-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium } from '../engine/node_modules/playwright/index.mjs';
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
const unit = (id, line, old, revised) => ({ id, file: 'main.tex', kind: 'text', status: 'modified', old_start: line, old_end: line + 2, new_start: line, new_end: line + 2, old_text: old, new_text: revised });
const units = { 1: [unit('c1', 10, 'The original technical sentence.', 'A shorter technical sentence.'), unit('c2', 20, 'A second original sentence.', 'Our contribution is now explicit.')], 2: [unit('c1', 11, 'A shorter technical sentence.', 'A shorter sentence preserving the technical term.')] };
const rounds = Object.fromEntries([1, 2].map(round => [round, { round, units: units[round], sections: [], loose: units[round].map(unit => ({ kind: 'change', units: [unit.id], before: [{ text: [{ text: unit.old_text }] }] })) }]));
const decisions = { 1: { c1: 'pending', c2: 'rejected' }, 2: { c1: 'pending' } };
const client = { get: async route => route.includes('/rounds/') ? rounds[Number(route.split('/').at(-1))] : { decisions: decisions[Number(new URL(route, origin).searchParams.get('round'))] } };
let failResults = true;
const optionWrites = [];
const alternateSource = '\\emph{A concise alternative preserving the technical term.}';
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  if (url.pathname.startsWith('/review/')) return route.fallback();
  if (url.pathname === '/api/indirect-changes') return route.fulfill({ json: { indirectChanges: false } });
  if (url.pathname === '/api/updates') return route.fulfill({ json: { currentVersion: snapshot.version, latestVersion: null, phase: 'idle', checkedAt: 1, error: null, canUpdate: true } });
  if (url.pathname === '/api/runtime/requirements') return route.fulfill({ json: readyRequirements });
  if (url.pathname === '/api/state') return route.fulfill({ json: snapshot });
  if (url.pathname.endsWith('/items')) return route.fulfill({ json: { items } });
  if (url.pathname.endsWith('/note-results')) return route.fulfill(failResults ? { status: 503, json: { error: 'Temporary failure' } } : { json: { notes: await taskNoteResults(task, items, runs, client) } });
  if (url.pathname.endsWith('/note-options/preview')) {
    const round = Number(url.searchParams.get('round')), option = url.searchParams.get('option');
    const candidate = round === 2 ? [...units[round].map(unit => ({ ...unit, new_text: option === 'brief' ? alternateSource : unit.new_text })), unit('other', 80, 'Three datasets.', 'Five datasets.')] : units[round];
    return route.fulfill({ json: { ...rounds[round], units: candidate, task: task.name, before: 'before', after: `candidate-${option}`, files: '', warnings: [], loose: candidate.map(unit => ({ kind: 'change', units: [unit.id], before: [], after: [] })) } });
  }
  if (url.pathname.endsWith('/note-options')) {
    if (route.request().method() !== 'GET') optionWrites.push(route.request().postData());
    const round = url.searchParams.get('key')?.startsWith('request-1:') ? 1 : 2;
    return route.fulfill({ json: { round, key: url.searchParams.get('key'), ...(round === 1 ? { options: [], locked: 'Options are not available for this source range yet.' } : { options: [
      { id: 'current', label: 'Current proposal', edits: [{ unit: 'c1', text: units[2][0].new_text }] },
      { id: 'brief', label: 'Concise', reason: 'Keep the technical term in a shorter sentence.', edits: [{ unit: 'c1', text: alternateSource }] },
    ] }) } });
  }
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
const controls = () => page.locator('#review-panel .review-note-controls');
try {
  await page.goto(origin);
  await controls().getByRole('button', { name: 'Retry linking changes', exact: true }).waitFor();
  assert.equal(await page.getByText('No linked change', { exact: true }).count(), 0, 'failure must not look like an ignored note');
  failResults = false;
  await controls().getByRole('button', { name: 'Retry linking changes', exact: true }).click();
  await frame().getByRole('button', { name: 'Show note 1: Keep the technical term.', exact: true }).waitFor();
  assert.equal(await frame().getByRole('button', { name: 'Show note 1: Shorten the opening.', exact: true }).count(), 0, 'an older note must not label a newer round');
  const original = await page.locator('[data-note-result]').allTextContents();
  assert.equal(await page.locator('#conversation-panel .note-result-links, #conversation-panel .note-options').count(), 0);
  assert.equal(await controls().locator('.note-result-link').count(), 0);

  await sent(2).click();
  await controls().getByText('No linked change', { exact: true }).waitFor();
  await sent(1).click();
  await frame().locator('html[data-papilot-round="1"]').waitFor();
  await frame().locator('.papilot-linked-change[data-stop="1"]').waitFor();
  assert.equal(await controls().locator('.review-note-position').textContent(), '2 / 3');
  assert.equal(await controls().getByRole('button', { name: 'Previous note', exact: true }).isEnabled(), true);
  assert.equal(await controls().getByRole('button', { name: 'Next note', exact: true }).isEnabled(), true);
  assert.match(await page.locator('.review-frame').getAttribute('src'), /round=1&history=1/);

  decisions[1].c1 = 'accepted';
  await frame().locator('body').evaluate(element => element.ownerDocument.defaultView.dispatchEvent(new Event('latex-review:decided')));
  await sent(0).click();
  assert.equal(await controls().locator('.review-note-position').textContent(), '1 / 3');
  assert.equal(await controls().getByRole('button', { name: 'Previous note', exact: true }).isEnabled(), false);
  const currentNote = page.locator('[data-note-result="request-2:0"]');
  await currentNote.click();
  await frame().locator('html[data-papilot-round="2"]').waitFor();
  await frame().locator('.papilot-linked-change[data-stop="0"]').waitFor();
  assert.doesNotMatch(await page.locator('.review-frame').getAttribute('src'), /[?&](history|round)=/);
  assert.deepEqual(await page.locator('[data-note-result]').allTextContents(), original, 'review operations never add content to original messages');
  await controls().getByRole('region', { name: 'Complete PDF comparison', exact: true }).waitFor();
  const sourceToggle = controls().getByRole('button', { name: 'Show LaTeX source', exact: true });
  assert.equal(await sourceToggle.getAttribute('aria-pressed'), 'false', 'PDF remains the default');
  await sourceToggle.click();
  await controls().getByRole('region', { name: 'LaTeX comparison', exact: true }).waitFor();
  await controls().getByRole('tab', { name: 'Concise', exact: true }).click();
  const sourceView = controls().locator('.note-option-source[data-revision="candidate-brief"]');
  await sourceView.waitFor();
  assert.ok((await sourceView.locator('.note-source-unit[data-unit="c1"]').textContent()).includes(alternateSource), 'source follows the selected alternative');
  assert.equal(await sourceView.locator('.note-source-unit[data-unit="other"] pre').allTextContents().then(values => values.join('|')), 'Three datasets.|Five datasets.');
  assert.equal(await sourceView.locator('.note-source-unit[data-unit="other"] ins, .note-source-unit[data-unit="other"] del').count(), 0, 'unrelated edits retain context without focused colors');
  assert.deepEqual(optionWrites, [], 'source and option switches never generate or apply a proposal');
  fs.mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/note-options-latex.png', fullPage: true });
  await sourceToggle.click();
  await controls().getByRole('region', { name: 'Complete PDF comparison', exact: true }).waitFor();
  assert.equal(await controls().locator('.note-option-source').count(), 0, 'toggle restores the selected candidate PDF');
  assert.equal(await controls().getByRole('button', { name: 'Show all changes', exact: true }).count(), 0);
  await page.locator('.review-host-bar').getByRole('button', { name: 'Show all changes', exact: true }).click();
  await frame().locator('.papilot-linked-change').waitFor({ state: 'hidden' });
  assert.equal(await controls().isVisible(), true, 'all changes keeps the selected note options open');
  await frame().locator('.source-fixture p').first().click();
  await controls().waitFor({ state: 'hidden' });
  await frame().getByRole('button', { name: 'Show note 1: Keep the technical term.', exact: true }).click();
  await controls().waitFor({ state: 'visible' });
  fs.mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/note-results-desktop.png', fullPage: true });

  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await sent(0).click();
  await frame().locator('.papilot-linked-change[data-stop="0"]').waitFor();
  assert.equal(await controls().locator('.review-note-position').textContent(), '1 / 3');
  assert.equal(await page.locator('.review-frame').isVisible(), true);
  await frame().getByRole('button', { name: 'Show note 1: Shorten the opening.', exact: true }).click();
  assert.equal(await page.locator('.review-frame').isVisible(), true, 'PDF note badges keep the author in the review');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  const box = await controls().boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, 'note controls stay inside the PDF pane on mobile');
  await page.screenshot({ path: 'test-results/note-results-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await currentNote.click();
  await sourceToggle.click();
  await controls().getByRole('region', { name: 'LaTeX comparison', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'LaTeX wraps within the narrow PDF pane');
  const toolbar = await controls().locator('.note-option-navigation').boundingBox();
  assert.ok(toolbar.height < 50, 'tabs, pager, review actions and LaTeX toggle stay in one row');
  const tabs = await controls().getByRole('tablist').boundingBox(), selectedTab = await controls().getByRole('tab', { selected: true }).boundingBox();
  assert.ok(selectedTab.x >= tabs.x - 1 && selectedTab.x + selectedTab.width <= tabs.x + tabs.width + 1, 'the remembered selected option stays visible in the narrow tab strip');
  for (const button of await controls().locator('.note-option-actions button').all()) {
    const bounds = await button.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390, 'every action remains reachable on mobile');
  }
  await page.screenshot({ path: 'test-results/note-options-latex-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: Original messages preserved; PDF note controls; load retry; selected candidate PDF/LaTeX comparisons; no writes on option switches; single-row mobile actions');
} finally { await browser.close(); await server.close(); }
