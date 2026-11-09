import fs from 'node:fs';
import path from 'node:path';
import { Builder } from '../../src/core/build.ts';
import * as publisher from '../../src/core/publish.ts';
import { optionCandidate, previewNoteOption } from '../../src/core/option-preview.ts';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Fixture, fakeRound, METHOD, BODY } from './helpers.ts';
import { acceptNoteOption, noteOptionUnits, useNoteOption } from '../../src/core/note-options.ts';
import type { App } from '../../src/server.ts';
import type { Task, Unit } from '../../src/types.ts';

let f: Fixture, app: App, task: Task;
beforeEach(async () => {
  f = new Fixture(); app = f.app(); await app.ready;
  task = app.tasks.create('options', 'Note options', [], ['paper'], true);
  f.edit(task, METHOD, 'Method sentence 2.', 'Approach sentence two.');
  f.edit(task, METHOD, 'Detail sentence 15.', 'Detail proposal 15.');
  fakeRound(app, task.name);
  vi.spyOn(app.publisher, 'publish').mockResolvedValue({ outcome: 'unchanged', round: 1, changes: 3 });
});
afterEach(async () => { await f.close(); vi.restoreAllMocks(); });
const units = () => app.review.latestRound(task.name)!.units;
it('replaces the selected note only, leaves the manuscript intact, and retries once', async () => {
  const selected = units().find(u => u.new_text === 'Approach')!;
  const input = { id: 'first-option', round: 1, edits: [{ unit: selected.id, text: 'Procedure' }] };
  await useNoteOption(app, task.name, input); await app.publisher.join();
  expect(f.read(METHOD, task.worktree)).toContain('Procedure sentence two.');
  expect(f.read(METHOD, task.worktree)).toContain('Detail proposal 15.');
  expect(f.read(METHOD)).toBe(BODY);
  await useNoteOption(app, task.name, input); await app.publisher.join();
  expect(app.publisher.publish).toHaveBeenCalledTimes(1);
});
it('keeps the original source range when an alternative includes the old wording', async () => {
  const round = app.review.latestRound(task.name)!;
  const selected = units().find(u => u.new_text === 'Approach')!;
  await useNoteOption(app, task.name, { id: 'retain-range', round: 1, edits: [{ unit: selected.id, text: `Revised ${selected.old_text}` }] });
  await app.publisher.join();
  const job = app.store.one<{ job: string }>('SELECT job FROM build_requests')!.job;
  const after = app.tasks.snapshot(app.tasks.get(task.name));
  const preserved = await noteOptionUnits(app, task.name, job, round.before, after);
  expect(preserved!.map(unit => unit.id)).toEqual(round.units.map(unit => unit.id));
  expect(preserved!.find(unit => unit.id === selected.id)).toMatchObject({ old_text: selected.old_text, new_text: `Revised ${selected.old_text}` });
  f.edit(task, METHOD, 'Detail proposal 15.', 'External proposal 15.');
  expect(await noteOptionUnits(app, task.name, job, round.before, app.tasks.snapshot(app.tasks.get(task.name)))).toBeUndefined();
});
it('the checkmark accepts only the chosen note after publishing and is idempotent', async () => {
  const selected = units().find(unit => unit.new_text === 'Approach')!;
  vi.mocked(app.publisher.publish).mockImplementation(async () => {
    const round = fakeRound(app, task.name);
    return { outcome: 'published', round: round.number, changes: round.units.length };
  });
  await useNoteOption(app, task.name, { id: 'local-accept', round: 1, accept: true, edits: [{ unit: selected.id, text: 'Procedure' }] });
  await app.publisher.join();
  const round = app.review.latestRound(task.name)!, decisions = app.review.decisions(task.name, round);
  const accepted = round.units.filter(unit => decisions[unit.id] === 'accepted');
  expect(accepted.map(unit => unit.new_text)).toEqual(['Procedure']);
  expect(round.units.filter(unit => decisions[unit.id] === 'pending')).toHaveLength(round.units.length - 1);
  const job = app.store.one<{ job: string }>('SELECT job FROM build_requests')!.job;
  await acceptNoteOption(app, task.name, job);
  expect(app.store.all('SELECT id FROM actions')).toHaveLength(1);
  const acceptedText = app.repo.blob(app.tasks.get(task.name).accepted, METHOD)!.toString();
  expect(acceptedText).toContain('Procedure sentence 2.');
  expect(acceptedText).toContain('Detail sentence 15.');
});
it('refuses an option shared with an accepted edit before writing any fragment', async () => {
  const [first, second] = units();
  await app.review.decide(task.name, { round: 1, changes: [first.id], action: 'accept' });
  const before = f.read(METHOD, task.worktree);
  await expect(useNoteOption(app, task.name, { id: 'shared', round: 1, edits: [{ unit: second.id, text: 'other' }, { unit: first.id, text: 'overwrite' }] })).rejects.toThrow('reviewed');
  expect(f.read(METHOD, task.worktree)).toBe(before);
});
it('preserves a rejected neighboring edit on the same line', async () => {
  const word = units().find(u => u.new_text === 'Approach')!, number = units().find(u => u.new_text === 'two')!;
  await app.review.decide(task.name, { round: 1, changes: [number.id], action: 'reject' });
  await useNoteOption(app, task.name, { id: 'neighbor', round: 1, edits: [{ unit: word.id, text: 'Procedure' }] });
  await app.publisher.join();
  expect(f.read(METHOD, task.worktree)).toContain('Procedure sentence 2.');
  expect(app.review.decisions(task.name, app.review.latestRound(task.name)!)[number.id]).toBe('rejected');
});

