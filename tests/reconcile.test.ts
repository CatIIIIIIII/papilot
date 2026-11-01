import test from 'node:test';
import assert from 'node:assert/strict';
import { Fixture, METHOD, fakeRound } from '../vendor/latex-review/tests/ts/helpers.ts';
import { scopeViolations } from '../vendor/latex-review/src/core/changes.ts';

const decide = (app: ReturnType<Fixture['app']>, name: string, action: 'accept' | 'reject' = 'accept') => {
  const round = fakeRound(app, name);
  app.review.decide(name, { id: crypto.randomUUID(), round: round.number, action, changes: round.units.map(unit => unit.id) });
  return round;
};

test('a previously committed task applies to the manuscript without merging branches or touching the index', async () => {
  const disk = new Fixture(), app = disk.app();
  try {
    const task = app.tasks.create('old-branch', 'Old task', [], ['paper'], true);
    disk.edit(task, METHOD, 'Method sentence 2.', 'Accepted revision.');
    decide(app, task.name);
    const committed = app.delivery.deliver(task.name, 'branch', 'Old task commit');
    const head = disk.repo.rev('HEAD'), index = disk.repo.text(['write-tree']);
    const applied = app.delivery.apply(task.name);
    assert.equal(applied.delivery?.mode, 'workspace');
    assert.match(disk.read(METHOD), /Accepted revision/);
    assert.equal(disk.repo.rev('HEAD'), head);
    assert.equal(disk.repo.text(['write-tree']), index);
    assert.equal(disk.repo.rev(committed.branch!), committed.commit);
    assert.deepEqual(app.delivery.apply(task.name), applied);
    disk.edit(task, METHOD, 'Method sentence 9.', 'Next accepted revision.');
    decide(app, task.name);
    app.delivery.apply(task.name);
    assert.match(disk.read(METHOD), /Next accepted revision/);
  } finally { await disk.close(); }
});

test('conflicts become a review of only overlapping passages, preserving clean edits in the same file', async () => {
  const disk = new Fixture(), app = disk.app();
  try {
    const task = app.tasks.create('conflict', 'Review', [], ['paper'], true);
    disk.edit(task, METHOD, 'Method sentence 2.', 'Accepted conflicting statement.');
    disk.edit(task, METHOD, 'Detail sentence 2.', 'Accepted independent detail.');
    disk.edit(task, 'paper/main.tex', 'Intro sentence 2.', 'Accepted introduction.');
    const original = decide(app, task.name);
    disk.write(METHOD, disk.read(METHOD).replace('Method sentence 2.', 'Latest manuscript statement.').replace('Detail sentence 19.', 'Latest independent detail.'));
    disk.repo.run(['add', METHOD]);
    const manuscript = disk.read(METHOD), introduction = disk.read('paper/main.tex'), index = disk.repo.text(['write-tree']), head = disk.repo.rev('HEAD');
    const result = app.delivery.apply(task.name), merge = result.reconciliation!;
    assert.deepEqual(merge.files, [METHOD]);
    assert.equal(disk.read(METHOD), manuscript);
    assert.equal(disk.read('paper/main.tex'), introduction);
    assert.equal(disk.repo.text(['write-tree']), index);
    assert.equal(disk.repo.rev('HEAD'), head);
    assert.match(disk.read(METHOD, task.worktree), /Latest manuscript statement/);
    assert.match(disk.read(METHOD, task.worktree), /Accepted independent detail/);
    assert.match(disk.read(METHOD, task.worktree), /Latest independent detail/);
    assert.doesNotMatch(disk.read(METHOD, task.worktree), /<<<<<<<|=======|>>>>>>>/);
    assert.deepEqual(app.delivery.apply(task.name), result, 'retry reuses the prepared suggestion');
    assert.equal(app.review.undoEntry(task.name), null);
    assert.throws(() => app.review.decide(task.name, { id: crypto.randomUUID(), round: original.number, action: 'reject', changes: original.units.map(unit => unit.id) }), /new merge suggestion/);
    assert.throws(() => app.delivery.deliver(task.name, 'workspace'), /Review the merge suggestion/);
    // Simulate the AI's proposed resolution; it still needs an author decision.
    disk.edit(task, METHOD, 'Latest manuscript statement.', 'Combined statement for author review.');
    const round = fakeRound(app, task.name);
    assert.equal(round.units.length, 1);
    assert.match(round.units[0].old_text, /Latest manuscript statement/);
    assert.doesNotMatch(round.units[0].new_text, /Accepted independent detail|Accepted introduction/);
    const refreshed = app.tasks.get(task.name);
    assert.deepEqual(scopeViolations(app.repo, refreshed.base, app.tasks.snapshot(refreshed), refreshed.scope), []);
    assert.throws(() => app.delivery.apply(task.name), /Finish reviewing/);
    app.review.decide(task.name, { id: crypto.randomUUID(), round: round.number, action: 'accept', changes: round.units.map(unit => unit.id) });
    assert.equal(disk.read(METHOD), manuscript, 'acceptance is still isolated');
    disk.write(METHOD, manuscript.replace('Detail sentence 10.', 'Edited while reviewing.'));
    app.delivery.apply(task.name);
    assert.match(disk.read(METHOD), /Combined statement for author review/);
    assert.match(disk.read(METHOD), /Accepted independent detail/);
    assert.match(disk.read(METHOD), /Latest independent detail/);
    assert.match(disk.read(METHOD), /Edited while reviewing/);
    assert.match(disk.read('paper/main.tex'), /Accepted introduction/);
    assert.equal(app.reconciliation.get(task.name), undefined);
    assert.equal(disk.repo.text(['write-tree']), index);
    assert.equal(disk.repo.rev('HEAD'), head);
  } finally { await disk.close(); }
});

