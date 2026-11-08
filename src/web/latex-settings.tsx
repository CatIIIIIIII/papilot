import { useEffect, useState } from 'react';
import type { LatexInstallation } from '../shared.ts';
import { BrandIcon } from './brand-icon.tsx';
import { Icon } from './icons.tsx';
import { ToolRequirement, type RequirementsState } from './system-requirements.tsx';
import { t } from './i18n.ts';

export function LatexSettings({ load, online, requirements }: { requirements?: { state: RequirementsState; online: boolean }; load: (signal: AbortSignal) => Promise<LatexInstallation | null>; online: boolean }) {
  const [installation, setInstallation] = useState<LatexInstallation | null>(null);
  const [busy, setBusy] = useState(true), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setFailed(false); setInstallation(null);
    void load(controller.signal).then(value => { if (!controller.signal.aborted) setInstallation(value); }, () => {
      if (!controller.signal.aborted) setFailed(true);
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [load, attempt]);
  return <div className="latex-settings settings-page">
    <section className="settings-card settings-card-body" aria-label={t('LaTeX installation')}>
      <header className="latex-installation-header">
        <BrandIcon name="latex" size={32}/>
        <h3>{installation?.distribution || t('LaTeX installation')}</h3>
        <button type="button" className="icon-button" aria-label={t('Detect again')} title={t('Detect again')} disabled={busy || requirements?.state.busy || !online} onClick={() => { setAttempt(value => value + 1); requirements?.state.recheck(); }}><Icon name="refresh" size={16}/></button>
      </header>
      {requirements && <ToolRequirement tool="latex" {...requirements} showRecheck={false}/>}
      {busy ? <p role="status" className="settings-intro">{t('Detecting LaTeX installation…')}</p>
        : failed ? <p role="alert" className="settings-intro">{t('Could not read the LaTeX installation. Try again.')}</p>
        : installation ? <dl className="latex-installation-facts">
          {!installation.distribution && <div><dt>{t('Distribution')}</dt><dd>{t('Unknown')}</dd></div>}
          <div><dt>{t('Version')}</dt><dd>{installation.version || t('Unknown')}</dd></div>
          <div><dt>{t('Installation location')}</dt><dd><code>{installation.path}</code></dd></div>
        </dl> : <p role="status" className="settings-intro">{t('No LaTeX installation was detected on this host.')}</p>}
    </section>
  </div>;
}
