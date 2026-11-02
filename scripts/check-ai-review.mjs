import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from '../engine/node_modules/@playwright/test/index.mjs';

fs.mkdirSync('test-results', { recursive: true });
const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 1000 } });
const archives = [];
const errors = []; page.on('pageerror', error => errors.push(error.message));
const runtime = { connected: true, authenticated: true, models: [] };
const state = { version: 'test', csrf: 'fixture', projects: [{ id: 'paper', name: 'Review example', path: '/tmp/paper' }], tasks: [], requests: [], runtime };
const words = JSON.parse(fs.readFileSync('tests/fixtures/outline-words.json', 'utf8'));
const text = words[0].words[1], rect = [text[1] / 612, (text[2] - text[3]) / 792, (text[1] + text[4]) / 612, text[2] / 792];
const note = { id: 'ai-finding-1', projectId: 'paper', key: 'pdf', page: 0, rect, rects: [rect], quote: text[0], comment: 'State the assumptions under which this claim holds.', source: null, createdAt: Date.now(), aiReview: { taskId: 'review', agent: 'codex' } };
const nextText = words[1].words.at(-1), nextRect = [nextText[1] / 612, (nextText[2] - nextText[3]) / 792, (nextText[1] + nextText[4]) / 612, nextText[2] / 792];
const second = { ...note, id: 'ai-finding-2', page: 1, rect: nextRect, rects: [nextRect], quote: nextText[0], comment: 'Explain how this conclusion follows from the evidence. ' + 'Specify the assumptions and distinguish the observed result from the broader claim. '.repeat(18) };
const personal = { ...note, id: 'personal-note', comment: 'My reading thought.', aiReview: undefined };
let notes = [personal], reviewNotes = [], attempts = [], edits = [], copies = [], fail = true, failDelete = true, failCopy = true;
let releaseRestore, restoreCommitted = false;
const restoreGate = new Promise(resolve => { releaseRestore = resolve; });
const fixturePdf = fs.readFileSync('tests/fixtures/outline.pdf');
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url()), json = value => route.fulfill({ json: value });
  if (url.pathname === '/api/state') return json(state);
  if (url.pathname === '/api/updates') return json({ currentVersion: 'test', latestVersion: null, phase: 'idle', checkedAt: 1, error: null, canUpdate: false });
  if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
  if (url.pathname.endsWith('/skills')) return json({ skills: [{ id: 'ai-review', name: 'AI review', description: 'Read the paper and leave PDF comments without editing the manuscript', hint: 'Review focus', source: 'builtin', output: 'annotations' }] });
  if (url.pathname.endsWith('/git')) return json({ branch: 'main', files: [] });
  if (url.pathname.endsWith('/manuscript')) return json({ git: { branch: 'main', files: [] }, build: { current: true, status: 'ready', key: 'pdf', pages: [[612, 792], [612, 792]] }, annotations: notes });
  if (url.pathname.endsWith('/manuscript.pdf') || url.pathname.endsWith('/ai-review/pdf')) return route.fulfill({ contentType: 'application/pdf', body: fixturePdf });
  if (url.pathname.endsWith('/manuscript/words') || url.pathname.endsWith('/ai-review/words')) return json(words[Number(url.searchParams.get('page'))]);
  if (url.pathname.endsWith('/ai-review')) return json({ key: 'pdf', notes: reviewNotes });
  if (url.pathname.endsWith('/items')) return json({ items: [{ id: 'answer', taskId: state.tasks[0]?.id, type: 'assistant', text: 'Clarify the assumptions behind the main claim.\n\n1. **Page 1** — ' + note.comment + '\n\n2. **Page 2** — ' + second.comment, createdAt: 1 }] });
  if (url.pathname.endsWith('/note-results')) return json({ notes: [] });
  if (url.pathname.endsWith('/ai-review/ai-finding-1/copy')) {
    copies.push(route.request().postDataJSON());
    if (failCopy) { failCopy = false; return route.fulfill({ status: 503, json: { error: 'Could not copy. Try again.' } }); }
    const copy = { ...note, id: 'copied-finding-1', aiReview: { ...note.aiReview, sourceId: note.id } };
    if (!notes.some(item => item.id === copy.id)) notes.push(copy);
    note.aiReview.copiedTo = copy.id;
    return json({ note, copy });
  }
  if (url.pathname.endsWith('/ai-review/ai-finding-1/delete')) {
    if (failDelete) { failDelete = false; return route.fulfill({ status: 503, json: { error: 'Could not ignore. Try again.' } }); }
    reviewNotes = reviewNotes.filter(item => item.id !== note.id); return json({ ok: true });
  }
  if (url.pathname.endsWith('/ai-review/ai-finding-1/restore')) {
    reviewNotes = [note, ...reviewNotes]; state.tasks[0].aiReview.revision++;
    restoreCommitted = true; await restoreGate; return json(note);
  }
  if (url.pathname.endsWith('/archive')) { archives.push(route.request().postDataJSON()); return json(state.tasks[0]); }
  if (url.pathname === '/api/tasks' && route.request().postDataJSON().skill === 'ai-review') {
    const body = route.request().postDataJSON(); attempts.push(body);
    if (fail) { fail = false; return route.fulfill({ status: 503, json: { error: 'Temporary failure. Try again.' } }); }
    const task = { ...body, name: body.id, mode: 'review', status: 'reviewing', aiReview: { key: 'pdf', notes: 2 }, createdAt: 1, updatedAt: 1, review: { state: 'done', round: null, counts: {}, files: [], unsent: 0, comments: 0 } };
    note.aiReview.taskId = body.id; second.aiReview = { ...note.aiReview };
    state.tasks.push(task); reviewNotes = [note, second]; return json(task);
  }
  if (url.pathname === '/api/tasks') {
    const body = route.request().postDataJSON(); edits.push(body);
    const task = { ...body, name: body.id, status: 'queued', createdAt: 2, updatedAt: 2, review: null };
    state.tasks.push(task); notes = notes.filter(item => !body.annotations?.includes(item.id)); return json(task);
  }
  throw Error(`Unexpected request ${url.pathname}`);
});
try {
  await page.goto(`http://127.0.0.1:${server.server.address().port}`);
  const chooseReview = async () => {
    await page.getByRole('button', { name: 'Add files or skills', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'AI review', exact: true }).click();
    await expect(page.locator('.composer-skill')).toHaveText('AI review');
  };
  await expect(page.getByRole('group', { name: 'Task type' })).toHaveCount(0);
  await chooseReview();
  await page.getByRole('textbox', { name: 'Describe the revision' }).fill('Check assumptions and clarity.');
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  await expect(page.getByText('Temporary failure. Try again.', { exact: true })).toBeVisible();
  await page.reload(); await chooseReview();
  await expect(page.getByRole('textbox', { name: 'Describe the revision' })).toHaveValue('Check assumptions and clarity.');
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  await page.locator('.task-link').first().click();
  await expect(page.locator('.message.assistant .message-body')).toHaveText('Clarify the assumptions behind the main claim.');
  await expect(page.locator('.message.assistant ol')).toHaveCount(0);
  await expect(page.locator('.ai-review-view .pdfViewer canvas').first()).toBeVisible();
  await expect(page.getByText('Review copy', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark region', exact: true })).toHaveCount(0);
  assert.equal(attempts.length, 2); assert.equal(attempts[0].id, attempts[1].id);
  assert.equal(attempts[0].skill, 'ai-review'); assert.equal(attempts[0].mode, undefined);
  assert.deepEqual(notes.map(item => item.id), [personal.id], 'review completion leaves the manuscript alone');
  await page.getByRole('button', { name: 'AI suggestions', exact: true }).click();
  const suggestions = page.getByRole('dialog', { name: 'AI suggestion 1', exact: true });
  const copy = suggestions.getByRole('button', { name: 'Keep on manuscript', exact: true });
  await expect(copy).toHaveText('');
  await expect(copy).toHaveAttribute('title', 'Keep on manuscript');
  await expect(suggestions.getByText(note.comment, { exact: true })).toBeVisible();
  await expect(suggestions.getByRole('button', { name: /^Edit note/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Note 1:/ })).toHaveCount(0, 'personal notes do not leak into the task copy');
  // Another device changes findings without changing the task's timestamp.
  // The annotation revision must refresh both the markers and open popover.
  reviewNotes = [second]; state.tasks[0].aiReview.revision = 1;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('.note-tag[data-note="ai-finding-1"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'AI suggestions', exact: true })).toHaveText('1');
  reviewNotes = [note, second]; state.tasks[0].aiReview.revision = 2;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(suggestions).toBeVisible();
  await expect(page.getByRole('button', { name: 'AI suggestions', exact: true })).toHaveText('2');
  await page.screenshot({ path: 'test-results/ai-review-task-copy.png', fullPage: true });
  await suggestions.screenshot({ path: 'test-results/ai-review-bookmark.png' });
  const fits = async () => {
    const dialog = await page.locator('.pdf-suggestion').boundingBox(), area = await page.locator('.pdf-container').boundingBox();
    assert.ok(dialog && area && dialog.x >= area.x && dialog.x + dialog.width <= area.x + area.width + 1 && dialog.y >= area.y && dialog.y + dialog.height <= area.y + area.height + 1, JSON.stringify({ dialog, area }));
  };
  await fits();
  await suggestions.getByRole('button', { name: 'Next suggestion' }).click();
  await expect(page.getByRole('dialog', { name: 'AI suggestion 2', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Page number', exact: true })).toHaveValue('2');
  await fits();
  assert.equal(await page.locator('.pdf-suggestion-body').evaluate(element => element.scrollHeight > element.clientHeight), true);
  await page.getByRole('button', { name: 'Previous suggestion', exact: true }).click();
  await expect(suggestions).toBeVisible();
  // Navigation follows the open card, including across pages, without taking
  // over text editing, selection, IME composition, or modified arrow keys.
  await page.keyboard.press('ArrowLeft');
  await expect(suggestions).toBeVisible();
  await page.keyboard.press('Shift+ArrowRight');
  await expect(suggestions).toBeVisible();
  await suggestions.dispatchEvent('keydown', { key: 'ArrowRight', isComposing: true });
  await expect(suggestions).toBeVisible();
  const composer = page.getByRole('textbox', { name: /^Instructions for / });
  await composer.fill('abc');
  await composer.evaluate(element => element.setSelectionRange(0, 0));
  await page.keyboard.press('ArrowRight');
  assert.equal(await composer.evaluate(element => element.selectionStart), 1);
  await expect(suggestions).toBeVisible();
  await composer.fill('');
  await suggestions.focus();
  await suggestions.getByText(note.comment, { exact: true }).evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await page.keyboard.press('ArrowRight');
  await expect(suggestions).toBeVisible();
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await suggestions.focus();
  await page.keyboard.press('ArrowRight');
  const nextSuggestion = page.getByRole('dialog', { name: 'AI suggestion 2', exact: true });
  await expect(nextSuggestion).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Page number', exact: true })).toHaveValue('2');
  await page.keyboard.press('ArrowRight');
  await expect(nextSuggestion).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(suggestions).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Page number', exact: true })).toHaveValue('1');
  await page.setViewportSize({ width: 1680, height: 1000 });
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(suggestions).toHaveCount(0);
  await page.getByRole('button', { name: `Suggestion 1: ${note.comment}`, exact: true }).click();
  await expect(suggestions).toBeVisible(); await fits();
  await suggestions.focus(); await page.keyboard.press('Escape');
  await expect(suggestions).toHaveCount(0);
  await page.getByRole('button', { name: 'AI suggestions', exact: true }).click();
  await copy.click();
  await expect(suggestions.getByRole('alert')).toHaveText('Could not copy. Try again.');
  assert.deepEqual(notes.map(item => item.id), [personal.id]);
  await copy.click();
  await expect(suggestions.getByRole('button', { name: 'Kept on manuscript', exact: true })).toBeDisabled();
  await suggestions.screenshot({ path: 'test-results/ai-review-bookmark-saved.png' });
  await page.keyboard.press('ArrowRight');
  await expect(nextSuggestion).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(suggestions).toBeVisible();
  assert.equal(copies.length, 2); assert.equal(edits.length, 0);
  assert.deepEqual(notes.map(item => item.id), [personal.id, 'copied-finding-1']);
  await expect(page.locator('.task-link.active')).toHaveCount(1);
  await suggestions.getByRole('button', { name: 'Ignore suggestion 1', exact: true }).click();
  await expect(suggestions.getByRole('alert')).toHaveText('Could not ignore. Try again.');
  await suggestions.getByRole('button', { name: 'Ignore suggestion 1', exact: true }).click();
  await expect(suggestions).toHaveCount(0);
  assert.equal(notes.length, 2, 'ignoring a task finding leaves its manuscript copy intact');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  // Polling can see the restored note before the slower POST reply arrives.
  await expect.poll(() => restoreCommitted).toBe(true);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('.note-tag[data-note="ai-finding-1"]')).toHaveCount(1);
  releaseRestore();
  await expect(suggestions.getByRole('button', { name: 'Kept on manuscript', exact: true })).toBeDisabled();
  await expect(page.locator('.note-tag[data-note="ai-finding-1"]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'AI suggestions', exact: true })).toHaveText('2');
  await page.reload();
  await page.getByRole('button', { name: 'AI suggestions', exact: true }).click();
  await expect(suggestions.getByRole('button', { name: 'Kept on manuscript', exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('group', { name: 'Workspace view' }).getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'AI suggestions', exact: true }).click();
  await expect(suggestions).toBeVisible(); await fits();
  await page.screenshot({ path: 'test-results/ai-review-task-mobile.png', fullPage: true, animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.manuscript-link').click();
  await expect(page.getByRole('button', { name: /^Suggestion 2:/ })).toBeVisible();
  await expect(page.locator('.note-tag[data-note="ai-finding-2"]')).toHaveCount(0);
  await page.locator('.note-tag[data-note="copied-finding-1"]').click();
  const manuscriptCard = page.getByRole('dialog', { name: 'AI suggestion 2', exact: true });
  await expect(manuscriptCard.getByText(note.comment, { exact: true })).toBeVisible();
  await expect(manuscriptCard.getByRole('button', { name: 'Keep on manuscript', exact: true })).toHaveCount(0);
  await manuscriptCard.getByRole('button', { name: 'Include suggestion 2 in this task', exact: true }).click();
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  await expect.poll(() => edits.length).toBe(1);
  assert.deepEqual(edits[0].annotations, ['copied-finding-1']);
  assert.equal(reviewNotes.length, 2, 'sending the copy does not consume the original task findings');
  assert.deepEqual(archives, []); assert.deepEqual(errors, []);
  console.log('PASS: AI review task PDF, isolated findings, bookmark/retry/idempotence, keyboard navigation and input guards, ignore/undo, reload, mobile layout and explicit manuscript handoff.');
} finally { releaseRestore(); await browser.close(); await server.close(); }
