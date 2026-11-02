import { noteGroups, type NoteGroup } from '../note-groups.ts';
import { GroupPicker, GroupCard, GroupAction, groupStyle, groupName } from './note-groups.tsx';
import { NoteBody, NoteQuote } from './note-content.tsx';
import groupStyles from './note-groups.css?inline';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NoteSummary, Task } from '../shared.ts';
import { noteLocation } from './note-location.ts';
import { noteAnchor } from '../notes.ts';
import { Icon } from './icons.tsx';
import { browserStorage } from './storage.ts';
import { sendsMessage } from './composer.ts';
import styles from './review-notes.css?inline';
import noteStyles from './note-controls.css?inline';
import { mergeLines, type Rect } from './note-geometry.ts';
import { touchSelection } from './touch-select.ts';
import { t, tn } from './i18n.ts';
import { useNoteUndo } from './use-note-undo.ts';

type Mark = { group?: NoteGroup; strip: string; round: number; where: string; quote: string; rects: Rect[]; region: boolean };
type Note = Mark & { id: string; comment: string };
type Draft = { instructions?: string; notes: Note[]; requestKey: string; editing: (Mark & { comment: string; id?: string }) | null; deleted?: { note: Note; index: number }[] };
type Layer = { strip: HTMLElement; element: HTMLElement; key: string; round: number };
// A touch selection's ends: the edge of its first and last glyph, with that line's top and bottom.
type Handles = { from: [number, number, number]; to: [number, number, number] };
type Selected = Mark & { handles?: Handles };
const uuid = () => crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(20)), b => b.toString(16).padStart(2, '0')).join('');
const unit = (v: number) => Math.max(0, Math.min(1, v));
const percent = ([x, y, right, bottom]: Rect) => ({ left: `${x * 100}%`, top: `${y * 100}%`, width: `${(right - x) * 100}%`, height: `${(bottom - y) * 100}%` });
const elementAt = (node: Node | null) => node?.nodeType === 1 ? node as Element : node?.parentElement;
function load(key: string): Draft {
  try {
    const value = JSON.parse(browserStorage.getItem(key) || 'null');
    if (value && Array.isArray(value.notes) && typeof value.requestKey === 'string') return value;
  } catch { /* A damaged draft must not prevent the review from opening. */ }
  return { notes: [], requestKey: uuid(), editing: null };
}
function mark(layer: Layer, rects: Rect[], quote: string, region: boolean): Mark {
  const change = layer.strip.closest('.change');
  const side = layer.strip.closest('.before') ? 'Before' : layer.strip.closest('.after') ? 'After' : 'Unchanged text';
  // The viewer may be in Chinese; the agent reads the English copies in data-change and data-location.
  const number = change?.querySelector<HTMLElement>('.change-number'), place = change?.querySelector<HTMLElement>('.change-where');
  const where = [`Round ${layer.round}`, `PDF page ${layer.strip.dataset.page || '?'}`, side,
    number?.dataset.change ? `Change ${number.dataset.change}` : number?.textContent, place?.dataset.location || place?.getAttribute('title') || place?.textContent].filter(Boolean).join(' · ');
  return { strip: layer.key, round: layer.round, where, quote, rects, region };
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
  return <div ref={menu} className="review-select-menu"><button type="button" aria-label={group ? t('Add to {group}', { group: groupName(group) }) : t('Add note')} onClick={onAdd}><GroupAction group={group}/></button></div>;
}