// Exercise the same preserved-unit hook used by Publisher.publish without
// compiling a PDF for each journal/offset regression.
function publishOptionRound() {
  vi.mocked(app.publisher.publish).mockImplementation(async job => {
    const round = fakeRound(app, task.name);
    const preserved = await noteOptionUnits(app, task.name, job.id, round.before, round.after);
    if (preserved) app.store.execute('UPDATE rounds SET units=? WHERE task=? AND number=?', JSON.stringify(preserved), task.name, round.number);
    return { outcome: 'published', round: round.number, changes: (preserved || round.units).length };
  });
}

for (const neighbor of ['accepted', 'rejected'] as const) it(`accepts an alternative retaining its old word after an ${neighbor} neighbor`, async () => {
  const word = units().find(unit => unit.new_text === 'Approach')!, number = units().find(unit => unit.new_text === 'two')!;
  await app.review.decide(task.name, { round: 1, changes: [word.id], action: neighbor === 'accepted' ? 'accept' : 'reject' });
  publishOptionRound();
  const input = { id: `after-${neighbor}`, round: 1, accept: true, edits: [{ unit: number.id, text: 'about 2' }] };
  await useNoteOption(app, task.name, input); await app.publisher.join();
  expect(app.publisher.current(task.name)?.status).toBe('done');
  const round = app.review.latestRound(task.name)!, decisions = app.review.decisions(task.name, round);
  expect(round.units.filter(unit => decisions[unit.id] === 'accepted').map(unit => [unit.old_text, unit.new_text])).toEqual([['2', 'about 2']]);
  expect(round.units.filter(unit => decisions[unit.id] === 'pending').map(unit => unit.new_text)).toEqual(['proposal']);
  const expected = neighbor === 'accepted' ? 'Approach' : 'Method';
  expect(f.read(METHOD, task.worktree)).toContain(`${expected} sentence about 2.`);
  expect(app.repo.blob(app.tasks.get(task.name).accepted, METHOD)!.toString()).toContain(`${expected} sentence about 2.`);
  await useNoteOption(app, task.name, input); await app.publisher.join();
  expect(app.store.all('SELECT id FROM actions')).toHaveLength(2);
});

it('accepts the intended repeated fragment after a distant accepted edit', async () => {
  const word = units().find(unit => unit.new_text === 'Approach')!, distant = units().find(unit => unit.new_text === 'proposal')!;
  await app.review.decide(task.name, { round: 1, changes: [distant.id], action: 'accept' });
  publishOptionRound();
  await useNoteOption(app, task.name, { id: 'after-distant', round: 1, accept: true, edits: [{ unit: word.id, text: 'Procedure' }] }); await app.publisher.join();
  expect(app.publisher.current(task.name)?.status).toBe('done');
  const accepted = app.repo.blob(app.tasks.get(task.name).accepted, METHOD)!.toString();
  expect(accepted).toContain('Procedure sentence 2.');
  expect(accepted).toContain('Method sentence 3.');
  expect(accepted).toContain('Detail proposal 15.');
});

