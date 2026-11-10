import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { PdfReader } from '../src/server/pdf-reader.ts';
import { AnnotationPages, placeAnnotation } from '../src/server/annotation-placement.ts';
import { PdfDocument, mupdf } from '../engine/src/render/pdf.ts';
import type { Annotation } from '../src/shared.ts';

type Rect = Annotation['rect'];
const paper = path.resolve('examples/papilot-paper/preview/main.pdf');

// The paper with a blank page in front, so that every page moves one on.
function shifted(folder: string) {
  const file = path.join(folder, 'shifted.pdf');
  const source = mupdf.Document.openDocument(fs.readFileSync(paper), 'application/pdf') as mupdf.PDFDocument;
  try {
    source.insertPage(0, source.addPage([0, 0, 612, 792], 0, {}, ''));
    const buffer = source.saveToBuffer('');
    try { fs.writeFileSync(file, buffer.asUint8Array()); } finally { buffer.destroy(); }
  } finally { source.destroy(); }
  return file;
}
// A line of the paper's text that a note marks, in page fractions.
function markedLine(pageNumber: number) {
  const document = new PdfDocument(paper);
  try {
    const page = document.page(pageNumber), [x0, y0, x1, y1] = page.bounds;
    const line = page.lines.find(line => line.text.trim().length > 30)!;
    const rect: Rect = [(line.rect[0] - x0) / (x1 - x0), (line.rect[1] - y0) / (y1 - y0), (line.rect[2] - x0) / (x1 - x0), (line.rect[3] - y0) / (y1 - y0)];
    const clip: Rect = [x0 + rect[0] * (x1 - x0), y0 + rect[1] * (y1 - y0), x0 + rect[2] * (x1 - x0), y0 + rect[3] * (y1 - y0)];
    return { rect, text: page.text(clip).replace(/�/g, '').replace(/\s+/g, ' ').trim() };
  } finally { document.close(); }
}
// What placing does on the event loop, as before the worker.
async function inProcess(note: Annotation, previous: string, current: string) {
  const before = new PdfDocument(previous), after = new PdfDocument(current);
  try { return await placeAnnotation(note, new AnnotationPages(before), new AnnotationPages(after)); }
  finally { before.close(); after.close(); }
}

test('notes are placed on a newer PDF in the worker, as on the event loop, which stays free', { timeout: 120000 }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-pdf-reader-')), reader = new PdfReader();
  try {
    const moved = shifted(folder), { rect, text } = markedLine(3);
    const note = (extra: Partial<Annotation>): Annotation => ({ id: 'note', projectId: 'paper', key: 'old', page: 3, rect, quote: text, comment: 'Keep this.', source: null, createdAt: 1, ...extra });
    // A marked region finds its whole page; a text selection finds its words.
    const notes = [note({}), note({ rects: [rect] })];
    const expected = [];
    for (const each of notes) expected.push(await inProcess(each, paper, moved));
    assert.deepEqual(expected.map(placement => placement?.page), [4, 4]);

    const before = performance.eventLoopUtilization();
    const placed = await reader.place(moved, notes.map(each => ({ note: each, previous: paper })));
    const busy = performance.eventLoopUtilization(before).utilization;
    assert.deepEqual(placed, expected);
    // Rendering and reading every page happened elsewhere: the event loop
    // mostly waited for the answer.
    assert.ok(busy < 0.5, `The event loop was busy ${Math.round(busy * 100)}% of the time while placing notes`);

    // A note whose earlier PDF is gone keeps its place; the others are still placed.
    assert.deepEqual(await reader.place(moved, [{ note: notes[1], previous: path.join(folder, 'missing.pdf') }, { note: notes[1], previous: paper }]), [null, expected[1]]);
    // A current PDF that cannot be read places nothing, and says so.
    await assert.rejects(reader.place(path.join(folder, 'missing.pdf'), [{ note: notes[1], previous: paper }]));
  } finally {
    await reader.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('a marked region is read in the worker: its words, and no page outside the PDF', { timeout: 120000 }, async () => {
  const reader = new PdfReader();
  try {
    const { rect, text } = markedLine(2);
    const located = await reader.locate({ pdf: paper, page: 2, rect, rects: [rect], selected: '' });
    assert.equal(located?.quote, text);
    assert.equal((await reader.locate({ pdf: paper, page: 2, rect, rects: [rect], selected: 'The selected words.' }))?.quote, 'The selected words.');
    assert.equal(await reader.locate({ pdf: paper, page: 99, rect, rects: [], selected: '' }), null);
  } finally { await reader.stop(); }
});

test('a stopped reader refuses work, and an idle worker ends without keeping the process alive', { timeout: 120000 }, async () => {
  const reader = new PdfReader(50);
  const { rect } = markedLine(0);
  assert.ok(await reader.locate({ pdf: paper, page: 0, rect, rects: [], selected: '' }));
  // The idle worker ends; the next request starts another.
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(await reader.locate({ pdf: paper, page: 0, rect, rects: [], selected: '' }));
  await reader.stop();
  await assert.rejects(reader.locate({ pdf: paper, page: 0, rect, rects: [], selected: '' }), /shutting down/);
});
