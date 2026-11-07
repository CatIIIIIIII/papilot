import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACP_PROFILES, AcpAgent, KimiAgent, opencodeConfig } from '../src/server/acp.ts';
import { GrokAgent } from '../src/server/grok.ts';
import { RpcResponseError } from '../src/server/codex.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const configOptions = [
  { id: 'model', category: 'model', currentValue: 'kimi/k3', options: [{ value: 'kimi/k3', name: 'K3' }, { value: 'kimi/k2', name: 'K2' }] },
  { id: 'thinking', category: 'thought_level', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
];
function fixture(onPrompt: (message: any, rpc: ReturnType<typeof peer>) => void = (m, rpc) => { rpc.update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } }); rpc.reply(m.id, { stopReason: 'end_turn' }); }) {
  const calls: any[] = [], peers: ReturnType<typeof peer>[] = [];
  const launch = (_binary: string, args: string[], options: { cwd: string }) => {
    assert.deepEqual(args, ['acp']);
    assert.equal(options.cwd, os.homedir(), 'Kimi must not run from the probe folder that is removed');
    const rpc = peer(message => {
      calls.push(message);
      if (!message.method) return;
      const { id, method, params } = message;
      if (method === 'initialize') rpc.reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { delete: {} } } });
      else if (method === 'session/new' || method === 'session/load') {
        if (method === 'session/load') rpc.update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Historical reply' } });
        rpc.reply(id, { sessionId: params.sessionId || `session-${++serial}`, configOptions, modes: { availableModes: [{ id: 'default' }] } });
      } else if (method === 'session/set_config_option') rpc.reply(id, { configOptions });
      else if (method === 'session/prompt') onPrompt(message, rpc);
      else if (id !== undefined) rpc.reply(id, {});
    });
    peers.push(rpc); return rpc.child;
  };
  let serial = 0;
  const agent = new KimiAgent('fake-kimi', launch as any);
  const notifications: any[] = [], requests: any[] = [];
  agent.on('notification', message => notifications.push(message));
  agent.on('request', message => requests.push(message));
  return { agent, calls, peers, notifications, requests };
}
function peer(receive: (message: any) => void) {
  const child: any = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { setImmediate(() => child.emit('close', 0)); return true; };
  let buffer = '';
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) { const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); setImmediate(() => receive(message)); }
  });
  const send = (message: any) => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  return { child, send, reply: (id: number, result: any) => send({ id, result }), update: (sessionId: string, update: any) => send({ method: 'session/update', params: { sessionId, update } }) };
}
function completion(agent: KimiAgent) {
  return new Promise<any>(resolve => {
    const listener = (message: any) => { if (message.method === 'turn/completed') { agent.off('notification', listener); resolve(message.params.turn); } };
    agent.on('notification', listener);
  });
}
async function thread(agent: KimiAgent) { return (await agent.request('thread/start', { cwd: '/paper', model: 'kimi/k3', developerInstructions: 'Only edit this paper.' })).thread.id as string; }
async function run(agent: KimiAgent, id: string, extra: any = {}) {
  const done = completion(agent);
  await agent.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'Fix it.' }], ...extra });
  return done;
}

test('Kimi discovers configuration without a prompt and streams text, tools and native images', { timeout: 5000 }, async () => {
  const f = fixture((m, rpc) => {
    const id = m.params.sessionId;
    rpc.update(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking ' } });
    rpc.update(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'now.' } });
    rpc.update(id, { sessionUpdate: 'tool_call', toolCallId: 'shell', kind: 'execute', title: 'Run check', rawInput: { command: 'latexmk main.tex' }, status: 'in_progress' });
    rpc.update(id, { sessionUpdate: 'tool_call_update', toolCallId: 'shell', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Build passed' } }] });
    rpc.update(id, { sessionUpdate: 'tool_call', toolCallId: 'edit', kind: 'edit', status: 'completed', content: [{ type: 'diff', path: '/paper/main.tex', oldText: 'a', newText: 'b' }] });
    rpc.update(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
    rpc.reply(m.id, { stopReason: 'end_turn' });
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-kimi-test-'));
  const file = path.join(dir, 'image.png');
  fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  try {
    await Promise.all([f.agent.start(), f.agent.start()]);
    assert.equal(f.peers.length, 1);
    assert.equal(f.calls.some(call => call.method === 'session/prompt'), false);
    assert.ok(f.calls.some(call => call.method === 'session/delete'));
    assert.equal((await f.agent.request('account/read')).requiresOpenaiAuth, false);
    const models = (await f.agent.request('model/list')).data;
    assert.deepEqual(models.map((m: any) => [m.model, m.isDefault]), [['kimi/k3', true], ['kimi/k2', false]]);
    assert.deepEqual(models[0].supportedReasoningEfforts, [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }]);
    const id = await thread(f.agent);
    const result = await run(f.agent, id, { effort: 'low', clientUserMessageId: 'user-1', input: [{ type: 'text', text: 'Fix it.' }, { type: 'localImage', path: file }] });
    assert.equal(result.status, 'completed');
    const prompt = f.calls.find(call => call.method === 'session/prompt').params;
    assert.equal(prompt.prompt[0].text.trim(), 'Only edit this paper.\n\n---\n\nFix it.');
    assert.equal(prompt.prompt[1].mimeType, 'image/png');
    assert.equal(prompt.prompt[1].data, fs.readFileSync(file).toString('base64'));
    assert.ok(f.calls.some(call => call.method === 'session/set_mode' && call.params.modeId === 'default'));
    assert.ok(f.calls.some(call => call.method === 'session/set_config_option' && call.params.value === 'low'));
    const items = f.notifications.filter(n => n.method === 'item/completed').map(n => n.params.item);
    assert.deepEqual(items.map(item => item.type), ['agentMessage', 'commandExecution', 'fileChange', 'agentMessage']);
    assert.equal(items[0].text, 'Checking now.');
    assert.equal(items[1].command, 'latexmk main.tex');
    assert.equal(items[1].aggregatedOutput, 'Build passed');
    assert.deepEqual(items[2].changes, [{ path: '/paper/main.tex' }]);
    assert.equal((await f.agent.request('thread/read', { threadId: id })).thread.turns[0].items[0].clientId, 'user-1');
    await run(f.agent, id);
    assert.equal(f.calls.filter(call => call.method === 'session/prompt')[1].params.prompt[0].text, 'Fix it.');
  } finally { f.agent.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Kimi resumes persisted IDs after restart and ignores replayed history', { timeout: 5000 }, async () => {
  const f = fixture();
  try {
    await f.agent.start(); const id = await thread(f.agent); await run(f.agent, id);
    f.agent.close(); await f.agent.start();
    await f.agent.request('thread/resume', { threadId: id, cwd: '/paper', developerInstructions: 'Only edit this paper.' });
    await run(f.agent, id);
    assert.ok(f.calls.some(call => call.method === 'session/load' && call.params.sessionId === id));
    assert.equal(f.notifications.some(n => n.params.delta === 'Historical reply'), false);
    assert.equal(f.calls.filter(call => call.method === 'session/prompt').at(-1).params.prompt[0].text, 'Fix it.');
    // Workspace can still consider an idle thread loaded after the process exits.
    f.agent.close(); await f.agent.start(); await run(f.agent, id);
    assert.equal(f.calls.filter(call => call.method === 'session/load').length, 2);
    assert.equal(f.notifications.some(n => n.params.delta === 'Historical reply'), false);
  } finally { f.agent.close(); }
});

test('Kimi changes model and effort on the same session for the next turn', { timeout: 5000 }, async () => {
  const f = fixture();
  try {
    await f.agent.start(); const id = await thread(f.agent);
    await run(f.agent, id, { effort: 'high' });
    await run(f.agent, id, { effort: 'low' });
    await run(f.agent, id);
    assert.equal(f.calls.filter(call => call.method === 'session/set_config_option' && call.params.configId === 'thinking').at(-1).params.value, 'high', 'model default clears the previous low override');
    const before = f.calls.length;
    assert.equal((await run(f.agent, id, { model: 'kimi/k2', effort: 'low' })).status, 'completed');
    const calls = f.calls.slice(before);
    assert.deepEqual(calls.filter(call => call.method === 'session/set_config_option').map(call => [call.params.sessionId, call.params.configId, call.params.value]), [[id, 'model', 'kimi/k2'], [id, 'thinking', 'low']]);
    assert.equal(calls.find(call => call.method === 'session/prompt').params.prompt[0].text, 'Fix it.');
    assert.ok(!calls.some(call => ['session/new', 'session/load'].includes(call.method)));
  } finally { f.agent.close(); }
});

test('Kimi forwards approvals and only selects one-time grants or denials', { timeout: 5000 }, async () => {
  for (const decision of ['accept', 'decline', 'cancel']) {
    const f = fixture((m, rpc) => {
      rpc.send({ id: 'permission', method: 'session/request_permission', params: { sessionId: m.params.sessionId, toolCall: { title: 'Edit main.tex', kind: 'edit' }, options: [{ optionId: 'always', kind: 'allow_always' }, { optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] } });
    });
    try {
      await f.agent.start(); const id = await thread(f.agent);
      const done = completion(f.agent);
      const requested = new Promise<void>(resolve => f.agent.once('request', m => { f.agent.respond(m.id, { decision }); resolve(); }));
      await f.agent.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'Edit.' }] });
      await requested; await tick();
      const reply = f.calls.find(call => call.id === 'permission' && !call.method);
      assert.deepEqual(reply.result.outcome, decision === 'cancel' ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: decision === 'accept' ? 'yes' : 'no' });
      assert.equal(f.requests[0].method, 'item/fileChange/requestApproval');
      f.peers[0].reply(f.calls.find(call => call.method === 'session/prompt').id, { stopReason: 'cancelled' });
      assert.equal((await done).status, 'interrupted');
    } finally { f.agent.close(); }
  }
});

