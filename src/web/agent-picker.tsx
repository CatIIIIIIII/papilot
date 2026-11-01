import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { AgentId, RuntimeStatus } from '../shared.ts';
import { Icon } from './icons.tsx';
import { BrandIcon } from './brand-icon.tsx';
import { t } from './i18n.ts';
import { browserStorage } from './storage.ts';
import { EffortSlider, effortName } from './effort-slider.tsx';

// The picker and an existing conversation use the same compact model label.
export function ModelLabel({ model, effort, fast }: { model: string; effort?: string | null; fast?: boolean }) {
  return <span className="agent-model-label"><span className="agent-model-name">{model}</span>{effort && <small>{effortName(effort)}</small>}{fast && <Icon name="bolt" size={13}/>}</span>;
}

export function AgentConnectionNotice({ name, runtime, reconnecting, onReconnect }: { name: string; runtime?: RuntimeStatus; reconnecting: boolean; onReconnect: () => void }) {
  if (!runtime || (runtime.connected && runtime.authenticated)) return null;
  const error = runtime.error || '', first = error.split(/:\s|\.\s/)[0];
  // An agent that was not found is not connecting: say so until it is installed and Reconnect finds it.
  const message = runtime.installed === false ? t('{agent} was not found on this computer. Install or set it up, then select Reconnect.', { agent: name })
    : error ? (first.length <= 120 ? first : t('{agent} is unavailable', { agent: name })) : t('Connecting to {agent}…', { agent: name });
  return <div className="agent-connection">
    <div className="agent-connection-message" role="status"><Icon name="alert" size={15}/><span>{message}</span></div>
    {error && error !== message && <details><summary>{t('Connection details')}</summary><p>{error}</p></details>}
    <button type="button" disabled={reconnecting} onClick={onReconnect}><Icon name="refresh" size={12}/>{reconnecting ? t('Connecting…') : t('Reconnect')}</button>
  </div>;
}

// Recent agent and model choices, newest first, shown above the full list.
const RECENT = 'papilot:recent-models';
function readRecent(): { agent: AgentId; model: string }[] {
  try { const value = JSON.parse(browserStorage.getItem(RECENT) || '[]'); return Array.isArray(value) ? value.filter(item => item && typeof item.agent === 'string' && typeof item.model === 'string').slice(0, 3) : []; } catch { return []; }
}
function remember(agent: AgentId, model: string) {
  const next = [{ agent, model }, ...readRecent().filter(item => item.agent !== agent || item.model !== model)].slice(0, 3);
  browserStorage.setItem(RECENT, JSON.stringify(next));
}

export interface AgentOption { value: AgentId; label: string; runtime?: RuntimeStatus }
interface Choice { key: string; agent: AgentOption; model: string; name: string; isDefault: boolean; recent: boolean }

// An agent's state when it cannot be used yet, shown beside its name.
function agentState(runtime?: RuntimeStatus) {
  if (runtime?.installed === false) return t('Not found');
  if (!runtime || (!runtime.connected && !runtime.error)) return t('Connecting…');
  if (!runtime.connected) return t('Unavailable');
  return runtime.authenticated ? '' : t('Sign-in required');
}

