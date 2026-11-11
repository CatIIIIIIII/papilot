import { readyRequirements } from './required-tools-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from './playwright.mjs';

// A newer pass of the manuscript lands while a note is being written on the
// pages on screen. The card stays open and keeps its draft, the note names
// the pages it was written on, and the newer pages appear once it is saved.
const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const origin = `http://127.0.0.1:${server.server.address().port}`;
const snapshot = { version: 'test', csrf: 'fixture', projects: [{ id: 'paper', name: 'Paper', path: '/tmp/paper' }], tasks: [], requests: [], runtime: { connected: true, authenticated: true, models: [] } };
const git = { branch: 'main', files: [] };
const words = JSON.parse(fs.readFileSync('tests/fixtures/outline-words.json', 'utf8'));
let notes = [], serial = 0, key = 'first-pass', manuscriptReads = 0;
const pdfKeys = [], created = [];
let releasePending; const pendingPdf = new Promise(resolve => { releasePending = resolve; });
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url()), json = value => route.fulfill({ json: value });
  if (url.pathname === '/api/note-alternatives') return json({ noteAlternatives: true, noteAlternativeRange: 'few' });
  if (url.pathname === '/api/indirect-changes') return json({ indirectChanges: false });
  if (url.pathname === '/api/updates') return json({ currentVersion: snapshot.version, latestVersion: null, phase: 'idle', checkedAt: 1, error: null, canUpdate: true });
  if (url.pathname === '/api/runtime/requirements') return json(readyRequirements);
  if (url.pathname === '/api/state') return json(snapshot);
  if (url.pathname === '/api/quick-notes') return json({ quickNotes: null });
  if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
  if (url.pathname.endsWith('/skills')) return json({ skills: [] });
  if (url.pathname.endsWith('/git')) return json(git);
  if (url.pathname.endsWith('/manuscript')) { manuscriptReads++; return json({ git, build: { status: 'building', key, pages: [[612, 792], [612, 792]] }, annotations: notes }); }
  if (url.pathname.endsWith('/manuscript.pdf')) {
    const requested = url.searchParams.get('key'); pdfKeys.push(requested);
    if (requested === 'fifth-pass') await pendingPdf;
    return route.fulfill({ contentType: 'application/pdf', body: fs.readFileSync('tests/fixtures/outline.pdf') });
  }
  if (url.pathname.endsWith('/manuscript/words')) return json(words[Number(url.searchParams.get('page'))]);
  if (url.pathname.endsWith('/annotations')) {
    const body = route.request().postDataJSON();
    created.push(body);
    const note = { ...body, quote: body.quote || '', comment: body.comment || '', id: `note-${++serial}`, projectId: 'paper', source: null, createdAt: serial };
    notes.push(note); return json(note);
  }
  if (url.pathname.endsWith('/note-results')) return json({ notes: [] });
  throw Error(`Unexpected fixture request ${url.pathname}`);
});
const rail = () => page.getByRole('toolbar', { name: 'Marking tools' });
const textOnPage = () => page.locator('.page[data-page-number="1"] .textLayer span').filter({ hasText: /\S/ });
async function selectText(index) {
  await textOnPage().nth(index).evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    const box = element.getBoundingClientRect();
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', clientX: box.right, clientY: box.bottom }));
  });
}
async function newerPass(name) {
  const before = manuscriptReads;
  key = name;
  await page.evaluate(() => window.dispatchEvent(new Event('papilot:manuscript')));
  await expect.poll(() => manuscriptReads).toBeGreaterThan(before);
}
try {
  await page.goto(origin);
  await textOnPage().first().waitFor();
  assert.deepEqual(pdfKeys, ['first-pass']);
  await rail().getByRole('button', { name: 'Note', exact: true }).click();
  await selectText(0);
  const card = page.getByRole('dialog', { name: /^PDF note/ }), input = card.getByRole('textbox');
  await expect(input).toBeFocused();
  await input.fill('Is this opening too long?');

  // Two passes land while the author writes; the pages under the card stay.
  await newerPass('second-pass');
  await newerPass('third-pass');
  await page.waitForTimeout(300);
  await expect(card).toBeVisible();
  await expect(input).toHaveValue('Is this opening too long?');
  assert.deepEqual(pdfKeys, ['first-pass'], 'The pages under an open card are not replaced');

  const firstPassText = await textOnPage().first().elementHandle();
  await input.press('Enter');
  await expect.poll(() => created.length).toBe(1);
  assert.equal(created[0].key, 'first-pass', 'The note names the pages it was written on');
  assert.equal(created[0].comment, 'Is this opening too long?');
  await expect(card).toHaveCount(0);
  // Then the newest pages replace them.
  await expect.poll(() => pdfKeys.at(-1)).toBe('third-pass');
  await expect.poll(() => firstPassText.evaluate(element => element.isConnected)).toBe(false);
  await textOnPage().first().waitFor();

  // Without an open card a newer pass replaces the pages right away.
  const thirdPassText = await textOnPage().first().elementHandle();
  await newerPass('fourth-pass');
  await expect.poll(() => pdfKeys.at(-1)).toBe('fourth-pass');
  await expect.poll(() => thirdPassText.evaluate(element => element.isConnected)).toBe(false);
  await textOnPage().first().waitFor();

  // The old pages stay interactive while a replacement PDF is downloading.
  // Opening a card in that interval must keep its page key and its draft,
  // even after the pending download completes.
  await newerPass('fifth-pass');
  await expect.poll(() => pdfKeys.at(-1)).toBe('fifth-pass');
  await selectText(0);
  await expect(input).toBeFocused();
  await input.fill('Keep this note on the fourth pass.');
  releasePending();
  await page.waitForTimeout(300);
  await expect(card).toBeVisible();
  await expect(input).toHaveValue('Keep this note on the fourth pass.');
  const fourthPassText = await textOnPage().first().elementHandle();
  await input.press('Enter');
  await expect.poll(() => created.length).toBe(2);
  assert.equal(created[1].key, 'fourth-pass', 'A pending PDF cannot claim a note on the visible pages');
  await expect(card).toHaveCount(0);
  await expect.poll(() => fourthPassText.evaluate(element => element.isConnected)).toBe(false);
  await textOnPage().first().waitFor();
  assert.deepEqual(errors, []);
  console.log('Notes retain their visible pages and build key, including when opened during a replacement download.');
} finally {
  releasePending();
  await browser.close();
  await server.close();
}
