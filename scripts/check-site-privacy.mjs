// The public notice must remain readable without JavaScript or third-party requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, webkit } from '../engine/node_modules/playwright/index.mjs';

const root = path.resolve(import.meta.dirname, '..');
const languages = JSON.parse(fs.readFileSync(path.join(root, 'i18n/languages.json'), 'utf8'));
const html = fs.readFileSync(path.join(root, '_site/privacy/index.html'), 'utf8');
assert.doesNotMatch(html, /data-website-id|analytics\.js|cloud\.umami\.is|gateway\.umami\.is/);
assert.equal((html.match(/<script\b/g) || []).length, 1);
assert.match(html, /<script defer src="\/statistics-preferences\.js\?v=[a-f0-9]+" data-enabled="(?:true|false)"><\/script>/);
assert.match(html, /statistics by default/);
assert.match(html, /默认开启/);
assert.doesNotMatch(html, /After consent|Until you allow statistics|有效期为 180 天/);
assert.match(html, /Chen Cui/);
assert.match(html, /mailto:i@cuichen\.cc/);
assert.match(html, /six months/);
assert.match(html, /六个月/);
assert.match(html, /href="\/style\.css\?v=[a-f0-9]+"/);
assert.ok(fs.readFileSync(path.join(root, '_site/sitemap.xml'), 'utf8').includes('<loc>https://papilot.ai/privacy/</loc>'));
const server = Fastify();
await server.register(staticFiles, { root: path.join(root, '_site') });
await server.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.server.address().port}`;
let browser;
const external = [], errors = [];
try {
  browser = process.env.PAPILOT_BROWSER_ENGINE === 'webkit'
    ? await webkit.launch({ headless: true })
    : await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ javaScriptEnabled: false, reducedMotion: 'reduce' });
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  for (const locale of Object.keys(languages)) {
    await page.goto(origin + (locale === 'en' ? '/' : `/${locale}/`));
    const link = page.locator('.footer a[href="/privacy/"]');
    assert.equal(await link.count(), 1, `${locale}: permanent privacy link`);
    assert.equal(await page.locator('.footer button, .footer [id^=statistics-]').count(), 0, `${locale}: no statistics controls in the homepage footer`);
    assert.equal(await link.isVisible(), true, `${locale}: the notice does not depend on statistics or JavaScript`);
    const expected = locale === 'en' ? 'Privacy notice' : JSON.parse(fs.readFileSync(path.join(root, `site/locales/${locale}.json`), 'utf8'))['Privacy notice'];
    assert.equal(await link.innerText(), expected);
  }
  await page.locator('.footer a[href="/privacy/"]').click();
  await page.waitForURL(origin + '/privacy/');
  assert.equal(await page.locator('script').count(), 1);
  assert.match(await page.locator('script').getAttribute('src'), /^\/statistics-preferences\.js\?v=[a-f0-9]+$/);
  assert.equal(await page.locator('#statistics-privacy-controls').isHidden(), true, 'without JavaScript, the notice remains readable without inactive controls');
  assert.equal(await page.locator('link[rel=canonical]').getAttribute('href'), 'https://papilot.ai/privacy/');
  for (const language of ['en', 'zh-CN']) {
    assert.equal(await page.locator(`article[lang="${language}"]`).isVisible(), true);
    assert.equal(await page.locator(`article[lang="${language}"] a[href="mailto:i@cuichen.cc"]`).count(), 2);
  }
  fs.mkdirSync(path.join(root, 'test-results/site'), { recursive: true });
  for (const [width, scheme] of [[1440, 'light'], [390, 'dark'], [320, 'light']]) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(origin + '/privacy/');
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}: no horizontal overflow`);
    if (width !== 320) await page.screenshot({ path: path.join(root, `test-results/site/privacy-${width}-${scheme}.png`) });
    await page.locator('.privacy-nav a[href="#zh-CN"]').click();
    await page.waitForURL(origin + '/privacy/#zh-CN');
    const heading = await page.locator('#privacy-zh-title').boundingBox();
    assert.ok(heading.y >= 64 && heading.y < 200, `${width}: Chinese anchor clears the sticky header`);
    if (width !== 320) await page.screenshot({ path: path.join(root, `test-results/site/privacy-zh-CN-${width}-${scheme}.png`) });
  }
  assert.deepEqual(external, [], 'the notice loads only local resources');
  assert.deepEqual(errors, []);
  await context.close();

  // Exercise configured controls without changing the shared build output.
  // Only this local response's configuration flag changes; no provider is loaded.
  const preferencesContext = await browser.newContext({ reducedMotion: 'reduce' });
  let controlsEnabled = true;
  await preferencesContext.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { external.push(url.href); return route.abort(); }
    if (url.pathname === '/privacy/') return route.fulfill({ contentType: 'text/html', body: html.replace(/data-enabled="(?:true|false)"/, `data-enabled="${controlsEnabled}"`) });
    return route.continue();
  });
  preferencesContext.on('page', page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  });
  const settings = await preferencesContext.newPage(), otherTab = await preferencesContext.newPage();
  await settings.goto(origin + '/privacy/');
  await otherTab.goto(origin + '/privacy/');
  await settings.locator('#statistics-privacy-controls').waitFor({ state: 'visible' });
  assert.equal(await settings.locator('script').count(), 1);
  assert.equal(await settings.locator('#statistics-status').getAttribute('role'), 'status');
  const originalStatus = await otherTab.locator('#statistics-status').innerText();
  await settings.locator('#statistics-disable').click();
  assert.equal(await settings.evaluate(() => localStorage.getItem('papilot-statistics-disabled')), 'true');
  await otherTab.waitForFunction(before => document.getElementById('statistics-status').textContent !== before, originalStatus);
  await settings.reload();
  await settings.locator('#statistics-enable').waitFor({ state: 'visible' });
  await settings.locator('#statistics-enable').click();
  assert.equal(await settings.evaluate(() => localStorage.getItem('papilot-statistics-disabled')), 'false');
  await otherTab.locator('#statistics-disable').waitFor({ state: 'visible' });
  for (const [width, scheme] of [[1440, 'light'], [390, 'dark'], [320, 'light']]) {
    await settings.setViewportSize({ width, height: 900 });
    await settings.emulateMedia({ colorScheme: scheme });
    assert.equal(await settings.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}: settings fit`);
    if (width !== 320) await settings.screenshot({ path: path.join(root, `test-results/site/privacy-settings-${width}-${scheme}.png`) });
  }
  controlsEnabled = false;
  await settings.reload();
  assert.equal(await settings.locator('#statistics-privacy-controls').isHidden(), true, 'unconfigured builds keep statistics controls hidden');
  assert.equal(await settings.evaluate(() => window.papilotStatistics.enabled()), false);
  assert.deepEqual(external, [], 'even enabled settings never contact analytics or other external services');
  assert.deepEqual(errors, []);
  await preferencesContext.close();
  console.log('Privacy checks passed: bilingual no-JS notice, local-only preferences, opt-out/re-enable and cross-tab updates, 11 permanent privacy footer links, canonical/sitemap, contact details, and 320/390/1440px layouts.');
} finally {
  await browser?.close();
  await server.close();
}
