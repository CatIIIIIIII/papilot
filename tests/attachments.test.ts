import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/server/store.ts';
import { Workspace } from '../src/server/workspace.ts';
import { Accounts } from '../src/server/accounts.ts';
import { Manuscripts } from '../src/server/manuscript.ts';
import { buildApp, gitQueue } from '../src/server/app.ts';
import { attachmentIds } from '../src/server/attachments.ts';
import { ClaudeAgent } from '../src/server/agents.ts';
import { MAX_ATTACHMENT_BYTES, MAX_IMAGE_BYTES, type Task } from '../src/shared.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const headers = { host: '127.0.0.1:7274', origin: 'http://127.0.0.1:7274', 'x-papilot-token': 'csrf' };
class Agent extends EventEmitter {
  ready = false;
  calls: { method: string; params: any }[] = [];
  async request(method: string, params: any) { this.calls.push({ method, params }); return method === 'turn/start' ? { turn: { id: 'turn' } } : { thread: { id: 'thread' } }; }
  start = async () => {}; respond() {} reject() {} close() {}
}
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-files-test-'));
  const store = new Store(path.join(dir, 'state.sqlite')), agent = new Agent();
  const review = { url: 'http://unused', token: '', get: async () => ({ cursor: 0, feedback: [] }) as any, post: async () => ({ worktree: dir }) as any };
  const workspace = new Workspace(store, agent, async () => review, { claude: new Agent(), antigravity: new Agent() });
  const project = { id: 'paper', path: dir, name: 'Paper', createdAt: 1 };
  store.saveProject(project); store.saveProject({ ...project, id: 'other', path: path.join(dir, 'other') });
  const task: Task = { id: 'task-attachments-1', projectId: 'paper', name: 'p-test', title: 'Task', titleSource: 'manual', instructions: 'Edit.', worktree: dir, threadId: null, turnId: null, model: null, status: 'reviewing', createdAt: 1, updatedAt: 1, feedbackCursor: 0, error: null, review: null };
  store.saveTask(task);
  const accounts = new Accounts(store, '');
  const app = await buildApp({ listener: { kind: 'local', port: 7274, publicOrigin: '', owner: '' }, store, workspace, manuscripts: new Manuscripts(), accounts, csrf: 'csrf', serialGit: gitQueue(), dist: null, version: 'test', connectReview: async () => review });
  const upload = (name: string, payload: Buffer, extra = {}) => app.inject({ method: 'POST', url: '/api/projects/paper/attachments', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-papilot-filename': encodeURIComponent(name), ...extra }, payload });
  return { dir, store, agent, workspace, app, upload, task, async close() { await app.close(); workspace.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('binary uploads enforce CSRF, body limits and safe downloads, and retain Unicode names', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.upload('secret.png', PNG, { 'x-papilot-token': 'wrong' })).statusCode, 403);
    assert.equal((await f.upload('empty', Buffer.alloc(0))).statusCode, 400);
    assert.equal((await f.upload('huge.bin', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))).statusCode, 413);
    assert.equal((await f.upload('huge.png', Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]))).statusCode, 400);
    const response = await f.upload('../../公式.png', PNG);
    assert.equal(response.statusCode, 200, response.body);
    const file = response.json();
    assert.equal(file.name, '公式.png'); assert.equal(file.mime, 'image/png'); assert.equal(file.size, PNG.length);
    const read = await f.app.inject({ url: `/api/projects/paper/attachments/${file.id}`, headers });
    assert.equal(read.statusCode, 200); assert.deepEqual(read.rawPayload, PNG);
    assert.match(String(read.headers['content-disposition']), /^inline;.*UTF-8''/);
    assert.equal(read.headers['x-content-type-options'], 'nosniff');
    assert.equal((await f.app.inject({ url: `/api/projects/other/attachments/${file.id}`, headers })).statusCode, 400);
    const duplicate = (await f.upload('公式.png', Buffer.concat([PNG, Buffer.from('second')]))).json();
    assert.notEqual(file.id, duplicate.id); assert.deepEqual(fs.readFileSync(f.workspace.attachments.path(file)), PNG);
    const html = (await f.upload('fake.png', Buffer.from('<html><script>alert(1)</script></html>'))).json();
    const download = await f.app.inject({ url: `/api/projects/paper/attachments/${html.id}`, headers });
    assert.equal(html.mime, 'application/octet-stream'); assert.match(String(download.headers['content-disposition']), /^attachment;/);
    assert.match(String(download.headers['content-security-policy']), /sandbox/);
  } finally { await f.close(); }
});

