import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from '../engine/node_modules/@playwright/test/index.mjs';
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
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url()), json = value => route.fulfill({ json: value });
  if (url.pathname === '/api/state') return json(snapshot);
  if (url.pathname === '/api/updates') return json({ currentVersion: 'test', latestVersion: null, phase: 'idle', checkedAt: 1, error: null, canUpdate: false });
  if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
  if (url.pathname.endsWith('/skills')) return json({ skills: [] });
  if (url.pathname.endsWith('/git')) return json({ branch: 'main', files: [] });
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
  if (relative.startsWith('/assets/')) return route.fulfill({ path: path.resolve('engine/dist/web' + relative), contentType: relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : 'font/otf' });
  if (relative.startsWith('/files/')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 420"><rect width="600" height="420" fill="white"/><text x="60" y="60" font-size="20">A paragraph in the review PDF.</text></svg>' });
  if (/\/rounds\/\d+$/.test(relative)) return route.fulfill({ json: detail });
  return route.fulfill({ json: annotateReviewState(reviewState, [task]) });
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
  assert.deepEqual(errors, []);
  console.log('Places check passed');
} catch (error) {
  await page.screenshot({ path: 'test-results/places-failure.png' });
  throw error;
} finally {
  await browser.close();
  await server.close();
}
