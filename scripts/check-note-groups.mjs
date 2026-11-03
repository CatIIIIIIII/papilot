import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from '../engine/node_modules/@playwright/test/index.mjs';
import { summarizeNotes } from '../src/notes.ts';

const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const origin = `http://127.0.0.1:${server.server.address().port}`;
const snapshot = { version: 'test', csrf: 'fixture', projects: [{ id: 'paper', name: 'Paper', path: '/tmp/paper' }], tasks: [], requests: [], runtime: { connected: true, authenticated: true, models: [] } };
const git = { branch: 'main', files: [] };
let notes = [], deleted = [], serial = 0;
const requests = [], items = new Map();
const routeApi = async route => {
  const url = new URL(route.request().url()), json = value => route.fulfill({ json: value });
  if (url.pathname === '/api/updates') return route.fulfill({ json: { currentVersion: snapshot.version, latestVersion: null, phase: 'idle', checkedAt: 1, error: null, canUpdate: true } });
  if (url.pathname === '/api/state') return json(snapshot);
  if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
  if (url.pathname.endsWith('/skills')) return json({ skills: [] });
  if (url.pathname.endsWith('/git')) return json(git);
  if (url.pathname.endsWith('/manuscript')) return json({ git, build: { status: 'ready', key: 'pdf', pages: [[612, 792], [612, 792]] }, annotations: notes });
  if (url.pathname.endsWith('/manuscript.pdf')) return route.fulfill({ contentType: 'application/pdf', body: fs.readFileSync('tests/fixtures/outline.pdf') });
  if (url.pathname.endsWith('/manuscript/words')) return json(JSON.parse(fs.readFileSync('tests/fixtures/outline-words.json', 'utf8'))[Number(url.searchParams.get('page'))]);
  if (url.pathname.endsWith('/annotations')) {
    const body = route.request().postDataJSON();
    const note = { ...body, comment: body.comment || '', id: `mark-${++serial}`, projectId: 'paper', source: null, createdAt: serial };
    notes.push(note); return json(note);
  }
  if (url.pathname.endsWith('/delete')) {
    const id = url.pathname.split('/').at(-2), note = notes.find(note => note.id === id);
    deleted.push(note); notes = notes.filter(note => note.id !== id); return json({ ok: true });
  }
  if (url.pathname.endsWith('/restore')) {
    const id = url.pathname.split('/').at(-2); notes.push(deleted.find(note => note.id === id)); notes.sort((a, b) => a.createdAt - b.createdAt); return json({ annotations: notes });
  }
  if (url.pathname === '/api/tasks') {
    const body = route.request().postDataJSON(); requests.push(body);
    const attached = notes.filter(note => body.annotations.includes(note.id));
    const task = { ...body, name: 'groups', status: 'queued', createdAt: Date.now(), updatedAt: Date.now(), review: null };
    snapshot.tasks.push(task); items.set(task.id, [{ id: 'group-request', taskId: task.id, type: 'user', text: body.instructions, meta: { notes: summarizeNotes(attached) }, createdAt: Date.now() }]);
    notes = notes.filter(note => !body.annotations.includes(note.id)); return json(task);
  }
  if (url.pathname.endsWith('/items')) return json({ items: items.get(url.pathname.split('/')[3]) || [] });
  if (url.pathname.endsWith('/note-results')) return json({ notes: [] });
  throw Error(`Unexpected fixture request ${url.pathname}`);
};
await page.route('**/api/**', routeApi);
const picker = () => page.getByRole('button', { name: 'Annotation group color', exact: true });
async function chooseGroup(name) {
  await picker().click();
  await page.getByRole('menuitemradio', { name, exact: true }).click();
}
async function selectText(index, automatic = true) {
  const word = page.locator('.page[data-page-number="1"] .textLayer span').filter({ hasText: /\S/ }).nth(index);
  await word.evaluate((el, automatic) => {
    const range = document.createRange(); range.selectNodeContents(el);
    const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    if (automatic) el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }));
  }, automatic);
}
async function markPoint(note, target = page) {
  const mark = target.locator(`.note-layer [data-note="${note.id}"]`).first();
  await mark.scrollIntoViewIfNeeded();
  const rect = await mark.boundingBox();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}
