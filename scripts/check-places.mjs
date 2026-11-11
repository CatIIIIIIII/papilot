import { readyRequirements } from './required-tools-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from './playwright.mjs';
import { annotateReviewState, rewriteReviewHtml } from '../src/server/review.ts';

// Leaving the manuscript for a task (or a task for the manuscript) unmounts
// the view. Coming back opens it where the author was, not at the top.
fs.mkdirSync('test-results', { recursive: true });
const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const prefix = '/review/paper';
const runtime = { connected: true, authenticated: true, models: [] };
const task = { id: 'places-task', projectId: 'paper', name: 'places', title: 'Tighten the method', status: 'reviewing', createdAt: 1, updatedAt: 1, review: { state: 'reviewing', round: 1, counts: { pending: 8 }, unsent: 0 } };
const snapshot = { version: 'test', csrf: 'fixture', projects: [{ id: 'paper', name: 'Paper', path: '/tmp/paper' }], tasks: [task], requests: [], runtime, runtimes: { codex: runtime, claude: runtime, antigravity: runtime } };
const words = JSON.parse(fs.readFileSync('tests/fixtures/outline-words.json', 'utf8'));
const items = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, taskId: task.id, type: i % 2 ? 'assistant' : 'user', text: `Message ${i}. ` + 'The method section needs one more pass. '.repeat(6), createdAt: 1000 + i }));
const ids = Array.from({ length: 8 }, (_, i) => `u${i}`);
const image = (name, label) => ({ src: `${name}.svg`, clean: `${name}.svg`, width: 600, height: 420, page: 0, label: '1', text: [{ chars: [{ text: label, rect: [60, 40, 500, 62] }] }] });
const detail = { task: 'places', round: 1, before: 'b', after: 'a', warnings: [], files: `${prefix}/files/places/1/`, loose: [],
  sections: [{ node: 'method', title: 'Method', number: '2', blocks: ids.map((id, i) => ({ kind: 'change', units: [id], identical: false, before: [image(`before-${i}`, `Old ${i}`)], after: [image(`after-${i}`, `New ${i}`)] })) }],
  units: ids.map((id, i) => ({ id, file: 'main.tex', status: 'modified', kind: 'text', whole_file: false, ops: [], old_start: i + 1, old_end: i + 1, new_start: i + 1, new_end: i + 1, old_text: `Old ${i}`, new_text: `New ${i}`, truncated: false })) };
