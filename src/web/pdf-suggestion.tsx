import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { AGENT_NAMES, type Annotation } from '../shared.ts';
import { Icon } from './icons.tsx';
import { t } from './i18n.ts';
import './pdf-suggestion.css';
import { groupName } from './note-groups.tsx';
import { sendsMessage } from './composer.ts';
import { noteFromTask, noteToTask } from './note-flight.ts';

export interface PdfNoteActions {
  has: (id: string) => boolean;
  toggle: (note: Annotation) => void;
  remove: (note: Annotation) => Promise<void>;
  restore: (note: Annotation) => Promise<void>;
  edit: (note: Annotation, comment: string) => Promise<void>;
  onEditing: (editing: boolean) => void;
  onBusy: (busy: boolean) => void;
  disabled: boolean;
  copy?: (note: Annotation) => Promise<void>;
}

function usePdfNotePosition(card: RefObject<HTMLElement | null>, rect: Annotation['rect'], preferredWidth = 280, enabled = true) {
  useLayoutEffect(() => {
    if (!enabled) return;
    const element = card.current!, layer = element.closest<HTMLElement>('.note-layer')!, viewport = element.closest<HTMLElement>('.pdf-container')!;
    let frame = 0;
    const place = () => {
      const page = layer.getBoundingClientRect(), view = viewport.getBoundingClientRect();
      const left = Math.max(page.left, view.left) + 8, right = Math.min(page.right, view.right) - 8;
      const top = Math.max(page.top, view.top) + 8, bottom = Math.min(page.bottom, view.bottom) - 8;
      const anchor = { left: page.left + rect[0] * page.width, right: page.left + rect[2] * page.width, top: page.top + rect[1] * page.height, bottom: page.top + rect[3] * page.height };
      const visible = right > left && bottom > top && anchor.bottom >= top && anchor.top <= bottom && anchor.right >= left && anchor.left <= right;
      element.style.visibility = visible ? 'visible' : 'hidden';
      if (!visible) return;
      const width = Math.min(preferredWidth, right - left);
      element.style.width = `${width}px`;
      element.style.maxHeight = `${bottom - top}px`;
      const height = element.getBoundingClientRect().height;
      // Use space beside the passage when possible; otherwise sit just below
      // it, or above when the passage is near the foot of the visible page.
      const beside = right - anchor.right >= width + 12;
      const x = beside ? anchor.right + 12 : Math.max(left, Math.min(anchor.left, right - width));
      const below = bottom - anchor.bottom, above = anchor.top - top;
      const y = beside ? anchor.top : below >= height + 10 || below >= above ? anchor.bottom + 10 : anchor.top - height - 10;
      element.style.left = `${x - page.left}px`;
      element.style.top = `${Math.max(top, Math.min(y, bottom - height)) - page.top}px`;
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
    const observer = new ResizeObserver(schedule);
    observer.observe(layer); observer.observe(viewport); observer.observe(element);
    viewport.addEventListener('scroll', schedule); window.addEventListener('resize', schedule);
    place();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); viewport.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); };
  }, [card, enabled, preferredWidth, rect[0], rect[1], rect[2], rect[3]]);
}

export function NoteAttachButton({ number, ai = false, selected, disabled, destination, onClick }: {
  number: number; ai?: boolean; selected: boolean; disabled?: boolean; destination?: 'manuscript'; onClick: () => void;
}) {
  if (!destination) return <NoteSendButton quiet number={number} ai={ai} selected={selected} disabled={Boolean(disabled)} busy={false} onClick={onClick}/>;
  const label = selected ? t('Kept on manuscript') : t('Keep on manuscript');
  return <button type="button" className="icon-button pdf-note-attach" aria-label={label} title={label} disabled={disabled || selected} onClick={onClick}><Icon name={selected ? 'bookmarkFilled' : 'bookmark'} size={16}/></button>;
}

// The popover's main action sends the note to the task, like the chat
// composer's own send button; a note already there says so and offers × to take it back out.
// Lists use the quiet form: the arrow without its blue disc until hovered.
function NoteSendButton({ number, ai, selected, disabled, busy, quiet = false, onClick }: {
  number: number; ai: boolean; selected: boolean; disabled: boolean; busy: boolean; quiet?: boolean; onClick: () => void;
}) {
  return <button type="button" className={'note-send' + (quiet ? ' quiet' : '')} aria-label={ai ? t('Include suggestion {n} in this task', { n: number }) : t('Include note {n} in this task', { n: number })} aria-pressed={selected} title={selected ? ai ? t('Remove suggestion {n} from task', { n: number }) : t('Remove note {n} from task', { n: number }) : t('Quote in chat')} disabled={disabled} onClick={onClick}>
    {busy ? <span className="spinner light"/> : selected ? <>{t('Included')}<Icon name="close" size={12}/></> : <Icon name="arrowRight" size={15}/>}
  </button>;
}

