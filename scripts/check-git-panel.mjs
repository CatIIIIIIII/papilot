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
const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 960 } });
const page = await context.newPage();
await page.clock.install();
context.setDefaultTimeout(15000);
const errors = [], requests = [], stages = [], diffs = [];
page.on('pageerror', error => errors.push(error.message));
const files = [{ path: 'main.tex', status: 'M', staged: false, unstaged: true, incoming: 'M', lines: [18, 4] }, { path: 'chapters/results.tex', status: 'M', staged: false, unstaged: true, lines: [6, 2] }, { path: 'references.bib', status: '?', staged: false, unstaged: true }];
const longDiff = '@@ -1,9002 +1,9002 @@\n-First result.\n+Updated result.\n' + Array.from({ length: 9000 }, (_, index) => ` Context ${index + 2}\n`).join('') + '-Late result.\n+Late updated result.\n';
let git = { remote: true, branch: 'main', upstream: 'origin/main', ahead: 1, behind: 1, head: { hash: 'abc1234', subject: 'Initial', date: 1 }, files: structuredClone(files), merging: null };
let syncFailure = false, syncConflict = false, syncGate = null, overviewRequests = 0, fetches = 0, incoming = 0, historyDiffs = 0;
const project = { id: 'paper', name: 'Example paper', path: '/tmp/git-panel-fixture', createdAt: 1 };
const history = [{ hash: 'abc1234'.padEnd(40, '0'), message: 'Refine the discussion\n\nExplain the limitations and next steps.', author: 'Chen', date: Date.now() }, { hash: '1'.repeat(40), message: 'Add comparison results\n\nInclude the baseline and shared workspace results.', author: 'Lin', date: Date.now() - 86400000 }];
const runtime = { connected: true, authenticated: true, account: null, error: null, models: [{ id: 'model', name: 'Model', isDefault: true, efforts: ['high'], defaultEffort: 'high' }] };
await context.route('**/api/**', async route => {
  const url = new URL(route.request().url()), json = data => route.fulfill({ json: data });
  if (url.pathname === '/api/note-alternatives') return route.fulfill({ json: { noteAlternatives: true, noteAlternativeRange: 'few' } });
  if (url.pathname === '/api/indirect-changes') return json({ indirectChanges: false });
  if (url.pathname === '/api/runtime/requirements') return route.fulfill({ json: readyRequirements });
  if (url.pathname === '/api/state') return json({ version: 'test', csrf: 'fixture', projects: [project], tasks: [], requests: [], runtime });
  if (url.pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
  if (url.pathname === '/api/updates') return json({ currentVersion: 'test', latestVersion: 'test', phase: 'idle', checkedAt: 1, error: null, canUpdate: true });
  if (url.pathname.endsWith('/skills')) return json({ skills: [] });
  if (url.pathname.endsWith('/note-results')) return json({ notes: [] });
  if (url.pathname.endsWith('/manuscript.pdf')) return route.fulfill({ contentType: 'application/pdf', body: fs.readFileSync('tests/fixtures/outline.pdf') });
  if (url.pathname.endsWith('/manuscript/words')) return json(JSON.parse(fs.readFileSync('tests/fixtures/outline-words.json', 'utf8'))[Number(url.searchParams.get('page'))]);
  if (url.pathname.endsWith('/manuscript')) return json({ git, build: { status: 'ready', key: 'fixture', pages: [[612, 792], [612, 792]], builtAt: 1, current: true }, annotations: [] });
  if (url.pathname.endsWith('/git')) return json(git);
  if (url.pathname === '/api/indirect-changes') return json({ indirectChanges: false });
  if (url.pathname.endsWith('/git/fetch')) { fetches++; if (incoming) git = { ...git, behind: incoming }; return json({ git }); }
  if (url.pathname.endsWith('/git/overview')) { overviewRequests++; return json({ commits: [], worktrees: [], truncated: false }); }
  if (url.pathname.endsWith('/git/history')) return json({ versions: history, next: null });
  if (/\/git\/history\/[a-f0-9]+\/diff$/.test(url.pathname)) { historyDiffs++; return json({ path: 'main.tex', diff: '@@ -1 +1 @@\n-First draft\n+Historical result\n', truncated: false }); }
  if (/\/git\/history\/[a-f0-9]+$/.test(url.pathname)) return json({ version: history.find(version => url.pathname.endsWith(version.hash)), files: [{ path: 'main.tex', status: 'M' }] });
  if (url.pathname.endsWith('/git/restore')) { requests.push({ action: 'restore', ...route.request().postDataJSON() }); git = { ...git, ahead: git.ahead + 1, head: { hash: '2'.repeat(40), subject: 'Restore version: Add comparison results', date: Date.now() } }; history.unshift({ ...git.head, message: git.head.subject, author: 'Chen' }); return json({ git }); }
  if (url.pathname.endsWith('/git/diff')) {
    const path = url.searchParams.get('path'), scope = url.searchParams.get('scope');
    diffs.push({ path, scope });
    const both = git.files.find(file => file.path === path && file.staged && file.unstaged);
    return json({ path, diff: both ? (scope === 'staged' ? '@@ -1 +1 @@\n-Original.\n+Staged revision.\n' : '@@ -1 +1 @@\n-Staged revision.\n+Later revision.\n') : path === 'chapters/results.tex' ? longDiff : '@@ -1 +1 @@\n-Original.\n+Updated.\n', truncated: false });
  }
  if (url.pathname.endsWith('/git/stage')) {
    const body = route.request().postDataJSON(); stages.push(body);
    git = { ...git, files: git.files.map(file => body.paths.includes(file.path) ? { ...file, staged: body.stage, unstaged: !body.stage } : file) };
    return json({ git });
  }
  if (url.pathname.endsWith('/git/commit')) {
    const body = route.request().postDataJSON();
    requests.push({ action: 'commit', ...body });
    git = { ...git, files: git.files.filter(file => body.staged ? !file.staged : !body.paths.includes(file.path)), ahead: git.ahead + 1 };
    return json({ git, commit: 'def5678' });
  }
  if (url.pathname.endsWith('/git/sync')) {
    requests.push({ action: 'sync' });
    if (syncGate) await syncGate;
    if (syncFailure) return route.fulfill({ status: 400, json: { error: 'Remote rejected the push.' } });
    git = syncConflict ? { ...git, merging: { message: 'Merge origin/main', conflicts: ['main.tex'] }, files: [{ path: 'main.tex', status: 'U', staged: true, unstaged: true }] } : { ...git, ahead: 0, behind: 0, files: git.files.map(({ incoming, ...file }) => file) };
    return json({ git });
  }
  throw new Error('Unexpected Git panel request: ' + url.pathname);
});
const panel = page.getByRole('region', { name: 'Version Management', exact: true });
const showHistory = () => panel.locator('.git-detail-switcher').getByRole('button', { name: 'Version history', exact: true }).click();
const settings = page.locator('.settings-dialog');
async function openSettings() {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings.getByRole('button', { name: 'Git', exact: true }).click();
}
async function closeSettings() { await settings.getByRole('button', { name: 'Close', exact: true }).click(); }
async function syncFromMenu() {
  await panel.getByRole('button', { name: 'More commit actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sync', exact: true }).click();
}
try {
  await page.goto(origin);
  await page.locator('.manuscript-link').click();
  const pdfPage = page.locator('.pdfViewer .page').first();
  await pdfPage.waitFor();
  await page.locator('.git-link').click();
  await panel.getByRole('group', { name: 'Changes', exact: true }).waitFor();
  assert.equal(await panel.getByRole('region', { name: 'Commit graph' }).count(), 0);
  assert.equal(await panel.getByRole('region', { name: 'Worktrees' }).count(), 0);
  assert.equal(overviewRequests, 0, 'Hidden advanced views do not load or poll');
  assert.equal(await panel.getByRole('button', { name: /Settings/ }).count(), 0, 'The panel has no settings entry');
  const versions = panel.getByRole('region', { name: 'Version history', exact: true });
  await showHistory();
  await versions.getByRole('button', { name: /Add comparison results/ }).click();
  await expect(versions.locator('.git-version-message')).toContainText('Include the baseline');
  await versions.getByRole('button', { name: 'Restore this version', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Save current changes before restoring');
  await page.getByRole('dialog').getByRole('button', { name: 'Go to changes' }).click();
  await expect(panel.getByRole('textbox', { name: 'Commit message' })).toBeFocused();
  await versions.locator('.git-version-file').click();
  await expect(page.locator('.git-diff-view')).toContainText('Historical result');
  const historicalRequests = historyDiffs, liveRequests = diffs.length;
  await page.clock.fastForward(16000);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.git-diff-view')).toContainText('Historical result');
  assert.equal(historyDiffs, historicalRequests, 'Immutable historical diffs do not poll');
  assert.equal(diffs.length, liveRequests, 'Leaving the working-tree diff stops its refresh');
  // The dedicated workspace releases the PDF and its keyboard shortcuts.
  await expect(page.locator('.manuscript')).toHaveCount(0);
  const swallowed = await page.evaluate(() => {
    document.activeElement?.blur();
    return ['f', '=', '-', '0', 'h', ' '].map(key => {
      const event = new KeyboardEvent('keydown', { key, ctrlKey: !['h', ' '].includes(key), bubbles: true, cancelable: true });
      document.dispatchEvent(event);
      return event.defaultPrevented;
    });
  });
  assert.deepEqual(swallowed, [false, false, false, false, false, false]);
  await expect(page.locator('input[aria-label="Search the PDF"]')).toHaveCount(0);
  await page.locator('.manuscript-link').click();
  await expect(pdfPage).toBeVisible();
  assert.equal(await page.evaluate(() => {
    const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(event); return event.defaultPrevented;
  }), true);
  await page.getByRole('textbox', { name: 'Search the PDF', exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Search the PDF', exact: true }).press('Escape');
  await page.locator('.git-link').click();
  await showHistory();
  await expect(panel.getByRole('button', { name: 'Commit', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Sync', exact: true })).toHaveCount(0);
  const changes = panel.getByRole('group', { name: 'Changes', exact: true });
  const staged = panel.getByRole('group', { name: 'Staged changes', exact: true });
  const mainRow = changes.locator('li').filter({ has: page.getByRole('button', { name: 'main.tex', exact: true }) });
  await page.getByRole('textbox', { name: 'Commit message' }).hover();
  await expect(mainRow.locator('.git-row-actions')).toHaveCSS('opacity', '0');
  await mainRow.hover();
  await expect(mainRow.locator('.git-row-actions')).toHaveCSS('opacity', '1');
  await expect(mainRow.locator('.git-code')).toHaveText('↓M, M');
  await expect(mainRow.locator('.git-code')).toHaveAttribute('title', /Incoming: Modified.*Local: Modified/);
  await mainRow.getByRole('button', { name: 'Stage main.tex', exact: true }).hover();
  await panel.screenshot({ path: 'test-results/git-row-actions.png' });
  await mainRow.getByRole('button', { name: 'Stage main.tex', exact: true }).click();
  await staged.getByRole('button', { name: 'main.tex', exact: true }).waitFor();
  await expect(mainRow).toHaveCount(0);
  await staged.getByRole('button', { name: 'main.tex', exact: true }).click();
  await page.getByRole('region', { name: 'Changes in main.tex', exact: true }).getByText('Updated.', { exact: true }).waitFor();
  assert.deepEqual(diffs.at(-1), { path: 'main.tex', scope: 'staged' });
  await staged.getByRole('button', { name: 'Unstage main.tex', exact: true }).click();
  await expect(staged).toHaveCount(0);
  await expect.poll(() => diffs.at(-1)?.scope).toBe('unstaged');
  await expect(mainRow.getByRole('button', { name: 'main.tex', exact: true })).toHaveAttribute('aria-pressed', 'true');
  assert.deepEqual(stages, [{ paths: ['main.tex'], stage: true }, { paths: ['main.tex'], stage: false }]);
  // Both rows of a partly staged file show their own diff, never a combined one.
  git = { ...git, files: git.files.map(file => file.path === 'main.tex' ? { ...file, staged: true, unstaged: true } : file) };
  await panel.getByRole('button', { name: 'Refresh changes', exact: true }).click();
  await staged.getByRole('button', { name: 'main.tex', exact: true }).click();
  await page.locator('.git-diff-view').getByText('Staged revision.', { exact: true }).waitFor();
  await expect(page.locator('.git-diff-view').getByText('Later revision.', { exact: true })).toHaveCount(0);
  await mainRow.getByRole('button', { name: 'main.tex', exact: true }).click();
  await page.locator('.git-diff-view').getByText('Later revision.', { exact: true }).waitFor();
  await staged.getByRole('button', { name: 'Unstage main.tex', exact: true }).click();
  await expect(staged).toHaveCount(0);
  await panel.getByRole('button', { name: 'main.tex', exact: true }).click();
  await page.getByRole('region', { name: 'Changes in main.tex', exact: true }).getByText('Updated.', { exact: true }).waitFor();
  await expect(panel.locator('.git-panel .git-diff-view,.git-panel .git-diff-wrap')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'main.tex', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await panel.getByRole('button', { name: 'results.tex chapters', exact: true }).click();
  const sourceDiff = page.getByRole('region', { name: 'Changes in chapters/results.tex', exact: true });
  await sourceDiff.getByText('Updated result.', { exact: true }).waitFor();
  assert.ok(await sourceDiff.locator('.git-source-line').count() < 150, 'Long files only render the visible rows');
  await sourceDiff.getByRole('button', { name: 'Next change', exact: true }).click();
  await sourceDiff.getByText('Late updated result.', { exact: true }).waitFor();
  await expect(sourceDiff.locator('.git-diff-position')).toHaveText('2 / 2');
  await expect(panel.locator('.git-files > li')).toHaveCount(3);
  await page.screenshot({ path: 'test-results/git-diff-long.png' });
  await sourceDiff.getByRole('button', { name: 'Previous change', exact: true }).click();
  await sourceDiff.getByText('Updated result.', { exact: true }).waitFor();
  await sourceDiff.locator('.git-source-scroll').press('Escape');
  await expect(page.locator('.git-diff-view')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'results.tex chapters', exact: true })).toBeFocused();
  await panel.screenshot({ path: 'test-results/git-simple-desktop.png' });
  await syncFromMenu();
  await panel.getByRole('status').filter({ hasText: 'Synced with the remote.' }).waitFor();
  assert.deepEqual(requests, [{ action: 'sync' }]); assert.equal(git.files.length, 3);
  await panel.getByRole('textbox', { name: 'Commit message' }).fill('Revise the paper');
  await panel.getByRole('button', { name: 'More commit actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Commit and sync', exact: true }).waitFor();
  assert.equal(await page.getByRole('menuitem', { name: 'Commit (Amend)', exact: true }).count(), 0);
  assert.equal(await page.getByRole('menuitem', { name: 'Commit and push', exact: true }).count(), 0);
  let releaseSync;
  syncGate = new Promise(resolve => { releaseSync = resolve; });
  await page.getByRole('menuitem', { name: 'Commit and sync', exact: true }).click();
  await panel.getByText('Syncing…', { exact: true }).waitFor();
  await expect(panel.getByRole('button', { name: 'Syncing…', exact: true })).toBeDisabled();
  await expect(panel.locator('.git-commit-button')).toHaveCount(1);
  releaseSync(); syncGate = null;
  await panel.getByRole('status').filter({ hasText: 'Committed def5678 and synced.' }).waitFor();
  assert.deepEqual(requests.slice(-2), [{ action: 'commit', message: 'Revise the paper', paths: files.map(f => f.path) }, { action: 'sync' }]);
  await panel.locator('.git-panel').getByText('No uncommitted changes', { exact: true }).waitFor();
  await expect(panel.getByRole('button', { name: 'Synced', exact: true })).toBeDisabled();
  // Remote-only changes become the primary action without a manual refresh.
  const beforeFetch = fetches;
  incoming = 2;
  await page.clock.fastForward(61_000);
  await expect.poll(() => fetches).toBeGreaterThan(beforeFetch);
  await expect(panel.getByRole('button', { name: 'Sync', exact: true })).toContainText('↓2');
  incoming = 0;
  await panel.getByRole('button', { name: 'Sync', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Synced', exact: true })).toBeDisabled();
  await page.clock.resume();
  // A plain commit changes that same button into Sync for outgoing commits.
  git = { ...git, files: structuredClone(files) };
  await panel.getByRole('button', { name: 'Refresh changes', exact: true }).click();
  await panel.getByRole('button', { name: 'main.tex', exact: true }).click();
  await expect(page.locator('.git-diff-view')).toBeVisible();
  await panel.getByRole('textbox', { name: 'Commit message' }).fill('Local revision');
  await panel.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(page.locator('.git-diff-view')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Sync', exact: true })).toContainText('↑1');
  await panel.getByRole('button', { name: 'Sync', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Synced', exact: true })).toBeDisabled();

  await openSettings();
  const advanced = settings.getByRole('switch', { name: 'Show advanced Git features', exact: true });
  assert.equal(await advanced.isChecked(), false);
  await advanced.check();
  await settings.screenshot({ path: 'test-results/git-app-settings.png' });
  await closeSettings();
  await showHistory();
  await panel.getByRole('region', { name: 'Commit graph', exact: true }).waitFor();
  await panel.getByRole('region', { name: 'Worktrees', exact: true }).waitFor();
  // A local repository read timing out is not evidence of a network failure.
  const graph = panel.getByRole('region', { name: 'Commit graph', exact: true });
  await expect(graph.getByText('No commits yet', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const timeout = AbortSignal.timeout;
    window.__restoreGitOverviewTimeout = () => { AbortSignal.timeout = timeout; };
    AbortSignal.timeout = wait => wait === 60000
      ? AbortSignal.abort(new DOMException('Timed out', 'TimeoutError')) : timeout.call(AbortSignal, wait);
  });
  await graph.getByRole('button', { name: 'Refresh worktrees and history', exact: true }).click();
  await expect(graph.getByRole('alert')).toContainText('The request timed out. Please try again.');
  await expect(graph.getByRole('alert')).toContainText('Showing the last update.');
  await expect(graph.getByRole('alert')).not.toContainText(/network/i);
  await expect(graph.getByText('No commits yet', { exact: true })).toBeVisible();
  await page.evaluate(() => { window.__restoreGitOverviewTimeout(); delete window.__restoreGitOverviewTimeout; });
  await graph.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(graph.getByRole('alert')).toHaveCount(0);
  await page.reload();
  await page.locator('.git-link').click();
  await panel.getByRole('region', { name: 'Commit graph', exact: true }).waitFor();
  git = { ...git, files: [{ ...files[0], staged: true, unstaged: false }, files[1]] };
  await panel.getByRole('button', { name: 'Refresh changes', exact: true }).click();
  await panel.getByRole('group', { name: 'Staged changes', exact: true }).waitFor();
  await panel.getByRole('textbox', { name: 'Commit message' }).fill('Refine the last revision');
  await panel.getByRole('button', { name: 'More commit actions', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Commit and push', exact: true })).toBeEnabled();
  await page.getByRole('menuitem', { name: 'Commit (Amend)', exact: true }).click();
  await panel.getByRole('status').filter({ hasText: 'Committed def5678.' }).waitFor();
  assert.deepEqual(requests.at(-1), { action: 'commit', message: 'Refine the last revision', staged: true, amend: true });
  await expect(panel.locator('.git-files > li')).toHaveCount(1);
  await panel.getByRole('button', { name: 'results.tex chapters', exact: true }).waitFor();
  await openSettings(); await expect(advanced).toBeChecked(); await advanced.uncheck(); await closeSettings();
  await expect(panel.getByRole('region', { name: 'Commit graph', exact: true })).toHaveCount(0);

  // Sync failures retain the completed commit and clear only its message draft.
  git = { ...git, ahead: 0, files: structuredClone(files) }; syncFailure = true;
  await panel.getByRole('button', { name: 'Refresh changes', exact: true }).click();
  await panel.getByRole('textbox', { name: 'Commit message' }).fill('Commit before rejection');
  await panel.getByRole('button', { name: 'More commit actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Commit and sync', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'Remote rejected the push.' }).waitFor();
  await expect(panel.getByRole('textbox', { name: 'Commit message' })).toHaveValue('');
  await panel.locator('.git-panel').getByText('No uncommitted changes', { exact: true }).waitFor();
  assert.equal(git.ahead, 1);
  syncFailure = false; await panel.getByRole('button', { name: 'Sync', exact: true }).click();
  await panel.getByRole('status').filter({ hasText: 'Synced with the remote.' }).waitFor();

  // Conflict recovery stays available even with advanced views hidden.
  syncConflict = true;
  await syncFromMenu();
  await panel.getByRole('group', { name: 'Merge in progress', exact: true }).waitFor();
  await expect(panel.getByRole('button', { name: 'Abort merge', exact: true })).toBeEnabled();
  await expect(panel.getByRole('status')).toHaveClass(/git-warning/);
  await expect(panel.getByRole('region', { name: 'Commit graph', exact: true })).toHaveCount(0);
  syncConflict = false;
  git = { ...git, merging: null, files: structuredClone(files), remote: false, upstream: null };
  await panel.getByRole('button', { name: 'Refresh changes', exact: true }).click();
  await panel.getByRole('button', { name: 'More commit actions', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Sync', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  git = { ...git, files: [], remote: true, upstream: 'origin/main', ahead: 0, behind: 0 };
  await panel.getByRole('button', { name: 'Refresh changes', exact: true }).click();
  await showHistory();
  await versions.getByRole('button', { name: /Add comparison results/ }).click();
  await versions.getByRole('button', { name: 'Restore this version', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore this version', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(versions.getByRole('button', { name: /Restore version: Add comparison results/ })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Sync', exact: true })).toBeEnabled();
  assert.deepEqual(requests.at(-1), { action: 'restore', hash: '1'.repeat(40), head: 'abc1234'.padEnd(40, '0') });
  git = { ...git, files: structuredClone(files) };
  await context.addInitScript(() => localStorage.setItem('papilot:language', 'zh-CN'));
  await page.reload();
  await page.locator('.git-link').click();
  const chinesePanel = page.locator('.git-panel');
  await chinesePanel.getByRole('button', { name: '提交', exact: true }).waitFor();
  await chinesePanel.screenshot({ path: 'test-results/git-simple-zh.png' });
  for (const width of [900, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await chinesePanel.screenshot({ path: `test-results/git-simple-${width}.png` });
    assert.ok(await chinesePanel.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Git panel fits at ' + width);
  }
  await chinesePanel.getByRole('button', { name: 'results.tex chapters', exact: true }).click();
  await expect(page.locator('.git-diff-view')).toBeVisible();
  await expect(chinesePanel).toBeVisible();
  await page.locator('.git-diff-view').getByRole('button', { name: '下一处改动', exact: true }).click();
  await page.locator('.git-diff-view').getByText('Late updated result.', { exact: true }).waitFor();
  await page.screenshot({ path: 'test-results/git-diff-phone.png' });
  await page.getByRole('button', { name: '返回文件列表', exact: true }).click();
  await expect(chinesePanel).toBeVisible();
  assert.deepEqual(errors, []);
  console.log('PASS: Git settings, basic/advanced views, commit/sync, failure recovery and responsive layout');
} finally { await browser.close(); await server.close(); }
