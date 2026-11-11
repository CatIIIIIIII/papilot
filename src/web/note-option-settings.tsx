import { useId, type CSSProperties } from 'react';
import { NOTE_ALTERNATIVE_RANGES, type NoteAlternativeRange } from '../shared.ts';
import { saveNoteAlternatives, useNoteAlternatives } from './note-option-preferences.ts';
import { t } from './i18n.ts';

export function NoteOptionSettings() {
  const preference = useNoteAlternatives(), description = useId();
  const choices: { id: 'off' | NoteAlternativeRange; label: string }[] = [{ id: 'off', label: t('Off') }, { id: 'few', label: t('Few') }, { id: 'balanced', label: t('Balanced') }, { id: 'many', label: t('More') }];
  const index = preference.enabled ? choices.findIndex(choice => choice.id === preference.range) : 0, [min, max] = NOTE_ALTERNATIVE_RANGES[preference.range];
  const range = preference.enabled ? t('{min}–{max} alternatives', { min, max }) : t('Off');
  const help = t('A target range, excluding the main proposal. The AI may return fewer or more useful choices. More choices take longer to prepare.');
  const centre = (step: number) => `calc(8px + ${step / 3} * (100% - 16px))`;
  const style = { '--effort-position': centre(index) } as CSSProperties;
  return <div className="settings-row settings-note-options">
    <div className="settings-text">
      <label className="settings-name" htmlFor="settings-note-alternatives">{t('Prepare alternatives for PDF notes')}</label>
      <p id="settings-note-alternatives-detail">{t('Prepared with edits. Counts exclude the main proposal and are approximate. Applies to future requests.')}</p>
    </div>
    <div className="agent-effort settings-note-count" data-effort="custom" style={style} title={help}>
      <div className="note-count-value">{preference.enabled ? range : null}</div>
      <div className={'effort-track' + (preference.enabled ? '' : ' unset')}>
        <span className="effort-fill" aria-hidden="true"/>
        {choices.map((choice, step) => step !== index && <span key={choice.id} aria-hidden="true" className={'effort-stop' + (step < index ? ' on' : '')} style={{ left: centre(step) }}/>) }
        <span className="effort-thumb" aria-hidden="true"/>
        <input id="settings-note-alternatives" type="range" min={0} max={3} step={1} value={index} aria-valuetext={preference.enabled ? `${choices[index].label} · ${range}` : range} aria-describedby={`settings-note-alternatives-detail ${description}`} onChange={event => {
          const choice = choices[Number(event.target.value)].id;
          void (choice === 'off' ? saveNoteAlternatives(false) : saveNoteAlternatives(true, choice));
        }}/>
      </div>
      <div className="effort-scale note-count-scale" aria-hidden="true">{choices.map((choice, step) => <span key={choice.id} className={step === index ? 'active' : undefined}>{choice.label}</span>)}</div>
      <span className="sr-only" id={description}>{help}</span>
    </div>
  </div>;
}
