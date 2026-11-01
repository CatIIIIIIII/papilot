import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons.tsx';
import { ChipSelect } from './chip-select.tsx';
import { keepDialogFocus } from './focus.ts';
import { t } from './i18n.ts';
import logo from './logo.svg';
import type { UpdateStatus } from '../shared.ts';
import './update-notice.css';

export type UpdateApi = <T = any>(route: string, body?: unknown) => Promise<T>;
const working = (status: UpdateStatus) => ['installing', 'waiting', 'restarting'].includes(status.phase);
// The sidebar notice and Settings may observe completion together.
let reloading = false;
export const versionLabel = (version: string) => version.replace(/(-dev\.[a-f0-9]{7})[a-f0-9]{33}$/, '$1');
function updateError(error: string) {
  if (error === 'The dev build needs at least 2 GB of free disk space. Free some space and retry.') return t('The dev build needs at least 2 GB of free disk space. Free some space and retry.');
  if (error === 'Could not check for updates. Try again when connected.') return t('Could not check for updates. Try again when connected.');
  return error;
}
function useUpdates(api: UpdateApi, version?: string) {
  const [status, setState] = useState<UpdateStatus | null>(null);
  const revision = useRef(0);
  const setStatus = (value: UpdateStatus) => { revision.current++; setState(value); };
  const initialVersion = useRef(version);
  const current = useRef(status); current.current = status;
  useEffect(() => {
    let stopped = false, reading = false, timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      if (reading) return;
      reading = true;
      const request = ++revision.current;
      try {
        const next = await api<UpdateStatus>('/updates');
        if (stopped || request !== revision.current || !next?.currentVersion) return;
        initialVersion.current ??= next.currentVersion;
        setState(next);
        if (next.phase === 'updated' && next.currentVersion !== initialVersion.current && !reloading) {
          reloading = true; location.reload();
        }
      } catch { /* The old page stays usable while the server restarts. */ }
      finally { reading = false; if (!stopped) timer = setTimeout(read, current.current && working(current.current) ? 2000 : 30000); }
    };
    void read();
    const focus = () => { clearTimeout(timer); void read(); };
    window.addEventListener('online', focus); window.addEventListener('focus', focus);
    window.addEventListener('papilot:updates', focus);
    return () => { stopped = true; clearTimeout(timer); window.removeEventListener('online', focus); window.removeEventListener('focus', focus); window.removeEventListener('papilot:updates', focus); };
  }, [api, status?.phase]);
  return { status, setStatus };
}
export function UpdateNotice({ api, version }: { api: UpdateApi; version: string }) {
  const { status, setStatus } = useUpdates(api, version);
  const [open, setOpen] = useState(false), [sending, setSending] = useState(false), [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null, element = dialog.current!;
    element.showModal();
    return () => { element.close(); if (opener?.isConnected) opener.focus(); };
  }, [open]);
  const currentVersion = <span className="brand-version" title={t('Papilot {version}', { version })}>v{versionLabel(version)}</span>;
  if (!status) return currentVersion;
  const busy = working(status), available = status.latestVersion && status.latestVersion !== status.currentVersion;
  if (!open && !busy && status.phase !== 'failed' && (!available || status.phase === 'idle')) return currentVersion;
  const label = status.phase === 'installing' ? t('Updating…') : status.phase === 'waiting' ? t('Update ready') : status.phase === 'restarting' ? t('Restarting…') : status.phase === 'failed' ? t('Update failed') : t('New version');
  const description = `${t('Papilot {version}', { version: versionLabel(version) })} · ${label}${status.latestVersion ? ` · v${versionLabel(status.latestVersion)}` : ''}`;
  async function install() {
    if (!status || sending) return;
    setSending(true); setError('');
    try { setStatus(await api<UpdateStatus>('/updates/install', { version: status.latestVersion })); }
    catch (error) { setError(error instanceof Error ? error.message : t('Could not start the update. Please retry.')); }
    finally { setSending(false); }
  }
  return <>
    <button type="button" className={'brand-version update-badge' + (status.phase === 'failed' ? ' failed' : '')} aria-label={description} aria-haspopup="dialog" aria-expanded={open} aria-busy={busy || undefined} title={description} onClick={() => setOpen(true)}>
      v{versionLabel(version)}
      <span className="update-dot" aria-hidden="true"/>
    </button>
    {open && <dialog ref={dialog} className="update-dialog" aria-labelledby="update-title" onCancel={event => { event.preventDefault(); setOpen(false); }} onKeyDown={keepDialogFocus} onClick={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div className="update-heading"><h2 id="update-title">{t('Update Papilot')}</h2><button className="icon-button" aria-label={t('Close')} onClick={() => setOpen(false)}><Icon name="close" size={16}/></button></div>
      <p className="update-versions"><span>{versionLabel(status.currentVersion)}</span><Icon name="arrowRight" size={14}/><strong>{versionLabel(status.latestVersion || status.currentVersion)}</strong></p>
      <p role="status">{status.phase === 'installing' ? t('Downloading and checking the new version…')
        : status.phase === 'waiting' ? t('The update is ready. Waiting for tasks and PDF builds to finish before restarting.')
        : status.phase === 'restarting' ? t('Restarting Papilot. This page will reconnect automatically; your drafts are kept.')
        : status.phase === 'failed' ? t('The update did not finish. Your current version is still available. You can retry here.')
        : t('Install the new version and restart automatically when tasks are idle. Your papers, tasks and settings stay in place.')}</p>
      {!status.canUpdate && <p className="inline-error">{t('Papilot cannot find npm on this computer. Updates are unavailable until npm is installed.')}</p>}
      {(error || status.error) && <p className="inline-error" role="alert">{updateError(error || status.error!)}</p>}
      <div className="update-actions"><button className="button ghost" onClick={() => setOpen(false)}>{busy ? t('Close') : t('Later')}</button>
        {!busy && <button className="button primary" disabled={sending || !status.canUpdate || !available} onClick={() => void install()}>{sending ? t('Updating…') : status.phase === 'failed' ? t('Retry update') : t('Update to {version}', { version: versionLabel(status.latestVersion || '') })}</button>}
      </div>
    </dialog>}
  </>;
}