test('pause cancels pending approvals; immediate pause never sends a prompt', { timeout: 5000 }, async () => {
  const f = fixture((m, rpc) => rpc.send({ id: 'permission', method: 'session/request_permission', params: { sessionId: m.params.sessionId, toolCall: { title: 'Run command', kind: 'execute' }, options: [] } }));
  try {
    await f.agent.start(); const id = await thread(f.agent);
    let done = completion(f.agent);
    const { turn } = await f.agent.request('turn/start', { threadId: id });
    await f.agent.request('turn/interrupt', { turnId: turn.id });
    assert.equal((await done).status, 'interrupted'); await tick();
    assert.equal(f.calls.some(call => call.method === 'session/prompt'), false);
    done = completion(f.agent);
    const requested = new Promise<void>(resolve => f.agent.once('request', () => resolve()));
    const next = await f.agent.request('turn/start', { threadId: id }); await requested;
    await f.agent.request('turn/interrupt', { turnId: next.turn.id }); await tick();
    assert.deepEqual(f.calls.find(call => call.method === 'session/cancel').params, { sessionId: id });
    assert.deepEqual(f.calls.find(call => call.id === 'permission' && !call.method).result, { outcome: { outcome: 'cancelled' } });
    assert.ok(f.notifications.some(n => n.method === 'serverRequest/resolved'));
    f.peers[0].reply(f.calls.find(call => call.method === 'session/prompt').id, { stopReason: 'cancelled' });
    assert.equal((await done).status, 'interrupted');
  } finally { f.agent.close(); }
});

test('Kimi reports RPC errors, empty turns, unsupported efforts and process loss as failures', { timeout: 5000 }, async () => {
  for (const behavior of ['error', 'empty', 'exit', 'effort']) {
    const f = fixture((m, rpc) => {
      if (behavior === 'error') rpc.send({ id: m.id, error: { code: -32000, message: 'Authentication required' } });
      else if (behavior === 'exit') rpc.child.emit('close', 1);
      else rpc.reply(m.id, { stopReason: 'end_turn' });
    });
    try {
      await f.agent.start(); const id = await thread(f.agent);
      const result = await run(f.agent, id, behavior === 'effort' ? { effort: 'max' } : {});
      assert.equal(result.status, 'failed');
      assert.match(result.error.message, behavior === 'error' ? /Authentication/ : behavior === 'empty' ? /no response/ : behavior === 'effort' ? /does not support/ : /exited/);
      if (behavior === 'effort') assert.equal(f.calls.some(call => call.method === 'session/prompt'), false);
      if (behavior === 'exit') assert.equal(f.agent.ready, false);
    } finally { f.agent.close(); }
  }
  const missing = new KimiAgent('/nonexistent/papilot-kimi');
  await assert.rejects(missing.start(), /PAPILOT_KIMI_BIN/); missing.close();
});

test('concurrent Kimi sessions keep text and permissions attached to their own turns', { timeout: 5000 }, async () => {
  const prompts: any[] = [];
  const f = fixture(m => { prompts.push(m); });
  try {
    await f.agent.start();
    const first = await thread(f.agent), second = await thread(f.agent);
    const a = await f.agent.request('turn/start', { threadId: first });
    const b = await f.agent.request('turn/start', { threadId: second });
    for (let i = 0; i < 20 && prompts.length < 2; i++) await tick();
    assert.equal(prompts.length, 2);
    const rpc = f.peers[0];
    rpc.update(second, { sessionUpdate: 'tool_call', toolCallId: 'write', kind: 'edit', title: 'Write', rawInput: { file_path: '/paper/main.tex' } });
    rpc.send({ id: 'permission', method: 'session/request_permission', params: { sessionId: second, toolCall: { toolCallId: 'write', title: 'Write' }, options: [{ optionId: 'yes', kind: 'allow_once' }] } });
    assert.equal(f.requests[0].params.threadId, second);
    assert.equal(f.requests[0].params.turnId, b.turn.id);
    assert.equal(f.requests[0].method, 'item/fileChange/requestApproval');
    assert.equal(f.requests[0].params.command, 'Edit /paper/main.tex');
    f.agent.respond(f.requests[0].id, { decision: 'accept' });
    await f.agent.request('turn/interrupt', { turnId: a.turn.id });
    const paused = completion(f.agent);
    rpc.reply(prompts.find(p => p.params.sessionId === first).id, { stopReason: 'cancelled' });
    assert.equal((await paused).status, 'interrupted');
    const done = completion(f.agent);
    rpc.update(second, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Second session done' } });
    rpc.reply(prompts.find(p => p.params.sessionId === second).id, { stopReason: 'end_turn' });
    assert.equal((await done).status, 'completed');
    assert.ok(f.notifications.some(n => n.method === 'item/completed' && n.params.threadId === second && n.params.item.text === 'Second session done'));
  } finally { f.agent.close(); }
});

// As Kimi Code CLI 2.2 sends it: the tool is titled AskUserQuestion, the
// question is its text, and Skip is a one-time rejection.
const ask = (sessionId: string, id: string) => ({ id, method: 'session/request_permission', params: { sessionId,
  toolCall: { toolCallId: id, title: 'AskUserQuestion', content: [{ type: 'content', content: { type: 'text', text: 'Which section?' } }] },
  options: [{ optionId: 'intro', name: 'Introduction', kind: 'allow_once' }, { optionId: 'model', name: 'Model', kind: 'allow_once' }, { optionId: 'skip', name: 'Skip', kind: 'reject_once' }] } });
for (const [answer, optionId] of [['Model', 'model'], ['Skip', 'skip']]) {
  test(`Kimi asks its question with its options and passes on ${answer}`, { timeout: 5000 }, async () => {
    const f = fixture((m, rpc) => rpc.send(ask(m.params.sessionId, 'question')));
    try {
      await f.agent.start(); const id = await thread(f.agent);
      const requested = new Promise<void>(resolve => f.agent.once('request', m => {
        assert.equal(m.method, 'item/tool/requestUserInput');
        assert.equal(m.params.questions[0].question, 'Which section?');
        assert.deepEqual(m.params.questions[0].options, [{ label: 'Introduction' }, { label: 'Model' }, { label: 'Skip' }]);
        assert.equal(m.params.questions[0].isOther, false, 'ACP cannot carry a typed answer');
        f.agent.respond(m.id, { answers: { choice: { answers: [answer] } } }); resolve();
      }));
      const done = completion(f.agent);
      await f.agent.request('turn/start', { threadId: id }); await requested; await tick();
      assert.deepEqual(f.calls.find(call => call.id === 'question' && !call.method).result.outcome, { outcome: 'selected', optionId });
      f.peers[0].reply(f.calls.find(call => call.method === 'session/prompt').id, { stopReason: 'cancelled' });
      await done;
    } finally { f.agent.close(); }
  });
}

// A fake ACP agent for any profile: initialize, session/new with the given
// session result, and prompts answered by onPrompt.
function profileFixture(profile: typeof ACP_PROFILES[keyof typeof ACP_PROFILES], session: any, onPrompt: (message: any, rpc: ReturnType<typeof peer>) => void,
  capabilities = { sessionCapabilities: { resume: {}, close: {} } } as any, authMethods: string[] = [], authError = false) {
  const calls: any[] = [], launches: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  let serial = 0, rpc!: ReturnType<typeof peer>;
  const launch = (_binary: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    launches.push({ args, env: options.env });
    rpc = peer(message => {
      calls.push(message);
      if (!message.method) return;
      const { id, method, params } = message;
      if (method === 'initialize') rpc.reply(id, { protocolVersion: 1, agentCapabilities: capabilities, authMethods: authMethods.map(id => ({ id })) });
      else if (method === 'authenticate' && authError) rpc.send({ id, error: { code: -32000, message: 'Authentication required' } });
      else if (method === 'session/new' || method === 'session/resume' || method === 'session/load') rpc.reply(id, { sessionId: params.sessionId || `session-${++serial}`, ...structuredClone(session) });
      else if (method === 'session/prompt') onPrompt(message, rpc);
      else if (method === 'session/set_config_option') rpc.reply(id, { configOptions: session.configOptions?.map((option: any) => option.id === params.configId ? { ...option, currentValue: params.value } : option) });
      else if (id !== undefined) rpc.reply(id, {});
    });
    return rpc.child;
  };
  const agent = new AcpAgent(profile, 'fake-agent', launch as any);
  const notifications: any[] = [], requests: any[] = [];
  agent.on('notification', message => notifications.push(message));
  agent.on('request', message => requests.push(message));
  return { agent, calls, launches, notifications, requests, rpc: () => rpc };
}

// Copilot CLI 1.0.105 advertises URI mode IDs and a separate allow_all option.
// An empty catalog is valid (observed with a working local BYOK provider).
const copilotSession = {
  modes: { currentModeId: 'https://agentclientprotocol.com/protocol/session-modes#autopilot', availableModes: ['agent', 'plan', 'autopilot'].map(mode => ({ id: `https://agentclientprotocol.com/protocol/session-modes#${mode}` })) },
  configOptions: [{ id: 'allow_all', category: 'permissions', currentValue: 'on', options: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }] }],
};
const copilotCapabilities = { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { close: {} } };

