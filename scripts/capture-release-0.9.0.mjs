// Release screenshots: the real UI and TeX renderer, disposable example data.
// No account, agent invocation, or user manuscript is used.
// npm run build && npm --prefix engine run build
// node --import tsx scripts/capture-release-0.9.0.mjs [output-directory]
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from './playwright.mjs';
import { Fixture, METHOD } from '../engine/tests/ts/helpers.ts';
import { Builder } from '../engine/src/core/build.ts';
import { createServer } from '../engine/src/server.ts';
import { pdfWords } from '../src/server/manuscript.ts';
import { annotateReviewState, rewriteReviewHtml, rewriteReviewJson } from '../src/server/review.ts';

const out = path.resolve(process.argv[2] || 'docs/releases/0.9.0');
fs.mkdirSync(out, { recursive: true });
const f = new Fixture();
let server, reviewServer, browser;
const captures = [];
try {
  f.write('paper/main.tex', String.raw`\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb,hyperref}
\title{A Reviewable Workflow for Scientific Writing}
\author{Papilot Example Paper}
\date{}
\begin{document}
\maketitle
\begin{abstract}
Scientific writing combines precise arguments, mathematical notation, and repeated revision. We describe a workflow in which an author directs an assistant from the rendered paper, reviews each proposed change in context, and retains control of the manuscript.
\end{abstract}
\section{Introduction}
A useful writing assistant should make revisions easy to inspect. Reading the final layout reveals whether a sentence fits the argument, a reference supports a claim, and an equation uses consistent notation.

The author marks a passage, states the intended change, and reviews a typeset comparison. Each proposal remains separate from the manuscript until the author chooses to apply it.
\input{sections/method}
\section{Discussion}
Small, focused tasks make feedback easier to act on. An author can ask for a shorter explanation, check an assumption, or improve a transition without handing over control of the entire paper.

Version history records the accepted work. Earlier versions remain available, and restoring a version creates a new commit so the history stays intact.
\end{document}
`);
  f.write(METHOD, String.raw`\section{Reviewing a revision}
Let $M$ denote the manuscript and $\Delta$ a proposed revision. The author decides which edits belong in the next version.
\begin{equation}
  M_{t+1} = M_t \oplus \Delta_{\mathrm{accepted}}.
\end{equation}
The assistant changes the paper automatically after reviewing it.

A comparison places old and new wording together. Comments identify the passage and the intended improvement, while rejected edits leave the accepted manuscript unchanged.
`);
  f.repo.run(['add', '.']); f.repo.run(['commit', '-qm', 'Add release example']);
  const app = f.app(); await app.ready;
  const proposal = app.tasks.create('release-demo', 'Clarify who approves a revision', [], ['paper'], true);
  f.edit(proposal, METHOD, 'The assistant changes the paper automatically after reviewing it.', 'The author reviews each proposed edit and explicitly chooses which changes to apply to the manuscript.');
  app.publisher.submit(proposal.name); await app.publisher.join();
  assert.equal(app.publisher.current(proposal.name)?.status, 'done');
  const built = await new Builder(app.project, app.repo).build(proposal.base);
  const words = await pdfWords(built.pdf, 0);
  reviewServer = createServer(app); await reviewServer.ready();
  server = Fastify(); await server.register(staticFiles, { root: path.resolve('dist') });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${server.server.address().port}`;
  browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ locale: 'en-US', colorScheme: 'light', viewport: { width: 1440, height: 800 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const now = Date.UTC(2026, 10, 5, 12);
  const runtime = { connected: true, authenticated: true, models: [] };
  const task = { id: 'release-task', projectId: 'paper', name: proposal.name, title: proposal.title, status: 'reviewing', createdAt: now, updatedAt: now, review: app.review.summary(proposal.name) };
  const git = { branch: 'main', upstream: 'origin/main', remote: true, ahead: 1, behind: 0, head: { hash: 'a'.repeat(40), subject: 'Clarify the revision workflow', date: now }, files: [
    { path: 'sections/method.tex', status: 'M', staged: true, unstaged: false, lines: [5, 2] },
    { path: 'sections/introduction.tex', status: 'M', staged: false, unstaged: true, lines: [3, 1] },
    { path: 'references.bib', status: '?', staged: false, unstaged: true },
  ] };
  const snapshot = { version: JSON.parse(fs.readFileSync('package.json', 'utf8')).version, csrf: 'fixture', projects: [{ id: 'paper', name: 'Scientific writing', path: '/example/paper' }], tasks: [task], requests: [], runtime, runtimes: { codex: runtime } };
  let notes = [];
  const history = [
    { hash: 'a'.repeat(40), message: 'Clarify the revision workflow\n\nMake author approval explicit before changes reach the manuscript.', author: 'Example Author', date: now },
    { hash: 'b'.repeat(40), message: 'Explain the acceptance rule\n\nKeep the notation consistent with the discussion.', author: 'Example Author', date: now - 86400000 },
    { hash: 'c'.repeat(40), message: 'Add the introduction and motivating example', author: 'Example Author', date: now - 172800000 },
  ];
  const diff = String.raw`diff --git a/sections/method.tex b/sections/method.tex
--- a/sections/method.tex
+++ b/sections/method.tex
@@ -1,9 +1,12 @@
 \section{Reviewing a revision}
 Let $M$ denote the manuscript and $\Delta$ a proposed revision.
-The assistant changes the paper automatically after reviewing it.
+The author reviews each proposed edit and explicitly chooses
+which changes to apply to the manuscript.
 
 \begin{equation}
   M_{t+1} = M_t \oplus \Delta_{\mathrm{accepted}}.
 \end{equation}
-Comments describe the revision.
+Comments identify the passage and the intended improvement.
+Rejected edits leave the accepted manuscript unchanged.
+Version history records every accepted revision.
`;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), p = url.pathname;
    const json = value => route.fulfill({ json: value });
    if (p === '/api/quick-notes') return json({ quickNotes: null });
    if (p === '/api/state') return json(snapshot);
    if (p === '/api/indirect-changes') return json({ indirectChanges: false });
    if (p === '/api/updates') return json({ currentVersion: snapshot.version, latestVersion: null, phase: 'idle', canUpdate: false });
    if (p.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': preview\n\n' });
    if (p.endsWith('/skills')) return json({ skills: [] });
    if (p.endsWith('/items')) return json({ items: [
      { id: 'request', taskId: task.id, type: 'user', text: 'Clarify who approves a revision. Keep the acceptance equation and explain how rejected edits affect the manuscript.', createdAt: now },
      { id: 'response', taskId: task.id, type: 'assistant', text: 'The proposed wording now makes the author’s approval explicit. The equation is unchanged. Review the typeset comparison, then accept the edit or leave feedback below.', createdAt: now + 1000 },
    ] });
    if (p.endsWith('/note-results')) return json({ notes: [] });
    if (p.endsWith('/git')) return json(git);
    if (p.endsWith('/git/fetch')) return json({ git });
    if (p.endsWith('/git/history')) return json({ versions: history, next: null });
    if (p.endsWith('/git/diff') || /\/git\/history\/.*\/diff$/.test(p)) return json({ path: 'sections/method.tex', diff, truncated: false });
    if (/\/git\/history\/[abc]+$/.test(p)) return json({ version: history.find(v => p.endsWith(v.hash)), files: [{ path: 'sections/method.tex', status: 'M' }] });
    if (p.endsWith('/manuscript')) return json({ git, build: { status: 'ready', current: true, key: 'release-example', pages: [[words.width, words.height]], builtAt: now }, annotations: notes });
    if (p.endsWith('/manuscript.pdf')) return route.fulfill({ contentType: 'application/pdf', body: fs.readFileSync(built.pdf) });
    if (p.endsWith('/manuscript/words')) return json(words);
    if (p.endsWith('/annotations')) {
      const note = { ...route.request().postDataJSON(), id: `note-${notes.length + 1}`, projectId: 'paper', source: null, createdAt: now };
      notes.push(note); return json(note);
    }
    throw Error(`Unexpected screenshot request ${p}`);
  });
  await page.route('**/review/paper/**', async route => {
    const url = new URL(route.request().url()), relative = url.pathname.slice('/review/paper'.length);
    const response = await reviewServer.inject({ method: route.request().method(), url: relative + url.search, headers: { host: '127.0.0.1:9', 'x-review-token': app.csrf }, payload: route.request().postData() || undefined });
    let body = response.rawPayload;
    if (relative === '/') body = rewriteReviewHtml(response.body, '/review/paper');
    if (String(response.headers['content-type']).includes('application/json')) body = JSON.stringify(rewriteReviewJson(response.json(), '/review/paper'));
    if (relative.endsWith('/state')) body = JSON.stringify(annotateReviewState(response.json(), [task]));
    await route.fulfill({ status: response.statusCode, contentType: String(response.headers['content-type'] || 'application/octet-stream'), body });
  });
  async function shot(name) {
    await page.evaluate(() => document.fonts.ready);
    for (const frame of page.frames()) {
      await expect.poll(() => frame.locator('img').evaluateAll(images => images.every(img => img.complete && img.naturalWidth > 0))).toBe(true);
    }
    await page.screenshot({ path: path.join(out, name), animations: 'disabled' });
    console.log('Captured', name);
    captures.push(name);
  }
  await page.goto(origin);
  const viewer = page.frameLocator('.review-frame');
  await expect(viewer.locator('.change').first()).toBeVisible({ timeout: 30000 });
  await viewer.locator('.change .comment').first().click();
  await page.getByRole('textbox', { name: 'Comment 1', exact: true }).fill('Keep the explicit approval step. Please use “accepted edits” consistently in the equation and discussion.');
  await page.getByRole('textbox', { name: 'Instructions for Codex', exact: true }).fill('Keep the explanation concise and preserve the notation.');
  await shot('review-feedback.png');
  await viewer.getByRole('button', { name: 'LaTeX', exact: true }).first().click();
  await viewer.locator('.source-editor').getByRole('button', { name: 'Edit', exact: true }).first().click();
  await expect(viewer.getByRole('textbox', { name: 'Edit LaTeX source' })).toBeVisible();
  await viewer.getByRole('textbox', { name: 'Edit LaTeX source' }).fill(String.raw`The author reviews each proposed edit.
Only $\Delta_{\mathrm{accepted}}$ enters the manuscript.
Rejected edits leave the accepted version unchanged.
`);
  const editor = viewer.getByRole('textbox', { name: 'Edit LaTeX source' });
  await expect.poll(() => editor.evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  await shot('inline-source.png');
  await page.locator('.manuscript-link').click();
  await page.locator('.textLayer span').first().waitFor();
  const rail = page.getByRole('toolbar', { name: 'Marking tools' });
  await rail.getByRole('button', { name: 'Magic pen', exact: true }).click();
  await page.locator('.textLayer span').filter({ hasText: /useful/ }).first().evaluate(el => {
    const spans = [...el.parentElement.querySelectorAll('span')];
    const end = spans[spans.indexOf(el) + 8] || el;
    const range = document.createRange(); range.setStart(el.firstChild, 0); range.setEnd(end.firstChild, end.firstChild.textContent.length);
    const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    const box = end.getBoundingClientRect(); el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', clientX: box.right, clientY: box.bottom }));
  });
  await page.getByRole('menu', { name: 'Quick notes' }).getByRole('menuitem', { name: 'Polish', exact: true }).hover();
  await shot('magic-pen.png');
  await page.keyboard.press('Escape');
  await page.locator('.git-link').click();
  await page.locator('.git-file').filter({ hasText: 'method.tex' }).click();
  await page.getByRole('textbox', { name: 'Commit message' }).fill('Clarify author approval in the revision workflow');
  await expect(page.locator('.git-diff-view')).toBeVisible();
  await shot('version-management.png');
  await page.getByRole('button', { name: 'Version history', exact: true }).click();
  await page.getByRole('button', { name: /Explain the acceptance rule/ }).click();
  await page.getByRole('button', { name: /Explain the acceptance rule/ }).hover();
  await shot('version-history.png');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'screenshots.json'), JSON.stringify({ version: snapshot.version, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), viewport: { width: 1440, height: 800 }, scale: 2, source: 'Real Papilot UI and a TeX-compiled disposable example; simulated account, task list, conversation and Git responses; no live agent inference.', captures }, null, 2) + '\n');
  console.log(`Captured ${captures.length} release images in ${out}`);
} finally {
  await browser?.close(); await server?.close(); await reviewServer?.close(); await f.close();
}
