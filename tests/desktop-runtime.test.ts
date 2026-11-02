import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activeRelease, backendEnvironment, codexFor, newer, removeReleases, startServer, STARTUP_FAILED, switchServer, type Bundle } from '../desktop/runtime.ts';

const readJson = (file: string) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const write = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
// An installed release, laid out as npm installs it into the data directory.
function release(data: string, version: string, pkg: Record<string, unknown> = {}) {
  const root = path.join(data, 'updates/releases', `${version}-x`, 'node_modules/papilot');
  write(path.join(root, 'package.json'), { name: 'papilot', version, desktopShell: 1, ...pkg });
  write(path.join(root, 'src/server/start.ts'), '');
  return root;
}
function fixture() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-desktop-runtime-'));
  const bundle: Bundle = { root: path.join(data, 'app/server'), version: '0.9.0', shell: 1 };
  write(path.join(bundle.root, 'package.json'), { name: 'papilot', version: '0.9.0', desktopShell: 1 });
  return { data, bundle, active: path.join(data, 'updates/active.json'), status: path.join(data, 'updates/status.json'), close: () => fs.rmSync(data, { recursive: true, force: true }) };
}

test('the app runs a newer installed release only when its shell supports it', () => {
  const f = fixture();
  try {
    assert.equal(newer('0.10.0', '0.9.0'), true); assert.equal(newer('0.9.0', '0.9.0'), false); assert.equal(newer('0.9.1-dev.x', '0.9.0'), false);
    const root = release(f.data, '0.9.1');
    assert.equal(activeRelease(f.data, f.bundle), null, 'Nothing is active yet');
    write(f.active, { root, version: '0.9.1', phase: 'starting' });
    assert.equal(activeRelease(f.data, f.bundle), null, 'An interrupted switch is not trusted');
    write(f.active, { root, version: '0.9.1', phase: 'active' });
    assert.deepEqual(activeRelease(f.data, f.bundle), { root, version: '0.9.1' });
    assert.equal(activeRelease(f.data, { ...f.bundle, version: '0.9.1' }), null, 'A newer installer runs its own Papilot');
    assert.equal(activeRelease(f.data, { ...f.bundle, shell: 0 }), null);
    const future = release(f.data, '0.9.2', { desktopShell: 2 });
    write(f.active, { root: future, version: '0.9.2', phase: 'active' });
    assert.equal(activeRelease(f.data, f.bundle), null, 'A release that needs a newer shell is skipped');
    const outside = path.join(f.data, 'elsewhere/papilot');
    write(path.join(outside, 'package.json'), { name: 'papilot', version: '0.9.3', desktopShell: 1 }); write(path.join(outside, 'src/server/start.ts'), '');
    write(f.active, { root: outside, version: '0.9.3', phase: 'active' });
    assert.equal(activeRelease(f.data, f.bundle), null, 'Only the updater directory is trusted');
    write(f.active, { root, version: '0.9.2', phase: 'active' });
    assert.equal(activeRelease(f.data, f.bundle), null, 'The recorded version must match the package');
  } finally { f.close(); }
});

test('releases find their dependencies and Codex beside them', () => {
  const f = fixture();
  try {
    const root = release(f.data, '0.9.1'), stage = path.resolve(root, '../..');
    const env = backendEnvironment('/runtime/bin/node', root, f.data, { PATH: '/usr/bin' });
    assert.ok(env.PATH!.split(path.delimiter).includes(path.join(stage, 'node_modules/.bin')));
    write(path.join(f.bundle.root, 'node_modules/.bin/codex'), '');
    assert.equal(codexFor(root, f.bundle.root), path.join(f.bundle.root, 'node_modules/.bin/codex'), 'The installer Codex serves releases that test it');
    write(path.join(stage, 'codex/node_modules/.bin/codex'), '');
    assert.equal(codexFor(root, f.bundle.root), path.join(stage, 'codex/node_modules/.bin/codex'));
    assert.equal(codexFor(f.bundle.root, f.bundle.root), path.join(f.bundle.root, 'node_modules/.bin/codex'));
  } finally { f.close(); }
});