for (const action of ['accept', 'reject'] as const) it(`accepts the original option span when another ${action} arrives during publication`, async () => {
  const word = units().find(unit => unit.new_text === 'Approach')!, number = units().find(unit => unit.new_text === 'two')!;
  publishOptionRound();
  const publish = vi.mocked(app.publisher.publish).getMockImplementation()!;
  vi.mocked(app.publisher.publish).mockImplementation(async (...args) => {
    await app.review.decide(task.name, { round: 1, changes: [number.id], action });
    return publish(...args);
  });
  await useNoteOption(app, task.name, { id: 'decision-during-option', round: 1, accept: true, edits: [{ unit: word.id, text: 'Revised Method' }] }); await app.publisher.join();
  expect(app.publisher.current(task.name)?.status).toBe('done');
  const accepted = app.repo.blob(app.tasks.get(task.name).accepted, METHOD)!.toString();
  expect(accepted).toContain(`Revised Method sentence ${action === 'accept' ? 'two' : '2'}.`);
  expect(accepted).toContain('Detail sentence 15.');
  const round = app.review.latestRound(task.name)!, decisions = app.review.decisions(task.name, round);
  expect(round.units.filter(unit => decisions[unit.id] === 'pending').map(unit => unit.new_text)).toEqual(['proposal']);
});

it('keeps an independent manual edit outside the selected acceptance', async () => {
  const word = units().find(unit => unit.new_text === 'Approach')!;
  f.edit(task, METHOD, 'Method sentence 4.', 'Manual sentence 4.');
  publishOptionRound();
  await useNoteOption(app, task.name, { id: 'with-manual-edit', round: 1, accept: true, edits: [{ unit: word.id, text: 'Revised Method' }] }); await app.publisher.join();
  expect(app.publisher.current(task.name)?.status).toBe('done');
  expect(f.read(METHOD, task.worktree)).toContain('Manual sentence 4.');
  const accepted = app.repo.blob(app.tasks.get(task.name).accepted, METHOD)!.toString();
  expect(accepted).toContain('Revised Method sentence 2.');
  expect(accepted).toContain('Method sentence 4.');
});

it('keeps a distant atomic TeX construct pending when accepting a prose option', async () => {
  const word = units().find(unit => unit.new_text === 'Approach')!;
  const equation = '\\begin{equation}x + y = 1\\end{equation}';
  f.edit(task, METHOD, 'Method sentence 4.', equation);
  publishOptionRound();
  await useNoteOption(app, task.name, { id: 'with-atomic-tex', round: 1, accept: true, edits: [{ unit: word.id, text: 'Revised Method' }] }); await app.publisher.join();
  expect(app.publisher.current(task.name)?.status).toBe('done');
  const round = app.review.latestRound(task.name)!, decisions = app.review.decisions(task.name, round);
  const atomic = round.units.find(unit => unit.new_text === equation)!;
  expect(atomic.old_text).toBe('Method sentence 4.');
  expect(atomic.text_ops).toHaveLength(1);
  expect(decisions[atomic.id]).toBe('pending');
  expect(f.read(METHOD, task.worktree)).toContain(equation);
  const accepted = app.repo.blob(app.tasks.get(task.name).accepted, METHOD)!.toString();
  expect(accepted).toContain('Revised Method sentence 2.');
  expect(accepted).toContain('Method sentence 4.');
  expect(accepted).not.toContain(equation);
});

it('accepts an empty option without consuming the surrounding whitespace or neighbor', async () => {
  const word = units().find(unit => unit.new_text === 'Approach')!;
  publishOptionRound();
  await useNoteOption(app, task.name, { id: 'delete-word', round: 1, accept: true, edits: [{ unit: word.id, text: '' }] }); await app.publisher.join();
  expect(app.publisher.current(task.name)?.status).toBe('done');
  expect(app.repo.blob(app.tasks.get(task.name).accepted, METHOD)!.toString()).toBe(BODY.replace('Method sentence 2.', ' sentence 2.'));
  expect(f.read(METHOD, task.worktree)).toBe(BODY.replace('Method sentence 2.', ' sentence two.').replace('Detail sentence 15.', 'Detail proposal 15.'));
  const round = app.review.latestRound(task.name)!, decisions = app.review.decisions(task.name, round);
  expect(round.units.filter(unit => decisions[unit.id] === 'accepted').map(unit => [unit.old_text, unit.new_text])).toEqual([['Method', '']]);
  const removed = round.units.find(unit => decisions[unit.id] === 'accepted')!;
  expect(removed.ops[0][3]).toBe(removed.ops[0][4]);
});

