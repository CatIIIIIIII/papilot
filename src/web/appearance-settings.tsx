import { useState, type CSSProperties } from 'react';
import { ACCENTS, DEFAULT_APPEARANCE, PRESETS, appearanceColors, appearanceVariables, hexColor, type AccentId, type Appearance, type ColorMode, type PresetId } from './appearance.ts';
import { ChipSelect } from './chip-select.tsx';
import { Icon } from './icons.tsx';
import { t } from './i18n.ts';
import type { Theme } from './theme.tsx';
import './appearance-settings.css';

export type AppearanceSettingsProps = { theme: Theme; onTheme: (theme: Theme) => void; resolved: ColorMode; appearance: Appearance; onAppearance: (appearance: Appearance) => void };

function MiniWorkspace({ appearance, mode }: { appearance: Appearance; mode: ColorMode }) {
  return <span className="appearance-mini" style={appearanceVariables(appearance, mode) as CSSProperties}>
    <span className="appearance-mini-sidebar"><Icon name="paper" size={10}/><i/><i/><i/></span>
    <span className="appearance-mini-page"><b/><i/><i/><i/><em/><i/><i/></span>
    <span className="appearance-mini-chat"><b/><i/><i/><em/><i/><span/></span>
  </span>;
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const invalid = draft !== null && !hexColor(draft);
  function commit() {
    const color = hexColor(draft);
    if (color) onChange(color);
    if (!invalid) setDraft(null);
  }
  return <div className="appearance-color-field">
    <div className="appearance-color-chip">
      <label className="appearance-swatch" style={{ background: value }} title={t('Choose {color} color', { color: label })}>
        <input type="color" aria-label={t('Choose {color} color', { color: label })} value={value} onChange={event => { setDraft(null); onChange(event.target.value); }}/>
      </label>
      <input className="appearance-hex" aria-label={label} aria-invalid={invalid || undefined} aria-describedby={invalid ? `appearance-${label}-error` : undefined} spellCheck={false} autoComplete="off" maxLength={7} value={draft ?? value.toUpperCase()} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); commit(); }
        if (event.key === 'Escape' && draft !== null) { event.preventDefault(); event.stopPropagation(); setDraft(null); }
      }}/>
    </div>
    {invalid && <small id={`appearance-${label}-error`} className="appearance-color-error">{t('Use a hex color, like #2563EB.')}</small>}
  </div>;
}

export function AppearanceSettings({ theme, onTheme, resolved, appearance, onAppearance }: AppearanceSettingsProps) {
  const colors = appearanceColors(appearance, resolved);
  const customized = Object.values(appearance.colors).some(colors => colors.background || colors.foreground);
  // Each theme shows its surface and accent in the current mode; each accent its color.
  const themeSwatch = (id: PresetId) => `linear-gradient(135deg, ${PRESETS[id][resolved].background} 50%, ${PRESETS[id][resolved].accent} 50%)`;
  const presets = [{ value: 'papilot', label: 'Papilot', swatch: themeSwatch('papilot') }, { value: 'paper', label: t('Paper'), swatch: themeSwatch('paper') }, { value: 'slate', label: t('Slate'), swatch: themeSwatch('slate') }];
  const accents = [{ value: 'default', label: t('Default'), swatch: PRESETS[appearance.preset][resolved].accent }, { value: 'blue', label: t('Slate blue'), swatch: ACCENTS.blue }, { value: 'graphite', label: t('Graphite'), swatch: ACCENTS.graphite }, { value: 'stone', label: t('Stone'), swatch: ACCENTS.stone }];
  const changeColor = (name: 'background' | 'foreground', value: string) => onAppearance({ ...appearance, colors: { ...appearance.colors, [resolved]: { ...appearance.colors[resolved], [name]: value } } });
  return <div className="settings-page appearance-settings">
    <section aria-labelledby="appearance-visual-style">
      <h3 className="settings-section-title" id="appearance-visual-style">{t('Visual style')}</h3>
      <div className="settings-card appearance-mode-card">
        <div className="settings-row">
          <span className="settings-name" id="appearance-mode">{t('Mode')}</span>
          <div className="appearance-modes" role="radiogroup" aria-labelledby="appearance-mode">
            {(['system', 'light', 'dark'] as const).map(mode => <label className="appearance-mode" key={mode}>
              <input type="radio" name="theme" value={mode} checked={theme === mode} onChange={() => onTheme(mode)}/>
              <span className={`appearance-preview appearance-preview-${mode}`} aria-hidden="true">
                <MiniWorkspace appearance={appearance} mode={mode === 'system' ? 'light' : mode}/>
                {mode === 'system' && <span className="appearance-preview-half"><MiniWorkspace appearance={appearance} mode="dark"/></span>}
              </span>
              <span className="appearance-mode-label"><Icon name={mode === 'system' ? 'monitor' : mode === 'light' ? 'sun' : 'moon'} size={13}/>{mode === 'system' ? t('System') : mode === 'light' ? t('Light') : t('Dark')}</span>
            </label>)}
          </div>
        </div>
      </div>
      <div className="settings-card appearance-colors-card">
        <div className="settings-row">
          <span className="settings-name">{t('Theme')}</span>
          <div className="appearance-theme-controls">
            {customized && <span className="appearance-customized">{t('Customized')}</span>}
            <span className="appearance-theme-picker"><ChipSelect label={t('Theme')} value={appearance.preset} options={presets} onChange={value => onAppearance({ ...appearance, preset: value as PresetId, accent: 'default', colors: { light: {}, dark: {} } })}/></span>
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-name">{t('Accent')}</span>
          <span className="appearance-accent-picker"><ChipSelect label={t('Accent')} value={appearance.accent} options={accents} onChange={value => onAppearance({ ...appearance, accent: value as AccentId })}/></span>
        </div>
        <div className="settings-row"><span className="settings-name">{t('Background')}</span><ColorField key={`background-${resolved}-${appearance.preset}`} label={t('Background')} value={colors.background} onChange={value => changeColor('background', value)}/></div>
        <div className="settings-row"><span className="settings-name">{t('Foreground')}</span><ColorField key={`foreground-${resolved}-${appearance.preset}`} label={t('Foreground')} value={colors.foreground} onChange={value => changeColor('foreground', value)}/></div>
      </div>
      <p className="appearance-hint">{resolved === 'light' ? t('Editing light mode colors. Changes are saved automatically.') : t('Editing dark mode colors. Changes are saved automatically.')}</p>
    </section>
    <details className="appearance-advanced">
      <summary>{t('Advanced')}<Icon name="chevronRight" size={15}/></summary>
      <div className="settings-card">
        <div className="settings-row settings-choice"><div className="settings-text"><span className="settings-name">{t('PDF appearance')}</span><p>{t('Choose how paper pages look in dark mode.')}</p></div><ChipSelect label={t('PDF appearance')} value={appearance.pdf} options={[{ value: 'theme', label: t('Follow mode') }, { value: 'light', label: t('Always light') }]} onChange={value => onAppearance({ ...appearance, pdf: value as Appearance['pdf'] })}/></div>
      </div>
    </details>
    <button type="button" className="appearance-reset" onClick={() => { onAppearance(DEFAULT_APPEARANCE); onTheme('system'); }}><Icon name="restore" size={15}/>{t('Reset appearance')}</button>
  </div>;
}
