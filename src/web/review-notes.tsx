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
import { useNoteUndo } from './use-note-undo.ts';

import { reviewDraft, useReviewDraft, type ReviewMark as Mark } from './review-draft.ts';

type Layer = { strip: HTMLElement; element: HTMLElement; key: string; round: number };
// A touch selection's ends: the edge of its first and last glyph, with that line's top and bottom.
type Handles = { from: [number, number, number]; to: [number, number, number] };
type Selected = Mark & { handles?: Handles };
const unit = (v: number) => Math.max(0, Math.min(1, v));
const percent = ([x, y, right, bottom]: Rect) => ({ left: `${x * 100}%`, top: `${y * 100}%`, width: `${(right - x) * 100}%`, height: `${(bottom - y) * 100}%` });
const elementAt = (node: Node | null) => node?.nodeType === 1 ? node as Element : node?.parentElement;
function mark(layer: Layer, rects: Rect[], quote: string, region: boolean): Mark {
  const change = layer.strip.closest('.change');
  const side = layer.strip.closest('.before') ? 'Before' : layer.strip.closest('.after') ? 'After' : 'Unchanged text';
  // The viewer may be in Chinese; the agent reads the English copies in data-change and data-location.
  const number = change?.querySelector<HTMLElement>('.change-number'), place = change?.querySelector<HTMLElement>('.change-where');
  const where = [`Round ${layer.round}`, `PDF page ${layer.strip.dataset.page || '?'}`, side,
    number?.dataset.change ? `Change ${number.dataset.change}` : number?.textContent, place?.dataset.location || place?.getAttribute('title') || place?.textContent].filter(Boolean).join(' · ');
  return { strip: layer.key, round: layer.round, ...(change?.getAttribute('data-stop') ? { stop: Number(change.getAttribute('data-stop')) } : {}), where, quote: quote.slice(0, 2000), rects, region };
}
function rangeMark(layer: Layer, range: Range) {
  const box = layer.strip.getBoundingClientRect();
  const rects: Rect[] = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0).map(r => [unit((r.left - box.left) / box.width), unit((r.top - box.top) / box.height), unit((r.right - box.left) / box.width), unit((r.bottom - box.top) / box.height)]);
  const quote = range.toString().replace(/\s+/g, ' ').trim();
  return quote && rects.length ? mark(layer, mergeLines(rects), quote, false) : null;
}

// The menu for a touch selection floats in the viewer above the selection,
// or below it near the top, and follows it as the paper scrolls.
function SelectionMenu({ doc, layer, selection, group, onAdd }: { doc: Document; layer: Layer; selection: Mark; group: NoteGroup | null; onAdd: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const place = () => {
      const element = menu.current; if (!element) return;
      const box = layer.strip.getBoundingClientRect(), paper = doc.getElementById('paper')?.getBoundingClientRect() || doc.body.getBoundingClientRect();
      const top = box.top + selection.rects[0][1] * box.height, bottom = box.top + selection.rects.at(-1)![3] * box.height;
      const middle = box.left + box.width * (Math.min(...selection.rects.map(r => r[0])) + Math.max(...selection.rects.map(r => r[2]))) / 2;
      const height = element.offsetHeight, half = element.offsetWidth / 2, above = top - height - 22 >= paper.top + 6;
      element.style.top = `${above ? top - height - 22 : bottom + 22}px`;
      element.style.left = `${Math.max(paper.left + half + 8, Math.min(paper.right - half - 8, middle))}px`;
      element.style.visibility = bottom < paper.top || top > paper.bottom ? 'hidden' : '';
    };
    place();
    let frame = 0;
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
    doc.addEventListener('scroll', schedule, true); doc.defaultView?.addEventListener('resize', schedule);
    return () => { cancelAnimationFrame(frame); doc.removeEventListener('scroll', schedule, true); doc.defaultView?.removeEventListener('resize', schedule); };
  }, [doc, layer, selection]);
  return <div ref={menu} className="review-select-menu"><button type="button" aria-label={group ? t('Add to {group}', { group: groupName(group) }) : t('Comment')} onClick={onAdd}>{group ? <GroupAction group={group}/> : t('Comment')}</button></div>;
}

