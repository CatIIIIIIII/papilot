import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons.tsx';
import { t } from './i18n.ts';
import { slotKey, type Stamp } from './stamps.ts';
import './pdf-tools.css';

// The ring in pixels: its edge, the hole that writes an ordinary note, and
// where each slot's icon sits. Segments hold only icons, since a wedge is a
// poor shape for words; the name of the slot under the pointer shows large in
// the middle. It is drawn like the app's menus: segments keep an even gap and
// rounded corners, and the one under the pointer takes the selection color
// and lifts outward a little.
const OUTER = 96, INNER = 46, CONTENT = 71, GAP = 4, ROUND = 3, LIFT = 3, SIZE = OUTER * 2;
const at = (radius: number, degrees: number) => [Math.sin(degrees * Math.PI / 180) * radius, -Math.cos(degrees * Math.PI / 180) * radius];
// One segment around an angle measured clockwise from the top. Its outline is
// stroked in its own color with round joins, which rounds the corners; the
// path is inset by that stroke so the drawn segment keeps its size and gap.
// A single note fills the whole ring but for one gap.
function segment(middle: number, step: number) {
  const outer = OUTER - ROUND, inner = INNER + ROUND;
  const pad = (radius: number) => Math.asin((GAP / 2 + ROUND) / radius) * 180 / Math.PI;
  const large = (radius: number) => step - 2 * pad(radius) > 180 ? 1 : 0;
  const [ax, ay] = at(outer, middle - step / 2 + pad(outer)), [bx, by] = at(outer, middle + step / 2 - pad(outer));
  const [cx, cy] = at(inner, middle + step / 2 - pad(inner)), [dx, dy] = at(inner, middle - step / 2 + pad(inner));
  return `M${ax} ${ay}A${outer} ${outer} 0 ${large(outer)} 1 ${bx} ${by}L${cx} ${cy}A${inner} ${inner} 0 ${large(inner)} 0 ${dx} ${dy}Z`;
}

// Each slot's direction, for lifting it.
const lift = (index: number, step: number) => { const [lx, ly] = at(LIFT, index * step); return { '--lift-x': `${lx}px`, '--lift-y': `${ly}px` } as CSSProperties; };

