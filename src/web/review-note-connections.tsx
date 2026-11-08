import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NoteResult } from '../shared.ts';
import { useNoteResults } from './note-results.tsx';
import { Icon } from './icons.tsx';
import { t } from './i18n.ts';

type Place = { element: HTMLElement; slot: HTMLElement; notes: NoteResult[]; stop: number; round: number };
export function ReviewNoteConnections({ doc, round }: { doc: Document | null; round: number }) {
  const links = useNoteResults(), latest = useRef(links); latest.current = links;
  const [places, setPlaces] = useState<Place[]>([]);
  const jumped = useRef<{ doc: Document; sequence: number } | null>(null);
  useEffect(() => {
    if (!doc || !links) return;
    const slots = new Map<HTMLElement, HTMLElement>();
    const scan = () => {
      const shown = Number(doc.documentElement.dataset.papilotRound) || round;
      const next: Place[] = [];
      for (const element of doc.querySelectorAll<HTMLElement>('.change[data-stop]')) {
        const stop = Number(element.dataset.stop), units = element.dataset.units?.split(' ');
        const notes = links.notes.filter(note => note.changes.some(change => change.round === shown && (units ? change.units.some(id => units.includes(id)) : change.stop === stop)));
        const header = element.querySelector<HTMLElement>('.change-head');
        if (!notes.length || !header) continue;
        let slot = slots.get(element);
        if (!slot) { slot = doc.createElement('span'); slot.className = 'papilot-note-links'; header.append(slot); slots.set(element, slot); }
        else if (slot.parentElement !== header) header.append(slot);
        next.push({ element, slot, notes, stop, round: shown });
      }
      for (const [element, slot] of slots) if (!next.some(place => place.element === element)) { slot.remove(); slots.delete(element); }
      setPlaces(previous => previous.length === next.length && previous.every((place, i) => place.slot === next[i].slot && place.element === next[i].element && place.round === next[i].round && place.notes.length === next[i].notes.length && place.notes.every((note, n) => note === next[i].notes[n])) ? previous : next);
    };
    scan();
    const observer = new MutationObserver(scan); observer.observe(doc.body, { childList: true, subtree: true });
    doc.defaultView?.addEventListener('papilot:round', scan);
    return () => { observer.disconnect(); doc.defaultView?.removeEventListener('papilot:round', scan); slots.forEach((slot, element) => { slot.remove(); element.classList.remove('papilot-linked-change'); }); };
  }, [doc, links?.notes, round]);
  useEffect(() => {
    const focus = links?.focus;
    const selected = links?.notes.find(note => note.key === focus?.key);
    for (const place of places) place.element.classList.toggle('papilot-linked-change', Boolean(links?.scope === 'note' && selected && place.notes.some(note => note.key === selected.key)));
    if (!doc || !focus || (jumped.current?.doc === doc && jumped.current.sequence === focus.sequence)) return;
    const place = places.find(place => place.round === focus.change.round && place.notes.some(note => note.key === focus.key));
    if (!place) return;
    place.element.click(); place.element.scrollIntoView({ block: 'center' }); place.element.focus({ preventScroll: true });
    jumped.current = { doc, sequence: focus.sequence };
  }, [doc, places, links?.focus, links?.scope]);
  useEffect(() => {
    const target = doc?.defaultView;
    if (!target) return;
    const send = () => {
      const current = latest.current, selected = current?.notes.find(note => note.key === current.focus?.key);
      const shown = Number(doc.documentElement.dataset.papilotRound) || round;
      const units = [...new Set(selected?.changes.filter(change => change.round === shown).flatMap(change => change.units) || [])];
      target.dispatchEvent(new CustomEvent('papilot:option-preview', { detail: current?.preview ? { key: current.preview.key, round: current.preview.round } : null }));
      target.dispatchEvent(new CustomEvent('papilot:note-focus', { detail: current?.focus && units.length ? { round: shown, units: current.scope === 'all' ? null : units } : null }));
    };
    send(); target.addEventListener('papilot:round', send); target.addEventListener('papilot:note-focus-ready', send);
    return () => { target.removeEventListener('papilot:round', send); target.removeEventListener('papilot:note-focus-ready', send); };
  }, [doc, round, links?.focus, links?.notes, links?.preview, links?.scope]);
  if (!doc || !links) return null;
  return <>{createPortal(<style>{`
    .papilot-note-links{display:inline-flex;align-items:center;flex-wrap:wrap;gap:4px;order:5}
    .papilot-note-links button{display:inline-flex;align-items:center;gap:4px;padding:3px 7px;border:1px solid var(--line);border-radius:6px;background:var(--bg-muted);color:var(--text-2);font:12px/1.5 var(--sans);cursor:pointer}
    .papilot-note-links button:hover,.papilot-note-links button:focus-visible{color:var(--primary);border-color:var(--primary)}
    .papilot-linked-change{outline:2px solid var(--primary);outline-offset:-2px}
    @media(max-width:680px){.papilot-note-links button{min-height:32px}}
  `}</style>, doc.head)}{places.map(place => createPortal(<>{place.notes.map(note => <button key={note.key} type="button" title={note.note.comment} aria-pressed={links.focus?.key === note.key} aria-label={t('Show note {n}: {comment}', { n: note.index + 1, comment: note.note.comment })} onClick={event => { event.stopPropagation(); latest.current?.focusNote(note.key); }}><Icon name="notes" size={12}/>{note.index + 1}</button>)}</>, place.slot, `${place.round}:${place.stop}`))}</>;
}