test('rejecting a merge suggestion preserves the latest manuscript, including when nothing remains to apply', async () => {
  const disk = new Fixture(), app = disk.app();
  try {
    const task = app.tasks.create('reject-merge', 'Review', [], ['paper'], true);
    disk.edit(task, METHOD, 'Method sentence 2.', 'Original proposal.');
    decide(app, task.name);
    disk.write(METHOD, disk.read(METHOD).replace('Method sentence 2.', 'Latest statement.'));
    app.delivery.apply(task.name);
    disk.edit(task, METHOD, 'Latest statement.', 'Suggested combination.');
    decide(app, task.name, 'reject');
    const applied = app.delivery.apply(task.name);
    assert.equal(applied.delivery?.mode, 'workspace');
    assert.match(disk.read(METHOD), /Latest statement/);
    assert.doesNotMatch(disk.read(METHOD), /Suggested combination|Original proposal/);
    assert.equal(app.reconciliation.get(task.name), undefined);
  } finally { await disk.close(); }
});

test('a second overlapping manuscript edit requires a fresh review instead of overwriting it', async () => {
  const disk = new Fixture(), app = disk.app();
  try {
    const task = app.tasks.create('changed-again', 'Review', [], ['paper'], true);
    disk.edit(task, METHOD, 'Method sentence 2.', 'Original proposal.');
    decide(app, task.name);
    disk.write(METHOD, disk.read(METHOD).replace('Method sentence 2.', 'Latest statement.'));
    const first = app.delivery.apply(task.name).reconciliation!;
    disk.edit(task, METHOD, 'Latest statement.', 'First combined statement.');
    decide(app, task.name);
    disk.write(METHOD, disk.read(METHOD).replace('Latest statement.', 'Changed again during review.'));
    const second = app.delivery.apply(task.name).reconciliation!;
    assert.notEqual(second.id, first.id);
    assert.match(disk.read(METHOD), /Changed again during review/);
    assert.match(disk.read(METHOD, task.worktree), /Changed again during review/);
    assert.match(app.repo.blob(second.sourceAccepted, METHOD)!.toString(), /First combined statement/);
  } finally { await disk.close(); }
});

test('preparation recovers after interruption without writing the manuscript or losing the accepted proposal', async () => {
  const disk = new Fixture(), app = disk.app();
  try {
    const task = app.tasks.create('recover-merge', 'Review', [], ['paper'], true);
    disk.edit(task, METHOD, 'Method sentence 2.', 'Accepted proposal.');
    decide(app, task.name);
    disk.write(METHOD, disk.read(METHOD).replace('Method sentence 2.', 'Latest statement.'));
    const update = app.repo.updateRef.bind(app.repo);
    app.repo.updateRef = (ref, value) => { if (ref.endsWith('/accepted')) throw new Error('Simulated interruption'); update(ref, value); };
    assert.throws(() => app.delivery.apply(task.name), /Simulated interruption/);
    assert.equal(app.reconciliation.get(task.name)?.ready, false);
    const recovered = disk.app();
    const merge = recovered.reconciliation.get(task.name)!;
    assert.equal(merge.ready, true);
    assert.match(recovered.repo.blob(merge.sourceAccepted, METHOD)!.toString(), /Accepted proposal/);
    assert.match(disk.read(METHOD), /Latest statement/);
    assert.deepEqual(recovered.delivery.apply(task.name).reconciliation, merge);
  } finally { await disk.close(); }
});

