import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from './playwright.mjs';

const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const runtime = { connected: true, authenticated: true, models: [] };
const task = (id, extra = {}) => ({ id, projectId: 'paper', name: id, title: `Task ${id}`, instructions: 'Revise the paper.', status: 'running', createdAt: 1, updatedAt: 1, review: null, ...extra });
const snapshot = { version: 'test', csrf: 'fixture', projects: [{ id: 'paper', name: 'Paper', path: '/tmp/paper' }, { id: 'other', name: 'Other paper', path: '/tmp/other' }], tasks: [task('a', { status: 'reviewing', review: { state: 'reviewing', round: 1, counts: { pending: 1 } } }), task('b'), task('archived', { archivedAt: 1 }), task('deleting', { status: 'deleting' }), task('elsewhere', { projectId: 'other' })], requests: [], runtime, runtimes: { codex: runtime } };
const initialTasks = structuredClone(snapshot.tasks);
const errors = [];
fs.mkdirSync('test-results', { recursive: true });
try {
  for (const platform of ['MacIntel', 'Win32']) {
    snapshot.tasks = structuredClone(initialTasks);
    // These are DOM-event tests; they cannot verify macOS-reserved shortcuts.
    const modifier = 'Control', modifierLabel = 'Ctrl';
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(platform => { Object.defineProperty(navigator, 'platform', { get: () => platform }); localStorage.setItem('papilot:task', ''); localStorage.setItem('papilot:project', 'paper'); }, platform);
    await page.route('**/api/**', route => {
      const url = new URL(route.request().url()), json = value => route.fulfill({ json: value });
      if (url.pathname === '/api/state') return json(snapshot);
      if (url.pathname === '/api/updates') return json({ currentVersion: 'test', phase: 'idle' });
      if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
      if (url.pathname.endsWith('/skills')) return json({ skills: [] });
      if (url.pathname.endsWith('/git')) return json({ branch: 'main', files: [] });
      if (url.pathname.endsWith('/items')) return json({ items: [] });
      if (url.pathname.endsWith('/note-results')) return json({ notes: [] });
      if (url.pathname.endsWith('/manuscript')) return json({ git: { files: [] }, build: { status: 'failed', error: 'Fixture preview' }, annotations: [] });
      return json({});
    });
    await page.route('**/review/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"><main id="paper"><button>Review content</button><textarea aria-label="Review comment"></textarea><button onclick="document.querySelector(&quot;dialog&quot;).showModal()">Open review dialog</button><dialog><textarea aria-label="Review dialog draft"></textarea></dialog></main></div></body></html>' }));
    await page.goto(`http://127.0.0.1:${server.server.address().port}`);
    const manuscript = page.locator('.manuscript-link'), taskLink = id => page.locator(`[data-task="${id}"] .task-link`);
    const chooser = page.getByRole('dialog', { name: 'Switch tasks and manuscript', exact: true });
    const selected = chooser.getByRole('option', { selected: true });
    const begin = async (reverse = false) => {
      await page.keyboard.down(modifier);
      await page.keyboard.press(reverse ? 'Shift+Backquote' : 'Backquote');
      await expect(chooser).toBeVisible();
    };
    const release = async () => { await page.keyboard.up(modifier); await expect(chooser).toHaveCount(0); };
    await expect(manuscript).toHaveAttribute('aria-current', 'page');
    const draft = page.getByRole('textbox', { name: 'Describe the revision', exact: true });
    await draft.fill('Keep this unsent manuscript draft.');
    await begin();
    await expect(chooser.getByRole('option')).toHaveCount(3);
    await expect(selected).toHaveText('Task b');
    await expect(chooser.locator('kbd')).toHaveText(modifierLabel + ' + `');
    await page.keyboard.press(modifier === 'Meta' ? 'Control' : 'Meta');
    await expect(chooser).toBeVisible();
    await expect(manuscript).toHaveAttribute('aria-current', 'page'); // Preview does not navigate.
    await page.screenshot({ path: 'test-results/workspace-switcher.png' });
    await chooser.screenshot({ path: 'test-results/workspace-switcher-dialog.png' });
    await release(); await expect(taskLink('b')).toHaveAttribute('aria-current', 'page');
    const instructions = page.getByRole('textbox', { name: 'Instructions for Codex', exact: true });
    await instructions.fill('Keep this unsent task draft.');
    await begin(); await expect(selected).toHaveText('Manuscript');
    await release(); await expect(draft).toHaveValue('Keep this unsent manuscript draft.');
    // A quick second invocation returns to the last task, independent of list order.
    await page.keyboard.press(`${modifier}+Backquote`); await expect(taskLink('b')).toHaveAttribute('aria-current', 'page');
    await expect(instructions).toHaveValue('Keep this unsent task draft.');
    await taskLink('a').click();
    // Events from the embedded review reach the host, and Escape restores its focus.
    const review = page.frameLocator('iframe.review-frame').getByRole('textbox', { name: 'Review comment' });
    await review.fill('Unsent review comment');
    await begin(); await expect(selected).toHaveText('Task b');
    await page.keyboard.press('Escape'); await page.keyboard.up(modifier);
    await expect(chooser).toHaveCount(0); await expect(taskLink('a')).toHaveAttribute('aria-current', 'page');
    await expect(review).toBeFocused(); await expect(review).toHaveValue('Unsent review comment');
    const reviewFrame = page.frameLocator('iframe.review-frame');
    await reviewFrame.getByRole('button', { name: 'Open review dialog' }).click();
    const dialogDraft = reviewFrame.getByRole('textbox', { name: 'Review dialog draft' });
    await dialogDraft.fill('Preserve this dialog draft');
    await page.keyboard.press('Control+Backquote');
    await expect(chooser).toHaveCount(0);
    await expect(dialogDraft).toHaveValue('Preserve this dialog draft');
    await page.keyboard.press('Escape');
    await review.focus();
    await begin(); await page.keyboard.press('Backquote'); await expect(selected).toHaveText('Manuscript');
    await page.keyboard.press('Shift+Backquote'); await expect(selected).toHaveText('Task b');
    await page.keyboard.press('ArrowDown'); await expect(selected).toHaveText('Manuscript');
    await page.keyboard.press('Enter'); await page.keyboard.up(modifier);
    await expect(manuscript).toHaveAttribute('aria-current', 'page');
    // Reverse opening wraps to the least recent entry.
    await begin(true); await expect(selected).toHaveText('Task b');
    await page.keyboard.press('Backquote'); await expect(selected).toHaveText('Manuscript');
    await page.keyboard.press('Escape'); await page.keyboard.up(modifier);
    // Losing the window cancels a held shortcut; releasing it later cannot navigate.
    await begin();
    // Headless Chrome keeps all tabs focused; simulate the OS focus notification.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
      window.dispatchEvent(new Event('blur'));
      delete document.hasFocus;
    });
    await expect(chooser).toHaveCount(0);
    await page.keyboard.up(modifier);
    await expect(manuscript).toHaveAttribute('aria-current', 'page');
    // Sidebar filters do not prevent returning to a recently used task.
    await page.getByRole('searchbox', { name: 'Search tasks' }).fill('no matches');
    await begin(); await expect(selected).toHaveText('Task a');
    await release(); await expect(page.getByRole('heading', { name: 'Task a', exact: true })).toBeAttached();
    await page.getByRole('searchbox', { name: 'Search tasks' }).fill('');
    // Existing dialogs retain their keyboard interaction.
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.keyboard.press(`${modifier}+Backquote`); await expect(chooser).toHaveCount(0);
    await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click();
    await expect(page.getByText('Hold ' + modifierLabel + ' and press ` to cycle. Shift reverses; release ' + modifierLabel + ' to switch. Esc cancels.', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    // A refresh while choosing cannot commit a deleted destination.
    await begin();
    const chosenTitle = await selected.textContent();
    assert.equal(chosenTitle, 'Manuscript');
    await page.keyboard.press('ArrowDown'); await expect(selected).toHaveText('Task b');
    snapshot.tasks = snapshot.tasks.filter(task => task.id !== 'b');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(chooser).toHaveCount(0); await page.keyboard.up(modifier);
    await expect(taskLink('a')).toHaveAttribute('aria-current', 'page');
    // The same UI fits narrow windows and follows dark appearance.
    await page.setViewportSize({ width: 390, height: 700 }); await page.emulateMedia({ colorScheme: 'dark' });
    await begin();
    const bounds = await chooser.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
    await page.screenshot({ path: 'test-results/workspace-switcher-mobile.png' });
    await release();
    // With no other destinations the shortcut leaves text input alone.
    snapshot.tasks = [];
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('.task-row')).toHaveCount(0);
    await page.keyboard.press(`${modifier}+Backquote`); await expect(chooser).toHaveCount(0);
    assert.deepEqual(errors, []);
    console.log(platform + ' workspace switcher: MRU, hold/release, reverse, wrap, cancel, iframe focus, drafts, filters, dialogs, removal and narrow layout passed.');
    await context.close();
  }
} finally { await browser.close(); await server.close(); }
