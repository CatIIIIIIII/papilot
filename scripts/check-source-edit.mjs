// A real LaTeX task, edited through the browser. Everything lives in a
// disposable repository; no agent or manuscript owned by the user is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium, expect } from '../engine/node_modules/@playwright/test/index.mjs';
import { Fixture, METHOD } from '../engine/tests/ts/helpers.ts';
import { createServer } from '../engine/src/server.ts';

const f = new Fixture();
f.write(METHOD, '\\section{Method}\nOriginal sentence.\n');
f.repo.run(['add', '.']); f.repo.run(['commit', '-qm', 'Short editing fixture']);
const app = f.app(); await app.ready;
const task = app.tasks.create('manual', 'Local source editing', [], ['paper'], true);
f.edit(task, METHOD, 'Original sentence.', 'Proposed sentence.');
app.publisher.submit(task.name); await app.publisher.join();
assert.equal(app.publisher.current(task.name)?.status, 'done', JSON.stringify(app.publisher.current(task.name)));
const server = createServer(app);
await server.listen({ host: '127.0.0.1', port: 0 });
app.url = `http://127.0.0.1:${server.server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const edit = () => page.locator('.source-editor').getByRole('button', { name: '编辑', exact: true });
const field = () => page.getByRole('textbox', { name: '编辑 LaTeX 源码' });
const save = () => page.getByRole('button', { name: '保存并更新 PDF', exact: true });
const waitRound = async number => {
  await expect.poll(() => app.review.latestRound(task.name)?.number, { timeout: 90000 }).toBe(number);
  await expect.poll(() => app.review.latestRound(task.name)?.visuals, { timeout: 90000 }).toBe('ready');
};
const open = async () => {
  const source = page.locator('.source');
  if (!await source.isVisible()) await page.getByRole('button', { name: 'LaTeX', exact: true }).click();
  await edit().click();
};
try {
  await page.goto(app.url + '/?task=manual&lang=zh-Hans');
  await expect(page.locator('.change')).toBeVisible();
  await page.getByRole('button', { name: 'LaTeX', exact: true }).click();
  const originalBox = await page.locator('.source-code').boundingBox();
  await open();
  await expect(page.locator('.source-code')).toHaveCount(1);
  await expect(page.locator('pre.source-code')).toHaveCount(0);
  await expect(page.locator('.source-title').getByRole('button', { name: '保存并更新 PDF', exact: true })).toBeVisible();
  const editingBox = await page.locator('.source-code').boundingBox();
  assert.equal(editingBox.x, originalBox.x, 'editing uses the existing source surface');
  assert.equal(editingBox.y, originalBox.y, 'the source stays in place when editing begins');
  assert.equal(editingBox.width, originalBox.width);
  await expect(field()).toHaveValue('Proposed sentence.\n');
  await field().fill('A precise manual correction.');
  await field().press('Escape');
  await expect(page.locator('pre.source-code')).toHaveCount(1);
  await expect(page.locator('.latex-input')).toHaveCount(0);
  await edit().click();
  await expect(field()).toHaveValue('A precise manual correction.');
  await page.reload(); await open();
  await expect(field()).toHaveValue('A precise manual correction.');
  const highlighted = String.raw`We prove \textbf{type safety} for this calculus.
% Keep the author's wording: 中文注释
For $x_i \in \mathbb{R}$, let \(\bar{x}=\frac{1}{n}\sum_i x_i\).
Literal symbols: \% and \$; \verb|% $ { }|.
`;
  await field().fill(highlighted);
  const backdrop = page.locator('.latex-highlight');
  await expect(backdrop.locator('.latex-command').first()).toHaveText('\\textbf');
  await expect(backdrop.locator('.latex-comment')).toHaveText("% Keep the author's wording: 中文注释");
  assert.equal(await backdrop.textContent(), highlighted + '\u200b');
  assert.equal(await page.locator('.source-editor-actions').innerText(), '', 'actions use icons with accessible names');
  await expect(save()).toHaveAttribute('title', /Enter/);
  assert.equal(await field().inputValue(), highlighted, 'syntax highlighting never rewrites the source');
  // Wrapping and vertical scrolling share the native textarea's dimensions.
  await field().fill((highlighted + 'A long line '.repeat(60) + '\n').repeat(12));
  await field().evaluate(input => { input.scrollTop = input.scrollHeight; input.dispatchEvent(new Event('scroll')); });
  await expect.poll(() => field().evaluate(input => {
    const pre = input.previousElementSibling;
    return Math.abs(pre.scrollTop - input.scrollTop) < 1 && pre.clientWidth === input.clientWidth;
  })).toBe(true);
  await field().fill(highlighted);
  fs.mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/source-edit-desktop.png' });
  await field().fill('A precise manual correction.');
  await field().press('Control+Enter');
  await waitRound(2);
  await expect(page.locator('.source-code')).toContainText('A precise manual correction', { timeout: 15000 });
  assert.match(f.read(METHOD, task.worktree), /A precise manual correction\.\n/);
  assert.match(f.read(METHOD), /Original sentence/);
  assert.equal(app.review.pageState(task.name).decisions.c001, 'pending');

  // Stale edits retain the draft and refuse to overwrite a changed file.
  await edit().click(); await field().fill('My unsaved draft.');
  f.edit(task, METHOD, 'A precise manual correction.', 'External edit.');
  await save().click();
  await expect(page.locator('.source-editor-error')).toContainText('编辑期间源码发生了变化');
  await expect(field()).toHaveValue('My unsaved draft.');
  assert.match(f.read(METHOD, task.worktree), /External edit/);
  await page.getByRole('button', { name: '恢复已保存的源码' }).click();
  await expect(field()).toHaveValue('External edit.\n');

  // Compilation failure inserts a failed round and keeps its source editable.
  await field().fill('\\unknownSourceEditCommand'); await save().click();
  await expect.poll(() => app.publisher.current(task.name)?.status, { timeout: 90000 }).toBe('failed');
  assert.equal(app.review.latestRound(task.name)?.number, 3);
  assert.equal(app.review.latestRound(task.name)?.visuals, 'failed');
  // The publisher can fail before the browser has loaded its new round.
  // Wait for that round's source before opening its editor.
  await expect(page.locator('.source-code')).toContainText('\\unknownSourceEditCommand', { timeout: 15000 });
  await expect(edit()).toBeEnabled({ timeout: 15000 }); await edit().click();
  await expect(field()).toHaveValue('\\unknownSourceEditCommand\n');
  await field().fill('Repaired by hand.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/source-edit-mobile.png' });
  const fits = await field().evaluate(element => element.getBoundingClientRect().right <= window.innerWidth);
  assert.equal(fits, true);
  await save().click(); await waitRound(4);
  await expect(page.locator('.source-code')).toContainText('Repaired by hand', { timeout: 15000 });

  // Reverting the last proposal produces an empty current review.
  await edit().click(); await field().fill('Original sentence.'); await save().click();
  await waitRound(5);
  await expect(page.locator('.change')).toHaveCount(0, { timeout: 15000 });
  assert.deepEqual(app.review.pageState(task.name).decisions, {});
  assert.equal(f.read(METHOD, task.worktree), f.read(METHOD));
  assert.deepEqual(errors, []);
  console.log('Source editing passed: one source surface, in-place edit and diff switching, header icons, syntax highlighting, wrapping and scrolling, draft recovery, keyboard save, real PDF rebuild, stale write refusal, compilation repair, mobile layout, empty review.');
} finally {
  await browser.close(); await server.close(); await f.close();
}
