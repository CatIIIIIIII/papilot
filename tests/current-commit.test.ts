import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Fixture, METHOD, fakeRound } from '../vendor/latex-review/tests/ts/helpers.ts';

function accept(app: ReturnType<Fixture['app']>, name: string) {
  const round = fakeRound(app, name);
  app.review.decide(name, { id: crypto.randomUUID(), round: round.number, action: 'accept', changes: round.units.map(unit => unit.id) });
}

test('one task commit updates the current manuscript branch, excludes rejected and unrelated staged/unstaged edits', async () => {
  const disk = new Fixture(), app = disk.app();
  try {
    disk.write(METHOD, disk.read(METHOD).replace('Detail sentence 19.', 'My staged wording.'));
    disk.write('staged.txt', 'My staged file.');
    disk.repo.run(['add', METHOD, 'staged.txt']);
    disk.write(METHOD, disk.read(METHOD).replace('Detail sentence 10.', 'My unstaged wording.'));
    disk.write('private.txt', 'My untracked file.');
    const stagedDiff = disk.repo.text(['diff', '--cached']), unstagedDiff = disk.repo.text(['diff']);
    const task = app.tasks.create('commit-task', 'Review', [], ['paper'], true), head = disk.repo.rev('HEAD');
    const branch = disk.repo.text(['branch', '--show-current']);
    disk.edit(task, METHOD, 'Method sentence 2.', 'Accepted wording.');
    disk.edit(task, METHOD, 'Detail sentence 2.', 'Rejected wording.');
    const round = fakeRound(app, task.name);
    app.review.decide(task.name, { id: 'accept', round: round.number, action: 'accept', changes: [round.units[0].id] });
    app.review.decide(task.name, { id: 'reject', round: round.number, action: 'reject', changes: [round.units[1].id] });
    const result = app.delivery.apply(task.name, false, 'commit', 'Improve method').delivery!;
    assert.equal(result.mode, 'commit');
    assert.equal(result.branch, branch);
    assert.equal(disk.repo.rev('HEAD'), result.commit);
    assert.equal(disk.repo.rev('HEAD^'), head);
    assert.equal(disk.repo.text(['log', '-1', '--format=%s']), 'Improve method');
    assert.match(disk.read(METHOD), /Accepted wording/);
    assert.match(disk.read(METHOD), /My staged wording/);
    assert.match(disk.read(METHOD), /My unstaged wording/);
    const committed = disk.repo.blob('HEAD', METHOD)!.toString();
    assert.match(committed, /Accepted wording/);
    assert.doesNotMatch(committed, /Rejected wording|My staged wording|My unstaged wording/);
    assert.equal(disk.repo.blob('HEAD', 'staged.txt'), null);
    assert.equal(disk.repo.blob('HEAD', 'private.txt'), null);
    // Context hashes change, but every remaining hunk is the author's own.
    const removeHashes = (value: string) => value.replace(/^index .*\n/gm, '');
    assert.equal(removeHashes(disk.repo.text(['diff', '--cached'])), removeHashes(stagedDiff));
    assert.equal(removeHashes(disk.repo.text(['diff'])), removeHashes(unstagedDiff));
    assert.equal(disk.repo.text(['for-each-ref', '--format=%(refname)', 'refs/heads/papilot/']), '');
    assert.deepEqual(app.delivery.apply(task.name, false, 'commit', 'Retry').delivery, result);
    disk.edit(task, METHOD, 'Method sentence 10.', 'Later task change.');
    accept(app, task.name);
    app.delivery.apply(task.name);
    assert.equal(disk.repo.rev('HEAD'), result.commit, 'later rounds may choose apply without commit');
    assert.match(disk.read(METHOD), /Later task change/);
  } finally { await disk.close(); }
});

for (const legacy of [false, true]) test(`commit finishes with a clean manuscript${legacy ? ' for an old task branch too' : ''}`, async () => {
  const disk = new Fixture(), app = disk.app();
  try {
    const task = app.tasks.create('clean', 'Review', [], ['paper'], true);
    disk.edit(task, METHOD, 'Method sentence 2.', 'Accepted text.');
    accept(app, task.name);
    const old = legacy ? app.delivery.deliver(task.name, 'branch', 'Old commit') : null;
    const result = app.delivery.apply(task.name, false, 'commit', 'Reviewed task').delivery!;
    assert.equal(disk.repo.rev('HEAD'), result.commit);
    assert.equal(disk.repo.text(['status', '--porcelain']), '');
    if (old) assert.equal(disk.repo.rev(old.branch!), old.commit);
    assert.equal(app.review.undoEntry(task.name), null);
  } finally { await disk.close(); }
});

