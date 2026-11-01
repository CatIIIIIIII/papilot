import { useEffect, useRef, useState } from 'react';
import { AGENT_NAMES, type RuntimeStatus, type Task } from '../shared.ts';
import { AgentPicker } from './agent-picker.tsx';
import { t } from './i18n.ts';

type Settings = Pick<Task, 'model' | 'effort' | 'serviceTier'>;
const settingsOf = (task: Settings): Settings => ({ model: task.model, effort: task.effort, serviceTier: task.serviceTier });

export function TaskModelPicker({ task, runtime, disabled, reconnecting, onReconnect, save, onSaving, refresh, reportError }: {
  task: Task; runtime?: RuntimeStatus; disabled: boolean; reconnecting: boolean; onReconnect: () => void;
  save: (settings: { model: string; effort: string; serviceTier?: string }) => Promise<Task>;
  onSaving: (saving: boolean) => void; refresh: () => void; reportError: (error: unknown) => void;
}) {
  const [choice, setChoice] = useState(() => settingsOf(task));
  const current = useRef(choice), saved = useRef(choice), pending = useRef(0), queue = useRef(Promise.resolve());
  useEffect(() => {
    if (pending.current) return;
    current.current = saved.current = settingsOf(task); setChoice(current.current);
  }, [task.model, task.effort, task.serviceTier]);
  const agent = task.agent || 'codex';
  function change(next: Settings) {
    current.current = next; setChoice(next); pending.current++; onSaving(true);
    // Serialize rapid slider/model changes, keeping the menu open while saving.
    queue.current = queue.current.then(async () => {
      try { saved.current = settingsOf(await save({ model: next.model || '', effort: next.effort || '', ...(agent === 'codex' ? { serviceTier: next.serviceTier || 'default' } : {}) })); }
      catch (error) { reportError(error); }
      finally {
        if (--pending.current === 0) {
          current.current = saved.current; setChoice(saved.current); onSaving(false); refresh();
        }
      }
    });
  }
  return <AgentPicker agents={[{ value: agent, label: AGENT_NAMES[agent], runtime }]} agent={agent}
    model={choice.model || ''} effort={choice.effort || ''} fast={Boolean(choice.serviceTier && choice.serviceTier !== 'default')}
    disabled={disabled} reconnecting={reconnecting} onReconnect={onReconnect} description={pending.current ? t('Saving…') : t('Changes apply to the next turn.')}
    onSelect={(_agent, id) => {
      const model = runtime?.models.find(model => model.id === id), previous = current.current;
      change({ model: id, effort: model?.efforts.includes(previous.effort || '') ? previous.effort : null,
        serviceTier: previous.serviceTier === model?.fastMode?.serviceTier ? previous.serviceTier : 'default' });
    }}
    onChange={patch => {
      const previous = current.current, model = runtime?.models.find(model => previous.model ? model.id === previous.model : model.isDefault);
      change({ ...previous, ...(patch.effort !== undefined ? { effort: patch.effort || null } : {}), ...(patch.fast !== undefined ? { serviceTier: patch.fast ? model?.fastMode?.serviceTier : 'default' } : {}) });
    }}/>;
}
