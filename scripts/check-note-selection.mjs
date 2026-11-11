import { readyRequirements } from './required-tools-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from './playwright.mjs';

fs.mkdirSync('test-results', { recursive: true });
const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const origin = `http://127.0.0.1:${server.server.address().port}`;
const runtime = { connected: true, authenticated: true, models: [] };
const snapshot = { version: 'test', csrf: 'fixture', projects: [{ id: 'paper', name: 'Paper', path: '/tmp/paper' }, { id: 'other', name: 'Other paper', path: '/tmp/other' }], tasks: [], requests: [], runtime, runtimes: { codex: runtime, claude: runtime, antigravity: runtime } };
const words = JSON.parse(fs.readFileSync('tests/fixtures/outline-words.json', 'utf8'));
function note(id, index, group) {
  const [quote, x, y, height, width] = words[0].words[index];
  const rect = [x / 612, (y - height) / 792, (x + width) / 612, y / 792];
  return { id, projectId: 'paper', key: 'pdf', page: 0, rect, rects: [rect], quote, comment: group ? '' : `Revise ${id}.`, ...(group ? { group } : {}), source: null, createdAt: index };
}
let notes = [note('n1', 1), note('n2', 2, 'yellow'), note('n3', 3, 'yellow'), note('n4', 4, 'purple'), note('n5', 5)];
const otherNote = { ...note('other-note', 6), projectId: 'other' };
const original = structuredClone(notes), sent = [], attempts = [], items = new Map();
let failDelete = false, holdDelete = false, releaseDelete, deletedFixture, restores = 0;
let fail = false, hold = false, release, failEdit = false, holdEdit = false, failHeldEdit = false, releaseEdit;
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url()), json = value => route.fulfill({ json: value });
  if (url.pathname === '/api/indirect-changes') return json({ indirectChanges: false });
  if (url.pathname === '/api/note-alternatives') return route.fulfill({ json: { noteAlternatives: true, noteAlternativeRange: 'few' } });
  if (url.pathname.endsWith('/git/history')) return json({ versions: [], next: null });
  if (url.pathname === '/api/runtime/requirements') return route.fulfill({ json: readyRequirements });
  if (url.pathname === '/api/state') return json(snapshot);
  if (url.pathname === '/api/updates') return json({ currentVersion: 'test', latestVersion: null, phase: 'idle', checkedAt: 1, error: null, canUpdate: false });
  if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
  if (url.pathname.endsWith('/skills')) return json({ skills: [{ id: 'review', name: 'Review', description: 'Review the paper', hint: '', source: 'builtin', output: 'annotations' }] });
  if (url.pathname.endsWith('/git')) return json({ branch: 'main', files: [] });
  if (url.pathname.endsWith('/git/overview')) return json({ worktrees: [], commits: [], truncated: false });
  if (url.pathname.endsWith('/manuscript')) return json({ git: { branch: 'main', files: [] }, build: { status: 'ready', key: 'pdf', pages: [[612, 792], [612, 792]] }, annotations: url.pathname.includes('/other/') ? [otherNote] : notes });
  if (url.pathname.endsWith('/manuscript.pdf')) return route.fulfill({ contentType: 'application/pdf', body: fs.readFileSync('tests/fixtures/outline.pdf') });
  if (url.pathname.endsWith('/manuscript/words')) return json(words[Number(url.searchParams.get('page'))]);
  if (url.pathname.endsWith('/items')) return json({ items: items.get(url.pathname.split('/')[3]) || [] });
  if (url.pathname.endsWith('/note-results')) return json({ notes: [] });
  if (url.pathname.endsWith('/delete')) {
    if (failDelete) return route.fulfill({ status: 503, json: { error: 'Could not delete the note.' } });
    if (holdDelete) { holdDelete = false; await new Promise(resolve => { releaseDelete = resolve; }); }
    const id = url.pathname.split('/').at(-2);
    deletedFixture = notes.find(note => note.id === id);
    notes = notes.filter(note => note.id !== id); return json({ ok: true });
  }
  if (url.pathname.endsWith('/restore')) {
    restores++;
    notes.push(deletedFixture); notes.sort((a, b) => a.createdAt - b.createdAt);
    return json({ annotations: notes });
  }
  if (/\/annotations\/[^/]+$/.test(url.pathname)) {
    if (failEdit) return route.fulfill({ status: 503, json: { error: 'Could not save the note.' } });
    if (holdEdit) {
      holdEdit = false; const reject = failHeldEdit; failHeldEdit = false;
      await new Promise(resolve => { releaseEdit = resolve; });
      if (reject) return route.fulfill({ status: 503, json: { error: 'First save failed.' } });
    }
    const note = notes.find(note => note.id === url.pathname.split('/').at(-1));
    note.comment = route.request().postDataJSON().comment; return json(note);
  }
  if (url.pathname === '/api/tasks') {
    const body = route.request().postDataJSON(); attempts.push(body);
    if (fail) { fail = false; return route.fulfill({ status: 503, json: { error: 'Try again.' } }); }
    if (hold) { hold = false; await new Promise(resolve => { release = resolve; }); }
    sent.push(body);
    items.set(body.id, [{ id: `message-${body.id}`, taskId: body.id, type: 'user', text: body.instructions, createdAt: Date.now(), meta: { groupInstructions: body.groupInstructions, notes: notes.filter(note => body.annotations?.includes(note.id)).map(note => ({ id: note.id, group: note.group, where: 'Page 1', quote: note.quote, comment: note.comment })) } }]);
    const task = { ...body, name: body.id, title: body.title, status: 'queued', createdAt: Date.now(), updatedAt: Date.now(), review: null };
    snapshot.tasks.push(task); notes = notes.filter(note => !(body.annotations || []).includes(note.id));
    return json(task);
  }
  throw Error(`Unexpected request ${url.pathname}`);
});
const all = () => page.getByRole('button', { name: 'Select all notes for this task', exact: true });
const group = color => page.getByRole('button', { name: `Select all ${color} notes for this task`, exact: true });
const check = id => page.locator(`.notes-panel [data-note="${id}"]`).getByRole('button', { name: /^Include note/ });
const prompt = () => page.getByRole('textbox', { name: 'Describe the revision', exact: true });
const send = () => page.getByRole('button', { name: 'Start task', exact: true });
const instruction = color => page.getByRole('textbox', { name: `Instructions for ${color} notes`, exact: true });
async function setSelection(control, selected) {
  if (await control.getAttribute('aria-pressed') === String(selected)) return;
  await control.click();
  await expect(control).toHaveAttribute('aria-pressed', String(selected));
}
async function notesReady() {
  if (!await page.getByRole('complementary', { name: 'PDF note library' }).isVisible()) await page.getByRole('button', { name: /^My notes(?: · .+)?$/ }).click();
  await expect(all()).toBeVisible();
}
async function switchPaper(name) {
  await page.locator('.project-switcher').click();
  await page.getByRole('menuitemradio', { name: new RegExp(`^${name}`) }).click();
}
try {
  await page.goto(origin);
  // A task's notes are the same cards as My notes, except that × replaces
  // "Included ×": it keeps the annotation; trash deletes it everywhere, and ⌘Z
  // brings it back into the task.
  await notesReady(); await setSelection(check('n1'), true);
  const deletingCard = page.locator('.new-task-panel [data-note="n1"]');
  await expect(deletingCard.locator('.pdf-note-card.pdf-note-inline')).toHaveCount(1);
  await expect(deletingCard.getByRole('button', { name: 'Edit note 1', exact: true })).toBeVisible();
  await expect(deletingCard.getByRole('button', { name: 'Include note 1 in this task', exact: true })).toHaveCount(0);
  await expect(deletingCard.getByText('Included', { exact: true })).toHaveCount(0);
  // Both panels may edit the same note. Only successful writes belong in
  // history, even when the next editor started from optimistic text.
  const historyTool = name => page.getByRole('toolbar', { name: 'Marking tools' }).getByRole('button', { name, exact: true });
  for (const firstFails of [true, false]) {
    await notesReady();
    const libraryCard = page.locator('.notes-panel [data-note="n1"]');
    await deletingCard.getByRole('button', { name: 'Edit note 1', exact: true }).click();
    await deletingCard.getByRole('textbox').fill('First draft.');
    holdEdit = true; failHeldEdit = firstFails; releaseEdit = undefined;
    await deletingCard.getByRole('textbox').press('Enter');
    await expect.poll(() => Boolean(releaseEdit)).toBe(true);
    await libraryCard.getByRole('button', { name: 'Edit note 1', exact: true }).click();
    await expect(libraryCard.getByRole('textbox')).toHaveValue('First draft.');
    await libraryCard.getByRole('textbox').fill('Second draft.');
    await libraryCard.getByRole('textbox').press('Enter');
    releaseEdit(); releaseEdit = undefined;
    await expect.poll(() => notes[0].comment).toBe('Second draft.');
    await expect(libraryCard.getByRole('textbox')).toHaveCount(0);
    if (firstFails) {
      // Dismiss the failed editor without introducing another server write.
      await deletingCard.getByRole('textbox').fill('Second draft.');
      await deletingCard.getByRole('textbox').press('Enter');
    }
    await expect(deletingCard.getByRole('textbox')).toHaveCount(0);
    await page.getByRole('button', { name: /^My notes(?: · .+)?$/ }).click();
    const before = firstFails ? 'Revise n1.' : 'First draft.';
    await historyTool('Undo').click(); await expect.poll(() => notes[0].comment).toBe(before);
    await historyTool('Redo').click(); await expect.poll(() => notes[0].comment).toBe('Second draft.');
    await historyTool('Undo').click(); await expect.poll(() => notes[0].comment).toBe(before);
    if (!firstFails) { await historyTool('Undo').click(); await expect.poll(() => notes[0].comment).toBe('Revise n1.'); }
  }
  await notesReady();
  await deletingCard.getByRole('button', { name: 'Remove note 1 from task', exact: true }).click();
  await expect(deletingCard).toHaveCount(0);
  assert.ok(notes.some(note => note.id === 'n1'));
  await expect(check('n1')).toHaveAttribute('aria-pressed', 'false');
  await setSelection(check('n1'), true);
  await page.getByRole('button', { name: /^My notes(?: · .+)?$/ }).click();
  await expect(page.locator('.note-tag[data-note="n1"]')).toHaveCount(1);
  // Undo and redo must finish before a task can snapshot its selected notes.
  await deletingCard.getByRole('button', { name: 'Edit note 1', exact: true }).click();
  await deletingCard.getByRole('textbox').fill('Changed instruction.');
  await page.keyboard.press('Enter');
  await expect.poll(() => notes[0].comment).toBe('Changed instruction.');
  await expect(deletingCard.getByRole('textbox')).toHaveCount(0);
  for (const [action, comment] of [['Undo', 'Revise n1.'], ['Redo', 'Changed instruction.'], ['Undo', 'Revise n1.']]) {
    holdEdit = true; releaseEdit = undefined;
    await page.getByRole('toolbar', { name: 'Marking tools' }).getByRole('button', { name: action, exact: true }).click();
    await expect.poll(() => Boolean(releaseEdit)).toBe(true);
    await expect(send()).toBeDisabled();
    await page.getByRole('textbox', { name: 'Describe the revision', exact: true }).focus();
    await page.keyboard.press('Enter');
    // Also exercise the submit handler independently of the disabled button.
    await send().evaluate(button => button.form.requestSubmit());
    await page.waitForTimeout(100);
    assert.equal(attempts.length, 0, `${action} must finish before task submission`);
    releaseEdit(); releaseEdit = undefined;
    await expect.poll(() => notes[0].comment).toBe(comment);
    await expect(send()).toBeEnabled();
  }
  failDelete = true;
  await deletingCard.getByRole('button', { name: 'Delete note 1', exact: true }).click();
  await expect(deletingCard.getByRole('alert')).toHaveText('Could not delete the note.');
  await expect(page.locator('.note-tag[data-note="n1"]')).toHaveCount(1);
  await expect(deletingCard).toBeVisible();
  failDelete = false; holdDelete = true;
  await deletingCard.getByRole('button', { name: 'Delete note 1', exact: true }).click();
  await expect.poll(() => Boolean(releaseDelete)).toBe(true);
  await expect(deletingCard.getByRole('button', { name: 'Delete note 1', exact: true })).toBeDisabled();
  await expect(send()).toBeDisabled();
  releaseDelete();
  await expect(deletingCard).toHaveCount(0);
  await expect(page.locator('.pdf-container [data-note="n1"]')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(deletingCard).toBeVisible();
  await expect(page.locator('.note-tag[data-note="n1"]')).toHaveCount(1);
  // Phones have no ⌘Z: the task shows Undo, which also returns the note to the
  // task, and clears the deletion so a later ⌘Z does not restore it again.
  await deletingCard.getByRole('button', { name: 'Delete note 1', exact: true }).click();
  await expect(deletingCard).toHaveCount(0);
  const deleted = page.locator('.task-notes-panel .note-dismissed');
  await expect(deleted).toContainText('Note deleted.');
  const restoresBefore = restores;
  await deleted.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(deletingCard).toBeVisible();
  await expect(deleted).toHaveCount(0);
  assert.equal(restores, restoresBefore + 1);
  await page.locator('.note-selection-head span').click();
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(300);
  assert.equal(restores, restoresBefore + 1, 'A later ⌘Z must not replay an undone deletion');
  assert.equal(notes.filter(note => note.id === 'n1').length, 1);
  await deletingCard.getByRole('button', { name: 'Delete note 1', exact: true }).click();
  await expect(deletingCard).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.note-tag[data-note="n2"]')).toHaveCount(1);
  await expect(page.locator('.pdf-container [data-note="n1"]')).toHaveCount(0);
  assert.ok(!notes.some(note => note.id === 'n1'));
  notes = structuredClone(original);
  await page.reload();

  await expect(page.locator('.new-task-panel [data-note]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Note 1: Revise n1.', exact: true }).click();
  const personalCard = page.getByRole('dialog', { name: 'PDF note 1', exact: true });
  await expect(personalCard).toBeVisible();
  await personalCard.locator('.pdf-suggestion-body p').evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.waitForTimeout(250);
  await expect(page.getByRole('button', { name: 'Add note', exact: true })).toHaveCount(0);
  await page.evaluate(() => document.getSelection().removeAllRanges());
  await page.keyboard.press('Escape');
  await expect(personalCard).toHaveCount(0);
  const marker = page.locator('.note-tag[data-note="n1"]');
  await expect(marker).toBeFocused(); await page.keyboard.press('Enter');
  await expect(personalCard).toBeVisible();
  await prompt().focus(); await page.keyboard.press('Escape');
  await expect(personalCard).toHaveCount(0); await expect(prompt()).toBeFocused();
  await marker.click(); await expect(personalCard).toBeVisible();
  await prompt().click();
  await expect(personalCard).toHaveCount(0); await expect(prompt()).toBeFocused();
  await marker.click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('group', { name: 'Manuscript view' }).getByRole('button', { name: 'PDF', exact: true }).click();
  await expect(personalCard).toHaveCount(0);
  await marker.click();
  await expect(personalCard).toBeVisible();
  await expect(page.locator('.new-task-panel')).not.toBeVisible();
  await personalCard.getByText('Revise n1.', { exact: true }).click();
  const mobileEditor = personalCard.getByRole('textbox', { name: 'Edit note 1', exact: true });
  await expect(mobileEditor).toBeFocused();
  await mobileEditor.fill('A temporary reading thought.');
  await page.screenshot({ path: 'test-results/personal-note-edit-mobile.png', fullPage: true, animations: 'disabled' });
  await mobileEditor.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
  await expect(mobileEditor).toBeVisible();
  await page.getByRole('textbox', { name: 'Page number', exact: true }).click();
  await expect(personalCard).toHaveCount(0);
  assert.equal(notes[0].comment, 'A temporary reading thought.');
  await marker.click();
  await personalCard.getByText('A temporary reading thought.', { exact: true }).click();
  await expect(mobileEditor).toBeFocused();
  await expect(mobileEditor).toHaveValue('A temporary reading thought.');
  await mobileEditor.fill('Revise n1.');
  await mobileEditor.press('ControlOrMeta+Enter');
  // Sending saves the edit, adds the note to the task and closes the popover.
  await expect(personalCard).toHaveCount(0);
  assert.equal(notes[0].comment, 'Revise n1.');
  await marker.click();
  await expect(personalCard.getByText('Revise n1.', { exact: true })).toBeVisible();
  const quoteMobile = personalCard.getByRole('button', { name: 'Include note 1 in this task', exact: true });
  await expect(quoteMobile).toHaveAttribute('aria-pressed', 'true');
  await quoteMobile.click();
  await expect(quoteMobile).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.new-task-panel [data-note]')).toHaveCount(0);
  const cardBox = await personalCard.boundingBox(), pdfBox = await page.locator('.pdf-container').boundingBox();
  assert.ok(cardBox.x >= pdfBox.x && cardBox.x + cardBox.width <= pdfBox.x + pdfBox.width + 1);
  await page.screenshot({ path: 'test-results/personal-note-mobile.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(personalCard.getByRole('button', { name: 'Close note', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(personalCard).toHaveCount(0);
  await notesReady();
  await expect(all()).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.notes-panel input[type="checkbox"]')).toHaveCount(0);
  for (const item of notes) await expect(check(item.id)).toHaveAttribute('aria-pressed', 'false');
  await page.locator('.notes-panel [data-note="n1"] .note-quote-text').click();
  await expect(check('n1')).toHaveAttribute('aria-pressed', 'false');
  await expect(send()).toBeDisabled();
  await setSelection(all(), true);
  await expect(send()).toBeDisabled();
  await instruction('Yellow').fill('Explain the reasoning step by step.');
  await expect(send()).toBeDisabled();
  await instruction('Purple').fill('Shorten this wording.');
  await expect(send()).toBeEnabled();
  // Included notes are edited in place exactly like My notes: the text or ✏️
  // opens the editor; Enter, Escape or a click elsewhere saves.
  const taskCard = page.locator('.task-notes-panel [data-note="n1"]');
  const editTaskNote = () => taskCard.getByRole('button', { name: 'Edit note 1', exact: true });
  const taskText = () => taskCard.locator('.note-edit-trigger');
  const taskEditor = taskCard.getByRole('textbox', { name: 'Edit note 1', exact: true });
  await editTaskNote().focus(); await page.keyboard.press('Enter');
  await expect(taskEditor).toBeFocused();
  await expect(taskEditor).toHaveValue('Revise n1.');
  await expect(editTaskNote()).toHaveCount(0);
  await expect(taskCard.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  await expect(taskCard.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(send()).toBeDisabled();
  await expect(page.locator('.task-notes-panel').getByRole('button', { name: 'Remove all from task', exact: true })).toBeDisabled();
  await taskEditor.fill('   ');
  await expect(taskCard.getByRole('button', { name: 'Remove note 1 from task', exact: true })).toBeDisabled();
  await taskEditor.press('Escape');
  await expect(taskEditor).toHaveCount(0);
  await expect(taskText()).toBeFocused();
  assert.equal(notes[0].comment, 'Revise n1.');
  await taskText().click();
  await expect(taskEditor).toBeFocused();
  await taskEditor.fill('Edited from the task panel.');
  await taskEditor.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await taskEditor.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
  await expect(taskEditor).toHaveValue('Edited from the task panel.');
  assert.equal(notes[0].comment, 'Revise n1.');
  failEdit = true;
  await taskEditor.press('Enter');
  await expect(taskCard.getByRole('alert')).toHaveText('Could not save the note.');
  await expect(taskEditor).toHaveValue('Edited from the task panel.');
  await expect(send()).toBeDisabled();
  failEdit = false; holdEdit = true;
  await taskEditor.press('Enter');
  await expect.poll(() => Boolean(releaseEdit)).toBe(true);
  await expect(taskEditor).toHaveAttribute('readonly', '');
  await expect(taskCard.getByRole('button', { name: 'Delete note 1', exact: true })).toBeDisabled();
  await expect(send()).toBeDisabled();
  releaseEdit();
  await expect(taskEditor).toHaveCount(0);
  await expect(taskCard.getByRole('alert')).toHaveCount(0);
  await expect(taskText()).toHaveText('Edited from the task panel.');
  await expect(check('n1')).toHaveAttribute('aria-pressed', 'true');
  await expect(send()).toBeEnabled();
  assert.equal(notes[0].comment, 'Edited from the task panel.');
  // The library shows the same text; both lists are one note.
  await expect(page.locator('.notes-panel [data-note="n1"] .note-edit-trigger')).toHaveText('Edited from the task panel.');
  await page.reload(); await notesReady();
  await expect(taskText()).toHaveText('Edited from the task panel.');
  await editTaskNote().click();
  await taskEditor.fill('Saved by Escape.'); await taskEditor.press('Escape');
  await expect(taskText()).toHaveText('Saved by Escape.');
  assert.equal(notes[0].comment, 'Saved by Escape.');
  await editTaskNote().click();
  await taskEditor.fill('Saved by clicking elsewhere.');
  await page.screenshot({ path: 'test-results/task-note-edit.png', fullPage: true, animations: 'disabled' });
  await prompt().click();
  await expect(taskEditor).toHaveCount(0);
  await expect(taskText()).toHaveText('Saved by clicking elsewhere.');
  assert.equal(notes[0].comment, 'Saved by clicking elsewhere.');
  // The editor is only the text: the rest of the same card counts as elsewhere.
  for (const part of ['.note-quote-text', '.note-where']) {
    await editTaskNote().click();
    await taskEditor.fill(`Saved by clicking ${part}.`);
    await taskCard.locator(part).click();
    await expect(taskEditor).toHaveCount(0);
    await expect(taskText()).toHaveText(`Saved by clicking ${part}.`);
    assert.equal(notes[0].comment, `Saved by clicking ${part}.`);
  }
  await editTaskNote().click();
  await taskEditor.fill('Revise n1.');
  await taskEditor.press('Enter');
  await expect(taskText()).toHaveText('Revise n1.');
  await expect(taskText()).toBeFocused();
  assert.equal(notes[0].comment, 'Revise n1.');
  // Editing in the task, then starting in the library, saves the task's draft
  // first; the composer waits until the library's editor closes too.
  await editTaskNote().click();
  await taskEditor.fill('Saved when the library editor opens.');
  const otherCard = page.locator('.notes-panel [data-note="n5"]');
  await otherCard.locator('.note-edit-trigger').click();
  await expect(taskEditor).toHaveCount(0);
  assert.equal(notes[0].comment, 'Saved when the library editor opens.');
  await expect(send()).toBeDisabled();
  await otherCard.getByRole('textbox', { name: 'Edit note 5', exact: true }).press('Enter');
  await expect(send()).toBeEnabled();
  // While the task's save is still on its way, the same note opened in My notes
  // starts from the new text and never writes the old one back.
  const libraryN1 = page.locator('.notes-panel [data-note="n1"]');
  const libraryN1Editor = libraryN1.getByRole('textbox', { name: 'Edit note 1', exact: true });
  await editTaskNote().click();
  await taskEditor.fill('Newer text from the task.');
  releaseEdit = undefined; holdEdit = true;
  await libraryN1.locator('.note-edit-trigger').click();
  await expect.poll(() => Boolean(releaseEdit)).toBe(true);
  await expect(libraryN1Editor).toHaveValue('Newer text from the task.');
  releaseEdit();
  await expect(taskText()).toHaveText('Newer text from the task.');
  await page.mouse.click(130, 400);
  await expect(libraryN1Editor).toHaveCount(0);
  await expect(libraryN1.locator('.note-edit-trigger')).toHaveText('Newer text from the task.');
  assert.equal(notes[0].comment, 'Newer text from the task.');
  // A failed save puts the old text back everywhere and keeps the draft.
  await editTaskNote().click();
  await taskEditor.fill('This save fails.');
  failEdit = true;
  await taskEditor.press('Enter');
  await expect(taskCard.getByRole('alert')).toHaveText('Could not save the note.');
  await expect(taskEditor).toHaveValue('This save fails.');
  await expect(libraryN1.locator('.note-edit-trigger')).toHaveText('Newer text from the task.');
  failEdit = false;
  await taskEditor.press('Escape');
  await expect(taskText()).toHaveText('This save fails.');
  assert.equal(notes[0].comment, 'This save fails.');
  // Contents stays over the PDF, leaving even a failed task draft in place.
  const contentsTrigger = page.getByRole('button', { name: 'Contents', exact: true });
  const contentsMenu = page.getByRole('menu', { name: 'Contents', exact: true });
  for (const activation of ['keyboard', 'pointer']) {
    await editTaskNote().click();
    const draft = `Keep this draft while navigating contents with ${activation}.`;
    await taskEditor.fill(draft);
    failEdit = true;
    await taskEditor.press('Enter');
    await expect(taskCard.getByRole('alert')).toHaveText('Could not save the note.');
    if (activation === 'keyboard') { await contentsTrigger.focus(); await page.keyboard.press('Enter'); }
    else await contentsTrigger.click();
    await expect(contentsMenu).toBeVisible();
    await contentsMenu.getByRole('menuitemradio', { name: 'Results', exact: true }).click();
    await expect(contentsMenu).toBeHidden();
    await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('2');
    await expect(taskEditor).toHaveValue(draft);
    await expect(page.getByRole('tab', { name: 'New task', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(send()).toBeDisabled();
    // Clicking outside the editor starts another save. Let that failed
    // request settle before retrying: Enter is ignored while it is busy.
    await expect(taskEditor).toBeEditable();
    failEdit = false;
    await taskEditor.press('Enter');
    await expect(taskText()).toHaveText(draft);
    assert.equal(notes[0].comment, draft);
  }
  // Opening Version Management must save and preserve a failed draft. Use
  // the keyboard as well: it does not trigger the card's pointerdown saver.
  for (const tab of ['Version Management']) {
    await editTaskNote().click();
    await taskEditor.fill(`Keep this draft when opening ${tab}.`);
    failEdit = true;
    await page.locator('.git-link').focus();
    await page.keyboard.press('Enter');
    await expect(taskEditor).toHaveValue(`Keep this draft when opening ${tab}.`);
    await expect(taskCard.getByRole('alert')).toHaveText('Could not save the note.');
    await expect(page.getByRole('tab', { name: 'New task', exact: true })).toHaveAttribute('aria-selected', 'true');
    failEdit = false;
    await page.locator('.git-link').click();
    await expect(page.getByRole('region', { name: 'Version Management', exact: true })).toBeVisible();
    assert.equal(notes[0].comment, `Keep this draft when opening ${tab}.`);
    await page.locator('.manuscript-link').click();
    await expect(taskText()).toHaveText(`Keep this draft when opening ${tab}.`);
  }
  // The library's deselection button must also save the task's draft before
  // removing the card, including when activated without a pointer event.
  await page.getByRole('button', { name: /^My notes(?: · .+)?$/ }).click();
  await editTaskNote().click();
  await taskEditor.fill('Keep this draft when deselecting elsewhere.');
  failEdit = true;
  await taskEditor.press('Enter');
  await expect(taskCard.getByRole('alert')).toHaveText('Could not save the note.');
  await check('n1').focus(); await page.keyboard.press('Enter');
  await expect(taskCard.getByRole('alert')).toHaveText('Could not save the note.');
  await expect(check('n1')).toHaveAttribute('aria-pressed', 'true');
  await expect(taskEditor).toHaveValue('Keep this draft when deselecting elsewhere.');
  failEdit = false;
  await check('n1').click();
  await expect(taskCard).toHaveCount(0);
  assert.equal(notes[0].comment, 'Keep this draft when deselecting elsewhere.');
  await setSelection(check('n1'), true);

  // Phone navigation unmounts the card. Failed drafts and pending writes still
  // belong to the task, so returning must recover the editor and submission lock.
  await page.setViewportSize({ width: 390, height: 844 });
  const views = page.getByRole('group', { name: 'Manuscript view' });
  await views.getByRole('button', { name: 'New task', exact: true }).click();
  async function openMobileView(tab) {
    await views.getByRole('button', { name: tab, exact: true }).click();
    if (tab === 'PDF') {
      await contentsTrigger.click();
      await contentsMenu.getByRole('menuitemradio', { name: 'Results', exact: true }).click();
      await expect(contentsMenu).toBeHidden();
    }
  }
  for (const tab of ['PDF']) {
    await editTaskNote().click();
    await taskEditor.fill(`Keep the mobile draft across ${tab}.`);
    failEdit = true;
    await openMobileView(tab);
    await views.getByRole('button', { name: 'New task', exact: true }).click();
    await expect(taskEditor).toHaveValue(`Keep the mobile draft across ${tab}.`);
    await expect(taskCard.getByRole('alert')).toHaveText('Could not save the note.');
    await expect(send()).toBeDisabled();
    failEdit = false;
    await taskEditor.press('ControlOrMeta+Enter');
    await expect(taskEditor).toHaveCount(0);

    await editTaskNote().click();
    await taskEditor.fill(`Wait for the mobile save across ${tab}.`);
    releaseEdit = undefined; holdEdit = true;
    await openMobileView(tab);
    await expect.poll(() => Boolean(releaseEdit)).toBe(true);
    await views.getByRole('button', { name: 'New task', exact: true }).click();
    await expect(taskEditor).toHaveValue(`Wait for the mobile save across ${tab}.`);
    await expect(taskEditor).toHaveAttribute('readonly', '');
    await expect(send()).toBeDisabled();
    assert.equal(notes[0].comment, `Keep the mobile draft across ${tab}.`);
    releaseEdit();
    await expect(taskText()).toHaveText(`Wait for the mobile save across ${tab}.`);
    await expect(send()).toBeEnabled();
  }
  const openVersionManagement = async () => {
    await page.getByRole('button', { name: 'Show task list', exact: true }).click();
    await page.locator('.git-link').click();
  };
  await editTaskNote().click();
  await taskEditor.fill('Keep the mobile draft across Version Management.');
  failEdit = true;
  await openVersionManagement();
  await expect(taskCard.getByRole('alert')).toHaveText('Could not save the note.');
  await expect(page.getByRole('region', { name: 'Version Management', exact: true })).toHaveCount(0);
  await expect(taskEditor).toHaveValue('Keep the mobile draft across Version Management.');
  failEdit = false;
  // The failed navigation leaves the sidebar open for a retry.
  await page.locator('.git-link').click();
  await expect(page.getByRole('region', { name: 'Version Management', exact: true })).toBeVisible();
  assert.equal(notes[0].comment, 'Keep the mobile draft across Version Management.');
  await page.getByRole('button', { name: 'Show task list', exact: true }).click();
  await page.locator('.manuscript-link').click();
  await views.getByRole('button', { name: 'New task', exact: true }).click();
  await expect(taskText()).toHaveText('Keep the mobile draft across Version Management.');
  await page.setViewportSize({ width: 1440, height: 900 });

  // Review skills hide attachments; returning to the ordinary task recovers
  // failed drafts. The hidden editor must not silently unlock submission.
  await editTaskNote().click();
  await taskEditor.fill('Keep this draft across the review skill.');
  failEdit = true;
  await page.locator('.new-task-panel').getByRole('button', { name: 'Add files or skills', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Review', exact: true }).click();
  await expect(taskCard).toHaveCount(0);
  await expect(send()).toBeDisabled();
  await page.locator('.new-task-panel').getByRole('button', { name: 'Add skill', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Review', exact: true }).click();
  await expect(taskEditor).toHaveValue('Keep this draft across the review skill.');
  await expect(taskCard.getByRole('alert')).toHaveText('Could not save the note.');

  // A different paper has its own editing state, while this paper's failed
  // draft remains available when its annotations finish loading again.
  await switchPaper('Other paper'); await notesReady();
  await setSelection(check('other-note'), true);
  await expect(send()).toBeEnabled();
  await setSelection(check('other-note'), false);
  await switchPaper('Paper'); await notesReady();
  await expect(taskEditor).toHaveValue('Keep this draft across the review skill.');
  await expect(taskCard.getByRole('alert')).toHaveText('Could not save the note.');
  await expect(send()).toBeDisabled();
  failEdit = false;
  await taskEditor.press('Enter');
  await expect(taskText()).toHaveText('Keep this draft across the review skill.');

  // Saving and taking a note out of the task in one click, as in My notes.
  await editTaskNote().click();
  await taskEditor.fill('Revise n1.');
  await taskCard.getByRole('button', { name: 'Remove note 1 from task', exact: true }).click();
  await expect(taskCard).toHaveCount(0);
  await expect(check('n1')).toHaveAttribute('aria-pressed', 'false');
  assert.equal(notes[0].comment, 'Revise n1.');
  await setSelection(check('n1'), true);
  // Cards are keyboard operable; editing and locating a note do not change
  // whether that note will be sent.
  await check('n1').focus(); await page.keyboard.press('Space');
  await expect(check('n1')).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Enter');
  await expect(check('n1')).toHaveAttribute('aria-pressed', 'true');
  const libraryCard = page.locator('.notes-panel [data-note="n1"]');
  await libraryCard.getByRole('button', { name: 'Edit note 1: Revise n1.', exact: true }).click();
  const libraryEditor = libraryCard.getByRole('textbox', { name: 'Edit note 1', exact: true });
  await expect(libraryEditor).toBeFocused();
  await expect(libraryCard.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  await expect(libraryCard.getByRole('button', { name: 'Edit note 1', exact: true })).toHaveCount(0);
  await expect(libraryCard.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(libraryCard.getByRole('button', { name: 'Add to task', exact: true })).toHaveCount(0);
  await expect(check('n1')).toHaveAttribute('aria-pressed', 'true');
  await libraryEditor.fill('Edited directly in the note library.');
  failEdit = true;
  await libraryEditor.press('Enter');
  await expect(libraryCard.getByRole('alert')).toHaveText('Could not save the note.');
  await expect(libraryEditor).toHaveValue('Edited directly in the note library.');
  assert.equal(notes[0].comment, 'Revise n1.');
  failEdit = false;
  await libraryEditor.press('Escape');
  await expect(libraryEditor).toHaveCount(0);
  await expect(libraryCard.getByRole('button', { name: 'Edit note 1: Edited directly in the note library.', exact: true })).toBeFocused();
  assert.equal(notes[0].comment, 'Edited directly in the note library.');
  await libraryCard.getByRole('button', { name: 'Edit note 1', exact: true }).click();
  await expect(libraryEditor).toBeFocused();
  await libraryEditor.fill('Revise n1.');
  await check('n1').click();
  await expect(libraryEditor).toHaveCount(0);
  await expect(check('n1')).toHaveAttribute('aria-pressed', 'false');
  assert.equal(notes[0].comment, 'Revise n1.');
  await check('n1').click();
  // Jumping from an edited card saves first; a failed save keeps the draft.
  await libraryCard.getByRole('button', { name: 'Edit note 1: Revise n1.', exact: true }).click();
  await libraryEditor.fill('Keep this note when jumping to the PDF.');
  failEdit = true;
  await libraryCard.getByRole('button', { name: 'Show note 1 on the page', exact: true }).click();
  await expect(libraryEditor).toHaveValue('Keep this note when jumping to the PDF.');
  await expect(libraryCard.getByRole('alert')).toHaveText('Could not save the note.');
  assert.equal(notes[0].comment, 'Revise n1.');
  failEdit = false;
  await libraryCard.getByRole('button', { name: 'Show note 1 on the page', exact: true }).click();
  await expect(libraryEditor).toHaveCount(0);
  await expect(personalCard.getByText('Keep this note when jumping to the PDF.', { exact: true })).toBeVisible();
  assert.equal(notes[0].comment, 'Keep this note when jumping to the PDF.');
  await page.keyboard.press('Escape');
  await expect(personalCard).toHaveCount(0);
  await notesReady();
  await libraryCard.getByRole('button', { name: /^Edit note 1:/ }).click();
  await libraryEditor.fill('Keep this note when closing the library.');
  failEdit = true;
  await page.getByRole('button', { name: 'Close notes', exact: true }).click();
  await expect(libraryEditor).toHaveValue('Keep this note when closing the library.');
  await expect(libraryCard.getByRole('alert')).toHaveText('Could not save the note.');
  assert.equal(notes[0].comment, 'Keep this note when jumping to the PDF.');
  failEdit = false;
  await page.getByRole('button', { name: 'Close notes', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'PDF note library' })).toHaveCount(0);
  assert.equal(notes[0].comment, 'Keep this note when closing the library.');
  await notesReady();
  await libraryCard.getByRole('button', { name: /^Edit note 1:/ }).click();
  await libraryEditor.fill('Revise n1.');
  await libraryEditor.press('Enter');
  await expect(libraryEditor).toHaveCount(0);
  await expect(check('n1')).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: 'test-results/note-library-shared-card.png', fullPage: true });
  await setSelection(check('n2'), false);
  await page.getByRole('button', { name: 'Show note 2 on the page', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'PDF note 2', exact: true })).toBeVisible();
  await notesReady();
  await expect(check('n2')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.notes-panel [data-note="n2"]')).toHaveAttribute('data-selected', 'false');
  const backgrounds = await page.locator('.notes-panel .group-location').evaluateAll(rows => rows.slice(0, 2).map(row => getComputedStyle(row).backgroundColor));
  assert.notEqual(backgrounds[0], backgrounds[1], 'Selected cards must have a distinct highlight');
  await expect(all()).toHaveAttribute('aria-pressed', 'mixed');
  await expect(group('Yellow')).toHaveAttribute('aria-pressed', 'mixed');
  await expect(page.getByText('Added to task: 4', { exact: true })).toBeVisible();
  await page.reload(); await notesReady();
  await expect(instruction('Yellow')).toHaveValue('Explain the reasoning step by step.');
  await expect(instruction('Purple')).toHaveValue('Shorten this wording.');
  await expect(check('n2')).toHaveAttribute('aria-pressed', 'false');
  await switchPaper('Other paper'); await notesReady(); await expect(all()).toHaveAttribute('aria-pressed', 'false');
  await setSelection(check('other-note'), true);
  await switchPaper('Paper'); await notesReady();
  await expect(check('n2')).toHaveAttribute('aria-pressed', 'false');
  await setSelection(group('Yellow'), true);
  await expect(check('n2')).toHaveAttribute('aria-pressed', 'true');
  await setSelection(group('Yellow'), false);
  await expect(check('n3')).toHaveAttribute('aria-pressed', 'false');
  await setSelection(all(), true); await setSelection(all(), false);
  await expect(send()).toBeDisabled();
  await prompt().press('Enter'); assert.equal(attempts.length, 0);
  await setSelection(check('n1'), true);
  await expect(send()).toBeEnabled();
  await setSelection(check('n3'), true);
  await expect(send()).toBeEnabled();
  await expect(prompt()).toHaveValue('');
  fail = true; await send().click();
  await expect(page.getByRole('alert').filter({ hasText: 'Try again.' })).toBeVisible();
  assert.deepEqual(notes, original);
  await expect(check('n1')).toHaveAttribute('aria-pressed', 'true'); await expect(check('n3')).toHaveAttribute('aria-pressed', 'true'); await expect(check('n2')).toHaveAttribute('aria-pressed', 'false');
  await expect(instruction('Yellow')).toHaveValue('Explain the reasoning step by step.');
  await page.screenshot({ path: 'test-results/note-selection-desktop.png', fullPage: true, animations: 'disabled' });
  hold = true; await send().click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await expect(all()).toBeDisabled(); await expect(check('n2')).toBeDisabled();
  assert.deepEqual(attempts[1].annotations, ['n1', 'n3']);
  assert.deepEqual(attempts[1].groupInstructions, { yellow: 'Explain the reasoning step by step.' });
  assert.equal(attempts[1].instructions, '');
  assert.equal(attempts[0].id, attempts[1].id, 'Retry the same task after a failure');
  const concurrent = note('n6', 6); notes.push(concurrent); release();
  await expect(page.getByRole('region', { name: 'Notes in this task', exact: true })).toHaveCount(0);
  assert.deepEqual(notes, [original[1], original[3], original[4], concurrent]);
  assert.equal(sent[0].agent, 'codex');
  await page.locator(`.task-row[data-task="${sent[0].id}"] .task-link`).click();
  await expect(page.locator('.thread .group-instruction-sent')).toHaveText('Explain the reasoning step by step.');
  await page.locator('.manuscript-link').click();
  await page.reload(); await notesReady();
  await expect(instruction('Yellow')).toHaveCount(0);
  await expect(instruction('Purple')).toHaveCount(0);
  await expect(all()).toHaveAttribute('aria-pressed', 'false');
  await expect(check('n6')).toHaveAttribute('aria-pressed', 'false');
  await switchPaper('Other paper'); await notesReady(); await expect(check('other-note')).toHaveAttribute('aria-pressed', 'true');
  await switchPaper('Paper'); await notesReady();
  await setSelection(check('n2'), true); await setSelection(check('n4'), true);
  await expect(instruction('Yellow')).toHaveValue('Explain the reasoning step by step.');
  await expect(instruction('Purple')).toHaveValue('Shorten this wording.');
  await page.locator('.new-task-panel').getByRole('button', { name: 'Agent settings', exact: true }).click();
  await page.getByRole('option', { name: / · Claude$/ }).first().click();
  await page.keyboard.press('Escape');
  await expect(prompt()).toHaveValue('');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('group', { name: 'Manuscript view' }).getByRole('button', { name: 'New task', exact: true }).click();
  await page.screenshot({ path: 'test-results/group-instructions-mobile.png', fullPage: true, animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.setViewportSize({ width: 1440, height: 900 });
  await send().click();
  await expect(page.getByRole('region', { name: 'Notes in this task', exact: true })).toHaveCount(0);
  assert.deepEqual(sent[1].annotations, ['n2', 'n4']); assert.equal(sent[1].agent, 'claude');
  assert.deepEqual(sent[1].groupInstructions, { yellow: 'Explain the reasoning step by step.', purple: 'Shorten this wording.' });
  assert.equal(sent[1].instructions, '');
  assert.equal(await page.evaluate(() => localStorage.getItem('papilot:group-instructions')), null);
  assert.deepEqual(notes, [original[4], concurrent]);
  await expect(all()).toHaveAttribute('aria-pressed', 'false'); await prompt().fill('A question without any annotations.'); await send().click();
  await expect.poll(() => sent.length).toBe(3);
  assert.equal(sent[2].annotations, undefined); assert.deepEqual(notes, [original[4], concurrent]);
  await expect(all()).toHaveAttribute('aria-pressed', 'false');
  // The same controls remain usable without horizontal overflow on phones.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('group', { name: 'Manuscript view' }).getByRole('button', { name: 'PDF', exact: true }).click();
  await notesReady();
  await setSelection(check('n6'), true);
  await page.getByRole('button', { name: 'Close notes', exact: true }).click();
  await page.getByRole('group', { name: 'Manuscript view' }).getByRole('button', { name: 'New task', exact: true }).click();
  await expect(page.getByText('Added to task: 1', { exact: true })).toBeVisible();
  const mobileTaskCard = page.locator('.task-notes-panel [data-note="n6"]');
  await mobileTaskCard.getByRole('button', { name: /^Edit note \d+$/ }).click();
  await mobileTaskCard.getByRole('textbox', { name: /^Edit note/ }).fill('Clarify this passage.\n补充说明。');
  await page.screenshot({ path: 'test-results/task-note-edit-mobile.png', fullPage: true, animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  // Phones keep Enter for new lines; tapping elsewhere saves.
  await page.getByText('Added to task: 1', { exact: true }).click();
  await expect(mobileTaskCard.getByRole('textbox')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/note-selection-mobile.png', fullPage: true, animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await expect(prompt()).toHaveValue('');
  await send().click();
  await expect.poll(() => sent.length).toBe(4);
  assert.deepEqual(sent[3].annotations, ['n6']);
  assert.equal(items.get(sent[3].id)[0].meta.notes[0].comment, 'Clarify this passage.\n补充说明。');
  assert.equal(sent[3].instructions, ''); assert.equal(sent[3].groupInstructions, undefined);
  assert.deepEqual(notes, [original[4]]);
  // Undo belongs to the task draft it was shown in: sending that task clears it,
  // so it can never add the note to the next one.
  await page.setViewportSize({ width: 1440, height: 900 });
  await notesReady();
  await setSelection(check('n5'), true);
  await page.locator('.task-notes-panel [data-note="n5"]').getByRole('button', { name: /^Delete note/ }).click();
  await expect(page.locator('.task-notes-panel .note-dismissed')).toContainText('Note deleted.');
  await prompt().fill('A question after deleting a note.');
  fail = true; await send().click();
  await expect(page.getByRole('alert').filter({ hasText: 'Try again.' })).toBeVisible();
  await expect(page.locator('.task-notes-panel .note-dismissed')).toContainText('Note deleted.');
  await send().click();
  await expect.poll(() => sent.length).toBe(5);
  await expect(page.locator('.task-notes-panel .note-dismissed')).toHaveCount(0);
  assert.equal(sent[4].annotations, undefined);
  await page.locator('.side-tabs [role="tab"]').first().focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(check('n5')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.task-notes-panel [data-note="n5"]')).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log('PASS: notes default to saved only, explicit selection, direct note sends, inline color-group instructions, persistence, failure/retry, partial sends to different agents, retained group drafts, grouped history, plain questions, and mobile controls.');
} finally { release?.(); releaseEdit?.(); releaseDelete?.(); await browser.close(); await server.close(); }
