import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACP_PROFILES, AcpAgent, KimiAgent, opencodeConfig } from '../src/server/acp.ts';

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
    assert.deepEqual(f.calls.filter(call => call.method === 'session/set_mode').map(call => call.params.modeId), Array(2).fill('https://agentclientprotocol.com/protocol/session-modes#agent'));
    assert.deepEqual(f.calls.filter(call => call.method === 'session/set_config_option' && call.params.configId === 'allow_all').map(call => call.params.value), ['off', 'off']);
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

test('OpenCode is set to its build mode option and asked to request approval before commands', { timeout: 5000 }, async () => {
  const session = { configOptions: [
    { id: 'model', category: 'model', currentValue: 'deepseek/deepseek-v4-pro', options: [{ value: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] },
    { id: 'effort', category: 'thought_level', currentValue: 'default', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }, { value: 'default', name: 'Default' }] },
    { id: 'mode', category: 'mode', currentValue: 'plan', options: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }] },
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
    assert.ok(f.calls.some(call => call.method === 'session/set_config_option' && call.params.configId === 'mode' && call.params.value === 'build'));
    assert.equal(f.calls.some(call => call.method === 'session/set_mode'), false);
  } finally { f.agent.close(); }
  // The user's own OpenCode configuration is kept, with Papilot's approvals on top.
  const merged = JSON.parse(opencodeConfig(JSON.stringify({ model: 'x/y', permission: { webfetch: 'deny', bash: 'allow' } })));
  assert.equal(merged.model, 'x/y'); assert.equal(merged.permission.webfetch, 'deny'); assert.equal(merged.permission.bash, 'ask');
  assert.equal(JSON.parse(opencodeConfig('not json')).permission.shell, 'ask');
});

test('Qwen prefers its auto-edit mode, and an agent without any accepted mode is refused', { timeout: 5000 }, async () => {
  const modes = { availableModes: [{ id: 'plan' }, { id: 'default' }, { id: 'auto-edit' }, { id: 'yolo' }] };
  const f = profileFixture(ACP_PROFILES.qwen, { modes }, (m, rpc) => { rpc.update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } }); rpc.reply(m.id, { stopReason: 'end_turn' }); });
  try {
    await f.agent.start();
    assert.deepEqual(f.launches[0].args, ['--acp']);
    const id = (await f.agent.request('thread/start', { cwd: '/paper' })).thread.id;
    assert.equal((await run(f.agent as unknown as KimiAgent, id)).status, 'completed');
    assert.deepEqual(f.calls.filter(call => call.method === 'session/set_mode').map(call => call.params.modeId), ['auto-edit']);
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
    assert.deepEqual(items.map(item => [item.type, item.command || item.changes?.[0].path]), [['commandExecution', 'ls'], ['fileChange', '/paper/main.tex']]);
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
    assert.equal(new AcpAgent(ACP_PROFILES.qwen, file).detect(), true);
    assert.equal(new AcpAgent(ACP_PROFILES.qwen, path.join(dir, 'missing')).detect(), false);
    const previous = { PATH: process.env.PATH, HOME: process.env.HOME };
    Object.assign(process.env, { PATH: dir, HOME: dir });
    try {
      assert.equal(new AcpAgent(ACP_PROFILES.qwen).detect(), true); assert.equal(new AcpAgent(ACP_PROFILES.opencode).detect(), false);
      // A service's PATH may lack the folder a CLI installs itself in.
      fs.mkdirSync(path.join(dir, '.opencode/bin'), { recursive: true });
      fs.copyFileSync(file, path.join(dir, '.opencode/bin/opencode')); fs.chmodSync(path.join(dir, '.opencode/bin/opencode'), 0o755);
      process.env.PATH = '/usr/bin';
      assert.equal(new AcpAgent(ACP_PROFILES.opencode).detect(), true);
    } finally { Object.assign(process.env, previous); }
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