it('fails closed if the selected wording changes while publication is pending', async () => {
  const word = units().find(unit => unit.new_text === 'Approach')!;
  publishOptionRound();
  const publish = vi.mocked(app.publisher.publish).getMockImplementation()!;
  vi.mocked(app.publisher.publish).mockImplementation(async (...args) => {
    f.edit(task, METHOD, 'Procedure', 'Different');
    return publish(...args);
  });
  await useNoteOption(app, task.name, { id: 'changed-during-build', round: 1, accept: true, edits: [{ unit: word.id, text: 'Procedure' }] }); await app.publisher.join();
  expect(app.publisher.current(task.name)?.status).toBe('failed');
  expect(app.store.all('SELECT id FROM actions')).toHaveLength(0);
  expect(f.read(METHOD)).toBe(BODY);
});
it('refuses stale rounds and overlapping external writes', async () => {
  const word = units().find(u => u.new_text === 'Approach')!;
  await expect(useNoteOption(app, task.name, { id: 'old', round: 99, edits: [{ unit: word.id, text: 'Procedure' }] })).rejects.toThrow('newer round');
  f.edit(task, METHOD, 'Approach', 'External');
  await expect(useNoteOption(app, task.name, { id: 'external', round: 1, edits: [{ unit: word.id, text: 'Procedure' }] })).rejects.toThrow('source changed');
  expect(f.read(METHOD, task.worktree)).toContain('External sentence two.');
});

for (const replacement of ['Procedure', 'A much longer\nprocedure', '']) it(`previews exact ranges without losing neighboring IDs: ${JSON.stringify(replacement)}`, () => {
  const selected = units().find(unit => unit.new_text === 'Approach')!;
  const original = f.read(METHOD, task.worktree);
  const candidate = optionCandidate(units(), [{ unit: selected.id, text: replacement }], () => original);
  const source = candidate.files[METHOD]!.toString();
  expect(source).toBe(original.replace('Approach', replacement));
  expect(candidate.units.map(unit => unit.id)).toEqual(units().map(unit => unit.id));
  for (const unit of candidate.units) {
    const [, , , start, end] = unit.text_ops![0];
    expect(source.slice(start, end)).toBe(unit.new_text);
    expect(unit.new_start).toBe(source.slice(0, start).split('\n').length);
    if (start === end) expect(unit.ops[0][3]).toBe(unit.ops[0][4]);
    expect(unit.new_end).toBeGreaterThanOrEqual(unit.new_start);
  }
  expect(candidate.units.map(unit => unit.old_text)).toEqual(units().map(unit => unit.old_text));
});

it('compiles an isolated preview and caches it without publishing, writing source, or deciding', async () => {
  const selected = units().find(unit => unit.new_text === 'Approach')!;
  const round = app.review.latestRound(task.name)!, decisions = app.review.decisions(task.name, round);
  const original = f.read(METHOD, task.worktree), head = app.repo.rev('HEAD');
  const pdf = path.join(app.state, 'preview-test.pdf'); fs.writeFileSync(pdf, 'test PDF');
  const built = vi.spyOn(Builder.prototype, 'build').mockImplementation(async rev => ({ key: rev, tree: rev, targets: ['full'], root: task.worktree, cwd: task.worktree, pdf, seconds: 0, warnings: [] }));
  vi.spyOn(publisher, 'render').mockImplementation(async (out, request) => {
    expect(app.repo.blob(request.new.tree, METHOD)?.toString()).toContain('Procedure sentence two.');
    fs.writeFileSync(path.join(out, 'round.json'), JSON.stringify({ units: {}, sections: [], loose: [] }));
  });
  const input = { id: 'preview-only', round: 1, edits: [{ unit: selected.id, text: 'Procedure' }] };
  const [first, second] = await Promise.all([previewNoteOption(app, task.name, input), previewNoteOption(app, task.name, input)]);
  expect(first.after).toBe(second.after);
  expect(first.units.find(unit => unit.id === selected.id)?.new_text).toBe('Procedure');
  await previewNoteOption(app, task.name, input);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-02T13:00:00Z'));
  expect((await previewNoteOption(app, task.name, input)).files).toBe(first.files);
  vi.useRealTimers();
  expect(built).toHaveBeenCalledTimes(2);
  expect(f.read(METHOD, task.worktree)).toBe(original);
  expect(f.read(METHOD)).toBe(BODY);
  expect(app.repo.rev('HEAD')).toBe(head);
  expect(app.review.latestRound(task.name)).toEqual(round);
  expect(app.review.decisions(task.name, round)).toEqual(decisions);
  expect(app.publisher.publish).not.toHaveBeenCalled();
  await app.review.decide(task.name, { round: 1, changes: [selected.id], action: 'accept' });
  await expect(previewNoteOption(app, task.name, input)).rejects.toThrow('reviewed');
});

