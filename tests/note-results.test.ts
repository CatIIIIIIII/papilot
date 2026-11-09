import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { matchNoteChanges, taskNoteResults, type NoteRound } from '../src/server/note-results.ts';
import { noteAnchor, reviewNotesInstructions } from '../src/notes.ts';
import type { NoteSummary, Run, Task, TimelineItem } from '../src/shared.ts';
import type { ReviewClient } from '../src/server/review.ts';
import { diffUnits } from '../engine/src/core/changes.ts';
import { Fixture, fakeRound, METHOD } from '../engine/tests/ts/helpers.ts';
import { optionCandidate } from '../engine/src/core/option-preview.ts';

const note: NoteSummary = { id: 'n1', where: 'Page 2 · main.tex lines 10–12', quote: 'The original technical sentence.', comment: 'Shorten it.', anchor: { sources: [{ file: 'main.tex', lines: [10, 12] }] } };

test('a focused note includes its verified wrapping changes without accepting another word on that line', () => {
  const text = 'The model is fast and\nthe result is stable.\n';
  const unit = (id: string, start: number, old: string, next: string, formattingFor?: string): NoteRound['units'][number] => ({ id, file: 'main.tex', old_start: 1, old_end: 2, old_text: old, new_text: next, formattingFor, text_ops: [['replace', start, start + old.length, start, start + next.length]], old_context: { text, start: 0 } });
  const units = [unit('word', text.indexOf('fast'), 'fast', 'efficient'), unit('space', text.indexOf('\n'), '\n', ' ', 'word'), unit('other', text.indexOf('stable'), 'stable', 'robust')];
  const detail: NoteRound = { round: 1, units, sections: [], loose: [{ kind: 'change', units: units.map(unit => unit.id) }] };
  const changes = matchNoteChanges({ where: 'main.tex line 1', quote: 'The model is fast', comment: 'Clarify speed.' }, detail, { word: 'pending', space: 'pending', other: 'pending' });
  assert.deepEqual(changes.map(change => change.units), [['word', 'space']]);
});
const detail: NoteRound = {
  round: 1,
  units: [
    { id: 'c1', file: 'main.tex', old_start: 10, old_end: 11, old_text: note.quote, new_text: 'A shorter sentence.' },
    { id: 'c2', file: 'main.tex', old_start: 12, old_end: 14, old_text: 'A second sentence.', new_text: 'Another.' },
    { id: 'c3', file: 'other.tex', old_start: 10, old_end: 11, old_text: note.quote, new_text: 'A different paper section.' },
    { id: 'c4', file: 'main.tex', old_start: 40, old_end: 42, old_text: 'Unrelated content.', new_text: 'Revised unrelated content.' },
  ],
  sections: [{ blocks: [{ kind: 'context' }, { kind: 'change', units: ['c1'], before: [{ text: [{ text: note.quote }] }] }, { kind: 'change', units: ['c2'] }] }],
  loose: [{ kind: 'change', units: ['c3'] }, { kind: 'change', units: ['c4'] }],
};

test('source anchors link every overlapping change in viewer order, with actual review decisions', () => {
  assert.deepEqual(matchNoteChanges(note, detail, { c1: 'accepted', c2: 'rejected' }), [
    { round: 1, stop: 0, units: ['c1'], state: 'accepted', match: 'source' },
    { round: 1, stop: 1, units: ['c2'], state: 'rejected', match: 'source' },
  ]);
  assert.deepEqual(matchNoteChanges({ ...note, quote: '', anchor: { sources: [{ file: 'main.tex', lines: [80, 90] }] } }, detail, {}), []);
});

test('older locations are recovered and review quotes survive shifted source lines', () => {
  assert.deepEqual(noteAnchor({ where: 'Round 1 · PDF page 2 · Before · Change 2 · a file.tex:26–43, 50; b.tex:2 · p. 2', quote: '', comment: '' }), { round: 1, sources: [{ file: 'a file.tex', lines: [26, 43] }, { file: 'a file.tex', lines: [50, 50] }, { file: 'b.tex', lines: [2, 2] }] });
  const review = { ...note, anchor: { round: 1, sources: [{ file: 'main.tex', lines: [35, 36] as [number, number] }] } };
  const links = matchNoteChanges(review, { ...detail, round: 2 }, {});
  assert.equal(links.length, 1); assert.equal(links[0].stop, 0); assert.equal(links[0].match, 'quote');
  assert.deepEqual(matchNoteChanges({ ...review, quote: 'x' }, detail, {}), [], 'short common text is not enough evidence');
  assert.deepEqual(matchNoteChanges({ ...review, quote: 'No such text appears in the changes.' }, detail, {}), []);
});