for (const provider of ['kimi', 'qwen', 'copilot', 'opencode'] as const) {
  test(`${provider} applies native permission changes before prompts and after reconnecting`, async () => {
    const modes = provider === 'opencode' ? ['papilot-default', 'papilot-full'] : ['default', 'auto-edit', 'plan', 'auto', 'yolo'];
    const session = provider === 'copilot' ? copilotSession : { modes: { availableModes: modes.map(id => ({ id })) } };
    const active = new Map<string, string>(), prompted: { id: string; mode: string | undefined }[] = [];
    const f = profileFixture(ACP_PROFILES[provider], session, (m, rpc) => {
      const setter = [...f.calls].reverse().find(call => call.params?.sessionId === m.params.sessionId && (provider === 'copilot'
        ? call.method === 'session/set_config_option' && call.params.configId === 'allow_all' : call.method === 'session/set_mode'));
      active.set(m.params.sessionId, setter.params.modeId || setter.params.value);
      prompted.push({ id: m.params.sessionId, mode: active.get(m.params.sessionId) });
      rpc.update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } });
      rpc.reply(m.id, { stopReason: 'end_turn' });
    }, copilotCapabilities);
    try {
      await f.agent.start();
      assert.ok(f.agent.permissionOptions().some(option => option.value === 'full'));
      assert.ok(!f.agent.permissionOptions().some(option => option.value === 'mystery'));
      const id = (await f.agent.request('thread/start', { cwd: '/paper', taskPermissions: 'full' })).thread.id;
      for (const value of ['full', 'workspace', 'full', 'workspace']) {
        const policy = await f.agent.taskPermissionConfig(value);
        assert.equal((await run(f.agent, id, policy.turn)).status, 'completed');
      }
      f.agent.close(); await f.agent.start();
      await f.agent.request('thread/resume', { threadId: id, cwd: '/paper', taskPermissions: 'workspace' });
      assert.equal((await run(f.agent, id)).status, 'completed');
      const full = provider === 'copilot' ? 'on' : provider === 'opencode' ? 'papilot-full' : 'yolo';
      const restricted = provider === 'copilot' ? 'off' : provider === 'opencode' ? 'papilot-default' : provider === 'qwen' ? 'auto-edit' : 'default';
      assert.deepEqual(prompted, [full, restricted, full, restricted, restricted].map(mode => ({ id, mode })));
      await assert.rejects(f.agent.taskPermissionConfig('mystery'), /does not support/);
      const rejected = await run(f.agent, id, { taskPermissions: 'mystery' });
      assert.equal(rejected.status, 'failed');
      assert.equal(prompted.length, 5, 'unsupported permissions must fail before a prompt');
    } finally { f.agent.close(); }
  });
}

test('Kimi advertises only installed modes and keeps explicit approvals in YOLO', async () => {
  const f = profileFixture(ACP_PROFILES.kimi, { modes: { availableModes: ['default', 'plan', 'auto', 'yolo'].map(id => ({ id })) } }, (m, rpc) => {
    rpc.send({ id: 'managed-approval', method: 'session/request_permission', params: { sessionId: m.params.sessionId,
      toolCall: { title: 'Managed action', kind: 'execute' }, options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] } });
  });
  try {
    await f.agent.start();
    assert.deepEqual(f.agent.permissionOptions().map(option => option.value), ['workspace', 'plan', 'auto', 'full']);
    const id = (await f.agent.request('thread/start', { cwd: '/paper', taskPermissions: 'full' })).thread.id;
    const requested = new Promise<any>(resolve => f.agent.once('request', resolve));
    const done = run(f.agent, id, { taskPermissions: 'full' });
    const request = await requested;
    assert.equal(f.calls.some(call => call.id === 'managed-approval' && !call.method), false);
    f.agent.respond(request.id, { decision: 'decline' }); await tick();
    assert.deepEqual(f.calls.find(call => call.id === 'managed-approval' && !call.method).result.outcome, { outcome: 'selected', optionId: 'no' });
    f.rpc().reply(f.calls.find(call => call.method === 'session/prompt').id, { stopReason: 'cancelled' }); await done;
    const older = profileFixture(ACP_PROFILES.kimi, { modes: { availableModes: [{ id: 'default' }] } }, () => {});
    try { await older.agent.start(); assert.deepEqual(older.agent.permissionOptions().map(option => option.value), ['workspace']); }
    finally { older.agent.close(); }
  } finally { f.agent.close(); }
});

test('OpenCode owns its permission personas without overriding unrelated native or legacy configuration', () => {
  const own = { model: 'provider/model', permission: { webfetch: 'deny' },
    agent: { custom: { prompt: 'Keep me' }, 'papilot-default': { permission: 'allow' } },
    agents: { custom2: { mode: 'primary' }, 'papilot-default': { permissions: [{ action: '*', resource: '*', effect: 'allow' }] }, 'papilot-full': { mode: 'subagent' } } };
  const merged = JSON.parse(opencodeConfig(JSON.stringify(own)));
  assert.deepEqual(merged.agents, { custom2: own.agents.custom2 });
  assert.deepEqual(merged.agent.custom, own.agent.custom);
  assert.equal(merged.agent['papilot-default'].permission.bash, 'ask');
  assert.equal(merged.agent['papilot-default'].permission.external_directory, 'ask');
  assert.equal(merged.agent['papilot-full'].permission, 'allow');
  assert.equal(merged.permission.webfetch, 'deny');
});

