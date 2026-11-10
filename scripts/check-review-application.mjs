// Browser -> Papilot -> real review server -> real Git and LaTeX.
// Only the agent is inert. All repositories, state and browser profiles are disposable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Builder } from '../engine/src/core/build.ts';
import { chromium, expect } from '../engine/node_modules/@playwright/test/index.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-review-application-'));
process.env.PAPILOT_DATA = path.join(temp, 'data');
delete process.env.PAPILOT_DESKTOP;
// Exercise ordinary manuscript previews separately from the review's dated PDFs.
delete process.env.SOURCE_DATE_EPOCH;
const latexmk = execFileSync('which', ['latexmk'], { encoding: 'utf8' }).trim();
const calls = path.join(temp, 'compiles.jsonl'), fail = path.join(temp, 'fail'), hold = path.join(temp, 'hold');
const bin = path.join(temp, 'bin'); fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'latexmk'), `#!${process.execPath}
const fs = require('node:fs');
const build = process.argv.includes('-outdir=build');
const parts = process.cwd().split(require('node:path').sep);
if (build) fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ cwd: process.cwd(), key: parts[parts.lastIndexOf('builds') + 1], args: process.argv.slice(2) }) + String.fromCharCode(10));
if (build && fs.existsSync(${JSON.stringify(fail)})) { console.error('Intentional compilation failure'); process.exit(1); }
const deadline = Date.now() + 30000;
while (build && fs.existsSync(${JSON.stringify(hold)}) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
const result = require('node:child_process').spawnSync(${JSON.stringify(latexmk)}, process.argv.slice(2), { stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
process.env.PATH = bin + path.delimiter + process.env.PATH;
const [{ Fixture }, { createServer }, { Store }, { Workspace }, { Manuscripts }, { buildApp, gitQueue }, { Updates }, { AGENT_IDS }] = await Promise.all([
  import('../engine/tests/ts/helpers.ts'), import('../engine/src/server.ts'), import('../src/server/store.ts'),
  import('../src/server/workspace.ts'), import('../src/server/manuscript.ts'), import('../src/server/app.ts'),
  import('../src/server/updates.ts'), import('../src/shared.ts'),
]);
class InertAgent extends EventEmitter { ready = false; close() {} }
const f = new Fixture(), store = new Store(path.join(temp, 'data/state.sqlite3')), manuscripts = new Manuscripts();
let server, reviewServer, browser, page, workspace, updates;
const compiles = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => {
  const entry = JSON.parse(line);
  assert.match(entry.key || '', /^[a-f0-9]{32}$/, 'every counted latexmk belongs to a review build key');
  return entry;
}) : [];
const count = () => compiles().length;
fs.mkdirSync('test-results', { recursive: true });
const report = { decisions: 0, intermediateHostCompiles: 0, finalPredictionCompiles: 0, applicationCompiles: 0, appliedPreviewCompiles: 0, refreshes: 0, predictions: 0, errors: [] };
// Observe real builds without replacing any compilation, snapshot or cache.
// A count of every latexmk would conflate the engine's per-decision PDF with
// the host's manuscript preview. Associate each invocation with its build key.
const owner = new AsyncLocalStorage(), observedBuilds = [], buildJobs = new Set(), predictionJobs = new Set();
const originalBuild = Builder.prototype.build;
Builder.prototype.build = function (rev, targets, seed, options = {}) {
  const entry = { owner: owner.getStore() || 'engine', rev, key: null, resultKey: null, status: 'building' };
  observedBuilds.push(entry);
  const job = originalBuild.call(this, rev, targets, seed, { ...options, onKey(key) { entry.key = key; options.onKey?.(key); } }).then(result => {
    entry.status = 'ready'; entry.resultKey = result.key; return result;
  }, error => { entry.status = 'failed'; entry.error = error.message; throw error; });
  buildJobs.add(job);
  void job.finally(() => buildJobs.delete(job)).catch(() => undefined);
  return job;
};
const state = manuscripts.state.bind(manuscripts), refresh = manuscripts.refresh.bind(manuscripts), predict = manuscripts.predict.bind(manuscripts);
manuscripts.state = (...args) => owner.run('host-state', () => state(...args));
manuscripts.refresh = (...args) => { report.refreshes++; return owner.run('host-refresh', () => refresh(...args)); };
manuscripts.predict = (...args) => {
  report.predictions++;
  const job = owner.run('prediction', () => predict(...args));
  predictionJobs.add(job);
  void job.finally(() => predictionJobs.delete(job)).catch(() => undefined);
  return job;
};
const keysFor = kinds => new Set(observedBuilds.filter(build => kinds.includes(build.owner)).flatMap(build => [build.key, build.resultKey]).filter(Boolean));
const countKeys = (records, keys) => records.filter(record => keys.has(record.key)).length;
const settledBuilds = async () => {
  await expect.poll(() => predictionJobs.size, { timeout: 60000 }).toBe(0);
  await expect.poll(() => buildJobs.size, { timeout: 60000 }).toBe(0);
};
try {
  f.write('paper/main.tex', '\\documentclass{article}\n\\begin{document}\n\\input{first}\n\\input{second}\n\\input{third}\n\\end{document}\n');
  for (const name of ['first', 'second', 'third']) f.write(`paper/${name}.tex`, `\\section{${name}}\nOriginal ${name} sentence.\n`);
  f.repo.run(['add', '.']); f.repo.run(['commit', '-qm', 'Browser batching fixture']);
  const engine = f.app(); await engine.ready;
  const proposal = engine.tasks.create('batching', 'Review batching', [], ['paper'], true);
  for (const name of ['first', 'second', 'third']) f.edit(proposal, `paper/${name}.tex`, `Original ${name}`, `Revised ${name}`);
  engine.publisher.submit(proposal.name); await engine.publisher.join();
  assert.equal(engine.publisher.current(proposal.name)?.status, 'done', JSON.stringify(engine.publisher.current(proposal.name)));
  reviewServer = createServer(engine); await reviewServer.listen({ host: '127.0.0.1', port: 0 });
  engine.url = `http://127.0.0.1:${reviewServer.server.address().port}`;
  const call = async (route, body) => {
    const response = await fetch(engine.url + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Review-Token': engine.csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || response.statusText);
    return result;
  };
  const client = { url: engine.url, token: engine.csrf, get: route => call(route), post: (route, body = {}) => call(route, body) };
  workspace = new Workspace(store, new InertAgent(), async () => client, Object.fromEntries(AGENT_IDS.filter(id => id !== 'codex').map(id => [id, new InertAgent()])));
  store.saveProject({ id: 'paper', name: 'Batching test paper', path: f.root, createdAt: Date.now() });
  store.saveTask({ id: 'batching', projectId: 'paper', name: proposal.name, title: 'Review batching', instructions: '', worktree: proposal.worktree,
    deferred: true, threadId: null, turnId: null, model: null, status: 'reviewing', createdAt: Date.now(), updatedAt: Date.now(), feedbackCursor: 0, error: null, review: null });
  await workspace.refresh('batching');
  const settle = async () => {
    let result;
    await expect.poll(async () => { result = await manuscripts.state('paper', f.root); return result.build.status; }, { timeout: 60000 }).not.toBe('building');
    return result.build;
  };
  assert.equal((await settle()).status, 'ready');
  const listener = { kind: 'local', port: 0, publicOrigin: '', owner: '' };
  updates = new Updates({ root: process.cwd(), data: process.env.PAPILOT_DATA, version: '0.9.2', port: 0, supported: false, busy: () => false, shutdown() {}, latest: async () => '0.9.2' });
  server = await buildApp({ store, workspace, manuscripts, listener, csrf: 'batching-test', serialGit: gitQueue(), dist: path.resolve('dist'), version: '0.9.2', connectReview: async () => client, updates });
  await server.listen({ host: '127.0.0.1', port: 0 }); listener.port = server.server.address().port;
  const origin = `http://127.0.0.1:${listener.port}`;
  console.log(`Isolated web test: ${origin}, real review service: ${engine.url}`);
  browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
  page = await browser.newPage({ locale: 'en-US', viewport: { width: 1100, height: 900 } });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('response', response => { if (response.status() >= 500) report.errors.push(`${response.status()} ${response.url()}`); });
  await page.addInitScript(() => { localStorage.setItem('papilot:task', 'batching'); localStorage.setItem('papilot:project', 'paper'); localStorage.setItem('papilot:language', 'en'); });
  await page.goto(origin);
  const viewer = () => page.frameLocator('.review-frame');
  await expect(viewer().locator('.change.current')).toBeVisible();
  assert.equal(engine.review.summary(proposal.name).counts.pending, 3);
  await settledBuilds();
  const start = count(), refreshStart = report.refreshes, predictionStart = report.predictions, round = engine.review.latestRound(proposal.name).number;
  const decisionResponse = route => page.waitForResponse(response => new URL(response.url()).pathname === `/review/paper/api/tasks/batching/${route}` && response.request().method() === 'POST');
  const choose = async (action, pending) => {
    const response = decisionResponse('decide');
    await viewer().locator('.change.current').getByRole('button', { name: action, exact: true }).click();
    const confirmed = await response; assert.ok(confirmed.ok(), await confirmed.text()); await confirmed.finished();
    await expect.poll(() => engine.review.summary(proposal.name).counts.pending).toBe(pending);
    if (pending) await expect(viewer().locator('.change.current').getByRole('button', { name: 'Accept', exact: true })).toBeEnabled();
    report.decisions++;
  };
  await choose('Accept', 2);
  await choose('Reject', 1);
  // Undo through the real embedded viewer, then reload with persisted choices.
  await viewer().locator('.change.current .change-number').click();
  const undoResponse = decisionResponse('undo');
  await page.keyboard.press('ControlOrMeta+z');
  const undone = await undoResponse; assert.ok(undone.ok(), await undone.text()); await undone.finished();
  await expect.poll(() => engine.review.summary(proposal.name).counts.pending).toBe(2);
  await page.reload();
  await expect(viewer().locator('.bar .reject-all')).toBeEnabled();
  await choose('Accept', 1);
  // Read the authoritative proxied state: its summary waits for the queued
  // settlement. A pending choice must not start any host prediction/build.
  await page.evaluate(async () => {
    const response = await fetch('/review/paper/api/tasks/batching/state');
    if (!response.ok) throw new Error('Could not read settled review state');
    await response.json();
  });
  await engine.applied.join(); await settledBuilds();
  report.intermediateHostCompiles = countKeys(compiles().slice(start), keysFor(['host-state', 'host-refresh', 'prediction']));
  assert.equal(report.intermediateHostCompiles, 0, 'intermediate decisions never compile the manuscript');
  assert.equal(report.refreshes, refreshStart, 'intermediate decisions never refresh the manuscript');
  assert.equal(report.predictions, predictionStart, 'unfinished choices never predict a manuscript');

  await choose('Accept', 0);
  const apply = () => viewer().getByRole('button', { name: 'Apply to workspace', exact: true });
  await expect(apply()).toBeEnabled();
  await expect.poll(() => observedBuilds.some(build => build.owner === 'prediction' && build.status === 'ready'), { timeout: 60000 }).toBe(true);
  await engine.applied.join(); await settledBuilds();
  const finalKeys = keysFor(['prediction']);
  assert.equal(finalKeys.size, 1, 'all final-selection predictions share one build key');
  report.finalPredictionCompiles = countKeys(compiles().slice(start), finalKeys);
  assert.equal(report.finalPredictionCompiles, 1, 'the final manuscript is compiled exactly once before Apply');
  assert.equal(report.refreshes, refreshStart, 'preparing the final selection does not rewrite or refresh the manuscript');
  for (const name of ['first', 'second', 'third']) assert.match(f.read(`paper/${name}.tex`), /Original/);

  // The engine's PDF of accepted decisions is a separate dated build. It may
  // compile intermediate choices; its work must not be counted as host work.
  const applied = await engine.applied.state(proposal.name);
  assert.equal(applied.shown?.current, true);
  assert.equal(applied.building, false);
  assert.ok(!finalKeys.has(applied.shown.key), 'the applied-paper preview and manuscript prediction have independent keys');
  report.appliedPreviewCompiles = countKeys(compiles().slice(start), keysFor(['engine']));
  assert.ok(report.appliedPreviewCompiles > 0, 'real applied-paper previews were exercised');

  // Reopening the Apply controls requests another prediction, but its real
  // compiler result must be reused. Do not require exactly one HTTP request.
  const predictionsBeforeReload = report.predictions, compilesBeforeReload = count();
  const requestedPrediction = page.waitForResponse(response => new URL(response.url()).pathname === '/api/tasks/batching/predict' && response.ok());
  await page.reload(); await expect(apply()).toBeEnabled(); await requestedPrediction;
  await expect.poll(() => report.predictions).toBeGreaterThan(predictionsBeforeReload);
  await engine.applied.join(); await settledBuilds();
  assert.deepEqual([...keysFor(['prediction'])], [...finalKeys]);
  assert.equal(count(), compilesBeforeReload, 'reload reuses the final prediction and applied-paper caches');
  assert.equal(engine.review.latestRound(proposal.name).number, round);
  await page.screenshot({ path: 'test-results/review-application-before-apply.png' });

  const beforeApply = count();
  await apply().click();
  await expect.poll(() => store.task('batching').delivery?.mode).toBe('workspace');
  await expect.poll(() => report.refreshes - refreshStart).toBe(1);
  assert.equal((await settle()).status, 'ready');
  await engine.applied.join(); await settledBuilds();
  report.applicationCompiles = count() - beforeApply;
  assert.equal(report.applicationCompiles, 0, 'Apply reuses the final prediction without another latexmk invocation');
  assert.equal(report.refreshes - refreshStart, 1, 'the actual manuscript write refreshes its displayed state once');
  assert.equal(countKeys(compiles().slice(start), finalKeys), 1);
  assert.match(f.read('paper/first.tex'), /Revised first/);
  assert.match(f.read('paper/second.tex'), /Revised second/);
  assert.match(f.read('paper/third.tex'), /Revised third/);
  console.log('PASS: intermediate decisions avoid host builds; the final selection compiles once; reload and Apply reuse it; applied-paper previews are counted separately.');

  // A new task exercises a real in-flight comparison, compiler failure and retry.
  f.repo.run(['add', '.']); f.repo.run(['commit', '-qm', 'Applied selection']);
  const retry = engine.tasks.create('retry', 'Compilation recovery', [], ['paper'], true);
  f.edit(retry, 'paper/first.tex', 'Revised first', 'Recovery first');
  f.edit(retry, 'paper/third.tex', 'Revised third', 'Recovery third');
  store.saveTask({ ...store.task('batching'), id: 'retry', name: retry.name, title: 'Compilation recovery', worktree: retry.worktree, delivery: null, review: null });
  await workspace.publish('retry');
  await page.getByRole('button', { name: /^Compilation recovery/ }).click();
  await expect(viewer().locator('.bar .accept-all')).toBeEnabled();
  // Record transient false success messages too: waiting for a toast to
  // disappear could otherwise pass only because its six-second timer expired.
  await viewer().locator('body').evaluate(body => {
    window.readyWhileUnavailable = [];
    const record = () => {
      const toast = [...body.querySelectorAll('.toast')].find(element => element.textContent.trim() === 'Changes are ready');
      const unavailable = body.querySelector('.comparison-waiting, .bar .status[data-state="building"], .bar .status[data-state="build_failed"]');
      if (toast && unavailable) window.readyWhileUnavailable.push(unavailable.textContent.trim());
    };
    new MutationObserver(record).observe(body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-state'] });
    record();
  });
  const readyToast = () => viewer().locator('.toast').filter({ hasText: /^Changes are ready$/ });
  const noFalseReady = async () => {
    assert.equal(await readyToast().count(), 0, 'an unavailable comparison never claims that changes are ready');
    assert.deepEqual(await viewer().locator('body').evaluate(() => window.readyWhileUnavailable), [], 'no transient ready toast while comparisons build or fail');
  };
  f.edit(retry, 'paper/first.tex', 'Recovery first', 'Updated first');
  fs.writeFileSync(hold, '');
  await page.locator('.review-rebuild').click();
  await expect(page.locator('.review-rebuild')).toHaveAttribute('aria-busy', 'true');
  await expect(viewer().locator('.bar .status[data-state="building"]')).toHaveCSS('clip-path', 'inset(50%)');
  await expect(viewer().locator('.comparison-waiting[data-state="pending"]').first()).toBeVisible();
  await noFalseReady();
  assert.equal(await viewer().locator('.bar').evaluate(el => el.offsetHeight), 44);
  await page.screenshot({ path: 'test-results/review-application-real-build.png' });
  fs.rmSync(hold);
  await expect(page.locator('.review-rebuild')).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });
  await expect(viewer().locator('.bar .accept-all')).toBeEnabled();
  await expect(readyToast()).toBeVisible();
  const goodRound = engine.review.latestRound(retry.name).number;

  f.edit(retry, 'paper/first.tex', 'Updated first', 'Broken first'); fs.writeFileSync(fail, '');
  await page.locator('.review-rebuild').click();
  await expect(page.locator('.review-rebuild')).toHaveAttribute('data-state', 'failed', { timeout: 60000 });
  await expect(viewer().locator('.bar .status[data-state="build_failed"]')).toBeVisible();
  // This fixture has one carried change and one missing comparison. The
  // usable single change keeps its own controls; a batch requires two.
  await expect(viewer().locator('.bar .accept-all')).toHaveCount(0);
  const carried = viewer().locator('.change:has(.change-carried)');
  await expect(carried).toHaveCount(1);
  // Only the current change shows its actions, and which change is current
  // first depends on which comparison settles first. Select it, as note
  // links do, before checking its controls.
  await carried.evaluate(element => element.click());
  await expect(carried).toHaveClass(/\bcurrent\b/);
  await expect(carried.getByRole('button', { name: 'Accept', exact: true })).toBeEnabled();
  await expect(carried.getByRole('button', { name: 'Reject', exact: true })).toBeEnabled();
  assert.equal(engine.review.latestRound(retry.name).number, goodRound + 1, 'a failed build keeps its new source round');
  assert.equal(engine.review.latestRound(retry.name).visuals, 'failed');
  await expect(viewer().locator('.change-carried').first()).toContainText('PDF from');
  await expect(viewer().locator('.comparison-waiting').first()).toContainText('PDF comparison failed');
  await expect(viewer().locator('.change:has(.comparison-waiting) button.accept')).toHaveCount(0);
  await expect(viewer().locator('.change.current')).toBeVisible();
  await noFalseReady();
  await page.screenshot({ path: 'test-results/review-application-failed.png' });
  fs.rmSync(fail); await page.locator('.review-rebuild').click();
  await expect(page.locator('.review-rebuild')).toHaveAttribute('data-state', 'ready', { timeout: 60000 });
  await expect(viewer().locator('.bar .accept-all')).toBeEnabled();
  await expect(viewer().locator('.bar .status')).toHaveCount(0);
  assert.equal(engine.review.latestRound(retry.name).visuals, 'ready');
  await expect(viewer().locator('.comparison-waiting')).toHaveCount(0);
  await expect(readyToast()).toBeVisible();
  assert.deepEqual(await viewer().locator('body').evaluate(() => window.readyWhileUnavailable), [], 'success is announced only when the comparison is ready');
  assert.deepEqual(report.errors, []);
  console.log('PASS: real comparison progress, carried pages, source-first failure gating and retry recover without stuck controls');
  report.builds = observedBuilds; report.compiles = compiles();
  fs.writeFileSync('test-results/review-application.json', JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error);
  console.error('Task at failure:', JSON.stringify(store.tasks()));
  fs.writeFileSync('test-results/review-application.json', JSON.stringify({ ...report, builds: observedBuilds, compilerLog: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' }, null, 2));
  if (page) { await page.screenshot({ path: 'test-results/review-application-error.png' }); fs.writeFileSync('test-results/review-application-error.txt', await page.locator('body').innerText()); }
  throw error;
} finally {
  fs.rmSync(hold, { force: true });
  if (browser) await browser.close();
  if (server) await server.close();
  workspace?.close(); updates?.close();
  await manuscripts.stop();
  if (reviewServer) await reviewServer.close();
  await f.close(); store.close();
  Builder.prototype.build = originalBuild;
  fs.rmSync(temp, { recursive: true, force: true });
}
