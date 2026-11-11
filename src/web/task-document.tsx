import { lazy, Suspense, useCallback, useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import type { Manuscript, Task } from '../shared.ts';
import type { OutlineItem } from './pdf-view.tsx';
import { ModeSwitch } from './mode-switch.tsx';
import { ReviewFrame } from './review-frame.tsx';
import { useTaskReviewView } from './review-view.ts';
import { pdfAsset } from './playground-mode.ts';
import { t } from './i18n.ts';

const PdfView = lazy(() => import('./pdf-view.tsx').then(module => ({ default: module.PdfView })));
const nothing = () => {};

// Keep a reader mounted behind the comparison. The manuscript is the first
// readable version; a successful task round replaces it only after it loads.
// A new round, a failed compile, or an empty answer must not remove the paper.
export function TaskDocument({ task, projectId, manuscript, placeholder, ...review }: Omit<ComponentProps<typeof ReviewFrame>, 'task'> & {
  task: Task; projectId: string; manuscript: Manuscript | null; placeholder: ReactNode;
}) {
  const [ready, setReady] = useState(false), [lastRound, setLastRound] = useState<number>();
  const [view, chooseView] = useTaskReviewView(task.id), [fullPaper, setFullPaper] = useState(false);
  const [outline, setOutline] = useState<OutlineItem[]>([]), [section, setSection] = useState(-1);
  const hasReview = Boolean(!task.preparation && task.review?.round);
  const failed = task.review?.state === 'build_failed' || task.review?.job?.status === 'failed';
  const completedRound = !failed && task.status !== 'building' && !task.pendingBuild && task.review?.state !== 'building' ? task.review?.round : null;
  const visibleReview = hasReview && ready;
  useEffect(() => { if (!task.review?.round && task.status !== 'reviewing') setLastRound(undefined); }, [task.review?.round, task.status]);
  const onReadyChange = useCallback((value: boolean, round?: number) => {
    setReady(value);
    // A round's source can arrive before its PDF. Wait for both the viewer and
    // the completed publication, and do not replace it with a historical round.
    if (value && round && round === completedRound) setLastRound(round);
  }, [completedRound]);
  const modes = hasReview && fullPaper ? <ModeSwitch mode={view === 'paper' ? 'pdf' : 'changes'} onMode={mode => chooseView(mode === 'pdf' ? 'paper' : 'changes')} changesTitle={t('Changes')}/> : null;
  const key = manuscript?.build.key;
  const url = lastRound ? pdfAsset(`/api/tasks/${task.id}/pdf?round=${lastRound}&retained=1`)
    : key ? pdfAsset(`/api/projects/${projectId}/manuscript.pdf?key=${key}`) : '';
  return <>
    {!visibleReview && hasReview && review.completion && <div className="task-document-actions">{review.completion}</div>}
    <div className={'task-document' + (visibleReview ? ' has-review' : '')}>
    <div className="task-document-preview" aria-hidden={visibleReview} inert={visibleReview}>
      {url ? <Suspense fallback={<div className="review-loading"><p role="status">{t('Opening the PDF…')}</p></div>}>
        <PdfView readOnly suspended={visibleReview} place={'task-pdf:' + task.id} url={url} notes={[]} active="" region={false} setRegion={nothing} onCreate={async () => {}} onSelect={nothing}
          outline={outline} section={section} onOutline={setOutline} onSection={setSection} lead={visibleReview ? undefined : (review.lead || modes) ? <>{review.lead}{modes}</> : undefined} tools={visibleReview ? undefined : review.tools}/>
      </Suspense> : !hasReview && <>{(review.lead || review.tools) && <div className="review-placeholder-toolbar">{review.lead}<div className="panel-tools">{review.tools}</div></div>}{placeholder}</>}
    </div>
    {hasReview && <ReviewFrame {...review} view={view} onViewChange={chooseView} onFullPaperChange={setFullPaper} lead={visibleReview || !url ? review.lead : undefined} tools={visibleReview || !url ? review.tools : undefined} task={task} keepPdf={Boolean(url)} onReadyChange={onReadyChange}/>}
    </div>
  </>;
}
