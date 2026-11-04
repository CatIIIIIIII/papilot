import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentDirs, findExecutable, agentPath } from '../bin/agent-paths.mjs';
import { activeInstallation } from '../bin/installation.mjs';
import { Updates } from '../src/server/updates.ts';

test('agent discovery uses PATH before Nix profiles and preserves wrappers', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-nix-path-'));
  try {
    const env = { HOME: home, PATH: path.join(home, 'path'), XDG_STATE_HOME: path.join(home, 'state') };
    const profile = path.join(home, '.nix-profile/bin'); fs.mkdirSync(profile, { recursive: true });
    const wrapper = path.join(profile, 'test-agent'); fs.writeFileSync(wrapper, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    assert.equal(findExecutable('test-agent', env), wrapper);
    assert.ok(agentDirs(env).includes(path.join(home, 'state/nix/profile/bin')));
    assert.ok(agentPath(env).startsWith(env.PATH + path.delimiter));
    fs.mkdirSync(env.PATH); fs.symlinkSync(wrapper, path.join(env.PATH, 'test-agent'));
    assert.equal(findExecutable('test-agent', env), path.join(env.PATH, 'test-agent'));
    assert.equal(findExecutable(path.join(home, 'missing'), env), null);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Nix ignores saved update layers and refuses installation or channel changes', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-nix-update-'));
  const previous = process.env.PAPILOT_INSTALL_METHOD;
  process.env.PAPILOT_INSTALL_METHOD = 'nix';
  try {
    assert.equal(activeInstallation('/nix/store/papilot', data), '/nix/store/papilot');
    const updates = new Updates({ data, version: '0.8.9', supported: true, latest: async () => { throw new Error('must not request updates'); }, root: data, port: 7274, busy: () => false, shutdown: () => {}, restart: async () => {} });
    assert.equal((await updates.check()).packageManager, 'nix');
    assert.equal(updates.snapshot().canUpdate, false);
    assert.throws(() => updates.install('0.9.0'), /Nix/);
    assert.throws(() => updates.setChannel('dev'), /Nix/);
    updates.close();
  } finally { if (previous === undefined) delete process.env.PAPILOT_INSTALL_METHOD; else process.env.PAPILOT_INSTALL_METHOD = previous; fs.rmSync(data, { recursive: true, force: true }); }
});