test('conflict review remembers the commit choice and message across restart and commits the reviewed resolution', async () => {
  const disk = new Fixture(), app = disk.app();
  try {
    const task = app.tasks.create('conflict-commit', 'Review', [], ['paper'], true);
    disk.edit(task, METHOD, 'Method sentence 2.', 'Task proposal.');
    accept(app, task.name);
    disk.write(METHOD, disk.read(METHOD).replace('Method sentence 2.', 'New published wording.'));
    disk.repo.run(['add', METHOD]); disk.repo.run(['commit', '-m', 'Other author edit']);
    const head = disk.repo.rev('HEAD');
    const result = app.delivery.apply(task.name, false, 'commit', 'My custom message');
    assert.deepEqual(result.reconciliation?.intent, { mode: 'commit', message: 'My custom message' });
    assert.equal(disk.repo.rev('HEAD'), head);
    assert.match(disk.read(METHOD), /New published wording/);
    const recovered = disk.app();
    disk.edit(task, METHOD, 'New published wording.', 'Reviewed combined wording.');
    accept(recovered, task.name);
    const saved = recovered.delivery.apply(task.name).delivery!;
    assert.equal(saved.mode, 'commit');
    assert.equal(disk.repo.rev('HEAD'), saved.commit);
    assert.equal(disk.repo.rev('HEAD^'), head);
    assert.equal(disk.repo.text(['log', '-1', '--format=%s']), 'My custom message');
    assert.equal(disk.repo.text(['status', '--porcelain']), '');
    assert.match(disk.read(METHOD), /Reviewed combined wording/);
  } finally { await disk.close(); }
});

test('an overlapping earlier edit needs explicit combined-commit review and can still be applied without committing', async () => {
  const disk = new Fixture(), app = disk.app();
  try {
    disk.write(METHOD, disk.read(METHOD).replace('Method sentence 2.', 'My uncommitted baseline.'));
    const task = app.tasks.create('dependency', 'Review', [], ['paper'], true);
    disk.edit(task, METHOD, 'My uncommitted baseline.', 'Reviewed rewrite.');
    accept(app, task.name);
    const head = disk.repo.rev('HEAD'), index = disk.repo.text(['write-tree']), content = disk.read(METHOD);
    const preview = app.delivery.apply(task.name, false, 'commit', 'Task').commitReview!;
    assert.deepEqual(preview.files, [METHOD]);
    assert.match(preview.diff, /Reviewed rewrite/);
    assert.equal(disk.repo.rev('HEAD'), head);
    assert.equal(disk.repo.text(['write-tree']), index);
    assert.equal(disk.read(METHOD), content);
    assert.equal(app.delivery.get(task.name), undefined);
    app.delivery.apply(task.name);
    assert.match(disk.read(METHOD), /Reviewed rewrite/);
  } finally { await disk.close(); }
});

for (const phase of ['before-files', 'after-files', 'after-index']) test(`task commit recovers at ${phase} without another commit`, async () => {
  const disk = new Fixture(), app = disk.app();
  try {
    const task = app.tasks.create('recover-commit', 'Review', [], ['paper'], true);
    disk.edit(task, METHOD, 'Method sentence 2.', 'Accepted text.');
    accept(app, task.name);
    const save = app.delivery.save.bind(app.delivery), run = app.repo.run.bind(app.repo), rename = fs.renameSync;
    const head = disk.repo.rev('HEAD');
    if (phase === 'after-index') app.delivery.save = (name, data) => { if (data.done) throw new Error('Simulated crash'); save(name, data); };
    if (phase === 'before-files') app.repo.run = (args, options) => { const result = run(args, options); if (args[0] === 'update-ref' && args.includes('Papilot: commit reviewed task')) throw new Error('Simulated crash'); return result; };
    if (phase === 'after-files') fs.renameSync = ((from, to) => { if (String(from).endsWith('index.lock')) throw new Error('Simulated crash'); return rename(from, to); }) as typeof fs.renameSync;
    try { assert.throws(() => app.delivery.apply(task.name, false, 'commit', 'One commit'), /Simulated crash/); }
    finally { fs.renameSync = rename; app.repo.run = run; app.delivery.save = save; }
    const pending = app.delivery.get(task.name)!;
    assert.equal(pending.done, false);
    assert.equal(disk.repo.rev('HEAD'), pending.commit);
    const recovered = disk.app();
    const result = recovered.delivery.apply(task.name, false, 'commit', 'Retry').delivery!;
    assert.equal(result.commit, pending.commit);
    assert.equal(disk.repo.rev('HEAD^'), head);
    assert.equal(disk.repo.text(['status', '--porcelain']), '');
  } finally { await disk.close(); }
});

