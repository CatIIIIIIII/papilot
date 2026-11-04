import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from '../engine/node_modules/@playwright/test/index.mjs';
import { annotateReviewState, rewriteReviewHtml } from '../src/server/review.ts';

fs.mkdirSync('test-results', { recursive: true });
const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 1000 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const prefix = '/review/paper';
const reviewDist = path.resolve(process.env.PAPILOT_REVIEW_DIST || 'engine/dist/web');
const task = { id: 'review-flow-fixture', projectId: 'paper', name: 'flow', title: 'Review the new wording', status: 'reviewing', createdAt: 1, updatedAt: 1, review: { state: 'reviewing', round: 1, counts: {}, unsent: 0 } };
const snapshot = { version: 'test', csrf: 'fixture', projects: [{ id: 'paper', name: 'Paper', path: '/tmp/paper' }], tasks: [task], requests: [], runtime: { connected: true, authenticated: true, models: [] } };
let latest = 1, serial = 0, undo = null;
let effectFixture = false, effectRequests = 0;
const rounds = { 1: { first: 'pending', second: 'pending', third: 'pending', fourth: 'pending' } };
const actions = [], writes = [], messageRequests = [], commitRequests = [], applyRequests = [], archiveRequests = [], deleteRequests = [];
let gitFiles = [];
let pushError, conflictOnApply = false, combinedOnCommit = false;
let timeline = [];
const state = round => ({ task: 'flow', title: task.title, csrf: 'fixture', closed: false, state: task.review.state, latest, history: Object.keys(rounds).map(number => ({ number: Number(number), created: 1793322000 + Number(number) * 120 })), round, revision: `after-${round}`, decisions: rounds[round], comments: {}, undo, job: null });
function update() {
  const values = Object.values(rounds[latest]);
  task.review.counts = Object.fromEntries(['pending', 'accepted', 'rejected', 'commented'].map(value => [value, values.filter(v => v === value).length]));
  task.review.state = values.includes('pending') ? 'reviewing' : values.includes('commented') ? 'revise' : 'done';
}
update();
const image = (name, label) => ({ src: `${name}.svg`, clean: `${name}-clean.svg`, width: 600, height: 130, page: 0, label: '1', text: [{ chars: [{ text: label, rect: [60, 40, 500, 62] }] }] });
const effectPlace = name => ({ page: '2', section: 'Contents', before: [image(`${name}-old`, 'Section 2')], after: [image(`${name}-new`, 'Section 3')] });
function detail(round) {
  const ids = Object.keys(rounds[round]);
  const groups = round === 1 ? [['first'], ['second'], ['third', 'fourth']] : [['new']];
  const result = { task: 'flow', round, before: `before-${round}`, after: `after-${round}`, warnings: [], files: `${prefix}/files/flow/${round}/`,
    sections: [{ node: 'intro', title: 'Introduction', number: '1', blocks: groups.map((units, i) => ({ kind: 'change', units, identical: false, before: [image(`before-${i}`, `Original paragraph ${i + 1}.`)], after: [image(`after-${i}`, `Revised paragraph ${i + 1}.`)] })) }], loose: [],
    units: ids.map((id, i) => ({ id, file: 'main.tex', status: 'modified', kind: 'text', whole_file: false, ops: [], old_start: i + 1, old_end: i + 1, new_start: i + 1, new_end: i + 1, old_text: `Original paragraph ${i + 1}`, new_text: `Revised paragraph ${i + 1}`, truncated: false })) };
  if (effectFixture && round === 1) {
    for (const [i, visual] of ['text', 'unmapped', 'identical'].entries()) Object.assign(result.units[i], {
      visual, effects: { total: i === 0 ? 2 : 1, shown: [effectPlace(`effect-${i}`)] },
    });
    // A macro definition has no crop of its own; its uses are its preview.
    Object.assign(result.units[1], { file: 'macros.tex', old_text: '\\newcommand{\\term}{Old}', new_text: '\\newcommand{\\term}{New}' });
    Object.assign(result.sections[0].blocks[1], { before: [], after: [] });
  }
  result.pdf = prefix + '/full.pdf';
  result.sections[0].blocks[0].after[0].height = 220;
  result.sections[0].blocks[1].before = [];
  result.sections[0].blocks[2].after = [];
  for (const block of result.sections[0].blocks) for (const strip of [...block.before, ...block.after]) Object.assign(strip, { page: 1, top: 200 });
  result.sections[0].blocks.unshift({ kind: 'context', image: image('context', 'Unchanged context.') });
  return result;
}
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/updates') return route.fulfill({ json: { currentVersion: snapshot.version, latestVersion: null, phase: 'idle', checkedAt: 1, error: null, canUpdate: true } });
  if (url.pathname === '/api/state') return route.fulfill({ json: snapshot });
  if (url.pathname.endsWith('/skills')) return route.fulfill({ json: { skills: [] } });
  if (url.pathname === '/api/tasks/question-fixture/items') return route.fulfill({ json: { items: [{ id: 'answer', taskId: 'question-fixture', type: 'assistant', text: 'This equation expresses conservation of mass.', createdAt: 1 }] } });
  if (url.pathname.endsWith('/items')) return route.fulfill({ json: { items: timeline } });
  if (url.pathname.endsWith('/delete')) {
    deleteRequests.push(route.request().postDataJSON());
    snapshot.tasks = snapshot.tasks.filter(item => item.id !== task.id);
    return route.fulfill({ json: { ok: true } });
  }
  if (url.pathname.endsWith('/archive')) {
    const body = route.request().postDataJSON(); archiveRequests.push(body);
    task.archivedAt = body.archived ? Date.now() : null;
    return route.fulfill({ json: task });
  }
  if (url.pathname.endsWith('/git')) return route.fulfill({ json: { branch: 'main', upstream: 'origin/main', remote: true, ahead: 0, behind: 0, head: null, files: gitFiles } });
  if (url.pathname.endsWith('/manuscript')) return route.fulfill({ json: { git: { branch: 'main', remote: true, ahead: 0, behind: 0, head: null, files: gitFiles }, build: { status: 'building', current: false }, annotations: [] } });
  if (url.pathname.endsWith('/git/message') || url.pathname.endsWith('/commit-message')) { messageRequests.push(route.request().postDataJSON()); return route.fulfill({ json: { message: 'Explain the method', agent: 'codex' } }); }
  if (url.pathname.endsWith('/apply')) {
    const body = route.request().postDataJSON();
    applyRequests.push(body);
    if (conflictOnApply) {
      conflictOnApply = false; task.status = 'queued';
      task.reconciliation = { id: 'merge-fixture', round: latest, files: ['main.tex'], ready: true, intent: { mode: body.mode, message: body.message || '' } };
      return route.fulfill({ json: { reconciliation: task.reconciliation } });
    }
    if (combinedOnCommit && body.mode === 'commit' && body.confirmation !== 'combined-version') return route.fulfill({ json: { commitReview: { token: 'combined-version', files: ['main.tex'], diff: '-Original title\n+Final reviewed title' } } });
    combinedOnCommit = false;
    task.review.files = []; task.reconciliation = null;
    task.delivery = { mode: body.mode || 'workspace', accepted: 'accepted', ...(body.mode === 'commit' ? { branch: 'main', commit: 'abc1234' } : {}) };
    if (body.mode === 'commit') commitRequests.push(body);
    return route.fulfill({ json: { delivery: task.delivery } });
  }
  if (url.pathname.endsWith('/commit')) {
    const body = route.request().postDataJSON();
    commitRequests.push(body); gitFiles = []; task.review.files = [];
    if (task.deferred) task.delivery = { mode: 'branch', branch: 'papilot/flow', commit: 'abc1234', accepted: 'accepted' };
    else task.committed = { hash: 'abc1234', accepted: `accepted-${commitRequests.length}`, at: Date.now(), pushed: body.push && !pushError };
    return route.fulfill({ json: { commit: 'abc1234', pushError, git: { branch: 'main', upstream: 'origin/main', remote: true, ahead: 0, behind: 0, head: { hash: 'abc1234', subject: 'Explain the method', date: 2 }, files: [] } } });
  }
  if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
  if (url.pathname.endsWith('/messages')) { task.status = 'running'; task.review.unsent = 0; return route.fulfill({ json: { ok: true } }); }
  throw Error(`Unexpected app request ${url.pathname}`);
});
await page.route('**/review/**', async route => {
  const url = new URL(route.request().url()), relative = url.pathname.slice(prefix.length);
  if (relative === '/') return route.fulfill({ contentType: 'text/html', body: rewriteReviewHtml(fs.readFileSync(path.join(reviewDist, 'index.html'), 'utf8'), prefix) });
  if (relative.startsWith('/assets/')) return route.fulfill({ path: path.join(reviewDist, relative), contentType: /\.m?js$/.test(relative) ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : 'font/otf' });
  if (relative === '/full.pdf') return route.fulfill({ contentType: 'application/pdf', body: fs.readFileSync('tests/fixtures/outline.pdf') });
  if (relative.startsWith('/files/')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 130"><rect width="600" height="130" fill="white"/><text x="60" y="60" font-size="20">A paragraph in the review PDF.</text></svg>' });
  const round = Number(url.searchParams.get('round') || latest);
  if (/\/rounds\/\d+$/.test(relative)) return route.fulfill({ json: detail(Number(relative.split('/').at(-1))) });
  if (relative.endsWith('/effects/first')) { effectRequests++; return route.fulfill({ json: { places: [effectPlace('extra')] } }); }
  let restored;
  if (route.request().method() === 'POST') {
    const body = route.request().postDataJSON(); writes.push(body);
    if (relative.endsWith('/decide')) {
      actions.push({ decisions: structuredClone(rounds[latest]), undo });
      for (const id of body.changes) rounds[latest][id] = { accept: 'accepted', reject: 'rejected', comment: 'commented' }[body.action];
      undo = { id: `action-${++serial}`, kind: body.action, changes: body.changes };
      task.review.unsent++;
    } else if (relative.endsWith('/undo')) {
      restored = undo.changes;
      const previous = actions.pop(); rounds[latest] = previous.decisions; undo = previous.undo;
    }
    update();
  }
  return route.fulfill({ json: { ...annotateReviewState(state(round), [task]), ...(restored ? { restored } : {}) } });
});
const viewer = () => page.frameLocator('.review-frame');
const sync = async () => page.evaluate(() => window.dispatchEvent(new Event('online')));
try {
  await page.goto(origin);
  const frame = viewer();
  await frame.locator('.change.current').waitFor();
  async function aligned() {
    const boxes = await frame.locator('.change .comparison-row').evaluateAll(rows => rows.map(row => [...row.children].map(el => { const b=el.getBoundingClientRect(); return {x:b.x,y:b.y,width:b.width,height:b.height}; })));
    assert.equal(boxes.length,3);
    for (const [left,right] of boxes) { assert.ok(Math.abs(left.y-right.y)<1); assert.ok(Math.abs(left.width-right.width)<1); assert.ok(right.x>left.x+left.width); assert.ok(Math.abs(left.height-right.height)<1); }
  }
  await aligned();
  assert.equal(await frame.locator('.context-pair .context').count(),2);
  await expect(frame.locator('.change[data-stop="1"] .before')).toBeEmpty();
  await expect(frame.locator('.change[data-stop="2"] .after')).toBeEmpty();
  await page.screenshot({path:'test-results/review-side-by-side.png',fullPage:true});
  await frame.locator('.change.current').getByRole('button',{name:'Accept',exact:true}).click();
  await expect.poll(()=>rounds[1].first).toBe('accepted');
  await frame.getByRole('button',{name:'Undo',exact:true}).first().click();
  await expect.poll(()=>rounds[1].first).toBe('pending');
  await frame.locator('.change.current').getByRole('button',{name:'Reject',exact:true}).click();
  await expect.poll(()=>Object.values(rounds[1]).includes('rejected')).toBe(true);
  await frame.getByRole('button',{name:'Undo',exact:true}).first().click();
  await page.getByRole('group',{name:'Show',exact:true}).getByRole('button',{name:'PDF',exact:true}).click();
  await expect(frame.locator('.paper-page').first()).toBeVisible();
  await expect(frame.locator('.paper-context-pair canvas').first()).toBeVisible();
  await aligned();
  await page.screenshot({path:'test-results/review-side-by-side-paper.png',fullPage:true});
  await page.setViewportSize({width:1000,height:900});
  await aligned();
  assert.deepEqual(errors,[]);
  console.log('PASS: paired context, unequal heights, insertions, deletions, accept/reject/undo, full-paper canvases and narrow desktop alignment.');
} finally { await browser.close(); await server.close(); }
