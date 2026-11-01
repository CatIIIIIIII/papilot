import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/server/store.ts';
import { Workspace } from '../src/server/workspace.ts';
import { Accounts } from '../src/server/accounts.ts';
import { Manuscripts } from '../src/server/manuscript.ts';
import { buildApp, gitQueue } from '../src/server/app.ts';
import { accountHsts, accountProblem } from '../src/server/security.ts';
import { Limiter, clientAddress } from '../src/server/access.ts';
import { Updates } from '../src/server/updates.ts';
import { Diagnostics } from '../src/server/diagnostics.ts';
import { PassThrough } from 'node:stream';
import type { Codex } from '../src/server/codex.ts';
import type { ReviewClient } from '../src/server/review.ts';
import { AGENT_IDS, type Annotation, type Task } from '../src/shared.ts';

const ORIGIN = 'https://mini.example.ts.net:10000', PUBLIC = 'https://mini.example.ts.net:8443';
const LOCAL = { host: '127.0.0.1:7274' }, REMOTE = { host: 'mini.example.ts.net:10000' };
class FakeAgent extends EventEmitter { ready = false; async request() { return {}; } respond() {} reject() {} close() {} }
const passkeys = {
  generateRegistrationOptions: async () => ({ challenge: 'register' }) as any,
  verifyRegistrationResponse: async ({ response, expectedChallenge }: any) => ({ verified: await expectedChallenge('register'), registrationInfo: { credential: { id: response.id, publicKey: new Uint8Array([1]), counter: 0 } } }) as any,
  generateAuthenticationOptions: async () => ({ challenge: 'sign-in' }) as any,
  verifyAuthenticationResponse: async () => ({ verified: false }) as any,
};
const task = (id: string, projectId: string): Task => ({ id, projectId, name: 'p-' + id, title: id, instructions: 'Edit.', worktree: '/unused', threadId: null, turnId: null, model: null, status: 'reviewing', createdAt: 1, updatedAt: 1, feedbackCursor: 0, error: null, review: null });

async function fixture() {
  const store = new Store(':memory:'), dist = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-app-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<html>app</html>');
  fs.writeFileSync(path.join(dist, '.env'), 'SECRET=1');
  const review: ReviewClient = { url: 'http://127.0.0.1:9', token: 'review-token', get: async () => ({}) as any, post: async () => ({}) as any };
  const workspace = new Workspace(store, new FakeAgent() as unknown as Codex, 2, async () => review, Object.fromEntries(AGENT_IDS.filter(id => id !== 'codex').map(id => [id, new FakeAgent() as unknown as Codex])));
  workspace.runtimes.codex.account = 'owner@example.com';
  const accounts = new Accounts(store, ORIGIN, passkeys);
  store.saveProject({ id: 'thesis', name: 'Thesis', path: '/unused/thesis', createdAt: 1 });
  store.saveProject({ id: 'grant', name: 'Grant', path: '/unused/grant', createdAt: 1 });
  store.saveTask(task('thesis-task', 'thesis'));
  store.saveTask(task('grant-task', 'grant'));
  workspace.requests.set('grant-request', { id: 'grant-request', taskId: 'grant-task', method: 'item/commandExecution/requestApproval', params: { command: 'ls' }, createdAt: 1, rpcId: 1, agent: 'codex' });
  const updates = new Updates({ root: process.cwd(), data: dist, version: '9.9.9', port: 7274, supported: true, busy: () => true, shutdown() {}, latest: async () => '10.0.0', install: async () => '/fixture-update' });
  const diagnosticRequests: { repo?: string; port?: number }[] = [];
  const diagnostics = new Diagnostics(async (repo, port) => { diagnosticRequests.push({ repo, port }); return { version: '9.9.9', ok: false, checks: [{ id: 'latexmk', ok: false, severity: 'error', detail: 'Not installed.', fix: 'Install TeX Live.' }] }; });
  const shared = { store, workspace, accounts, updates, diagnostics, latexInstallation: async () => ({ distribution: 'MacTeX' as const, version: '2025', path: '/usr/local/texlive/2025' }), manuscripts: new Manuscripts(), csrf: 'local-csrf', serialGit: gitQueue(), dist, version: '9.9.9', connectReview: async () => review };
  const local = await buildApp({ ...shared, listener: { kind: 'local', port: 7274, publicOrigin: PUBLIC, owner: 'owner@example' } });
  const remote = await buildApp({ ...shared, listener: { kind: 'account', origin: ORIGIN, hsts: true } });
  // Ada is invited to the thesis only and signs in at the public URL.
  const ada = accounts.addPerson('Ada', ['thesis']), token = new URL(ada.link).hash.slice(1);
  await accounts.registrationOptions(token);
  const joined = await remote.inject({ method: 'POST', url: '/api/auth/invite/verify', headers: { ...REMOTE, origin: ORIGIN }, payload: { token, response: { id: 'ada-key' } } });
  const session = String(joined.headers['set-cookie']).split(';')[0];
  const state = (await remote.inject({ url: '/api/state', headers: { ...REMOTE, cookie: session } })).json();
  const as = { ...REMOTE, origin: ORIGIN, cookie: session, 'x-papilot-token': state.csrf };
  return { updates, diagnosticRequests, manuscripts: shared.manuscripts, store, workspace, review, accounts, local, remote, ada, joined, session, state, as, async close() { updates.close(); await local.close(); await remote.close(); workspace.close(); store.close(); fs.rmSync(dist, { recursive: true }); } };
}

test('task model changes keep the agent fixed and require task access and valid settings', async () => {
  const f = await fixture();
  try {
    f.workspace.runtime.models = [{ id: 'deep', name: 'Deep', isDefault: true, efforts: ['low', 'high'], defaultEffort: 'high' }];
    const request = { method: 'POST' as const, url: '/api/tasks/thesis-task/model', headers: f.as, payload: { model: 'deep', effort: 'low' } };
    const changed = await f.remote.inject(request);
    assert.equal(changed.statusCode, 200); assert.equal(changed.json().model, 'deep'); assert.equal(changed.json().effort, 'low');
    assert.equal((await f.remote.inject({ ...request, payload: { effort: '' } })).json().effort, null);
    for (const payload of [{ agent: 'claude' }, { effort: 'extreme' }, { effort: 3 }, { model: 3 }, { model: 'foreign' }]) {
      assert.equal((await f.remote.inject({ ...request, payload })).statusCode, 400);
    }
    assert.equal((await f.remote.inject({ ...request, url: '/api/tasks/grant-task/model' })).statusCode, 400);
    assert.equal((await f.remote.inject({ ...request, headers: { ...f.as, 'x-papilot-token': 'wrong' } })).statusCode, 403);
    assert.equal(f.store.task('thesis-task').agent, undefined);
  } finally { await f.close(); }
});

test('skill management is owner-only and writes require CSRF', async () => {
  const f = await fixture();
  try {
    for (const url of ['/api/skills', '/api/skills/builtin/polish']) assert.equal((await f.remote.inject({ url, headers: f.as })).statusCode, 403);
    for (const url of ['/api/skills/user/example', '/api/skills/user/example/remove']) {
      assert.equal((await f.remote.inject({ method: 'POST', url, headers: f.as, payload: { content: 'Instructions.' } })).statusCode, 403);
      assert.equal((await f.local.inject({ method: 'POST', url, headers: { ...LOCAL, origin: 'http://127.0.0.1:7274', 'x-papilot-token': 'wrong' }, payload: { content: 'Instructions.' } })).statusCode, 403);
    }
    const listed = await f.local.inject({ url: '/api/skills', headers: LOCAL });
    assert.equal(listed.statusCode, 200);
    assert.ok(listed.json().skills.some((skill: any) => skill.source === 'builtin'));
    const detail = await f.local.inject({ url: '/api/skills/builtin/polish', headers: LOCAL });
    assert.equal(detail.statusCode, 200); assert.ok(detail.json().content);
    assert.equal((await f.local.inject({ url: '/api/skills?projectId=missing', headers: LOCAL })).statusCode, 400);
  } finally { await f.close(); }
});

test('paper imports require owner access and CSRF before receiving files or starting repairs', async () => {
  const f = await fixture();
  try {
    for (const route of ['/api/imports', '/api/imports/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/build', '/api/imports/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/repair', '/api/imports/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/finish']) {
      const request = { method: 'POST' as const, url: route, payload: {} };
      assert.equal((await f.remote.inject({ ...request, headers: f.as })).statusCode, 403);
      assert.equal((await f.local.inject({ ...request, headers: { ...LOCAL, origin: 'http://127.0.0.1:7274', 'x-papilot-token': 'wrong' } })).statusCode, 403);
    }
    assert.equal((await f.remote.inject({ url: '/api/imports/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', headers: f.as })).statusCode, 403);
  } finally { await f.close(); }
});

