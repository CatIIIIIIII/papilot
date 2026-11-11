import { type NoteGroup } from '../note-groups.ts';
import { GroupPicker, GroupAction, groupStyle, groupName } from './note-groups.tsx';
import groupStyles from './note-groups.css?inline';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '../shared.ts';
import { Icon } from './icons.tsx';
import styles from './review-notes.css?inline';
import noteStyles from './note-controls.css?inline';
import { mergeLines, type Rect } from './note-geometry.ts';
import { touchSelection } from './touch-select.ts';
import { t } from './i18n.ts';
import { PdfToolRail, type PdfTool } from './pdf-tool-rail.tsx';
import { loadStamps, useStamps, type Stamp } from './stamps.ts';
import { StampWheel } from './stamp-wheel.tsx';
import { useReviewToolKeys } from './review-tool-keys.ts';
import { useNoteUndo } from './use-note-undo.ts';

import { reviewCommentMark, reviewDraft, useReviewDraft, type ReviewComment, type ReviewMark as Mark } from './review-draft.ts';

type Layer = { strip: HTMLElement; element: HTMLElement; key: string; round: number };
// The host's API, for finding a mark's source on a page of the paper as decided.
let request: (<T>(route: string, body?: unknown) => Promise<T>) | null = null;
export function connectNoteLocation(api: <T>(route: string, body?: unknown) => Promise<T>) { request = api; }
// A touch selection's ends: the edge of its first and last glyph, with that line's top and bottom.
type Handles = { from: [number, number, number]; to: [number, number, number] };
type Selected = Mark & { handles?: Handles };
const unit = (v: number) => Math.max(0, Math.min(1, v));
const percent = ([x, y, right, bottom]: Rect) => ({ left: `${x * 100}%`, top: `${y * 100}%`, width: `${(right - x) * 100}%`, height: `${(bottom - y) * 100}%` });
const elementAt = (node: Node | null) => node?.nodeType === 1 ? node as Element : node?.parentElement;
function mark(layer: Layer, rects: Rect[], quote: string, region: boolean): Mark {
  const change = layer.strip.closest('.change');
  const side = layer.strip.classList.contains('applied-page') ? 'Paper as decided' : layer.strip.closest('.before') ? 'Before' : layer.strip.closest('.after') ? 'After' : 'Unchanged text';
  // The viewer may be in Chinese; the agent reads the English copies in data-change and data-location.
  const number = change?.querySelector<HTMLElement>('.change-number'), place = change?.querySelector<HTMLElement>('.change-where');
  const where = [`Round ${layer.round}`, `PDF page ${layer.strip.dataset.page || '?'}`, side,
    number?.dataset.change ? `Change ${number.dataset.change}` : number?.textContent, place?.dataset.location || place?.getAttribute('title') || place?.textContent].filter(Boolean).join(' · ');
  return { strip: layer.key, round: layer.round, ...(change?.getAttribute('data-stop') ? { stop: Number(change.getAttribute('data-stop')) } : {}), where, quote, rects, region };
}
function rangeMark(layer: Layer, range: Range) {
  const box = layer.strip.getBoundingClientRect();
  const rects: Rect[] = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0).map(r => [unit((r.left - box.left) / box.width), unit((r.top - box.top) / box.height), unit((r.right - box.left) / box.width), unit((r.bottom - box.top) / box.height)]);
  const quote = range.toString().replace(/\s+/g, ' ').trim();
  return quote && rects.length ? mark(layer, mergeLines(rects), quote, false) : null;
}

function pointMark(layer: Layer, clientX: number, clientY: number): Mark {
  const box = layer.strip.getBoundingClientRect(), x = unit((clientX - box.left) / box.width), y = unit((clientY - box.top) / box.height);
  const glyphs = Array.from(layer.strip.querySelectorAll<HTMLElement>('.pdf-glyph')).map(element => ({ element, box: element.getBoundingClientRect() }));
  const distance = (rect: DOMRect) => Math.max(rect.top - clientY, clientY - rect.bottom, 0) * 4 + Math.max(rect.left - clientX, clientX - rect.right, 0);
  const nearest = glyphs.sort((a, b) => distance(a.box) - distance(b.box))[0];
  const line = nearest ? glyphs.filter(glyph => glyph.element.parentElement === nearest.element.parentElement).sort((a, b) => a.box.left - b.box.left) : [];
  const before = line.filter(glyph => (glyph.box.left + glyph.box.right) / 2 < clientX).map(glyph => glyph.element.textContent).join('');
  const after = line.filter(glyph => (glyph.box.left + glyph.box.right) / 2 >= clientX).map(glyph => glyph.element.textContent).join('');
  const quote = `${before}‸${after}`.replace(/\s+/g, ' ').trim();
  return { ...mark(layer, [[unit(x - .006), unit(y - .004), unit(x + .006), unit(y + .004)]], quote, false), kind: 'point' };
}

