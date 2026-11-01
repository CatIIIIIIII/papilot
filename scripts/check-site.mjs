// Verify the passive desktop-size UI films, using an isolated static server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, webkit } from '../vendor/latex-review/node_modules/playwright/index.mjs';

const languages = JSON.parse(fs.readFileSync('i18n/languages.json', 'utf8'));
const route = locale => locale === 'en' ? '/' : `/${locale}/`;
const server = Fastify();
await server.register(staticFiles, { root: path.resolve('_site') });
await server.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.server.address().port}`;
const browser = process.env.PAPILOT_BROWSER_ENGINE === 'webkit'
  ? await webkit.launch({ headless: true })
  : await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const errors = [], requests = [];
fs.mkdirSync('test-results/site', { recursive: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference' });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  page.on('request', request => requests.push(request.url()));
  const time = new Date('2026-01-01T00:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(new Date(time.getTime() + 1000));
  await page.goto(`${origin}/?lang=en`);
  await page.evaluate(() => document.fonts.ready);
  const hero = page.locator('#demo-hero');
  const current = root => root.locator('[data-scene]:not([hidden])');
  const state = root => current(root).evaluate(el => [el.dataset.scene, el.dataset.phase]);
  const show = async root => {
    await root.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await root.evaluate(el => new Promise(resolve => {
      const observer = new IntersectionObserver(entries => {
        if (entries[0].isIntersecting) { observer.disconnect(); resolve(); }
      });
      observer.observe(el);
    }));
  };
  assert.equal(await page.locator('[data-demo]').count(), 5);
  assert.equal(await page.locator('.ui-demo button, .ui-demo input, .ui-demo textarea, .ui-demo a, .ui-demo [tabindex], .ui-demo [role=tab]').count(), 0);
  assert.equal(await page.locator('video').count(), 0);
  assert.equal(await page.locator('.ui-demo math').count() > 0, true);
  await show(hero);
  assert.deepEqual(await state(hero), ['annotate', '0']);
  await page.clock.runFor(1900);
  assert.deepEqual(await state(hero), ['annotate', '1']);
  await page.clock.runFor(1500);
  assert.equal(await current(hero).locator('.typed-copy').evaluate(el => getComputedStyle(el).visibility), 'visible');
  await hero.screenshot({ animations: 'disabled', path: 'test-results/site/hero-desktop.png' });
  // Clicking/hovering does not take control of the demo or stop its playback.
  await hero.click({ position: { x: 300, y: 200 } });
  await page.clock.runFor(2700);
  assert.deepEqual(await state(hero), ['annotate', '3']);
  assert.equal(await current(hero).locator('.agent-receipt').isVisible(), true);
  await page.clock.runFor(1600);
  assert.deepEqual(await state(hero), ['review', '0']);
  await page.clock.runFor(3700);
  assert.deepEqual(await state(hero), ['review', '2']);
  assert.equal(await current(hero).locator('.diff-before').isVisible(), false);
  assert.equal(await current(hero).locator('.accepted').isVisible(), true);
  await hero.screenshot({ animations: 'disabled', path: 'test-results/site/hero-review.png' });
  await page.clock.runFor(2900);
  assert.deepEqual(await state(hero), ['read', '0']);
  await page.clock.runFor(4700);
  assert.deepEqual(await state(hero), ['read', '2']);
  await page.clock.runFor(1000);
  assert.equal(await current(hero).locator('.zoom-large').isVisible(), true);
  await hero.screenshot({ animations: 'disabled', path: 'test-results/site/hero-read.png' });
  await page.clock.runFor(1300);
  assert.deepEqual(await state(hero), ['commit', '0']);
  await page.clock.runFor(6000);
  assert.deepEqual(await state(hero), ['commit', '4']);
  assert.equal(await current(hero).locator('.committed-label').isVisible(), true);
  await hero.screenshot({ animations: 'disabled', path: 'test-results/site/hero-commit.png' });
  await page.clock.runFor(1600);
  assert.deepEqual(await state(hero), ['annotate', '0']);

  // All four feature frames also play automatically, rather than waiting on a click.
  for (const kind of ['annotate', 'review', 'read', 'commit']) {
    const root = page.locator(`#demo-${kind}`);
    await show(root);
    const before = await state(root);
    await page.clock.runFor(3000);
    assert.notDeepEqual(await state(root), before, `${kind} must autoplay`);
    await root.screenshot({ animations: 'disabled', path: `test-results/site/${kind}-desktop.png` });
  }
  // Offscreen examples retain their place and resume from it.
  const beforeOffscreen = await state(hero);
  await page.clock.runFor(10000);
  assert.deepEqual(await state(hero), beforeOffscreen);

  // Every viewport retains the native 1000:740 frame, 660:340 panes and 46px
  // toolbar, scaled uniformly. No mobile mini-layout or internal scrollbars.
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [lang, name] of Object.entries(languages)) {
      await page.locator('#lang-button').click();
      await Promise.all([page.waitForURL(origin + route(lang)), page.getByRole('menuitemradio', { name, exact: true }).click()]);
      assert.equal(await page.evaluate(() => document.documentElement.lang), lang);
      await show(hero);
      const geometry = await hero.evaluate(el => {
        const panel = el.querySelector('[data-scene]:not([hidden])');
        const w = el.clientWidth;
        return {
          ratio: el.offsetWidth / el.offsetHeight,
          pane: panel.querySelector('.app-side').getBoundingClientRect().width / w,
          toolbar: panel.querySelector('.workspace-toolbar').getBoundingClientRect().height / w,
        };
      });
      assert.ok(Math.abs(geometry.ratio - 1000 / 740) < 0.01);
      assert.ok(Math.abs(geometry.pane - 0.34) < 0.002);
      assert.ok(Math.abs(geometry.toolbar - 0.046) < 0.002);
      // The demo controls must scale and center together, including at phone
      // widths where a text glyph's line box used to exceed its checkbox.
      for (const kind of ['annotate', 'review', 'read', 'commit']) {
        const root = page.locator(`#demo-${kind}`);
        const controls = await root.evaluate(el => [...el.querySelectorAll('.page-nav,.file-check,.note-check')].map(control => {
          const box = control.getBoundingClientRect();
          const glyph = control.querySelector('svg')?.getBoundingClientRect();
          return { name: control.className, width: box.width, height: box.height, glyph: glyph && {
            width: glyph.width, height: glyph.height,
            dx: glyph.x + glyph.width / 2 - box.x - box.width / 2,
            dy: glyph.y + glyph.height / 2 - box.y - box.height / 2,
          } };
        }));
        for (const control of controls) {
          const label = `${kind} ${control.name} at ${width}px (${lang})`;
          assert.ok(control.glyph?.width > 0 && control.glyph?.height > 0, `${label}: visible vector icon`);
          assert.ok(Math.abs(control.glyph.dx) < 0.1 && Math.abs(control.glyph.dy) < 0.1, `${label}: centered icon`);
          assert.ok(control.glyph.width < control.width && control.glyph.height < control.height, `${label}: icon fits inside control`);
          if (control.name.includes('check')) assert.ok(Math.abs(control.width - control.height) < 0.1, `${label}: square checkbox`);
        }
      }
      const scrollports = await page.evaluate(() => [...document.querySelectorAll('.ui-demo, .ui-demo *')].filter(el => {
        const s = getComputedStyle(el);
        return /^(auto|scroll)$/.test(s.overflowX) || /^(auto|scroll)$/.test(s.overflowY);
      }).map(el => el.className));
      assert.deepEqual(scrollports, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (width === 390) await hero.screenshot({ animations: 'disabled', path: `test-results/site/hero-mobile-${lang}.png` });
      if (width === 390) await page.locator('#demo-commit').screenshot({ animations: 'disabled', path: `test-results/site/commit-mobile-${lang}.png` });
    }
  }
  // Reduced motion removes animation, while the film still advances without
  // needing a play control (all states remain native, readable HTML).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const beforeReduced = await state(hero);
  await page.clock.runFor(3000);
  assert.notDeepEqual(await state(hero), beforeReduced);
  assert.equal(await current(hero).locator('.paper-content').first().evaluate(el => getComputedStyle(el).transitionDuration), '0s');

  const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const staticPage = await noJs.newPage();
  await staticPage.goto(origin);
  assert.equal(await staticPage.locator('#demo-hero .paper-sheet').first().isVisible(), true);
  assert.equal(await staticPage.locator('.ui-demo button, .ui-demo input').count(), 0);
  await staticPage.locator('#demo-hero').screenshot({ animations: 'disabled', path: 'test-results/site/no-js-mobile.png' });
  await noJs.close();
  // Every URL is already localized without JavaScript, with reciprocal SEO links.
  const sitemap = fs.readFileSync('_site/sitemap.xml', 'utf8');
  assert.match(fs.readFileSync('_site/robots.txt', 'utf8'), /Sitemap: https:\/\/papilot.ai\/sitemap.xml/);
  assert.equal((sitemap.match(/<url>/g) || []).length, Object.keys(languages).length);
  const staticContext = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const staticVisitor = await staticContext.newPage();
  for (const [locale] of Object.entries(languages)) {
    await staticVisitor.goto(origin + route(locale));
    const canonical = 'https://papilot.ai' + route(locale);
    assert.equal(await staticVisitor.locator('html').getAttribute('lang'), locale);
    assert.equal(await staticVisitor.locator('link[rel=canonical]').getAttribute('href'), canonical);
    assert.equal(await staticVisitor.locator('meta[property="og:url"]').getAttribute('content'), canonical);
    assert.equal(await staticVisitor.locator('meta[property="og:title"]').getAttribute('content'), await staticVisitor.title());
    for (const selector of ['meta[name=description]', 'meta[property="og:description"]', 'meta[property="og:locale"]']) assert.ok(await staticVisitor.locator(selector).getAttribute('content'));
    for (const alt of [...Object.keys(languages), 'x-default']) {
      const href = 'https://papilot.ai' + route(alt === 'x-default' ? 'en' : alt);
      assert.equal(await staticVisitor.locator(`link[hreflang="${alt}"]`).getAttribute('href'), href);
      assert.equal((sitemap.match(new RegExp(`hreflang="${alt}"`, 'g')) || []).length, Object.keys(languages).length);
      assert.ok(sitemap.includes(`hreflang="${alt}" href="${href}"`));
    }
    assert.equal(await staticVisitor.locator('#demo-hero .paper-sheet').first().isVisible(), true);
    assert.deepEqual(await staticVisitor.locator('main [lang]').evaluateAll(nodes => [...new Set(nodes.map(node => node.lang))]), [locale]);
    assert.equal(await staticVisitor.locator('.no-js-languages a').count(), Object.keys(languages).length);
  }
  await staticContext.close();
  const preferenceContext = await browser.newContext({ locale: 'ja-JP' });
  const visitor = await preferenceContext.newPage();
  await visitor.goto(origin);
  assert.equal(await visitor.locator('html').getAttribute('lang'), 'en', 'browser language does not redirect');
  await visitor.locator('#lang-button').click();
  await Promise.all([visitor.waitForURL(origin + '/ja/'), visitor.getByRole('menuitemradio', { name: languages.ja, exact: true }).click()]);
  await visitor.goto(origin);
  await visitor.waitForURL(origin + '/ja/');
  await visitor.goto(origin + '/de/');
  assert.equal(await visitor.locator('html').getAttribute('lang'), 'de', 'explicit URL wins over saved choice');
  await visitor.locator('#lang-button').click();
  await visitor.keyboard.press('Escape');
  assert.equal(await visitor.locator('#lang-list').isHidden(), true);
  await preferenceContext.close();

  // Capture the requested layouts and assert buttons, menus and cards fit.
  for (const locale of ['zh-CN', 'ja', 'de', 'sv']) {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(origin + route(locale));
      await page.evaluate(() => document.fonts.ready);
      await page.locator('#download-button').click();
      for (const selector of ['#download-button', '#download-list', '.agent-card']) {
        const boxes = await page.locator(selector).evaluateAll(nodes => nodes.map(el => ({ width: el.clientWidth, scroll: el.scrollWidth, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right })));
        for (const box of boxes) {
          assert.ok(box.scroll <= box.width + 1, `${locale}/${width}: ${selector} contents fit`);
          assert.ok(box.left >= 0 && box.right <= width + 1, `${locale}/${width}: ${selector} within viewport`);
        }
      }
      await page.screenshot({ animations: 'disabled', path: `test-results/site/${locale}-${width}-download.png` });
      await page.keyboard.press('Escape');
      await page.locator('#agents').screenshot({ animations: 'disabled', path: `test-results/site/${locale}-${width}-agents.png` });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await show(hero);
      assert.equal(await current(hero).locator('.paper-content').first().evaluate(el => getComputedStyle(el).transitionDuration), '0s');
    }
  }
  assert.deepEqual(errors, []);
  assert.equal(requests.some(url => /\.(mp4|gif|jpe?g)|feature-.*\.png/.test(url)), false);
  console.log('Site checks passed: automatic complete workflow and feature loops; no controls or inner scrollbars; native desktop proportions at 320/390/768/1440px; all language URLs and SEO; reduced motion; no-JS; assets; saved language; download and card layouts.');
} finally {
  await browser.close();
  await server.close();
}
