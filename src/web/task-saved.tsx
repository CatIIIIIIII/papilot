import { Icon } from './icons.tsx';
import { t } from './i18n.ts';
import './task-commit.css';

// A task whose result is in the manuscript: archive it, or delete it at once.
// Its changes stay in the manuscript either way.
export function TaskSaved({ message, disabled, onArchive, onDelete }: { message: string; disabled: boolean; onArchive?: () => void; onDelete?: () => void }) {
  return <div className="task-commit task-saved">
    <span className="commit-state task-save-result"><Icon name="check" size={14}/>{message}</span>
    {(onArchive || onDelete) && <div className="task-commit-actions">
      {onArchive && <button type="button" className="task-commit-alternative" aria-label={t('Archive task')} disabled={disabled} onClick={onArchive}><Icon name="archive" size={14}/>{t('Archive')}</button>}
      {onDelete && <button type="button" className="task-commit-alternative task-delete" aria-label={t('Delete task')} disabled={disabled} onClick={onDelete}><Icon name="trash" size={14}/>{t('Delete')}</button>}
    </div>}
  </div>;
}
