import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons.tsx';
import { BrandIcon } from './brand-icon.tsx';
import logo from './logo.svg';
import { ChipSelect } from './chip-select.tsx';
import { keepDialogFocus } from './focus.ts';
import { LANGUAGES, browserLanguage, setLanguage, t, useLanguage, type LanguageChoice } from './i18n.ts';
import { NotificationSettings } from './notification-settings.tsx';
import { browserStorage } from './storage.ts';
import { saveExpandedEffects, useExpandedEffects } from './effect-preferences.ts';
import { saveDefaultReviewView, useDefaultReviewView } from './review-view.ts';
import { ModeSwitch } from './mode-switch.tsx';
import { AppearanceSettings, type AppearanceSettingsProps } from './appearance-settings.tsx';
import { ShortcutSettings } from './shortcut-settings.tsx';
import { AboutSettings, LicenseSettings } from './about-settings.tsx';
import info from 'virtual:papilot-info';
import { DiagnosticsSettings, type DiagnosticsSettingsProps } from './diagnostics-settings.tsx';
import { LatexSettings } from './latex-settings.tsx';
import { UpdateSettings, versionLabel, type UpdateApi } from './update-notice.tsx';
import { SkillLibraryPanel, type SkillLibraryControls, type SkillLibraryOptions } from './skill-library.tsx';
import { ModelDefaultSettings, type ModelDefaultSettingsProps } from './model-default-settings.tsx';
import { PeopleSettings, type PeopleSettingsProps, type PeopleSettingsControls } from './people-settings.tsx';

type SettingsPage = 'general' | 'appearance' | 'notifications' | 'review' | 'shortcuts' | 'about' | 'licenses' | 'agents' | 'latex' | 'skills' | 'people' | 'updates';
type SettingsEntry = { page: SettingsPage; label: string; icon: string; keywords?: string };

// Shared with the review page's bibliography checks.
const REFERENCE_CHECKS = 'latex-review:references';

