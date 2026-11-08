import test from 'node:test';
import assert from 'node:assert/strict';
import { noteOptionContext, noteOptionsKey, parseNoteOptions, rebaseNoteOptions, selectedNoteOptions } from '../src/server/note-options.ts';
import { matchNoteChanges, type NoteRound } from '../src/server/note-results.ts';
import { Store } from '../src/server/store.ts';
import type { ReviewClient } from '../src/server/review.ts';
import type { Task } from '../src/shared.ts';

test('two notes in one PDF block select their own exact source ranges', () => {
  const text = 'The model is fast and the result is useful.';
  const detail: NoteRound = { round: 1, sections: [], loose: [{ kind: 'change', units: ['a', 'b'] }], units: [
    { id: 'a', file: 'main.tex', old_start: 1, old_end: 1, old_text: 'fast', new_text: 'efficient', text_ops: [['replace', 13, 17, 13, 22]], old_context: { text, start: 0 } },
    { id: 'b', file: 'main.tex', old_start: 1, old_end: 1, old_text: 'useful', new_text: 'practical', text_ops: [['replace', 36, 42, 41, 50]], old_context: { text, start: 0 } },
  ] };
  const note = { where: 'main.tex line 1', quote: 'The model is fast', comment: 'Polish', anchor: { sources: [{ file: 'main.tex', lines: [1, 1] as [number, number] }] } };
  assert.deepEqual(matchNoteChanges(note, detail, {}).flatMap(change => change.units), ['a']);
  assert.deepEqual(matchNoteChanges({ ...note, quote: 'the result is useful' }, detail, {}).flatMap(change => change.units), ['b']);
  assert.deepEqual(matchNoteChanges({ ...note, quote: text }, detail, {}).flatMap(change => change.units), ['a', 'b']);
});
test('options must be distinct and cover exactly the supplied edits', () => {
  const current = { id: 'current', label: 'Current', edits: [{ unit: 'a', text: 'efficient' }] };
  const valid = { options: ['quick', 'fast'].map(text => ({ label: text, reason: `Use ${text} to describe speed directly.`, edits: [{ unit: 'a', text }] })) };
  assert.equal(parseNoteOptions(JSON.stringify(valid), current).length, 2);
  assert.equal(parseNoteOptions(JSON.stringify(valid), current)[0].reason, valid.options[0].reason);
  for (const reason of [undefined, '', ' ', 'x'.repeat(181)]) assert.throws(() => parseNoteOptions(JSON.stringify({ options: [{ ...valid.options[0], reason }, valid.options[1]] }), current), /reason/);
  assert.throws(() => parseNoteOptions(JSON.stringify({ options: [valid.options[0], valid.options[0]] }), current), /repeated/);
  assert.throws(() => parseNoteOptions(JSON.stringify({ options: [{ label: 'escape', reason: 'Escape the source range.', edits: [{ unit: 'b', text: 'oops' }] }, valid.options[0]] }), current), /invalid/);
});

test('choices and the selected alternative survive publication and a fresh context read', async () => {
  const store = new Store(':memory:');
  try {
    const task = { id: 'task', name: 'task', status: 'reviewing', review: { round: 2 } } as Task;
    const note = { where: 'main.tex line 1', quote: 'The estimates are stable.', comment: 'Clarify stability.' };
    store.saveRun({ id: 'run', taskId: 'task', requestKey: 'run', prompt: '', createdAt: 1, finishedAt: 2, status: 'completed', reviewRound: 2, noteRounds: { 0: 1 } });
    store.saveItem({ id: 'run', taskId: 'task', type: 'user', text: '', createdAt: 1, meta: { notes: [note] } });
    const unit = { id: 'a', file: 'main.tex', old_start: 1, old_end: 1, old_text: 'stable', new_text: 'robust', kind: 'text', text_ops: [['replace', 18, 24, 18, 24]] as NoteRound['units'][number]['text_ops'], old_context: { text: note.quote, start: 0 } };
    const rounds: Record<number, NoteRound> = {
      1: { round: 1, units: [unit], sections: [], loose: [{ kind: 'change', units: ['a'] }] },
      2: { round: 2, units: [{ ...unit, id: 'b', new_text: 'numerically stable' }], sections: [], loose: [{ kind: 'change', units: ['b'] }] },
    };
    const choices = ['robust', 'reliable', 'numerically stable'].map((text, index) => ({ id: index ? `option-${index}` : 'current', label: text, reason: text, edits: [{ unit: 'a', text }] }));
    store.savePreference(noteOptionsKey('task', 'run:0', 1), { round: 1, key: 'run:0', options: choices.slice(1) });
    const client = { get: async (route: string) => route.includes('/rounds/') ? rounds[Number(route.split('/').at(-1))] : { latest: 2, closed: false, decisions: { a: 'pending', b: 'pending' } } } as unknown as ReviewClient;
    for (let read = 0; read < 2; read++) {
      const { options } = await noteOptionContext(store, task, 'run:0', client);
      assert.equal(options.selected, 'option-2');
      assert.deepEqual(options.options.map(option => option.edits), choices.map(option => [{ ...option.edits[0], unit: 'b' }]));
      assert.equal(options.locked, undefined);
    }
    rounds[2].units[0].new_text = 'robust';
    assert.equal((await noteOptionContext(store, task, 'run:0', client)).options.selected, 'current', 'the initial proposal remains selectable');
  } finally { store.close(); }
});