async function clickMark(note) {
  // A personal note's popover closes with Escape; it has no close button.
  const open = page.getByRole('dialog', { name: /^PDF note/ });
  if (await open.isVisible()) { await page.keyboard.press('Escape'); await expect(open).toHaveCount(0); }
  const { x, y } = await markPoint(note);
  await page.mouse.click(x, y);
  await expect(page.locator('.note-tag.active')).toHaveAttribute('data-note', note.id);
  await expect(page.getByRole('dialog', { name: /^PDF note/ })).toBeVisible();
}
try {
  await page.goto(origin);
  await page.locator('.page[data-page-number="1"] .textLayer span').first().waitFor();
  await chooseGroup('Yellow');
  await selectText(0); await expect.poll(() => notes.length).toBe(1);
  await selectText(1); await expect.poll(() => notes.length).toBe(2);
  await expect(page.getByRole('textbox', { name: /^Edit note / })).toHaveCount(0);
  await page.getByRole('button', { name: 'My notes', exact: true }).click();
  await expect(page.locator('.annotation-group')).toHaveCount(1);
  await expect(page.locator('.annotation-group .group-header')).toContainText('2 locations');
  await page.getByRole('button', { name: 'Close notes', exact: true }).click();
  assert.deepEqual(notes.map(note => [note.group, note.comment]), [['yellow', ''], ['yellow', '']]);
  await page.locator('.pdf-container').focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect.poll(() => notes.length).toBe(1);
  await selectText(2); await expect.poll(() => notes.length).toBe(2);
  await page.getByRole('button', { name: 'Mark region', exact: true }).click();
  const regionBox = await page.locator('.region-capture').first().boundingBox();
  await page.mouse.move(regionBox.x + 60, regionBox.y + 90); await page.mouse.down();
  await page.mouse.move(regionBox.x + 180, regionBox.y + 150, { steps: 5 }); await page.mouse.up();
  await expect.poll(() => notes.length).toBe(3);
  assert.equal(notes.at(-1).group, 'yellow');
  assert.equal(notes.at(-1).rects, undefined);
  await expect(page.getByRole('textbox', { name: /^Edit note / })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await chooseGroup('Yellow');
  await clickMark(notes[0]);
  await clickMark(notes.at(-1));
  assert.equal(notes.length, 3, 'Clicking existing marks must not create annotations, even with a color selected');
  await page.locator('.pdf-container').focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect.poll(() => notes.length).toBe(2);
  await page.keyboard.press('Escape');
  await chooseGroup('Purple');
  await selectText(3); await expect.poll(() => notes.length).toBe(3);
  await page.getByRole('button', { name: 'My notes', exact: true }).click();
  await expect(page.locator('.annotation-group')).toHaveCount(2);
  await page.getByRole('button', { name: 'Close notes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start task', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(picker()).not.toHaveAttribute('data-group');
  await page.reload();
  await page.getByRole('button', { name: 'My notes', exact: true }).click();
  await expect(page.locator('.annotation-group')).toHaveCount(2);
  await page.getByRole('button', { name: 'Close notes', exact: true }).click();
  await expect(page.locator('.note-tag[data-group="yellow"]')).toHaveCount(2);
  await page.getByRole('tab', { name: 'Contents', exact: true }).click();
  await clickMark(notes[0]);
  await clickMark(notes[2]);
  await expect(page.getByRole('tab', { name: 'Contents', exact: true })).toHaveAttribute('aria-selected', 'true');
  // Dragging outside the card closes it while keeping normal PDF text selection.
  const dragMark = page.locator(`.note-mark[data-note="${notes[0].id}"]`).first();
  const dragBox = await dragMark.boundingBox();
  await page.mouse.move(dragBox.x + 1, dragBox.y + dragBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(dragBox.x + dragBox.width - 1, dragBox.y + dragBox.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString().trim())).not.toBe('');
  await expect(page.getByRole('button', { name: 'Add note', exact: true })).toBeVisible();
  await expect(page.locator('.note-tag.active')).toHaveCount(0);
  assert.equal(notes.length, 3);
  const paper = await page.locator('.page[data-page-number="1"]').boundingBox();
  await page.mouse.click(paper.x + 20, paper.y + 20);
  await expect(page.getByRole('button', { name: 'Add note', exact: true })).toHaveCount(0);
  await clickMark(notes[1]);
  // Real touch events: a tap selects a note, whereas a long press still
  // selects text and dismisses the card without changing any saved annotation.
  const mobile = await browser.newPage({ locale: 'en-US', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  mobile.on('pageerror', error => errors.push(error.message));
  await mobile.route('**/api/**', routeApi);
  await mobile.goto(origin);
  await mobile.getByRole('group', { name: 'Manuscript view' }).getByRole('button', { name: 'PDF', exact: true }).click();
  const tap = await markPoint(notes[2], mobile);
  await mobile.touchscreen.tap(tap.x, tap.y);
  await expect(mobile.locator('.note-tag.active')).toHaveAttribute('data-note', notes[2].id);
  const hold = await markPoint(notes[0], mobile), touch = await mobile.context().newCDPSession(mobile);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [hold] });
  await expect(mobile.locator('.select-handle')).toHaveCount(2);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(mobile.locator('.note-tag.active')).toHaveCount(0);
  await mobile.touchscreen.tap(tap.x, tap.y);
  await expect(mobile.locator('.select-handle')).toHaveCount(0);
  await mobile.touchscreen.tap(hold.x, hold.y);
  await expect(mobile.locator('.note-tag.active')).toHaveAttribute('data-note', notes[0].id);
  assert.equal(notes.length, 3);
  await mobile.close();
  await page.getByRole('button', { name: 'My notes', exact: true }).click();
  await page.getByRole('button', { name: 'Select all notes for this task', exact: true }).click();
  await page.getByRole('button', { name: 'Close notes', exact: true }).click();
  await page.getByRole('tab', { name: 'New task', exact: true }).click();
  await page.getByRole('textbox', { name: 'Describe the revision' }).fill('Explain yellow selections. Shorten purple selections.');
  await page.screenshot({ path: 'test-results/note-groups-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.locator('.annotation-group')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Describe the revision' })).toHaveValue('');
  await page.locator('.task-link').first().click();
  await expect(page.locator('.thread .annotation-group')).toHaveCount(2);
  await expect(page.locator('.notes-request')).toHaveText('Explain yellow selections. Shorten purple selections.');
  await page.locator('.manuscript-link').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('group', { name: 'Manuscript view' }).getByRole('button', { name: 'PDF', exact: true }).click();
  await page.getByLabel('Page number').fill('1');
  await page.getByLabel('Page number').press('Enter');
  await chooseGroup('Yellow');
  await selectText(0, false);
  await page.getByRole('button', { name: 'Add to Yellow', exact: true }).click();
  await expect.poll(() => notes.length).toBe(1);
  await expect(page.getByRole('textbox', { name: /^Edit note / })).toHaveCount(0);
  await chooseGroup('Individual notes');
  await page.getByRole('button', { name: 'My notes', exact: true }).click();
  await expect(page.locator('.annotation-group')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Notes in this task' })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/note-groups-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  assert.deepEqual(errors, []);
  console.log('PASS: Continuous marking, groups, undo, persistence, direct text/region note selection, text dragging through highlights, grouped messages, and mobile marking.');
} finally { await browser.close(); await server.close(); }
