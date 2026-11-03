import test from 'node:test';
import assert from 'node:assert/strict';
import { AnnotationPages, placeAnnotation } from '../src/server/annotation-placement.ts';
import type { Annotation } from '../src/shared.ts';

type Rect = Annotation['rect'];
function page(text: string, y = 20, drawing = '') {
  const lines = text.split('\n').map((line, index) => ({ chars: [...line].map((text, column) => ({ text, rect: [10 + column * 5, y + index * 15, 15 + column * 5, y + index * 15 + 10] as Rect })) }));
  return { bounds: [0, 0, 600, 800] as Rect, lines, raster: () => ({ width: 600, height: 800, pixels: new TextEncoder().encode(JSON.stringify([lines, drawing])) }) };
}
const pages = (...items: ReturnType<typeof page>[]) => new AnnotationPages({ length: items.length, page: index => items[index] });
function note(quote: string, rects = true): Annotation {
  const rect: Rect = [10 / 600, 20 / 800, (10 + [...quote].length * 5) / 600, 30 / 800];
  return { id: 'saved-note', projectId: 'paper', key: 'old-pdf', page: 0, rect, ...(rects ? { rects: [rect] } : {}), quote, comment: 'Keep my note.', source: null, createdAt: 1 };
}

test('unchanged PDF pages preserve text and region positions', async () => {
  const text = 'A uniquely marked sentence.';
  for (const textSelection of [true, false]) {
    const saved = note(text, textSelection);
    const result = await placeAnnotation(saved, pages(page(text)), pages(page(text)));
    assert.deepEqual(result, { page: 0, rect: saved.rect, rects: saved.rects });
    assert.equal(saved.key, 'old-pdf');
  }
});

test('text follows its unambiguous passage onto another page', async () => {
  const text = 'A uniquely marked sentence.', saved = note(text);
  const result = await placeAnnotation(saved, pages(page(text)), pages(page('Inserted content.'), page(text, 170)));
  assert.equal(result?.page, 1);
  assert.equal(result?.rect[1], 170 / 800);
  assert.equal(saved.comment, 'Keep my note.');
});

test('removed text and ambiguous copies retain their earlier anchors', async () => {
  const text = 'A uniquely marked sentence.', saved = note(text);
  assert.equal(await placeAnnotation(saved, pages(page(text)), pages(page('The original sentence was removed.'))), null);
  assert.equal(await placeAnnotation(saved, pages(page(text)), pages(page(text, 90), page(text, 170))), null);
});

test('short selections need their surrounding text to disambiguate them', async () => {
  const text = 'value', context = ' surrounded by enough unchanged context to identify the paragraph';
  assert.equal(await placeAnnotation(note(text), pages(page(text)), pages(page(text, 80))), null);
  const result = await placeAnnotation(note(text), pages(page(text + context)), pages(page('An unrelated value'), page(text + context, 80)));
  assert.equal(result?.page, 1);
});

test('a changed figure cannot inherit a region annotation merely because its text is unchanged', async () => {
  const saved = note('Figure caption.', false);
  assert.equal(await placeAnnotation(saved, pages(page(saved.quote, 20, 'old figure')), pages(page(saved.quote, 20, 'new figure'))), null);
  const moved = await placeAnnotation(saved, pages(page(saved.quote, 20, 'old figure')), pages(page('New cover'), page(saved.quote, 20, 'old figure')));
  assert.equal(moved?.page, 1);
});

test('a truncated stored quote still preserves the full highlighted passage', async () => {
  const text = 'A uniquely marked sentence that is longer than its stored preview.';
  const saved = { ...note(text), quote: text.slice(0, 18) };
  const result = await placeAnnotation(saved, pages(page(text)), pages(page(text, 80)));
  assert.equal(result?.rect[2], saved.rect[2]);
});
