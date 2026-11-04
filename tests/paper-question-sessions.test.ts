import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/store.ts';
import { PaperQuestions } from '../src/server/paper-questions.ts';

test('legacy questions migrate without loss and sessions survive reopening', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-session-'));
  const file = path.join(root, 'state.sqlite');
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE paper_questions(project_id TEXT,owner_id TEXT,id TEXT,created INTEGER,data TEXT,PRIMARY KEY(project_id,owner_id,id))');
  for (let i = 0; i < 105; i++) old.prepare('INSERT INTO paper_questions VALUES(?,?,?,?,?)').run('paper', 'owner', `q${i}`, i + 1, JSON.stringify({ id: `q${i}`, projectId: 'paper', ownerId: 'owner', question: `Question ${i}`, answer: `Answer ${i}`, createdAt: i + 1, status: 'completed', agent: 'codex' }));
  old.close();
  try {
    for (let pass = 0; pass < 2; pass++) {
      const store = new Store(file);
      try {
        assert.equal(store.questionSessions('paper', 'owner').length, 1);
        assert.equal(store.questionSessions('paper', 'owner')[0].title, 'Question 0');
        for (let i = 0; i < 105; i++) {
          assert.equal(store.question('paper', 'owner', `q${i}`)?.answer, `Answer ${i}`);
          assert.equal(store.question('paper', 'owner', `q${i}`)?.sessionId, 'default');
        }
        assert.equal(store.questionSessions('paper', 'guest').length, 0);
      } finally { store.close(); }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('sessions isolate prompts, concurrent answers, ownership and deletion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-session-'));
  fs.writeFileSync(path.join(root, 'main.tex'), 'Paper text.');
  const store = new Store(path.join(root, 'state.sqlite'));
  store.saveProject({ id: 'paper', path: root, name: 'Paper', createdAt: 1 });
  const prompts: any[] = [], resolves = new Map<string, (value: string) => void>();
  const service = new PaperQuestions(store, async ({ prompt }) => {
    const data = JSON.parse(prompt); prompts.push(data);
    return new Promise<string>(resolve => resolves.set(data.question, resolve));
  });
  const send = (id: string, sessionId: string) => service.submit('paper', 'owner', { id, sessionId, question: id, agent: 'codex' });
  const waitFor = async (question: string) => {
    for (let i = 0; i < 100 && !resolves.has(question); i++) await new Promise(done => setTimeout(done, 5));
    assert.ok(resolves.has(question));
  };
  try {
    const first = service.createSession('paper', 'owner', 'one');
    assert.deepEqual(service.createSession('paper', 'owner', 'one'), first);
    service.createSession('paper', 'owner', 'two');
    assert.throws(() => service.list('paper', 'guest', 'one'), /not found/);
    assert.throws(() => service.createSession('paper', 'owner', '../bad'), /valid/);
    assert.throws(() => send('missing', 'missing'), /not found/);
    send('q1', 'one'); send('q2', 'two');
    await waitFor('q1'); await waitFor('q2');
    assert.equal(service.sessions('paper', 'owner').filter(s => s.running).length, 2);
    resolves.get('q2')!('Answer two'); resolves.get('q1')!('Answer one'); await service.settled();
    assert.equal(service.list('paper', 'owner', 'one')[0].answer, 'Answer one');
    assert.equal(service.list('paper', 'owner', 'two')[0].answer, 'Answer two');
    assert.throws(() => send('q1', 'two'), /already been used/);
    send('followup', 'one'); await waitFor('followup');
    assert.deepEqual(prompts.at(-1).recentConversation, [{ question: 'q1', answer: 'Answer one' }]);
    resolves.get('followup')!('Follow-up answer'); await service.settled();
    assert.equal(service.sessions('paper', 'owner').find(s => s.id === 'one')?.title, 'q1');
    assert.equal(store.tasks().length, 0);
    store.removeProject('paper');
    assert.deepEqual(store.questionSessions('paper', 'owner'), []);
    assert.deepEqual(store.questions('paper', 'owner', 'one'), []);
  } finally { service.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('deleting a conversation removes only its history and prevents stale default requests from restoring it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-session-delete-'));
  const file = path.join(root, 'state.sqlite');
  const store = new Store(file);
  store.saveProject({ id: 'paper', name: 'Paper', path: root, createdAt: 1 });
  let finish!: (answer: string) => void;
  const service = new PaperQuestions(store, () => new Promise(resolve => { finish = resolve; }));
  try {
    service.sessions('paper', 'owner');
    service.createSession('paper', 'owner', 'keep');
    service.createSession('paper', 'guest', 'keep');
    service.submit('paper', 'owner', { id: 'q', sessionId: 'default', agent: 'codex', question: 'Explain.' });
    assert.throws(() => service.removeSession('paper', 'owner', 'default'), /Wait for the answer/);
    for (let n = 0; n < 100 && !finish; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(finish); finish('Answer.'); await service.settled();
    assert.equal(service.removeSession('paper', 'owner', 'default')[0].id, 'keep');
    assert.equal(store.question('paper', 'owner', 'q'), undefined);
    assert.throws(() => service.list('paper', 'owner', 'default'), /not found/);
    assert.throws(() => service.submit('paper', 'owner', { id: 'stale', agent: 'codex', question: 'Stale request.' }), /not found/);
    service.removeSession('paper', 'owner', 'default'); // Retrying a completed deletion is safe.
    const remaining = service.removeSession('paper', 'owner', 'keep');
    assert.equal(remaining.length, 1); assert.notEqual(remaining[0].id, 'default'); assert.notEqual(remaining[0].id, 'keep');
    assert.ok(store.questionSession('paper', 'guest', 'keep'));
    assert.throws(() => service.removeSession('missing', 'owner', 'keep'));
    assert.throws(() => service.removeSession('paper', 'owner', '../invalid'), /valid/);
  } finally { service.close(); store.close(); }
  const reopened = new Store(file);
  try { assert.equal(reopened.questionSession('paper', 'owner', 'default'), undefined); assert.deepEqual(reopened.questions('paper', 'owner', 'default'), []); }
  finally { reopened.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
