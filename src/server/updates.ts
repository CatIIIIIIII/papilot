import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { devRevision, newerVersion, readJson, stableVersion, writeJson } from '../../bin/installation.mjs';
import { installRelease, loaderFor, npmCli } from './update-install.ts';
import type { UpdateChannel, UpdateStatus } from '../shared.ts';

const activePhases = new Set(['installing', 'waiting', 'restarting']);
export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function releaseInfo(url: string, fetcher: typeof fetch) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(10000), redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'Papilot' } });
  if (!response.ok) throw new Error('Could not check for updates.');
  const text = await response.text();
  if (text.length > 256000) throw new Error('Invalid release information.');
  return JSON.parse(text);
}
export async function latestRelease(channel: UpdateChannel = 'stable', fetcher = fetch): Promise<string> {
  if (channel === 'dev') {
    const commit = await releaseInfo('https://api.github.com/repos/PapilotAI/papilot/git/ref/heads/main', fetcher);
    const revision = commit.object?.sha;
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid development revision.');
    const pkg = await releaseInfo(`https://raw.githubusercontent.com/PapilotAI/papilot/${revision}/package.json`, fetcher);
    if (pkg.name !== 'papilot' || !stableVersion(pkg.version)) throw new Error('Invalid development version.');
    return `${pkg.version}-dev.${revision}`;
  }
  const pkg = await releaseInfo('https://registry.npmjs.org/papilot/latest', fetcher);
  if (pkg.name !== 'papilot' || !stableVersion(pkg.version)) throw new Error('Invalid release information.');
  return pkg.version;
}
const validTarget = (version: unknown, channel: UpdateChannel): version is string => channel === 'dev' ? Boolean(devRevision(version)) : stableVersion(version);
const available = (next: string, current: string, channel: UpdateChannel) => validTarget(next, channel)
  && (channel === 'dev' || devRevision(current) ? next !== current : newerVersion(next, current));
