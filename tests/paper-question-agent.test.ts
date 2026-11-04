import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/server/store.ts';
import type { AgentRuntime } from '../src/server/agents.ts';

test('Q&A uses full access in the selected paper without creating an editing task', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-question-agent-'));
  process.env.PAPILOT_DATA = path.join(root, 'data');
  const { Workspace } = await import('../src/server/workspace.ts');
  class Agent extends EventEmitter {
    ready = true;
    calls: { method: string; params: any }[] = [];
    rejections: string[] = [];
    async request(method: string, params: any): Promise<any> {
      this.calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'question-thread' } };
      if (method === 'turn/start') {
        setImmediate(() => {
          const start = this.calls.find(call => call.method === 'thread/start')!.params;
          assert.equal(start.sandbox, 'danger-full-access');
          fs.writeFileSync(path.join(start.cwd, 'answer.txt'), 'Requested test edit.');
          this.emit('notification', { method: 'item/completed', params: { threadId: 'question-thread', item: { type: 'agentMessage', text: 'The method groups related skills. See main.tex:1.' } } });
          this.emit('notification', { method: 'turn/completed', params: { threadId: 'question-thread', turn: { id: 'answer-turn', status: 'completed' } } });
        });
        return { turn: { id: 'answer-turn' } };
      }
      return {};
    }
    reject(_id: unknown, message: string) { this.rejections.push(message); }
    respond() {}
    close() {}
  }
  const store = new Store(':memory:'), agent = new Agent();
  const workspace = new Workspace(store, agent as unknown as AgentRuntime, async () => { throw Error('Q&A must not contact the review engine.'); });
  try {
    const paper = path.join(root, 'paper'); fs.mkdirSync(paper); fs.writeFileSync(path.join(paper, 'main.tex'), 'Hierarchical skill induction.');
    store.saveProject({ id: 'paper', path: paper, name: 'Skills', createdAt: 1 });
    workspace.runtimes.codex.authenticated = true;
    workspace.runtimes.codex.models = [{ id: 'reasoning', name: 'Reasoning', isDefault: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }];
    workspace.questions.submit('paper', 'owner', { id: 'q1', question: 'Explain the method.', agent: 'codex', model: 'reasoning', effort: 'high' });
    assert.equal(workspace.busyForUpdate, true);
    await workspace.questions.settled();
    const start = agent.calls.find(call => call.method === 'thread/start')!.params;
    assert.equal(start.sandbox, 'danger-full-access'); assert.equal(start.approvalPolicy, 'never'); assert.equal(start.ephemeral, true);
    assert.equal(start.config.web_search, 'live');
    assert.equal(agent.calls.find(call => call.method === 'turn/start')!.params.effort, 'high');
    assert.equal(store.questions('paper', 'owner')[0].effort, 'high');
    assert.equal(start.cwd, paper);
    assert.equal(fs.readFileSync(path.join(paper, 'answer.txt'), 'utf8'), 'Requested test edit.');
    assert.match(start.developerInstructions, /paper Q&A assistant/);
    assert.match(start.developerInstructions, /full tool access/);
    assert.equal(agent.rejections.length, 0);
    assert.equal(store.questions('paper', 'owner')[0].status, 'completed');
    assert.deepEqual(store.tasks(), []); assert.deepEqual(store.runs(), []);
    assert.equal(fs.readFileSync(path.join(paper, 'main.tex'), 'utf8'), 'Hierarchical skill induction.');
    assert.equal(workspace.busyForUpdate, false);
    workspace.questions.submit('paper', 'owner', { id: 'unsupported', question: 'Explain more.', agent: 'codex', model: 'reasoning', effort: 'ultra' });
    await workspace.questions.settled();
    assert.match(store.question('paper', 'owner', 'unsupported')!.error!, /supported by this model/);
    workspace.runtimes.codex.authenticated = false;
    workspace.questions.submit('paper', 'owner', { id: 'q2', question: 'Another question.', agent: 'codex' });
    await workspace.questions.settled();
    assert.match(store.question('paper', 'owner', 'q2')!.error!, /Sign in to Codex/);
    assert.equal(agent.calls.filter(call => call.method === 'thread/start').length, 1);
  } finally { workspace.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