for (const race of ['branch', 'head', 'index', 'lock']) test(`task commit preserves a concurrent ${race} operation`, async () => {
  const disk = new Fixture(), app = disk.app();
  try {
    const task = app.tasks.create('race', 'Review', [], ['paper'], true);
    disk.edit(task, METHOD, 'Method sentence 2.', 'Accepted text.'); accept(app, task.name);
    const original = disk.read(METHOD), save = app.delivery.save.bind(app.delivery);
    let expectedHead = '', expectedIndex = '';
    const lock = path.resolve(disk.root, disk.repo.text(['rev-parse', '--git-path', 'index.lock']));
    app.delivery.save = (name, data) => {
      save(name, data); if (data.done) return;
      if (race === 'branch') disk.repo.run(['checkout', '-b', 'other']);
      if (race === 'head') disk.repo.run(['commit', '--allow-empty', '-m', 'Concurrent commit']);
      if (race === 'index') { disk.write('new.txt', 'Concurrent staged text.'); disk.repo.run(['add', 'new.txt']); }
      expectedHead = disk.repo.rev('HEAD'); expectedIndex = disk.repo.text(['write-tree']);
      if (race === 'lock') fs.writeFileSync(lock, 'Other operation');
    };
    assert.throws(() => app.delivery.apply(task.name, false, 'commit', 'Task'), /branch changed|branch moved|staged changes changed|Another Git operation/);
    assert.equal(disk.repo.rev('HEAD'), expectedHead);
    if (race === 'lock') { assert.equal(fs.readFileSync(lock, 'utf8'), 'Other operation'); fs.rmSync(lock); }
    assert.equal(disk.repo.text(['write-tree']), expectedIndex);
    assert.equal(disk.read(METHOD), original);
  } finally { await disk.close(); }
});

for (const staged of [false, true]) test(`confirmed combined commit includes the earlier overlapping passage only (${staged ? 'staged' : 'unstaged'})`, async () => {
  const disk = new Fixture(), app = disk.app();
  try {
    disk.write(METHOD, disk.read(METHOD).replace('Method sentence 2.', 'Earlier title.').replace('Detail sentence 19.', 'Unrelated staged text.'));
    if (staged) disk.repo.run(['add', METHOD]);
    disk.write(METHOD, disk.read(METHOD).replace('Detail sentence 10.', 'Unrelated unstaged text.'));
    const task = app.tasks.create('together', 'Review', [], ['paper'], true);
    disk.edit(task, METHOD, 'Earlier title.', 'Reviewed final title.'); accept(app, task.name);
    const head = disk.repo.rev('HEAD'), original = disk.read(METHOD), index = disk.repo.text(['write-tree']);
    const preview = app.delivery.apply(task.name, false, 'commit', 'Final title').commitReview!;
    assert.match(preview.diff, /Reviewed final title/);
    assert.doesNotMatch(preview.diff, /Unrelated/);
    assert.equal(disk.repo.rev('HEAD'), head); assert.equal(disk.read(METHOD), original); assert.equal(disk.repo.text(['write-tree']), index);
    const saved = app.delivery.apply(task.name, false, 'commit', 'Final title', preview.token).delivery!;
    assert.equal(saved.commit, disk.repo.rev('HEAD'));
    assert.equal(disk.repo.rev('HEAD^'), head);
    assert.match(disk.repo.blob('HEAD', METHOD)!.toString(), /Reviewed final title/);
    assert.doesNotMatch(disk.repo.blob('HEAD', METHOD)!.toString(), /Unrelated/);
    assert.match(disk.read(METHOD), /Unrelated staged text/); assert.match(disk.read(METHOD), /Unrelated unstaged text/);
    assert.equal(disk.repo.text(['diff', '--cached']).includes('Unrelated staged text'), staged);
    assert.match(disk.repo.text(['diff']), /Unrelated unstaged text/);
  } finally { await disk.close(); }
});

test('a combined commit confirmation expires when the manuscript changes', async () => {
  const disk = new Fixture(), app = disk.app();
  try {
    disk.write(METHOD, disk.read(METHOD).replace('Method sentence 2.', 'Earlier title.'));
    const task = app.tasks.create('preview-race', 'Review', [], ['paper'], true);
    disk.edit(task, METHOD, 'Earlier title.', 'Reviewed final title.'); accept(app, task.name);
    const preview = app.delivery.apply(task.name, false, 'commit', 'Final title').commitReview!;
    disk.write(METHOD, disk.read(METHOD).replace('Detail sentence 19.', 'Changed during preview.'));
    const head = disk.repo.rev('HEAD');
    const next = app.delivery.apply(task.name, false, 'commit', 'Final title', preview.token).commitReview!;
    assert.ok(next); assert.notEqual(next.token, preview.token); assert.equal(disk.repo.rev('HEAD'), head);
    assert.equal(app.delivery.get(task.name), undefined);
  } finally { await disk.close(); }
});

test('a combined commit does not discard a different version staged by the author', async () => {
  const disk = new Fixture(), app = disk.app();
  try {
    disk.write(METHOD, disk.read(METHOD).replace('Method sentence 2.', 'Separate staged title.')); disk.repo.run(['add', METHOD]);
    disk.write(METHOD, disk.read(METHOD).replace('Separate staged title.', 'Earlier working title.'));
    const task = app.tasks.create('staged-version', 'Review', [], ['paper'], true);
    disk.edit(task, METHOD, 'Earlier working title.', 'Reviewed final title.'); accept(app, task.name);
    const head = disk.repo.rev('HEAD'), index = disk.repo.text(['write-tree']);
    assert.throws(() => app.delivery.apply(task.name, false, 'commit', 'Title'), /different version/);
    assert.equal(disk.repo.rev('HEAD'), head); assert.equal(disk.repo.text(['write-tree']), index);
  } finally { await disk.close(); }
});
