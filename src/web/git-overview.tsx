import { useEffect, useState, type ReactNode } from 'react';
import type { GitOverview, GitStatus, GitWorktree, Task } from '../shared.ts';
import { graphRows } from './git-graph.ts';
import { Icon } from './icons.tsx';
import { locale, t } from './i18n.ts';
import { browserStorage } from './storage.ts';
import './git-overview.css';

export function GitCounts({ status }: { status: GitStatus }) {
  const conflicts = status.merging?.conflicts.length ?? status.files.filter(file => file.status === 'U').length;
  const staged = status.files.filter(file => file.staged && file.status !== 'U').length;
  const unstaged = status.files.filter(file => file.unstaged && file.status !== '?').length;
  const untracked = status.files.filter(file => file.status === '?').length;
  return <span className="git-status-counts">
    {!status.files.length && <span className="is-clean"><Icon name="check" size={12}/>{t('clean')}</span>}
    {conflicts > 0 && <span className="has-conflicts">{t('{n} conflicts', { n: conflicts })}</span>}
    {staged > 0 && <span>{t('{n} staged', { n: staged })}</span>}
    {unstaged > 0 && <span>{t('{n} unstaged', { n: unstaged })}</span>}
    {untracked > 0 && <span>{t('{n} untracked', { n: untracked })}</span>}
    {status.merging && <span className="has-conflicts">{t('Merge in progress')}</span>}
  </span>;
}

const treeName = (tree: GitWorktree) => tree.branch || (tree.bare ? t('Bare repository') : t('detached HEAD'));
const colors = ['var(--accent)', 'var(--green)', 'var(--graph-purple)', 'var(--amber-text)', 'var(--graph-pink)'];

// A collapsible view of the Git panel, like an editor's source-control views:
// a title, and actions beside it. Whether it is open is kept in this browser.
export function usePane(name: string, initial: boolean) {
  const key = 'papilot:git-pane:' + name;
  const [open, setOpen] = useState(() => { const saved = browserStorage.getItem(key); return saved === null ? initial : saved === 'open'; });
  const toggle = (next?: boolean) => setOpen(value => { const result = next ?? !value; browserStorage.setItem(key, result ? 'open' : 'closed'); return result; });
  return [open, toggle] as const;
}
export function GitPane({ title, count, actions, open, onToggle, className = '', children }: { title: string; count?: number; actions?: ReactNode; open: boolean; onToggle: () => void; className?: string; children: ReactNode }) {
  return <section className={'git-pane ' + className + (open ? ' open' : '')} aria-label={title}>
    <div className="git-pane-header">
      <button type="button" className="git-pane-toggle" aria-expanded={open} onClick={onToggle}><Icon name={open ? 'chevronDown' : 'chevronRight'} size={12}/><h3>{title}</h3>{count ? <span className="git-count">{count}</span> : null}</button>
      {actions && <div className="git-pane-actions">{actions}</div>}
    </div>
    {open && children}
  </section>;
}

