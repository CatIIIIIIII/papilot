import { readyRequirements } from './required-tools-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium } from '../engine/node_modules/playwright/index.mjs';

const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ locale: 'en-US', colorScheme: 'dark', viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(15000);
const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error('PAGE ERROR', error.message); });
const task = { id: 'review-notes-fixture', projectId: 'paper', name: 'p-notes', title: 'Polish the acknowledgments', status: 'reviewing', createdAt: 1, updatedAt: 1, review: { round: 1, state: 'reviewed', counts: { pending: 0, rejected: 1, accepted: 1 } } };
const snapshot = { version: 'test', csrf: 'fixture', projects: [{ id: 'paper', name: 'Thesis', path: '/tmp/thesis' }], tasks: [task], requests: [], runtime: { connected: true, authenticated: true, models: [] } };
const markdown = '已润色 [acknowledgments.tex](/Users/chen/thesis/main/frontmatter/acknowledgments.tex:26)。\n\n| Item | Result |\n| --- | --- |\n| Text | **Ready** |\n\n- Parent\n  - Nested *item*\n\n- [x] Reviewed\n\n~~Previous~~';
let failSend = true;
const messages = [];
await page.route('**/api/**', route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/indirect-changes') return route.fulfill({ json: { indirectChanges: false } });
  if (url.pathname === '/api/note-alternatives') return route.fulfill({ json: { noteAlternatives: true, noteAlternativeRange: 'few' } });
  if (url.pathname === '/api/updates') return route.fulfill({ json: { currentVersion: snapshot.version, latestVersion: null, phase: 'idle', checkedAt: 1, error: null, canUpdate: true } });
  if (url.pathname === '/api/runtime/requirements') return route.fulfill({ json: readyRequirements });
  if (url.pathname === '/api/state') return route.fulfill({ json: snapshot });
  if (url.pathname.endsWith('/skills')) return route.fulfill({ json: { skills: [] } });
  if (url.pathname.endsWith('/items')) return route.fulfill({ json: { items: [{ id: 'reply', taskId: task.id, type: 'assistant', text: markdown, createdAt: 1 }] } });
  if (url.pathname.endsWith('/messages')) {
    messages.push(route.request().postDataJSON());
    if (!failSend) { task.review.unsent = 0; task.review.comments = 0; }
    return route.fulfill(failSend ? { status: 503, json: { error: 'Temporary failure. Try again.' } } : { json: { ok: true } });
  }
  if (url.pathname.endsWith('/git')) return route.fulfill({ json: { files: [], branch: 'main' } });
  if (url.pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
  throw Error(`Unexpected request ${url.pathname}`);
});
const strip = (text, page) => `<div class="pdf-strip" data-page="${page}" style="aspect-ratio:600/180"><img alt="" aria-hidden="true" width="600" height="180"><div class="pdf-text"><span class="pdf-text-line"><span class="pdf-glyph" style="left:15%;top:30%;font-size:20px">${text}</span></span></div></div>`;
const review = `<html><head><style>${fs.readFileSync('engine/src/web/style.css', 'utf8')} .pdf-glyph{color:#171717}</style></head><body><header class="bar"><div class="identity"><span>Round 1</span></div><span class="meter">2 of 2 decided</span></header><main id="paper"><div class="document"><div class="sheet"><div class="context">${strip('Unchanged paragraph for context.', 'ix')}</div>${['rejected', 'accepted'].map((state, i) => `<article class="change inline" data-stop="${i}" data-state="${state}" data-resolved="${i ? 'after' : 'before'}"><header class="change-head"><span class="change-number">Change ${i + 1}</span><span class="change-where" title="main/frontmatter/acknowledgments.tex:26–43">main/frontmatter/acknowledgments.tex:26–43</span><span class="badge">${state}</span></header><div class="side ${i ? 'after' : 'before'}">${strip(i ? 'Accepted paragraph remains available.' : 'Thank you to my friends and family.', 'x')}</div></article>`).join('')}</div></div></main></body></html>`;
await page.route('**/review/**', route => route.fulfill({ contentType: 'text/html', body: review }));
const frame = () => page.frameLocator('.review-frame');
async function selectText(selector) {
  await frame().locator(selector).evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el);
    const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  const comment = frame().getByRole('button', { name: 'Comment', exact: true });
  await comment.waitFor({ state: 'visible' });
  assert.equal(await comment.evaluate(button => {
    const bounds = button.getBoundingClientRect(), paper = document.getElementById('paper').getBoundingClientRect();
    return !button.closest('.pdf-strip') && bounds.top >= paper.top && bounds.bottom <= paper.bottom &&
      bounds.left >= paper.left && bounds.right <= paper.right &&
      button.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2));
  }), true, 'selection action must escape strip stacking, fit the viewer and remain clickable');
  await comment.click();
}

