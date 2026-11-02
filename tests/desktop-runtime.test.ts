import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backendEnvironment, startBackend } from '../desktop/runtime.ts';
import { readJson, writeJson } from '../bin/installation.mjs';

test('desktop backend environment clears legacy npm activation settings', () => {
  const env = backendEnvironment('/runtime/bin/node', '/app/server', '/app/data', {
    PATH: '/usr/bin', PAPILOT_DESKTOP_SHELL: '1', PAPILOT_DESKTOP_INSTALLER: '0.6.0', PAPILOT_DESKTOP_CODEX: '/old/codex',
    ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', PAPILOT_PUBLIC_ORIGIN: 'https://example.com',
  });
  assert.equal(env.PAPILOT_DESKTOP, '1'); assert.equal(env.PAPILOT_DATA, '/app/data');
  assert.equal(env.PAPILOT_PUBLIC_ORIGIN, ''); assert.ok(env.PATH.startsWith('/runtime/bin'));
  for (const key of ['PAPILOT_DESKTOP_SHELL', 'PAPILOT_DESKTOP_INSTALLER', 'PAPILOT_DESKTOP_CODEX', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) assert.equal((env as NodeJS.ProcessEnv)[key], undefined);
});

test('desktop backend ignores legacy web update state and rejects install and channel requests', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-desktop-runtime-')), root = process.cwd();
  const version = readJson(path.join(root, 'package.json')).version;
  writeJson(path.join(data, 'updates/active.json'), { root: '/unwanted', version: '999.0.0', phase: 'active' });
  const saved = { phase: 'restarting', latestVersion: '999.0.0', pid: process.pid };
  writeJson(path.join(data, 'updates/status.json'), saved);
  writeJson(path.join(data, 'updates/channel.json'), { channel: 'dev' });
  const backend = startBackend({ node: process.execPath, root, data, log: path.join(data, 'server.log'),
    env: { ...backendEnvironment(process.execPath, root, data), PAPILOT_UPDATE_PROBE: '1' } });
  try {
    const url = await backend.ready, state = await (await fetch(url + '/api/state')).json();
    const status = await (await fetch(url + '/api/updates')).json();
    assert.equal(status.currentVersion, version); assert.equal(status.phase, 'idle');
    assert.equal(status.canUpdate, false); assert.equal(status.channel, 'stable');
    assert.equal(status.downloadUrl, 'https://github.com/PapilotAI/papilot/releases');
    for (const [route, body] of [['install', { version: '999.0.0' }], ['channel', { channel: 'dev' }]] as const) {
      const response = await fetch(`${url}/api/updates/${route}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: url, 'X-Papilot-Token': state.csrf }, body: JSON.stringify(body) });
      assert.equal(response.status, 400); assert.match(await response.text(), /desktop updates/);
    }
    assert.deepEqual(readJson(path.join(data, 'updates/status.json')), saved);
  } finally { await backend.stop(); fs.rmSync(data, { recursive: true, force: true }); }
});
