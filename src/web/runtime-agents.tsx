import { useEffect, useRef, useState } from 'react';
import { AGENT_IDS, AGENT_NAMES, type AgentId, type DiagnosticReport, type RuntimeStatus } from '../shared.ts';
import info from 'virtual:papilot-info';
import { BrandIcon } from './brand-icon.tsx';
import { Icon } from './icons.tsx';
import { t } from './i18n.ts';
import { UsageSummary } from './usage.tsx';
import { agentSetup } from './agent-setup.ts';
import { RuntimeModels } from './runtime-models.tsx';
import { ActionMenu } from './action-menu.tsx';
import { RuntimeCardGrid } from './runtime-card-grid.tsx';

function connectionInfo(id: AgentId) {
  const descriptions = {
    codex: t('Uses a compatible local Codex CLI. Papilot installs its own copy when needed.'),
    claude: t('Uses Claude Code when installed, or the Claude Agent SDK with API credentials.'),
    cursor: t('Uses the Cursor SDK with CURSOR_API_KEY. Papilot installs the SDK on first use.'),
    grok: t('Uses Grok Build CLI through ACP with its saved login or configured API credentials.'),
    copilot: t('Uses GitHub Copilot CLI and its saved login or configured provider through ACP.'),
    antigravity: t('Uses the local Antigravity CLI and its saved Google login.'),
    kimi: t('Uses Kimi Code CLI and its saved login through ACP.'),
    glm: t('Uses Claude Code or the Claude Agent SDK with ZHIPU_API_KEY or ZAI_API_KEY.'),
    deepseek: t('Uses DeepSeek Harness and the providers configured in dsh.'),
    qwen: t('Uses Qwen Code and its saved login through ACP.'),
    opencode: t('Uses OpenCode with the providers and models you have connected.'),
  };
  const commands = { codex: 'papilot codex login', claude: 'claude auth login', cursor: 'CURSOR_API_KEY', copilot: 'copilot login', grok: 'grok login', antigravity: 'agy', kimi: 'kimi login', glm: 'ZHIPU_API_KEY / ZAI_API_KEY', deepseek: 'dsh web', qwen: 'qwen', opencode: 'opencode auth login' };
  return { description: descriptions[id], command: commands[id], key: id === 'cursor' || id === 'glm' };
}

// A disconnected host cannot confirm availability or current account usage.
function agentAvailability(online: boolean, runtime?: RuntimeStatus) {
  if (!online || !runtime) return 'unknown';
  if (runtime.installed === false) return 'missing';
  if (runtime.connected) return runtime.authenticated ? runtime.usage?.reached ? 'limited' : 'ready' : 'signin';
  return runtime.error ? 'unavailable' : 'connecting';
}

