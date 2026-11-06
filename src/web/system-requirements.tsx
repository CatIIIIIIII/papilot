import { useEffect, useRef, useState } from 'react';
import type { SystemRequirements } from '../shared.ts';
import { BrandIcon } from './brand-icon.tsx';
import { Icon } from './icons.tsx';
import { keepDialogFocus } from './focus.ts';
import { t } from './i18n.ts';
import './system-requirements.css';

export function useSystemRequirements(enabled: boolean, load: (signal: AbortSignal) => Promise<SystemRequirements>) {
  const [report, setReport] = useState<SystemRequirements | null>(null);
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setBusy(true); setFailed(false);
    void load(controller.signal).then(value => {
      if (!value || typeof value.platform !== 'string' || !Array.isArray(value.checks) ||
        !['git', 'latexmk', 'synctex', 'tex-engine'].every(id => value.checks.some(check => check.id === id && typeof check.ok === 'boolean'))) throw new Error('Invalid requirements response');
      if (!controller.signal.aborted) setReport(value);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [enabled, load, attempt]);
  return { report, busy, failed, recheck: () => setAttempt(value => value + 1) };
}
export type RequirementsState = ReturnType<typeof useSystemRequirements>;
export const requirementsMissing = (report: SystemRequirements | null) => Boolean(report?.checks.some(check => !check.ok));

export function RequirementsBanner({ state, onOpen }: { state: RequirementsState; onOpen: () => void }) {
  if (!state.failed && !requirementsMissing(state.report)) return null;
  return <div className="requirements-banner" role="status"><Icon name="info" size={18}/><span>{state.failed ? t('Could not check the required tools.') : t('A few tools are needed before you can work on papers.')}</span><button type="button" onClick={onOpen}>{t('Review setup')}</button></div>;
}

function CheckAgain({ state, online, primary = false }: { state: RequirementsState; online: boolean; primary?: boolean }) {
  return <button type="button" className={'button requirements-recheck ' + (primary ? 'primary' : 'secondary')} disabled={state.busy || !online} onClick={state.recheck}>{state.busy ? <span className="spinner"/> : <Icon name="refresh" size={15}/>} {t('Check again')}</button>;
}

export function RequirementsPanel({ state, owner, online, showRecheck = true }: { state: RequirementsState; owner: boolean; online: boolean; showRecheck?: boolean }) {
  const { report, busy, failed } = state;
  const platform = report?.platform;
  const ready = Boolean(report && !requirementsMissing(report));
  const git = report?.checks.find(check => check.id === 'git')?.ok;
  const latex = report ? report.checks.filter(check => check.id !== 'git').every(check => check.ok) : undefined;
  const gitUrl = 'https://git-scm.com/install/' + (platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : '');
  const texUrl = platform === 'darwin' ? 'https://www.tug.org/mactex/mactex-download.html' : 'https://www.tug.org/texlive/acquire-netinstall.html';
  return <div className="requirements-panel">
    <p className="requirements-intro">{owner ? t('These tools run on the computer hosting Papilot.') : t('These tools are needed on the computer running Papilot. You do not need to install them on your own device. Ask the workspace owner to complete setup.')}</p>
    <div className="requirements-list">
      {(['git', 'latex'] as const).map(id => {
        const ok = id === 'git' ? git : latex;
        const partial = id === 'latex' && report?.checks.some(check => check.id !== 'git' && check.ok);
        const status = !online ? 'unknown' : busy ? 'checking' : failed ? 'unknown' : ok === true ? 'ready' : ok === false ? 'missing' : 'checking';
        const label = !online ? t('Offline') : busy ? t('Checking…') : failed ? t('Check failed') : ok === true ? t('Ready') : ok === false ? partial ? t('Incomplete installation') : t('Not installed or unavailable') : t('Checking…');
        return <section key={id} className="requirement-row" aria-label={id === 'git' ? 'Git' : 'LaTeX'}>
          <BrandIcon name={id} size={22}/>
          <div className="requirement-copy"><div className="requirement-heading"><h3>{id === 'git' ? 'Git' : 'LaTeX'}</h3><span className={'requirement-status ' + status}>{status === 'checking' ? <span className="spinner"/> : <Icon name={status === 'ready' ? 'check' : 'alert'} size={12}/>} {label}</span></div><p>{id === 'git' ? t('Version history') : t('PDF compilation')}</p></div>
          {ok === false && owner && <a className="requirement-install" href={id === 'git' ? gitUrl : texUrl} target="_blank" rel="noopener noreferrer">{id === 'git' ? t('Install Git') : platform === 'darwin' ? t('Install MacTeX') : t('Install TeX Live')}<Icon name="external" size={13}/></a>}
        </section>;
      })}
    </div>
    <div className="requirements-result" role="status" aria-live="polite">{!online ? t('Reconnect to check the required tools.') : busy ? t('Checking the required tools…') : failed ? t('Could not check the required tools. Try again.') : ready ? t('All required tools are ready. You can open a paper.') : null}</div>
    {showRecheck && <CheckAgain state={state} online={online}/>}
  </div>;
}

export function RequirementsDialog({ state, owner, online, onClose }: { state: RequirementsState; owner: boolean; online: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null, element = dialog.current!;
    element.showModal();
    element.querySelector<HTMLHeadingElement>('h2')?.focus();
    return () => { element.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  const ready = Boolean(state.report && !requirementsMissing(state.report) && !state.failed && !state.busy);
  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="requirements-title" onKeyDown={keepDialogFocus} onCancel={event => { event.preventDefault(); onClose(); }}>
    <section className="modal requirements-dialog">
      <button type="button" className="modal-close icon-button" aria-label={t('Close')} onClick={onClose}><Icon name="close"/></button>
      <h2 id="requirements-title" tabIndex={-1}>{t('Get ready to write')}</h2>
      <RequirementsPanel state={state} owner={owner} online={online} showRecheck={false}/>
      <footer>{ready ? <><CheckAgain state={state} online={online}/><button type="button" className="button primary" onClick={onClose}>{t('Continue')}</button></> : <><button type="button" className="button ghost" onClick={onClose}>{t('Set up later')}</button><CheckAgain state={state} online={online} primary/></>}</footer>
    </section>
  </dialog>;
}
