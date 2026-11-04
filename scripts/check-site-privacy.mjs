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
assert.doesNotMatch(html, /<script\b|data-website-id|analytics\.js/);
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
    assert.equal(await link.isVisible(), true, `${locale}: the notice does not depend on statistics or JavaScript`);
    const expected = locale === 'en' ? 'Privacy notice' : JSON.parse(fs.readFileSync(path.join(root, `site/locales/${locale}.json`), 'utf8'))['Privacy notice'];
    assert.equal(await link.innerText(), expected);
  }
  await page.locator('.footer a[href="/privacy/"]').click();
  await page.waitForURL(origin + '/privacy/');
  assert.equal(await page.locator('script').count(), 0);
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
  console.log('Privacy checks passed: bilingual notice, no scripts or external requests, 11 permanent localized links, canonical/sitemap, contact details, and 320/390/1440px layouts.');
} finally {
  await browser?.close();
  await server.close();
}
