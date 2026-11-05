import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { parseAiReview, reviewPrompt, type ReviewSnapshot } from '../src/server/ai-review.ts';
import { Manuscripts } from '../src/server/manuscript.ts';

const snapshot: ReviewSnapshot = { key: 'original-pdf', lines: [
  { id: 'p1-l1', page: 0, text: 'The method always converges.', rect: [0.1, 0.1, 0.8, 0.12] },
  { id: 'p1-l2', page: 0, text: 'No assumptions are required.', rect: [0.1, 0.13, 0.7, 0.15] },
  { id: 'p2-l1', page: 1, text: 'Experiments', rect: [0.1, 0.1, 0.5, 0.12] },
] };
const finding = { start: 'p1-l1', end: 'p1-l2', comment: 'State the conditions needed for convergence.' };
const reply = (notes: unknown) => JSON.stringify({ summary: 'Clarify the convergence claim.', notes });

test('review findings use saved PDF geometry and remove identical duplicate notes', () => {
  const result = parseAiReview(reply([finding, finding]), snapshot);
  assert.equal(result.notes.length, 1);
  assert.deepEqual(result.notes[0], { page: 0, rect: [0.1, 0.1, 0.8, 0.15], rects: snapshot.lines.slice(0, 2).map(line => line.rect), quote: 'The method always converges. No assumptions are required.', comment: finding.comment });
  assert.equal(parseAiReview('```json\n' + reply([]) + '\n```', snapshot).notes.length, 0);
  assert.match(reviewPrompt('Check claims.', snapshot), /p1-l1/);
  assert.doesNotMatch(reviewPrompt('', snapshot), /rect/);
});

test('malformed, nonexistent, backwards and cross-page anchors are rejected as one batch', () => {
  for (const note of [{ ...finding, start: 'imaginary' }, { ...finding, end: 'p2-l1' }, { ...finding, start: 'p1-l2', end: 'p1-l1' }, { ...finding, comment: '' }]) {
    assert.throws(() => parseAiReview(reply([finding, note]), snapshot));
  }
  for (const text of ['not JSON', '{}', JSON.stringify({ summary: '', notes: [] })]) assert.throws(() => parseAiReview(text, snapshot));
});

test('a valid same-page passage may exceed the preferred highlight length', () => {
  const long: ReviewSnapshot = { key: 'pdf', lines: Array.from({ length: 30 }, (_, index) => ({ id: `p13-l${index + 1}`, page: 12, text: `Line ${index + 1}.`, rect: [0.1, index / 40, 0.8, (index + 1) / 40] })) };
  for (const count of [3, 4, 12, 13, 14, 30]) {
    const result = parseAiReview(reply([{ start: 'p13-l1', end: `p13-l${count}`, comment: 'Clarify how this paragraph handles reflow.' }]), long);
    assert.equal(result.notes.length, 1);
    assert.equal(result.notes[0].page, 12);
    assert.deepEqual(result.notes[0].rects, long.lines.slice(0, count).map(line => line.rect));
    assert.deepEqual(result.notes[0].rect, [0.1, 0, 0.8, count / 40]);
    assert.match(result.notes[0].quote, new RegExp(`Line ${count}\\.$`));
  }
});

test('location errors distinguish missing IDs, reversed ranges and page boundaries', () => {
  assert.throws(() => parseAiReview(reply([{ ...finding, end: 'missing' }]), snapshot), /unknown PDF location/);
  assert.throws(() => parseAiReview(reply([{ ...finding, start: 'p1-l2', end: 'p1-l1' }]), snapshot), /reverse order/);
  assert.throws(() => parseAiReview(reply([{ ...finding, end: 'p2-l1' }]), snapshot), /multiple PDF pages/);
});

test('a real PDF produces stable line IDs and normalized highlights on the original version', async () => {
  const captured = await new Manuscripts().snapshotPdf(path.resolve('tests/fixtures/outline.pdf'), 'original-pdf');
  assert.ok(captured.lines.length > 10);
  assert.equal(new Set(captured.lines.map(line => line.id)).size, captured.lines.length);
  for (const line of captured.lines) {
    assert.ok(line.text.trim());
    assert.ok(line.rect.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
    assert.ok(line.rect[0] < line.rect[2] && line.rect[1] < line.rect[3]);
    assert.ok(line.id.startsWith(`p${line.page + 1}-l`));
  }
  const first = captured.lines[0];
  const result = parseAiReview(reply([{ start: first.id, end: first.id, comment: 'Clarify this heading.' }]), captured);
  assert.deepEqual(result.notes[0].rect, first.rect);
});


test('review output retains large batches, long comments, summaries and complete quotations', () => {
  const text = 'A passage that must reach the reviewer intact. '.repeat(100);
  const input: ReviewSnapshot = { key: 'long', lines: [{ ...snapshot.lines[0], text }] };
  const summary = 'Review summary. '.repeat(1000), comment = 'Explain the missing assumption. '.repeat(200);
  const notes = Array.from({ length: 600 }, (_, index) => ({ start: 'p1-l1', end: 'p1-l1', comment: `${index}: ${comment}` }));
  const result = parseAiReview(JSON.stringify({ summary, notes }), input);
  assert.equal(result.summary, summary.trim());
  assert.equal(result.notes.length, 600);
  assert.equal(result.notes[599].comment, notes[599].comment.trim());
  assert.equal(result.notes[599].quote, text);
});

test('PDF extraction and agent input preserve manuscripts beyond 180,000 characters', async () => {
  const mupdf = await import('mupdf'), document = new mupdf.PDFDocument();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-long-review-'));
  try {
    const resources = document.addObject(document.newDictionary()), fonts = document.newDictionary();
    fonts.put('F1', document.addSimpleFont(new mupdf.Font('Times-Roman'))); resources.put('Font', fonts);
    const line = 'This is a complete manuscript line with assumptions and evidence for the review. ';
    for (let page = 0; page < 50; page++) {
      const content = `BT /F1 8 Tf 10 TL 20 760 Td ${Array.from({ length: 60 }, (_, index) => `(${page + 1}-${index + 1}: ${line}) Tj T*`).join(' ')} ET`;
      document.insertPage(-1, document.addPage([0, 0, 600, 800], 0, resources, content));
    }
    const pdf = path.join(root, 'long.pdf');
    fs.writeFileSync(pdf, document.saveToBuffer('').asUint8Array());
    const captured = await new Manuscripts().snapshotPdf(pdf, 'long-pdf');
    assert.ok(captured.lines.reduce((sum, line) => sum + line.text.length, 0) > 180000);
    assert.equal(captured.lines.length, 3000);
    assert.match(captured.lines.at(-1)!.text, /^50-60:/);
    const prompt = reviewPrompt('Review chapter 50 in detail.', { ...captured, pdf });
    assert.ok(prompt.includes(captured.lines.at(-1)!.text));
    assert.ok(prompt.includes('Review chapter 50 in detail.'));
    assert.ok(prompt.includes(pdf));
  } finally { document.destroy(); fs.rmSync(root, { recursive: true, force: true }); }
});
