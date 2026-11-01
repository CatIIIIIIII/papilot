import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from '../vendor/latex-review/node_modules/@playwright/test/index.mjs';

const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ locale: 'en-US', colorScheme: 'light', viewport: { width: 1440, height: 900 } });
await page.clock.install();
await page.addInitScript(() => localStorage.setItem('papilot:task', ''));
const errors = []; page.on('pageerror', error => errors.push(error.message));
const task = { id: 'revision', projectId: 'paper', name: 'revision', title: 'Revise the introduction', status: 'reviewing', createdAt: 1, updatedAt: 1, review: { state: 'reviewing', round: 1, counts: { pending: 1 } } };
const snapshot = { version: 'test', csrf: 'fixture', projects: [{ id: 'paper', name: 'Paper', path: '/tmp/paper' }], tasks: [task], requests: [], runtime: { connected: true, authenticated: true, models: [] } };
const git = { branch: 'main', files: [] };
const build = { status: 'building', pages: [[612, 792], [612, 792]], current: false };
const annotations = [];
let posts = 0, reads = 0, releaseBuild, heldBuild, failRequest = false, holdRead = false, releaseRead;
function holdNextBuild() { heldBuild = new Promise(resolve => { releaseBuild = resolve; }); }
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url()), json = value => route.fulfill({ json: value });
  if (url.pathname === '/api/state') return json(snapshot);
  if (url.pathname === '/api/updates') return json({ phase: 'idle', currentVersion: 'test', latestVersion: 'test', canUpdate: false });
  if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
  if (url.pathname.endsWith('/skills')) return json({ skills: [] });
  if (url.pathname.endsWith('/items')) return json({ items: [] });
  if (url.pathname.endsWith('/note-results')) return json({ notes: [] });
  if (url.pathname.endsWith('/git')) return json(git);
  if (url.pathname.endsWith('/manuscript')) {
    if (route.request().method() === 'POST') {
      posts++;
      if (heldBuild) { const hold = heldBuild; heldBuild = null; await hold; }
      if (failRequest) return route.fulfill({ status: 503, json: { error: 'Host unavailable.' } });
      Object.assign(build, { status: 'building', current: false, error: undefined });
    } else {
      reads++;
      if (holdRead) {
        holdRead = false; const previous = structuredClone(build);
        await new Promise(resolve => { releaseRead = resolve; });
        return json({ git, build: previous, annotations });
      }
    }
    return json({ git, build, annotations });
  }
  if (url.pathname.endsWith('/manuscript.pdf')) return route.fulfill({ contentType: 'application/pdf', body: fs.readFileSync('tests/fixtures/outline.pdf') });
  if (url.pathname.endsWith('/manuscript/words')) return json(JSON.parse(fs.readFileSync('tests/fixtures/outline-words.json', 'utf8'))[Number(url.searchParams.get('page'))]);
  if (url.pathname.endsWith('/publish')) {
    posts++;
    if (heldBuild) { const hold = heldBuild; heldBuild = null; await hold; }
    task.status = 'building'; task.review.job = { status: 'running', phase: 'building' };
    return json(task);
  }
  throw new Error(`Unexpected fixture request: ${url.pathname}`);
});
await page.route('**/review/**', route => route.fulfill({ contentType: 'text/html', body: '<html><head></head><body><div class="bar">Review</div><main id="paper">PDF comparison</main></body></html>' }));
const compile = page.getByRole('button', { name: 'Recompile PDF', exact: true });
async function check(button, color, busy = false) {
  await expect(button).toHaveCSS('color', color);
  await expect(button).toHaveAttribute('aria-busy', String(busy));
  if (busy) {
    await expect(button).toBeDisabled();
    await expect(button.locator('.spinner')).toBeVisible();
    await expect(button.locator('svg')).toHaveCount(0);
  } else {
    await expect(button).toBeEnabled();
    await expect(button.locator('.spinner')).toHaveCount(0);
  }
  assert.equal(await button.innerText(), '', 'The toolbar remains icon-only');
}
const green = 'rgb(21, 128, 61)', blue = 'rgb(37, 99, 235)', red = 'rgb(220, 38, 38)';
try {
  fs.mkdirSync('test-results', { recursive: true });
  await page.goto(`http://127.0.0.1:${server.server.address().port}`);
  // The first build has no PDF yet. Its fallback toolbar must keep actions
  // together instead of distributing each icon across the whole empty row.
  const initialToolbar = page.locator('.manuscript-lead');
  for (const [width, colorScheme] of [[1440, 'light'], [1440, 'dark'], [1000, 'dark'], [768, 'dark'], [390, 'dark'], [320, 'dark']]) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme });
    if (width <= 680) await page.getByRole('group', { name: 'Manuscript view', exact: true }).getByRole('button', { name: 'PDF', exact: true }).click();
    await expect(initialToolbar).toBeVisible();
    await check(compile, colorScheme === 'dark' ? 'rgb(138, 180, 255)' : blue, true);
    const spacing = await initialToolbar.evaluate(toolbar => {
      const boxes = [...toolbar.querySelectorAll(':scope > button, :scope > .problems-anchor > button')].map(button => button.getBoundingClientRect());
      const modes = toolbar.querySelector('.pdf-modes').getBoundingClientRect();
      const nav = toolbar.querySelector('.sidebar-toggle')?.getBoundingClientRect();
      const tools = boxes.filter(box => box.x >= modes.right);
      return { count: tools.length, gaps: tools.slice(1).map((box, index) => box.x - tools[index].right),
        tops: tools.map(box => box.y), navGap: nav && modes.x - nav.right,
        contained: boxes.every(box => box.x >= toolbar.getBoundingClientRect().x && box.right <= toolbar.getBoundingClientRect().right) };
    });
    assert.equal(spacing.count, width > 680 ? 3 : 2, 'Compile, log and notes remain available; phones keep compile in the navigation bar');
    assert.ok(spacing.gaps.every(gap => gap >= 0 && gap <= 6.1), `Initial toolbar has compact action spacing at ${width}px: ${JSON.stringify(spacing)}`);
    assert.ok(spacing.tops.every(top => Math.abs(top - spacing.tops[0]) < 1), 'Initial toolbar actions align');
    if (spacing.navGap !== undefined) assert.ok(spacing.navGap >= 0 && spacing.navGap <= 6.1, 'Navigation stays next to PDF modes');
    assert.ok(spacing.contained, 'Initial toolbar actions remain inside the panel');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    await initialToolbar.screenshot({ path: `test-results/compile-initial-${width}-${colorScheme}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  Object.assign(build, { status: 'failed', error: 'Undefined control sequence.' });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await check(compile, red);
  await expect(initialToolbar).toBeVisible();
  await expect(page.getByText('The manuscript did not compile.', { exact: true })).toBeVisible();
  Object.assign(build, { status: 'ready', key: 'pdf', current: true, error: undefined });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(initialToolbar).toHaveCount(0);
  await check(compile, green);
  await page.locator('.pdf-toolbar').screenshot({ path: 'test-results/compile-ready.png' });

  // A stale read and repeated clicks cannot hide or duplicate a new compile.
  holdRead = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => Boolean(releaseRead)).toBe(true);
  holdNextBuild(); await compile.click();
  await check(compile, blue, true);
  await expect(compile.locator('.spinner')).toHaveCSS('animation-name', 'spin');
  await expect(compile.locator('.spinner')).toHaveCSS('animation-timing-function', 'linear');
  await expect(compile.locator('.spinner')).toHaveCSS('opacity', '1');
  await expect.poll(() => posts).toBe(1);
  releaseRead();
  await compile.evaluate(button => { button.click(); button.click(); });
  const before = reads;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.clock.runFor(100);
  assert.equal(reads, before, 'Do not poll over an in-flight compile request');
  assert.equal(posts, 1);
  await check(compile, blue, true);
  releaseBuild();
  await expect.poll(() => build.status).toBe('building');
  await check(compile, blue, true);
  await page.locator('.pdf-toolbar').screenshot({ path: 'test-results/compile-building.png' });
  assert.equal(await page.getByText('Compiling the latest changes…', { exact: true }).count(), 0);

  // A compile started between regular polls is checked again within 1.5s.
  Object.assign(build, { status: 'failed', error: 'Undefined control sequence.' });
  await page.clock.runFor(1600);
  await check(compile, red);
  await expect(compile).toHaveAttribute('title', /failed.*retry/);
  await page.locator('.pdf-toolbar').screenshot({ path: 'test-results/compile-failed.png' });
  await compile.click();
  await expect.poll(() => posts).toBe(2);
  await check(compile, blue, true);
  Object.assign(build, { status: 'ready', current: true, error: undefined });
  await page.clock.runFor(1600);
  await check(compile, green);

  // Transport errors leave the action available instead of claiming success.
  failRequest = true; await compile.click();
  await check(compile, 'rgb(138, 138, 138)');
  await expect(compile).toHaveAttribute('title', /status unavailable/);
  failRequest = false; await compile.click();
  await check(compile, blue, true);
  Object.assign(build, { status: 'ready', current: true });
  await page.clock.runFor(1600);
  await check(compile, green);

  // A new PDF keeps confirmed highlights and keeps unresolved notes in the
  // PDF note library, including color groups, without attaching them to wrong places.
  annotations.push(
    { id: 'kept', projectId: 'paper', key: 'pdf-next', page: 0, rect: [.1, .1, .4, .14], rects: [[.1, .1, .4, .14]], quote: 'Preserved selected text', comment: 'Keep this instruction.', source: null, createdAt: 1 },
    { id: 'uncertain', projectId: 'paper', key: 'pdf', page: 0, rect: [.1, .2, .4, .3], quote: 'Earlier figure caption', comment: 'Keep this comment even when the figure changes.', source: null, createdAt: 2 },
    { id: 'grouped', projectId: 'paper', key: 'pdf', page: 0, rect: [.1, .4, .4, .5], quote: 'Earlier grouped text', comment: '', group: 'blue', source: null, createdAt: 3 },
  );
  build.key = 'pdf-next';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('button', { name: 'My notes', exact: true }).click();
  await page.getByText('Keep this instruction.', { exact: true }).waitFor();
  await page.getByText('Keep this comment even when the figure changes.', { exact: true }).waitFor();
  await page.getByRole('status').filter({ hasText: 'Some note positions need confirmation.' }).waitFor();
  await expect(page.locator('.note-tag')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Show note 2 on the page', exact: true })).toBeDisabled();
  const groupDisclosure = page.locator('.annotation-group .group-disclosure');
  if (await groupDisclosure.getAttribute('aria-expanded') === 'false') await groupDisclosure.click();
  await page.getByText('Earlier grouped text', { exact: true }).waitFor();
  await expect(page.getByRole('button', { name: 'Show note 3 on the page', exact: true })).toBeDisabled();
  await expect(page.getByText('Position needs confirmation', { exact: true })).toHaveCount(2);
  await page.locator('.notes-panel').screenshot({ path: 'test-results/annotation-positions.png' });

  // The same control stays readable and aligned on phones and in dark mode.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.runFor(300);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await check(compile, 'rgb(123, 213, 160)');
  assert.equal((await compile.boundingBox()).width, 44);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.locator('.workspace-navigation').screenshot({ path: 'test-results/compile-mobile-dark.png' });
  await compile.click();
  await check(compile, 'rgb(138, 180, 255)', true);
  await expect(compile.locator('.spinner')).toHaveCSS('animation-name', 'none');
  Object.assign(build, { status: 'failed', error: 'Compile failed.' });
  await page.clock.runFor(1600);
  await check(compile, 'rgb(255, 150, 150)');

  // Comparison generation uses the task's actual build status, too.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('button', { name: /^Revise the introduction/ }).click();
  const compare = page.getByRole('button', { name: 'Regenerate PDF comparison', exact: true });
  await check(compare, green);
  holdNextBuild(); await compare.click();
  await check(compare, blue, true);
  releaseBuild();
  await expect.poll(() => task.status).toBe('building');
  await check(compare, blue, true);
  task.status = 'failed'; task.review.job = { status: 'failed', phase: 'building' };
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await check(compare, red);
  task.status = 'reviewing'; task.review.job = { status: 'done', phase: 'building' };
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await check(compare, green);
  assert.deepEqual(errors, []);
  console.log('PASS: Compile actions show real build states, block duplicate requests, retry failures, poll promptly, and work on mobile, in dark mode, and with reduced motion');
} finally { releaseBuild?.(); releaseRead?.(); await browser.close(); await server.close(); }