it('reuses the published chapter scope, baseline and frozen date, compiling only the candidate', async () => {
  const selected = units().find(unit => unit.new_text === 'Approach')!;
  const round = app.review.latestRound(task.name)!;
  const date = { SOURCE_DATE_EPOCH: '1735732800', FORCE_SOURCE_DATE: '1' };
  const keys = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)], targets = ['sections/method'];
  app.store.execute('UPDATE rounds SET summary=? WHERE task=? AND number=1', JSON.stringify({ ...round.summary, date, targets, builds: keys }), task.name);
  const pdf = path.join(app.state, 'preview-test.pdf'); fs.writeFileSync(pdf, 'test PDF');
  const info = (key: string) => ({ key, tree: key, targets, root: task.worktree, cwd: task.worktree, pdf, seconds: 0, warnings: [] });
  const completed = vi.spyOn(Builder.prototype, 'completed').mockImplementation(async key => info(key));
  const seed = vi.spyOn(Builder.prototype, 'buildSeed');
  const build = vi.spyOn(Builder.prototype, 'build').mockImplementation(async rev => info(rev));
  vi.spyOn(publisher, 'render').mockImplementation(async (out, request) => {
    expect(request.old.key).toBe(keys[1]);
    fs.writeFileSync(path.join(out, 'round.json'), JSON.stringify({ units: {}, sections: [], loose: [] }));
  });
  const detail = await previewNoteOption(app, task.name, { id: 'chapter', round: 1, edits: [{ unit: selected.id, text: 'Procedure' }] });
  expect(detail.build?.targets).toEqual(targets);
  expect(completed.mock.calls).toEqual([[keys[0]], [keys[1]]]);
  expect(seed).not.toHaveBeenCalled();
  expect(build).toHaveBeenCalledExactlyOnceWith(detail.after, targets, info(keys[0]), { date });
});

it('preview caches follow rejection and undo without resurrecting a neighboring edit', async () => {
  const selected = units().find(unit => unit.new_text === 'Approach')!, neighbor = units().find(unit => unit.new_text === 'two')!;
  const pdf = path.join(app.state, 'preview-test.pdf'); fs.writeFileSync(pdf, 'test PDF');
  const build = vi.spyOn(Builder.prototype, 'build').mockImplementation(async rev => ({ key: rev, tree: rev, targets: ['full'], root: task.worktree, cwd: task.worktree, pdf, seconds: 0, warnings: [] }));
  vi.spyOn(publisher, 'render').mockImplementation(async out => {
    fs.writeFileSync(path.join(out, 'round.json'), JSON.stringify({ units: {}, sections: [], loose: [] }));
  });
  const input = { id: 'respect-rejection', round: 1, edits: [{ unit: selected.id, text: 'Procedure' }], rejected: [] as string[] };
  const first = await previewNoteOption(app, task.name, input);
  expect(app.repo.blob(first.after, METHOD)?.toString()).toContain('Procedure sentence two.');
  await app.review.decide(task.name, { id: 'reject-neighbor', round: 1, changes: [neighbor.id], action: 'reject' });
  // A rejection can land after the host checks its comparison key but before
  // the engine receives the preview request. Never cache that new state under
  // the browser's old key, which becomes reusable after undo.
  await expect(previewNoteOption(app, task.name, input)).rejects.toThrow('The review changed. Reload the options.');
  const second = await previewNoteOption(app, task.name, { ...input, rejected: [neighbor.id] });
  expect(second.files).not.toBe(first.files);
  expect(app.repo.blob(second.after, METHOD)?.toString()).toContain('Procedure sentence 2.');
  expect(second.units.map(unit => unit.id)).toEqual(first.units.filter(unit => unit.id !== neighbor.id).map(unit => unit.id));
  expect(f.read(METHOD, task.worktree)).toContain('Approach sentence 2.');
  await app.review.undo(task.name, 'reject-neighbor');
  await expect(previewNoteOption(app, task.name, { ...input, rejected: [neighbor.id] })).rejects.toThrow('The review changed. Reload the options.');
  expect((await previewNoteOption(app, task.name, input)).files).toBe(first.files);
  expect(build).toHaveBeenCalledTimes(4);
});

