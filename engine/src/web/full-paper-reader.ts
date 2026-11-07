import type { PDFDocumentProxy } from 'pdfjs-dist';
import { pdfZoom, PDF_ZOOM_STORAGE, readOutline, PDF_READER_COMMAND, PDF_READER_STATE, type PdfReaderCommand, type PdfReaderState } from './pdf-reader.ts';
import { fullPaperSearch } from './full-paper-search.ts';

interface Place { anchor: string; offset: number; top: number; left: number; zoom: string }
const memory = new Map<string, Place>();
function read(key: string): Place | undefined {
  try { return memory.get(key) ?? JSON.parse(localStorage.getItem(key) || 'null') ?? undefined; } catch { return memory.get(key); }
}

// The review opens PDF pages to insert before/after rows. Keep its rendering,
// but adapt those pages to the same navigation contract as the manuscript.
export function fullPaperReader(container: HTMLElement, root: HTMLElement, pdf: PDFDocumentProxy, key: string, restore: boolean) {
  const document = container.ownerDocument, view = document.defaultView!;
  const documentBox = container.closest<HTMLElement>('.document')!;
  let alive = true, initialized = false, tick = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let saved = read(key), position: Place | undefined, globalZoom: string | null = null;
  try { globalZoom = localStorage.getItem(PDF_ZOOM_STORAGE); } catch { /* Optional storage. */ }
  const savedPage = restore && saved ? Number(saved.anchor.split(':')[0]) + 1 : 1;
  let state: PdfReaderState = { pages: pdf.numPages, page: Number.isInteger(savedPage) ? Math.max(1, Math.min(pdf.numPages, savedPage)) : 1, zoom: { value: pdfZoom(saved?.zoom || globalZoom), scale: 1 }, outline: [], section: -1 };
  const pages = () => [...container.querySelectorAll<HTMLElement>('.paper-page')];
  const anchors = () => [...container.querySelectorAll<HTMLElement>('[data-reading-anchor]')];
  const top = (element: HTMLElement) => element.getBoundingClientRect().top - root.getBoundingClientRect().top;
  const capture = (): Place => {
    const list = anchors(), anchor = list.find(item => top(item) + item.offsetHeight > 0) || list.at(-1);
    return { anchor: anchor?.dataset.readingAnchor || '', offset: anchor ? -top(anchor) / Math.max(1, anchor.offsetHeight) : 0, top: root.scrollTop, left: root.scrollLeft, zoom: state.zoom.value };
  };
  const goBack = (place: Place) => {
    const anchor = anchors().find(item => item.dataset.readingAnchor === place.anchor);
    root.scrollTop = anchor ? root.scrollTop + top(anchor) + place.offset * anchor.offsetHeight : place.top;
    root.scrollLeft = place.left;
  };
  const persist = () => {
    clearTimeout(timer);
    if (!initialized || !root.clientHeight) return;
    saved = position = capture(); memory.set(key, saved);
    try { localStorage.setItem(key, JSON.stringify(saved)); } catch { /* Keep the tab-local place. */ }
  };
  let announced: PdfReaderState | undefined;
  const announce = (force = false) => {
    if (!force && announced && announced.page === state.page && announced.section === state.section && announced.outline === state.outline && announced.zoom.value === state.zoom.value && announced.zoom.scale === state.zoom.scale && announced.find === state.find) return;
    announced = state;
    view.dispatchEvent(new CustomEvent(PDF_READER_STATE, { detail: state }));
  };
  const search = fullPaperSearch(container, root, pdf, find => { state = { ...state, find }; announce(); });
  const update = () => {
    const list = pages();
    const visible = list.map((element, index) => ({ index, fraction: Math.max(0, Math.min(root.clientHeight, top(element) + element.offsetHeight) - Math.max(0, top(element))) / Math.max(1, element.offsetHeight) }));
    // Like PDF.js, keep a fully visible current page; otherwise report the
    // most visible page, including at the end of a short PDF on a tall phone.
    const current = visible[state.page - 1];
    const page = current?.fraction === 1 ? current.index : visible.sort((a, b) => b.fraction - a.fraction)[0]?.index ?? 0;
    let section = -1;
    state.outline.forEach((item, index) => {
      const element = list[item.page - 1];
      if (element && destination(element, item.top) <= root.scrollTop + root.clientHeight * 0.4) section = index;
    });
    if (root.scrollTop + root.clientHeight >= root.scrollHeight - 2 && state.outline.length) section = state.outline.length - 1;
    state = { ...state, page: page + 1, section };
    announce();
  };
  // Bookmarks use PDF coordinates. Find the surviving PDF band at that height;
  // a heading replaced by a change lands at that change's before/after row.
  function destination(element: HTMLElement, y: number | null) {
    const pageTop = root.scrollTop + top(element);
    if (y === null) return pageTop;
    const height = Number(element.dataset.pdfHeight), fromTop = height - y;
    const bands = [...element.querySelectorAll<HTMLElement>('[data-pdf-top]')];
    const band = bands.find(item => Number(item.dataset.pdfBottom) >= fromTop) || bands.at(-1);
    if (!band) return pageTop;
    const start = Number(band.dataset.pdfTop), end = Number(band.dataset.pdfBottom);
    return root.scrollTop + top(band) + Math.max(0, Math.min(1, (fromTop - start) / Math.max(1, end - start))) * band.offsetHeight;
  }
  const goTo = (page: number, y: number | null = null) => {
    const number = Math.max(1, Math.min(pdf.numPages, page)), element = pages()[number - 1];
    if (!element) return;
    state = { ...state, page: number };
    if (state.zoom.value === 'page-fit') resize();
    root.scrollTo({ top: destination(element, y), behavior: 'instant' });
    state = { ...state, page: number };
    root.focus({ preventScroll: true }); update();
  };
  const resize = () => {
    if (!root.clientWidth || !root.clientHeight) return;
    // ResizeObserver runs after layout changes; measure on scroll, before a
    // toolbar wraps or the pane changes width, rather than at that late point.
    const keep = initialized ? position : restore ? saved : undefined;
    const list = pages(), width = Number(list[0]?.dataset.pdfWidth), page = list[state.page - 1];
    if (!width || !page) return;
    const style = getComputedStyle(root), available = root.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const fit = available / (width * 96 / 72);
    let scale = Math.max(0.1, state.zoom.value === 'page-width' || state.zoom.value === 'page-fit' ? fit : Number(state.zoom.value));
    const size = (value: number) => { documentBox.style.width = `${width * 96 / 72 * value}px`; };
    documentBox.style.maxWidth = 'none';
    size(scale);
    if (state.zoom.value === 'page-fit') {
      // Review pages include fixed-height controls and inserted before/after
      // strips. Measure that layout, rather than the unexpanded PDF's height.
      const height = root.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      if (page.getBoundingClientRect().height > height) {
        let low = 0.1, high = scale;
        for (let step = 0; step < 12 && (high - low) * width * 96 / 72 > 0.5; step++) {
          const middle = (low + high) / 2; size(middle);
          if (page.getBoundingClientRect().height <= height) low = middle; else high = middle;
        }
        scale = low; size(scale);
      }
    }
    state = { ...state, zoom: { ...state.zoom, scale } };
    if (keep) goBack(keep);
    initialized = true; position = capture(); update();
  };
  const zoom = (value: string, origin?: [number, number]) => {
    // Anchor the actual slice under the fingers: a whole review page also
    // contains controls whose height does not scale with its PDF content.
    const hit = origin && document.elementFromPoint(...origin)?.closest<HTMLElement>('.paper-slice,.pdf-strip,[data-reading-anchor],.paper-page');
    const element = hit && container.contains(hit) ? hit : undefined, before = element?.getBoundingClientRect();
    const point = origin && before?.width && before.height ? [(origin[0] - before.left) / before.width, (origin[1] - before.top) / before.height] : undefined;
    const page = state.page;
    state = { ...state, zoom: { ...state.zoom, value: pdfZoom(value) } };
    if (value === 'page-fit') goTo(page); else resize();
    if (element && point && origin) {
      const after = element.getBoundingClientRect();
      root.scrollLeft += after.left + point[0] * after.width - origin[0];
      root.scrollTop += after.top + point[1] * after.height - origin[1];
    }
    persist(); update();
    try { localStorage.setItem(PDF_ZOOM_STORAGE, state.zoom.value); } catch { /* Optional storage. */ }
  };
  const command = (event: Event) => {
    const action = (event as CustomEvent<PdfReaderCommand>).detail;
    if (action.type === 'state') announce(true);
    else if (action.type === 'page') goTo(action.page);
    else if (action.type === 'outline') { const item = state.outline[action.index]; if (item) goTo(item.page, item.top); }
    else if (action.type === 'zoom') zoom(action.value);
    else if (action.type === 'zoomBy') zoom(String(Math.max(0.1, Math.min(10, state.zoom.scale * action.factor))));
    else if (action.type === 'find') search.search(action.query, action.again, action.previous);
    else if (action.type === 'closeFind') search.close();
  };
  const scroll = () => {
    position = capture();
    cancelAnimationFrame(tick); tick = requestAnimationFrame(update);
    clearTimeout(timer); timer = setTimeout(persist, 150);
  };
  const wheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault(); zoom(String(Math.max(0.1, Math.min(10, state.zoom.scale * Math.exp(-event.deltaY / 100)))), [event.clientX, event.clientY]);
  };
  const keyboard = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.defaultPrevented) return;
    if (event.key === '0') { event.preventDefault(); zoom('page-width'); }
    else if (['+', '=', '-'].includes(event.key)) { event.preventDefault(); zoom(String(Math.max(0.1, Math.min(10, state.zoom.scale * (event.key === '-' ? 1 / 1.1 : 1.1))))); }
  };
  let pinch: number | null = null;
  const spread = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  const touchStart = (event: TouchEvent) => { if (event.touches.length === 2) pinch = spread(event.touches); };
  const touchMove = (event: TouchEvent) => {
    if (pinch === null || event.touches.length !== 2) return;
    event.preventDefault();
    const distance = spread(event.touches);
    if (pinch > 0) zoom(String(Math.max(0.1, Math.min(10, state.zoom.scale * distance / pinch))), [(event.touches[0].clientX + event.touches[1].clientX) / 2, (event.touches[0].clientY + event.touches[1].clientY) / 2]);
    pinch = distance;
  };
  const touchEnd = () => { pinch = null; };
  const observer = new ResizeObserver(resize);
  // Hosts may replay an open search in response to the initial state event.
  view.addEventListener(PDF_READER_COMMAND, command);
  resize(); observer.observe(root);
  void readOutline(pdf).then(outline => { if (alive) { state = { ...state, outline }; update(); } }, () => {});
  view.addEventListener('keydown', keyboard);
  view.addEventListener('pagehide', persist);
  root.addEventListener('scroll', scroll, { passive: true });
  root.addEventListener('wheel', wheel, { passive: false });
  root.addEventListener('touchstart', touchStart, { passive: true });
  root.addEventListener('touchmove', touchMove, { passive: false });
  root.addEventListener('touchend', touchEnd);
  root.addEventListener('touchcancel', touchEnd);
  return {
    restored: Boolean(restore && saved),
    dispose() {
      persist(); alive = false; clearTimeout(timer); cancelAnimationFrame(tick); observer.disconnect(); search.dispose();
      root.removeEventListener('scroll', scroll); root.removeEventListener('wheel', wheel);
      root.removeEventListener('touchstart', touchStart); root.removeEventListener('touchmove', touchMove); root.removeEventListener('touchend', touchEnd); root.removeEventListener('touchcancel', touchEnd);
      view.removeEventListener(PDF_READER_COMMAND, command); view.removeEventListener('keydown', keyboard); view.removeEventListener('pagehide', persist);
      documentBox.style.removeProperty('width'); documentBox.style.removeProperty('max-width');
      view.dispatchEvent(new CustomEvent(PDF_READER_STATE, { detail: null }));
    },
  };
}
