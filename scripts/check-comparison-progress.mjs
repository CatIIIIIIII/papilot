import { readyRequirements } from './required-tools-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from '../engine/node_modules/@playwright/test/index.mjs';

const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const job = { id: 'build', status: 'running', phase: 'snapshot', createdAt: Date.now() - 300_000 };
const task = { id: 'progress-task', projectId: 'paper', agent: 'codex', name: 'p-task', title: '根据批注修改第一章引言用词与格式', instructions: '', worktree: '/tmp/paper', threadId: 'thread', turnId: null, model: null, status: 'building', createdAt: 1, updatedAt: 1, feedbackCursor: 0, error: null, pendingBuild: { requestId: 'request', job: job.id, runs: [], sendBack: false, restarts: 0 }, review: { state: 'building', round: null, counts: {}, job } };
const snapshot = { version: 'test', csrf: 'fixture', projects: [{ id: 'paper', name: 'Thesis', path: '/tmp/paper', createdAt: 1 }], tasks: [task], requests: [], runtime: { connected: true, authenticated: true, models: [] } };
await page.addInitScript(() => {
  localStorage.setItem('papilot:task', 'progress-task');
  localStorage.setItem('papilot:language', 'zh-Hans');
});
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url()), json = value => route.fulfill({ json: value });
  if (url.pathname === '/api/runtime/requirements') return route.fulfill({ json: readyRequirements });
  if (url.pathname === '/api/state') return json(snapshot);
  if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
  if (url.pathname.endsWith('/updates')) return json({ currentVersion: 'test', phase: 'idle', canUpdate: false });
  if (url.pathname.endsWith('/indirect-changes')) return json({ indirectChanges: false });
  if (url.pathname === '/api/note-alternatives') return route.fulfill({ json: { noteAlternatives: true, noteAlternativeRange: 'few' } });
  if (url.pathname.endsWith('/quick-notes')) return json({ quickNotes: null });
  if (url.pathname.endsWith('/skills')) return json({ skills: [] });
  if (url.pathname.endsWith('/items')) return json({ items: [{ id: 'answer', taskId: task.id, type: 'assistant', text: '已根据 5 条批注完成修改。', createdAt: 2 }] });
  if (url.pathname.endsWith('/note-results')) return json({ notes: [] });
  if (url.pathname.endsWith('/manuscript')) return json({ annotations: [], build: { status: 'building' }, git: { files: [] } });
  if (url.pathname.endsWith('/git')) return json({ files: [], branch: 'main', ahead: 0, behind: 0 });
  throw new Error(`Unexpected request: ${url.pathname}`);
});
await page.route('**/review/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"><main id="paper">Review ready</main></div></body></html>' }));
const placeholder = page.locator('.review-placeholder');
try {
  await page.goto(`http://127.0.0.1:${server.server.address().port}`);
  await expect(placeholder).toContainText('正在检查论文是否有改动');
  Object.assign(job, { phase: 'build', progress: { baseline: { step: 'tex', pass: 1, pages: 23, total: 180 } } });
  await expect(placeholder).toContainText('正在编译 PDF');
  await expect(placeholder).toContainText('第 23 / 180 页');
  await expect(placeholder).toContainText('已用时间：5:');
  const elapsed = await page.locator('.comparison-elapsed').textContent();
  await expect(page.locator('.comparison-elapsed')).not.toHaveText(elapsed);
  job.progress.baseline.pages = 32;
  job.progress.revised = { step: 'tex', pass: 2, pages: 15, total: 181 };
  await expect(placeholder).toContainText('第 32 / 180 页');
  await expect(placeholder).toContainText('第 15 / 181 页');
  await expect(page.getByRole('progressbar', { name: '修改后' })).toHaveAttribute('value', '15');
  fs.mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/comparison-progress.png' });
  job.progress.revised = { step: 'bibliography', pass: 2, pages: 15, total: 181 };
  delete job.progress.baseline;
  await expect(placeholder).toContainText('正在处理参考文献');
  await expect(page.locator('.comparison-build')).toHaveCount(1);
  Object.assign(job, { phase: 'render', progress: undefined });
  await expect(placeholder).toContainText('正在对比排版后的页面');
  await expect(page.locator('.comparison-build')).toHaveCount(0);

  // A new request must not display the previous job's elapsed time or phase.
  task.pendingBuild = { ...task.pendingBuild, job: undefined, requestId: 'new' };
  await expect(placeholder).toContainText('正在检查论文是否有改动');
  await expect(page.locator('.comparison-elapsed')).toHaveCount(0);
  task.pendingBuild.job = job.id;
  task.status = 'failed'; task.error = 'Compiler failed'; job.status = 'failed';
  await expect(placeholder.getByRole('button', { name: '生成 PDF 对比' })).toBeVisible();
  await expect(page.locator('.comparison-progress')).toHaveCount(0);
  await expect(page.locator('.task-error')).toContainText('Compiler failed');

  task.status = 'reviewing'; task.error = null; task.pendingBuild = null;
  task.review.state = 'reviewing'; task.review.round = 1; task.review.counts = { pending: 2 }; job.status = 'done';
  await expect(page.locator('iframe')).toBeVisible();
  await expect(placeholder).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log('Comparison phases, live page counts, elapsed time, retry isolation and review completion passed.');
} finally {
  await browser.close();
  await server.close();
}
