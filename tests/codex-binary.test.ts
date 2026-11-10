import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { killTree } from '../bin/agent-paths.mjs';
import { codexCandidates, firstRunnable, isWsl, windowsDrive } from '../bin/codex-lookup.mjs';
import { codexBinary, resolveCodex } from '../src/server/codex-binary.ts';
import { Codex } from '../src/server/codex.ts';

const POSIX = process.platform !== 'win32';
// A stand-in Codex that reports a version, or fails like a broken installation.
function fakeCodex(dir: string, version: string | null, delay = 0) {
  fs.mkdirSync(dir, { recursive: true });
  if (!POSIX) { fs.writeFileSync(path.join(dir, 'codex.cmd'), version ? `@echo codex-cli ${version}\r\n` : '@exit /b 1\r\n'); return path.join(dir, 'codex.cmd'); }
  fs.writeFileSync(path.join(dir, 'codex'), `#!/bin/sh\n${delay ? `/bin/sleep ${delay}\n` : ''}${version ? `echo "codex-cli ${version}"` : 'exit 1'}\n`, { mode: 0o755 });
  return path.join(dir, 'codex');
}
// Only the given folders: the host's own Codex must not answer for the test.
const env = (root: string, ...dirs: string[]): NodeJS.ProcessEnv => ({ PATH: dirs.join(path.delimiter), Path: dirs.join(path.delimiter), HOME: root, USERPROFILE: root,
  SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT });

test('WSL is detected only on Linux from its environment or kernel release', () => {
  assert.equal(isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, 'linux', ''), true);
  assert.equal(isWsl({ WSL_INTEROP: '/run/WSL/1_interop' }, 'linux', ''), true);
  assert.equal(isWsl({}, 'linux', '6.6.87.2-Microsoft-standard-WSL2'), true);
  assert.equal(isWsl({}, 'linux', '6.6.87'), false);
  assert.equal(isWsl({}, 'linux', ''), false);
  for (const platform of ['darwin', 'win32'] as const) {
    assert.equal(isWsl({ WSL_DISTRO_NAME: 'Ubuntu', WSL_INTEROP: '/run/WSL/1_interop' }, platform, 'microsoft'), false);
  }
});

test('only a single-letter Windows drive mount is excluded from WSL Codex discovery', () => {
  for (const dir of ['/mnt/c', '/mnt/c/', '/mnt/C/Users/u/AppData/Roaming/npm', '"/mnt/d/Program Files/nodejs"']) assert.equal(windowsDrive(dir), true, dir);
  for (const dir of ['/usr/local/bin', '/mnt/data-disk-not-a-letter/bin', '/mnt/cc/bin', '/mnt/1/bin', '/home/u/mnt/c/bin']) assert.equal(windowsDrive(dir), false, dir);
});

test('WSL Codex discovery skips Windows folders before probing the filesystem, while other hosts keep them', t => {
  const folders = ['/mnt/c/Users/u/AppData/Roaming/npm', '/usr/local/bin', '/mnt/data-disk-not-a-letter/bin'];
  const plain = env('/home/papilot-test', ...folders), scanned: string[] = [];
  t.mock.method(fs, 'statSync', (file: fs.PathLike) => { scanned.push(String(file)); throw new Error('ENOENT'); });
  const wasScanned = (dir: string) => scanned.some(file => file === path.resolve(dir, 'codex') || file.startsWith(path.resolve(dir, 'codex') + '.'));
  codexCandidates(plain, '/data', '/checkout', isWsl({ ...plain, WSL_DISTRO_NAME: 'Ubuntu' }, 'linux', ''));
  assert.equal(wasScanned(folders[0]), false);
  assert.equal(wasScanned(folders[1]), true);
  assert.equal(wasScanned(folders[2]), true);
  scanned.length = 0;
  codexCandidates(plain, '/data', '/checkout', isWsl(plain, 'linux', '6.6.87'));
  for (const dir of folders) assert.equal(wasScanned(dir), true, dir);
});

