import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { Fixture, METHOD, fakeRound } = await import(new URL('../vendor/latex-review/tests/ts/helpers.ts', import.meta.url).href);
const decide = (app: any, name: string, round: any, action = 'accept', units = round.units) => app.review.decide(name, { id: crypto.randomUUID(), round: round.number, action, changes: units.map((unit: any) => unit.id) });

test('isolated acceptance and undo preserve the manuscript; a task commit includes only accepted changes', async () => {
  const disk = new Fixture(), app = disk.app();
  try {
    disk.write(METHOD, disk.read(METHOD).replace('Detail sentence 19.', 'An existing hand edit.'));
    disk.repo.run(['add', METHOD]);
    disk.write('personal.txt', 'Unrelated untracked text.');
    const head = disk.repo.rev('HEAD'), index = disk.repo.text(['write-tree']), original = disk.read(METHOD);
    const task = app.tasks.create('isolated', 'Review', [], ['paper'], true);
    disk.edit(task, METHOD, 'Method sentence 2.', 'Accepted sentence.');
    disk.edit(task, METHOD, 'Detail sentence 2.', 'Rejected sentence.');
    const round = fakeRound(app, task.name);
    decide(app, task.name, round, 'accept', [round.units[0]]);
    assert.equal(disk.read(METHOD), original);
    const undo = app.review.undoEntry(task.name);
    app.review.undo(task.name, undo.id);
    assert.equal(disk.read(METHOD), original);
    decide(app, task.name, round, 'accept', [round.units[0]]);
    assert.throws(() => app.delivery.deliver(task.name, 'branch', 'Too soon'), /Finish reviewing/);
    decide(app, task.name, round, 'reject', [round.units[1]]);
    const delivered = app.delivery.deliver(task.name, 'branch', 'Explain the method');
    assert.equal(delivered.branch, 'papilot/isolated');
    assert.equal(disk.repo.rev('HEAD'), head);
    assert.equal(disk.repo.text(['write-tree']), index);
    assert.equal(disk.read(METHOD), original);
    assert.equal(disk.repo.rev(`${delivered.commit}^`), head);
    const text = disk.repo.text(['show', `${delivered.commit}:${METHOD}`]);
    assert.match(text, /Accepted sentence/);
    assert.doesNotMatch(text, /Rejected sentence|An existing hand edit/);
    assert.equal(disk.repo.text(['log', '-1', '--format=%an <%ae>', delivered.commit]), 'Test <test@localhost>');
    assert.equal(disk.repo.text(['log', '-1', '--format=%s', delivered.commit]), 'Explain the method');
    assert.equal(app.review.undoEntry(task.name), null, 'delivered decisions cannot be undone behind the destination');
    assert.deepEqual(app.delivery.deliver(task.name, 'branch', 'Retry'), delivered);
    disk.edit(task, METHOD, 'Method sentence 7.', 'Next round sentence.');
    const next = fakeRound(app, task.name);
    decide(app, task.name, next);
    const second = app.delivery.deliver(task.name, 'branch', 'Follow up');
    assert.equal(disk.repo.rev(`${second.commit}^`), delivered.commit);
    assert.match(disk.repo.text(['show', `${second.commit}:${METHOD}`]), /Next round sentence/);
    assert.equal(disk.read(METHOD), original);
    await app.tasks.finish(task.name, true);
    assert.equal(disk.repo.rev(`refs/heads/${second.branch}`), second.commit, 'deleting the task retains its branch');
  } finally { await disk.close(); }
});

