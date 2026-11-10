import test from 'node:test';
import assert from 'node:assert/strict';
import { agentsSettled, chosenAgent, noAgent, offeredAgents } from '../src/web/agent-choice.ts';
import { AGENT_IDS, type RuntimeStatus } from '../src/shared.ts';

const runtime = (installed?: boolean): RuntimeStatus => ({ connected: false, authenticated: false, account: null, error: null, models: [], ...(installed === undefined ? {} : { installed }) });

test('a desktop host without Codex offers and picks the agents it has', () => {
  assert.deepEqual(offeredAgents({}), [], 'agents are offered only after the host reports on them');
  assert.deepEqual(offeredAgents({ codex: runtime() }), ['codex'], 'older servers report only the Codex runtime');
  for (const id of AGENT_IDS) assert.deepEqual(offeredAgents({ [id]: runtime() }), [id]);
  assert.deepEqual(offeredAgents({ codex: runtime(), claude: runtime(false) }), ['codex']);
  const runtimes = { codex: runtime(false), claude: runtime(true), kimi: runtime(false) };
  const noCodex = offeredAgents(runtimes);
  assert.deepEqual(noCodex, ['claude']);
  assert.equal(chosenAgent('codex', noCodex, runtimes), 'claude', 'a first task does not go to a missing Codex');
  const onlyCodex = { codex: runtime(true), kimi: runtime(false) };
  assert.equal(chosenAgent('kimi', offeredAgents(onlyCodex), onlyCodex), 'codex');
  assert.equal(chosenAgent('claude', ['codex', 'claude'], runtimes), 'claude');
  assert.equal(chosenAgent('claude', [], runtimes), 'codex', 'the internal fallback does not overwrite the saved choice');
});

test('automatic agent choice waits for every reported runtime to settle', () => {
  const ready = { ...runtime(true), connected: true, authenticated: true };
  const runtimes = { codex: runtime(true), claude: ready, kimi: runtime(false) };
  const offered = offeredAgents(runtimes);
  assert.equal(agentsSettled({}), false);
  assert.equal(agentsSettled(runtimes), false);
  assert.equal(chosenAgent(null, offered, runtimes), 'codex', 'another ready agent does not change the choice during startup');
  assert.equal(chosenAgent(null, ['claude', 'codex'], runtimes), 'claude', 'startup follows the offered order');
  assert.equal(chosenAgent(null, [], {}), 'codex');
  assert.equal(chosenAgent('claude', offered, runtimes), 'claude', 'a saved choice wins during startup');
  assert.equal(agentsSettled({ codex: runtime(false) }), true, 'missing installations have settled');
  assert.equal(agentsSettled({ codex: { ...runtime(true), connected: true } }), true, 'authentication is not required to settle');
});

test('once settled, the first connected and authenticated agent is chosen unless a choice is saved', () => {
  const ready = { ...runtime(true), connected: true, authenticated: true };
  const runtimes = { codex: { ...runtime(true), error: 'Failed to start' }, claude: ready, kimi: ready };
  const offered = offeredAgents(runtimes);
  assert.equal(agentsSettled(runtimes), true);
  assert.equal(chosenAgent(null, offered, runtimes), 'claude', 'a fresh install skips a broken Codex');
  assert.equal(chosenAgent('codex', offered, runtimes), 'codex', 'an explicit choice wins even when it is not ready');
  assert.equal(chosenAgent('grok', offered, runtimes), 'claude', 'a missing saved agent falls back to a ready one');
  const notReady = { codex: runtimes.codex, claude: { ...ready, authenticated: false } };
  assert.equal(agentsSettled(notReady), true);
  assert.equal(chosenAgent(null, ['codex', 'claude'], notReady), 'codex', 'nothing ready falls back to the first offered');
  assert.equal(chosenAgent(null, ['claude', 'codex'], notReady), 'claude', 'fallback respects the offered order');
  assert.equal(chosenAgent(null, [], runtimes), 'codex', 'only offered agents can be chosen');
  const initial = { codex: ready, claude: ready };
  const saved = chosenAgent(null, offeredAgents(initial), initial);
  assert.equal(saved, 'codex');
  assert.equal(chosenAgent(saved, offered, runtimes), 'codex', 'saving the automatic choice preserves it after a crash');
});

test('no agent is reported only after every runtime is known to be missing', () => {
  assert.equal(noAgent({}), false);
  assert.equal(noAgent({ codex: runtime(false) }), false, 'unreported runtimes are still unknown');
  const runtimes = Object.fromEntries(AGENT_IDS.map(id => [id, runtime(false)]));
  assert.deepEqual(offeredAgents(runtimes), []);
  assert.equal(noAgent(runtimes), true);
  assert.equal(noAgent({ ...runtimes, claude: runtime() }), false, 'an unknown installation is not absent');
  assert.equal(noAgent({ ...runtimes, claude: runtime(true) }), false);
  assert.deepEqual(offeredAgents({ ...runtimes, claude: runtime(true) }), ['claude']);
});
