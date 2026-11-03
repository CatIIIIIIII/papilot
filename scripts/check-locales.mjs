import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium } from '../engine/node_modules/playwright/index.mjs';
import { LANGUAGES } from '../engine/src/locales.ts';
import { messages, errorMessages } from '../src/web/locales/index.ts';
import { messages as reviewMessages } from '../engine/src/web/locales/index.ts';
import { selectOption, selectedValue } from './select.mjs';

const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.server.address().port}`;
const reviewServer = Fastify();
await reviewServer.register(staticFiles, { root: path.resolve('engine/dist/web') });
await reviewServer.listen({ host: '127.0.0.1', port: 0 });
const reviewOrigin = `http://127.0.0.1:${reviewServer.server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const runtime = { connected: true, authenticated: true, account: null, error: null, models: [{ id: 'model', name: 'Model', isDefault: true, efforts: [], defaultEffort: null }] };
const snapshot = { version: 'test', csrf: 'fixture', projects: [], tasks: [], requests: [], runtime, runtimes: { codex: runtime } };
const failures = [];
fs.mkdirSync('test-results/locales', { recursive: true });
const label = (id, source) => id === 'en' ? source : messages[id][source];

try {
  const context = await browser.newContext({ locale: 'en-US', colorScheme: 'light', viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => failures.push(error.message));
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/state') return route.fulfill({ json: snapshot });
    if (pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    if (pathname === '/api/updates') return route.fulfill({ json: { currentVersion: 'test', phase: 'idle', error: null } });
    if (pathname === '/api/skills') return route.fulfill({ json: { skills: [] } });
    if (pathname === '/api/imports') return route.fulfill({ status: 400, json: { error: 'Paper name is too long.' } });
    return route.fulfill({ json: {} });
  });
  await page.goto(origin);
  let previous = 'en';
  for (const { id, name } of LANGUAGES) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: label(previous, 'Settings'), exact: true }).click();
    await selectOption(page.getByRole('combobox', { name: label(previous, 'Language'), exact: true }), id);
    const dialog = page.getByRole('dialog', { name: label(id, 'Settings'), exact: true });
    await dialog.waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), id);
    assert.equal(await selectedValue(page.getByRole('combobox', { name: label(id, 'Language'), exact: true })), id);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${id} page overflows at ${width}px`);
      const box = await dialog.locator('.settings-dialog').boundingBox();
      assert.ok(box.x >= -1 && box.x + box.width <= width + 1, `${id} settings exceed the viewport`);
      assert.ok(await dialog.locator('.settings-dialog').evaluate(element => element.scrollWidth <= element.clientWidth + 1), `${id} settings content overflows at ${width}px`);
      await page.screenshot({ path: `test-results/locales/settings-${id}-${width}.png`, animations: 'disabled' });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.keyboard.press('Escape');
    await page.reload();
    await page.getByRole('button', { name: label(id, 'Settings'), exact: true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), id, 'preference survives reload');
    await page.locator('.home').getByRole('button', { name: label(id, 'Add paper'), exact: true }).click();
    await page.getByText(label(id, 'Use a folder on this computer'), { exact: true }).click();
    await page.getByRole('textbox', { name: label(id, 'Folder path'), exact: true }).fill('/tmp/example');
    await page.getByRole('button', { name: label(id, 'Read folder'), exact: true }).click();
    const error = id === 'en' ? 'Paper name is too long.' : errorMessages[id]['Paper name is too long.'];
    await page.getByRole('alert').filter({ hasText: error }).waitFor();
    await page.keyboard.press('Escape');
    previous = id;
    console.log(`PASS: ${name}: live switching, saved choice, API errors, settings at 1440/390/320px`);
  }
  // A stored preference from the existing app remains valid after migration.
  await page.evaluate(() => localStorage.setItem('papilot:language', 'zh-CN'));
  await page.reload();
  await page.getByRole('button', { name: '设置', exact: true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-Hans');
  await context.close();

  // Load the actual built review viewer for every language, not a mocked iframe.
  for (const { id } of LANGUAGES) {
    const viewerContext = await browser.newContext({ colorScheme: 'light', viewport: { width: 1280, height: 900 } });
    const viewer = await viewerContext.newPage();
    viewer.on('pageerror', error => failures.push(`${id}: ${error.message}`));
    await viewer.route('**/api/**', route => route.fulfill({ json: { tasks: [] } }));
    await viewer.goto(`${reviewOrigin}/?lang=${id}`);
    const heading = id === 'en' ? 'All reviews' : reviewMessages[id]['All reviews'];
    await viewer.getByRole('heading', { name: heading, exact: true }).waitFor();
    assert.equal(await viewer.locator('html').getAttribute('lang'), id);
    await viewer.screenshot({ path: `test-results/locales/reviews-${id}.png`, animations: 'disabled' });
    await viewer.setViewportSize({ width: 390, height: 844 });
    assert.ok(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${id} review overview overflows on mobile`);
    await viewer.screenshot({ path: `test-results/locales/reviews-${id}-390.png`, animations: 'disabled' });
    await viewerContext.close();
  }
  assert.deepEqual(failures, []);
  console.log('PASS: All eleven languages render in the built workspace and review viewer without uncaught errors.');
} finally { await browser.close(); await server.close(); await reviewServer.close(); }
