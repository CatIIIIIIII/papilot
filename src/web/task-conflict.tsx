import type { TaskStatus } from '../shared.ts';
import { Icon } from './icons.tsx';
import { t } from './i18n.ts';
import './task-commit.css';

export function TaskConflict({ status, waiting, onChat }: { status: TaskStatus; waiting: boolean; onChat: () => void }) {
  const busy = ['queued', 'running', 'building'].includes(status);
  return <div className="task-commit task-merge-status" role="status">
    <span>{busy ? <i className="task-commit-spinner" aria-hidden="true"/> : <Icon name="spark" size={14}/>}
      {busy ? t('AI is resolving conflicts…') : status === 'waiting_input' ? t('AI needs your input') : waiting ? t('Conflict resolution paused') : t('Review the merged result')}</span>
    {!busy && waiting && <div className="task-commit-actions"><button type="button" onClick={onChat}>{t('Open chat')}<Icon name="arrowRight" size={13}/></button></div>}
  </div>;
}
