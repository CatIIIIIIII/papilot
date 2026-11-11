import { readyRequirements } from './required-tools-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium } from '../engine/node_modules/playwright/index.mjs';
import { expect } from './playwright.mjs';
import { taskNoteResults } from '../src/server/note-results.ts';
import { rewriteReviewHtml } from '../src/server/review.ts';
import { messages } from '../src/web/locales/index.ts';
import { messages as reviewMessages } from '../engine/src/web/locales/index.ts';
import { interpolateMessage } from '../engine/src/locales.ts';

const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ locale: 'en-US', colorScheme: 'dark', viewport: { width: 1440, height: 900 } });
// A browser decode that never settles must not keep a prepared choice spinning.
await page.addInitScript(() => { Image.prototype.decode = () => new Promise(() => {}); });
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
// Several annotations can legitimately share a PDF group. Its links stay
// compact and individually usable instead of wrapping into tall cards.
items[2].meta.notes.push(...['Keep the definition precise.', 'Avoid unnecessary repetition.'].map(comment => ({ ...items[2].meta.notes[0], comment })));
const unit = (id, line, old, revised) => ({ id, file: 'main.tex', kind: 'text', status: 'modified', old_start: line, old_end: line + 2, new_start: line, new_end: line + 2, old_text: old, new_text: revised });
const units = { 1: [unit('c1', 10, 'The original technical sentence.', 'A shorter technical sentence.'), unit('c2', 20, 'A second original sentence.', 'Our contribution is now explicit.'), unit('c3', 12, 'The original technical sentence.', 'A clearer technical sentence.')], 2: [unit('c1', 11, 'A shorter technical sentence.', 'A shorter sentence preserving the technical term.')] };
const rounds = Object.fromEntries([1, 2].map(round => [round, { round, units: units[round], sections: [], loose: units[round].map(unit => ({ kind: 'change', units: [unit.id], before: [{ text: [{ text: unit.old_text }] }] })) }]));
const decisions = { 1: { c1: 'pending', c2: 'rejected', c3: 'accepted' }, 2: { c1: 'pending' } };
const client = { get: async route => route.includes('/rounds/') ? rounds[Number(route.split('/').at(-1))] : { decisions: decisions[Number(new URL(route, origin).searchParams.get('round'))] } };
let failResults = true;
const optionWrites = [], optionReads = [], previewReads = [];
// Hold the alternate preview until the test has inspected the pending UI.
let releaseBriefPreview;
const briefPreviewWait = new Promise(resolve => { releaseBriefPreview = resolve; });
let rejectFails = false;
let comparisonVersion = 'initial';
const alternateSource = '\\emph{A concise alternative preserving the technical term.}';
const strip = text => {
  const src = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="30"><rect width="600" height="30" fill="white"/><text x="40" y="20" font-size="12">${text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</text></svg>`);
  return { src, clean: src, width: 600, height: 30, page: 1, label: '1', text: [{ text, chars: Array.from(text, (text, index) => ({ text, rect: [40 + index * 5, 8, 45 + index * 5, 22] })) }] };
};
const sharedStrip = text => {
  const image = strip(text);
  const src = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="white"/><text x="40" y="20">Unrelated opening</text><text x="40" y="412" font-size="12">${text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</text><text x="40" y="720">Unrelated ending</text></svg>`);
  return { ...image, src, clean: src, height: 800, text: image.text.map(line => ({ ...line, chars: line.chars.map(char => ({ ...char, rect: [char.rect[0], char.rect[1] + 392, char.rect[2], char.rect[3] + 392] })) })), marks: [{ unit: 'c1', kind: 'added', rect: [40, 400, 300, 414] }, { unit: 'other', kind: 'added', rect: [40, 700, 300, 720] }] };
};
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  if (url.pathname.startsWith('/review/')) return route.fallback();
  if (url.pathname === '/api/indirect-changes') return route.fulfill({ json: { indirectChanges: false } });
  if (url.pathname === '/api/updates') return route.fulfill({ json: { currentVersion: snapshot.version, latestVersion: null, phase: 'idle', checkedAt: 1, error: null, canUpdate: true } });
  if (url.pathname === '/api/runtime/requirements') return route.fulfill({ json: readyRequirements });
  if (url.pathname === '/api/note-alternatives') return route.fulfill({ json: { noteAlternatives: true } });
  if (url.pathname.endsWith('/manuscript')) return route.fulfill({ json: { annotations: [], build: { status: 'idle' }, git: { files: [] } } });
  if (/\/api\/tasks\/[^/]+\/pdf$/.test(url.pathname)) return route.fulfill({ contentType: 'application/pdf', body: fs.readFileSync('tests/fixtures/outline.pdf') });
  if (url.pathname === '/api/state') return route.fulfill({ json: snapshot });
  if (url.pathname.endsWith('/items')) return route.fulfill({ json: { items } });
  if (url.pathname.endsWith('/note-results')) return route.fulfill(failResults ? { status: 503, json: { error: 'Temporary failure' } } : { json: { notes: await taskNoteResults(task, items, runs, client) } });
  if (url.pathname.endsWith('/note-options/preview')) {
    assert.equal(url.searchParams.get('comparison'), comparisonVersion);
    const round = Number(url.searchParams.get('round')), option = url.searchParams.get('option');
    if (round === 2 && option === 'brief' && comparisonVersion === 'initial') await briefPreviewWait;
    previewReads.push({ key: url.searchParams.get('key'), round, option });
    const candidate = round === 2 ? [...units[round].map(unit => ({ ...unit, new_text: option === 'brief' ? alternateSource : unit.new_text })), unit('other', 80, 'Three datasets.', 'Five datasets.')] : units[round];
    const blocks = round === 2 ? [{ kind: 'change', units: candidate.map(unit => unit.id), before: [strip('Unrelated leading strip'), sharedStrip(candidate[0].old_text)], after: [strip('Unrelated leading strip'), sharedStrip(candidate[0].new_text)] }] : candidate.map(unit => ({ kind: 'change', units: [unit.id], before: [strip(unit.old_text)], after: [strip(unit.new_text)] }));
    return route.fulfill({ json: { ...rounds[round], units: candidate, task: task.name, before: 'before', after: `candidate-${option}-${comparisonVersion}`, files: '', warnings: [], loose: [...blocks, ...Array.from({ length: 5 }, (_, i) => ({ kind: 'change', units: ['space-' + i], identical: true, before: [], after: [] }))] } });
  }
  if (url.pathname.endsWith('/note-options')) {
    const body = route.request().method() !== 'GET' ? route.request().postDataJSON() : null;
    if (body) {
      optionWrites.push(body);
      if (body.reject && rejectFails) return route.fulfill({ status: 400, json: { error: 'The source changed. Try again.' } });
      if (body.reject) decisions[2].c1 = 'rejected';
    } else optionReads.push(url.searchParams.get('key'));
    const round = (body?.key || url.searchParams.get('key'))?.startsWith('request-1:') ? 1 : 2;
    return route.fulfill({ json: { round, comparisonKey: comparisonVersion, key: url.searchParams.get('key'), ...(round === 1 ? { options: [], locked: 'Options are not available for this source range yet.' } : { options: [
      { id: 'current', label: 'Keep terminology', reason: 'Preserve the author’s technical term.', edits: [{ unit: 'c1', text: units[2][0].new_text }] },
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
  const html = `<html><head><style>${css} .change{min-height:300px}.source-fixture{padding:24px;font-size:18px;line-height:1.6}</style></head><body><div id="root"><header class="bar"><div class="identity"><span>Round ${round}</span></div></header><div class="review-body"><main id="paper"><div class="document"><div class="sheet">${units[round].map((unit, index) => `<article class="change inline" data-stop="${index}" data-state="${decisions[round][unit.id]}" tabindex="-1"><header class="change-head"><span class="change-number" data-change="${index + 1}">Change ${index + 1}</span><span class="change-where" data-location="main.tex:${unit.old_start}–${unit.old_end}">main.tex:${unit.old_start}–${unit.old_end}</span></header><div class="source-fixture"><p>${unit.old_text}</p><p>${unit.new_text}</p></div></article>`).join('')}</div></div></main></div></div><script>fetch('/api/tasks/p-note-results/rounds/${round}').then(response => response.json()).then(detail => { document.documentElement.dataset.papilotRound = String(detail.round); dispatchEvent(new Event('papilot:round')); });</script></body></html>`;
  return route.fulfill({ contentType: 'text/html', body: rewriteReviewHtml(html, '/review/paper') });
});
const frame = () => page.frameLocator('.review-frame');
const sent = index => page.locator(`[data-note-result="request-1:${index}"]`);
const controls = () => page.locator('#review-panel .review-note-controls');
// The review round can replace the iframe, so evaluating inside the old one
// fails with a detached frame. Dispatch in its current window from the page.
const decided = () => expect.poll(() => page.evaluate(() => {
  const view = document.querySelector('.review-frame')?.contentWindow;
  if (!view || view.document.readyState !== 'complete') return false;
  view.dispatchEvent(new view.Event('latex-review:decided'));
  return true;
})).toBe(true);
try {
  await page.goto(origin);
  await controls().getByRole('button', { name: 'Retry linking changes', exact: true }).waitFor();
  assert.equal(await page.getByText('No linked change', { exact: true }).count(), 0, 'failure must not look like an ignored note');
  failResults = false;
  await controls().getByRole('button', { name: 'Retry linking changes', exact: true }).click();
  await frame().getByRole('button', { name: 'Show note 1: Keep the technical term.', exact: true }).waitFor();
  assert.equal(await frame().getByRole('button', { name: 'Show note 1: Shorten the opening.', exact: true }).count(), 0, 'an older note must not label a newer round');
  await expect.poll(() => [...optionReads].sort(), { message: 'Every current note\'s small manifest is read, so each change can offer its options' }).toEqual(['request-2:0', 'request-2:1', 'request-2:2']);
  assert.deepEqual(previewReads, [], 'Opening the review never prefetches option PDFs');
  await frame().getByRole('button', { name: 'Other options · 1', exact: true }).click();
  await controls().getByRole('tab', { name: 'Concise', exact: true }).waitFor();
  assert.equal(optionReads.length, 3, 'Opening a cached note does not repeat its manifest request');
  await expect.poll(() => previewReads[0], { message: 'The visible comparison loads first; the note\'s other options follow while the author reads' }).toEqual({ key: 'request-2:0', round: 2, option: 'current' });
  await frame().locator('.source-fixture p').first().click();
  await controls().waitFor({ state: 'hidden' });
  const original = await page.locator('[data-note-result]').allTextContents();
  assert.equal(await page.locator('#conversation-panel .note-result-links, #conversation-panel .note-options').count(), 0);
  assert.equal(await controls().locator('.note-result-link').count(), 0);

  await sent(2).click();
  await controls().getByText('No linked change', { exact: true }).waitFor();
  await sent(1).click();
  await frame().locator('html[data-papilot-round="1"]').waitFor();
  await frame().locator('[data-papilot-link][data-stop="1"]').waitFor();
  assert.equal(await frame().locator('.papilot-note-options button').count(), 0, 'Historical changes do not advertise unavailable alternatives');
  assert.equal(await controls().locator('.review-note-position').textContent(), 'Note 2 / 3');
  await expect(frame().locator('[data-papilot-link=target]')).toHaveAttribute('data-stop', '1');
  await expect(controls().locator('.note-review-targets')).toHaveCount(0);
  assert.equal(await controls().getByRole('button', { name: 'Previous note', exact: true }).isEnabled(), true);
  assert.equal(await controls().getByRole('button', { name: 'Next note', exact: true }).isEnabled(), true);
  assert.match(await page.locator('.review-frame').getAttribute('src'), /round=1&history=1/);

  decisions[1].c1 = 'accepted';
  await decided();
  await sent(0).click();
  assert.equal(await controls().locator('.review-note-position').textContent(), 'Note 1 / 3');
  await expect(frame().locator('[data-papilot-link]')).toHaveCount(2);
  await frame().locator('.change[data-stop="2"] .papilot-note-links button').click();
  await expect(frame().locator('[data-papilot-link=target]')).toHaveAttribute('data-stop', '2');
  const selectedColor = await frame().locator('[data-papilot-link=target]').evaluate(element => getComputedStyle(element).outlineColor);
  assert.equal(await controls().evaluate(element => getComputedStyle(element).borderTopColor), selectedColor, 'The drawer and its exact source change share a selection accent');
  assert.notEqual(await frame().locator('.change[data-stop="0"] .change-head').evaluate(element => getComputedStyle(element).backgroundColor), await frame().locator('[data-papilot-link=target] .change-head').evaluate(element => getComputedStyle(element).backgroundColor), 'Other related fragments do not look like the selected target');
  assert.ok(await frame().locator('[data-papilot-link=target]').evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.top < window.innerHeight && bounds.bottom > 0;
  }), 'A note badge reveals its own change instead of the note’s first change');
  await frame().locator('.change[data-stop="0"] .papilot-note-links button').click();
  await expect(frame().locator('[data-papilot-link=target]')).toHaveAttribute('data-stop', '0');
  await frame().locator('.change[data-stop="2"] .papilot-note-links button').click();
  await expect(frame().locator('[data-papilot-link=target]')).toHaveAttribute('data-stop', '2');
  const linkedHeader = await frame().locator('[data-papilot-link=target] .change-head').boundingBox();
  const linkedDrawer = await controls().boundingBox();
  assert.ok(linkedHeader.y + linkedHeader.height <= linkedDrawer.y, 'The linked header stays above the drawer');
  assert.equal(await controls().getByRole('button', { name: 'Previous note', exact: true }).isEnabled(), false);
  const currentNote = page.locator('[data-note-result="request-2:0"]');
  await currentNote.click();
  await frame().locator('html[data-papilot-round="2"]').waitFor();
  await frame().locator('[data-papilot-link][data-stop="0"]').waitFor();
  await expect(frame().locator('[data-papilot-link=target]')).toHaveAttribute('data-stop', '0');
  const noteLinks = frame().locator('.change[data-stop="0"] .papilot-note-links');
  await expect(noteLinks.locator('button')).toHaveCount(3);
  await expect(noteLinks.locator('svg')).toHaveCount(1);
  const linkBounds = await noteLinks.locator('button').evaluateAll(buttons => buttons.map(button => { const box = button.getBoundingClientRect(); return { top: box.top, bottom: box.bottom }; }));
  assert.ok(linkBounds.every(box => box.top === linkBounds[0].top && box.bottom === linkBounds[0].bottom), 'Shared note numbers stay on one compact row');
  assert.doesNotMatch(await page.locator('.review-frame').getAttribute('src'), /[?&](history|round)=/);
  assert.deepEqual(await page.locator('[data-note-result]').allTextContents(), original, 'review operations never add content to original messages');
  await controls().getByRole('region', { name: 'Complete PDF comparison', exact: true }).waitFor();
  await controls().getByRole('tab', { name: 'Keep terminology', selected: true, exact: true }).waitFor();
  assert.equal(await controls().locator('.note-option-reason').textContent(), 'Preserve the author’s technical term.', 'The preferred proposal uses the AI-provided title and reason');
  assert.equal(await controls().locator('.note-comparison-side-label').count(), 2, 'Only this group has before/after labels');
  assert.equal(await controls().locator('.note-comparison-change[data-units="other"]').count(), 0, 'Other groups remain in the main review');
  await expect(controls().locator('.note-comparison-crop').first()).toHaveAttribute('data-crop-top', '376');
  assert.ok((await controls().locator('.note-comparison-crop').first().boundingBox()).height < 200, 'The shared PDF opens at this note instead of a page of unrelated edits');
  // A shared engine strip must follow live workspace language changes even
  // though this page has no viewer ?lang parameter or workspace reload.
  const firstStrip = controls().locator('.pdf-strip .pdf-text').first();
  for (const id of ['fr', 'de', 'en']) {
    await page.evaluate(id => {
      localStorage.setItem('papilot:language', id);
      window.dispatchEvent(new StorageEvent('storage', { key: 'papilot:language', newValue: id }));
    }, id);
    const before = id === 'en' ? 'Before' : messages[id].Before;
    const expected = interpolateMessage(id === 'en' ? '{label}, PDF page {page}' : reviewMessages[id]['{label}, PDF page {page}'], id, { label: before, page: '1' });
    await expect(page.locator('html')).toHaveAttribute('lang', id);
    await expect(firstStrip).toHaveAttribute('aria-label', expected);
  }
  console.log('PASS: Embedded PDF strip labels follow live workspace language changes');
  const sourceToggle = controls().getByRole('button', { name: 'Show LaTeX source', exact: true });
  assert.equal(await sourceToggle.getAttribute('aria-pressed'), 'false', 'PDF remains the default');
  await sourceToggle.click();
  await controls().getByRole('region', { name: 'LaTeX comparison', exact: true }).waitFor();
  const navigationBefore = await controls().locator('.note-option-navigation').boundingBox();
  await controls().getByRole('tab', { name: 'Concise', exact: true }).click();
  await expect(controls().getByRole('tablist')).toHaveAttribute('aria-busy', 'true');
  // The previous comparison keeps its place, dimmed and inert, while the next loads.
  await controls().locator('.note-option-source[data-revision="candidate-current-initial"][data-stale]').waitFor();
  assert.equal(await controls().getByRole('button', { name: 'Accept Concise', exact: true }).isDisabled(), true, 'An option cannot be accepted before its own comparison shows');
  assert.deepEqual(await controls().locator('.note-option-navigation').boundingBox(), navigationBefore, 'Switching options keeps the toolbar stable');
  assert.deepEqual(await page.locator('[data-note-result]').allTextContents(), original, 'Switching options never rearranges the review list');
  releaseBriefPreview();
  const sourceView = controls().locator('.note-option-source[data-revision="candidate-brief-initial"]');
  await sourceView.waitFor();
  assert.equal(previewReads.filter(read => read.key === 'request-2:0' && read.option === 'brief').length, 1, 'A newly visible option loads its preview once');
  assert.ok((await sourceView.locator('.note-source-unit[data-unit="c1"]').textContent()).includes(alternateSource), 'source follows the selected alternative');
  assert.equal(await sourceView.locator('.note-source-unit[data-unit="other"]').count(), 0, 'other groups are excluded from this note’s drawer');
  assert.equal(await sourceView.locator('.note-source-unit[data-unit="other"] ins, .note-source-unit[data-unit="other"] del').count(), 0, 'unrelated edits retain context without focused colors');
  assert.deepEqual(optionWrites, [], 'source and option switches never generate or apply a proposal');
  comparisonVersion = 'rejected-neighbor'; task.updatedAt++;
  await decided();
  await controls().locator('.note-option-source[data-revision="candidate-brief-rejected-neighbor"]').waitFor();
  fs.mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/note-options-latex.png', fullPage: true });
  await sourceToggle.click();
  await controls().getByRole('region', { name: 'Complete PDF comparison', exact: true }).waitFor();
  assert.equal(await controls().locator('.note-option-source').count(), 0, 'toggle restores the selected candidate PDF');
  assert.equal(await controls().getByRole('button', { name: 'Show all changes', exact: true }).count(), 0);
  await page.locator('.review-host-bar').getByRole('button', { name: 'Show all changes', exact: true }).click();
  await frame().locator('[data-papilot-link]').waitFor({ state: 'hidden' });
  assert.equal(await controls().isVisible(), true, 'all changes keeps the selected note options open');
  await frame().locator('.source-fixture p').first().click();
  await controls().waitFor({ state: 'hidden' });
  await frame().getByRole('button', { name: 'Show note 1: Keep the technical term.', exact: true }).click();
  await controls().waitFor({ state: 'visible' });
  await controls().getByRole('region', { name: 'Complete PDF comparison', exact: true }).waitFor();
  fs.mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/note-results-desktop.png', fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: 'test-results/note-results-desktop-light.png', fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });

  // Load the phone layout directly rather than resizing a page mid-load.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await sent(0).click();
  await frame().locator('[data-papilot-link][data-stop="0"]').waitFor();
  assert.equal(await controls().locator('.review-note-position').textContent(), 'Note 1 / 3');
  assert.equal(await page.locator('.review-frame').isVisible(), true);
  await frame().getByRole('button', { name: 'Show note 1: Shorten the opening.', exact: true }).first().click();
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
  assert.ok(toolbar.height < 90, 'narrow screens give tabs their own row above the pager and review actions');
  const tabs = await controls().getByRole('tablist').boundingBox(), selectedTab = await controls().getByRole('tab', { selected: true }).boundingBox();
  assert.ok(selectedTab.x >= tabs.x - 1 && selectedTab.x + selectedTab.width <= tabs.x + tabs.width + 1, 'the remembered selected option stays visible in the narrow tab strip');
  const conciseTab = await controls().getByRole('tab', { name: 'Concise', exact: true }).boundingBox();
  assert.ok(conciseTab.x >= tabs.x - 1 && conciseTab.x + conciseTab.width <= tabs.x + tabs.width + 1, 'both choices are directly visible on a phone');
  for (const button of await controls().locator('.note-option-actions button').all()) {
    const bounds = await button.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390, 'every action remains reachable on mobile');
  }
  await page.screenshot({ path: 'test-results/note-options-latex-mobile.png', fullPage: true });
  const draftBefore = await page.evaluate(id => localStorage.getItem('papilot:review-notes:' + id), task.id);
  rejectFails = true;
  await controls().getByRole('button', { name: 'Reject Concise', exact: true }).click();
  await controls().getByRole('alert').filter({ hasText: 'The source changed' }).waitFor();
  assert.equal(await controls().isVisible(), true, 'A failed rejection keeps the comparison open');
  assert.equal(decisions[2].c1, 'pending');
  rejectFails = false;
  await controls().getByRole('button', { name: 'Reject Concise', exact: true }).click();
  await expect.poll(() => decisions[2].c1).toBe('rejected');
  await expect(controls()).toHaveAttribute('data-open', 'true');
  await frame().locator('.papilot-note-options button').waitFor({ state: 'hidden' });
  assert.equal(optionWrites.length, 2);
  assert.ok(optionWrites.every(body => body.reject === true && body.accept === undefined && body.option === 'brief'));
  assert.equal(optionWrites[0].id, optionWrites[1].id, 'A retry keeps the same decision identity');
  assert.equal(await page.evaluate(id => localStorage.getItem('papilot:review-notes:' + id), task.id), draftBefore, 'Rejecting never creates a feedback draft');
  assert.deepEqual(errors, []);
  console.log('PASS: Original messages preserved; PDF note controls; load retry; selected candidate PDF/LaTeX comparisons; no writes on option switches; responsive mobile actions');
} finally { releaseBriefPreview(); await browser.close(); await server.close(); }
