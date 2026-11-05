import { useEffect, useRef } from 'react';

// Notes in the review live in an iframe. Listen in both documents, ahead of
// review shortcuts, but leave native text editing and unrelated undo alone.
export function useNoteUndo(undo: () => boolean, frame?: Document | null, redo?: () => boolean) {
  const current = useRef({ undo, redo }); current.current = { undo, redo };
  useEffect(() => {
    const documents = [...new Set([document, ...(frame ? [frame] : [])])];
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat || event.altKey || !(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      const action = key === 'z' ? event.shiftKey ? current.current.redo : current.current.undo
        : key === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey ? current.current.redo : undefined;
      if (!action) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || target?.closest?.('input, textarea, select, [role="textbox"], [role="combobox"]')) return;
      if (documents.some(doc => doc.querySelector('dialog[open], [aria-modal="true"]'))) return;
      if (!action()) return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    documents.forEach(doc => doc.addEventListener('keydown', key, true));
    return () => documents.forEach(doc => doc.removeEventListener('keydown', key, true));
  }, [frame]);
}