interface Options {
  downloadUrl?: string;
  root: string; data: string; version: string; port: number;
  busy: () => boolean; shutdown: () => void;
  latest?: (channel: UpdateChannel) => Promise<string>; install?: (data: string, version: string) => Promise<string>;
  restart?: (root: string, version: string) => Promise<void>; supported?: boolean;
}
// Both HTTP listeners share one updater. Downloads do not interrupt editing;
// only the short activation window refuses new work and waits for quiescence.
export class Updates {
  private state: UpdateStatus;
  private checking: Promise<UpdateStatus> | null = null;
  private prepared = '';
  private inFlight = 0;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private file: string;
  private lock: string;
  private channel: UpdateChannel;
  constructor(private options: Options) {
    this.file = path.join(options.data, 'updates/status.json'); this.lock = path.join(options.data, 'updates/install.lock');
    const preference = readJson(path.join(options.data, 'updates/channel.json'))?.channel;
    this.channel = options.downloadUrl ? 'stable' : preference === 'dev' || preference === 'stable' ? preference : devRevision(options.version) ? 'dev' : 'stable';
    let supported = options.supported ?? true;
    if (options.supported === undefined) try { npmCli(); } catch { supported = false; }
    this.state = { currentVersion: options.version, latestVersion: null, phase: 'idle', checkedAt: null, error: null, canUpdate: supported };
    const saved = readJson(this.file);
    if (saved && ['failed', 'updated', 'installing', 'waiting', 'restarting'].includes(saved.phase)) this.state = { ...this.state, ...saved, currentVersion: options.version, canUpdate: supported };
    if (saved && activePhases.has(saved.phase) && !alive(saved.pid)) this.change({ phase: 'failed', checkedAt: Date.now(), error: 'The update was interrupted. Your current installation is still available; retry the update.' });
  }
  snapshot(): UpdateStatus {
    if (this.options.downloadUrl) return { currentVersion: this.options.version, latestVersion: null, phase: 'idle', checkedAt: null, error: null, canUpdate: false, channel: 'stable', downloadUrl: this.options.downloadUrl };
    const saved = readJson(this.file);
    if (saved && activePhases.has(this.state.phase) && ['updated', 'failed'].includes(saved.phase)) this.state = { ...this.state, ...saved, currentVersion: this.options.version };
    const { currentVersion, latestVersion, phase, checkedAt, error, canUpdate } = this.state;
    return { currentVersion, latestVersion, phase, checkedAt, error, canUpdate, channel: this.channel };
  }
  get restarting() { return this.snapshot().phase === 'restarting'; }
  enter() { this.inFlight++; let released = false; return () => { if (!released) { released = true; this.inFlight--; } }; }
  start() {
    if (this.options.downloadUrl) return;
    if (this.state.phase !== 'failed') void this.check();
    this.timer = setInterval(() => {
      if (this.state.phase === 'waiting') void this.activate();
      else if (!activePhases.has(this.state.phase) && Date.now() - (this.state.checkedAt || 0) > 6 * 3600000) void this.check();
    }, 2000); this.timer.unref();
  }
  close() { this.closed = true; clearInterval(this.timer); }
  private change(patch: Partial<UpdateStatus>) {
    this.state = { ...this.state, ...patch };
    writeJson(this.file, { ...this.state, pid: process.pid });
  }
  setChannel(channel: unknown) {
    if (this.options.downloadUrl) throw new Error('Download desktop updates from GitHub Releases.');
    if (channel !== 'stable' && channel !== 'dev') throw new Error('Choose a valid update channel.');
    if (activePhases.has(this.state.phase)) throw new Error('Wait for the current update to finish before changing channels.');
    if (channel === this.channel) return this.check();
    this.channel = channel;
    writeJson(path.join(this.options.data, 'updates/channel.json'), { channel });
    this.checking = null;
    this.change({ latestVersion: null, checkedAt: null, phase: 'idle', error: null });
    return this.check();
  }
  check(): Promise<UpdateStatus> {
    if (this.options.downloadUrl) return Promise.resolve(this.snapshot());
    if (this.checking) return this.checking;
    if (activePhases.has(this.state.phase)) return Promise.resolve(this.snapshot());
    this.change({ phase: 'checking' });
    const channel = this.channel;
    const checking = (this.options.latest || latestRelease)(channel).then(version => {
      if (!validTarget(version, channel)) throw new Error('Invalid release version.');
      if (!this.closed && this.checking === checking && !activePhases.has(this.state.phase)) this.change({ latestVersion: version, checkedAt: Date.now(), error: null, phase: available(version, this.options.version, channel) ? 'available' : 'idle' });
      return this.snapshot();
    }).catch(() => {
      if (!this.closed && this.checking === checking && !activePhases.has(this.state.phase)) this.change({ phase: this.state.latestVersion && available(this.state.latestVersion, this.options.version, channel) ? 'available' : 'idle', checkedAt: Date.now(), error: 'Could not check for updates. Try again when connected.' });
      return this.snapshot();
    }).finally(() => { if (this.checking === checking) this.checking = null; });
    this.checking = checking;
    return this.checking;
  }
  install(version: unknown) {
    if (this.options.downloadUrl) throw new Error('Download desktop updates from GitHub Releases.');
    if (activePhases.has(this.state.phase)) return this.snapshot();
    if (!this.state.canUpdate) throw new Error('npm is unavailable to Papilot.');
    if (!validTarget(version, this.channel) || version !== this.state.latestVersion || !available(version, this.options.version, this.channel)) throw new Error('Check for a newer release before updating.');
    fs.mkdirSync(path.dirname(this.lock), { recursive: true, mode: 0o700 });
    const previous = readJson(this.lock);
    if (previous && alive(previous.pid)) throw new Error('Another Papilot instance is already updating.');
    if (previous) fs.rmSync(this.lock);
    const fd = fs.openSync(this.lock, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.closeSync(fd);
    this.change({ phase: 'installing', error: null });
    void (this.options.install || installRelease)(this.options.data, version).then(root => {
      if (this.closed) return;
      this.prepared = root; this.change({ phase: 'waiting' });
      return this.activate();
    }).catch(error => { this.change({ phase: 'failed', error: error instanceof Error ? error.message : 'The update failed.' }); this.release(); });
    return this.snapshot();
  }
  // Public for deterministic tests; the periodic tick calls this in production.
  async activate() {
    if (this.closed || this.state.phase !== 'waiting' || !this.prepared || this.inFlight || this.options.busy()) return;
    this.change({ phase: 'restarting' });
    try { await (this.options.restart || this.restart.bind(this))(this.prepared, this.state.latestVersion!); }
    catch (error) { this.change({ phase: 'failed', error: error instanceof Error ? error.message : 'Could not restart Papilot.' }); this.release(); }
  }
  private release() { const lock = readJson(this.lock); if (lock?.pid === process.pid) fs.rmSync(this.lock, { force: true }); }
  private restart(root: string, version: string) {
    const folder = path.dirname(this.file), job = path.join(folder, 'restart.json');
    writeJson(job, { id: randomUUID(), root, version, channel: this.channel, previousRoot: this.options.root, previousVersion: this.options.version, data: this.options.data, port: this.options.port, parent: process.pid,
      service: process.env.PAPILOT_SERVICE_MANAGER === 'launchd' || process.env.XPC_SERVICE_NAME === 'local.papilot' });
    const log = fs.openSync(path.join(folder, 'restart.log'), 'a', 0o600);
    const child = spawn(process.execPath, ['--import', loaderFor(this.options.root), path.join(this.options.root, 'src/server/update-worker.ts'), job], { cwd: this.options.root, env: process.env, detached: true, stdio: ['ignore', log, log, 'ipc'] });
    fs.closeSync(log);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('The update restart helper did not start.')); }, 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`The update restart helper stopped (${code}).`)); });
      child.once('message', message => {
        if (message !== 'ready') return;
        clearTimeout(timer); child.disconnect(); child.unref(); resolve(); this.options.shutdown();
      });
    });
  }
}
