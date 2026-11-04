// Production URLs are intercepted locally; these checks never send real statistics.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium, webkit } from '../engine/node_modules/playwright/index.mjs';
import { parse } from 'parse5';
import { siteAnalytics } from './site-analytics.mjs';

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
assert.equal(head.childNodes.length, 2, 'configuration cannot inject another element');
const script = head.childNodes[1];
assert.equal(script.attrs.length, 6, 'configuration cannot inject attributes');
assert.equal(script.attrs.find(attr => attr.name === 'data-script-url').value, new URL(hostileUrl).href);
const consentVersion = siteAnalytics(config).match(/data-consent-version="([^"]+)"/)[1];
for (const change of [{ PAPILOT_ANALYTICS_PRIVACY_URL: 'https://privacy.example/new' }, { PAPILOT_UMAMI_SCRIPT_URL: 'https://another.example/script.js' }, { PAPILOT_UMAMI_WEBSITE_ID: '12345678-1234-1234-1234-123456789abd' }]) {
  assert.ok(!siteAnalytics({ ...config, ...change }).includes(consentVersion), 'a new provider, website or notice requires fresh consent');
}

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-site-analytics-'));
const locales = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'i18n/languages.json'), 'utf8')));
const routeFor = locale => locale === 'en' ? '/' : `/${locale}/`;
const output = locale => path.join(fixture, '_site', locale === 'en' ? '' : locale, 'index.html');
const consentKey = 'papilot-statistics-consent', duration = 180 * 86400000;
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
  const disabledPages = new Map(locales.map(locale => [routeFor(locale), fs.readFileSync(output(locale), 'utf8')]));
  for (const html of disabledPages.values()) assert.doesNotMatch(html, /src="[^"]*analytics\.js|data-website-id/);
  assert.equal(fs.existsSync(path.join(fixture, '_site/analytics.js')), false);
  build(config);
  for (const locale of locales) {
    const html = fs.readFileSync(output(locale), 'utf8');
    assert.match(html, /src="\/analytics\.js\?v=[a-f0-9]+"/);
    assert.equal((html.match(/data-website-id=/g) || []).length, 1);
    assert.equal((html.match(/data-download-format=/g) || []).length, 8);
    assert.doesNotMatch(html, /papilot-analytics-referrer|sessionStorage/);
  }
  browser = process.env.PAPILOT_BROWSER_ENGINE === 'webkit'
    ? await webkit.launch({ headless: true })
    : await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
  const errors = [], requests = [], collected = [];
  let enabled = true, blocked = false, delayProvider;
  const setup = async options => {
    const context = await browser.newContext({ reducedMotion: 'reduce', ...options });
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
  const externalCount = () => requests.filter(url => url.startsWith('https://statistics.example')).length;
  const visit = (url = 'https://papilot.ai/') => page.goto(url, { referer: 'https://source.example/private/email@example.org?token=secret' });
  const reset = () => page.evaluate(() => localStorage.clear());
  const permit = async () => {
    await page.locator('#statistics-allow').click();
    await page.waitForFunction(() => window.statistics.length > 0);
  };
  const reopen = () => page.locator('#statistics-preferences').click();

  for (const locale of locales) {
    if (page.url() !== 'about:blank') await reset();
    const before = externalCount();
    await visit('https://papilot.ai' + routeFor(locale));
    assert.equal(await page.locator('#statistics-notice').isVisible(), true);
    assert.equal(await page.locator('#statistics-privacy').getAttribute('href'), config.PAPILOT_ANALYTICS_PRIVACY_URL);
    assert.equal(await page.locator('#statistics-allow').getAttribute('class'), await page.locator('#statistics-decline').getAttribute('class'), 'choices have equal emphasis');
    await page.locator('.hero [data-copy]').click();
    assert.equal(externalCount(), before, `${locale}: no statistics before a choice`);
    await page.locator('#statistics-decline').click();
    await page.reload();
    assert.equal(await page.locator('#statistics-notice').isHidden(), true);
    assert.equal(externalCount(), before, `${locale}: rejection is remembered without loading analytics`);
    await reopen();
    await permit();
    assert.deepEqual(await visits(), [{ website: config.PAPILOT_UMAMI_WEBSITE_ID, hostname: 'papilot.ai', url: routeFor(locale), title: 'Papilot', language: locale, referrer: 'https://source.example' }]);
    assert.equal(await page.evaluate(() => window.trackerConfig.autoTrack), 'false');
    await reopen();
    await page.locator('#statistics-withdraw').click();
    const count = (await visits()).length;
    await page.locator('.hero [data-copy]').click();
    await page.evaluate(() => window.umami.track('download_click', { placement: 'hero' }));
    assert.equal((await visits()).length, count, `${locale}: withdrawal also stops direct provider calls`);
  }

  await reset();
  await visit('https://papilot.ai/zh-CN/?email=private@example.org&token=secret&utm_source=private&gclid=tracking#private');
  await permit();
  assert.equal((await visits())[0].url, '/zh-CN/');
  assert.equal((await visits())[0].referrer, 'https://source.example');
  await page.evaluate(() => window.umami.track('download_click', { placement: 'hero', platform: 'mac', arch: 'arm64', format: 'dmg', email: 'private@example.org' }));
  assert.deepEqual((await visits()).at(-1).data, { locale: 'zh-CN', placement: 'hero', platform: 'mac', arch: 'arm64', format: 'dmg' });
  const countBeforeUnknown = (await visits()).length;
  await page.evaluate(() => window.umami.track('arbitrary', { email: 'private@example.org' }));
  assert.equal((await visits()).length, countBeforeUnknown);
  for (const [list, button, placement] of [['download-list', 'download-button', 'hero'], ['get-list', 'get-button', 'download']]) {
    for (const [platform, arch, format] of [['mac', 'arm64', 'dmg'], ['mac', 'x64', 'dmg'], ['linux', 'x64', 'AppImage'], ['linux', 'x64', 'deb']]) {
      await page.locator(`#${button}`).click();
      const download = page.waitForEvent('download');
      await page.locator(`#${list} [data-download-platform="${platform}"][data-download-arch="${arch}"][data-download-format="${format}"] strong`).click();
      await (await download).cancel();
      assert.deepEqual((await visits()).at(-1).data, { locale: 'zh-CN', placement, platform, arch, format });
      assert.equal(await page.locator(`#${list}`).isHidden(), true);
    }
  }
  for (const [selector, placement] of [['.hero [data-copy]', 'hero'], ['#download [data-copy]', 'download']]) {
    await page.locator(selector).click();
    assert.equal((await visits()).at(-1).name, 'copy_install');
    assert.deepEqual((await visits()).at(-1).data, { locale: 'zh-CN', placement });
  }
  await page.evaluate(() => { window.copyFails = true; });
  const beforeFailure = (await visits()).length;
  await page.locator('.hero [data-copy]').click();
  assert.equal((await visits()).length, beforeFailure, 'failed clipboard writes never count');

  // Inspect actual mocked HTTP collection, including the browser's Referer header.
  assert.ok(collected.length > 0);
  for (const item of collected) {
    assert.doesNotMatch(JSON.stringify(item), /private|secret|tracking|gclid|utm_|screen|unexpected-id|email@/);
    assert.ok(!item.referer || item.referer === 'https://papilot.ai/', `collector Referer is origin-only: ${item.referer}`);
  }

  // Failed preference writes must not leave a previous grant to revive on reload.
  await reopen();
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('Storage write blocked'); }; });
  await page.locator('#statistics-withdraw').click();
  assert.equal(await page.evaluate(key => localStorage.getItem(key), consentKey), null);
  const beforeFailedSaveReload = externalCount();
  await page.reload();
  assert.deepEqual(await visits(), []);
  assert.equal(externalCount(), beforeFailedSaveReload);
  assert.equal(await page.locator('#statistics-notice').isVisible(), true);

  for (const saved of [{ version: 'old-provider', choice: 'granted', expiresAt: Date.now() + duration }, { version: consentVersion, choice: 'granted', expiresAt: Date.now() - 1 }, { version: consentVersion, choice: 'granted', expiresAt: 'never' }]) {
    await page.evaluate(({ key, saved }) => localStorage.setItem(key, JSON.stringify(saved)), { key: consentKey, saved });
    const before = externalCount();
    await visit();
    assert.equal(await page.locator('#statistics-notice').isVisible(), true);
    assert.equal(externalCount(), before, 'invalid or expired consent does not load a provider');
  }
  await permit();
  const consent = JSON.parse(await page.evaluate(key => localStorage.getItem(key), consentKey));
  assert.deepEqual(Object.keys(consent), ['version', 'choice', 'expiresAt']);
  assert.ok(consent.expiresAt - Date.now() <= duration);
  await page.evaluate(duration => { const now = Date.now(); Date.now = () => now + duration + 1; document.dispatchEvent(new Event('visibilitychange')); }, duration);
  assert.equal(await page.locator('#statistics-notice').isVisible(), true);
  const beforeExpiryClick = (await visits()).length;
  await page.locator('.hero [data-copy]').click();
  assert.equal((await visits()).length, beforeExpiryClick, 'consent expires in an open tab');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), consentKey), null, 'expired preferences are removed when observed');

  for (const origin of ['http://localhost:7274', 'https://preview.example', 'https://papilot.ai.preview.example']) {
    const before = externalCount();
    await visit(origin + '/');
    assert.deepEqual(await visits(), []);
    assert.equal(externalCount(), before);
    assert.equal(await page.locator('#statistics-preferences').isHidden(), true);
  }
  enabled = false;
  for (const locale of locales) {
    await visit('https://papilot.ai' + routeFor(locale));
    assert.deepEqual(await visits(), []);
    assert.equal(await page.locator('#statistics-preferences').isHidden(), true);
  }
  enabled = true;
  await reset();
  blocked = true;
  await visit();
  await page.locator('#statistics-allow').click();
  await page.locator('.hero [data-copy]').click();
  assert.equal(await page.locator('.hero [data-copy]').evaluate(button => button.classList.contains('copied')), true);
  blocked = false;
  for (const failure of ['throw', 'reject']) {
    await visit();
    await page.waitForFunction(() => window.statistics.length > 0);
    await page.evaluate(failure => { window.umami.track = () => { if (failure === 'throw') throw new Error('Unavailable'); return Promise.reject(new Error('Unavailable')); }; }, failure);
    await page.locator('.hero [data-copy]').click();
    assert.equal(await page.locator('.hero [data-copy]').evaluate(button => button.classList.contains('copied')), true);
    await page.locator('#download-button').click();
    const download = page.waitForEvent('download');
    await page.locator('#download-list [data-download-format]').first().click();
    await (await download).cancel();
  }

  // Revoking while the script is in flight must not send a late pageview.
  await reset();
  let releaseProvider;
  delayProvider = new Promise(resolve => { releaseProvider = resolve; });
  await visit();
  await page.locator('#statistics-allow').click();
  await reopen();
  await page.locator('#statistics-withdraw').click();
  releaseProvider(); delayProvider = null;
  await page.waitForFunction(() => window.umami);
  assert.deepEqual(await visits(), []);
  await context.close();

  const storageBlocked = await setup();
  await storageBlocked.addInitScript(() => { Storage.prototype.getItem = () => { throw new Error('Blocked'); }; Storage.prototype.setItem = () => { throw new Error('Blocked'); }; });
  const privatePage = await storageBlocked.newPage();
  await privatePage.goto('https://papilot.ai/');
  assert.equal(await privatePage.locator('#statistics-notice').isVisible(), true);
  await privatePage.locator('#statistics-allow').click();
  await privatePage.waitForFunction(() => window.statistics.length === 1);
  await privatePage.reload();
  assert.deepEqual(await privatePage.evaluate(() => window.statistics), [], 'blocked storage never invents saved consent');
  await storageBlocked.close();

  const visual = await setup();
  const visualPage = await visual.newPage();
  fs.mkdirSync(path.join(root, 'test-results/site'), { recursive: true });
  for (const width of [1440, 390, 320]) {
    await visualPage.setViewportSize({ width, height: 900 });
    for (const locale of locales) {
      await visualPage.goto('https://papilot.ai' + routeFor(locale));
      assert.equal(await visualPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${locale}/${width}: consent fits`);
      if (['en', 'zh-CN', 'de'].includes(locale) && width !== 320) await visualPage.screenshot({ path: path.join(root, `test-results/site/statistics-${locale}-${width}.png`) });
    }
  }
  await visual.close();
  assert.deepEqual(errors, []);
  console.log('Site analytics checks passed: safe configuration, 11 localized opt-ins, no pre-consent requests, denial and withdrawal, payload minimization, consent expiry/storage failures, downloads/copying, provider failures, and responsive layouts.');
} finally {
  await browser?.close();
  fs.rmSync(fixture, { recursive: true, force: true });
}
