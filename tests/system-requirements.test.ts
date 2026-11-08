import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSystemRequirements, probeRequiredTool } from '../src/server/system-requirements.ts';

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

test('setup distinguishes missing tools from failed probes and retries timeouts once', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-requirements-probe-'));
  try {
    for (const name of ['git', 'latexmk', 'synctex', 'pdflatex', 'xelatex']) fs.writeFileSync(path.join(bin, name), '', { mode: 0o755 });
    const calls: Record<string, number> = {};
    const deadlines: number[] = [];
    const report = await checkSystemRequirements({ PATH: bin }, 'linux', async (file, _args, _env, timeout) => {
      const name = path.basename(file);
      calls[name] = (calls[name] || 0) + 1;
      if (name === 'latexmk') { deadlines.push(timeout); return calls[name] === 1 ? 'timeout' : true; }
      if (name === 'synctex' || name === 'pdflatex') return 'timeout';
      return name !== 'xelatex';
    });
    assert.deepEqual(report.checks, [
      { id: 'git', ok: true }, { id: 'latexmk', ok: true },
      { id: 'synctex', ok: false, failureReason: 'timeout' }, { id: 'tex-engine', ok: false, failureReason: 'timeout' },
    ]);
    assert.deepEqual(calls, { git: 1, latexmk: 2, synctex: 2, pdflatex: 2, xelatex: 1 });
    assert.deepEqual(deadlines, [5000, 10000], 'The retry gives a slow process more time to finish');
    const broken = await checkSystemRequirements({ PATH: bin }, 'linux', async () => false);
    assert.ok(broken.checks.every(check => check.failureReason === 'failed'));
    fs.rmSync(path.join(bin, 'latexmk'));
    const missing = await checkSystemRequirements({ PATH: bin }, 'linux', async () => true);
    assert.deepEqual(missing.checks.find(check => check.id === 'latexmk'), { id: 'latexmk', ok: false });
  } finally { fs.rmSync(bin, { recursive: true, force: true }); }
});

test('a cold latexmk process that exceeds the deadline is retried instead of reported missing', { skip: process.platform === 'win32', timeout: 30000 }, async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-requirements-cold-'));
  try {
    fs.writeFileSync(path.join(bin, 'latexmk'), '#!/bin/sh\nexec /bin/sleep 6\n', { mode: 0o755 });
    const report = await checkSystemRequirements({ PATH: bin });
    assert.deepEqual(report.checks.find(check => check.id === 'latexmk'), { id: 'latexmk', ok: true });
  } finally { fs.rmSync(bin, { recursive: true, force: true }); }
});

test('native Windows probes distinguish real timeouts, slow success and failed exits', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  // Use the installed runtime rather than generating an unsigned executable,
  // which endpoint protection can quarantine before the probe runs.
  const slow = ['-e', 'setTimeout(() => {}, 6000)'];
  assert.equal(await probeRequiredTool(process.execPath, slow, process.env, 5000), 'timeout');
  assert.equal(await probeRequiredTool(process.execPath, slow, process.env, 10000), true, 'The longer retry budget must allow a native process to finish');
  assert.equal(await probeRequiredTool(process.execPath, ['-e', 'process.exit(1)'], process.env, 5000), false);
  assert.equal(await probeRequiredTool(process.execPath, ['--version'], process.env, 5000), true, 'A fresh probe recovers after failure');
});

test('macOS setup does not invoke the Git installer stub when developer tools are missing', { skip: !fs.existsSync('/usr/bin/git') }, async () => {
  const calls: string[] = [];
  const report = await checkSystemRequirements({ PATH: '/usr/bin' }, 'darwin', async file => { calls.push(file); return false; });
  assert.equal(report.checks[0].ok, false);
  assert.ok(calls.includes('/usr/bin/xcode-select'));
  assert.ok(!calls.includes('/usr/bin/git'));
});