test('paper path and removal require the owner, CSRF and an idle paper', async () => {
  const f = await fixture();
  try {
    const headers = { ...LOCAL, origin: 'http://127.0.0.1:7274', 'x-papilot-token': 'local-csrf' };
    for (const action of ['path', 'remove']) {
      const request = { method: 'POST' as const, url: `/api/projects/thesis/${action}`, payload: { path: '/new/path' } };
      assert.equal((await f.remote.inject({ ...request, headers: f.as })).statusCode, 403);
      assert.equal((await f.local.inject({ ...request, headers: { ...headers, 'x-papilot-token': 'wrong' } })).statusCode, 403);
    }
    f.store.updateTask('thesis-task', { status: 'running' });
    assert.equal((await f.local.inject({ method: 'POST', url: '/api/projects/thesis/remove', headers, payload: {} })).statusCode, 409);
    f.store.updateTask('thesis-task', { status: 'reviewing' });
    f.manuscripts.busyForProject = () => true;
    assert.equal((await f.local.inject({ method: 'POST', url: '/api/projects/thesis/remove', headers, payload: {} })).statusCode, 409);
    f.manuscripts.busyForProject = () => false;
    const release = f.workspace.enterProjectRequest('thesis');
    assert.equal((await f.local.inject({ method: 'POST', url: '/api/projects/thesis/remove', headers, payload: {} })).statusCode, 409);
    release();
    const renamed = await f.local.inject({ method: 'POST', url: '/api/projects/thesis/rename', headers, payload: { name: 'Renamed' } });
    assert.equal(renamed.statusCode, 200);
    assert.equal((await f.local.inject({ method: 'POST', url: '/api/projects/thesis/remove', headers, payload: {} })).statusCode, 200);
    assert.deepEqual(f.accounts.projects(f.ada.id), []);
    const snapshot = (await f.local.inject({ url: '/api/state', headers: LOCAL })).json();
    assert.deepEqual(snapshot.projects.map((p: any) => p.id), ['grant']);
    assert.deepEqual(snapshot.tasks.map((t: any) => t.id), ['grant-task']);
    assert.equal((await f.remote.inject({ url: '/api/projects/thesis/git', headers: f.as })).statusCode, 400);
  } finally { await f.close(); }
});

test('LaTeX installation information is read-only and owner-only', async () => {
  const f = await fixture();
  try {
    const url = '/api/runtime/latex';
    assert.equal((await f.remote.inject({ url, headers: f.as })).statusCode, 403);
    const result = await f.local.inject({ url, headers: LOCAL });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), { distribution: 'MacTeX', version: '2025', path: '/usr/local/texlive/2025' });
    assert.equal(f.diagnosticRequests.length, 0, 'Reading the installation does not run repository or agent diagnostics');
  } finally { await f.close(); }
});

test('diagnostics are owner-only, require CSRF and resolve only registered paper IDs', async () => {
  const f = await fixture();
  try {
    const request = { method: 'POST' as const, url: '/api/diagnostics', payload: { projectId: 'thesis' } };
    assert.equal((await f.remote.inject({ ...request, headers: f.as })).statusCode, 403);
    assert.equal((await f.local.inject({ ...request, headers: LOCAL })).statusCode, 403);
    assert.equal(f.diagnosticRequests.length, 0);
    const headers = { ...LOCAL, origin: 'http://127.0.0.1:7274', 'x-papilot-token': 'local-csrf' };
    for (const projectId of [42, '', '/arbitrary/path']) assert.equal((await f.local.inject({ ...request, headers, payload: { projectId } })).statusCode, 400);
    assert.equal(f.diagnosticRequests.length, 0);
    const checked = await f.local.inject({ ...request, headers });
    assert.equal(checked.statusCode, 200); assert.equal(checked.json().ok, false);
    assert.equal(checked.json().checks[0].id, 'latexmk');
    assert.deepEqual(f.diagnosticRequests, [{ repo: '/unused/thesis', port: 7274 }]);
    assert.equal((await f.local.inject({ ...request, headers, payload: {} })).statusCode, 200);
    assert.deepEqual(f.diagnosticRequests[1], { repo: undefined, port: 7274 });
  } finally { await f.close(); }
});

test('recompilation persists confirmed note positions without losing edits, deleted notes, or unresolved notes', async () => {
  const f = await fixture();
  try {
    const makeNote = (id: string): Annotation => ({ id, projectId: 'thesis', key: 'old', page: 0, rect: [0.1, 0.1, 0.3, 0.2], quote: 'Original marked text', comment: 'Original comment', source: null, createdAt: 1 });
    const notes = ['matched', 'deleted', 'sent', 'unresolved'].map(makeNote);
    notes.forEach(note => f.store.saveAnnotation(note));
    f.manuscripts.state = async () => ({ git: { branch: 'main', upstream: null, ahead: 0, behind: 0, files: [], head: null }, build: { key: 'new', status: 'ready', current: true } });
    f.manuscripts.reanchor = async (_id, _root, annotations) => {
      f.store.saveAnnotation({ ...f.store.annotation('thesis', 'matched'), comment: 'Edited while compiling' });
      f.store.deleteAnnotation('thesis', 'deleted');
      f.store.saveAnnotation({ ...f.store.annotation('thesis', 'sent'), taskId: 'thesis-task' });
      return annotations.map(note => note.id === 'unresolved' ? note : { ...note, key: 'new', page: 2 });
    };
    const response = await f.local.inject({ url: '/api/projects/thesis/manuscript', headers: LOCAL });
    assert.equal(response.statusCode, 200);
    const result = response.json().annotations;
    assert.deepEqual(result.map((note: Annotation) => note.id), ['matched', 'unresolved']);
    assert.equal(result[0].key, 'new');
    assert.equal(result[0].page, 2);
    assert.equal(result[0].comment, 'Edited while compiling');
    assert.equal(result[0].quote, 'Original marked text');
    assert.deepEqual(result[1], notes[3]);
    assert.equal(f.store.annotation('thesis', 'matched').key, 'new');
    assert.ok(f.store.annotation('thesis', 'deleted').deletedAt);
    assert.equal(f.store.annotation('thesis', 'sent').key, 'old');
  } finally { await f.close(); }
});

test('updates are owner-only and installs require a valid CSRF token and the advertised version', async () => {
  const f = await fixture();
  try {
    for (const url of ['/api/updates', '/api/updates/check', '/api/updates/install', '/api/updates/channel']) {
      const method = url === '/api/updates' ? 'GET' : 'POST';
      assert.equal((await f.remote.inject({ method, url, headers: f.as, ...(method === 'POST' ? { payload: { version: '10.0.0' } } : {}) })).statusCode, 403);
    }
    const headers = { ...LOCAL, origin: 'http://127.0.0.1:7274', 'x-papilot-token': 'local-csrf' };
    const checked = await f.local.inject({ method: 'POST', url: '/api/updates/check', headers, payload: {} });
    assert.equal((await f.local.inject({ method: 'POST', url: '/api/updates/channel', headers: { ...headers, 'x-papilot-token': 'wrong' }, payload: { channel: 'dev' } })).statusCode, 403);
    assert.equal((await f.local.inject({ method: 'POST', url: '/api/updates/channel', headers, payload: { channel: 'unknown' } })).statusCode, 400);
    assert.equal(checked.json().phase, 'available');
    assert.equal((await f.local.inject({ method: 'POST', url: '/api/updates/install', headers: { ...headers, 'x-papilot-token': 'wrong' }, payload: { version: '10.0.0' } })).statusCode, 403);
    assert.equal((await f.local.inject({ method: 'POST', url: '/api/updates/install', headers, payload: { version: '10.0.1' } })).statusCode, 400);
    const installed = await f.local.inject({ method: 'POST', url: '/api/updates/install', headers, payload: { version: '10.0.0' } });
    assert.equal(installed.statusCode, 200); assert.equal(installed.json().phase, 'installing');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.updates.snapshot().phase, 'waiting');
    Object.defineProperty(f.updates, 'restarting', { get: () => true });
    assert.equal((await f.local.inject({ method: 'POST', url: '/api/tasks/thesis-task/rename', headers, payload: { title: 'Blocked during restart' } })).statusCode, 503);
    assert.equal((await f.local.inject({ url: '/api/updates', headers: LOCAL })).statusCode, 200);
    assert.equal((await f.local.inject({ url: '/api/state', headers: LOCAL })).statusCode, 200);
    assert.equal(f.store.task('thesis-task').title, 'thesis-task');
  } finally { await f.close(); }
});

