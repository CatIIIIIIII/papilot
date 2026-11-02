import { useEffect, useState, type ReactNode } from 'react';
import info from 'virtual:papilot-info';
import type { LicenseNotice } from '../license-info.ts';
import { Icon } from './icons.tsx';
import { t } from './i18n.ts';
import logo from './logo.svg';
import { versionLabel } from './update-notice.tsx';
import './settings.css';

export function SettingsLink({ href, icon, title, detail }: { href: string; icon: string; title: string; detail?: string }) {
  return <a className="settings-navigation-row settings-resource" href={href} target="_blank" rel="noopener noreferrer">
    <Icon name={icon} size={18}/><span><strong>{title}</strong>{detail && <small>{detail}</small>}</span><Icon name="external" size={14}/><span className="sr-only">{t('Opens in a new tab')}</span>
  </a>;
}

export function AboutSettings({ onLicenses }: { onLicenses: () => void }) {
  return <div className="about-settings settings-page">
    <section className="settings-card settings-card-body">
    <div className="settings-product">
      <img src={logo} width="52" height="52" alt=""/>
      <div><div className="settings-product-name">Papilot <span className="settings-version" title={info.version}>v{versionLabel(info.version)}</span></div><p>{t('A workspace for your papers.')}</p></div>
    </div>
    <p className="settings-intro">{t('Read, annotate, and revise your papers with AI, all in one place.')}</p>
    </section>
    <section className="settings-card settings-resources">
      <SettingsLink href={info.repository} icon="github" title={t('GitHub repository')} detail={new URL(info.repository).pathname.slice(1)}/>
      <SettingsLink href={info.issues} icon="chat" title={t('Feedback & issues')} detail={t('Report a bug or suggest an improvement.')}/>
      <SettingsLink href={`${info.repository}/blob/main/docs/guide.md`} icon="paper" title={t('User guide')} detail={t('Get started and make Papilot your own.')}/>
      <SettingsLink href={`${info.repository}/blob/main/CHANGELOG.md`} icon="restore" title={t('Changelog')} detail={t('See what changed in each release.')}/>
      <SettingsLink href={`${info.repository}/blob/main/.github/CONTRIBUTING.md`} icon="people" title={t('Contribute')} detail={t('Help improve Papilot with code, docs, and ideas.')}/>
    </section>
    <section>
    <h3 className="settings-section-title">{t('Licenses & acknowledgments')}</h3>
    <div className="settings-card">
    <details className="settings-project-license">
      <summary><span>{t('Papilot license')}</span><span className="settings-license-badge">{info.license}</span><Icon name="chevronDown" size={15}/></summary>
      <pre tabIndex={0} aria-label={t('Papilot license')}>{info.licenseText}</pre>
    </details>
    <button type="button" className="settings-navigation-row settings-resource" data-settings-page="licenses" onClick={onLicenses}>
      <Icon name="code" size={18}/><span><strong>{t('Third-party licenses')}</strong><small>{t('Libraries, fonts, and the people behind them.')}</small></span><Icon name="chevronRight" size={15}/>
    </button>
    </div>
    </section>
    <p className="settings-credit">{t('Made by Cui Chen and the Papilot contributors.')}</p>
  </div>;
}

export function LicenseSettings() {
  const [notices, setNotices] = useState<LicenseNotice[] | null>(null), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState('');
  useEffect(() => {
    let active = true;
    setFailed(false);
    void import('virtual:papilot-licenses').then(module => { if (active) setNotices(module.default); }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [attempt]);
  const search = query.trim().toLowerCase();
  const matches = notices?.filter(item => `${item.name} ${item.version} ${item.license}`.toLowerCase().includes(search));
  let content: ReactNode;
  if (failed) content = <div role="alert" className="settings-license-error"><p>{t('Could not load the license notices.')}</p><button className="button secondary" onClick={() => setAttempt(value => value + 1)}>{t('Retry')}</button></div>;
  else if (!matches) content = <p role="status" className="muted">{t('Loading license notices…')}</p>;
  else content = <>
    <p role="status" className="settings-license-count">{t('{shown} of {total} components', { shown: matches.length, total: notices!.length })}</p>
    {matches.length ? <div className="settings-license-list settings-card">{matches.map(item => <details key={`${item.name}@${item.version}`} className="settings-license-item">
      <summary><span className="settings-license-component"><strong>{item.name}</strong>{item.version && <small>v{item.version}</small>}</span><span className="settings-license-badge">{item.license || t('See license notice')}</span><Icon name="chevronDown" size={15}/></summary>
      <div className="settings-license-body">
        <a href={item.url} target="_blank" rel="noopener noreferrer">{t('Component source')}<Icon name="external" size={13}/><span className="sr-only">{t('Opens in a new tab')}</span></a>
        {item.notices.length ? item.notices.map(notice => <div key={notice.name}><h4>{notice.name}</h4><pre tabIndex={0} aria-label={`${item.name} — ${notice.name}`}>{notice.text}</pre></div>) : <p className="muted">{t('License text is not included in this package. See the component source for its terms.')}</p>}
      </div>
    </details>)}</div> : <p className="settings-license-empty">{t('No components match your search.')}</p>}
  </>;
  return <div className="license-settings settings-page">
    <p className="settings-intro">{t('Libraries and fonts used by Papilot and its review engine. Each component is covered by its own license.')}</p>
    <label className="settings-license-search"><Icon name="search" size={17}/><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('Search components or licenses…')} aria-label={t('Search components or licenses')}/></label>
    {content}
  </div>;
}