test('Grok isolates concurrent tasks and restores the same native session with reduced permissions', async () => {
  const peers: ReturnType<typeof peer>[] = [], calls: any[][] = [], prompts: { process: number; id: string; full: boolean; request: number }[] = [];
  let serial = 0;
  const launch = () => {
    const index = peers.length, log: any[] = [], modes = new Map<string, boolean>(); calls.push(log);
    const rpc = peer(m => {
      log.push(m); const { id, method, params } = m;
      if (method === 'initialize') rpc.reply(id, { protocolVersion: 1, authMethods: [{ id: 'cached_token' }], agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } });
      else if (method === 'session/new' || method === 'session/resume') {
        const sessionId = params.sessionId || `grok-${++serial}`;
        // Like Grok, a resident session cannot be downgraded with metadata alone.
        modes.set(sessionId, modes.get(sessionId) || Boolean(params._meta.yoloMode));
        assert.equal(params._meta.autoMode, false);
        rpc.reply(id, { sessionId });
      } else if (method === 'session/prompt') prompts.push({ process: index, id: params.sessionId, full: modes.get(params.sessionId)!, request: id });
      else if (id !== undefined) rpc.reply(id, {});
    });
    peers.push(rpc); return rpc.child;
  };
  const agent = new GrokAgent('fake-grok', launch as any);
  const finish = async (prompt: typeof prompts[number]) => {
    const done = completion(agent as any), rpc = peers[prompt.process];
    rpc.update(prompt.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } });
    rpc.reply(prompt.request, { stopReason: 'end_turn' });
    assert.equal((await done).status, 'completed');
  };
  const waitPrompts = async (count: number) => { for (let i = 0; i < 100 && prompts.length < count; i++) await tick(); assert.equal(prompts.length, count); };
  try {
    await agent.start();
    const first = (await agent.request('thread/start', { cwd: '/first', taskPermissions: 'full' })).thread.id;
    const second = (await agent.request('thread/start', { cwd: '/second', taskPermissions: 'workspace' })).thread.id;
    await agent.request('turn/start', { threadId: first });
    await agent.request('turn/start', { threadId: second }); await waitPrompts(2);
    assert.deepEqual(prompts.map(p => [p.id, p.full]), [[first, true], [second, false]]);
    assert.notEqual(prompts[0].process, prompts[1].process);
    await finish(prompts[0]);
    await agent.request('turn/start', { threadId: first, taskPermissions: 'workspace' }); await waitPrompts(3);
    assert.equal(prompts[2].id, first); assert.equal(prompts[2].full, false);
    assert.notEqual(prompts[2].process, prompts[0].process);
    assert.ok(calls[prompts[2].process].some(call => call.method === 'session/resume' && call.params.sessionId === first));
    await finish(prompts[1]); await finish(prompts[2]);
  } finally { agent.close(); }
});

function grokLifecycleFixture() {
  const peers: { rpc: ReturnType<typeof peer>; kills: number; prompt?: any; held?: () => void }[] = [];
  let serial = 0, hold = false, failResume = false;
  const launch = () => {
    const state = { kills: 0 } as typeof peers[number];
    const rpc = peer(m => {
      const { id, method, params } = m;
      if (method === 'initialize') rpc.reply(id, { protocolVersion: 1, authMethods: [{ id: 'cached_token' }], agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } });
      else if (method === 'session/new' || method === 'session/load') {
        if (failResume && method === 'session/load') return rpc.send({ id, error: { code: -32000, message: 'resume unavailable' } });
        const result = { sessionId: params.sessionId || `session-${++serial}` };
        if (hold && peers.length === 2) { hold = false; state.held = () => rpc.reply(id, result); }
        else rpc.reply(id, result);
      } else if (method === 'session/prompt') state.prompt = m;
      else if (id !== undefined) rpc.reply(id, {});
    });
    state.rpc = rpc; peers.push(state);
    const kill = rpc.child.kill; rpc.child.kill = () => { state.kills++; return kill(); };
    return rpc.child;
  };
  return { agent: new GrokAgent('fake-grok', launch as any), peers, hold: () => { hold = true; }, failResume: () => { failResume = true; } };
}

test('Grok closes active and starting workers when the runtime disconnects', async () => {
  const f = grokLifecycleFixture();
  try {
    await f.agent.start();
    const id = (await f.agent.request('thread/start', { cwd: '/paper', taskPermissions: 'full' })).thread.id;
    await f.agent.request('turn/start', { threadId: id });
    for (let i = 0; i < 30 && !f.peers[1].prompt; i++) await tick();
    assert.ok(f.peers[1].prompt);
    const disconnected = new Promise(resolve => f.agent.once('disconnected', resolve));
    f.peers[0].rpc.child.emit('close', 1); await disconnected;
    assert.ok(f.peers[1].kills > 0, 'a disconnected runtime must not leave a YOLO worker running');
  } finally { f.agent.close(); }
  const pending = grokLifecycleFixture();
  try {
    await pending.agent.start(); pending.hold();
    const starting = pending.agent.request('thread/start', { cwd: '/paper', taskPermissions: 'full' });
    const rejected = assert.rejects(starting, /disconnected/);
    for (let i = 0; i < 30 && !pending.peers[1]?.held; i++) await tick();
    assert.ok(pending.peers[1].held);
    pending.agent.close(); await rejected;
    assert.ok(pending.peers[1].kills > 0, 'workers must be tracked before session creation completes');
  } finally { pending.agent.close(); }
});

test('Grok resume failures have a definite outcome before sending a new prompt', async () => {
  const f = grokLifecycleFixture();
  try {
    await f.agent.start();
    const id = (await f.agent.request('thread/start', { cwd: '/paper', taskPermissions: 'full' })).thread.id;
    const done = completion(f.agent as any);
    await f.agent.request('turn/start', { threadId: id, clientUserMessageId: 'first' });
    for (let i = 0; i < 30 && !f.peers[1].prompt; i++) await tick();
    const worker = f.peers[1]; assert.ok(worker.prompt);
    worker.rpc.update(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } });
    worker.rpc.reply(worker.prompt.id, { stopReason: 'end_turn' }); await done;
    f.failResume();
    await assert.rejects(f.agent.request('turn/start', { threadId: id, taskPermissions: 'workspace', clientUserMessageId: 'second' }), error => error instanceof RpcResponseError && /resume unavailable/.test(error.message));
    assert.equal(f.peers[2].prompt, undefined);
    assert.ok(f.peers[2].kills > 0);
  } finally { f.agent.close(); }
});

test('Grok restores idle threads after reconnect without an extra thread/resume from Workspace', async () => {
  const f = grokLifecycleFixture();
  try {
    await f.agent.start();
    const id = (await f.agent.request('thread/start', { cwd: '/paper', taskPermissions: 'full' })).thread.id;
    f.peers[0].rpc.child.emit('close', 1); await tick();
    await f.agent.start();
    await f.agent.request('turn/start', { threadId: id, taskPermissions: 'workspace' });
    for (let i = 0; i < 30 && !f.peers.at(-1)?.prompt; i++) await tick();
    assert.equal(f.peers.at(-1)?.prompt.params.sessionId, id);
  } finally { f.agent.close(); }
});

