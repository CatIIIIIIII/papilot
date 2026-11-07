import { readyRequirements } from './required-tools-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from '../engine/node_modules/@playwright/test/index.mjs';
import { annotateReviewState, rewriteReviewHtml } from '../src/server/review.ts';

fs.mkdirSync('test-results', { recursive: true });
const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 1100 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const prefix = '/review/paper', reviewDist = path.resolve('engine/dist/web');
const task = { id: 'appearance-task', projectId: 'paper', name: 'colors', title: 'Clarify the experimental results', status: 'reviewing', createdAt: 1, updatedAt: 1, review: { state: 'reviewing', round: 1, counts: { pending: 3 }, unsent: 0 } };
let decisions = { first: 'pending', second: 'pending', third: 'pending' };
const snapshot = { version: 'test', csrf: 'fixture', projects: [{ id: 'paper', name: 'Example paper', path: '/tmp/paper' }], tasks: [task], requests: [], runtime: { connected: true, authenticated: true, models: [] } };
const image = name => ({ src: name + '.svg', clean: name + '.svg', width: 600, height: 110, page: 1, label: '1' });
const block = (...units) => ({ kind: 'change', units, identical: false, before: [image('before')], after: [image('after')] });
const detail = { task: 'colors', round: 1, before: 'before', after: 'after', warnings: [], files: prefix + '/files/',
  sections: [{ node: 'results', title: 'Results', number: '4', blocks: [block('first', 'second')] }], loose: [block('third')],
  units: ['first', 'second', 'third'].map((id, i) => ({ id, file: 'main.tex', status: 'modified', kind: 'text', whole_file: false, ops: [], old_start: i + 1, old_end: i + 1, new_start: i + 1, new_end: i + 1, old_text: 'Results improve.', new_text: 'The results improve across all evaluated settings.', truncated: false })) };
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url()), json = data => route.fulfill({ json: data });
  if (url.pathname === '/api/runtime/requirements') return route.fulfill({ json: readyRequirements });
  if (url.pathname === '/api/state') return json(snapshot);
  if (url.pathname === '/api/indirect-changes') return json({ indirectChanges: false });
  if (url.pathname === '/api/updates') return json({ currentVersion: 'test', phase: 'idle', canUpdate: false });
  if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
  if (url.pathname.endsWith('/items')) return json({ items: [] });
  if (url.pathname.endsWith('/note-results')) return json({ notes: [] });
  if (url.pathname.endsWith('/skills')) return json({ skills: [] });
  if (url.pathname.endsWith('/git')) return json({ files: [], branch: 'main', ahead: 0, behind: 0 });
  if (url.pathname.endsWith('/manuscript')) return json({ git: { files: [] }, annotations: [], build: { status: 'building', current: false } });
  throw Error(`Unexpected app request ${url.pathname}`);
});
await page.route('**/review/**', async route => {
  const relative = new URL(route.request().url()).pathname.slice(prefix.length);
  if (relative === '/') return route.fulfill({ contentType: 'text/html', body: rewriteReviewHtml(fs.readFileSync(path.join(reviewDist, 'index.html'), 'utf8'), prefix) });
  if (relative.startsWith('/assets/')) return route.fulfill({ path: path.join(reviewDist, relative), contentType: /\.m?js$/.test(relative) ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : 'font/otf' });
  if (relative.startsWith('/files/')) return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 110"><rect width="600" height="110" fill="white"/><text x="40" y="60" font-size="21">${relative.includes('after') ? 'Results improve across all evaluated settings.' : 'Results improve.'}</text></svg>` });
  if (/\/rounds\/\d+$/.test(relative)) return route.fulfill({ json: detail });
  return route.fulfill({ json: annotateReviewState({ task: 'colors', title: task.title, csrf: 'fixture', closed: false, state: 'reviewing', latest: 1, history: [{ number: 1, created: 1 }], round: 1, revision: 'after', decisions, comments: {}, undo: null, job: null }, [task]) });
});
try {
  await page.goto(`http://127.0.0.1:${server.server.address().port}`);
  const frame = page.frameLocator('.review-frame');
  await expect(frame.getByText('Other changes', { exact: true })).toBeVisible();
  for (const theme of ['Dark', 'Light']) for (const pdf of ['light', 'theme']) for (const review of ['pdf', 'theme', 'light']) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.locator('.settings-dialog');
    await dialog.getByRole('button', { name: 'Appearance', exact: true }).click();
    await dialog.getByRole('radiogroup', { name: 'Mode', exact: true }).getByRole('radio', { name: theme, exact: true }).check();
    await dialog.getByRole('radiogroup', { name: 'PDF appearance', exact: true }).getByRole('radio', { name: pdf === 'theme' ? 'Auto' : 'Original', exact: true }).check();
    await dialog.getByRole('radiogroup', { name: 'Review appearance', exact: true }).getByRole('radio', { name: review === 'pdf' ? 'PDF' : review === 'theme' ? 'Auto' : 'Original', exact: true }).check();
    if (theme === 'Dark' && pdf === 'light' && review === 'pdf') await page.screenshot({ path: 'test-results/review-appearance-settings.png' });
    await page.keyboard.press('Escape');
    const darkPaper = theme === 'Dark' && pdf === 'theme';
    const darkReview = theme === 'Dark' && (review === 'theme' || (review === 'pdf' && pdf === 'theme'));
    // Review overrides must leave the manuscript PDF and application theme alone.
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.toLowerCase());
    assert.equal(await page.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--pdf-filter').trim()), darkPaper ? 'invert(.84) hue-rotate(180deg)' : 'none');
    await expect(frame.locator('html')).toHaveAttribute('data-review-theme', darkReview ? 'dark' : 'light');
    await expect(frame.locator('.sheet')).toHaveCSS('background-color', darkReview ? 'rgb(41, 41, 41)' : 'rgb(255, 255, 255)');
    for (const kind of ['inline', 'standalone']) {
      const change = frame.locator('.change.' + kind).first();
      await expect(change.locator('.side.before')).toHaveCSS('background-color', darkReview ? 'rgb(67, 44, 48)' : 'rgb(251, 238, 238)');
      await expect(change.locator('.side.after')).toHaveCSS('background-color', darkReview ? 'rgb(40, 57, 45)' : 'rgb(238, 248, 241)');
      await expect(change.locator('.pdf-strip img').first()).toHaveCSS('filter', darkReview ? 'invert(0.84) hue-rotate(180deg)' : 'none');
      const selected = /\bcurrent\b/.test(await change.getAttribute('class'));
      await expect(change.locator('.change-head')).toHaveCSS('background-color', darkReview ? (selected ? 'rgb(48, 49, 53)' : 'rgb(42, 43, 47)') : (selected ? 'rgb(244, 244, 244)' : 'rgb(250, 250, 250)'));
      const sourceToggle = change.getByRole('button', { name: /LaTeX$/ });
      await sourceToggle.click();
      await expect(change.locator('.source-code').first()).toHaveCSS('background-color', darkReview ? 'rgb(38, 39, 43)' : 'rgb(255, 255, 255)');
      await expect(change.locator('.source-code').first()).toHaveCSS('color', darkReview ? 'rgb(236, 236, 238)' : 'rgb(23, 23, 23)');
      // Grouped changes expose per-edit actions. Their hover background must
      // follow the review surface even when the surrounding workspace is dark.
      if (kind === 'inline') {
        for (const [action, light, dark] of [
          ['accept', 'rgb(21, 128, 61)', 'rgb(123, 213, 160)'],
          ['reject', 'rgb(220, 38, 38)', 'rgb(255, 150, 150)'],
          ['comment', 'rgb(37, 99, 235)', 'rgb(138, 180, 255)'],
        ]) {
          const button = change.locator('.unit-actions .' + action).first();
          await button.hover();
          await expect(button).toHaveCSS('background-color', darkReview ? 'rgb(30, 31, 34)' : 'rgb(243, 243, 243)');
          await expect(button).toHaveCSS('color', darkReview ? dark : light);
        }
      }
      await sourceToggle.click();
    }
    if (theme === 'Dark') await page.screenshot({ path: `test-results/review-appearance-pdf-${pdf}-review-${review}.png` });
  }
  // A decided change still needs its navigation and source controls to fit
  // inside a narrow desktop pane, without switching to a phone dock.
  decisions = { first: 'accepted', second: 'accepted', third: 'pending' };
  await page.reload();
  await expect(frame.locator('.change.current')).toBeVisible();
  await frame.getByRole('button', { name: 'History', exact: true }).click();
  await frame.locator('.change-map-mark').first().click();
  await expect(frame.getByRole('button', { name: 'Next undecided', exact: true })).toBeVisible();
  const checkWidths = async () => {
    for (const width of [320, 500, 700]) {
      await page.locator('.review-frame').evaluate((iframe, width) => { iframe.style.flex = 'none'; iframe.style.width = `${width}px`; }, width);
      await expect.poll(() => frame.locator('html').evaluate(() => window.innerWidth)).toBe(width);
      await expect.poll(() => frame.locator('.change.current .change-head').evaluate(head => {
        const bounds = head.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= window.innerWidth && bounds.height <= 40 && [...head.querySelectorAll('button')].every(button => {
          const box = button.getBoundingClientRect();
          return box.width >= 28 && box.height >= 28 && box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom;
        });
      })).toBe(true);
      await expect.poll(() => frame.locator('.change.current .change-number').evaluate(number => {
        const box = number.getBoundingClientRect();
        return box.width >= 14 && number.scrollWidth <= number.clientWidth;
      })).toBe(true);
      if (width === 320) await frame.locator('.change.current .change-head').screenshot({ path: 'test-results/review-toolbar-narrow.png' });
    }
  };
  await checkWidths();
  await frame.getByRole('button', { name: 'Next undecided', exact: true }).click();
  await expect(frame.locator('.change.current')).toHaveAttribute('data-stop', '1');
  await checkWidths();
  // Longer translations and multiple-digit change numbers must not steal
  // the pointer targets' space in a narrow desktop review pane.
  const ids = Array.from({ length: 12 }, (_, i) => `change-${i}`);
  decisions = Object.fromEntries(ids.map(id => [id, 'pending']));
  detail.units = ids.map((id, i) => ({ ...detail.units[0], id, old_start: i + 1, old_end: i + 1, new_start: i + 1, new_end: i + 1 }));
  detail.sections[0].blocks = ids.map(id => block(id)); detail.loose = [];
  for (const language of ['en', 'fr', 'de']) {
    await page.evaluate(language => localStorage.setItem('papilot:language', language), language);
    await page.reload();
    await frame.locator('.change-map-mark').nth(9).click();
    await expect(frame.locator('.change.current')).toHaveAttribute('data-stop', '9');
    await checkWidths();
  }
  await page.evaluate(() => localStorage.setItem('papilot:language', 'en'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('button', { name: /^Review(?:,|$)/ }).click();
  await expect(frame.locator('html')).toHaveAttribute('data-papilot-phone', '');
  await expect.poll(() => frame.locator('.change.current .dock').evaluate(dock => {
    const box = dock.getBoundingClientRect();
    return box.bottom <= innerHeight && box.bottom >= innerHeight - 16 && box.left >= 0 && box.right <= innerWidth;
  })).toBe(true);
  assert.deepEqual(errors, []);
  console.log('PASS: all 12 UI/PDF/review appearance combinations, inline and standalone changes, preview filters, controls, LaTeX colors, per-edit action hover states, pending/decided toolbars at 320/500/700 px, localized two-digit numbers, pointer target sizes, and phone dock positioning.');
} catch (error) {
  await page.screenshot({ path: 'test-results/review-appearance-failure.png' });
  throw error;
} finally { await browser.close(); await server.close(); }