export function SettingsDialog({ theme, onTheme, resolved, appearance, onAppearance, onClose, people, onSignOut, accountName, diagnostics, skills, updates, modelDefaults, initialPage = 'general' }: AppearanceSettingsProps & { onClose: () => void; people?: PeopleSettingsProps; onSignOut?: () => void; accountName?: string; diagnostics?: DiagnosticsSettingsProps; skills?: SkillLibraryOptions; updates?: UpdateApi; modelDefaults: ModelDefaultSettingsProps; initialPage?: 'general' | 'shortcuts' }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const peopleControls = useRef<PeopleSettingsControls>(null);
  const [peopleVisited, setPeopleVisited] = useState(false);
  const skillControls = useRef<SkillLibraryControls>(null);
  const { choice } = useLanguage();
  const expandedEffects = useExpandedEffects(), reviewView = useDefaultReviewView();
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const [showCategories, setShowCategories] = useState(() => initialPage === 'general' && window.matchMedia('(max-width: 760px)').matches);
  const [query, setQuery] = useState('');
  const [checkReferences, setCheckReferences] = useState(() => browserStorage.getItem(REFERENCE_CHECKS) !== 'off');
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal();
    return () => { element.close(); if (opener?.isConnected && opener.getClientRects().length) opener.focus(); };
  }, []);
  useEffect(() => {
    const element = dialog.current!;
    element.querySelector('.settings-content')!.scrollTop = 0;
    const target = showCategories ? element.querySelector<HTMLElement>('.settings-category[aria-current="page"]') || element.querySelector<HTMLInputElement>('.settings-search input') : element.querySelector<HTMLElement>('#settings-title');
    target?.focus();
  }, [page, showCategories]);
  function navigate(proceed: () => void) {
    if (peopleControls.current?.isBusy()) return;
    if (page === 'skills') skillControls.current?.navigate(proceed); else proceed();
  }
  function goTo(next: SettingsPage) {
    const proceed = () => { if (next === 'people') setPeopleVisited(true); setPage(next); setShowCategories(false); };
    if (next === page) proceed(); else navigate(proceed);
  }
  function browseCategories() {
    navigate(() => { setPage('general'); setShowCategories(true); });
  }
  const browserName = LANGUAGES.find(item => item.id === browserLanguage())!.name;
  const close = () => { if (peopleControls.current?.isBusy()) return; if (page === 'skills') skillControls.current?.cancel(); else navigate(onClose); };
  const groups: { label: string; entries: SettingsEntry[] }[] = [
    { label: t('Personal'), entries: [
      { page: 'general', label: t('General'), icon: 'settings', keywords: `${t('Language')} ${t('Default model')} ${t('Default reasoning effort')}` },
      { page: 'appearance', label: t('Appearance'), icon: 'sun', keywords: `${t('Light')} ${t('Dark')} ${t('System')} ${t('Theme')} ${t('Accent')} ${t('Background')} ${t('Foreground')}` },
      { page: 'notifications', label: t('Notifications'), icon: 'bell' },
      { page: 'review', label: t('Review preferences'), icon: 'diff', keywords: `${t('Open reviews on')} ${t('Check references online')} ${t('Expand indirect changes')}` },
      { page: 'shortcuts', label: t('Keyboard shortcuts'), icon: 'keyboard' },
    ] },
    { label: t('Workspace'), entries: [
      ...(skills ? [{ page: 'skills' as const, label: t('Skills'), icon: 'spark' }] : []),
      ...(people ? [{ page: 'people' as const, label: t('Sharing'), icon: 'people' }] : []),
    ] },
    { label: t('Runtime'), entries: diagnostics ? [
      { page: 'agents', label: t('Agents'), icon: 'terminal', keywords: `${t('Agent configuration')} ${t('Available models')} ${t('Usage & limits')}` },
      { page: 'latex', label: 'LaTeX', icon: 'paper', keywords: 'TeX Live MacTeX BasicTeX MiKTeX' },
    ] : [] },
    { label: t('Application'), entries: [
      ...(updates ? [{ page: 'updates' as const, label: t('Updates'), icon: 'refresh' }] : []),
      { page: 'about', label: t('About Papilot'), icon: 'info', keywords: t('Third-party licenses') },
    ] },
  ];
  const title = page === 'licenses' ? t('Third-party licenses') : groups.flatMap(group => group.entries).find(entry => entry.page === page)!.label;
  const search = query.trim().toLocaleLowerCase();
  const visibleGroups = groups.map(group => ({ ...group, entries: group.entries.filter(entry => `${group.label} ${entry.label} ${entry.keywords || ''}`.toLocaleLowerCase().includes(search)) })).filter(group => group.entries.length);
  return <dialog ref={dialog} className="modal-backdrop" aria-label={page === 'general' ? t('Settings') : title} onKeyDown={keepDialogFocus} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <section className={'modal settings-dialog' + (showCategories ? ' settings-browse' : '')}>
      <button className="modal-close icon-button" aria-label={t('Close')} onClick={close}><Icon name="close"/></button>
      <aside className="settings-sidebar">
        <h2 className="settings-sidebar-title">{t('Settings')}</h2>
        <label className="settings-search"><Icon name="search" size={17}/><input type="search" aria-label={t('Search settings')} placeholder={t('Search settings')} value={query} onChange={event => setQuery(event.target.value)}/></label>
        <nav className="settings-categories" aria-label={t('Settings categories')}>
          {visibleGroups.map(group => <section className="settings-category-group" key={group.label}>
            <h3>{group.label}</h3>
            {group.entries.map(entry => <button type="button" key={entry.label} className="settings-category" data-settings-page={entry.page} aria-current={entry.page === page || (page === 'licenses' && entry.page === 'about') ? 'page' : undefined} onClick={() => goTo(entry.page)}>
              {entry.page === 'about' ? <img src={logo} width="18" height="18" alt=""/> : entry.page === 'latex' ? <BrandIcon name={entry.page} size={18}/> : <Icon name={entry.icon} size={18}/>}<span>{entry.label}</span>
            </button>)}
          </section>)}
          {!visibleGroups.length && <p className="settings-search-empty">{t('No matching settings')}</p>}
        </nav>
        <div className="settings-sidebar-bottom">
          {onSignOut && <button type="button" className="settings-category settings-account" onClick={() => navigate(onSignOut)}><Icon name="signOut" size={18}/><span>{t('Sign out')}{accountName && <small>{accountName}</small>}</span></button>}
          <footer className="settings-footer"><span>Papilot · v{versionLabel(info.version)}</span><a href={info.repository} target="_blank" rel="noopener noreferrer" aria-label={`GitHub · ${t('Opens in a new tab')}`}><Icon name="github" size={16}/></a></footer>
        </div>
      </aside>
      <div className={`settings-content settings-content-${page}`}>
        <header className="settings-content-header">
          <button type="button" className="settings-back settings-mobile-back" onClick={browseCategories}><Icon name="chevronLeft" size={14}/>{t('Settings')}</button>
          {page === 'licenses' && <button type="button" className="settings-back" onClick={() => goTo('about')}><Icon name="chevronLeft" size={14}/>{t('About Papilot')}</button>}
          <h2 id="settings-title" tabIndex={-1}>{(page === 'latex') && <BrandIcon name={page} size={30}/>}{title}</h2>
        </header>
        {page === 'general' && <section className="settings-card">
          <div className="settings-row settings-choice">
            <div className="settings-text"><span className="settings-name">{t('Language')}</span><p>{t('Language for the Papilot interface.')}</p></div>
            <ChipSelect label={t('Language')} value={choice} onChange={value => setLanguage(value as LanguageChoice)} options={[{ value: 'system', label: t('Browser default ({language})', { language: browserName }) }, ...LANGUAGES.map(item => ({ value: item.id, label: item.name }))]}/>
          </div>
          <ModelDefaultSettings {...modelDefaults}/>
        </section>}
        {page === 'appearance' && <AppearanceSettings theme={theme} onTheme={onTheme} resolved={resolved} appearance={appearance} onAppearance={onAppearance}/>}
        {page === 'review' && <section className="settings-card">
          <div className="settings-row settings-choice">
            <div className="settings-text"><span className="settings-name">{t('Open reviews on')}</span><p>{t('Changes shows only the changed sections and opens fastest. PDF shows each change in place in the whole paper and takes longer for long papers. The switch in a review changes only that review.')}</p></div>
            <ModeSwitch labeled label={t('Open reviews on')} changesTitle={t('Changes')} mode={reviewView === 'paper' ? 'pdf' : 'changes'} onMode={mode => saveDefaultReviewView(mode === 'pdf' ? 'paper' : 'changes')}/>
          </div>
          <div className="settings-row settings-toggle">
            <div className="settings-text">
              <label className="settings-name" htmlFor="settings-references">{t('Check references online')}</label>
              <p id="settings-references-detail">{t('When a change adds or edits a bibliography entry, look up its title, authors, year and DOI in Crossref, DBLP and arXiv. Nothing else from your paper is sent.')}</p>
            </div>
            <input id="settings-references" type="checkbox" role="switch" className="switch" aria-describedby="settings-references-detail" checked={checkReferences} onChange={event => { setCheckReferences(event.target.checked); browserStorage.setItem(REFERENCE_CHECKS, event.target.checked ? 'on' : 'off'); }}/>
          </div>
          <div className="settings-row settings-toggle">
            <div className="settings-text">
              <label className="settings-name" htmlFor="settings-effects">{t('Expand indirect changes')}</label>
              <p id="settings-effects-detail">{t('Expand changes elsewhere, such as contents and reference numbering. Off by default; edits with no visible change at their source, such as macro definitions, still show their effects.')}</p>
            </div>
            <input id="settings-effects" type="checkbox" role="switch" className="switch" aria-describedby="settings-effects-detail" checked={expandedEffects} onChange={event => saveExpandedEffects(event.target.checked)}/>
          </div>
        </section>}
        {page === 'notifications' && <NotificationSettings/>}
        {page === 'shortcuts' && <ShortcutSettings/>}
        {page === 'about' && <AboutSettings onLicenses={() => goTo('licenses')}/>}
        {page === 'licenses' && <LicenseSettings/>}
        {page === 'agents' && diagnostics && <DiagnosticsSettings {...diagnostics}/>}
        {page === 'latex' && diagnostics && <LatexSettings online={diagnostics.online} load={diagnostics.latex}/>}
        {page === 'updates' && updates && <UpdateSettings api={updates}/>}
        {peopleVisited && people && <div hidden={page !== 'people'}><PeopleSettings {...people} controls={peopleControls}/></div>}
        {page === 'skills' && skills && <SkillLibraryPanel {...skills} controls={skillControls} onClose={onClose}/>}
      </div>
    </section>
  </dialog>;
}
