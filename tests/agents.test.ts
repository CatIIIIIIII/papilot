import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AntigravityAgent, ClaudeAgent, GlmAgent, findExecutable, glmEndpoint, groupModels } from '../src/server/agents.ts';
import { CursorAgent, type CursorSdk } from '../src/server/cursor.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const events = (agent: EventEmitter) => { const seen: { method: string; params: any }[] = []; agent.on('notification', message => seen.push(message)); return seen; };
const completed = (seen: { method: string; params: any }[]) => new Promise<any>(resolve => { const check = setInterval(() => { const done = seen.find(event => event.method === 'turn/completed'); if (done) { clearInterval(check); resolve(done.params.turn); } }, 2); });

test('agy effort variants are grouped into one model with efforts, and the saved model is the default', () => {
  const listing = 'Fetching available models...\ngemini-4-argon-medium\tGemini 4 Argon (Medium)\ngemini-4-argon-high\tGemini 4 Argon (High)\ngemini-4-argon-low\tGemini 4 Argon (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n';
  assert.deepEqual(groupModels(listing, 'Gemini 4 Argon (High)'), [
    { model: 'gemini-4-argon', displayName: 'Gemini 4 Argon', efforts: ['low', 'medium', 'high'], ids: { medium: 'gemini-4-argon-medium', high: 'gemini-4-argon-high', low: 'gemini-4-argon-low' }, isDefault: true, defaultEffort: 'high' },
    { model: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6 (Thinking)', efforts: [], ids: { '': 'claude-sonnet-4-6' }, isDefault: false, defaultEffort: null },
  ]);
});

function fakeAgy(lines: string[][]) {
  const launches: { args: string[]; cwd: string; child: any }[] = [];
  const launch = (_command: string, args: string[], options: { cwd: string }) => {
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = (signal: string) => { child.killed = signal; setImmediate(() => child.emit('close', null, signal)); };
    launches.push({ args, cwd: options.cwd, child });
    const script = lines.shift() || [];
    setImmediate(() => { for (const line of script) child.stdout.write(line + '\n'); if (script.length) { child.stdout.end(); setImmediate(() => child.emit('close', 0)); } });
    return child;
  };
  return { launches, launch };
}

test('Antigravity turns run agy in accept-edits mode, stream into items, and resume their conversation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-agy-'));
  const first = [
    JSON.stringify({ event: 'init', conversation_id: 'conv-1', init: {} }),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Editing ' } }),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'now.' } }),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_file', tool_info: { parameters: { Path: '/work/main.tex' } } } }),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'write_file', tool_info: { parameters: { Path: '/work/main.tex' } } } }),
    'warning: not JSON',
    JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Editing now.', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } }),
  ];
  const second = [JSON.stringify({ event: 'init', conversation_id: 'conv-1' }), JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'Quota exceeded' } })];
  const fake = fakeAgy([first, second, []]);
  const agent = new AntigravityAgent('agy', path.join(dir, 'conversations.json'), fake.launch as any);
  (agent as any).catalog = groupModels('gemini-4-argon-low\tGemini 4 Argon (Low)\ngemini-4-argon-high\tGemini 4 Argon (High)\n');
  agent.ready = true;
  try {
    const seen = events(agent);
    const { thread } = await agent.request('thread/start', { cwd: '/work', developerInstructions: 'Only edit the worktree.', model: 'gemini-4-argon' });
    const { turn } = await agent.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Shorten the abstract.' }], cwd: '/work', effort: 'high', clientUserMessageId: 'run-1' });
    assert.equal((await completed(seen)).status, 'completed');
    const args = fake.launches[0].args;
    assert.equal(fake.launches[0].cwd, '/work');
    assert.deepEqual(args.slice(2), ['--output-format', 'stream-json', '--mode', 'accept-edits', '--model', 'gemini-4-argon-high']);
    assert.match(args[1], /^Only edit the worktree\.\n\n---\n\nShorten the abstract\.$/);
    assert.deepEqual(seen.filter(e => e.method === 'item/agentMessage/delta').map(e => e.params.delta), ['Editing ', 'now.']);
    const items = seen.filter(e => e.method === 'item/completed').map(e => e.params.item);
    assert.deepEqual(items.map(item => item.type), ['agentMessage', 'fileChange', 'agentMessage']);
    assert.equal(items[0].text, 'Editing now.');
    assert.deepEqual(items[1].changes, [{ path: '/work/main.tex' }]);
    assert.match(items[2].text, /could not run RunCommand/);
    assert.equal(seen.every(e => e.params.threadId === thread.id), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'conversations.json'), 'utf8')), { [thread.id]: 'conv-1' });
    const read = await agent.request('thread/read', { threadId: thread.id });
    assert.deepEqual(read.thread.turns, [{ id: turn.id, status: 'completed', items: [{ type: 'userMessage', clientId: 'run-1' }] }]);
    // A later turn, even from a fresh adapter after a restart, resumes the same conversation.
    const restarted = new AntigravityAgent('agy', path.join(dir, 'conversations.json'), fake.launch as any);
    restarted.ready = true;
    const again = events(restarted);
    await restarted.request('thread/resume', { threadId: thread.id, cwd: '/work', developerInstructions: 'Only edit the worktree.' });
    await restarted.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Now the introduction.' }], cwd: '/work' });
    const failed = await completed(again);
    assert.deepEqual([failed.status, failed.error.message], ['failed', 'Quota exceeded']);
    assert.deepEqual(fake.launches[1].args.slice(0, 2), ['-p', 'Now the introduction.']);
    assert.deepEqual(fake.launches[1].args.slice(-2), ['--conversation', 'conv-1']);
    // Pausing stops the process and ends the turn as interrupted.
    const paused = events(restarted);
    const { turn: third } = await restarted.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Wait.' }], cwd: '/work' });
    await tick();
    await restarted.request('turn/interrupt', { threadId: thread.id, turnId: third.id });
    assert.equal((await completed(paused)).status, 'interrupted');
    assert.equal(fake.launches[2].child.killed, 'SIGINT');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function fakeClaude(script: (options: any) => AsyncGenerator<any>, account: Record<string, string> = { email: 'me@example.com', apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' }) {
  const calls: { prompt: unknown; options: any }[] = [];
  const query = ((input: { prompt: unknown; options: any }) => {
    calls.push(input);
    const generator: any = typeof input.prompt === 'string' ? script(input.options) : (async function* () {})();
    generator.accountInfo = async () => account;
    generator.supportedModels = async () => [
      { value: 'default', displayName: 'Default (recommended)', description: '', resolvedModel: 'claude-opus-5-5', supportedEffortLevels: ['low', 'high'] },
      { value: 'opus', displayName: 'Opus 5.5', description: '', resolvedModel: 'claude-opus-5-5', supportedEffortLevels: ['low', 'high'] },
      { value: 'haiku', displayName: 'Haiku 5.5', description: '', resolvedModel: 'claude-haiku-5-5', supportedEffortLevels: ['low'] },
    ];
    generator.close = () => {};
    return generator;
  });
  return { calls, load: async () => query as any };
}

test('Claude turns use the local Claude Code login, resume their session, and report items, approvals and usage', async () => {
  const fake = fakeClaude(async function* (options) {
    yield { type: 'system', subtype: 'init', session_id: options.sessionId || options.resume, effort: 'xhigh' };
    yield { type: 'stream_event', parent_tool_use_id: null, session_id: 's', event: { type: 'message_start', message: { id: 'm1' } } };
    yield { type: 'stream_event', parent_tool_use_id: null, session_id: 's', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking.' } } };
    yield { type: 'assistant', parent_tool_use_id: null, session_id: 's', message: { id: 'm1', content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'latexmk main.tex' } }, { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/work/main.tex' } }] } };
    // An unsandboxed command asks for approval; a question asks the user.
    const decision = await options.canUseTool('Bash', { command: 'rm -rf build' }, { signal: new AbortController().signal, title: 'Claude wants to run rm -rf build' });
    const answer = await options.canUseTool('AskUserQuestion', { questions: [{ question: 'Which section?', header: 'Scope', options: [{ label: 'Intro', description: '' }, { label: 'Model', description: '' }] }] }, { signal: new AbortController().signal });
    yield { type: 'user', parent_tool_use_id: null, session_id: 's', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Output written', is_error: false }, { type: 'tool_result', tool_use_id: 'tool-2', content: [{ type: 'text', text: 'file' }], is_error: false }] } };
    yield { type: 'rate_limit_event', session_id: 's', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.42, resetsAt: 1_800_000_000 } };
    yield { type: 'assistant', parent_tool_use_id: null, session_id: 's', message: { id: 'm2', content: [{ type: 'text', text: `Done: ${decision.behavior}, ${answer.updatedInput.answers['Which section?']}.` }] } };
    yield { type: 'result', subtype: 'success', is_error: false, result: 'Done', session_id: 's' };
  });
  const agent = new ClaudeAgent(fake.load, () => null);
  await agent.start();
  assert.deepEqual(await agent.request('account/read'), { account: { email: 'me@example.com', type: 'API key' }, requiresOpenaiAuth: false });
  // With only a Claude subscription login, Claude is unavailable and says why.
  const subscription = new ClaudeAgent(fakeClaude(async function* () {}, { email: 'me@example.com', subscriptionType: 'Claude Max', apiProvider: 'firstParty' }).load, () => null);
  await subscription.start();
  const refused = await subscription.request('account/read');
  assert.equal(refused.account, null);
  assert.match(refused.reason, /needs an Anthropic API key.*ANTHROPIC_API_KEY/);
  const bedrock = new ClaudeAgent(fakeClaude(async function* () {}, { apiProvider: 'bedrock' }).load, () => null);
  await bedrock.start();
  assert.deepEqual((await bedrock.request('account/read')).account, { email: undefined, type: 'bedrock' });
  // A token for a gateway or an Anthropic-compatible ANTHROPIC_BASE_URL counts as a key.
  const compatible = new ClaudeAgent(fakeClaude(async function* () {}, { tokenSource: 'ANTHROPIC_AUTH_TOKEN', apiProvider: 'firstParty' }).load, () => null);
  await compatible.start();
  assert.deepEqual((await compatible.request('account/read')).account, { email: undefined, type: 'API key' });
  assert.deepEqual((await agent.request('model/list')).data.map((m: any) => [m.model, m.isDefault, m.supportedReasoningEfforts.length]), [['opus', true, 2], ['haiku', false, 1]]);
  await assert.rejects(agent.request('account/rateLimits/read'), /not reported usage/);
  const seen = events(agent), requests: any[] = [];
  agent.on('request', request => { requests.push(request); setImmediate(() => agent.respond(request.id, request.method === 'item/tool/requestUserInput' ? { answers: { 0: { answers: ['Intro'] } } } : { decision: 'decline' })); });
  const { thread } = await agent.request('thread/start', { cwd: '/work', developerInstructions: 'Only edit the worktree.', model: 'opus' });
  await agent.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Fix the build.' }], cwd: '/work', effort: 'high' });
  assert.equal((await completed(seen)).status, 'completed');
  const options = fake.calls[1].options;
  assert.equal(fake.calls[1].prompt, 'Fix the build.');
  assert.deepEqual([options.cwd, options.model, options.effort, options.sessionId, options.resume, options.permissionMode], ['/work', 'opus', 'high', thread.id, undefined, 'acceptEdits']);
  assert.deepEqual(options.sandbox, { enabled: true, autoAllowBashIfSandboxed: true });
  assert.deepEqual(options.systemPrompt, { type: 'preset', preset: 'claude_code', append: 'Only edit the worktree.' });
  assert.deepEqual(options.settingSources, ['project']);
  assert.deepEqual(requests.map(r => [r.method, r.params.command || r.params.questions?.[0].question]), [['item/commandExecution/requestApproval', 'rm -rf build'], ['item/tool/requestUserInput', 'Which section?']]);
  assert.equal(requests[0].params.reason, 'Claude wants to run rm -rf build');
  const items = seen.filter(e => e.method === 'item/completed').map(e => e.params.item);
  assert.deepEqual(items.map(item => [item.type, item.text || item.command || item.status]), [['agentMessage', 'Checking.'], ['commandExecution', 'latexmk main.tex'], ['toolCall', 'Read /work/main.tex'], ['agentMessage', 'Done: deny, Intro.']]);
  assert.equal(items[1].aggregatedOutput, 'Output written');
  assert.deepEqual(seen.filter(e => e.method === 'item/agentMessage/delta').map(e => [e.params.itemId, e.params.delta]), [['m1:0', 'Checking.']]);
  // Usage comes from the turn's rate limit events; the model's default effort from its init message.
  const usage = await agent.request('account/rateLimits/read');
  assert.deepEqual(usage.rateLimits.primary, { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_800_000_000 });
  assert.equal(usage.rateLimits.planType, null);
  assert.equal((await agent.request('model/list')).data[0].defaultReasoningEffort, 'xhigh');
  // The next turn resumes the same Claude session.
  const next = events(agent);
  await agent.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Again.' }], cwd: '/work', model: 'haiku', effort: 'low' });
  await completed(next);
  assert.deepEqual([fake.calls[2].options.resume, fake.calls[2].options.sessionId, fake.calls[2].options.model, fake.calls[2].options.effort], [thread.id, undefined, 'haiku', 'low']);
});

test('pausing a Claude turn aborts it and declines its pending approval', async () => {
  let started = () => {};
  const ready = new Promise<void>(resolve => { started = resolve; });
  const fake = fakeClaude(async function* (options) {
    yield { type: 'system', subtype: 'init', session_id: 's' };
    const signal = options.abortController.signal;
    const decision = options.canUseTool('Bash', { command: 'make' }, { signal, title: 'Run make?' });
    started();
    const result = await decision;
    if (signal.aborted) throw new Error(`aborted after ${result.behavior}`);
    yield { type: 'result', subtype: 'success', is_error: false, result: '', session_id: 's' };
  });
  const agent = new ClaudeAgent(fake.load, () => null);
  const seen = events(agent);
  const { thread } = await agent.request('thread/start', { cwd: '/work' });
  const { turn } = await agent.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Build.' }], cwd: '/work' });
  await ready;
  await agent.request('turn/interrupt', { threadId: thread.id, turnId: turn.id });
  assert.equal((await completed(seen)).status, 'interrupted');
  assert.equal(seen.some(e => e.method === 'serverRequest/resolved'), true);
});

test('a refused Claude subscription login explains that Papilot needs an API key', async () => {
  const fake = fakeClaude(async function* () {
    yield { type: 'system', subtype: 'init', session_id: 's' };
    yield { type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate. API Error: 403 Request not allowed', session_id: 's' };
  });
  const agent = new ClaudeAgent(fake.load, () => null);
  const seen = events(agent);
  const { thread } = await agent.request('thread/start', { cwd: '/work' });
  await agent.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Edit.' }], cwd: '/work' });
  const turn = await completed(seen);
  assert.equal(turn.status, 'failed');
  assert.match(turn.error.message, /subscription login cannot be used through the Claude Agent SDK; give Papilot an Anthropic API key/);
});

test('GLM runs Claude Code on Zhipu\'s endpoint with only the GLM key, and offers GLM models', async () => {
  assert.equal(glmEndpoint({}), null);
  assert.equal(glmEndpoint({ ZAI_API_KEY: 'z' })!.url, 'https://api.z.ai/api/anthropic');
  assert.equal(new GlmAgent(async () => { throw new Error('unused'); }, {}).detect(), false);
  const env = { PATH: '/usr/bin', ZHIPU_API_KEY: 'zhipu-key', ANTHROPIC_API_KEY: 'anthropic-secret', ANTHROPIC_BASE_URL: 'https://gateway.example', CLAUDE_CODE_USE_BEDROCK: '1' };
  const fake = fakeClaude(async function* (options) {
    yield { type: 'system', subtype: 'init', session_id: options.sessionId };
    yield { type: 'assistant', parent_tool_use_id: null, session_id: 's', message: { id: 'm1', content: [{ type: 'text', text: 'Done.' }] } };
    yield { type: 'result', subtype: 'success', is_error: false, result: 'Done', session_id: 's' };
  }, { tokenSource: 'ANTHROPIC_AUTH_TOKEN', apiProvider: 'firstParty' });
  const agent = new GlmAgent(fake.load, env);
  assert.equal(agent.detect(), true);
  await agent.start();
  assert.deepEqual((await agent.request('account/read')).account, { email: undefined, type: 'Zhipu API key' });
  const models = (await agent.request('model/list')).data;
  assert.equal(models[0].model, 'glm-5.3'); assert.equal(models[0].isDefault, true);
  assert.ok(models.every((model: any) => !model.supportedReasoningEfforts.length));
  const seen = events(agent);
  const { thread } = await agent.request('thread/start', { cwd: '/work', model: 'glm-5.3-flash' });
  await agent.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Fix it.' }] });
  assert.equal((await completed(seen)).status, 'completed');
  for (const { options } of fake.calls) {
    assert.equal(options.env.ANTHROPIC_BASE_URL, 'https://open.bigmodel.cn/api/anthropic');
    assert.equal(options.env.ANTHROPIC_AUTH_TOKEN, 'zhipu-key');
    assert.equal(options.env.ANTHROPIC_API_KEY, undefined, 'an Anthropic key never goes to Zhipu');
    assert.equal(options.env.CLAUDE_CODE_USE_BEDROCK, undefined);
    assert.equal(options.env.PATH, '/usr/bin');
  }
  assert.equal(fake.calls.at(-1)!.options.model, 'glm-5.3-flash');
});

test('executables are found on PATH or by path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-exec-'));
  try {
    const file = path.join(dir, 'tool'), plain = path.join(dir, 'plain');
    fs.writeFileSync(file, '#!/bin/sh\n'); fs.chmodSync(file, 0o755); fs.writeFileSync(plain, 'text');
    assert.equal(findExecutable('tool', { PATH: `/nonexistent${path.delimiter}${dir}` }), file);
    assert.equal(findExecutable(file, { PATH: '' }), file);
    assert.equal(findExecutable('plain', { PATH: dir }), null, 'a file without execute permission is not an agent');
    assert.equal(findExecutable('tool', { PATH: '', HOME: dir }), null);
    // Under a service whose PATH lacks ~/.local/bin, Claude Code is still found there.
    fs.mkdirSync(path.join(dir, '.local/bin'), { recursive: true });
    fs.copyFileSync(file, path.join(dir, '.local/bin/claude')); fs.chmodSync(path.join(dir, '.local/bin/claude'), 0o755);
    assert.equal(findExecutable('claude', { PATH: '/usr/bin:/bin', HOME: dir }), path.join(dir, '.local/bin/claude'));
    fs.mkdirSync(path.join(dir, '.grok/bin'), { recursive: true });
    fs.copyFileSync(file, path.join(dir, '.grok/bin/grok')); fs.chmodSync(path.join(dir, '.grok/bin/grok'), 0o755);
    assert.equal(findExecutable('grok', { PATH: '/usr/bin:/bin', HOME: dir }), path.join(dir, '.grok/bin/grok'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function fakeCursor(script: (send: { message: any; options: any }) => any[], result: any = { status: 'finished' }) {
  const created: any[] = [], resumed: any[] = [], sends: { message: any; options: any }[] = [], cancelled: string[] = [];
  const handle = (agentId: string) => ({ agentId, close() {}, async send(message: any, options: any) {
    const call = { message, options }; sends.push(call);
    const events = script(call);
    return {
      async *stream() { for (const event of events) { if (event.delta) options.onDelta?.({ update: event.delta }); else yield event; await tick(); } },
      async wait() { return result; },
      async cancel() { cancelled.push(agentId); },
    };
  } });
  const sdk: CursorSdk = {
    Agent: { async create(options: any) { created.push(options); return handle(`agent-${created.length}`); }, async resume(id: string, options: any) { resumed.push({ id, options }); return handle(id); } },
    Cursor: { async me() { return { apiKeyName: 'papilot', userEmail: 'me@example.com' }; }, models: { async list() { return [
      { id: 'composer-2.5', displayName: 'Composer 2.5' },
      { id: 'auto', displayName: 'Auto' },
      { id: 'gpt-5.3-codex', displayName: 'Codex 5.3', parameters: [{ id: 'reasoning', values: [{ value: 'low' }, { value: 'high' }] }], variants: [{ params: [{ id: 'reasoning', value: 'high' }], isDefault: true }] },
    ]; } } },
  };
  return { sdk, created, resumed, sends, cancelled };
}

test('Cursor runs a sandboxed local SDK agent, streams items and resumes its agent after a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-cursor-'));
  const file = path.join(dir, 'cursor-agents.json'), image = path.join(dir, 'figure.png');
  fs.writeFileSync(image, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  const fake = fakeCursor(() => [
    { delta: { type: 'text-delta', text: 'Checking ' } }, { delta: { type: 'text-delta', text: 'now.' } },
    { type: 'tool_call', call_id: 'c1', name: 'shell', status: 'running', args: { command: 'latexmk main.tex' } },
    { type: 'tool_call', call_id: 'c1', name: 'shell', status: 'completed', args: { command: 'latexmk main.tex' }, result: { status: 'success', value: { stdout: 'Build passed', stderr: '', exitCode: 0 } } },
    { type: 'tool_call', call_id: 'c2', name: 'edit', status: 'completed', args: { path: '/work/main.tex' }, result: { status: 'success', value: {} } },
    { delta: { type: 'text-delta', text: 'Done.' } },
  ]);
  try {
    assert.equal(new CursorAgent(async () => fake.sdk, file, () => false).detect(), false);
    const agent = new CursorAgent(async () => fake.sdk, file, () => true);
    await agent.start();
    assert.deepEqual((await agent.request('account/read')).account, { email: 'me@example.com', type: 'Cursor API key' });
    const models = (await agent.request('model/list')).data;
    assert.deepEqual(models.map((m: any) => [m.model, m.isDefault]), [['composer-2.5', false], ['auto', true], ['gpt-5.3-codex', false]]);
    assert.deepEqual(models[2].supportedReasoningEfforts, [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }]);
    assert.equal(models[2].defaultReasoningEffort, 'high');
    const seen = events(agent);
    const { thread } = await agent.request('thread/start', { cwd: '/work', developerInstructions: 'Only edit the worktree.', model: 'gpt-5.3-codex' });
    await agent.request('turn/start', { threadId: thread.id, effort: 'low', input: [{ type: 'text', text: 'Fix it.' }, { type: 'localImage', path: image }] });
    assert.equal((await completed(seen)).status, 'completed');
    assert.deepEqual(fake.created[0].local, { cwd: '/work', settingSources: ['project'], sandboxOptions: { enabled: true } });
    assert.deepEqual(fake.created[0].model, { id: 'gpt-5.3-codex', params: [{ id: 'reasoning', value: 'low' }] });
    assert.equal(fake.sends[0].message.text, 'Only edit the worktree.\n\n---\n\nFix it.');
    assert.equal(fake.sends[0].message.images[0].mimeType, 'image/png');
    const items = seen.filter(e => e.method === 'item/completed').map(e => e.params.item);
    assert.deepEqual(items.map(item => item.type), ['agentMessage', 'commandExecution', 'fileChange', 'agentMessage']);
    assert.equal(items[0].text, 'Checking now.'); assert.equal(items[1].aggregatedOutput, 'Build passed'); assert.deepEqual(items[2].changes, [{ path: '/work/main.tex' }]);
    const deltas = seen.filter(e => e.method === 'item/agentMessage/delta');
    assert.equal(deltas[0].params.itemId, items[0].id); assert.equal(deltas.at(-1)!.params.itemId, items[3].id);
    // A restarted Papilot resumes the same Cursor agent and sends only the new message.
    agent.close();
    const restarted = new CursorAgent(async () => fake.sdk, file, () => true);
    await restarted.start();
    const again = events(restarted);
    await restarted.request('thread/resume', { threadId: thread.id, cwd: '/work' });
    await restarted.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Shorter.' }] });
    assert.equal((await completed(again)).status, 'completed');
    assert.equal(fake.resumed[0].id, 'agent-1'); assert.equal(fake.created.length, 1);
    assert.equal(fake.sends[1].message, 'Shorter.');
    await assert.rejects(restarted.request('account/rateLimits/read'), /does not report usage/);
    restarted.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pausing a Cursor turn cancels its run, and a failed run reports its error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-cursor-'));
  try {
    const cancelled: string[] = [];
    let release = () => {};
    const released = new Promise<void>(resolve => { release = resolve; });
    const waiting: CursorSdk = {
      Agent: { async create() { return { agentId: 'agent-1', close() {}, async send() { return {
        async *stream() { yield { type: 'tool_call', call_id: 'c1', name: 'shell', status: 'running', args: { command: 'sleep 100' } }; await released; },
        async wait() { return { status: 'cancelled' as const }; },
        async cancel() { cancelled.push('agent-1'); release(); },
      }; } }; }, async resume() { throw new Error('unused'); } },
      Cursor: { async me() { return { apiKeyName: 'papilot' }; }, models: { async list() { return []; } } },
    };
    const agent = new CursorAgent(async () => waiting, path.join(dir, 'a.json'), () => true);
    await agent.start();
    const seen = events(agent);
    const { thread } = await agent.request('thread/start', { cwd: '/work' });
    const { turn } = await agent.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Wait.' }] });
    for (let i = 0; i < 50 && !seen.some(e => e.method === 'item/started'); i++) await tick();
    await agent.request('turn/interrupt', { turnId: turn.id });
    assert.equal((await completed(seen)).status, 'interrupted');
    assert.deepEqual(cancelled, ['agent-1']);
    const failing = fakeCursor(() => [], { status: 'error', error: { message: 'Usage limit reached' } });
    const broken = new CursorAgent(async () => failing.sdk, path.join(dir, 'b.json'), () => true);
    await broken.start();
    const errors = events(broken);
    const started = await broken.request('thread/start', { cwd: '/work' });
    await broken.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'Go.' }] });
    const failed = await completed(errors);
    assert.equal(failed.status, 'failed'); assert.equal(failed.error.message, 'Usage limit reached');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const CLI_MODELS = [
  { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-5-5', supportedEffortLevels: ['low', 'high'] },
  { value: 'opus', displayName: 'Opus 5.5', resolvedModel: 'claude-opus-5-5', supportedEffortLevels: ['low', 'high'] },
  { value: 'haiku', displayName: 'Haiku 5.5', resolvedModel: 'claude-haiku-5-5', supportedEffortLevels: [] },
];
function fakeClaudeCli(dir: string, login: Record<string, unknown>, turns: any[][], models: unknown[] | null = CLI_MODELS) {
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\necho '${JSON.stringify(login)}'\n`); fs.chmodSync(bin, 0o755);
  const launches: { command: string; args: string[]; cwd: string; stdin: string; child: any }[] = [];
  const launch = (command: string, args: string[], options: { cwd: string }) => {
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    const record = { command, args, cwd: options.cwd, stdin: '', child };
    child.stdin.on('data', (chunk: Buffer) => { record.stdin += chunk.toString(); });
    child.kill = (signal: string) => { child.killed = signal; setImmediate(() => child.emit('close', null, signal)); return true; };
    // The model listing answers an initialize request and is not a turn.
    if (!args.includes('--session-id') && !args.includes('--resume')) {
      child.stdin.on('data', (chunk: Buffer) => {
        const request = JSON.parse(chunk.toString().trim());
        if (models && request.request?.subtype === 'initialize') child.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { models } } }) + '\n');
        else setImmediate(() => child.emit('close', 1));
      });
      return child;
    }
    launches.push(record);
    const lines = turns.shift();
    if (lines) setImmediate(() => { for (const line of lines) child.stdout.write(JSON.stringify(line) + '\n'); child.stdout.end(); setImmediate(() => child.emit('close', 0)); });
    return child;
  };
  return { bin, launches, launch };
}

test('with Claude Code installed, Claude runs claude -p on the host login, streams items and resumes its session', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-claude-cli-'));
  const image = path.join(dir, 'figure.png');
  fs.writeFileSync(image, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  try {
    const first = [
      { type: 'system', subtype: 'init', session_id: 'x' },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'm1' } } },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Fixing.' } } },
      { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: 'Fixing.' }, { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/work/main.tex' } }] } },
      { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] } },
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.5, resetsAt: 1_800_000_000 } },
      { type: 'result', subtype: 'success', is_error: false, result: 'Done', permission_denials: [{ tool_name: 'Write', tool_input: { file_path: '/elsewhere' } }] },
    ];
    const second = [{ type: 'result', subtype: 'success', is_error: false, result: 'Done' }];
    const fake = fakeClaudeCli(dir, { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'me@example.com' }, [first, second]);
    const agent = new ClaudeAgent(async () => { throw new Error('The SDK is not used with the CLI.'); }, () => fake.bin, fake.launch as any);
    assert.equal(agent.detect(), true);
    await agent.start();
    assert.deepEqual((await agent.request('account/read')).account, { email: 'me@example.com', type: 'Claude Max' });
    // Claude Code's own list, with versions, efforts and its default.
    assert.deepEqual((await agent.request('model/list')).data.map((m: any) => [m.model, m.displayName, m.isDefault, m.supportedReasoningEfforts.length]), [['opus', 'Opus 5.5', true, 2], ['haiku', 'Haiku 5.5', false, 0]]);
    const seen = events(agent);
    const { thread } = await agent.request('thread/start', { cwd: '/work', developerInstructions: 'Only edit the worktree.', model: 'opus' });
    await agent.request('turn/start', { threadId: thread.id, effort: 'high', input: [{ type: 'text', text: 'Fix it.' }, { type: 'localImage', path: image }] });
    assert.equal((await completed(seen)).status, 'completed');
    const run = fake.launches[0];
    assert.equal(run.cwd, '/work');
    const flag = (name: string) => run.args[run.args.indexOf(name) + 1];
    assert.equal(run.args[0], '-p');
    assert.equal(flag('--permission-mode'), 'acceptEdits'); assert.equal(flag('--permission-prompts'), 'none');
    assert.equal(flag('--session-id'), thread.id); assert.equal(flag('--model'), 'opus'); assert.equal(flag('--effort'), 'high');
    assert.equal(flag('--append-system-prompt'), 'Only edit the worktree.'); assert.equal(flag('--disallowedTools'), 'AskUserQuestion');
    assert.deepEqual(JSON.parse(flag('--settings')).sandbox, { enabled: true, autoAllowBashIfSandboxed: true });
    const sent = JSON.parse(run.stdin.trim());
    assert.equal(sent.message.content[0].text, 'Fix it.'); assert.equal(sent.message.content[1].source.media_type, 'image/png');
    const items = seen.filter(e => e.method === 'item/completed').map(e => e.params.item);
    assert.deepEqual(items.map(item => item.type), ['agentMessage', 'fileChange', 'agentMessage']);
    assert.match(items[2].text, /could not use Write.*cannot ask for approval/);
    assert.equal(seen.find(e => e.method === 'item/agentMessage/delta')!.params.delta, 'Fixing.');
    assert.equal((await agent.request('account/rateLimits/read')).rateLimits.planType, 'max');
    // The next turn resumes the same session.
    const again = events(agent);
    await agent.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Shorter.' }] });
    assert.equal((await completed(again)).status, 'completed');
    assert.equal(fake.launches[1].args[fake.launches[1].args.indexOf('--resume') + 1], thread.id);
    assert.equal(fake.launches[1].args.includes('--session-id'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Claude Code that is not signed in says how to sign in, and pausing stops claude -p', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-claude-cli-'));
  try {
    const signedOut = fakeClaudeCli(dir, { loggedIn: false }, []);
    const outside = new ClaudeAgent(async () => { throw new Error('unused'); }, () => signedOut.bin, signedOut.launch as any);
    await outside.start();
    const account = await outside.request('account/read');
    assert.equal(account.account, null); assert.match(account.reason, /claude auth login/);
    const fake = fakeClaudeCli(dir, { loggedIn: true, authMethod: 'console' }, [], null);
    const agent = new ClaudeAgent(async () => { throw new Error('unused'); }, () => fake.bin, fake.launch as any);
    await agent.start();
    assert.deepEqual((await agent.request('account/read')).account, { email: undefined, type: 'API key' });
    // Without Claude Code's list, its aliases are offered.
    assert.deepEqual((await agent.request('model/list')).data.map((m: any) => m.model), ['fable', 'opus', 'sonnet', 'haiku']);
    const seen = events(agent);
    const { thread } = await agent.request('thread/start', { cwd: '/work' });
    const { turn } = await agent.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Wait.' }] });
    for (let i = 0; i < 20 && !fake.launches.length; i++) await tick();
    assert.equal(fake.launches[0].args.includes('--append-system-prompt'), false, 'no empty system prompt');
    await agent.request('turn/interrupt', { turnId: turn.id });
    assert.equal((await completed(seen)).status, 'interrupted');
    assert.equal(fake.launches[0].child.killed, 'SIGINT');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('read-only Claude reviews disable tools and project settings, including on resume', async () => {
  const fake = fakeClaude(async function* (options) {
    assert.deepEqual(options.tools, []);
    assert.deepEqual(options.settingSources, []);
    yield { type: 'result', subtype: 'success', result: '{"summary":"Looks clear.","notes":[]}', session_id: options.sessionId || options.resume };
  });
  const agent = new ClaudeAgent(fake.load, () => null);
  await agent.start();
  const seen = events(agent);
  const { thread } = await agent.request('thread/start', { cwd: '/work', sandbox: 'read-only', developerInstructions: 'Review only.' });
  await agent.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Review this text.' }] });
  assert.equal((await completed(seen)).status, 'completed');
  await agent.request('thread/resume', { threadId: thread.id, cwd: '/work', sandbox: 'read-only', developerInstructions: 'Review only.' });
  const resumed = events(agent);
  await agent.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Check assumptions too.' }] });
  assert.equal((await completed(resumed)).status, 'completed');
  agent.close();
});

test('read-only Claude CLI reviews disable tool access and project settings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-review-cli-'));
  try {
    const fake = fakeClaudeCli(dir, { loggedIn: true, authMethod: 'claude.ai' }, [[{ type: 'result', subtype: 'success', is_error: false, result: '{"summary":"Clear.","notes":[]}' }]]);
    const agent = new ClaudeAgent(async () => { throw new Error('No SDK needed'); }, () => fake.bin, fake.launch as any);
    await agent.start();
    const seen = events(agent);
    const { thread } = await agent.request('thread/start', { cwd: '/work', sandbox: 'read-only', developerInstructions: 'Review only.' });
    await agent.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Review the supplied text.' }] });
    assert.equal((await completed(seen)).status, 'completed');
    const args = fake.launches[0].args;
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.equal(args[args.indexOf('--setting-sources') + 1], '');
    agent.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
