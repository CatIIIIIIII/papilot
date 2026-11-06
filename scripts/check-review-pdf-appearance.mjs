import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from '../engine/node_modules/@playwright/test/index.mjs';
import { selectOption } from './select.mjs';
import { annotateReviewState, rewriteReviewHtml } from '../src/server/review.ts';

fs.mkdirSync('test-results', { recursive: true });
const baseline = process.env.PAPILOT_BASELINE === '1';
const server = Fastify();
await server.register(staticFiles, { root: path.resolve(process.env.PAPILOT_WEB_DIST || 'dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 1100 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const prefix = '/review/paper', reviewDist = path.resolve('engine/dist/web');
const task = { id: 'appearance-task', projectId: 'paper', name: 'colors', title: 'Clarify the experimental results', agent: 'codex', status: 'reviewing', createdAt: 1, updatedAt: 1, review: { state: 'reviewing', round: 1, counts: { pending: 2 }, unsent: 0 } };
const runtime = { connected: true, authenticated: true, models: [] };
const snapshot = { version: 'test', csrf: 'fixture', projects: [{ id: 'paper', name: 'Example paper', path: '/tmp/paper' }], tasks: [task], requests: [], runtime };
const image = name => ({ src: name + '.svg', clean: name + '.svg', width: 600, height: 110, page: 1, label: '1' });
const block = id => ({ kind: 'change', units: [id], identical: false, before: [image('before')], after: [image('after')] });
const detail = { task: 'colors', round: 1, before: 'before', after: 'after', warnings: [], files: prefix + '/files/',
  sections: [{ node: 'results', title: 'Results', number: '4', blocks: [block('first')] }], loose: [block('second')],
  units: ['first', 'second'].map((id, i) => ({ id, file: 'main.tex', status: 'modified', kind: 'text', whole_file: false, ops: [], old_start: i + 1, old_end: i + 1, new_start: i + 1, new_end: i + 1, old_text: 'Results improve.', new_text: 'The results improve across all evaluated settings.', truncated: false })) };
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url()), json = data => route.fulfill({ json: data });
  if (url.pathname === '/api/state') return json(snapshot);
  if (url.pathname === '/api/updates') return json({ currentVersion: 'test', phase: 'idle', canUpdate: false });
  if (url.pathname === '/api/indirect-changes') return json({ indirectChanges: false });
  if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
  if (url.pathname.endsWith('/items')) return json({ items: [] });
  if (url.pathname.endsWith('/note-results')) return json({ notes: [] });
  if (url.pathname.endsWith('/skills')) return json({ skills: [] });
  if (url.pathname.endsWith('/git')) return json({ files: [], branch: 'main', ahead: 0, behind: 0 });
  if (url.pathname.endsWith('/manuscript')) return json({ git: { files: [] }, annotations: [], build: { status: 'building', current: false } });
  throw Error(`Unexpected app request ${url.pathname}`);
});
await page.route('**/review/**', async route => {
  const relative = new URL(route.request().url()).pathname.slice(prefix.length);
  if (relative === '/') return route.fulfill({ contentType: 'text/html', body: rewriteReviewHtml(fs.readFileSync(path.join(reviewDist, 'index.html'), 'utf8'), prefix) });
  if (relative.startsWith('/assets/')) return route.fulfill({ path: path.join(reviewDist, relative), contentType: /\.m?js$/.test(relative) ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : 'font/otf' });
  if (relative.startsWith('/files/')) return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 110"><rect width="600" height="110" fill="white"/><text x="40" y="60" font-size="21">${relative.includes('after') ? 'Results improve across all evaluated settings.' : 'Results improve.'}</text></svg>` });
  if (/\/rounds\/\d+$/.test(relative)) return route.fulfill({ json: detail });
  return route.fulfill({ json: annotateReviewState({ task: 'colors', title: task.title, csrf: 'fixture', closed: false, state: 'reviewing', latest: 1, history: [{ number: 1, created: 1 }], round: 1, revision: 'after', decisions: { first: 'pending', second: 'pending' }, comments: {}, undo: null, job: null }, [task]) });
});
try {
  await page.goto(`http://127.0.0.1:${server.server.address().port}`);
  const frame = page.frameLocator('.review-frame');
  await expect(frame.getByText('Other changes', { exact: true })).toBeVisible();
  for (const [theme, pdf] of [['Dark','theme'],['Dark','light'],['Light','light'],['Light','theme']]) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.locator('.settings-dialog');
    await dialog.getByRole('button', { name: 'Appearance', exact: true }).click();
    await dialog.getByRole('radio', { name: theme, exact: true }).check();
    await dialog.getByText('Advanced', { exact: true }).click();
    await selectOption(dialog.getByRole('combobox', { name: 'PDF appearance', exact: true }), pdf);
    await page.keyboard.press('Escape');
    const darkPaper = theme === 'Dark' && pdf === 'theme';
    const darkDiff = baseline ? theme === 'Dark' : darkPaper;
    for (const kind of ['inline', 'standalone']) {
      const change = frame.locator('.change.' + kind).first();
      await expect(change.locator('.side.before')).toHaveCSS('background-color', darkDiff ? 'rgb(67, 44, 48)' : 'rgb(251, 238, 238)');
      await expect(change.locator('.side.after')).toHaveCSS('background-color', darkDiff ? 'rgb(40, 57, 45)' : 'rgb(238, 248, 241)');
      await expect(change.locator('.pdf-strip img').first()).toHaveCSS('filter', darkPaper ? 'invert(0.84) hue-rotate(180deg)' : 'none');
    }
    const loose = frame.locator('.change.standalone').first();
    const selected = /\bcurrent\b/.test(await loose.getAttribute('class'));
    await expect(loose.locator('.change-head')).toHaveCSS('background-color', darkDiff ? (selected ? 'rgb(48, 49, 53)' : 'rgb(42, 43, 47)') : (selected ? 'rgb(244, 244, 244)' : 'rgb(250, 250, 250)'));
    await loose.getByRole('button', { name: 'LaTeX', exact: true }).click();
    await expect(loose.locator('.source-code').first()).toHaveCSS('background-color', darkDiff ? 'rgb(38, 39, 43)' : 'rgb(255, 255, 255)');
    if (theme === 'Dark' && pdf === 'light') await page.screenshot({ path: `test-results/pdf-appearance-${baseline ? 'before' : 'after'}.png`, fullPage: true });
    await loose.getByRole('button', { name: 'LaTeX', exact: true }).click();
  }
  assert.deepEqual(errors, []);
  console.log('PASS: all four UI/PDF theme combinations, inline and Other changes backgrounds, PDF filters, headers and LaTeX source colors.');
} finally { await browser.close(); await server.close(); }
