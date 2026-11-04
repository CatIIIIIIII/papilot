// Verify the landing page's windows and layout, using an isolated static server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, webkit } from '../engine/node_modules/playwright/index.mjs';
import { checkAnnotations } from './site-annotation-checks.mjs';
import { checkSiteTheme } from './site-theme-checks.mjs';

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
const watch = page => {
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  page.on('request', request => requests.push(request.url()));
  page.setDefaultTimeout(20000);
};
const hero = '.hero .app-window', change = `${hero} .review-change`;
const stateOf = page => page.locator(change).getAttribute('data-state');
try {
  await checkSiteTheme(browser, origin, watch);
  await checkAnnotations(browser, origin);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
  const page = await context.newPage();
  await page.bringToFront();
  await page.mouse.move(0, 0);
  watch(page);
  await page.goto(`${origin}/?lang=en`);
  await page.evaluate(() => document.fonts.ready);

  // The first screen is the headline, the window and the downloads; the
  // arrow sits on it and the agents start just below.
  const fold = await page.evaluate(() => ({
    cue: document.querySelector('.scroll-cue').getBoundingClientRect().bottom,
    agents: document.querySelector('#agents').getBoundingClientRect().top,
    inner: innerHeight,
  }));
  assert.ok(fold.cue <= fold.inner && fold.agents >= fold.inner - 1, 'the first screen holds the hero');
  assert.equal(await page.locator('video').count(), 0);

  // The navbar leads to this page's own sections.
  const anchors = await page.locator('.nav a').evaluateAll(links => links.map(link => link.getAttribute('href')));
  assert.ok(anchors.length >= 3 && anchors.every(href => href.startsWith('#')));
  for (const href of anchors) assert.equal(await page.locator(href).count(), 1, href);

  // A round plays by itself: the plain sentence, a boxed note, the diff, and
  // the accepted sentence, without the headline or the window moving.
  assert.equal(await stateOf(page), 'idle');
  const still = async () => page.evaluate(sel => [document.querySelector('h1').getBoundingClientRect().top, document.querySelector(sel).getBoundingClientRect().height], hero);
  const start = await still();
  await page.waitForFunction(sel => document.querySelector(sel).dataset.state === 'pending', change);
  assert.deepEqual(await still(), start);
  assert.equal(await page.locator(`${hero} .chat-bubble`).isVisible(), true);
  await page.locator(hero).screenshot({ path: 'test-results/site/hero-diff.png' });
  await page.waitForFunction(sel => document.querySelector(sel).dataset.state === 'accepted', change);
  await page.waitForTimeout(700);
  assert.deepEqual(await still(), start);
  assert.equal(await page.locator(`${change} .review-head`).isVisible(), false, 'a decided change has no header');
  await page.locator(hero).screenshot({ path: 'test-results/site/hero-accepted.png' });

  // Touching the window stops the round on the diff; decisions leave plain
  // text that reopens on a click, and LaTeX shows the source.
  await page.reload();
  await page.locator(change).click();
  assert.equal(await page.locator(hero).evaluate(el => el.classList.contains('playing')), false);
  assert.equal(await stateOf(page), 'pending');
  await page.locator(`${change} .review-accept`).click();
  await page.locator(`${change} .before`).waitFor({ state: 'hidden' });
  await page.locator(`${change} .review-head`).waitFor({ state: 'hidden' });
  await page.locator(change).click();
  await page.locator(`${change} .review-reject`).click();
  await page.locator(`${change} .after`).waitFor({ state: 'hidden' });
  await page.locator(change).click();
  assert.equal(await stateOf(page), 'pending');
  await page.locator(`${change} .review-latex`).click();
  assert.equal(await page.locator(`${change} .review-source`).isVisible(), true);

  // Every agent shows at once; on screen they arrive, then one at a time lights up.
  const grid = page.locator('.agent-grid');
  assert.equal(await grid.locator('li').count(), 11);
  await grid.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('.agent-grid.arrived'));
  const view = await page.evaluate(() => innerHeight);
  for (const box of await grid.locator('li').evaluateAll(items => items.map(item => item.getBoundingClientRect().toJSON()))) assert.ok(box.top > 0 && box.bottom < view, 'every agent is in view at once');

  // The older ways keep their colour while they are read, lose it as they
  // scroll past, and Papilot's comes in on the same scroll.
  const progress = () => page.evaluate(() => [...document.querySelectorAll('.era')].map(card => +(card.style.getPropertyValue(card.classList.contains('ours') ? '--new' : '--old') || 0)));
  const scrollEras = fraction => page.evaluate(f => scrollTo(0, document.querySelector('.era.old').getBoundingClientRect().top + scrollY - innerHeight * f), fraction);
  await scrollEras(.3);
  await page.waitForTimeout(300);
  assert.deepEqual(await progress(), [0, 0, 0], 'colour while the older ways are read');
  await scrollEras(-.25);
  await page.waitForTimeout(300);
  const [first, second, ours] = await progress();
  assert.ok(first > .9 && second > .9 && ours > .9, 'grey once scrolled past, with Papilot\'s in view');

  // The feature windows are pictures: named, with nothing to focus inside,
  // and each plays its round once on screen, at a fixed height.
  const scenes = page.locator('.scene');
  assert.equal(await scenes.count(), 3);
  assert.equal(await page.locator('.scene-art :is(a, button, input, textarea, [tabindex])').evaluateAll(nodes => nodes.filter(node => !node.closest('[inert]')).length), 0);
  for (const name of ['notes', 'revise', 'record']) {
    const scene = page.locator(`[data-scene=${name}]`);
    assert.equal(await scene.getAttribute('role'), 'img');
    assert.ok(await scene.getAttribute('aria-label'));
    await scene.scrollIntoViewIfNeeded();
    await page.mouse.move(1, 1);
    const height = (await scene.boundingBox()).height;
    await page.waitForFunction(sel => document.querySelector(sel).classList.contains('playing'), `[data-scene=${name}]`);
    await page.waitForTimeout(5000);
    assert.equal((await scene.boundingBox()).height, height, `${name} keeps its height`);
    assert.equal(await scene.locator('.app-cursor').isVisible(), true, `${name} plays`);
    await scene.screenshot({ path: `test-results/site/${name}-desktop.png` });
  }

  // Reduced motion: nothing plays; the hero shows the sent note and the
  // diff, and the ticker stands still.
  const calm = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const calmPage = await calm.newPage();
  watch(calmPage);
  await calmPage.goto(origin + '/');
  await calmPage.waitForTimeout(3000);
  assert.equal(await calmPage.locator('.playing').count(), 0);
  assert.equal(await stateOf(calmPage), 'pending');
  assert.equal(await calmPage.locator('.agent-grid.waiting').count(), 0, 'the agents stand in colour');
  assert.equal(await calmPage.locator('.era.old').evaluateAll(cards => cards.every(card => card.style.getPropertyValue('--old') === '1')), true, 'the older ways are simply grey');
  await calmPage.locator(`${change} .review-accept`).click();
  assert.equal(await calmPage.locator(`${change} .before`).isVisible(), false, 'decisions are immediate');
  await calm.close();

  // Without JavaScript every window shows where its round ends.
  const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1440, height: 900 } });
  const staticPage = await noJs.newPage();
  await staticPage.goto(origin);
  for (const selector of [`${change} .before`, `${change} .after`, `${hero} .chat-bubble`, '[data-scene=record] .git-pushed']) assert.equal(await staticPage.locator(selector).isVisible(), true, selector);
  await staticPage.locator(hero).screenshot({ path: 'test-results/site/no-js.png' });
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
    assert.deepEqual(await staticVisitor.locator('main [lang]').evaluateAll(nodes => [...new Set(nodes.map(node => node.lang))]), [locale]);
    assert.equal(await staticVisitor.locator('.no-js-languages a').count(), Object.keys(languages).length);
  }
  await staticContext.close();

  // The language menu switches pages; browser language never redirects, a
  // saved choice does at the root, and an explicit URL wins.
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

  // Both download menus open on their own, end with All downloads, stay
  // inside the window (opening upward without room below) and close with Escape.
  for (const [width, height] of [[1440, 900], [1280, 760], [390, 664]]) {
    await page.setViewportSize({ width, height });
    await page.goto(origin + '/');
    for (const [button, list] of [['#download-button', '#download-list'], ['#get-button', '#get-list']]) {
      await page.locator(button).scrollIntoViewIfNeeded();
      await page.locator(button).click();
      assert.equal(await page.locator('.download-list:visible').count(), 1, `${list} opens alone`);
      const box = await page.locator(list).boundingBox();
      assert.ok(box.y >= 0 && box.y + box.height <= height, `${list} inside the window at ${width}×${height}`);
      assert.equal(await page.locator(`${list} [role=menuitem]`).last().getAttribute('href'), 'https://github.com/PapilotAI/papilot/releases/latest');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator(list).isHidden(), true, `${list} closes`);
    }
  }

  // Every language fits at every width: no sideways scroll, the first screen
  // still holds the hero, and buttons, menus, cards and windows fit.
  for (const width of [1440, 961, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
    for (const locale of Object.keys(languages)) {
      await page.goto(origin + route(locale));
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${locale}/${width}: no sideways scroll`);
      await page.locator('#download-button').click();
      for (const selector of ['#download-button', '#download-list', '.era', '.app-window']) {
        const boxes = await page.locator(selector).evaluateAll(nodes => nodes.map(el => ({ width: el.clientWidth, scroll: el.scrollWidth, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right })));
        for (const box of boxes) {
          assert.ok(box.scroll <= box.width + 1, `${locale}/${width}: ${selector} contents fit`);
          assert.ok(box.left >= 0 && box.right <= width + 1, `${locale}/${width}: ${selector} within viewport`);
        }
      }
      await page.keyboard.press('Escape');
      const panels = await page.locator('.scene').evaluateAll(apps => apps.map(app => {
        const pdf = app.querySelector('.app-pdf').getBoundingClientRect();
        const target = app.querySelector(app.dataset.scene === 'notes' ? '.scene-figure' : app.dataset.scene === 'revise' ? '.review-change' : '.scene-text').getBoundingClientRect();
        return { scene: app.dataset.scene, bottom: target.bottom - pdf.top, height: pdf.height };
      }));
      for (const panel of panels) assert.ok(panel.bottom <= panel.height - 6, `${locale}/${width}: ${panel.scene} content stays inside its PDF pane`);
      if (width === 390 || width === 1440) {
        await page.screenshot({ path: `test-results/site/${locale}-${width}-hero.png` });
        await page.locator('#why').screenshot({ style: '.topbar{visibility:hidden!important}', path: `test-results/site/${locale}-${width}-why.png` });
      }
    }
  }
  assert.deepEqual(errors, []);
  assert.equal(requests.some(url => /\.(mp4|gif|jpe?g)|feature-.*\.png/.test(url)), false);
  console.log('Site checks passed: annotations during scroll and resize, first screen, the hero round and takeover, feature windows, reduced motion, no-JS, all language URLs and SEO, saved language, both download menus, and layouts at 320/390/768/961/1440px.');
} finally {
  await browser.close();
  await server.close();
}
