import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activeLayer, BackendStopError, backendEnvironment, linkBundle, npmBinFolder, removeLayers, startBackend, startServer, STARTUP_FAILED, switchServer, type Bundle } from '../desktop/runtime.ts';
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

test('desktop PATH includes Node/npm install folders without a shell environment', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-desktop-home-'));
  const node = path.join(home, 'runtime/bin/node'), root = path.join(home, 'app'), data = path.join(home, 'data');
  const paths = (extra: NodeJS.ProcessEnv = {}) => backendEnvironment(node, root, data, { HOME: home, USERPROFILE: home, PATH: path.join(home, 'inherited'), ...extra }).PATH.split(path.delimiter);
  try {
    const defaults = paths();
    for (const dir of ['Library/pnpm', '.local/share/pnpm', '.local/share/mise/shims', '.yarn/bin',
      '.local/share/fnm/aliases/default/bin', 'Library/Application Support/fnm/aliases/default/bin']) {
      assert.ok(defaults.includes(path.join(home, dir)), dir);
      assert.ok(defaults.indexOf(path.join(home, dir)) > defaults.indexOf(path.join(home, '.asdf/shims')), 'existing home folders keep their precedence');
    }
    fs.writeFileSync(path.join(home, '.npmrc'), '# user configuration\nprefix=~/custom npm\n');
    const custom = paths({ PNPM_HOME: path.join(home, 'custom-pnpm'), FNM_DIR: path.join(home, 'custom-fnm') });
    for (const dir of ['custom-pnpm', 'custom-fnm/aliases/default/bin']) assert.ok(custom.includes(path.join(home, dir)), dir);
    assert.ok(custom.includes(npmBinFolder(path.join(home, 'custom npm'))));
    assert.equal(custom[0], path.dirname(node), 'the bundled Node stays first');
    assert.ok(custom.indexOf(path.join(home, 'inherited')) < custom.indexOf(path.join(home, 'custom-pnpm')));
    fs.writeFileSync(path.join(home, '.npmrc'), `prefix="${path.join(home, 'absolute npm')}"\n`);
    assert.ok(paths().includes(npmBinFolder(path.join(home, 'absolute npm'))), 'absolute and quoted prefixes work');
    fs.writeFileSync(path.join(home, '.npmrc'), 'prefix=${HOME}/npm-x\n');
    assert.ok(paths().includes(npmBinFolder(path.join(home, 'npm-x'))), 'npm variables use the inherited environment');
    fs.writeFileSync(path.join(home, '.npmrc'), 'prefix=~/npm-home\n');
    const otherHome = path.join(home, 'unused');
    const selectedHome = paths(process.platform === 'win32' ? { HOME: otherHome } : { USERPROFILE: otherHome });
    assert.ok(selectedHome.includes(npmBinFolder(path.join(home, 'npm-home'))), 'home discovery agrees with agentDirs on this platform');
    fs.rmSync(path.join(home, '.npmrc'));
    fs.mkdirSync(path.join(home, '.npmrc'));
    assert.deepEqual(paths(), defaults, 'an unreadable npmrc does not prevent startup');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('npm global executables live in the prefix on Windows and bin on POSIX', () => {
  assert.equal(npmBinFolder('C:\\Users\\author\\npm-x', 'win32'), 'C:\\Users\\author\\npm-x');
  assert.equal(npmBinFolder('/home/author/npm-x', 'linux'), '/home/author/npm-x/bin');
  assert.equal(npmBinFolder('/Users/author/npm-x', 'darwin'), '/Users/author/npm-x/bin');
});

test('the development desktop app ignores legacy web update state and rejects install and channel requests', async () => {
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
    assert.equal(status.canUpdate, false); assert.equal(status.channel, undefined, 'Only packaged apps choose a channel');
    assert.equal(status.downloadUrl, 'https://github.com/PapilotAI/papilot/releases');
    for (const [route, body] of [['install', { version: '999.0.0' }], ['channel', { channel: 'dev' }]] as const) {
      const response = await fetch(`${url}/api/updates/${route}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: url, 'X-Papilot-Token': state.csrf }, body: JSON.stringify(body) });
      assert.equal(response.status, 400); assert.match(await response.text(), /desktop updates/);
    }
    assert.deepEqual(readJson(path.join(data, 'updates/status.json')), saved);
  } finally { await backend.stop(); fs.rmSync(data, { recursive: true, force: true }); }
});

const write = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const fingerprint = 'f'.repeat(64);

for (const mode of ['concurrent', 'closed IPC', 'idle closed IPC', 'throwing send', 'unresponsive'] as const) test(`desktop backend stop handles ${mode} and waits for process exit`, { timeout: 15000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-desktop-stop-')), root = path.join(directory, 'server'), data = path.join(directory, 'data');
  const closedIPC = mode === 'closed IPC' || mode === 'idle closed IPC';
  write(path.join(root, 'package.json'), { type: 'module' });
  fs.symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  write(path.join(root, 'src/server/start.ts'), `import fs from 'node:fs';import path from 'node:path';
    setInterval(()=>{},1000);
    ${closedIPC ? `setInterval(()=>{if(process.connected && fs.existsSync(path.join(process.env.PAPILOT_DATA,'close-ipc'))) {
      process.disconnect();fs.writeFileSync(path.join(process.env.PAPILOT_DATA,'ipc-closed'),'yes');
    }},10);` : ''}
    ${mode === 'unresponsive' ? "process.on('SIGTERM',()=>{});" : ''}
    process.on('message',message=>{if(message.type==='papilot:shutdown') {
      fs.appendFileSync(path.join(process.env.PAPILOT_DATA,'shutdowns'),'shutdown\\n');
      ${mode === 'unresponsive' ? '' : 'setTimeout(()=>process.exit(0),100);'}
    }});
    process.send({type:'papilot:ready',url:'http://127.0.0.1:12345'});`);
  const backend = startBackend({ node: process.execPath, root, data, log: path.join(data, 'server.log'), env: backendEnvironment(process.execPath, root, data) });
  const send = backend.child.send, errors: Error[] = [];
  backend.child.on('error', error => errors.push(error));
  t.after(async () => {
    backend.child.send = send;
    if (backend.child.exitCode === null && backend.child.signalCode === null) {
      const ended = new Promise(resolve => backend.child.once('exit', resolve));
      backend.child.kill('SIGKILL'); await ended;
    }
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await backend.ready;
  let sends = 0, exited = false;
  const sendFailures: Error[] = [];
  backend.child.once('exit', () => { exited = true; });
  backend.child.send = ((...args: any[]) => {
    sends++;
    if (closedIPC) {
      // Let the child close its real pipe while this event loop is held, so
      // connected still reflects the state before the peer disconnected.
      fs.writeFileSync(path.join(data, 'close-ipc'), 'yes');
      const deadline = performance.now() + 3000, closed = path.join(data, 'ipc-closed');
      while (!fs.existsSync(closed) && performance.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      assert.ok(fs.existsSync(closed)); assert.equal(backend.child.connected, true);
      const callback = args.at(-1);
      if (typeof callback === 'function') args[args.length - 1] = (error: Error | null) => { if (error) sendFailures.push(error); callback(error); };
    }
    if (mode === 'throwing send') throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    return (send as any).apply(backend.child, args);
  }) as typeof send;
  if (mode === 'idle closed IPC') {
    const failure = await backend.idle().then(() => undefined, error => error);
    assert.deepEqual(errors, [], 'An idle check must reject its IPC error instead of emitting an unhandled error');
    assert.match(String(failure), /EPIPE|closed|pipe/i);
    await backend.stop();
    assert.equal(exited, true); assert.deepEqual(errors, []);
    return;
  }
  const first = backend.stop(), second = backend.stop();
  if (mode === 'concurrent') assert.equal(first, second, 'All callers share one shutdown promise');
  await Promise.all([first, second]);
  assert.deepEqual(errors, [], 'IPC send errors belong to the send callback, not an unhandled error event');
  assert.equal(exited, true, 'stop must observe process exit, including after forced termination');
  assert.ok(backend.child.exitCode !== null || backend.child.signalCode !== null);
  assert.equal(sends, 1, 'Concurrent stop calls send shutdown only once');
  if (mode === 'closed IPC') assert.equal(sendFailures.length, 1, 'The real closed pipe must report a send failure');
  if (mode === 'concurrent' || mode === 'unresponsive') assert.equal(fs.readFileSync(path.join(data, 'shutdowns'), 'utf8'), 'shutdown\n');
  assert.equal(backend.stop(), first, 'Calls after exit reuse the completed shutdown');
});

// A downloaded layer, laid out as the updater extracts it.
function layer(data: string, version: string, shell = fingerprint) {
  const root = path.join(data, 'updates/desktop/layers', `${version}-x`, 'papilot');
  write(path.join(root, 'package.json'), { name: 'papilot', version });
  write(path.join(root, 'desktop-layer.json'), { format: 1, version, fingerprint: shell });
  write(path.join(root, 'src/server/start.ts'), '');
  fs.mkdirSync(path.join(root, 'engine'), { recursive: true });
  return root;
}
function fixture() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-desktop-layers-'));
  const bundle: Bundle = { root: path.join(data, 'app/server'), version: '0.9.0', fingerprint };
  write(path.join(bundle.root, 'package.json'), { name: 'papilot', version: '0.9.0' });
  fs.mkdirSync(path.join(bundle.root, 'node_modules/.bin'), { recursive: true }); fs.mkdirSync(path.join(bundle.root, 'engine/node_modules'), { recursive: true });
  const folder = path.join(data, 'updates/desktop');
  return { data, bundle, active: path.join(folder, 'active.json'), status: path.join(folder, 'status.json'), lock: path.join(folder, 'install.lock'), close: () => fs.rmSync(data, { recursive: true, force: true }) };
}

test('the app runs a downloaded layer only on the installer shell it was built for', () => {
  const f = fixture();
  try {
    const root = layer(f.data, '0.9.1-dev.' + 'a'.repeat(40)), version = '0.9.1-dev.' + 'a'.repeat(40);
    const record = { root, version, installer: '0.9.0', phase: 'active' };
    assert.equal(activeLayer(f.data, f.bundle), null, 'Nothing is active yet');
    write(f.active, { ...record, phase: 'starting' });
    assert.equal(activeLayer(f.data, f.bundle), null, 'An interrupted switch is not trusted');
    write(f.active, record);
    assert.deepEqual(activeLayer(f.data, f.bundle), { root, version });
    assert.equal(activeLayer(f.data, { ...f.bundle, version: '0.9.2' }), null, 'Installing another app version retires the layer');
    assert.equal(activeLayer(f.data, { ...f.bundle, fingerprint: 'e'.repeat(64) }), null, 'A layer built for another shell never runs');
    assert.equal(activeLayer(f.data, { ...f.bundle, fingerprint: '' }), null, 'The development app runs its checkout');
    write(f.active, { ...record, version: '0.9.2' });
    assert.equal(activeLayer(f.data, f.bundle), null, 'The recorded version must match the package');
    const outside = path.join(f.data, 'elsewhere/papilot');
    write(path.join(outside, 'package.json'), { name: 'papilot', version }); write(path.join(outside, 'desktop-layer.json'), { version, fingerprint }); write(path.join(outside, 'src/server/start.ts'), '');
    write(f.active, { ...record, root: outside });
    assert.equal(activeLayer(f.data, f.bundle), null, 'Only the updater directory is trusted');
  } finally { f.close(); }
});

test('layers run on the installer dependencies, wherever the installer moved', () => {
  const f = fixture();
  try {
    const root = layer(f.data, '0.9.1');
    linkBundle(root, f.bundle.root);
    assert.equal(fs.readlinkSync(path.join(root, 'node_modules')), path.join(f.bundle.root, 'node_modules'));
    assert.equal(fs.readlinkSync(path.join(root, 'engine/node_modules')), path.join(f.bundle.root, 'engine/node_modules'));
    // An AppImage mounts at a new path on every launch.
    const moved = path.join(f.data, 'mount/server');
    fs.cpSync(f.bundle.root, moved, { recursive: true });
    linkBundle(root, moved);
    assert.equal(fs.readlinkSync(path.join(root, 'node_modules')), path.join(moved, 'node_modules'));
    const env = backendEnvironment('/runtime/bin/node', root, f.data, { PATH: '/usr/bin' });
    assert.ok(env.PATH!.split(path.delimiter).includes(path.join(root, 'node_modules/.bin')), 'The bundled Codex stays on PATH');
  } finally { f.close(); }
});

test('startup falls back to the bundled version and removes unused layers', async () => {
  const f = fixture();
  try {
    const old = layer(f.data, '0.9.1'), root = layer(f.data, '0.9.2');
    write(f.active, { root, version: '0.9.2', installer: '0.9.0', phase: 'active' });
    const launched: string[] = [];
    assert.equal(await startServer(f.data, f.bundle, async folder => { launched.push(folder); }), root);
    assert.deepEqual(launched, [root]);
    assert.equal(fs.existsSync(path.dirname(old)), false, 'Superseded layers are removed');
    assert.equal(fs.readlinkSync(path.join(root, 'node_modules')), path.join(f.bundle.root, 'node_modules'));

    launched.length = 0;
    write(f.status, { phase: 'updated', latestVersion: '0.9.2' });
    assert.equal(await startServer(f.data, f.bundle, async folder => { launched.push(folder); if (folder === root) throw new Error('broken'); }), f.bundle.root);
    assert.deepEqual(launched, [root, f.bundle.root]);
    assert.equal(fs.existsSync(f.active), false);
    assert.equal(readJson(f.status).phase, 'failed'); assert.equal(readJson(f.status).error, STARTUP_FAILED); assert.equal(readJson(f.status).latestVersion, '0.9.2');

    launched.length = 0;
    assert.equal(await startServer(f.data, f.bundle, async folder => { launched.push(folder); }), f.bundle.root);
    assert.deepEqual(fs.readdirSync(path.join(f.data, 'updates/desktop/layers')), [], 'A layer that is not active is removed on the next launch');

    const kept = layer(f.data, '0.9.3');
    write(f.active, { root: kept, version: '0.9.3', installer: '0.9.0', phase: 'active' });
    assert.equal(await startServer(f.data, { ...f.bundle, fingerprint: '' }, async () => {}), f.bundle.root);
    assert.ok(fs.existsSync(kept) && fs.existsSync(f.active), 'The development app leaves the installed app\'s updates alone');
  } finally { f.close(); }
});

test('startup does not fall back when the chosen backend cannot be stopped', async () => {
  const f = fixture();
  try {
    const root = layer(f.data, '0.9.1'), record = { root, version: '0.9.1', installer: '0.9.0', phase: 'active' };
    write(f.active, record);
    const launched: string[] = [];
    await assert.rejects(startServer(f.data, f.bundle, async folder => {
      launched.push(folder); throw new BackendStopError('The candidate is still running.');
    }), BackendStopError);
    assert.deepEqual(launched, [root]);
    assert.deepEqual(readJson(f.active), record);
    assert.equal(fs.existsSync(f.status), false);
  } finally { f.close(); }
});

test('an update cannot restore the database or launch the old version until its candidate stops', async () => {
  const f = fixture();
  try {
    const root = layer(f.data, '0.9.1'), database = path.join(f.data, 'papilot.sqlite'), launched: string[] = [];
    write(database, 'original database');
    await assert.rejects(switchServer(f.data, f.bundle, { root, version: '0.9.1' }, f.bundle.root, async () => {}, async folder => {
      launched.push(folder); write(database, 'candidate database'); throw new BackendStopError('The candidate is still running.');
    }), BackendStopError);
    assert.deepEqual(launched, [root]);
    assert.equal(fs.readFileSync(database, 'utf8'), 'candidate database');
    assert.equal(fs.readFileSync(path.join(f.data, 'updates/desktop/before-update.sqlite'), 'utf8'), 'original database');
    assert.equal(readJson(f.active).root, root); assert.equal(readJson(f.active).phase, 'starting');
    assert.notEqual(readJson(f.status).phase, 'failed', 'Do not claim the previous version was restored');
  } finally { f.close(); }
});

test('switching layers backs up the database and restores everything if the new one fails', async () => {
  const f = fixture();
  try {
    const database = path.join(f.data, 'papilot.sqlite');
    write(database, 'before'); write(f.lock, { pid: 1 });
    const first = layer(f.data, '0.9.1');
    write(f.status, { phase: 'restarting', latestVersion: '0.9.1', pid: 1 });
    const events: string[] = [];
    const stop = async () => { events.push('stop'); };
    assert.equal(await switchServer(f.data, f.bundle, { type: 'papilot:activate', root: first, version: '0.9.1' }, f.bundle.root, stop, async folder => { events.push(folder); }), first);
    assert.deepEqual(events, ['stop', first]);
    assert.equal(readJson(f.active).phase, 'active'); assert.equal(readJson(f.active).root, first); assert.equal(readJson(f.active).installer, '0.9.0');
    assert.equal(readJson(f.status).phase, 'updated'); assert.equal(readJson(f.status).currentVersion, '0.9.1');
    assert.equal(fs.readFileSync(path.join(f.data, 'updates/desktop/before-update.sqlite'), 'utf8'), 'before');
    assert.equal(fs.existsSync(f.lock), false);
    assert.ok(fs.existsSync(path.join(first, 'node_modules')), 'The layer was linked before it started');

    const second = layer(f.data, '0.9.2'), previous = readJson(f.active);
    events.length = 0; write(f.lock, { pid: 1 });
    const launch = async (folder: string) => { events.push(folder); if (folder === second) { write(database, 'migrated'); throw new Error('The local server stopped (1).'); } };
    assert.equal(await switchServer(f.data, f.bundle, { root: second, version: '0.9.2' }, first, stop, launch), first);
    assert.deepEqual(events, ['stop', second, first]);
    assert.deepEqual(readJson(f.active), previous);
    assert.equal(fs.readFileSync(database, 'utf8'), 'before', 'The database is restored for the previous version');
    assert.equal(readJson(f.status).phase, 'failed'); assert.match(readJson(f.status).error, /stopped \(1\)\. The previous version has been restored\./);
    assert.equal(fs.existsSync(f.lock), false);

    // Returning to the installer's own version needs no layer.
    events.length = 0;
    assert.equal(await switchServer(f.data, f.bundle, { root: f.bundle.root, version: '0.9.0' }, first, stop, async folder => { events.push(folder); }), f.bundle.root);
    assert.deepEqual(events, ['stop', f.bundle.root]);
    assert.equal(fs.existsSync(f.active), false); assert.equal(readJson(f.status).currentVersion, '0.9.0');
    assert.deepEqual(fs.readdirSync(path.join(f.data, 'updates/desktop/layers')), [], 'Layers are removed once the bundled version runs');

    events.length = 0;
    const other = layer(f.data, '0.9.4', 'e'.repeat(64));
    for (const request of [null, { root: path.join(f.data, 'elsewhere'), version: '0.9.4' }, { root: other, version: '0.9.4' }, { root: f.bundle.root, version: '0.9.4' }]) {
      assert.equal(await switchServer(f.data, f.bundle, request, f.bundle.root, stop, launch), f.bundle.root);
      assert.equal(readJson(f.status).error, 'Invalid update activation.');
    }
    assert.deepEqual(events, [], 'Invalid requests keep the running backend');
  } finally { f.close(); }
});

test('removing layers keeps only the active one', () => {
  const f = fixture();
  try {
    const keep = layer(f.data, '0.9.1'); layer(f.data, '0.9.2');
    removeLayers(f.data, keep);
    assert.deepEqual(fs.readdirSync(path.join(f.data, 'updates/desktop/layers')), ['0.9.1-x']);
    removeLayers(f.data);
    assert.deepEqual(fs.readdirSync(path.join(f.data, 'updates/desktop/layers')), []);
  } finally { f.close(); }
});