for (const legacy of [false, true]) {
  test(`ACP reports each session's current model instead of the probe default (${legacy ? 'legacy' : 'config options'})`, async () => {
    const session: any = legacy
      ? { models: { currentModelId: 'probe-model', availableModels: [{ modelId: 'probe-model', name: 'Probe' }, { modelId: 'paper-model', name: 'Paper' }] } }
      : { configOptions: [{ id: 'model', category: 'model', currentValue: 'probe-model', options: [{ value: 'probe-model', name: 'Probe' }, { value: 'paper-model', name: 'Paper' }] }] };
    const f = profileFixture(ACP_PROFILES.deepseek, session, (m, rpc) => {
      rpc.update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
      rpc.reply(m.id, { stopReason: 'end_turn' });
    });
    try {
      await f.agent.start();
      if (legacy) session.models.currentModelId = 'paper-model';
      else session.configOptions[0].currentValue = 'paper-model';
      assert.equal((await f.agent.request('model/list')).data.find((m: any) => m.isDefault).model, 'probe-model');
      const created = await f.agent.request('thread/start', { cwd: '/paper' });
      assert.equal(created.model, 'paper-model');
      const resumed = await f.agent.request('thread/resume', { threadId: 'saved-session', cwd: '/paper' });
      assert.equal(resumed.model, 'paper-model');
      const turn = await run(f.agent, resumed.thread.id, { effort: '' });
      assert.equal(turn.status, 'completed', turn.error?.message);
      assert.ok(f.calls.some(call => legacy ? call.method === 'session/set_model' && call.params.modelId === 'paper-model'
        : call.method === 'session/set_config_option' && call.params.configId === 'model' && call.params.value === 'paper-model'));
      await f.agent.request('thread/resume', { threadId: created.thread.id, cwd: '/paper', model: 'probe-model' });
      assert.equal((await f.agent.request('thread/resume', { threadId: created.thread.id, cwd: '/paper' })).model, 'probe-model', 'resuming a known session retains its last explicit selection');
    } finally { f.agent.close(); }
  });
}

test('Copilot pins agent mode and manual approvals on new and resumed sessions, with CLI-owned models', { timeout: 5000 }, async () => {
  const session = { ...copilotSession, configOptions: [...copilotSession.configOptions,
    { id: 'model', category: 'model', currentValue: 'model-a', options: [{ value: 'model-a', name: 'Model A' }, { value: 'model-b', name: 'Model B' }] },
    { id: 'reasoning_effort', category: 'thought_level', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  ] };
  const f = profileFixture(ACP_PROFILES.copilot, session, (m, rpc) => {
    rpc.update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
    rpc.reply(m.id, { stopReason: 'end_turn' });
  }, copilotCapabilities);
  const previous = { COPILOT_ALLOW_ALL: process.env.COPILOT_ALLOW_ALL, COPILOT_ASSISTED_APPROVAL: process.env.COPILOT_ASSISTED_APPROVAL };
  Object.assign(process.env, { COPILOT_ALLOW_ALL: 'true', COPILOT_ASSISTED_APPROVAL: 'true' });
  try {
    await f.agent.start();
    assert.deepEqual(f.launches[0].args, ['--acp', '--stdio', '--no-auto-update']);
    assert.equal(f.launches[0].env.COPILOT_ALLOW_ALL, 'false');
    assert.equal(f.launches[0].env.COPILOT_ASSISTED_APPROVAL, 'false');
    assert.equal(f.calls.some(call => call.method === 'session/prompt'), false);
    assert.ok(f.calls.some(call => call.method === 'session/close'));
    const models = (await f.agent.request('model/list')).data;
    assert.deepEqual(models.map((model: any) => [model.model, model.isDefault]), [['model-a', true], ['model-b', false]]);
    assert.deepEqual(models[0].supportedReasoningEfforts, [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }]);
    const { thread } = await f.agent.request('thread/start', { cwd: '/paper', model: 'model-a', developerInstructions: 'Only edit this paper.' });
    assert.equal((await run(f.agent, thread.id, { effort: 'low' })).status, 'completed');
    f.agent.close(); await f.agent.start();
    await f.agent.request('thread/resume', { threadId: thread.id, cwd: '/paper', model: 'model-b' });
    assert.equal((await run(f.agent, thread.id)).status, 'completed');
    assert.ok(f.calls.some(call => call.method === 'session/load' && call.params.sessionId === thread.id));
    assert.deepEqual(f.calls.filter(call => call.method === 'session/set_mode').map(call => call.params.modeId), Array(4).fill('https://agentclientprotocol.com/protocol/session-modes#agent'));
    assert.deepEqual(f.calls.filter(call => call.method === 'session/set_config_option' && call.params.configId === 'allow_all').map(call => call.params.value), ['off', 'off', 'off', 'off']);
    assert.ok(f.calls.some(call => call.method === 'session/set_config_option' && call.params.configId === 'reasoning_effort' && call.params.value === 'low'));
    assert.ok(f.calls.some(call => call.method === 'session/set_config_option' && call.params.configId === 'model' && call.params.value === 'model-b'));
    assert.equal(f.calls.filter(call => call.method === 'session/prompt').at(-1).params.prompt[0].text, 'Fix it.');
  } finally {
    f.agent.close();
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('Copilot works without a model catalog, forwards approvals and images, and cancels pending permissions', { timeout: 5000 }, async () => {
  const f = profileFixture(ACP_PROFILES.copilot, copilotSession, (m, rpc) => {
    rpc.send({ id: `permission-${m.id}`, method: 'session/request_permission', params: { sessionId: m.params.sessionId,
      toolCall: { toolCallId: 'command', kind: 'execute', title: 'Build the paper', rawInput: { command: 'latexmk main.tex' } },
      options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'always', name: 'Always allow', kind: 'allow_always' }, { optionId: 'no', name: 'Deny', kind: 'reject_once' }] } });
  }, copilotCapabilities);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-copilot-image-'));
  const file = path.join(dir, 'image.png');
  fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  try {
    await f.agent.start();
    assert.deepEqual((await f.agent.request('model/list')).data, []);
    const { thread } = await f.agent.request('thread/start', { cwd: '/paper' });
    for (const decision of ['accept', 'decline', 'cancel']) {
      const done = completion(f.agent), requested = new Promise<any>(resolve => f.agent.once('request', resolve));
      const { turn } = await f.agent.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Build.' }, { type: 'localImage', path: file }] });
      const request = await requested;
      assert.equal(request.method, 'item/commandExecution/requestApproval');
      assert.equal(request.params.command, 'latexmk main.tex');
      const prompt = f.calls.filter(call => call.method === 'session/prompt').at(-1);
      assert.equal(prompt.params.prompt[1].mimeType, 'image/png');
      if (decision === 'cancel') await f.agent.request('turn/interrupt', { turnId: turn.id });
      else f.agent.respond(request.id, { decision });
      await tick();
      assert.deepEqual(f.calls.find(call => call.id === `permission-${prompt.id}` && !call.method).result.outcome,
        decision === 'cancel' ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: decision === 'accept' ? 'once' : 'no' });
      f.rpc().update(thread.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
      f.rpc().reply(prompt.id, { stopReason: decision === 'cancel' ? 'cancelled' : 'end_turn' });
      assert.equal((await done).status, decision === 'cancel' ? 'interrupted' : 'completed');
    }
    assert.ok(f.calls.some(call => call.method === 'session/cancel'));
    assert.ok(f.notifications.some(n => n.method === 'serverRequest/resolved'));
  } finally { f.agent.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Copilot refuses versions without a way to disable automatic approvals', { timeout: 5000 }, async () => {
  const f = profileFixture(ACP_PROFILES.copilot, { ...copilotSession, configOptions: [] }, () => {}, copilotCapabilities);
  try {
    await assert.rejects(f.agent.start(), /required allow_all setting.*copilot login/);
    assert.equal(f.agent.ready, false);
    assert.equal(f.calls.some(call => call.method === 'session/prompt'), false);
  } finally { f.agent.close(); }
});

test('OpenCode is set to its dedicated default mode and asked to request approval before commands', { timeout: 5000 }, async () => {
  const session = { configOptions: [
    { id: 'model', category: 'model', currentValue: 'deepseek/deepseek-v4-pro', options: [{ value: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] },
    { id: 'effort', category: 'thought_level', currentValue: 'default', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }, { value: 'default', name: 'Default' }] },
    { id: 'mode', category: 'mode', currentValue: 'plan', options: [{ value: 'papilot-default', name: 'Default' }, { value: 'papilot-full', name: 'Full' }] },
  ] };
  const f = profileFixture(ACP_PROFILES.opencode, session, (m, rpc) => { rpc.update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } }); rpc.reply(m.id, { stopReason: 'end_turn' }); });
  try {
    await f.agent.start();
    assert.deepEqual(f.launches[0].args, ['acp']);
    const permission = JSON.parse(f.launches[0].env.OPENCODE_CONFIG_CONTENT!).permission;
    assert.equal(permission.bash, 'ask'); assert.equal(permission.external_directory, 'ask'); assert.equal(permission.edit, 'allow');
    const models = (await f.agent.request('model/list')).data;
    assert.deepEqual(models[0].supportedReasoningEfforts, [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], 'the "default" level is the model default');
    assert.equal(models[0].defaultReasoningEffort, null);
    const id = (await f.agent.request('thread/start', { cwd: '/paper', developerInstructions: 'Only edit this paper.' })).thread.id;
    assert.equal((await run(f.agent as unknown as KimiAgent, id)).status, 'completed');
    assert.ok(f.calls.some(call => call.method === 'session/set_config_option' && call.params.configId === 'mode' && call.params.value === 'papilot-default'));
    assert.equal(f.calls.some(call => call.method === 'session/set_mode'), false);
  } finally { f.agent.close(); }
  // The user's own OpenCode configuration is kept, with Papilot's approvals on top.
  const merged = JSON.parse(opencodeConfig(JSON.stringify({ model: 'x/y', permission: { webfetch: 'deny', bash: 'allow' } })));
  assert.equal(merged.model, 'x/y'); assert.equal(merged.permission.webfetch, 'deny'); assert.equal(merged.permission.bash, 'ask');
  assert.equal(JSON.parse(opencodeConfig('not json')).permission.shell, 'ask');
});