it('restores rejected multi-range and whole-file edits while adjusting the selected candidate', () => {
  const original = 'new word and tail';
  const selected = { ...units()[0], id: 'selected', file: 'main.tex', old_text: 'word', new_text: 'word', text_ops: [['replace', 4, 8, 4, 8]], ops: [['replace', 0, 1, 0, 1]] } as Unit;
  const rejected = { ...selected, id: 'rejected', text_ops: [['replace', 0, 3, 0, 3], ['replace', 13, 16, 13, 17]], ops: [['replace', 0, 1, 0, 1], ['replace', 0, 1, 0, 1]] } as typeof selected;
  const file = { ...selected, id: 'file', file: 'added.tex', whole_file: true };
  const candidate = optionCandidate([selected, rejected, file], [{ unit: selected.id, text: 'longer word' }], () => original,
    { ids: new Set(['rejected', 'file']), source: file => file === 'main.tex' ? Buffer.from('old word and end') : null });
  expect(candidate.files['main.tex']?.toString()).toBe('old longer word and end');
  expect(candidate.files['added.tex']).toBeNull();
  expect(candidate.units.map(unit => unit.id)).toEqual(['selected']);
});

it('a candidate restoring the original wording has no empty diff card or source row', async () => {
  const selected = units().find(unit => unit.new_text === 'Approach')!;
  const original = f.read(METHOD, task.worktree), round = app.review.latestRound(task.name)!;
  const pdf = path.join(app.state, 'preview-test.pdf'); fs.writeFileSync(pdf, 'test PDF');
  vi.spyOn(Builder.prototype, 'build').mockImplementation(async rev => ({ key: rev, tree: rev, targets: ['full'], root: task.worktree, cwd: task.worktree, pdf, seconds: 0, warnings: [] }));
  vi.spyOn(publisher, 'render').mockImplementation(async (out, request) => {
    expect(request.units.some(unit => unit.id === selected.id)).toBe(false);
    expect(app.repo.blob(request.new.tree, METHOD)?.toString()).toContain('Method sentence two.');
    fs.writeFileSync(path.join(out, 'round.json'), JSON.stringify({ units: {}, sections: [], loose: [] }));
  });
  const detail = await previewNoteOption(app, task.name, { id: 'restore-word', round: 1, edits: [{ unit: selected.id, text: selected.old_text }] });
  expect(detail.units.map(unit => unit.id)).toEqual(round.units.filter(unit => unit.id !== selected.id).map(unit => unit.id));
  expect(f.read(METHOD, task.worktree)).toBe(original);
  expect(app.review.latestRound(task.name)).toEqual(round);
  expect(app.review.decisions(task.name, round)[selected.id]).toBe('pending');
});

it('a failed candidate compilation leaves the published review and source intact', async () => {
  const selected = units().find(unit => unit.new_text === 'Approach')!;
  const round = app.review.latestRound(task.name), original = f.read(METHOD, task.worktree);
  vi.spyOn(Builder.prototype, 'build').mockRejectedValue(new Error('Invalid candidate LaTeX'));
  await expect(previewNoteOption(app, task.name, { id: 'bad-preview', round: 1, edits: [{ unit: selected.id, text: '\\broken' }] })).rejects.toThrow('Invalid candidate LaTeX');
  expect(f.read(METHOD, task.worktree)).toBe(original);
  expect(app.review.latestRound(task.name)).toEqual(round);
  expect(app.publisher.publish).not.toHaveBeenCalled();
});