test('the first Codex that runs is used, whatever its version', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-codex-'));
  try {
    const broken = fakeCodex(path.join(root, 'broken'), null), old = fakeCodex(path.join(root, 'old'), '0.1.0'), recent = fakeCodex(path.join(root, 'recent'), '0.170.0');
    const plain = env(root);
    assert.equal(await firstRunnable([broken, old, recent], plain), old, 'a broken installation is skipped; no version is required');
    assert.equal(await firstRunnable([broken], plain), null);
    assert.equal(await firstRunnable([path.join(root, 'absent'), recent], plain), recent, 'a spawn error is skipped');
    assert.equal(await resolveCodex([broken, old, recent], plain), old);
    await assert.rejects(resolveCodex([], plain), /not found on this computer/);
    await assert.rejects(resolveCodex([broken], plain), /could not be run/);
    assert.equal(await codexBinary({ ...plain, PAPILOT_CODEX_BIN: '/configured/codex' }), '/configured/codex', 'the npm command chose already');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Codex is looked for on PATH first, then in the checkout and the data folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-codex-')), data = path.join(root, 'data'), checkout = path.join(root, 'checkout');
  try {
    const first = fakeCodex(path.join(root, 'a'), null), second = fakeCodex(path.join(root, 'b'), '0.170.0');
    const dev = fakeCodex(path.join(checkout, 'node_modules/.bin'), '0.164.0'), own = fakeCodex(path.join(data, 'agents/node_modules/.bin'), '0.164.0');
    // PATHEXT may change a shim's extension case on Windows.
    const comparable = (file: string) => POSIX ? file : file.toLowerCase();
    const found = codexCandidates(env(root, path.dirname(first), path.dirname(second)), data, checkout).map(comparable);
    // Standard install folders (Homebrew, /usr/local/bin) sit between PATH and the copies.
    assert.deepEqual(found.slice(0, 2), [first, second].map(comparable));
    assert.ok(found.indexOf(comparable(dev)) > 1 && found.indexOf(comparable(own)) > found.indexOf(comparable(dev)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('stopping Codex while it looks for an installation starts no app-server', { skip: !POSIX && 'uses a POSIX sleep' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-codex-'));
  try {
    const slow = fakeCodex(path.join(root, 'slow'), '0.170.0', 1);
    const codex = new Codex(undefined, undefined, env(root, path.dirname(slow)));
    const starting = codex.start();
    codex.close();
    await assert.rejects(starting, { message: 'Codex is not connected.' });
    assert.equal(codex.child, null);
    assert.equal(codex.ready, false);
    await assert.rejects(codex.request('account/read', {}), /not connected/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await delay(10);
  assert.ok(check(), 'the child process reached the expected state');
}

test('closing Codex cancels a hanging version probe and its children immediately', { skip: !POSIX && 'uses a POSIX process group', timeout: 6000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-codex-')), pids = path.join(root, 'pids');
  const codex = new Codex(undefined, undefined, { ...env(root, root), PROBE_PIDS: pids });
  let starting: Promise<void> | undefined;
  try {
    fs.writeFileSync(path.join(root, 'codex'), '#!/bin/sh\n/bin/sleep 30 &\necho "$$ $!" > "$PROBE_PIDS"\nwait\n', { mode: 0o755 });
    starting = codex.start();
    const stopped = assert.rejects(starting, new Error('Codex is not connected.'));
    await waitFor(() => fs.existsSync(pids) && fs.readFileSync(pids, 'utf8').trim().split(' ').length === 2);
    const children = fs.readFileSync(pids, 'utf8').trim().split(' ').map(Number);
    const closed = Date.now();
    codex.close();
    await stopped;
    assert.ok(Date.now() - closed < 1000, 'close must not wait for the 15 second probe timeout');
    await waitFor(() => children.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } }));
    assert.equal(codex.child, null);
    assert.equal(codex.ready, false);
  } finally {
    codex.close();
    if (fs.existsSync(pids)) killTree(Number(fs.readFileSync(pids, 'utf8').split(' ')[0]), 'SIGKILL');
    await starting?.catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an aborted Codex lookup never probes the next candidate or starts an already aborted probe', { skip: !POSIX && 'uses a POSIX executable', timeout: 6000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-codex-')), pidFile = path.join(root, 'pid'), tried = path.join(root, 'tried');
  const controller = new AbortController();
  let lookup: Promise<string | null> | undefined;
  try {
    const hanging = path.join(root, 'hanging'), next = path.join(root, 'next');
    fs.writeFileSync(hanging, '#!/bin/sh\necho "$$" > "$PROBE_PID"\nexec /bin/sleep 30\n', { mode: 0o755 });
    fs.writeFileSync(next, '#!/bin/sh\necho tried > "$PROBE_TRIED"\n', { mode: 0o755 });
    const plain = { ...env(root), PROBE_PID: pidFile, PROBE_TRIED: tried };
    lookup = firstRunnable([hanging, next], plain, { signal: controller.signal });
    await waitFor(() => fs.existsSync(pidFile) && Boolean(fs.readFileSync(pidFile, 'utf8').trim()));
    controller.abort();
    assert.equal(await lookup, null);
    assert.equal(await firstRunnable([next], plain, { signal: controller.signal }), null);
    assert.equal(fs.existsSync(tried), false);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  } finally {
    controller.abort();
    if (fs.existsSync(pidFile)) killTree(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
    await lookup;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a Codex wrapper with a waiting child times out and the next installation is tried', { skip: !POSIX && 'uses a POSIX process group', timeout: 12000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-codex-'));
  const pids = path.join(root, 'pids'), wrapper = path.join(root, 'codex');
  try {
    fs.writeFileSync(wrapper, `#!/bin/sh\n/bin/sleep 30 &\necho "$$ $!" > "$PROBE_PIDS"\nwait\n`, { mode: 0o755 });
    const working = fakeCodex(path.join(root, 'working'), '0.1.0');
    const started = Date.now();
    assert.equal(await firstRunnable([wrapper, working], { ...env(root), PROBE_PIDS: pids }, { timeout: 2500 }), working);
    assert.ok(Date.now() - started < 8000, 'the wrapper cannot hold the lookup open');
    const children = fs.readFileSync(pids, 'utf8').trim().split(' ').map(Number);
    assert.equal(children.length, 2);
    await waitFor(() => children.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } }));
  } finally {
    if (fs.existsSync(pids)) killTree(Number(fs.readFileSync(pids, 'utf8').split(' ')[0]), 'SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex lookup shares a total budget and kills the hanging probe trees', { skip: !POSIX && 'uses POSIX process groups', timeout: 15000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-codex-'));
  const pidFiles = [path.join(root, 'first.pids'), path.join(root, 'second.pids')], tried = path.join(root, 'tried');
  const pids = () => pidFiles.flatMap(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split(' ').map(Number) : []);
  try {
    const wrappers = ['first', 'second'].map((name, index) => {
      const file = path.join(root, name);
      fs.writeFileSync(file, `#!/bin/sh\n/bin/sleep 30 &\necho "$$ $!" > "$PROBE_PIDS_${index}"\nwait\n`, { mode: 0o755 });
      return file;
    });
    const next = path.join(root, 'next');
    fs.writeFileSync(next, '#!/bin/sh\necho tried > "$PROBE_TRIED"\n', { mode: 0o755 });
    const plain = { ...env(root), PROBE_PIDS_0: pidFiles[0], PROBE_PIDS_1: pidFiles[1], PROBE_TRIED: tried };
    // Each probe gets long enough for a loaded machine to start its shell.
    const started = Date.now(), budget = 3000;
    assert.equal(await firstRunnable([...wrappers, next], plain, { timeout: 2000, budget }), null);
    const elapsed = Date.now() - started;
    // The upper bound only rules out waiting on every candidate; process start-up varies with load.
    assert.ok(elapsed >= budget - 100 && elapsed < budget + 3000, `lookup took ${elapsed} ms for a ${budget} ms budget`);
    assert.equal(fs.existsSync(tried), false, 'no candidate runs after the budget is exhausted');
    const children = pids();
    assert.ok(children.length >= 2, 'at least the first wrapper and its child started');
    await waitFor(() => children.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } }));
    assert.equal(await firstRunnable([next], plain, { budget: 0 }), null);
    assert.equal(fs.existsSync(tried), false, 'an empty budget starts no probe');
  } finally {
    for (const pid of pids()) { try { killTree(pid, 'SIGKILL'); } catch { /* already stopped */ } }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('starting Codex again during a stopped lookup launches afresh and retains the new promise', { skip: !POSIX && 'uses a POSIX executable', timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-codex-'));
  const probes = path.join(root, 'probes'), launches = path.join(root, 'launches');
  const codex = new Codex(undefined, undefined, env(root, root));
  let first: Promise<void> | undefined, second: Promise<void> | undefined;
  const pids = () => fs.existsSync(probes) ? fs.readFileSync(probes, 'utf8').trim().split('\n') : [];
  try {
    fs.writeFileSync(path.join(root, 'codex'), `#!${process.execPath}
      const fs = require('node:fs'), readline = require('node:readline');
      if (process.argv.includes('--version')) {
        fs.appendFileSync(${JSON.stringify(probes)}, process.pid + '\\n');
        const timer = setInterval(() => {
          if (fs.existsSync(${JSON.stringify(root)} + '/' + process.pid)) { clearInterval(timer); process.exit(0); }
        }, 10);
      } else {
        fs.appendFileSync(${JSON.stringify(launches)}, 'launch\\n');
        readline.createInterface({ input: process.stdin }).on('line', line => {
          const message = JSON.parse(line);
          if (message.id !== undefined) console.log(JSON.stringify({ id: message.id, result: {} }));
        });
      }
    `, { mode: 0o755 });
    first = codex.start();
    const stopped = assert.rejects(first, { message: 'Codex is not connected.' });
    await waitFor(() => pids().length === 1);
    codex.close();
    second = codex.start();
    assert.notEqual(first, second);
    await waitFor(() => pids().length === 2);
    fs.writeFileSync(path.join(root, pids()[0]), '');
    await stopped;
    assert.equal(codex.child, null, 'the stale lookup starts no app-server');
    assert.equal(codex.start(), second, 'a stale finally must not clear the new launch');
    fs.writeFileSync(path.join(root, pids()[1]), '');
    await second;
    assert.equal(codex.ready, true);
    assert.equal(fs.readFileSync(launches, 'utf8'), 'launch\n');
  } finally {
    codex.close();
    for (const pid of pids()) fs.writeFileSync(path.join(root, pid), '');
    await Promise.allSettled([first, second]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const afterReply of [false, true]) test(`closing Codex ${afterReply ? 'just after the initialize reply' : 'while initialize is pending'} isolates the next launch`, { skip: !POSIX && 'uses a POSIX executable', timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-codex-'));
  const binary = path.join(root, 'codex'), messages = path.join(root, 'messages');
  const codex = new Codex(binary, undefined, env(root));
  const starts: Promise<void>[] = [], children: NonNullable<Codex['child']>[] = [];
  const disconnected: Error[] = [];
  codex.on('disconnected', error => disconnected.push(error));
  const received = (): { pid: number; method: string }[] => fs.existsSync(messages) ? fs.readFileSync(messages, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const start = () => { const starting = codex.start(); starts.push(starting); children.push(codex.child!); return starting; };
  const release = (child: NonNullable<Codex['child']>) => fs.writeFileSync(path.join(root, String(child.pid)), '');
  try {
    fs.writeFileSync(binary, `#!${process.execPath}
      const fs = require('node:fs'), readline = require('node:readline');
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const message = JSON.parse(line);
        fs.appendFileSync(${JSON.stringify(messages)}, JSON.stringify({ pid: process.pid, ...message }) + '\\n');
        if (message.method === 'initialize') {
          const timer = setInterval(() => {
            if (!fs.existsSync(${JSON.stringify(root)} + '/' + process.pid)) return;
            clearInterval(timer);
            // Both lines arrive together so close can run before launch resumes.
            process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n'
              + JSON.stringify({ method: 'initializeReplied', params: { pid: process.pid } }) + '\\n');
          }, 10);
        } else if (message.method === 'test/barrier') console.log(JSON.stringify({ id: message.id, result: {} }));
      });
    `, { mode: 0o755 });
    const first = start(), firstChild = codex.child!;
    const stopped = assert.rejects(first, new Error('Codex is not connected.'));
    await waitFor(() => received().some(message => message.pid === firstChild.pid && message.method === 'initialize'));
    const pending = ['account/read', 'model/list'].map(method => assert.rejects(codex.request(method, {}), new Error('Codex is not connected.')));
    let second: Promise<void> | undefined;
    const restart = () => {
      codex.close();
      assert.equal(codex.child, null);
      assert.equal(codex.ready, false);
      second = start();
      assert.notEqual(first, second);
    };
    if (afterReply) {
      codex.on('notification', message => { if (message.method === 'initializeReplied' && message.params.pid === firstChild.pid) restart(); });
      release(firstChild);
    } else restart();
    await stopped;
    await Promise.all(pending);
    assert.ok(second);
    const secondChild = codex.child!;
    assert.notEqual(secondChild, firstChild);
    assert.equal(codex.ready, false, 'the old launch cannot mark its replacement ready');
    assert.equal(codex.start(), second, 'the replacement keeps its own start promise');
    await waitFor(() => received().some(message => message.pid === secondChild.pid && message.method === 'initialize'));
    release(secondChild);
    await second;
    assert.equal(codex.ready, true);
    await codex.request('test/barrier', {});
    assert.deepEqual(received().filter(message => message.pid === secondChild.pid).map(message => message.method), ['initialize', 'initialized', 'test/barrier'], 'the replacement receives exactly one initialized notification and no stale messages');

    codex.close();
    assert.equal(codex.ready, false);
    assert.equal(codex.child, null);
    await assert.rejects(codex.request('account/read', {}), new Error('Codex is not connected.'));
    const third = start(), thirdChild = codex.child!;
    assert.ok(thirdChild, 'starting immediately after closing a ready instance launches again');
    assert.notEqual(thirdChild, secondChild);
    assert.equal(codex.ready, false);
    await waitFor(() => received().some(message => message.pid === thirdChild.pid && message.method === 'initialize'));
    release(thirdChild);
    await third;
    assert.equal(codex.ready, true);
    await codex.request('test/barrier', {});
    assert.deepEqual(received().filter(message => message.pid === thirdChild.pid).map(message => message.method), ['initialize', 'initialized', 'test/barrier']);
  } finally {
    codex.close();
    await Promise.allSettled(starts);
    await waitFor(() => children.every(child => child.exitCode !== null || child.signalCode !== null));
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(disconnected, [], 'intentional closes do not emit disconnected on the later exit');
});
