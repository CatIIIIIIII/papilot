import { useEffect, useState } from 'react';
import type { SystemRequirements } from '../shared.ts';
import { BrandIcon } from './brand-icon.tsx';
import { Icon } from './icons.tsx';
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
const requirementsFailed = (report: SystemRequirements | null) => Boolean(report?.checks.some(check => check.failureReason));

export type RequiredTool = 'git' | 'latex';
export const missingTools = (state: RequirementsState): RequiredTool[] => (['git', 'latex'] as const).filter(tool =>
  state.failed || state.report?.checks.some(check => (tool === 'git' ? check.id === 'git' : check.id !== 'git') && !check.ok));

export function RequirementsBanner({ state, onOpen }: { state: RequirementsState; onOpen: (tool: RequiredTool) => void }) {
  const tools = missingTools(state);
  if (!tools.length) return null;
  return <div className="requirements-banner" role="status"><Icon name="info" size={18}/><span>{state.failed || requirementsFailed(state.report) ? t('Could not check the required tools.') : t('A few tools are needed before you can work on papers.')}</span>{tools.map(tool => <button type="button" key={tool} onClick={() => onOpen(tool)}>{tool === 'git' ? 'Git' : 'LaTeX'}<Icon name="chevronRight" size={12}/></button>)}</div>;
}

export function ToolRequirement({ tool, state, online, showRecheck = true }: { tool: RequiredTool; state: RequirementsState; online: boolean; showRecheck?: boolean }) {
  const { report, busy, failed } = state;
  const checks = report?.checks.filter(check => tool === 'git' ? check.id === 'git' : check.id !== 'git');
  const ok = checks?.every(check => check.ok);
  const checkFailed = failed || checks?.some(check => check.failureReason);
  const partial = tool === 'latex' && checks?.some(check => check.ok);
  const status = !online ? 'unknown' : busy ? 'checking' : checkFailed ? 'unknown' : ok === true ? 'ready' : ok === false ? 'missing' : 'checking';
  const label = !online ? t('Offline') : busy ? t('Checking…') : checkFailed ? t('Check failed') : ok === true ? t('Ready') : ok === false ? partial ? t('Incomplete installation') : t('Not installed or unavailable') : t('Checking…');
  const platform = report?.platform;
  const installUrl = tool === 'git' ? 'https://git-scm.com/install/' + (platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : '')
    : platform === 'darwin' ? 'https://www.tug.org/mactex/mactex-download.html' : 'https://www.tug.org/texlive/acquire-netinstall.html';
  return <div className="tool-requirement">
    <section className="requirement-row" aria-label={tool === 'git' ? 'Git' : 'LaTeX'}>
      {tool === 'git' && <BrandIcon name="git" size={22}/>}
      <div className="requirement-copy"><div className="requirement-heading"><h3>{tool === 'git' ? 'Git' : t('PDF compilation')}</h3><span className={'requirement-status ' + status} role="status" aria-live="polite">{status === 'checking' ? <span className="spinner"/> : <Icon name={status === 'ready' ? 'check' : 'alert'} size={12}/>} {label}</span></div>{tool === 'git' && <p>{t('Version history')}</p>}</div>
      {ok === false && !checkFailed && !busy && online && <a className="requirement-install" href={installUrl} target="_blank" rel="noopener noreferrer">{tool === 'git' ? t('Install Git') : platform === 'darwin' ? t('Install MacTeX') : t('Install TeX Live')}<Icon name="external" size={13}/></a>}
    </section>
    {showRecheck && <button type="button" className="button secondary requirements-recheck" disabled={busy || !online} onClick={state.recheck}>{busy ? <span className="spinner"/> : <Icon name="refresh" size={15}/>} {t('Check again')}</button>}
  </div>;
}
