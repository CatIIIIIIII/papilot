// Verify the passive desktop-size UI films, using an isolated static server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, webkit } from '../vendor/latex-review/node_modules/playwright/index.mjs';

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
    for (const lang of ['EN', '中文']) {
      await page.locator('#lang-button').click();
      await page.getByRole('menuitemradio', { name: lang === 'EN' ? 'English' : '简体中文', exact: true }).click();
      assert.equal(await page.evaluate(() => document.documentElement.lang), lang === 'EN' ? 'en' : 'zh-CN');
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
      if (width === 390) await hero.screenshot({ animations: 'disabled', path: `test-results/site/hero-mobile-${lang === 'EN' ? 'en' : 'zh'}.png` });
      if (width === 390) await page.locator('#demo-commit').screenshot({ animations: 'disabled', path: `test-results/site/commit-mobile-${lang === 'EN' ? 'en' : 'zh'}.png` });
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
  // The browser's first supported language is shown; a saved choice wins.
  for (const [locale, expected] of [['zh-CN', 'zh-CN'], ['zh-SG', 'zh-CN'], ['zh-TW', 'en'], ['fr-FR', 'en'], ['en-GB', 'en']]) {
    const context = await browser.newContext({ locale });
    const visitor = await context.newPage();
    await visitor.goto(origin);
    assert.equal(await visitor.evaluate(() => document.documentElement.lang), expected, locale);
    if (locale === 'zh-CN') {
      await visitor.locator('#lang-button').click();
      await visitor.getByRole('menuitemradio', { name: 'English', exact: true }).click();
      await visitor.reload();
      assert.equal(await visitor.evaluate(() => document.documentElement.lang), 'en', 'a saved choice wins');
      await visitor.locator('#lang-button').click();
      await visitor.keyboard.press('Escape');
      assert.equal(await visitor.locator('#lang-list').isHidden(), true);
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.equal(requests.some(url => /\.(mp4|gif|jpe?g)|feature-.*\.png/.test(url)), false);
  console.log('Site checks passed: automatic complete workflow and feature loops; no controls or inner scrollbars; native desktop proportions at 320/390/768/1440px; EN/中文; reduced motion; no-JS; assets; language from the browser and the menu.');
} finally {
  await browser.close();
  await server.close();
}
