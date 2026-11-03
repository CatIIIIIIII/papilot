import type { AgentId } from '../shared.ts';
import type { AgentOption } from './agent-picker.tsx';
import { ChipSelect } from './chip-select.tsx';
import { EffortSlider } from './effort-slider.tsx';
import { t } from './i18n.ts';

export interface ModelDefaultSettingsProps {
  agents: AgentOption[];
  agent: AgentId;
  model: string;
  effort: string;
  onSelect: (agent: AgentId, model: string) => void;
  onEffort: (effort: string) => void;
}

// Use the same catalog and saved choices as the new-task composer.
export function ModelDefaultSettings({ agents, agent, model, effort, onSelect, onEffort }: ModelDefaultSettingsProps) {
  const groups = agents.map(option => ({
    ...option,
    choices: [
      { id: '', name: t('Model default') },
      ...(option.runtime?.models || []),
      ...(option.value === agent && model && !option.runtime?.models.some(item => item.id === model) ? [{ id: model, name: model }] : []),
    ],
  }));
  const current = groups.find(item => item.value === agent);
  const models = current?.runtime?.models || [];
  const selected = models.find(item => item.id === model) || models.find(item => item.isDefault);
  const label = `${current?.label || agent} · ${current?.choices.find(item => item.id === model)?.name || t('Model default')}`;
  const value = JSON.stringify([agent, model]);
  return <>
    <div className="settings-row settings-choice">
      <div className="settings-text"><span className="settings-name">{t('Default model')}</span><p>{t('Used for new tasks. Saved in this browser.')}</p></div>
      <ChipSelect className="settings-model-select" label={t('Default model')} display={label} value={value} options={groups.flatMap(group => group.choices.map(item => ({ value: JSON.stringify([group.value, item.id]), label: item.name, group: group.label })))} onChange={chosen => {
        for (const group of groups) {
          const choice = group.choices.find(item => JSON.stringify([group.value, item.id]) === chosen);
          if (choice) { onSelect(group.value, choice.id); break; }
        }
      }}/>
    </div>
    <div className="settings-row settings-effort">
      {selected?.efforts.length ? <EffortSlider efforts={selected.efforts} value={effort} fallback={selected.defaultEffort} onChange={onEffort}
        label={t('Default reasoning effort')} description={t('Available levels depend on the selected model.')}/>
        : <div className="settings-text"><span className="settings-name">{t('Default reasoning effort')}</span><p>{t('This model uses its own reasoning settings.')}</p></div>}
    </div>
  </>;
}
