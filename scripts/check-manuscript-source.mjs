// Editing the manuscript's LaTeX by hand from its PDF and from its Changes
// view, through the browser, against a real Papilot server, review engine,
// Git and LaTeX. Only the agents are inert; the repository, state and
// browser profile are disposable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chromium, expect } from '../engine/node_modules/@playwright/test/index.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-source-edit-'));
process.env.PAPILOT_DATA = path.join(temp, 'data');
delete process.env.PAPILOT_DESKTOP;
const [{ App, createServer }, { Store }, { Workspace }, { Manuscripts }, { buildApp, gitQueue }, { Updates }, { AGENT_IDS }] = await Promise.all([
  import('../engine/src/server.ts'), import('../src/server/store.ts'), import('../src/server/workspace.ts'), import('../src/server/manuscript.ts'),
  import('../src/server/app.ts'), import('../src/server/updates.ts'), import('../src/shared.ts'),
]);
class InertAgent extends EventEmitter { ready = false; close() {} }
const root = path.join(temp, 'paper'), intro = path.join(root, 'sections/intro.tex');
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
// Filler between the passages keeps their changes apart in the Changes view.
const FILLER = Array.from({ length: 10 }, (_, index) => `Filler sentence ${index + 1} keeps the changes apart.`).join('\n');
const ORIGINAL = `\\section{Introduction}\nAn opening paragraph that sets the scene.\nIt has a second line of prose.\n\nA separate paragraph about pelicans.\nPelicans glide over the water.\n\n${FILLER}\n\nA closing paragraph.\n`;
fs.mkdirSync(path.join(root, 'sections'), { recursive: true });
fs.writeFileSync(path.join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}\n');
fs.writeFileSync(intro, ORIGINAL);
git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@localhost');
git('add', '.'); git('commit', '-qm', 'Paper');

