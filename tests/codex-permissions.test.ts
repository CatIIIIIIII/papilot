import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Codex } from '../src/server/codex.ts';
import { Store } from '../src/server/store.ts';
import { Workspace } from '../src/server/workspace.ts';
import { taskAccessInstructions } from '../src/server/task-permissions.ts';
import type { Task } from '../src/shared.ts';

// The real app-server from the @openai/codex dev dependency. The model
// endpoint is local and canned: no credentials, external API requests or
// model charges are needed.
const CODEX = path.join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'codex.cmd' : 'codex');
for (const history of ['new', 'legacy-loaded', 'legacy-restarted'] as const)
for (const initial of ['workspace', 'full'] as const) test(`real Codex switches permissions with ${history} history starting with ${initial}`,
  // Codex resolves workspace-write to read-only on Windows (Papilot then refuses
  // to start); see the workspace permission handling in src/server/codex.ts.
  { skip: process.platform === 'win32' && 'Codex has no workspace-write sandbox on Windows', timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-native-permissions-'));
  const cwd = path.join(dir, 'paper'), extra = path.join(dir, 'extra'), home = path.join(dir, 'home');
  for (const item of [cwd, extra, home]) fs.mkdirSync(item);
  const modelRequests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    modelRequests.push(JSON.parse(body));
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
  const codex = new Codex(CODEX, args, { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, TMPDIR: os.tmpdir() });
  const store = new Store(':memory:');
  const workspace = new Workspace(store, codex);
  const task: Task = { id: 'permission-task', projectId: 'paper', agent: 'codex', name: 'p-task', title: 'Edit', instructions: 'Edit the manuscript and an external experiment script when authorized.', worktree: cwd, threadId: null, turnId: null, model: null, status: 'idle', createdAt: 1, updatedAt: 1, feedbackCursor: 0, error: null, review: null };
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
    const first = await codex.taskPermissionConfig(initial, cwd);
    const developerInstructions = (workspace as any).instructions({ ...task, permissions: initial });
    const legacyAccess = initial === 'workspace' ? 'Only edit this isolated task worktree.'
      : 'The user selected full access. You may run authorized commands including SSH and access files outside this worktree. Keep manuscript edits in this isolated task worktree.';
    const { thread } = await codex.request('thread/start', { cwd, ...first.thread,
      developerInstructions: history === 'new' ? developerInstructions : developerInstructions.replace(taskAccessInstructions, legacyAccess) });
    if (history !== 'new') {
      // Seed a pre-upgrade turn without the new application context.
      const { additionalContext: _, ...policy } = first.turn;
      const legacy = await codex.request('turn/start', { threadId: thread.id, cwd, ...policy, input: [{ type: 'text', text: 'Remember the original experiment request. Say Done.' }] });
      await finish(legacy.turn.id);
      if (history === 'legacy-restarted') {
        const closed = once(codex.child!, 'close');
        codex.close(); await closed; await codex.start();
      }
      await codex.request('thread/resume', { threadId: thread.id, cwd, ...first.thread, developerInstructions });
    }
    for (const permissions of [initial, initial === 'full' ? 'workspace' : 'full', initial] as const) {
      const config = await codex.taskPermissionConfig(permissions, cwd);
      // Preserve the loaded conversation; native turn settings carry both the
      // effective permissions and the current application instructions.
      const started = await codex.request('turn/start', { threadId: thread.id, cwd, ...config.turn, input: [{ type: 'text', text: 'Say Done.' }] });
      await finish(started.turn.id);
      const effective = await codex.request('thread/resume', { threadId: thread.id, excludeTurns: true });
      assert.equal(effective.thread.id, thread.id);
      assert.equal(effective.sandbox.type, permissions === 'full' ? 'dangerFullAccess' : 'workspaceWrite');
      assert.equal(effective.approvalPolicy, permissions === 'full' ? 'never' : 'on-request');
      if (permissions === 'workspace') {
        assert.equal(effective.sandbox.networkAccess, true);
        assert.equal(effective.sandbox.excludeTmpdirEnvVar, true);
        assert.equal(effective.sandbox.excludeSlashTmp, true);
        assert.ok(effective.sandbox.writableRoots.includes(extra));
      }
      const sent = JSON.stringify(modelRequests.at(-1));
      assert.match(sent, /Keep manuscript edits in this isolated task worktree/);
      assert.match(sent, /runtime's current sandbox and approval requirements/);
      assert.match(sent, /Never edit the manuscript checkout, other task worktrees, or Papilot's own source\/state/);
      const input: any[] = modelRequests.at(-1).input;
      const update = input.findLastIndex(item => item.role === 'developer' && JSON.stringify(item).includes('<papilot-task-access>'));
      assert.ok(update >= 0, 'current access instructions must have developer authority');
      assert.match(JSON.stringify(input[update]), /replace earlier Papilot instructions about access outside the task worktree/);
      assert.match(JSON.stringify(input[update]), /manuscript review scope and protected-path rules still apply/);
      if (history === 'new') assert.doesNotMatch(sent, /Only edit this isolated task worktree|The user selected full access/);
      else {
        const legacy = input.findIndex(item => item.role === 'developer' && JSON.stringify(item).includes(legacyAccess));
        assert.ok(legacy >= 0 && update > legacy, 'current developer instructions must supersede the preserved legacy restriction');
        assert.match(sent, /Remember the original experiment request/, 'migration must preserve conversation history');
      }
    }
  } finally {
    // Wait for Codex to stop writing its state before removing the fixture.
    const closed = codex.child ? once(codex.child, 'close') : Promise.resolve();
    workspace.close(); await closed; store.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
