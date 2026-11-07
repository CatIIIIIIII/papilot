import type { PDFDocumentProxy } from 'pdfjs-dist';
import { EventBus, FindState, PDFFindController, SimpleLinkService } from 'pdfjs-dist/web/pdf_viewer.mjs';

// Use PDF.js's matching engine in both readers (including accents and matches
// spanning text runs). The review maps the results into its surviving slices.
export function fullPaperSearch(container: HTMLElement, root: HTMLElement, pdf: PDFDocumentProxy, onChange: (state: { current: number; total: number; notFound: boolean }) => void) {
  const bus = new EventBus();
  class Links extends SimpleLinkService {
    override get pagesCount() { return pdf.numPages; }
    override get page() {
      const pages = [...container.querySelectorAll<HTMLElement>('.paper-page')];
      return Math.max(1, pages.findIndex(page => page.getBoundingClientRect().bottom > root.getBoundingClientRect().top) + 1);
    }
    // Match geometry below scrolls the paper only, never the embedding document.
    override set page(_page: number) {}
  }
  const find = new PDFFindController({ eventBus: bus, linkService: new Links() });
  find.setDocument(pdf);
  const text = new Map<number, Promise<Awaited<ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['getTextContent']>>>>();
  let alive = true, generation = 0, query = '', revealed = '', count = { current: 0, total: 0, notFound: false };
  const clear = () => container.querySelectorAll('.paper-find-mark').forEach(mark => mark.remove());
  const update = async () => {
    const version = ++generation;
    clear();
    if (!find.highlightMatches) return;
    const selected = find.selected;
    if (!selected) return;
    const revealKey = `${query}:${selected.pageIdx}:${selected.matchIdx}`;
    for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex++) {
      const matches = find.pageMatches?.[pageIndex], lengths = find.pageMatchesLength?.[pageIndex];
      const page = container.querySelector<HTMLElement>(`.paper-page[data-page="${pageIndex}"]`);
      if (!matches?.length || !lengths || !page) continue;
      if (!text.has(pageIndex)) text.set(pageIndex, pdf.getPage(pageIndex + 1).then(page => page.getTextContent({ disableNormalization: true })));
      const content = await text.get(pageIndex)!;
      if (!alive || version !== generation) return;
      const slices = [...page.querySelectorAll<HTMLElement>('.paper-slice')];
      const height = Number(page.dataset.pdfHeight);
      let offset = 0;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const start = offset;
        // PDF.js maps normalized results back to text without synthetic EOLs.
        offset += item.str.length;
        for (const [index, match] of matches.entries()) {
          if (match >= offset || match + lengths[index] <= start || !item.str.length) continue;
          const selectedMatch = pageIndex === selected.pageIdx && index === selected.matchIdx;
          const left = item.transform[4] + item.width * Math.max(0, match - start) / item.str.length;
          const right = item.transform[4] + item.width * Math.min(item.str.length, match + lengths[index] - start) / item.str.length;
          const bottom = height - item.transform[5], top = bottom - item.height;
          let target: HTMLElement | undefined;
          for (const slice of slices) {
            const x0 = Number(slice.dataset.left), x1 = Number(slice.dataset.right), y0 = Number(slice.dataset.top), y1 = Number(slice.dataset.bottom);
            const x = Math.max(x0, left), y = Math.max(y0, top), r = Math.min(x1, right), b = Math.min(y1, bottom);
            if (r <= x || b <= y) continue;
            const mark = container.ownerDocument.createElement('span');
            mark.className = 'paper-find-mark' + (selectedMatch ? ' selected' : '');
            Object.assign(mark.style, { left: `${(x - x0) / (x1 - x0) * 100}%`, top: `${(y - y0) / (y1 - y0) * 100}%`, width: `${(r - x) / (x1 - x0) * 100}%`, height: `${(b - y) / (y1 - y0) * 100}%` });
            slice.append(mark); target ||= mark;
          }
          // A match in replaced lines points to their review row.
          target ||= [...page.querySelectorAll<HTMLElement>('[data-pdf-top]')].find(band => Number(band.dataset.pdfTop) <= top && Number(band.dataset.pdfBottom) >= top);
          if (selectedMatch && target && revealed !== revealKey) {
            revealed = revealKey;
            root.scrollTop += target.getBoundingClientRect().top - root.getBoundingClientRect().top - root.clientHeight / 3;
          }
        }
      }
    }
  };
  const render = () => { void update().catch(() => {}); };
  bus.on('updatetextlayermatches', render);
  bus.on('updatefindmatchescount', ({ matchesCount }: { matchesCount: { current: number; total: number } }) => { if (alive) { count = { ...count, ...matchesCount }; onChange(count); } });
  bus.on('updatefindcontrolstate', ({ state, matchesCount }: { state: number; matchesCount?: { current: number; total: number } }) => { if (alive) { count = { ...count, ...matchesCount, notFound: state === FindState.NOT_FOUND }; onChange(count); } });
  return {
    search(value: string, again: boolean, previous: boolean) {
      if (value !== query) { generation++; clear(); count = { current: 0, total: 0, notFound: false }; onChange(count); }
      revealed = '';
      query = value;
      bus.dispatch('find', { source: null, type: again ? 'again' : '', query, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: previous, matchDiacritics: false });
    },
    close() { bus.dispatch('findbarclose', { source: null }); clear(); },
    dispose() {
      alive = false; generation++; bus.dispatch('findbarclose', { source: null });
      // PDF.js accepts null to cancel extraction; its declaration omits null.
      (find.setDocument as (document: PDFDocumentProxy | null) => void)(null);
      clear();
    },
  };
}
