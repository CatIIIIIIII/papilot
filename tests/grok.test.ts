import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { GrokAgent } from '../src/server/grok.ts';

test('Grok launches native wrappers and resumes with restricted permissions in a fresh worker', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot grok 中文 & '));
  const entry = path.join(dir, 'fixture.cjs'), log = path.join(dir, 'calls.jsonl');
  const wrapper = path.join(dir, process.platform === 'win32' ? 'grok.cmd' : 'grok');
  fs.writeFileSync(entry, `
    const fs = require('node:fs');
    const readline = require('node:readline');
    if (process.env.PAPILOT_GROK_FIXTURE !== 'prepared') process.exit(2);
    const record = value => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, ...value }) + '\\n');
    const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
    const sessions = new Map();
    let serial = 0;
    record({ method: 'started', args: process.argv.slice(2) });
    const input = readline.createInterface({ input: process.stdin });
    input.on('close', () => process.exit(0));
    setTimeout(() => process.exit(3), 15000).unref();
    input.on('line', line => {
      const { id, method, params } = JSON.parse(line);
      if (method === 'initialize') return send({ id, result: { protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } }, authMethods: [{ id: 'xai.api_key' }] } });
      if (method === 'session/new' || method === 'session/resume') {
        const sessionId = params.sessionId || 'session-' + process.pid + '-' + (++serial);
        sessions.set(sessionId, params._meta);
        record({ method, sessionId, cwd: params.cwd, meta: params._meta });
        return send({ id, result: { sessionId } });
      }
      if (method === 'session/prompt') {
        record({ method, sessionId: params.sessionId, meta: sessions.get(params.sessionId), prompt: params.prompt });
        send({ method: 'session/update', params: { sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } } } });
        return send({ id, result: { stopReason: 'end_turn' } });
      }
      if (id !== undefined) send({ id, result: {} });
    });
  `);
  // A custom launcher must run its setup, not just its embedded Node command.
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  fs.writeFileSync(wrapper, process.platform === 'win32'
    ? `@echo off\r\nset "PAPILOT_GROK_FIXTURE=prepared"\r\n"${process.execPath}" "${entry}" %*\r\n`
    : `#!/bin/sh\nexport PAPILOT_GROK_FIXTURE=prepared\nexec ${quote(process.execPath)} ${quote(entry)} "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  const agent = new GrokAgent(wrapper);
  const records = (): any[] => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const prompt = '修改论文 & 保留 "quoted" text\nNext line.';
  try {
    await agent.start();
    const { thread } = await agent.request('thread/start', { cwd: dir, taskPermissions: 'full', developerInstructions: 'Only edit this paper.' });
    for (const taskPermissions of ['full', 'workspace']) {
      const completed = new Promise<any>(resolve => {
        const listener = (message: any) => {
          if (message.method !== 'turn/completed') return;
          agent.off('notification', listener);
          resolve(message.params.turn);
        };
        agent.on('notification', listener);
      });
      await agent.request('turn/start', { threadId: thread.id, taskPermissions, input: [{ type: 'text', text: prompt }] });
      assert.equal((await completed).status, 'completed');
    }
    const calls = records(), prompts = calls.filter(call => call.method === 'session/prompt');
    assert.equal(prompts.length, 2);
    assert.deepEqual(prompts.map(call => call.sessionId), [thread.id, thread.id]);
    assert.notEqual(prompts[0].pid, prompts[1].pid, 'revoking YOLO must use a fresh process');
    assert.deepEqual(prompts.map(call => call.meta), [{ yoloMode: true, autoMode: false }, { yoloMode: false, autoMode: false }]);
    assert.equal(prompts[0].prompt[0].text, 'Only edit this paper.\n\n---\n\n' + prompt);
    assert.equal(prompts[1].prompt[0].text, prompt);
    const resumed = calls.find(call => call.method === 'session/resume');
    assert.equal(resumed.sessionId, thread.id);
    assert.equal(resumed.cwd, dir);
    const launches = calls.filter(call => call.method === 'started');
    assert.equal(launches.length, 3, 'discovery and each task worker use the same launcher');
    for (const call of launches) assert.deepEqual(call.args, ['--no-auto-update', 'agent', '--no-leader', 'stdio']);
  } finally {
    agent.close();
    // Closing stdin must also end a wrapper's child, before removing its files.
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const pids = records().filter(call => call.method === 'started').map(call => call.pid);
    const deadline = performance.now() + 10000;
    while (pids.some(alive) && performance.now() < deadline) await delay(20);
    try { assert.equal(pids.some(alive), false, 'fixture processes must exit after closing the agent'); }
    finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  }
});
