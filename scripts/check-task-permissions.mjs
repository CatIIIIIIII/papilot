import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from '../engine/node_modules/@playwright/test/index.mjs';
import { selectOption, selectedValue } from './select.mjs';

fs.mkdirSync('test-results', { recursive: true });
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
let permissionFailure = false; const permissionChanges = [];
await context.addInitScript(() => {
  localStorage.setItem('papilot:task', 'fixture-task');
  localStorage.setItem('papilot:recent-models', JSON.stringify([{ agent: 'claude', model: 'opus' }]));
});
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url()), json = data => route.fulfill({ json: data });
  if (url.pathname.endsWith('/indirect-changes')) return json({ indirectChanges: false });
  if (url.pathname === '/api/state') return json(snapshot);
  if (url.pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
  if (url.pathname === '/api/updates') return json({ currentVersion: 'test', latestVersion: 'test', phase: 'idle', canUpdate: false });
  if (url.pathname.endsWith('/ai-review')) return json({ notes: [] });
  if (url.pathname.endsWith('/manuscript')) return json({ git: { files: [] }, annotations: [], build: { status: 'building', current: false } });
  if (url.pathname.endsWith('/skills')) return json({ skills: [] });
  if (url.pathname.endsWith('/items')) return json({ items: [] });
  if (url.pathname.endsWith('/note-results')) return json({ notes: [] });
  if (url.pathname.endsWith('/git')) return json({ files: [], branch: 'main', ahead: 0, behind: 0 });
  if (url.pathname.endsWith('/permissions')) {
    const body = route.request().postDataJSON(); permissionChanges.push(body);
    if (permissionFailure) return route.fulfill({ status: 503, json: { error: 'Permission change failed.' } });
    Object.assign(task, body); return json(task);
  }
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
  await page.getByRole('button', {name:'Chat', exact:true}).click();
  const picker = page.locator('.activity-panel').getByRole('combobox', { name: 'Task permissions', exact: true });
  await expect(picker).toBeDisabled();
  task.status = 'reviewing'; await page.reload();
  await expect(picker).toBeEnabled();
  await expect(picker).toHaveAttribute('data-value', 'workspace');
  await picker.click();
  await page.screenshot({animations:'disabled',path:'test-results/task-permissions-menu.png'});
  await picker.press('Escape');
  await selectOption(picker, 'full');
  await expect(picker).toHaveAttribute('data-value', 'full');
  assert.equal(task.permissions, 'full');
  await page.screenshot({animations:'disabled',path:'test-results/task-permissions-full.png'});
  await page.reload(); await expect(picker).toHaveAttribute('data-value', 'full');
  await selectOption(picker, 'workspace');
  await expect(picker).toHaveAttribute('data-value', 'workspace');
  permissionFailure = true;
  await selectOption(picker, 'full');
  await expect(page.getByText('Permission change failed.', { exact: true })).toBeVisible();
  await expect(picker).toHaveAttribute('data-value', 'workspace');
  permissionFailure = false;
  task.agent = 'cursor'; snapshot.runtimes.cursor = runtime;
  await page.reload(); await expect(picker).toHaveCount(0);
  task.agent = 'codex'; task.mode = 'review';
  await page.reload(); await expect(picker).toHaveCount(0);
  delete task.mode; snapshot.tasks = [];
  await page.evaluate(() => localStorage.removeItem('papilot:task'));
  await page.reload();
  const fresh = page.locator('.new-task-panel').getByRole('combobox', { name: 'Task permissions', exact: true });
  await expect(fresh).toHaveAttribute('data-value', 'workspace');
  await selectOption(fresh, 'full');
  await fresh.click();
  await page.screenshot({animations:'disabled',path:'test-results/task-permissions-new.png'});
  await fresh.press('Escape');
  const creates = [];
  await page.route('**/api/tasks', async route => {
    creates.push(route.request().postDataJSON());
    return route.fulfill({ status: 503, json: { error: 'Captured submission.' } });
  });
  await page.getByRole('textbox', { name: 'Describe the revision', exact: true }).fill('Inspect results over SSH.');
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  await expect.poll(() => creates.length).toBe(1);
  assert.equal(creates[0].permissions, 'full');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(fresh).toBeVisible();
  const box = await fresh.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 390);
  assert.deepEqual(errors, []);
  console.log('PASS: permissions default, busy lock, save/downgrade, persistence, error recovery, provider/review restrictions, creation and mobile layout.');
} finally { await browser.close(); await server.close(); }
