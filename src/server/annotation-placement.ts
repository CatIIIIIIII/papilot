import { createHash } from 'node:crypto';
import type { Annotation } from '../shared.ts';

type Rect = Annotation['rect'];
interface Page {
  bounds: Rect;
  lines: { chars: { text: string; rect: Rect }[] }[];
  raster(clip: Rect, scale: number): { width: number; height: number; pixels: Uint8Array };
}
interface Document { length: number; page(index: number): Page }
export type AnnotationPlacement = Pick<Annotation, 'page' | 'rect' | 'rects'>;
const normalize = (text: string) => text.normalize('NFKC').replace(/[\s\u00ad]/gu, '');
const contains = (rect: Rect, glyph: Rect) => {
  const x = (glyph[0] + glyph[2]) / 2, y = (glyph[1] + glyph[3]) / 2;
  return x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3];
};
const union = (rects: Rect[]): Rect => [Math.min(...rects.map(r => r[0])), Math.min(...rects.map(r => r[1])), Math.max(...rects.map(r => r[2])), Math.max(...rects.map(r => r[3]))];

// Cache page evidence for the lifetime of one reconciliation batch. Pixel
// fingerprints ignore PDF timestamps and IDs but include figures and colors.
export class AnnotationPages {
  private hashes = new Map<number, string>();
  private texts = new Map<number, ReturnType<AnnotationPages['readText']>>();
  constructor(readonly document: Document) {}
  hash(index: number) {
    let hash = this.hashes.get(index);
    if (!hash) {
      const page = this.document.page(index), raster = page.raster(page.bounds, 1);
      hash = createHash('sha256').update(JSON.stringify([page.bounds, raster.width, raster.height])).update(raster.pixels).digest('hex');
      this.hashes.set(index, hash);
    }
    return hash;
  }
  private readText(index: number) {
    const page = this.document.page(index), glyphs: { rect: Rect; line: number }[] = [];
    let text = '';
    page.lines.forEach((line, number) => line.chars.forEach(char => {
      const value = normalize(char.text);
      text += value;
      // String.indexOf uses UTF-16 offsets, including for supplementary glyphs.
      for (let unit = 0; unit < value.length; unit++) glyphs.push({ rect: char.rect, line: number });
    }));
    return { text, glyphs, bounds: page.bounds };
  }
  text(index: number) {
    if (!this.texts.has(index)) this.texts.set(index, this.readText(index));
    return this.texts.get(index)!;
  }
}

// Reading a page's text or pixels takes milliseconds, and a search may read
// every page of a long PDF, so the server answers other requests between pages.
const breather = () => new Promise<void>(resolve => setImmediate(resolve));

export async function placeAnnotation(note: Annotation, previous: AnnotationPages, current: AnnotationPages): Promise<AnnotationPlacement | null> {
  if (note.page < 0 || note.page >= previous.document.length) return null;
  const samePage = (page: number) => previous.hash(note.page) === current.hash(page);
  if (note.page < current.document.length) {
    // Each fingerprint renders a page, so they take turns with other requests.
    previous.hash(note.page);
    await breather();
    if (samePage(note.page)) return { page: note.page, rect: note.rect, rects: note.rects };
    await breather();
  }

  // A box may contain a figure rather than text. Only move it automatically
  // when the entire original page still exists, exactly once, in the new PDF.
  if (!note.rects?.length) {
    const pages: number[] = [];
    for (let index = 0; index < current.document.length; index++) {
      if (index % 2 === 1) await breather();
      if (samePage(index)) pages.push(index);
    }
    return pages.length === 1 ? { page: pages[0], rect: note.rect, rects: note.rects } : null;
  }

  const old = previous.text(note.page), [x, y, right, bottom] = old.bounds;
  const clips = note.rects.map(([l, t, r, b]): Rect => [x + l * (right - x), y + t * (bottom - y), x + r * (right - x), y + b * (bottom - y)]);
  const selected = old.glyphs.flatMap((glyph, index) => clips.some(clip => contains(clip, glyph.rect)) ? [index] : []);
  if (!selected.length) return null;
  const start = selected[0], end = selected.at(-1)! + 1;
  const needle = old.text.slice(start, end), quote = normalize(note.quote);
  // The stored quote can be truncated; the original PDF retains the full range.
  if (!quote || !needle.startsWith(quote)) return null;
  const before = old.text.slice(Math.max(0, start - 32), start), after = old.text.slice(end, end + 32);
  const matches: { page: number; start: number }[] = [];
  for (let page = 0; page < current.document.length; page++) {
    if (page % 2 === 1) await breather();
    const text = current.text(page).text;
    for (let from = 0; from <= text.length - needle.length;) {
      const found = text.indexOf(needle, from);
      if (found < 0) break;
      matches.push({ page, start: found }); from = found + 1;
    }
  }
  let match = matches.length === 1 && needle.length >= 12 ? matches[0] : undefined;
  if (!match && before.length + after.length >= 24) {
    const contextual = matches.filter(candidate => {
      const text = current.text(candidate.page).text;
      return text.slice(Math.max(0, candidate.start - before.length), candidate.start) === before
        && text.slice(candidate.start + needle.length, candidate.start + needle.length + after.length) === after;
    });
    if (contextual.length === 1) match = contextual[0];
  }
  if (!match) return null;
  const next = current.text(match.page), lines = new Map<number, Rect[]>();
  for (const glyph of next.glyphs.slice(match.start, match.start + needle.length)) lines.set(glyph.line, [...(lines.get(glyph.line) || []), glyph.rect]);
  const [left, top, r, b] = next.bounds;
  const rects = [...lines.values()].map(rectangles => {
    const [x0, y0, x1, y1] = union(rectangles);
    return [(x0 - left) / (r - left), (y0 - top) / (b - top), (x1 - left) / (r - left), (y1 - top) / (b - top)] as Rect;
  });
  return { page: match.page, rect: union(rects), rects };
}