// One compact trigger opens a searchable list of every agent's models,
// grouped by agent with recent choices first, so one choice sets both. The
// selected model's reasoning effort and fast mode sit below the list. Native
// popovers keep the menu above the PDF and scrolling panels, with
// outside-click and Escape dismissal.
export function AgentPicker({ agents, agent, model, effort, fast, reconnecting, onReconnect, onSelect, onChange, disabled, description }: {
  agents: AgentOption[]; agent: AgentId; model: string; effort: string; fast: boolean;
  reconnecting: boolean; onReconnect: () => void;
  onSelect: (agent: AgentId, model: string) => void; onChange: (change: Partial<{ effort: string; fast: boolean }>) => void; disabled?: boolean; description?: string;
}) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [active, setActive] = useState(''), [recent, setRecent] = useState(readRecent);
  const current = agents.find(item => item.value === agent) || agents[0];
  const runtime = current?.runtime, models = runtime?.models || [];
  const selected = model ? models.find(item => item.id === model) : models.find(item => item.isDefault);
  const agentName = current?.label || agent;
  const modelName = selected?.name || model || agentName;
  const currentEffort = effort || selected?.defaultEffort;
  const fastMode = agent === 'codex' ? selected?.fastMode : undefined;
  const disconnected = runtime && (!runtime.connected || !runtime.authenticated);
  const summary = [agentName, modelName, currentEffort ? effortName(currentEffort) : '', fastMode && fast ? t('Fast') : ''].filter((part, index, all) => part && all.indexOf(part) === index).join(' · ');
  // Every model of every agent; an agent without a model list offers its default.
  const choices = (option: AgentOption): Choice[] => {
    const list = option.runtime?.models || [];
    return list.length ? list.map(item => ({ key: `${option.value}\n${item.id}`, agent: option, model: item.id, name: item.name, isDefault: item.isDefault, recent: false }))
      : [{ key: `${option.value}\n`, agent: option, model: '', name: t('Default model'), isDefault: false, recent: false }];
  };
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = (choice: Choice) => terms.every(term => `${choice.agent.label} ${choice.name} ${choice.model}`.toLocaleLowerCase().includes(term));
  const groups = agents.map(option => ({ option, items: choices(option).filter(matches) })).filter(group => group.items.length);
  const recentItems = terms.length ? [] : recent.flatMap(item => {
    const option = agents.find(candidate => candidate.value === item.agent);
    const found = option && choices(option).find(choice => choice.model === item.model);
    return found ? [{ ...found, key: `recent\n${found.key}`, recent: true }] : [];
  });
  const visible = [...recentItems, ...groups.flatMap(group => group.items)];
  const isSelected = (choice: Choice) => choice.agent.value === agent && (choice.model === model || (!model && (choice.isDefault || choice.model === '')));
  function position() {
    const box = panel.current!, rect = trigger.current!.getBoundingClientRect();
    box.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - box.offsetWidth - 8))}px`;
    const below = rect.bottom + 6, above = rect.top - box.offsetHeight - 6;
    box.style.top = `${Math.max(8, Math.min(below + box.offsetHeight > window.innerHeight - 8 && above >= 8 ? above : below, window.innerHeight - box.offsetHeight - 8))}px`;
  }
  useLayoutEffect(() => { if (open) position(); }, [open, agent, model, selected]);
  useEffect(() => {
    if (!open) return;
    const dismiss = () => panel.current?.hidePopover();
    const scroll = (event: Event) => { if (event.target instanceof Node && event.target.contains(trigger.current) && !panel.current?.contains(event.target)) dismiss(); };
    const observer = new ResizeObserver(() => { if (panel.current?.matches(':popover-open')) position(); });
    if (panel.current) observer.observe(panel.current);
    window.addEventListener('resize', dismiss); document.addEventListener('scroll', scroll, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', dismiss); document.removeEventListener('scroll', scroll, true); };
  }, [open]);
  useEffect(() => { if (disabled) panel.current?.hidePopover(); }, [disabled]);
  // Keep the active option in view while moving through the list with the keyboard.
  useEffect(() => { if (open && active) list.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(active)}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active, open]);
  function show() {
    setQuery(''); setRecent(readRecent());
    panel.current?.showPopover(); position(); setOpen(true);
    const chosen = visible.find(isSelected);
    setActive(chosen?.key || visible[0]?.key || '');
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }));
    // Typing filters right away; on a touch screen the keyboard would cover the list, so search waits for a tap.
    if (!window.matchMedia('(pointer: coarse)').matches) search.current?.focus();
  }
  function choose(choice: Choice) {
    onSelect(choice.agent.value, choice.model);
    remember(choice.agent.value, choice.model);
    setActive(choice.key);
  }
  function move(step: number) {
    if (!visible.length) return;
    const index = visible.findIndex(choice => choice.key === active);
    setActive(visible[(index + step + visible.length) % visible.length].key);
  }
  const renderChoice = (choice: Choice) => {
    const chosen = isSelected(choice), state = agentState(choice.agent.runtime);
    return <div key={choice.key} id={`${id}-${choice.key.replace(/\W/g, '_')}`} data-key={choice.key} role="option" aria-selected={chosen} aria-label={`${choice.name} · ${choice.agent.label}`}
      className={'model-option' + (choice.key === active ? ' active' : '')} onPointerMove={() => setActive(choice.key)} onClick={() => choose(choice)}>
      {choice.recent && <BrandIcon name={choice.agent.value} size={15}/>}<span className="model-option-name">{choice.name}</span>
      {choice.isDefault && !choice.recent && <small className="model-option-tag">{t('Default')}</small>}
      {(choice.recent || state) && <small className={'model-option-agent' + (state ? ' warn' : '')}>{choice.recent ? choice.agent.label : state}</small>}
      {chosen && <Icon name="check" size={14}/>}
    </div>;
  };
  const activeChoice = visible.find(choice => choice.key === active);
  return <span className="agent-picker">
    <button ref={trigger} type="button" className="agent-picker-trigger" aria-label={t('Agent settings')} title={summary + (disconnected ? ` · ${t('{agent} is unavailable', { agent: agentName })}` : '')} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} disabled={disabled}
      onClick={() => panel.current?.matches(':popover-open') ? panel.current.hidePopover() : show()}
      onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); show(); } }}>
      <BrandIcon name={agent} size={15}/>{modelName !== agentName && <span className="agent-picker-agent">{agentName}</span>}<ModelLabel model={modelName} effort={currentEffort} fast={Boolean(fastMode && fast)}/><Icon name="chevronDown" size={13}/>{disconnected && <span className="agent-status-mark"><Icon name="alert" size={13}/></span>}
    </button>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label={t('Agent settings')} className="agent-picker-panel" onToggle={event => {
      const shown = (event.nativeEvent as ToggleEvent).newState === 'open'; setOpen(shown);
      if (!shown && (!document.activeElement || document.activeElement === document.body || panel.current?.contains(document.activeElement))) trigger.current?.focus();
    }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); panel.current?.hidePopover(); trigger.current?.focus(); } }}>
      <label className="model-search"><Icon name="search" size={14}/>
        <input ref={search} type="search" value={query} placeholder={t('Search models')} aria-label={t('Search models')} role="combobox" aria-expanded="true" aria-controls={`${id}-list`} aria-autocomplete="list"
          aria-activedescendant={activeChoice ? `${id}-${activeChoice.key.replace(/\W/g, '_')}` : undefined}
          onChange={event => { setQuery(event.target.value); const terms = event.target.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean); const first = agents.flatMap(choices).find(choice => terms.every(term => `${choice.agent.label} ${choice.name} ${choice.model}`.toLocaleLowerCase().includes(term))); setActive(first?.key || ''); }}
          onKeyDown={event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); move(event.key === 'ArrowDown' ? 1 : -1); }
            else if (event.key === 'Enter' && activeChoice) { event.preventDefault(); choose(activeChoice); }
          }}/>
      </label>
      <div ref={list} id={`${id}-list`} role="listbox" aria-label={t('Models')} className="model-list">
        {recentItems.length > 0 && <div role="group" aria-label={t('Recent')} className="model-group"><div className="model-group-head" aria-hidden="true">{t('Recent')}</div>{recentItems.map(renderChoice)}</div>}
        {groups.map(group => <div key={group.option.value} role="group" aria-label={group.option.label} className="model-group">
          <div className="model-group-head" aria-hidden="true"><BrandIcon name={group.option.value} size={15}/>{group.option.label}</div>
          {group.items.map(renderChoice)}
        </div>)}
        {!visible.length && <p className="model-empty">{t('No models match “{query}”', { query: query.trim() })}</p>}
      </div>
      <AgentConnectionNotice key={agent} name={agentName} runtime={runtime} reconnecting={reconnecting} onReconnect={onReconnect}/>
      {description && <p className="effort-description">{description}</p>}
      {selected?.efforts.length ? <EffortSlider efforts={selected.efforts} value={effort} fallback={selected.defaultEffort} onChange={value => onChange({ effort: value })}/> : null}
      {fastMode && <label className="agent-fast"><span><strong><Icon name="bolt" size={14}/>{t('Fast mode')}</strong><small>{fastMode.description || t('Faster responses; may use more of your limit.')}</small></span><input type="checkbox" role="switch" aria-label={t('Fast mode')} checked={fast} onChange={event => onChange({ fast: event.target.checked })}/></label>}
    </div>
  </span>;
}
