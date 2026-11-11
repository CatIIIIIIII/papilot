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
async function fixture({ platform = 'darwin', missing = all, existing = false, returning = existing, desktop = false, language = 'en', width = 1280, dark = false, failure = false } = {}) {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width, height: 900 }, colorScheme: dark ? 'dark' : 'light' });
  const scenario = { report: report(platform, missing), failure, requests: 0 };
  await context.addInitScript(({ language, returning, desktop, platform }) => {
    localStorage.setItem('papilot:language', language);
    if (returning) localStorage.setItem('papilot:project', 'paper');
    if (desktop) window.papilotDesktop = { platform, minimize() {}, maximize() {}, close() {}, chooseDirectory: async () => { window.fixtureFolderRequests = (window.fixtureFolderRequests || 0) + 1; return null; } };
  }, { language, returning, desktop, platform });
  const state = { version: '0.9.0', csrf: 'fixture', projects: existing ? [{ id: 'paper', name: 'Paper', path: '/fixture/paper', createdAt: 1 }] : [], tasks: [], requests: [], runtime: { connected: true, authenticated: true, account: 'Owner', error: null, models: [] } };
  await context.route('**/api/**', route => {
    const target = new URL(route.request().url()).pathname;
    if (target === '/api/runtime/requirements') { scenario.requests++; return route.fulfill(scenario.failure ? { status: 503, json: { error: 'Unavailable' } } : { json: scenario.report }); }
    if (target === '/api/runtime/latex') return route.fulfill({ json: { distribution: 'TeX Live', version: '2026', path: '/fixture/texlive' } });
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
async function status(dialog, label) {
  await dialog.locator('.requirement-status').getByText(label, { exact: true }).waitFor();
  assert.equal(await dialog.locator('.requirement-row').count(), 1, 'Each tool has its own settings page');
}
async function goTo(dialog, tool) {
  const category = dialog.locator(`[data-settings-page="${tool}"]`);
  if (!await category.isVisible()) await dialog.locator('.settings-mobile-back').click();
  await category.click();
}
try {
  const f = await fixture({ desktop: true });
  const dialog = f.page.locator('dialog[open]');
  await f.page.getByRole('dialog', { name: 'Git', exact: true }).waitFor();
  await status(dialog, 'Not installed or unavailable');
  assert.equal(await dialog.getByRole('link', { name: 'Install Git' }).getAttribute('href'), 'https://git-scm.com/install/mac');
  assert.equal(await dialog.getByRole('link', { name: 'Install MacTeX' }).count(), 0);
  await dialog.getByRole('switch', { name: 'Show advanced Git features' }).check();
  await dialog.screenshot({ animations: 'disabled', path: 'test-results/setup-git-desktop.png' });
  await dialog.getByRole('button', { name: 'Close', exact: true }).focus();
  await f.page.keyboard.press('Shift+Tab');
  assert.equal(await dialog.getByRole('switch', { name: 'Show advanced Git features' }).evaluate(el => el === document.activeElement), true);
  await f.page.keyboard.press('Tab');
  assert.equal(await dialog.getByRole('button', { name: 'Close', exact: true }).evaluate(el => el === document.activeElement), true);
  await f.page.keyboard.press('Escape');
  assert.equal(await dialog.count(), 0);
  await f.page.reload();
  const banner = f.page.locator('.requirements-banner');
  await banner.getByRole('button', { name: 'LaTeX', exact: true }).waitFor();
  assert.equal(await dialog.count(), 0, 'returning users without a paper are not prompted again');
  await f.page.getByRole('button', { name: 'Open a folder', exact: true }).first().click();
  assert.equal(await f.page.evaluate(() => window.fixtureFolderRequests), 1, 'setup guidance does not block the folder picker');
  const bannerBox = await banner.boundingBox();
  assert.ok(bannerBox.y > 46, 'the desktop notice stays clear of the window controls');
  await banner.getByRole('button', { name: 'LaTeX', exact: true }).click();
  await f.page.getByRole('dialog', { name: 'LaTeX', exact: true }).waitFor();
  assert.equal(await dialog.getByRole('link', { name: 'Install MacTeX' }).getAttribute('href'), 'https://www.tug.org/mactex/mactex-download.html');
  assert.equal(await dialog.getByRole('link', { name: 'Install Git' }).count(), 0);
  await dialog.getByText('/fixture/texlive', { exact: true }).waitFor();
  f.scenario.report = report('darwin', ['synctex']);
  await dialog.getByRole('button', { name: 'Detect again' }).click();
  await status(dialog, 'Incomplete installation');
  for (const failureReason of ['timeout', 'failed']) {
    f.scenario.report = report('darwin', ['latexmk']);
    f.scenario.report.checks.find(check => check.id === 'latexmk').failureReason = failureReason;
    await dialog.getByRole('button', { name: 'Detect again' }).click();
    await status(dialog, 'Check failed');
    assert.equal(await dialog.getByRole('link', { name: 'Install MacTeX' }).count(), 0, 'A failed probe must not recommend reinstalling LaTeX');
    assert.match(await banner.textContent(), /Could not check the required tools/);
    if (failureReason === 'timeout') await dialog.screenshot({ animations: 'disabled', path: 'test-results/setup-latex-probe-failed.png' });
  }
  f.scenario.failure = true;
  await dialog.getByRole('button', { name: 'Detect again' }).click();
  await status(dialog, 'Check failed');
  await goTo(dialog, 'git');
  await status(dialog, 'Check failed');
  assert.equal(await dialog.getByRole('link', { name: 'Install Git' }).count(), 0);
  f.scenario.failure = false; f.scenario.report = report('darwin');
  await dialog.getByRole('button', { name: 'Check again' }).click();
  await status(dialog, 'Ready');
  assert.equal(await banner.count(), 0);
  await goTo(dialog, 'latex');
  await status(dialog, 'Ready');
  await dialog.screenshot({ animations: 'disabled', path: 'test-results/setup-latex-desktop.png' });
  await goTo(dialog, 'general');
  assert.equal(await dialog.getByRole('switch', { name: 'Show advanced Git features' }).count(), 0);
  await dialog.getByRole('searchbox', { name: 'Search settings' }).fill('advanced Git');
  await goTo(dialog, 'git');
  assert.equal(await dialog.getByRole('switch', { name: 'Show advanced Git features' }).isChecked(), true);
  assert.ok(f.scenario.requests >= 5);
  await f.context.close();

  // Existing users are not interrupted, and the host's OS wins over the browser's.
  const existing = await fixture({ platform: 'linux', missing: ['latexmk'], existing: true });
  await existing.page.locator('.requirements-banner').getByRole('button', { name: 'LaTeX' }).waitFor();
  assert.equal(await existing.page.getByRole('dialog').count(), 0);
  await existing.page.locator('.requirements-banner').getByRole('button', { name: 'LaTeX' }).click();
  await existing.page.getByRole('link', { name: 'Install TeX Live' }).waitFor();
  assert.equal(await existing.page.getByRole('link', { name: 'Install MacTeX' }).count(), 0);
  assert.equal(await existing.page.getByRole('link', { name: 'Install Git' }).count(), 0);
  await existing.context.close();

  const demo = await fixture({ existing: true, returning: false, desktop: true, missing: ['latexmk'] });
  await demo.page.getByRole('dialog', { name: 'LaTeX', exact: true }).waitFor();
  await demo.context.close();

  const failed = await fixture({ failure: true });
  await failed.page.locator('.requirements-banner').getByRole('button', { name: 'Git', exact: true }).click();
  await status(failed.page.getByRole('dialog'), 'Check failed');
  failed.scenario.failure = false; failed.scenario.report = report('linux');
  await failed.page.getByRole('button', { name: 'Check again' }).click();
  await status(failed.page.getByRole('dialog'), 'Ready');
  await failed.context.close();

  const ready = await fixture({ missing: [] });
  await ready.page.getByRole('button', { name: 'Settings', exact: true }).click();
  await goTo(ready.page.getByRole('dialog'), 'git');
  await status(ready.page.getByRole('dialog'), 'Ready');
  assert.equal(await ready.page.locator('.requirements-banner').count(), 0);
  await ready.context.close();

  const windows = await fixture({ platform: 'win32' });
  assert.equal(await windows.page.getByRole('link', { name: 'Install Git' }).getAttribute('href'), 'https://git-scm.com/install/windows');
  await goTo(windows.page.getByRole('dialog'), 'latex');
  assert.equal(await windows.page.getByRole('link', { name: 'Install TeX Live' }).getAttribute('href'), 'https://www.tug.org/texlive/acquire-netinstall.html');
  assert.equal(await windows.page.getByRole('link', { name: 'Install MacTeX' }).count(), 0);
  await windows.context.close();

  // Every supported translation is exercised at a phone width, including long labels.
  for (const language of ['zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es', 'pt', 'it', 'sv']) {
    const locale = language === 'zh-Hans' ? 'zh-CN' : language;
    const dictionary = JSON.parse(fs.readFileSync(`src/web/locales/${locale}.json`, 'utf8'));
    const f = await fixture({ language, width: 390, dark: language === 'de' });
    const dialog = f.page.getByRole('dialog');
    await dialog.getByRole('link', { name: dictionary['Install Git'] }).waitFor();
    assert.equal(await dialog.locator('.settings-content').evaluate(el => el.scrollWidth > el.clientWidth + 1), false, `${language} Git page must fit a phone`);
    await goTo(dialog, 'latex');
    await dialog.getByRole('link', { name: dictionary['Install MacTeX'] }).waitFor();
    await dialog.getByText('/fixture/texlive', { exact: true }).waitFor();
    assert.equal(await dialog.locator('.settings-content').evaluate(el => el.scrollWidth > el.clientWidth + 1), false, `${language} LaTeX page must fit a phone`);
    if (['zh-Hans', 'de'].includes(language)) await f.page.screenshot({ animations: 'disabled', path: `test-results/setup-${locale}-mobile.png` });
    await f.context.close();
  }
  assert.deepEqual(errors, []);
  console.log('Git and LaTeX settings UI passed: separate pages, startup links, retries, partial installs, host OS, keyboard focus, advanced Git preferences, and 11 languages.');
} finally { await browser.close(); await server.close(); }
