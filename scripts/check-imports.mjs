import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium } from '../vendor/latex-review/node_modules/playwright/index.mjs';
const server = Fastify(); await server.register(staticFiles, { root: path.resolve('dist') }); await server.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const state = { version: '0.6.0', csrf: 'fixture', projects: [], tasks: [], requests: [], runtime: { connected: true, authenticated: true, account: 'Owner', error: null, models: [] }, viewer: { id: 'owner', role: 'owner', name: 'Owner', listener: 'local', owner: 'Owner' } };
const imported = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'My paper', path: '/papers/copied-paper', copied: true, candidates: ['main.tex', 'supplement.tex'], main: 'main.tex', engine: 'pdflatex', phase: 'choose' };
const requests = [], errors = []; let draft = structuredClone(imported), result = 'failed', failure = 'fontspec needs XeLaTeX';
fs.mkdirSync('test-results', { recursive: true });
try {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 850 } });
  await context.route('**/api/**', route => {
    const url = new URL(route.request().url()), method = route.request().method();
    if (url.pathname.startsWith('/api/imports')) {
      const body = method === 'POST' ? route.request().postDataJSON() : null; requests.push({ route: url.pathname, body });
      if (url.pathname === '/api/imports') { draft = { ...structuredClone(imported), ...(body.path ? { path: body.path, copied: false } : {}) }; return route.fulfill({ json: draft }); }
      if (url.pathname.endsWith('/build') || url.pathname.endsWith('/repair')) { Object.assign(draft, body, { phase: 'building', error: undefined }); if (url.pathname.endsWith('/repair')) { result = 'ready'; draft.summary = 'Fixed a missing package reference.'; } return route.fulfill({ json: draft }); }
      if (url.pathname.endsWith('/finish')) { const project = { id: 'paper', name: draft.name, path: draft.path, createdAt: 1 }; state.projects = [project]; return route.fulfill({ json: project }); }
      if (draft.phase === 'building') Object.assign(draft, { phase: result, versioned: true, error: result === 'failed' ? failure : undefined });
      return route.fulfill({ json: draft });
    }
    if (url.pathname === '/api/state') return route.fulfill({ json: state });
    if (url.pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    if (url.pathname === '/api/updates') return route.fulfill({ json: { phase: 'idle', currentVersion: '0.6.0' } });
    if (url.pathname.endsWith('/skills')) return route.fulfill({ json: { skills: [] } });
    if (url.pathname.endsWith('/manuscript')) return route.fulfill({ json: { git: { files: [] }, build: { status: 'failed', error: 'Fixture preview' }, annotations: [] } });
    if (url.pathname.endsWith('/git')) return route.fulfill({ json: { files: [] } });
    return route.fulfill({ json: {} });
  });
  const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.server.address().port}`);
  await page.getByRole('button', { name: 'Add paper', exact: true }).first().click();
  let dialog = page.getByRole('dialog', { name: 'Add a paper' }); await dialog.waitFor();
  assert.equal(await page.getByLabel('Folder path', { exact: true }).isVisible(), false);
  const [folderButton, zipButton] = await dialog.locator('.import-options button').evaluateAll(buttons => buttons.map(button => { const rect = button.getBoundingClientRect(); return { y: rect.y, width: rect.width }; }));
  assert.ok(Math.abs(folderButton.y - zipButton.y) < 1); assert.ok(Math.abs(folderButton.width - zipButton.width) < 1);
  await dialog.screenshot({ animations: 'disabled', path: 'test-results/import-start.png' });
  const transfer = await page.evaluateHandle(() => { const transfer = new DataTransfer(); transfer.items.add(new File(['fixture zip bytes'], 'paper.zip', { type: 'application/zip' })); return transfer; });
  await page.locator('.import-drop').dispatchEvent('drop', { dataTransfer: transfer });
  await page.getByLabel('Main TeX file', { exact: true }).waitFor().catch(async error => { console.log(requests, errors, await dialog.innerText()); throw error; });
  assert.equal(requests[0].body.zip, Buffer.from('fixture zip bytes').toString('base64'));
  await page.getByText('The paper needs a little help').waitFor(); await page.getByText('This paper may need XeLaTeX. Change the engine below and retry.').waitFor();
  await page.getByRole('button', { name: 'Continue later' }).click();
  await page.getByRole('button', { name: 'Add paper', exact: true }).first().click();
  await page.getByText('The paper needs a little help').waitFor();
  await page.getByLabel('LaTeX engine', { exact: true }).selectOption('xelatex');
  await page.setViewportSize({ width: 360, height: 740 }); await page.emulateMedia({ colorScheme: 'dark' });
  await dialog.screenshot({ animations: 'disabled', path: 'test-results/import-failure-mobile.png' });
  assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.getByRole('button', { name: 'Help fix compilation' }).click();
  await page.getByText('Your paper compiled successfully. It is ready for editing.').waitFor();
  await page.getByText('Fixed a missing package reference.').waitFor();
  await page.getByRole('button', { name: 'Open paper', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  assert.equal(state.projects.length, 1);
  await page.setViewportSize({ width: 1280, height: 850 }); await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('button', { name: 'Paper: My paper', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add paper…', exact: true }).click();
  // Browser folder input preserves relative file names, including binary assets.
  const temp = fs.mkdtempSync('/tmp/papilot-ui-import-');
  try {
    fs.writeFileSync(path.join(temp, 'main.tex'), 'source'); fs.writeFileSync(path.join(temp, 'figure.png'), Buffer.from([0, 255, 32]));
    await page.locator('input[webkitdirectory]').setInputFiles(temp);
    await page.getByLabel('Main TeX file', { exact: true }).waitFor();
    const uploaded = requests.filter(request => request.route === '/api/imports').at(-1).body.files;
    assert.ok(uploaded.some(file => file.path.endsWith('/main.tex'))); assert.ok(uploaded.some(file => file.data === Buffer.from([0, 255, 32]).toString('base64')));
    await page.getByText('Your paper compiled successfully. It is ready for editing.').waitFor();
    await page.getByRole('button', { name: 'Choose different files', exact: true }).click();
    fs.mkdirSync(path.join(temp, 'nested'));
    for (let index = 0; index < 120; index++) fs.writeFileSync(path.join(temp, 'nested', `${index}.txt`), 'asset');
    const dropBox = await page.locator('.import-drop').boundingBox(), cdp = await context.newCDPSession(page);
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: dropBox.x + 20, y: dropBox.y + 20, data: { items: [], files: [temp], dragOperationsMask: 1 } });
    await page.getByLabel('Main TeX file', { exact: true }).waitFor();
    const dropped = requests.filter(request => request.route === '/api/imports').at(-1).body.files;
    assert.equal(dropped.length, 122, 'Folder drops read all directory batches');
    assert.ok(dropped.some(file => file.path.endsWith('/nested/119.txt')));
    assert.ok(dropped.some(file => file.data === Buffer.from([0, 255, 32]).toString('base64')));
    await cdp.detach();
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  await page.getByText('Your paper compiled successfully. It is ready for editing.').waitFor();
  await page.getByRole('button', { name: 'Choose different files', exact: true }).click();
  await page.getByText('Enter a folder path', { exact: true }).click();
  const builds = requests.filter(request => request.route.endsWith('/build')).length;
  await page.getByLabel('Folder path', { exact: true }).fill('/papers/large-local-paper');
  await page.getByRole('button', { name: 'Read folder', exact: true }).click();
  await page.getByLabel('Main TeX file', { exact: true }).waitFor();
  assert.deepEqual(requests.filter(request => request.route === '/api/imports').at(-1).body, { path: '/papers/large-local-paper' });
  assert.equal(requests.filter(request => request.route.endsWith('/build')).length, builds, 'Local folder selection only inspects the paper');
  result = 'failed'; failure = 'spawnSync /usr/bin/git ENOBUFS';
  await page.getByRole('button', { name: 'Prepare and compile', exact: true }).click();
  await page.getByText('Could not prepare the paper', { exact: true }).waitFor();
  assert.equal(await page.getByText('The paper needs a little help', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Help fix compilation', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: local folder path, ZIP drop, folder upload, main selection, failed compile, resume, assistant repair, mobile layout and opening paper');
} finally { await browser.close(); await server.close(); }
