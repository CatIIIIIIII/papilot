// The admitted task remains usable while its worktree and review PDF prepare.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from './playwright.mjs';
import { readyRequirements } from './required-tools-fixture.mjs';

const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
fs.mkdirSync('test-results', { recursive: true });
try {
  for (const width of [1440, 390]) {
    const task = { id: 'preparing-task-id', projectId: 'paper', name: 'p-preparing', title: 'Prepare a review', instructions: 'Check the introduction.', worktree: '', threadId: null, turnId: null, model: null, deferred: true, status: 'preparing', preparation: {}, createdAt: 1, updatedAt: 1, feedbackCursor: 0, error: null, review: null };
    const snapshot = { version: 'test', csrf: 'fixture', projects: [{ id: 'paper', name: 'Example paper', path: '/unused/paper', createdAt: 1 }], tasks: [task], requests: [], runtime: { connected: true, authenticated: true, account: null, error: null, models: [] } };
    const page = await browser.newPage({ locale: 'en-US', viewport: { width, height: 844 } });
    const errors = [], retries = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('papilot:task', 'preparing-task-id'));
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()), json = data => route.fulfill({ json: data });
      if (url.pathname === '/api/state') return json(snapshot);
      if (url.pathname.endsWith('/prepare')) { retries.push(url.pathname); task.status = 'preparing'; task.error = null; return json(task); }
      if (url.pathname.endsWith('/delete')) { snapshot.tasks = []; return json({ deleted: true }); }
      if (url.pathname.endsWith('/runtime/requirements')) return json(readyRequirements);
      if (url.pathname.endsWith('/updates')) return json({ currentVersion: 'test', phase: 'idle' });
      if (url.pathname.endsWith('/indirect-changes')) return json({ indirectChanges: false });
      if (url.pathname.endsWith('/note-alternatives')) return json({ noteAlternatives: true, noteAlternativeRange: 'few' });
      if (url.pathname.endsWith('/skills')) return json({ skills: [] });
      if (url.pathname.endsWith('/items')) return json({ items: [] });
      if (url.pathname.endsWith('/note-results')) return json({ notes: [] });
      if (url.pathname.endsWith('/git')) return json({ branch: 'main', files: [], ahead: 0, behind: 0, remote: false });
      if (url.pathname.endsWith('/manuscript')) return json({ annotations: [], build: { status: 'idle' }, git: { branch: 'main', files: [] } });
      if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
      throw new Error(`Unexpected preparation fixture request: ${url.pathname}`);
    });
    await page.goto(origin);
    await expect(page.locator('.status.preparing').first()).toHaveText('Preparing…');
    task.mode = 'review'; await page.reload();
    await expect(page.locator('.status.preparing').first()).toHaveText('Preparing the review PDF…');
    task.status = 'failed'; task.error = 'The review PDF could not be prepared.'; await page.reload();
    await page.getByRole('button', { name: 'View details', exact: true }).click();
    const actions = page.locator('.task-error-actions');
    await expect(actions.getByRole('button', { name: 'Delete task…', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send instructions', exact: true })).toBeDisabled();
    await actions.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(actions).toHaveCount(0);
    assert.equal(retries.length, 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `test-results/task-preparation-${width}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('PASS: Preparing tasks, AI-review preparation, failure, Retry, Delete and send gating at desktop and phone widths');
} finally { await browser.close(); await server.close(); }
