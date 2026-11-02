import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Annotation, Task } from '../shared.ts';
import type { OutlineItem, PdfHandle } from './pdf-view.tsx';
import { Icon } from './icons.tsx';
import { t } from './i18n.ts';

const PdfView = lazy(() => import('./pdf-view.tsx').then(module => ({ default: module.PdfView })));
const noop = () => {};
interface ReviewCopy { key: string; notes: Annotation[] }

export function AiReviewView({ task, api, lead, tools, onCopied }: { task: Task; api: <T>(route: string, body?: unknown, signal?: AbortSignal) => Promise<T>; lead?: ReactNode; tools?: ReactNode; onCopied: () => void }) {
  const [data, setData] = useState<ReviewCopy | null>(null), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const [active, setActive] = useState(''), [outline, setOutline] = useState<OutlineItem[]>([]), [section, setSection] = useState(0);
  const pdf = useRef<PdfHandle>(null);
  const base = `/tasks/${task.id}/ai-review`;
  useEffect(() => {
    const controller = new AbortController();
    void api<ReviewCopy>(base, undefined, controller.signal).then(value => { setData(value); setError(''); }, error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [base, task.updatedAt, task.aiReview?.revision, attempt, api]);
  const update = (note: Annotation) => setData(current => current && ({ ...current, notes: current.notes.map(item => item.id === note.id ? note : item) }));
  const onSelect = (note: Annotation) => { setActive(note.id); pdf.current?.goToNote(note); };
  return <div className="ai-review-view">
    {error && <div className="connection-banner" role="alert"><span>{error}</span><button onClick={() => setAttempt(value => value + 1)}>{t('Retry')}</button></div>}
    {data ? <Suspense fallback={<div className="review-loading"><p>{t('Opening the PDF…')}</p></div>}>
      <PdfView ref={pdf} readOnly place={'pdf:review:' + task.id} url={`/api${base}/pdf?key=${data.key}`} words={`/api${base}/words?key=${data.key}`} notes={data.notes.filter(note => note.key === data.key).map((note, index) => ({ note, number: index + 1 }))} active={active} onSelect={onSelect} onDeselect={() => setActive('')}
        region={false} setRegion={noop} onCreate={async () => {}} outline={outline} section={section} onOutline={setOutline} onSection={setSection}
        lead={lead} tools={<><span className="review-copy-label" title={t('Suggestions stay in this task until you copy them to the manuscript')}>{t('Review copy')}</span>{tools}<a className="icon-button" href={`/api${base}/pdf`} target="_blank" rel="noreferrer" aria-label={t('Open PDF')} title={t('Open PDF')}><Icon name="external" size={16}/></a></>}
        noteActions={{ has: id => Boolean(data.notes.find(note => note.id === id)?.aiReview?.copiedTo), toggle: noop, onEditing: noop, onBusy: noop, disabled: false,
          edit: async () => {},
          copy: async note => { const result = await api<{ note: Annotation }>(`${base}/${note.id}/copy`, {}); update(result.note); onCopied(); },
          remove: async note => { await api(`${base}/${note.id}/delete`, {}); setData(current => current && ({ ...current, notes: current.notes.filter(item => item.id !== note.id) })); },
          restore: async note => { const restored = await api<Annotation>(`${base}/${note.id}/restore`, {}); setData(current => current && ({ ...current, notes: [...current.notes.filter(item => item.id !== restored.id), restored].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)) })); setActive(restored.id); },
        }}/>
    </Suspense> : !error && <div className="review-loading"><p role="status">{t('Opening the PDF…')}</p></div>}
  </div>;
}