test('a title word links to its definition even when SyncTeX points at maketitle', () => {
  const title: NoteSummary = { where: 'Page 1 · main.tex line 10', quote: 'Manuscripts', comment: 'Change this word.' };
  const round: NoteRound = { round: 1, units: [{ id: 'c1', file: 'main.tex', old_start: 4, old_end: 4, old_text: '\\title{Papilot for LaTeX Manuscripts}', new_text: '\\title{Papilot for LaTeX Papers}' }], sections: [], loose: [{ kind: 'change', units: ['c1'] }] };
  assert.equal(matchNoteChanges(title, round, {})[0]?.match, 'quote');
  const ambiguous = { ...round, units: [...round.units, { ...round.units[0], id: 'c2' }], loose: [...round.loose, { kind: 'change', units: ['c2'] }] };
  assert.deepEqual(matchNoteChanges({ ...title, quote: 'LaTeX' }, ambiguous, {}), [], 'a short repeated word is not enough to select a change');
});

test('note links stay with the published run, never the queued follow-up or latest unrelated round', async () => {
  const task = { id: 'task', name: 'p-task', status: 'reviewing', review: { round: 3 } } as Task;
  const run = { id: 'run1', taskId: task.id, reviewRound: 1, status: 'completed' } as Run;
  const items: TimelineItem[] = [
    { id: run.id, taskId: task.id, type: 'user', text: '', meta: { notes: [note] }, createdAt: 1 },
    { id: 'queued', taskId: task.id, type: 'user', text: '', meta: { notes: [note] }, createdAt: 2 },
    { id: 'unchanged', taskId: task.id, type: 'user', text: '', meta: { notes: [note] }, createdAt: 3 },
  ];
  const routes: string[] = [];
  const client = { get: async (route: string) => { routes.push(route); return route.includes('/rounds/') ? detail : { decisions: { c1: 'accepted', c2: 'pending' } }; } } as unknown as ReviewClient;
  const results = await taskNoteResults(task, items, [run, { ...run, id: 'queued', reviewRound: 0, status: 'queued' }, { ...run, id: 'unchanged', reviewRound: null }], client);
  assert.deepEqual(results.map(result => [result.round, result.state]), [[1, 'matched'], [null, 'waiting'], [null, 'unmatched']]);
  assert.deepEqual(routes.sort(), ['/api/tasks/p-task/rounds/1', '/api/tasks/p-task/state?round=1']);
  const unpublished = await taskNoteResults(task, [items[1]], [{ ...run, id: 'queued', reviewRound: 0 }], client);
  assert.equal(unpublished[0].state, 'waiting', 'a finished run awaiting a successful build cannot use an older round');
  const legacy = { ...items[0], id: 'old', text: reviewNotesInstructions([{ where: 'Page 2 · main.tex lines 10–12', quote: note.quote, comment: note.comment }]), meta: undefined };
  const old = await taskNoteResults({ ...task, review: { ...task.review!, round: 1 } }, [legacy], [], client);
  assert.equal(old[0].state, 'matched');
  await assert.rejects(taskNoteResults(task, [items[0]], [run], { get: async () => ({}) } as unknown as ReviewClient), /could not be loaded/, 'missing review data is not reported as an unmatched note');
});