test('draft files are private, become visible with a message, survive restart, and reach Codex as images', async () => {
  const f = await fixture();
  try {
    const image = await f.workspace.attachments.upload('paper', 'ada', 'figure.png', PNG);
    const data = await f.workspace.attachments.upload('paper', 'ada', 'results.csv', Buffer.from('x,y\n1,2'));
    assert.throws(() => f.workspace.attachments.get('paper', image.id, 'bob'), /not found/);
    await assert.rejects(f.workspace.enqueue(f.task.id, 'Use these.', 'wrong-person', false, { attachments: [image.id], author: { id: 'bob', name: 'Bob' } }), /not available/);
    const run = await f.workspace.enqueue(f.task.id, 'Update the results.', 'files-request', false, { attachments: [image.id, data.id], author: { id: 'ada', name: 'Ada' } });
    assert.deepEqual(run.attachments, [image, data]);
    assert.match(run.prompt, /results.csv/); assert.ok(run.prompt.includes(f.workspace.attachments.path(data)));
    assert.deepEqual(f.store.items(f.task.id)[0].meta?.attachments, [image, data]);
    assert.equal(f.workspace.attachments.get('paper', image.id, 'bob').id, image.id);
    assert.throws(() => f.workspace.attachments.resolve('paper', [image.id], 'ada', 'another-task'), /not available/);
    f.workspace.attachments.discard('paper', image.id, 'ada');
    assert.equal(fs.existsSync(f.workspace.attachments.path(image)), true, 'late draft removal preserves a sent file');
    const reopened = new Store(path.join(f.dir, 'state.sqlite'));
    assert.deepEqual(reopened.runs()[0].attachments, [image, data]); reopened.close();
    f.agent.ready = true; f.workspace.runtime.authenticated = true;
    await f.workspace.enqueue(f.task.id, 'Update the results.', 'files-request', false, { attachments: [image.id, data.id], author: { id: 'ada', name: 'Ada' } });
    for (let i = 0; i < 40 && !f.agent.calls.some(call => call.method === 'turn/start'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    const input = f.agent.calls.find(call => call.method === 'turn/start')?.params.input;
    assert.equal(input[0].text, run.prompt);
    assert.deepEqual(input[1], { type: 'localImage', path: f.workspace.attachments.path(image) });
    assert.equal(input.length, 2);
    assert.equal(f.store.runs().length, 1, 'retry did not duplicate the message');
  } finally { await f.close(); }
});

test('new tasks and follow-ups can contain only files; unknown or cross-paper files cannot start work', async () => {
  const f = await fixture();
  try {
    const file = (await f.upload('reference.pdf', Buffer.from('%PDF-test'))).json();
    const body = { id: 'new-task-attachments-1', projectId: 'other', title: 'Reference', instructions: '', attachments: [file.id] };
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/tasks', headers, payload: body })).statusCode, 400);
    assert.equal(f.store.tasks().length, 1);
    const result = await f.app.inject({ method: 'POST', url: '/api/tasks', headers, payload: { ...body, projectId: 'paper' } });
    assert.equal(result.statusCode, 200, result.body);
    assert.match(f.store.runs()[0].prompt, /Do not change the manuscript yet/);
    const another = (await f.upload('values.csv', Buffer.from('x,y\n1,2'))).json();
    const message = { text: '', requestKey: 'follow-up-file', attachments: [another.id] };
    const sent = await f.app.inject({ method: 'POST', url: `/api/tasks/${f.task.id}/messages`, headers, payload: message });
    assert.equal(sent.statusCode, 200, sent.body);
    assert.deepEqual(f.store.items(f.task.id)[0].meta?.attachments, [another]);
    assert.throws(() => attachmentIds([file.id, file.id]), /valid attachments/);
    assert.throws(() => attachmentIds(Array(11).fill(file.id)), /valid attachments/);
    assert.throws(() => attachmentIds(['../../outside']), /valid attachments/);
  } finally { await f.close(); }
});

test('Claude receives structured image bytes with text instead of losing non-text input', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-claude-image-')), file = path.join(dir, 'image.png');
  fs.writeFileSync(file, PNG);
  const messages: any[] = [];
  const query = ({ prompt }: any) => (async function* () {
    for await (const message of prompt) messages.push(message);
    yield { type: 'result', subtype: 'success', is_error: false, session_id: 'thread' };
  })();
  const agent = new ClaudeAgent(async () => query as any, () => null);
  try {
    await agent.request('thread/start', { cwd: dir });
    const { thread } = await agent.request('thread/start', { cwd: dir });
    const done = new Promise<void>(resolve => agent.on('notification', event => { if (event.method === 'turn/completed') resolve(); }));
    await agent.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Explain this figure.' }, { type: 'localImage', path: file }] });
    await done;
    assert.equal(messages[0].message.content[0].text.trim(), 'Explain this figure.');
    assert.deepEqual(messages[0].message.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } });
  } finally { agent.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