// The PDF popover and reading list share the editor and actions. Floating cards
// also follow their text anchor and close when the reader clicks elsewhere.
export function PdfNoteCard({ note, number, index, total, selected, busy, error, draft, onDraftChange, onToggle, onDismiss, onClose, onPrevious, onNext, onSave, onEditing, destination, inline = false, header, children }: {
  destination?: 'manuscript'; inline?: boolean; header?: ReactNode; children?: ReactNode;
  note: Pick<Annotation, 'rect' | 'comment' | 'group' | 'aiReview'> & { id?: string }; number: number; index: number; total: number; selected: boolean; busy: boolean; error: string;
  draft: string | null; onDraftChange: (draft: string | null) => void;
  onToggle?: () => void; onDismiss: () => void; onClose?: (restoreFocus?: boolean) => void; onPrevious?: () => void; onNext?: () => void;
  onSave: (comment: string, action: 'keep' | 'close' | 'quote') => Promise<boolean>; onEditing?: (editing: boolean) => void;
}) {
  const card = useRef<HTMLElement>(null), saving = useRef(false);
  const text = useRef<HTMLParagraphElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const editing = draft !== null, ai = Boolean(note.aiReview);
  // A new note is one line with its send button beside it. Escape or a click
  // elsewhere closes it (keeping any text), so it shows a discard button only
  // once there is text to discard.
  const compose = !inline && !note.id, send = !inline && !destination;
  useEffect(() => { onEditing?.(editing); return () => onEditing?.(false); }, [editing, onEditing]);
  function finish() { onDraftChange(null); requestAnimationFrame(() => text.current?.focus({ preventScroll: true })); }
  function edit() { if (!busy) onDraftChange(note.comment); }
  function close(restoreFocus = true) {
    if (inline) { onDraftChange(null); if (restoreFocus) requestAnimationFrame(() => text.current?.focus({ preventScroll: true })); }
    else onClose?.(restoreFocus);
  }
  async function save(action: 'keep' | 'close' | 'quote' = 'keep', restoreFocus = true) {
    if (busy || saving.current) return;
    const comment = draft?.trim();
    if (editing && !comment) { if (action === 'close') close(restoreFocus); return; }
    // Adding a note to the task closes its popover, so the card itself seems
    // to fly there; taking one out keeps it open for the copy to land on.
    const adding = action === 'quote' && !destination && !selected;
    const flight = action === 'quote' && !destination && card.current ? adding ? noteToTask(card.current) : note.id ? noteFromTask(note.id, card.current) : null : null;
    if (editing && comment !== note.comment) {
      saving.current = true;
      try { if (!await onSave(comment!, action)) return; }
      finally { saving.current = false; }
    } else if (action === 'quote') onToggle?.();
    flight?.();
    if (action === 'close' || (adding && !inline)) { onDraftChange(null); close(restoreFocus); }
    else if (editing) finish();
  }
  useEffect(() => {
    if (inline && !editing) return;
    const element = card.current!;
    const outside = (event: PointerEvent) => {
      if (event.button === 0 && !event.composedPath().includes(element)) void save('close', false);
    };
    const escape = (event: KeyboardEvent) => {
      if (inline && !element.contains(document.activeElement)) return;
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      const dialog = event.target instanceof Element ? event.target.closest('dialog,[role="dialog"],[role="menu"],[role="listbox"]') : null;
      if (dialog && dialog !== element) return;
      event.preventDefault(); event.stopPropagation();
      void save('close', element.contains(document.activeElement));
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); };
  }, [inline, editing, draft, busy, note.comment, onClose, onSave, onToggle, onDraftChange]);
  useLayoutEffect(() => {
    const element = input.current;
    if (element) { element.focus({ preventScroll: true }); element.setSelectionRange(element.value.length, element.value.length); }
  }, [editing]);
  useLayoutEffect(() => {
    const element = input.current;
    if (element) { element.style.height = '0'; element.style.height = `${element.scrollHeight}px`; }
  }, [draft]);
  usePdfNotePosition(card, note.rect, note.aiReview ? 330 : 280, !inline);
  // Enter in the popover sends, like the arrow; a note already in the chat
  // just saves, and the library keeps Enter for saving edits in place.
  const enterAction = !inline && !destination && !selected ? 'quote' : 'keep';
  useLayoutEffect(() => { if (!inline && (!input.current || input.current.disabled)) card.current?.focus({ preventScroll: true }); }, [inline, note.id]);

  const deleteButton = <button type="button" className="icon-button pdf-note-delete" aria-label={ai ? t('Ignore suggestion {n}', { n: number }) : t('Delete note {n}', { n: number })} title={ai ? t('Ignore') : t('Delete note')} disabled={busy} onClick={onDismiss}><Icon name="trash" size={14}/></button>;
  const sendButton = send && <NoteSendButton number={number} ai={ai} selected={selected} busy={busy} disabled={busy || (editing && !draft.trim())} onClick={() => void save('quote')}/>;

  return <section ref={card} className={'pdf-note-card ' + (ai ? 'pdf-suggestion' : 'pdf-personal-note') + (inline ? ' pdf-note-inline' : '') + (compose ? ' pdf-note-compose' : '')} role={inline ? 'group' : 'dialog'} aria-modal={inline ? undefined : false} aria-label={ai ? t('AI suggestion {n}', { n: number }) : t('PDF note {n}', { n: number })} tabIndex={inline ? undefined : -1}>
    {header}
    <div className="pdf-note-content"><div className="pdf-suggestion-body">{editing ?
      <textarea ref={input} className="pdf-note-input" aria-label={t('Edit note {n}', { n: number })} placeholder={t('Write a note…')} value={draft} rows={1} maxLength={4000} readOnly={busy} onChange={event => onDraftChange(event.target.value)} onKeyDown={event => { if (sendsMessage(event.nativeEvent, window.matchMedia('(pointer: coarse)').matches)) { event.preventDefault(); void save(enterAction); } }}/>
      : ai ? <p>{note.comment}</p> : <p ref={text} className="pdf-note-text note-edit-trigger" role="button" tabIndex={busy ? -1 : 0} aria-disabled={busy} aria-label={t('Edit note {n}: {comment}', { n: number, comment: note.comment })} title={t('Edit note')} onClick={() => {
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed && text.current?.contains(selection.anchorNode)) return;
        edit();
      }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); edit(); } }}>{note.comment || (note.group ? t('Highlighted in {group}', { group: groupName(note.group) }) : '')}</p>}
    </div>{compose ? <div className="pdf-note-compose-tools">{draft?.trim() && deleteButton}{sendButton}</div> : !inline && (ai || !send) && <button type="button" className="icon-button pdf-note-close" aria-label={ai ? t('Close suggestion') : t('Close note')} title={ai ? t('Close suggestion') : t('Close note')} disabled={busy} onClick={() => void save('close')}>{busy ? <span className="spinner"/> : <Icon name="close" size={14}/>}</button>}</div>
    {children}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!compose && <div className="pdf-note-tools">
      {note.aiReview && !destination && <span className="pdf-note-origin" title={t('AI suggestion')}>{AGENT_NAMES[note.aiReview.agent]}</span>}
      <span className="pdf-note-tools-space"/>
      {ai && total > 1 && <div className="pdf-suggestion-navigation"><button type="button" className="icon-button" aria-label={t('Previous suggestion')} title={t('Previous suggestion (←)')} aria-keyshortcuts="ArrowLeft" disabled={busy || index <= 0} onClick={onPrevious}><Icon name="chevronLeft" size={14}/></button><span aria-label={t('{current} of {total}', { current: index + 1, total })}>{index + 1}/{total}</span><button type="button" className="icon-button" aria-label={t('Next suggestion')} title={t('Next suggestion (→)')} aria-keyshortcuts="ArrowRight" disabled={busy || index >= total - 1} onClick={onNext}><Icon name="chevronRight" size={14}/></button></div>}
      {deleteButton}
      {send ? sendButton : <NoteAttachButton number={number} ai={ai} selected={selected} disabled={busy || (editing && !draft.trim())} destination={destination} onClick={() => {
        // Keep keyboard navigation available while this button becomes disabled.
        if (destination && !inline) card.current?.focus({ preventScroll: true });
        void save('quote');
      }}/>}
    </div>}
  </section>;
}