// Model-specific options, including grouped choices and a model without efforts.
function openCodeEffortFixture() {
  const levels: Record<string, string[]> = { first: ['low', 'high', 'default'], second: ['medium', 'high', 'max', 'default'], plain: [] };
  const options = (model: string, effort = 'default') => [
    { id: 'model', category: 'model', currentValue: model, options: [{ group: 'Provider', options: Object.keys(levels).map(value => ({ value, name: value })) }] },
    ...(levels[model].length ? [{ id: 'effort', category: 'thought_level', currentValue: effort, options: levels[model].map(value => ({ value, name: value })) }] : []),
  ];
  const calls: any[] = [], sessions = new Map<string, { model: string; effort: string }>();
  let serial = 0;
  const behavior = { stale: 0, missing: false, stalled: false, rejected: '', effortResponse: 'applied', onModel: () => {} };
  const launch = () => {
    const rpc = peer(message => {
      calls.push(message);
      const { id, method, params } = message;
      if (method === 'initialize') rpc.reply(id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, delete: {} } } });
      else if (method === 'session/new' || method === 'session/resume') {
        const sessionId = params.sessionId || `session-${++serial}`;
        const session = { model: 'first', effort: 'default' };
        sessions.set(sessionId, session);
        rpc.reply(id, { sessionId, configOptions: options(session.model), modes: { availableModes: [{ id: 'papilot-default' }] } });
      } else if (method === 'session/set_config_option') {
        const session = sessions.get(params.sessionId)!;
        if (params.configId === 'model') {
          behavior.onModel();
          if (behavior.stalled) return;
          if (params.value === behavior.rejected) { rpc.send({ id, error: { code: -32602, message: 'Unavailable model' } }); return; }
          if (behavior.missing) { rpc.reply(id, {}); return; }
          if (behavior.stale > 0) behavior.stale--;
          else if (session.model !== params.value) { session.model = params.value; session.effort = 'default'; }
        } else {
          if (behavior.effortResponse === 'missing') { rpc.reply(id, {}); return; }
          if (behavior.effortResponse === 'applied') session.effort = params.value;
        }
        rpc.reply(id, { configOptions: options(session.model, session.effort) });
      } else if (method === 'session/prompt') {
        rpc.update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } });
        rpc.reply(id, { stopReason: 'end_turn' });
      } else if (method && id !== undefined) rpc.reply(id, {});
    });
    return rpc.child;
  };
  return { agent: new AcpAgent(ACP_PROFILES.opencode, 'fake-opencode', launch as any), calls, sessions, behavior, levels };
}

test('OpenCode discovers per-model efforts, retries stale responses and preserves defaults across turns', async () => {
  const { agent, calls, sessions, behavior } = openCodeEffortFixture();
  behavior.stale = 1;
  try {
    await agent.start();
    const models = structuredClone((await agent.request('model/list')).data);
    assert.deepEqual(models.map((m: any) => [m.model, m.supportedReasoningEfforts.map((e: any) => e.reasoningEffort), m.defaultReasoningEffort, m.isDefault]), [
      ['first', ['low', 'high'], null, true], ['second', ['medium', 'high', 'max'], null, false], ['plain', [], null, false],
    ]);
    assert.equal(calls.filter(c => c.method === 'session/set_config_option' && c.params.value === 'second').length, 2);
    assert.ok(calls.some(c => c.method === 'session/delete' && c.params.sessionId === 'session-1'));
    assert.equal(calls.some(c => c.method === 'session/prompt'), false, 'discovery does not generate');
    const { thread } = await agent.request('thread/start', { cwd: '/paper', model: 'second' });
    assert.equal((await run(agent, thread.id, { effort: 'max' })).status, 'completed');
    assert.deepEqual(sessions.get(thread.id), { model: 'second', effort: 'max' });
    assert.equal((await run(agent, thread.id)).status, 'completed');
    assert.equal(sessions.get(thread.id)!.effort, 'default', 'clears the prior override');
    behavior.stale = 1;
    assert.equal((await run(agent, thread.id, { model: 'first', effort: 'low' })).status, 'completed');
    assert.deepEqual(sessions.get(thread.id), { model: 'first', effort: 'low' });
    assert.equal((await run(agent, thread.id, { model: 'plain' })).status, 'completed');
    assert.equal(sessions.get(thread.id)!.model, 'plain');
    assert.deepEqual((await agent.request('model/list')).data, models, 'turn overrides do not change catalog defaults');
    await agent.request('thread/resume', { cwd: '/paper', threadId: 'restored', model: 'second' });
    assert.equal((await run(agent, 'restored', { effort: 'max' })).status, 'completed');
    assert.deepEqual(sessions.get('restored'), { model: 'second', effort: 'max' });
  } finally { agent.close(); }
});

for (const missing of [false, true]) test(`OpenCode rejects unconfirmed model changes (${missing ? 'missing' : 'stale'} options) before prompting`, async () => {
  const { agent, calls, behavior } = openCodeEffortFixture();
  try {
    await agent.start();
    const { thread } = await agent.request('thread/start', { cwd: '/paper', model: 'first' });
    const before = calls.length;
    behavior.missing = missing; behavior.stale = 10;
    const result = await run(agent, thread.id, { model: 'second', effort: 'max' });
    assert.equal(result.status, 'failed');
    assert.match(result.error.message, /could not apply model=second/);
    assert.equal(calls.slice(before).filter(c => c.method === 'session/set_config_option').length, 3);
    assert.equal(calls.slice(before).some(c => c.method === 'session/prompt' || c.params?.configId === 'effort'), false);
  } finally { agent.close(); }
});

test('OpenCode skips failed discovery and bounds the total discovery time', async t => {
  const { agent, calls, behavior } = openCodeEffortFixture();
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  behavior.rejected = 'second';
  behavior.onModel = () => t.mock.timers.tick(10000);
  try {
    await agent.start();
    assert.equal(agent.ready, true);
    const models = (await agent.request('model/list')).data;
    assert.deepEqual(models[1].supportedReasoningEfforts, []);
    assert.equal(calls.filter(c => c.params?.configId === 'model').length, 1, 'deadline stops further probes');
    assert.ok(calls.some(c => c.method === 'session/delete'));
  } finally { agent.close(); }
});

