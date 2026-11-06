import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium } from '../engine/node_modules/playwright/index.mjs';

const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const url = `http://127.0.0.1:${server.server.address().port}`;
const report = (platform, missing = []) => ({ platform, checks: ['git', 'latexmk', 'synctex', 'tex-engine'].map(id => ({ id, ok: !missing.includes(id) })) });
const all = ['git', 'latexmk', 'synctex', 'tex-engine'];
const errors = [];
fs.mkdirSync('test-results', { recursive: true });
async function fixture({ platform = 'darwin', missing = all, member = false, existing = false, returning = existing, desktop = false, language = 'en', width = 1280, dark = false, failure = false } = {}) {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width, height: 900 }, colorScheme: dark ? 'dark' : 'light' });
  const scenario = { report: report(platform, missing), failure, requests: 0 };
  await context.addInitScript(({ language, returning, desktop, platform }) => {
    localStorage.setItem('papilot:language', language);
    if (returning) localStorage.setItem('papilot:project', 'paper');
    if (desktop) window.papilotDesktop = { platform, minimize() {}, maximize() {}, close() {}, chooseDirectory: async () => { window.fixtureFolderRequests = (window.fixtureFolderRequests || 0) + 1; return null; } };
  }, { language, returning, desktop, platform });
  const state = { version: '0.9.0', csrf: 'fixture', projects: existing ? [{ id: 'paper', name: 'Paper', path: '/fixture/paper', createdAt: 1 }] : [], tasks: [], requests: [], runtime: { connected: true, authenticated: true, account: 'Owner', error: null, models: [] }, viewer: { id: member ? 'member' : 'owner', role: member ? 'member' : 'owner', name: 'Reader', listener: member ? 'account' : 'local', owner: 'Owner' } };
  await context.route('**/api/**', route => {
    const target = new URL(route.request().url()).pathname;
    if (target === '/api/runtime/requirements') { scenario.requests++; return route.fulfill(scenario.failure ? { status: 503, json: { error: 'Unavailable' } } : { json: scenario.report }); }
    if (target === '/api/state') return route.fulfill({ json: state });
    if (target === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    if (target === '/api/updates') return route.fulfill({ json: { phase: 'idle', currentVersion: '0.9.0' } });
    if (target.endsWith('/skills')) return route.fulfill({ json: { skills: [] } });
    if (target.endsWith('/manuscript')) return route.fulfill({ json: { git: { files: [] }, build: { status: 'failed', error: 'Fixture preview' }, annotations: [] } });
    if (target.endsWith('/git')) return route.fulfill({ json: { files: [] } });
    return route.fulfill({ json: {} });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  return { page, context, scenario };
}
try {
  const f = await fixture({ desktop: true });
  const dialog = f.page.getByRole('dialog', { name: 'Get ready to write' });
  await dialog.waitFor();
  assert.deepEqual((await dialog.locator('.requirement-status').allTextContents()).map(text => text.trim()), ['Not installed or unavailable', 'Not installed or unavailable']);
  assert.equal(await dialog.getByRole('link', { name: 'Install Git' }).getAttribute('href'), 'https://git-scm.com/install/mac');
  assert.equal(await dialog.getByRole('link', { name: 'Install MacTeX' }).getAttribute('href'), 'https://www.tug.org/mactex/mactex-download.html');
  await dialog.screenshot({ animations: 'disabled', path: 'test-results/setup-desktop.png' });
  await dialog.getByRole('button', { name: 'Close', exact: true }).focus();
  await f.page.keyboard.press('Shift+Tab');
  assert.equal(await dialog.getByRole('button', { name: 'Check again' }).evaluate(el => el === document.activeElement), true);
  await f.page.keyboard.press('Tab');
  assert.equal(await dialog.getByRole('button', { name: 'Close', exact: true }).evaluate(el => el === document.activeElement), true);
  await f.page.keyboard.press('Escape');
  assert.equal(await dialog.count(), 0);
  await f.page.reload();
  await f.page.getByRole('button', { name: 'Review setup' }).waitFor();
  assert.equal(await dialog.count(), 0, 'returning users without a paper are not prompted again');
  await f.page.getByRole('button', { name: 'Open a folder', exact: true }).first().click();
  assert.equal(await f.page.evaluate(() => window.fixtureFolderRequests), 1, 'setup guidance does not block the folder picker');
  assert.equal(await dialog.count(), 0);
  const bannerBox = await f.page.locator('.requirements-banner').boundingBox();
  assert.ok(bannerBox.y > 46, 'the desktop notice stays clear of the window controls');
  await f.page.getByRole('button', { name: 'Review setup' }).click();
  await dialog.waitFor();
  f.scenario.report = report('darwin', ['synctex']);
  await dialog.getByRole('button', { name: 'Check again' }).click();
  await dialog.getByRole('link', { name: 'Install Git' }).waitFor({ state: 'hidden' });
  assert.deepEqual((await dialog.locator('.requirement-status').allTextContents()).map(text => text.trim()), ['Ready', 'Incomplete installation']);
  assert.equal(await dialog.locator('details').count(), 0);
  f.scenario.failure = true;
  await dialog.getByRole('button', { name: 'Check again' }).click();
  await dialog.getByText('Could not check the required tools. Try again.', { exact: true }).waitFor();
  assert.deepEqual((await dialog.locator('.requirement-status').allTextContents()).map(text => text.trim()), ['Check failed', 'Check failed']);
  f.scenario.failure = false; f.scenario.report = report('darwin');
  await dialog.getByRole('button', { name: 'Check again' }).click();
  await dialog.getByText('All required tools are ready. You can open a paper.').waitFor();
  assert.deepEqual((await dialog.locator('.requirement-status').allTextContents()).map(text => text.trim()), ['Ready', 'Ready']);
  assert.equal(await dialog.getByRole('link').count(), 0);
  assert.equal(await f.page.locator('.requirements-banner').count(), 0);
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await f.page.getByRole('button', { name: 'Settings', exact: true }).click();
  await f.page.getByRole('button', { name: 'Required tools', exact: true }).click();
  await f.page.getByText('All required tools are ready. You can open a paper.').waitFor();
  assert.ok(f.scenario.requests >= 4);
  await f.context.close();

  // Existing users are not interrupted, and the host's OS wins over the browser's.
  const existing = await fixture({ platform: 'linux', missing: ['latexmk'], existing: true });
  await existing.page.getByRole('button', { name: 'Review setup' }).waitFor();
  assert.equal(await existing.page.getByRole('dialog').count(), 0);
  await existing.page.getByRole('button', { name: 'Review setup' }).click();
  await existing.page.getByRole('link', { name: 'Install TeX Live' }).waitFor();
  assert.equal(await existing.page.getByRole('link', { name: 'Install MacTeX' }).count(), 0);
  assert.equal(await existing.page.getByRole('link', { name: 'Install Git' }).count(), 0);
  await existing.context.close();

  const demo = await fixture({ existing: true, returning: false, desktop: true, missing: ['latexmk'] });
  await demo.page.getByRole('dialog', { name: 'Get ready to write' }).waitFor();
  await demo.context.close();

  const member = await fixture({ member: true, width: 390 });
  await member.page.getByRole('button', { name: 'Review setup' }).click();
  await member.page.getByText(/You do not need to install them on your own device/).waitFor();
  assert.equal(await member.page.getByRole('dialog').getByRole('link').count(), 0);
  await member.page.getByRole('dialog').screenshot({ animations: 'disabled', path: 'test-results/setup-member-mobile.png' });
  await member.context.close();

  const failed = await fixture({ failure: true });
  await failed.page.getByRole('button', { name: 'Review setup' }).click();
  await failed.page.getByText('Could not check the required tools. Try again.', { exact: true }).waitFor();
  failed.scenario.failure = false; failed.scenario.report = report('linux');
  await failed.page.getByRole('button', { name: 'Check again' }).click();
  await failed.page.getByText('All required tools are ready. You can open a paper.').waitFor();
  await failed.context.close();

  const ready = await fixture({ missing: [] });
  await ready.page.getByRole('button', { name: 'Settings', exact: true }).click();
  await ready.page.getByRole('button', { name: 'Required tools', exact: true }).click();
  await ready.page.getByText('All required tools are ready. You can open a paper.').waitFor();
  assert.equal(await ready.page.locator('.requirements-banner').count(), 0);
  assert.equal(await ready.page.getByRole('dialog', { name: 'Get ready to write' }).count(), 0);
  await ready.context.close();

  const windows = await fixture({ platform: 'win32' });
  assert.equal(await windows.page.getByRole('link', { name: 'Install Git' }).getAttribute('href'), 'https://git-scm.com/install/windows');
  assert.equal(await windows.page.getByRole('link', { name: 'Install TeX Live' }).getAttribute('href'), 'https://www.tug.org/texlive/acquire-netinstall.html');
  assert.equal(await windows.page.getByRole('link', { name: 'Install MacTeX' }).count(), 0);
  await windows.context.close();

  // Every supported translation is exercised at a phone width, including long labels.
  for (const language of ['zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es', 'pt', 'it', 'sv']) {
    const locale = language === 'zh-Hans' ? 'zh-CN' : language;
    const dictionary = JSON.parse(fs.readFileSync(`src/web/locales/${locale}.json`, 'utf8'));
    const f = await fixture({ language, width: 390, dark: language === 'de' });
    const dialog = f.page.getByRole('dialog', { name: dictionary['Get ready to write'] });
    await dialog.waitFor();
    await dialog.getByRole('link', { name: dictionary['Install MacTeX'] }).waitFor();
    const buttonBox = await dialog.getByRole('button', { name: dictionary['Set up later'] }).boundingBox();
    assert.ok(buttonBox.y + buttonBox.height <= 900, `${language} actions stay visible`);
    const overflow = await dialog.locator('.requirements-dialog').evaluate(el => el.scrollWidth > el.clientWidth + 1);
    assert.equal(overflow, false, `${language} must fit a phone`);
    await dialog.getByRole('button', { name: dictionary['Set up later'] }).scrollIntoViewIfNeeded();
    if (['zh-Hans', 'de'].includes(language)) {
      await dialog.locator('.requirements-panel').evaluate(el => { el.scrollTop = 0; });
      await f.page.screenshot({ animations: 'disabled', path: `test-results/setup-${locale}-mobile.png` });
    }
    await f.context.close();
  }
  assert.deepEqual(errors, []);
  console.log('Required tools UI passed: desktop, existing users, partial installs, retries, ready state, host OS, collaborators, keyboard focus, and 11 languages.');
} finally { await browser.close(); await server.close(); }
