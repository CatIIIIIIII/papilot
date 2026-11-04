import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
fs.mkdirSync('test-results', { recursive: true });
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from '../engine/node_modules/@playwright/test/index.mjs';
import { selectOption, selectedValue } from './select.mjs';

const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const context = await browser.newContext({ locale: 'en-US', colorScheme: 'light', viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await page.clock.install();
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
const task = { id: 'fixture-task-0001', projectId: 'fixture-paper', name: 'p-fixture', title: 'Clarify the introduction', instructions: 'Keep the technical meaning.', worktree: '/tmp/fixture', threadId: null, turnId: null, model: null, status: 'reviewing', createdAt: 1, updatedAt: 1, feedbackCursor: 0, error: null, review: { state: 'reviewing', round: 1, counts: { pending: 3, commented: 1 } } };
const snapshot = { version: 'test', csrf: 'fixture', projects: [{ id: task.projectId, name: 'Example paper', path: '/tmp/fixture', createdAt: 1 }], tasks: [task], requests: [], runtime: { connected: true, authenticated: true, account: null, error: null, models: [{ id: 'fast-model', name: 'Fast model', isDefault: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }, { id: 'deep-model', name: 'Deep model', isDefault: false, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', fastMode: { serviceTier: 'priority', description: '2x speed, increased usage' } }], usage: { plan: 'pro', windows: [{ usedPercent: 83, minutes: 10080, resetsAt: Date.now() + 3 * 86_400_000 }], credits: { unlimited: false, balance: 12418.76 }, reached: false } } };
// Claude is available with its own models; Antigravity is not installed.
snapshot.runtimes = { codex: snapshot.runtime, claude: { connected: true, authenticated: true, account: 'Claude Max', error: null, models: [{ id: 'opus', name: 'Opus 5.5', isDefault: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: null }, { id: 'haiku', name: 'Haiku 5.5', isDefault: false, efforts: ['low', 'medium', 'high'], defaultEffort: null }] }, antigravity: { connected: false, authenticated: false, account: null, error: 'spawn agy ENOENT', models: [] }, kimi: { installed: true, connected: false, authenticated: false, account: null, error: null, models: [] }, cursor: { installed: false, connected: false, authenticated: false, account: null, error: null, models: [] } };
const messages = [];
let diagnosticFailure = true;
let latexInstallation = { distribution: 'MacTeX', version: '2025', path: '/usr/local/texlive/2025' };
let latexFailure = false;
const diagnosticRequests = [];
const diagnosticReport = { version: '0.6.0', checkedAt: 1700000000000, platform: 'darwin', arch: 'arm64', node: '22.22.0', ok: false, checks: [
  { id: 'node', ok: true, severity: 'error', detail: 'Node.js 22.22.0', fix: null },
  { id: 'latexmk', ok: false, severity: 'error', detail: '/Users/private/bin/latexmk was not found.', fix: 'Install a full TeX distribution and add it to PATH.' },
  { id: 'agent.antigravity', ok: false, severity: 'warn', detail: 'Antigravity is not configured.', fix: 'Sign in to agy or choose another agent.' },
  { id: 'git', ok: true, severity: 'error', detail: 'Git is installed.', fix: null },
  { id: 'project.head', ok: false, severity: 'error', detail: 'The repository has no initial commit.', fix: 'Create the first Git commit.' },
  { id: 'synctex', ok: true, severity: 'warn', detail: 'SyncTeX is installed.', fix: null },
  { id: 'tex-engines', ok: true, severity: 'error', detail: 'pdfLaTeX, XeLaTeX, LuaLaTeX are installed.', fix: null },
  { id: 'project.main', ok: true, severity: 'error', detail: 'main.tex', fix: null },
  { id: 'project.engine', ok: true, severity: 'error', detail: 'XeLaTeX', fix: null },
  { id: 'project.git', ok: true, severity: 'error', detail: 'The paper is a Git repository.', fix: null },
  { id: 'project.worktrees', ok: true, severity: 'warn', detail: 'Task folders are writable.', fix: null },
] };
const creates = [];
let failCreate = true;
let createResult = task;
let heldState;
let stateStarted;
let releaseState;
let holdMessage;
let releaseMessage;
let stateFailure = false;
let itemsFailure = false;
let history = null;
let reviewFailure = false;
let reviewStarting = false;
let deleteFailure = false;
let archiveFailure = false;
const archives = [];
const deletions = [];
const renames = [];
const titleRequests = [];
const paperRenames = [];
const gitState = { remote: true, branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0, head: { hash: 'abc1234', subject: 'Draft the introduction', date: 1 }, files: [{ path: 'main.tex', status: 'M', staged: false, unstaged: true, lines: [2, 4] }, { path: 'notes.md', status: '?', staged: false, unstaged: true }] };
const originalGit = structuredClone(gitState);
let overviewFailure = false;
const overview = () => ({
  worktrees: [
    { path: '/tmp/fixture', branch: gitState.branch, head: gitState.head.hash, current: true, bare: false, status: gitState },
    { taskId: task.id, path: '/tmp/paper-tasks/revise-introduction', branch: 'review/introduction', head: 'bbb2222', current: false, bare: false, locked: 'Proposal in progress', status: { branch: 'review/introduction', upstream: null, ahead: 0, behind: 0, head: { hash: 'bbb2222', subject: 'Explain the contribution', date: 2 }, files: [{ path: 'sections/introduction.tex', status: 'M', staged: true, unstaged: true }, { path: 'references.bib', status: '?', staged: false, unstaged: true }] } },
    { path: '/tmp/paper-tasks/experiment', branch: null, head: 'ccc3333', current: false, bare: false, status: { branch: null, upstream: null, ahead: 0, behind: 0, head: { hash: 'ccc3333', subject: 'Try another proof', date: 2 }, files: [] } },
    { path: '/tmp/paper-tasks/removed', branch: 'old-proposal', head: 'aaa0000', current: false, bare: false, status: null, prunable: 'gitdir file points to non-existent location', error: 'Could not read this worktree.' },
  ],
  commits: [
    { hash: gitState.head.hash, parents: ['aaa1110', 'bbb2222'], subject: gitState.head.subject, author: 'Cui Chen', date: 1720000000000, refs: ['main'] },
    { hash: 'bbb2222', parents: ['aaa0000'], subject: 'Explain the contribution', author: 'Cui Chen', date: 1719990000000, refs: ['review/introduction'] },
    { hash: 'aaa1110', parents: ['aaa0000'], subject: 'Refine the abstract', author: 'Cui Chen', date: 1719980000000, refs: [], remotes: ['origin/main'] },
    { hash: 'ccc3333', parents: ['aaa0000'], subject: 'Try another proof', author: 'Cui Chen', date: 1719970000000, refs: [] },
    { hash: 'aaa0000', parents: [], subject: 'Initial manuscript', author: 'Cui Chen', date: 1719960000000, refs: [] },
  ], truncated: false,
});
const gitCommits = [], gitActions = [], gitIgnores = [], gitMessages = [], gitStages = [], gitDiscards = [];
const manuscriptBuild = { status: 'ready', key: 'fixture', pages: [[612, 792], [612, 792]], builtAt: 1, current: true };
let annotations = [];
const deletedNotes = new Map();
let failNoteCreate = false, failNoteEdit = false, failNoteDelete = false, failNoteRestore = false;
const noteSends = [];
const fixturePdf = fs.readFileSync('tests/fixtures/outline.pdf');
// The server's word places for the fixture PDF (tests/manuscript.test.ts keeps them current).
const fixtureWords = JSON.parse(fs.readFileSync('tests/fixtures/outline-words.json', 'utf8'));
const interruptions = [];
let reconnects = 0;
let reconnectFailure = false;
await context.addInitScript(() => localStorage.setItem('papilot:task', 'removed-task'));
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith('/note-results')) return route.fulfill({ json: { notes: [] } });
  const json = data => route.fulfill({ json: data });
  if (url.pathname === '/api/updates') return json({ currentVersion: snapshot.version, latestVersion: snapshot.version, phase: 'idle', checkedAt: 1, error: null, canUpdate: true });
  if (url.pathname === '/api/state') {
    if (stateFailure) return route.fulfill({ status: 503, json: { error: 'Host unavailable.' } });
    const captured = structuredClone(snapshot);
    if (heldState) { const hold = heldState; heldState = null; stateStarted?.(); await hold; }
    return json(captured);
  }
  if (url.pathname === '/api/reconnect') { reconnects++; return reconnectFailure ? route.fulfill({ status: 503, json: { error: 'Connection failed.' } }) : json({ ok: true }); }
  if (url.pathname === '/api/runtime/latex') return latexFailure ? route.fulfill({ status: 503, json: { error: 'Probe unavailable.' } }) : route.fulfill({ contentType: 'application/json', body: JSON.stringify(latexInstallation) });
  if (url.pathname === '/api/diagnostics') {
    diagnosticRequests.push(route.request().postDataJSON());
    return diagnosticFailure ? route.fulfill({ status: 503, json: { error: 'Probe unavailable.' } }) : json(diagnosticReport);
  }
  if (url.pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
  if (url.pathname.endsWith('/items') && itemsFailure) return route.fulfill({ status: 503, json: { error: 'Conversation temporarily unavailable.' } });
  if (url.pathname.endsWith('/items') && history) return json({ items: history });
  if (url.pathname.endsWith('/items')) return json({ items: [{ id: 'hello', taskId: task.id, type: 'assistant', text: 'The introduction is ready for review.', createdAt: 1 }] });
  if (url.pathname.endsWith('/git')) return json(gitState);
  if (url.pathname.endsWith('/git/overview')) return overviewFailure ? route.fulfill({ status: 503, json: { error: 'Repository unavailable.' } }) : json(overview());
  // Skills and the feedback bar have their own check (check-skills.mjs).
  if (url.pathname.endsWith('/skills')) return json({ skills: [] });
  if (url.pathname.endsWith('/git/diff')) return json({ path: url.searchParams.get('path'), diff: 'diff --git a/main.tex b/main.tex\n--- a/main.tex\n+++ b/main.tex\n@@ -1,2 +1,2 @@\n-Old line.\n+New line.\n Context.\n', truncated: false });
  if (url.pathname.endsWith('/git/commit')) {
    const body = route.request().postDataJSON(); gitCommits.push(body);
    Object.assign(gitState, { files: gitState.files.filter(file => body.staged ? !file.staged : !body.paths.includes(file.path)), ahead: gitState.ahead + 1, head: { hash: 'def5678', subject: body.message, date: 2 } });
    return json({ commit: 'def5678', git: gitState });
  }
  if (url.pathname.endsWith('/git/stage')) {
    const body = route.request().postDataJSON(); gitStages.push(body);
    for (const file of gitState.files) if (body.paths.includes(file.path)) Object.assign(file, { staged: body.stage, unstaged: !body.stage });
    return json({ git: gitState });
  }
  if (url.pathname.endsWith('/git/discard')) {
    const body = route.request().postDataJSON(); gitDiscards.push(body);
    gitState.files = gitState.files.filter(file => !body.paths.includes(file.path));
    return json({ git: gitState });
  }
  if (url.pathname.endsWith('/git/ignore')) {
    const body = route.request().postDataJSON(); gitIgnores.push(body);
    gitState.files = [...gitState.files.filter(file => !body.paths.includes(file.path)), { path: '.gitignore', status: '?', staged: false, unstaged: true }];
    return json({ git: gitState });
  }
  if (url.pathname.endsWith('/git/message')) { gitMessages.push(route.request().postDataJSON()); return json({ message: 'Tighten the introduction', agent: 'codex' }); }
  // A merge stops at a conflict in main.tex; the agent resolves it; the merge commits.
  if (url.pathname.endsWith('/git/merge')) {
    gitActions.push('merge');
    Object.assign(gitState, { files: [{ path: 'main.tex', status: 'U', staged: false }], merging: { message: "Merge branch 'main' of origin", conflicts: ['main.tex'] } });
    return json({ git: gitState });
  }
  if (url.pathname.endsWith('/git/resolve')) {
    gitActions.push(route.request().postDataJSON());
    gitState.merging = { ...gitState.merging, conflicts: [] };
    return json({ summary: 'Kept **both** openings.', remaining: [], agent: 'codex', git: gitState });
  }
  if (url.pathname.endsWith('/git/finish')) {
    gitActions.push('finish');
    Object.assign(gitState, { files: [], merging: null, ahead: 2, behind: 0, head: { hash: 'aaa1111', subject: "Merge branch 'main' of origin", date: 3 } });
    return json({ commit: 'aaa1111', git: gitState });
  }
  if (/\/git\/(fetch|pull|push)$/.test(url.pathname)) { const action = url.pathname.split('/').pop(); gitActions.push(action); if (action === 'push') gitState.ahead = 0; return json({ git: gitState }); }
  if (url.pathname.endsWith('/manuscript')) return json({ git: gitState, build: manuscriptBuild, annotations });
  if (url.pathname.endsWith('/delete') && url.pathname.includes('/annotations/')) {
    if (failNoteDelete) return route.fulfill({ status: 503, json: { error: 'Could not delete. Try again.' } });
    const id = url.pathname.split('/')[5]; deletedNotes.set(id, { note: annotations.find(note => note.id === id), index: annotations.findIndex(note => note.id === id) });
    annotations = annotations.filter(note => note.id !== id); return json({ ok: true });
  }
  if (url.pathname.endsWith('/restore') && url.pathname.includes('/annotations/')) {
    if (failNoteRestore) return route.fulfill({ status: 503, json: { error: 'Could not restore. Try again.' } });
    const removed = deletedNotes.get(url.pathname.split('/')[5]); annotations.splice(removed.index, 0, removed.note);
    return json({ annotations });
  }
  if (/\/annotations\/[^/]+$/.test(url.pathname)) {
    if (failNoteEdit) return route.fulfill({ status: 503, json: { error: 'Could not save. Try again.' } });
    const note = annotations.find(note => note.id === url.pathname.split('/')[5]);
    note.comment = route.request().postDataJSON().comment; return json(note);
  }
  if (url.pathname.endsWith('/annotations')) {
    if (failNoteCreate) return route.fulfill({ status: 503, json: { error: 'Could not save. Try again.' } });
    const body = route.request().postDataJSON();
    const note = { id: `note-${annotations.length + 1}`, projectId: task.projectId, quote: 'The marked fixture sentence.', ...body, source: { file: 'main.tex', lines: [10, 12], excerpt: 'The marked \\emph{fixture} sentence.' }, createdAt: 1 };
    annotations.push(note); return json(note);
  }
  if (url.pathname.endsWith('/manuscript.pdf')) return route.fulfill({ contentType: 'application/pdf', body: fixturePdf });
  if (url.pathname.endsWith('/manuscript/words')) return json(fixtureWords[Number(url.searchParams.get('page'))]);
  if (url.pathname.startsWith('/api/projects/') && url.pathname.endsWith('/rename')) { const id = url.pathname.split('/')[3], body = route.request().postDataJSON(); paperRenames.push({ id, ...body }); const paper = snapshot.projects.find(p => p.id === id); paper.name = body.name; return json(paper); }
  if (url.pathname.endsWith('/title')) { const id = url.pathname.split('/')[3]; titleRequests.push(id); const target = snapshot.tasks.find(t => t.id === id); target.titleGeneration = 'pending'; return json(target); }
  if (url.pathname.endsWith('/rename')) { const id = url.pathname.split('/')[3], body = route.request().postDataJSON(); renames.push({ id, ...body }); snapshot.tasks.find(t => t.id === id).title = body.title; return json(snapshot.tasks.find(t => t.id === id)); }
  if (url.pathname.endsWith('/interrupt')) { const id = url.pathname.split('/')[3]; interruptions.push(id); snapshot.tasks.find(t => t.id === id).status = 'interrupted'; return json({ ok: true }); }
  if (url.pathname.endsWith('/archive')) {
    if (archiveFailure) return route.fulfill({ status: 503, json: { error: 'Could not archive. Try again.' } });
    const id = url.pathname.split('/')[3], body = route.request().postDataJSON(); archives.push({ id, ...body });
    const target = snapshot.tasks.find(t => t.id === id);
    if (body.archived && body.finished && target.review?.state !== 'done') return json(target);
    target.archivedAt = body.archived ? Date.now() : null; return json(target);
  }
  if (url.pathname.endsWith('/delete')) {
    const id = url.pathname.split('/')[3];
    deletions.push({ id, body: route.request().postDataJSON() });
    if (deleteFailure) {
      snapshot.tasks.find(t => t.id === id).status = 'deleting';
      return route.fulfill({ status: 503, json: { error: 'The cleanup response was lost. Retry deletion to confirm it.' } });
    }
    snapshot.tasks = snapshot.tasks.filter(t => t.id !== id);
    return json({ deleted: true });
  }
  if (url.pathname.endsWith('/messages')) {
    messages.push(route.request().postDataJSON());
    if (holdMessage) await holdMessage;
    return json({ ok: true });
  }
  if (url.pathname === '/api/tasks' && route.request().method() === 'POST') {
    const body = route.request().postDataJSON();
    if (body.annotations?.length) {
      noteSends.push(body);
      const created = { ...task, id: body.id, name: 'p-notes', title: body.title, status: 'queued', review: null };
      snapshot.tasks.push(created); annotations = annotations.filter(note => !body.annotations.includes(note.id));
      return json(created);
    }
    creates.push(body);
    if (failCreate) return route.fulfill({ status: 503, json: { error: 'Connection lost. Try again.' } });
    if (!snapshot.tasks.some(t => t.id === createResult.id)) snapshot.tasks.push(createResult);
    return json(createResult);
  }
  throw new Error(`Unexpected fixture request: ${url.pathname}`);
});
await page.route('**/review/**', route => reviewFailure ? route.fulfill({ status: 503, json: { error: 'Review server unavailable.' } }) : reviewStarting ? route.fulfill({ contentType: 'text/html', body: '<html><head></head><body><div id="root"></div></body></html>' }) : route.fulfill({ contentType: 'text/html', body: '<html lang="en"><head></head><body><div class="bar">Review round 1</div><main id="paper"><h2>Introduction</h2><p>PDF review fixture</p></main></body></html>' }));

async function openDelete(title = task.title) {
  const show = page.getByRole('button', { name: 'Show task list', exact: true });
  // The drawer slides closed; check its open state rather than its in-transition visibility.
  const narrow = await page.evaluate(() => matchMedia('(max-width: 900px)').matches);
  if (narrow ? !(await page.locator('.sidebar.is-open').count()) : await show.count()) await show.click();
  await page.getByRole('button', { name: `Task actions for ${title}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete task…', exact: true }).click();
}

try {
  await page.goto(origin);
  await page.getByRole('textbox', { name: 'Describe the revision' }).waitFor();
  assert.equal(await page.locator('.host-status').count(), 0, 'A connected, idle host shows no status line');
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.getByRole('button', { name: /^Clarify the introduction/ }).click();
  await page.getByRole('textbox', { name: 'Instructions for Codex' }).waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.doesNotMatch(await page.locator('body').innerText(), /\p{Script=Han}/u);

  // Appearance changes live in both documents without losing a chat draft.
  const settingsButton = page.getByRole('button', { name: 'Settings', exact: true });
  const settingsDialog = page.locator('dialog').filter({ has: page.locator('.settings-dialog') });
  const closeSettings = async () => { await page.keyboard.press('Escape'); await settingsDialog.waitFor({ state: 'hidden' }); };
  const chooseTheme = async name => { await settingsButton.click(); await settingsDialog.getByRole('button', { name: 'Appearance', exact: true }).click(); await settingsDialog.getByRole('radio', { name, exact: true }).check(); await closeSettings(); };
  const themeIs = async value => {
    await page.waitForFunction(value => document.documentElement.dataset.theme === value, value);
    await page.frameLocator('.review-frame').locator(`html[data-theme="${value}"]`).waitFor();
  };
  await settingsButton.click();
  await page.clock.runFor(300);
  await page.screenshot({ path: 'test-results/settings-general-desktop.png' });
  for (const [label, file] of [['Appearance', 'appearance'], ['Notifications', 'notifications'], ['Keyboard shortcuts', 'shortcuts'], ['About Papilot', 'about']]) {
    await settingsDialog.getByRole('button', { name: label, exact: true }).click();
    assert.equal(await settingsDialog.locator('.settings-content').evaluate(el => el.scrollWidth > el.clientWidth), false);
    await page.screenshot({ path: `test-results/settings-${file}-desktop.png` });
  }
  await settingsDialog.getByRole('button', { name: 'Third-party licenses', exact: false }).click();
  await settingsDialog.getByRole('searchbox', { name: 'Search components or licenses' }).fill('react');
  await settingsDialog.getByText(/components$/, { exact: false }).waitFor();
  await page.screenshot({ path: 'test-results/settings-licenses-desktop.png' });
  await settingsDialog.getByRole('searchbox', { name: 'Search settings' }).fill('indirect');
  await settingsDialog.getByRole('button', { name: 'Review preferences', exact: true }).click();
  await settingsDialog.getByRole('switch', { name: 'Expand indirect changes' }).waitFor();
  await settingsDialog.getByRole('searchbox', { name: 'Search settings' }).fill('');
  await page.screenshot({ path: 'test-results/settings-review-desktop.png' });
  const runtimeGroup = settingsDialog.locator('.settings-category-group').filter({ has: page.getByRole('heading', { name: 'Runtime', exact: true }) });
  assert.deepEqual(await runtimeGroup.getByRole('button').allTextContents(), ['Agents', 'LaTeX']);
  await runtimeGroup.getByRole('button', { name: 'Agents', exact: true }).click();
  const diagnostics = settingsDialog;
  assert.equal(await diagnostics.locator('.runtime-advanced').count(), 0);
  assert.equal(await diagnostics.getByRole('button', { name: 'Copy diagnostic summary' }).count(), 0);
  await diagnostics.getByRole('button', { name: 'Codex details', exact: true }).click();
  await diagnostics.locator('.runtime-agent-detection').getByText('Installation & setup', { exact: true }).click();
  await diagnostics.getByRole('alert').waitFor();
  diagnosticFailure = false;
  await diagnostics.getByRole('button', { name: 'Check again', exact: true }).click();
  await diagnostics.getByText('No installation details were returned. Run the checks again to refresh.', { exact: true }).waitFor();
  await diagnostics.getByRole('button', { name: 'Close agent details' }).click();
  assert.deepEqual(diagnosticRequests, [{ projectId: task.projectId }, { projectId: task.projectId }]);
  assert.equal(await diagnostics.locator('.diagnostic-checks').count(), 0, 'Agent checks belong in their card details, without a second list');
  assert.equal(await diagnostics.getByRole('heading', { name: 'Agent configuration', exact: true }).count(), 0);
  assert.equal(await diagnostics.getByRole('button', { name: 'Check again', exact: true }).count(), 0);
  const agentCards = diagnostics.locator('.diagnostic-agent-card[data-agent]');
  assert.deepEqual(await agentCards.locator('h4').allTextContents(), ['Codex', 'Claude', 'Cursor', 'Copilot', 'Grok', 'Antigravity', 'Kimi', 'GLM', 'DeepSeek', 'Qwen', 'OpenCode']);
  const availability = id => diagnostics.locator(`[data-agent="${id}"] .diagnostic-availability`);
  assert.equal(await availability('codex').innerText(), 'Ready');
  assert.equal(await availability('cursor').innerText(), 'Not detected');
  assert.equal(await availability('antigravity').innerText(), 'Unavailable');
  assert.equal(await availability('kimi').innerText(), 'Connecting…');
  assert.equal(await availability('glm').innerText(), 'Unknown');
  snapshot.runtimes.claude.authenticated = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await availability('claude').getByText('Sign-in required', { exact: true }).waitFor();
  stateFailure = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await availability('codex').getByText('Unknown', { exact: true }).waitFor();
  assert.equal((await agentCards.locator('.diagnostic-availability').allTextContents()).every(value => value === 'Unknown'), true, 'Disconnected hosts cannot report stale availability');
  stateFailure = false; snapshot.runtimes.claude.authenticated = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await availability('claude').getByText('Ready', { exact: true }).waitFor();
  await diagnostics.locator('.settings-content').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: 'test-results/settings-agents-desktop.png' });
  assert.equal(await agentCards.locator('.brand-icon').count(), await agentCards.count());
  const agentDetail = diagnostics.locator('#runtime-agent-detail');
  const codexCard = diagnostics.getByRole('button', { name: 'Codex details', exact: true });
  const originalCatalog = snapshot.runtime.models;
  snapshot.runtime.models = [...originalCatalog, ...Array.from({ length: 6 }, (_, index) => ({ id: `research-${index}`, name: index === 5 ? 'Research model with a longer display name' : `Research model ${index + 1}`, isDefault: false, efforts: [], defaultEffort: null }))];
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await codexCard.click();
  await agentDetail.getByRole('button', { name: 'Show 2 more models', exact: true }).waitFor();
  assert.equal(await codexCard.evaluate(element => element === document.activeElement), true, 'Opening the drawer keeps focus on its trigger');
  assert.equal(await agentDetail.locator('.runtime-model-list li').count(), 6);
  assert.deepEqual((await agentDetail.locator('.runtime-model-list li>span').allTextContents()).slice(0, 2), ['Fast model', 'Deep model']);
  assert.equal(await agentDetail.locator('.runtime-model-list li').first().getAttribute('title'), 'fast-model');
  await agentDetail.getByRole('button', { name: 'Show 2 more models', exact: true }).click();
  assert.equal(await agentDetail.locator('.runtime-model-list li').count(), 8);
  assert.equal(await codexCard.getAttribute('aria-expanded'), 'true');
  assert.equal(await agentDetail.getByRole('meter').getAttribute('aria-valuenow'), '83');
  await agentDetail.getByText('12,418 credits', { exact: true }).waitFor();
  assert.equal(await agentDetail.getByText('papilot codex login', { exact: true }).isVisible(), false);
  await agentDetail.locator('.runtime-agent-detection').getByText('Installation & setup', { exact: true }).click();
  await agentDetail.getByText('papilot codex login', { exact: true }).waitFor();
  await agentDetail.locator('.runtime-agent-detection').getByText('Installation & setup', { exact: true }).click();
  assert.equal(await page.locator('dialog[open]').count(), 1, 'Agent details stay in the settings page');
  await diagnostics.locator('.settings-content').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: 'test-results/settings-agent-details-desktop.png', animations: 'disabled' });
  await agentDetail.getByRole('button', { name: 'Show fewer models', exact: true }).click();
  assert.equal(await agentDetail.locator('.runtime-model-list li').count(), 6);
  snapshot.runtime.models = originalCatalog;
  snapshot.runtime.usage.reached = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await availability('codex').getByText('Limit reached', { exact: true }).waitFor();
  snapshot.runtime.usage.reached = false;
  stateFailure = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await availability('codex').getByText('Unknown', { exact: true }).waitFor();
  assert.equal(await agentDetail.getByRole('meter').count(), 0, 'Disconnected agents must not show stale usage');
  assert.equal(await agentDetail.locator('.runtime-model-list').count(), 0, 'Disconnected agents must not show stale model availability');
  stateFailure = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await agentDetail.getByRole('meter').waitFor();
  await agentDetail.locator('#runtime-agent-title').focus();
  await page.keyboard.press('Escape');
  assert.equal(await agentDetail.count(), 0);
  assert.equal(await codexCard.evaluate(element => element === document.activeElement), true);
  await diagnostics.getByRole('button', { name: 'Claude details', exact: true }).click();
  await agentDetail.getByText('Claude Max', { exact: true }).waitFor();
  await agentDetail.getByText('Usage not reported', { exact: true }).waitFor();
  await diagnostics.getByRole('button', { name: 'Antigravity details', exact: true }).click();
  await agentDetail.locator('.runtime-agent-help').getByText('spawn agy ENOENT', { exact: true }).waitFor();
  await agentDetail.locator('.runtime-agent-detection').getByText('Installation & setup', { exact: true }).click();
  await agentDetail.getByText('Antigravity is not configured.', { exact: true }).waitFor();
  await agentDetail.locator('.runtime-agent-detection').getByText('Warning', { exact: true }).waitFor();
  await agentDetail.locator('.runtime-agent-detection .diagnostic-fix').filter({ hasText: 'Sign in to agy or choose another agent.' }).waitFor();
  await agentDetail.getByRole('button', { name: 'Close agent details' }).click();

  await diagnostics.getByRole('button', { name: 'Cursor details', exact: true }).click();
  await agentDetail.getByText('Cursor SDK credentials were not detected.', { exact: true }).waitFor();
  await page.screenshot({ path: 'test-results/settings-agent-setup-desktop.png', animations: 'disabled' });
  await agentDetail.locator('.runtime-agent-detection').getByText('Installation & setup', { exact: true }).click();
  await agentDetail.getByText(/The last connection attempt found neither CURSOR_API_KEY/).waitFor();
  await agentDetail.getByText(/An environment variable set in a new terminal/).waitFor();
  await agentDetail.locator('.runtime-agent-detection').getByText('Installation & setup', { exact: true }).click();
  const reconnectsBeforeSetup = reconnects;
  reconnectFailure = true;
  await agentDetail.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await agentDetail.getByRole('alert').waitFor();
  assert.equal(reconnects, reconnectsBeforeSetup + 1);
  reconnectFailure = false;
  const originalCursor = snapshot.runtimes.cursor;
  snapshot.runtimes.cursor = { ...originalCursor, installed: true, connected: true, authenticated: true, account: 'SDK account', models: [{ id: 'auto', name: 'Auto', isDefault: true, efforts: [], defaultEffort: null }] };
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/diagnostics')), agentDetail.getByRole('button', { name: 'Reconnect', exact: true }).click()]);
  await availability('cursor').getByText('Ready', { exact: true }).waitFor();
  await agentDetail.locator('.runtime-agent-header').getByText('SDK account', { exact: true }).waitFor();
  await agentDetail.locator('.runtime-model-list').getByText('Auto', { exact: true }).waitFor();
  assert.equal(await agentDetail.locator('.runtime-agent-help').count(), 0);
  assert.equal(reconnects, reconnectsBeforeSetup + 2);
  snapshot.runtimes.cursor = originalCursor;
  await agentDetail.getByRole('button', { name: 'Close agent details' }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await availability('cursor').getByText('Not detected', { exact: true }).waitFor();
  snapshot.runtimes.copilot = { installed: false, connected: false, authenticated: false, account: null, error: null, models: [] };
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await availability('copilot').getByText('Not detected', { exact: true }).waitFor();
  await diagnostics.getByRole('button', { name: 'Copilot details', exact: true }).click();
  await agentDetail.getByText('copilot was not found by Papilot.', { exact: true }).waitFor();
  await agentDetail.getByText('copilot login', { exact: true }).waitFor();
  await agentDetail.locator('.runtime-agent-detection').getByText('Installation & setup', { exact: true }).click();
  await agentDetail.getByText(/PAPILOT_COPILOT_BIN/).waitFor();
  await page.screenshot({ path: 'test-results/copilot-setup.png', animations: 'disabled' });
  await agentDetail.getByRole('button', { name: 'Close agent details' }).click();
  snapshot.runtimes.grok = { installed: false, connected: false, authenticated: false, account: null, error: null, models: [] };
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await availability('grok').getByText('Not detected', { exact: true }).waitFor();
  await diagnostics.getByRole('button', { name: 'Grok details', exact: true }).click();
  await agentDetail.getByText('grok was not found by Papilot.', { exact: true }).waitFor();
  await agentDetail.getByText('grok login', { exact: true }).waitFor();
  await agentDetail.locator('.runtime-agent-detection').getByText('Installation & setup', { exact: true }).click();
  await agentDetail.getByText(/PAPILOT_GROK_BIN/).waitFor();
  await page.screenshot({ path: 'test-results/grok-setup.png', animations: 'disabled' });
  await agentDetail.getByRole('button', { name: 'Close agent details' }).click();
  const checksBeforeLatex = diagnosticRequests.length;
  await diagnostics.getByRole('button', { name: 'LaTeX', exact: true }).click();
  await diagnostics.getByRole('heading', { name: 'MacTeX', exact: true }).waitFor();
  const installation = diagnostics.getByRole('region', { name: 'LaTeX installation' });
  await installation.getByText('2025', { exact: true }).waitFor();
  await installation.getByText('/usr/local/texlive/2025', { exact: true }).waitFor();
  assert.equal(await diagnostics.locator('.runtime-advanced').count(), 0);
  assert.equal(await diagnostics.getByRole('button', { name: 'Copy diagnostic summary' }).count(), 0);
  assert.equal(diagnosticRequests.length, checksBeforeLatex, 'LaTeX only reads installation information');
  await diagnostics.locator('.settings-content').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ animations: 'disabled', path: 'test-results/settings-latex-desktop.png' });
  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await diagnostics.locator('.settings-content').evaluate(el => el.scrollWidth > el.clientWidth), false);
  await page.screenshot({ animations: 'disabled', path: 'test-results/settings-latex-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await diagnostics.locator('.settings-content').evaluate(el => { el.scrollTop = 0; });
  const installedLatex = latexInstallation;
  latexInstallation = null;
  await installation.getByRole('button', { name: 'Detect again' }).click();
  await installation.getByText('No LaTeX installation was detected on this host.', { exact: true }).waitFor();
  latexFailure = true;
  await installation.getByRole('button', { name: 'Detect again' }).click();
  await installation.getByRole('alert').waitFor();
  latexFailure = false;
  latexInstallation = { distribution: 'TeX Live', version: '2026', path: '/a/long/installation/location/texlive/2026' };
  await installation.getByRole('button', { name: 'Detect again' }).click();
  await installation.getByRole('heading', { name: 'TeX Live', exact: true }).waitFor();
  latexInstallation = installedLatex;
  await diagnostics.getByRole('button', { name: 'Agents', exact: true }).click();
  await diagnostics.getByRole('button', { name: 'General', exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'General');
  await selectOption(settingsDialog.getByRole('combobox', { name: 'Language', exact: true }), 'zh-Hans');
  await settingsDialog.getByRole('button', { name: '外观', exact: true }).click();
  await settingsDialog.getByRole('radio', { name: '深色', exact: true }).check();
  await page.getByRole('button', { name: '智能体', exact: true }).click();
  await diagnostics.getByRole('button', { name: 'Codex 详情', exact: true }).waitFor();
  await page.screenshot({ path: 'test-results/settings-diagnostics-dark.png' });
  await page.setViewportSize({ width: 320, height: 740 });
  assert.equal(await page.locator('.settings-dialog').evaluate(el => el.scrollWidth > el.clientWidth), false);
  await page.screenshot({ path: 'test-results/settings-diagnostics-mobile.png' });
  await diagnostics.getByRole('button', { name: 'Codex 详情', exact: true }).click();
  await agentDetail.getByRole('meter').waitFor();
  assert.equal(await diagnostics.locator('.settings-content').evaluate(el => el.scrollWidth > el.clientWidth), false);
  await page.screenshot({ path: 'test-results/settings-agent-details-mobile.png', animations: 'disabled' });
  await agentDetail.getByRole('button', { name: '关闭智能体详情' }).click();
  await page.locator('dialog[open]').getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: /关于 Papilot/ }).click();
  assert.equal(await page.getByRole('link', { name: /更新日志/ }).getAttribute('href'), 'https://github.com/PapilotAI/papilot/blob/main/CHANGELOG.md');
  assert.equal(await page.getByRole('link', { name: /参与贡献/ }).getAttribute('href'), 'https://github.com/PapilotAI/papilot/blob/main/.github/CONTRIBUTING.md');
  await page.screenshot({ path: 'test-results/settings-about-links-mobile.png' });
  await page.locator('dialog[open]').getByRole('button', { name: '设置', exact: true }).click();
  await settingsDialog.getByRole('button', { name: '外观', exact: true }).click();
  await settingsDialog.getByRole('radio', { name: '跟随系统', exact: true }).check();
  await settingsDialog.getByRole('button', { name: '设置', exact: true }).click();
  await settingsDialog.getByRole('button', { name: '通用', exact: true }).click();
  await selectOption(settingsDialog.getByRole('combobox', { name: '语言', exact: true }), 'system');
  await closeSettings();
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log('PASS: Agent diagnostics retry, LaTeX installation, translated mobile layout, changelog and contribution links');
  await page.getByRole('textbox', { name: 'Instructions for Codex' }).fill('Preserve this draft while changing appearance.');
  await page.emulateMedia({ colorScheme: 'dark' });
  await themeIs('dark');
  await chooseTheme('Light');
  await themeIs('light');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await themeIs('light');
  await chooseTheme('Dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await themeIs('dark');
  assert.equal(await page.getByRole('textbox', { name: 'Instructions for Codex' }).inputValue(), 'Preserve this draft while changing appearance.');
  assert.equal(await page.locator('.main').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(38, 39, 43)');
  assert.equal(await page.locator('html').evaluate(el => getComputedStyle(el).colorScheme), 'dark');
  await page.reload();
  await settingsButton.click();
  await settingsDialog.getByRole('button', { name: 'Appearance', exact: true }).click();
  assert.equal(await settingsDialog.getByRole('radio', { name: 'Dark', exact: true }).isChecked(), true);
  await closeSettings();
  assert.equal(await settingsButton.evaluate(el => document.activeElement === el), true, 'Closing Settings returns focus to its button');
  await page.getByRole('button', { name: /^Clarify the introduction/ }).click();
  await themeIs('dark');
  await page.getByRole('textbox', { name: 'Instructions for Codex' }).fill('');
  await chooseTheme('System');
  await themeIs('light');
  console.log('PASS: System appearance, explicit overrides, saved preference, live review theme and draft preservation');

  // The interface language switches live, reloads the review in it, and keeps the draft.
  await page.getByRole('textbox', { name: 'Instructions for Codex' }).fill('Keep this draft across languages.');
  await settingsButton.click();
  await selectOption(settingsDialog.getByRole('combobox', { name: 'Language' }), 'zh-Hans');
  await page.getByRole('dialog', { name: '设置' }).getByText('外观', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-Hans');
  await page.getByRole('button', { name: '设置', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '给 Codex 的指令' }).inputValue(), 'Keep this draft across languages.');
  await page.waitForFunction(() => document.querySelector('.review-frame')?.getAttribute('src')?.endsWith('&lang=zh-Hans'));
  assert.match(await page.getByRole('link', { name: '在新标签页中打开审阅' }).getAttribute('href'), /&lang=zh-Hans$/);
  await page.reload();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await selectOption(page.getByRole('dialog', { name: '设置' }).getByRole('combobox', { name: '语言' }), 'zh-Hant');
  const hant = JSON.parse(fs.readFileSync('src/web/locales/zh-Hant.json', 'utf8'));
  await page.getByRole('dialog', { name: hant.Settings }).getByRole('combobox', { name: hant.Language }).waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-Hant');
  await page.keyboard.press('Escape');
  await page.locator('.task-link').filter({ hasText: 'Clarify the introduction' }).click();
  await page.waitForFunction(() => document.querySelector('.review-frame')?.getAttribute('src')?.endsWith('&lang=zh-Hant'));
  await page.screenshot({ path: 'test-results/i18n-workspace-zh-Hant.png', fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: hant.Settings, exact: true }).click();
  await selectOption(page.getByRole('dialog', { name: hant.Settings }).getByRole('combobox', { name: hant.Language }), 'system');
  await settingsDialog.waitFor();
  await closeSettings();
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  await page.getByRole('button', { name: /^Clarify the introduction/ }).click();
  await page.getByRole('textbox', { name: 'Instructions for Codex' }).fill('');
  console.log('PASS: Live interface language, saved choice, translated review address and draft preservation');

  // Notifications: each scenario can be muted, independently of the master switch.
  await context.grantPermissions(['notifications'], { origin });
  await page.evaluate(() => {
    window.shown = [];
    window.Notification = class { static permission = 'granted'; static requestPermission = async () => 'granted'; constructor(title, options) { window.shown.push({ title, body: options.body, tag: options.tag }); } close() {} };
  });
  await settingsButton.click();
  await settingsDialog.getByRole('button', { name: 'Notifications', exact: true }).click();
  const notifySwitch = settingsDialog.getByRole('switch', { name: 'Notifications' });
  assert.equal(await notifySwitch.isChecked(), false);
  for (const name of ['Input needed', 'Approval requests', 'Review ready', 'Task finished', 'Task errors']) {
    assert.equal(await selectedValue(settingsDialog.getByRole('combobox', { name, exact: true })), 'push');
  }
  const reviewNotifications = settingsDialog.getByRole('combobox', { name: 'Review ready', exact: true });
  await selectOption(reviewNotifications, 'off');
  await notifySwitch.check();
  await settingsDialog.getByRole('button', { name: 'Send a test notification' }).click();
  await settingsDialog.getByText(/^Sent\./).waitFor();
  await closeSettings();
  await page.evaluate(() => { document.hasFocus = () => false; });
  const fixtureTask = snapshot.tasks.find(t => t.id === task.id);
  fixtureTask.status = 'building';
  await page.clock.runFor(3000);
  await page.getByRole('button', { name: /^Clarify the introduction/ }).getByText('Preparing task results').waitFor();
  fixtureTask.status = 'reviewing';
  await page.clock.runFor(3000);
  assert.equal(await page.evaluate(() => window.shown.length), 1, 'A muted review does not notify');
  fixtureTask.status = 'failed';
  await page.clock.runFor(3000);
  await page.waitForFunction(() => window.shown.length === 2);
  assert.equal((await page.evaluate(() => window.shown))[1].title, 'A task needs attention', 'Other scenarios still notify');
  await page.evaluate(() => { delete document.hasFocus; });
  await settingsButton.click();
  await settingsDialog.getByRole('button', { name: 'Notifications', exact: true }).click();
  await notifySwitch.uncheck();
  await notifySwitch.check();
  assert.equal(await selectedValue(reviewNotifications), 'off', 'The master switch preserves scenario choices');
  await selectOption(reviewNotifications, 'push');
  await closeSettings();
  await page.evaluate(() => { document.hasFocus = () => false; });
  fixtureTask.status = 'building';
  await page.clock.runFor(3000);
  await page.getByRole('button', { name: /^Clarify the introduction/ }).getByText('Preparing task results').waitFor();
  fixtureTask.status = 'reviewing';
  await page.clock.runFor(3000);
  await page.waitForFunction(() => window.shown.length === 3);
  assert.deepEqual((await page.evaluate(() => window.shown))[2], { title: 'Review ready · 3 changes to decide', body: 'Clarify the introduction', tag: 'papilot:fixture-task-0001' });
  await page.evaluate(() => { delete document.hasFocus; });
  await settingsButton.click();
  await settingsDialog.getByRole('button', { name: 'Notifications', exact: true }).click();
  await selectOption(reviewNotifications, 'off');
  await page.reload();
  await settingsButton.click();
  await settingsDialog.getByRole('button', { name: 'Notifications', exact: true }).click();
  assert.equal(await notifySwitch.isChecked(), true);
  assert.equal(await selectedValue(reviewNotifications), 'off', 'Scenario choices survive reloads');
  // A change from another tab is reflected without reloading this one.
  const preferencesTab = await context.newPage();
  await preferencesTab.goto(`${origin}/favicon.png`);
  await preferencesTab.evaluate(() => localStorage.removeItem('papilot:notifications:review'));
  await page.waitForFunction(() => document.querySelector('[role="combobox"][aria-label="Review ready"]').dataset.value === 'push');
  await preferencesTab.close();
  await page.screenshot({ path: 'test-results/settings-notifications-enabled-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await settingsDialog.locator('.settings-content').evaluate(el => el.scrollWidth > el.clientWidth), false);
  assert.equal(await settingsDialog.locator('.settings-notification-event').first().evaluate(el => getComputedStyle(el).flexDirection), 'row');
  await page.screenshot({ path: 'test-results/settings-notifications-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await notifySwitch.uncheck();
  await closeSettings();
  await page.reload();
  await page.getByRole('button', { name: /^Clarify the introduction/ }).click();
  console.log('PASS: Notification scenarios, background filtering, master switch, persistence and cross-tab sync');

  const switcher = page.getByRole('button', { name: 'Paper: Example paper', exact: true });
  await switcher.click();
  await page.getByRole('menuitemradio', { name: 'Example paper', exact: true }).waitFor();
  assert.equal(await page.getByRole('menuitemradio', { name: 'Example paper', exact: true }).getAttribute('aria-checked'), 'true');
  await page.getByRole('menuitem', { name: 'Add paper…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a paper' });
  await dialog.waitFor();
  // The folder chooser leads; typing a path is a collapsed fallback.
  await expect(dialog.getByRole('button', { name: 'Choose folder', exact: true })).toBeFocused();
  for (let i = 0; i < 9; i++) {
    await page.keyboard.press(i < 5 ? 'Tab' : 'Shift+Tab');
    assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true);
  }
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await switcher.evaluate(el => el === document.activeElement), true);

  const paperName = page.getByRole('button', { name: 'Paper: Example paper', exact: true });
  await paperName.click();
  await page.getByRole('menuitem', { name: 'Edit ' + (await page.locator('.project-switcher-name').innerText()), exact: true }).click();
  let paperBox = page.getByRole('textbox', { name: 'Paper name', exact: true });
  assert.equal(await paperBox.evaluate(el => el === document.activeElement && el.selectionStart === 0 && el.selectionEnd === el.value.length), true);
  await paperBox.fill('Something else');
  await paperBox.press('Escape');
  await paperName.waitFor();
  assert.equal(paperRenames.length, 0);
  assert.equal(await paperName.evaluate(el => el === document.activeElement), true);
  await paperName.click();
  await page.getByRole('menuitem', { name: 'Edit ' + (await page.locator('.project-switcher-name').innerText()), exact: true }).click();
  paperBox = page.getByRole('textbox', { name: 'Paper name', exact: true });
  await paperBox.fill('  Small   Steps ');
  await paperBox.press('Enter');
  const renamedPaper = page.getByRole('button', { name: 'Paper: Small Steps', exact: true });
  await renamedPaper.waitFor();
  assert.deepEqual(paperRenames, [{ id: task.projectId, name: 'Small Steps' }]);
  assert.equal(await renamedPaper.evaluate(el => el === document.activeElement), true);
  await page.getByRole('button', { name: 'Paper: Small Steps', exact: true }).waitFor();
  await renamedPaper.click();
  await page.getByRole('menuitem', { name: 'Edit ' + (await page.locator('.project-switcher-name').innerText()), exact: true }).click();
  await page.getByRole('textbox', { name: 'Paper name', exact: true }).fill('Example paper');
  await page.getByRole('textbox', { name: 'Paper name', exact: true }).press('Enter');
  await paperName.waitFor();
  assert.equal(paperRenames.length, 2);
  console.log('PASS: Papers rename from the paper menu; Escape cancels and Enter saves the trimmed name');
  await page.locator('.manuscript-link').click();
  await page.getByRole('tab', { name: 'New task', exact: true }).click();
  const prompt = page.getByRole('textbox', { name: 'Describe the revision' });
  await prompt.waitFor();
  assert.equal(await page.getByRole('button', { name: 'Start task' }).isDisabled(), true);
  assert.equal(await page.getByRole('tab', { name: 'New task', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.getByRole('region', { name: 'PDF preview', exact: true }).isVisible(), true);
  assert.equal(await page.locator('.home').count(), 0);
  assert.equal(await page.getByText(/Proofread|Each task edits its own Git worktree/).count(), 0);
  await page.getByRole('button', { name: /^Clarify the introduction/ }).click();
  console.log('PASS: English UI, stale selection recovery, paper menu, modal focus containment, Escape, focus restoration, and the new-task composer');
  const views = page.locator('.view-selector');
  async function selectWorkspaceView(name) {
    await views.getByRole('button', { name, exact: true }).click();
    await page.waitForFunction(name => !document.documentElement.classList.contains('switching-workspace') && document.querySelector('.workspace-view-selector [aria-pressed=true]')?.getAttribute('aria-label') === name, name);
  }
  await selectWorkspaceView('Review');
  assert.equal(await page.getByRole('region', { name: 'PDF review', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('region', { name: 'Codex conversation', exact: true }).isVisible(), false);
  await selectWorkspaceView('Review');
  assert.equal(await views.getByRole('button', { name: 'Review', exact: true }).getAttribute('aria-pressed'), 'true');
  await selectWorkspaceView('Chat');
  assert.equal(await page.getByRole('region', { name: 'PDF review', exact: true }).isVisible(), false);
  await page.getByText('3 changes to review', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Open review', exact: true }).click();
  assert.equal(await views.getByRole('button', { name: 'Split', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('button', { name: 'Open review', exact: true }).count(), 0);
  assert.equal(await page.getByRole('region', { name: 'PDF review', exact: true }).isVisible(), true);
  assert.equal(await page.locator('.topbar').count(), 0);
  assert.equal((await page.locator('.task-grid').boundingBox()).y, 0, 'The task fills the space freed by the header');
  assert.equal(await page.locator('.panel-heading').getByRole('button', { name: 'Delete task', exact: true }).count(), 0);
  // The review's own tools are direct buttons beside the review toolbar, with no zoom box or menu.
  const reviewTools = page.locator('.review-tools');
  assert.equal(await reviewTools.getByRole('link', { name: 'Full PDF', exact: true }).getAttribute('href'), '/api/tasks/fixture-task-0001/pdf?round=1');
  assert.equal(await page.locator('.panel-tools').getByRole('link', { name: 'Open review in new tab', exact: true }).getAttribute('href'), '/review/fixture-paper/?task=p-fixture');
  assert.equal(await reviewTools.getByRole('button', { name: 'Regenerate PDF comparison', exact: true }).isDisabled(), false);
  assert.equal(await reviewTools.getByRole('button', { name: 'Annotation group color', exact: true }).count(), 1);
  assert.equal(await reviewTools.getByRole('button', { name: 'Review options' }).count(), 0);
  // Menus open from the keyboard on the first item and return focus on Escape.
  const taskMenu = page.getByRole('button', { name: `Task actions for ${task.title}`, exact: true });
  await taskMenu.focus(); await page.keyboard.press('ArrowDown');
  await page.getByRole('menu', { name: `Task actions for ${task.title}`, exact: true }).waitFor();
  assert.equal(await page.getByRole('menuitem', { name: 'Rename…', exact: true }).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Escape');
  assert.equal(await taskMenu.evaluate(el => el === document.activeElement), true);
  console.log('PASS: Views select explicitly, PDF tools stay with the review, and menus support keyboard navigation');
  for (const name of ['Review', 'Chat', 'Split']) {
    await selectWorkspaceView(name);
    await page.waitForFunction(() => document.querySelector('.task-grid .view-selector [aria-pressed="true"]') === document.activeElement);
    await page.getByRole('button', { name: 'Hide task list', exact: true }).click();
    const showTasks = page.getByRole('button', { name: 'Show task list', exact: true });
    await page.waitForFunction(() => document.querySelector('.main .sidebar-toggle') === document.activeElement);
    await showTasks.click();
    assert.equal((await page.locator('.task-grid').boundingBox()).y, 0);
  }
  await page.waitForFunction(() => document.querySelector('.review-frame').contentDocument.documentElement.style.getPropertyValue('--papilot-lead') === '0px');
  console.log('PASS: Content toolbars retain view-switch focus and reopen the sidebar in every desktop layout');

  const pdfLink = page.locator('.manuscript-link');
  await pdfLink.locator('.nav-meta').filter({ hasText: 'main · 2 changed · ↑1' }).waitFor();
  // A previously saved percentage must not prevent the divider from fitting the PDF.
  await page.evaluate(() => localStorage.setItem('papilot:pdf-zoom', '0.95'));
  await pdfLink.click();
  await page.getByRole('heading', { name: 'Manuscript', exact: true }).waitFor();
  assert.equal(await pdfLink.getAttribute('aria-current'), 'page');
  const pdfPages = page.locator('.pdfViewer .page');
  await page.locator('.textLayer span').filter({ hasText: /^Fixture ?$/ }).first().waitFor();
  assert.equal(await pdfPages.count(), 2);
  assert.equal(await page.getByLabel('Page number').inputValue(), '1');
  const manuscriptDivider = page.getByRole('separator', { name: 'Resize manuscript panel' });
  const manuscriptSide = page.locator('.manuscript-side');
  const originalSideWidth = Math.round((await manuscriptSide.boundingBox()).width);
  assert.equal(await selectedValue(page.getByRole('combobox', { name: 'Zoom', exact: true })), '0.95');
  const originalPdfWidth = await page.locator('.pdf-container').evaluate(box => box.clientWidth);
  await manuscriptDivider.focus(); await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(width => Math.round(document.querySelector('.manuscript-side').getBoundingClientRect().width) === width, originalSideWidth + 24);
  await page.waitForFunction(width => Math.abs(document.querySelector('.pdfViewer .page').getBoundingClientRect().width - (width - 24)) < 2, originalPdfWidth);
  await selectOption(page.getByRole('combobox', { name: 'Zoom', exact: true }), '1');
  const manuscriptHandle = await manuscriptDivider.boundingBox();
  await page.mouse.move(manuscriptHandle.x + 4, manuscriptHandle.y + 300); await page.mouse.down();
  await page.mouse.move(manuscriptHandle.x - 116, manuscriptHandle.y + 300, { steps: 5 }); await page.mouse.up();
  const widenedSide = Math.round((await manuscriptSide.boundingBox()).width);
  assert.equal(widenedSide, originalSideWidth + 144);
  await page.waitForFunction(width => Math.abs(document.querySelector('.pdfViewer .page').getBoundingClientRect().width - (width - 144)) < 2, originalPdfWidth);
  assert.equal(await page.evaluate(() => localStorage.getItem('papilot:pdf-zoom')), 'page-width');
  assert.equal(await page.evaluate(() => localStorage.getItem('papilot:manuscript-width')), String(widenedSide));
  await page.reload(); await manuscriptDivider.waitFor();
  assert.equal(Math.round((await manuscriptSide.boundingBox()).width), widenedSide, 'manuscript width survives a reload');
  await page.setViewportSize({ width: 1000, height: 900 });
  assert.ok(Math.round((await manuscriptSide.boundingBox()).width) <= 368, 'a narrow desktop clamps the saved width');
  await page.setViewportSize({ width: 800, height: 900 });
  await manuscriptDivider.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.body.classList.contains('resizing')), false);
  await page.setViewportSize({ width: 1440, height: 900 }); await manuscriptDivider.waitFor();
  assert.equal(Math.round((await manuscriptSide.boundingBox()).width), widenedSide);
  await manuscriptDivider.focus(); await page.keyboard.press('End');
  await page.waitForFunction(() => Math.round(document.querySelector('.manuscript-side').getBoundingClientRect().width) === 300);
  await manuscriptDivider.dblclick();
  assert.equal(Math.round((await manuscriptSide.boundingBox()).width), originalSideWidth);
  assert.equal(await page.evaluate(() => localStorage.getItem('papilot:manuscript-width')), null);
  await page.waitForFunction(width => Math.abs(document.querySelector('.pdfViewer .page').getBoundingClientRect().width - width) < 2, originalPdfWidth);
  await page.locator('.textLayer span').filter({ hasText: /^Fixture ?$/ }).first().waitFor();
  console.log('PASS: Manuscript panel resizes with pointer and keyboard, persists, clamps on narrow screens and resets');
  // Notes belong to New task; Contents keeps the bookmarks beside the PDF.
  assert.deepEqual((await page.getByRole('tablist', { name: 'Manuscript panels' }).getByRole('tab').allInnerTexts()).map(text => text.replace(/\s+/g, ' ')), ['New task', 'Contents', 'Git 2']);
  await page.getByRole('tab', { name: 'Contents', exact: true }).click();
  const contents = page.getByRole('navigation', { name: 'PDF contents' });
  assert.deepEqual((await contents.getByRole('button').allInnerTexts()).map(text => text.replace(/\s+/g, ' ')), ['Introduction 1', 'Method 2', 'Results 2']);
  await contents.getByRole('button', { name: /^Results/ }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Page number"]').value === '2' && document.querySelector('.pdf-section-title')?.textContent === 'Results');
  assert.equal(await page.locator('.pdf-section-title').innerText(), 'Results');
  assert.equal(await contents.getByRole('button', { name: /^Results/ }).getAttribute('aria-current'), 'location');
  const mountedPdf = await pdfPages.first().elementHandle();
  await page.locator('.manuscript-link').click();
  await page.getByRole('tab', { name: 'New task', exact: true }).click();
  await prompt.fill('Keep this draft beside the PDF.');
  assert.equal(await mountedPdf.evaluate(el => el.isConnected), true, 'Opening New task keeps the PDF mounted');
  assert.equal(await page.getByLabel('Page number').inputValue(), '2');
  await page.getByRole('tab', { name: 'Contents', exact: true }).click();
  await page.getByRole('tab', { name: 'New task', exact: true }).click();
  assert.equal(await prompt.inputValue(), 'Keep this draft beside the PDF.');
  await page.screenshot({ path: 'test-results/new-task-beside-pdf.png', fullPage: true });
  const beforeCollapseWidth = (await page.locator('.manuscript-pages').boundingBox()).width;
  const collapsePanel = page.getByRole('button', { name: 'Collapse manuscript panel', exact: true });
  const expandPanel = page.getByRole('button', { name: 'Expand manuscript panel', exact: true });
  await collapsePanel.click();
  await manuscriptSide.waitFor({ state: 'hidden' });
  await manuscriptDivider.waitFor({ state: 'hidden' });
  assert.ok((await page.locator('.manuscript-pages').boundingBox()).width > beforeCollapseWidth + 250);
  await page.waitForFunction(() => document.activeElement === document.querySelector('.pdf-toolbar .manuscript-panel-toggle'));
  assert.equal(await expandPanel.getAttribute('aria-expanded'), 'false');
  // Collapsed, the toggle is the last toolbar control and the PDF link leaves with the panel.
  assert.equal(await page.locator('.manuscript-pages .pdf-toolbar > :last-child').first().getAttribute('aria-label'), 'Expand manuscript panel');
  assert.equal(await page.locator('.pdf-toolbar').getByRole('link', { name: 'Open PDF', exact: true }).count(), 0);
  await page.screenshot({ path: 'test-results/manuscript-panel-collapsed.png', fullPage: true });
  await expandPanel.press('Enter');
  await manuscriptSide.waitFor();
  assert.equal(await mountedPdf.evaluate(el => el.isConnected), true);
  assert.equal(await prompt.inputValue(), 'Keep this draft beside the PDF.');
  assert.equal(Math.round((await manuscriptSide.boundingBox()).width), originalSideWidth);
  assert.equal(await page.getByLabel('Page number').inputValue(), '2');
  await page.waitForFunction(() => document.activeElement === document.querySelector('.manuscript-side-header .manuscript-panel-toggle'));
  console.log('PASS: Manuscript panel collapses and expands from the keyboard, preserving its draft, PDF and width');
  await prompt.fill('');
  await page.getByRole('tab', { name: 'Contents', exact: true }).click();
  await page.getByLabel('Page number').fill('1');
  await page.getByLabel('Page number').press('Enter');
  await page.waitForFunction(() => document.querySelector('.pdf-section-title').textContent === 'Introduction');
  assert.equal(await contents.isVisible(), true);
  assert.equal(await contents.getByRole('button', { name: /^Introduction/ }).getAttribute('aria-current'), 'location');
  await page.clock.runFor(200);
  await page.screenshot({ path: 'test-results/contents-desktop.png', fullPage: true });
  await contents.getByRole('button', { name: /^Method/ }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Page number"]').value === '2');
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Page number"]').value === '1');
  // Zoom steps away from fit width and returns to it; the choice is remembered.
  const zoom = page.getByRole('combobox', { name: 'Zoom', exact: true });
  assert.equal(await selectedValue(zoom), 'page-width');
  const width = (await pdfPages.first().boundingBox()).width;
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.waitForFunction(() => /^[\d.]+$/.test(document.querySelector('[role="combobox"][aria-label="Zoom"]').dataset.value));
  assert.ok((await pdfPages.first().boundingBox()).width > width);
  await selectOption(zoom, 'page-width');
  await page.waitForFunction(() => document.querySelector('[role="combobox"][aria-label="Zoom"]').dataset.value === 'page-width');
  assert.equal(await page.evaluate(() => localStorage.getItem('papilot:pdf-zoom')), 'page-width');
  // Window resizing preserves manual zoom; dragging the divider restores fit width.
  await selectOption(zoom, '1');
  const fixedWidth = (await pdfPages.first().boundingBox()).width;
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.clock.runFor(100);
  assert.equal((await pdfPages.first().boundingBox()).width, fixedWidth);
  assert.equal(await selectedValue(zoom), '1');
  await page.setViewportSize({ width: 1440, height: 900 });
  await manuscriptDivider.dblclick();
  await selectOption(zoom, 'page-fit');
  const fitHeight = (await pdfPages.first().boundingBox()).height;
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.waitForFunction(height => document.querySelector('.pdfViewer .page').getBoundingClientRect().height < height - 100, fitHeight);
  assert.equal(await selectedValue(zoom), 'page-fit');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(height => Math.abs(document.querySelector('.pdfViewer .page').getBoundingClientRect().height - height) < 2, fitHeight);
  await selectOption(zoom, 'page-width');
  console.log('PASS: Dragging restores fit width from saved percentages; viewport resize preserves the chosen zoom mode');
  // Find runs across every page.
  await page.locator('.pdf-container').focus();
  await page.keyboard.press('ControlOrMeta+f');
  const findBox = page.getByRole('textbox', { name: 'Search the PDF' });
  assert.equal(await findBox.evaluate(el => el === document.activeElement), true);
  await findBox.fill('operator');
  await page.locator('.pdf-find-count').filter({ hasText: '1 of 1' }).waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="Page number"]').value === '2');
  await findBox.fill('nowhere in the fixture');
  await page.locator('.pdf-find-count').filter({ hasText: 'No matches' }).waitFor();
  await findBox.press('Escape');
  await findBox.waitFor({ state: 'hidden' });
  // Select text, write a note, cancel it, delete one, then send another.
  await page.getByRole('tab', { name: 'New task', exact: true }).click();
  const notesPanel = page.getByRole('dialog', { name: 'PDF note 1', exact: true });
  // Where a word is printed, in page pixels, from the server's word places.
  const printed = async text => {
    const words = fixtureWords[0], word = words.words.find(w => w[0] === text), box = await pdfPages.first().boundingBox();
    const sx = box.width / words.width, sy = box.height / words.height;
    return { left: box.x + word[1] * sx, right: box.x + (word[1] + word[4]) * sx, middle: box.y + (word[2] - word[3] * 0.3) * sy };
  };
  const drag = async (from, to) => {
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 }); await page.mouse.up();
    await page.waitForTimeout(200);
  };
  const selectText = async () => {
    await page.getByLabel('Page number').fill('1');
    await page.getByLabel('Page number').press('Enter');
    await page.locator('.textLayer span').filter({ hasText: /^Fixture ?$/ }).first().scrollIntoViewIfNeeded();
    // The selection layer sits on the printed words: one run per word, from
    // where the word is printed to where the next one begins.
    const fixture = await printed('Fixture'), sentence = await printed('sentence'), about = await printed('about');
    const span = await page.locator('.textLayer span').filter({ hasText: /^Fixture ?$/ }).first().boundingBox();
    assert.ok(Math.abs(span.x - fixture.left) < 1.5 && Math.abs(span.x + span.width - sentence.left) < 2, `Fixture is printed from ${fixture.left} and sentence from ${sentence.left}; the run spans ${span.x}–${span.x + span.width}`);
    // Start inside "Fixture" and end inside "about"; the note takes both whole words.
    await drag({ x: fixture.left + (fixture.right - fixture.left) * 0.4, y: fixture.middle }, { x: about.right - 3, y: about.middle });
    assert.doesNotMatch(await page.evaluate(() => document.getSelection().toString()), /^F/);
    await page.getByRole('button', { name: 'Add note', exact: true }).click();
    const note = page.getByRole('textbox', { name: 'Edit note 1', exact: true });
    assert.equal(await note.evaluate(el => el === document.activeElement), true);
    return note;
  };
  let noteBox = await selectText();
  const newNote = notesPanel;
  await expect(newNote.getByRole('button', { name: 'Add note', exact: true })).toHaveCount(0);
  await expect(newNote.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  // An empty new note has nothing to discard; Escape or a click elsewhere closes it.
  await expect(newNote.getByRole('button', { name: 'Delete note 1', exact: true })).toHaveCount(0);
  await expect(newNote.getByRole('button', { name: 'Close note', exact: true })).toHaveCount(0);
  await expect(newNote.getByRole('button', { name: 'Include note 1 in this task', exact: true })).toBeDisabled();
  await page.screenshot({ path: 'test-results/new-note-inline.png', fullPage: true });
  await noteBox.press('Escape');
  await noteBox.waitFor({ state: 'hidden' });
  assert.equal(annotations.length, 0);
  noteBox = await selectText();
  await prompt.click();
  await expect(newNote).toHaveCount(0);
  await expect(prompt).toBeFocused();
  assert.equal(annotations.length, 0, 'closing an empty note does not create an annotation');
  noteBox = await selectText();
  await noteBox.fill('Discard this draft.');
  await expect(newNote.getByRole('button', { name: 'Delete note 1', exact: true })).toBeEnabled();
  await newNote.getByRole('button', { name: 'Delete note 1', exact: true }).click();
  await expect(newNote).toHaveCount(0);
  assert.equal(annotations.length, 0, 'the same trash action discards a new note without saving it');
  // A drag from the gap before a word to the gap after another takes just those words.
  const sentence = await printed('sentence'), about = await printed('about');
  await drag({ x: sentence.left - 2, y: sentence.middle }, { x: about.right + 1, y: about.middle });
  await page.getByRole('button', { name: 'Add note', exact: true }).click();
  noteBox = page.getByRole('textbox', { name: 'Edit note 1', exact: true });
  await noteBox.fill('Only these words.');
  await noteBox.press('Escape');
  await page.getByRole('button', { name: 'Note 1: Only these words.', exact: true }).waitFor();
  await expect(newNote).toHaveCount(0);
  await expect(notesPanel).toHaveCount(0);
  await page.getByRole('button', { name: 'Note 1: Only these words.', exact: true }).click();
  assert.equal(annotations[0].quote, 'sentence about');
  await expect(notesPanel).toBeVisible();
  await expect(page.locator('.new-task-panel [data-note]')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/personal-note-inline.png', fullPage: true });
  // Creating and editing use the same card and actions; closing saves in place.
  const anchor = structuredClone(annotations[0]);
  await notesPanel.getByText('Only these words.', { exact: true }).click();
  const editingNote = notesPanel.getByRole('textbox', { name: 'Edit note 1', exact: true });
  await expect(editingNote).toBeFocused();
  await page.screenshot({ path: 'test-results/personal-note-edit.png', fullPage: true });
  await editingNote.fill('');
  await expect(notesPanel.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(notesPanel.getByRole('button', { name: 'Include note 1 in this task', exact: true })).toBeDisabled();
  assert.equal(await page.getByRole('button', { name: 'Start task', exact: true }).isDisabled(), true);
  await editingNote.fill('Unfinished edit.'); await editingNote.press('Escape');
  await expect(notesPanel).toHaveCount(0);
  assert.equal(annotations[0].comment, 'Unfinished edit.');
  await expect(page.getByRole('button', { name: 'Note 1: Unfinished edit.', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await notesPanel.getByText('Unfinished edit.', { exact: true }).click();
  await expect(editingNote).toHaveValue('Unfinished edit.');
  await expect(editingNote).toBeFocused();
  await editingNote.fill('Only these words, please.');
  failNoteEdit = true;
  await editingNote.press('Enter');
  await notesPanel.getByRole('alert').waitFor();
  assert.equal(await editingNote.inputValue(), 'Only these words, please.');
  failNoteEdit = false;
  // Enter sends, like the arrow: the edit is saved, quoted in the chat, and the popover closes.
  await editingNote.press('Enter');
  await page.getByRole('button', { name: 'Note 1: Only these words, please.', exact: true }).waitFor();
  assert.deepEqual(annotations[0], { ...anchor, comment: 'Only these words, please.' });
  await expect(page.getByRole('region', { name: 'Notes in this task' })).toContainText('Only these words, please.');
  await expect(notesPanel).toHaveCount(0);
  await page.getByRole('button', { name: 'Note 1: Only these words, please.', exact: true }).click();
  await expect(notesPanel.getByRole('button', { name: 'Include note 1 in this task', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(notesPanel.getByRole('button', { name: 'Include note 1 in this task', exact: true })).toHaveText('Included');
  // Editing a note that is already in the chat saves it and keeps it there.
  await notesPanel.getByText('Only these words, please.', { exact: true }).click();
  await editingNote.press('Enter');
  await expect(editingNote).toHaveCount(0);
  await expect(notesPanel.getByRole('button', { name: 'Include note 1 in this task', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await notesPanel.getByRole('button', { name: 'Include note 1 in this task', exact: true }).click();
  await expect(page.locator('.new-task-panel [data-note]')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Note 1: Only these words, please.', exact: true }).waitFor();
  await page.getByRole('button', { name: 'My notes', exact: true }).click();
  await expect(page.getByRole('region', { name: 'PDF notes' })).toContainText('Only these words, please.');
  await page.getByRole('button', { name: 'Show note 1 on the page', exact: true }).click();
  await expect(notesPanel).toBeVisible();
  failNoteDelete = true;
  await notesPanel.getByRole('button', { name: 'Delete note 1' }).click();
  await notesPanel.getByRole('alert').waitFor(); assert.equal(annotations.length, 1);
  failNoteDelete = false;
  await notesPanel.getByRole('button', { name: 'Delete note 1' }).click();
  await page.getByRole('button', { name: 'Note 1: Only these words, please.', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await notesPanel.locator('.note-undo').count(), 0, 'no dedicated undo UI');
  // Text fields keep native undo even when a deleted annotation can be restored.
  await prompt.fill(''); await prompt.pressSequentially('Undo this text');
  await prompt.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  assert.ok((await prompt.inputValue()).length < 'Undo this text'.length, 'native undo edits the text');
  assert.equal(annotations.length, 0); await prompt.fill('');
  await page.getByRole('button', { name: 'Mark region', exact: true }).focus();
  await page.keyboard.press('Meta+Shift+z');
  assert.equal(annotations.length, 0, 'redo is not interpreted as undo');
  failNoteRestore = true;
  await page.keyboard.press('Meta+z');
  await page.getByRole('alert').filter({ hasText: 'Could not restore. Try again.' }).waitFor(); assert.equal(annotations.length, 0);
  failNoteRestore = false;
  await page.keyboard.press('Control+z');
  await page.getByRole('button', { name: 'Note 1: Only these words, please.', exact: true }).waitFor();
  assert.equal(await page.getByRole('alert').filter({ hasText: 'Could not restore. Try again.' }).count(), 0);
  assert.deepEqual(annotations[0], { ...anchor, comment: 'Only these words, please.' });
  await notesPanel.getByRole('button', { name: 'Delete note 1' }).click();
  await page.getByRole('button', { name: 'Note 1: Only these words, please.', exact: true }).waitFor({ state: 'hidden' });
  noteBox = await selectText();
  await noteBox.fill('Shorten this sentence.');
  await noteBox.press('Enter');
  await expect(notesPanel).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Notes in this task' })).toContainText('Shorten this sentence.');
  assert.equal(annotations[0].page, 0);
  assert.equal(annotations[0].key, 'fixture');
  assert.equal(annotations[0].quote, 'Fixture sentence about');
  assert.ok(annotations[0].rects.length >= 1 && annotations[0].rects.every(([x0, y0, x1, y1]) => x0 < x1 && y0 < y1 && y1 < 0.5));
  await page.getByRole('button', { name: 'Note 1: Shorten this sentence.', exact: true }).waitFor();
  assert.ok(await page.locator('.note-mark').count() >= 1);
  await page.getByRole('button', { name: 'Note 1: Shorten this sentence.', exact: true }).click();
  await notesPanel.getByRole('button', { name: 'Delete note 1' }).click();
  await page.getByRole('button', { name: 'Note 1: Shorten this sentence.', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(annotations.length, 0);
  await expect(page.locator('.new-task-panel [data-note]')).toHaveCount(0);
  // The arrow works immediately on a new note: save and quote in one click.
  noteBox = await selectText();
  await noteBox.fill('Quote this new note.');
  await notesPanel.getByRole('button', { name: 'Include note 1 in this task', exact: true }).click();
  await expect(notesPanel).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Notes in this task' })).toContainText('Quote this new note.');
  assert.equal(annotations.length, 1);
  // Taking a note back out keeps its popover open.
  await page.getByRole('button', { name: 'Note 1: Quote this new note.', exact: true }).click();
  await notesPanel.getByRole('button', { name: 'Include note 1 in this task', exact: true }).click();
  await expect(page.locator('.new-task-panel [data-note]')).toHaveCount(0);
  await expect(notesPanel.getByRole('button', { name: 'Include note 1 in this task', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await notesPanel.getByText('Quote this new note.', { exact: true }).click();
  await notesPanel.getByRole('textbox', { name: 'Edit note 1', exact: true }).fill('Quote the updated note.');
  await notesPanel.getByRole('button', { name: 'Include note 1 in this task', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Notes in this task' })).toContainText('Quote the updated note.');
  assert.equal(annotations[0].comment, 'Quote the updated note.');
  await page.getByRole('button', { name: 'Note 1: Quote the updated note.', exact: true }).click();
  await notesPanel.getByRole('button', { name: 'Delete note 1', exact: true }).click();
  await expect(notesPanel).toHaveCount(0);
  await expect(page.locator('.new-task-panel [data-note]')).toHaveCount(0);
  assert.equal(annotations.length, 0);
  // A region marks a figure or equation that has no text to select.
  await page.getByRole('button', { name: 'Mark region', exact: true }).click();
  const firstPage = await pdfPages.first().boundingBox();
  await page.mouse.move(firstPage.x + firstPage.width * 0.2, firstPage.y + firstPage.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(firstPage.x + firstPage.width * 0.7, firstPage.y + firstPage.height * 0.36, { steps: 5 });
  await page.mouse.up();
  noteBox = page.getByRole('textbox', { name: 'Edit note 1', exact: true });
  assert.equal(await noteBox.evaluate(el => el === document.activeElement), true);
  await noteBox.fill('Define the operator here.');
  failNoteCreate = true;
  await prompt.click();
  await expect(newNote.getByRole('alert')).toHaveText('Could not save. Try again.');
  await expect(noteBox).toHaveValue('Define the operator here.');
  assert.equal(annotations.length, 0);
  failNoteCreate = false;
  await prompt.click();
  await page.getByRole('button', { name: 'Note 1: Define the operator here.', exact: true }).waitFor();
  await expect(newNote).toHaveCount(0);
  await expect(notesPanel).toHaveCount(0);
  await expect(prompt).toBeFocused();
  assert.equal(annotations.length, 1);
  await page.getByRole('button', { name: 'Note 1: Define the operator here.', exact: true }).click();
  await expect(notesPanel).toContainText('Define the operator here.');
  assert.equal(await page.getByRole('button', { name: 'Mark region', exact: true }).getAttribute('aria-pressed'), 'false');
  assert.equal(annotations[0].rects, undefined);
  assert.ok(annotations[0].rect[0] > 0.15 && annotations[0].rect[2] < 0.75 && annotations[0].rect[1] < annotations[0].rect[3]);
  await expect(page.locator('.new-task-panel [data-note]')).toHaveCount(0);
  assert.equal(await page.getByRole('button', { name: 'Start task', exact: true }).isDisabled(), true);
  await notesPanel.getByRole('button', { name: 'Include note 1 in this task', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Notes in this task' })).toContainText('Define the operator here.');
  await page.getByRole('button', { name: 'Remove note 1 from task', exact: true }).click();
  await expect(page.locator('.new-task-panel [data-note]')).toHaveCount(0);
  assert.equal(annotations.length, 1);
  await expect(notesPanel).toHaveCount(0);
  await page.getByRole('button', { name: 'Note 1: Define the operator here.', exact: true }).click();
  await notesPanel.getByRole('button', { name: 'Include note 1 in this task', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: 'Notes', exact: true }).count(), 0);
  assert.equal(await prompt.inputValue(), '');
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  await page.locator('.task-list').getByRole('button', { name: /^Define the operator here/ }).waitFor();
  assert.equal(await prompt.isVisible(), true);
  assert.equal(await page.locator('.task-link.active').count(), 0);
  assert.equal(noteSends.length, 1);
  assert.ok(noteSends[0].id.length >= 16);
  assert.deepEqual(noteSends[0].annotations, ['note-1']);
  assert.equal(noteSends[0].instructions, '');
  assert.equal(annotations.length, 0);
  const notesTask = noteSends[0].id;
  snapshot.tasks = snapshot.tasks.filter(t => t.id !== notesTask);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  gitState.files.push({ path: 'main.aux', status: '?', staged: false, unstaged: true }, { path: 'main.log', status: '?', staged: false, unstaged: true });
  await pdfLink.click();
  await page.getByRole('heading', { name: 'Manuscript', exact: true }).waitFor();
  await page.getByRole('tab', { name: /^Git/ }).click();
  const gitPanel = page.getByRole('region', { name: 'Git status' });
  // Cursor's source control: the commit box, then staged and unstaged lists.
  const changes = gitPanel.getByRole('region', { name: 'Changes', exact: true });
  const unstagedList = changes.getByRole('group', { name: 'Changes', exact: true });
  const stagedList = changes.getByRole('group', { name: 'Staged changes', exact: true });
  await unstagedList.getByText('main.tex', { exact: true }).waitFor();
  await unstagedList.getByText('notes.md', { exact: true }).waitFor();
  assert.equal(await changes.getByRole('textbox', { name: 'Commit message' }).getAttribute('placeholder'), 'Message (↵ to commit on “main”)');
  assert.equal(await gitPanel.getByRole('checkbox').count(), 0, 'Files are staged with + and −, not checkboxes');
  const graphPane = gitPanel.getByRole('region', { name: 'Commit graph', exact: true });
  assert.match(await graphPane.locator('.git-branch').innerText(), /main\s*↑1/);
  assert.equal(await graphPane.locator('.git-branch').getAttribute('title'), 'Tracking origin/main');
  await graphPane.locator('.git-graph-row.head').getByText('Draft the introduction', { exact: true }).waitFor();
  await graphPane.locator('.current-ref').getByText('main', { exact: true }).waitFor();
  await graphPane.locator('.remote-ref').getByText('origin/main', { exact: true }).waitFor();
  const worktrees = gitPanel.getByRole('region', { name: 'Worktrees', exact: true });
  await worktrees.locator('.git-pane-toggle').click();
  const proposalTree = worktrees.locator(`[data-task-id="${task.id}"]`);
  await proposalTree.getByText(task.title, { exact: true }).waitFor();
  await proposalTree.locator('.status').filter({ hasText: 'Ready for review' }).waitFor();
  assert.ok((await proposalTree.boundingBox()).height <= 56, 'Worktrees use compact rows');
  assert.equal(await worktrees.locator('.git-worktree').count(), 4);
  await worktrees.getByText('Status unavailable', { exact: true }).waitFor();
  const graph = graphPane;
  assert.equal(await graph.locator('.git-graph-row').count(), 5);
  await graph.getByRole('button', { name: task.title, exact: true }).waitFor();
  assert.ok((await graph.locator('.git-graph-row').first().boundingBox()).height <= 48, 'Graph rows no longer reserve three lines');
  // Generated captions update the sidebar, worktree and graph without navigation.
  const originalTitle = task.title;
  const captionMenu = () => page.getByRole('button', { name: `Task actions for ${task.title}`, exact: true });
  await captionMenu().click();
  await page.getByRole('menuitem', { name: 'Generate task title', exact: true }).click();
  await captionMenu().click();
  const generatingTitle = page.getByRole('menuitem', { name: 'Generating task title…', exact: true });
  await generatingTitle.waitFor();
  assert.equal(await generatingTitle.isDisabled(), true);
  await page.keyboard.press('Escape');
  task.titleGeneration = 'failed';
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await captionMenu().click();
  await page.getByRole('menuitem', { name: 'Retry title generation', exact: true }).click();
  assert.deepEqual(titleRequests, [task.id, task.id]);
  task.title = '明确引言中的研究贡献'; task.titleSource = 'generated'; task.titleGeneration = null;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await captionMenu().waitFor();
  await proposalTree.getByText(task.title, { exact: true }).waitFor();
  await graph.getByRole('button', { name: task.title, exact: true }).waitFor();
  task.title = originalTitle;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await proposalTree.getByText(originalTitle, { exact: true }).waitFor();
  console.log('PASS: Task captions show pending and retry states and update task, worktree and graph labels');
  await proposalTree.locator('.git-worktree-button').click();
  await worktrees.getByText('sections/introduction.tex', { exact: true }).waitFor();
  assert.equal(await graph.locator('.highlighted').getAttribute('data-commit'), 'bbb2222');
  await proposalTree.locator('.git-worktree-button').click();
  await graph.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/git-overview-desktop.png' });
  overviewFailure = true;
  await graph.getByRole('button', { name: 'Refresh worktrees and history' }).click();
  await graph.getByRole('alert').filter({ hasText: 'Showing the last update.' }).waitFor();
  assert.equal(await worktrees.locator('.git-worktree').count(), 4, 'A failed refresh keeps the last known worktrees');
  overviewFailure = false;
  await graph.getByRole('button', { name: 'Retry', exact: true }).click();
  await graph.getByRole('alert').waitFor({ state: 'detached' });
  // Build output goes into .gitignore from the Changes menu, one pattern per kind.
  await unstagedList.getByText('main.aux', { exact: true }).waitFor();
  await changes.getByRole('button', { name: 'More Git actions', exact: true }).click();
  const ignoreItem = page.getByRole('menuitem', { name: /^Add to \.gitignore/ });
  await expect(ignoreItem).toContainText('2 build files');
  await ignoreItem.click();
  await gitPanel.getByRole('status').filter({ hasText: 'Added 2 patterns to .gitignore.' }).waitFor();
  assert.deepEqual(gitIgnores, [{ paths: ['main.aux', 'main.log'] }]);
  assert.equal(await gitPanel.getByText('main.aux', { exact: true }).count(), 0);
  assert.equal(await unstagedList.getByLabel('Untracked').first().innerText(), 'U');
  // With nothing staged, Commit takes every file as it is on disk.
  const commitButton = changes.getByRole('button', { name: 'Commit', exact: true });
  assert.equal(await commitButton.getAttribute('title'), 'Commit all 3 files');
  assert.equal(await commitButton.isDisabled(), true);
  await unstagedList.getByRole('button', { name: 'main.tex', exact: true }).click();
  await gitPanel.getByRole('region', { name: 'Changes in main.tex' }).getByText('+New line.', { exact: true }).waitFor();
  // + stages a file and − unstages it; Commit then takes only what is staged.
  await unstagedList.getByRole('button', { name: 'Stage main.tex', exact: true }).click();
  await stagedList.getByText('main.tex', { exact: true }).waitFor();
  await stagedList.getByRole('button', { name: 'Unstage main.tex', exact: true }).click();
  await expect(stagedList).toHaveCount(0);
  await unstagedList.getByRole('button', { name: 'Stage main.tex', exact: true }).click();
  await stagedList.getByText('main.tex', { exact: true }).waitFor();
  assert.deepEqual(gitStages, [{ paths: ['main.tex'], stage: true }, { paths: ['main.tex'], stage: false }, { paths: ['main.tex'], stage: true }]);
  assert.equal(await commitButton.getAttribute('title'), 'Commit staged changes in 1 file');
  // Discarding asks first; Cancel keeps the file.
  await unstagedList.getByRole('button', { name: 'Discard changes in notes.md', exact: true }).click();
  const deleteNotes = page.getByRole('dialog', { name: 'Delete notes.md?' });
  await deleteNotes.getByText('This file is not tracked by Git, so it cannot be recovered.', { exact: true }).waitFor();
  await page.screenshot({ path: 'test-results/git-discard-dialog.png' });
  await deleteNotes.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(gitDiscards.length, 0);
  await unstagedList.getByRole('button', { name: 'notes.md', exact: true }).hover();
  await gitPanel.screenshot({ path: 'test-results/git-panel-cursor.png' });
  // The chosen agent writes the message for what is staged.
  const commitMessage = changes.getByRole('textbox', { name: 'Commit message' });
  await changes.getByRole('button', { name: 'Generate commit message', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Commit message"]')?.value === 'Tighten the introduction');
  assert.deepEqual(gitMessages.map(body => [body.paths, body.staged]), [[['main.tex'], true]]);
  assert.ok(['codex', 'claude', 'antigravity'].includes(gitMessages[0].agent));
  await commitMessage.press('Enter');
  await gitPanel.getByRole('status').filter({ hasText: 'Committed def5678.' }).waitFor();
  assert.deepEqual(gitCommits, [{ message: 'Tighten the introduction', staged: true }]);
  assert.deepEqual(gitState.files.map(file => file.path), ['notes.md', '.gitignore'], 'Unstaged files stay for the next commit');
  assert.equal(await commitMessage.inputValue(), '');
  await graph.locator('.git-graph-row.head').getByText('Tighten the introduction', { exact: true }).waitFor();
  // Confirming deletes an untracked file.
  await unstagedList.getByRole('button', { name: 'Discard changes in .gitignore', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete .gitignore?' }).getByRole('button', { name: 'Delete file', exact: true }).click();
  await gitPanel.getByRole('status').filter({ hasText: 'Discarded changes in 1 file.' }).waitFor();
  assert.deepEqual(gitDiscards, [{ paths: ['.gitignore'] }]);
  // Commit's menu commits and pushes.
  await commitMessage.fill('Add notes');
  await changes.getByRole('button', { name: 'More commit actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Commit and push', exact: true }).click();
  await gitPanel.getByRole('status').filter({ hasText: 'Committed def5678 and pushed.' }).waitFor();
  assert.deepEqual(gitCommits.at(-1), { message: 'Add notes', paths: ['notes.md'] });
  assert.deepEqual(gitActions, ['push']);
  assert.equal(await graph.getByRole('button', { name: 'Push', exact: true }).isDisabled(), true, 'Nothing is left to push');
  await changes.getByText('No uncommitted changes', { exact: true }).waitFor();
  // A branch and upstream that both moved on merge instead of pulling.
  Object.assign(gitState, { ahead: 1, behind: 2 });
  await graph.getByRole('button', { name: 'Fetch from the remote', exact: true }).click();
  await graph.getByRole('button', { name: 'Merge', exact: true }).click();
  const merge = gitPanel.getByRole('group', { name: 'Merge in progress' });
  await merge.getByText('Merging: 1 file has conflicts', { exact: true }).waitFor();
  assert.equal(await gitPanel.getByLabel('Conflict').innerText(), '!');
  assert.equal(await gitPanel.getByRole('textbox', { name: 'Commit message' }).count(), 0);
  assert.equal(await graph.getByRole('button', { name: 'Push', exact: true }).isDisabled(), true);
  await merge.getByRole('button', { name: /^Resolve with / }).click();
  await gitPanel.getByRole('status').filter({ hasText: 'Conflicts resolved. Read the diffs, then commit the merge.' }).waitFor();
  assert.equal(await merge.locator('.git-merge-summary strong').innerText(), 'both');
  assert.ok(['codex', 'claude', 'antigravity'].includes(gitActions.at(-1).agent));
  await merge.getByRole('button', { name: 'Commit merge', exact: true }).click();
  await gitPanel.getByRole('status').filter({ hasText: 'Committed aaa1111.' }).waitFor();
  assert.equal(await merge.count(), 0);
  assert.deepEqual(gitActions.filter(action => typeof action === 'string'), ['push', 'fetch', 'merge', 'finish']);
  Object.assign(gitState, structuredClone(originalGit));
  const pdfToolbar = page.getByRole('toolbar', { name: 'PDF controls' });
  await page.locator('.manuscript-side-header').getByRole('button', { name: 'Share', exact: true }).click();
  assert.equal(await page.getByRole('menuitem', { name: 'Open PDF', exact: true }).getAttribute('href'), '/api/projects/fixture-paper/manuscript.pdf?key=fixture');
  assert.equal(await page.getByRole('menuitem', { name: 'Export PDF', exact: true }).getAttribute('href'), '/api/projects/fixture-paper/manuscript.pdf?key=fixture&download=1');
  await page.keyboard.press('Escape');
  await pdfToolbar.getByRole('button', { name: 'Recompile PDF', exact: true }).waitFor();
  assert.equal(await page.title(), 'Example paper · Papilot');
  await worktrees.getByRole('button', { name: `Open task: ${task.title}`, exact: true }).click();
  await page.getByRole('heading', { name: task.title }).waitFor();
  console.log('PASS: Each paper has a PDF view with contents, paging, zoom and find; text and region notes are added, deleted and sent as one task; Git changes are diffed, committed and pushed');

  const divider = page.getByRole('separator', { name: 'Resize chat panel' });
  const chatPanel = page.getByRole('region', { name: 'Codex conversation', exact: true });
  const defaultWidth = Math.round((await chatPanel.boundingBox()).width);
  await divider.focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(Math.round((await chatPanel.boundingBox()).width), defaultWidth + 24);
  assert.equal(await page.evaluate(() => localStorage.getItem('papilot:chat-width')), String(defaultWidth + 24));
  const handle = await divider.boundingBox();
  await page.mouse.move(handle.x + 4, handle.y + 300);
  await page.mouse.down();
  await page.mouse.move(handle.x - 96, handle.y + 300, { steps: 5 });
  await page.mouse.up();
  assert.ok(Math.abs((await chatPanel.boundingBox()).width - (defaultWidth + 124)) <= 2);
  await divider.dblclick();
  assert.equal(Math.round((await chatPanel.boundingBox()).width), defaultWidth);
  assert.equal(await page.evaluate(() => localStorage.getItem('papilot:chat-width')), null);
  const copy = page.getByRole('button', { name: 'Copy message' });
  await copy.click();
  await page.getByRole('button', { name: 'Copied' }).waitFor();
  await page.getByText('1 review update not sent yet', { exact: true }).waitFor();
  await page.getByText('1 review update will be sent with this message', { exact: true }).waitFor();
  task.review.unsent = 0;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByRole('button', { name: 'Send feedback', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.composer-hint').count(), 0);
  delete task.review.unsent;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByRole('button', { name: 'Send feedback', exact: true }).waitFor();
  console.log('PASS: The chat divider drags, nudges, persists and resets; replies copy; only unsent review updates offer Send feedback');


  await page.locator('.manuscript-link').click();
  await page.getByRole('tab', { name: 'New task', exact: true }).click();
  await prompt.fill('Shorten the introduction.');
  await prompt.press('Shift+Enter');
  await prompt.pressSequentially('Preserve the technical content.');
  await prompt.press('Enter');
  await page.locator('.new-task-panel').getByRole('alert').waitFor();
  assert.equal(await prompt.inputValue(), 'Shorten the introduction.\nPreserve the technical content.');
  // The new-task panel shows the Codex account's usage.
  const usage = page.getByRole('region', { name: 'Codex usage' });
  await usage.locator('summary').click();
  assert.equal(await usage.getByRole('meter', { name: 'Weekly limit used' }).getAttribute('aria-valuenow'), '83');
  assert.match(await usage.innerText(), /Pro[\s\S]*Weekly limit[\s\S]*83% used[\s\S]*resets [\s\S]*12,418 credits/);
  await usage.locator('summary').click();
  // One picker lists every agent's models with a search; one choice sets the
  // agent and its model, and effort and fast mode follow the chosen model.
  const settingsTrigger = page.getByRole('button', { name: 'Agent settings', exact: true });
  const agentSettings = page.getByRole('dialog', { name: 'Agent settings', exact: true });
  await settingsTrigger.click();
  const search = agentSettings.getByRole('combobox', { name: 'Search models', exact: true });
  const models = agentSettings.getByRole('listbox', { name: 'Models', exact: true });
  // A recent choice is listed again under its agent; the agent's own entry is the last.
  const option = name => models.getByRole('option', { name, exact: true }).last();
  const choose = name => option(name).click();
  const groupNames = () => models.getByRole('group').evaluateAll(groups => groups.map(group => group.getAttribute('aria-label')));
  const effortChoice = agentSettings.getByRole('slider', { name: 'Reasoning effort', exact: true });
  const fastMode = agentSettings.getByRole('switch', { name: 'Fast mode' });
  assert.equal(await search.evaluate(el => el === document.activeElement), true, 'typing searches right away');
  assert.deepEqual(await groupNames(), ['Codex', 'Claude', 'Antigravity', 'Kimi']);
  assert.equal(await option('Fast model · Codex').getAttribute('aria-selected'), 'true');
  assert.deepEqual(await option('Default model · Antigravity').locator('small').allInnerTexts(), ['Unavailable']);
  // Without a choice, a task reasons at high effort, not the catalog default (Medium here).
  assert.match(await settingsTrigger.innerText(), /High/);
  assert.equal(await fastMode.count(), 0);
  await choose('Deep model · Codex');
  assert.match(await settingsTrigger.innerText(), /High/);
  await effortChoice.press('End');
  assert.equal(await effortChoice.getAttribute('aria-valuetext'), 'Xhigh');
  await fastMode.check();
  await search.press('Escape');
  await agentSettings.waitFor({ state: 'hidden' });
  assert.equal(await settingsTrigger.evaluate(el => el === document.activeElement), true);
  assert.match(await settingsTrigger.getAttribute('title'), /Codex.*Deep model.*Xhigh.*Fast/);
  // Recent choices come first; a search covers every agent and Enter takes the first match.
  await settingsTrigger.click();
  assert.deepEqual(await groupNames(), ['Recent', 'Codex', 'Claude', 'Antigravity', 'Kimi']);
  assert.deepEqual(await models.getByRole('group', { name: 'Recent', exact: true }).getByRole('option').evaluateAll(options => options.map(option => option.getAttribute('aria-label'))), ['Deep model · Codex']);
  await search.fill('haiku');
  assert.deepEqual(await models.getByRole('option').evaluateAll(options => options.map(option => option.getAttribute('aria-label'))), ['Haiku 5.5 · Claude']);
  await search.press('Enter');
  assert.deepEqual(await page.evaluate(() => [localStorage.getItem('papilot:agent'), localStorage.getItem('papilot:model:claude')]), ['claude', 'haiku']);
  assert.match(await settingsTrigger.innerText(), /Claude\s*Haiku 5\.5/);
  await search.fill('no such model');
  await agentSettings.getByText('No models match “no such model”', { exact: true }).waitFor();
  await search.fill('claude');
  await search.press('ArrowDown');
  const active = await search.getAttribute('aria-activedescendant');
  assert.equal(await agentSettings.locator(`[id="${active}"]`).getAttribute('aria-label'), 'Haiku 5.5 · Claude');
  await search.press('ArrowUp');
  await search.press('Enter');
  assert.equal(await option('Opus 5.5 · Claude').getAttribute('aria-selected'), 'true');
  await search.fill('');
  assert.equal(await effortChoice.getAttribute('aria-valuetext'), 'High');
  await effortChoice.press('Home');
  assert.equal(await effortChoice.getAttribute('aria-valuetext'), 'Low');
  await agentSettings.getByRole('button', { name: 'Model default', exact: true }).click();
  assert.equal(await effortChoice.getAttribute('aria-valuetext'), 'Model default');
  assert.equal(await fastMode.count(), 0);
  await choose('Haiku 5.5 · Claude');
  // An agent that cannot be used says why, with Reconnect, inside the same menu.
  await choose('Default model · Antigravity');
  await agentSettings.getByRole('status').getByText('spawn agy ENOENT', { exact: true }).waitFor();
  assert.equal(await page.locator('.runtime-banner').count(), 0);
  assert.equal(await page.locator('.new-task-panel > .inline-error[role=status]').count(), 0);
  const reconnectsBeforePicker = reconnects;
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/state')), agentSettings.getByRole('button', { name: 'Reconnect', exact: true }).click()]);
  assert.equal(reconnects, reconnectsBeforePicker + 1);
  assert.equal(await agentSettings.isVisible(), true);
  await page.keyboard.press('Escape');
  await agentSettings.waitFor({ state: 'hidden' });
  assert.equal(await settingsTrigger.locator('.agent-status-mark').count(), 1);
  await settingsTrigger.click();
  await agentSettings.getByRole('status').getByText('spawn agy ENOENT', { exact: true }).waitFor();
  // An agent that connects later offers its models with the next state.
  snapshot.runtimes.kimi = { connected: true, authenticated: true, account: 'Local Kimi configuration', error: null, models: [{ id: 'kimi/k3', name: 'K3', isDefault: true, efforts: ['low', 'high', 'max'], defaultEffort: 'high' }] };
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await option('K3 · Kimi').waitFor();
  await choose('K3 · Kimi');
  assert.equal(await effortChoice.getAttribute('aria-valuetext'), 'High');
  await effortChoice.press('End');
  assert.deepEqual(await page.evaluate(() => [localStorage.getItem('papilot:agent'), localStorage.getItem('papilot:model:kimi'), localStorage.getItem('papilot:effort:kimi')]), ['kimi', 'kimi/k3', 'max']);
  assert.equal(await fastMode.count(), 0);
  await page.screenshot({ path: 'test-results/kimi-agent-settings.png', fullPage: true });
  // Only agents the host has are offered: one found later appears with the next state.
  snapshot.runtimes.qwen = { installed: false, connected: false, authenticated: false, account: null, error: null, models: [] };
  snapshot.runtimes.opencode = { installed: true, connected: true, authenticated: true, account: 'Local OpenCode configuration', error: null, models: [{ id: 'deepseek/deepseek-v4-pro', name: 'deepseek/DeepSeek V4 Pro', isDefault: true, efforts: ['low', 'high'], defaultEffort: null }] };
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await option('deepseek/DeepSeek V4 Pro · OpenCode').waitFor();
  assert.deepEqual((await groupNames()).filter(name => name !== 'Recent'), ['Codex', 'Claude', 'Antigravity', 'Kimi', 'OpenCode']);
  await page.screenshot({ path: 'test-results/detected-agent-settings.png', fullPage: true });
  snapshot.runtimes.copilot = { installed: true, connected: true, authenticated: true, account: 'Local Copilot configuration', error: null, models: [{ id: 'copilot-model', name: 'Copilot model', isDefault: true, efforts: ['low', 'high'], defaultEffort: 'low' }] };
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await option('Copilot model · Copilot').waitFor();
  await choose('Copilot model · Copilot');
  assert.equal(await effortChoice.getAttribute('aria-valuetext'), 'High');
  assert.deepEqual(await page.evaluate(() => [localStorage.getItem('papilot:agent'), localStorage.getItem('papilot:model:copilot')]), ['copilot', 'copilot-model']);
  assert.equal(await agentSettings.getByRole('group', { name: 'Copilot', exact: true }).locator('[data-brand=copilot]').count(), 1);
  await page.screenshot({ path: 'test-results/copilot-agent-settings.png', fullPage: true });
  snapshot.runtimes.grok = { installed: true, connected: true, authenticated: true, account: 'Local Grok configuration', error: null, models: [{ id: 'grok-model', name: 'Grok model', isDefault: true, efforts: ['low', 'high'], defaultEffort: 'low' }] };
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await option('Grok model · Grok').waitFor();
  await choose('Grok model · Grok');
  assert.equal(await effortChoice.getAttribute('aria-valuetext'), 'High');
  assert.deepEqual(await page.evaluate(() => [localStorage.getItem('papilot:agent'), localStorage.getItem('papilot:model:grok')]), ['grok', 'grok-model']);
  assert.equal(await agentSettings.getByRole('group', { name: 'Grok', exact: true }).locator('[data-brand=grok]').count(), 1);
  await page.screenshot({ path: 'test-results/grok-agent-settings.png', fullPage: true });
  const claudeRuntime = structuredClone(snapshot.runtimes.claude);
  Object.assign(snapshot.runtimes.claude, { connected: false, authenticated: false, error: 'Claude needs an Anthropic API key: Start Papilot with ANTHROPIC_API_KEY set to use Claude.' });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await option('Haiku 5.5 · Claude').getByText('Unavailable', { exact: true }).waitFor();
  await choose('Haiku 5.5 · Claude');
  await agentSettings.getByRole('status').getByText('Claude needs an Anthropic API key', { exact: true }).waitFor();
  await agentSettings.getByText('Connection details', { exact: true }).click();
  await agentSettings.getByText(snapshot.runtimes.claude.error, { exact: true }).waitFor();
  await choose('Deep model · Codex');
  assert.equal(await agentSettings.locator('.agent-connection').count(), 0);
  assert.equal(await settingsTrigger.locator('.agent-status-mark').count(), 0);
  snapshot.runtimes.claude = claudeRuntime;
  assert.equal(await option('Deep model · Codex').getAttribute('aria-selected'), 'true');
  assert.equal(await effortChoice.getAttribute('aria-valuetext'), 'Xhigh');
  assert.equal(await fastMode.isChecked(), true);
  assert.deepEqual(await page.evaluate(() => [localStorage.getItem('papilot:agent'), localStorage.getItem('papilot:model:claude')]), ['codex', 'haiku']);
  await page.screenshot({ path: 'test-results/agent-settings.png', fullPage: true });
  await page.keyboard.press('Escape');
  // Settings and the composer share reasoning levels, reset and saved choices.
  await settingsButton.click();
  const defaultModel = settingsDialog.getByRole('combobox', { name: 'Default model', exact: true });
  const defaultEffort = settingsDialog.getByRole('slider', { name: 'Default reasoning effort', exact: true });
  assert.equal(await selectedValue(defaultModel), JSON.stringify(['codex', 'deep-model']));
  assert.equal(await defaultEffort.getAttribute('aria-valuetext'), 'Xhigh');
  await selectOption(defaultModel, JSON.stringify(['claude', 'haiku']));
  assert.equal(await defaultEffort.getAttribute('max'), '2');
  await defaultEffort.press('Home');
  await defaultEffort.press('ArrowRight');
  assert.equal(await defaultEffort.getAttribute('aria-valuetext'), 'Medium');
  assert.equal(await page.evaluate(() => localStorage.getItem('papilot:effort:claude')), 'medium');
  await selectOption(defaultModel, JSON.stringify(['antigravity', '']));
  assert.equal(await defaultEffort.count(), 0);
  await settingsDialog.getByText('This model uses its own reasoning settings.', { exact: true }).waitFor();
  await selectOption(defaultModel, JSON.stringify(['codex', 'deep-model']));
  assert.equal(await defaultEffort.getAttribute('aria-valuetext'), 'Xhigh');
  // Ultra is offered only when it is in the runtime's model catalog.
  const originalEfforts = snapshot.runtime.models[1].efforts;
  snapshot.runtime.models[1].efforts = [...originalEfforts, 'max', 'ultra'];
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => document.querySelector('.settings-effort input')?.max === '5');
  await defaultEffort.press('End');
  assert.equal(await defaultEffort.getAttribute('aria-valuetext'), 'Ultra');
  assert.equal(await page.evaluate(() => localStorage.getItem('papilot:effort:codex')), 'ultra');
  await page.screenshot({ path: 'test-results/settings-effort-desktop.png', animations: 'disabled' });
  await settingsDialog.getByRole('button', { name: 'Model default', exact: true }).click();
  assert.equal(await page.evaluate(() => localStorage.getItem('papilot:effort:codex')), '');
  assert.equal(await defaultEffort.getAttribute('aria-valuetext'), 'High');
  assert.equal(await settingsDialog.getByRole('button', { name: 'Model default', exact: true }).isDisabled(), true);
  await defaultEffort.press('End');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await settingsDialog.locator('.settings-content').evaluate(el => el.scrollWidth > el.clientWidth), false);
    await page.screenshot({ path: `test-results/settings-effort-${width}.png`, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  snapshot.runtime.models[1].efforts = originalEfforts;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => document.querySelector('.settings-effort input')?.max === '3');
  await defaultEffort.press('End');
  await closeSettings();
  await page.reload();
  await settingsButton.click();
  assert.equal(await selectedValue(defaultModel), JSON.stringify(['codex', 'deep-model']));
  assert.equal(await defaultEffort.getAttribute('aria-valuetext'), 'Xhigh');
  await closeSettings();
  await page.locator('.manuscript-link').click();
  await page.getByRole('tab', { name: 'New task', exact: true }).click();
  assert.match(await settingsTrigger.getAttribute('title'), /Codex.*Deep model.*Xhigh.*Fast/);
  console.log('PASS: Default effort slider follows model capabilities, resets, persists, fits narrow screens and synchronizes with new tasks');
  failCreate = false;
  await page.getByRole('button', { name: 'Start task' }).click();
  await page.waitForFunction(() => document.querySelector('.new-task-panel textarea')?.value === '');
  assert.equal(await prompt.isVisible(), true);
  assert.equal(await page.locator('.task-link.active').count(), 0);
  assert.equal(creates.length, 2);
  assert.equal(creates[1].agent, 'codex');
  assert.equal(creates[1].model, 'deep-model');
  assert.equal(creates[1].effort, 'xhigh');
  assert.equal(creates[1].serviceTier, 'priority');
  assert.equal(creates[0].id, creates[1].id);
  assert.equal(creates[1].title, 'Shorten the introduction');
  assert.equal(creates[1].instructions, 'Shorten the introduction.\nPreserve the technical content.');
  assert.equal(await page.evaluate(() => localStorage.getItem('papilot:new-task')), null);
  console.log('PASS: Enter starts a task, Shift+Enter adds a line, retrying creation retains the same task ID, and agent, model and effort are remembered per agent');

  await page.locator(`[data-task="${task.id}"] .task-link`).click();
  const input = page.getByRole('textbox', { name: 'Instructions for Codex' });
  const previousReview = structuredClone(task.review);
  task.review = { state: 'done', round: 1, counts: { pending: 0, accepted: 1, rejected: 1, commented: 0 }, unsent: 2 };
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByText('2 review updates not sent yet', { exact: true }).waitFor();
  await input.fill('Keep this unsent draft.');
  await page.screenshot({ path: 'test-results/send-review-decisions.png', fullPage: true });
  await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await page.getByRole('button', { name: 'Send instructions', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.send-button').disabled);
  assert.equal(await input.inputValue(), 'Keep this unsent draft.');
  assert.equal(messages[0].feedback, true);
  assert.equal(messages[0].text, '');
  task.review.unsent = 0;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByRole('button', { name: 'Send feedback', exact: true }).waitFor({ state: 'hidden' });
  task.review = previousReview;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByRole('button', { name: 'Send feedback', exact: true }).waitFor();
  holdMessage = new Promise(resolve => { releaseMessage = resolve; });
  await page.getByRole('button', { name: 'Send instructions', exact: true }).click();
  await page.getByText('Sending…', { exact: true }).waitFor();
  await input.fill('New text typed during submission.');
  releaseMessage();
  holdMessage = null;
  await page.waitForFunction(() => !document.querySelector('.send-button').disabled);
  assert.equal(await input.inputValue(), 'New text typed during submission.');
  assert.notEqual(messages[0].requestKey, messages[1].requestKey);
  await page.reload();
  // The deliberate stale selection injected on every load returns to the welcome view.
  await page.getByRole('button', { name: /^Clarify the introduction/ }).click();
  await input.waitFor();
  assert.equal(await input.inputValue(), 'New text typed during submission.');
  console.log('PASS: Feedback and in-flight submission preserve drafts, including after reload');
  const secondTask = { ...task, id: 'fixture-task-0002', name: 'p-second', title: 'Check the notation', review: null };
  snapshot.tasks.push(secondTask);
  await page.getByRole('button', { name: /^Check the notation/ }).waitFor();
  const activeBeforeMenu = await page.locator('.task-link.active').innerText();
  const otherMenu = page.getByRole('button', { name: `Task actions for ${secondTask.title}`, exact: true });
  await otherMenu.click();
  await page.getByRole('menuitem', { name: 'Delete task…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete task?' }).waitFor();
  assert.equal(await page.locator('.delete-task-name').innerText(), secondTask.title);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await otherMenu.evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator('.task-link.active').innerText(), activeBeforeMenu);
  console.log('PASS: Task menus preserve selection and bind confirmation to the originating task');
  secondTask.status = 'running';
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await otherMenu.click();
  await page.getByRole('menuitem', { name: 'Pause task', exact: true }).waitFor();
  await page.getByRole('menuitem', { name: 'Pause task', exact: true }).click();
  assert.deepEqual(interruptions, [secondTask.id]);
  assert.equal(await page.locator('.task-link.active').innerText(), activeBeforeMenu);
  secondTask.status = 'reviewing';
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await otherMenu.click();
  await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
  let renameBox = page.getByRole('textbox', { name: `Rename ${secondTask.title}` });
  assert.equal(await renameBox.evaluate(el => el === document.activeElement), true);
  await renameBox.fill('Something else');
  await renameBox.press('Escape');
  await page.getByRole('button', { name: /^Check the notation/ }).waitFor();
  assert.equal(renames.length, 0);
  await otherMenu.click();
  await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
  renameBox = page.getByRole('textbox', { name: `Rename ${secondTask.title}` });
  await renameBox.fill('Check the notation and symbols');
  await renameBox.press('Enter');
  await page.getByRole('button', { name: /^Check the notation and symbols/ }).waitFor();
  assert.deepEqual(renames, [{ id: secondTask.id, title: 'Check the notation and symbols' }]);
  assert.equal(await page.getByRole('button', { name: /^Check the notation and symbols/ }).evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator('.task-link.active').innerText(), activeBeforeMenu);
  console.log('PASS: Tasks rename inline from their menu; Escape cancels and Enter saves without changing the selection');

  const taskSearch = page.getByRole('searchbox', { name: 'Search tasks', exact: true });
  await taskSearch.fill('  SYMBOLS notation  ');
  assert.equal(await page.locator('.task-link').count(), 1);
  assert.match(await page.locator('.task-link').innerText(), /Check the notation/);
  await taskSearch.fill('technical meaning');
  assert.equal(await page.locator('.task-link').count(), 2, 'search includes initial instructions');
  await taskSearch.fill('不存在的任务');
  await page.getByText('No matching tasks', { exact: true }).waitFor();
  await taskSearch.press('Escape');
  assert.equal(await page.locator('.task-link').count(), 2);
  const renamedMenu = page.getByRole('button', { name: `Task actions for ${secondTask.title}`, exact: true });
  archiveFailure = true;
  await renamedMenu.click(); await page.getByRole('menuitem', { name: 'Archive task', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Could not archive' }).waitFor();
  assert.equal(await page.locator('.task-link').count(), 2, 'failed archive keeps the task visible');
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click(); archiveFailure = false;
  await renamedMenu.click(); await page.getByRole('menuitem', { name: 'Archive task', exact: true }).click();
  await page.getByRole('button', { name: /^Check the notation/ }).waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.task-link.active').innerText(), activeBeforeMenu, 'archiving another task preserves selection');
  await page.getByRole('button', { name: 'Show archived tasks', exact: true }).click();
  assert.equal(await page.locator('.task-link').count(), 1);
  await taskSearch.fill('symbols'); assert.equal(await page.locator('.task-link').count(), 1);
  await page.getByRole('button', { name: 'Clear task search', exact: true }).click();
  await page.getByRole('button', { name: /^Check the notation/ }).click();
  await input.waitFor();
  await renamedMenu.click(); await page.getByRole('menuitem', { name: 'Restore task', exact: true }).click();
  await page.getByRole('button', { name: 'Show archived tasks', exact: true }).waitFor();
  assert.equal(await page.locator('.task-link').count(), 2);
  assert.match(await page.locator('.task-link.active').innerText(), /Check the notation/);
  await renamedMenu.click(); await page.getByRole('menuitem', { name: 'Archive task', exact: true }).click();
  await page.getByRole('heading', { name: 'Manuscript', exact: true }).waitFor();
  await page.reload(); await page.getByRole('button', { name: 'Show archived tasks', exact: true }).waitFor();
  assert.equal(await page.locator('.task-link').count(), 1, 'archived tasks stay hidden after reload');
  await page.getByRole('button', { name: 'Show archived tasks', exact: true }).click();
  await renamedMenu.click(); await page.getByRole('menuitem', { name: 'Restore task', exact: true }).click();
  await page.getByRole('button', { name: /^Clarify the introduction/ }).click(); await input.waitFor();
  assert.deepEqual(archives.map(item => item.archived), [true, false, true, false]);
  console.log('PASS: Tasks search by title and instructions, archive without losing history, and restore from the archive');

  // Navigation only changes the view, even after a task has finished.
  archives.length = 0;
  const finishedTask = { ...task, id: 'fixture-task-0003', name: 'p-finished', title: 'Tidy the bibliography', status: 'reviewing', review: { state: 'done', round: 1, counts: { accepted: 2 }, unsent: 2, comments: 0, files: [] } };
  snapshot.tasks.push(finishedTask);
  await page.clock.runFor(3000);
  const finishedLink = page.getByRole('button', { name: /^Tidy the bibliography/ }), firstLink = page.getByRole('button', { name: /^Clarify the introduction/ });
  await finishedLink.click(); await input.waitFor();
  await input.fill('Ask about the DOI style.');
  await firstLink.click(); await input.waitFor();
  assert.equal(archives.length, 0, 'an unsent follow-up keeps the task listed');
  await finishedLink.click(); await input.waitFor();
  await input.fill('');
  await firstLink.click(); await input.waitFor();
  await finishedLink.waitFor();
  assert.deepEqual(archives, [], 'leaving a completed task does not archive it');
  await finishedLink.click(); await input.waitFor();
  await page.locator('.manuscript-link').click();
  await finishedLink.waitFor();
  assert.deepEqual(archives, [], 'opening the PDF does not archive a completed task');
  await page.reload(); await finishedLink.waitFor();
  assert.deepEqual(archives, [], 'reloading preserves the task list');
  await page.screenshot({ path: 'test-results/tasks-retained-after-navigation.png' });
  await firstLink.click(); await input.waitFor();
  await page.getByRole('button', { name: /^Check the notation/ }).click(); await input.waitFor();
  await firstLink.click(); await input.waitFor();
  assert.equal(archives.length, 0, 'an unfinished task also stays listed');
  snapshot.tasks.splice(snapshot.tasks.indexOf(finishedTask), 1);
  await page.clock.runFor(3000);
  await finishedLink.waitFor({ state: 'hidden' });
  console.log('PASS: Completed tasks remain listed after switching tasks, opening the PDF and reloading');

  await input.fill('Only send this once.');
  holdMessage = new Promise(resolve => { releaseMessage = resolve; });
  const beforeNavigationSend = messages.length;
  await page.getByRole('button', { name: 'Send instructions', exact: true }).click();
  await page.getByText('Sending…', { exact: true }).waitFor();
  await page.getByRole('button', { name: /^Check the notation/ }).click();
  await page.getByRole('button', { name: /^Clarify the introduction/ }).click();
  assert.equal(await page.getByRole('button', { name: 'Send instructions', exact: true }).isDisabled(), true);
  await input.press('Control+Enter');
  await input.fill('New text typed during submission.');
  releaseMessage(); holdMessage = null;
  await page.waitForFunction(() => !document.querySelector('.send-button').disabled);
  assert.equal(messages.length, beforeNavigationSend + 1);
  assert.equal(await input.inputValue(), 'New text typed during submission.');
  console.log('PASS: Task navigation retains pending sends and cannot duplicate a message');
  const beforeEnterSend = messages.length;
  await input.fill('First line');
  await input.press('Shift+Enter');
  await input.pressSequentially('Second line');
  await input.press('Enter');
  await page.waitForFunction(() => document.querySelector('.composer textarea').value === '');
  assert.equal(messages.length, beforeEnterSend + 1);
  assert.equal(messages.at(-1).text, 'First line\nSecond line');
  await input.fill('New text typed during submission.');
  console.log('PASS: Enter sends follow-up instructions and Shift+Enter keeps a new line');

  heldState = new Promise(resolve => { releaseState = resolve; });
  const stateCaptured = new Promise(resolve => { stateStarted = resolve; });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await stateCaptured;
  createResult = { ...secondTask, id: 'fixture-task-0003', title: 'A newly created task' };
  await page.locator('.manuscript-link').click();
  await page.getByRole('tab', { name: 'New task', exact: true }).click();
  await prompt.fill(createResult.title + '\nKeep the manuscript open.');
  await page.getByRole('button', { name: 'Start task' }).click();
  await page.locator(`[data-task="${createResult.id}"] .task-link`).waitFor();
  releaseState();
  assert.equal(await page.locator('.task-link.active').count(), 0);
  assert.equal(await prompt.isVisible(), true);
  createResult = task;
  await page.getByRole('button', { name: /^Clarify the introduction/ }).click();
  console.log('PASS: A stale pre-creation snapshot cannot erase the new task or navigate away from the manuscript');

  await page.frameLocator('.review-frame').locator('#paper').waitFor({ state: 'visible' });
  await page.screenshot({ path: 'test-results/english-desktop.png', fullPage: true });

  snapshot.requests = [{ id: 'question', taskId: task.id, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'scope', question: 'Which section should I revise?', options: [{ label: 'Introduction', description: 'Revise only the introduction.' }] }] }, createdAt: 1 }];
  task.status = 'waiting_input';
  await page.reload();
  await page.getByRole('button', { name: /^Clarify the introduction/ }).click();
  await page.getByRole('heading', { name: 'Codex needs your input' }).waitFor();
  assert.equal(await page.title(), `(1) ${task.title} · Papilot`);
  assert.equal(await page.getByRole('button', { name: 'Reply to Codex' }).isDisabled(), true);
  await page.getByRole('button', { name: /Introduction/ }).click({ timeout: 3000 });
  assert.equal(await page.getByRole('button', { name: 'Reply to Codex' }).isEnabled(), true);
  console.log('PASS: Codex reply requires an answer and shows an accessible pending-input indicator');
  await page.getByRole('textbox', { name: 'Which section should I revise?' }).fill('Keep the theorem statement.');
  await page.getByRole('button', { name: /^Check the notation/ }).click();
  await page.getByRole('button', { name: /^Clarify the introduction/ }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Which section should I revise?' }).inputValue(), 'Keep the theorem statement.');
  console.log('PASS: Unsent answers survive switching tasks');
  // An agent that can only take one of its options (Kimi's ACP choices) gets no free-form answer.
  const question = snapshot.requests[0];
  snapshot.requests = [{ ...question, id: 'choice', params: { questions: [{ id: 'choice', question: 'Which section should Kimi edit?', isOther: false, options: [{ label: 'Introduction' }, { label: 'Model' }] }] } }];
  await page.reload();
  await page.getByRole('button', { name: /^Clarify the introduction/ }).click();
  const choice = page.locator('.request-card').getByRole('button', { name: 'Model', exact: true });
  await choice.waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Which section should Kimi edit?' }).count(), 0);
  await choice.click();
  assert.equal(await page.getByRole('button', { name: 'Reply to Codex' }).isEnabled(), true);
  console.log('PASS: Questions without an "Other" choice offer only their options');
  snapshot.requests = [question];
  await page.reload();
  await page.getByRole('button', { name: /^Clarify the introduction/ }).click();
  await page.getByRole('heading', { name: 'Codex needs your input' }).waitFor();


  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
    if (width < 681) await page.getByRole('button', { name: 'Chat (reply needed)', exact: true }).click();
    await input.waitFor();
    assert.equal(await input.inputValue(), 'New text typed during submission.');
    const overflow = await page.evaluate(() => {
      const containers = ['.app-shell', '.workspace-navigation', '.panel-tools', '.view-selector', '.review-tools', '.composer-wrap'];
      return containers.filter(selector => { const el = document.querySelector(selector); return el && el.clientWidth && el.scrollWidth > el.clientWidth + 1; });
    });
    assert.deepEqual(overflow, [], `overflow at ${width}px`);
    const send = await page.getByRole('button', { name: 'Send instructions', exact: true }).boundingBox();
    assert.ok(send.x >= 0 && send.x + send.width <= width);
    if (width < 681) {
      await page.getByRole('button', { name: /Review/ }).first().click();
      // Phone layouts keep PDF tools in the viewer and the new-tab link in navigation.
      await page.locator('.review-tools').getByRole('link', { name: 'Full PDF', exact: true }).waitFor();
      assert.equal(await page.locator('.workspace-navigation').getByRole('link', { name: 'Open review in new tab', exact: true }).isVisible(), true);
      await page.screenshot({ path: `test-results/english-mobile-${width}.png`, fullPage: true });
    }
    const drawerToggle = page.getByRole('button', { name: 'Show task list', exact: true });
    await drawerToggle.click();
    const drawer = page.getByRole('dialog', { name: 'Papers and tasks' });
    assert.equal(await drawer.evaluate(el => el.contains(document.activeElement)), true);
    assert.equal(await page.locator('.main').evaluate(el => el.inert), true);
    const lastTaskMenu = drawer.getByRole('button', { name: /^Task actions for / }).last();
    await lastTaskMenu.click();
    await page.getByRole('menuitem', { name: 'Delete task…', exact: true }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await drawer.evaluate(el => el.contains(document.activeElement) && document.hasFocus()), true);
    await lastTaskMenu.click();
    await page.getByRole('menuitem', { name: 'Delete task…', exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await drawer.evaluate(el => el.contains(document.activeElement) && document.hasFocus()), true);

    for (let i = 0; i < 14; i++) {
      await page.keyboard.press(i < 8 ? 'Tab' : 'Shift+Tab');
      assert.equal(await drawer.evaluate(el => el.contains(document.activeElement)), true);
    }
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
    assert.equal(await drawerToggle.evaluate(el => el === document.activeElement), true);
    await drawerToggle.click();
    await drawer.getByRole('button', { name: 'Paper: Example paper', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add paper…', exact: true }).click();
    await page.getByRole('dialog', { name: 'Add a paper' }).waitFor();
    await expect(page.getByRole('dialog', { name: 'Add a paper' }).getByRole('button', { name: 'Choose folder', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    if (width === 390) {
      await page.locator('.manuscript-link').click();
      const pdfPage = page.locator('.pdfViewer .page').first();
      await page.locator('.textLayer span').first().waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      const toolbar = page.getByRole('toolbar', { name: 'PDF controls' });
      assert.equal(await toolbar.evaluate(el => el.scrollWidth <= el.clientWidth), true);
      await page.getByRole('button', { name: 'Contents', exact: true }).click();
      await page.getByRole('navigation', { name: 'PDF contents' }).waitFor();
      assert.equal(await pdfPage.isVisible(), false);
      assert.equal(await page.getByRole('button', { name: 'Contents', exact: true }).getAttribute('aria-pressed'), 'true');
      await page.clock.runFor(200);
      await page.screenshot({ path: 'test-results/contents-mobile.png', fullPage: true });
      await page.getByRole('navigation', { name: 'PDF contents' }).getByRole('button', { name: /^Results/ }).click();
      await pdfPage.waitFor();
      await page.waitForFunction(() => document.querySelector('[aria-label="Page number"]').value === '2');
      await page.getByRole('button', { name: 'Git, 2 changed' }).click();
      await page.getByRole('region', { name: 'Git status' }).getByText('main.tex', { exact: true }).waitFor();
      const treesToggle = page.getByRole('region', { name: 'Worktrees', exact: true }).locator('.git-pane-toggle');
      if (await treesToggle.getAttribute('aria-expanded') !== 'true') await treesToggle.click();
      await page.getByRole('region', { name: 'Worktrees', exact: true }).locator(`[data-task-id="${task.id}"]`).waitFor();
      await page.getByRole('region', { name: 'Commit graph', exact: true }).scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      await page.screenshot({ path: `test-results/git-overview-mobile-${width}.png` });
      assert.equal(await pdfPage.isVisible(), false);
      await page.getByRole('button', { name: 'PDF', exact: true }).click();
      await pdfPage.waitFor();
      await page.getByRole('button', { name: 'New task', exact: true }).click();
      await prompt.fill('A task beside the PDF\nKeep the manuscript composer visible.');
      await page.getByRole('button', { name: 'Start task' }).click();
      await page.waitForFunction(() => document.querySelector('.new-task-panel textarea')?.value === '');
      assert.equal(await prompt.isVisible(), true);
      assert.equal(await page.locator('.sidebar').isVisible(), false);
      assert.equal(await page.getByRole('button', { name: 'New task', exact: true }).getAttribute('aria-pressed'), 'true');
      await page.getByRole('button', { name: 'Show task list', exact: true }).click();
      await page.locator(`[data-task="${task.id}"] .task-link`).click();
      await page.getByRole('button', { name: 'Chat (reply needed)', exact: true }).click();
      await input.waitFor();
    } else await page.getByRole('button', { name: 'Hide task list', exact: true }).first().click();
  }
  console.log('PASS: 320px, 390px, and tablet layouts; draft persistence; zoom; drawer; project dialog');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /^Review/ }).first().click();
  await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await input.waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('button', { name: 'Chat (reply needed)', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await input.inputValue(), 'New text typed during submission.');
  await openDelete();
  await page.getByRole('dialog', { name: 'Delete task?' }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: `Task actions for ${task.title}`, exact: true }).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Escape');
  console.log('PASS: Mobile review feedback opens the conversation without clearing drafts; task menu dialogs restore drawer focus');

  await page.setViewportSize({ width: 1440, height: 900 });
  snapshot.requests = []; task.status = 'reviewing';
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.locator(`.task-row[data-task="${task.id}"] .status`).filter({ hasText: 'Ready for review' }).waitFor();
  await input.fill('Keep this draft through connection recovery.');
  await page.getByRole('button', { name: 'Hide task list', exact: true }).first().click();
  stateFailure = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByText('Connection lost. Showing the last update; your draft is kept.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Retry connection' }).isVisible(), true);
  assert.equal(await input.inputValue(), 'Keep this draft through connection recovery.');
  stateFailure = false;
  await page.getByRole('button', { name: 'Retry connection' }).click();
  await page.locator('.connection-banner').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Show task list', exact: true }).click();
  console.log('PASS: Connection loss stays visible with the sidebar collapsed, and recovery preserves drafts');

  itemsFailure = true;
  await page.getByRole('button', { name: /^Check the notation/ }).click();
  await page.getByRole('button', { name: 'Retry conversation' }).waitFor();
  itemsFailure = false;
  await page.getByRole('button', { name: 'Retry conversation' }).click();
  await page.getByRole('button', { name: 'Retry conversation' }).waitFor({ state: 'hidden' });
  reviewFailure = true;
  await page.getByRole('button', { name: /^Clarify the introduction/ }).click();
  await page.getByText('The PDF review could not be loaded.', { exact: true }).waitFor();
  reviewFailure = false;
  await page.getByRole('button', { name: 'Reload review', exact: true }).click();
  await page.frameLocator('.review-frame').locator('#paper').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.review-viewport').getAttribute('aria-busy'), 'false');
  assert.equal(await input.inputValue(), 'Keep this draft through connection recovery.');
  console.log('PASS: Failed conversation and iframe loads recover in place without losing the draft');
  await page.getByRole('button', { name: /^Check the notation/ }).click();
  reviewStarting = true;
  await page.getByRole('button', { name: /^Clarify the introduction/ }).click();
  await page.frameLocator('.review-frame').locator('#root').waitFor({ state: 'attached' });
  await page.clock.fastForward(16000);
  await page.getByText('The PDF review is taking longer than expected.', { exact: true }).waitFor();
  await page.locator('.review-frame').evaluate(frame => { frame.contentDocument.querySelector('#root').innerHTML = '<main id="paper"><p>The delayed review is ready.</p></main>'; });
  await page.frameLocator('.review-frame').getByText('The delayed review is ready.', { exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Reload review', exact: true }).waitFor({ state: 'hidden' });
  reviewStarting = false;
  console.log('PASS: A slow review becomes visible when it finishes without requiring a reload');


  // A task made from PDF notes shows the notes, and the agent's work folds into one line.
  const notesPrompt = 'Revise the manuscript according to these notes the author marked on the compiled PDF. SyncTeX mapped each marked region to the LaTeX file and lines that produced it; the PDF text is what the author saw. Read the current source before editing, and change only what the notes ask for.\n\n1. Page 1 · main.tex line 10\n   LaTeX source of the marked region:\n   ```latex\n   \\title{Small Steps}\n   ```\n   PDF text: "Small Steps, Clearer Papers"\n   Note: Make the title plainer.';
  history = [
    { id: 'notes', taskId: task.id, type: 'user', text: notesPrompt, createdAt: 1 },
    { id: 'cmd-1', taskId: task.id, type: 'command', text: "/bin/zsh -lc 'cat main.tex'", detail: '\\title{Small Steps}', status: 'completed', createdAt: 2 },
    { id: 'cmd-2', taskId: task.id, type: 'command', text: "/bin/zsh -lc 'git status --short'", status: 'completed', createdAt: 3 },
    { id: 'edit', taskId: task.id, type: 'files', text: `${task.worktree}/main.tex`, status: 'completed', createdAt: 4 },
    { id: 'done', taskId: task.id, type: 'assistant', text: 'Changed the title.', createdAt: 5 },
    { id: 'cmd-3', taskId: task.id, type: 'command', text: "/bin/zsh -lc 'latexmk -pdf main.tex'", status: 'inProgress', createdAt: 6 },
  ];
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  const sentNotes = page.locator('.notes-message');
  await sentNotes.waitFor();
  assert.equal(await sentNotes.locator('.sent-notes-head').innerText(), 'Note on the PDF');
  assert.equal(await sentNotes.locator('.sent-note-number').innerText(), '1');
  assert.equal(await sentNotes.locator('.sent-note-location').innerText(), 'Page 1 · main.tex line 10');
  assert.equal(await sentNotes.locator('blockquote').innerText(), 'Small Steps, Clearer Papers');
  assert.equal(await sentNotes.locator('p').innerText(), 'Make the title plainer.');
  assert.doesNotMatch(await page.locator('.thread').innerText(), /SyncTeX|```/);
  const work = page.locator('.tool-group');
  assert.equal(await work.count(), 1);
  assert.equal(await page.locator('.tool-group > summary').innerText(), 'Ran 2 commands, edited main.tex');
  assert.equal(await work.locator('.tool-item').first().isVisible(), false);
  await page.locator('.tool-group > summary').click();
  assert.deepEqual(await work.locator('.tool-label').allInnerTexts(), ['cat main.tex', 'git status --short', 'Edited main.tex']);
  assert.equal(await page.locator('.thread > .tool-item .tool-label').innerText(), 'latexmk -pdf main.tex');
  // A task on the host's default model names that model.
  assert.equal(await page.locator('.activity-panel .agent-picker .agent-model-name').innerText(), 'Fast model');
  assert.equal(await page.locator('.activity-panel .agent-picker .agent-model-label small').innerText(), 'Medium');
  console.log('PASS: Notes sent from the PDF read as notes, and consecutive commands fold into one line with task paths');

  history = Array.from({ length: 120 }, (_, i) => ({ id: `history-${i}`, taskId: task.id, type: 'assistant', text: `Message ${i}: A detailed review of the argument.`, createdAt: i + 1 }));
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByText('Message 119: A detailed review of the argument.', { exact: true }).waitFor();
  const scroller = page.locator('.messages');
  assert.ok(await scroller.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 5));
  await scroller.evaluate(el => { el.scrollTop = 0; });
  await page.getByRole('button', { name: 'Latest messages' }).waitFor();
  history.push({ ...history[0], id: 'history-new', text: 'A new message while reading history.' });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByText('A new message while reading history.', { exact: true }).waitFor();
  assert.equal(await scroller.evaluate(el => el.scrollTop), 0);
  await page.getByRole('button', { name: 'Latest messages' }).click();
  assert.ok(await scroller.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 5));
  history = null;
  task.status = 'failed'; task.error = 'A build failed in the test fixture.'; task.review.job = { status: 'failed' };
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByRole('button', { name: 'Retry build', exact: true }).waitFor();
  await page.getByRole('button', { name: 'View details', exact: true }).click();
  assert.equal(await views.getByRole('button', { name: 'Chat', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.getByText(task.error, { exact: true }).waitFor();
  task.error = null; task.review.job = null;
  await selectWorkspaceView('Split');
  console.log('PASS: Long conversations follow new messages, preserve history reading position, and offer a jump back');

  task.status = 'running';
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  const pauseButton = page.locator('.composer').getByRole('button', { name: 'Pause task' });
  await pauseButton.waitFor();
  assert.equal(await page.locator('.panel-heading').getByRole('button', { name: 'Pause task' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Send instructions', exact: true }).isEnabled(), true);
  await selectWorkspaceView('Review');
  await page.locator('.review-tools').getByRole('button', { name: 'Pause task' }).waitFor();
  await selectWorkspaceView('Split');
  await pauseButton.click();
  assert.equal(interruptions.at(-1), task.id);
  task.status = 'running';
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await pauseButton.waitFor();
  console.log('PASS: Pause sits in the composer while Codex works and moves to the review toolbar when the chat is hidden');
  await openDelete();
  const deleteDialog = page.getByRole('dialog', { name: 'Delete task?' });
  await deleteDialog.waitFor();
  assert.equal(await deleteDialog.getByRole('button', { name: 'Cancel', exact: true }).evaluate(el => el === document.activeElement), true);
  assert.equal(await deleteDialog.getByRole('button', { name: 'Delete task', exact: true }).isDisabled(), true);
  await page.getByText('Pause this task before deleting it.', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(deletions.length, 0);
  task.status = 'reviewing';
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.locator(`.task-row[data-task="${task.id}"] .status`).filter({ hasText: 'Ready for review' }).waitFor();
  await openDelete();
  await deleteDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(deletions.length, 0);
  await openDelete();
  deleteFailure = true;
  await deleteDialog.getByRole('button', { name: 'Delete task', exact: true }).click();
  await deleteDialog.getByRole('alert').waitFor();
  await deleteDialog.getByRole('button', { name: 'Retry deletion', exact: true }).waitFor();
  await deleteDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Send instructions', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Retry deletion', exact: true }).click();
  deleteFailure = false;
  await deleteDialog.getByRole('button', { name: 'Retry deletion', exact: true }).click();
  await deleteDialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: /^Clarify the introduction/ }).waitFor({ state: 'hidden' });
  assert.deepEqual(deletions, [{ id: task.id, body: { confirm: true } }, { id: task.id, body: { confirm: true } }]);
  assert.equal(await page.getByRole('button', { name: /^Check the notation/ }).count(), 1);
  assert.equal(await page.evaluate(id => localStorage.getItem('papilot:draft:' + id), task.id), null);
  console.log('PASS: Task deletion defaults to Cancel, blocks active tasks, retries uncertain cleanup, and removes only the confirmed task');
  await page.getByRole('button', { name: /^Check the notation/ }).click();
  await input.fill('A draft on a task removed elsewhere.');
  await openDelete(secondTask.title);
  await deleteDialog.waitFor();
  snapshot.tasks = snapshot.tasks.filter(t => t.id !== secondTask.id);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await deleteDialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: /^Check the notation/ }).waitFor({ state: 'hidden' });
  assert.equal(deletions.length, 2);
  assert.equal(await page.evaluate(id => localStorage.getItem('papilot:draft:' + id), secondTask.id), null);
  console.log('PASS: Deletion in another tab closes a stale confirmation and clears only that task’s local draft');

  // Opening on a task from a paper other than the first keeps New task on that paper.
  const otherPaper = { id: 'second-paper', name: 'Second paper', path: '/tmp/second', createdAt: 2 };
  const otherTask = { ...task, id: 'other-task-0001', projectId: otherPaper.id, name: 'p-other', title: 'Polish the second paper', status: 'reviewing', review: null };
  const papers = await browser.newContext({ locale: 'en-US', colorScheme: 'light', viewport: { width: 1440, height: 900 } });
  const papersPage = await papers.newPage();
  const paperState = { ...snapshot, projects: [...snapshot.projects, otherPaper], tasks: [otherTask], requests: [] };
  await papersPage.route('**/api/**', route => route.fulfill({ json: route.request().url().endsWith('/api/state') ? paperState : { items: [], build: { status: 'building' }, git: { files: [] } } }));
  await papersPage.goto(origin);
  await papersPage.getByRole('heading', { name: otherTask.title }).waitFor();
  assert.equal(await papersPage.getByRole('button', { name: /^Paper:/ }).getAttribute('aria-label'), 'Paper: Second paper');
  await papersPage.locator('.manuscript-link').click();
  await papersPage.getByRole('tab', { name: 'New task', exact: true }).click();
  await papersPage.getByRole('textbox', { name: 'Describe the revision' }).waitFor();
  assert.equal(await papersPage.getByRole('button', { name: /^Paper:/ }).getAttribute('aria-label'), 'Paper: Second paper');
  // A saved empty task means the manuscript. A newer task in another paper
  // must not steal the page on reload, nor change the selected paper.
  const unrelatedTask = { ...otherTask, id: 'unrelated-task', projectId: snapshot.projects[0].id, title: 'A newer task in the first paper' };
  paperState.tasks.push(unrelatedTask);
  const manuscriptDraft = papersPage.getByRole('textbox', { name: 'Describe the revision' });
  await manuscriptDraft.fill('Continue editing this paper after reload.');
  await papersPage.reload();
  await manuscriptDraft.waitFor();
  assert.equal(await manuscriptDraft.inputValue(), 'Continue editing this paper after reload.');
  assert.equal(await papersPage.locator('.task-grid').count(), 0);
  assert.equal(await papersPage.getByRole('button', { name: /^Paper:/ }).getAttribute('aria-label'), 'Paper: Second paper');
  assert.deepEqual(await papersPage.evaluate(() => [localStorage.getItem('papilot:task'), localStorage.getItem('papilot:project')]), ['', otherPaper.id]);
  await papersPage.getByRole('button', { name: new RegExp('^' + otherTask.title) }).click();
  await papersPage.getByRole('heading', { name: otherTask.title, exact: true }).waitFor();
  await papersPage.reload();
  await papersPage.getByRole('heading', { name: otherTask.title, exact: true }).waitFor();
  assert.equal(await papersPage.getByRole('button', { name: /^Paper:/ }).getAttribute('aria-label'), 'Paper: Second paper');
  // A task removed while the page was closed falls back to its manuscript,
  // and the next reload must keep that explicit manuscript selection.
  paperState.tasks = [unrelatedTask];
  await papersPage.reload(); await manuscriptDraft.waitFor();
  await papersPage.reload(); await manuscriptDraft.waitFor();
  assert.equal(await papersPage.getByRole('button', { name: /^Paper:/ }).getAttribute('aria-label'), 'Paper: Second paper');
  paperState.projects = snapshot.projects;
  await papersPage.reload(); await manuscriptDraft.waitFor();
  assert.equal(await papersPage.getByRole('button', { name: /^Paper:/ }).getAttribute('aria-label'), `Paper: ${snapshot.projects[0].name}`);
  assert.equal(await papersPage.evaluate(() => localStorage.getItem('papilot:project')), snapshot.projects[0].id);
  await papers.close();
  console.log('PASS: Reload restores the manuscript or selected task and its paper, preserves drafts, and recovers from removed tasks and papers');

  const restricted = await browser.newContext({ locale: 'en-US', colorScheme: 'light', viewport: { width: 1280, height: 800 } });
  await restricted.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage blocked', 'SecurityError'); } }));
  const restrictedPage = await restricted.newPage();
  const restrictedErrors = [];
  restrictedPage.on('pageerror', error => restrictedErrors.push(error.message));
  await restrictedPage.route('**/api/**', route => route.fulfill({ json: route.request().url().endsWith('/api/state') ? { ...snapshot, tasks: [secondTask], requests: [] } : { items: [] } }));
  await restrictedPage.goto(origin);
  const restrictedInput = restrictedPage.getByRole('textbox', { name: 'Instructions for Codex' });
  await restrictedInput.fill('A usable draft with storage disabled.');
  assert.equal(await restrictedInput.inputValue(), 'A usable draft with storage disabled.');
  assert.deepEqual(restrictedErrors, []);
  await restricted.close();
  console.log('PASS: Blocked browser storage does not prevent loading or editing');
  assert.deepEqual(pageErrors, []);
  console.log('PASS: No uncaught browser errors');
} finally {
  await browser.close();
  await server.close();
}
