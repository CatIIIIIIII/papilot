import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NoteResult } from '../shared.ts';
import { useNoteResults } from './note-results.tsx';
import { Icon } from './icons.tsx';
import { t } from './i18n.ts';

type Place = { element: HTMLElement; slot: HTMLElement; optionsSlot: HTMLElement; notes: NoteResult[]; stop: number; round: number };
// Marks a change linked to the focused note, or the one it shows. The embedded
// renderer owns each change's className and rewrites it when it repaints, but
// leaves an attribute it does not render alone.
const LINK = 'data-papilot-link';
function markLink(element: HTMLElement, link: 'change' | 'target' | null) {
  if (element.getAttribute(LINK) === link) return;
  if (link) element.setAttribute(LINK, link); else element.removeAttribute(LINK);
}
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
    return () => { observer.disconnect(); doc.defaultView?.removeEventListener('papilot:round', scan); slots.forEach((pair, element) => { pair.slot.remove(); pair.optionsSlot.remove(); markLink(element, null); }); };
  }, [doc, links?.notes, round]);
  useEffect(() => {
    const focus = links?.focus;
    const selected = links?.notes.find(note => note.key === focus?.key);
    for (const place of places) {
      const linked = Boolean(links?.scope === 'note' && selected && place.notes.some(note => note.key === selected.key));
      markLink(place.element, !linked ? null : place.round === focus?.change.round && place.stop === focus.change.stop ? 'target' : 'change');
    }
    if (!doc || !focus || (jumped.current?.doc === doc && jumped.current.sequence === focus.sequence)) return;
    const place = places.find(place => place.round === focus.change.round && place.stop === focus.change.stop && place.notes.some(note => note.key === focus.key));
    if (!place) return;
    place.element.click();
    // Scroll only the PDF pane: scrollIntoView can also move the host page
    // horizontally or leave the target behind the bottom drawer.
    const paper = doc.getElementById('paper');
    if (paper) {
      const padding = parseFloat(doc.defaultView?.getComputedStyle(paper).scrollPaddingTop || '') || 0;
      paper.scrollBy({ top: place.element.getBoundingClientRect().top - paper.getBoundingClientRect().top - padding - 12, behavior: 'instant' });
    }
    place.element.focus({ preventScroll: true });
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
  const focusAt = (place: Place, note: NoteResult) => {
    const change = note.changes.find(change => change.round === place.round && change.stop === place.stop);
    if (change) latest.current?.showChange(note.key, change);
    else latest.current?.focusNote(note.key);
  };
  return <>{createPortal(<style>{`
    .papilot-note-links{display:inline-flex;align-items:center;flex-wrap:nowrap;gap:1px;order:5;flex-shrink:0;padding:2px;border-radius:5px;background:var(--bg-muted)}
    .papilot-note-links>svg{flex:none;margin:0 3px;color:var(--text-2)}
    .papilot-note-links>span{display:flex;min-width:0;max-width:112px;overflow-x:auto;scrollbar-width:thin}
    .papilot-note-links button{display:inline-flex;align-items:center;justify-content:center;flex:none;min-width:22px;padding:2px 5px;border:0;border-radius:3px;background:transparent;color:var(--text-2);font:11px/1.5 var(--sans);cursor:pointer}
    .papilot-note-links button:hover,.papilot-note-links button[aria-pressed=true]{color:var(--primary);background:var(--accent-soft)}
    .papilot-note-links button:focus-visible{outline:2px solid var(--primary);outline-offset:-2px}
    .papilot-note-options{display:inline-flex;flex:none;order:3;margin-left:4px}
    .papilot-note-options:empty{display:none}
    .papilot-note-options button{display:inline-flex;align-items:center;gap:4px;min-height:26px;padding:3px 5px;border:0;border-radius:5px;background:transparent;color:var(--accent);font:11px/1.5 var(--sans);white-space:nowrap;cursor:pointer}
    .papilot-note-options button:hover,.papilot-note-options button[aria-expanded=true]{background:var(--accent-soft)}
    .papilot-note-options button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
    .papilot-note-options button[aria-expanded=true]>svg:last-child{transform:rotate(180deg)}
    .papilot-note-options-count{display:none}
    [data-papilot-link]>.change-head{box-shadow:inset 3px 0 color-mix(in srgb,var(--primary) 35%,transparent)}
    [data-papilot-link=target]{outline:2px solid var(--primary);outline-offset:-2px}
    [data-papilot-link=target]>.change-head{background:color-mix(in srgb,var(--primary) 12%,var(--bg));box-shadow:inset 3px 0 var(--primary)}
    [data-papilot-link=target]>.change-head .change-number{color:var(--primary);font-weight:600}
    @media(max-width:640px){.papilot-note-options-label{display:none}.papilot-note-options-count{display:inline}.papilot-note-options button{gap:2px}}
    @media(pointer:coarse){.papilot-note-links button{min-height:32px;min-width:28px}.papilot-note-options button{min-height:32px;min-width:32px;justify-content:center}}
  `}</style>, doc.head)}{places.map(place => createPortal(<><Icon name="notes" size={12}/><span>{place.notes.map(note => <button key={note.key} type="button" title={note.note.comment} aria-pressed={links.focus?.key === note.key} aria-label={t('Show note {n}: {comment}', { n: note.index + 1, comment: note.note.comment })} onClick={event => { event.stopPropagation(); focusAt(place, note); }}>{note.index + 1}</button>)}</span></>, place.slot, `${place.round}:${place.stop}`))}{places.map(place => {
    const available = place.notes.filter(note => links.alternativeCounts[note.key] > 0);
    const note = available.find(note => note.key === links.focus?.key) || available[0];
    const label = note && t('Other options · {n}', { n: links.alternativeCounts[note.key] });
    return createPortal(note ? <button type="button" aria-label={label} title={label} aria-expanded={links.focus?.key === note.key} onClick={event => { event.stopPropagation(); focusAt(place, note); }}><Icon name="layers" size={13}/><span className="papilot-note-options-label">{label}</span><span className="papilot-note-options-count" aria-hidden="true">{links.alternativeCounts[note.key]}</span><Icon name="chevronDown" size={12}/></button> : null, place.optionsSlot, `options:${place.round}:${place.stop}`);
  })}</>;
}