export function RuntimeAgents({ online, runtimes, report, busy, checkFailed, checkAgain, reconnect }: { online: boolean; runtimes: Partial<Record<AgentId, RuntimeStatus>>; report: DiagnosticReport | null; busy: boolean; checkFailed: boolean; checkAgain: () => void; reconnect: () => Promise<void> }) {
  const [selected, setSelected] = useState<AgentId | null>(null);
  const cards = useRef<Partial<Record<AgentId, HTMLButtonElement | null>>>({});
  const [reconnecting, setReconnecting] = useState(false), [reconnectError, setReconnectError] = useState(false);
  const labels = { ready: t('Ready'), limited: t('Limit reached'), missing: t('Not detected'), signin: t('Sign-in required'), connecting: t('Connecting…'), unavailable: t('Unavailable'), unknown: t('Unknown') };
  const icons = { ready: 'check', limited: 'alert', missing: 'minus', signin: 'key', connecting: 'refresh', unavailable: 'alert', unknown: 'minus' };
  useEffect(() => { setReconnectError(false); }, [selected]);
  const close = () => { if (selected) cards.current[selected]?.focus(); setSelected(null); };
  const runtime = selected ? runtimes[selected] : undefined;
  const state = agentAvailability(online, runtime);
  const setup = selected ? connectionInfo(selected) : null;
  const checked = report?.checks.find(item => item.id === `agent.${selected}`);
  const current = online && runtime?.connected && runtime.authenticated;
  const blocked = state === 'missing' || state === 'signin' || state === 'unavailable';
  const guidance = selected ? agentSetup(selected) : null;
  async function retry() {
    if (reconnecting) return;
    setReconnecting(true); setReconnectError(false);
    try { await reconnect(); } catch { setReconnectError(true); } finally { setReconnecting(false); }
  }
  const agents = AGENT_IDS.map(id => {
    const availability = agentAvailability(online, runtimes[id]);
    return { id, availability, active: availability === 'ready' || availability === 'limited' } as const;
  }).sort((a, b) => Number(b.active) - Number(a.active));
  const tiles = [
    ...agents.map(({ id, availability }) => {
        return <li key={id} className="diagnostic-agent-card" data-agent={id} data-availability={availability}>
          <button type="button" className="diagnostic-agent-button" ref={element => { cards.current[id] = element; }} aria-label={t('{agent} details', { agent: AGENT_NAMES[id] })} aria-expanded={selected === id} aria-controls={selected === id ? 'runtime-agent-detail' : undefined} title={availability === 'missing' ? agentSetup(id).reason : t('View installation, account, and usage')} onClick={() => selected === id ? close() : setSelected(id)} onKeyDown={event => { if (event.key === 'Escape' && selected === id) { event.preventDefault(); event.stopPropagation(); close(); } }}>
            <div className="diagnostic-agent-heading"><BrandIcon name={id} size={28}/><h4>{AGENT_NAMES[id]}</h4></div>
            <div className="diagnostic-agent-footer"><span className={'diagnostic-availability ' + availability}><Icon name={icons[availability]} size={13}/>{labels[availability]}</span><span className="diagnostic-agent-chevron"><Icon name={selected === id ? 'chevronUp' : 'chevronDown'} size={14}/></span></div>
          </button>
        </li>;
      }),
      <li key="contribute" className="diagnostic-agent-card runtime-agent-contribute">
        <ActionMenu label={t('Support more')} className="diagnostic-agent-button" align="start" actions={[
          { label: t('Suggest an agent'), icon: 'chat', href: `${info.issues}/new?template=feature_request.yml&title=${encodeURIComponent('Agent support: ')}`, title: t('Opens in a new tab') },
          { label: t('Contribute an integration'), icon: 'code', href: `${info.repository}/compare`, title: t('Opens in a new tab') },
        ]}>
          <div className="diagnostic-agent-heading"><Icon name="plus" size={28}/><h4>{t('Support more')}</h4></div>
          <div className="diagnostic-agent-footer"><span className="diagnostic-agent-action">{t('Contribute')}<Icon name="chevronRight" size={14}/></span></div>
        </ActionMenu>
      </li>,
  ];
  const setupGuide = <a className="runtime-agent-guide" href={`${info.repository}/blob/main/docs/guide.md#agents`} target="_blank" rel="noopener noreferrer">{t('Setup guide')}<Icon name="external" size={12}/><span className="sr-only">{t('Opens in a new tab')}</span></a>;
  const drawer = selected && setup && <section className="runtime-agent-detail runtime-agent-compact settings-card settings-card-body" id="runtime-agent-detail" aria-labelledby="runtime-agent-title" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <header className="runtime-agent-header">
        <h4 id="runtime-agent-title" tabIndex={-1}>{AGENT_NAMES[selected]}</h4>
        {current && <span className="runtime-agent-account" aria-label={t('Account')}>{runtime.account || t('Signed in')}</span>}
        <button type="button" className="icon-button" aria-label={t('Close agent details')} onClick={close}><Icon name="close" size={16}/></button>
      </header>
      {blocked && guidance && <section className="runtime-agent-help" aria-label={t('Set up this agent')}>
        <p className="runtime-agent-reason" title={runtime?.error || undefined}>{state === 'missing' ? checked?.ok ? t('The latest configuration check found this agent. Reconnect to refresh its live status.') : guidance.summary : state === 'signin' ? t('Sign in on the Papilot host to continue.') : runtime?.error || t('The agent could not connect. Check its setup and try again.')}</p>
        {state === 'missing' && !checked?.ok && <p>{guidance.steps[0]}</p>}
        {!(state === 'missing' && checked?.ok) && <code className="runtime-agent-command">{setup.command}</code>}
        <div className="runtime-setup-actions"><button type="button" className="button secondary compact" disabled={!online || reconnecting} onClick={() => void retry()}><Icon name="refresh" size={13}/>{reconnecting ? t('Connecting…') : t('Reconnect')}</button>{setupGuide}</div>
        {reconnectError && <p role="alert">{t('Could not reconnect. Check the server connection and try again.')}</p>}
      </section>}
      {current ? <div className="runtime-agent-overview">
        <RuntimeModels key={selected} models={runtime.models} connected/>
        <section className="runtime-agent-usage">
          <h5>{t('Usage & limits')}</h5>
          {runtime.usage ? <UsageSummary usage={runtime.usage} agent={AGENT_NAMES[selected]} expanded/> : <p className="runtime-agent-note">{t('Usage not reported')}</p>}
        </section>
      </div> : !blocked && <p className="runtime-agent-note">{t('Connect to view account, models, and usage.')}</p>}
      <details key={selected + String(blocked)} className="runtime-agent-detection">
        <summary><Icon name="terminal" size={14}/><span>{t('Installation & setup')}</span><Icon name="chevronDown" size={14}/></summary>
        <div className="runtime-agent-installation">
          <p>{setup.description}</p>
          {blocked && guidance ? <>
            <p>{state === 'missing' ? guidance.reason : state === 'signin' ? t('Papilot reached this agent, but could not confirm a signed-in account on this host.') : t('Papilot could not establish a working connection to this agent. The latest connection error is shown below.')}</p>
            {runtime?.error && <p className="runtime-agent-error">{runtime.error}</p>}
            {state === 'missing' && checked?.ok ? <p>{t('If the live status still disagrees with the check, restart Papilot under the same user and environment where you configured the agent.')}</p> : state === 'signin' ? <p>{t('Sign in as the user running Papilot, then restart Papilot.')}</p> : state === 'unavailable' ? <p>{t('Check the connection error above and the agent’s login, provider, and network settings on this host. Restart Papilot after changing credentials or executable paths.')}</p> : <ol>{guidance.steps.map(step => <li key={step}>{step}</li>)}</ol>}
            <p><strong>{t('Already set up?')}</strong> {guidance.existing}</p>
          </> : <><span className="runtime-agent-caption">{setup.key ? t('Environment variable') : t('Set up on the host')}</span><code className="runtime-agent-command">{setup.command}</code></>}
          <div className="runtime-agent-check-heading"><h5>{t('Installation check')}</h5>{!busy && checked && <span className={`diagnostic-state ${checked.ok ? 'ok' : checked.severity === 'error' ? 'error' : checked.severity === 'warn' ? 'warn' : 'info'}`}>{checked.ok ? t('Passed') : checked.severity === 'error' ? t('Needs attention') : checked.severity === 'warn' ? t('Warning') : t('Not found')}</span>}</div>
          {busy ? <p role="status">{t('Checking…')}</p> : checkFailed ? <p role="alert">{t('Could not complete the environment checks. Check the connection and try again.')}</p> : checked ? <><p>{checked.detail}</p>{!checked.ok && checked.fix && <p className="diagnostic-fix"><strong>{t('Suggested fix')}</strong>{checked.fix}</p>}</> : <p>{t('No installation details were returned. Run the checks again to refresh.')}</p>}
          <div className="runtime-setup-actions"><button type="button" className="button secondary compact" disabled={busy || !online} onClick={checkAgain}><Icon name="refresh" size={13}/>{busy ? t('Checking…') : t('Check again')}</button>{!blocked && setupGuide}</div>
        </div>
      </details>
    </section>;
  const selectedIndex = agents.findIndex(agent => agent.id === selected);
  return <section aria-label={t('Agents')}>
    <RuntimeCardGrid tiles={tiles} selectedIndex={selectedIndex} drawer={drawer}/>
  </section>;
}
