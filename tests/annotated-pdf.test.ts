import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as mupdf from 'mupdf';
import { annotatePdf, type ExportNote } from '../src/server/annotated-pdf.ts';

const input = fs.readFileSync('examples/papilot-paper/preview/main.pdf');
type Rect = [number, number, number, number];

// The rectangles of a phrase on a page, as fractions of the page, the way the
// PDF view stores a text note.
function mark(page: number, phrase: string): Rect[] {
  const document = mupdf.Document.openDocument(input, 'application/pdf'), loaded = document.loadPage(page);
  const [, , w, h] = loaded.getBounds(), [hit] = loaded.search(phrase, '');
  assert.ok(hit, phrase);
  return hit.map(q => [Math.min(q[0], q[4]) / w, Math.min(q[1], q[3]) / h, Math.max(q[2], q[6]) / w, Math.max(q[5], q[7]) / h]);
}
const note = (page: number, phrase: string, comment: string, extra: Partial<ExportNote> = {}): ExportNote => {
  const rects = mark(page, phrase);
  return { page, rect: rects[0], rects, comment, ...extra };
};
const open = (bytes: Uint8Array) => mupdf.Document.openDocument(bytes, 'application/pdf');
const text = (document: mupdf.Document, page: number) => document.loadPage(page).toStructuredText('').asText().replace(/\s+/g, ' ');
const links = (document: mupdf.Document, page: number) => document.loadPage(page).getLinks();
function outline(document: mupdf.Document) {
  const titles: string[] = [];
  const walk = (items: ReturnType<mupdf.Document['loadOutline']> | undefined) => { for (const item of items || []) { titles.push(item.title || ''); walk(item.down); } };
  walk(document.loadOutline());
  return titles;
}

test('the notes are drawn beside the paper, which keeps its pages, text, links and bookmarks', () => {
  const original = open(input);
  const output = open(annotatePdf(mupdf, input, [
    note(3, 'Papilot organises the loop around three commitments.', 'Name the sections that implement each commitment.', { group: 'green', author: 'Ada' }),
    note(3, 'Three commitments', '这里可以更具体一点：三个承诺分别对应哪一部分实现？'),
    note(3, 'unreviewed text cannot leak into the paper.', '', { group: 'yellow' }),
    { page: 0, rect: [0.15, 0.36, 0.85, 0.55], comment: 'Trim the abstract.' },
  ]));
  assert.equal(output.countPages(), original.countPages(), 'no extra pages when every comment fits');
  const [, , width, height] = original.loadPage(3).getBounds();
  for (const page of [0, 3, 10]) {
    const [, , w, h] = output.loadPage(page).getBounds();
    assert.equal(h, height);
    assert.equal(w, width + Math.round(width * 0.4), 'every page gets the same margin');
  }
  const page = text(output, 3);
  assert.ok(page.includes(text(original, 3).slice(0, 200)), 'the paper text is unchanged');
  assert.match(page, /Name the sections that implement each commitment\./);
  assert.match(page, /Ada/);
  assert.ok(page.replace(/ /g, '').includes('这里可以更具体一点：三个承诺分别对应哪一部分实现？'), 'CJK text wraps between characters');
  assert.match(text(output, 0), /Trim the abstract\./);
  // Cards follow reading order.
  assert.ok(page.indexOf('这里可以') < page.indexOf('Name the sections'));
  assert.doesNotMatch(page, /unreviewed text cannot leak into the paper\..*unreviewed text/, 'cards do not repeat the marked text');
  assert.deepEqual(links(output, 3).map(link => link.getURI()), links(original, 3).map(link => link.getURI()));
  assert.deepEqual(outline(output), outline(original));
});

test('comments the margin cannot hold are printed in full after the paper and linked both ways', () => {
  const long = 'A long remark that wraps over many lines in the margin, so that a crowded page has to shorten it and print the rest at the end. '.repeat(3).trim();
  const phrases = ['an algebra of edits', 'compatible edits commute', 'tight bounds', 'an estimate of the conflict rate', 'clustered edits', 'content-addressed build scheme', 'never recompiles', 'per-word runs bound the drift', 'turns a mark on the page', 'matches are unique', 'security model', 'model-based evaluation'];
  const original = open(input), count = original.countPages();
  const output = open(annotatePdf(mupdf, input, phrases.map(phrase => note(3, phrase, `${phrase}: ${long}`))));
  assert.ok(output.countPages() > count);
  const extra = Array.from({ length: output.countPages() - count }, (_, index) => text(output, count + index)).join(' ');
  // Every comment can be read in full, in the margin or after the paper.
  for (const phrase of phrases) assert.ok(text(output, 3).includes(`${phrase}: ${long}`) || extra.includes(`${phrase}: ${long}`), phrase);
  assert.ok(text(output, 3).includes('…'), 'the margin shortens some comments');
  const forward = links(output, 3).filter(link => !link.isExternal() && output.resolveLinkDestination(link).page >= count);
  assert.ok(forward.length > 0, 'a shortened card links to its full text');
  const back = links(output, count).map(link => output.resolveLinkDestination(link).page);
  assert.ok(back.length > 0 && back.every(page => page === 3), 'the full text links back to the page');
});

test('a PDF without notes is returned as it is', () => {
  assert.equal(annotatePdf(mupdf, input, []), input);
  assert.equal(annotatePdf(mupdf, input, [{ page: 999, rect: [0, 0, 1, 1], comment: 'gone' }]), input);
});
