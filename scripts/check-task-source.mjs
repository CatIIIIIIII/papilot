// A change's source, edited in the workspace's editor beside a task's review:
// the real review engine and Papilot routes with a real LaTeX paper; only the
// agent is replaced. All files and servers belong to this disposable fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { chromium, expect } from '../engine/node_modules/@playwright/test/index.mjs';
import { Fixture, METHOD } from '../engine/tests/ts/helpers.ts';
import { createServer } from '../engine/src/server.ts';

const f = new Fixture();
process.env.PAPILOT_DATA = path.join(f.base, 'data');
const [{ Store }, { Workspace }, { Manuscripts }, { buildApp, gitQueue }, { AGENT_IDS }] = await Promise.all([
  import('../src/server/store.ts'), import('../src/server/workspace.ts'), import('../src/server/manuscript.ts'),
  import('../src/server/app.ts'), import('../src/shared.ts'),
]);
f.write('paper/main.tex', '\\documentclass{article}\n\\begin{document}\n\\input{sections/method}\n\\end{document}\n');
const BEFORE = '\\section{First}\nOriginal first paragraph.\n\\newpage\n\\section{Second}\nOriginal second paragraph.\n\\newpage\n\\section{Third}\nOriginal third paragraph.\n';
f.write(METHOD, BEFORE);
f.repo.run(['add', '-A']); f.repo.run(['commit', '-qm', 'Three pages']);
const app = f.app(); await app.ready;
const task = app.tasks.create('sources', 'Edit three pages', [], ['paper'], true);
f.edit(task, METHOD, 'Original first', 'Proposed first');
f.edit(task, METHOD, 'Original second', 'Proposed second');
f.edit(task, METHOD, 'Original third', 'Proposed third');
app.publisher.submit(task.name); await app.publisher.join();
assert.equal(app.review.latestRound(task.name)?.visuals, 'ready');
const engine = createServer(app);
await engine.listen({ host: '127.0.0.1', port: 0 });
app.url = `http://127.0.0.1:${engine.server.address().port}`;
const call = async (route, body) => {
  const response = await fetch(app.url + route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Review-Token': app.csrf }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || response.statusText);
  return result;
};
const client = { url: app.url, token: app.csrf, get: route => call(route), post: (route, body = {}) => call(route, body) };
class Agent extends EventEmitter { ready = false; close() {} }
const store = new Store(':memory:');
const workspace = new Workspace(store, new Agent(), async () => client, Object.fromEntries(AGENT_IDS.filter(id => id !== 'codex').map(id => [id, new Agent()])));
store.saveProject({ id: 'paper', path: f.root, name: 'Paper', createdAt: 1 });
store.saveTask({ id: 'sources', projectId: 'paper', name: task.name, title: task.title, instructions: '', worktree: task.worktree, threadId: null, turnId: null, model: null, status: 'reviewing', deferred: true, createdAt: 1, updatedAt: 1, feedbackCursor: 0, error: null, review: null });
await workspace.refresh('sources');
const manuscripts = new Manuscripts();
manuscripts.predict = async () => {};
const listener = { kind: 'local', port: 0, publicOrigin: '', owner: '' };
const server = await buildApp({ listener, store, workspace, manuscripts, csrf: 'fixture', serialGit: gitQueue(), dist: path.resolve('dist'), version: 'test', connectReview: async () => client });
await server.listen({ host: '127.0.0.1', port: 0 });
listener.port = server.server.address().port;
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const errors = [];
const worktree = () => fs.readFileSync(path.join(task.worktree, METHOD), 'utf8');
try {
  const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 950 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
  await page.addInitScript(() => { localStorage.setItem('papilot:task', 'sources'); localStorage.setItem('papilot:project', 'paper'); localStorage.setItem('papilot:language', 'en'); });
  await page.goto(`http://127.0.0.1:${listener.port}`);
  const viewer = page.frameLocator('.review-frame'), side = page.locator('#conversation-panel');
  await expect(viewer.locator('.change.current')).toBeVisible({ timeout: 60000 });

  // LaTeX on a change opens its file beside the chat, at the change, not in the card.
  await viewer.locator('.change.current .source-toggle').click();
  const tab = side.getByRole('tab', { name: 'method.tex' }), chat = side.getByRole('tab', { name: 'Chat' });
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(tab).toHaveAttribute('title', METHOD);
  await expect(viewer.locator('.change.current .source'), 'the card shows no source of its own').toHaveCount(0);
  const editor = side.locator('.cm-editor'), field = side.locator('.cm-content');
  await expect(editor).toBeVisible();
  await expect(side.locator('.composer-wrap'), 'the editor takes the chat\'s place').toBeHidden();
  const text = () => field.evaluate(content => [...content.querySelectorAll('.cm-line')].map(line => line.textContent.replace(/\u200b/g, '')).join('\n'));
  await expect(field).toBeFocused();

  // The round's changes show in the text as the review's cards: a header
  // with the card's title and actions, the line as it was, the line now.
  const cards = side.locator('.cm-review-card');
  await expect(cards).toHaveCount(3);
  await expect(cards.locator('.cm-review-title')).toHaveText(['Change 1', 'Change 2', 'Change 3']);
  await expect(cards.first().locator('.cm-review-before')).toHaveText('Original first paragraph.');
  await expect(cards.first().locator('.cm-review-before')).toHaveAttribute('data-label', 'Before');
  await expect(side.locator('.cm-review-removed')).toHaveText(['Original', 'Original', 'Original']);
  await expect(side.locator('.cm-line.cm-review-after')).toHaveCount(3);
  await expect(side.locator('.cm-line.cm-review-after').first()).toHaveAttribute('data-label', 'After');
  await expect(side.locator('.cm-review-added')).toHaveText(['Proposed', 'Proposed', 'Proposed']);
  await expect(cards.first().locator('.cm-review-buttons button')).toHaveCount(3);
  await expect(side.locator('.cm-change-bar'), 'bars mark what the task changed').toHaveCount(3);
  await page.screenshot({ path: 'test-results/task-source-review.png' });

  // The caret on a change makes it the review's current change.
  await side.locator('.cm-line', { hasText: 'third paragraph' }).click();
  await expect(viewer.locator('.change.current')).toHaveAttribute('data-stop', '2');

  // Accepting in the editor decides the change in the review; its marks go.
  await cards.nth(0).locator('.cm-review-accept').click();
  await expect.poll(() => app.review.pageState(task.name).decisions.c001).toBe('accepted');
  await expect(cards).toHaveCount(2);
  await expect(side.locator('.cm-review-removed')).toHaveCount(2);

  // Rejecting returns the task's text, which the editor then shows.
  await cards.nth(0).locator('.cm-review-reject').click();
  await expect.poll(() => app.review.pageState(task.name).decisions.c002).toBe('rejected');
  await expect.poll(worktree, { timeout: 60000 }).toContain('Original second paragraph.');
  await expect.poll(text, { timeout: 30000 }).toContain('Original second paragraph.');
  await expect(cards, 'the change after it keeps its place and its card').toHaveCount(1);
  await expect(cards.locator('.cm-review-title')).toHaveText('Change 3');
  await expect(side.locator('.cm-review-added')).toHaveText(['Proposed']);
  await expect(side.locator('.cm-line', { hasText: 'third paragraph' }).locator('.cm-review-added')).toHaveText('Proposed');

  // Comment starts a comment on the card, which is written in the chat.
  await cards.locator('.cm-review-comment').click();
  await expect(viewer.locator('.change.current')).toHaveAttribute('data-stop', '2');
  await expect(chat).toHaveAttribute('aria-selected', 'true');
  await expect(side.locator('.review-draft')).toBeVisible();
  await expect(side.locator('.review-draft-location'), 'the comment is on the card\'s change').toContainText('Page 3');
  await tab.click();
  await expect.poll(() => app.review.latestRound(task.name)?.visuals, { timeout: 90000 }).toBe('ready');

  // Typing marks the tab; the chat keeps its place, and so does the draft.
  await side.locator('.cm-line', { hasText: 'third paragraph' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed in Papilot.');
  const unsaved = side.locator('.side-tab-close[data-dirty]');
  await expect(unsaved).toHaveAttribute('title', /^Unsaved/);
  await chat.click();
  await expect(side.locator('.composer-wrap')).toBeVisible();
  await expect(editor).toBeHidden();
  await tab.click();
  await expect.poll(text).toContain('Proposed third paragraph. Typed in Papilot.');
  fs.mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/task-source-edit.png' });

  // ⌘S writes the task's file, without an agent, and reviews it in a new round.
  const round = app.review.latestRound(task.name).number;
  await field.press('ControlOrMeta+s');
  await expect.poll(worktree, { timeout: 60000 }).toContain('Proposed third paragraph. Typed in Papilot.');
  assert.equal(fs.readFileSync(path.join(f.root, METHOD), 'utf8'), BEFORE, 'the manuscript itself is untouched');
  await expect(unsaved, 'a saved file has no dot').toHaveCount(0);
  await expect.poll(() => app.review.latestRound(task.name)?.number, { timeout: 90000 }).toBeGreaterThan(round);
  await expect.poll(() => app.review.latestRound(task.name)?.visuals, { timeout: 90000 }).toBe('ready');
  await expect(viewer.locator('.change').last()).toContainText('Typed in Papilot', { timeout: 60000 });
  await expect(side.locator('.cm-review-added').last(), 'the new round\'s changes show in the text').toContainText('Typed in Papilot', { timeout: 30000 });
  await page.screenshot({ path: 'test-results/task-source-saved.png' });
  await expect(side.locator('.source-panel-error')).toHaveCount(0);

  // Closing the tab returns to the chat.
  await side.locator('.side-tab-close').click();
  await expect(tab).toHaveCount(0);
  await expect(chat).toHaveCount(0);
  await expect(side.locator('.composer-wrap')).toBeVisible();

  // An earlier round keeps its inline LaTeX: the editor shows the files as
  // they are now, with the latest round's changes.
  await viewer.getByRole('button', { name: 'History', exact: true }).click();
  await viewer.getByRole('combobox', { name: 'Review history' }).selectOption(String(round));
  await expect(viewer.locator('.change.current')).toBeVisible({ timeout: 60000 });
  await viewer.locator('.change.current .source-toggle').click();
  await expect(viewer.locator('.change.current .source'), 'an earlier round shows its LaTeX in the card').toBeVisible();
  await expect(side.getByRole('tab', { name: 'method.tex' }), 'the editor does not open for an earlier round').toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log('PASS: LaTeX on a change opens its whole file in the editor beside the chat, which shows the round\'s changes as the review\'s cards (title, Accept, Reject and Comment over the lines before and after) acting through the review; rejected text comes back and the rest stay placed; the caret and the review follow each other; ⌘S saves into the task and reviews it in a new round; the chat stays as it was');
} finally {
  await browser.close();
  await server.close(); await engine.close(); workspace.close(); store.close();
  await f.close();
}