const reviewState = { task: 'places', title: task.title, csrf: 'fixture', closed: false, state: 'reviewing', latest: 1, history: [{ number: 1, created: 1 }], round: 1, revision: 'a', decisions: Object.fromEntries(ids.map(id => [id, 'pending'])), comments: {}, undo: null, job: null };
let fullPdfWait;
const fullPdfRequests = [];
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url()), json = value => route.fulfill({ json: value });
  if (url.pathname === '/api/indirect-changes') return json({ indirectChanges: false });
  if (url.pathname === '/api/note-alternatives') return route.fulfill({ json: { noteAlternatives: true, noteAlternativeRange: 'few' } });
  if (url.pathname === '/api/runtime/requirements') return route.fulfill({ json: readyRequirements });
  if (/\/api\/tasks\/[^/]+\/pdf$/.test(url.pathname)) return route.fulfill({ contentType: 'application/pdf', body: fs.readFileSync('tests/fixtures/outline.pdf') });
  if (url.pathname === '/api/state') return json(snapshot);
  if (url.pathname === '/api/updates') return json({ currentVersion: 'test', latestVersion: null, phase: 'idle', checkedAt: 1, error: null, canUpdate: false });
  if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
  if (url.pathname.endsWith('/skills')) return json({ skills: [] });
  if (url.pathname.endsWith('/git')) return json({ branch: 'main', files: [] });
  if (url.pathname.endsWith('/git/history')) return json({ versions: [], next: null });
  if (url.pathname.endsWith('/git/overview')) return json({ commits: [], worktrees: [], truncated: false });
  if (url.pathname.endsWith('/manuscript')) return json({ git: { branch: 'main', files: [] }, build: { status: 'ready', key: 'pdf', pages: [[612, 792], [612, 792]] }, annotations: [] });
  if (url.pathname.endsWith('/manuscript.pdf')) return route.fulfill({ contentType: 'application/pdf', body: fs.readFileSync('tests/fixtures/outline.pdf') });
  if (url.pathname.endsWith('/manuscript/words')) return json(words[Number(url.searchParams.get('page'))]);
  if (url.pathname.endsWith('/items')) return json({ items });
  if (url.pathname.endsWith('/note-results')) return json({ notes: [] });
  throw Error(`Unexpected request ${url.pathname}`);
});
await page.route('**/review/**', async route => {
  const url = new URL(route.request().url()), relative = url.pathname.slice(prefix.length);
  if (relative === '/') return route.fulfill({ contentType: 'text/html', body: rewriteReviewHtml(fs.readFileSync('engine/dist/web/index.html', 'utf8'), prefix) });
  if (relative.startsWith('/assets/')) return route.fulfill({ path: path.resolve('engine/dist/web' + relative), contentType: /\.m?js$/.test(relative) ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : 'font/otf' });
  if (relative === '/files/full.pdf') {
    fullPdfRequests.push(Number(url.searchParams.get('round') || 1));
    await fullPdfWait;
    return route.fulfill({ contentType: 'application/pdf', body: fs.readFileSync('tests/fixtures/outline.pdf') });
  }
  if (relative.startsWith('/files/')) return route.fulfill({ contentType: 'image/svg+xml', body: detail.pdf
    ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 612 35"><rect width="612" height="35" fill="white"/><text x="60" y="24" font-size="12">A paragraph in the review PDF.</text></svg>'
    : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 420"><rect width="600" height="420" fill="white"/><text x="60" y="60" font-size="20">A paragraph in the review PDF.</text></svg>' });
  const requested = snapshot.tasks.find(item => relative.includes(`/tasks/${item.name}/`)) || task;
  if (/\/rounds\/\d+$/.test(relative)) return route.fulfill({ json: { ...detail, task: requested.name } });
  return route.fulfill({ json: annotateReviewState({ ...reviewState, task: requested.name, title: requested.title }, snapshot.tasks) });
});
const scrollOf = locator => locator.evaluate(element => Math.round(element.scrollTop));
const manuscript = () => page.locator('.manuscript-link').click();
const openTask = () => page.locator('.task-link').filter({ hasText: task.title }).click();
const chat = () => page.locator('.messages');
const paper = () => page.frameLocator('.review-frame').locator('#paper');
const near = (actual, expected, label, slack = 4) => assert.ok(Math.abs(actual - expected) <= slack, `${label}: ${actual} is not near ${expected}`);
try {
  await page.goto(origin);
  await manuscript();
  await page.locator('.pdf-view .page[data-page-number="2"]').waitFor();
  const box = page.locator('.pdf-view .pdf-container');
  await box.evaluate(element => { element.scrollTop = element.scrollHeight * 0.62; });
  await page.waitForTimeout(300);
  const pdfTop = await scrollOf(box);
  assert.ok(pdfTop > 500, 'the PDF is scrolled to its second page');

  await page.locator('.git-link').click();
  await expect(page.locator('.git-workspace')).toBeVisible();
  await expect(page.locator('.manuscript')).toHaveCount(0);
  await manuscript();
  await page.locator('.pdf-view .page[data-page-number="2"]').waitFor();
  await expect.poll(() => scrollOf(box)).toBeGreaterThan(500);
  near(await scrollOf(box), pdfTop, 'PDF position after the Git workspace');

  // Leave for the task, scroll its chat and review, and come back.
  await openTask();
  await expect(chat().getByText('Message 39.')).toBeVisible();
  await paper().locator('.change[data-stop="3"]').waitFor();
  await chat().evaluate(element => { element.scrollTop = 600; element.dispatchEvent(new Event('scroll')); });
  await expect(page.getByRole('button', { name: 'Latest messages' })).toBeVisible();
  await paper().evaluate(element => {
    const article = element.querySelector('[data-stop="3"]');
    element.scrollTop += article.getBoundingClientRect().top - element.getBoundingClientRect().top + 250;
  });
  await page.waitForTimeout(300);
  const reviewTop = await scrollOf(paper());
  const chatTop = await scrollOf(chat());

  await manuscript();
  await page.locator('.pdf-view .page[data-page-number="2"]').waitFor();
  await expect.poll(() => scrollOf(box)).toBeGreaterThan(500);
  near(await scrollOf(box), pdfTop, 'PDF position after returning from the task');

  await openTask();
  await paper().locator('.change[data-stop="3"]').waitFor();
  await expect.poll(() => scrollOf(chat())).toBeGreaterThan(0);
  near(await scrollOf(chat()), chatTop, 'chat position after returning to the task');
  await expect(page.getByRole('button', { name: 'Latest messages' })).toBeVisible();
  await expect.poll(() => scrollOf(paper())).toBeGreaterThan(0);
  near(await scrollOf(paper()), reviewTop, 'review position after returning to the task', 6);

  // A chat that was following the latest messages keeps following them.
  await page.getByRole('button', { name: 'Latest messages' }).click();
  await manuscript(); await openTask();
  await expect(chat().getByText('Message 39.')).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Latest messages' })).toHaveCount(0);

  // The manuscript's PDF / Changes switch is kept too.
  await manuscript();
  await page.locator('.pdf-modes').getByRole('button', { name: 'Changes', exact: true }).click();
  await expect(page.locator('.manuscript .review-frame')).toBeVisible();
  await openTask(); await manuscript();
  await expect(page.locator('.manuscript .review-frame')).toBeVisible();
  await page.locator('.review-lead .pdf-modes').getByRole('button', { name: 'PDF', exact: true }).click();
  await page.locator('.pdf-view .page[data-page-number="2"]').waitFor();
  await expect.poll(() => scrollOf(box)).toBeGreaterThan(500);
  near(await scrollOf(box), pdfTop, 'PDF position after the Changes view');

  // A reload returns to the same places.
  await page.reload();
  await page.locator('.pdf-view .page[data-page-number="2"]').waitFor();
  await expect.poll(() => scrollOf(box)).toBeGreaterThan(500);
  near(await scrollOf(box), pdfTop, 'PDF position after a reload');

  // On a phone the chat waits behind the Review tab and goes back once shown.
  await page.setViewportSize({ width: 390, height: 844 });
  const drawer = () => page.getByRole('button', { name: 'Show task list', exact: true }).click();
  const tab = name => page.locator('.workspace-view-selector').getByRole('button', { name: new RegExp(`^${name}`) });
  await drawer(); await openTask();
  await tab('Chat').click();
  await expect(chat().getByText('Message 39.')).toBeInViewport();
  await chat().evaluate(element => { element.scrollTop = 900; });
  await expect(page.getByRole('button', { name: 'Latest messages' })).toBeVisible();
  const phoneChat = await scrollOf(chat());
  await tab('Review').click();
  await drawer(); await manuscript();
  await drawer(); await openTask();
  await expect(tab('Review')).toHaveAttribute('aria-pressed', 'true');
  await tab('Chat').click();
  await expect.poll(() => scrollOf(chat())).toBeGreaterThan(0);
  near(await scrollOf(chat()), phoneChat, 'phone chat position after the Review tab');
  await page.screenshot({ path: 'test-results/places.png' });

  // The full review shares the manuscript's controls, and reading untouched
  // pages must survive leaving, changing modes and reloading as well.
  await page.setViewportSize({ width: 1800, height: 1000 });
  detail.pdf = `${prefix}/files/full.pdf`;
  const otherTask = { ...task, id: 'places-second', name: 'second', title: 'Revise another section' };
  snapshot.tasks.push(otherTask);
  const openOther = () => page.locator('.task-link').filter({ hasText: otherTask.title }).click();
  for (const [index, block] of detail.sections[0].blocks.entries()) {
    for (const strip of [...block.before, ...block.after]) Object.assign(strip, { page: 1, label: '1', top: 100 + index * 55, left: 0, width: 612, height: 35, text: [{ chars: [{ text: 'A paragraph in the review PDF.', rect: [60, 12, 250, 26] }] }] });
  }
  await page.evaluate(() => { localStorage.setItem('papilot:review:default-view', 'paper'); localStorage.removeItem('papilot:pdf-zoom'); });
  await page.reload();
  const full = page.frameLocator('.review-frame');
  await expect(full.locator('.paper-page')).toHaveCount(2);
  await expect(page.locator('.review-host-bar .pdf-pages')).toHaveText('/ 2');
  await expect.poll(() => full.locator('#paper').evaluate(root => Math.abs(root.querySelector('.paper-page').getBoundingClientRect().width - root.clientWidth))).toBeLessThan(2);
  await page.getByRole('button', { name: 'Contents', exact: true }).click();
  const entries = page.locator('.review-host-bar .pdf-contents-menu [role="menuitemradio"]');
  const sectionTitles = await entries.allTextContents();
  assert.ok(sectionTitles.length >= 2, 'the review reads PDF bookmarks');
  await entries.last().click();
  await expect(page.getByRole('textbox', { name: 'Page number', exact: true })).toHaveValue('2');
  await expect.poll(() => scrollOf(paper())).toBeGreaterThan(500);
  const inlineSource = full.locator('.change.inline').first().getByRole('button', { name: /LaTeX/ });
  await inlineSource.click();
  await expect(full.locator('.change.inline .source').first()).toBeVisible();
  await inlineSource.click();
  await expect(full.locator('.change.inline .source')).toHaveCount(0);

  // Fit and explicit zoom use the same picker in both readers.
  const chooseZoom = async label => {
    await page.getByRole('combobox', { name: 'Zoom', exact: true }).click();
    await page.getByRole('option', { name: label, exact: true }).click();
  };
  await chooseZoom('125%');
  await expect.poll(() => full.locator('.paper-page').first().evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(1020);
  await paper().evaluate(root => { const second = root.querySelector('.paper-page[data-page="1"]'); root.scrollTop += second.getBoundingClientRect().top - root.getBoundingClientRect().top + 180; });
  await page.waitForTimeout(250);
  const secondPageOffset = () => paper().evaluate(root => Math.round(root.querySelector('.paper-page[data-page="1"]').getBoundingClientRect().top - root.getBoundingClientRect().top));
  const fullOffset = await secondPageOffset();
  await manuscript();
  await page.locator('.pdf-view .page[data-page-number="2"]').waitFor();
  await chooseZoom('75%');
  await openTask();
  await expect(full.locator('.paper-page')).toHaveCount(2);
  await expect.poll(() => scrollOf(paper())).toBeGreaterThan(500);
  near(await secondPageOffset(), fullOffset, 'full PDF reading position after another reader changes zoom', 6);
  await expect(page.getByRole('combobox', { name: 'Zoom', exact: true })).toHaveText('125%');
  await openOther();
  await expect(full.locator('.paper-page')).toHaveCount(2);
  await chooseZoom('150%');
  await paper().evaluate(root => { root.scrollTop = 200; });
  await page.waitForTimeout(200);
  await openTask();
  await expect(full.locator('.paper-page')).toHaveCount(2);
  await expect(page.getByRole('combobox', { name: 'Zoom', exact: true })).toHaveText('125%');
  near(await secondPageOffset(), fullOffset, 'two tasks keep separate reading places', 6);


  await page.locator('.review-lead .pdf-modes').getByRole('button', { name: 'Changes', exact: true }).click();
  await expect(full.locator('.paper-page')).toHaveCount(0);
  await page.locator('.review-lead .pdf-modes').getByRole('button', { name: 'PDF', exact: true }).click();
  await expect(full.locator('.paper-page')).toHaveCount(2);
  near(await secondPageOffset(), fullOffset, 'full PDF reading position after Changes', 6);
  await page.reload();
  await expect(full.locator('.paper-page')).toHaveCount(2);
  await expect.poll(() => scrollOf(paper())).toBeGreaterThan(500);
  near(await secondPageOffset(), fullOffset, 'full PDF reading position after reload', 6);

  // Fit page measures the expanded review, including all eight change rows.
  const pageNumber = page.getByRole('textbox', { name: 'Page number', exact: true });
  await pageNumber.fill('1'); await pageNumber.press('Enter');
  await chooseZoom('Fit page');
  const fitsPage = () => paper().evaluate(root => {
    const page = root.querySelector('.paper-page'), box = page.getBoundingClientRect(), viewport = root.getBoundingClientRect();
    return box.height <= root.clientHeight + 1 && box.width <= root.clientWidth + 1 && box.top >= viewport.top - 1 && box.bottom <= viewport.bottom + 1;
  });
  await expect.poll(fitsPage).toBe(true);
  await expect.poll(() => full.locator('.paper-page').first().locator('canvas').count()).toBeGreaterThan(0);
  await page.locator('.review-viewport').screenshot({ path: 'test-results/review-reader-fit-page.png' });
  await page.setViewportSize({ width: 1800, height: 850 });
  await expect.poll(fitsPage).toBe(true);
  await page.setViewportSize({ width: 1800, height: 1000 });
  await chooseZoom('Fit width');

  // Both pinch paths keep the actual PDF content beneath the gesture's
  // midpoint, including strips next to controls that do not scale.
  for (const gesture of ['wheel', 'touch']) {
    const delta = await paper().evaluate(async (root, gesture) => {
      const strip = root.querySelector('[data-stop="3"] .side.after .pdf-strip');
      root.scrollTop += strip.getBoundingClientRect().top - root.getBoundingClientRect().top - root.clientHeight / 3;
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      const box = strip.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
      let event;
      if (gesture === 'wheel') {
        event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -30, clientX: x, clientY: y });
        strip.dispatchEvent(event);
      } else {
        const touches = distance => [-1, 1].map((sign, identifier) => new Touch({ identifier, target: strip, clientX: x + sign * distance / 2, clientY: y }));
        strip.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: touches(100) }));
        event = new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: touches(135) });
        strip.dispatchEvent(event);
        strip.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }));
      }
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      const after = strip.getBoundingClientRect();
      return { x: after.left + after.width / 2 - x, y: after.top + after.height / 2 - y, intercepted: event.defaultPrevented };
    }, gesture);
    assert.equal(delta.intercepted, true, `${gesture} zoom belongs to the PDF`);
    near(delta.x, 0, `${gesture} horizontal zoom anchor`, 2);
    near(delta.y, 0, `${gesture} vertical zoom anchor`, 2);
  }
  await chooseZoom('Fit width');

  // Search uses PDF.js matching even in unchanged parts of the paper.
  await page.getByRole('button', { name: 'Find in PDF', exact: true }).click();
  const search = page.getByRole('textbox', { name: 'Search the PDF', exact: true });
  await search.fill('Method');
  await expect(page.locator('.pdf-find-count')).toContainText('of');
  await expect(full.locator('.paper-find-mark.selected').first()).toBeVisible();
  await search.fill('operator applies');
  await expect(page.locator('.pdf-find-count')).toContainText('of');
  await expect(full.locator('.paper-find-mark.selected').first()).toBeVisible();
  await expect.poll(() => full.locator('.paper-find-mark.selected').first().evaluate(mark => {
    const page = mark.closest('.paper-page').getBoundingClientRect(), box = mark.getBoundingClientRect();
    return Math.abs((box.top - page.top) / page.width * 612 - 167);
  })).toBeLessThan(5);
  await page.screenshot({ path: 'test-results/review-reader-search.png' });
  await search.fill('unfindable-phrase-987654');
  await expect(page.locator('.pdf-find-count')).toHaveText('No matches');
  await search.press('Escape');
  await expect(page.locator('.pdf-find')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/review-reader-desktop.png' });

  // A new round cannot save the old PDF under its own reading-place key.
  // Delay its PDF to expose the interval between receiving detail and pages.
  const nextRound = async (number, whileLoading) => {
    let release;
    fullPdfWait = new Promise(resolve => { release = resolve; });
    detail.round = number; detail.after = `a${number}`; detail.pdf = `${prefix}/files/full.pdf?round=${number}`;
    Object.assign(reviewState, { latest: number, round: number, revision: detail.after });
    reviewState.history.push({ number, created: number }); task.review.round = number;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    try {
      await expect.poll(() => fullPdfRequests.at(-1)).toBe(number);
      await expect(full.locator('.paper-status')).toContainText('Preparing the full PDF');
      await whileLoading();
    } finally { release(); fullPdfWait = undefined; }
    await expect(full.locator('.paper-page')).toHaveCount(2);
  };
  await pageNumber.fill('2'); await pageNumber.press('Enter');
  await expect.poll(secondPageOffset).toBeLessThan(2);
  await nextRound(2, async () => {
    assert.equal(await full.locator('body').evaluate(() => localStorage.getItem('papilot:review:/review/paper/:places:pdf:2')), null);
  });
  await expect(full.locator('.change.current')).toHaveAttribute('data-stop', '0');
  await expect(full.locator('[data-stop="0"] .change-head')).toBeInViewport();

  // The open query is replayed when a new PDF replaces its search controller.
  await page.getByRole('button', { name: 'Find in PDF', exact: true }).click();
  await search.fill('operator applies');
  await expect(page.locator('.pdf-find-count')).toHaveText('1 of 1');
  await expect(full.locator('.paper-find-mark.selected')).toHaveCount(1);
  await nextRound(3, async () => {
    // The last PDF remains readable while the comparison's search controller loads.
    await expect(page.locator('.task-document-preview .pdfViewer canvas').first()).toBeVisible();
    await expect(page.locator('.review-host-bar').getByRole('textbox', { name: 'Search the PDF', exact: true, includeHidden: true })).toHaveValue('operator applies');
    await expect(page.locator('.review-host-bar .pdf-find-count')).toBeEmpty();
  });
  await expect(page.locator('.pdf-find-count')).toHaveText('1 of 1');
  await expect(full.locator('.paper-find-mark.selected')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Next match', exact: true })).toBeEnabled();
  await search.press('Escape');

  await chooseZoom('Fit width');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Contents', exact: true })).toBeVisible();
  await expect.poll(() => full.locator('#paper').evaluate(root => Math.abs(root.querySelector('.paper-page').getBoundingClientRect().width - root.clientWidth))).toBeLessThan(2);
  await page.getByRole('button', { name: 'Contents', exact: true }).click();
  await expect(page.locator('.review-host-bar .pdf-contents-menu')).toBeVisible();
  await entries.last().click();
  await expect(page.getByRole('textbox', { name: 'Page number', exact: true })).toHaveValue('2');
  await page.screenshot({ path: 'test-results/review-reader-phone.png' });
  assert.deepEqual(errors, []);
  console.log('Places check passed');
} catch (error) {
  await page.screenshot({ path: 'test-results/places-failure.png' });
  throw error;
} finally {
  await browser.close();
  await server.close();
}
