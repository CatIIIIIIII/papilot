import type { PDFDocumentProxy } from 'pdfjs-dist';

// Shared by the manuscript reader and the PDF with inline review changes.
export interface OutlineItem { title: string; level: number; dest: unknown; page: number; top: number | null }
export const DEFAULT_PDF_ZOOM = 'page-width';
export const PDF_ZOOM_STORAGE = 'papilot:pdf-zoom';
export const PDF_ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
export function pdfZoom(value?: string | null) {
  return value === 'page-width' || value === 'page-fit' || (value && Number(value) >= 0.1 && Number(value) <= 10) ? value! : DEFAULT_PDF_ZOOM;
}

export async function readOutline(document: PDFDocumentProxy) {
  const items: OutlineItem[] = [];
  async function walk(nodes: Awaited<ReturnType<PDFDocumentProxy['getOutline']>> | undefined, level: number) {
    for (const node of nodes || []) {
      const dest = typeof node.dest === 'string' ? await document.getDestination(node.dest).catch(() => null) : node.dest;
      let page = 0, top: number | null = null;
      if (Array.isArray(dest) && dest[0] !== undefined && dest[0] !== null) {
        page = typeof dest[0] === 'number' ? dest[0] + 1 : await document.getPageIndex(dest[0]).then(index => index + 1, () => 0);
        const kind = (dest[1] as { name?: string } | undefined)?.name;
        top = kind === 'XYZ' && typeof dest[3] === 'number' ? dest[3] : (kind === 'FitH' || kind === 'FitBH') && typeof dest[2] === 'number' ? dest[2] : null;
      }
      if (page) items.push({ title: node.title.trim(), level, dest: node.dest, page, top });
      await walk(node.items, level + 1);
    }
  }
  await walk(await document.getOutline(), 0);
  return items;
}

// The embedded review supplies a reader adapter; Papilot renders exactly the
// same controls as for the manuscript. No PDF or review data crosses origins.
export const PDF_READER_STATE = 'latex-review:pdf-reader-state';
export const PDF_READER_COMMAND = 'latex-review:pdf-reader-command';
export interface PdfReaderState {
  pages: number; page: number; zoom: { value: string; scale: number };
  outline: OutlineItem[]; section: number;
  find?: { current: number; total: number; notFound: boolean };
}
export type PdfReaderCommand = { type: 'state' } | { type: 'page'; page: number } | { type: 'outline'; index: number } | { type: 'zoom'; value: string } | { type: 'zoomBy'; factor: number } | { type: 'find'; query: string; again: boolean; previous: boolean } | { type: 'closeFind' };
