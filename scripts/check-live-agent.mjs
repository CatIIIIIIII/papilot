// Opt-in only: this uses an already authenticated subscription and makes real turns.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const agent = process.env.PAPILOT_LIVE_AGENT;
if (!['codex', 'claude'].includes(agent)) throw new Error('Set PAPILOT_LIVE_AGENT=codex or claude to explicitly enable subscription testing.');
if (Object.keys(process.env).some(key => /^(OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_USE_)/.test(key) && process.env[key])) throw new Error('API/cloud billing is not allowed for this test.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), `papilot-live-${agent}-`));
process.env.PAPILOT_DATA = path.join(root, 'data');
const { Store } = await import('../src/server/store.ts');
const { Workspace } = await import('../src/server/workspace.ts');
const { findSkill } = await import('../src/server/skills.ts');
const { Codex } = await import('../src/server/codex.ts');
const { reviewClient } = await import('../src/server/review.ts');
const paper = path.join(root, 'paper'); fs.mkdirSync(paper);
fs.writeFileSync(path.join(paper, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nThe original sentence.\n\\end{document}\n');
fs.writeFileSync(path.join(paper, '.latex-review.json'), JSON.stringify({ main: 'main.tex', engine: 'pdflatex' }));
for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Papilot Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Fixture']]) execFileSync('git', args, { cwd: paper, stdio: 'ignore' });
fs.mkdirSync(process.env.PAPILOT_DATA);
const database = path.join(process.env.PAPILOT_DATA, 'papilot.sqlite');
let store = new Store(database), workspace = new Workspace(store, new Codex(process.env.PAPILOT_CODEX_BIN || 'codex'));
let client;
const evidence = { agent, root, protocol: [], events: {}, checks: [] };
function observe() {
  const runtime = workspace.agents[agent], request = runtime.request.bind(runtime);
  runtime.request = async (method, params, timeout) => {
    const result = await request(method, params, timeout);
    if (/^(thread\/(start|resume)|turn\/(start|interrupt))$/.test(method)) evidence.protocol.push({ method, requestedModel: params.model, effort: params.effort, actualModel: result.model, thread: result.thread?.id });
    return result;
  };
  runtime.on('notification', message => { evidence.events[message.method] = (evidence.events[message.method] || 0) + 1; });
}
async function connect() {
  await workspace.connectAgent(agent);
  assert.equal(workspace.runtimes[agent].authenticated, true);
  const runtime = workspace.agents[agent];
  if (agent === 'codex') {
    const account = await runtime.request('account/read', {}), config = (await runtime.request('config/read', { includeLayers: false })).config;
    assert.equal(account.account?.type, 'chatgpt');
    const provider = config.model_providers?.[config.model_provider];
    assert.ok(!provider?.base_url && !provider?.env_key && !provider?.experimental_bearer_token, 'Custom billing provider is not allowed');
    const limits = (await runtime.request('account/rateLimits/read', {})).rateLimits;
    assert.ok(limits?.primary && limits.primary.usedPercent < 80, 'Subscription quota is not confirmed available');
  } else {
    const status = JSON.parse(execFileSync(process.env.PAPILOT_CLAUDE_BIN || 'claude', ['auth', 'status', '--json'], { encoding: 'utf8' }));
    assert.equal(status.authMethod, 'claude.ai'); assert.equal(status.apiProvider, 'firstParty'); assert.ok(['pro', 'max'].includes(status.subscriptionType));
  }
}
async function wait(id) {
  const until = Date.now() + 180000;
  while (Date.now() < until) {
    const task = store.task(id);
    if (workspace.requests.size) throw new Error('Approval needs manual review; no command was auto-approved by the test.');
    if (['failed', 'uncertain', 'waiting_input'].includes(task.status)) throw new Error(task.error || task.status);
    if (task.status === 'reviewing' && task.review?.round && !store.runs().some(run => run.taskId === id && ['queued', 'running'].includes(run.status))) return task;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Live task timed out');
}
try {
  observe(); await connect();
  const models = workspace.runtimes[agent].models; evidence.models = models;
  const selected = process.env.PAPILOT_LIVE_MODEL;
  if (selected) assert.ok(models.some(model => model.id === selected), 'The requested live model is unavailable');
  const project = await workspace.addProject(paper, 'Subscription integration fixture');
  const created = await workspace.createTask({ id: randomUUID(), projectId: project.id, agent, ...(selected ? { model: selected } : {}), title: 'Live integration', instructions: 'Read main.tex. Change only "The original sentence." to "The revised sentence." Do not run git or network commands. Then reply briefly.' });
  let task = await wait(created.id);
  assert.match(fs.readFileSync(path.join(task.worktree, 'main.tex'), 'utf8'), /The revised sentence/);
  assert.ok(evidence.events['item/agentMessage/delta'] > 0, 'Real streaming reply was not observed');
  evidence.checks.push('default-model', 'streaming', 'read-edit', 'compile', 'review');
  client = await reviewClient(paper);
  const review = await client.get(`/api/tasks/${task.name}/rounds/${task.review.round}`);
  evidence.reviewKeys = Object.keys(review);
  // A second real turn exercises a persisted explicit model and effort after restart.
  const other = models.find(model => model.id !== task.model && /haiku|luna|mini/i.test(model.id)) || models.find(model => model.id !== task.model);
  if (other) workspace.updateTaskModel(task.id, { model: other.id, ...(other.efforts.length ? { effort: other.efforts[0] } : {}) });
  workspace.close(); await new Promise(resolve => setTimeout(resolve, 300)); store.close();
  store = new Store(database); store.recover(); workspace = new Workspace(store, new Codex(process.env.PAPILOT_CODEX_BIN || 'codex'));
  observe(); await connect();
  await workspace.enqueue(task.id, 'Read main.tex and change "The revised sentence." to "The final sentence." Do not change other files.', randomUUID());
  task = await wait(task.id);
  assert.match(fs.readFileSync(path.join(task.worktree, 'main.tex'), 'utf8'), /The final sentence/);
  evidence.checks.push('continued-conversation', 'restart-resume', ...(other ? ['model-switch', 'effort'] : []));
  if (process.env.PAPILOT_LIVE_EXTENDED === '1') {
    const folder = path.join(paper, '.papilot/skills'); fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'vision-fixture.md'), '---\nname: Vision fixture\ndescription: Identify a supplied square\n---\nRead the attached image. Replace only the final sentence in main.tex with "The square is COLOR." using the actual color in lowercase. Do not change other files.');
    const attachment = await workspace.attachments.upload(project.id, 'owner', 'square.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC', 'base64'));
    await workspace.enqueue(task.id, 'Apply the selected skill to the attached image.', randomUUID(), false, { skill: findSkill(paper, 'vision-fixture'), attachments: [attachment.id] });
    task = await wait(task.id);
    assert.match(fs.readFileSync(path.join(task.worktree, 'main.tex'), 'utf8'), /The square is red/);
    evidence.checks.push('image-attachment', 'paper-skill');
    await workspace.enqueue(task.id, 'Do not edit files. Write a very long explanation of LaTeX line breaking, at least 3000 words.', randomUUID());
    const until = Date.now() + 30000;
    while (!store.task(task.id).turnId && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(store.task(task.id).turnId, 'No running turn to stop');
    await workspace.interrupt(task.id);
    const stoppedBy = Date.now() + 30000;
    while (store.task(task.id).status === 'running' && Date.now() < stoppedBy) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(store.task(task.id).status, 'interrupted');
    evidence.checks.push('stop-real-turn');
  }
  evidence.passed = true;
} catch (error) { evidence.passed = false; evidence.error = String(error); process.exitCode = 1; }
finally {
  workspace.close(); await new Promise(resolve => setTimeout(resolve, 300)); store.close();
  if (client) await client.post('/api/shutdown', {}).catch(() => {});
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
