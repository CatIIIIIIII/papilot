import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from '../engine/node_modules/@playwright/test/index.mjs';

// The PDF's tool rail: each tool marks the way its name says, keys pick
// tools, the magic pen's wheel and number keys add quick notes, its menu and
// settings change them, and narrow viewers keep their old toolbar instead.
const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const origin = `http://127.0.0.1:${server.server.address().port}`;
const snapshot = { version: 'test', csrf: 'fixture', projects: [{ id: 'paper', name: 'Paper', path: '/tmp/paper' }], tasks: [], requests: [], runtime: { connected: true, authenticated: true, models: [] } };
const git = { branch: 'main', files: [] };
let notes = [], serial = 0, quickNotes = null;
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url()), json = value => route.fulfill({ json: value });
  if (url.pathname === '/api/updates') return json({ currentVersion: snapshot.version, latestVersion: null, phase: 'idle', checkedAt: 1, error: null, canUpdate: true });
  if (url.pathname === '/api/state') return json(snapshot);
  if (url.pathname === '/api/indirect-changes') return json({ indirectChanges: false });
  if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
  if (url.pathname.endsWith('/skills')) return json({ skills: [] });
  if (url.pathname.endsWith('/git')) return json(git);
  if (url.pathname.endsWith('/manuscript')) return json({ git, build: { status: 'ready', key: 'pdf', pages: [[612, 792], [612, 792]] }, annotations: notes });
  if (url.pathname.endsWith('/manuscript.pdf')) return route.fulfill({ contentType: 'application/pdf', body: fs.readFileSync('tests/fixtures/outline.pdf') });
  if (url.pathname.endsWith('/manuscript/words')) return json(JSON.parse(fs.readFileSync('tests/fixtures/outline-words.json', 'utf8'))[Number(url.searchParams.get('page'))]);
  if (url.pathname === '/api/quick-notes') {
    if (route.request().method() === 'POST') quickNotes = route.request().postDataJSON().quickNotes;
    return json({ quickNotes });
  }
  if (url.pathname.endsWith('/annotations')) {
    const body = route.request().postDataJSON();
    const note = { ...body, quote: body.quote || '', comment: body.comment || '', id: `mark-${++serial}`, projectId: 'paper', source: null, createdAt: serial };
    notes.push(note); return json(note);
  }
  const edit = url.pathname.match(/\/annotations\/(mark-\d+)$/);
  if (edit) { const note = notes.find(note => note.id === edit[1]); note.comment = route.request().postDataJSON().comment; return json(note); }
  if (url.pathname.endsWith('/delete')) { const id = url.pathname.split('/').at(-2); notes = notes.filter(note => note.id !== id); return json({ ok: true }); }
  if (url.pathname.endsWith('/note-results')) return json({ notes: [] });
  throw Error(`Unexpected fixture request ${url.pathname}`);
});
const rail = () => page.getByRole('toolbar', { name: 'Marking tools' });
const tool = name => rail().getByRole('button', { name, exact: true });
const words = () => page.locator('.page[data-page-number="1"] .textLayer span').filter({ hasText: /\S/ });
async function selectText(index, release = true) {
  await words().nth(index).evaluate((element, release) => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    if (release) {
      const box = element.getBoundingClientRect();
      element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', clientX: box.right, clientY: box.bottom }));
    }
  }, release);
}
// Floating cards are placed on animation frames and settings scroll a row into
// view smoothly; act on an element once its box has held still.
async function settled(target) {
  let previous = '', changedAt = Date.now();
  await expect.poll(async () => {
    const box = await target.boundingBox(), value = JSON.stringify(box);
    if (value !== previous) { previous = value; changedAt = Date.now(); }
    return Boolean(box) && Date.now() - changedAt >= 200;
  }).toBe(true);
  return target.boundingBox();
}
const key = async value => { await page.locator('.pdf-container').focus(); await page.keyboard.press(value); };
try {
  await page.goto(origin);
  await words().first().waitFor();
  await expect(rail().getByRole('button')).toHaveCount(7);
  // The note tool is its own color picker: a click picks it, a second opens colors.
  await tool('Note').click();
  await expect(tool('Note')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('menu', { name: 'Annotation group color' })).toHaveCount(0);
  await tool('Note').click();
  await page.getByRole('menuitemradio', { name: 'Green', exact: true }).click();
  await expect(tool('Note')).toHaveAttribute('data-group', 'green');
  await tool('Note').click();
  await page.getByRole('menuitemradio', { name: 'Individual notes', exact: true }).click();
  await expect(tool('Note')).not.toHaveAttribute('data-group');
  await key('v');
  await expect(tool('Select')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.pdf-compact-tools')).toBeHidden();

  // Delete strikes text out at once; the mark's card takes a replacement.
  await key('d');
  await expect(tool('Delete')).toHaveAttribute('aria-pressed', 'true');
  await selectText(0);
  await expect.poll(() => notes.length).toBe(1);
  assert.deepEqual([notes[0].kind, notes[0].comment], ['delete', '']);
  await expect(page.locator('.note-mark[data-kind="delete"]')).toHaveCount(1);
  await page.locator('.note-tag[data-kind="delete"]').click();
  const card = page.getByRole('dialog', { name: /^PDF note/ });
  await expect(card).toContainText('Delete this text');
  await card.getByRole('button', { name: /^Edit note \d+$/ }).click();
  await expect(card.getByRole('textbox')).toHaveAttribute('placeholder', 'Replace with… (leave empty to delete)');
  // Left empty, the deletion still goes into the task.
  await page.keyboard.press('Enter');
  await expect(card).toHaveCount(0);
  await page.locator('.note-tag[data-kind="delete"]').click();
  const include = card.getByRole('button', { name: 'Include note 1 in this task' });
  await expect(include).toHaveAttribute('aria-pressed', 'true');
  await settled(include); await include.click();
  await expect(include).toHaveAttribute('aria-pressed', 'false');
  await card.getByRole('button', { name: /^Edit note \d+$/ }).click();
  await card.getByRole('textbox').fill('plainer words');
  await page.keyboard.press('Escape');
  await expect.poll(() => notes[0].comment).toBe('plainer words');
  // Marking waits while a note saves; the card closes once it has.
  await expect(card).toHaveCount(0);

  // The magic pen opens its wheel where the drag ended; a number picks a slot.
  await key('q');
  await selectText(1);
  const wheel = page.getByRole('menu', { name: 'Quick notes' });
  await expect(wheel).toBeVisible();
  await expect(wheel.getByRole('menuitem')).toHaveCount(6);
  await wheel.getByRole('menuitem', { name: /Runt/ }).hover();
  await expect(page.locator('.stamp-caption')).toContainText('last line of this paragraph');
  await page.screenshot({ path: 'test-results/pdf-tools-wheel.png' });
  await expect(page.locator('.stamp-center-name')).toContainText('Runt');
  // Arrow keys move focus with the light, so Enter takes the lit slot.
  await page.keyboard.press('Tab');
  await expect(wheel.getByRole('menuitem', { name: 'Polish' })).toBeFocused();
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  await expect(wheel.getByRole('menuitem', { name: 'Runt' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(wheel).toHaveCount(0);
  await expect.poll(() => notes.length).toBe(2);
  assert.equal(notes[1].stamp, 'Runt');
  assert.match(notes[1].comment, /last line of this paragraph/);
  await expect(page.locator('.note-tag[data-stamp]')).toContainText('Runt');
  // The middle writes an ordinary note instead.
  await selectText(2);
  await wheel.getByRole('menuitem', { name: 'Write a note instead' }).click();
  await expect(page.getByRole('dialog', { name: /^PDF note/ }).getByRole('textbox')).toBeFocused();
  await page.keyboard.press('Escape');
  assert.equal(notes.length, 2);

  // A number key keeps a quick note on the pen: marks skip the wheel, and a
  // click on the page marks a point there.
  await key('5');
  await expect(page.locator('.stamp-lock')).toContainText('Verify');
  await expect(rail().locator('.rail-badge')).toHaveText('5');
  await selectText(3);
  await expect.poll(() => notes.length).toBe(3);
  await expect(wheel).toHaveCount(0);
  assert.equal(notes[2].stamp, 'Verify');
  const first = await words().nth(4).boundingBox();
  await page.mouse.click(first.x + first.width + 1, first.y + first.height / 2);
  await expect.poll(() => notes.length).toBe(4);
  assert.equal(notes[3].kind, 'point');
  assert.match(notes[3].quote, /‸/);
  await expect(page.locator('.note-point[data-stamp]')).toHaveCount(1);
  // A click that closes a card does only that.
  await page.locator('.note-tag[data-stamp]').first().click();
  await expect(page.getByRole('dialog', { name: /^PDF note/ })).toBeVisible();
  await page.mouse.click(first.x + first.width + 1, first.y + first.height / 2 + 40);
  await expect(page.getByRole('dialog', { name: /^PDF note/ })).toHaveCount(0);
  await page.waitForTimeout(400);
  assert.equal(notes.length, 4);
  await key('Escape');
  await expect(page.locator('.stamp-lock')).toHaveCount(0);
  await key('Escape');
  await expect(tool('Select')).toHaveAttribute('aria-pressed', 'true');

  // Clicking the magic pen again lists its quick notes: one can stay on the
  // pen, and the list itself is edited in settings.
  await key('q');
  await tool('Magic pen').click();
  const menu = rail().getByRole('menu', { name: 'Quick notes' });
  await expect(menu.getByRole('menuitemradio')).toHaveCount(6);
  await menu.getByRole('menuitemradio', { name: /Connect/ }).click();
  await expect(rail().locator('.rail-badge')).toHaveText('4');
  await tool('Magic pen').click();
  await menu.getByRole('menuitemradio', { name: /Choose on the wheel/ }).click();
  await expect(rail().locator('.rail-badge')).toHaveCount(0);
  await tool('Magic pen').click();
  await menu.getByRole('menuitem', { name: 'Edit quick notes…' }).click();
  const settings = page.getByRole('dialog', { name: 'Quick notes' }), list = settings.getByRole('list', { name: 'Quick notes' });
  await expect(list.getByRole('listitem')).toHaveCount(5);
  // A new note, with its own icon; presets that stay as they are keep only their ids.
  await settings.getByRole('button', { name: 'Add quick note' }).click();
  await settings.getByLabel('Short name').fill('Define');
  await settings.getByLabel('Instruction').fill('Define this term where it first appears.');
  await settings.getByRole('button', { name: 'Choose an icon' }).click();
  await page.getByRole('radio', { name: 'Book' }).click();
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(list.getByRole('listitem')).toHaveCount(6);
  await expect.poll(() => quickNotes?.length).toBe(6);
  assert.deepEqual(quickNotes.slice(0, 5), ['polish', 'tighten', 'runt', 'connect', 'verify'].map(id => ({ id })));
  assert.deepEqual({ ...quickNotes[5], id: '' }, { id: '', label: 'Define', instruction: 'Define this term where it first appears.', icon: 'book' });
  await page.screenshot({ path: 'test-results/pdf-tools-settings.png' });
  // Arrow keys move a note, and focus stays on it; a handle drags one.
  const handle = name => list.getByRole('button', { name: `Move ${name}` });
  await handle('Define').focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => quickNotes[4].label).toBe('Define');
  await expect(handle('Define')).toBeFocused();
  const from = await settled(handle('Polish')), to = await settled(list.getByRole('listitem').last());
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y + to.height - 4, { steps: 8 }); await page.mouse.up();
  await expect.poll(() => quickNotes.at(-1).id).toBe('polish');
  await expect(list.getByRole('listitem').first()).toContainText('Shorten');
  // A removal can be undone; restoring the presets saves nothing at all.
  await list.getByRole('button', { name: 'Delete Shorten' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(5);
  await settings.getByRole('button', { name: 'Undo' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(6);
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  // The wheel offers the list as saved.
  await selectText(7);
  await expect(wheel.getByRole('menuitem')).toHaveCount(7);
  await expect(wheel.getByRole('menuitem').first()).toHaveAccessibleName('Shorten');
  await page.keyboard.press('Escape');
  await expect(wheel).toHaveCount(0);
  await tool('Magic pen').click();
  await menu.getByRole('menuitem', { name: 'Edit quick notes…' }).click();
  await settings.getByRole('button', { name: 'Restore presets' }).click();
  await expect.poll(() => quickNotes).toBe(null);
  await expect(list.getByRole('listitem')).toHaveCount(5);
  await page.keyboard.press('Escape');
  await key('Escape');
  assert.equal(notes.length, 4);

  // A sticky note goes wherever the page is clicked, with the line beside it.
  await key('p');
  const paper = await page.locator('.page[data-page-number="1"]').boundingBox();
  await page.mouse.click(paper.x + paper.width * 0.5, paper.y + paper.height * 0.3);
  const sticky = page.getByRole('dialog', { name: /^PDF note/ });
  await expect(sticky.getByRole('textbox')).toBeFocused();
  await expect(page.locator('.note-point.draft')).toHaveCount(1);
  await page.keyboard.type('Explain why here.');
  await page.keyboard.press('Enter');
  await expect.poll(() => notes.length).toBe(5);
  assert.deepEqual([notes[4].kind, notes[4].comment], ['point', 'Explain why here.']);

  // A selection made first takes the tool picked for it.
  await key('v');
  await selectText(6, false);
  await expect(page.getByRole('button', { name: 'Add note', exact: true })).toBeVisible();
  await page.keyboard.press('d');
  await expect.poll(() => notes.length).toBe(6);
  assert.equal(notes[5].kind, 'delete');

  // The hand drags the pages; Space borrows it and a tap still turns the page.
  await page.setViewportSize({ width: 1440, height: 600 });
  await key('h');
  const box = page.locator('.pdf-container'), before = await box.evaluate(element => element.scrollTop);
  const view = await box.boundingBox();
  await page.mouse.move(view.x + view.width / 2, view.y + 400); await page.mouse.down();
  await page.mouse.move(view.x + view.width / 2, view.y + 100, { steps: 6 }); await page.mouse.up();
  await expect.poll(() => box.evaluate(element => element.scrollTop)).toBeGreaterThan(before + 200);
  await key('v');
  const top = await box.evaluate(element => element.scrollTop);
  await page.keyboard.down(' ');
  await expect(page.locator('.pdf-view')).toHaveClass(/tool-hand/);
  await page.keyboard.up(' ');
  await expect(page.locator('.pdf-view')).toHaveClass(/tool-select/);
  await expect.poll(() => box.evaluate(element => element.scrollTop)).toBeGreaterThan(top + 100);
  // Space over the region tool drags the page and draws no box.
  await key('m');
  await page.keyboard.down(' ');
  await page.mouse.move(view.x + view.width / 2, view.y + 400); await page.mouse.down();
  await page.mouse.move(view.x + view.width / 2 + 80, view.y + 250, { steps: 6 }); await page.mouse.up();
  await page.keyboard.up(' ');
  await page.waitForTimeout(300);
  await expect(page.getByRole('dialog', { name: /^PDF note/ })).toHaveCount(0);
  await key('v');

  // Keys typed into a note stay there.
  await page.locator('.note-tag[data-kind="point"]').last().click();
  await page.getByRole('dialog', { name: /^PDF note/ }).getByRole('button', { name: /^Edit note \d+$/ }).click();
  await page.keyboard.type(' dq');
  await expect(tool('Select')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');

  // Narrow viewers keep the old toolbar controls.
  await page.setViewportSize({ width: 520, height: 844 });
  await page.getByRole('group', { name: 'Manuscript view' }).getByRole('button', { name: 'PDF', exact: true }).click();
  await expect(rail()).toBeHidden();
  await expect(page.locator('.pdf-compact-tools')).toBeVisible();
  assert.deepEqual(errors, []);
  console.log('PASS: rail tools, deletions with replacements, the magic pen wheel, number lock, menu and settings, points, sticky notes, hand and Space, tool-after-selection, and narrow viewers.');
} finally { await browser.close(); await server.close(); }
