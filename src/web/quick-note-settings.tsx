import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Icon } from './icons.tsx';
import { t } from './i18n.ts';
import { IconPicker } from './skill-icon-picker.tsx';
import { StampRingPreview } from './stamp-wheel.tsx';
import { QUICK_NOTE_LIMIT, loadStamps, presetStamps, samePresets, saveStamps, slotKey, stampIcons, useStamps, type Stamp } from './stamps.ts';
import './quick-note-settings.css';

// A note being written: one already on the wheel, by its id, since the list
// can refresh from another device meanwhile; or a new one.
type Draft = { id: string | null; label: string; instruction: string; icon: string };

// The magic pen's quick notes. Each change saves at once; a removal or a
// return to the presets can be undone. The ring beside the list shows where
// each note sits and the number key that picks it.
export function QuickNoteSettings() {
  const stamps = useStamps();
  const [order, setOrder] = useState<Stamp[] | null>(null), list = order || stamps;
  const [draft, setDraft] = useState<Draft | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [undo, setUndo] = useState<{ text: string; stamps: Stamp[] } | null>(null);
  const [hover, setHover] = useState<number | null>(null), [dragging, setDragging] = useState<string | null>(null);
  const rows = useRef<HTMLDivElement>(null);
  useEffect(() => { loadStamps(); }, []);

  async function save(next: Stamp[], undoable?: string) {
    const previous = list;
    setBusy(true); setError(''); setUndo(null);
    try { await saveStamps(next); if (undoable) setUndo({ text: undoable, stamps: previous }); return true; }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); return false; }
    finally { setOrder(null); setBusy(false); }
  }
  function edit(stamp?: Stamp) {
    // A new note starts with an icon no other note uses.
    const icon = stamp?.icon || stampIcons().find(item => !list.some(other => other.icon === item.id))?.id || 'notes';
    setDraft({ id: stamp?.id ?? null, label: stamp?.label || '', instruction: stamp?.instruction || '', icon }); setError(''); setUndo(null);
  }
  const label = draft?.label.trim().replace(/\s+/g, ' ') || '', instruction = draft?.instruction.trim() || '';
  async function commit() {
    if (!draft || !label || !instruction || busy) return;
    const entry = { label, instruction, icon: draft.icon };
    // A note removed elsewhere while being edited comes back with the edit.
    const next = draft.id !== null && list.some(stamp => stamp.id === draft.id) ? list.map(stamp => stamp.id === draft.id ? { ...stamp, ...entry } : stamp)
      : [...list, { id: draft.id ?? `custom-${Math.random().toString(36).slice(2, 10)}`, ...entry }];
    if (await save(next)) setDraft(null);
  }
  const moved = (from: number, to: number) => { const next = [...list]; next.splice(to, 0, ...next.splice(from, 1)); return next; };
  // Dragging a handle reorders the list as it goes and saves on release. The
  // row moves in the page as it goes, which ends pointer capture, so the
  // window follows the pointer instead.
  function drag(event: ReactPointerEvent<HTMLButtonElement>, index: number) {
    if (busy || draft || event.button !== 0) return;
    event.preventDefault();
    const id = list[index].id, start = list, pointer = event.pointerId;
    setDragging(id);
    let current = start;
    const move = (step: PointerEvent) => {
      if (step.pointerId !== pointer) return;
      const items = Array.from(rows.current?.querySelectorAll<HTMLElement>('.quick-note-row') || []);
      const from = current.findIndex(stamp => stamp.id === id);
      const to = items.reduce((slot, item, position) => step.clientY > item.getBoundingClientRect().top + item.offsetHeight / 2 ? position : slot, 0);
      if (to !== from) { const next = [...current]; next.splice(to, 0, ...next.splice(from, 1)); current = next; setOrder(next); setHover(to); }
    };
    const end = (step: PointerEvent) => {
      if (step.pointerId !== pointer) return;
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end);
      setDragging(null);
      if (current !== start) void save(current); else setOrder(null);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
  }
  const editing = draft?.id ? list.findIndex(stamp => stamp.id === draft.id) : -1, adding = draft !== null && editing < 0;
  const lit = hover ?? (editing >= 0 ? editing : null);
  const editor = draft && <div className="quick-note-editor" key="editor"
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDraft(null); }
      else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void commit(); }
    }}>
    <IconPicker value={draft.icon} onChange={icon => setDraft({ ...draft, icon })} disabled={busy} icons={stampIcons()} name={t('Quick note icon')}/>
    <div className="quick-note-fields">
      <label>{t('Short name')}<input autoFocus value={draft.label} maxLength={20} disabled={busy} placeholder={t('A word or two for the wheel')} onChange={event => setDraft({ ...draft, label: event.target.value })}/></label>
      <label>{t('Instruction')}<textarea rows={3} value={draft.instruction} maxLength={1000} disabled={busy} placeholder={t('What the agent should do with the marked text')} onChange={event => setDraft({ ...draft, instruction: event.target.value })}/></label>
      <div className="quick-note-editor-actions">
        <button type="button" className="button secondary compact" disabled={busy} onClick={() => setDraft(null)}>{t('Cancel')}</button>
        <button type="button" className="button primary compact" disabled={busy || !label || !instruction} onClick={() => void commit()}>{busy ? t('Saving…') : t('Save')}</button>
      </div>
    </div>
  </div>;
  return <div className="quick-note-settings settings-page">
    <div className="quick-note-intro">
      <StampRingPreview stamps={adding && label ? [...list, { id: 'draft', label, instruction, icon: draft.icon }] : list} highlight={adding && label ? list.length : lit}/>
      <div>
        <p className="settings-intro">{t('After you mark text with the magic pen, its wheel offers these notes, clockwise from the top. Each is sent to the agent as the instruction for that text.')}</p>
        <p className="settings-intro">{t('Number keys pick the same slots. Press one before marking to keep that note on the pen; 0 or Escape lets go.')}</p>
        <p className="settings-intro">{t('Papilot keeps this list for you, so your phone and computer offer the same notes.')}</p>
      </div>
    </div>
    <div ref={rows} className="quick-note-list settings-card" role="list" aria-label={t('Quick notes')} onPointerLeave={() => { if (!dragging) setHover(null); }}>
      {list.map((stamp, index) => draft?.id === stamp.id ? editor : <div key={stamp.id} data-id={stamp.id} role="listitem" className="quick-note-row" data-dragging={dragging === stamp.id || undefined} onPointerEnter={() => { if (!dragging) setHover(index); }}>
        <button type="button" className="quick-note-handle" aria-label={t('Move {name}', { name: stamp.label })} title={t('Drag to reorder')} aria-keyshortcuts="ArrowUp ArrowDown" disabled={busy || Boolean(draft) || list.length < 2}
          onPointerDown={event => drag(event, index)}
          onKeyDown={event => {
            const to = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : -1;
            if (to < 0 || to >= list.length) return;
            // Saving disables the handle, so focus returns to it afterwards.
            event.preventDefault();
            void save(moved(index, to)).then(() => requestAnimationFrame(() => rows.current?.querySelector<HTMLElement>(`[data-id="${stamp.id}"] .quick-note-handle`)?.focus()));
          }}><Icon name="grip" size={16}/></button>
        <kbd className="quick-note-key">{slotKey(index)}</kbd>
        <span className="quick-note-icon"><Icon name={stamp.icon} size={20}/></span>
        <button type="button" className="quick-note-text" disabled={busy || Boolean(draft)} onFocus={() => setHover(index)} onClick={() => edit(stamp)} aria-label={t('Edit {name}', { name: stamp.label })}>
          <strong>{stamp.label}</strong><span>{stamp.instruction}</span>
        </button>
        <button type="button" className="icon-button" aria-label={t('Delete {name}', { name: stamp.label })} title={t('Delete')} disabled={busy || Boolean(draft) || list.length < 2} onClick={() => void save(list.filter((_, other) => other !== index), t('Removed “{name}”.', { name: stamp.label }))}><Icon name="trash" size={16}/></button>
      </div>)}
      {adding && editor}
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {undo && <p className="quick-note-undo" role="status"><span>{undo.text}</span><button type="button" className="button ghost compact" disabled={busy} onClick={() => void save(undo.stamps)}><Icon name="undo" size={14}/>{t('Undo')}</button></p>}
    <footer className="quick-note-footer">
      <button type="button" className="button secondary compact" disabled={busy || Boolean(draft) || list.length >= QUICK_NOTE_LIMIT} onClick={() => edit()}><Icon name="plus" size={15}/>{t('Add quick note')}</button>
      <span className="settings-intro">{list.length >= QUICK_NOTE_LIMIT ? t('The wheel holds up to {count} notes.', { count: QUICK_NOTE_LIMIT }) : t('{count} of {limit}', { count: list.length, limit: QUICK_NOTE_LIMIT })}</span>
      <button type="button" className="button secondary compact" disabled={busy || Boolean(draft) || samePresets(list)} onClick={() => void save(presetStamps(), t('Restored the preset notes.'))}>{t('Restore presets')}</button>
    </footer>
  </div>;
}
