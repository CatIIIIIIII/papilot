import { useId, type CSSProperties } from 'react';
import { NOTE_ALTERNATIVE_RANGES, type NoteAlternativeRange } from '../shared.ts';
import { saveNoteAlternatives, useNoteAlternatives } from './note-option-preferences.ts';
import { t } from './i18n.ts';

export function NoteOptionSettings() {
  const preference = useNoteAlternatives(), description = useId();
  const choices: { id: 'off' | NoteAlternativeRange; label: string }[] = [{ id: 'off', label: t('Off') }, { id: 'few', label: t('Few') }, { id: 'balanced', label: t('Balanced') }, { id: 'many', label: t('More') }];
  const index = preference.enabled ? choices.findIndex(choice => choice.id === preference.range) : 0, [min, max] = NOTE_ALTERNATIVE_RANGES[preference.range];
  const range = preference.enabled ? t('{min}–{max} alternatives', { min, max }) : t('Off');
  const centre = (step: number) => `calc(15px + ${step / 3} * (100% - 30px))`;
  const style = { '--effort-position': centre(index), '--effort-fill-width': `calc(30px + ${index / 3} * (100% - 30px))` } as CSSProperties;
  return <>
    <div className="settings-row">
      <div className="settings-text">
        <label className="settings-name" htmlFor="settings-note-alternatives">{t('Prepare alternatives for PDF notes')}</label>
        <p id="settings-note-alternatives-detail">{t('When editing from PDF notes, prepare other wording and brief reasons alongside the main proposal. Applies to future requests.')}</p>
      </div>
    </div>
    <div className="agent-effort settings-note-count" data-effort="custom" style={style}>
      <div className="effort-head"><span>{t('Extra alternatives per note')}</span><strong className="effort-value" key={range}>{range}</strong></div>
      <div className={'effort-track' + (preference.enabled ? '' : ' unset')}>
        <span className="effort-fill" aria-hidden="true"/>
        {choices.map((choice, step) => step !== index && <span key={choice.id} aria-hidden="true" className={'effort-stop' + (step < index ? ' on' : '')} style={{ left: centre(step) }}/>) }
        <span className="effort-thumb" aria-hidden="true"/>
        <input id="settings-note-alternatives" type="range" min={0} max={3} step={1} value={index} aria-label={t('Extra alternatives per note')} aria-valuetext={preference.enabled ? `${choices[index].label} · ${range}` : range} aria-describedby={`settings-note-alternatives-detail ${description}`} onChange={event => {
          const choice = choices[Number(event.target.value)].id;
          void (choice === 'off' ? saveNoteAlternatives(false) : saveNoteAlternatives(true, choice));
        }}/>
      </div>
      <div className="effort-scale note-count-scale" aria-hidden="true">{choices.map((choice, step) => <span key={choice.id} style={{ left: centre(step) }}>{choice.label}</span>)}</div>
      <p className="effort-description" id={description}>{t('A target range, excluding the main proposal. The AI may return fewer or more useful choices. More choices take longer to prepare.')}</p>
    </div>
  </>;
}
