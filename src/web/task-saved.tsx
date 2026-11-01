import { Icon } from './icons.tsx';
import { t } from './i18n.ts';
import './task-commit.css';

export function TaskSaved({ message, disabled, onArchive }: { message: string; disabled: boolean; onArchive?: () => void }) {
  return <div className="task-commit task-saved">
    <span className="commit-state task-save-result"><Icon name="check" size={14}/>{message}</span>
    {onArchive && <div className="task-commit-actions"><button type="button" className="task-commit-alternative" aria-label={t('Archive task')} disabled={disabled} onClick={onArchive}><Icon name="archive" size={14}/>{t('Archive')}</button></div>}
  </div>;
}
