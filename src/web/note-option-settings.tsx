import { useId, type CSSProperties } from 'react';
import { NOTE_ALTERNATIVE_RANGES, type NoteAlternativeRange } from '../shared.ts';
import { saveNoteAlternatives, useNoteAlternatives } from './note-option-preferences.ts';
import { t } from './i18n.ts';

export function NoteOptionSettings() {
  const preference = useNoteAlternatives(), description = useId();
  const choices: { id: NoteAlternativeRange; label: string }[] = [{ id: 'few', label: t('Few') }, { id: 'balanced', label: t('Balanced') }, { id: 'many', label: t('More') }];
  const index = choices.findIndex(choice => choice.id === preference.range), [min, max] = NOTE_ALTERNATIVE_RANGES[preference.range];
  const range = t('{min}–{max} alternatives', { min, max });
  const centre = (step: number) => `calc(15px + ${step / 2} * (100% - 30px))`;
  const style = { '--effort-position': centre(index), '--effort-fill-width': `calc(30px + ${index / 2} * (100% - 30px))` } as CSSProperties;
  return <>
    <div className="settings-row settings-toggle">
      <div className="settings-text">
        <label className="settings-name" htmlFor="settings-note-alternatives">{t('Prepare alternatives for PDF notes')}</label>
        <p id="settings-note-alternatives-detail">{t('When editing from PDF notes, prepare other wording and brief reasons alongside the main proposal. Applies to future requests.')}</p>
      </div>
      <input id="settings-note-alternatives" type="checkbox" role="switch" className="switch" aria-describedby="settings-note-alternatives-detail" checked={preference.enabled} onChange={event => void saveNoteAlternatives(event.target.checked)}/>
    </div>
    <div className="agent-effort settings-note-count" data-effort="custom" style={style} aria-disabled={!preference.enabled}>
      <div className="effort-head"><span>{t('Extra alternatives per note')}</span><strong className="effort-value" key={range}>{range}</strong></div>
      <div className="effort-track">
        <span className="effort-fill" aria-hidden="true"/>
        {choices.map((choice, step) => step !== index && <span key={choice.id} aria-hidden="true" className={'effort-stop' + (step < index ? ' on' : '')} style={{ left: centre(step) }}/>) }
        <span className="effort-thumb" aria-hidden="true"/>
        <input type="range" min={0} max={2} step={1} value={index} aria-label={t('Extra alternatives per note')} aria-valuetext={`${choices[index].label} · ${range}`} aria-describedby={description} disabled={!preference.enabled} onChange={event => void saveNoteAlternatives(preference.enabled, choices[Number(event.target.value)].id)}/>
      </div>
      <div className="effort-scale note-count-scale" aria-hidden="true">{choices.map(choice => <span key={choice.id}>{choice.label}</span>)}</div>
      <p className="effort-description" id={description}>{t('A target range, excluding the main proposal. The AI may return fewer or more useful choices. More choices take longer to prepare.')}</p>
    </div>
  </>;
}
