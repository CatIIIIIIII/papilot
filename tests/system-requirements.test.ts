import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSystemRequirements } from '../src/server/system-requirements.ts';

test('setup detects missing, broken and partially installed tools on the server PATH', { skip: process.platform === 'win32' }, async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-requirements-'));
  const env = { PATH: bin };
  const tool = (name: string, body = 'exit 0') => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  try {
    assert.ok((await checkSystemRequirements(env)).checks.every(check => !check.ok));
    tool('git'); tool('pdflatex', 'exit 1'); tool('xelatex');
    let report = await checkSystemRequirements(env);
    assert.deepEqual(report.checks, [{ id: 'git', ok: true }, { id: 'latexmk', ok: false }, { id: 'synctex', ok: false }, { id: 'tex-engine', ok: true }]);
    tool('latexmk'); tool('synctex');
    report = await checkSystemRequirements(env);
    assert.ok(report.checks.every(check => check.ok));
    assert.ok(!JSON.stringify(report).includes(bin), 'shared status must not expose host paths');
    fs.unlinkSync(path.join(bin, 'git'));
    assert.equal((await checkSystemRequirements(env)).checks[0].ok, false, 'a later check sees changed installations');
  } finally { fs.rmSync(bin, { recursive: true, force: true }); }
});

test('Windows setup recognizes Path and quoted installation directories', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-requirements-win-'));
  try {
    fs.writeFileSync(path.join(bin, 'git.exe'), 'fixture');
    const calls: string[] = [];
    const report = await checkSystemRequirements({ Path: `"${bin}"`, PATHEXT: '.EXE' }, 'win32', async file => { calls.push(file); return true; });
    assert.equal(report.checks[0].ok, true);
    assert.deepEqual(calls, [path.join(bin, 'git.exe')]);
    assert.ok(report.checks.slice(1).every(check => !check.ok));
  } finally { fs.rmSync(bin, { recursive: true, force: true }); }
});

test('macOS setup does not invoke the Git installer stub when developer tools are missing', { skip: !fs.existsSync('/usr/bin/git') }, async () => {
  const calls: string[] = [];
  const report = await checkSystemRequirements({ PATH: '/usr/bin' }, 'darwin', async file => { calls.push(file); return false; });
  assert.equal(report.checks[0].ok, false);
  assert.ok(calls.includes('/usr/bin/xcode-select'));
  assert.ok(!calls.includes('/usr/bin/git'));
});
