import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NoteResult } from '../shared.ts';
import { useNoteResults } from './note-results.tsx';
import { Icon } from './icons.tsx';
import { t } from './i18n.ts';

type Place = { element: HTMLElement; slot: HTMLElement; optionsSlot: HTMLElement; notes: NoteResult[]; stop: number; round: number };
export function ReviewNoteConnections({ doc, round }: { doc: Document | null; round: number }) {
  const links = useNoteResults(), latest = useRef(links); latest.current = links;
  const [places, setPlaces] = useState<Place[]>([]);
  const jumped = useRef<{ doc: Document; sequence: number } | null>(null);
  useEffect(() => {
    if (!doc || !links) return;
    const slots = new Map<HTMLElement, { slot: HTMLElement; optionsSlot: HTMLElement }>();
    const scan = () => {
      const shown = Number(doc.documentElement.dataset.papilotRound) || round;
      const next: Place[] = [];
      for (const element of doc.querySelectorAll<HTMLElement>('.change[data-stop]')) {
        const stop = Number(element.dataset.stop), units = element.dataset.units?.split(' ');
        const notes = links.notes.filter(note => note.changes.some(change => change.round === shown && (units ? change.units.some(id => units.includes(id)) : change.stop === stop)));
        const header = element.querySelector<HTMLElement>('.change-head');
        if (!notes.length || !header) continue;
        let pair = slots.get(element);
        if (!pair) {
          const slot = doc.createElement('span'), optionsSlot = doc.createElement('span');
          slot.className = 'papilot-note-links'; optionsSlot.className = 'papilot-note-options';
          pair = { slot, optionsSlot }; slots.set(element, pair);
        }
        if (pair.slot.parentElement !== header) header.append(pair.slot);
        if (pair.optionsSlot.parentElement !== header) {
          const number = header.querySelector('.change-number');
          if (number) number.after(pair.optionsSlot); else header.prepend(pair.optionsSlot);
        }
        next.push({ element, ...pair, notes, stop, round: shown });
      }
      for (const [element, pair] of slots) if (!next.some(place => place.element === element)) { pair.slot.remove(); pair.optionsSlot.remove(); slots.delete(element); }
      setPlaces(previous => previous.length === next.length && previous.every((place, i) => place.slot === next[i].slot && place.element === next[i].element && place.round === next[i].round && place.notes.length === next[i].notes.length && place.notes.every((note, n) => note === next[i].notes[n])) ? previous : next);
    };
    scan();
    const observer = new MutationObserver(scan); observer.observe(doc.body, { childList: true, subtree: true });
    doc.defaultView?.addEventListener('papilot:round', scan);
    return () => { observer.disconnect(); doc.defaultView?.removeEventListener('papilot:round', scan); slots.forEach((pair, element) => { pair.slot.remove(); pair.optionsSlot.remove(); element.classList.remove('papilot-linked-change'); }); };
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
    .papilot-note-options{display:inline-flex;flex:none;order:3;margin-left:4px}
    .papilot-note-options:empty{display:none}
    .papilot-note-options button{display:inline-flex;align-items:center;gap:3px;padding:4px;border:0;border-radius:5px;background:transparent;color:var(--accent);font:11px/1.5 var(--sans);white-space:nowrap;cursor:pointer}
    .papilot-note-options button:hover,.papilot-note-options button[aria-expanded=true]{background:var(--accent-soft)}
    .papilot-note-options button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
    .papilot-linked-change{outline:2px solid var(--primary);outline-offset:-2px}
    @media(max-width:680px){.papilot-note-links button{min-height:32px}}
  `}</style>, doc.head)}{places.map(place => createPortal(<>{place.notes.map(note => <button key={note.key} type="button" title={note.note.comment} aria-pressed={links.focus?.key === note.key} aria-label={t('Show note {n}: {comment}', { n: note.index + 1, comment: note.note.comment })} onClick={event => { event.stopPropagation(); latest.current?.focusNote(note.key); }}><Icon name="notes" size={12}/>{note.index + 1}</button>)}</>, place.slot, `${place.round}:${place.stop}`))}{places.map(place => {
    const available = place.notes.filter(note => links.alternativeCounts[note.key] > 0);
    const note = available.find(note => note.key === links.focus?.key) || available[0];
    return createPortal(note ? <button type="button" aria-expanded={links.focus?.key === note.key} onClick={event => { event.stopPropagation(); latest.current?.focusNote(note.key); }}>{t('Other options · {n}', { n: links.alternativeCounts[note.key] })}<Icon name="chevronDown" size={12}/></button> : null, place.optionsSlot, `options:${place.round}:${place.stop}`);
  })}</>;
}