export function UpdateSettings({ api }: { api: UpdateApi }) {
  const { status, setStatus } = useUpdates(api);
  const [sending, setSending] = useState(false), [error, setError] = useState('');
  async function send(route: string, body: unknown = {}) {
    setSending(true); setError('');
    try { setStatus(await api<UpdateStatus>(route, body)); window.dispatchEvent(new Event('papilot:updates')); }
    catch (error) { setError(error instanceof Error ? error.message : t('Could not check for updates. Try again when connected.')); }
    finally { setSending(false); }
  }
  if (!status) return <div className="update-settings settings-page"><section className="settings-card update-summary update-loading"><p role="status">{t('Reading update status…')}</p><button className="button secondary" disabled={sending} onClick={() => void send('/updates/check')}>{t('Check for updates')}</button>{error && <p className="inline-error" role="alert">{updateError(error)}</p>}</section></div>;
  if (status.downloadUrl) return <div className="update-settings settings-page"><section className="settings-card update-summary">
    <div className="update-product-row"><div className="update-product"><span className="update-product-mark"><img src={logo} width="34" height="34" alt=""/></span><div><h3>Papilot</h3><p className="update-current-version">{t('Current version')} <code>{versionLabel(status.currentVersion)}</code></p></div></div>
      <a className="button secondary" href={status.downloadUrl} target="_blank" rel="noreferrer">{t('Download desktop updates')}</a></div>
    <p className="update-settings-notice">{t('Download the latest desktop app for your system from GitHub Releases. Your papers and settings stay in place.')}</p>
  </section></div>;
  const busy = working(status), available = status.latestVersion && status.latestVersion !== status.currentVersion && status.phase !== 'idle' && status.phase !== 'checking';
  const checking = status.phase === 'checking';
  const message = error || status.error;
  const checkFailed = !!message && !busy && !checking && status.phase !== 'failed';
  const title = status.phase === 'installing' ? t('Updating…') : status.phase === 'waiting' ? t('Update ready')
    : status.phase === 'restarting' ? t('Restarting…') : checking ? t('Checking for updates…')
    : status.phase === 'failed' ? t('Update failed') : checkFailed ? t('Could not check for updates') : available ? t('Update available')
    : status.latestVersion ? t('Up to date') : t('Ready to check for updates');
  const tone = status.phase === 'failed' ? 'failed' : checkFailed ? 'warning' : busy || checking ? 'active' : available ? 'available' : status.latestVersion ? 'current' : 'idle';
  const icon = tone === 'failed' || tone === 'warning' ? 'alert' : busy || checking ? 'refresh' : available ? 'arrowUp' : status.latestVersion ? 'check' : 'refresh';
  return <div className="update-settings settings-page">
    <section className="settings-card update-summary" aria-label={t('Update Papilot')}>
      <div className="update-product-row">
        <div className="update-product">
          <span className="update-product-mark"><img src={logo} width="34" height="34" alt=""/></span>
          <div><h3>Papilot</h3><p className="update-current-version"><span>{t('Current version')}</span><code title={status.currentVersion}>{versionLabel(status.currentVersion)}</code></p></div>
        </div>
        <button className="button secondary update-check" disabled={sending || busy || checking} onClick={() => void send('/updates/check')}><Icon name="refresh" size={14}/>{t('Check for updates')}</button>
      </div>
      <div className={'update-status ' + tone}>
        <div className="update-summary-heading" role="status">
          <span className="update-summary-icon"><Icon name={icon} size={17}/></span>
          <h4 id="update-settings-title">{title}</h4>
        </div>
        {!checkFailed && <p className="update-status-description">{status.phase === 'installing' ? status.channel === 'dev' ? t('Downloading and building the selected GitHub commit…') : t('Downloading and checking the new version…')
          : status.phase === 'waiting' ? t('The update is ready. Waiting for tasks and PDF builds to finish before restarting.')
          : status.phase === 'restarting' ? t('Restarting Papilot. This page will reconnect automatically; your drafts are kept.')
          : checking ? null
          : status.phase === 'failed' ? t('The update did not finish. Your current version is still available. You can retry here.')
          : available ? t('Install the new version and restart automatically when tasks are idle. Your papers, tasks and settings stay in place.')
          : status.latestVersion ? t('You are using the latest version on this channel.') : t('Check for updates to see the latest version.')}</p>}
        {message && <p className="update-status-error" role="alert">{message === 'Could not check for updates. Try again when connected.' ? t('Check your connection and try again.') : updateError(message)}</p>}
        {status.latestVersion && status.latestVersion !== status.currentVersion && <div className="update-release">
          <p id="update-latest-version"><span>{t('Latest version')}</span><code title={status.latestVersion}>{versionLabel(status.latestVersion)}</code></p>
          {available && !busy && <button className="button primary" aria-describedby="update-latest-version" disabled={sending || !status.canUpdate} onClick={() => void send('/updates/install', { version: status.latestVersion })}><Icon name="arrowUp" size={15}/>{status.phase === 'failed' ? t('Retry update') : t('Update now')}</button>}
        </div>}
      </div>
      {!status.canUpdate && <p className="update-settings-notice"><Icon name="info" size={15}/><span>{t('Papilot cannot find npm on this computer. Updates are unavailable until npm is installed.')}</span></p>}
      <div className="update-channel">
        <div className="update-channel-copy"><h4>{t('Update channel')}</h4><p>{status.channel === 'dev' ? t('Early updates from GitHub main. May be less stable.') : t('Published releases, recommended for everyday use.')}</p></div>
        <ChipSelect label={t('Update channel')} icon={status.channel === 'dev' ? 'branch' : undefined} value={status.channel || 'stable'} disabled={sending || busy} onChange={channel => void send('/updates/channel', { channel })} options={[{ value: 'stable', label: t('Stable') }, { value: 'dev', label: t('Dev (GitHub main)') }]}/>
      </div>
    </section>
  </div>;
}
