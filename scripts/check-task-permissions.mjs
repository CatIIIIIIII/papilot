import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { Codex } from '../src/server/codex.ts';
import { ClaudeAgent } from '../src/server/agents.ts';
import { chromium, expect } from '../engine/node_modules/@playwright/test/index.mjs';

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
const runtime = { permissionOptions: new Codex().permissionOptions(), connected: true, authenticated: true, account: null, error: null, models: [
  { id: 'fast-model', name: 'Fast model', isDefault: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
  { id: 'deep-model', name: 'Deep model', isDefault: false, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', fastMode: { serviceTier: 'priority', description: 'Faster responses' } },
] };
const snapshot = { version: 'test', csrf: 'test', projects: [{ id: 'paper', name: 'Paper', path: '/tmp/paper', createdAt: 1 }], tasks: [task], requests: [], runtime, runtimes: { codex: runtime, claude: { ...runtime, permissionOptions: Object.assign(new ClaudeAgent(), { cli: '/fixture/claude' }).permissionOptions(), models: [{ id: 'opus', name: 'Opus', isDefault: true, efforts: ['low', 'high'], defaultEffort: 'high' }] } } };
const modelChanges = [], messages = [];
let modelFailure = false, holdModel, releaseModel;
let permissionFailure = false, holdPermission, releasePermission; const permissionChanges = [];
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
    if (holdPermission) await holdPermission;
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
  const trigger = page.locator('.activity-panel').getByRole('button', { name: 'Agent settings', exact: true });
  const menu = page.getByRole('dialog', { name: 'Agent settings', exact: true });
  const workspace = menu.getByRole('radio', { name: 'Workspace access', exact: true });
  const full = menu.getByRole('radio', { name: 'Full access', exact: true });
  const open = async (button = trigger) => { if (!await menu.isVisible()) await button.click(); };
  const choose = async (radio) => {
    await open();
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/permissions')), radio.click()]);
    await expect(trigger).toBeEnabled();
    await open();
  };
  await expect(trigger).toHaveCount(1);
  await expect(page.getByRole('combobox', { name: 'Task permissions', exact: true })).toHaveCount(0);
  await open();
  await expect(workspace).toBeDisabled();
  await expect(menu.getByRole('slider', { name: 'Reasoning effort', exact: true })).toBeEnabled();
  await expect(menu.getByText('Pause the task before changing permissions.', { exact: true })).toBeVisible();
  task.status = 'reviewing'; await page.reload(); await open();
  await expect(workspace).toBeEnabled();
  await expect(workspace).toBeChecked();
  await page.screenshot({ animations: 'disabled', path: 'test-results/task-permissions-menu.png' });
  await choose(full);
  await expect(full).toBeChecked();
  assert.equal(task.permissions, 'full');
  await page.screenshot({ animations: 'disabled', path: 'test-results/task-permissions-full.png' });
  await page.reload(); await open(); await expect(full).toBeChecked();
  await choose(workspace);
  await expect(workspace).toBeChecked();
  permissionFailure = true;
  await choose(full);
  await expect(page.getByText('Permission change failed.', { exact: true })).toBeVisible();
  await expect(workspace).toBeChecked();
  permissionFailure = false;
  // Sending and model changes wait for a permission save; permission changes
  // also wait for the existing model-save queue.
  await menu.press('Escape');
  await page.getByRole('textbox', { name: 'Instructions for Codex' }).fill('Continue.');
  await open();
  holdPermission = new Promise(resolve => { releasePermission = resolve; });
  await full.click();
  await expect(trigger).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Send instructions', exact: true })).toBeDisabled();
  releasePermission(); holdPermission = null;
  await expect(trigger).toBeEnabled(); await open(); await expect(full).toBeChecked();
  holdModel = new Promise(resolve => { releaseModel = resolve; });
  await menu.getByRole('option', { name: 'Deep model · Codex', exact: true }).last().click();
  await expect(full).toBeDisabled();
  releaseModel(); holdModel = null;
  await expect(full).toBeEnabled();
  await menu.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const taskTrigger = await trigger.boundingBox(), taskSend = await page.getByRole('button', { name: 'Send instructions', exact: true }).boundingBox();
  assert.ok(taskTrigger.x >= 0 && taskTrigger.x + taskTrigger.width <= taskSend.x, 'existing-task settings must not overlap send');
  await open(); await expect(full).toBeChecked();
  const taskMenu = await menu.boundingBox();
  assert.ok(taskMenu.x >= 0 && taskMenu.x + taskMenu.width <= 390 && taskMenu.y >= 0 && taskMenu.y + taskMenu.height <= 844);
  await page.screenshot({ animations: 'disabled', path: 'test-results/task-permissions-task-mobile.png' });
  await menu.press('Escape'); await page.setViewportSize({ width: 1440, height: 900 });
  task.agent = 'claude';
  await page.reload(); await open();
  await expect(menu.getByRole('radio', { name: 'Sandboxed edits', exact: true })).toBeVisible();
  await expect(menu.getByText(/Other permission requests are denied in print mode/)).toBeVisible();
  assert.equal(await menu.locator('.task-permission-option small').first().evaluate(el => el.scrollWidth <= el.clientWidth), true, 'permission descriptions must not be truncated');
  await page.screenshot({ animations: 'disabled', path: 'test-results/task-permissions-claude.png' });
  task.agent = 'glm'; snapshot.runtimes.glm = { ...runtime, permissionOptions: new ClaudeAgent().permissionOptions() };
  await page.reload(); await open();
  await expect(menu.getByText(/Ask before other actions/)).toBeVisible();
  task.agent = 'cursor'; snapshot.runtimes.cursor = { ...runtime, permissionOptions: [] };
  await page.reload(); await open(); await expect(menu.getByRole('group', { name: 'Task permissions', exact: true })).toHaveCount(0);
  task.agent = 'codex'; task.mode = 'review';
  await page.reload(); await open(); await expect(menu.getByRole('group', { name: 'Task permissions', exact: true })).toHaveCount(0);
  delete task.mode; snapshot.tasks = [];
  await page.evaluate(() => localStorage.removeItem('papilot:task'));
  await page.reload();
  const fresh = page.locator('.new-task-panel').getByRole('button', { name: 'Agent settings', exact: true });
  await expect(fresh).toHaveCount(1);
  await open(fresh); await expect(workspace).toBeChecked();
  await full.check(); await expect(full).toBeChecked();
  await expect(menu.getByRole('slider', { name: 'Reasoning effort', exact: true })).toBeVisible();
  await expect(page.locator(':popover-open')).toHaveCount(1);
  await page.screenshot({ animations: 'disabled', path: 'test-results/task-permissions-new.png' });
  // Switching agents updates permissions inside the same open menu.
  await menu.getByRole('option', { name: 'Opus · Claude', exact: true }).last().click();
  await expect(menu.getByRole('radio', { name: 'Bypass permissions', exact: true })).toBeChecked();
  await expect(menu.getByRole('radio', { name: 'Full access', exact: true })).toHaveCount(0);
  await menu.getByRole('option', { name: 'Deep model · Codex', exact: true }).last().click();
  await expect(full).toBeChecked();
  await menu.press('Escape');
  const creates = [];
  await page.route('**/api/tasks', async route => {
    creates.push(route.request().postDataJSON());
    return route.fulfill({ status: 503, json: { error: 'Captured submission.' } });
  });
  await page.getByRole('textbox', { name: 'Describe the revision', exact: true }).fill('Inspect results over SSH.');
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  await expect.poll(() => creates.length).toBe(1);
  assert.equal(creates[0].permissions, 'full');
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport);
    await expect(fresh).toBeVisible();
    const box = await fresh.boundingBox(), send = await page.getByRole('button', { name: 'Start task', exact: true }).boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= send.x, 'settings trigger must not overlap the send button');
    await open(fresh);
    const panel = await menu.boundingBox();
    assert.ok(panel.x >= 0 && panel.x + panel.width <= viewport.width && panel.y >= 0 && panel.y + panel.height <= viewport.height, 'all settings share one menu within the viewport');
    await workspace.check(); await expect(workspace).toBeChecked();
    await workspace.press('ArrowDown'); await expect(full).toBeChecked();
    await page.screenshot({ animations: 'disabled', path: `test-results/task-permissions-mobile-${viewport.width}.png` });
    await menu.press('Escape');
  }
  assert.deepEqual(errors, []);
  console.log('PASS: shared agent menu, native permission options, busy/save locks, persistence, error recovery, provider/review restrictions, creation, keyboard and narrow-screen layout.');
} finally { await browser.close(); await server.close(); }
