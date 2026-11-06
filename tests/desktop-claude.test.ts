import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backendEnvironment } from '../desktop/runtime.ts';

test('desktop uses native Claude when Dock PATH points at a legacy installation', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-native-claude-'));
  const native = path.join(home, '.local/bin/claude');
  const inherited = { HOME: home, PATH: '/usr/local/bin:/usr/bin:/bin' };
  const env = (extra = {}) => backendEnvironment('/runtime/bin/node', '/app/server', '/app/data', { ...inherited, ...extra });
  try {
    assert.equal(env().PAPILOT_CLAUDE_BIN, undefined);
    fs.mkdirSync(path.dirname(native), { recursive: true });
    fs.writeFileSync(native, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
    assert.equal(env().PAPILOT_CLAUDE_BIN, undefined, 'non-executable native installs are ignored');
    fs.chmodSync(native, 0o700);
    assert.equal(env().PAPILOT_CLAUDE_BIN, native);
    assert.equal(env({ PAPILOT_CLAUDE_BIN: '/custom/claude' }).PAPILOT_CLAUDE_BIN, '/custom/claude');
    assert.equal(env({ PAPILOT_INSTALL_METHOD: 'nix' }).PAPILOT_CLAUDE_BIN, undefined);
    assert.equal(env({ PAPILOT_INSTALL_METHOD: 'nix', PAPILOT_CLAUDE_BIN: '/nix/wrapper' }).PAPILOT_CLAUDE_BIN, '/nix/wrapper');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
