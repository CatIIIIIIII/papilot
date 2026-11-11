import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from './playwright.mjs';
const server = Fastify();
await server.register(staticFiles, { root: path.resolve('desktop') });
await server.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
fs.mkdirSync('test-results', { recursive: true });
const errors = [];
async function open(options = {}) {
  const page = await browser.newPage({ viewport: { width: 800, height: 810 }, locale: options.locale || 'en-US' });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(options => {
    window.setupTest = { links: [], applied: [], copied: false, canceled: false, ready: false, options };
    const state = window.setupTest;
    window.papilotEnvironment = {
      info: async () => ({ current: options.current || null, distributions: options.empty ? [] : ['Ubuntu', 'Debian'], startupError: options.startupError || '', discoveryError: options.discoveryError || '' }),
      inspect: async value => {
        if (options.fail) throw Error('Distribution did not respond. Check again.');
        if (options.slow && value.kind === 'wsl') await new Promise(r => setTimeout(r, 500));
        const ready = !(options.missing || []).includes('node');
        return { canPrepare: ready, prepared: value.kind === 'native' || state.ready || options.prepared,
          checks: ['node', 'git', 'tex'].map(id => ({ id, ready: !(options.missing || []).includes(id), detail: id === 'node' ? value.kind === 'native' ? 'bundled' : 'Node.js 24.22.2 · npm' : '' })) };
      },
      prepare: async () => { if (options.cancel) await new Promise((_, reject) => { state.cancel = () => reject(Error('Setup canceled.')); }); state.ready = true; },
      cancel: async () => { state.canceled = true; state.cancel?.(); },
      apply: async value => state.applied.push(value),
      copyInstall: async () => { state.copied = true; },
      help: async key => state.links.push(key),
      onProgress: () => {},
    };
  }, options);
  await page.goto(`http://127.0.0.1:${server.server.address().port}/environment.html`);
  await expect(page.locator('#refresh')).toBeEnabled();
  return page;
}
try {
  let page = await open({ empty: true, locale: 'zh-CN', discoveryError: 'WSL is not installed.' });
  await expect(page.locator('input[value=wsl]')).toBeChecked();
  await expect(page.locator('#install-wsl')).toBeVisible();
  await expect(page.locator('#prepare')).toBeDisabled();
  await expect(page.locator('#status')).toHaveText('');
  await page.locator('#copy-install').click(); assert.equal(await page.evaluate(() => window.setupTest.copied), true);
  await page.locator('#help').click(); assert.deepEqual(await page.evaluate(() => window.setupTest.links), ['wsl']);
  await page.screenshot({ path: 'test-results/environment-install-zh.png' }); await page.close();

  page = await open({ missing: ['node', 'tex'], locale: 'zh-CN' });
  await expect(page.locator('.check.missing')).toHaveCount(2);
  await expect(page.locator('#prepare')).toBeDisabled();
  await page.locator('[data-check=node] button').click(); assert.deepEqual(await page.evaluate(() => window.setupTest.links), ['node']);
  await page.screenshot({ path: 'test-results/environment-missing-zh.png' });
  await page.evaluate(() => { window.setupTest.options.missing = []; }); await page.locator('#refresh').click();
  await expect(page.locator('#prepare')).toBeEnabled();
  await page.locator('#prepare').click(); await expect(page.locator('#continue')).toBeEnabled();
  await page.screenshot({ path: 'test-results/environment-ready-zh.png' });
  await page.locator('#continue').click(); assert.deepEqual(await page.evaluate(() => window.setupTest.applied), [{ kind: 'wsl', distribution: 'Ubuntu' }]); await page.close();

  page = await open({ current: { kind: 'native' }, missing: ['git'] });
  await expect(page.locator('input[value=native]')).toBeChecked();
  await expect(page.locator('#continue')).toHaveText('Explore the demo');
  await page.locator('[data-check=git] button').click(); assert.deepEqual(await page.evaluate(() => window.setupTest.links), ['gitWindows']);
  await page.setViewportSize({ width: 640, height: 600 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'test-results/environment-native-en.png', fullPage: true }); await page.close();

  const startupError = 'Papilot could not open its database. Check the data folder permissions.';
  page = await open({ current: { kind: 'native' }, startupError, prepared: true });
  await expect(page.locator('#status.error')).toHaveText(startupError);
  await expect(page.locator('#check-summary')).toHaveText('Papilot could not start in this environment.');
  await expect(page.locator('#continue')).toHaveText('Retry Papilot'); await expect(page.locator('#continue')).toBeEnabled();
  await page.locator('#refresh').click(); await expect(page.locator('#status.error')).toHaveText(startupError);
  await page.locator('input[value=wsl]').check(); await expect(page.locator('#status')).toHaveText('');
  await expect(page.locator('#check-summary')).toHaveText('Everything is ready for your workspace.');
  await expect(page.locator('#continue')).toHaveText('Open Papilot'); await expect(page.locator('#continue')).toBeEnabled();
  await page.locator('input[value=native]').check(); await expect(page.locator('#status.error')).toHaveText(startupError);
  await page.locator('#continue').click(); assert.deepEqual(await page.evaluate(() => window.setupTest.applied), [{ kind: 'native' }]); await page.close();

  page = await open({ current: { kind: 'native' }, startupError, empty: true, discoveryError: 'WSL is not installed.' });
  await expect(page.locator('#status.error')).toHaveText(startupError);
  await expect(page.locator('#check-summary')).toHaveText('Papilot could not start in this environment.');
  await page.locator('input[value=wsl]').check(); await expect(page.locator('#install-wsl')).toBeVisible();
  await expect(page.locator('#status')).toHaveText(''); await page.close();

  page = await open({ fail: true }); await expect(page.locator('#status.error')).toBeVisible(); await expect(page.locator('#prepare')).toBeDisabled();
  await expect(page.locator('[data-check=node]')).toContainText('Not checked'); await page.close();
  page = await open({ cancel: true }); await expect(page.locator('#prepare')).toBeEnabled(); await page.locator('#prepare').click();
  await page.locator('#cancel').click(); await expect(page.locator('#status')).toHaveText('Setup canceled.'); await expect(page.locator('#refresh')).toBeEnabled(); await page.close();
  page = await open({ slow: true }); await page.locator('input[value=native]').check();
  await expect(page.locator('#continue')).toBeEnabled(); await page.waitForTimeout(650);
  await expect(page.locator('[data-check=node]')).toContainText('Included with Papilot'); await page.close();
  assert.deepEqual(errors, []);
  console.log('PASS: recommended WSL, install guides, recheck, prepare, persisted native choice, startup failure and retry, environment switching, missing WSL, failure, cancellation, stale-result isolation, and responsive bilingual layouts.');
} finally { await browser.close(); await server.close(); }
