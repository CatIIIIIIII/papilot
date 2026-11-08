import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import type { ReviewSnapshot } from './ai-review.ts';

const { pdf, key, engine } = workerData as { pdf: string; key?: string; engine: string };
const { mupdf, walkText } = await import(pathToFileURL(path.join(engine, 'src/render/pdf.ts')).href);
const bytes = fs.readFileSync(pdf);
const document = mupdf.Document.openDocument(bytes, 'application/pdf');
const lines: ReviewSnapshot['lines'] = [];
try {
  for (let index = 0; index < document.countPages(); index++) {
    const page = document.loadPage(index);
    try {
      const [left, top, right, bottom] = page.getBounds();
      // Keep PdfPage's extraction flags: dropping vectors merges lines around
      // overbars and changes the saved line IDs. Only skip glyph/drawing analysis.
      const text = page.toStructuredText('preserve-whitespace,preserve-ligatures,vectors,preserve-images');
      try {
        let number = -1, value = '', bounds: number[] = [];
        walkText(text, {
          beginLine(rect: number[]) { number++; value = ''; bounds = rect; },
          onChar(char: string) { value += char; },
          endLine() {
            const clean = value.trim();
            if (!clean) return;
            const [x0, y0, x1, y1] = bounds;
            const rect = [(x0 - left) / (right - left), (y0 - top) / (bottom - top), (x1 - left) / (right - left), (y1 - top) / (bottom - top)]
              .map(value => Math.max(0, Math.min(1, value))) as ReviewSnapshot['lines'][number]['rect'];
            if (rect[2] <= rect[0] || rect[3] <= rect[1]) return;
            lines.push({ id: `p${index + 1}-l${number + 1}`, page: index, text: clean, rect });
          },
        });
      } finally { text.destroy(); }
    } finally { page.destroy(); }
  }
  if (!lines.length) throw new Error('This PDF has no selectable text to review.');
  parentPort!.postMessage({ key: key ?? createHash('sha256').update(bytes).digest('hex').slice(0, 16), lines } satisfies ReviewSnapshot);
} finally { document.destroy(); }
