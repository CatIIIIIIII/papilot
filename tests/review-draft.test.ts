import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewDraft, reviewCommentMark, reviewNoteSummary, reviewSubmission, type ReviewMark } from '../src/web/review-draft.ts';
const mark: ReviewMark = { strip: '1:before.svg', round: 1, stop: 0, where: 'Round 1 · PDF page 1 · Before · main.tex:2–4', quote: 'Original term', rects: [[0.1, 0.2, 0.4, 0.3]], region: false };
const storage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); } }; };
test('each alternative keeps its own comment and rejection in the unsent draft', () => {
  const saved = storage(), draft = new ReviewDraft('options', saved);
  const option = { ...mark, where: mark.where + ' · Option: Concise', option: { note: 'run:0', id: 'brief', label: 'Concise', kind: 'comment' as const } };
  const id = draft.add(option, false)!;
  draft.edit(id, 'Keep the technical term.');
  assert.equal(draft.add(option, false), id, 'reopening edits the same draft');
  const rejected = draft.add({ ...option, option: { ...option.option, id: 'specific', kind: 'reject' } }, false, 'Do not use this option.')!;
  const reopened = new ReviewDraft('options', saved);
  assert.equal(reopened.getSnapshot().notes.length, 2);
  assert.equal(reopened.getSnapshot().notes.find(note => note.id === id)?.comment, 'Keep the technical term.');
  reopened.remove(rejected);
  assert.equal(reopened.getSnapshot().notes.length, 1, 'undoing rejection leaves the other option comment intact');
  const summary = reviewNoteSummary(reopened.getSnapshot().notes[0]);
  assert.match(summary.where, /Option: Concise/);
  assert.equal(summary.comment, 'Keep the technical term.');
  assert.deepEqual(summary.anchor, { round: 1, sources: [{ file: 'main.tex', lines: [2, 4] }] });
});
test('review draft keeps exact before/after anchors across reload and delete/undo', () => {
  const saved = storage(), draft = new ReviewDraft('task', saved);
  draft.add(mark); const note = draft.getSnapshot().notes[0]; draft.edit(note.id, 'Keep it.');
  const reopened = new ReviewDraft('task', saved);
  assert.equal(reopened.getSnapshot().notes[0].comment, 'Keep it.');
  const summary = reviewNoteSummary(reopened.getSnapshot().notes[0]);
  assert.deepEqual(summary.anchor, { round: 1, sources: [{ file: 'main.tex', lines: [2, 4] }] });
  assert.equal(summary.quote, 'Original term'); assert.match(summary.where, /Before/);
  reopened.remove(note.id); assert.equal(reopened.getSnapshot().notes.length, 0);
  assert.equal(reopened.undo(), true); assert.equal(reopened.getSnapshot().notes[0].id, note.id);
});
test('a late send clears only submitted notes, preserving a draft edited elsewhere', () => {
  const saved = storage(), draft = new ReviewDraft('task', saved); draft.add(mark);
  const note = draft.getSnapshot().notes[0]; draft.edit(note.id, 'First comment');
  const submitted = draft.getSnapshot(); draft.setBusy(true);
  const reopened = new ReviewDraft('task', saved); reopened.edit(note.id, 'Updated comment');
  reopened.add({ ...mark, where: mark.where.replace('Before', 'After') });
  draft.clear(submitted); draft.setBusy(false);
  assert.equal(draft.getSnapshot().notes.length, 2);
  assert.equal(draft.getSnapshot().notes[0].comment, 'Updated comment');
});
test('a former floating-editor draft migrates, including clean strip identity', () => {
  const saved = storage(); saved.setItem('task', JSON.stringify({ notes: [], editing: { ...mark, strip: '1:before-clean.svg', comment: 'Recover me' } }));
  const draft = new ReviewDraft('task', saved);
  assert.equal(draft.getSnapshot().notes[0].strip, '1:before.svg');
  assert.equal(draft.getSnapshot().notes[0].comment, 'Recover me');
});
test('Comment reopens one overall comment per change while quotations stay independent', () => {
  const draft = new ReviewDraft('task', storage());
  draft.add({ ...mark, whole: true }); const first = draft.getSnapshot().notes[0];
  draft.edit(first.id, 'My overall comment');
  draft.add({ ...mark, whole: true }); draft.add({ ...mark, whole: true });
  assert.equal(draft.getSnapshot().notes.length, 1);
  assert.equal(draft.getSnapshot().notes[0].comment, 'My overall comment');
  assert.equal(draft.getSnapshot().editing?.id, first.id);
  draft.add(mark); draft.add({ ...mark, quote: 'Another term' });
  assert.equal(draft.getSnapshot().notes.length, 3);
  draft.add({ ...mark, whole: true, stop: 1 });
  draft.add({ ...mark, whole: true, round: 2 });
  assert.equal(draft.getSnapshot().notes.length, 5);
});
test('scoped comments preserve their exact units and never merge with the surrounding change', () => {
  const saved = storage(), draft = new ReviewDraft('task', saved);
  const selected = reviewCommentMark(mark, { round: 1, stop: 0, changes: ['c001'], scope: { where: 'After · main.tex:10', quote: 'efficient' } }, 'efficient and robust with five datasets');
  const id = draft.add(selected)!;
  draft.edit(id, 'Keep this concise.');
  assert.equal(draft.add(selected), id);
  draft.add({ ...selected, changes: ['c002'], quote: 'robust' });
  draft.add(reviewCommentMark(mark, { round: 1, stop: 0 }, 'efficient and robust with five datasets'));
  const reopened = new ReviewDraft('task', saved), notes = reopened.getSnapshot().notes;
  assert.equal(notes.length, 3);
  assert.deepEqual(notes[0].changes, ['c001']);
  assert.equal(notes[0].whole, false);
  assert.equal(notes[0].quote, 'efficient');
  const sent = reviewSubmission(reopened.getSnapshot()).notes.map(reviewNoteSummary);
  assert.equal(sent.length, 1);
  assert.match(sent[0].where, /Source changes: c001$/);
  assert.deepEqual(sent[0].anchor, { round: 1, sources: [{ file: 'main.tex', lines: [10, 10] }] });
});
test('reloading the first trial consolidates repeated overall drafts without losing text', () => {
  const saved = storage(); saved.setItem('task', JSON.stringify({ notes: [
    { ...mark, id: 'first', whole: true, comment: 'Keep the meaning.' },
    { ...mark, id: 'empty', whole: true, comment: '' },
    { ...mark, id: 'second', whole: true, comment: 'Shorten the wording.' },
  ] }));
  const draft = new ReviewDraft('task', saved);
  assert.equal(draft.getSnapshot().notes.length, 1);
  assert.equal(draft.getSnapshot().notes[0].comment, 'Keep the meaning.\n\nShorten the wording.');
});

