import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { serviceEnvironment } from '../src/server/service-environment.ts';

test('the service resolves tools from the installing shell and retains an explicit override on reinstall', { skip: process.platform === 'win32' && 'the background service is macOS-only' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-service-'));
  try {
    const shellTools = path.join(root, 'shell'), compatibleTools = path.join(root, 'compatible');
    for (const [directory, version] of [[shellTools, '3.14'], [compatibleTools, '3.12']]) {
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'python3'), `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
    }
    const inherited = { PATH: `${shellTools}:/usr/bin:/bin`, PAPILOT_PUBLIC_ORIGIN: 'https://host.example:8443' };
    // Homebrew can install Node and the incompatible Python in the same directory.
    const executable = path.join(shellTools, 'node');
    const initial = serviceEnvironment(root, os.homedir(), executable, inherited);
    assert.equal(execFileSync('/usr/bin/env', ['python3'], { env: initial, encoding: 'utf8' }).trim(), '3.14');
    const configured = serviceEnvironment(root, os.homedir(), executable, { ...inherited, PAPILOT_SERVICE_PATH: compatibleTools });
    const reinstalled = serviceEnvironment(root, os.homedir(), executable, inherited, configured);
    assert.equal(execFileSync('/usr/bin/env', ['python3'], { env: reinstalled, encoding: 'utf8' }).trim(), '3.12');
    assert.equal(reinstalled.PAPILOT_SERVICE_PATH, compatibleTools);
    assert.equal(reinstalled.PAPILOT_PUBLIC_ORIGIN, inherited.PAPILOT_PUBLIC_ORIGIN);
    const cleared = serviceEnvironment(root, os.homedir(), executable, { ...inherited, PAPILOT_SERVICE_PATH: '' }, configured);
    assert.equal(execFileSync('/usr/bin/env', ['python3'], { env: cleared, encoding: 'utf8' }).trim(), '3.14');
    assert.equal(cleared.PAPILOT_SERVICE_PATH, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('service paths keep the selected Node, exclude relative entries and do not copy unrelated environment', { skip: process.platform === 'win32' && 'the background service is macOS-only' }, () => {
  const env = serviceEnvironment('/app', '/user', '/node/bin/node', {
    PATH: ':/custom/bin:.:../tools:/custom/bin:/bin',
    PAPILOT_SERVICE_PATH: '/python/bin:relative',
    PRIVATE_TOKEN: 'not-a-service-setting',
  });
  const entries = env.PATH.split(path.delimiter);
  assert.equal(entries[0], '/python/bin');
  assert.equal(entries[1], '/node/bin');
  assert.ok(entries.indexOf('/python/bin') < entries.indexOf('/custom/bin'));
  assert.ok(entries.every(p => path.isAbsolute(p)));
  assert.equal(entries.length, new Set(entries).size);
  assert.equal(env.PRIVATE_TOKEN, undefined);
  assert.equal(env.HOME, '/user');
});
