import { readyRequirements } from './required-tools-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { Codex } from '../src/server/codex.ts';
import { ClaudeAgent } from '../src/server/agents.ts';
import { CursorAgent } from '../src/server/cursor.ts';
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
snapshot.runtimes.kimi = { ...runtime, models: [{ id: 'kimi-k3', name: 'Kimi K3', isDefault: true, efforts: [] }], permissionOptions: [
  { value: 'workspace', label: 'Default', detail: 'Ask before tools' }, { value: 'plan', label: 'Plan', detail: 'Read-only planning' },
  { value: 'auto', label: 'Auto', detail: 'Approve safe operations' }, { value: 'full', label: 'YOLO', detail: 'Approve all tools' },
] };
const modelChanges = [], messages = [];
let modelFailure = false, holdModel, releaseModel;
let permissionFailure = false, holdPermission, releasePermission; const permissionChanges = [];
let holdState, releaseState, stateFailure = false, stateReads = 0, stateFailures = 0;
await context.addInitScript(() => {
  localStorage.setItem('papilot:task', 'fixture-task');
  localStorage.setItem('papilot:recent-models', JSON.stringify([{ agent: 'claude', model: 'opus' }]));
});
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url()), json = data => route.fulfill({ json: data });
  if (url.pathname === '/api/runtime/requirements') return json(readyRequirements);
  if (url.pathname.endsWith('/indirect-changes')) return json({ indirectChanges: false });
  if (url.pathname === '/api/state') {
    stateReads++;
    const captured = structuredClone(snapshot);
    if (stateFailure) { stateFailures++; return route.fulfill({ status: 503, json: { error: 'State unavailable.' } }); }
    if (holdState) await holdState;
    return json(captured);
  }
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
    Object.assign(task, body, { updatedAt: task.updatedAt + 1 }); return json(task);
  }
  if (url.pathname.endsWith('/model')) {
    const body = route.request().postDataJSON(); modelChanges.push(body);
    if (holdModel) await holdModel;
    if (modelFailure) return route.fulfill({ status: 503, json: { error: 'Model settings could not be saved.' } });
    Object.assign(task, body, { model: body.model || null, effort: body.effort || null, updatedAt: task.updatedAt + 1 });
    return json(task);
  }
  if (url.pathname.endsWith('/messages')) { messages.push({ body: route.request().postDataJSON(), effectivePermissions: task.permissions }); return json({ ok: true }); }
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
  await expect(trigger.locator('.agent-permission-label')).toHaveText('Workspace access');
  await expect(page.getByRole('combobox', { name: 'Permissions', exact: true })).toHaveCount(0);
  await open();
  await expect(workspace).toBeDisabled();
  await expect(menu.getByRole('slider', { name: 'Reasoning effort', exact: true })).toBeEnabled();
  await expect(menu.getByRole('group', { name: 'Permissions', exact: true })).toBeVisible();
  await expect(menu.getByText('Pause to change', { exact: true })).toBeVisible();
  task.status = 'reviewing'; await page.reload(); await open();
  await expect(workspace).toBeEnabled();
  await expect(workspace).toBeChecked();
  await page.screenshot({ animations: 'disabled', path: 'test-results/task-permissions-menu.png' });
  await choose(full);
  await expect(full).toBeChecked();
  await expect(trigger.locator('.agent-permission-label')).toHaveText('Full access');
  assert.equal(task.permissions, 'full');
  await page.screenshot({ animations: 'disabled', path: 'test-results/task-permissions-full.png' });
  await menu.press('Escape');
  await page.screenshot({ animations: 'disabled', path: 'test-results/task-permissions-collapsed.png' });
  await page.reload(); await open(); await expect(full).toBeChecked();
  await choose(workspace);
  await expect(workspace).toBeChecked();
  await expect(trigger.locator('.agent-permission-label')).toHaveText('Workspace access');
  permissionFailure = true;
  await choose(full);
  await expect(page.getByText('Permission change failed.', { exact: true })).toBeVisible();
  await expect(workspace).toBeChecked();
  await expect(trigger.locator('.agent-permission-label')).toHaveText('Workspace access');
  permissionFailure = false;
  // The save response confirms the mode even when the separate state refresh
  // is slow or fails. Both controls must agree before another message can send.
  for (const refreshMode of ['delayed', 'failed']) {
    const beforeReads = stateReads, beforeFailures = stateFailures, beforeChanges = permissionChanges.length;
    if (refreshMode === 'delayed') holdState = new Promise(resolve => { releaseState = resolve; });
    else stateFailure = true;
    await choose(full);
    await expect.poll(() => stateReads).toBeGreaterThan(beforeReads);
    if (stateFailure) await expect.poll(() => stateFailures).toBeGreaterThan(beforeFailures);
    await expect(full).toBeChecked();
    await expect(trigger.locator('.agent-permission-label')).toHaveText('Full access');
    // A failed downgrade keeps the last confirmed Full mode in both places.
    permissionFailure = true;
    await choose(workspace);
    await expect(full).toBeChecked();
    await expect(trigger.locator('.agent-permission-label')).toHaveText('Full access');
    permissionFailure = false;
    await choose(workspace);
    await expect(workspace).toBeChecked();
    await expect(trigger.locator('.agent-permission-label')).toHaveText('Workspace access');
    assert.deepEqual(permissionChanges.slice(beforeChanges), [{ permissions: 'full' }, { permissions: 'workspace' }, { permissions: 'workspace' }]);
    await menu.press('Escape');
    await page.getByRole('textbox', { name: 'Instructions for Codex' }).fill(`Continue after a ${refreshMode} state refresh.`);
    const beforeMessages = messages.length;
    await page.getByRole('button', { name: 'Send instructions', exact: true }).click();
    await expect.poll(() => messages.length).toBe(beforeMessages + 1);
    assert.equal(messages.at(-1).effectivePermissions, 'workspace', 'sent messages must use the displayed permission mode');
    stateFailure = false; holdState = null; releaseState?.();
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/state') && response.status() === 200), page.evaluate(() => window.dispatchEvent(new Event('online')))]);
    await expect(trigger.locator('.agent-permission-label')).toHaveText('Workspace access');
    await open(); await expect(workspace).toBeChecked();
  }
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
  await expect(trigger.locator('.agent-permission-label')).toHaveText('Bypass permissions');
  await expect(menu.getByRole('radio', { name: 'Sandboxed edits', exact: true })).toBeVisible();
  await choose(menu.getByRole('radio', { name: 'Sandboxed edits', exact: true }));
  await expect(trigger.locator('.agent-permission-label')).toHaveText('Sandboxed edits');
  await expect(menu.getByText('Sandboxed; other requests denied', { exact: true })).toBeVisible();
  assert.equal(await menu.locator('.task-permission-detail').evaluate(el => el.scrollWidth <= el.clientWidth), true, 'permission descriptions must not be truncated');
  await page.screenshot({ animations: 'disabled', path: 'test-results/task-permissions-claude.png' });
  task.agent = 'glm'; snapshot.runtimes.glm = { ...runtime, permissionOptions: new ClaudeAgent().permissionOptions() };
  await page.reload(); await open();
  await expect(menu.getByText('Sandboxed; exceptions need approval', { exact: true })).toBeVisible();
  task.agent = 'kimi'; task.model = null;
  await page.reload(); await open();
  await expect(menu.getByRole('radio')).toHaveCount(4);
  await choose(menu.getByRole('radio', { name: 'Auto', exact: true }));
  await expect(trigger.locator('.agent-permission-label')).toHaveText('Auto');
  assert.equal(task.permissions, 'auto');
  await page.screenshot({ animations: 'disabled', path: 'test-results/task-permissions-kimi.png' });
  await menu.press('Escape');
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport);
    await page.reload();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await open();
    for (const radio of await menu.locator('.task-permission-option').all()) {
      const box = await radio.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width && box.y >= 0 && box.y + box.height <= viewport.height, 'all native modes must fit on mobile');
    }
    await choose(menu.getByRole('radio', { name: 'YOLO', exact: true }));
    await expect(trigger.locator('.agent-permission-label')).toHaveText('YOLO');
    await choose(menu.getByRole('radio', { name: 'Default', exact: true }));
    await expect(trigger.locator('.agent-permission-label')).toHaveText('Default');
    await page.screenshot({ animations: 'disabled', path: `test-results/task-permissions-kimi-${viewport.width}.png` });
    await menu.press('Escape');
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  task.agent = 'cursor'; snapshot.runtimes.cursor = { ...runtime, permissionOptions: new CursorAgent().permissionOptions() };
  await page.reload(); await open();
  await choose(menu.getByRole('radio', { name: 'Unrestricted', exact: true }));
  await expect(trigger.locator('.agent-permission-label')).toHaveText('Unrestricted');
  await choose(menu.getByRole('radio', { name: 'Sandbox', exact: true }));
  await expect(trigger.locator('.agent-permission-label')).toHaveText('Sandbox');
  task.agent = 'cursor'; snapshot.runtimes.cursor = { ...runtime, permissionOptions: [] };
  await page.reload(); await open(); await expect(menu.getByRole('group', { name: 'Permissions', exact: true })).toHaveCount(0);
  await expect(trigger.locator('.agent-permission-label')).toHaveCount(0);
  task.agent = 'codex'; task.mode = 'review';
  await page.reload(); await open(); await expect(menu.getByRole('group', { name: 'Permissions', exact: true })).toHaveCount(0);
  await expect(trigger.locator('.agent-permission-label')).toHaveCount(0);
  delete task.mode; snapshot.tasks = [];
  await page.evaluate(() => localStorage.removeItem('papilot:task'));
  await page.reload();
  const fresh = page.locator('.new-task-panel').getByRole('button', { name: 'Agent settings', exact: true });
  await expect(fresh).toHaveCount(1);
  await expect(fresh.locator('.agent-permission-label')).toHaveText('Workspace access');
  await open(fresh); await expect(workspace).toBeChecked();
  await full.check(); await expect(full).toBeChecked();
  await expect(menu.getByRole('slider', { name: 'Reasoning effort', exact: true })).toBeVisible();
  await expect(page.locator(':popover-open')).toHaveCount(1);
  await page.screenshot({ animations: 'disabled', path: 'test-results/task-permissions-new.png' });
  // Switching agents updates permissions inside the same open menu.
  await menu.getByRole('option', { name: 'Kimi K3 · Kimi', exact: true }).last().click();
  await menu.getByRole('radio', { name: 'Auto', exact: true }).check();
  await expect(fresh.locator('.agent-permission-label')).toHaveText('Auto');
  await menu.getByRole('option', { name: 'Opus · Claude', exact: true }).last().click();
  await expect(menu.getByRole('radio', { name: 'Sandboxed edits', exact: true })).toBeChecked();
  await expect(fresh.locator('.agent-permission-label')).toHaveText('Sandboxed edits');
  await menu.getByRole('radio', { name: 'Bypass permissions', exact: true }).check();
  await expect(menu.getByRole('radio', { name: 'Bypass permissions', exact: true })).toBeChecked();
  await expect(fresh.locator('.agent-permission-label')).toHaveText('Bypass permissions');
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
    await expect(fresh.locator('.agent-permission-label')).toHaveText('Workspace access');
    await workspace.press('ArrowDown'); await expect(full).toBeChecked();
    await page.screenshot({ animations: 'disabled', path: `test-results/task-permissions-mobile-${viewport.width}.png` });
    await menu.press('Escape');
    const mode = fresh.locator('.agent-permission-label');
    await expect(mode).toHaveText('Full access');
    assert.ok(await mode.evaluate(el => el.scrollWidth <= el.clientWidth), 'the collapsed permission mode must remain readable');
    await page.screenshot({ animations: 'disabled', path: `test-results/task-permissions-collapsed-${viewport.width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' }); await open(fresh);
  await page.screenshot({ animations: 'disabled', path: 'test-results/task-permissions-dark.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: shared agent menu, native permission options, busy/save locks, delayed/failed refresh consistency, persistence, error recovery, provider/review restrictions, creation, keyboard and narrow-screen layout.');
} catch (error) { await page.screenshot({ path: 'test-results/task-permissions-failure.png' }); throw error; }
finally { releaseState?.(); await browser.close(); await server.close(); }
