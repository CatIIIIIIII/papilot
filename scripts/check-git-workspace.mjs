import { readyRequirements } from './required-tools-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from '../engine/node_modules/@playwright/test/index.mjs';

fs.mkdirSync('test-results', { recursive: true });
const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ locale: 'en-US', colorScheme: 'light', viewport: { width: 1440, height: 900 } });
await page.clock.install();
await page.addInitScript(() => localStorage.setItem('papilot:advanced-git', 'on'));
const errors = []; page.on('pageerror', error => errors.push(error.message));
const diffFailures = [];
page.on('requestfailed', request => {
  if (new URL(request.url()).pathname.endsWith('/git/diff')) diffFailures.push(request.failure()?.errorText);
});
const project = { id: 'git-paper', name: 'Example paper', path: '/tmp/git-paper', createdAt: 1 };
const task = { id: 'git-task', projectId: project.id, title: 'Clarify the introduction', name: 'git-task', instructions: '', status: 'idle', createdAt: 1, updatedAt: 1, review: null };
const runtime = { connected: true, authenticated: true, models: [{ id: 'model', name: 'Model', isDefault: true, efforts: [] }] };
const snapshot = { version: 'test', csrf: 'fixture', projects: [project], tasks: [task], requests: [], runtime, runtimes: { codex: runtime }, gitAvailable: true };
const initialFiles = [{ path: 'main.tex', status: 'M', staged: false, unstaged: true, lines: [2, 4] }, { path: 'references.bib', status: '?', staged: false, unstaged: true }];
const git = { branch: 'main', remote: true, upstream: 'origin/main', ahead: 1, behind: 0, head: { hash: 'abc1234', subject: 'Clarify the introduction', date: 1 }, files: structuredClone(initialFiles) };
const actions = [];
const note = { id: 'note-1', projectId: project.id, key: 'fixture', page: 0, rect: [72, 72, 200, 90], rects: [[72, 72, 200, 90]], source: null, quote: 'Fixture', comment: 'Original note', createdAt: 1 };
let failNoteSave = false, gitRequests = 0;
let diffText = 'New', diffRequests = 0, diffGate = null;
const words = JSON.parse(fs.readFileSync('tests/fixtures/outline-words.json', 'utf8'));
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url()), json = value => route.fulfill({ json: value });
  if (/\/git(?:\/|$)/.test(url.pathname)) gitRequests++;
  if (url.pathname === '/api/indirect-changes') return json({ indirectChanges: false });
  if (url.pathname === '/api/note-alternatives') return route.fulfill({ json: { noteAlternatives: true, noteAlternativeRange: 'few' } });
  if (url.pathname === '/api/runtime/requirements') return route.fulfill({ json: readyRequirements });
  if (url.pathname === '/api/state') return json(snapshot);
  if (url.pathname === '/api/updates') return json({ currentVersion: 'test', latestVersion: null, phase: 'idle', canUpdate: false });
  if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
  if (url.pathname.endsWith('/skills')) return json({ skills: [] });
  if (url.pathname.endsWith('/note-results')) return json({ notes: [] });
  if (url.pathname.endsWith('/items')) return json({ items: [] });
  if (url.pathname.endsWith('/annotations/note-1')) {
    if (failNoteSave) return route.fulfill({ status: 503, json: { error: 'Could not save note.' } });
    note.comment = route.request().postDataJSON().comment; return json(note);
  }
  if (url.pathname.endsWith('/git')) return json(git);
  if (url.pathname.endsWith('/git/fetch')) return json({ git });
  if (url.pathname.endsWith('/git/history')) return json({ versions: [], next: null });
  if (url.pathname.endsWith('/git/overview')) return json({ worktrees: [{ path: project.path, current: true, branch: git.branch, head: git.head.hash, status: git }], commits: [{ ...git.head, parents: [], author: 'Author', refs: ['main'] }], truncated: false });
  if (url.pathname.endsWith('/git/diff')) {
    const file = url.searchParams.get('path'), text = diffText;
    diffRequests++;
    if (diffGate) await diffGate;
    return json({ path: file, diff: `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-Old ${file}\n+${text} ${file}\n`, truncated: false });
  }
  if (url.pathname.endsWith('/git/stage')) {
    const body = route.request().postDataJSON(); actions.push(['stage', body]);
    git.files = git.files.map(file => body.paths.includes(file.path) ? { ...file, staged: body.stage, unstaged: !body.stage } : file);
    return json({ git });
  }
  if (url.pathname.endsWith('/git/commit')) {
    const body = route.request().postDataJSON(); actions.push(['commit', body]);
    git.files = git.files.filter(file => body.staged ? !file.staged : !body.paths.includes(file.path));
    git.head = { hash: 'def5678', subject: body.message, date: 2 }; git.ahead++;
    return json({ git, commit: 'def5678' });
  }
  if (url.pathname.endsWith('/git/push')) { actions.push(['push']); git.ahead = 0; return json({ git }); }
  if (url.pathname.endsWith('/manuscript')) return json({ git, build: { status: 'ready', key: 'fixture', pages: [[612, 792], [612, 792]] }, annotations: [note] });
  if (url.pathname.endsWith('/manuscript.pdf')) return route.fulfill({ contentType: 'application/pdf', body: fs.readFileSync('tests/fixtures/outline.pdf') });
  if (url.pathname.endsWith('/manuscript/words')) return json(words[Number(url.searchParams.get('page'))]);
  throw new Error(`Unexpected request: ${route.request().method()} ${url.pathname}`);
});
const workspace = page.getByRole('region', { name: 'Version Management', exact: true });
const panel = workspace.locator('.git-panel');
const details = workspace.locator('.git-details');
const toolbar = workspace.locator('.git-toolbar');
const openGit = async () => { if (!await page.locator('.git-link').isVisible()) await page.getByRole('button', { name: 'Show task list', exact: true }).click(); await page.locator('.git-link').click(); };
try {
  await page.goto(origin);
  await page.locator('.manuscript-link').click();
  await page.locator('.textLayer span').first().waitFor();
  // Leaving the manuscript saves note edits, and a failed save keeps the editor open.
  await page.getByRole('button', { name: 'My notes', exact: true }).click();
  await page.locator('.pdf-reading-notes').getByRole('button', { name: 'Edit note 1', exact: true }).click();
  const noteEditor = page.locator('.pdf-reading-notes').getByRole('textbox', { name: 'Edit note 1', exact: true });
  await noteEditor.fill('Save before opening version management');
  failNoteSave = true;
  await openGit();
  await expect(page.locator('.pdf-reading-notes').getByRole('alert')).toContainText('Could not save note.');
  await expect(workspace).toHaveCount(0);
  await expect(noteEditor).toHaveValue('Save before opening version management');
  failNoteSave = false;
  await openGit();
  await expect(workspace).toBeVisible();
  assert.equal(note.comment, 'Save before opening version management');
  await page.locator('.manuscript-link').click();

  await expect(page.getByRole('tablist', { name: 'Manuscript panels' }).getByRole('tab', { name: /^Version Management/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Collapse manuscript panel', exact: true }).click();
  await openGit();
  await expect(workspace).toBeVisible();
  await expect(page.locator('.manuscript')).toHaveCount(0);
  await expect(page.locator('.git-link')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.manuscript-link')).not.toHaveAttribute('aria-current', 'page');
  const left = await panel.boundingBox(), right = await details.boundingBox();
  assert.ok(left.x + left.width <= right.x + 1, 'Git operations are left of the detail area');
  assert.equal(Math.round(left.x), Math.round((await page.locator('.main').boundingBox()).x));
  await expect(details.getByRole('region', { name: 'Changes in main.tex', exact: true })).toContainText('New main.tex');
  const message = panel.getByRole('textbox', { name: 'Commit message' });
  await message.fill('Keep this commit draft');
  // Same status and line counts must not leave an outdated working-tree diff.
  diffText = 'Updated on focus';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(details.locator('.git-diff-view')).toContainText('Updated on focus main.tex');
  await expect(message).toBeFocused();
  diffText = 'Updated by polling';
  await page.clock.fastForward(5100);
  await expect(details.locator('.git-diff-view')).toContainText('Updated by polling main.tex');
  await expect(message).toBeFocused();
  // Slow requests are allowed to finish, without overlapping or being aborted
  // by a polling interval or repeated focus/visibility events.
  let releaseDiff;
  diffGate = new Promise(resolve => { releaseDiff = resolve; });
  diffText = 'Slow update';
  const beforeSlow = diffRequests, failuresBeforeSlow = diffFailures.length;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => diffRequests).toBe(beforeSlow + 1);
  // Cross multiple polling intervals while staying below the API's 15s deadline.
  // Passing that deadline legitimately aborts the request and permits a retry.
  for (let interval = 0; interval < 2; interval++) {
    await page.clock.runFor(5100);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.equal(diffRequests, beforeSlow + 1, 'Only one live diff request may be in flight');
    assert.equal(diffFailures.length, failuresBeforeSlow, 'Polling and focus must not abort an in-flight diff');
  }
  diffGate = null; releaseDiff();
  await expect(details.locator('.git-diff-view')).toContainText('Slow update main.tex');
  // A genuine timeout ends the pending request; Retry must then load fresh text.
  let releaseTimeout;
  diffGate = new Promise(resolve => { releaseTimeout = resolve; });
  diffText = 'Recovered after timeout';
  const beforeTimeout = diffRequests, failuresBeforeTimeout = diffFailures.length;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => diffRequests).toBe(beforeTimeout + 1);
  await page.clock.runFor(15100);
  await expect(details.getByRole('alert')).toHaveText('The request timed out. Please try again.');
  await expect.poll(() => diffFailures.length).toBe(failuresBeforeTimeout + 1);
  assert.equal(diffRequests, beforeTimeout + 1, 'A timed-out diff must wait for the next poll or an explicit retry');
  diffGate = null; releaseTimeout();
  await details.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(details.locator('.git-diff-view')).toContainText('Recovered after timeout main.tex');
  await expect(details.getByRole('alert')).toHaveCount(0);
  assert.equal(diffRequests, beforeTimeout + 2, 'Retry must issue one replacement diff request');
  diffText = 'New';
  await panel.getByRole('button', { name: 'references.bib', exact: true }).click();
  await expect(details.getByRole('region', { name: 'Changes in references.bib', exact: true })).toContainText('New references.bib');
  await details.locator('.git-detail-switcher').getByRole('button', { name: 'Version history', exact: true }).click();
  await expect(details.locator('.git-graph-row')).toHaveCount(1);
  await page.reload();
  await expect(workspace).toBeVisible();
  await expect(message).toHaveValue('Keep this commit draft');
  await expect(details.locator('.git-detail-switcher').getByRole('button', { name: 'Version history', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await details.locator('.git-detail-switcher').getByRole('button', { name: 'Changes', exact: true }).click();
  await expect(details.getByRole('region', { name: 'Changes in references.bib', exact: true })).toBeVisible();
  await page.locator('.task-link').click();
  const chat = page.locator('.activity-panel textarea').first();
  await chat.fill('Keep this task draft');
  await openGit();
  await expect(message).toHaveValue('Keep this commit draft');
  await page.locator('.task-link').click();
  await expect(chat).toHaveValue('Keep this task draft');
  await openGit();
  // Commit operations stay pinned while the changed files scroll independently.
  git.files.push(...Array.from({ length: 60 }, (_, i) => ({ path: `sections/section-${i}.tex`, status: 'M', staged: false, unstaged: true })));
  await panel.getByRole('button', { name: 'Refresh changes' }).click();
  await expect(panel.locator('.git-file')).toHaveCount(62);
  const toolbarY = (await toolbar.boundingBox()).y, messageY = (await message.boundingBox()).y;
  await panel.locator('.git-file-lists').evaluate(el => { el.scrollTop = el.scrollHeight; });
  assert.ok(await panel.locator('.git-file-lists').evaluate(el => el.scrollTop > 0));
  assert.equal((await toolbar.boundingBox()).y, toolbarY);
  assert.equal((await message.boundingBox()).y, messageY);
  git.files = structuredClone(initialFiles);
  await panel.getByRole('button', { name: 'Refresh changes' }).click();
  await expect(panel.locator('.git-file')).toHaveCount(2);
  await panel.getByRole('button', { name: 'Stage references.bib', exact: true }).click();
  await message.fill('Add references');
  await panel.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Committed def5678.');
  await expect(details.getByRole('region', { name: 'Changes in main.tex', exact: true })).toBeVisible();
  await toolbar.getByRole('button', { name: 'Push', exact: true }).click();
  await expect(toolbar.getByRole('button', { name: 'Push', exact: true })).toBeDisabled();
  assert.deepEqual(actions, [['stage', { paths: ['references.bib'], stage: true }], ['commit', { message: 'Add references', staged: true }], ['push']]);
  await page.screenshot({ path: 'test-results/git-workspace-desktop.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: 'test-results/git-workspace-dark.png', animations: 'disabled' });
  await page.emulateMedia({ colorScheme: 'light' });
  for (const width of [320, 390, 820]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(page.locator('.sidebar')).toBeHidden();
    await openGit();
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(message).toBeInViewport();
    await expect(details.getByRole('region', { name: 'Changes in main.tex', exact: true })).toBeInViewport();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    await page.screenshot({ path: `test-results/git-workspace-${width}.png` });
  }
  // In short windows a multiline draft must not clip the commit action or files.
  await message.fill('Explain this revision\n\nClarify the definitions.\nAdd the missing argument.\nDocument assumptions.\nUpdate the examples.\nExplain the edge cases.\nKeep the original notation.');
  const centerClickable = locator => locator.evaluate(el => {
    const rect = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  });
  for (const size of [{ width: 390, height: 568 }, { width: 1440, height: 400 }]) {
    await page.setViewportSize(size);
    const commit = panel.getByRole('button', { name: 'Commit', exact: true });
    await commit.scrollIntoViewIfNeeded();
    await expect.poll(() => centerClickable(commit)).toBe(true);
    await page.screenshot({ path: `test-results/git-workspace-short-${size.width}.png` });
    const file = panel.getByRole('button', { name: 'main.tex', exact: true });
    await file.scrollIntoViewIfNeeded();
    await expect.poll(() => centerClickable(file)).toBe(true);
    await file.click();
    await expect(details.locator('.git-diff-view')).toContainText('New main.tex');
  }
  await page.setViewportSize({ width: 820, height: 800 });
  // Git keeps the manuscript's collapsed preference and PDF view separate.
  await page.getByRole('button', { name: 'Show task list', exact: true }).click();
  await page.locator('.manuscript-link').click();
  await expect(page.locator('.manuscript-side')).toBeHidden();
  await expect(page.locator('.git-workspace')).toHaveCount(0);
  // A persisted Git page must not bypass the missing-Git gate. Background Git
  // requests also stop; installation is picked up by the normal state refresh.
  await page.setViewportSize({ width: 1440, height: 900 });
  snapshot.gitAvailable = false;
  await page.evaluate(() => { localStorage.setItem('papilot:page', 'git'); localStorage.setItem('papilot:task', ''); });
  const beforeMissing = gitRequests;
  await page.reload();
  await expect(page.locator('.git-link')).toBeDisabled();
  await expect(workspace).toHaveCount(0);
  await expect(page.locator('.manuscript-link')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: 'Install Git in this environment to use version management.', exact: true })).toHaveAttribute('href', 'https://git-scm.com/install/');
  await page.clock.runFor(21000);
  assert.equal(gitRequests, beforeMissing, 'No Git reads or writes while Git is unavailable');
  await page.screenshot({ path: 'test-results/git-workspace-missing-git.png' });
  snapshot.gitAvailable = true;
  await page.clock.runFor(11000);
  await expect(page.locator('.git-link')).toBeEnabled();
  await expect(page.locator('.git-install-hint')).toHaveCount(0);
  await openGit();
  await expect(workspace).toBeVisible();
  assert.deepEqual(errors, []);
  console.log('Git workspace passed: left-side controls, separate diff/history, navigation and draft restoration, live and slow diff refresh, timeout recovery, pinned commit controls, staging/commit/push, responsive and short-window layouts, missing-Git gate and installation recovery.');
} catch (error) {
  if (errors.length) console.error('Page errors:', errors);
  await page.screenshot({ path: 'test-results/git-workspace-failure.png' });
  throw error;
} finally { await browser.close(); await server.close(); }