test('option rebuilds retain accepted shared edits and follow pending fragments into the new round', async () => {
  const task = { id: 'task', name: 'p-task', status: 'reviewing', review: { round: 2 } } as Task;
  const run = { id: 'run', requestKey: 'options', prompt: '', createdAt: 1, finishedAt: 2, taskId: task.id, reviewRound: 2, noteRounds: { 0: 1 }, status: 'completed' } as Run;
  const item = { id: run.id, taskId: task.id, type: 'user', text: '', meta: { notes: [note] }, createdAt: 1 };
  const next: NoteRound = { round: 2, units: [{ ...detail.units[0], id: 'c7', new_text: 'A different option.' }], sections: [], loose: [{ kind: 'change', units: ['c7'] }] };
  const client = { get: async (route: string) => route.includes('/rounds/') ? route.endsWith('/1') ? detail : next : route.endsWith('=1') ? { decisions: { c1: 'pending', c2: 'accepted' } } : { decisions: { c7: 'pending' } } } as unknown as ReviewClient;
  const [result] = await taskNoteResults(task, [item], [run], client);
  assert.equal(result.round, 2);
  assert.deepEqual(result.changes.map(change => [change.round, change.units, change.state]), [[2, ['c7'], 'pending'], [1, ['c2'], 'accepted']]);
});

test('formatted PDF quotes select only their exact source edits, and unresolved quotes fail closed', () => {
  const before = 'The model is \\emph{fast} and the estimates are stable.\n';
  const after = before.replace('fast', 'efficient').replace('stable', 'robust');
  const repo = { changedFiles: () => ['main.tex'], blobs: (rev: string) => ({ 'main.tex': Buffer.from(rev === 'old' ? before : after) }) } as unknown as Parameters<typeof diffUnits>[0];
  const units = diffUnits(repo, 'old', 'new').map(unit => ({ ...unit, old_context: { text: before, start: 0 } }));
  const round: NoteRound = { round: 1, units, sections: [], loose: [{ kind: 'change', units: units.map(unit => unit.id), before: [{ text: [{ text: 'The model is fast and the estimates are stable.' }] }] }] };
  const annotation = { where: 'main.tex line 1', quote: 'The model is fast', comment: 'Improve speed.' };
  assert.deepEqual(matchNoteChanges(annotation, round, {}).flatMap(change => change.units), [units[0].id]);
  assert.deepEqual(matchNoteChanges({ ...annotation, quote: 'the estimates are stable' }, round, {}).flatMap(change => change.units), [units[1].id]);
  assert.deepEqual(matchNoteChanges({ ...annotation, quote: 'Text generated by a macro' }, round, {}), [], 'a failed quote match must not widen to all edits on the source line');
  const repeated = { ...round, units: units.map(unit => ({ ...unit, old_context: { text: before + before, start: 0 } })) };
  assert.deepEqual(matchNoteChanges({ ...annotation, where: 'main.tex lines 1–2' }, repeated, {}), [], 'an ambiguous quote must not widen to all edits either');
  assert.deepEqual(matchNoteChanges(annotation, repeated, {}).flatMap(change => change.units), [units[0].id], 'the original manuscript line disambiguates repeated text');
  for (const command of ['\\label', '\\cite', '\\custom']) {
    const hidden = { ...round, units: units.map(unit => ({ ...unit, old_context: { text: before + `${command}{hidden phrase}`, start: 0 } })) };
    assert.deepEqual(matchNoteChanges({ ...annotation, quote: 'hidden phrase' }, hidden, {}), [], 'macro arguments are not proof of printed text');
  }
});

test('repeated short quotes use original source lines, including clipped context excerpts', () => {
  const before = 'Header.\nA small example.\nUnchanged.\nAnother small example.\n';
  const after = before.replaceAll('small', 'short');
  const repo = { changedFiles: () => ['main.tex'], blobs: (rev: string) => ({ 'main.tex': Buffer.from(rev === 'old' ? before : after) }) } as unknown as Parameters<typeof diffUnits>[0];
  const units = diffUnits(repo, 'old', 'new').map(unit => ({ ...unit, old_context: { text: before.slice(4), start: 4 } }));
  const round: NoteRound = { round: 1, units, sections: [], loose: units.map(unit => ({ kind: 'change', units: [unit.id] })) };
  const annotation = { where: 'main.tex line 2', quote: 'small', comment: 'Shorten.' };
  assert.deepEqual(matchNoteChanges(annotation, round, {}).flatMap(change => change.units), [units[0].id]);
  assert.deepEqual(matchNoteChanges({ ...annotation, where: 'main.tex line 4' }, round, {}).flatMap(change => change.units), [units[1].id]);
  assert.deepEqual(matchNoteChanges({ ...annotation, where: 'main.tex lines 2–4' }, round, {}), []);
  assert.deepEqual(matchNoteChanges({ ...annotation, where: 'Round 1 · main.tex line 2' }, round, {}), [], 'review lines refer to a different source revision');
  assert.deepEqual(matchNoteChanges({ ...annotation, where: 'Page 1' }, round, {}), []);
  const sameLine = { ...round, units: units.map(unit => ({ ...unit, old_context: { text: before.replaceAll('\n', ' '), start: 0 } })) };
  assert.deepEqual(matchNoteChanges(annotation, sameLine, {}), [], 'two occurrences on the same line remain ambiguous');
});