// The magic pen's wheel, like a game's: it opens where the mark ended, the
// pointer's direction lifts a segment, and a click takes it. Number keys pick
// a slot outright; the middle writes an ordinary note instead; Escape or a
// click well outside closes it.
export function StampWheel({ x, y, stamps, onPick, onFree, onClose }: { x: number; y: number; stamps: Stamp[]; onPick: (stamp: Stamp) => void; onFree: () => void; onClose: () => void }) {
  const overlay = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const cx = Math.max(OUTER + 16, Math.min(x, window.innerWidth - OUTER - 16)), cy = Math.max(OUTER + 16, Math.min(y, window.innerHeight - OUTER - 64));
  const step = 360 / stamps.length;
  useLayoutEffect(() => { overlay.current?.focus({ preventScroll: true }); }, []);
  function slotAt(px: number, py: number): number | 'center' | null {
    const dx = px - cx, dy = py - cy, distance = Math.hypot(dx, dy);
    if (distance < INNER) return 'center';
    if (distance > OUTER + 64) return null;
    return Math.floor(((Math.atan2(dx, -dy) * 180 / Math.PI + 360 + step / 2) % 360) / step) % stamps.length;
  }
  const slot = (index: number) => lift(index, step);
  const shown = hover === null ? null : stamps[hover];
  return createPortal(<div ref={overlay} className="stamp-wheel-overlay" tabIndex={-1} role="menu" aria-label={t('Quick notes')}
    onPointerDown={event => event.preventDefault()}
    onPointerMove={event => { const slot = slotAt(event.clientX, event.clientY); setHover(typeof slot === 'number' ? slot : null); }}
    onClick={event => {
      if (event.target instanceof Element && event.target.closest('button')) return;
      const slot = slotAt(event.clientX, event.clientY);
      if (slot === 'center') onFree(); else if (slot === null) onClose(); else onPick(stamps[slot]);
    }}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      else if (/^[0-9]$/.test(event.key)) { const stamp = stamps[(Number(event.key) + 9) % 10]; if (stamp) { event.preventDefault(); onPick(stamp); } }
      else if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        // Focus follows, so Enter takes the slot that is lit.
        const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
        const next = hover === null ? forward ? 0 : stamps.length - 1 : (hover + (forward ? 1 : -1) + stamps.length) % stamps.length;
        overlay.current?.querySelectorAll<HTMLButtonElement>('.stamp-slot')[next]?.focus(); setHover(next);
      } else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); if (hover === null) onFree(); else onPick(stamps[hover]); }
    }}>
    <div className="stamp-wheel" style={{ left: cx, top: cy, width: SIZE, height: SIZE }}>
      <svg className="stamp-ring" viewBox={`${-OUTER} ${-OUTER} ${SIZE} ${SIZE}`} aria-hidden="true">
        <g className="stamp-segments">{stamps.map((stamp, index) => hover !== index && <path key={stamp.id} style={slot(index)} strokeWidth={ROUND * 2} d={segment(index * step, step)}/>)}</g>
        {hover !== null && <path key={hover} className="stamp-segment-lit" style={slot(hover)} strokeWidth={ROUND * 2} d={segment(hover * step, step)}/>}
      </svg>
      {stamps.map((stamp, index) => {
        const [nx, ny] = at(CONTENT, index * step);
        return <button key={stamp.id} type="button" role="menuitem" className="stamp-slot" data-hover={hover === index || undefined} aria-label={stamp.label} aria-keyshortcuts={slotKey(index)}
          style={{ left: `calc(50% + ${nx}px)`, top: `calc(50% + ${ny}px)`, ...slot(index) }} onFocus={() => setHover(index)} onPointerEnter={() => setHover(index)} onClick={() => onPick(stamp)}>
          <Icon name={stamp.icon} size={22}/>
        </button>;
      })}
      <button type="button" role="menuitem" className="stamp-center" data-key={hover === null ? undefined : slotKey(hover)} aria-label={t('Write a note instead')} title={t('Write a note instead')} onClick={onFree}>
        {shown && hover !== null ? <span key={hover} className="stamp-center-name" aria-hidden="true">{shown.label}<kbd>{slotKey(hover)}</kbd></span> : <Icon name="toolNote" size={20}/>}
      </button>
    </div>
    {shown && <p key={hover} className="stamp-caption" style={{ left: cx, top: cy + OUTER + 12 }} aria-live="polite">{shown.instruction}</p>}
  </div>, document.body);
}

// The same ring, still, for settings: it shows where each note sits and the
// key that picks it, with the one being looked at lit.
export function StampRingPreview({ stamps, highlight }: { stamps: Stamp[]; highlight: number | null }) {
  const step = 360 / Math.max(1, stamps.length), shown = highlight === null ? undefined : stamps[highlight];
  return <div className="stamp-wheel stamp-preview" style={{ width: SIZE, height: SIZE }} aria-hidden="true">
    <svg className="stamp-ring" viewBox={`${-OUTER} ${-OUTER} ${SIZE} ${SIZE}`}>
      <g className="stamp-segments">{stamps.map((stamp, index) => highlight !== index && <path key={stamp.id} strokeWidth={ROUND * 2} d={segment(index * step, step)}/>)}</g>
      {shown && <path key={highlight} className="stamp-segment-lit" style={lift(highlight!, step)} strokeWidth={ROUND * 2} d={segment(highlight! * step, step)}/>}
    </svg>
    {stamps.map((stamp, index) => {
      const [nx, ny] = at(CONTENT, index * step);
      return <span key={stamp.id} className="stamp-slot" data-hover={highlight === index || undefined} style={{ left: `calc(50% + ${nx}px)`, top: `calc(50% + ${ny}px)`, ...lift(index, step) }}><Icon name={stamp.icon} size={22}/></span>;
    })}
    <span className="stamp-center">{shown ? <span key={highlight} className="stamp-center-name">{shown.label}<kbd>{slotKey(highlight!)}</kbd></span> : <Icon name="toolNote" size={20}/>}</span>
  </div>;
}