// Notes belong to the task and the exact displayed round/strip. They do not
// change accept/reject decisions, and are sent through the normal task queue.
export function ReviewNotes({ doc, task, onComment }: { doc: Document | null; task: Task; onComment: () => void }) {
  const store = reviewDraft(task.id), draft = useReviewDraft(task.id);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [selection, setSelection] = useState<Selected | null>(null);
  const [group, setGroup] = useState<NoteGroup | null>(null);
  const activeGroup = useRef(group); activeGroup.current = group;
  const [region, setRegion] = useState(false);
  const busy = draft.busy || task.status === 'deleting';
  const [drag, setDrag] = useState<{ key: string; rect: Rect } | null>(null);
  const origin = useRef<{ layer: Layer; x: number; y: number } | null>(null);
  const current = useRef({ region, busy }); current.current = { region, busy };
  const touch = useRef<ReturnType<typeof touchSelection> | null>(null);
  useNoteUndo(() => activeGroup.current ? store.undoAdded() : store.undo(), doc);
  useEffect(() => {
    if (!region || !doc) return;
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRegion(false); setDrag(null); origin.current = null; } };
    doc.addEventListener('keydown', cancel, true); document.addEventListener('keydown', cancel, true);
    return () => { doc.removeEventListener('keydown', cancel, true); document.removeEventListener('keydown', cancel, true); };
  }, [doc, region]);
  function annotate(region: boolean) { setRegion(region); touch.current?.reset(); setSelection(null); doc?.defaultView?.focus(); }
  useEffect(() => {
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
        const key = `${round}:${(src.split('/').pop() || String(index)).replace(/-clean(?=\.)/, '')}`;
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
      if (current.current.region || current.current.busy || touch.current?.active()) return;
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
    const marked = (event: PointerEvent) => {
      if (!activeGroup.current || event.pointerType === 'touch' || !(event.target as Element).closest('.pdf-text')) return;
      setTimeout(() => { if (disposed) return; const value = select(); if (value && activeGroup.current) addGrouped(value); }, 0);
    };
    doc.addEventListener('pointerup', marked);
    // Touch screens select glyphs with Papilot's own handles and menu
    // (review-notes.css turns native selection off there).
    touch.current = touchSelection<Layer>(doc, {
      target: element => { const strip = element.closest('.pdf-text')?.closest<HTMLElement>('.pdf-strip'); return strip ? mounted.get(strip) : undefined; },
      units: layer => ({ units: Array.from(layer.strip.querySelectorAll<HTMLElement>('.pdf-glyph')), line: glyph => glyph.parentElement }),
      blocked: () => { const { region, busy } = current.current; return region || busy; },
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
      doc.removeEventListener('selectionchange', selectionChanged); doc.removeEventListener('pointerup', marked);
      for (const layer of mounted.values()) layer.element.remove();
    };
  }, [doc, task.review?.round]);
  function chooseGroup(next: NoteGroup | null) {
    setGroup(next); touch.current?.reset(); setSelection(null);
    if (!next && store.getSnapshot().notes.some(note => note.group)) onComment();
  }
  useEffect(() => {
    const finish = (event: KeyboardEvent) => { if (event.key === 'Escape' && activeGroup.current) chooseGroup(null); };
    doc?.addEventListener('keydown', finish); document.addEventListener('keydown', finish);
    return () => { doc?.removeEventListener('keydown', finish); document.removeEventListener('keydown', finish); };
  }, [doc]);
  function addGrouped(mark: Mark) {
    if (current.current.busy) return;
    store.add({ ...mark, ...(activeGroup.current ? { group: activeGroup.current } : {}) }, !activeGroup.current);
    touch.current?.reset(); setSelection(null); doc?.getSelection()?.removeAllRanges();
  }
  function edit({ handles: _, ...mark }: Selected) {
    addGrouped(mark); setRegion(false); onComment();
  }
  // The standalone engine keeps its editor; embedded comments join this draft.
  useEffect(() => {
    const view = doc?.defaultView; if (!doc || !view) return;
    const comment = (event: Event) => {
      event.preventDefault();
      if (current.current.busy) return;
      const detail = (event as CustomEvent<{ round: number; stop: number }>).detail;
      const change = doc.querySelector<HTMLElement>(`.change[data-stop="${detail.stop}"]`);
      if (!change) return;
      const layer = layers.find(layer => change.contains(layer.strip) && layer.strip.closest('.after')) || layers.find(layer => change.contains(layer.strip));
      const location = change.querySelector<HTMLElement>('.change-where');
      const base = layer ? mark(layer, [], '', false) : { strip: '', round: detail.round, where: `Round ${detail.round} · ${location?.dataset.location || location?.textContent || ''}`, rects: [], region: false, quote: '' };
      store.add({ ...base, whole: true, stop: detail.stop, quote: Array.from(change.querySelectorAll('.after .pdf-text')).map(el => el.textContent).join(' ').trim().slice(0, 2000) });
      onComment();
    };
    view.addEventListener('latex-review:comment', comment);
    return () => view.removeEventListener('latex-review:comment', comment);
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
    <GroupPicker value={group} onChange={chooseGroup} disabled={busy}/>
    <button type="button" className="icon-button" aria-label={t('Mark region')} title={t('Mark region')} aria-pressed={region} disabled={!doc || busy} onClick={() => annotate(!region)}><Icon name="region" size={16}/></button>
    {doc && createPortal(<style>{styles + noteStyles + groupStyles}</style>, doc.head)}
    {layers.map(layer => createPortal(<Fragment>
      {draft.notes.filter(note => note.strip === layer.key).map(note => <Fragment key={note.id}>
        {note.rects.map((rect, i) => <div key={i} className={note.region ? 'review-note-box' : 'review-note-mark'} data-group={note.group} style={{ ...percent(rect), ...groupStyle(note.group) }}/>) }
        <button className="review-note-tag" data-group={note.group} style={{ top: `${(note.rects[0]?.[1] || 0) * 100}%`, ...groupStyle(note.group) }} title={note.group ? t('Annotation groups') : note.comment} aria-label={t('Review note: {comment}', { comment: note.group ? groupName(note.group) : note.comment })} onClick={() => { store.focus(note.id); onComment(); }}>{draft.notes.indexOf(note) + 1}</button>
      </Fragment>)}
      {region && <div className="review-region-capture" onPointerDown={e => {
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
        const quote = (start.layer.strip.querySelector('.pdf-text')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
        edit(mark(start.layer, [rect], quote, true));
      }} onPointerCancel={() => { origin.current = null; setDrag(null); }}/>}
      {drag?.key === layer.key && <div className="review-note-box" style={percent(drag.rect)}/>}
      {selection?.handles && selection.strip === layer.key && <>
        {selection.rects.map((rect, i) => <div key={i} className="review-note-mark" style={percent(rect)}/>)}
        {(['from', 'to'] as const).map(end => { const [x, top, bottom] = selection.handles![end]; return <span key={end} className="select-handle" data-end={end} style={{ left: `${x * 100}%`, top: `${top * 100}%`, height: `${(bottom - top) * 100}%` }}/>; })}
      </>}
      {selection?.strip === layer.key && !selection.handles && !busy && <button className="review-add-note" aria-label={group ? t('Add to {group}', { group: groupName(group) }) : t('Comment')} style={{ left: `${Math.min(80, selection.rects.at(-1)![2] * 100)}%`, top: `${selection.rects.at(-1)![3] * 100}%` }} onPointerDown={e => e.preventDefault()} onClick={() => edit(selection)}>{group ? <GroupAction group={group}/> : t('Comment')}</button>}
    </Fragment>, layer.element, layer.key))}
    {doc && selection?.handles && !busy && (() => {
      const layer = layers.find(layer => layer.key === selection.strip);
      return layer ? createPortal(<SelectionMenu doc={doc} layer={layer} selection={selection} group={group} onAdd={() => edit(selection)}/>, doc.body) : null;
    })()}
  </>;
}