// Notes belong to the task and the exact displayed round/strip. They do not
// change accept/reject decisions, and are sent through the normal task queue.
export function ReviewNotes({ doc, task, onSend }: { doc: Document | null; task: Task; onSend: (message: { text: string; requestKey: string; notes?: NoteSummary[] }) => Promise<void> }) {
  const storageKey = `papilot:review-notes:${task.id}`;
  const [draft, setDraft] = useState(() => load(storageKey));
  const [layers, setLayers] = useState<Layer[]>([]);
  const [selection, setSelection] = useState<Selected | null>(null);
  const [group, setGroup] = useState<NoteGroup | null>(null);
  const activeGroup = useRef(group); activeGroup.current = group;
  const added = useRef<string[]>([]);
  // A note left half-written, for example by a reload, reopens its editor.
  const [region, setRegion] = useState(false), [open, setOpen] = useState(() => Boolean(draft.editing?.comment.trim())), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [drag, setDrag] = useState<{ key: string; rect: Rect } | null>(null);
  const origin = useRef<{ layer: Layer; x: number; y: number } | null>(null);
  const current = useRef({ draft, region, busy, open }); current.current = { draft, region, busy, open };
  // A note is being written while its editor is open; a closed one does not block selecting elsewhere.
  const writing = open && Boolean(draft.editing);
  const sending = useRef(false);
  const touch = useRef<ReturnType<typeof touchSelection> | null>(null);
  useNoteUndo(() => {
    // When the notes panel is closed, the review owns its normal Undo shortcut.
    if (doc && (activeGroup.current || current.current.open) && added.current.length && !current.current.busy && !current.current.draft.editing) {
      const id = added.current.pop(); const value = current.current.draft;
      update({ ...value, notes: value.notes.filter(note => note.id !== id), requestKey: uuid() }); return true;
    }
    if (!doc || !current.current.open || !current.current.draft.deleted?.length) return false;
    if (!current.current.busy && !current.current.draft.editing && !current.current.region) undo();
    return true;
  }, doc);
  useEffect(() => {
    if (!region || !doc) return;
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRegion(false); setDrag(null); origin.current = null; } };
    doc.addEventListener('keydown', cancel, true); document.addEventListener('keydown', cancel, true);
    return () => { doc.removeEventListener('keydown', cancel, true); document.removeEventListener('keydown', cancel, true); };
  }, [doc, region]);
  function annotate(region: boolean) { setRegion(region); setOpen(false); touch.current?.reset(); setSelection(null); doc?.defaultView?.focus(); }
  function update(value: Draft) { current.current.draft = value; browserStorage.setItem(storageKey, JSON.stringify(value)); setDraft(value); }
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
        const key = `${round}:${src.split('/').pop() || index}`;
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
      if ((current.current.open && current.current.draft.editing) || current.current.region || current.current.busy || touch.current?.active()) return;
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
      blocked: () => { const { draft, region, busy, open } = current.current; return Boolean(open && draft.editing) || region || busy; },
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
    if (!next && current.current.draft.notes.some(note => note.group)) setOpen(true);
  }
  useEffect(() => {
    const finish = (event: KeyboardEvent) => { if (event.key === 'Escape' && activeGroup.current) chooseGroup(null); };
    doc?.addEventListener('keydown', finish); document.addEventListener('keydown', finish);
    return () => { doc?.removeEventListener('keydown', finish); document.removeEventListener('keydown', finish); };
  }, [doc]);
  function addGrouped(mark: Mark) {
    const group = activeGroup.current, value = current.current.draft;
    if (!group || current.current.busy) return;
    const note = { ...mark, group, comment: '', id: uuid() };
    added.current.push(note.id);
    update({ ...value, notes: [...value.notes, note], requestKey: uuid() });
    touch.current?.reset(); setSelection(null); doc?.getSelection()?.removeAllRanges();
  }
  // Text written for a note that was closed unsaved moves to the new place.
  function edit({ handles: _, ...mark }: Selected) {
    if (activeGroup.current) { addGrouped(mark); return; }
    const value = current.current.draft;
    update({ ...value, editing: { ...mark, comment: value.editing?.id ? '' : value.editing?.comment || '' } });
    touch.current?.reset(); setSelection(null); setRegion(false); setOpen(true); doc?.getSelection()?.removeAllRanges();
  }
  function editNote(note: Note) {
    update({ ...current.current.draft, editing: { ...note } }); setError('');
    touch.current?.reset(); setSelection(null);
  }
  function finishEdit() {
    const value = current.current.draft, id = value.editing?.id;
    update({ ...value, editing: null });
    if (!value.notes.length) setOpen(false);
    if (id) requestAnimationFrame(() => doc?.querySelector<HTMLButtonElement>(`[data-note="${id}"] .note-comment`)?.focus());
  }
  // Closing drops a note with nothing written yet.
  function close() {
    const value = current.current.draft;
    if (value.editing && !value.editing.comment.trim()) update({ ...value, editing: null });
    setOpen(false); setRegion(false);
  }
  function save() {
    const value = current.current.draft, editing = value.editing;
    if (!editing?.comment.trim() || busy) return;
    const note = { ...editing, comment: editing.comment.trim(), id: editing.id || uuid() };
    update({ ...value, notes: editing.id ? value.notes.map(item => item.id === note.id ? note : item) : [...value.notes, note], requestKey: uuid() });
    finishEdit();
  }
  function remove(note: Note) {
    added.current = [];
    const value = current.current.draft;
    update({ ...value, notes: value.notes.filter(item => item.id !== note.id), deleted: [...(value.deleted || []), { note, index: value.notes.indexOf(note) }], requestKey: uuid() });
    setError('');
  }
  function undo() {
    const value = current.current.draft, deleted = [...(value.deleted || [])], removed = deleted.pop();
    if (!removed) return;
    const notes = [...value.notes]; notes.splice(removed.index, 0, removed.note);
    update({ ...value, notes, deleted, requestKey: uuid() }); setError('');
    requestAnimationFrame(() => doc?.querySelector<HTMLButtonElement>(`[data-note="${removed.note.id}"] .note-comment`)?.focus());
  }
  async function send() {
    if (sending.current || !draft.notes.length || draft.editing) return;
    sending.current = true; setBusy(true); setError('');
    const submitted = draft;
    try {
      await onSend({ requestKey: submitted.requestKey, text: submitted.instructions || '', notes: submitted.notes.map(note => ({
        ...(note.group ? { group: note.group } : {}), id: note.id, where: note.where + (note.region ? ` · Region in displayed strip: ${note.rects[0].map(v => `${Math.round(v * 100)}%`).join(', ')}` : ''), quote: note.quote, comment: note.comment, anchor: { ...noteAnchor(note), round: note.round },
      })) });
      // A different mount may have saved more notes while this request was pending.
      const saved = load(storageKey);
      if (saved.requestKey === submitted.requestKey) update({ notes: [], editing: null, requestKey: uuid() });
      else setDraft(saved);
      setOpen(false); setGroup(null); added.current = [];
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { sending.current = false; setBusy(false); }
  }
  const blocked = task.status === 'uncertain' || task.status === 'deleting';
  const hasGroups = draft.notes.some(note => note.group);
  return <>
    <GroupPicker value={group} onChange={chooseGroup} disabled={busy || writing}/>
    <button type="button" className="icon-button" aria-label={t('Mark region')} title={t('Mark region')} aria-pressed={region} disabled={!doc || busy || writing} onClick={() => annotate(!region)}><Icon name="region" size={16}/></button>
    {doc && createPortal(<style>{styles + noteStyles + groupStyles}</style>, doc.head)}
    {layers.map(layer => createPortal(<Fragment>
      {draft.notes.filter(note => note.strip === layer.key).map(note => <Fragment key={note.id}>
        {note.rects.map((rect, i) => <div key={i} className={note.region ? 'review-note-box' : 'review-note-mark'} data-group={note.group} style={{ ...percent(rect), ...groupStyle(note.group) }}/>) }
        <button className="review-note-tag" data-group={note.group} style={{ top: `${note.rects[0][1] * 100}%`, ...groupStyle(note.group) }} title={note.group ? t('Annotation groups') : note.comment} aria-label={t('Review note: {comment}', { comment: note.group ? groupName(note.group) : note.comment })} onClick={() => setOpen(true)}>{draft.notes.indexOf(note) + 1}</button>
      </Fragment>)}
      {writing && draft.editing?.strip === layer.key && draft.editing.rects.map((rect, i) => <div key={i} className={draft.editing!.region ? 'review-note-box' : 'review-note-mark'} style={percent(rect)}/>)}
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
      {selection?.strip === layer.key && !selection.handles && !writing && !busy && <button className="review-add-note" aria-label={group ? t('Add to {group}', { group: groupName(group) }) : t('Add note')} style={{ left: `${Math.min(80, selection.rects.at(-1)![2] * 100)}%`, top: `${selection.rects.at(-1)![3] * 100}%` }} onPointerDown={e => e.preventDefault()} onClick={() => edit(selection)}><GroupAction group={group}/></button>}
    </Fragment>, layer.element, layer.key))}
    {doc && selection?.handles && !writing && !busy && (() => {
      const layer = layers.find(layer => layer.key === selection.strip);
      return layer ? createPortal(<SelectionMenu doc={doc} layer={layer} selection={selection} group={group} onAdd={() => edit(selection)}/>, doc.body) : null;
    })()}
    {doc && open && !region && createPortal(<aside className="review-notes-panel" aria-label={t('Review PDF notes')} onKeyDown={e => {
      // Do not let the review engine interpret note-editor shortcuts as decisions.
      e.stopPropagation();
      if (e.key === 'Escape' && !busy) { if (draft.editing?.id) finishEdit(); else close(); }
    }}>
      <header><strong>{hasGroups ? t('PDF annotations') : draft.notes.length ? t('Review notes ({n})', { n: draft.notes.length }) : t('Review notes')}</strong><button type="button" aria-label={t('Close review notes')} onClick={close}>×</button></header>
        {draft.editing ? <form onSubmit={e => { e.preventDefault(); save(); }}>
          <small>{noteLocation(draft.editing.where)}</small>
          <NoteQuote text={draft.editing.quote}/>
          <NoteBody>
          <textarea autoFocus aria-label={t('Note for the agent')} rows={3} maxLength={4000} placeholder={t('What should change here?')} value={draft.editing.comment} onChange={e => update({ ...draft, editing: { ...draft.editing!, comment: e.target.value } })} onKeyDown={e => { if (sendsMessage(e.nativeEvent, window.matchMedia('(pointer: coarse)').matches)) { e.preventDefault(); save(); } }}/>
          </NoteBody>
          <footer><button type="button" onClick={finishEdit}>{t('Cancel')}</button><button className="primary" disabled={!draft.editing.comment.trim()}>{draft.editing.id ? t('Save') : t('Add note')}</button></footer>
        </form> : <>
          {noteGroups(draft.notes).map(({ group, entries }) => <GroupCard key={group} group={group} count={entries.length}>
            {entries.map(({ note, index }) => <div className="group-location" key={note.id}><button type="button" onClick={() => { layers.find(layer => layer.key === note.strip)?.strip.scrollIntoView({ block: 'center' }); setOpen(false); }}><span>{noteLocation(note.where)}</span><blockquote>{note.quote || t('Marked region')}</blockquote></button><button type="button" aria-label={t('Delete review note {n}', { n: index + 1 })} disabled={busy} onClick={() => remove(note)}>×</button></div>)}
          </GroupCard>)}
          {hasGroups && <textarea aria-label={t('Instructions for color groups')} placeholder={t('What should change in each color group?')} value={draft.instructions || ''} disabled={busy} onChange={event => update({ ...current.current.draft, instructions: event.target.value, requestKey: uuid() })}/>}
          {draft.notes.length ? <ol>{draft.notes.map((note, index) => !note.group && <li key={note.id} data-note={note.id}>
            <div className="review-note-head"><button className="review-note-location" onClick={() => { layers.find(layer => layer.key === note.strip)?.strip.scrollIntoView({ block: 'center' }); setOpen(false); }}>{index + 1}. {noteLocation(note.where)}</button><button type="button" aria-label={t('Delete review note {n}', { n: index + 1 })} disabled={busy} onClick={() => remove(note)}>×</button></div>
            <NoteQuote text={note.quote}/>
            <NoteBody><button type="button" className="note-comment" aria-label={t('Edit note {n}: {comment}', { n: index + 1, comment: note.comment })} title={t('Edit note')} disabled={busy} onClick={() => editNote(note)}><span>{note.comment}</span><Icon name="pencil" size={13}/></button></NoteBody>
            {note.round !== task.review?.round && <small>{t('Marked on earlier changes.')}</small>}
          </li>)}</ol> : <div className="review-notes-empty"><p>{t('No notes yet')}</p><div className="review-note-actions">
            <button type="button" onClick={() => annotate(true)}><Icon name="region" size={16}/>{t('Region note')}</button>
          </div></div>}
          {error && <p className="review-notes-error" role="alert">{error}</p>}
          {blocked && <p>{t('Check the task status before sending notes.')}</p>}
          {draft.notes.length > 0 && <footer><button className="primary" aria-label={busy ? t('Sending…') : hasGroups ? t('Send annotations to the agent') : tn(draft.notes.length, 'Send {n} note to the agent', 'Send {n} notes to the agent')} disabled={busy || blocked || (hasGroups && !draft.instructions?.trim() && !draft.notes.some(note => note.comment.trim()))} onClick={() => void send()}>{busy ? t('Sending…') : hasGroups ? t('Send annotations') : tn(draft.notes.length, 'Send {n} note', 'Send {n} notes')}</button></footer>}
        </>}
    </aside>, doc.body)}
  </>;
}