const noteInput = n => page.getByRole('textbox', { name: `Comment ${n}`, exact: true });
const send = () => page.getByRole('button', { name: 'Send instructions', exact: true });
const savedDraft = () => page.evaluate(() => JSON.parse(localStorage.getItem('papilot:review-notes:review-notes-fixture')));
try {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Region', exact: true }).waitFor();
  await frame().locator('.review-note-layer').first().waitFor({ state: 'attached' });
  assert.equal(await page.locator('.markdown .file-reference').textContent(), 'acknowledgments.tex');
  assert.equal(await page.locator('.markdown table td').last().textContent(), 'Ready');
  assert.equal(await page.locator('.markdown ul ul li').textContent(), 'Nested item');
  await page.locator('.file-reference').click();
  await page.getByRole('button', { name: 'Copied path' }).waitFor();
  await page.getByRole('button', { name: 'Region', exact: true }).click();
  await frame().locator('.review-region-capture').first().waitFor();
  await page.keyboard.press('Escape');
  await frame().locator('.review-region-capture').first().waitFor({ state: 'hidden' });
  await selectText('[data-state="accepted"] .pdf-glyph');
  await page.getByRole('button', { name: 'Delete review note 1' }).click();
  await selectText('[data-state="rejected"] .pdf-glyph');
  assert.equal(await frame().locator('.sheet').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(41, 41, 41)');
  assert.match(await frame().locator('.pdf-strip img').first().evaluate(el => getComputedStyle(el).filter), /invert/);
  await noteInput(1).fill('Keep all the names and make this warmer.');
  await frame().locator('.review-note-tag').first().waitFor();
  assert.equal(await frame().locator('[data-state="rejected"]').getAttribute('data-state'), 'rejected');
  await page.reload();
  assert.equal(await noteInput(1).inputValue(), 'Keep all the names and make this warmer.');
  await selectText('[data-state="accepted"] .pdf-glyph');
  await noteInput(2).fill('Keep this accepted paragraph.');
  await page.getByRole('button', { name: 'Region', exact: true }).click();
  const box = await frame().locator('.context .review-region-capture').boundingBox();
  await page.mouse.move(box.x + 60, box.y + 20); await page.mouse.down();
  await page.mouse.move(box.x + 250, box.y + 65, { steps: 5 }); await page.mouse.up();
  await noteInput(3).fill('Check the spacing in this region.');
  const originalNotes = (await savedDraft()).notes; console.log('Created notes', originalNotes.length);
  await noteInput(2).fill('Keep this accepted paragraph and its citation.'); console.log('Edited notes', (await savedDraft()).notes.length);
  await page.reload();
  assert.equal(await noteInput(2).inputValue(), 'Keep this accepted paragraph and its citation.');
  assert.deepEqual((await savedDraft()).notes[1], { ...originalNotes[1], comment: 'Keep this accepted paragraph and its citation.' });
  // Deletion undo survives reload; native textarea undo does not restore notes.
  const beforeDelete = (await savedDraft()).notes;
  await page.getByRole('button', { name: 'Delete review note 2' }).click();
  await page.getByRole('button', { name: 'Delete review note 1' }).click();
  await noteInput(1).fill(''); await noteInput(1).pressSequentially('Undo this text');
  await noteInput(1).press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  assert.ok((await noteInput(1).inputValue()).length < 'Undo this text'.length);
  assert.equal((await savedDraft()).notes.length, 1);
  await noteInput(1).fill(beforeDelete[2].comment);
  await page.reload();
  await page.getByRole('button', { name: 'Region', exact: true }).focus();
  await page.keyboard.press('Meta+z'); await frame().locator('.review-note-tag').nth(1).waitFor();
  await page.keyboard.press('Control+z'); await frame().locator('.review-note-tag').nth(2).waitFor();
  assert.deepEqual((await savedDraft()).notes, beforeDelete);
  fs.mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/review-notes-desktop.png', fullPage: true });
  await send().click();
  await page.getByRole('alert').waitFor(); assert.equal(messages.length, 1);
  await page.reload(); failSend = false;
  await send().click(); await frame().locator('.review-note-tag').first().waitFor({ state: 'hidden' });
  assert.deepEqual(messages[0], messages[1]);
  assert.match(messages[1].notes[0].where, /Round 1 · PDF page x · Before · Change 1/);
  assert.match(messages[1].notes[1].where, /After · Change 2/);
  assert.match(messages[1].notes[2].where, /Unchanged text · Region in displayed strip/);
  assert.deepEqual(messages[1].notes[0].anchor, { round: 1, sources: [{ file: 'main/frontmatter/acknowledgments.tex', lines: [26, 43] }] });
  // A phone moves straight from selection to the same chat draft.
  await page.setViewportSize({ width: 320, height: 740 });
  await page.getByRole('button', { name: /^Review/ }).first().click();
  await selectText('.context .pdf-glyph'); await noteInput(1).waitFor({ state: 'visible' });
  await noteInput(1).fill('Keep the names.');
  const bounds = await noteInput(1).boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);
  await page.screenshot({ path: 'test-results/review-notes-mobile.png', fullPage: true });
  // Continuous group marking keeps focus in the document; shared instructions use Chat.
  await page.evaluate(() => localStorage.removeItem('papilot:review-notes:review-notes-fixture'));
  await page.setViewportSize({ width: 1440, height: 900 }); await page.reload();
  await frame().locator('.review-note-layer').first().waitFor({ state: 'attached' });
  await page.getByRole('button', { name: 'Note', exact: true }).click();
  await page.getByRole('button', { name: 'Note', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Green', exact: true }).click();
  for (const [index, selector] of ['.context .pdf-glyph', '.before .pdf-glyph'].entries()) {
    await frame().locator(selector).first().evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el);
      const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }));
    });
    await page.waitForFunction(count => JSON.parse(localStorage.getItem('papilot:review-notes:review-notes-fixture'))?.notes.length === count, index + 1);
  }
  await frame().locator('.review-note-tag[data-group="green"]').nth(1).waitFor();
  assert.equal(await page.locator('.review-draft textarea:focus').count(), 0);
  await page.getByRole('button', { name: 'Note', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Individual notes', exact: true }).click();
  await page.getByRole('textbox', { name: 'Instructions for color groups' }).fill('Green: explain these passages.');
  const beforeGroups = messages.length;
  await send().click(); await page.waitForFunction(() => !document.querySelector('.review-draft'));
  assert.equal(messages.length, beforeGroups + 1);
  assert.equal(messages.at(-1).text, 'Green: explain these passages.');
  assert.deepEqual(messages.at(-1).notes.map(note => [note.group, note.comment]), [['green', ''], ['green', '']]);
  assert.deepEqual(errors, []);
  console.log('PASS: review quotes and regions, autosave, persistent delete/undo, native text undo, unified retry, phone commenting and continuous color groups');
} catch (error) { console.error('Draft:', await savedDraft(), '\nBODY:', await page.locator('body').innerText()); await page.screenshot({ path: 'test-results/review-notes-failure.png' }); throw error; } finally { await browser.close(); await server.close(); }
