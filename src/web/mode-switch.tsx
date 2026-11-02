import { Icon } from './icons.tsx';
import { t } from './i18n.ts';

// PDF or Changes: the manuscript as it is or what changed since the last
// commit, and in a task's review, the whole paper with each change in place
// or the changed sections only. Settings uses it, labeled, for the default.
export type PdfMode = 'pdf' | 'changes';
export function ModeSwitch({ mode, onMode, changesTitle, label, labeled }: { mode: PdfMode; onMode: (mode: PdfMode) => void; changesTitle?: string; label?: string; labeled?: boolean }) {
  return <div className={'pdf-modes' + (labeled ? ' labeled' : '')} role="group" aria-label={label ?? t('Show')}>
    <button type="button" aria-label="PDF" title="PDF" aria-pressed={mode === 'pdf'} onClick={() => onMode('pdf')}><Icon name="paper" size={15}/><span>PDF</span></button>
    <button type="button" aria-label={t('Changes')} aria-pressed={mode === 'changes'} title={changesTitle ?? t('What changed since the last commit, to stage, revert and commit change by change')} onClick={() => onMode('changes')}><Icon name="diff" size={15}/><span>{t('Changes')}</span></button>
  </div>;
}