test('notes beside rewritten math and lists keep independent badges, options and acceptance', async () => {
  const fixture = new Fixture();
  const before = 'A small example.\n\n\\[\\begin{aligned}x &= 1 \\\\ y &= 2\\end{aligned}\\]\n\nThe intermediate result is clear.\n\n\\begin{enumerate}\n\\item First check.\n\\item Second check.\n\\end{enumerate}\n\nThe compiler gives immediate feedback.\n\nThe Boolean argument reveals an error.\n';
  const after = before.replace('small', 'short').replace('y &= 2', 'y &= 3').replace('clear', 'concise')
    .replace('\\begin{enumerate}\n', '').replaceAll('\\item ', '').replace('\\end{enumerate}\n', '')
    .replace('immediate', 'early').replace('an error', 'a type error');
  try {
    fixture.write(METHOD, before);
    const app = fixture.app(); await app.ready;
    const task = app.tasks.create('independent-notes', 'Independent notes', [], ['paper']);
    fixture.edit(task, METHOD, before, after);
    const published = fakeRound(app, task.name), detail = app.review.roundDetail(task.name, published.number);
    // All changes can share a PDF crop without sharing their decision units.
    const round: NoteRound = { ...detail, sections: [], loose: [{ kind: 'change', units: detail.units.map(unit => unit.id) }] };
    const quotes = ['small', 'The intermediate result is clear.', 'The compiler gives immediate feedback.', 'The Boolean argument reveals an error.'];
    const links = quotes.map(quote => matchNoteChanges({ where: `${METHOD} line ${before.slice(0, before.indexOf(quote)).split('\n').length}`, quote, comment: 'Clarify.' }, round, {}).flatMap(change => change.units));
    assert.ok(links.every(ids => ids.length > 0));
    assert.equal(new Set(links.flat()).size, links.flat().length, 'the four note badges never point at the same unit');
    const selected = published.units.filter(unit => links[1].includes(unit.id));
    assert.equal(selected.length, 1);
    const variants = ['brief', 'explicit'].map(text => optionCandidate(published.units, [{ unit: selected[0].id, text }], () => after));
    assert.notEqual(variants[0].files[METHOD]?.toString(), variants[1].files[METHOD]?.toString());
    assert.equal(variants[0].files[METHOD]?.toString(), after.replace('concise', 'brief'));
    assert.equal(variants[1].files[METHOD]?.toString(), after.replace('concise', 'explicit'));
    await app.review.decide(task.name, { action: 'accept', round: published.number, changes: links[1] });
    assert.equal(fixture.read(METHOD), before.replace('clear', 'concise'), 'accepting note 7 cannot accept note 3, 8, 9 or the math/list');
    const decisions = app.review.decisions(task.name, published);
    assert.ok([...links[0], ...links[2], ...links[3]].every(id => decisions[id] === 'pending'));
  } finally { await fixture.close(); }
});

