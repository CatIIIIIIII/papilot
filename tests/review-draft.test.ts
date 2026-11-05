import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewDraft, reviewNoteSummary, reviewSubmission, type ReviewMark } from '../src/web/review-draft.ts';
const mark: ReviewMark = { strip: '1:before.svg', round: 1, stop: 0, where: 'Round 1 · PDF page 1 · Before · main.tex:2–4', quote: 'Original term', rects: [[0.1, 0.2, 0.4, 0.3]], region: false };
const storage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); } }; };
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