// The menu floats outside the PDF strips' stacking and clipping boundaries,
// or below it near the top, and follows it as the paper scrolls.
function SelectionMenu({ doc, layer, selection, group, onAdd }: { doc: Document; layer: Layer; selection: Selected; group: NoteGroup | null; onAdd: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const place = () => {
      const element = menu.current; if (!element) return;
      const box = layer.strip.getBoundingClientRect(), paper = doc.getElementById('paper')?.getBoundingClientRect() || doc.body.getBoundingClientRect();
      const top = box.top + selection.rects[0][1] * box.height, bottom = box.top + selection.rects.at(-1)![3] * box.height;
      const middle = box.left + box.width * (Math.min(...selection.rects.map(r => r[0])) + Math.max(...selection.rects.map(r => r[2]))) / 2;
      const gap = selection.handles ? 22 : 8;
      const height = element.offsetHeight, half = element.offsetWidth / 2, above = top - height - gap >= paper.top + 6;
      element.style.top = `${Math.max(paper.top + 6, Math.min(paper.bottom - height - 6, above ? top - height - gap : bottom + gap))}px`;
      element.style.left = `${Math.max(paper.left + half + 8, Math.min(paper.right - half - 8, middle))}px`;
      element.style.visibility = bottom < paper.top || top > paper.bottom ? 'hidden' : '';
    };
    place();
    let frame = 0;
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
    doc.addEventListener('scroll', schedule, true); doc.defaultView?.addEventListener('resize', schedule);
    return () => { cancelAnimationFrame(frame); doc.removeEventListener('scroll', schedule, true); doc.defaultView?.removeEventListener('resize', schedule); };
  }, [doc, layer, selection, group]);
  return <div ref={menu} className="review-select-menu" onPointerDown={event => event.preventDefault()}><button type="button" aria-label={group ? t('Add to {group}', { group: groupName(group) }) : t('Comment')} onClick={onAdd}>{group ? <GroupAction group={group}/> : t('Comment')}</button></div>;
}

