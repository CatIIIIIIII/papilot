import { useEffect, useRef, useState } from 'react';
import type { GitHistory, GitStatus, GitVersion, GitVersionDetail } from '../shared.ts';
import { GitPane, usePane } from './git-overview.tsx';
import { Icon } from './icons.tsx';
import { locale, t } from './i18n.ts';
import { keepDialogFocus } from './focus.ts';
import './git-history.css';

export type HistorySelection = { list: 'history'; path: string; hash: string; subject: string };
const subject = (version: GitVersion) => version.message.split('\n')[0];
const date = (value: number) => new Date(value).toLocaleString(locale(), { month: 'short', day: 'numeric', year: new Date(value).getFullYear() === new Date().getFullYear() ? undefined : 'numeric', hour: '2-digit', minute: '2-digit' });

export function VersionHistory({ git, busy, load, loadVersion, restore, onOpenDiff, selection }: {
  git: GitStatus; busy: boolean; load: (before: string | null, signal: AbortSignal) => Promise<GitHistory>;
  loadVersion: (hash: string, signal: AbortSignal) => Promise<GitVersionDetail>;
  restore: (hash: string, head: string) => Promise<void>;
  onOpenDiff: (selection: HistorySelection) => void; selection: HistorySelection | null;
}) {
  const [open, toggle] = usePane('versions', true);
  const [data, setData] = useState<GitHistory | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState(''), [restoring, setRestoring] = useState<GitVersion | null>(null);
  const request = useRef<AbortController | null>(null), loadingMore = useRef(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError(''); setData(null); loadingMore.current = false;
    load(null, controller.signal).then(result => { if (!controller.signal.aborted) setData(result); }, failure => {
      if (!controller.signal.aborted) setError(failure.message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load, git.head?.hash, open, refresh]);
  async function more() {
    const controller = request.current;
    if (!data?.next || !controller || loadingMore.current) return;
    loadingMore.current = true; setLoading(true); setError('');
    try {
      const next = await load(data.next, controller.signal);
      if (!controller.signal.aborted) setData(previous => previous && ({ versions: [...previous.versions, ...next.versions], next: next.next }));
    } catch (failure) { if (!controller.signal.aborted) setError((failure as Error).message); }
    finally { if (!controller.signal.aborted) { setLoading(false); loadingMore.current = false; } }
  }
  return <GitPane title={t('Version history')} className="git-versions" open={open} onToggle={() => toggle()} actions={
    <button type="button" className="icon-button" aria-label={t('Refresh version history')} title={t('Refresh version history')} disabled={loading} onClick={() => { toggle(true); setRefresh(value => value + 1); }}><Icon name="refresh" size={14}/></button>
  }>
    {error && <p className="inline-error git-overview-note" role="alert">{error} <button type="button" onClick={() => setRefresh(value => value + 1)}>{t('Retry')}</button></p>}
    {!data && loading && <p className="git-overview-note" role="status">{t('Loading versions…')}</p>}
    {data && !data.versions.length && <p className="git-overview-note">{t('Your commits will appear here.')}</p>}
    <ol className="git-version-list">{data?.versions.map(version => {
      const current = Boolean(git.head && version.hash.startsWith(git.head.hash)), expanded = selected === version.hash;
      return <li key={version.hash} className={(current ? 'current ' : '') + (expanded ? 'expanded' : '')}>
        <div className="git-version-heading">
        <button type="button" className="git-version-row" aria-expanded={expanded} onClick={() => setSelected(expanded ? '' : version.hash)} title={version.message + '\n' + new Date(version.date).toLocaleString(locale())}>
          <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12}/>
          <span className="git-version-summary"><span className="git-version-subject">{subject(version)}</span><span className="git-version-meta"><span>{version.author}</span><time dateTime={new Date(version.date).toISOString()}>{date(version.date)}</time></span></span>
          {current && <span className="git-current-badge">{t('Current')}</span>}
        </button>
        {expanded && !current && <button type="button" className="icon-button git-restore-version" aria-label={t('Restore this version')} title={t('Restore this version')} disabled={busy} onClick={() => setRestoring(version)}><Icon name="restore" size={14}/></button>}
        </div>
        {expanded && <VersionDetail version={version} load={loadVersion} onOpenDiff={onOpenDiff} selection={selection}/>}
      </li>;
    })}</ol>
    {data?.next && <button type="button" className="git-history-more" disabled={loading} onClick={() => void more()}>{loading ? t('Loading versions…') : t('Older versions')}</button>}
    {restoring && <RestoreVersionDialog version={restoring} git={git} busy={busy} onClose={() => setRestoring(null)} onConfirm={async () => {
      if (!data?.versions[0]) return;
      await restore(restoring.hash, data.versions[0].hash); setRestoring(null); setSelected('');
    }}/>}
  </GitPane>;
}

function VersionDetail({ version, load, selection, onOpenDiff }: {
  version: GitVersion; load: (hash: string, signal: AbortSignal) => Promise<GitVersionDetail>;
  selection: HistorySelection | null; onOpenDiff: (selection: HistorySelection) => void;
}) {
  const [detail, setDetail] = useState<GitVersionDetail | null>(null), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError('');
    load(version.hash, controller.signal).then(result => { if (!controller.signal.aborted) setDetail(result); }, failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [load, version.hash, retry]);
  const body = version.message.split('\n').slice(1).join('\n').trim();
  return <div className="git-version-detail">
    {body && <p className="git-version-message">{body}</p>}
    {error ? <p className="inline-error" role="alert">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>{t('Retry')}</button></p>
      : !detail ? <p className="git-overview-note" role="status">{t('Loading the diff…')}</p>
      : detail.files.length ? <ul className="git-version-files">{detail.files.map(file => {
        const slash = file.path.lastIndexOf('/');
        return <li key={file.path}><button type="button" className="git-version-file" title={file.from ? `${file.from} → ${file.path}` : file.path} aria-pressed={selection?.hash === version.hash && selection.path === file.path} onClick={() => onOpenDiff({ list: 'history', hash: version.hash, subject: subject(version), path: file.path })}>
          <Icon name="file" size={14}/><span>{file.path.slice(slash + 1)}</span>{slash > 0 && <small>{file.path.slice(0, slash)}</small>}<code>{file.status}</code>
        </button></li>;
      })}</ul> : <p className="git-overview-note">{t('No file changes in this version.')}</p>}
  </div>;
}

function RestoreVersionDialog({ version, git, busy, onClose, onConfirm }: { version: GitVersion; git: GitStatus; busy: boolean; onClose: () => void; onConfirm: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null), pending = useRef(false);
  const [error, setError] = useState('');
  const blocked = git.files.length || git.merging ? t('Save current changes before restoring a version.') : !git.branch ? t('Check out a branch before restoring a version.') : '';
  useEffect(() => {
    const element = dialog.current!, opener = document.activeElement as HTMLElement | null;
    element.showModal(); element.querySelector<HTMLButtonElement>('[data-cancel]')?.focus();
    return () => { element.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  async function confirm() {
    if (pending.current || busy || blocked) return;
    pending.current = true; setError('');
    try { await onConfirm(); } catch (failure) { setError((failure as Error).message); }
    finally { pending.current = false; }
  }
  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="restore-version-title" onKeyDown={keepDialogFocus} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="modal delete-dialog">
      <h2 id="restore-version-title">{t('Restore this version?')}</h2>
      <p className="git-restore-name">{subject(version)}<small>{version.author} · {date(version.date)}</small></p>
      <p>{t('The manuscript’s files will match this version. A new version records the restoration, so all previous versions remain available.')}</p>
      {blocked && <p className="inline-error" role="status">{blocked}</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="button-row">
        <button type="button" data-cancel className="button secondary" disabled={busy} onClick={onClose}>{t('Cancel')}</button>
        {blocked && git.files.length > 0 ? <button type="button" className="button primary" onClick={() => { onClose(); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.git-message-box textarea')?.focus()); }}>{t('Go to changes')}</button>
          : <button type="button" className="button primary" disabled={busy || Boolean(blocked)} onClick={() => void confirm()}>{busy ? t('Restoring…') : t('Restore this version')}</button>}
      </div>
    </section>
  </dialog>;
}