test('overlapping choices reflect actual wording and ambiguous source ranges are not reused', () => {
  const initial = { id: 'current', label: 'Initial', edits: [{ unit: 'a', text: 'efficient' }, { unit: 'b', text: 'robust' }] };
  const brief = { id: 'brief', label: 'Brief', edits: [{ unit: 'a', text: 'quick' }, { unit: 'b', text: 'reliable' }] };
  const actual = { ...initial, edits: [brief.edits[0], initial.edits[1]] };
  const result = selectedNoteOptions([initial, brief], actual);
  assert.equal(result.selected, 'latest');
  assert.deepEqual(result.options[0].edits, actual.edits);
  assert.deepEqual(result.options.slice(1), [initial, brief]);
  const unit = { id: 'a', file: 'main.tex', old_start: 1, old_end: 1, old_text: 'fast', new_text: 'efficient' };
  assert.deepEqual(rebaseNoteOptions([{ ...initial, edits: [initial.edits[0]] }], [unit], [unit, { ...unit, id: 'b' }]), []);
});

test('short source options rebase by exact offsets only when the baseline is unchanged', () => {
  const previous = { id: 'a', file: 'sentence.tex', old_start: 1, old_end: 1, old_text: 'fast', new_text: 'quick', text_ops: [['replace', 2, 6, 2, 7]] as NoteRound['units'][number]['text_ops'], old_context: { text: 'A fast dog.', start: 0 } };
  const next = { ...previous, id: 'b', new_text: 'speedy' };
  const options = [{ id: 'current', label: 'Initial', edits: [{ unit: 'a', text: 'quick' }] }, { id: 'specific', label: 'Specific', reason: 'Clarify speed.', edits: [{ unit: 'a', text: 'speedy' }] }];
  assert.deepEqual(rebaseNoteOptions(options, [previous], [next], true).map(option => option.edits), [[{ unit: 'b', text: 'quick' }], [{ unit: 'b', text: 'speedy' }]]);
  assert.deepEqual(rebaseNoteOptions(options, [previous], [next], false), []);
  assert.deepEqual(rebaseNoteOptions(options, [previous], [{ ...next, text_ops: [['replace', 4, 8, 4, 10]] }], true), [], 'same baseline must use the exact range, not similar context');
  const source = { ...previous, old_context: { ...previous.old_context, source_hash: 'same-file-hash' } };
  const rebased = { ...next, old_context: source.old_context };
  assert.deepEqual(rebaseNoteOptions(options, [source], [rebased], false).map(option => option.edits), [[{ unit: 'b', text: 'quick' }], [{ unit: 'b', text: 'speedy' }]], 'the same file is sufficient even when an unrelated acceptance changes the baseline commit');
  assert.deepEqual(rebaseNoteOptions(options, [source], [{ ...rebased, old_context: { ...rebased.old_context, source_hash: 'changed-file-hash' } }], false), [], 'a short context must not prove unchanged source');
  assert.deepEqual(rebaseNoteOptions(options, [source], [{ ...rebased, text_ops: [['replace', 4, 8, 4, 10]] }], false), [], 'matching file hashes still require matching offsets');
  assert.deepEqual(rebaseNoteOptions(options, [source], [rebased, { ...rebased, id: 'c' }], false), [], 'an ambiguous source mapping stays unavailable');
});
