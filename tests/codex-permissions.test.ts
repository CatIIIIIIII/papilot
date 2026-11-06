import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { Codex } from '../src/server/codex.ts';

// Opt in with a real app-server binary. The model endpoint is local and canned:
// no credentials, external API requests or model charges are needed.
test('real Codex applies Full → Workspace to an already-loaded conversation', { skip: !process.env.PAPILOT_CODEX_TEST_BIN, timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-native-permissions-'));
  const cwd = path.join(dir, 'paper'), extra = path.join(dir, 'extra'), home = path.join(dir, 'home');
  for (const item of [cwd, extra, home]) fs.mkdirSync(item);
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const message = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.', annotations: [] }] };
    const response = { id: 'resp_fixture', object: 'response', status: 'completed', output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    for (const event of [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: 'Done.' },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const args = ['app-server', '--listen', 'stdio://'];
  for (const setting of ['model="fixture"', 'model_provider="fixture"', 'model_providers.fixture.name="Fixture"', `model_providers.fixture.base_url="http://127.0.0.1:${port}/v1"`, 'model_providers.fixture.wire_api="responses"', 'model_providers.fixture.requires_openai_auth=false', `sandbox_workspace_write.writable_roots=[${JSON.stringify(extra)}]`, 'sandbox_workspace_write.exclude_tmpdir_env_var=true', 'sandbox_workspace_write.exclude_slash_tmp=true']) args.push('-c', setting);
  const codex = new Codex(process.env.PAPILOT_CODEX_TEST_BIN!, args, { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, TMPDIR: os.tmpdir() });
  const events: any[] = [];
  codex.on('notification', event => events.push(event));
  const finish = async (id: string) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const done = events.find(event => event.method === 'turn/completed' && event.params.turn.id === id);
      if (done) { assert.equal(done.params.turn.status, 'completed', JSON.stringify(done)); return; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(`Turn did not finish: ${codex.stderr}`);
  };
  try {
    await codex.start();
    const full = await codex.taskPermissionConfig('full', cwd);
    const { thread } = await codex.request('thread/start', { cwd, ...full.thread });
    const first = await codex.request('turn/start', { threadId: thread.id, cwd, ...full.turn, input: [{ type: 'text', text: 'Say Done.' }] });
    await finish(first.turn.id);
    const stale = await codex.request('thread/resume', { threadId: thread.id, cwd, sandbox: 'workspace-write', approvalPolicy: 'on-request', excludeTurns: true });
    // Do not depend on the old bug remaining in future releases; the next turn
    // must revoke access whether resume already fixed it or still retains full.
    assert.ok(['dangerFullAccess', 'workspaceWrite'].includes(stale.sandbox.type));
    const workspace = await codex.taskPermissionConfig('workspace', cwd);
    const second = await codex.request('turn/start', { threadId: thread.id, cwd, ...workspace.turn, input: [{ type: 'text', text: 'Say Done again.' }] });
    await finish(second.turn.id);
    const effective = await codex.request('thread/resume', { threadId: thread.id, excludeTurns: true });
    assert.equal(effective.thread.id, thread.id);
    assert.equal(effective.sandbox.type, 'workspaceWrite');
    assert.equal(effective.approvalPolicy, 'on-request');
    assert.equal(effective.sandbox.networkAccess, true);
    assert.equal(effective.sandbox.excludeTmpdirEnvVar, true);
    assert.equal(effective.sandbox.excludeSlashTmp, true);
    assert.ok(effective.sandbox.writableRoots.includes(extra));
    console.log(`Native resume before turn override: ${stale.sandbox.type}/${stale.approvalPolicy}; after: ${effective.sandbox.type}/${effective.approvalPolicy}`);
    const third = await codex.request('turn/start', { threadId: thread.id, cwd, ...full.turn, input: [{ type: 'text', text: 'Say Done.' }] });
    await finish(third.turn.id);
    const upgraded = await codex.request('thread/resume', { threadId: thread.id, excludeTurns: true });
    assert.equal(upgraded.sandbox.type, 'dangerFullAccess');
    assert.equal(upgraded.approvalPolicy, 'never');
  } finally { codex.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Codex refuses a workspace policy resolver that retains full access and cleans up its probe', async () => {
  const codex = new Codex();
  const calls: string[] = [];
  codex.request = async method => {
    calls.push(method);
    return { thread: { id: 'probe' }, sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'never' };
  };
  await assert.rejects(codex.taskPermissionConfig('workspace', '/work'), /could not apply workspace permissions/);
  assert.deepEqual(calls, ['thread/start', 'thread/unsubscribe']);
});
