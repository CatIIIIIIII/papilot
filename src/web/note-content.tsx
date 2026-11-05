import type { ReactNode } from 'react';
import { t } from './i18n.ts';
import type { MarkKind } from '../shared.ts';

// A delete mark's text says what happens to the marked passage.
export const markText = (note: { kind?: MarkKind; comment: string }) => note.kind === 'delete' ? note.comment.trim() ? t('Replace with: {text}', { text: note.comment.trim() }) : t('Delete this text') : note.comment;
export function NoteQuote({ text, kind }: { text: string; kind?: MarkKind }) {
  return <div className="note-quote">
    <blockquote className="note-quote-text" data-kind={kind} aria-label={t('Quoted text')}>{text || t('Marked region')}</blockquote>
  </div>;
}

export function NoteBody({ children }: { children: ReactNode }) {
  return <div className="note-body" role="group" aria-label={t('Your note')}>
    {children}
  </div>;
}
