// Real engine and Papilot routes, with only the agent and manuscript builds
// replaced. All files and servers belong to this disposable fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { chromium, expect } from '../engine/node_modules/@playwright/test/index.mjs';
import { Fixture, METHOD } from '../engine/tests/ts/helpers.ts';
import { createServer } from '../engine/src/server.ts';
import { Builder } from '../engine/src/core/build.ts';

const f = new Fixture();
process.env.PAPILOT_DATA = path.join(f.base, 'data');
const [{ Store }, { Workspace }, { Manuscripts }, { buildApp, gitQueue }, { AGENT_IDS }] = await Promise.all([
  import('../src/server/store.ts'), import('../src/server/workspace.ts'), import('../src/server/manuscript.ts'),
  import('../src/server/app.ts'), import('../src/shared.ts'),
]);
f.write('paper/main.tex', '\\documentclass{article}\n\\begin{document}\n\\input{sections/method}\n\\end{document}\n');
f.write(METHOD, '\\section{First}\nOriginal first paragraph.\n\\newpage\n\\section{Second}\nOriginal second paragraph.\n\\newpage\n\\section{Third}\nOriginal third paragraph.\n');
f.repo.run(['add', '-A']); f.repo.run(['commit', '-qm', 'Separate review pages']);
const app = f.app(); await app.ready;
const task = app.tasks.create('batch', 'Review three pages', [], ['paper'], true);
f.edit(task, METHOD, 'Original first', 'Proposed first');
f.edit(task, METHOD, 'Original second', 'Proposed second');
f.edit(task, METHOD, 'Original third', 'Proposed third');
app.publisher.submit(task.name); await app.publisher.join();
assert.equal(app.review.latestRound(task.name)?.visuals, 'ready');
const engine = createServer(app);
await engine.listen({ host: '127.0.0.1', port: 0 });
app.url = `http://127.0.0.1:${engine.server.address().port}`;
const client = { url: app.url, token: app.csrf,
  async get(route) { const response = await fetch(app.url + route); assert.ok(response.ok, await response.clone().text()); return response.json(); },
  async post(route, body) { const response = await fetch(app.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Review-Token': app.csrf }, body: JSON.stringify(body) }); assert.ok(response.ok, await response.clone().text()); return response.json(); },
};
class Agent extends EventEmitter { ready = false; close() {} }
const store = new Store(':memory:');
const workspace = new Workspace(store, new Agent(), async () => client, Object.fromEntries(AGENT_IDS.filter(id => id !== 'codex').map(id => [id, new Agent()])));
store.saveProject({ id: 'paper', path: f.root, name: 'Paper', createdAt: 1 });
store.saveTask({ id: 'batch', projectId: 'paper', name: task.name, title: task.title, instructions: '', worktree: task.worktree, threadId: null, turnId: null, model: null, status: 'reviewing', deferred: true, createdAt: 1, updatedAt: 1, feedbackCursor: 0, error: null, review: null });
const manuscripts = new Manuscripts(), builds = [];
manuscripts.refresh = async () => { builds.push('refresh'); };
manuscripts.predict = async () => { builds.push('predict'); };
const listener = { kind: 'local', port: 0, publicOrigin: '', owner: '' };
const server = await buildApp({ listener, store, workspace, manuscripts, csrf: 'fixture', serialGit: gitQueue(), dist: path.resolve('dist'), version: 'test', connectReview: async () => client });
await server.listen({ host: '127.0.0.1', port: 0 });
listener.port = server.server.address().port;
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const errors = [], pages = [];
let release = () => {}, original = Builder.prototype.build;
try {
  // No single decision, undo, or comment may start a manuscript build.
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); pages.push(page);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${listener.port}/review/paper/?task=batch`);
  await expect(page.locator('.change.current')).toHaveAttribute('data-stop', '0');
  await page.keyboard.press('a');
  await expect.poll(() => app.review.pageState(task.name).decisions.c001).toBe('accepted');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect.poll(() => app.review.pageState(task.name).decisions.c001).toBe('pending');
  await page.waitForTimeout(500);
  assert.deepEqual(builds, [], 'decisions and undo do not refresh or predict the manuscript');

  // Hold a failing round: the pages before the broken one have carried comparisons.
  const gate = new Promise(resolve => { release = resolve; });
  Builder.prototype.build = async function (...args) { await gate; return original.apply(this, args); };
  f.edit(task, METHOD, 'Proposed third paragraph.', '\\unknownBatchCommand');
  app.publisher.submit(task.name);
  await expect.poll(() => app.review.latestRound(task.name)?.number).toBe(2);
  store.updateTask('batch', { status: 'building' });
  for (const width of [1440, 390]) {
    const view = width === 1440 ? page : await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
    if (view !== page) { pages.push(view); view.on('pageerror', error => errors.push(error.message)); }
    await view.addInitScript(() => localStorage.clear());
    await view.goto(`http://127.0.0.1:${listener.port}/review/paper/?task=batch`);
    const waiting = view.locator('.change[data-stop="2"]');
    await expect(waiting.locator('.comparison-waiting')).toContainText('PDF comparison in progress');
    await waiting.locator('.comparison-waiting').click();
    await expect(waiting.locator('button.accept')).toHaveCount(0);
    await expect(waiting.locator('button.comment')).toBeEnabled();
    await expect(view.locator('.change-carried').first()).toContainText('PDF from');
    await view.locator('.accept-all').click();
    await expect.poll(() => app.review.pageState(task.name).decisions.c002).toBe('accepted');
    assert.equal(app.review.pageState(task.name).decisions.c001, 'accepted');
    assert.equal(app.review.pageState(task.name).decisions.c003, 'pending');
    await expect(view.locator('.accept-all')).toHaveCount(0);
    fs.mkdirSync('test-results', { recursive: true });
    await view.screenshot({ path: `test-results/review-batching-${width}.png` });
    assert.ok(await view.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await view.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await expect.poll(() => app.review.pageState(task.name).decisions.c002).toBe('pending');
    assert.deepEqual(builds, [], 'batch decisions during a render do not build the manuscript');
  }
  release(); await app.publisher.join();
  assert.equal(app.review.latestRound(task.name)?.number, 2, 'failure retains the inserted round');
  assert.equal(app.review.latestRound(task.name)?.visuals, 'failed');
  store.updateTask('batch', { status: 'failed' });
  await expect(page.locator('.comparison-waiting')).toContainText('PDF comparison failed', { timeout: 10000 });
  await expect(page.locator('.change[data-stop="2"] button.accept')).toHaveCount(0);
  await expect(page.locator('.accept-all')).toBeEnabled();
  await page.locator('.accept-all').click();
  await expect.poll(() => app.review.pageState(task.name).decisions.c002).toBe('accepted');
  await expect(page.locator('.accept-all')).toHaveCount(0);
  assert.equal(app.review.pageState(task.name).decisions.c003, 'pending');
  assert.deepEqual(builds, []);
  assert.deepEqual(errors, []);
  console.log('PASS: real Papilot decisions do not build the manuscript; desktop and phone batches include only comparable changes; failure keeps the inserted round and gates its missing comparison.');
} finally {
  release(); Builder.prototype.build = original;
  await browser.close(); await server.close(); workspace.close(); store.close();
  await engine.close(); await f.close();
}
