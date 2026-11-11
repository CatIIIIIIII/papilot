import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { Icon } from './icons.tsx';
import { t } from './i18n.ts';
import type { TaskCommitDraft } from './task-commit-draft.ts';
import './task-commit.css';

// The same form lives in the review iframe or chat. Its draft belongs to the
// workspace so moving between those views does not lose an edited message.
export function TaskCommit({ draft, branch, remote, disabled, agent, generate, commit }: {
  draft: TaskCommitDraft; branch: string | null; remote: boolean; disabled: boolean; agent: string;
  generate?: (fresh: boolean) => Promise<string>;
  commit: (message: string, push: boolean) => Promise<string>;
}) {
  const state = useSyncExternalStore(draft.subscribe, draft.getSnapshot);
  useEffect(() => { if (generate) void draft.write(generate); }, [draft, Boolean(generate)]);
  const input = useRef<HTMLTextAreaElement>(null);
  const resize = () => {
    const element = input.current; if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 132)}px`;
  };
  useLayoutEffect(resize, [state.message, Boolean(generate), state.result]);
  useEffect(() => {
    const element = input.current; if (!element) return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== width) { width = element.clientWidth; resize(); }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [Boolean(generate), state.result]);
  if (state.result) return <span className="commit-state" role="status">{state.result}</span>;
  const busy = disabled || Boolean(state.busy);
  const submit = (push = false) => { if (!busy) void draft.submit(push ? 'push' : 'commit', message => commit(message, push)); };
  return <form className="task-commit" aria-label={t('Save accepted changes')} onSubmit={event => { event.preventDefault(); submit(); }}>
    <div className="task-commit-compose">
      {generate && <textarea ref={input} aria-label={t('Commit message')} aria-busy={state.writing} rows={1} value={state.message} readOnly={busy} placeholder={state.writing ? t('{agent} is writing a commit message…', { agent }) : t('Commit message')}
        onChange={event => draft.edit(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }}/>}
      <div className="task-commit-toolbar">
        {generate && <span className="task-commit-branch" title={branch ? t('Commit to {branch}', { branch }) : t('Commit')}><Icon name="branch" size={13}/><span>{branch || t('Commit')}</span></span>}
        {generate && <button type="button" className="task-commit-generate" aria-label={t('Generate commit message')} aria-busy={state.writing} title={t('Write a commit message for the chosen files with {agent}', { agent })} disabled={busy || state.writing} onClick={() => void draft.write(generate, true)}>
          {state.writing ? <span className="task-commit-spinner" aria-hidden="true"/> : <Icon name="spark" size={15}/>}
        </button>}
        <div className="task-commit-actions">
          {generate && <>
            {remote && <button type="button" className="task-commit-alternative" disabled={busy || !state.message.trim()} onClick={() => submit(true)}>{state.busy === 'push' ? t('Committing and pushing…') : t('Commit and push')}</button>}
            <button className="task-commit-primary" disabled={busy || !state.message.trim()}>{state.busy === 'commit' ? t('Committing…') : t('Commit')}<Icon name="arrowRight" size={14}/></button>
          </>}
        </div>
      </div>
    </div>
    {state.writing && <span className="task-commit-hint" role="status">{t('{agent} is writing a commit message…', { agent })}</span>}
    {state.error && <p className="task-commit-error" role="alert">{state.error}</p>}

  </form>;
}