const engine = new App(root);
const reviewServer = createServer(engine);
await reviewServer.listen({ host: '127.0.0.1', port: 0 });
engine.url = `http://127.0.0.1:${reviewServer.server.address().port}`;
const call = async (route, body) => {
  const response = await fetch(engine.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Review-Token': engine.csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || response.statusText);
  return result;
};
const review = { url: engine.url, token: engine.csrf, get: route => call(route), post: (route, body = {}) => call(route, body) };
fs.mkdirSync(process.env.PAPILOT_DATA, { recursive: true });
const store = new Store(path.join(process.env.PAPILOT_DATA, 'state.sqlite3')), manuscripts = new Manuscripts();
const workspace = new Workspace(store, new InertAgent(), async () => review, Object.fromEntries(AGENT_IDS.filter(id => id !== 'codex').map(id => [id, new InertAgent()])));
store.saveProject({ id: 'paper', name: 'Pelican paper', path: root, createdAt: Date.now() });
const listener = { kind: 'local', port: 0, publicOrigin: '', owner: '' };
const updates = new Updates({ root: process.cwd(), data: process.env.PAPILOT_DATA, version: '0.9.2', port: 0, supported: false, busy: () => false, shutdown() {}, latest: async () => '0.9.2' });
const server = await buildApp({ store, workspace, manuscripts, listener, csrf: 'source-edit-test', serialGit: gitQueue(), dist: path.resolve('dist'), version: '0.9.2', connectReview: async () => review, updates });
await server.listen({ host: '127.0.0.1', port: 0 }); listener.port = server.server.address().port;
const origin = `http://127.0.0.1:${listener.port}`;
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(20000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => { if (response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
fs.mkdirSync('test-results', { recursive: true });
const shot = name => page.screenshot({ path: `test-results/manuscript-source-${name}.png` });
const settle = async () => {
  let result;
  await expect.poll(async () => { result = await manuscripts.state('paper', root); return result.build.status; }, { timeout: 90000 }).not.toBe('building');
  return result.build;
};

try {
  assert.equal((await settle()).status, 'ready');
  await page.addInitScript(() => { localStorage.setItem('papilot:project', 'paper'); localStorage.setItem('papilot:language', 'en'); });
  await page.goto(origin);
  const word = text => page.locator('.pdf-view .textLayer span', { hasText: text }).first();
  await expect(word('pelicans')).toBeVisible({ timeout: 60000 });
  const rail = page.getByRole('toolbar', { name: 'Marking tools' });
  const panel = page.locator('.source-panel'), field = panel.getByRole('textbox', { name: 'Edit LaTeX source' });
  const tabs = page.getByRole('tablist', { name: 'Manuscript panels' }), close = tabs.locator('.side-tab-close'), unsaved = tabs.locator('.side-tab-close[data-dirty]');
  // A build of the working tree as it is now, finished and shown.
  const compiled = async () => { const build = await settle(); assert.equal(build.status, 'ready', build.error); await expect(page.locator('.manuscript-note.error.brief')).toHaveCount(0); return build; };
  const text = () => field.evaluate(content => [...content.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'));
  const setText = async value => { await field.click(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.insertText(value); };
  // A flash lasts a moment: record every line that flashes from now on.
  const watchFlashes = () => page.evaluate(() => {
    const seen = window.flashedLines = [];
    new MutationObserver(() => document.querySelectorAll('.source-panel .cm-source-flash').forEach(line => seen.push(line.textContent)))
      .observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  });
  const flashed = () => page.evaluate(() => (window.flashedLines || []).join('\n'));

  // The tool opens the clicked passage's file in a tab beside New task, at
  // the passage, with the clicked line highlighted and flashing.
  await rail.getByRole('button', { name: 'Edit source' }).click();
  await watchFlashes();
  await word('pelicans').click();
  await expect(panel.locator('.cm-editor')).toBeVisible();
  await expect.poll(text).toBe(ORIGINAL);
  await expect(tabs.getByRole('tab', { name: 'intro.tex' }), 'the tab names the file and shows its path').toHaveAttribute('title', 'sections/intro.tex');
  await expect(panel.locator('header'), 'the tab is the only header').toHaveCount(0);
  await expect(panel.locator('.cm-source-focus')).toContainText('pelicans');
  await expect(panel.locator('.cm-source-word'), 'the clicked word stands out').toHaveText('pelicans');
  await expect(field).toBeFocused();
  await expect(tabs.getByRole('tab', { name: 'intro.tex' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.source-mark').first()).toBeVisible();
  await expect.poll(flashed, { message: 'the passage flashes in the editor' }).toContain('A separate paragraph about pelicans.');
  await expect(page.locator('.source-beam'), 'only highlights join the page and the editor').toHaveCount(0);
  await expect(panel.locator('.cm-change-bar')).toHaveCount(0);
  await page.waitForTimeout(700);
  await shot('open');

  // What changed since the last commit, as bars beside the lines while editing.
  await page.keyboard.press('End');
  await page.keyboard.type(' Really.');
  await expect(panel.locator('.cm-change-modified')).toHaveCount(1);
  await expect(panel.locator('.cm-change-ruler .cm-ruler-modified'), 'the change shows along the scrollbar').toHaveCount(1);
  await expect(panel.getByText('1 change'), 'no count in the header').toHaveCount(0);
  await expect(unsaved, 'unsaved changes show as a dot on the tab').toHaveAttribute('title', /^Unsaved/);
  await expect(page.getByRole('button', { name: 'Save', exact: true }), 'unsaved changes show as a mark, not a Save button').toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Compare' }), 'comparing belongs to version management').toHaveCount(0);
  await shot('changed');

  // Saving writes the file without an agent; the PDF marks the saved lines.
  const herons = ORIGINAL.replace('A separate paragraph about pelicans.\nPelicans glide over the water.', 'A separate paragraph about herons.\nHerons wade in the shallows.');
  await setText(herons);
  await watchFlashes();
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => fs.readFileSync(intro, 'utf8')).toBe(herons);
  await expect(word('herons')).toBeVisible({ timeout: 60000 });
  await expect(page.locator('.problem-flash')).toBeVisible();
  await expect.poll(flashed, { message: 'the saved lines flash with the PDF' }).toContain('Herons wade in the shallows.');
  await expect(unsaved, 'a saved file has no dot').toHaveCount(0);
  await expect(panel.locator('.cm-change-modified')).toHaveCount(2);
  await shot('saved');

  // A version that does not compile keeps the last PDF and shows the error on its line.
  const before = (await settle()).key;
  await setText(herons.replace('Herons wade in the shallows.', 'Herons \\undefinedcommand{wade}.'));
  await field.press('ControlOrMeta+s');
  await expect(panel.locator('.source-panel-problems')).toBeVisible({ timeout: 60000 });
  await expect(panel.locator('.source-panel-problem').first()).toContainText(/Line \d+/);
  await expect(page.locator('.manuscript-note.error.brief')).toBeVisible();
  assert.equal((await settle()).key, before, 'the last PDF stays');
  await panel.locator('.source-panel-problem').first().click();
  await expect(field).toBeFocused();
  await shot('failed');

  // Repairing it compiles again.
  await setText(herons);
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => fs.readFileSync(intro, 'utf8')).toBe(herons);
  await expect(panel.locator('.source-panel-problems')).toHaveCount(0, { timeout: 60000 });
  await compiled();

  // Another editor changes the file meanwhile: the save is refused and the draft kept.
  await field.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.type('Mine.');
  fs.writeFileSync(intro, '% Edited elsewhere\n' + fs.readFileSync(intro, 'utf8'));
  await page.keyboard.press('ControlOrMeta+s');
  await expect(panel.locator('.source-panel-error')).toContainText('changed while you were editing');
  assert.match(await text(), /Mine\./);
  assert.doesNotMatch(fs.readFileSync(intro, 'utf8'), /Mine\./);
  await panel.getByRole('button', { name: 'Load the current source' }).click();
  await expect(panel.locator('.source-panel-error')).toHaveCount(0);
  await expect.poll(text).toBe(fs.readFileSync(intro, 'utf8'));

  // A closed tab keeps its draft for the same version of the file.
  await settle();
  await expect(word('herons')).toBeVisible({ timeout: 60000 });
  await field.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.type('Draft words.');
  await expect.poll(text).toMatch(/Draft words\.$/);
  await page.waitForTimeout(600);
  await close.click();
  await expect(tabs.getByRole('tab', { name: 'intro.tex' })).toHaveCount(0);
  await word('herons').click();
  await expect.poll(text).toMatch(/Draft words\.$/);
  await expect(unsaved, 'the restored draft is unsaved').toBeVisible();
  await field.press('Escape');
  await expect(panel, 'Escape keeps a tab with unsaved changes').toBeVisible();
  await field.press('ControlOrMeta+z');
  await expect.poll(text, 'one undo returns to the file on disk').toBe(fs.readFileSync(intro, 'utf8'));
  await expect(unsaved).toHaveCount(0);
  await field.press('Escape');
  await expect(panel).toHaveCount(0);

  // New task and the editor are tabs; switching keeps the file.
  await word('herons').click();
  await expect(panel).toBeVisible();
  await expect(tabs.getByRole('tab', { name: 'intro.tex' }), 'the clicked passage opens its file').toBeAttached();
  await tabs.getByRole('tab', { name: 'New task' }).click();
  await expect(panel).toBeHidden();
  await tabs.getByRole('tab', { name: 'intro.tex' }).click();
  await expect(field).toBeVisible();

  // With the Select tool, a selection offers its source beside "Add note".
  await field.press('Escape');
  await expect(panel).toHaveCount(0);
  await page.locator('.pdf-container').focus(); await page.keyboard.press('v');
  await word('closing').dblclick();
  await page.locator('.add-source').click();
  await expect(panel.locator('.cm-source-focus')).toContainText('closing');
  await expect(panel.locator('.cm-source-word'), 'the selected word stands out').toHaveText('closing');

  // In Changes, picking a change opens its lines in the editor, and moving
  // to a changed line in the editor shows its change.
  await setText(fs.readFileSync(intro, 'utf8').replace('A closing paragraph.', 'A closing paragraph, rewritten.'));
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => fs.readFileSync(intro, 'utf8')).toMatch(/rewritten/);
  await compiled();
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  const viewer = page.frameLocator('.review-frame');
  const rewritten = viewer.locator('article.change', { hasText: 'rewritten' }), heronsChange = viewer.locator('article.change', { hasText: 'herons' }).first();
  await expect(rewritten).toBeVisible({ timeout: 90000 });
  const count = await viewer.locator('article.change').count(), picked = await rewritten.getAttribute('data-stop');
  // The viewer starts on a change, which the open editor follows; then the author picks another.
  await expect(viewer.locator('article.change.current')).toBeVisible();
  await rewritten.click();
  await expect(viewer.locator('article.change.current')).toHaveAttribute('data-stop', picked);
  await expect(panel.locator('.cm-source-focus')).toHaveText(['A closing paragraph, rewritten.']);
  await expect.poll(flashed).toContain('A closing paragraph, rewritten.');
  await page.waitForTimeout(500);
  await shot('changes');
  assert.ok(count >= 2, `separate changes stay apart: ${count}`);
  await expect(panel.locator('.cm-source-focus')).toHaveCount(1);
  await panel.locator('.cm-line', { hasText: 'Herons wade' }).click();
  await expect(viewer.locator('article.change.current')).toHaveAttribute('data-stop', await heronsChange.getAttribute('data-stop'), { timeout: 10000 });

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(600);
  await shot('dark');

  assert.deepEqual(errors, []);
  console.log('PASS: the source tool opens the clicked passage in an editor that marks its changes since the last commit, saves without an agent, flashes the saved lines in the new PDF and the editor, reports compile errors, refuses stale saves, keeps drafts, and follows the Changes view both ways');
} catch (error) {
  if (errors.length) console.error('Page errors:', errors);
  await shot('failure').catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await server?.close();
  await reviewServer?.close();
  await engine?.close();
  updates?.close();
  workspace?.close();
  store?.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