test('startup falls back to the bundled version and removes unused releases', async () => {
  const f = fixture();
  try {
    const old = release(f.data, '0.9.1'), root = release(f.data, '0.9.2');
    write(f.active, { root, version: '0.9.2', phase: 'active' });
    const launched: string[] = [];
    assert.equal(await startServer(f.data, f.bundle, async folder => { launched.push(folder); }), root);
    assert.deepEqual(launched, [root]);
    assert.equal(fs.existsSync(path.resolve(old, '../..')), false, 'Superseded releases are removed');
    assert.ok(fs.existsSync(root));

    launched.length = 0;
    write(f.status, { phase: 'updated', latestVersion: '0.9.2' });
    assert.equal(await startServer(f.data, f.bundle, async folder => { launched.push(folder); if (folder === root) throw new Error('broken'); }), f.bundle.root);
    assert.deepEqual(launched, [root, f.bundle.root]);
    assert.equal(fs.existsSync(f.active), false);
    assert.equal(readJson(f.status).phase, 'failed'); assert.equal(readJson(f.status).error, STARTUP_FAILED); assert.equal(readJson(f.status).latestVersion, '0.9.2');

    launched.length = 0;
    assert.equal(await startServer(f.data, f.bundle, async folder => { launched.push(folder); }), f.bundle.root);
    assert.deepEqual(fs.readdirSync(path.join(f.data, 'updates/releases')), [], 'A release that is not active is removed on the next launch');

    const kept = release(f.data, '0.9.3');
    write(f.active, { root: kept, version: '0.9.3', phase: 'active' });
    assert.equal(await startServer(f.data, { ...f.bundle, shell: 0 }, async () => {}), f.bundle.root);
    assert.ok(fs.existsSync(kept) && fs.existsSync(f.active), 'A development build leaves the installed app\'s updates alone');
  } finally { f.close(); }
});

test('switching to an installed release backs up the database and restores everything if it fails', async () => {
  const f = fixture();
  try {
    const database = path.join(f.data, 'papilot.sqlite'), lock = path.join(f.data, 'updates/install.lock');
    write(database, 'before'); write(lock, { pid: 1 });
    const first = release(f.data, '0.9.1');
    write(f.status, { phase: 'restarting', latestVersion: '0.9.1', pid: 1 });
    const events: string[] = [];
    const stop = async () => { events.push('stop'); };
    assert.equal(await switchServer(f.data, f.bundle, { type: 'papilot:activate', root: first, version: '0.9.1' }, f.bundle.root, stop, async folder => { events.push(folder); }), first);
    assert.deepEqual(events, ['stop', first]);
    assert.equal(readJson(f.active).phase, 'active'); assert.equal(readJson(f.active).root, first);
    assert.equal(readJson(f.status).phase, 'updated'); assert.equal(readJson(f.status).currentVersion, '0.9.1');
    assert.equal(fs.readFileSync(path.join(f.data, 'updates/before-update.sqlite'), 'utf8'), 'before');
    assert.equal(fs.existsSync(lock), false);

    const second = release(f.data, '0.9.2'), previous = readJson(f.active);
    events.length = 0; write(lock, { pid: 1 });
    const launch = async (folder: string) => { events.push(folder); if (folder === second) { write(database, 'migrated'); throw new Error('The local server stopped (1).'); } };
    assert.equal(await switchServer(f.data, f.bundle, { root: second, version: '0.9.2' }, first, stop, launch), first);
    assert.deepEqual(events, ['stop', second, first]);
    assert.deepEqual(readJson(f.active), previous);
    assert.equal(fs.readFileSync(database, 'utf8'), 'before', 'The database is restored for the previous version');
    assert.equal(readJson(f.status).phase, 'failed'); assert.match(readJson(f.status).error, /stopped \(1\)\. The previous version has been restored\./);
    assert.equal(fs.existsSync(lock), false);

    events.length = 0;
    for (const request of [null, { root: path.join(f.data, 'elsewhere'), version: '0.9.4' }, { root: second, version: '0.9.0' }]) {
      assert.equal(await switchServer(f.data, f.bundle, request, first, stop, launch), first);
      assert.equal(readJson(f.status).error, 'Invalid update activation.');
    }
    assert.deepEqual(events, [], 'Invalid requests keep the running backend');
  } finally { f.close(); }
});

test('removing releases keeps only the active one', () => {
  const f = fixture();
  try {
    const keep = release(f.data, '0.9.1'); release(f.data, '0.9.2');
    removeReleases(f.data, keep);
    assert.deepEqual(fs.readdirSync(path.join(f.data, 'updates/releases')), ['0.9.1-x']);
    removeReleases(f.data);
    assert.deepEqual(fs.readdirSync(path.join(f.data, 'updates/releases')), []);
  } finally { f.close(); }
});
