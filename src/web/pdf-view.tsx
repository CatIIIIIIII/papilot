import type { NoteGroup } from '../note-groups.ts';
import { GroupPicker, GroupAction, groupName, groupStyle } from './note-groups.tsx';
import { forwardRef, Fragment, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { EventBus, FindState, LinkTarget, PDFFindController, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import viewerStyles from 'pdfjs-dist/web/pdf_viewer.css?inline';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Annotation, MarkKind } from '../shared.ts';
import { loadStamps, useStamps, type Stamp } from './stamps.ts';
import { StampWheel } from './stamp-wheel.tsx';
import { PdfToolRail, TOOL_KEYS, type PdfTool } from './pdf-tool-rail.tsx';
import { PdfContents, PdfPageControls, PdfFind, PdfFindButton } from './pdf-controls.tsx';
import { readOutline, pdfZoom, PDF_ZOOM_STORAGE, type OutlineItem } from '../../engine/src/web/pdf-reader.ts';
import { Icon } from './icons.tsx';
import { browserStorage } from './storage.ts';
import { readPlace, savePlace } from './places.ts';
import { mergeLines } from './note-geometry.ts';
import { touchSelection } from './touch-select.ts';
import { t } from './i18n.ts';
import { PdfNoteCard, type PdfNoteActions } from './pdf-suggestion.tsx';
import { cMapData } from '../../engine/src/web/pdf-cmaps.ts';

pdfjs.GlobalWorkerOptions.workerSrc = worker;
const CMapData = cMapData(import.meta.glob<string>('../../node_modules/pdfjs-dist/cmaps/*.bcmap', { eager: true, import: 'default', query: '?url&no-inline' }));

// The pdf.js stylesheet also styles pdf.js's own app (.sidebar, .dialog) and
// sets a dark color scheme on :root; keep all of it inside the viewer.
const styles = document.createElement('style');
styles.textContent = `@scope (.pdf-view) {${viewerStyles.replaceAll(':root', ':scope').replace(/color-scheme:\s*light dark;?/g, '')}}`;
document.head.append(styles);

export type { PdfTool } from './pdf-tool-rail.tsx';
export type Rect = [number, number, number, number];
export type { OutlineItem } from '../../engine/src/web/pdf-reader.ts';
// `showPlace` scrolls a place into view and marks it briefly; with `keep`,
// a place already in view is marked without moving the pages.
export interface PdfHandle { goTo: (item: OutlineItem) => void; goToNote: (note: Annotation) => void; showPlace: (page: number, rect: Rect, options?: { keep?: boolean }) => void; focus: () => void; fitWidth: () => void }
// A touch selection also has its ends: the edge of its first and last word, with that line's top and bottom.
interface Selection { page: number; rects: Rect[]; quote: string; handles?: { from: [number, number, number]; to: [number, number, number] } }
// What a tool marks: selected text, a region, or a point (a small box quoted
// by the line at or beside it, with the word clicked and the words before it
// on that line).
export interface Target { page: number; rect: Rect; rects: Rect[]; quote: string; point?: boolean; word?: { text: string; context: string } }
// A passage the viewer's owner is working on, marked on its page.
export interface PdfPassage { page: number; marks: Rect[] }
const unit = (value: number) => Math.min(1, Math.max(0, value));
const percent = ([x0, y0, x1, y1]: Rect): React.CSSProperties => ({ left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` });
const bounds = (rects: Rect[]): Rect => [Math.min(...rects.map(r => r[0])), Math.min(...rects.map(r => r[1])), Math.max(...rects.map(r => r[2])), Math.max(...rects.map(r => r[3]))];
const center = (rect: Rect): React.CSSProperties => ({ left: `${(rect[0] + rect[2]) * 50}%`, top: `${(rect[1] + rect[3]) * 50}%` });
const typing = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"]'));

function closeDocument(task?: PDFDocumentLoadingTask) {
  void task?.destroy().catch(failure => console.error('Unable to close PDF', failure));
}

// A point is a small box where the author clicked. Its quote is the line of
// text at or beside it, with ‸ where the point falls, so the agent can find it.
function pointAt(pageDiv: HTMLElement, clientX: number, clientY: number): Target {
  const frame = pageDiv.getBoundingClientRect();
  const x = unit((clientX - frame.left) / frame.width), y = unit((clientY - frame.top) / frame.height);
  const words = Array.from(pageDiv.querySelectorAll<HTMLElement>('.textLayer span')).filter(span => !span.firstElementChild && span.textContent?.trim()).map(span => {
    const box = span.getBoundingClientRect();
    return { text: span.textContent!.trim(), left: (box.left - frame.left) / frame.width, right: (box.right - frame.left) / frame.width, top: (box.top - frame.top) / frame.height, bottom: (box.bottom - frame.top) / frame.height };
  }).filter(word => word.bottom > word.top);
  // Prefer the line the point is on over a word straight above or below it.
  let nearest: typeof words[number] | undefined, distance = Infinity;
  for (const word of words) {
    const dy = y < word.top ? word.top - y : y > word.bottom ? y - word.bottom : 0, dx = x < word.left ? word.left - x : x > word.right ? x - word.right : 0;
    if (dy * 4 + dx < distance) { distance = dy * 4 + dx; nearest = word; }
  }
  let quote = '', word: Target['word'];
  if (nearest && distance < 0.12) {
    const middle = (nearest.top + nearest.bottom) / 2, height = nearest.bottom - nearest.top;
    const line = words.filter(word => Math.abs((word.top + word.bottom) / 2 - middle) < height / 2).sort((a, b) => a.left - b.left);
    quote = [...line.filter(word => (word.left + word.right) / 2 < x).map(word => word.text), '‸', ...line.filter(word => (word.left + word.right) / 2 >= x).map(word => word.text)].join(' ');
    const away = (word: typeof line[number]) => x < word.left ? word.left - x : x > word.right ? x - word.right : 0;
    const clicked = line.reduce((best, word) => away(word) < away(best) ? word : best, line[0]);
    if (clicked) word = { text: clicked.text, context: line.slice(0, line.indexOf(clicked)).map(word => word.text).join(' ') };
  }
  return { page: Number(pageDiv.dataset.pageNumber) - 1, rect: [Math.max(0, x - 0.006), Math.max(0, y - 0.004), Math.min(1, x + 0.006), Math.min(1, y + 0.004)], rects: [], quote, point: true, ...(word ? { word } : {}) };
}

// A note covers whole words: a drag that starts or ends inside a word takes
// all of it, so the quote is readable and the highlight matches it. Only a
// boundary that cuts through a word widens; one already beside a word (the
// browser often ends a drag at the start of the next word) stays. Returns the
// widened range and the word pieces it added at each end.
function wholeWords(selected: Range) {
  const range = selected.cloneRange(), letter = /[\p{L}\p{N}]/u, start = range.startContainer, end = range.endContainer;
  let before = '', after = '';
  if (start.nodeType === Node.TEXT_NODE) {
    const text = start.textContent || ''; let at = range.startOffset;
    if (letter.test(text[at] || '')) while (at > 0 && letter.test(text[at - 1])) at--;
    before = text.slice(at, range.startOffset); range.setStart(start, at);
  }
  if (end.nodeType === Node.TEXT_NODE) {
    const text = end.textContent || ''; let at = range.endOffset;
    if (at > 0 && letter.test(text[at - 1])) while (at < text.length && letter.test(text[at])) at++;
    after = text.slice(range.endOffset, at); range.setEnd(end, at);
  }
  return { range, before, after };
}

// pdf.js lays each line of text out as one run in a stand-in font, which
// drifts from the printed words mid-line, so a drag selects other words than
// the ones under the pointer. The server reads each word's printed place from
// the PDF; selection and search use one run per word from it, placed on the
// word's baseline, and fall back to pdf.js's own text if that is unavailable.
type Words = { words: [string, number, number, number, number, number][] };
function exactText(document: PDFDocumentProxy, source: string) {
  const getPage = document.getPage.bind(document), pages = new Map<number, Promise<PDFPageProxy>>();
  document.getPage = (number: number) => {
    if (!pages.has(number)) pages.set(number, getPage(number).then(page => {
      if (page.rotate % 360 !== 0) return page;
      const own = page.streamTextContent.bind(page);
      let exact: Promise<ReturnType<typeof textContent> | null> | null = null;
      const content = () => exact ??= fetch(`${source}&page=${number - 1}`).then(response => response.ok ? response.json() : null).then((data: Words | null) => data ? textContent(data, page.view) : null, () => null);
      // pdf.js's getTextContent reads this stream, so it gets the word places
      // too. Without them the stream falls back to pdf.js's own stream: its
      // getTextContent would read this one again, forever, and freeze the tab.
      page.streamTextContent = ((params?: Parameters<PDFPageProxy['streamTextContent']>[0]) => {
        let fallback: ReadableStreamDefaultReader | null = null;
        return new ReadableStream({
          async pull(controller) {
            if (!fallback) {
              const words = await content();
              if (words) { controller.enqueue(words); controller.close(); return; }
              fallback = own(params).getReader();
            }
            const chunk = await fallback.read();
            if (chunk.done) controller.close(); else controller.enqueue(chunk.value);
          },
          cancel: reason => fallback?.cancel(reason),
        });
      }) as PDFPageProxy['streamTextContent'];
      return page;
    }));
    return pages.get(number)!;
  };
}
// A word followed by another on its line carries the space and reaches the
// next word's start, so a drag can begin in the gap between words.
function textContent({ words }: Words, view: number[]) {
  const items = words.map(([str, left, baseline, size, width, eol], index) => {
    const next = words[index + 1], joined = !eol && next && next[1] > left;
    return { str: joined ? str + ' ' : str, dir: 'ltr', width: joined ? next[1] - left : width, height: size, transform: [size, 0, 0, size, view[0] + left, view[3] - baseline], fontName: 'exact', hasEOL: Boolean(eol) };
  });
  return { items, styles: { exact: { fontFamily: 'serif', ascent: 0.8, descent: -0.2, vertical: false } }, lang: null };
}

// Number tags sit in the page margin level with the first marked line, on the
// side nearer the mark. Narrow pages stack colliding numbers down the margin;
// wider pages have room for named quick notes and horizontal groups.
const tagWidth = (name?: string) => name ? 30 + [...name].reduce((width, letter) => width + (letter.charCodeAt(0) > 0x2e80 ? 12 : 7), 0) : 20;
function tagSpots(tags: { rect: Rect; name?: string }[], narrowHeight?: number) {
  if (narrowHeight) {
    const spots = tags.map(({ rect }) => ({ side: (rect[0] + rect[2]) / 2 > 0.5 ? 'right' : 'left', top: (rect[1] + rect[3]) / 2 * narrowHeight }));
    for (const side of ['left', 'right']) {
      const column = spots.filter(spot => spot.side === side).sort((a, b) => a.top - b.top);
      // Keep 20px markers apart, including notes on nearby wrapped lines.
      for (let i = 0; i < column.length; i++) column[i].top = Math.max(column[i].top, i ? column[i - 1].top + 24 : 10);
      for (let i = column.length - 1; i >= 0; i--) column[i].top = Math.min(column[i].top, i < column.length - 1 ? column[i + 1].top - 24 : narrowHeight - 10);
    }
    return spots.map(spot => ({ [spot.side]: 8, top: `${spot.top / narrowHeight * 100}%` }) as React.CSSProperties);
  }
  const placed: { side: 'left' | 'right'; top: number; width: number }[] = [];
  return tags.map(({ rect, name }) => {
    const side: 'left' | 'right' = (rect[0] + rect[2]) / 2 > 0.5 ? 'right' : 'left', top = (rect[1] + rect[3]) / 2;
    const offset = placed.filter(spot => spot.side === side && Math.abs(spot.top - top) < 0.015).reduce((sum, spot) => sum + spot.width + 4, 0);
    placed.push({ side, top, width: tagWidth(name) });
    return { [side]: 8 + offset, top: `${top * 100}%` } as React.CSSProperties;
  });
}

// A pdf.js viewer that behaves like a local PDF reader: continuous pages,
// crisp zoom, selectable text, search, links and bookmarks. Notes live in a
// layer above each page; pdf.js clears unknown children when it redraws a
// page, so each layer is re-attached after rendering.
export interface PdfHistoryActions {
  canUndo: boolean; canRedo: boolean;
  undo: () => void; redo: () => void;
}

export const PdfView = forwardRef<PdfHandle, {
  readOnly?: boolean;
  group?: NoteGroup | null; onGroupChange?: (group: NoteGroup | null) => void; markingDisabled?: boolean;
  url: string; words?: string; notes: { note: Annotation; number: number }[]; active: string; region: boolean; setRegion: (on: boolean) => void;
  /** The build `url` shows; new marks name the build whose pages they were made on. */
  pdfKey?: string;
  onCreate: (page: number, rect: Rect, rects: Rect[], quote: string, comment: string, group?: NoteGroup, options?: { reveal?: boolean; quote?: boolean; kind?: MarkKind; stamp?: string; key?: string }) => Promise<void>;
  onSelect: (note: Annotation) => void; outline: OutlineItem[]; section: number;
  noteActions?: PdfNoteActions; onDeselect?: () => void;
  history?: PdfHistoryActions;
  onOutline: (items: OutlineItem[]) => void; onSection: (index: number) => void;
  lead?: ReactNode;
  tools?: ReactNode;
  /** Remembers the page and position under this name, and opens there next time. */
  place?: string;
  /** Keep reading state mounted while another workspace view is in front. */
  suspended?: boolean;
  /** Offers the source tool; a click or drag with it names a passage, on the PDF named `key`. */
  onSource?: (target: Target, key?: string) => void;
  passage?: PdfPassage;
}>(function PdfView(props, ref) {
  const latest = useRef(props); latest.current = props;
  const root = useRef<HTMLDivElement>(null), container = useRef<HTMLDivElement>(null), inner = useRef<HTMLDivElement>(null), findInput = useRef<HTMLInputElement>(null);
  const tools = useRef<{ bus: EventBus; links: PDFLinkService; find: PDFFindController; viewer: PDFViewer } | null>(null);
  const loaded = useRef<PDFDocumentProxy | null>(null), restore = useRef<{ scale: string; top: number; left: number } | null>(null);
  const layerMap = useRef(new Map<number, HTMLElement>());
  const [layers, setLayers] = useState(new Map<number, HTMLElement>());
  const [, relayoutTags] = useState(0);
  // pdf.js resizes page layers after its scale event. Recalculate marker
  // positions from their final dimensions, including phone rotation.
  useEffect(() => {
    const observer = new ResizeObserver(() => relayoutTags(value => value + 1));
    for (const layer of layers.values()) observer.observe(layer);
    return () => observer.disconnect();
  }, [layers]);
  const [pages, setPages] = useState(0), [page, setPage] = useState(1);
  const [zoom, setZoom] = useState({ value: 'page-width', scale: 1 });
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [findOpen, setFindOpen] = useState(false), [query, setQuery] = useState(''), [matches, setMatches] = useState({ current: 0, total: 0 }), [notFound, setNotFound] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  // A place shown from elsewhere, such as a compilation problem, marked briefly.
  const [flash, setFlash] = useState<{ page: number; rect: Rect; id: number } | null>(null);
  // A place asked for while a new PDF opens is shown once its pages have a size.
  const pagesReady = useRef(false), pendingPlace = useRef<{ page: number; rect: Rect; keep?: boolean } | null>(null);
  const [editing, setEditing] = useState<Target | null>(null), editingRef = useRef(editing); editingRef.current = editing;
  // A recompiled manuscript waits while a note is being written: replacing the
  // pages would close the card and lose its place. The pages on screen, their
  // notes and their key stay together until the card closes.
  const [shown, setShown] = useState({ url: props.url, words: props.words, key: props.pdfKey }), shownRef = useRef(shown); shownRef.current = shown;
  const heldNotes = useRef(props.notes), held = shown.url !== props.url;
  if (!held) heldNotes.current = props.notes;
  const notes = held ? heldNotes.current : props.notes, notesRef = useRef(notes); notesRef.current = notes;
  const picking = useRef<ReturnType<typeof touchSelection> | null>(null);
  const [draft, updateDraft] = useState<{ page: number; rect: Rect } | null>(null), draftRef = useRef(draft);
  const setDraft = (value: typeof draft) => { draftRef.current = value; updateDraft(value); };
  const origin = useRef<{ page: number; x: number; y: number; box: DOMRect } | null>(null);
  const [noteBusy, setNoteBusy] = useState(false), [noteError, setNoteError] = useState('');
  // Keep drafts available when a save fails or a blank edit is closed.
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [newNoteDraft, setNewNoteDraft] = useState('');
  const [dismissedNote, setDismissedNote] = useState<Annotation | null>(null);
  // The chosen tool; holding Space borrows the hand without changing it.
  const [tool, setTool] = useState<PdfTool>(props.region ? 'region' : 'select'), [spaceHand, setSpaceHand] = useState(false);
  const active: PdfTool = spaceHand ? 'hand' : tool, toolRef = useRef(active); toolRef.current = active;
  const spaceRef = useRef({ held: false, used: false }); spaceRef.current.held = spaceHand;
  // A number key keeps one quick note on the magic pen until 0 or Escape.
  const [locked, setLocked] = useState<number | null>(null), lockedRef = useRef(locked); lockedRef.current = locked;
  const [wheel, setWheel] = useState<{ x: number; y: number; target: Target } | null>(null);
  const [markError, setMarkError] = useState(''), pressed = useRef({ card: false });
  const stamps = useStamps(), markable = !props.readOnly;
  // The magic pen fetches this person's quick notes the first time it is
  // picked; a lock on a slot that no longer exists ends.
  useEffect(() => { if (tool === 'magic') loadStamps(); }, [tool]);
  useEffect(() => { if (locked !== null && !stamps[locked]) setLocked(null); }, [stamps, locked]);
  // Color groups belong to the note and region tools, like a brush's color.
  const groupFor = (tool: PdfTool) => tool === 'note' || tool === 'region' ? latest.current.group || null : null;
  useEffect(() => { setTool(current => props.region ? 'region' : current === 'region' ? 'select' : current); }, [props.region]);
  useEffect(() => { if (!markError) return; const timer = setTimeout(() => setMarkError(''), 6000); return () => clearTimeout(timer); }, [markError]);
  const suggestions = notes.filter(({ note }) => note.aiReview).sort((a, b) => a.note.page - b.note.page || a.note.rect[1] - b.note.rect[1] || a.note.rect[0] - b.note.rect[0]);
  const suggestionIndex = suggestions.findIndex(({ note }) => note.id === props.active);
  const activeSuggestion = suggestions[suggestionIndex];
  const personal = notes.filter(({ note }) => !note.aiReview).sort((a, b) => a.note.page - b.note.page || a.note.rect[1] - b.note.rect[1]);
  const personalIndex = personal.findIndex(({ note }) => note.id === props.active);
  const activeNote = activeSuggestion || personal[personalIndex];
  const noteIndex = activeSuggestion ? suggestionIndex : personalIndex, peers = activeSuggestion ? suggestions : personal;
  const noteLocked = noteBusy || Boolean(props.noteActions?.disabled);
  const onNoteBusy = props.noteActions?.onBusy;
  useEffect(() => { onNoteBusy?.(noteBusy); return () => onNoteBusy?.(false); }, [noteBusy, onNoteBusy]);
  useEffect(() => { setNoteError(''); }, [props.active]);
  useEffect(() => { if (dismissedNote && notes.some(({ note }) => note.id === dismissedNote.id)) setDismissedNote(null); }, [notes, dismissedNote]);
  function closeNote(restoreFocus = true) {
    if (latest.current.active !== props.active) return;
    const tag = container.current?.querySelector<HTMLButtonElement>(`.note-tag[data-note="${props.active}"]`);
    props.onDeselect?.(); if (restoreFocus) (tag || container.current)?.focus({ preventScroll: true });
  }
  function adjacentNote(direction: -1 | 1) {
    const next = peers[noteIndex + direction];
    if (!next || noteLocked) return;
    // The next card may still be offscreen during a cross-page scroll. Keep
    // focus in the PDF so repeated arrow keys continue to reach the viewer.
    container.current?.focus({ preventScroll: true });
    props.onSelect(next.note);
  }
  async function dismissNote(note: Annotation) {
    if (!props.noteActions || noteLocked) return;
    setNoteBusy(true); setNoteError('');
    try { await props.noteActions.remove(note); setDismissedNote(note); if (latest.current.active === note.id) latest.current.onDeselect?.(); }
    catch (error) { setNoteError(error instanceof Error ? error.message : String(error)); }
    finally { setNoteBusy(false); }
  }
  async function restoreNote() {
    if (!props.noteActions || !dismissedNote || noteLocked) return;
    setNoteBusy(true); setNoteError('');
    try { await props.noteActions.restore(dismissedNote); setDismissedNote(null); }
    catch (error) { setNoteError(error instanceof Error ? error.message : String(error)); }
    finally { setNoteBusy(false); }
  }

  async function copyNote(note: Annotation) {
    if (!props.noteActions?.copy || noteLocked) return;
    setNoteBusy(true); setNoteError('');
    try { await props.noteActions.copy(note); }
    catch (error) { setNoteError(error instanceof Error ? error.message : String(error)); }
    finally { setNoteBusy(false); }
  }

  const handle = useRef<PdfHandle | null>(null);
  useImperativeHandle(ref, () => handle.current = ({
    focus() { container.current?.focus({ preventScroll: true }); },
    fitWidth() { const viewer = tools.current?.viewer; if (viewer && viewer.currentScaleValue !== 'page-width') viewer.currentScaleValue = 'page-width'; },
    // Scroll to the section without pdf.js's link service, which focuses the
    // page's text layer the next time that page renders, possibly long after,
    // taking focus from wherever the author is by then.
    goTo(item) {
      latest.current.onSection(latest.current.outline.indexOf(item));
      void (async () => {
        const viewer = tools.current?.viewer, doc = viewer?.pdfDocument;
        if (!viewer || !doc) return;
        const dest = typeof item.dest === 'string' ? await doc.getDestination(item.dest) : item.dest as unknown[] | null;
        const ref = Array.isArray(dest) ? dest[0] : null;
        const index = ref && typeof ref === 'object' ? await doc.getPageIndex(ref as Parameters<typeof doc.getPageIndex>[0]) : Number.isInteger(ref) ? ref as number : -1;
        if (index < 0) return;
        viewer.scrollPageIntoView({ pageNumber: index + 1, destArray: dest as unknown[] });
        container.current?.focus({ preventScroll: true });
      })().catch(() => { /* A broken outline entry stays where it is. */ });
    },
    goToNote(note) {
      const div = tools.current?.viewer.getPageView(note.page)?.div, box = container.current;
      if (!div || !box) return;
      box.scrollTo({ top: box.scrollTop + div.getBoundingClientRect().top - box.getBoundingClientRect().top + note.rect[1] * div.offsetHeight - 96, behavior: 'smooth' });
    },
    showPlace(page, rect, options) {
      if (!pagesReady.current) { pendingPlace.current = { page, rect, ...options }; return; }
      const div = tools.current?.viewer.getPageView(page)?.div, box = container.current;
      if (!div || !box) return;
      const pageBox = div.getBoundingClientRect(), view = box.getBoundingClientRect();
      const visible = pageBox.top + rect[1] * pageBox.height >= view.top + 8 && pageBox.top + rect[3] * pageBox.height <= view.bottom - 8;
      if (options?.keep && visible) { setFlash({ page, rect, id: Date.now() }); return; }
      const top = box.scrollTop + pageBox.top - view.top + rect[1] * div.offsetHeight - box.clientHeight / 3;
      const middle = box.scrollLeft + pageBox.left - view.left + (rect[0] + rect[2]) / 2 * div.offsetWidth - box.clientWidth / 2;
      // A far jump lands at once, so the mark is still showing on arrival.
      box.scrollTo({ top, left: box.scrollWidth > box.clientWidth ? middle : box.scrollLeft, behavior: Math.abs(top - box.scrollTop) > box.clientHeight * 2 ? 'instant' : 'smooth' });
      setFlash({ page, rect, id: Date.now() });
    },
  }), []);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(current => current?.id === flash.id ? null : current), 2400);
    return () => clearTimeout(timer);
  }, [flash]);

  useEffect(() => {
    const box = container.current!, bus = new EventBus(), lifetime = new AbortController();
    const links = new PDFLinkService({ eventBus: bus, externalLinkTarget: LinkTarget.BLANK, externalLinkRel: 'noopener noreferrer' });
    const find = new PDFFindController({ eventBus: bus, linkService: links });
    // Papilot owns notes and clipboard attachments. The built-in PDF editor
    // installs document-wide paste/drop handlers even in its default NONE mode.
    // PDF.js 6 accepts abortSignal at runtime but omits it from its option type.
    const viewerOptions = { container: box, viewer: inner.current!, eventBus: bus, linkService: links, findController: find, removePageBorders: true, annotationMode: pdfjs.AnnotationMode.ENABLE,
      annotationEditorMode: pdfjs.AnnotationEditorType.DISABLE, enableSelectionRendering: false, abortSignal: lifetime.signal };
    const viewer = new PDFViewer(viewerOptions);
    links.setViewer(viewer);
    // pdf.js moves focus into the target page's text layer the next time that
    // page renders. For a page already on screen that happens later, on any
    // zoom or resize, and takes focus from wherever the author is typing.
    // Contents entries and links in the PDF scroll the same way, without it.
    links.goToDestination = async (dest: string | unknown[]) => {
      const document = loaded.current;
      if (!document) return;
      const explicit = typeof dest === 'string' ? await document.getDestination(dest) : await dest;
      if (!Array.isArray(explicit)) return;
      const [target] = explicit;
      let pageNumber: number | null = null;
      if (target && typeof target === 'object') {
        const ref = target as { num: number; gen: number };
        pageNumber = document.cachedPageNumber(ref) ?? await document.getPageIndex(ref).then(index => index + 1, () => null);
      } else if (Number.isInteger(target)) pageNumber = (target as number) + 1;
      if (pageNumber && pageNumber >= 1 && pageNumber <= viewer.pagesCount) viewer.scrollPageIntoView({ pageNumber, destArray: explicit });
    };
    tools.current = { bus, links, find, viewer };
    const attach = ({ pageNumber, source }: { pageNumber: number; source?: { div?: HTMLElement } }) => {
      const div = source?.div ?? viewer.getPageView(pageNumber - 1)?.div;
      if (!div) return;
      let layer = layerMap.current.get(pageNumber);
      if (!layer) { layer = document.createElement('div'); layer.className = 'note-layer'; layerMap.current.set(pageNumber, layer); setLayers(new Map(layerMap.current)); }
      if (layer.parentElement !== div) div.append(layer);
    };
    bus.on('pagerendered', attach); bus.on('textlayerrendered', attach); bus.on('annotationlayerrendered', attach);
    // Coming back to this PDF opens it where the author left it, as soon as
    // its pages have a size (a hidden panel has none yet).
    const place = latest.current.place;
    let returning = place ? readPlace<{ page: number; left: number; top: number; scale?: string }>(place) : undefined;
    const goBack = () => {
      if (!returning || !box.clientHeight || !viewer.pagesCount) return;
      const { page, left, top } = returning; returning = undefined;
      if (page >= 1 && page <= viewer.pagesCount) viewer.scrollPageIntoView({ pageNumber: page, destArray: [null, { name: 'XYZ' }, left, top, null], allowNegativeOffset: true });
    };
    bus.on('pagesinit', () => {
      const keep = restore.current; restore.current = null;
      if (!keep && !returning && !box.clientHeight && place) returning = readPlace(place);
      viewer.currentScaleValue = pdfZoom(keep?.scale || returning?.scale || browserStorage.getItem(PDF_ZOOM_STORAGE));
      if (keep) { returning = undefined; box.scrollTop = keep.top; box.scrollLeft = keep.left; }
      else goBack();
      pagesReady.current = true;
      const pending = pendingPlace.current; pendingPlace.current = null;
      if (pending) requestAnimationFrame(() => handle.current?.showPlace(pending.page, pending.rect, { keep: pending.keep }));
    });
    bus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => { setPage(pageNumber); });
    bus.on('scalechanging', ({ scale, presetValue }: { scale: number; presetValue?: string }) => {
      setZoom({ value: presetValue || String(scale), scale });
      if (presetValue) browserStorage.setItem(PDF_ZOOM_STORAGE, presetValue); else browserStorage.setItem(PDF_ZOOM_STORAGE, String(Math.round(scale * 100) / 100));
    });
    // Resizing a panel does not resize the window. Reapply fit presets to the
    // viewer's actual bounds, while preserving an explicitly chosen percentage.
    let resizeFrame = 0;
    const resize = new ResizeObserver(() => {
      if (!box.clientWidth || !box.clientHeight) { if (!returning && place) returning = readPlace(place); return; }
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (!viewer.pagesCount || !box.clientWidth || !box.clientHeight) return;
        const scale = viewer.currentScaleValue;
        if (scale === 'page-width' || scale === 'page-fit' || scale === 'page-height' || scale === 'auto') viewer.currentScaleValue = scale;
        viewer.update(); goBack();
      });
    });
    resize.observe(box);
    // The current section is the last bookmark above a line 40% down the view
    // (PDF units grow upwards); at the end of the document it is the last one.
    bus.on('updateviewarea', ({ location }: { location?: { pageNumber: number; top: number; left: number; scale: number } }) => {
      if (!location || !box.clientHeight) return;
      if (place && !returning) savePlace(place, { page: location.pageNumber, left: location.left, top: location.top, scale: viewer.currentScaleValue });
      const items = latest.current.outline, reading = location.top - box.clientHeight * 0.4 / (viewer.currentScale * 96 / 72);
      let current = -1;
      items.forEach((item, index) => { if (item.page < location.pageNumber || (item.page === location.pageNumber && (item.top === null || item.top >= reading))) current = index; });
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2 && items.length) current = items.length - 1;
      if (current !== latest.current.section) latest.current.onSection(current);
    });
    bus.on('updatefindmatchescount', ({ matchesCount }: { matchesCount: { current: number; total: number } }) => setMatches(matchesCount));
    bus.on('updatefindcontrolstate', ({ state, matchesCount }: { state: number; matchesCount?: { current: number; total: number } }) => { setNotFound(state === FindState.NOT_FOUND); if (matchesCount) setMatches(matchesCount); });
    // Trackpad pinches arrive as ctrl+wheel; touch pinches are handled here so
    // the page zooms instead of the whole workspace.
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault(); viewer.updateScale({ drawingDelay: 250, scaleFactor: Math.exp(-e.deltaY / 100), origin: [e.clientX, e.clientY] });
    };
    let pinch: number | null = null;
    const spread = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const touchStart = (e: TouchEvent) => { if (e.touches.length === 2) pinch = spread(e.touches); };
    const touchMove = (e: TouchEvent) => {
      if (pinch === null || e.touches.length !== 2) return;
      e.preventDefault();
      const distance = spread(e.touches);
      viewer.updateScale({ drawingDelay: 250, scaleFactor: distance / pinch, origin: [(e.touches[0].clientX + e.touches[1].clientX) / 2, (e.touches[0].clientY + e.touches[1].clientY) / 2] });
      pinch = distance;
    };
    const touchEnd = (e: TouchEvent) => { if (e.touches.length < 2) pinch = null; };
    box.addEventListener('wheel', wheel, { passive: false });
    box.addEventListener('touchstart', touchStart, { passive: true });
    box.addEventListener('touchmove', touchMove, { passive: false });
    box.addEventListener('touchend', touchEnd);
    // A text selection on one page offers "Add note" beside it.
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const select = () => {
      if (picking.current?.active()) return;
      const current = document.getSelection();
      if (!current || current.isCollapsed || !current.rangeCount) { setSelection(null); return; }
      const { range, before, after } = wholeWords(current.getRangeAt(0)), node = range.startContainer, element = node instanceof Element ? node : node.parentElement;
      const pageDiv = element?.closest<HTMLElement>('.page');
      if (!pageDiv || !box.contains(pageDiv) || element?.closest('.pdf-note-card')) { setSelection(null); return; }
      const frame = pageDiv.getBoundingClientRect();
      const rects = mergeLines(Array.from(range.getClientRects()).filter(r => r.width > 1 && r.height > 1 && r.top >= frame.top - 1 && r.bottom <= frame.bottom + 1)
        .map(r => [unit((r.left - frame.left) / frame.width), unit((r.top - frame.top) / frame.height), unit((r.right - frame.left) / frame.width), unit((r.bottom - frame.top) / frame.height)] as Rect));
      // The selection's own text keeps pdf.js's line breaks as spaces.
      const quote = (before + current.toString() + after).replace(/\s+/g, ' ').trim();
      const value = rects.length && quote ? { page: Number(pageDiv.dataset.pageNumber) - 1, rects, quote } : null;
      setSelection(value); return value;
    };
    const selectionChange = () => { clearTimeout(timer); timer = setTimeout(select, 120); };
    document.addEventListener('selectionchange', selectionChange);
    // The note, delete, magic and source tools act when a drag over text
    // ends; a plain click on the page gives the magic pen and the source
    // tool a point instead. The click waits a moment, so a double click
    // still selects a word.
    // A click that closes an open card does only that. The card closes on
    // the same press, so whether one was open is read before anything else.
    let down: { x: number; y: number; time: number } | null = null, pointTimer: ReturnType<typeof setTimeout> | undefined;
    const pressStart = (event: PointerEvent) => {
      pressed.current.card = Boolean(latest.current.active || editingRef.current);
      clearTimeout(pointTimer); down = event.button === 0 && box.contains(event.target as Node) ? { x: event.clientX, y: event.clientY, time: performance.now() } : null;
    };
    const clearDown = () => { down = null; };
    const finishMark = (event: PointerEvent) => {
      const tool = toolRef.current, start = down; down = null;
      const touchMagic = event.pointerType === 'touch' && tool === 'magic' && !picking.current?.active() && Boolean(start && performance.now() - start.time < 450);
      if ((tool !== 'note' && tool !== 'delete' && tool !== 'magic' && tool !== 'source') || latest.current.readOnly || (tool !== 'source' && latest.current.markingDisabled) || editingRef.current || (event.pointerType === 'touch' && !touchMagic) || event.button !== 0
        || !box.contains(event.target as Node) || (event.target as Element).closest('button,input,textarea,select,.pdf-note-card')) return;
      const at = { x: event.clientX, y: event.clientY }, page = (event.target as Element).closest<HTMLElement>('.page');
      const click = Boolean(start && !pressed.current.card && Math.hypot(at.x - start.x, at.y - start.y) < (event.pointerType === 'touch' ? 10 : 5)), onNote = Boolean(noteAt(event));
      setTimeout(() => {
        if (disposed || (event.pointerType === 'touch' && picking.current?.active())) return;
        const value = event.pointerType === 'touch' ? null : select();
        if (value) { markRef.current({ page: value.page, rect: bounds(value.rects), rects: value.rects, quote: value.quote }, at); return; }
        if ((tool === 'magic' || tool === 'source') && page && click && !onNote) {
          if (event.pointerType === 'touch') markRef.current(pointAt(page, at.x, at.y), at);
          else pointTimer = setTimeout(() => { if (!disposed && !editingRef.current) markRef.current(pointAt(page, at.x, at.y), at); }, 220);
        }
      }, 0);
    };
    window.addEventListener('pointerdown', pressStart, true);
    window.addEventListener('pointercancel', clearDown, true);
    document.addEventListener('pointerup', finishMark);
    // The hand drags the pages, whichever tool is chosen while Space is held.
    let pan: { id: number; x: number; y: number; left: number; top: number } | null = null;
    const panStart = (event: PointerEvent) => {
      if (toolRef.current !== 'hand' || event.button !== 0 || event.pointerType === 'touch' || (event.target as Element).closest('button,a,input,textarea,select,.pdf-note-card')) return;
      event.preventDefault(); spaceRef.current.used = true;
      pan = { id: event.pointerId, x: event.clientX, y: event.clientY, left: box.scrollLeft, top: box.scrollTop };
      box.setPointerCapture(event.pointerId); box.classList.add('panning');
    };
    const panMove = (event: PointerEvent) => {
      if (!pan || event.pointerId !== pan.id) return;
      box.scrollLeft = pan.left - (event.clientX - pan.x); box.scrollTop = pan.top - (event.clientY - pan.y);
    };
    const panEnd = (event: PointerEvent) => { if (pan?.id === event.pointerId) { pan = null; box.classList.remove('panning'); } };
    box.addEventListener('pointerdown', panStart); box.addEventListener('pointermove', panMove); box.addEventListener('pointerup', panEnd); box.addEventListener('pointercancel', panEnd);
    // Keep marks transparent to pointer events so dragging still selects the
    // underlying text. A click/tap on a mark selects its note after the native
    // selection gesture has finished; drags, scrolling and long presses do not.
    const noteAt = (event: MouseEvent) => {
      if (latest.current.region || editingRef.current || toolRef.current === 'point' || toolRef.current === 'source') return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('button,a,input,textarea,select,[contenteditable],.select-handle,.pdf-note-card')) return;
      const page = target?.closest<HTMLElement>('.page');
      if (!page || !box.contains(page)) return;
      const frame = page.getBoundingClientRect(), x = (event.clientX - frame.left) / frame.width, y = (event.clientY - frame.top) / frame.height;
      let hit: Annotation | undefined, area = Infinity;
      for (const { note } of notesRef.current) {
        if (note.page !== Number(page.dataset.pageNumber) - 1) continue;
        for (const [left, top, right, bottom] of note.rects?.length ? note.rects : [note.rect]) {
          // Prefer the more specific mark when text and a larger region overlap.
          const size = (right - left) * (bottom - top);
          if (x >= left && x <= right && y >= top && y <= bottom && size <= area) { hit = note; area = size; }
        }
      }
      return hit;
    };
    let press: { id: string; x: number; y: number; time: number; touch: boolean } | null = null;
    const cancelPress = () => { press = null; };
    const pressNote = (event: PointerEvent) => {
      press = null;
      if (!event.isPrimary || event.button !== 0) return;
      const note = noteAt(event);
      if (note) press = { id: note.id, x: event.clientX, y: event.clientY, time: event.timeStamp, touch: event.pointerType !== 'mouse' };
    };
    const moveNote = (event: PointerEvent) => {
      if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > (press.touch ? 10 : 4)) cancelPress();
    };
    const releaseNote = (event: PointerEvent) => {
      const start = press; press = null;
      if (!start || event.defaultPrevented || event.button !== 0 || (start.touch && event.timeStamp - start.time >= 450)
        || document.getSelection()?.isCollapsed === false) return;
      const note = noteAt(event);
      if (note?.id !== start.id) return;
      // pdf.js can remove its blank-page hit target on mouseup, suppressing
      // click entirely. Touch taps first let touchend clear any old handles.
      if (start.touch) setTimeout(() => { if (!disposed && !picking.current?.active()) latest.current.onSelect(note); }, 0);
      else latest.current.onSelect(note);
    };
    box.addEventListener('pointerdown', pressNote); box.addEventListener('scroll', cancelPress);
    document.addEventListener('pointermove', moveNote); document.addEventListener('pointerup', releaseNote); document.addEventListener('pointercancel', cancelPress);
    // Touch screens select words with Papilot's own handles and menu (style.css
    // turns native selection off there). Each text run is one word.
    picking.current = touchSelection<HTMLElement>(box, {
      target: element => element.closest('.textLayer')?.closest<HTMLElement>('.page') ?? undefined,
      units: page => ({ units: Array.from(page.querySelectorAll<HTMLElement>('.textLayer span')).filter(span => !span.firstElementChild), line: (_, index) => index }),
      blocked: () => latest.current.region || Boolean(editingRef.current),
      menu: '.add-note',
      onSelect: ({ target: pageDiv, units, from, to }) => {
        const frame = pageDiv.getBoundingClientRect(), range = document.createRange(), last = units[to].firstChild;
        // A word followed by another carries the space; the selection stops before it.
        range.setStart(units[from], 0);
        if (last?.nodeType === Node.TEXT_NODE) range.setEnd(last, (last.textContent || '').trimEnd().length); else range.setEnd(units[to], units[to].childNodes.length);
        const rects = mergeLines(Array.from(range.getClientRects()).filter(r => r.width > 1 && r.height > 1)
          .map(r => [unit((r.left - frame.left) / frame.width), unit((r.top - frame.top) / frame.height), unit((r.right - frame.left) / frame.width), unit((r.bottom - frame.top) / frame.height)] as Rect));
        // Words that end a line carry no space, so the runs are joined with one.
        const quote = units.slice(from, to + 1).map(span => span.textContent).join(' ').replace(/\s+/g, ' ').trim();
        if (!rects.length || !quote) return;
        const [first, end] = [rects[0], rects[rects.length - 1]];
        setSelection({ page: Number(pageDiv.dataset.pageNumber) - 1, rects, quote, handles: { from: [first[0], first[1], first[3]], to: [end[2], end[1], end[3]] } });
      },
      onClear: () => setSelection(null),
    });
    return () => {
      disposed = true; clearTimeout(timer); clearTimeout(pointTimer); picking.current?.stop(); picking.current = null;
      resize.disconnect(); cancelAnimationFrame(resizeFrame);
      document.removeEventListener('selectionchange', selectionChange); document.removeEventListener('pointerup', finishMark); window.removeEventListener('pointerdown', pressStart, true); window.removeEventListener('pointercancel', clearDown, true);
      box.removeEventListener('pointerdown', panStart); box.removeEventListener('pointermove', panMove); box.removeEventListener('pointerup', panEnd); box.removeEventListener('pointercancel', panEnd);
      box.removeEventListener('pointerdown', pressNote); box.removeEventListener('scroll', cancelPress);
      document.removeEventListener('pointermove', moveNote); document.removeEventListener('pointerup', releaseNote); document.removeEventListener('pointercancel', cancelPress);
      box.removeEventListener('wheel', wheel); box.removeEventListener('touchstart', touchStart); box.removeEventListener('touchmove', touchMove); box.removeEventListener('touchend', touchEnd);
      viewer.setDocument(null); lifetime.abort(); closeDocument(loaded.current?.loadingTask); loaded.current = null; tools.current = null; layerMap.current.clear();
    };
  }, []);

  // A recompiled manuscript opens at the same place and zoom. A card opened
  // during its download cancels that replacement until the card closes.
  useEffect(() => {
    if (editing || (loaded.current && shownRef.current.url === props.url)) return;
    const next = { url: props.url, words: props.words, key: props.pdfKey };
    const current = tools.current!, box = container.current!;
    let cancelled = false, attached = false;
    if (loaded.current && box.clientHeight > 0) restore.current = { scale: current.viewer.currentScaleValue, top: box.scrollTop, left: box.scrollLeft };
    pagesReady.current = false;
    setLoading(!loaded.current); setError('');
    const task = pdfjs.getDocument({ url: next.url, enableXfa: false, BinaryDataFactory: CMapData });
    void task.promise.then(async document => {
      if (cancelled) return;
      // PDFViewer's first-page rejection handler can outlive setDocument(null)
      // and reject its replacement state. Keep that request in our cancellable
      // load phase, before the viewer takes ownership of the document.
      await document.getPage(1);
      if (cancelled || editingRef.current) { restore.current = null; closeDocument(task); return; }
      const previous = loaded.current;
      loaded.current = document; attached = true; layerMap.current.clear(); setLayers(new Map()); setSelection(null); setEditing(null);
      // Marks always name the pages actually attached, never a pending fetch.
      shownRef.current = next; setShown(next);
      if (next.words) exactText(document, next.words);
      current.viewer.setDocument(document); current.links.setDocument(document, null);
      setPages(document.numPages); setLoading(false);
      closeDocument(previous?.loadingTask);
      const items = await readOutline(document).catch(() => []);
      if (loaded.current === document) latest.current.onOutline(items);
    }).catch(failure => {
      if (cancelled) return;
      if (!attached) { restore.current = null; closeDocument(task); }
      if (!loaded.current) setError(failure instanceof Error ? failure.message : String(failure));
      setLoading(false);
    });
    return () => { cancelled = true; if (!attached) { restore.current = null; closeDocument(task); } };
  }, [props.url, props.words, props.pdfKey, editing]);

  // Opening a suggestion from the task or navigation reveals its passage.
  // Page views exist after pagesinit even when their canvases have not rendered.
  useEffect(() => {
    const reveal = () => {
      const entry = notesRef.current.find(({ note }) => note.id === latest.current.active);
      const viewer = tools.current?.viewer, box = container.current;
      const div = entry && viewer?.getPageView(entry.note.page)?.div;
      if (!entry || !div || !box) return;
      const page = div.getBoundingClientRect(), view = box.getBoundingClientRect();
      const top = page.top + entry.note.rect[1] * page.height, bottom = page.top + entry.note.rect[3] * page.height;
      if (top < view.top + 16 || bottom > view.bottom - 240) box.scrollTo({ top: box.scrollTop + top - view.top - 72 });
    };
    const bus = tools.current?.bus;
    bus?.on('pagesinit', reveal); reveal();
    return () => bus?.off('pagesinit', reveal);
  }, [props.active, shown.url, loading]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const viewer = tools.current?.viewer, mod = e.metaKey || e.ctrlKey;
      if (!viewer || e.defaultPrevented || latest.current.suspended || !container.current?.clientHeight) return;
      if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); if (findInput.current) findInput.current.select(); else setFindOpen(true); }
      else if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); viewer.increaseScale(); }
      else if (mod && e.key === '-') { e.preventDefault(); viewer.decreaseScale(); }
      else if (mod && e.key === '0') { e.preventDefault(); viewer.currentScaleValue = 'page-width'; }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);

  // Single keys pick tools while the PDF has focus (V T Q M P D H), number
  // keys keep a quick note on the magic pen, Space borrows the hand (a tap
  // still turns the page), and Escape steps back: unlock, then Select.
  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey || latest.current.readOnly || latest.current.suspended || !container.current?.clientHeight) return;
      const focus = document.activeElement;
      if (typing(event.target) || (focus && focus !== document.body && !root.current?.contains(focus)) || document.querySelector('dialog[open]')) return;
      if (event.key === ' ') {
        if (focus?.closest('button,a,[role="button"]') || toolRef.current === 'hand' && !spaceRef.current.held) return;
        event.preventDefault();
        if (!event.repeat && !spaceRef.current.held) { spaceRef.current.used = false; setSpaceHand(true); }
        return;
      }
      if (event.key === 'Escape') {
        if (lockedRef.current !== null) { event.preventDefault(); setLocked(null); }
        else if (toolRef.current !== 'select' && !spaceRef.current.held) { event.preventDefault(); keys.current.pickTool('select'); }
        return;
      }
      if (event.shiftKey) return;
      const tool = TOOL_KEYS[event.key.toLowerCase()];
      if (tool) { event.preventDefault(); keys.current.pickTool(tool); }
      else if (/^[0-9]$/.test(event.key)) { event.preventDefault(); const slot = (Number(event.key) + 9) % 10; keys.current.lock(lockedRef.current === slot ? null : slot); }
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.key !== ' ' || !spaceRef.current.held) return;
      setSpaceHand(false);
      if (latest.current.suspended || !container.current?.clientHeight) return;
      const box = container.current;
      if (!spaceRef.current.used && box) box.scrollBy({ top: (event.shiftKey ? -0.9 : 0.9) * box.clientHeight });
    };
    const blur = () => setSpaceHand(false);
    document.addEventListener('keydown', keyDown); document.addEventListener('keyup', keyUp); window.addEventListener('blur', blur);
    return () => { document.removeEventListener('keydown', keyDown); document.removeEventListener('keyup', keyUp); window.removeEventListener('blur', blur); };
  }, []);

  function search(again: boolean, previous = false, text = query) {
    tools.current?.bus.dispatch('find', { source: null, type: again ? 'again' : '', query: text, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: previous, matchDiacritics: false });
  }
  function closeFind() { setFindOpen(false); setQuery(''); setMatches({ current: 0, total: 0 }); setNotFound(false); tools.current?.bus.dispatch('findbarclose', { source: null }); }
  function clearSelection() { document.getSelection()?.removeAllRanges(); picking.current?.reset(); setSelection(null); }
  const selected = (value: Selection): Target => ({ page: value.page, rect: bounds(value.rects), rects: value.rects, quote: value.quote });
  // Saved at once, without a card: a color group's mark, a deletion, a quick note.
  function createMark(target: Target, comment: string, options: { group?: NoteGroup; kind?: MarkKind; stamp?: string } = {}) {
    if (latest.current.markingDisabled) return;
    clearSelection();
    const kind = options.kind || (target.point ? 'point' : undefined);
    void latest.current.onCreate(target.page, target.rect, target.rects, target.quote, comment, options.group, { reveal: false, ...(kind ? { kind } : {}), ...(options.stamp ? { stamp: options.stamp } : {}), key: shownRef.current.key })
      .catch(error => setMarkError(error instanceof Error ? error.message : String(error)));
  }
  function openCard(target: Target) {
    clearSelection(); setNewNoteDraft(''); setNoteError(''); setEditing(target);
  }
  // Where on screen a target ends, for the wheel when a key, not the pointer, asked for it.
  function screenPoint(target: Target) {
    const div = tools.current?.viewer.getPageView(target.page)?.div, box = div?.getBoundingClientRect(), end = target.rects.at(-1) || target.rect;
    return box ? { x: box.left + end[2] * box.width, y: box.top + end[3] * box.height } : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }
  // Each tool's response to what was marked with it.
  function mark(target: Target, at?: { x: number; y: number }) {
    const tool = toolRef.current;
    if (tool === 'hand') return;
    if (tool === 'delete') { if (!target.point) createMark(target, '', { kind: 'delete' }); return; }
    if (tool === 'source') { clearSelection(); latest.current.onSource?.(target, shownRef.current.key); return; }
    if (tool === 'magic') {
      const slot = lockedRef.current, stamp = slot === null ? undefined : stamps[slot];
      if (stamp) createMark(target, stamp.instruction, { stamp: stamp.label });
      else { clearSelection(); setWheel({ ...(at || screenPoint(target)), target }); }
      return;
    }
    const group = target.point ? null : groupFor(tool);
    if (group) createMark(target, '', { group }); else openCard(target);
  }
  const markRef = useRef(mark); markRef.current = mark;
  function choose(next: PdfTool) {
    setTool(next); setWheel(null);
    if (next !== 'magic') setLocked(null);
    if ((next === 'region') !== latest.current.region) latest.current.setRegion(next === 'region');
  }
  // A selection made first is marked by the tool picked next.
  function pickTool(next: PdfTool) {
    if (next === 'source' && !latest.current.onSource) return;
    const pending = selection && !selection.handles && !editing ? selection : null;
    choose(next);
    if (pending && (next === 'note' || next === 'delete' || next === 'magic' || next === 'source')) { toolRef.current = next; mark(selected(pending)); }
  }
  function lock(slot: number | null) {
    if (slot === null || !stamps[slot]) { setLocked(null); return; }
    const pending = selection && !selection.handles && !editing ? selection : null;
    choose('magic'); setLocked(slot);
    if (pending) createMark(selected(pending), stamps[slot].instruction, { stamp: stamps[slot].label });
  }
  const keys = useRef({ pickTool, lock }); keys.current = { pickTool, lock };
  function pickStamp(stamp: Stamp) {
    const target = wheel?.target; setWheel(null); container.current?.focus({ preventScroll: true });
    if (target) createMark(target, stamp.instruction, { stamp: stamp.label });
  }
  function startNote() {
    if (!selection) return;
    // The button beside a selection: on touch screens it also carries the note tool's color.
    const group = groupFor(toolRef.current), target = selected(selection);
    if (group) createMark(target, '', { group }); else openCard(target);
  }
  function closeNewNote(restoreFocus = true) {
    setEditing(null);
    if (restoreFocus) container.current?.focus({ preventScroll: true });
  }
  async function saveNewNote(comment: string, action: 'keep' | 'close' | 'quote') {
    if (!editing) return false;
    setNoteBusy(true); setNoteError('');
    try {
      await latest.current.onCreate(editing.page, editing.rect, editing.rects, editing.quote, comment, undefined, { reveal: action === 'keep', quote: action === 'quote', ...(editing.point ? { kind: 'point' as const } : {}), key: shownRef.current.key });
      setEditing(null); return true;
    } catch (error) { setNoteError(error instanceof Error ? error.message : String(error)); return false; }
    finally { setNoteBusy(false); }
  }
  const pillGroup = active === 'note' || active === 'region' ? props.group || null : null;
  // On touch screens the button beside a selection does what the chosen tool does.
  const pillTool = active === 'delete' || active === 'magic' ? active : null;
  const lockedStamp = locked === null ? undefined : stamps[locked];
  const tagLabel = (note: Annotation, label: number) => note.aiReview ? t('Suggestion {n}: {comment}', { n: label, comment: note.comment })
    : note.stamp ? t('Quick note {n}: {name}', { n: label, name: note.stamp })
    : note.kind === 'delete' ? note.comment ? t('Replacement {n}: {text}', { n: label, text: note.comment }) : t('Deletion {n}', { n: label })
    : t('Note {n}: {comment}', { n: label, comment: note.group ? groupName(note.group) : note.comment });

  return <div ref={root} className={'pdf-view' + (props.region ? ' marking' : '') + (markable ? ` tool-${active}` : '')} onKeyDown={event => {
    if (!activeSuggestion || noteLocked || editing || props.region || event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="menu"],[role="listbox"]')) return;
    const dialog = target.closest('dialog,[role="dialog"]');
    if (dialog && !dialog.classList.contains('pdf-suggestion')) return;
    if (window.getSelection()?.isCollapsed === false) return;
    event.preventDefault(); event.stopPropagation();
    adjacentNote(event.key === 'ArrowLeft' ? -1 : 1);
  }}>
    <div className="pdf-toolbar" role="toolbar" aria-label={t('PDF controls')}>
      {props.lead}
      <PdfContents outline={props.outline} section={props.section} ready={!loading} onSelect={item => { void tools.current?.links.goToDestination(item.dest as string | unknown[]); }}/>
      <div className="pdf-toolbar-spacer"/>
      <PdfPageControls page={page} pages={pages} zoom={zoom} onPage={number => { if (tools.current) tools.current.viewer.currentPageNumber = number; }} onZoom={value => { if (tools.current) tools.current.viewer.currentScaleValue = value; }} onZoomBy={factor => tools.current?.viewer.updateScale({ scaleFactor: factor })}/>
      <PdfFindButton open={findOpen} onClick={() => { if (findOpen) closeFind(); else setFindOpen(true); }}/>

      {/* Narrow desktop panes keep compact tools; phones show a collapsible bottom capsule. */}
      {markable && <span className="pdf-compact-tools">
        <button type="button" className={'icon-button region-toggle' + (props.region ? ' active' : '')} aria-label={t('Mark region')} aria-pressed={props.region} title={t('Mark a figure or region')} onClick={() => pickTool(props.region ? 'select' : 'region')}><Icon name="region" size={16}/></button>
        {props.onGroupChange && <GroupPicker value={props.group || null} onChange={group => { props.onGroupChange!(group); if (group && tool !== 'region') choose('note'); }} disabled={props.markingDisabled || Boolean(editing)}/>}
      </span>}
      {suggestions.length > 0 && <button type="button" className="pdf-suggestion-trigger" aria-label={t('AI suggestions')} title={t('AI suggestions')} aria-pressed={Boolean(activeSuggestion)} disabled={noteLocked} onClick={() => activeSuggestion ? closeNote() : props.onSelect(suggestions.find(({ note }) => note.page >= page - 1)?.note || suggestions[0].note)}><Icon name="spark" size={15}/><span>{suggestions.length}</span></button>}
      {props.tools}
    </div>
    {findOpen && <PdfFind inputRef={findInput} query={query} matches={matches} notFound={notFound} onQuery={text => { setQuery(text); search(false, false, text); }} onNext={previous => search(true, previous)} onClose={closeFind}/>}
    <div className="pdf-body">
    {markable && <PdfToolRail tool={tool} onTool={pickTool} group={props.group || null} onGroup={props.onGroupChange} disabled={props.markingDisabled} suspended={props.suspended} editing={Boolean(editing)} stamps={stamps} locked={locked} onLock={slot => slot === null ? setLocked(null) : lock(slot)} history={props.history} sourceTool={Boolean(props.onSource)}/>}
    <div className="pdf-scroll-host">
      <div ref={container} className="pdf-container" tabIndex={0} aria-label={t('PDF pages')}>
        <div ref={inner} className="pdfViewer"/>
      </div>
      {lockedStamp && <div className="stamp-lock" role="status"><Icon name="toolMagic" size={14}/><span>{t('Magic pen: {name}', { name: lockedStamp.label })}</span><button type="button" onClick={() => setLocked(null)} title={t('Unlock (Esc)')} aria-label={t('Unlock quick note')}><Icon name="close" size={12}/></button></div>}
      {markError && <div className="pdf-suggestion-undo" role="alert">{markError}<button type="button" onClick={() => setMarkError('')}>{t('Close')}</button></div>}
      {(loading || error) && <div className="review-loading"><p role={error ? 'alert' : 'status'}>{error ? t('The PDF could not be opened: {error}', { error }) : t('Opening the PDF…')}</p></div>}
      {dismissedNote && <div className="pdf-suggestion-undo" role="status">{dismissedNote.aiReview ? t('Suggestion ignored.') : t('Note deleted.')}<button type="button" disabled={noteLocked} onClick={() => void restoreNote()}>{t('Undo')}</button>{noteError && <p role="alert">{noteError}</p>}</div>}
    </div>
    </div>
    {wheel && <StampWheel x={wheel.x} y={wheel.y} stamps={stamps} onPick={pickStamp} onClose={() => { setWheel(null); container.current?.focus({ preventScroll: true }); }}
      onFree={() => { const target = wheel.target; setWheel(null); openCard(target); }}/>}
    {[...layers].map(([number, layer]) => createPortal(<Fragment>
      {(() => {
        const compact = layer.clientWidth <= 680;
        const notes = notesRef.current.filter(({ note }) => note.page === number - 1), spots = tagSpots(notes.map(({ note }) => ({ rect: (note.rects?.length ? note.rects : [note.rect])[0], name: note.stamp })), compact ? layer.clientHeight : undefined);
        return notes.map(({ note, number: label }, index) => <Fragment key={note.id}>
          {note.kind === 'point' ? <div className={'note-point' + (props.active === note.id ? ' active' : '')} data-note={note.id} data-stamp={note.stamp ? true : undefined} style={{ ...center(note.rect), ...groupStyle(note.group) }}/>
            : (note.rects?.length ? note.rects : [note.rect]).map((rect, part) => <div key={part} className={(note.rects?.length ? 'note-mark' : 'note-box') + (props.active === note.id ? ' active' : '')} data-note={note.id} data-group={note.group} data-kind={note.kind} data-stamp={note.stamp ? true : undefined} data-review={note.aiReview ? true : undefined} style={{ ...percent(rect), ...groupStyle(note.group) }}/>) }
          <button type="button" className={'note-tag' + (props.active === note.id ? ' active' : '')} data-note={note.id} data-group={note.group} data-kind={note.kind} data-stamp={note.stamp ? true : undefined} data-review={note.aiReview ? true : undefined} style={{ ...spots[index], ...groupStyle(note.group) }} aria-label={tagLabel(note, label)} aria-expanded={props.noteActions ? props.active === note.id : undefined} title={note.group ? t('Annotation groups') : note.comment} onClick={() => props.onSelect(note)}>{label}{note.stamp && <span className="note-tag-stamp" hidden={compact}>{note.stamp}</span>}</button>
        </Fragment>);
      })()}
      {activeNote?.note.page === number - 1 && props.noteActions && !editing && !wheel && !props.region && <PdfNoteCard key={activeNote.note.id} note={activeNote.note} number={activeNote.number} index={noteIndex} total={peers.length} selected={props.noteActions.has(activeNote.note.id)} busy={noteLocked} error={noteError}
        draft={noteDrafts[activeNote.note.id] ?? null} onDraftChange={draft => setNoteDrafts(current => {
          const next = { ...current };
          if (draft === null) delete next[activeNote.note.id]; else next[activeNote.note.id] = draft;
          return next;
        })}
        destination={props.noteActions.copy ? 'manuscript' : undefined}
        onToggle={() => props.noteActions!.copy ? void copyNote(activeNote.note) : props.noteActions!.toggle(activeNote.note)} onDismiss={() => void dismissNote(activeNote.note)} onClose={closeNote}
        onEditing={props.noteActions.onEditing} onSave={async (comment, action) => {
          setNoteBusy(true); setNoteError('');
          try {
            await props.noteActions!.edit(activeNote.note, comment);
            if (action === 'quote') props.noteActions!.toggle(activeNote.note);
            return true;
          }
          catch (error) { setNoteError(error instanceof Error ? error.message : String(error)); return false; }
          finally { setNoteBusy(false); }
        }} onPrevious={() => adjacentNote(-1)} onNext={() => adjacentNote(1)}/>}
      {/* Holding Space lends the hand, so the page drags instead of boxing. */}
      {props.region && active !== 'hand' && <div className="region-capture"
        onPointerDown={e => {
          if (editing || e.button > 0) return;
          e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
          const box = e.currentTarget.getBoundingClientRect(), x = unit((e.clientX - box.left) / box.width), y = unit((e.clientY - box.top) / box.height);
          origin.current = { page: number - 1, x, y, box }; setDraft({ page: number - 1, rect: [x, y, x, y] });
        }}
        onPointerMove={e => { const start = origin.current; if (!start) return; const x = unit((e.clientX - start.box.left) / start.box.width), y = unit((e.clientY - start.box.top) / start.box.height); setDraft({ page: start.page, rect: [Math.min(start.x, x), Math.min(start.y, y), Math.max(start.x, x), Math.max(start.y, y)] }); }}
        onPointerUp={() => {
          const current = draftRef.current; origin.current = null; setDraft(null);
          if (current && (current.rect[2] - current.rect[0] > 0.015 || current.rect[3] - current.rect[1] > 0.01)) mark({ page: current.page, rect: current.rect, rects: [], quote: '' });
        }}/>}
      {active === 'point' && markable && !editing && <div className="point-capture" onClick={event => {
        const page = event.currentTarget.closest<HTMLElement>('.page');
        if (page && !props.markingDisabled && !pressed.current.card) mark(pointAt(page, event.clientX, event.clientY));
      }}/>}
      {wheel?.target.page === number - 1 && (wheel.target.point ? <div className="note-point draft" style={center(wheel.target.rect)}/>
        : (wheel.target.rects.length ? wheel.target.rects : [wheel.target.rect]).map((rect, index) => <div key={index} className={(wheel.target.rects.length ? 'note-mark' : 'note-box') + ' draft'} style={percent(rect)}/>))}
      {draft?.page === number - 1 && <div className="note-box draft" style={percent(draft.rect)}/>}
      {props.passage?.page === number - 1 && props.passage.marks.map((rect, index) => <div key={index} className="source-mark" style={percent(rect)}/>)}
      {flash?.page === number - 1 && <div key={flash.id} className="problem-flash" style={percent(flash.rect)}/>}
      {selection?.handles && selection.page === number - 1 && !editing && <>
        {selection.rects.map((rect, index) => <div key={index} className="note-mark draft" style={percent(rect)}/>)}
        {(['from', 'to'] as const).map(end => { const [x, top, bottom] = selection.handles![end]; return <span key={end} className="select-handle" data-end={end} style={{ left: `${x * 100}%`, top: `${top * 100}%`, height: `${(bottom - top) * 100}%` }}/>; })}
      </>}
      {markable && selection?.page === number - 1 && !editing && (active === 'select' || active === 'note' || selection.handles) && <button type="button" className={'add-note' + (selection.handles ? ' touch' : '')} aria-label={pillTool === 'delete' ? t('Delete') : pillTool === 'magic' ? t('Quick notes') : pillGroup ? t('Add to {group}', { group: groupName(pillGroup) }) : t('Add note')} style={{ left: `${selection.rects[selection.rects.length - 1][2] * 100}%`, top: `${selection.rects[selection.rects.length - 1][3] * 100}%` }} onPointerDown={e => e.preventDefault()} onMouseDown={e => e.preventDefault()} onClick={() => { if (pillTool) mark(selected(selection)); else startNote(); }}>{pillTool === 'delete' ? <><Icon name="toolStrike" size={14}/>{t('Delete')}</> : pillTool === 'magic' ? <><Icon name="toolMagic" size={14}/>{t('Quick notes')}</> : <><Icon name="pencil" size={14}/><GroupAction group={pillGroup}/></>}</button>}
      {/* Beside "Add note", the Select tool also offers the passage's LaTeX. */}
      {markable && props.onSource && selection?.page === number - 1 && !selection.handles && !editing && active === 'select' && <button type="button" className="add-source" aria-label={t('Edit source')} title={t('Edit source')} style={{ left: `${selection.rects[selection.rects.length - 1][2] * 100}%`, top: `${selection.rects[selection.rects.length - 1][3] * 100}%` }} onPointerDown={e => e.preventDefault()} onMouseDown={e => e.preventDefault()} onClick={() => { const target = selected(selection); clearSelection(); props.onSource!(target, shownRef.current.key); }}><Icon name="toolSource" size={15}/></button>}
      {editing?.page === number - 1 && <>
        {editing.point ? <div className="note-point draft" style={center(editing.rect)}/> : (editing.rects.length ? editing.rects : [editing.rect]).map((rect, index) => <div key={index} className={(editing.rects.length ? 'note-mark' : 'note-box') + ' draft'} style={percent(rect)}/>)}
        <PdfNoteCard note={{ rect: editing.rect, comment: '', ...(editing.point ? { kind: 'point' as const } : {}) }} number={notes.length + 1} index={0} total={1} selected={false} busy={noteLocked} error={noteError}
          draft={newNoteDraft} onDraftChange={value => setNewNoteDraft(value ?? '')} onDismiss={closeNewNote} onClose={closeNewNote}
          onEditing={props.noteActions?.onEditing} onSave={saveNewNote}/>
      </>}
    </Fragment>, layer, `layer-${number}`))}
  </div>;
});