test('keeping current wording is an explicit author choice and cannot bypass unreviewed edits', async () => {
  const disk = new Fixture(), app = disk.app();
  try {
    const task = app.tasks.create('choose-current', 'Review', [], ['paper'], true);
    disk.edit(task, METHOD, 'Method sentence 2.', 'Proposed scientific claim.');
    disk.edit(task, METHOD, 'Detail sentence 2.', 'Accepted independent detail.');
    decide(app, task.name);
    disk.write(METHOD, disk.read(METHOD).replace('Method sentence 2.', 'Current scientific claim.'));
    app.delivery.apply(task.name);
    disk.edit(task, METHOD, 'Current scientific claim.', 'Unreviewed guess.');
    assert.throws(() => app.delivery.apply(task.name, true), /Review the merge suggestion/);
    assert.match(disk.read(METHOD), /Current scientific claim/);
    disk.edit(task, METHOD, 'Unreviewed guess.', 'Current scientific claim.');
    const result = app.delivery.apply(task.name, true);
    assert.equal(result.delivery?.mode, 'workspace');
    assert.match(disk.read(METHOD), /Current scientific claim/);
    assert.match(disk.read(METHOD), /Accepted independent detail/);
    assert.doesNotMatch(disk.read(METHOD), /Unreviewed guess|Proposed scientific claim/);
  } finally { await disk.close(); }
});

test('an old branch delivery with a lost acknowledgement can be applied without a separate Git operation', async () => {
  const disk = new Fixture(), app = disk.app();
  try {
    const task = app.tasks.create('pending-branch', 'Old task', [], ['paper'], true);
    disk.edit(task, METHOD, 'Method sentence 2.', 'Accepted text.');
    decide(app, task.name);
    const save = app.delivery.save.bind(app.delivery);
    app.delivery.save = (name, data) => { if (data.done) throw new Error('Lost acknowledgement'); save(name, data); };
    assert.throws(() => app.delivery.deliver(task.name, 'branch', 'Old commit'), /Lost acknowledgement/);
    app.delivery.save = save;
    assert.equal(app.delivery.apply(task.name).delivery?.mode, 'workspace');
    assert.match(disk.read(METHOD), /Accepted text/);
  } finally { await disk.close(); }
});

test('merge suggestions cannot introduce unrelated edits, and applied merge recovery clears its review state', async () => {
  const disk = new Fixture(), app = disk.app();
  try {
    const task = app.tasks.create('merge-scope', 'Review', [], ['paper'], true);
    disk.edit(task, METHOD, 'Method sentence 2.', 'Accepted proposal.');
    decide(app, task.name);
    disk.write(METHOD, disk.read(METHOD).replace('Method sentence 2.', 'Latest statement.'));
    app.delivery.apply(task.name);
    disk.edit(task, 'paper/main.tex', 'Intro sentence 2.', 'Unrelated AI edit.');
    await assert.rejects(app.publisher.publish({ id: 'scope-check', task: task.name }), /Some edits are outside the task scope/);
    disk.edit(task, 'paper/main.tex', 'Unrelated AI edit.', 'Intro sentence 2.');
    disk.edit(task, METHOD, 'Latest statement.', 'Reviewed combination.');
    decide(app, task.name);
    const save = app.delivery.save.bind(app.delivery);
    app.delivery.save = (name, data) => { if (data.done) throw new Error('Lost apply response'); save(name, data); };
    assert.throws(() => app.delivery.apply(task.name), /Lost apply response/);
    assert.ok(app.reconciliation.get(task.name));
    assert.match(disk.read(METHOD), /Reviewed combination/);
    const recovered = disk.app();
    assert.equal(recovered.reconciliation.get(task.name), undefined);
    assert.equal(recovered.delivery.apply(task.name).delivery?.mode, 'workspace');
    assert.match(disk.read(METHOD), /Reviewed combination/);
  } finally { await disk.close(); }
});
