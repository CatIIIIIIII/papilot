import { useEffect, useRef, useState } from 'react';
import { TOOL_KEYS, type PdfTool } from './pdf-tool-rail.tsx';
import { useShortcuts } from './shortcuts.ts';
import { shortcutAction } from '../../engine/src/web/shortcuts.ts';
import type { Stamp } from './stamps.ts';

// Capture tool gestures before the embedded viewer's decision shortcuts. Custom
// review bindings keep priority; typing, menus and dialogs keep their own keys.
export function useReviewToolKeys(options: {
  doc: Document | null; tool: PdfTool; busy: boolean; choose: (tool: PdfTool) => void;
  lock: (slot: number | null) => void; stamps: Stamp[]; wheel: boolean;
}) {
  const shortcuts = useShortcuts();
  const [hand, setHand] = useState(false);
  const current = useRef({ ...options, shortcuts }); current.current = { ...options, shortcuts };
  useEffect(() => {
    const doc = options.doc; if (!doc) return;
    let space = false;
    const documents = [document, doc];
    const keydown = (event: KeyboardEvent) => {
      const state = current.current, target = event.target as Element | null;
      if (event.defaultPrevented || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || state.wheel) return;
      if (target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="menu"],[role="dialog"]')) return;
      if (documents.some(document => document.querySelector('dialog[open],[aria-modal="true"],[popover]:popover-open:not(.rail-tip)'))) return;
      if (event.currentTarget === document && !target?.closest('.review-viewport')) return;
      if (shortcutAction(event, state.shortcuts)) return;
      if (event.code === 'Space') {
        if (target?.closest('button,a,[role="button"]')) return;
        event.preventDefault(); event.stopPropagation(); space = true; setHand(true); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); state.lock(null); state.choose('select'); }
      else if (!state.busy && state.tool === 'magic' && /^[0-9]$/.test(event.key)) {
        const index = Number(event.key) - 1;
        if (event.key === '0' || state.stamps[index]) { event.preventDefault(); event.stopPropagation(); state.lock(event.key === '0' ? null : index); }
      } else {
        const tool = TOOL_KEYS[event.key.toLowerCase()];
        if (tool && (!state.busy || tool === 'select' || tool === 'hand')) { event.preventDefault(); event.stopPropagation(); state.choose(tool); }
      }
    };
    const release = () => { space = false; setHand(false); };
    const keyup = (event: KeyboardEvent) => { if (event.code === 'Space') release(); };
    let pan: { pointer: number; element: HTMLElement; x: number; y: number; left: number; top: number } | null = null;
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || (!space && current.current.tool !== 'hand')) return;
      const target = event.target as Element;
      if (target.closest('button,a,input,textarea,select,[role="dialog"]')) return;
      const paper = target.closest<HTMLElement>('#paper'); if (!paper) return;
      event.preventDefault(); event.stopPropagation(); paper.setPointerCapture(event.pointerId);
      pan = { pointer: event.pointerId, element: paper, x: event.clientX, y: event.clientY, left: paper.scrollLeft, top: paper.scrollTop };
    };
    const move = (event: PointerEvent) => {
      if (!pan || pan.pointer !== event.pointerId) return;
      event.preventDefault(); pan.element.scrollTo({ left: pan.left + pan.x - event.clientX, top: pan.top + pan.y - event.clientY, behavior: 'instant' });
    };
    const up = () => { if (pan?.element.hasPointerCapture(pan.pointer)) pan.element.releasePointerCapture(pan.pointer); pan = null; };
    documents.forEach(document => { document.addEventListener('keydown', keydown, true); document.addEventListener('keyup', keyup, true); });
    doc.addEventListener('pointerdown', down, true); doc.addEventListener('pointermove', move, true); doc.addEventListener('pointerup', up, true); doc.addEventListener('pointercancel', up, true);
    doc.defaultView?.addEventListener('blur', release); window.addEventListener('blur', release);
    return () => {
      up(); release();
      documents.forEach(document => { document.removeEventListener('keydown', keydown, true); document.removeEventListener('keyup', keyup, true); });
      doc.removeEventListener('pointerdown', down, true); doc.removeEventListener('pointermove', move, true); doc.removeEventListener('pointerup', up, true); doc.removeEventListener('pointercancel', up, true);
      doc.defaultView?.removeEventListener('blur', release); window.removeEventListener('blur', release);
    };
  }, [options.doc]);
  return hand;
}