test('an invited person signs in at the public URL and sees only the papers shared with them', async () => {
  const f = await fixture();
  try {
    assert.equal(f.joined.statusCode, 200);
    assert.match(String(f.joined.headers['set-cookie']), /^__Host-papilot-session=[\w-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict/);
    assert.deepEqual(f.state.viewer, { id: f.ada.id, name: 'Ada', role: 'member', listener: 'account', owner: f.accounts.owner().name });
    assert.deepEqual(f.state.projects.map((p: any) => p.id), ['thesis']);
    assert.deepEqual(f.state.tasks.map((t: any) => t.id), ['thesis-task']);
    assert.deepEqual(f.state.requests, []);
    assert.equal(f.state.runtimes.codex.account, 'Signed in', "the owner's agent login stays private");
    // Unsharing takes effect on the next request.
    f.accounts.share(f.ada.id, ['grant']);
    const after = (await f.remote.inject({ url: '/api/state', headers: { ...REMOTE, cookie: f.session } })).json();
    assert.deepEqual([after.projects.map((p: any) => p.id), after.requests.map((r: any) => r.id)], [['grant'], ['grant-request']]);
  } finally { await f.close(); }
});

test('the public URL lets nothing through without a session, whatever the headers claim', async () => {
  const f = await fixture();
  try {
    for (const headers of [REMOTE, { ...REMOTE, 'tailscale-user-login': 'owner@example' }, { ...REMOTE, cookie: '__Host-papilot-session=forged' }]) {
      const response = await f.remote.inject({ url: '/api/state', headers });
      assert.equal(response.statusCode, 401, JSON.stringify(headers));
    }
    // A local Host header does not make a public request local.
    assert.equal((await f.remote.inject({ url: '/api/state', headers: LOCAL })).statusCode, 403);
    // The app itself loads, so the sign-in page can show; dotfiles never do.
    assert.equal((await f.remote.inject({ url: '/', headers: REMOTE })).body, '<html>app</html>');
    assert.equal((await f.remote.inject({ url: '/invite', headers: REMOTE })).body, '<html>app</html>');
    const dotfile = await f.remote.inject({ url: '/.env', headers: REMOTE });
    assert.notEqual(dotfile.body, 'SECRET=1');
    assert.equal((await f.local.inject({ url: '/.env', headers: LOCAL })).body === 'SECRET=1', false);
    assert.deepEqual((await f.remote.inject({ url: '/api/health', headers: REMOTE })).json(), { ok: true });
    assert.equal((await f.remote.inject({ url: '/review/thesis/', headers: REMOTE })).statusCode, 401);
    assert.equal((await f.remote.inject({ url: '/api/projects/thesis/manuscript.pdf', headers: REMOTE })).statusCode, 401);
    assert.match(String((await f.remote.inject({ url: '/', headers: REMOTE })).headers['strict-transport-security']), /max-age/);
  } finally { await f.close(); }
});

test('public requests need the right origin, the session token and no other site', async () => {
  const f = await fixture();
  try {
    const rename = (headers: Record<string, string>) => f.remote.inject({ method: 'POST', url: '/api/tasks/thesis-task/rename', headers, payload: { title: 'Renamed' } });
    const { origin: _, ...noOrigin } = f.as;
    assert.equal((await rename(noOrigin)).statusCode, 403);
    assert.equal((await rename({ ...f.as, origin: 'https://evil.example' })).statusCode, 403);
    assert.equal((await rename({ ...f.as, 'x-papilot-token': 'local-csrf' })).statusCode, 403);
    assert.equal((await rename({ ...f.as, 'sec-fetch-site': 'same-site' })).statusCode, 403);
    assert.equal((await f.remote.inject({ url: '/api/state', headers: { ...REMOTE, cookie: f.session, 'sec-fetch-site': 'same-site' } })).statusCode, 403);
    assert.equal((await rename(f.as)).statusCode, 200);
    assert.equal(f.store.task('thesis-task').title, 'Renamed');
    // A link from another site, such as an invite in a web mail, opens the app; nothing else is served to other sites.
    const navigate = { ...REMOTE, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    assert.equal((await f.remote.inject({ url: '/invite', headers: navigate })).body, '<html>app</html>');
    assert.equal((await f.remote.inject({ url: '/api/state', headers: { ...navigate, cookie: f.session } })).statusCode, 403);
    assert.equal((await f.remote.inject({ url: '/', headers: { ...navigate, 'sec-fetch-dest': 'iframe' } })).statusCode, 403);
  } finally { await f.close(); }
});

test('archive API persists and restores shared tasks and rejects malformed requests', async () => {
  const f = await fixture();
  try {
    const archive = (payload: object) => f.remote.inject({ method: 'POST', url: '/api/tasks/thesis-task/archive', headers: f.as, payload });
    for (const payload of [{}, { archived: 'true' }, { archived: null }]) assert.equal((await archive(payload)).statusCode, 400);
    assert.equal(f.store.task('thesis-task').archivedAt, undefined);
    assert.equal((await archive({ archived: true, finished: true })).json().archivedAt, undefined, 'legacy navigation does not archive tasks');
    const archived = await archive({ archived: true });
    assert.equal(archived.statusCode, 200);
    assert.ok(archived.json().archivedAt);
    const snapshot = (await f.remote.inject({ url: '/api/state', headers: { ...REMOTE, cookie: f.session } })).json();
    assert.equal(snapshot.tasks[0].archivedAt, archived.json().archivedAt);
    assert.equal((await archive({ archived: false })).json().archivedAt, null);
  } finally { await f.close(); }
});

test('an unshared paper answers exactly like one that does not exist', async () => {
  const f = await fixture();
  try {
    const same = async (label: string, unshared: { method?: 'GET' | 'POST'; url: string; payload?: object }, missing: { method?: 'GET' | 'POST'; url: string; payload?: object }) => {
      const a = await f.remote.inject({ ...unshared, headers: f.as }), b = await f.remote.inject({ ...missing, headers: f.as });
      assert.equal(a.statusCode, b.statusCode, label);
      assert.equal(a.body, b.body, label);
      assert.ok(a.statusCode >= 400, label);
    };
    await same('paper', { url: '/api/projects/grant/git' }, { url: '/api/projects/nope/git' });
    await same('worktrees and history', { url: '/api/projects/grant/git/overview' }, { url: '/api/projects/nope/git/overview' });
    await same('paper PDF', { url: '/api/projects/grant/manuscript.pdf?key=x' }, { url: '/api/projects/nope/manuscript.pdf?key=x' });
    await same('notes', { method: 'POST', url: '/api/projects/grant/annotations/send', payload: { id: 'new-task-id-0001' } }, { method: 'POST', url: '/api/projects/nope/annotations/send', payload: { id: 'new-task-id-0001' } });
    await same('review', { url: '/review/grant/api/tasks' }, { url: '/review/nope/api/tasks' });
    await same('task', { url: '/api/tasks/grant-task/items' }, { url: '/api/tasks/nope/items' });
    await same('task write', { method: 'POST', url: '/api/tasks/grant-task/interrupt', payload: {} }, { method: 'POST', url: '/api/tasks/nope/interrupt', payload: {} });
    await same('task archive', { method: 'POST', url: '/api/tasks/grant-task/archive', payload: { archived: true } }, { method: 'POST', url: '/api/tasks/nope/archive', payload: { archived: true } });
    await same('task title generation', { method: 'POST', url: '/api/tasks/grant-task/title', payload: {} }, { method: 'POST', url: '/api/tasks/nope/title', payload: {} });
    await same('approval', { method: 'POST', url: '/api/requests/grant-request', payload: { decision: 'accept' } }, { method: 'POST', url: '/api/requests/nope', payload: { decision: 'accept' } });
    await same('new task', { method: 'POST', url: '/api/tasks', payload: { id: 'new-task-id-0002', projectId: 'grant', title: 'T', instructions: 'Edit.' } }, { method: 'POST', url: '/api/tasks', payload: { id: 'new-task-id-0002', projectId: 'nope', title: 'T', instructions: 'Edit.' } });
    assert.equal(f.store.task('grant-task').status, 'reviewing');
    // Deleting a task that is gone succeeds so a lost response can be retried; a hidden one answers the same and stays.
    const deleteHidden = await f.remote.inject({ method: 'POST', url: '/api/tasks/grant-task/delete', headers: f.as, payload: { confirm: true } });
    const deleteMissing = await f.remote.inject({ method: 'POST', url: '/api/tasks/nope/delete', headers: f.as, payload: { confirm: true } });
    assert.deepEqual([deleteHidden.statusCode, deleteHidden.body], [deleteMissing.statusCode, deleteMissing.body]);
    assert.deepEqual(deleteHidden.json(), { ok: true });
    assert.ok(f.store.tasks().some(task => task.id === 'grant-task'), 'a hidden task is not deleted');
    const reconnected = await f.remote.inject({ method: 'POST', url: '/api/reconnect', headers: f.as, payload: {} });
    assert.equal(reconnected.json().account, 'Signed in', "reconnecting does not reveal the owner's agent login");
    // Another paper's task id cannot be claimed through a shared paper.
    const claimed = await f.remote.inject({ method: 'POST', url: '/api/tasks', headers: f.as, payload: { id: 'grant-task', projectId: 'thesis', title: 'T', instructions: 'Edit.' } });
    assert.deepEqual([claimed.statusCode, claimed.json().error], [400, 'Invalid task ID.']);
    const sent = await f.remote.inject({ method: 'POST', url: '/api/projects/thesis/annotations/send', headers: f.as, payload: { id: 'grant-task' } });
    assert.deepEqual([sent.statusCode, sent.json().error], [400, 'Invalid task ID.']);
  } finally { await f.close(); }
});

test('task and PDF note submissions both carry the chosen service tier', async () => {
  const f = await fixture();
  try {
    const inputs: Parameters<Workspace['createTask']>[0][] = [];
    f.workspace.createTask = async input => { inputs.push(input); return { ...task(input.id, input.projectId), serviceTier: input.serviceTier }; };
    f.store.saveAnnotation({ id: 'note', projectId: 'thesis', key: 'pdf', page: 0, rect: [0, 0, 1, 1], quote: 'Text', comment: 'Shorten.', source: null, createdAt: 1 });
    const created = await f.remote.inject({ method: 'POST', url: '/api/tasks', headers: f.as, payload: { id: 'tier-task-test-01', projectId: 'thesis', title: 'Revise', instructions: 'Revise.', serviceTier: 'priority' } });
    const notes = await f.remote.inject({ method: 'POST', url: '/api/projects/thesis/annotations/send', headers: f.as, payload: { id: 'tier-task-test-02', annotations: ['note'], serviceTier: 'default' } });
    assert.equal(created.statusCode, 200);
    assert.equal(notes.statusCode, 200);
    assert.deepEqual(inputs.map(input => input.serviceTier), ['priority', 'default']);
    const invalid = await f.remote.inject({ method: 'POST', url: '/api/tasks', headers: f.as, payload: { id: 'tier-task-test-03', projectId: 'thesis', title: 'Revise', instructions: 'Revise.', serviceTier: true } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(inputs.length, 2);
  } finally { await f.close(); }
});

test('the note-send route requires explicit IDs and leaves reading notes alone', async () => {
  const f = await fixture();
  try {
    const inputs: Parameters<Workspace['createTask']>[0][] = [];
    f.workspace.createTask = async input => { inputs.push(input); return task(input.id, input.projectId); };
    const note = { projectId: 'thesis', key: 'pdf', page: 0, rect: [0, 0, 1, 1] as [number, number, number, number], quote: 'Text', comment: 'A reading note.', source: null, createdAt: 1 };
    f.store.saveAnnotation({ ...note, id: 'personal' });
    f.store.saveAnnotation({ ...note, id: 'selected', comment: 'Clarify this.' });
    f.store.saveAnnotation({ ...note, id: 'ignored', deletedAt: 1 });
    const send = (annotations?: unknown) => f.remote.inject({ method: 'POST', url: '/api/projects/thesis/annotations/send', headers: f.as, payload: { id: 'explicit-notes-01', ...(annotations === undefined ? {} : { annotations }) } });
    for (const ids of [undefined, [], ['ignored'], ['missing'], [42]]) assert.equal((await send(ids)).statusCode, 400);
    assert.equal(inputs.length, 0);
    assert.equal((await send(['selected'])).statusCode, 200);
    assert.deepEqual(inputs[0].annotations, ['selected']);
    assert.equal(f.store.annotation('thesis', 'personal').taskId, undefined);
  } finally { await f.close(); }
});

test('one task carries PDF notes, a skill and the overall request; retries leave newer notes pending', async () => {
  const f = await fixture();
  try {
    const note = { id: 'combined-note', projectId: 'thesis', key: 'pdf', page: 0, rect: [0, 0, 1, 1] as [number, number, number, number], quote: 'Original sentence.', comment: 'Shorten this.', source: { file: 'main.tex', lines: [10, 12] as [number, number], excerpt: 'Original source.' }, createdAt: 1 };
    f.store.saveAnnotation(note);
    const payload = { id: 'combined-task-0001', projectId: 'thesis', title: 'Polish the marked text', instructions: 'Keep all technical terms.', skill: 'polish', annotations: [note.id] };
    const sent = await f.remote.inject({ method: 'POST', url: '/api/tasks', headers: f.as, payload });
    assert.equal(sent.statusCode, 200, sent.body);
    const [item] = f.store.items(payload.id), run = f.store.runByKey('initial-' + payload.id)!;
    assert.equal(item.text, payload.instructions);
    assert.deepEqual(item.meta?.skill, { id: 'polish', name: 'Polish' });
    assert.deepEqual(item.meta?.notes, [{ id: note.id, where: 'Page 1 · main.tex lines 10–12', quote: note.quote, comment: note.comment, anchor: { sources: [{ file: 'main.tex', lines: [10, 12] }] } }]);
    assert.match(run.prompt, /<skill name="Polish">/);
    assert.match(run.prompt, /Overall request:\nKeep all technical terms\./);
    assert.match(run.prompt, /Original source\./);
    assert.match(run.prompt, /Note: Shorten this\./);
    assert.equal(f.store.annotations('thesis')[0].taskId, payload.id);
    f.store.saveAnnotation({ ...note, id: 'later-note' });
    const retried = await f.remote.inject({ method: 'POST', url: '/api/tasks', headers: f.as, payload: { ...payload, annotations: [note.id, 'later-note'] } });
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(retried.json().id, payload.id);
    assert.equal(f.store.items(payload.id).length, 1);
    assert.equal(f.store.annotations('thesis').find(note => note.id === 'later-note')?.taskId, undefined);
    const notesOnly = await f.remote.inject({ method: 'POST', url: '/api/tasks', headers: f.as, payload: { ...payload, id: 'notes-only-task-01', instructions: '', skill: undefined, annotations: ['later-note'] } });
    assert.equal(notesOnly.statusCode, 200, notesOnly.body);
    assert.equal(f.store.items('notes-only-task-01')[0].text, '');
    assert.equal(f.store.items('notes-only-task-01')[0].meta?.notes?.length, 1);
  } finally { await f.close(); }
});

test('annotation subsets go to separate agents while unselected notes keep their content and anchors', async () => {
  const f = await fixture();
  try {
    const notes: Annotation[] = ['first', 'second', 'kimi-note', 'later'].map((id, index) => ({ id, projectId: 'thesis', key: 'pdf', page: index, rect: [0.1, 0.2, 0.4, 0.3], quote: `Original text ${id}`, comment: `Revise ${id}.`, source: null, group: 'yellow', createdAt: index + 1 }));
    notes.forEach(note => f.store.saveAnnotation(note));
    for (const [index, agent] of ['codex', 'claude', 'kimi'].entries()) {
      const id = `subset-note-task-${index}`, payload = { id, projectId: 'thesis', title: 'Revise one annotation', instructions: '', agent, annotations: [notes[index].id] };
      const response = await f.remote.inject({ method: 'POST', url: '/api/tasks', headers: f.as, payload });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().agent, agent);
      assert.deepEqual(f.store.items(id)[0].meta?.notes?.map(note => note.id), [notes[index].id]);
      assert.deepEqual(f.store.annotations('thesis').filter(note => !note.taskId), notes.slice(index + 1));
    }
    assert.equal(f.store.annotation('thesis', 'first').taskId, 'subset-note-task-0');
    assert.equal(f.store.annotation('thesis', 'second').taskId, 'subset-note-task-1');
    assert.equal(f.store.annotation('thesis', 'kimi-note').taskId, 'subset-note-task-2');
    assert.deepEqual(f.store.annotation('thesis', 'later'), notes[3]);
  } finally { await f.close(); }
});

test('review notes retain their anchors and link only to their own task result', async () => {
  const f = await fixture();
  try {
    f.store.updateTask('thesis-task', { review: { state: 'reviewing', round: 1, counts: { pending: 1 } } });
    f.review.get = async (route: string) => (route.includes('/feedback') ? { cursor: 0, feedback: [] } : route.includes('/rounds/') ? {
      round: 2, units: [{ id: 'c1', file: 'main.tex', old_start: 10, old_end: 12, old_text: 'Original technical sentence.', new_text: 'Short sentence.' }],
      sections: [], loose: [{ kind: 'change', units: ['c1'] }],
    } : { decisions: { c1: 'accepted' } }) as any;
    const note = { id: 'review-note', where: 'Round 1 · Before · main.tex:10–12', quote: 'Original technical sentence.', comment: 'Shorten this.', anchor: { round: 1, sources: [{ file: 'main.tex', lines: [10, 12] }] } };
    const payload = { requestKey: 'review-note-request', text: '', notes: [note] };
    for (const invalid of [[], [null], [{ ...note, anchor: { round: 99, sources: [] } }], [{ ...note, anchor: { sources: [{ file: 'main.tex', lines: [12, 10] }] } }]]) {
      const response = await f.remote.inject({ method: 'POST', url: '/api/tasks/thesis-task/messages', headers: f.as, payload: { ...payload, notes: invalid } });
      assert.equal(response.statusCode, 400);
    }
    const sent = await f.remote.inject({ method: 'POST', url: '/api/tasks/thesis-task/messages', headers: f.as, payload });
    assert.equal(sent.statusCode, 200, sent.body);
    assert.deepEqual(f.store.items('thesis-task')[0].meta?.notes, [note]);
    assert.equal(f.store.items('thesis-task')[0].text, '');
    assert.match(sent.json().prompt, /Shorten this\./);
    assert.match(sent.json().prompt, /Original technical sentence\./);
    const waiting = await f.remote.inject({ url: '/api/tasks/thesis-task/note-results', headers: f.as });
    assert.equal(waiting.json().notes[0].state, 'waiting');
    f.store.saveRun({ ...sent.json(), status: 'completed', reviewRound: 2 });
    f.store.updateTask('thesis-task', { status: 'reviewing', review: { state: 'reviewing', round: 2, counts: { accepted: 1 } } });
    const result = await f.remote.inject({ url: '/api/tasks/thesis-task/note-results', headers: f.as });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().notes[0].changes[0].round, 2);
    assert.equal(result.json().notes[0].changes[0].state, 'accepted');
    const denied = await f.remote.inject({ url: '/api/tasks/grant-task/note-results', headers: f.as });
    assert.ok(denied.statusCode >= 400);
    const retry = await f.remote.inject({ method: 'POST', url: '/api/tasks/thesis-task/messages', headers: f.as, payload });
    assert.equal(retry.json().id, sent.json().id); assert.equal(f.store.items('thesis-task').length, 1);
  } finally { await f.close(); }
});

test('notes can be edited, deleted and restored in order without changing their PDF anchors or authors', async () => {
  const f = await fixture();
  try {
    const note = { id: 'editable-note', projectId: 'thesis', key: 'pdf', page: 2, rect: [0.1, 0.2, 0.6, 0.3] as [number, number, number, number], rects: [[0.1, 0.2, 0.6, 0.3]] as [number, number, number, number][], quote: 'Original sentence.', comment: 'Shorten.', source: { file: 'main.tex', lines: [10, 12] as [number, number], excerpt: 'Original source.' }, createdAt: 1, author: { id: f.ada.id, name: 'Ada' } };
    f.store.saveAnnotation(note); f.store.saveAnnotation({ ...note, id: 'next-note' });
    const post = (suffix: string, payload: Record<string, unknown> = {}) => f.remote.inject({ method: 'POST', url: '/api/projects/thesis/annotations/editable-note' + suffix, headers: f.as, payload });
    for (const comment of ['', '  ', 'x'.repeat(4001), 42]) assert.equal((await post('', { comment })).statusCode, 400);
    const edited = await post('', { comment: '  Keep the technical terms.  ', quote: 'Forged quote', author: { name: 'Someone else' }, page: 9 });
    const expected = { ...note, comment: 'Keep the technical terms.' };
    assert.equal(edited.statusCode, 200, edited.body); assert.deepEqual(edited.json(), expected);
    assert.equal((await post('/delete')).statusCode, 200);
    assert.equal((await post('/delete')).statusCode, 200, 'deletion is safe to retry');
    assert.deepEqual(f.store.annotations('thesis').map(note => note.id), ['next-note']);
    assert.equal((await post('', { comment: 'Cannot edit a deleted note.' })).statusCode, 400);
    const sendDeleted = await f.remote.inject({ method: 'POST', url: '/api/tasks', headers: f.as, payload: { id: 'deleted-note-task-01', projectId: 'thesis', title: 'Revise', instructions: '', annotations: [note.id] } });
    assert.equal(sendDeleted.statusCode, 400);
    f.store.saveAnnotation({ ...note, id: 'newer-note' });
    const restored = await post('/restore');
    assert.equal(restored.statusCode, 200, restored.body);
    assert.deepEqual(restored.json().annotations.map((note: any) => note.id), ['editable-note', 'next-note', 'newer-note']);
    assert.deepEqual(restored.json().annotations[0], expected);
    assert.equal((await post('/restore')).statusCode, 200);
    assert.equal(f.store.annotations('thesis').length, 3, 'restore retries do not duplicate notes');
    // A paper ID cannot be used to alter a note from another paper.
    f.store.saveAnnotation({ ...note, id: 'private-note', projectId: 'grant' });
    for (const suffix of ['', '/delete', '/restore']) {
      const response = await f.remote.inject({ method: 'POST', url: '/api/projects/thesis/annotations/private-note' + suffix, headers: f.as, payload: { comment: 'Changed' } });
      assert.equal(response.statusCode, 400);
    }
    assert.equal(f.store.annotations('grant')[0].comment, note.comment);
    const sent = await f.remote.inject({ method: 'POST', url: '/api/tasks', headers: f.as, payload: { id: 'edited-note-task-01', projectId: 'thesis', title: 'Revise', instructions: '', annotations: [note.id] } });
    assert.equal(sent.statusCode, 200, sent.body);
    assert.equal(f.store.items('edited-note-task-01')[0].meta?.notes?.[0].comment, expected.comment);
    for (const suffix of ['', '/delete', '/restore']) assert.equal((await post(suffix, { comment: 'Too late' })).statusCode, 400);
  } finally { await f.close(); }
});

test('notes being submitted cannot be edited or deleted while task creation awaits the review service', async () => {
  const f = await fixture();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  try {
    f.store.saveAnnotation({ id: 'sending-note', projectId: 'thesis', key: 'pdf', page: 0, rect: [0, 0, 1, 1], quote: '', comment: 'Keep this text.', source: null, createdAt: 1 });
    const workspace = f.workspace as any, connect = workspace.connectReview;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    workspace.connectReview = async (...args: any[]) => { entered(); await pending; return connect(...args); };
    const creating = f.remote.inject({ method: 'POST', url: '/api/tasks', headers: f.as, payload: { id: 'sending-note-task-01', projectId: 'thesis', title: 'Revise', instructions: '', annotations: ['sending-note'] } }).then(result => result);
    await waiting;
    for (const suffix of ['', '/delete', '/restore']) {
      const response = await f.remote.inject({ method: 'POST', url: '/api/projects/thesis/annotations/sending-note' + suffix, headers: f.as, payload: { comment: 'Changed' } });
      assert.equal(response.statusCode, 400); assert.match(response.json().error, /being sent/);
    }
    release(); assert.equal((await creating).statusCode, 200);
    assert.equal(f.store.items('sending-note-task-01')[0].meta?.notes?.[0].comment, 'Keep this text.');
  } finally { release(); await f.close(); }
});

test('task attachments must be pending notes from the selected paper', async () => {
  const f = await fixture();
  try {
    const note = { id: 'foreign-note', projectId: 'grant', key: 'pdf', page: 0, rect: [0, 0, 1, 1] as [number, number, number, number], quote: '', comment: 'Private note.', source: null, createdAt: 1 };
    f.store.saveAnnotation(note);
    f.store.saveAnnotation({ ...note, id: 'sent-note', projectId: 'thesis', taskId: 'thesis-task' });
    for (const annotations of [['foreign-note'], ['missing-note'], ['sent-note'], [42], 'not-an-array']) {
      const response = await f.remote.inject({ method: 'POST', url: '/api/tasks', headers: f.as, payload: { id: 'invalid-notes-0001', projectId: 'thesis', title: 'Revise', instructions: '', annotations } });
      assert.equal(response.statusCode, 400, response.body);
    }
    assert.equal(f.store.tasks().length, 2);
    assert.equal(f.store.annotations('grant')[0].taskId, undefined);
  } finally { await f.close(); }
});

test('adding papers and managing people stay with the owner', async () => {
  const f = await fixture();
  try {
    for (const [method, url] of [['POST', '/api/projects'], ['GET', '/api/people'], ['POST', '/api/people'], ['POST', `/api/people/${f.ada.id}/share`], ['POST', `/api/people/${f.ada.id}/remove`]] as const) {
      const response = await f.remote.inject({ method, url, headers: f.as, ...(method === 'POST' ? { payload: { path: '/', name: 'x', projects: ['grant'] } } : {}) });
      assert.equal(response.statusCode, 403, url);
    }
    // The owner shares from the host, and a removed person's next request asks them to sign in.
    const people = (await f.local.inject({ url: '/api/people', headers: LOCAL })).json();
    assert.deepEqual(people.people.map((p: any) => [p.name, p.role, p.joined]), [[f.accounts.owner().name, 'owner', false], ['Ada', 'member', true]]);
    const removed = await f.local.inject({ method: 'POST', url: `/api/people/${f.ada.id}/remove`, headers: { ...LOCAL, 'x-papilot-token': 'local-csrf' } });
    assert.equal(removed.statusCode, 200);
    assert.equal((await f.remote.inject({ url: '/api/state', headers: { ...REMOTE, cookie: f.session } })).statusCode, 401);
  } finally { await f.close(); }
});

test('a request whose body arrives after its person was removed or unshared does nothing', async () => {
  const f = await fixture();
  try {
    const slow = (url: string) => { const body = new PassThrough(); return { body, response: f.remote.inject({ method: 'POST', url, headers: { ...f.as, 'content-type': 'application/json' }, payload: body }) }; };
    const unshared = slow('/api/tasks/thesis-task/rename');
    await new Promise(resolve => setTimeout(resolve, 30));
    f.accounts.share(f.ada.id, ['grant']);
    unshared.body.end(JSON.stringify({ title: 'Renamed after unsharing' }));
    assert.deepEqual((await unshared.response).json(), { error: 'Task not found.' });
    const removed = slow('/api/tasks/grant-task/rename');
    await new Promise(resolve => setTimeout(resolve, 30));
    f.accounts.remove(f.ada.id);
    removed.body.end(JSON.stringify({ title: 'Renamed after removal' }));
    assert.equal((await removed.response).statusCode, 401);
    assert.deepEqual([f.store.task('thesis-task').title, f.store.task('grant-task').title], ['thesis-task', 'grant-task']);
  } finally { await f.close(); }
});

test('sign-in attempts are limited per client, an IPv6 client by its /64, with no cap one client can exhaust', () => {
  const address = (forwarded: string) => clientAddress({ headers: { 'x-forwarded-for': forwarded } } as any);
  assert.equal(address('10.0.0.1, 203.0.113.7'), '203.0.113.7');
  assert.equal(address('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(address('2001:db8:1:2::99'), '2001:db8:1:2::/64');
  assert.equal(address('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(address('::ffff:198.51.100.4'), '198.51.100.4');
  assert.equal(clientAddress({ headers: {} } as any), 'unknown');
  const limiter = new Limiter(3, 10, () => 0);
  for (let i = 0; i < 3; i++) assert.ok(limiter.take('2001:db8:1:2::/64'));
  assert.equal(limiter.take('2001:db8:1:2::/64'), false);
  for (let i = 0; i < 500; i++) limiter.take(`198.51.100.${i % 250}-${i}`);
  assert.ok(limiter.take('203.0.113.7'), 'many attackers do not lock out someone else');
  for (let i = 0; i < 10; i++) assert.ok(limiter.take('unknown'));
  assert.equal(limiter.take('unknown'), false);
});

test('messages from an invited person carry their name; the owner\'s carry none', async () => {
  const f = await fixture();
  try {
    const sent = await f.remote.inject({ method: 'POST', url: '/api/tasks/thesis-task/messages', headers: f.as, payload: { text: 'Tighten the abstract.', requestKey: 'ada-request' } });
    assert.equal(sent.statusCode, 200, sent.body);
    const items = f.store.items('thesis-task');
    assert.deepEqual(items.at(-1)?.meta?.author, { id: f.ada.id, name: 'Ada' });
    const own = await f.local.inject({ method: 'POST', url: '/api/tasks/grant-task/messages', headers: { ...LOCAL, 'x-papilot-token': 'local-csrf' }, payload: { text: 'And the title.', requestKey: 'owner-request' } });
    assert.equal(own.statusCode, 200, own.body);
    assert.equal(f.store.items('grant-task').at(-1)?.meta?.author, undefined);
  } finally { await f.close(); }
});

test('this host and the tailnet keep working as before, and refuse Funnel traffic', async () => {
  const f = await fixture();
  try {
    const state = (await f.local.inject({ url: '/api/state', headers: LOCAL })).json();
    assert.deepEqual([state.csrf, state.viewer.role, state.viewer.listener, state.projects.length, state.runtimes.codex.account], ['local-csrf', 'owner', 'local', 2, 'owner@example.com']);
    assert.equal((await f.local.inject({ url: '/api/state', headers: { host: 'mini.example.ts.net:8443', 'tailscale-user-login': 'owner@example' } })).statusCode, 200);
    assert.equal((await f.local.inject({ url: '/api/state', headers: { ...LOCAL, 'tailscale-funnel-request': '?1' } })).statusCode, 403);
    assert.equal((await f.local.inject({ method: 'POST', url: '/api/tasks/grant-task/rename', headers: LOCAL, payload: { title: 'x' } })).statusCode, 403);
    assert.equal((await f.local.inject({ method: 'POST', url: '/api/auth/options', headers: LOCAL, payload: {} })).statusCode, 404, 'sign-in exists only at the public URL');
    // Deleting a task that is already gone still succeeds, so a lost response can be retried.
    const gone = await f.local.inject({ method: 'POST', url: '/api/tasks/gone/delete', headers: { ...LOCAL, 'x-papilot-token': 'local-csrf' }, payload: { confirm: true } });
    assert.equal(gone.statusCode, 200);
  } finally { await f.close(); }
});

test('a route without an access rule stops the server from starting', async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.local.get('/api/unguarded', () => ({})), /has no access rule/);
    assert.throws(() => f.local.get('/api/things/:id', { config: { access: { task: 'thing' } } }, () => ({})), /no :thing parameter/);
  } finally { await f.close(); }
});

test('the public sign-in URL must be its own HTTPS origin', () => {
  assert.equal(accountProblem('', 7275, 7274, PUBLIC), null);
  assert.equal(accountProblem(ORIGIN, 7275, 7274, PUBLIC), null);
  assert.equal(accountProblem('http://localhost:7275', 7275, 7274, ''), null);
  assert.match(accountProblem('http://mini.example.ts.net', 7275, 7274, '')!, /https/);
  assert.match(accountProblem(PUBLIC, 7275, 7274, PUBLIC)!, /differ from PAPILOT_PUBLIC_ORIGIN/);
  assert.match(accountProblem(ORIGIN, 7274, 7274, PUBLIC)!, /PAPILOT_ACCOUNT_PORT/);
  assert.match(accountProblem(ORIGIN + '/papilot', 7275, 7274, PUBLIC)!, /without a path/);
  // HSTS would also cover a plain-HTTP tailnet endpoint on the same host name.
  assert.equal(accountHsts(ORIGIN, PUBLIC), true);
  assert.equal(accountHsts(ORIGIN, 'http://mini.example.ts.net:8081'), false);
  assert.equal(accountHsts(ORIGIN, 'http://100.64.0.1:8081'), true);
  assert.equal(accountHsts('http://localhost:7275', ''), false);
});


test('color groups persist without per-location comments and take their meaning from each request', async () => {
  const f = await fixture();
  f.manuscripts.locate = async () => ({ quote: 'Selected text', source: { file: 'main.tex', lines: [10, 12], excerpt: undefined } });
  try {
    const mark = { key: 'pdf', page: 0, rect: [0.1, 0.1, 0.4, 0.2], group: 'yellow' };
    const create = () => f.remote.inject({ method: 'POST', url: '/api/projects/thesis/annotations', headers: f.as, payload: mark });
    const a = await create(), b = await create();
    assert.equal(a.statusCode, 200, a.body); assert.equal(b.statusCode, 200, b.body);
    assert.equal(a.json().group, 'yellow'); assert.equal(a.json().comment, '');
    const invalid = await f.remote.inject({ method: 'POST', url: '/api/projects/thesis/annotations', headers: f.as, payload: { ...mark, group: 'delete' } });
    assert.equal(invalid.statusCode, 400);
    await f.remote.inject({ method: 'POST', url: `/api/projects/thesis/annotations/${a.json().id}/delete`, headers: f.as, payload: {} });
    const restored = await f.remote.inject({ method: 'POST', url: `/api/projects/thesis/annotations/${a.json().id}/restore`, headers: f.as, payload: {} });
    assert.equal(restored.json().annotations[0].group, 'yellow');
    const payload = { id: 'yellow-groups-task-01', projectId: 'thesis', title: 'Explain marked text', instructions: '', annotations: [a.json().id, b.json().id] };
    const empty = await f.remote.inject({ method: 'POST', url: '/api/tasks', headers: f.as, payload });
    assert.equal(empty.statusCode, 400);
    const send = await f.remote.inject({ method: 'POST', url: '/api/tasks', headers: f.as, payload: { ...payload, instructions: 'Explain the yellow selections.' } });
    assert.equal(send.statusCode, 200, send.body);
    const run = f.store.runByKey('initial-' + payload.id)!;
    assert.match(run.prompt, /no built-in meaning/);
    assert.equal(run.prompt.match(/Color group: Yellow/g)?.length, 2);
    const item = f.store.items(payload.id)[0];
    assert.equal(item.text, 'Explain the yellow selections.');
    assert.deepEqual(item.meta?.notes?.map(note => note.group), ['yellow', 'yellow']);
    const c = await create();
    const next = await f.remote.inject({ method: 'POST', url: '/api/tasks', headers: f.as, payload: { ...payload, id: 'yellow-groups-task-02', instructions: 'Shorten the yellow selections.', annotations: [c.json().id] } });
    assert.equal(next.statusCode, 200, next.body);
    const nextPrompt = f.store.runByKey('initial-yellow-groups-task-02')!.prompt;
    assert.match(nextPrompt, /Shorten the yellow selections/); assert.doesNotMatch(nextPrompt, /Explain the yellow selections/);
  } finally { await f.close(); }
});

test('group-specific instructions are scoped to selected notes and preserved in the agent prompt and chat', async () => {
  const f = await fixture();
  try {
    const make = (id: string, group?: Annotation['group']): Annotation => ({ id, projectId: 'thesis', key: 'pdf', page: 0, rect: [0.1, 0.1, 0.4, 0.2], source: null, quote: `Text ${id}`, comment: group ? '' : 'Fix this typo.', ...(group ? { group } : {}), createdAt: 1 });
    const notes = [make('yellow-1', 'blue'), make('yellow-later', 'yellow'), make('green-1', 'green'), make('with-comment')];
    notes.forEach(note => f.store.saveAnnotation(note));
    const payload = { id: 'group-directions-001', projectId: 'thesis', title: 'Work on these passages', instructions: '', annotations: ['yellow-1', 'green-1', 'with-comment'] };
    for (const groupInstructions of [null, [], { yellow: 42 }, { yellow: 'x'.repeat(4001) }, { unknown: 'Explain' }, { yellow: 'Explain only one group' }, { yellow: 'Explain', green: 'Shorten', purple: 'Unselected group' }]) {
      const response = await f.remote.inject({ method: 'POST', url: '/api/tasks', headers: f.as, payload: { ...payload, groupInstructions } });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(f.store.annotations('thesis').filter(note => !note.taskId).length, 4);
    }
    const groupInstructions = { yellow: 'Explain the reasoning.\nKeep the notation.', green: 'Shorten this paragraph.' };
    const response = await f.remote.inject({ method: 'POST', url: '/api/tasks', headers: f.as, payload: { ...payload, groupInstructions } });
    assert.equal(response.statusCode, 200, response.body);
    const prompt = f.store.runByKey('initial-' + payload.id)!.prompt;
    assert.match(prompt, /Yellow:\n   Explain the reasoning\.\n   Keep the notation\./);
    assert.match(prompt, /Green:\n   Shorten this paragraph\./);
    assert.match(prompt, /Note: Fix this typo\./);
    assert.equal(prompt.match(/Explain the reasoning/g)?.length, 1);
    const item = f.store.items(payload.id)[0];
    assert.equal(item.text, '');
    assert.deepEqual(item.meta?.groupInstructions, groupInstructions);
    assert.deepEqual(item.meta?.notes?.map(note => [note.id, note.comment]), [['yellow-1', ''], ['green-1', ''], ['with-comment', 'Fix this typo.']]);
    assert.deepEqual(f.store.annotation('thesis', 'yellow-later'), notes[1]);
    assert.equal(f.store.annotation('thesis', 'yellow-1').comment, '');
    const retry = await f.remote.inject({ method: 'POST', url: '/api/tasks', headers: f.as, payload: { ...payload, groupInstructions } });
    assert.equal(retry.statusCode, 200); assert.equal(f.store.items(payload.id).length, 1);
  } finally { await f.close(); }
});

test('attachment uploads and downloads follow paper membership and keep unsent files private', async () => {
  const f = await fixture();
  try {
    const upload = { method: 'POST' as const, url: '/api/projects/thesis/attachments', payload: Buffer.from('x,y\n1,2'), headers: { ...f.as, 'content-type': 'application/octet-stream', 'x-papilot-filename': 'results.csv' } };
    assert.equal((await f.remote.inject({ ...upload, headers: { ...upload.headers, cookie: '' } })).statusCode, 401);
    assert.equal((await f.remote.inject({ ...upload, url: '/api/projects/grant/attachments' })).statusCode, 400);
    const uploaded = await f.remote.inject(upload);
    assert.equal(uploaded.statusCode, 200, uploaded.body);
    const file = uploaded.json(), url = `/api/projects/thesis/attachments/${file.id}`;
    assert.equal((await f.remote.inject({ url, headers: f.as })).statusCode, 200);
    assert.equal((await f.local.inject({ url, headers: LOCAL })).statusCode, 400, 'owner cannot see another person’s unsent upload');
    const sent = await f.remote.inject({ method: 'POST', url: '/api/tasks/thesis-task/messages', headers: f.as, payload: { text: 'Use this data.', requestKey: 'member-attachment', attachments: [file.id] } });
    assert.equal(sent.statusCode, 200, sent.body);
    assert.equal((await f.local.inject({ url, headers: LOCAL })).statusCode, 200);
    f.accounts.share(f.ada.id, []);
    assert.equal((await f.remote.inject({ url, headers: f.as })).statusCode, 400);
  } finally { await f.close(); }
});

test('the AI review skill uses normal task submission with paper access, CSRF and a current PDF', async () => {
  const f = await fixture();
  try {
    const inputs: Parameters<Workspace['createTask']>[0][] = [];
    f.manuscripts.state = async () => ({ git: { branch: 'main', upstream: null, ahead: 0, behind: 0, files: [], head: null }, build: { key: 'pdf', status: 'ready', current: true } });
    f.manuscripts.reviewSnapshot = async () => ({ key: 'pdf', lines: [{ id: 'p1-l1', page: 0, text: 'Claim', rect: [0, 0, 1, 1] }] });
    f.workspace.createTask = async input => {
      inputs.push(input);
      return f.store.saveTask({ ...task(input.id, input.projectId), mode: 'review', aiReview: { key: input.reviewInput!.key } });
    };
    const payload = { id: 'ai-review-request-1', projectId: 'thesis', skill: 'ai-review', title: 'AI review', instructions: '', agent: 'codex' };
    const send = (body = payload, headers = f.as) => f.remote.inject({ method: 'POST', url: '/api/tasks', headers, payload: body });
    assert.equal((await send(payload, { ...f.as, 'x-papilot-token': '' })).statusCode, 403);
    const denied = await send({ ...payload, projectId: 'grant' }), missing = await send({ ...payload, projectId: 'missing' });
    assert.equal(denied.statusCode, 400);
    assert.equal(denied.body, missing.body);
    const ready = f.manuscripts.state;
    f.manuscripts.state = async () => ({ ...(await ready('thesis', '/unused')), build: { status: 'building', current: false } });
    assert.equal((await send()).statusCode, 400);
    f.manuscripts.state = ready;
    assert.equal(inputs.length, 0);
    assert.equal((await send()).statusCode, 200);
    assert.equal(inputs[0].author?.name, 'Ada');
    assert.equal(inputs[0].reviewInput?.lines[0].text, 'Claim');
    assert.equal(inputs[0].skill, 'ai-review');
    f.manuscripts.state = async () => { throw new Error('The PDF has changed since submission.'); };
    assert.equal((await send()).statusCode, 200, 'A retry uses the existing review even after rebuilding');
    assert.equal(inputs.length, 1);
  } finally { await f.close(); }
});

test('AI review findings stay in their task and copy individually, once, into the manuscript', async () => {
  const f = await fixture();
  try {
    const pdf = path.resolve('tests/fixtures/outline.pdf'), originalPdf = fs.readFileSync(pdf);
    f.store.updateTask('thesis-task', { mode: 'review', aiReview: { key: 'review-pdf' } });
    f.store.saveReviewInput('thesis-task', { key: 'review-pdf', pdf, lines: [] });
    const note = { id: 'finding-1', projectId: 'thesis', key: 'review-pdf', page: 0, rect: [0.1, 0.2, 0.5, 0.3] as [number, number, number, number], comment: 'Explain this claim.', quote: 'Claim', source: null, createdAt: 1, aiReview: { taskId: 'thesis-task', agent: 'codex' as const } };
    f.store.saveAnnotation(note);
    f.store.saveAnnotation({ ...note, id: 'finding-2', comment: 'A different suggestion.' });
    f.store.saveAnnotation({ ...note, id: 'personal', aiReview: undefined });
    f.store.saveAnnotation({ ...note, id: 'other-task', aiReview: { taskId: 'another-review', agent: 'claude' } });
    f.manuscripts.state = async () => ({ git: { branch: 'main', upstream: null, ahead: 0, behind: 0, files: [], head: null }, build: { key: 'current-pdf', status: 'ready', current: true } });
    f.manuscripts.reanchor = async (_id, _root, notes) => notes;
    let placeFails = false;
    f.manuscripts.placeReviewNote = async (_id, _root, selected, source) => {
      assert.equal(source, pdf);
      if (placeFails) throw new Error('This passage could not be located reliably.');
      return { ...selected, key: 'current-pdf', page: 1, source: { file: 'main.tex', lines: [20, 21] } };
    };
    const get = (url: string) => f.remote.inject({ url, headers: f.as });
    const post = (url: string) => f.remote.inject({ method: 'POST', url, headers: f.as, payload: {} });
    const base = '/api/tasks/thesis-task/ai-review';
    assert.deepEqual((await get('/api/projects/thesis/manuscript')).json().annotations.map((n: any) => n.id), ['personal']);
    assert.deepEqual((await get(base)).json().notes.map((n: any) => n.id), ['finding-1', 'finding-2']);
    assert.deepEqual((await get(base + '/pdf')).rawPayload, originalPdf);
    assert.ok((await get(base + '/words?page=0')).json().words.length > 0);
    assert.equal((await get('/api/tasks/grant-task/ai-review')).statusCode, 400);
    assert.equal((await post(base + '/other-task/copy')).statusCode, 400);
    assert.equal((await f.remote.inject({ method: 'POST', url: base + '/finding-1/copy', headers: { ...f.as, 'x-papilot-token': '' }, payload: {} })).statusCode, 403);
    assert.equal((await post('/api/projects/thesis/annotations/finding-1/delete')).statusCode, 400);
    const [first, retry] = await Promise.all([post(base + '/finding-1/copy'), post(base + '/finding-1/copy')]);
    assert.equal(first.statusCode, 200, first.body); assert.equal(retry.statusCode, 200, retry.body);
    const copy = first.json().copy;
    assert.equal(copy.id, retry.json().copy.id);
    assert.equal(f.store.task('thesis-task').aiReview?.revision, 1, 'copy changes the review revision only once, even with concurrent retries');
    assert.equal(copy.aiReview.sourceId, 'finding-1'); assert.equal(copy.comment, note.comment);
    assert.equal(copy.key, 'current-pdf'); assert.equal(copy.page, 1);
    assert.deepEqual((await get('/api/projects/thesis/manuscript')).json().annotations.map((n: any) => n.id), ['personal', copy.id]);
    assert.equal(f.store.annotation('thesis', note.id).key, 'review-pdf');
    assert.equal(f.store.annotation('thesis', note.id).page, 0);
    assert.equal((await get(base)).json().notes[0].aiReview.copiedTo, copy.id);
    placeFails = true;
    assert.equal((await post(base + '/finding-2/copy')).statusCode, 400);
    assert.equal(f.store.task('thesis-task').aiReview?.revision, 1, 'failed copies do not announce an annotation change');
    assert.equal(f.store.annotations('thesis').length, 5);
    assert.equal(f.store.annotation('thesis', 'finding-2').aiReview?.copiedTo, undefined);
    assert.equal((await post(base + '/finding-1/delete')).statusCode, 200);
    assert.equal(f.store.task('thesis-task').aiReview?.revision, 2);
    assert.equal((await get(base)).json().notes.length, 1);
    assert.equal((await get('/api/projects/thesis/manuscript')).json().annotations.length, 2);
    assert.equal((await post(base + '/finding-1/restore')).statusCode, 200);
    assert.equal(f.store.task('thesis-task').aiReview?.revision, 3);
    assert.deepEqual((await get(base + '/pdf')).rawPayload, originalPdf, 'review PDF never follows a main-manuscript rebuild');
    assert.deepEqual(fs.readFileSync(pdf), originalPdf);
    f.store.deleteTask('thesis-task');
    assert.equal((await get('/api/projects/thesis/manuscript')).json().annotations.length, 2, 'copied notes survive task deletion');
  } finally { await f.close(); }
});

test('changing a relocated paper path recovers its preserved review PDF without a build cache', async () => {
  const f = await fixture(), base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-review-move-')));
  const root = path.join(base, 'paper'), moved = path.join(base, 'moved-paper'), worktree = path.join(base, 'task');
  const git = (folder: string, ...args: string[]) => execFileSync('git', ['-C', folder, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}Paper\\end{document}\n');
    git(root, 'init', '-q'); git(root, 'add', '.');
    git(root, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'Paper');
    git(root, 'worktree', 'add', '--detach', worktree, 'HEAD');
    const original = fs.readFileSync('tests/fixtures/outline.pdf');
    const pdf = await f.manuscripts.preserveReviewPdf(root, 'thesis-task', path.resolve('tests/fixtures/outline.pdf'));
    const key = createHash('sha256').update(original).digest('hex').slice(0, 16);
    f.store.saveProject({ ...f.store.project('thesis'), path: root });
    f.store.updateTask('thesis-task', { mode: 'review', status: 'reviewing', worktree, aiReview: { key } });
    f.store.saveReviewInput('thesis-task', { key, pdf, lines: [] });
    f.store.saveAnnotation({ id: 'finding', projectId: 'thesis', key, page: 0, rect: [0.1, 0.1, 0.8, 0.2], quote: 'Claim', comment: 'Explain this claim.', source: null, createdAt: 1, aiReview: { taskId: 'thesis-task', agent: 'codex' } });
    const reviewBase = '/api/tasks/thesis-task/ai-review';
    const get = (suffix = '') => f.remote.inject({ url: reviewBase + suffix, headers: f.as });
    assert.equal((await get()).statusCode, 200);
    fs.renameSync(root, moved); git(moved, 'worktree', 'repair', worktree);
    f.review.get = async () => ({ task: f.store.task('thesis-task').name, worktree }) as any;
    const changed = await f.local.inject({ method: 'POST', url: '/api/projects/thesis/path', headers: { ...LOCAL, 'x-papilot-token': 'local-csrf' }, payload: { path: moved } });
    assert.equal(changed.statusCode, 200, changed.body);
    const relocated = path.join(moved, path.relative(root, pdf));
    assert.equal(fs.existsSync(pdf), false);
    assert.deepEqual(fs.readFileSync(relocated), original);
    assert.equal(await f.manuscripts.cachedPdf(moved, key), null);
    const recovered = await get();
    assert.equal(recovered.statusCode, 200, recovered.body);
    assert.equal(recovered.json().key, key);
    assert.equal(recovered.json().notes[0].comment, 'Explain this claim.');
    assert.equal(f.store.reviewInput('thesis-task').pdf, relocated);
    assert.deepEqual((await get('/pdf')).rawPayload, original);
    assert.ok((await get('/words?page=0')).json().words.length > 0);
    assert.equal(await new Manuscripts().savedReviewPdf(moved, 'thesis-task'), relocated);
    f.manuscripts.placeReviewNote = async (_id, target, note, source) => {
      assert.equal(target, moved); assert.equal(source, relocated);
      return { ...note, key: 'current-main' };
    };
    const copied = await f.remote.inject({ method: 'POST', url: reviewBase + '/finding/copy', headers: f.as, payload: {} });
    assert.equal(copied.statusCode, 200, copied.body);
    assert.equal(copied.json().copy.aiReview.sourceId, 'finding');
    fs.unlinkSync(relocated);
    const missing = await get();
    assert.equal(missing.statusCode, 400);
    assert.match(missing.json().error, /PDF copy.*unavailable/);
  } finally { await f.close(); fs.rmSync(base, { recursive: true, force: true }); }
});