test('empty comments do not block written notes, and stay in the draft after sending', () => {
  const draft = new ReviewDraft('task', storage());
  draft.add(mark); draft.add({ ...mark, whole: true });
  const [empty, written] = draft.getSnapshot().notes;
  draft.edit(written.id, 'A complete comment');
  const submitted = reviewSubmission(draft.getSnapshot());
  assert.deepEqual(submitted.notes.map(note => note.id), [written.id]);
  draft.clear(submitted);
  assert.deepEqual(draft.getSnapshot().notes.map(note => note.id), [empty.id]);
  assert.equal(reviewSubmission(draft.getSnapshot(), 'A separate message').notes.length, 0);
});
test('empty color marks need a shared direction, without blocking other comments', () => {
  const draft = new ReviewDraft('task', storage());
  draft.add({ ...mark, group: 'green' }); draft.add(mark);
  draft.edit(draft.getSnapshot().notes[1].id, 'A comment on another passage');
  assert.equal(reviewSubmission(draft.getSnapshot()).notes.length, 1);
  assert.equal(reviewSubmission(draft.getSnapshot(), 'Explain the highlighted passages').notes.length, 2);
  draft.instructions('Green: shorten this.');
  assert.equal(reviewSubmission(draft.getSnapshot()).notes.length, 2);
});

test('sending or deleting the revealed note releases its pinned review round', () => {
  const draft = new ReviewDraft('task', storage());
  draft.add(mark);
  const note = draft.getSnapshot().notes[0];
  draft.edit(note.id, 'Keep the term.');
  draft.reveal(note);
  draft.clear(reviewSubmission(draft.getSnapshot()));
  assert.equal(draft.getSnapshot().reveal, undefined);
  assert.equal(draft.getSnapshot().notes.length, 0);
  draft.add(mark);
  const next = draft.getSnapshot().notes[0];
  draft.reveal(next);
  draft.remove(next.id);
  assert.equal(draft.getSnapshot().reveal, undefined);
});


test('review tools retain deletion and quick-note intent through submission and reload', () => {
  const saved = storage(), draft = new ReviewDraft('task', saved);
  draft.add({ ...mark, kind: 'delete' }, false);
  draft.add({ ...mark, kind: 'point', stamp: 'Shorten' }, false, 'Make it concise.');
  draft.add(mark);
  const reopened = new ReviewDraft('task', saved);
  const sent = reviewSubmission(reopened.getSnapshot()).notes.map(reviewNoteSummary);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].kind, 'delete'); assert.equal(sent[0].comment, '');
  assert.equal(sent[1].kind, 'point'); assert.equal(sent[1].stamp, 'Shorten');
  assert.equal(sent[1].comment, 'Make it concise.'); assert.equal(sent[1].anchor?.round, 1);
});

test('review history preserves written text and drops redo after a new mark or send', () => {
  const draft = new ReviewDraft('task', storage()); draft.add(mark);
  const note = draft.getSnapshot().notes[0]; draft.edit(note.id, 'Keep this.');
  assert.equal(draft.undo(), true); assert.equal(draft.getSnapshot().notes.length, 0);
  assert.equal(draft.redo(), true); assert.equal(draft.getSnapshot().notes[0].comment, 'Keep this.');
  draft.remove(note.id); draft.undo(); assert.equal(draft.getSnapshot().notes[0].id, note.id);
  draft.setBusy(true); assert.equal(draft.undo(), false); assert.equal(draft.redo(), false);
  draft.setBusy(false); draft.add({ ...mark, kind: 'delete' }); assert.equal(draft.redo(), false);
  draft.clear(reviewSubmission(draft.getSnapshot())); assert.equal(draft.undo(), false);
});


test('review marks work on HTTP tailnet addresses without crypto.randomUUID', () => {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
  try {
    const draft = new ReviewDraft('task', storage()); draft.add(mark); draft.add(mark);
    const ids = draft.getSnapshot().notes.map(note => note.id);
    assert.match(ids[0], /^[a-f0-9]{32}$/); assert.notEqual(ids[0], ids[1]);
  } finally {
    if (descriptor) Object.defineProperty(crypto, 'randomUUID', descriptor);
    else Reflect.deleteProperty(crypto, 'randomUUID');
  }
});
