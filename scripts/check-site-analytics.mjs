// Production URLs are intercepted locally; these checks never send real statistics.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium, webkit } from '../engine/node_modules/playwright/index.mjs';
import { parse } from 'parse5';
import { siteAnalytics } from './site-analytics.mjs';
import { checkSiteBehavior } from './site-behavior-checks.mjs';

const root = path.resolve(import.meta.dirname, '..');
const config = {
  PAPILOT_UMAMI_SCRIPT_URL: 'https://statistics.example/script.js?a=1&b=2',
  PAPILOT_UMAMI_WEBSITE_ID: '12345678-1234-1234-1234-123456789abc',
  PAPILOT_ANALYTICS_PRIVACY_URL: 'https://privacy.example/notice',
};
assert.equal(siteAnalytics({}), '');
assert.equal(siteAnalytics(Object.fromEntries(Object.keys(config).map(key => [key, ' ']))), '');
for (const key of Object.keys(config)) assert.throws(() => siteAnalytics({ ...config, [key]: '' }));
for (const url of ['javascript:alert(1)', '/script.js', 'http://statistics.example/script.js', 'https://user:pass@statistics.example/script.js']) {
  assert.throws(() => siteAnalytics({ ...config, PAPILOT_UMAMI_SCRIPT_URL: url }));
  assert.throws(() => siteAnalytics({ ...config, PAPILOT_ANALYTICS_PRIVACY_URL: url }));
}
assert.throws(() => siteAnalytics({ ...config, PAPILOT_UMAMI_WEBSITE_ID: '"><script>alert(1)</script>' }));
const hostileUrl = 'https://statistics.example/script.js?x="/><script>alert(1)</script>&y=2';
const document = parse(siteAnalytics({ ...config, PAPILOT_UMAMI_SCRIPT_URL: hostileUrl }));
const head = document.childNodes.find(node => node.tagName === 'html').childNodes.find(node => node.tagName === 'head');
assert.equal(head.childNodes.length, 3, 'configuration cannot inject another element');
const script = head.childNodes[2];
assert.equal(script.attrs.length, 5, 'configuration cannot inject attributes');
assert.equal(script.attrs.find(attr => attr.name === 'data-script-url').value, new URL(hostileUrl).href);
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-site-analytics-'));
const locales = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'i18n/languages.json'), 'utf8')));
const routeFor = locale => locale === 'en' ? '/' : `/${locale}/`;
const output = locale => path.join(fixture, '_site', locale === 'en' ? '' : locale, 'index.html');
const optOutKey = 'papilot-statistics-disabled';
let browser;
try {
  for (const entry of ['site', 'docs/assets', 'src/web/fonts', 'src/web/brand-icons', 'public', 'i18n/config.json', 'i18n/languages.json', 'package.json', 'scripts/build-site.mjs', 'scripts/site-i18n.mjs', 'scripts/site-analytics.mjs']) {
    const target = path.join(fixture, entry);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(root, entry), target, { recursive: true });
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
  const build = env => execFileSync(process.execPath, ['scripts/build-site.mjs'], { cwd: fixture, env: { ...process.env, ...Object.fromEntries(Object.keys(config).map(key => [key, ''])), ...env }, stdio: 'pipe' });
  build({});
  const privacy = fs.readFileSync(path.join(fixture, '_site/privacy/index.html'), 'utf8');
  assert.doesNotMatch(privacy, /data-website-id|src="[^"]*analytics\.js/, 'privacy page never loads analytics');
  const disabledPages = new Map(locales.map(locale => [routeFor(locale), fs.readFileSync(output(locale), 'utf8')]));
  for (const html of disabledPages.values()) assert.doesNotMatch(html, /src="[^"]*analytics\.js|data-website-id/);
  assert.equal(fs.existsSync(path.join(fixture, '_site/analytics.js')), false);
  build(config);
  assert.equal(fs.readFileSync(path.join(fixture, '_site/privacy/index.html'), 'utf8').replace('data-enabled="true"', 'data-enabled="false"'), privacy, 'only local preference availability changes on the privacy page');
  for (const locale of locales) {
    const html = fs.readFileSync(output(locale), 'utf8');
    assert.match(html, /src="\/analytics\.js\?v=[a-f0-9]+"/);
    assert.equal((html.match(/data-website-id=/g) || []).length, 1);
    assert.equal((html.match(/data-download-format=/g) || []).length, 12);
    assert.doesNotMatch(html, /papilot-analytics-referrer|sessionStorage/);
  }
  browser = process.env.PAPILOT_BROWSER_ENGINE === 'webkit'
    ? await webkit.launch({ headless: true })
    : await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
  const errors = [], requests = [], collected = [];
  let enabled = true, blocked = false, delayProvider;
  const setup = async options => {
    const context = await browser.newContext({ reducedMotion: 'reduce', ...options });
    context.setDefaultTimeout(15000);
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await context.addInitScript(() => {
      window.statistics = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText() { if (window.copyFails) throw new Error('Clipboard denied'); } } });
    });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      requests.push(url.href);
      if (url.origin === 'https://statistics.example') {
        if (url.pathname === '/api/send') {
          collected.push({ payload: route.request().postDataJSON(), referer: route.request().headers().referer });
          return route.fulfill({ json: {} });
        }
        if (blocked) return route.abort();
        if (delayProvider) await delayProvider;
        // Match Umami's documented auto-track=false and before-send contract.
        return route.fulfill({ contentType: 'application/javascript', body: `
          window.trackerConfig = { ...document.currentScript.dataset };
          window.umami = { async track(name, data) {
            const raw = { name, data, url: location.href, screen: '1920x1080', id: 'unexpected-id', referrer: document.referrer };
            const payload = await window[window.trackerConfig.beforeSend]('event', raw);
            if (!payload) return;
            window.statistics.push(payload);
            return fetch('https://statistics.example/api/send', { method: 'POST', body: JSON.stringify(payload), keepalive: true });
          } };
          if (window.trackerConfig.autoTrack !== 'false') window.umami.track();
        ` });
      }
      if (url.origin === 'https://github.com') return route.fulfill({ contentType: 'application/octet-stream', headers: { 'Content-Disposition': 'attachment; filename="test.dmg"' }, body: 'test download' });
      assert.ok(['https://papilot.ai', 'https://www.papilot.ai', 'http://localhost:7274', 'https://preview.example', 'https://papilot.ai.preview.example'].includes(url.origin), `unexpected external request: ${url}`);
      const html = !enabled && disabledPages.get(url.pathname);
      if (html) return route.fulfill({ contentType: 'text/html', body: html });
      return route.fulfill({ path: path.join(fixture, '_site', url.pathname, url.pathname.endsWith('/') ? 'index.html' : '') });
    });
    return context;
  };
  const context = await setup();
  const page = await context.newPage();
  const visits = () => page.evaluate(() => window.statistics);
  const events = async name => (await visits()).filter(event => event.name === name);
  const externalCount = () => requests.filter(url => url.startsWith('https://statistics.example')).length;
  const visit = (url = 'https://papilot.ai/') => page.goto(url, { referer: 'https://source.example/private/email@example.org?token=secret', waitUntil: 'domcontentloaded' });
  const ready = () => page.waitForFunction(() => window.statistics.some(event => !event.name));
  for (const locale of locales) {
    await visit('https://papilot.ai' + routeFor(locale));
    await ready();
    assert.equal(await page.locator('#statistics-notice, #statistics-preferences').count(), 0, 'no homepage consent interface');
    assert.equal(await page.locator('.footer a[href="/privacy/"]').count(), 1);
    assert.deepEqual((await visits())[0], { website: config.PAPILOT_UMAMI_WEBSITE_ID, hostname: 'papilot.ai', url: routeFor(locale), title: 'Papilot', language: locale, referrer: 'https://source.example' });
    assert.equal(await page.evaluate(() => window.trackerConfig.autoTrack), 'false');
    await page.locator('.hero [data-copy]').click();
    assert.equal((await events('copy_install')).length, 1);
  }
  await visit('https://papilot.ai/zh-CN/?email=private@example.org&token=secret&utm_source=private&gclid=tracking#private');
  await ready();
  assert.equal((await visits())[0].url, '/zh-CN/');
  await page.evaluate(() => window.umami.track('download_click', { placement: 'hero', platform: 'mac', arch: 'arm64', format: 'dmg', email: 'private@example.org' }));
  assert.deepEqual((await events('download_click')).at(-1).data, { locale: 'zh-CN', placement: 'hero', platform: 'mac', arch: 'arm64', format: 'dmg' });
  const unknownBefore = (await visits()).length;
  await page.evaluate(() => window.umami.track('arbitrary', { email: 'private@example.org' }));
  assert.equal((await visits()).length, unknownBefore);
  for (const [list, button, placement] of [['download-list', 'download-button', 'hero'], ['get-list', 'get-button', 'download']]) {
    for (const [platform, arch, format] of [['mac', 'arm64', 'dmg'], ['mac', 'x64', 'dmg'], ['linux', 'x64', 'AppImage'], ['linux', 'x64', 'deb'], ['windows', 'x64', 'exe'], ['windows', 'x64', 'portable-exe']]) {
      await page.locator(`#${button}`).click();
      const download = page.waitForEvent('download');
      await page.locator(`#${list} [data-download-platform="${platform}"][data-download-arch="${arch}"][data-download-format="${format}"] strong`).click();
      await (await download).cancel();
      assert.deepEqual((await events('download_click')).at(-1).data, { locale: 'zh-CN', placement, platform, arch, format });
    }
  }
  for (const [selector, placement] of [['.hero [data-copy]', 'hero'], ['#download [data-copy]', 'download']]) {
    await page.locator(selector).click();
    assert.deepEqual((await events('copy_install')).at(-1).data, { locale: 'zh-CN', placement });
  }
  await page.evaluate(() => { window.copyFails = true; });
  await page.locator('.hero [data-copy]').click();
  assert.equal((await events('copy_install_failed')).length, 1);
  for (const item of collected) {
    assert.doesNotMatch(JSON.stringify(item), /private|secret|tracking|gclid|utm_|screen|unexpected-id|email@/);
    assert.ok(!item.referer || item.referer === 'https://papilot.ai/');
  }

  // Opt-out is available only on the untracked privacy page, and reaches open tabs.
  const privacyPage = await context.newPage();
  const beforePrivacy = externalCount();
  await privacyPage.goto('https://papilot.ai/privacy/');
  assert.equal(externalCount(), beforePrivacy, 'privacy page makes no provider requests');
  await privacyPage.locator('#statistics-disable').click();
  await page.waitForFunction(() => !window.papilotStatistics.enabled());
  const stopped = (await visits()).length;
  await page.locator('.hero [data-copy]').click();
  await page.evaluate(() => window.umami.track('menu_open', { menu: 'download', placement: 'hero' }));
  assert.equal((await visits()).length, stopped);
  const beforeDisabled = externalCount();
  await visit();
  assert.deepEqual(await visits(), []);
  assert.equal(externalCount(), beforeDisabled);
  await privacyPage.locator('#statistics-enable').click();
  await ready();

  // Never reinterpret an old refusal as permission, even if its old version expired.
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('papilot-statistics-consent', JSON.stringify({ choice: 'denied', version: 'old', expiresAt: 1 })); });
  await visit();
  assert.deepEqual(await visits(), []);
  await privacyPage.reload();
  await privacyPage.locator('#statistics-enable').click();
  await ready();
  assert.equal(await page.evaluate(() => localStorage.getItem('papilot-statistics-consent')), null);

  // If storage refuses writes, a local broadcast still stops already open tabs.
  await privacyPage.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('Blocked'); }; });
  await privacyPage.locator('#statistics-disable').click();
  await page.waitForFunction(() => !window.papilotStatistics.enabled());
  assert.match(await privacyPage.locator('#statistics-status').innerText(), /cannot save/);
  await context.close();

  for (const mode of ['dnt', 'gpc', 'blocked-storage', 'opted-out', 'provider-opted-out']) {
    const isolated = await setup();
    await isolated.addInitScript(mode => {
      if (mode === 'dnt') Object.defineProperty(navigator, 'doNotTrack', { get: () => '1' });
      if (mode === 'gpc') Object.defineProperty(navigator, 'globalPrivacyControl', { get: () => true });
      if (mode === 'blocked-storage') Storage.prototype.getItem = () => { throw new Error('Blocked'); };
      if (location.protocol !== 'about:') {
        if (mode === 'opted-out') localStorage.setItem('papilot-statistics-disabled', 'true');
        if (mode === 'provider-opted-out') localStorage.setItem('umami.disabled', '1');
      }
    }, mode);
    const tab = await isolated.newPage(), before = externalCount();
    await tab.goto('https://papilot.ai/');
    assert.equal(externalCount(), before, `${mode}: no provider load`);
    assert.deepEqual(await tab.evaluate(() => window.statistics), []);
    await isolated.close();
  }
  const delayed = await setup();
  const delayedPage = await delayed.newPage();
  let releaseProvider;
  delayProvider = new Promise(resolve => { releaseProvider = resolve; });
  await delayedPage.goto('https://papilot.ai/', { waitUntil: 'domcontentloaded' });
  const delayedPrivacy = await delayed.newPage();
  await delayedPrivacy.goto('https://papilot.ai/privacy/');
  await delayedPrivacy.locator('#statistics-disable').click();
  await delayedPage.waitForFunction(() => !window.papilotStatistics.enabled());
  releaseProvider(); delayProvider = null;
  await delayedPage.waitForFunction(() => window.umami);
  assert.deepEqual(await delayedPage.evaluate(() => window.statistics), [], 'late provider load cannot revive opted-out tracking');
  await delayed.close();

  const unsupported = await setup();
  const unsupportedPage = await unsupported.newPage();
  for (const origin of ['http://localhost:7274', 'https://preview.example', 'https://papilot.ai.preview.example']) {
    const before = externalCount();
    await unsupportedPage.goto(origin + '/');
    assert.equal(externalCount(), before);
  }
  enabled = false;
  for (const locale of locales) {
    const before = externalCount();
    await unsupportedPage.goto('https://papilot.ai' + routeFor(locale));
    assert.equal(externalCount(), before);
  }
  enabled = true;
  blocked = true;
  await unsupportedPage.goto('https://papilot.ai/');
  await unsupportedPage.locator('.hero [data-copy]').click();
  assert.equal(await unsupportedPage.locator('.hero [data-copy]').evaluate(button => button.classList.contains('copied')), true);
  blocked = false;
  await unsupported.close();
  await checkSiteBehavior(await setup());
  assert.deepEqual(errors, []);
  console.log('Analytics checks passed: default-on in 11 locales, no homepage banner, privacy-page opt-out across tabs, legacy refusal, DNT/GPC, storage failures, filtering, real downloads/copies, delayed provider and unsupported hosts. No real statistics sent.');
} finally {
  await browser?.close();
  fs.rmSync(fixture, { recursive: true, force: true });
}
