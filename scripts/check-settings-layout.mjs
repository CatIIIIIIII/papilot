import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from '../engine/node_modules/@playwright/test/index.mjs';

// Long translations and user-provided text must fit the content area, even
// when an outer dialog clips overflow instead of exposing a page scrollbar.
const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const origin = `http://127.0.0.1:${server.server.address().port}`;
const languages = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es', 'pt', 'it', 'sv'];
const runtime = { connected: true, authenticated: true, account: 'researcher.with.a.long.account.name@example-university.edu', error: null,
  models: [{ id: 'model', name: 'Research model with extended context and high reasoning', isDefault: true, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' }] };
const state = { version: '0.9.4-dev.' + 'a'.repeat(40), csrf: 'fixture', projects: [], tasks: [], requests: [], runtime };
const update = { currentVersion: state.version, latestVersion: '0.9.4-dev.' + 'b'.repeat(40), phase: 'failed', checkedAt: 1, canUpdate: true, channel: 'dev',
  error: 'Could not access C:\\Users\\Researcher\\AppData\\Local\\Papilot\\updates\\releases\\papilot-development-build-with-a-long-directory-name\\package.json' };
const errors = [];
let cases = 0;
fs.mkdirSync('test-results', { recursive: true });
try {
  for (const language of languages) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'en-US' });
    await context.addInitScript(language => {
      localStorage.setItem('papilot:language', language);
      localStorage.setItem('papilot:setup-seen', '1');
    }, language);
    await context.route('**/api/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/state') return route.fulfill({ json: state });
      if (pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
      if (pathname === '/api/runtime/requirements') return route.fulfill({ json: { platform: 'win32', checks: ['git', 'latexmk', 'synctex', 'tex-engine'].map(id => ({ id, ok: false })) } });
      if (pathname === '/api/runtime/latex') return route.fulfill({ json: { distribution: 'MiKTeX', version: '26.10', path: 'C:\\Users\\Researcher.with.a.very.long.university.username\\AppData\\Local\\Programs\\MiKTeX\\miktex\\bin\\x64' } });
      if (pathname === '/api/diagnostics') return route.fulfill({ json: { version: '0.9.4', checkedAt: 1, platform: 'win32', arch: 'x64', node: '24.22.2', ok: true, checks: [] } });
      if (pathname.startsWith('/api/updates')) return route.fulfill({ json: update });
      if (pathname === '/api/quick-notes') return route.fulfill({ json: { quickNotes: [
        { id: 'custom-reference', label: 'Literaturverzeichnis', instruction: 'Check the bibliography against the cited source.', icon: 'book' }, { id: 'polish' },
      ] } });
      if (pathname.endsWith('/skills')) return route.fulfill({ json: { skills: [] } });
      return route.fulfill({ json: {} });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.locator('.settings-link').click();
    await page.locator('.settings-dialog').waitFor();
    const pages = await page.locator('[data-settings-page]').evaluateAll(elements => elements.map(element => element.dataset.settingsPage));
    for (const width of [320, 390, 768, 900, 1280]) {
      await page.setViewportSize({ width, height: width < 500 ? 640 : 620 });
      for (const name of pages) {
        const category = page.locator(`[data-settings-page="${name}"]`);
        if (width <= 680 && name === 'shortcuts') {
          if (!await page.locator('.settings-sidebar').isVisible()) await page.locator('.settings-mobile-back').click();
          await expect(category).toBeHidden();
          continue;
        }
        if (!await category.isVisible()) await page.locator('.settings-mobile-back').click();
        await category.click();
        if (name === 'latex') await page.locator('.latex-installation-facts').waitFor();
        if (name === 'updates') await page.locator('.settings-content-updates [role=alert]').waitFor();
        if (name === 'skills') await expect(page.locator('.skill-library-new')).toBeEnabled();
        if (name === 'quickNotes') await page.locator('.quick-note-text strong').getByText('Literaturverzeichnis', { exact: true }).waitFor();
        await page.evaluate(() => document.fonts.ready);
        const content = page.locator('.settings-content');
        const overflow = await content.evaluate(root => {
          const issues = [root, ...root.querySelectorAll('*')].filter(element => {
            const box = element.getBoundingClientRect(), style = getComputedStyle(element);
            if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'inline' || style.overflowX !== 'visible' || element.scrollWidth <= element.clientWidth + 2) return false;
            // About-page hover backgrounds extend into the card's padding.
            if (element.matches('.settings-resource, .settings-project-license, .settings-project-license>summary') && element.scrollWidth <= element.clientWidth + 10) return false;
            return true;
          }).map(element => ({ element: element.className || element.tagName, text: element.textContent.slice(0, 100), width: element.clientWidth, scroll: element.scrollWidth }));
          if (root.scrollWidth > root.clientWidth + 2) issues.push({ element: 'settings-content', width: root.clientWidth, scroll: root.scrollWidth });
          return issues;
        });
        const label = `${language}/${width}/${name}`;
        if (overflow.length) await page.screenshot({ path: `test-results/settings-overflow-${language}-${width}-${name}.png` });
        assert.deepEqual(overflow, [], label);
        if (name === 'review') {
          const alternatives = page.locator('.settings-note-options');
          await expect(alternatives.getByRole('slider', { name: await alternatives.locator('label').innerText(), exact: true })).toHaveCount(1);
          const labels = await alternatives.locator('.note-count-scale span').evaluateAll(elements => elements.map(element => {
            const bounds = element.getBoundingClientRect();
            return { text: element.textContent, left: bounds.left, right: bounds.right };
          }));
          for (let index = 1; index < labels.length; index++) {
            assert.ok(labels[index].left >= labels[index - 1].right + 1,
              `${label}: alternative labels ${labels[index - 1].text} and ${labels[index].text} stay separated`);
          }
        }
        if (name === 'skills') {
          assert.ok((await page.locator('.skill-library-search input').boundingBox()).width >= 100, `${label}: search keeps enough room to type`);
          await expect(page.locator('.skill-library-new')).toBeInViewport();
        }
        if (width === 320 && ['de', 'fr', 'ja', 'pt'].includes(language)) {
          const detail = name === 'quickNotes' ? '.quick-note-row' : name === 'appearance' ? '.appearance-colors-card' : name === 'notifications' ? '.settings-notification-event' : null;
          if (detail) await page.locator(detail).first().scrollIntoViewIfNeeded();
          await page.screenshot({ animations: 'disabled', path: `test-results/settings-layout-${language}-${name}.png` });
        }
        cases++;
      }
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(`Settings layout passed: ${cases} page/viewport/language combinations, long names, paths, statuses, and usable skill search.`);
} finally { await browser.close(); await server.close(); }
