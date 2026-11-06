import { useEffect, useState } from 'react';
import type { ReviewJob } from '../shared.ts';
import { t } from './i18n.ts';

export function ComparisonProgress({ job }: { job?: ReviewJob | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!job?.createdAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [job?.id, job?.createdAt]);
  const seconds = Math.max(0, Math.floor((now - (job?.createdAt ?? now)) / 1000));
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return <div className="comparison-progress">
    {job?.phase === 'build' && (['baseline', 'revised'] as const).map(side => {
      const progress = job.progress?.[side];
      if (!progress) return null;
      const typesetting = progress.step === 'tex' && progress.pass > 0;
      const total = progress.total ? Math.max(progress.total, progress.pages) : null;
      const label = progress.step === 'bibliography' ? t('Processing the bibliography…')
        : progress.step === 'pdf' ? t('Writing the PDF…')
          : typesetting ? t('Typesetting with LaTeX, pass {n}…', { n: progress.pass }) : t('Compiling the PDF…');
      return <div className="comparison-build" key={side}>
        <div className="comparison-build-label"><strong>{side === 'baseline' ? t('Before') : t('After')}</strong><span>{label}</span></div>
        {typesetting && <div className="comparison-pages">
          <progress aria-label={side === 'baseline' ? t('Before') : t('After')} {...(total ? { value: progress.pages, max: total } : {})}/>
          <span>{total ? t('Page {pages} of {total}', { pages: progress.pages, total }) : t('Page {pages}', { pages: progress.pages })}</span>
        </div>}
      </div>;
    })}
    {job?.createdAt ? <div className="comparison-elapsed">{t('Elapsed: {time}', { time: elapsed })}</div> : null}
  </div>;
}