// Notes belong to the task and the exact displayed round/strip. They do not
// change accept/reject decisions, and are sent through the normal task queue.
export function ReviewNotes({ doc, task, onComment, railSlot }: { railSlot: HTMLElement | null; doc: Document | null; task: Task; onComment: () => void }) {
  const store = reviewDraft(task.id), draft = useReviewDraft(task.id);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [selection, setSelection] = useState<Selected | null>(null);
  const [group, setGroup] = useState<NoteGroup | null>(null);
  const activeGroup = useRef(group); activeGroup.current = group;
  const [tool, setTool] = useState<PdfTool>('select');
  const [locked, setLocked] = useState<number | null>(null);
  const stamps = useStamps();
  const [wheel, setWheel] = useState<{ x: number; y: number; mark: Mark } | null>(null);
  const region = tool === 'region';
  useEffect(() => { if (tool === 'magic') loadStamps(); }, [tool]);
  useEffect(() => { if (locked !== null && !stamps[locked]) setLocked(null); }, [locked, stamps]);
  const busy = draft.busy || task.status === 'deleting';
  const [drag, setDrag] = useState<{ key: string; rect: Rect } | null>(null);
  const origin = useRef<{ layer: Layer; x: number; y: number } | null>(null);
  const current = useRef({ region, busy, tool, markSelection }); current.current = { region, busy, tool, markSelection };
  const touch = useRef<ReturnType<typeof touchSelection> | null>(null);
  useNoteUndo(() => !busy && store.undo(), doc, () => !busy && store.redo());
  useEffect(() => {
    if (!region || !doc) return;
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); chooseTool('select'); setDrag(null); origin.current = null; } };
    doc.addEventListener('keydown', cancel, true); document.addEventListener('keydown', cancel, true);
    return () => { doc.removeEventListener('keydown', cancel, true); document.removeEventListener('keydown', cancel, true); };
  }, [doc, region]);
  function chooseTool(next: PdfTool) {
    setTool(next); setWheel(null); setDrag(null); origin.current = null;
    touch.current?.reset(); setSelection(null); doc?.getSelection()?.removeAllRanges();
    if (selection && ['note', 'magic', 'delete'].includes(next)) { current.current.tool = next; markSelection(selection); }
  }
  function annotate(region: boolean) { chooseTool(region ? 'region' : 'select'); doc?.defaultView?.focus(); }
  const hand = useReviewToolKeys({ doc, tool, busy, choose: chooseTool, lock: setLocked, stamps, wheel: Boolean(wheel) });
  current.current.tool = hand ? 'hand' : tool;
  useEffect(() => {
    if (!doc) return;
    doc.documentElement.dataset.reviewTool = hand ? 'hand' : tool;
    return () => { delete doc.documentElement.dataset.reviewTool; };
  }, [doc, tool, hand]);
  useEffect(() => {
    setWheel(null); setDrag(null); origin.current = null;
    if (!doc) return;
    const mounted = new Map<HTMLElement, Layer>();
    const scan = () => {
      let changed = false;
      const strips = Array.from(doc.querySelectorAll<HTMLElement>('.pdf-strip'));
      for (const [strip, layer] of mounted) if (!strips.includes(strip)) { layer.element.remove(); mounted.delete(strip); changed = true; }
      strips.forEach((strip, index) => {
        const src = strip.querySelector('img')?.getAttribute('src') || '';
        const round = Number(src.match(/\/files\/[^/]+\/(\d+)\//)?.[1] || task.review?.round || 0);
        // The strip's image names it in either view of the review; its index
        // differs between the full paper and the changes view.
        // A page of the paper as decided names its build and page instead.
        const key = strip.dataset.noteKey || `${round}:${(src.split('/').pop() || String(index)).replace(/-clean(?=\.)/, '')}`;
        const previous = mounted.get(strip);
        if (previous?.key === key) return;
        previous?.element.remove();
        const element = doc.createElement('div'); element.className = 'review-note-layer'; strip.append(element);
        mounted.set(strip, { strip, element, key, round }); changed = true;
      });
      if (changed) { setLayers([...mounted.values()]); touch.current?.reset(); setSelection(null); }
    };
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    let timer: ReturnType<typeof setTimeout>;
    const select = () => {
      if (['region', 'point', 'hand'].includes(current.current.tool) || current.current.busy || touch.current?.active()) return;
      const selected = doc.getSelection();
      if (!selected?.rangeCount || selected.isCollapsed) { setSelection(null); return; }
      const range = selected.getRangeAt(0);
      const first = elementAt(range.startContainer)?.closest<HTMLElement>('.pdf-strip');
      const last = elementAt(range.endContainer)?.closest<HTMLElement>('.pdf-strip');
      // Keep one note tied to one visible strip; never include change controls.
      const layer = first === last && first ? mounted.get(first) : null;
      if (!layer || !elementAt(range.startContainer)?.closest('.pdf-text') || !elementAt(range.endContainer)?.closest('.pdf-text')) { setSelection(null); return; }
      const value = rangeMark(layer, range); setSelection(value); return value;
    };
    const selectionChanged = () => { clearTimeout(timer); timer = setTimeout(select, 100); };
    doc.addEventListener('selectionchange', selectionChanged);
    let disposed = false;
    let pressed: { layer: Layer; x: number; y: number; at: number } | null = null;
    const press = (event: PointerEvent) => {
      const target = event.target as Element, strip = target.closest<HTMLElement>('.pdf-strip');
      const layer = strip && mounted.get(strip);
      pressed = event.button === 0 && layer && !target.closest('button,a,input,textarea') ? { layer, x: event.clientX, y: event.clientY, at: performance.now() } : null;
    };
    const marked = (event: PointerEvent) => {
      const start = pressed; pressed = null;
      if ((event.target as Element).closest('button,a,input,textarea')) return;
      // Long presses belong to the touch-selection handles and their menu.
      if (event.pointerType === 'touch' && (current.current.tool !== 'magic' || touch.current?.active() || !start || performance.now() - start.at >= 450)) return;
      if (!start && !(event.target as Element).closest('.pdf-strip')) return;
      if (!['note', 'delete', 'magic'].includes(current.current.tool)) return;
      // A native selection can end in the blank margin, outside the text layer.
      // A click with the magic pen marks a point, whether on text or whitespace.
      setTimeout(() => {
        if (disposed) return;
        const value = select();
        if (value) current.current.markSelection(value, event.clientX, event.clientY);
        else if (start && current.current.tool === 'magic' && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6) {
          current.current.markSelection(pointMark(start.layer, event.clientX, event.clientY), event.clientX, event.clientY);
        }
      }, 0);
    };
    const cancelPress = () => { pressed = null; };
    doc.addEventListener('pointercancel', cancelPress);
    doc.addEventListener('pointerdown', press);
    doc.addEventListener('pointerup', marked);
    // Touch screens select glyphs with Papilot's own handles and menu
    // (review-notes.css turns native selection off there).
    touch.current = touchSelection<Layer>(doc, {
      target: element => { const strip = element.closest('.pdf-text')?.closest<HTMLElement>('.pdf-strip'); return strip ? mounted.get(strip) : undefined; },
      units: layer => ({ units: Array.from(layer.strip.querySelectorAll<HTMLElement>('.pdf-glyph')), line: glyph => glyph.parentElement }),
      blocked: () => { const { busy } = current.current; return ['region', 'point', 'hand'].includes(current.current.tool) || busy; },
      menu: '.review-select-menu',
      onSelect: ({ target: layer, units, from, to }) => {
        const range = doc.createRange(); range.setStart(units[from], 0); range.setEnd(units[to], units[to].childNodes.length);
        const marked = rangeMark(layer, range); if (!marked) return;
        const box = layer.strip.getBoundingClientRect();
        const end = (glyph: HTMLElement, side: 'left' | 'right'): [number, number, number] => { const r = glyph.getBoundingClientRect(); return [unit((r[side] - box.left) / box.width), unit((r.top - box.top) / box.height), unit((r.bottom - box.top) / box.height)]; };
        setSelection({ ...marked, handles: { from: end(units[from], 'left'), to: end(units[to], 'right') } });
      },
      onClear: () => setSelection(null),
    });
    return () => {
      disposed = true; clearTimeout(timer); observer.disconnect(); touch.current?.stop(); touch.current = null;
      doc.removeEventListener('selectionchange', selectionChanged); doc.removeEventListener('pointercancel', cancelPress); doc.removeEventListener('pointerdown', press); doc.removeEventListener('pointerup', marked);
      for (const layer of mounted.values()) layer.element.remove();
    };
  }, [doc, task.review?.round]);
  function chooseGroup(next: NoteGroup | null) {
    setGroup(next); if (next && tool !== 'region') setTool('note'); touch.current?.reset(); setSelection(null);
    if (!next && store.getSnapshot().notes.some(note => note.group)) onComment();
  }
  useEffect(() => {
    const finish = (event: KeyboardEvent) => { if (event.key === 'Escape' && activeGroup.current) chooseGroup(null); };
    doc?.addEventListener('keydown', finish); document.addEventListener('keydown', finish);
    return () => { doc?.removeEventListener('keydown', finish); document.removeEventListener('keydown', finish); };
  }, [doc]);
  function addGrouped(mark: Mark, comment = '', focus = true) {
    if (current.current.busy) return;
    const grouped = !mark.kind && !mark.stamp && ['note', 'region'].includes(current.current.tool) && activeGroup.current;
    const id = store.add({ ...mark, ...(grouped ? { group: grouped } : {}) }, focus && !grouped, comment);
    touch.current?.reset(); setSelection(null); doc?.getSelection()?.removeAllRanges();
    if (id) locate(id, mark);
  }
  // A mark on the paper as decided has no change to name its source: its
  // build's SyncTeX finds the lines, followed into the task's current files,
  // also when newer decisions replaced those pages meanwhile.
  function locate(id: string, mark: Mark) {
    const [, key, page] = /^applied:([0-9a-f]{32}):(\d+)$/.exec(mark.strip) ?? [];
    if (!key || !request) return;
    const rect = mark.rects.length ? [Math.min(...mark.rects.map(r => r[0])), Math.min(...mark.rects.map(r => r[1])), Math.max(...mark.rects.map(r => r[2])), Math.max(...mark.rects.map(r => r[3]))] : [0, 0, 1, 1];
    void request<{ source: { file: string; lines: [number, number] } | null }>(`/tasks/${task.id}/locate`, { key, page: Number(page), rect, rects: mark.rects, quote: mark.quote })
      .then(({ source }) => {
        if (!source) return;
        const [start, end] = source.lines;
        store.place(id, `${mark.where} · ${source.file}:${start === end ? start : `${start}–${end}`}`);
      }, () => undefined);
  }
  function markSelection({ handles: _, ...mark }: Selected, x?: number, y?: number) {
    if (current.current.busy) return;
    if (current.current.tool === 'magic') {
      const stamp = locked === null ? null : stamps[locked];
      if (stamp) { addGrouped({ ...mark, stamp: stamp.label }, stamp.instruction, false); return; }
      const box = (doc?.defaultView?.frameElement as HTMLElement | null)?.getBoundingClientRect();
      setWheel({ x: (box?.left || 0) + (x ?? 150), y: (box?.top || 0) + (y ?? 150), mark });
      touch.current?.reset(); setSelection(null); doc?.getSelection()?.removeAllRanges(); return;
    }
    const deleting = current.current.tool === 'delete';
    addGrouped({ ...mark, ...(deleting ? { kind: 'delete' } : {}) }, '', !deleting);
    if (!deleting && (!activeGroup.current || !['note', 'region'].includes(current.current.tool))) onComment();
  }
  function edit(mark: Selected) { markSelection(mark); }
  function pickStamp(stamp: Stamp) {
    if (wheel) addGrouped({ ...wheel.mark, stamp: stamp.label }, stamp.instruction, false);
    setWheel(null); doc?.defaultView?.focus();
  }
  // The standalone engine keeps its editor; embedded comments join this draft.
  useEffect(() => {
    const view = doc?.defaultView; if (!doc || !view) return;
    const comment = (event: Event) => {
      event.preventDefault();
      if (current.current.busy) return;
      const detail = (event as CustomEvent<ReviewComment>).detail;
      const change = doc.querySelector<HTMLElement>(`.change[data-stop="${detail.stop}"]`);
      if (!change) return;
      const layer = layers.find(layer => change.contains(layer.strip) && layer.strip.closest('.after')) || layers.find(layer => change.contains(layer.strip));
      const location = change.querySelector<HTMLElement>('.change-where');
      const base = layer ? mark(layer, [], '', false) : { strip: '', round: detail.round, where: `Round ${detail.round} · ${location?.dataset.location || location?.textContent || ''}`, rects: [], region: false, quote: '' };
      store.add(reviewCommentMark(base, detail, Array.from(change.querySelectorAll('.after .pdf-text')).map(el => el.textContent).join(' ').trim()));
      onComment();
    };
    view.addEventListener('papilot:review:comment', comment);
    return () => view.removeEventListener('papilot:review:comment', comment);
  }, [doc, layers, store, onComment]);
  const jumped = useRef<unknown>(null);
  useEffect(() => {
    const focus = draft.reveal; if (!focus || !doc || jumped.current === focus) return;
    const layer = layers.find(layer => layer.key === focus.note.strip);
    if (layer) {
      layer.strip.scrollIntoView({ block: 'center' });
      layer.strip.animate([{ outline: '2px solid var(--primary)' }, { outline: '2px solid transparent' }], { duration: 1500 });
      jumped.current = focus;
    }
  }, [draft.reveal, layers, doc]);
  return <>
    <span className="pdf-compact-tools">
      <GroupPicker value={group} onChange={chooseGroup} disabled={!doc || busy}/>
      <button type="button" className="icon-button region-toggle" aria-label={t('Mark region')} title={t('Mark region')} aria-pressed={region} disabled={!doc || busy} onClick={() => annotate(!region)}><Icon name="region" size={16}/></button>
    </span>
    {railSlot && createPortal(<PdfToolRail tool={tool} onTool={chooseTool} group={group} onGroup={chooseGroup} disabled={!doc || busy} suspended={!doc} stamps={stamps} locked={locked} onLock={setLocked}
      history={{ canUndo: !busy && draft.canUndo, canRedo: !busy && draft.canRedo, undo: () => { store.undo(); }, redo: () => { store.redo(); } }}/>, railSlot)}
    {wheel && <StampWheel x={wheel.x} y={wheel.y} stamps={stamps} onPick={pickStamp} onClose={() => { setWheel(null); doc?.defaultView?.focus(); }} onFree={() => { addGrouped(wheel.mark); setWheel(null); onComment(); }}/>}
    {doc && createPortal(<style>{styles + noteStyles + groupStyles}</style>, doc.head)}
    {layers.map(layer => createPortal(<Fragment>
      {draft.notes.filter(note => note.strip === layer.key).map(note => <Fragment key={note.id}>
        {note.rects.map((rect, i) => <div key={i} className={note.kind === 'point' ? 'review-note-point' : note.region ? 'review-note-box' : 'review-note-mark'} data-kind={note.kind} data-stamp={note.stamp} data-group={note.group} style={{ ...percent(rect), ...groupStyle(note.group) }}/>) }
        <button className="review-note-tag" data-kind={note.kind} data-stamp={note.stamp} data-group={note.group} style={{ top: `${(note.rects[0]?.[1] || 0) * 100}%`, ...groupStyle(note.group) }} title={note.group ? t('Annotation groups') : note.comment} aria-label={t('Review note: {comment}', { comment: note.group ? groupName(note.group) : note.comment })} onClick={() => { store.focus(note.id); onComment(); }}>{draft.notes.indexOf(note) + 1}{note.stamp && <> · {note.stamp}</>}</button>
      </Fragment>)}
      {!busy && !hand && region && <div className="review-region-capture" onPointerDown={e => {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId);
        const box = layer.strip.getBoundingClientRect(), x = unit((e.clientX - box.left) / box.width), y = unit((e.clientY - box.top) / box.height);
        origin.current = { layer, x, y }; setDrag({ key: layer.key, rect: [x, y, x, y] });
      }} onPointerMove={e => {
        const start = origin.current; if (!start) return;
        const box = start.layer.strip.getBoundingClientRect(), x = unit((e.clientX - box.left) / box.width), y = unit((e.clientY - box.top) / box.height);
        setDrag({ key: start.layer.key, rect: [Math.min(start.x, x), Math.min(start.y, y), Math.max(start.x, x), Math.max(start.y, y)] });
      }} onPointerUp={e => {
        const start = origin.current; origin.current = null; setDrag(null);
        if (!start) return;
        const box = start.layer.strip.getBoundingClientRect(), x = unit((e.clientX - box.left) / box.width), y = unit((e.clientY - box.top) / box.height);
        const rect: Rect = [Math.min(start.x, x), Math.min(start.y, y), Math.max(start.x, x), Math.max(start.y, y)];
        if ((rect[2] - rect[0]) * box.width < 4 || (rect[3] - rect[1]) * box.height < 4) return;
        // Keep nearby PDF text as a locator for figures and equations too.
        const quote = (start.layer.strip.querySelector('.pdf-text')?.textContent || '').replace(/\s+/g, ' ').trim();
        edit(mark(start.layer, [rect], quote, true));
      }} onPointerCancel={() => { origin.current = null; setDrag(null); }}/>}
      {!busy && !hand && tool === 'point' && <div className="review-point-capture" onClick={event => {
        markSelection(pointMark(layer, event.clientX, event.clientY), event.clientX, event.clientY);
      }}/>}
      {drag?.key === layer.key && <div className="review-note-box" style={percent(drag.rect)}/>}
      {selection?.handles && selection.strip === layer.key && <>
        {selection.rects.map((rect, i) => <div key={i} className="review-note-mark" style={percent(rect)}/>)}
        {(['from', 'to'] as const).map(end => { const [x, top, bottom] = selection.handles![end]; return <span key={end} className="select-handle" data-end={end} style={{ left: `${x * 100}%`, top: `${top * 100}%`, height: `${(bottom - top) * 100}%` }}/>; })}
      </>}
    </Fragment>, layer.element, layer.key))}
    {doc && selection && !busy && (() => {
      const layer = layers.find(layer => layer.key === selection.strip);
      return layer ? createPortal(<SelectionMenu doc={doc} layer={layer} selection={selection} group={group} onAdd={() => edit(selection)}/>, doc.body) : null;
    })()}
  </>;
}