test('applying accepted changes preserves the index and independent edits, and retry is idempotent', async () => {
  const disk = new Fixture(), app = disk.app();
  try {
    const task = app.tasks.create('apply', 'Review', [], ['paper'], true);
    disk.edit(task, METHOD, 'Method sentence 2.', 'Accepted sentence.');
    const round = fakeRound(app, task.name);
    decide(app, task.name, round);
    disk.write(METHOD, disk.read(METHOD).replace('Detail sentence 19.', 'A later hand edit.'));
    disk.repo.run(['add', METHOD]);
    const head = disk.repo.rev('HEAD'), index = disk.repo.text(['write-tree']);
    app.delivery.deliver(task.name, 'workspace');
    assert.match(disk.read(METHOD), /Accepted sentence/);
    assert.match(disk.read(METHOD), /A later hand edit/);
    assert.equal(disk.repo.rev('HEAD'), head);
    assert.equal(disk.repo.text(['write-tree']), index);
    disk.write(METHOD, disk.read(METHOD).replace('Accepted sentence.', 'Edited after delivery.'));
    app.delivery.deliver(task.name, 'workspace');
    assert.match(disk.read(METHOD), /Edited after delivery/);
    assert.equal(app.review.undoEntry(task.name), null);
  } finally { await disk.close(); }
});

test('a destination conflict writes no files and a task commit never overwrites another branch', async () => {
  const disk = new Fixture(), app = disk.app();
  try {
    const task = app.tasks.create('conflict', 'Review', [], ['paper'], true);
    disk.edit(task, METHOD, 'Method sentence 2.', 'Accepted sentence.');
    disk.edit(task, 'paper/main.tex', 'Intro sentence 2.', 'Accepted introduction.');
    const round = fakeRound(app, task.name);
    decide(app, task.name, round);
    const main = disk.read('paper/main.tex');
    disk.write(METHOD, disk.read(METHOD).replace('Method sentence 2.', 'A conflicting hand edit.'));
    assert.throws(() => app.delivery.deliver(task.name, 'workspace'), /conflicts with the destination/);
    assert.equal(disk.read('paper/main.tex'), main);
    assert.equal(app.delivery.get(task.name), undefined);
    disk.repo.run(['branch', 'papilot/conflict']);
    assert.throws(() => app.delivery.deliver(task.name, 'branch', 'Commit'), /changed outside Papilot/);
  } finally { await disk.close(); }
});

test('task commits refuse dependencies on uncommitted baseline text instead of including it', async () => {
  const disk = new Fixture(), app = disk.app();
  try {
    disk.write(METHOD, disk.read(METHOD).replace('Method sentence 2.', 'Uncommitted baseline.'));
    const task = app.tasks.create('dependency', 'Review', [], ['paper'], true);
    disk.edit(task, METHOD, 'Uncommitted baseline.', 'Rewritten baseline.');
    decide(app, task.name, fakeRound(app, task.name));
    assert.throws(() => app.delivery.deliver(task.name, 'branch', 'Commit'), /conflicts with the destination/);
    assert.match(disk.read(METHOD), /Uncommitted baseline/);
    assert.equal(disk.repo.text(['for-each-ref', '--format=%(refname)', 'refs/heads/papilot/']), '');
  } finally { await disk.close(); }
});

for (const mode of ['workspace', 'branch'] as const) test(`${mode} delivery recovers after the result was written but its acknowledgement was lost`, async () => {
  const disk = new Fixture(), app = disk.app();
  try {
    const task = app.tasks.create('recover', 'Review', [], ['paper'], true);
    disk.edit(task, METHOD, 'Method sentence 2.', 'Accepted sentence.');
    decide(app, task.name, fakeRound(app, task.name));
    const save = app.delivery.save.bind(app.delivery);
    app.delivery.save = (name: string, data: any) => { if (data.done) throw new Error('Crash after writing'); save(name, data); };
    assert.throws(() => app.delivery.deliver(task.name, mode, 'Commit'), /Crash after writing/);
    const pending = app.delivery.get(task.name);
    assert.equal(pending.done, false);
    assert.throws(() => app.review.undo(task.name, 'any'), /pending delivery/);
    const recovered = disk.app();
    assert.equal(recovered.delivery.get(task.name).done, true);
    const result = recovered.delivery.deliver(task.name, mode, 'Retry');
    if (mode === 'branch') assert.equal(result.commit, pending.commit);
    else assert.match(fs.readFileSync(path.join(disk.root, METHOD), 'utf8'), /Accepted sentence/);
  } finally { await disk.close(); }
});