for (const response of ['stale', 'missing']) test(`OpenCode refuses to prompt when effort confirmation is ${response}`, async () => {
  const { agent, calls, behavior } = openCodeEffortFixture();
  try {
    await agent.start();
    const { thread } = await agent.request('thread/start', { cwd: '/paper', model: 'second' });
    behavior.effortResponse = response;
    const result = await run(agent, thread.id, { effort: 'max' });
    assert.equal(result.status, 'failed');
    assert.match(result.error.message, /could not apply effort=max/);
    assert.equal(calls.some(c => c.method === 'session/prompt'), false);
  } finally { agent.close(); }
});

test('OpenCode task selection retains the normal RPC timeout outside discovery', async t => {
  const { agent, behavior } = openCodeEffortFixture();
  try {
    await agent.start();
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    behavior.onModel = () => t.mock.timers.tick(3000);
    const { thread } = await agent.request('thread/start', { cwd: '/paper', model: 'second' });
    assert.equal((await run(agent, thread.id, { effort: 'max' })).status, 'completed');
  } finally { agent.close(); }
});

test('OpenCode continues discovery after a rejected model without copying another model\'s efforts', async () => {
  const { agent, calls, behavior } = openCodeEffortFixture();
  behavior.rejected = 'second';
  try {
    await agent.start();
    assert.deepEqual((await agent.request('model/list')).data[1].supportedReasoningEfforts, []);
    assert.ok(calls.some(c => c.params?.configId === 'model' && c.params.value === 'plain'));
  } finally { agent.close(); }
});

test('OpenCode stops probing a large unresponsive catalog at the discovery deadline', async t => {
  const { agent, calls, behavior, levels } = openCodeEffortFixture();
  for (let i = 0; i < 100; i++) levels[`extra-${i}`] = ['low', 'high'];
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  behavior.stalled = true;
  behavior.onModel = () => t.mock.timers.tick(2000);
  try {
    await agent.start();
    assert.equal(Date.now(), 11000);
    assert.equal(calls.filter(c => c.params?.configId === 'model').length, 5);
    assert.equal(agent.ready, true);
    assert.equal((await agent.request('model/list')).data.length, 103, 'models remain selectable even when their effort discovery times out');
    assert.ok(calls.some(c => c.method === 'session/delete'));
  } finally { agent.close(); }
});

test('Qwen prefers its auto-edit mode, and an agent without any accepted mode is refused', { timeout: 5000 }, async () => {
  const modes = { availableModes: [{ id: 'plan' }, { id: 'default' }, { id: 'auto-edit' }, { id: 'yolo' }] };
  const f = profileFixture(ACP_PROFILES.qwen, { modes }, (m, rpc) => { rpc.update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } }); rpc.reply(m.id, { stopReason: 'end_turn' }); });
  try {
    await f.agent.start();
    assert.deepEqual(f.launches[0].args, ['--acp']);
    const id = (await f.agent.request('thread/start', { cwd: '/paper' })).thread.id;
    assert.equal((await run(f.agent as unknown as KimiAgent, id)).status, 'completed');
    assert.deepEqual(f.calls.filter(call => call.method === 'session/set_mode').map(call => call.params.modeId), ['auto-edit', 'auto-edit']);
  } finally { f.agent.close(); }
  const yolo = profileFixture(ACP_PROFILES.qwen, { modes: { availableModes: [{ id: 'yolo' }] } }, () => {});
  try { await assert.rejects(yolo.agent.start(), /Qwen does not offer manual approvals/); } finally { yolo.agent.close(); }
});

test('DeepSeek keeps its sandbox preset and its "other" tools show as commands and edits', { timeout: 5000 }, async () => {
  const session = { configOptions: [{ id: 'model', category: 'model', currentValue: 'v4', options: [{ value: 'v4', name: 'DeepSeek V4' }] }] };
  const f = profileFixture(ACP_PROFILES.deepseek, session, (m, rpc) => {
    const id = m.params.sessionId;
    rpc.update(id, { sessionUpdate: 'tool_call', toolCallId: 'ls', title: 'bash', kind: 'other', status: 'in_progress', rawInput: { command: 'ls' } });
    rpc.update(id, { sessionUpdate: 'tool_call_update', toolCallId: 'ls', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'main.tex\n' } }] });
    rpc.update(id, { sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'edit', kind: 'other', status: 'in_progress', rawInput: { file_path: 'main.tex', old_string: 'wrold', new_string: 'world' } });
    rpc.update(id, { sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed' });
    rpc.update(id, { sessionUpdate: 'tool_call', toolCallId: 'outside', title: 'write', kind: 'other', status: 'in_progress', rawInput: { file_path: '/elsewhere/notes.txt' } });
    rpc.send({ id: 'permission', method: 'session/request_permission', params: { sessionId: id, toolCall: { toolCallId: 'outside' }, options: [{ optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'reject-once', kind: 'reject_once' }] } });
  });
  const previous = process.env.DSH_PERMISSION_MODE;
  process.env.DSH_PERMISSION_MODE = 'danger-full-access';
  try {
    await f.agent.start();
    assert.deepEqual(f.launches[0].args, ['acp']);
    assert.equal(f.launches[0].env.DSH_PERMISSION_MODE, 'workspace-write');
    const id = (await f.agent.request('thread/start', { cwd: '/paper' })).thread.id;
    const done = completion(f.agent as unknown as KimiAgent);
    const requested = new Promise<any>(resolve => f.agent.once('request', resolve));
    await f.agent.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'Fix it.' }] });
    const request = await requested;
    assert.equal(request.method, 'item/fileChange/requestApproval');
    assert.equal(request.params.command, 'Edit /elsewhere/notes.txt');
    f.agent.respond(request.id, { decision: 'decline' }); await tick();
    assert.deepEqual(f.calls.find(call => call.id === 'permission' && !call.method).result.outcome, { outcome: 'selected', optionId: 'reject-once' });
    assert.equal(f.calls.some(call => call.method === 'session/set_mode' || (call.method === 'session/set_config_option' && call.params.configId === 'mode')), false);
    f.rpc().reply(f.calls.find(call => call.method === 'session/prompt').id, { stopReason: 'end_turn' });
    assert.equal((await done).status, 'completed');
    const items = f.notifications.filter(n => n.method === 'item/completed').map(n => n.params.item);
    // The change path is the thread's cwd joined with the edited file.
    assert.deepEqual(items.map(item => [item.type, item.command || item.changes?.[0].path]), [['commandExecution', 'ls'], ['fileChange', path.resolve('/paper', 'main.tex')]]);
    assert.equal(items[0].aggregatedOutput, 'main.tex\n');
  } finally {
    f.agent.close();
    if (previous === undefined) delete process.env.DSH_PERMISSION_MODE; else process.env.DSH_PERMISSION_MODE = previous;
  }
});

