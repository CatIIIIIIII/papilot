import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium } from '../engine/node_modules/playwright/index.mjs';
import { blogLocales, blogOgLocales, blogRoute, loadBlogPosts } from './site-blog.mjs';

const posts = loadBlogPosts(process.cwd());
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-blog-check-'));
try {
  const folder = path.join(temp, 'site/blog/posts/example');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'post.json'), JSON.stringify({ draft: true }));
  assert.deepEqual(loadBlogPosts(temp), [], 'drafts are excluded from every generated listing');
  fs.writeFileSync(path.join(folder, 'post.json'), JSON.stringify({ published: '2026-02-30' }));
  assert.throws(() => loadBlogPosts(temp), /Invalid blog date/);
  fs.writeFileSync(path.join(folder, 'post.json'), JSON.stringify({ published: '2026-01-01', locales: { xx: {} } }));
  assert.throws(() => loadBlogPosts(temp), /Unsupported blog locale/);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }

const server = Fastify();
await server.register(staticFiles, { root: path.resolve('_site') });
await server.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const errors = [];
fs.mkdirSync('test-results/blog', { recursive: true });
const context = await browser.newContext({ javaScriptEnabled: false, colorScheme: 'light', reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
const loadIllustrations = async target => {
  await target.locator('.blog-figure img').evaluateAll(images => images.forEach(image => { image.loading = 'eager'; }));
  // Poll from Node: callbacks in a no-JS page may stop after responsive image selection.
  const deadline = Date.now() + 10000;
  let pending;
  do {
    pending = await target.locator('.blog-figure img').evaluateAll(images => images.filter(image => getComputedStyle(image.closest('picture')).display !== 'none').map(image => {
      const source = [...image.parentElement.querySelectorAll('source')].find(source => matchMedia(source.media).matches);
      return { current: image.currentSrc, expected: new URL(source?.srcset || image.getAttribute('src'), location.href).href, complete: image.complete, width: image.naturalWidth };
    }).filter(image => !image.complete || !image.width || image.current !== image.expected));
    if (!pending.length) break;
    await delay(50);
  } while (Date.now() < deadline);
  assert.deepEqual(pending, [], `Images not ready on ${target.url()}`);
  await target.locator('.blog-figure img').evaluateAll(images => Promise.all(images.filter(image => getComputedStyle(image.closest('picture')).display !== 'none').map(image => image.decode())));
};
try {
  const sitemap = fs.readFileSync('_site/sitemap.xml', 'utf8');
  for (const locale of blogLocales) {
    const ui = JSON.parse(fs.readFileSync(`site/blog/locales/${locale}.json`, 'utf8')).ui;
    await page.goto(origin + blogRoute(locale));
    assert.equal(await page.locator('html').getAttribute('lang'), locale);
    assert.equal(await page.title(), ui.indexSeoTitle);
    assert.equal(await page.locator('h1').innerText(), ui.indexTitle);
    assert.equal(await page.locator('.blog-card-image').count(), posts.filter(post => post.locales[locale]).length);
    assert.equal(await page.locator('meta[name=description]').getAttribute('content'), ui.indexSeoDescription);
    for (const width of [320,390,768,1440]) {
      await page.setViewportSize({width,height:1000});
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `index fits at ${width}px (${locale})`);
    }
    await page.locator('.blog-languages summary').click();
    assert.equal(await page.locator('.blog-language:visible').count(), blogLocales.length);
    await page.locator('.blog-languages summary').click();
    assert.equal(await page.locator('.blog-card').count(), posts.filter(post => post.locales[locale]).length);
    assert.equal(await page.locator('.blog-theme').isVisible(), false, 'no dead theme button without JS');
    assert.ok(sitemap.includes(`<loc>https://papilot.ai${blogRoute(locale)}</loc>`));
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `test-results/blog/index-${locale}.png`, fullPage: true });
    const feed = await (await fetch(origin + blogRoute(locale) + 'feed.xml')).text();
    const feedState = await page.evaluate(xml => {
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      return { error: !!doc.querySelector('parsererror'), links: [...doc.querySelectorAll('item link')].map(node => node.textContent), dates: [...doc.querySelectorAll('pubDate')].map(node => node.textContent) };
    }, feed);
    assert.equal(feedState.error, false, 'RSS must be well-formed XML');
    for (const post of posts.filter(post => post.locales[locale])) {
      const route = blogRoute(locale, post.slug), canonical = 'https://papilot.ai' + route;
      assert.ok(feedState.links.includes(canonical));
      assert.ok(sitemap.includes(`<loc>${canonical}</loc>`));
      await page.goto(origin + route);
      assert.equal(await page.locator('h1').count(), 1);
      assert.equal(await page.locator('h1').innerText(), post.locales[locale].title);
      assert.equal(await page.locator('link[rel=canonical]').getAttribute('href'), canonical);
      assert.equal(await page.locator('meta[property="og:url"]').getAttribute('content'), canonical);
      assert.equal(await page.locator('meta[name=description]').getAttribute('content'), post.locales[locale].description);
      assert.equal(await page.locator('meta[property="og:locale"]').getAttribute('content'), blogOgLocales[locale]);
      assert.equal(await page.locator('meta[property="og:locale:alternate"]').count(), Object.keys(post.locales).length - 1);
      assert.equal(await page.locator('meta[property="og:image:alt"]').getAttribute('content'), post.locales[locale].heroAlt);
      assert.ok(Number(await page.locator('meta[property="og:image:width"]').getAttribute('content')) > 0);
      const defaultLocale = post.locales.en ? 'en' : Object.keys(post.locales)[0];
      assert.equal(await page.locator('link[hreflang=x-default]').getAttribute('href'), 'https://papilot.ai' + blogRoute(defaultLocale, post.slug));
      assert.deepEqual(await page.locator('[id]').evaluateAll(nodes => nodes.map(node => node.id).filter((id,index,ids) => ids.indexOf(id)!==index)), [], 'no duplicate diagram or heading IDs');
      assert.ok(await page.locator('.blog-prose > *').count() > 0, 'article content is rendered without JavaScript');
      for (const code of Object.keys(post.locales)) assert.equal(await page.locator(`link[hreflang="${code}"]`).getAttribute('href'), 'https://papilot.ai' + blogRoute(code, post.slug));
      const structured = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent());
      const article = structured['@graph'].find(item => item['@type'] === 'BlogPosting');
      assert.equal(article.mainEntityOfPage, canonical);
      assert.equal(article.headline, await page.locator('h1').innerText());
      assert.equal(article.inLanguage, locale);
      assert.equal(article.datePublished, await page.locator('meta[property="article:published_time"]').getAttribute('content'));
      const modified = page.locator('meta[property="article:modified_time"]');
      if (post.updated) {
        assert.equal(article.dateModified, post.updated + 'T00:00:00+08:00');
        assert.equal(await modified.getAttribute('content'), article.dateModified);
      } else {
        assert.equal(article.dateModified, undefined);
        assert.equal(await modified.count(), 0);
      }
      assert.equal(article.isPartOf['@id'], 'https://papilot.ai' + blogRoute(locale) + '#blog');
      assert.equal(await page.locator('.blog-meta time').getAttribute('datetime'), post.published);
      const sitemapDoc = await page.evaluate(xml => { const doc = new DOMParser().parseFromString(xml,'application/xml'); return {error:!!doc.querySelector('parsererror'),urls:[...doc.querySelectorAll('url')].map(node=>({loc:node.querySelector('loc').textContent,alternates:[...node.getElementsByTagNameNS('http://www.w3.org/1999/xhtml','link')].map(link=>({locale:link.getAttribute('hreflang'),url:link.getAttribute('href')}))}))};}, sitemap);
      assert.equal(sitemapDoc.error,false);
      assert.equal(sitemapDoc.urls.find(item=>item.loc===canonical).alternates.length,Object.keys(post.locales).length+1);
      assert.ok(feedState.dates.includes(new Date(article.datePublished).toUTCString()));
      assert.deepEqual(await page.locator('.blog-toc a[href^="#"]').evaluateAll(links => links.filter(link => !document.getElementById(decodeURIComponent(link.hash.slice(1)))).map(link => link.hash)), []);
      for (const width of [1440, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(() => document.fonts.ready);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no page overflow at ${width}px (${locale})`);
        assert.ok(await page.locator('.blog-hero .blog-figure').isVisible());
        for (const diagram of await page.locator('.blog-illustration-responsive').all()) {
          assert.equal(await diagram.locator('.blog-art-compact').isVisible(), width <= 600);
          assert.equal(await diagram.locator('.blog-art-wide').isVisible(), width > 600);
        }
        assert.deepEqual(await page.locator('.blog-illustration svg:visible').evaluateAll(figures => figures.flatMap(svg => {
          const box = svg.getBoundingClientRect();
          return [...svg.querySelectorAll('text')].filter(text => {
            const bounds = text.getBoundingClientRect();
            return bounds.left < box.left - 1 || bounds.right > box.right + 1 || bounds.top < box.top - 1 || bounds.bottom > box.bottom + 1;
          }).map(text => text.textContent);
        })), [], `diagram labels fit at ${width}px (${locale})`);
        assert.deepEqual(await page.locator('.blog-illustration svg').evaluateAll(figures => figures.flatMap(svg => (svg.getAttribute('aria-labelledby') || '').split(/\s+/).filter(id => id && !svg.querySelector(`[id="${id}"]`)))), [], 'inline figures retain accessible titles and descriptions');
        if (width === 1440 || width === 390) {
          // Load responsive images and bring them into view before capture.
          await loadIllustrations(page);
          for (const figure of await page.locator('.blog-figure').all()) await figure.scrollIntoViewIfNeeded();
          const bodyPicture = page.locator('.blog-prose .blog-figure:has(picture)').last();
          if (width === 390 && await bodyPicture.count()) await bodyPicture.screenshot({ path: `test-results/blog/notes-${post.slug}-${locale}-mobile.png` });
          await page.evaluate(() => scrollTo(0, 0));
          await page.screenshot({ path: `test-results/blog/article-${post.slug}-${locale}-${width}.png`, fullPage: true });
          if (width === 390) await page.screenshot({ path: `test-results/blog/article-${post.slug}-${locale}-mobile-viewport.png` });
        }
      }
      assert.deepEqual(await page.locator('.blog-figure img').evaluateAll(images => images.filter(image => getComputedStyle(image.closest('picture')).display !== 'none' && (!image.complete || !image.naturalWidth || !image.alt)).map(image => image.src)), []);
      const other = Object.keys(post.locales).find(code => code !== locale);
      if (other) {
        await page.locator('.blog-languages summary').click();
        await page.locator(`.blog-language[hreflang="${other}"]`).click();
        assert.equal(new URL(page.url()).pathname, blogRoute(other, post.slug));
        assert.equal(await page.locator('h1').innerText(), post.locales[other].title);
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    console.log(`PASS: ${locale} article/index, metadata, feeds, language links and responsive diagrams.`);
  }
  const interactive = await browser.newContext({ colorScheme: 'light', reducedMotion: 'reduce', viewport: { width: 390, height: 844 } });
  const theme = await interactive.newPage();
  theme.on('pageerror', error => errors.push(error.message));
  const themePost = posts.find(post => Object.keys(post.locales).length > 1) || posts[0];
  const themeLocale = themePost ? Object.keys(themePost.locales)[0] : 'en';
  await theme.goto(origin + blogRoute(themeLocale, themePost?.slug));
  await theme.locator('.blog-theme').click();
  assert.equal(await theme.locator('html').getAttribute('data-theme'), 'dark');
  for (const picture of await theme.locator('.blog-image-dark').all()) assert.equal(await picture.isVisible(), true);
  for (const picture of await theme.locator('.blog-image-light').all()) assert.equal(await picture.isVisible(), false);
  await theme.reload();
  assert.equal(await theme.locator('.blog-theme').getAttribute('aria-pressed'), 'true');
  await loadIllustrations(theme);
  await theme.screenshot({ path: 'test-results/blog/article-dark-mobile.png', fullPage: true });
  const otherLocale = (themePost ? Object.keys(themePost.locales) : blogLocales).find(code => code !== themeLocale);
  if (otherLocale) {
    await theme.locator('.blog-languages summary').click();
    await theme.locator(`.blog-language[hreflang="${otherLocale}"]`).click();
    assert.equal(await theme.locator('html').getAttribute('data-theme'), 'dark', 'theme persists across languages');
  }
  await theme.locator('.blog-theme').click();
  assert.equal(await theme.locator('html').getAttribute('data-theme'), 'light');
  await interactive.close();
  assert.deepEqual(errors, []);
  console.log('PASS: static multilingual blog, full no-JS content, canonical/hreflang/structured data, valid RSS, sitemap entries, image loading, language switching, dark mode, and 320/390/768/1440px layouts.');
} finally { await browser.close(); await server.close(); }
