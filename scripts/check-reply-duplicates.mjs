import { readyRequirements } from './required-tools-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from '../engine/node_modules/@playwright/test/index.mjs';

fs.mkdirSync('test-results', { recursive: true });
const baseline = process.env.PAPILOT_BASELINE === '1';
const server = Fastify();
await server.register(staticFiles, { root: path.resolve(process.env.PAPILOT_WEB_DIST || 'dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1200, height: 780 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const task = { id: 'reply-task', projectId: 'paper', agent: 'claude', name: 'reply', title: 'Check the table width', instructions: 'Keep the table within the column.', worktree: '/tmp/paper', threadId: 'thread', turnId: 'turn', status: 'reviewing', createdAt: 1, updatedAt: 1, review: null };
const runtime = { connected: true, authenticated: true, models: [] };
const snapshot = { version: 'test', csrf: 'fixture', projects: [{ id: 'paper', name: 'Example paper', path: '/tmp/paper' }], tasks: [task], requests: [], runtime, runtimes: { claude: runtime } };
const text = 'The table exceeds the column width by 17 pt. I will check the original table before adjusting the cells.';
const stream = { id: 'reply-task:turn:msg_reply:1', taskId: task.id, type: 'assistant', text, createdAt: 1793935585902 };
const final = { ...stream, id: 'reply-task:turn:msg_reply:0', status: 'completed', createdAt: 1793935585911 };
let items = [{ id: 'user', taskId: task.id, type: 'user', text: 'Please check whether the revised table still fits the column.', createdAt: 1793935580000 }, stream, final];
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url()), json = data => route.fulfill({ json: data });
  if (url.pathname === '/api/runtime/requirements') return json(readyRequirements);
  if (url.pathname === '/api/state') return json(snapshot);
  if (url.pathname === '/api/updates') return json({ currentVersion: 'test', phase: 'idle', canUpdate: false });
  if (url.pathname === '/api/note-alternatives') return route.fulfill({ json: { noteAlternatives: true, noteAlternativeRange: 'few' } });
  if (url.pathname === '/api/indirect-changes') return json({ indirectChanges: false });
  if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
  if (url.pathname.endsWith('/items')) return json({ items });
  if (url.pathname.endsWith('/note-results')) return json({ notes: [] });
  if (url.pathname.endsWith('/skills')) return json({ skills: [] });
  if (url.pathname.endsWith('/git')) return json({ files: [], branch: 'main' });
  if (url.pathname.endsWith('/manuscript')) return json({ git: { files: [] }, annotations: [], build: { status: 'building', current: false } });
  throw Error(`Unexpected fixture request ${url.pathname}`);
});
try {
  await page.goto(`http://127.0.0.1:${server.server.address().port}`);
  await page.getByRole('button', {name:'Chat', exact:true}).click();
  await expect(page.getByText(text, { exact: true })).toHaveCount(baseline ? 2 : 1);
  await page.screenshot({ animations: 'disabled', path: `test-results/reply-duplicates-${baseline ? 'before' : 'after'}.png` });
  await page.reload();
  await expect(page.getByText(text, { exact: true })).toHaveCount(baseline ? 2 : 1);
  items = [...items, { ...final, id: 'reply-task:another-turn:msg_distinct:0', createdAt: final.createdAt + 1000 }];
  await page.reload();
  await expect(page.getByText(text, { exact: true })).toHaveCount(baseline ? 3 : 2);
  // A new block in the same message may repeat an earlier block's text.
  // It must stay visible even if the process exits before its final event.
  const live = { ...stream, id: 'reply-task:turn:msg_reply:2', status: 'inProgress', createdAt: final.createdAt + 2000 };
  task.status = 'running';
  items = [...items, live];
  await expect(page.getByText(text, { exact: true })).toHaveCount(baseline ? 4 : 3);
  task.status = 'interrupted';
  task.turnId = null;
  await page.reload();
  await expect(page.getByText(text, { exact: true })).toHaveCount(baseline ? 4 : 3);
  // The old adapter reused :0 for later final blocks without moving its timestamp.
  const laterText = 'The second table also needs narrower columns.';
  items = [stream, { ...final, text: laterText }, { ...stream, id: 'reply-task:turn:msg_reply:2', text: laterText, createdAt: final.createdAt + 1 }];
  await page.reload();
  await expect(page.getByText(laterText, { exact: true })).toHaveCount(baseline ? 2 : 1);
  await expect(page.getByText(text, { exact: true })).toHaveCount(1);
  assert.deepEqual(errors, []);
  console.log('PASS: legacy duplicates hidden; distinct replies, live repeated blocks, and interrupted blocks retained after reload.');
} finally { await browser.close(); await server.close(); }
