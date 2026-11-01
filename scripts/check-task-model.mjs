import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from '../vendor/latex-review/node_modules/@playwright/test/index.mjs';

const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
const page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message));
const task = { id: 'fixture-task', projectId: 'paper', agent: 'codex', name: 'p-task', title: 'Revise the introduction', instructions: 'Keep the meaning.', worktree: '/tmp/paper', threadId: 'thread', turnId: 'turn', model: null, effort: null, status: 'running', createdAt: 1, updatedAt: 1, feedbackCursor: 0, error: null, review: null };
const runtime = { connected: true, authenticated: true, account: null, error: null, models: [
  { id: 'fast-model', name: 'Fast model', isDefault: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
  { id: 'deep-model', name: 'Deep model', isDefault: false, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', fastMode: { serviceTier: 'priority', description: 'Faster responses' } },
] };
const snapshot = { version: 'test', csrf: 'test', projects: [{ id: 'paper', name: 'Paper', path: '/tmp/paper', createdAt: 1 }], tasks: [task], requests: [], runtime, runtimes: { codex: runtime, claude: { ...runtime, models: [{ id: 'opus', name: 'Opus', isDefault: true, efforts: ['low', 'high'], defaultEffort: 'high' }] } } };
const modelChanges = [], messages = [];
let modelFailure = false, holdModel, releaseModel;
await context.addInitScript(() => {
  localStorage.setItem('papilot:task', 'fixture-task');
  localStorage.setItem('papilot:recent-models', JSON.stringify([{ agent: 'claude', model: 'opus' }]));
});
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url()), json = data => route.fulfill({ json: data });
  if (url.pathname === '/api/state') return json(snapshot);
  if (url.pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
  if (url.pathname === '/api/updates') return json({ currentVersion: 'test', latestVersion: 'test', phase: 'idle', canUpdate: false });
  if (url.pathname.endsWith('/skills')) return json({ skills: [] });
  if (url.pathname.endsWith('/items')) return json({ items: [] });
  if (url.pathname.endsWith('/note-results')) return json({ notes: [] });
  if (url.pathname.endsWith('/git')) return json({ files: [], branch: 'main', ahead: 0, behind: 0 });
  if (url.pathname.endsWith('/model')) {
    const body = route.request().postDataJSON(); modelChanges.push(body);
    if (holdModel) await holdModel;
    if (modelFailure) return route.fulfill({ status: 503, json: { error: 'Model settings could not be saved.' } });
    Object.assign(task, body, { model: body.model || null, effort: body.effort || null });
    return json(task);
  }
  if (url.pathname.endsWith('/messages')) { messages.push(route.request().postDataJSON()); return json({ ok: true }); }
  throw new Error(`Unexpected fixture request: ${url.pathname}`);
});

try {
  await page.goto(origin);
  await page.getByRole('textbox', { name: 'Instructions for Codex' }).fill('Continue with these settings.');
  const taskSettings = page.locator('.activity-panel').getByRole('button', { name: 'Agent settings', exact: true });
  const taskModelMenu = page.getByRole('dialog', { name: 'Agent settings', exact: true });
  const taskEffort = taskModelMenu.getByRole('slider', { name: 'Reasoning effort', exact: true });
  await expect(taskSettings).toContainText('Fast model');
  await expect(taskSettings).toContainText('Medium');
  await taskSettings.click();
  await taskModelMenu.getByText('Changes apply to the next turn.', { exact: true }).waitFor();
  assert.ok((await taskModelMenu.getByRole('option').allTextContents()).every(name => !/Opus/.test(name)), 'recent choices cannot switch the task agent');
  await taskModelMenu.getByRole('combobox').fill('opus');
  await expect(taskModelMenu.getByRole('option')).toHaveCount(0);
  await taskModelMenu.getByRole('combobox').fill('');
  await taskModelMenu.getByRole('option', { name: 'Deep model · Codex', exact: true }).last().click();
  await expect.poll(() => task.model).toBe('deep-model');
  await taskEffort.press('End');
  await expect.poll(() => task.effort).toBe('xhigh');
  await expect(taskSettings).toContainText('Xhigh');
  await taskModelMenu.getByRole('switch', { name: 'Fast mode' }).check();
  await expect.poll(() => task.serviceTier).toBe('priority');
  await taskModelMenu.getByRole('button', { name: 'Model default', exact: true }).click();
  await expect.poll(() => task.effort).toBe(null);
  await expect(taskSettings).toContainText('High');
  await taskEffort.press('End');
  await expect.poll(() => task.effort).toBe('xhigh');
  await taskModelMenu.getByRole('option', { name: 'Fast model · Codex', exact: true }).last().click();
  await expect.poll(() => task.model).toBe('fast-model');
  await expect(taskSettings).toContainText('Medium');
  assert.equal(task.effort, null, 'incompatible Xhigh resets to model default');
  assert.equal(task.serviceTier, 'default');
  await taskModelMenu.getByRole('combobox').press('Escape');
  await page.reload();
  await expect(taskSettings).toContainText('Fast model');
  await taskSettings.click();
  await expect(taskEffort).toHaveAttribute('aria-valuetext', 'Medium');
  // Rapid changes are saved in order; instructions wait for their settings.
  holdModel = new Promise(resolve => { releaseModel = resolve; });
  await taskEffort.press('End');
  await taskEffort.press('Home');
  await expect(taskSettings).toContainText('Low');
  await expect(page.getByRole('button', { name: 'Send instructions', exact: true })).toBeDisabled();
  releaseModel(); holdModel = null;
  await expect.poll(() => task.effort).toBe('low');
  modelFailure = true;
  await taskEffort.press('End');
  await page.getByText('Model settings could not be saved.', { exact: true }).waitFor();
  await expect(taskSettings).toContainText('Low');
  modelFailure = false;
  fs.mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/task-model-desktop.png' });
  await taskModelMenu.getByRole('combobox').press('Escape');
  await page.getByRole('button', { name: 'Send instructions', exact: true }).click();
  assert.equal(messages.length, 1);
  assert.equal(task.status, 'running'); assert.equal(task.threadId, 'thread'); assert.equal(task.turnId, 'turn');
  assert.ok(modelChanges.every(change => !('agent' in change)));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await taskSettings.click();
  await expect(taskModelMenu).toBeVisible();
  const box = await taskModelMenu.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390);
  await page.screenshot({ path: 'test-results/task-model-mobile.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: Task model and effort stay editable within the same agent, persist, serialize changes, recover from save failures and fit mobile');
} finally {
  releaseModel?.();
  await browser.close(); await server.close();
}