test('ACP agents are detected by their executable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-acp-detect-'));
  try {
    const file = path.join(dir, 'qwen');
    fs.writeFileSync(file, '#!/bin/sh\n'); fs.chmodSync(file, 0o755);
    // Windows detects the .cmd shim beside the script.
    const runnable = process.platform === 'win32' ? `${file}.cmd` : file;
    if (process.platform === 'win32') fs.writeFileSync(runnable, `@echo off\r\n"${process.execPath}" "${file}" %*\r\n`);
    assert.equal(new AcpAgent(ACP_PROFILES.qwen, runnable).detect(), true);
    assert.equal(new AcpAgent(ACP_PROFILES.qwen, path.join(dir, 'missing')).detect(), false);
    const previous = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    Object.assign(process.env, { PATH: dir, HOME: dir, USERPROFILE: dir });
    try {
      assert.equal(new AcpAgent(ACP_PROFILES.qwen).detect(), true); assert.equal(new AcpAgent(ACP_PROFILES.opencode).detect(), false);
      // A service's PATH may lack the folder a CLI installs itself in.
      fs.mkdirSync(path.join(dir, '.opencode/bin'), { recursive: true });
      const opencode = path.join(dir, '.opencode/bin/opencode');
      if (process.platform === 'win32') fs.copyFileSync(runnable, `${opencode}.cmd`);
      else { fs.copyFileSync(file, opencode); fs.chmodSync(opencode, 0o755); }
      process.env.PATH = '/usr/bin';
      assert.equal(new AcpAgent(ACP_PROFILES.opencode).detect(), true);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('empty and whitespace-only text chunks never become empty messages', { timeout: 5000 }, async () => {
  const f = profileFixture(ACP_PROFILES.qwen, { modes: { availableModes: [{ id: 'auto-edit' }] } }, (m, rpc) => {
    const id = m.params.sessionId, chunk = (text: string) => rpc.update(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    chunk(''); chunk('\n');
    rpc.update(id, { sessionUpdate: 'tool_call', toolCallId: 'edit', kind: 'edit', status: 'completed', locations: [{ path: '/paper/main.tex' }] });
    chunk(''); chunk(' '); chunk('Done'); chunk('.');
    rpc.reply(m.id, { stopReason: 'end_turn' });
  });
  try {
    await f.agent.start();
    const id = (await f.agent.request('thread/start', { cwd: '/paper' })).thread.id;
    assert.equal((await run(f.agent as unknown as KimiAgent, id)).status, 'completed');
    const deltas = f.notifications.filter(n => n.method === 'item/agentMessage/delta').map(n => n.params.delta);
    assert.deepEqual(deltas, [' Done', '.']);
    const messages = f.notifications.filter(n => n.method === 'item/completed' && n.params.item.type === 'agentMessage').map(n => n.params.item.text);
    assert.deepEqual(messages, [' Done.']);
  } finally { f.agent.close(); }
});

// Grok Build 1.0.70 advertises no session modes. Its permission defaults
// are overridden through session metadata, including load/resume requests.
const grokSession = {
  configOptions: [
    { id: 'model', category: 'model', currentValue: 'grok-test', options: [{ value: 'grok-test', name: 'Grok test' }] },
    { id: 'reasoning_effort', category: 'thought_level', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  ],
};
const grokCapabilities = { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { resume: {}, close: {} } };

for (const methods of [['grok.com', 'cached_token'], ['grok.com', 'cached_token', 'xai.api_key'], ['xai.api_key']]) {
  test(`Grok authenticates with available local credentials (${methods.join(', ')}) and restores manual permissions`, { timeout: 5000 }, async () => {
    const f = profileFixture(ACP_PROFILES.grok, grokSession, (m, rpc) => {
      rpc.update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
      rpc.reply(m.id, { stopReason: 'end_turn' });
    }, grokCapabilities, methods);
    try {
      await f.agent.start();
      assert.deepEqual(f.launches[0].args, ['--no-auto-update', 'agent', '--no-leader', 'stdio']);
      assert.deepEqual(f.calls.find(call => call.method === 'authenticate').params, { methodId: methods.includes('xai.api_key') ? 'xai.api_key' : 'cached_token', _meta: { headless: true } });
      assert.ok(f.calls.findIndex(call => call.method === 'authenticate') < f.calls.findIndex(call => call.method === 'session/new'));
      assert.equal(f.calls.some(call => call.method === 'session/prompt'), false, 'discovery must not generate');
      const models = (await f.agent.request('model/list')).data;
      assert.equal(models[0].model, 'grok-test');
      assert.deepEqual(models[0].supportedReasoningEfforts, [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }]);
      const { thread } = await f.agent.request('thread/start', { cwd: '/paper', model: 'grok-test', developerInstructions: 'Only edit this paper.' });
      assert.equal((await run(f.agent, thread.id, { effort: 'low' })).status, 'completed');
      f.agent.close(); await f.agent.start();
      await f.agent.request('thread/resume', { threadId: thread.id, cwd: '/paper' });
      assert.equal((await run(f.agent, thread.id)).status, 'completed');
      assert.equal(f.calls.filter(call => call.method === 'authenticate').length, 2);
      assert.ok(f.calls.some(call => call.method === 'session/resume' && call.params.sessionId === thread.id));
      for (const call of f.calls.filter(call => ['session/new', 'session/resume'].includes(call.method))) {
        assert.deepEqual(call.params._meta, { yoloMode: false, autoMode: false });
      }
      assert.ok(f.calls.some(call => call.method === 'session/set_config_option' && call.params.configId === 'reasoning_effort' && call.params.value === 'low'));
    } finally { f.agent.close(); }
  });
}

test('Grok rejects missing or failed authentication before creating any session', { timeout: 5000 }, async () => {
  for (const [methods, failure] of [[['grok.com', 'oidc'], false], [[], false], [['cached_token'], true]] as [string[], boolean][]) {
    const f = profileFixture(ACP_PROFILES.grok, grokSession, () => {}, grokCapabilities, methods, failure);
    try {
      await assert.rejects(f.agent.start(), failure ? /Authentication required.*grok login/ : /no saved login.*grok login/);
      assert.equal(f.agent.ready, false);
      assert.equal(f.calls.some(call => call.method === 'session/new'), false);
      if (!failure) assert.equal(f.calls.some(call => call.method === 'authenticate'), false, 'never start browser login');
    } finally { f.agent.close(); }
  }
});

test('Grok forwards file edits and images, denies commands, cancels permissions and falls back to session/load', { timeout: 5000 }, async () => {
  const f = profileFixture(ACP_PROFILES.grok, {}, (m, rpc) => {
    const edit = m.params.prompt[0].text.endsWith('Edit.');
    const tool = { toolCallId: String(m.id), kind: edit ? 'edit' : 'execute', title: edit ? 'Edit main.tex' : 'Run check', rawInput: edit ? { file_path: '/paper/main.tex' } : { command: 'latexmk main.tex' }, status: 'pending' };
    rpc.update(m.params.sessionId, { sessionUpdate: 'tool_call', ...tool });
    rpc.send({ id: `permission-${m.id}`, method: 'session/request_permission', params: { sessionId: m.params.sessionId, toolCall: tool,
      options: [{ optionId: 'always', kind: 'allow_always' }, { optionId: 'once', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] } });
  }, { ...grokCapabilities, sessionCapabilities: { close: {} } }, ['xai.api_key']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-grok-image-'));
  const file = path.join(dir, 'image.png');
  fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  try {
    await f.agent.start();
    assert.deepEqual((await f.agent.request('model/list')).data, []);
    const { thread } = await f.agent.request('thread/start', { cwd: '/paper' });
    for (const decision of ['accept', 'decline', 'cancel']) {
      const done = completion(f.agent), requested = new Promise<any>(resolve => f.agent.once('request', resolve));
      const { turn } = await f.agent.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: decision === 'accept' ? 'Edit.' : 'Build.' }, { type: 'localImage', path: file }] });
      const request = await requested;
      assert.equal(request.method, decision === 'accept' ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval');
      const prompt = f.calls.filter(call => call.method === 'session/prompt').at(-1);
      assert.equal(prompt.params.prompt[1].mimeType, 'image/png');
      if (decision === 'cancel') await f.agent.request('turn/interrupt', { turnId: turn.id });
      else f.agent.respond(request.id, { decision });
      await tick();
      assert.deepEqual(f.calls.find(call => call.id === `permission-${prompt.id}` && !call.method).result.outcome,
        decision === 'cancel' ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: decision === 'accept' ? 'once' : 'no' });
      f.rpc().update(thread.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
      f.rpc().reply(prompt.id, { stopReason: decision === 'cancel' ? 'cancelled' : 'end_turn' });
      assert.equal((await done).status, decision === 'cancel' ? 'interrupted' : 'completed');
    }
    assert.ok(f.notifications.some(n => n.method === 'serverRequest/resolved'));
    assert.ok(f.notifications.some(n => n.params.item?.type === 'fileChange'));
    f.agent.close(); await f.agent.start();
    await f.agent.request('thread/resume', { threadId: thread.id, cwd: '/paper' });
    assert.deepEqual(f.calls.find(call => call.method === 'session/load').params._meta, { yoloMode: false, autoMode: false });
  } finally { f.agent.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