test('short included sources retain exact note identity and decisions across option rounds', async () => {
  const text = 'A fast dog.\n', unit = { id: 'a', file: 'sentence.tex', old_start: 1, old_end: 1, old_text: 'fast', new_text: 'quick', text_ops: [['replace', 2, 6, 2, 7]] as NoteRound['units'][number]['text_ops'], old_context: { text, start: 0 } };
  const rounds: Record<number, NoteRound> = {
    1: { before: 'same-base', round: 1, units: [unit], sections: [], loose: [{ kind: 'change', units: ['a'] }] },
    2: { before: 'same-base', round: 2, units: [{ ...unit, id: 'b', new_text: 'speedy' }], sections: [], loose: [{ kind: 'change', units: ['b'] }] },
  };
  const task = { id: 'task', name: 'task', status: 'reviewing', review: { round: 2 } } as Task;
  const run = { id: 'run', requestKey: 'options', prompt: '', createdAt: 1, finishedAt: 2, taskId: task.id, status: 'completed', reviewRound: 2, noteRounds: { 0: 1 } } as Run;
  const item = { id: 'run', taskId: task.id, type: 'user', createdAt: 1, text: '', meta: { notes: [{ where: 'sentence.tex line 1', quote: text, comment: 'Improve.' }] } };
  const client = { get: async (route: string) => route.includes('/rounds/') ? rounds[Number(route.split('/').at(-1))] : { decisions: route.endsWith('=1') ? { a: 'pending' } : { b: 'accepted' } } } as unknown as ReviewClient;
  const [result] = await taskNoteResults(task, [item], [run], client);
  assert.equal(result.round, 2);
  assert.deepEqual(result.changes.map(change => [change.round, change.units, change.state]), [[2, ['b'], 'accepted']]);
  rounds[2].before = 'different-base';
  const [unresolved] = await taskNoteResults(task, [item], [run], client);
  assert.equal(unresolved.round, 1, 'offsets alone must not match against a different baseline');
});

test('short note sources retain their identity after accepting another file', async () => {
  const fixture = new Fixture(), file = 'paper/short.tex', text = 'A fast dog.\n';
  try {
    fixture.write(file, text);
    fixture.repo.run(['add', file]);
    fixture.repo.run(['commit', '-qm', 'Add included source']);
    const app = fixture.app(); await app.ready;
    const engineTask = app.tasks.create('short-note', 'Short note', [], ['paper'], true);
    fixture.edit(engineTask, file, 'fast', 'quick');
    fixture.edit(engineTask, METHOD, 'Method sentence 2.', 'Approach sentence 2.');
    const first = fakeRound(app, engineTask.name);
    await app.review.decide(engineTask.name, { round: first.number, action: 'accept', changes: first.units.filter(unit => unit.file === METHOD).map(unit => unit.id) });
    fixture.edit(engineTask, file, 'quick', 'speedy');
    const second = fakeRound(app, engineTask.name);
    await app.review.decide(engineTask.name, { round: second.number, action: 'accept', changes: second.units.filter(unit => unit.file === file).map(unit => unit.id) });
    const old = app.review.roundDetail(engineTask.name, first.number), next = app.review.roundDetail(engineTask.name, second.number);
    assert.notEqual(old.before, next.before, 'accepting another file changes the baseline commit');
    const hash = createHash('sha256').update(text).digest('hex');
    assert.equal(old.units.find(unit => unit.file === file)?.old_context?.source_hash, hash);
    assert.equal(next.units.find(unit => unit.file === file)?.old_context?.source_hash, hash);
    const task = { id: 'task', name: engineTask.name, status: 'reviewing', review: { round: second.number } } as Task;
    const run = { id: 'run', requestKey: 'options', prompt: '', createdAt: 1, finishedAt: 2, taskId: task.id, status: 'completed', reviewRound: second.number, noteRounds: { 0: first.number } } as Run;
    const item = { id: run.id, taskId: task.id, type: 'user', text: '', createdAt: 1, meta: { notes: [{ where: `${file} line 1`, quote: text, comment: 'Improve.' }] } };
    const client = { get: async (route: string) => {
      const number = Number(route.match(/(?:rounds\/|round=)(\d+)/)![1]);
      const round = app.review.roundDetail(engineTask.name, number);
      return route.includes('/rounds/') ? { ...round, loose: [{ kind: 'change', units: round.units.map(unit => unit.id) }] } : { decisions: app.review.decisions(engineTask.name, app.review.round(engineTask.name, number)) };
    } } as unknown as ReviewClient;
    const [result] = await taskNoteResults(task, [item], [run], client);
    assert.equal(result.round, second.number);
    assert.deepEqual(result.changes.map(change => change.state), ['accepted']);
  } finally { await fixture.close(); }
});
