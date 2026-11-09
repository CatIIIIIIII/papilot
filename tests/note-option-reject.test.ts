import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Fixture, fakeRound, METHOD } from '../engine/tests/ts/helpers.ts';
import { createServer } from '../engine/src/server.ts';
import { Client } from '../engine/src/client.ts';
import { Store } from '../src/server/store.ts';
import { Workspace } from '../src/server/workspace.ts';
import { Manuscripts } from '../src/server/manuscript.ts';
import { buildApp, gitQueue } from '../src/server/app.ts';
import { noteOptionsKey } from '../src/server/note-options.ts';
import type { Codex } from '../src/server/codex.ts';
import type { Task } from '../src/shared.ts';

class Agent extends EventEmitter { ready = false; close() {} }
test('rejecting a note restores its source even when previewing an alternative; neighboring edits and undo survive', async () => {
  const f = new Fixture(), engine = f.app(); await engine.ready;
  const task = engine.tasks.create('reject-note', 'Reject a note', [], ['paper'], true);
  f.edit(task, METHOD, 'Method sentence 2.', 'Approach sentence two.');
  f.edit(task, METHOD, 'Detail sentence 15.', 'Detail proposal 15.');
  const round = fakeRound(engine, task.name);
  const word = round.units.find(unit => unit.new_text === 'Approach')!, neighbor = round.units.find(unit => unit.new_text === 'two')!, accepted = round.units.find(unit => unit.new_text === 'proposal')!;
  await engine.review.decide(task.name, { id: 'accept-neighbor', round: 1, changes: [accepted.id], action: 'accept' });
  const server = createServer(engine); await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address() as { port: number };
  const transport = new Client(`http://127.0.0.1:${address.port}`, engine.csrf);
  engine.url = transport.url;
  const detail = { ...round, units: round.units.map(unit => {
    const lines = engine.repo.blob(round.before, unit.file)!.toString().split('\n');
    const start = lines.slice(0, unit.old_start - 1).map(line => line + '\n').join('').length;
    return { ...unit, old_context: { text: lines[unit.old_start - 1], start } };
  }), sections: [], loose: round.units.map(unit => ({ kind: 'change', units: [unit.id] })) };
  const previews: unknown[] = [];
  const client = { url: transport.url, token: transport.token, get: async <T>(route: string) => route.includes('/rounds/') ? { ...detail, round: 1 } as T : transport.get<T>(route), post: async <T>(route: string, body?: unknown) => {
    if (route.endsWith('/source/options/preview')) { previews.push(body); return { ...detail, round: 1, after: 'respects-rejection' } as T; }
    return transport.post<T>(route, body);
  } };
  const store = new Store(':memory:');
  const workspace = new Workspace(store, new Agent() as unknown as Codex, async () => client);
  store.saveProject({ id: 'paper', name: 'Paper', path: f.root, createdAt: 1 });
  store.saveTask({ id: 'task', projectId: 'paper', name: task.name, title: task.title, worktree: task.worktree, instructions: '', status: 'reviewing', createdAt: 1, updatedAt: 1, feedbackCursor: 0, review: { round: 1 }, error: null } as Task);
  store.saveRun({ id: 'run', taskId: 'task', requestKey: 'run', prompt: '', status: 'completed', createdAt: 1, finishedAt: 2, reviewRound: 1 });
  store.saveItem({ id: 'run', taskId: 'task', type: 'user', text: '', createdAt: 1, meta: { notes: [{ where: `${METHOD} line ${word.old_start}`, quote: 'Method', comment: 'Improve wording.' }] } });
  store.savePreference(noteOptionsKey('task', 'run:0', 1), { key: 'run:0', round: 1, options: [
    { id: 'current', label: 'Main', edits: [{ unit: word.id, text: word.new_text }] },
    { id: 'alternative', label: 'Alternative', reason: 'Another wording.', edits: [{ unit: word.id, text: 'Procedure' }] },
  ] });
  const local = await buildApp({ listener: { kind: 'local', port: 7274, publicOrigin: '', owner: '' }, store, workspace, manuscripts: new Manuscripts(), csrf: 'test-csrf', serialGit: gitQueue(), dist: null, version: 'test', connectReview: async () => client });
  const headers = { host: '127.0.0.1:7274', origin: 'http://127.0.0.1:7274', 'x-papilot-token': 'test-csrf' };
  try {
    const options = async () => (await local.inject({ method: 'GET', url: '/api/tasks/task/note-options?key=run:0', headers })).json();
    const initialKey = (await options()).comparisonKey;
    await engine.review.decide(task.name, { id: 'reject-other', round: 1, changes: [neighbor.id], action: 'reject' });
    const rejectedKey = (await options()).comparisonKey;
    assert.notEqual(rejectedKey, initialKey, 'Another note’s rejection invalidates this note’s previews');
    const url = '/api/tasks/task/note-options/preview?key=run:0&round=1&option=current&comparison=';
    assert.equal((await local.inject({ method: 'GET', url: url + initialKey, headers })).statusCode, 400, 'Stale background requests cannot poison a previous cache entry');
    const currentPreview = await local.inject({ method: 'GET', url: url + rejectedKey, headers });
    assert.equal(currentPreview.statusCode, 200, currentPreview.body);
    assert.equal(currentPreview.json().after, 'respects-rejection', 'Current proposal also uses a decision-aware preview');
    assert.equal(previews.length, 1);
    assert.deepEqual((previews[0] as { rejected: string[] }).rejected, [neighbor.id], 'The engine must validate the same rejection state as the browser comparison key');
    await engine.review.undo(task.name, 'reject-other');
    assert.equal((await options()).comparisonKey, initialKey, 'Undo restores the reusable preview identity');
    for (const option of ['current', 'alternative']) {
      const request = { method: 'POST' as const, url: '/api/tasks/task/note-options', headers, payload: { key: 'run:0', round: 1, option, reject: true, id: 'reject-' + option } };
      const response = await local.inject(request);
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(response.json().locked);
      const replay = await local.inject(request);
      assert.equal(replay.statusCode, 200, 'A lost successful response can be retried with the same action ID: ' + replay.body);
      assert.equal(engine.store.all('SELECT id FROM actions WHERE id=?', request.payload.id).length, 1);
      const changed = await local.inject({ ...request, payload: { ...request.payload, reject: false, accept: true } });
      assert.equal(changed.statusCode, 400, 'The action ID cannot authorize a different decision');
      const duplicate = await local.inject({ ...request, payload: { ...request.payload, id: request.payload.id + '-new' } });
      assert.equal(duplicate.statusCode, 400, 'A new ID cannot re-decide reviewed source');
      assert.match(f.read(METHOD, task.worktree), /Method sentence two\./, 'Only the note’s wording is restored');
      assert.match(f.read(METHOD, task.worktree), /Detail proposal 15\./, 'The accepted neighbor stays accepted');
      const decisions = engine.review.decisions(task.name, round);
      assert.equal(decisions[word.id], 'rejected');
      assert.equal(decisions[neighbor.id], 'pending');
      assert.equal(decisions[accepted.id], 'accepted');
      assert.equal(engine.store.all('SELECT id FROM jobs').length, 0, 'Rejecting never compiles or applies a preview');
      assert.equal(engine.review.latestRound(task.name)?.number, 1);
      assert.equal(store.items('task').length, 1, 'No rejection feedback draft or chat message is created');
      await transport.post(`/api/tasks/${task.name}/undo`, { id: 'reject-' + option });
      assert.match(f.read(METHOD, task.worktree), /Approach sentence two\./);
      assert.equal(engine.review.decisions(task.name, round)[word.id], 'pending');
      const undone = await local.inject(request);
      assert.equal(undone.statusCode, 400, 'A late retry must not repeat an undone decision');
      assert.equal(engine.review.decisions(task.name, round)[word.id], 'pending');
    }
  } finally { await local.close(); workspace.close(); store.close(); await server.close(); await f.close(); }
});
