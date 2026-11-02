import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from '../engine/node_modules/@playwright/test/index.mjs';

const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const png = Buffer.from(await page.evaluate(() => {
  const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 160;
  const context = canvas.getContext('2d'); context.fillStyle = '#f8fafc'; context.fillRect(0, 0, 240, 160);
  context.strokeStyle = '#2563eb'; context.lineWidth = 5; context.beginPath(); context.moveTo(22, 130); context.lineTo(70, 105); context.lineTo(120, 110); context.lineTo(180, 45); context.lineTo(220, 25); context.stroke();
  return canvas.toDataURL('image/png').split(',')[1];
}), 'base64');
const snapshot = { version: 'test', csrf: 'fixture', projects: [{ id: 'paper', name: 'Paper', path: '/tmp/paper', createdAt: 1 }, { id: 'other', name: 'Other paper', path: '/tmp/other', createdAt: 1 }], tasks: [], requests: [], runtime: { connected: true, authenticated: true, account: null, error: null, models: [] } };
const git = { branch: 'main', upstream: null, ahead: 0, behind: 0, files: [], head: null };
const files = new Map(), items = new Map(), creates = [], messages = [];
let failUpload = false, failCreate = false, failMessage = false;
await page.route('**/api/**', async route => {
  const request = route.request(), url = new URL(request.url()), json = data => route.fulfill({ json: data });
  if (url.pathname === '/api/state') return json(snapshot);
  if (url.pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
  if (url.pathname === '/api/updates') return json({});
  if (url.pathname.endsWith('/skills')) return json({ skills: [{ id: 'polish', name: 'Polish', source: 'builtin', description: 'Polish', hint: '' }] });
  if (url.pathname.endsWith('/git')) return json(git);
  if (url.pathname.endsWith('/note-results')) return json({ notes: [] });
  if (url.pathname.endsWith('/manuscript')) return json({ git, build: { status: 'ready', key: 'fixture', current: true }, annotations: [] });
  if (url.pathname.endsWith('/manuscript.pdf')) return route.fulfill({ contentType: 'application/pdf', body: fs.readFileSync('tests/fixtures/outline.pdf') });
  if (url.pathname.endsWith('/manuscript/words')) return json(JSON.parse(fs.readFileSync('tests/fixtures/outline-words.json', 'utf8'))[Number(url.searchParams.get('page'))]);
  if (url.pathname.endsWith('/attachments') && request.method() === 'POST') {
    if (failUpload) return route.fulfill({ status: 503, json: { error: 'Upload interrupted. Please retry.' } });
    const bytes = request.postDataBuffer(), name = decodeURIComponent(request.headers()['x-papilot-filename']);
    assert.equal(request.headers()['content-type'], 'application/octet-stream');
    const file = { id: randomUUID(), projectId: url.pathname.split('/')[3], name, size: bytes.length, mime: name.endsWith('.png') ? 'image/png' : name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream' };
    files.set(file.id, { ...file, bytes }); return json(file);
  }
  if (url.pathname.includes('/attachments/')) {
    if (url.pathname.endsWith('/discard')) return json({ ok: true });
    const file = files.get(url.pathname.split('/').at(-1));
    return file ? route.fulfill({ contentType: file.mime, body: file.bytes }) : route.fulfill({ status: 404 });
  }
  if (url.pathname === '/api/tasks') {
    const body = request.postDataJSON(); creates.push(body);
    if (failCreate) return route.fulfill({ status: 503, json: { error: 'Creation interrupted. Please retry.' } });
    const task = { ...body, name: 'p-' + body.id, worktree: '/tmp/paper/task', threadId: null, turnId: null, status: 'idle', createdAt: Date.now(), updatedAt: Date.now(), feedbackCursor: 0, error: null, review: null };
    snapshot.tasks.push(task);
    items.set(task.id, [{ id: 'initial', taskId: task.id, type: 'user', text: body.instructions, createdAt: Date.now(), meta: { attachments: body.attachments.map(id => { const { bytes, ...file } = files.get(id); return file; }) } }]);
    return json(task);
  }
  if (url.pathname.endsWith('/items')) return json({ items: items.get(url.pathname.split('/')[3]) || [] });
  if (url.pathname.endsWith('/messages')) {
    const body = request.postDataJSON(); messages.push(body);
    if (failMessage) return route.fulfill({ status: 503, json: { error: 'Sending interrupted. Please retry.' } });
    const taskId = url.pathname.split('/')[3];
    items.get(taskId).push({ id: body.requestKey, taskId, type: 'user', text: body.text, createdAt: Date.now(), meta: { attachments: body.attachments.map(id => { const { bytes, ...file } = files.get(id); return file; }) } });
    return json({ ok: true });
  }
  throw new Error(`Unexpected API request: ${url.pathname}`);
});
try {
  await page.addInitScript(() => { if (!localStorage.getItem('fixture-started')) { localStorage.setItem('papilot:task', ''); localStorage.setItem('papilot:layout', 'conversation'); localStorage.setItem('fixture-started', '1'); } });
  await page.goto(origin);
  const input = page.getByRole('textbox', { name: 'Describe the revision', exact: true });
  await expect(input).toBeVisible();
  await page.getByRole('button', { name: 'Add files or skills', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Add files…', exact: true }).click();
  await (await chooser).setFiles([{ name: '实验结果.png', mimeType: 'image/png', buffer: png }, { name: 'reference-paper-with-a-long-descriptive-title.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync('tests/fixtures/outline.pdf') }]);
  await expect(page.locator('.composer-attachments .attachment')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Start task', exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.locator('.composer-attachments .attachment')).toHaveCount(2);
  await page.getByRole('button', { name: 'Paper: Paper', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Other paper', exact: true }).click();
  await expect(page.locator('.composer-attachments .attachment')).toHaveCount(0);
  await page.getByRole('button', { name: 'Paper: Other paper', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Paper', exact: true }).click();
  await expect(page.locator('.composer-attachments .attachment')).toHaveCount(2);
  failUpload = true;
  await page.getByLabel('Choose attachments').setInputFiles({ name: 'results.csv', mimeType: 'text/csv', buffer: Buffer.from('x,y\n1,2') });
  await expect(page.getByRole('button', { name: 'Retry uploading results.csv' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start task', exact: true })).toBeDisabled();
  failUpload = false;
  await page.getByRole('button', { name: 'Retry uploading results.csv' }).click();
  await expect(page.getByRole('button', { name: 'Start task', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Remove attachment results.csv' }).click();
  await input.evaluate(element => {
    const transfer = new DataTransfer(); transfer.items.add(new File(['x,y\n1,2'], 'dropped.csv', { type: 'text/csv' }));
    element.closest('form').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(page.locator('.composer-attachments .attachment')).toHaveCount(3);
  await input.fill('Update Figure 3 using these results.');
  fs.mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/attachments-new-task.png' });
  failCreate = true;
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  await expect(page.getByText('Creation interrupted. Please retry.', { exact: true })).toBeVisible();
  await expect(page.locator('.composer-attachments .attachment')).toHaveCount(3);
  failCreate = false;
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  await expect(page.locator('.composer-attachments .attachment')).toHaveCount(0);
  assert.equal(creates[0].id, creates[1].id);
  assert.equal(creates[1].attachments.length, 3);
  await page.locator('.task-link').filter({ hasText: 'Update Figure 3' }).click();
  await expect(page.locator('.message-attachments .attachment')).toHaveCount(3);
  const chat = page.getByRole('textbox', { name: 'Instructions for Codex' });
  await chat.evaluate((element, bytes) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(bytes)], 'pasted.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, [...png]);
  await expect(page.getByRole('button', { name: 'Send instructions', exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.locator('.composer-attachments .attachment')).toHaveCount(1);
  failMessage = true;
  await page.getByRole('button', { name: 'Send instructions', exact: true }).click();
  await expect(page.getByText('Sending interrupted. Please retry.', { exact: true })).toBeVisible();
  assert.equal(messages[0].text, '');
  failMessage = false;
  await page.getByRole('button', { name: 'Send instructions', exact: true }).click();
  await expect(page.locator('.composer-attachments .attachment')).toHaveCount(0);
  assert.equal(messages[0].requestKey, messages[1].requestKey);
  await expect(page.locator('.message-attachments .attachment')).toHaveCount(4);
  await page.getByLabel('Choose attachments').setInputFiles({ name: '另一张实验结果图.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.composer-attachments .attachment')).toHaveCount(1);
  await page.evaluate(() => localStorage.setItem('papilot:language', 'zh-CN'));
  await page.reload();
  await expect(page.getByRole('button', { name: '添加文件或技能', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/attachments-chat.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  const chatTab = page.getByRole('button', { name: '对话', exact: true });
  await expect(chatTab).toBeVisible();
  await chatTab.click();
  await expect(page.locator('.composer-attachments .attachment')).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'test-results/attachments-mobile.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: 'test-results/attachments-dark.png' });
  assert.deepEqual(errors, []);
  console.log('Attachment UI passed: pick, drop, paste, reload, paper isolation, retry, message previews and mobile layout.');
} finally { await browser.close(); await server.close(); }
