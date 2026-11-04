import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/server/store.ts';
import { PaperQuestions, questionContext } from '../src/server/paper-questions.ts';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-questions-test-'));
  const paper = path.join(root, 'paper'); fs.mkdirSync(paper);
  fs.writeFileSync(path.join(paper, 'main.tex'), 'A paper about hierarchical skills.\nThe loss decreases with training.');
  const store = new Store(path.join(root, 'state.sqlite'));
  store.saveProject({ id: 'paper', path: paper, name: 'Skills', createdAt: 1 });
  return { root, paper, store, close: () => { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const input = { id: 'q1', question: 'What does the loss mean?', agent: 'codex' as const };

test('questions are persisted separately, duplicate requests run once, and follow-ups use current sources', async () => {
  const f = fixture(), prompts: any[] = [];
  let resolve!: (answer: string) => void, held = 0;
  const questions = new PaperQuestions(f.store, async ({ prompt }) => { prompts.push(JSON.parse(prompt)); return new Promise<string>(done => { resolve = done; }); }, () => { held++; return () => { held--; }; });
  try {
    const original = fs.readFileSync(path.join(f.paper, 'main.tex'), 'utf8');
    assert.equal(questions.submit('paper', 'owner', input).status, 'running');
    assert.equal(questions.submit('paper', 'owner', input).id, 'q1');
    assert.throws(() => questions.submit('paper', 'owner', { ...input, id: 'q2' }), /Wait for/);
    assert.throws(() => questions.submit('paper', 'owner', { ...input, question: 'Different question' }), /already been used/);
    while (!resolve) await new Promise(done => setImmediate(done));
    assert.equal(prompts.length, 1); assert.equal(held, 1);
    assert.match(prompts[0].manuscript.sources[0].lines, /1: A paper/);
    assert.equal(prompts[0].manuscript.sources[0].file, 'main.tex');
    assert.equal(JSON.stringify(prompts[0]).includes(f.paper), false);
    resolve('It measures prediction error.'); await questions.settled();
    assert.equal(held, 0); assert.equal(questions.list('paper', 'owner')[0].answer, 'It measures prediction error.');
    assert.equal(fs.readFileSync(path.join(f.paper, 'main.tex'), 'utf8'), original);
    assert.equal(f.store.tasks().length, 0); assert.equal(f.store.runs().length, 0);
    fs.writeFileSync(path.join(f.paper, 'main.tex'), original + '\nNew experimental result.');
    resolve = undefined!;
    questions.submit('paper', 'owner', { ...input, id: 'q2', question: 'Why does it decrease?' });
    while (!resolve) await new Promise(done => setImmediate(done));
    assert.deepEqual(prompts[1].recentConversation, [{ question: input.question, answer: 'It measures prediction error.' }]);
    assert.match(prompts[1].manuscript.sources[0].lines, /New experimental result/);
    resolve('Training improves predictions.'); await questions.settled();
    assert.equal(questions.list('paper', 'someone-else').length, 0);
  } finally { questions.close(); f.close(); }
});

test('failures retain questions, require explicit retry, and reject empty answers', async () => {
  const f = fixture(); let calls = 0;
  const questions = new PaperQuestions(f.store, async () => { calls++; if (calls === 1) throw Error('Agent disconnected.'); return calls === 2 ? '   ' : 'Recovered answer.'; });
  try {
    questions.submit('paper', 'owner', input); await questions.settled();
    assert.equal(questions.list('paper', 'owner')[0].error, 'Agent disconnected.');
    questions.submit('paper', 'owner', input); await questions.settled(); assert.equal(calls, 1);
    questions.submit('paper', 'owner', { ...input, retry: true }); await questions.settled();
    assert.match(questions.list('paper', 'owner')[0].error!, /no answer/);
    questions.submit('paper', 'owner', { ...input, retry: true }); await questions.settled();
    assert.equal(questions.list('paper', 'owner').length, 1);
    assert.equal(questions.list('paper', 'owner')[0].answer, 'Recovered answer.');
    assert.throws(() => questions.submit('paper', 'owner', { ...input, id: 'q3', question: '  ' }), /Enter a question/);
    assert.throws(() => questions.submit('paper', 'owner', { ...input, id: 'q3', question: 'x'.repeat(20001) }), /20000/);
    assert.throws(() => questions.submit('paper', 'owner', { ...input, id: 'q3', agent: 'antigravity' }), /Codex, Claude, or GLM/);
  } finally { f.close(); }
});

test('question histories are isolated by paper and viewer and survive a server restart', async () => {
  const f = fixture();
  const questions = new PaperQuestions(f.store, async ({ prompt }) => JSON.parse(prompt).question);
  try {
    const other = path.join(f.root, 'other'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'main.tex'), 'Other paper.');
    f.store.saveProject({ id: 'other', path: other, name: 'Other', createdAt: 1 });
    questions.submit('paper', 'owner', input);
    questions.submit('paper', 'guest', { ...input, question: 'Private guest question' });
    questions.submit('other', 'owner', { ...input, question: 'Other paper question' });
    await questions.settled();
    assert.equal(questions.list('paper', 'owner')[0].question, input.question);
    assert.equal(questions.list('paper', 'guest')[0].question, 'Private guest question');
    assert.equal(questions.list('other', 'owner')[0].question, 'Other paper question');
    f.store.saveQuestion({ ...questions.list('paper', 'owner')[0], id: 'interrupted', status: 'running' });
    f.store.close();
    const reopened = new Store(path.join(f.root, 'state.sqlite')); reopened.recover();
    assert.equal(reopened.questions('paper', 'owner')[0].answer, input.question);
    assert.equal(reopened.question('paper', 'owner', 'interrupted')?.status, 'failed');
    reopened.removeProject('other'); assert.deepEqual(reopened.questions('other', 'owner'), []);
    reopened.close();
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('manuscript context is bounded and excludes hidden files, build output and symlinks', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, 'secret.txt'), 'outside secret');
    fs.symlinkSync(path.join(f.root, 'secret.txt'), path.join(f.paper, 'linked.txt'));
    fs.symlinkSync(f.root, path.join(f.paper, 'linked-directory'));
    fs.mkdirSync(path.join(f.paper, '.private')); fs.writeFileSync(path.join(f.paper, '.private/secret.txt'), 'hidden secret');
    fs.mkdirSync(path.join(f.paper, 'build')); fs.writeFileSync(path.join(f.paper, 'build/output.txt'), 'generated output');
    fs.writeFileSync(path.join(f.paper, 'long.tex'), 'x'.repeat(200000));
    const context = await questionContext(f.paper, 100);
    assert.equal(context.truncated, true);
    assert.ok(context.sources.reduce((sum, source) => sum + source.lines.length, 0) <= 100);
    assert.equal(context.sources[0].file, 'main.tex');
    assert.doesNotMatch(JSON.stringify(context), /outside secret|hidden secret|generated output|linked/);
  } finally { f.close(); }
});


test('question effort persists, is used for retry and participates in request identity', async () => {
  const f = fixture(); const efforts: string[] = [];
  const questions = new PaperQuestions(f.store, async ({ effort }) => { efforts.push(effort); if (efforts.length === 1) throw Error('Disconnected'); return 'Retried'; });
  try {
    questions.submit('paper', 'owner', { ...input, effort: 'high' }); await questions.settled();
    assert.equal(f.store.question('paper', 'owner', input.id)?.effort, 'high');
    assert.throws(() => questions.submit('paper', 'owner', { ...input, effort: 'low', retry: true }), /already been used/);
    questions.submit('paper', 'owner', { ...input, effort: 'high', retry: true }); await questions.settled();
    assert.deepEqual(efforts, ['high', 'high']);
    questions.submit('paper', 'owner', { ...input, id: 'default-effort' }); await questions.settled();
    assert.equal(efforts.at(-1), '');
    assert.throws(() => questions.submit('paper', 'owner', { ...input, id: 'bad-effort', effort: 42 as any }), /valid reasoning effort/);
  } finally { questions.close(); f.close(); }
});
