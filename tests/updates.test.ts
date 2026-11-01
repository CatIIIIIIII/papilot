import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { activeInstallation, devRevision, newerVersion, readJson, releaseVersion, stableVersion, writeJson } from '../bin/installation.mjs';
import { latestRelease, Updates } from '../src/server/updates.ts';
import { DEV_REPOSITORY, health, loaderFor, npmCli, prepareDev, probeInstallation, sleep } from '../src/server/update-install.ts';
import { restartRelease } from '../src/server/update-worker.ts';

const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-update-test-'));
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const revision = 'a'.repeat(40), devVersion = `0.7.0-dev.${revision}`;
function fixture(overrides: Record<string, any> = {}) {
  const data = temporary();
  const updates = new Updates({ root: process.cwd(), data, version: '0.6.0', port: 1, supported: true, latest: async () => '0.7.0', busy: () => false, shutdown() {}, ...overrides });
  return { data, updates, close() { updates.close(); fs.rmSync(data, { recursive: true, force: true }); } };
}
test('desktop updates cannot install npm releases or switch to a dev checkout', async () => {
  let checked = false, installed = false;
  const downloadUrl = 'https://github.com/PapilotAI/papilot/releases/latest';
  const f = fixture({ downloadUrl, latest: async () => { checked = true; return '0.7.0'; }, install: async () => { installed = true; return '/tmp/unwanted'; } });
  try {
    f.updates.start();
    const status = await f.updates.check();
    assert.equal(status.downloadUrl, downloadUrl);
    assert.equal(status.canUpdate, false);
    assert.equal(status.phase, 'idle');
    assert.throws(() => f.updates.setChannel('dev'), /desktop updates/);
    assert.throws(() => f.updates.install('0.7.0'), /desktop updates/);
    assert.equal(checked, false); assert.equal(installed, false);
  } finally { f.close(); }
});
test('release comparisons reject unsafe targets and never downgrade', () => {
  for (const version of ['latest', '../1.0.0', '1.2.3;whoami', '1.2.3-beta.1', '01.2.3', '1.2']) assert.equal(stableVersion(version), false, version);
  assert.ok(newerVersion('0.10.0', '0.9.0'));
  assert.ok(newerVersion('1.0.0', '1.0.0-beta.2'));
  assert.equal(newerVersion('0.6.0', '0.6.0'), false);
  assert.equal(newerVersion('0.6.0', '0.7.0'), false);
});
test('dev discovery reads main once and pins the package version to its exact commit', async () => {
  const requests: string[] = [];
  const fetcher: typeof fetch = async url => {
    requests.push(String(url));
    return new Response(JSON.stringify(requests.length === 1 ? { object: { sha: revision } } : { name: 'papilot', version: '0.7.0' }));
  };
  assert.equal(await latestRelease('dev', fetcher), devVersion);
  assert.deepEqual(requests, ['https://api.github.com/repos/PapilotAI/papilot/git/ref/heads/main', `https://raw.githubusercontent.com/PapilotAI/papilot/${revision}/package.json`]);
  assert.equal(devRevision(devVersion), revision);
  assert.ok(releaseVersion(devVersion));
  for (const value of ['0.7.0-dev.main', '0.7.0-dev.abc1234', `${devVersion}/../../bad`, '0.7.0-dev.' + 'A'.repeat(40)]) assert.equal(releaseVersion(value), false);
  await assert.rejects(latestRelease('dev', async () => new Response(JSON.stringify({ object: { sha: '../other' } }))), /revision/);
});
test('channel changes persist, discard stale checks, and require an advertised target from that channel', async () => {
  const pending: { channel: string; resolve: (version: string) => void }[] = [];
  const f = fixture({ latest: (channel: string) => new Promise<string>(resolve => pending.push({ channel, resolve })), install: async () => { throw new Error('fixture stop'); } });
  try {
    const old = f.updates.check();
    const next = f.updates.setChannel('dev');
    pending[1].resolve(devVersion); await next;
    pending[0].resolve('0.9.0'); await old;
    assert.equal(f.updates.snapshot().channel, 'dev');
    assert.equal(f.updates.snapshot().latestVersion, devVersion);
    assert.equal(f.updates.snapshot().phase, 'available');
    assert.throws(() => f.updates.install('0.9.0'), /Check for/);
    assert.throws(() => f.updates.setChannel('other'), /valid update channel/);
    const restored = new Updates({ root: process.cwd(), data: f.data, version: '0.7.0', port: 1, supported: true, busy: () => false, shutdown() {} });
    assert.equal(restored.snapshot().channel, 'dev'); restored.close();
    f.updates.install(devVersion);
    assert.throws(() => f.updates.setChannel('stable'), /current update/);
    await tick();
  } finally { f.close(); }
});
test('returning from dev offers stable even with a lower base version; the same dev commit is current', async () => {
  const f = fixture({ version: devVersion, latest: async (channel: string) => channel === 'dev' ? devVersion : '0.6.0', install: async () => { throw new Error('fixture stop'); } });
  try {
    await f.updates.check(); assert.equal(f.updates.snapshot().phase, 'idle');
    await f.updates.setChannel('stable'); assert.equal(f.updates.snapshot().phase, 'available');
    f.updates.install('0.6.0'); await tick(); assert.equal(f.updates.snapshot().phase, 'failed');
  } finally { f.close(); }
});
test('dev preparation builds the advertised commit, independently of a newer main, without editing its source checkout', async () => {
  const data = temporary(), source = path.join(data, 'source'), root = path.join(data, 'candidate');
  const calls: { args: string[]; cwd: string }[] = [];
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    fs.mkdirSync(source); fs.mkdirSync(root);
    git(source, ['init', '-q']); git(source, ['config', 'user.name', 'Test']); git(source, ['config', 'user.email', 'test@localhost']);
    writeJson(path.join(source, 'package.json'), { name: 'papilot', version: '0.7.0' });
    writeJson(path.join(source, 'vendor/latex-review/package.json'), { name: 'review' });
    git(source, ['add', '.']); git(source, ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Selected']);
    const sha = git(source, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(source, 'newer.txt'), 'Not selected'); git(source, ['add', '.']);
    git(source, ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Newer main']);
    const version = `0.7.0-dev.${sha}`;
    await prepareDev(root, version, 1, async (args, cwd) => { calls.push({ args, cwd }); }, async (args, cwd) => {
      if (args.includes('fetch')) { assert.equal(args.at(-1), sha); assert.ok(args.includes(DEV_REPOSITORY)); }
      return git(cwd, args.map(arg => arg === DEV_REPOSITORY ? source : arg));
    });
    assert.equal(git(root, ['rev-parse', 'HEAD']), sha);
    assert.equal(fs.existsSync(path.join(root, 'newer.txt')), false);
    assert.equal(readJson(path.join(root, 'package.json')).version, version);
    assert.equal(readJson(path.join(source, 'package.json')).version, '0.7.0');
    assert.deepEqual(calls.map(call => call.args[0]), ['ci', 'ci', 'run', 'run', 'prune', 'prune']);
    assert.deepEqual(calls.filter(call => call.args[0] === 'run').map(call => call.cwd), [path.join(root, 'vendor/latex-review'), root]);
    await assert.rejects(prepareDev(root, '0.7.0-dev.bad', 1), /Invalid development version/);
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});
test('dev builds tolerate test-only engine restrictions but reject incompatible runtime dependencies', async t => {
  const data = temporary(), source = path.join(data, 'source'), log = fs.openSync(path.join(data, 'install.log'), 'w');
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const npm = (cwd: string, args: string[]) => execFileSync(process.execPath, [npmCli(), ...args, '--ignore-scripts', '--engine-strict=false', '--no-audit', '--no-fund'], { cwd, stdio: ['ignore', log, log] });
  try {
    fs.mkdirSync(source);
    const dependency = path.join(source, 'fixture-incompatible');
    writeJson(path.join(dependency, 'package.json'), { name: 'fixture-incompatible', version: '1.0.0', engines: { node: '<0' } });
    npm(dependency, ['pack', '--pack-destination', source]);
    const build = `node -e "const fs = require('node:fs'); fs.accessSync('node_modules/fixture-incompatible/package.json'); fs.writeFileSync('build-ok', 'yes')"`;
    const engine = path.join(source, 'vendor/latex-review');
    git(source, ['init', '-q']); git(source, ['config', 'user.name', 'Test']); git(source, ['config', 'user.email', 'test@localhost']);
    for (const [name, appKind, reviewKind] of [
      ['dev-only', 'devDependencies', 'devDependencies'],
      ['app-runtime', 'dependencies', 'devDependencies'],
      ['review-runtime', 'devDependencies', 'dependencies'],
    ]) {
      writeJson(path.join(source, 'package.json'), { name: 'papilot', version: '0.7.0', scripts: { build }, [appKind]: { 'fixture-incompatible': 'file:./fixture-incompatible-1.0.0.tgz' } });
      writeJson(path.join(engine, 'package.json'), { name: 'review', version: '1.0.0', scripts: { build }, [reviewKind]: { 'fixture-incompatible': 'file:../../fixture-incompatible-1.0.0.tgz' } });
      npm(source, ['install', '--package-lock-only']);
      npm(engine, ['install', '--package-lock-only']);
      git(source, ['add', '.']); git(source, ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', name]);
      const revision = git(source, ['rev-parse', 'HEAD']), root = path.join(data, name); fs.mkdirSync(root);
      const preparing = prepareDev(root, `0.7.0-dev.${revision}`, log, undefined, async (args, cwd) => git(cwd, args.map(arg => arg === DEV_REPOSITORY ? source : arg)));
      if (name !== 'dev-only') await assert.rejects(preparing, /could not be installed/);
      else {
        await preparing;
        assert.equal(fs.readFileSync(path.join(root, 'build-ok'), 'utf8'), 'yes');
        assert.equal(fs.readFileSync(path.join(root, 'vendor/latex-review/build-ok'), 'utf8'), 'yes');
        assert.equal(fs.existsSync(path.join(root, 'node_modules/fixture-incompatible')), false);
        assert.equal(fs.existsSync(path.join(root, 'vendor/latex-review/node_modules/fixture-incompatible')), false);
        // The launcher reads tested agent versions from the retained devDependencies.
        const app = readJson(path.join(root, 'package.json')), review = readJson(path.join(root, 'vendor/latex-review/package.json'));
        assert.equal(app.version, `0.7.0-dev.${revision}`);
        assert.deepEqual(app.devDependencies, { 'fixture-incompatible': 'file:./fixture-incompatible-1.0.0.tgz' });
        assert.deepEqual(review.devDependencies, { 'fixture-incompatible': 'file:../../fixture-incompatible-1.0.0.tgz' });
      }
    }
  } catch (error) { t.diagnostic(fs.readFileSync(path.join(data, 'install.log'), 'utf8')); throw error; }
  finally { fs.closeSync(log); fs.rmSync(data, { recursive: true, force: true }); }
});
test('checks are shared, transient failures preserve an available version, and forged install targets are refused', async () => {
  let release!: (value: string) => void;
  const f = fixture({ latest: () => new Promise<string>(resolve => { release = resolve; }) });
  try {
    const checking = f.updates.check(); assert.equal(f.updates.check(), checking);
    release('0.7.0'); await checking;
    assert.equal(f.updates.snapshot().phase, 'available');
    assert.throws(() => f.updates.install('0.8.0'), /Check for/);
    assert.throws(() => f.updates.install('0.7.0 --prefix /tmp/other'), /Check for/);
    const retry = f.updates.check(); release('not-a-version'); await retry;
    assert.equal(f.updates.snapshot().latestVersion, '0.7.0');
    assert.equal(f.updates.snapshot().phase, 'available');
    assert.match(f.updates.snapshot().error!, /Could not check/);
  } finally { f.close(); }
});
test('installation is deduplicated, allows ongoing work, and restarts only after tasks and HTTP operations finish', async () => {
  let done!: (root: string) => void, busy = true, installs = 0, restarts = 0;
  const f = fixture({ busy: () => busy, install: () => { installs++; return new Promise<string>(resolve => { done = resolve; }); }, restart: async () => { restarts++; } });
  try {
    await f.updates.check();
    assert.equal(f.updates.install('0.7.0').phase, 'installing');
    assert.equal(f.updates.install('0.7.0').phase, 'installing');
    assert.equal(installs, 1); assert.equal(f.updates.restarting, false);
    done('/prepared'); await tick();
    assert.equal(f.updates.snapshot().phase, 'waiting'); assert.equal(restarts, 0);
    const finish = f.updates.enter(); busy = false; await f.updates.activate();
    assert.equal(restarts, 0); finish(); finish();
    await f.updates.activate(); assert.equal(restarts, 1); assert.equal(f.updates.restarting, true);
    await f.updates.activate(); assert.equal(restarts, 1);
  } finally { f.close(); }
});
test('failed installation and restart preserve the current version and permit a retry', async () => {
  let attempts = 0;
  const f = fixture({ install: async () => { if (++attempts === 1) throw new Error('Download failed'); return '/prepared'; }, restart: async () => { throw new Error('Cannot restart'); } });
  try {
    await f.updates.check(); f.updates.install('0.7.0'); await tick();
    assert.equal(f.updates.snapshot().phase, 'failed'); assert.equal(f.updates.snapshot().currentVersion, '0.6.0');
    assert.equal(fs.existsSync(path.join(f.data, 'updates/active.json')), false);
    f.updates.install('0.7.0'); await tick();
    assert.equal(f.updates.snapshot().phase, 'failed'); assert.match(f.updates.snapshot().error!, /Cannot restart/);
    assert.equal(fs.existsSync(path.join(f.data, 'updates/install.lock')), false);
  } finally { f.close(); }
});
test('an interrupted update is recoverable and another live installer owns the lock', async () => {
  const f = fixture();
  try {
    await f.updates.check();
    writeJson(path.join(f.data, 'updates/install.lock'), { pid: process.pid });
    assert.throws(() => f.updates.install('0.7.0'), /already updating/);
    writeJson(path.join(f.data, 'updates/status.json'), { ...f.updates.snapshot(), phase: 'restarting', pid: 2147483647 });
    const resumed = new Updates({ root: process.cwd(), data: f.data, version: '0.6.0', port: 1, supported: true, busy: () => false, shutdown() {} });
    assert.equal(resumed.snapshot().phase, 'failed'); assert.match(resumed.snapshot().error!, /interrupted/); resumed.close();
  } finally { f.close(); }
});
test('launchers select only a newer complete release inside the managed directory', () => {
  const data = temporary(), root = path.join(data, 'original'), release = path.join(data, 'updates/releases/next/node_modules/papilot');
  try {
    fs.mkdirSync(root, { recursive: true }); writeJson(path.join(root, 'package.json'), { name: 'papilot', version: '0.6.0' });
    fs.mkdirSync(path.join(release, 'src/server'), { recursive: true }); fs.writeFileSync(path.join(release, 'src/server/start.ts'), '');
    writeJson(path.join(release, 'package.json'), { name: 'papilot', version: '0.7.0' });
    writeJson(path.join(data, 'updates/active.json'), { root: release, version: '0.7.0' });
    assert.equal(activeInstallation(root, data), release);
    assert.equal(activeInstallation(release, data), release);
    writeJson(path.join(root, 'package.json'), { name: 'papilot', version: '0.8.0' });
    assert.equal(activeInstallation(root, data), root);
    writeJson(path.join(release, 'package.json'), { name: 'papilot', version: devVersion });
    writeJson(path.join(data, 'updates/active.json'), { root: release, version: devVersion, channel: 'dev' });
    assert.equal(activeInstallation(root, data), release, 'an explicit dev selection survives the original launcher');
    writeJson(path.join(release, 'package.json'), { name: 'papilot', version: '0.7.0' });
    writeJson(path.join(data, 'updates/active.json'), { root: release, version: '0.7.0', channel: 'stable' });
    assert.equal(activeInstallation(root, data), release, 'returning to stable is an explicit selection');
    writeJson(path.join(data, 'updates/active.json'), { root: release, version: '0.7.0', channel: 'dev' });
    assert.equal(activeInstallation(root, data), root, 'the channel must match the installed version');
    writeJson(path.join(data, 'updates/active.json'), { root: '/tmp/untrusted', version: '9.0.0' });
    assert.equal(activeInstallation(root, data), root);
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

async function freePort() {
  const server = net.createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
function fakeRelease(root: string, version: string, broken = false) {
  fs.mkdirSync(path.join(root, 'src/server'), { recursive: true });
  writeJson(path.join(root, 'package.json'), { name: 'papilot', version, type: 'module' });
  fs.symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(root, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(root, 'src/server/main.ts'), `
    import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
    const data = process.env.PAPILOT_DATA;
    fs.mkdirSync(data, {recursive:true}); fs.writeFileSync(path.join(data,'child.pid'),String(process.pid));
    ${broken ? "fs.writeFileSync(path.join(data,'papilot.sqlite'),'broken migration');" : ''}
    const server = http.createServer((req,res) => {
      let active = {}; try { active = JSON.parse(fs.readFileSync(path.join(data,'updates/active.json'),'utf8')); } catch {}
      res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ name:'Papilot', version:${JSON.stringify(broken ? 'wrong' : version)}, updateInstance:active.id }));
    }); server.listen(Number(process.env.PAPILOT_PORT),'127.0.0.1');
    process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
  `);
  fs.writeFileSync(path.join(root, 'src/server/start.ts'), '');
}
for (const version of ['0.7.0', devVersion]) for (const broken of [false, true]) test(`detached activation ${version}: ${broken ? 'restores the previous runtime and database when health checks fail' : 'starts the new runtime and retains the data directory'}`, async () => {
  const data = temporary(), root = path.join(data, 'updates/releases/next'), previousRoot = path.join(data, 'old'), port = await freePort();
  try {
    fakeRelease(root, version, broken); fakeRelease(previousRoot, '0.6.0');
    fs.writeFileSync(path.join(data, 'papilot.sqlite'), 'original database');
    fs.writeFileSync(path.join(data, 'papilot.sqlite-wal'), 'committed WAL pages');
    writeJson(path.join(data, 'updates/status.json'), { currentVersion: '0.6.0', latestVersion: version, phase: 'restarting' });
    await restartRelease({ id: 'test-instance', root, version, channel: devRevision(version) ? 'dev' : 'stable', previousRoot, previousVersion: '0.6.0', data, port, parent: 2147483647, service: false }, () => {}, broken ? 3 : 30);
    for (let i = 0; i < 30 && !(await health(port, broken ? '0.6.0' : version)); i++) await sleep(100);
    assert.ok(await health(port, broken ? '0.6.0' : version));
    assert.equal(readJson(path.join(data, 'updates/status.json')).phase, broken ? 'failed' : 'updated');
    assert.equal(fs.readFileSync(path.join(data, 'papilot.sqlite'), 'utf8'), 'original database');
    assert.equal(fs.readFileSync(path.join(data, 'papilot.sqlite-wal'), 'utf8'), 'committed WAL pages');
    assert.equal(fs.existsSync(path.join(data, 'updates/install.lock')), false);
    assert.equal(readJson(path.join(data, 'updates/active.json'))?.version, broken ? undefined : version);
  } finally {
    const pid = Number(fs.existsSync(path.join(data, 'child.pid')) && fs.readFileSync(path.join(data, 'child.pid'), 'utf8'));
    if (pid) try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
    fs.rmSync(data, { recursive: true, force: true });
  }
});
test('downloaded releases must pass a real isolated server startup before activation', async () => {
  const stage = temporary(), root = path.join(stage, 'candidate'), log = fs.openSync(path.join(stage, 'probe.log'), 'w');
  try { fakeRelease(root, '0.7.0'); await probeInstallation(root, '0.7.0', stage, log); }
  finally { fs.closeSync(log); fs.rmSync(stage, { recursive: true, force: true }); }
});

for (const version of ['0.7.0', devVersion]) test(`a browser install of ${version} restarts the real server and the original launcher keeps the selected version and data`, async () => {
  const folder = temporary(), original = path.join(folder, 'original'), data = path.join(original, '.papilot');
  const candidate = path.join(data, 'updates/releases/next/node_modules/papilot'), port = await freePort();
  const log = fs.openSync(path.join(folder, 'server.log'), 'w');
  let started: ReturnType<typeof spawn> | undefined;
  const copy = (root: string, version: string) => {
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(path.join(process.cwd(), 'src'), path.join(root, 'src'), { recursive: true });
    fs.cpSync(path.join(process.cwd(), 'bin'), path.join(root, 'bin'), { recursive: true });
    writeJson(path.join(root, 'package.json'), { ...readJson(path.join(process.cwd(), 'package.json')), version });
    fs.symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(root, 'node_modules'), 'dir');
    fs.symlinkSync(path.join(process.cwd(), 'vendor'), path.join(root, 'vendor'), 'dir');
    const start = path.join(root, 'src/server/start.ts');
    fs.appendFileSync(start, "\nfs.writeFileSync(path.join(DATA, 'test-server.pid'), String(process.pid));\n");
  };
  const stop = async () => {
    const file = path.join(data, 'test-server.pid');
    const pid = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : started?.pid;
    if (pid) {
      try { process.kill(pid, 'SIGTERM'); } catch { return; }
      for (let i = 0; i < 50; i++) { try { process.kill(pid, 0); } catch { return; } await sleep(100); }
      try { process.kill(pid, 'SIGKILL'); } catch { /* stopped */ }
    }
  };
  try {
    copy(original, '0.6.0'); copy(candidate, version);
    if (devRevision(version)) writeJson(path.join(data, 'updates/channel.json'), { channel: 'dev' });
    const { Store } = await import('../src/server/store.ts');
    const store = new Store(path.join(data, 'papilot.sqlite'));
    store.saveProject({ id: 'kept-paper', name: 'Preserved paper', path: '/unused', createdAt: 1 }); store.close();
    fs.writeFileSync(path.join(original, 'boot.ts'), `
      import { Updates } from './src/server/updates.ts';
      const check = Updates.prototype.check;
      Updates.prototype.check = function () { this.options.latest = async () => ${JSON.stringify(version)}; this.options.install = async () => ${JSON.stringify(candidate)}; return check.call(this); };
      await import('./src/server/main.ts');
    `);
    const env: NodeJS.ProcessEnv = { ...process.env, PAPILOT_PORT: String(port), PAPILOT_PUBLIC_ORIGIN: '', PAPILOT_ACCOUNT_ORIGIN: '', PAPILOT_SERVICE_MANAGER: '', XPC_SERVICE_NAME: '', PAPILOT_UPDATE_PROBE: '1' };
    delete env.PAPILOT_DATA;
    const launch = (file: string) => spawn(process.execPath, ['--import', loaderFor(original), path.join(original, file)], { cwd: original, env, stdio: ['ignore', log, log] });
    started = launch('boot.ts');
    for (let i = 0; i < 60 && !(await health(port, '0.6.0')); i++) await sleep(100);
    assert.ok(await health(port, '0.6.0'));
    const base = `http://127.0.0.1:${port}`, before = await (await fetch(base + '/api/state')).json();
    const post = (route: string, body: unknown) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Papilot-Token': before.csrf }, body: JSON.stringify(body) });
    assert.equal((await (await post('/api/updates/check', {})).json()).phase, 'available');
    assert.equal((await (await post('/api/updates/install', { version })).json()).phase, 'installing');
    for (let i = 0; i < 100 && !(await health(port, version)); i++) await sleep(100);
    const diagnostics = () => [path.join(folder, 'server.log'), path.join(data, 'updates/restart.log'), path.join(data, 'updates/server.log'), path.join(data, 'updates/status.json')].filter(file => fs.existsSync(file)).map(file => fs.readFileSync(file, 'utf8')).join('\n');
    assert.ok(await health(port, version), diagnostics());
    for (let i = 0; i < 30 && readJson(path.join(data, 'updates/status.json'))?.phase !== 'updated'; i++) await sleep(100);
    assert.equal(readJson(path.join(data, 'updates/status.json')).phase, 'updated');
    assert.deepEqual((await (await fetch(base + '/api/state')).json()).projects.map((project: any) => project.id), ['kept-paper']);
    assert.equal(execFileSync(process.execPath, [path.join(original, 'bin/papilot.mjs'), '--data', data, '--version'], { encoding: 'utf8' }).trim(), version);
    await stop(); started = launch('src/server/main.ts');
    for (let i = 0; i < 60 && !(await health(port, version)); i++) await sleep(100);
    assert.ok(await health(port, version));
    assert.deepEqual((await (await fetch(base + '/api/state')).json()).projects.map((project: any) => project.id), ['kept-paper']);
  } finally { await stop(); fs.closeSync(log); fs.rmSync(folder, { recursive: true, force: true }); }
});
