import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from '../engine/node_modules/@playwright/test/index.mjs';

// The PDF's selectable text comes from the server's word places when they
// arrive, and from pdf.js otherwise. A failed or interrupted request must fall
// back once: it used to call itself forever and freeze the tab, which also
// stopped a reload while the request was still on its way.
fs.mkdirSync('test-results', { recursive: true });
const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const runtime = { connected: true, authenticated: true, models: [] };
const snapshot = { version: 'test', csrf: 'fixture', projects: [{ id: 'paper', name: 'Paper', path: '/tmp/paper' }], tasks: [], requests: [], runtime, runtimes: { codex: runtime } };
let words = 'hang';
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url()), json = value => route.fulfill({ json: value });
  if (url.pathname === '/api/state') return json(snapshot);
  if (url.pathname === '/api/updates') return json({ currentVersion: 'test', latestVersion: null, phase: 'idle', checkedAt: 1, error: null, canUpdate: false });
  if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
  if (url.pathname.endsWith('/skills')) return json({ skills: [] });
  if (url.pathname.endsWith('/git')) return json({ branch: 'main', files: [] });
  if (url.pathname.endsWith('/manuscript')) return json({ git: { branch: 'main', files: [] }, build: { status: 'ready', key: 'pdf', pages: [[612, 792], [612, 792]] }, annotations: [] });
  if (url.pathname.endsWith('/manuscript.pdf')) return route.fulfill({ contentType: 'application/pdf', body: fs.readFileSync('tests/fixtures/outline.pdf') });
  if (url.pathname.endsWith('/manuscript/words')) {
    if (words === 'hang') return; // Left open; the reload interrupts it.
    return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
  }
  return json({});
});
const responsive = () => Promise.race([page.evaluate(() => true), new Promise(resolve => setTimeout(() => resolve(false), 3000))]);
try {
  // A reload while the word places are still loading goes through.
  await page.goto(origin);
  await page.waitForRequest(request => request.url().includes('/manuscript/words'));
  await page.reload({ timeout: 10000 });
  assert.equal(await responsive(), true, 'the page answers after a reload interrupted the word request');

  // When the server has no word places, pdf.js's own text is selectable.
  words = 'fail';
  await page.reload();
  await expect(page.locator('.pdf-view .textLayer span').filter({ hasText: /Fixture/ }).first()).toBeAttached();
  assert.equal(await responsive(), true, 'the page answers after the word request failed');
  assert.deepEqual(errors, []);
  console.log('PASS: The PDF text falls back to pdf.js once when word places fail or are interrupted, and reloads are never blocked');
} finally {
  await browser.close();
  await server.close();
}
