import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { NoteChange, NoteResult, Task, TimelineItem } from '../shared.ts';
import { readNotesInstructions } from '../notes.ts';
import { Icon } from './icons.tsx';
import { t } from './i18n.ts';
import { reviewDraft } from './review-draft.ts';

export interface NoteFocus { key: string; change: NoteChange; sequence: number }
interface Links {
  notes: NoteResult[]; error: boolean; loading: boolean; selected: string; reveal: number;
  focus: NoteFocus | null; reload: () => void;
  clearFocus: () => void;
  showChange: (key: string, change: NoteChange) => void; showNote: (key: string) => void;
}
const Context = createContext<Links | null>(null);
export const useNoteResults = () => useContext(Context);

export function NoteResultsProvider({ task, items, read, openReview, openChat, children }: {
  task?: Task; items: TimelineItem[]; read: (id: string) => Promise<{ notes: NoteResult[] }>;
  openReview: () => void; openChat: () => void; children: ReactNode;
}) {
  const [notes, setNotes] = useState<NoteResult[]>([]), [error, setError] = useState(false), [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(''), [focus, setFocus] = useState<NoteFocus | null>(null);
  const [reveal, setReveal] = useState(0);
  const sequence = useRef(0), actions = useRef({ read, openReview, openChat }); actions.current = { read, openReview, openChat };
  const signature = items.filter(item => item.type === 'user' && (item.meta?.notes?.length || readNotesInstructions(item.text))).map(item => item.id).join(',');
  const id = task?.id;
  const reload = useCallback(() => {
    if (!id || !signature) return;
    const request = ++sequence.current; setLoading(true); setError(false);
    void actions.current.read(id).then(result => { if (!Array.isArray(result.notes)) throw new Error('Invalid note results'); if (sequence.current === request) setNotes(result.notes); }).catch(() => { if (sequence.current === request) setError(true); }).finally(() => { if (sequence.current === request) setLoading(false); });
  }, [id, signature]);
  const decisions = JSON.stringify(task?.review?.counts);
  useEffect(() => { reload(); return () => { ++sequence.current; }; }, [reload, task?.review?.round, task?.status, task?.updatedAt, decisions]);
  useEffect(() => { setNotes([]); setFocus(null); setSelected(''); setError(false); }, [id]);
  const showNote = (key: string) => {
    setSelected(key); setReveal(value => value + 1); actions.current.openChat();
    requestAnimationFrame(() => {
      const element = [...document.querySelectorAll<HTMLElement>('[data-note-result]')].find(element => element.dataset.noteResult === key);
      element?.scrollIntoView({ block: 'center' }); element?.focus({ preventScroll: true });
    });
  };
  const value: Links = { notes, loading, error, selected, reveal, focus, reload, showNote, clearFocus: () => setFocus(null), showChange(key, change) {
    // A sent-note link replaces any earlier draft quotation destination.
    if (id) reviewDraft(id).clearReveal();
    setSelected(key); setFocus(previous => ({ key, change, sequence: (previous?.sequence || 0) + 1 })); actions.current.openReview();
  } };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

const decision = (state: NoteChange['state']) => ({ pending: t('Pending review'), accepted: t('Accepted'), rejected: t('Rejected'), commented: t('Revision requested'), mixed: t('Partly reviewed') })[state];
export function NoteResultLinks({ noteKey }: { noteKey: string }) {
  const links = useNoteResults();
  if (!links) return null;
  const result = links.notes.find(note => note.key === noteKey);
  if (links.error) return noteKey.endsWith(':0') ? <button type="button" className="note-result-retry" onClick={links.reload}><Icon name="refresh" size={12}/>{t('Retry linking changes')}</button> : null;
  if (!result) return links.loading ? <span className="note-result-status"><span className="spinner"/></span> : null;
  return <div className="note-result-links">{result.changes.length ? result.changes.map(change => <button type="button" key={`${change.round}:${change.stop}`} className={'note-result-link ' + change.state} title={t('View changes for this note')} onClick={() => links.showChange(noteKey, change)}>
    <Icon name="diff" size={13}/><span>{t('Change {n}', { n: change.stop + 1 })}</span><span className="note-result-decision">{decision(change.state)}</span><Icon name="arrowRight" size={12}/>
  </button>) : <span className="note-result-status">{result.state === 'waiting' ? t('Awaiting changes') : t('No linked change')}</span>}</div>;
}