// The commit graph and the worktrees beside the manuscript, as two views.
// actions are the remote commands the graph's header offers.
export function GitRepository({ git, load, tasks, onOpenTask, taskStatus, actions }: { git: GitStatus; load: (signal: AbortSignal) => Promise<GitOverview>; tasks: Task[]; onOpenTask: (id: string) => void; taskStatus: (task: Task) => ReactNode; actions?: ReactNode }) {
  const [data, setData] = useState<GitOverview | null>(null), [error, setError] = useState('');
  const [loading, setLoading] = useState(true), [refresh, setRefresh] = useState(0);
  const [selectedPath, setSelectedPath] = useState(''), [expandedPath, setExpandedPath] = useState('');
  const [graphOpen, toggleGraph] = usePane('graph', true), [treesOpen, toggleTrees] = usePane('worktrees', false);
  // Refresh after local Git changes, and poll other worktrees even when this
  // checkout stays unchanged. Aborting old requests prevents stale overwrites.
  const revision = JSON.stringify([git.head?.hash, git.branch, git.ahead, git.behind, git.files, git.merging]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function update() {
      if (document.hidden) { timer = setTimeout(update, 10_000); return; }
      setLoading(true);
      try {
        const result = await load(controller.signal);
        if (!controller.signal.aborted) { setData(result); setError(''); }
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(update, 10_000); }
      }
    }
    void update();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [load, revision, refresh]);
  const worktrees = data?.worktrees || [];
  const taskById = new Map(tasks.map(task => [task.id, task]));
  const taskFor = (tree: GitWorktree) => tree.taskId ? taskById.get(tree.taskId) : undefined;
  const label = (tree: GitWorktree) => taskFor(tree)?.title || (tree.current ? t('Manuscript') : treeName(tree));
  const selected = worktrees.find(tree => tree.path === selectedPath) || worktrees.find(tree => tree.current);
  const graph = graphRows(data?.commits || []), graphWidth = 12 + graph.lanes * 12;
  const reveal = (tree: GitWorktree) => { setSelectedPath(tree.path); setExpandedPath(tree.path); toggleTrees(true); };
  return <>
    <GitPane className="git-history" title={t('Commit graph')} open={graphOpen} onToggle={() => toggleGraph()} actions={<>{actions}
      <button type="button" className="icon-button" aria-label={t('Refresh worktrees and history')} title={t('Refresh worktrees and history')} disabled={loading} onClick={() => setRefresh(value => value + 1)}>{loading ? <span className="spinner"/> : <Icon name="refresh" size={14}/>}</button></>}>
      {error && <p className="inline-error git-overview-note" role="alert">{t('Could not refresh the repository.')}{data && <> {t('Showing the last update.')}</>} <span>{error}</span><button type="button" className="button ghost compact" onClick={() => setRefresh(value => value + 1)}>{t('Retry')}</button></p>}
      {!data && !error && <p className="git-overview-note" role="status">{t('Reading worktrees and history…')}</p>}
      {data && !graph.rows.length && <p className="git-overview-note">{t('No commits yet')}</p>}
      {graph.rows.length > 0 && <>
        {selected?.head && !graph.rows.some(row => row.commit.hash === selected.head) && <p className="git-overview-note">{t('This worktree’s HEAD is outside the displayed history.')}</p>}
        <div className="git-graph-scroll"><ol className="git-graph-list">{graph.rows.map(row => {
          const { commit, lane } = row, trees = worktrees.filter(tree => tree.head === commit.hash), highlighted = selected?.head === commit.hash && !selected.current;
          const head = commit.hash === git.head?.hash || commit.hash.startsWith(git.head?.hash || '\0');
          const x = (column: number) => 9 + column * 12;
          // A task's branch shows as its task, which opens the worktree.
          const refs = commit.refs.filter(ref => !trees.some(tree => taskFor(tree) && tree.branch === ref));
          const taskTrees = trees.filter(tree => taskFor(tree));
          return <li key={commit.hash} className={'git-graph-row' + (highlighted ? ' highlighted' : '') + (head ? ' head' : '')} data-commit={commit.hash} title={`${commit.subject}\n${commit.hash.slice(0, 7)} · ${commit.author} · ${new Date(commit.date).toLocaleString(locale())}`}>
            <div className="git-graph-rail" style={{ width: graphWidth }} aria-hidden="true">
              <svg viewBox={`0 0 ${graphWidth} 100`} preserveAspectRatio="none" className="git-graph-lines">
                {row.edges.filter(edge => !edge.parent).map((edge, index) => <path key={'through' + index} d={`M ${x(edge.from)} 0 L ${x(edge.from)} 50 C ${x(edge.from)} 75 ${x(edge.to)} 75 ${x(edge.to)} 100`} stroke={colors[edge.to % colors.length]}/>) }
                {row.incoming && <path d={`M ${x(lane)} 0 V 50`} stroke={colors[lane % colors.length]}/>}
                {row.edges.filter(edge => edge.parent).map((edge, index) => <path key={'parent' + index} d={`M ${x(lane)} 50 C ${x(lane)} 75 ${x(edge.to)} 75 ${x(edge.to)} 100`} stroke={colors[edge.to % colors.length]}/>)}
              </svg>
              <span className={'git-graph-dot' + (commit.parents.length > 1 ? ' merge' : '')} style={{ left: x(lane), ['--dot' as string]: colors[lane % colors.length] }}/>
            </div>
            <div className="git-graph-content">
              <span className="git-graph-subject">{commit.subject}</span>
              <span className="git-graph-author">{commit.author}</span>
              {(taskTrees.length > 0 || refs.length > 0 || commit.remotes?.length || commit.tags?.length) ? <span className="git-graph-refs">
                {taskTrees.map(tree => <button type="button" key={tree.path} className="git-graph-ref worktree-ref" title={`${label(tree)}\n${treeName(tree)}\n${tree.path}`} onClick={() => reveal(tree)}><Icon name="chat" size={10}/><span>{label(tree)}</span></button>)}
                {refs.map(ref => <span key={ref} className={'git-graph-ref branch-ref' + (ref === git.branch ? ' current-ref' : '')} title={ref}><Icon name="branch" size={10}/><span>{ref}</span></span>)}
                {commit.remotes?.map(ref => <span key={ref} className="git-graph-ref remote-ref" title={ref}><Icon name="cloud" size={10}/><span>{ref}</span></span>)}
                {commit.tags?.map(ref => <span key={ref} className="git-graph-ref tag-ref" title={ref}><Icon name="bookmark" size={10}/><span>{ref}</span></span>)}
              </span> : null}
            </div>
          </li>;
        })}</ol></div>
        {data?.truncated && <p className="git-overview-note git-history-end">{t('Showing the latest {n} commits. Older history is not shown.', { n: graph.rows.length })}</p>}
      </>}
    </GitPane>
    <GitPane className="git-worktree-pane" title={t('Worktrees')} count={data ? worktrees.length : undefined} open={treesOpen} onToggle={() => toggleTrees()}>
      <ul className="git-worktrees">{worktrees.map(tree => {
        const status = tree.current ? git : tree.status, expanded = expandedPath === tree.path, task = taskFor(tree);
        return <li key={tree.path} className={'git-worktree' + (tree.path === selected?.path ? ' selected' : '')} data-task-id={task?.id}>
          <div className="git-worktree-row">
          <button type="button" className="git-worktree-button" aria-expanded={expanded} onClick={() => { setSelectedPath(tree.path); setExpandedPath(expanded ? '' : tree.path); }}>
            <span className="git-worktree-title"><Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12}/><strong title={label(tree)}>{label(tree)}</strong>{task?.archivedAt && <span title={t('Archived task')} aria-label={t('Archived task')}><Icon name="archive" size={12}/></span>}{tree.current && <span className="git-current-badge">{t('Current')}</span>}{task && taskStatus(task)}</span>
            <span className="git-worktree-meta">
              {status ? <GitCounts status={status}/> : <span className="git-worktree-unavailable">{tree.bare ? t('Bare repository') : t('Status unavailable')}</span>}
              {status?.upstream && (status.ahead > 0 || status.behind > 0) && <span className="git-worktree-sync" title={t('Compared with {upstream}', { upstream: status.upstream })}>↑{status.ahead} ↓{status.behind}</span>}
              {tree.locked !== undefined && <span className="git-worktree-flag" title={tree.locked}>{t('Locked')}</span>}
              {tree.prunable !== undefined && <span className="git-worktree-flag" title={tree.prunable}>{t('Missing worktree')}</span>}
            </span>
          </button>
          {task && <button type="button" className="icon-button git-open-task" aria-label={t('Open task: {title}', { title: task.title })} title={t('Open task: {title}', { title: task.title })} onClick={() => onOpenTask(task.id)}><Icon name="arrowRight" size={14}/></button>}
          </div>
          {expanded && <div className="git-worktree-detail">
            <p className="git-worktree-branch"><Icon name="branch" size={12}/><code>{treeName(tree)}</code>{tree.head && <code>{tree.head.slice(0, 7)}</code>}{!task && !tree.current && <span>{t('No linked task')}</span>}</p>
            <p className="git-worktree-path">{tree.path}</p>
            {status?.head && <p>{status.head.subject}</p>}
            {status?.upstream ? <p className="git-worktree-tracking"><code>{status.upstream}</code><span>{t('{ahead} ahead · {behind} behind', { ahead: status.ahead, behind: status.behind })}</span></p> : status && <p>{t('No upstream branch')}</p>}
            {tree.error && <p className="inline-error">{t('Could not read this worktree.')}</p>}
            {tree.locked && <p>{t('Locked')}: {tree.locked}</p>}{tree.prunable && <p>{t('Missing worktree')}: {tree.prunable}</p>}
            {status && status.files.length > 0 && <ul className="git-worktree-files" aria-label={t('Changed files in {branch}', { branch: label(tree) })}>{status.files.map(file => <li key={file.path}><code className={file.status === 'U' ? 'has-conflicts' : ''}>{file.status === '?' ? '?' : file.status}</code><span>{file.path}</span>{file.staged && <small>{t('Staged')}</small>}</li>)}</ul>}
          </div>}
        </li>;
      })}</ul>
      {!data && <p className="git-overview-note" role="status">{t('Reading worktrees and history…')}</p>}
      {data && worktrees.length === 1 && <p className="git-overview-note">{t('No other worktrees in this repository.')}</p>}
    </GitPane>
  </>;
}
