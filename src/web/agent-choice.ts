import { AGENT_IDS, type AgentId, type RuntimeStatus } from '../shared.ts';

// Offer only reported runtimes whose installation is not known to be missing.
export function offeredAgents(runtimes: Partial<Record<AgentId, RuntimeStatus>>) {
  return AGENT_IDS.filter(id => Boolean(runtimes[id] && runtimes[id]!.installed !== false));
}
// Wait for the host's report before treating an unknown installation as absent.
export function noAgent(runtimes: Partial<Record<AgentId, RuntimeStatus>>) {
  return AGENT_IDS.every(id => runtimes[id]?.installed === false);
}
export function agentsSettled(runtimes: Partial<Record<AgentId, RuntimeStatus>>) {
  const reported = Object.values(runtimes).filter(Boolean);
  return reported.length > 0 && reported.every(runtime => runtime.connected || Boolean(runtime.error) || runtime.installed === false);
}
// Wait for startup to settle before preferring an agent ready for the first task.
export function chosenAgent(saved: AgentId | null, offered: AgentId[], runtimes: Partial<Record<AgentId, RuntimeStatus>>): AgentId {
  return saved && offered.includes(saved) ? saved
    : (agentsSettled(runtimes) && offered.find(id => runtimes[id]?.connected && runtimes[id]?.authenticated)) || offered[0] || 'codex';
}
