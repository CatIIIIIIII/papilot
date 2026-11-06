import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons.tsx';
import { t, tn } from './i18n.ts';
import { groupName, groupStyle } from './note-groups.tsx';
import { reviewDraft, useReviewDraft, type ReviewNote } from './review-draft.ts';
import { useNoteResults } from './note-results.tsx';
import type { Task } from '../shared.ts';
import './review-draft.css';

function version(note: ReviewNote) {
  return note.whole ? 'whole' : / · Before(?: ·|$)/.test(note.where) ? 'before' : / · After(?: ·|$)/.test(note.where) ? 'after' : 'unchanged';
}
function place(note: ReviewNote) {
  const side = version(note);
  const label = side === 'whole' ? t('Whole change') : side === 'before' ? t('Before revision') : side === 'after' ? t('After revision') : t('Unchanged text');
  const page = note.where.match(/PDF page ([^·]+)/)?.[1].trim();
  return <><span className="review-draft-side">{label}</span>{page && <span className="review-draft-page">· {t('Page {page}', { page })}</span>}</>;
}
export function ReviewDraftCards({ task, feedbackCount, onReveal }: { task: Task; feedbackCount: number; onReveal: () => void }) {
  const draft = reviewDraft(task.id), state = useReviewDraft(task.id), box = useRef<HTMLDivElement>(null);
  const links = useNoteResults();
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    if (!state.editing) return;
    setExpanded(true);
    const id = requestAnimationFrame(() => {
      const field = Array.from(box.current?.querySelectorAll<HTMLTextAreaElement>('textarea[data-note-id]') || []).find(input => input.dataset.noteId === state.editing!.id);
      field?.focus({ preventScroll: true }); field?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(id);
  }, [state.editing]);
  if (!state.notes.length && !feedbackCount) return null;
  const count = state.notes.length;
  return <div className="review-draft" ref={box} aria-label={t('Review feedback')}>
    <button type="button" className="review-draft-heading" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><Icon name="chat" size={15}/><strong>{t('Review feedback')}</strong><span>{count ? tn(count, '{n} comment', '{n} comments') : tn(feedbackCount, '{n} review update', '{n} review updates')}</span><Icon name={expanded ? 'chevronUp' : 'chevronDown'} size={14}/></button>
    {expanded && <div className="review-draft-list">
      {feedbackCount > 0 && <p className="review-draft-decisions">{tn(feedbackCount, '{n} review update included', '{n} review updates included')}</p>}
      {state.notes.map((note, index) => <div key={note.id} className="review-draft-note" style={groupStyle(note.group)} data-note={note.id} data-version={version(note)}>
        <div className="review-draft-location"><button type="button" onClick={() => { links?.clearFocus(); draft.reveal(note); onReveal(); }} title={t('Show quoted passage')}><span className="review-draft-number">{index + 1}</span>{place(note)}{note.group && <i className="group-dot"/>}<Icon name="arrowRight" size={12}/></button><button type="button" aria-label={t('Delete review note {n}', { n: index + 1 })} disabled={state.busy} onClick={() => draft.remove(note.id)}><Icon name="close" size={13}/></button></div>
        {note.stamp && <span className="pdf-note-stamp">{note.stamp}</span>}
        {note.quote && <blockquote data-kind={note.kind}>{note.quote}</blockquote>}
        {note.round !== task.review?.round && <small>{t('From review round {n}', { n: note.round })}</small>}
        <textarea data-note-id={note.id} aria-label={t('Comment {n}', { n: index + 1 })} placeholder={note.kind === 'delete' ? t('Replace with… (leave empty to delete)') : note.group ? t('Comment for {group} (optional)', { group: groupName(note.group) }) : t('What should change here?')} rows={2} value={note.comment} readOnly={state.busy} onChange={event => draft.edit(note.id, event.target.value)} onKeyDown={event => { event.stopPropagation(); }}/>
      </div>)}
      {state.notes.some(note => note.group) && <textarea className="review-group-instructions" aria-label={t('Instructions for color groups')} placeholder={t('What should change in each color group?')} rows={2} value={state.instructions} readOnly={state.busy} onChange={event => draft.instructions(event.target.value)}/>}
    </div>}
  </div>;
}
