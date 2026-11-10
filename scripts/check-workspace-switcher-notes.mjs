import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from '../engine/node_modules/@playwright/test/index.mjs';

const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const runtime = { connected: true, authenticated: true, models: [] };
const task = (id, extra = {}) => ({ id, projectId: 'paper', name: id, title: `Task ${id}`, instructions: 'Revise the paper.', status: 'running', createdAt: 1, updatedAt: 1, review: null, ...extra });
const snapshot = { version: 'test', csrf: 'fixture', projects: [{ id: 'paper', name: 'Paper', path: '/tmp/paper' }, { id: 'other', name: 'Other paper', path: '/tmp/other' }], tasks: [task('a', { status: 'reviewing', review: { state: 'reviewing', round: 1, counts: { pending: 1 } } }), task('b'), task('archived', { archivedAt: 1 }), task('deleting', { status: 'deleting' }), task('elsewhere', { projectId: 'other' })], requests: [], runtime, runtimes: { codex: runtime } };
const initialTasks = structuredClone(snapshot.tasks);
const errors = [];
const note = { id: 'note1', projectId: 'paper', key: 'pdf', page: 0, rect: [0.2,0.2,0.4,0.3], rects: [[0.2,0.2,0.4,0.3]], quote: 'Example', comment: 'Original note', createdAt: 1, updatedAt: 1 };
const writes = []; let holdWrite = false, releaseWrite;
fs.mkdirSync('test-results', { recursive: true });
try {
  for (const platform of ['MacIntel']) {
    snapshot.tasks = structuredClone(initialTasks);
    // These are DOM-event tests; they cannot verify macOS-reserved shortcuts.
    const modifier = 'Control';
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, reducedMotion: 'no-preference' });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(platform => { Object.defineProperty(navigator, 'platform', { get: () => platform }); localStorage.setItem('papilot:task', ''); localStorage.setItem('papilot:project', 'paper'); }, platform);
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()), json = value => route.fulfill({ json: value });
      if (url.pathname === '/api/state') return json(snapshot);
      if (url.pathname === '/api/updates') return json({ currentVersion: 'test', phase: 'idle' });
      if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
      if (url.pathname.endsWith('/skills')) return json({ skills: [] });
      if (url.pathname.endsWith('/git')) return json({ branch: 'main', files: [] });
      if (url.pathname.endsWith('/items')) return json({ items: [] });
      if (url.pathname.endsWith('/note-results')) return json({ notes: [] });
      if (url.pathname.endsWith('/manuscript')) return json({ git: { files: [] }, build: { status: 'ready', key: 'pdf', pages: [[612,792],[612,792]], current: true }, annotations: [note] });
      if (url.pathname.endsWith('/manuscript.pdf')) return route.fulfill({ contentType: 'application/pdf', body: fs.readFileSync('tests/fixtures/outline.pdf') });
      if (url.pathname.endsWith('/manuscript/words')) return json(JSON.parse(fs.readFileSync('tests/fixtures/outline-words.json','utf8'))[Number(url.searchParams.get('page'))]);
      if (route.request().method() === 'POST') { const body = route.request().postDataJSON(); writes.push({path:url.pathname,body}); if (holdWrite) await new Promise(resolve => { releaseWrite = resolve; }); note.comment = body.comment; return json(note); }
      return json({});
    });
    await page.route('**/review/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"><main id="paper"><button>Review content</button><textarea aria-label="Review comment"></textarea></main></div></body></html>' }));
    await page.goto(`http://127.0.0.1:${server.server.address().port}`);
    const chooser = page.getByRole('dialog', { name: 'Switch tasks and manuscript', exact: true });
    const popover = page.getByRole('dialog', { name: 'PDF note 1', exact: true });
    await page.locator('.note-tag[data-note="note1"]').click();
    await page.getByRole('button', { name: 'Edit note 1: Original note', exact: true }).click();
    await page.getByRole('textbox', { name: 'Edit note 1', exact: true }).fill('Unsaved PDF popover edit');
    await page.keyboard.press('Control+Backquote');
    await expect(chooser).toHaveCount(0);
    await expect(page.locator('.manuscript-link')).toHaveAttribute('aria-current','page');
    await expect(page.getByRole('textbox', { name: 'Edit note 1', exact: true })).toHaveValue('Unsaved PDF popover edit');
    assert.equal(writes.length, 0);
    await page.getByRole('textbox', { name: 'Edit note 1', exact: true }).press('Enter');
    await expect.poll(() => writes.length).toBe(1);
    assert.equal(writes[0].body.comment, 'Unsaved PDF popover edit');
    await expect(page.getByRole('textbox', { name: 'Edit note 1', exact: true })).toHaveCount(0);
    await expect(popover).toHaveCount(0);
    // Enter sends the note into the task. Its decorative copy still has a
    // dialog role, but must not block switching while the flight is visible.
    const flight = page.locator('.note-flight[role="dialog"][inert]');
    await flight.waitFor({ state: 'attached' });
    await flight.evaluate(element => element.getAnimations().forEach(animation => animation.pause()));
    await page.keyboard.down(modifier);
    await page.keyboard.press('Backquote');
    await expect(chooser).toBeVisible();
    await expect(flight).toBeAttached();
    await flight.evaluate(element => element.getAnimations().forEach(animation => animation.play()));
    await page.keyboard.up(modifier);
    await expect(page.locator('[data-task="b"] .task-link')).toHaveAttribute('aria-current','page');
    await page.locator('.manuscript-link').click();
    await page.getByRole('button', { name: /^My notes(?: · .+)?$/ }).click();
    await page.getByRole('region', { name: 'My notes', exact: true }).getByRole('button', { name: 'Edit note 1: Unsaved PDF popover edit', exact: true }).click();
    await page.getByRole('textbox', { name: 'Edit note 1', exact: true }).fill('Pending side-panel edit');
    holdWrite = true;
    await page.keyboard.press('Control+Backquote');
    await expect.poll(() => writes.length).toBe(2);
    await page.locator('[data-task="a"] .task-link').click();
    await expect(page.locator('[data-task="a"] .task-link')).toHaveAttribute('aria-current', 'page');
    const saved = page.waitForResponse(response => response.url().endsWith('/annotations/note1') && response.request().method() === 'POST');
    releaseWrite();
    await (await saved).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('[data-task="a"] .task-link')).toHaveAttribute('aria-current', 'page');
    assert.deepEqual(errors, []);
    console.log('Workspace switcher preserves PDF drafts, ignores inert note flights and respects navigation during a pending save.');
    await context.close();
  }
} finally { await browser.close(); await server.close(); }
