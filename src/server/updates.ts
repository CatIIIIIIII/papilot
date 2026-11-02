import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { devRevision, newerVersion, readJson, stableVersion, writeJson } from '../../bin/installation.mjs';
import { download, installLayer, installRelease, loaderFor, npmCli, type DesktopLayer } from './update-install.ts';
import type { UpdateChannel, UpdateStatus } from '../shared.ts';

const activePhases = new Set(['installing', 'waiting', 'restarting']);
export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function releaseInfo(url: string, fetcher: typeof fetch, limit = 256000, missing?: null) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(10000), redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'Papilot' } });
  if (response.status === 404 && missing === null) return null;
  if (!response.ok) throw new Error('Could not check for updates.');
  const text = await response.text();
  if (text.length > limit) throw new Error('Invalid release information.');
  return JSON.parse(text);
}
// The package.json of the newest release on a channel.
export async function latestManifest(channel: UpdateChannel = 'stable', fetcher = fetch): Promise<Record<string, any>> {
  if (channel === 'dev') {
    const commit = await releaseInfo('https://api.github.com/repos/PapilotAI/papilot/git/ref/heads/main', fetcher);
    const revision = commit.object?.sha;
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid development revision.');
    const pkg = await releaseInfo(`https://raw.githubusercontent.com/PapilotAI/papilot/${revision}/package.json`, fetcher);
    if (pkg.name !== 'papilot' || !stableVersion(pkg.version)) throw new Error('Invalid development version.');
    return { ...pkg, version: `${pkg.version}-dev.${revision}` };
  }
  const pkg = await releaseInfo('https://registry.npmjs.org/papilot/latest', fetcher);
  if (pkg.name !== 'papilot' || !stableVersion(pkg.version)) throw new Error('Invalid release information.');
  return pkg;
}
export const latestRelease = async (channel: UpdateChannel = 'stable', fetcher = fetch) => (await latestManifest(channel, fetcher)).version as string;
export const DESKTOP_RELEASES = 'https://github.com/PapilotAI/papilot/releases';
// Nightly builds of main replace the assets of this one prerelease.
export const DESKTOP_DEV_TAG = 'desktop-dev';
const DESKTOP_API = 'https://api.github.com/repos/PapilotAI/papilot';
// The smoke test serves releases locally.
const desktopApi = () => process.env.PAPILOT_DESKTOP_UPDATE_SOURCE ? process.env.PAPILOT_DESKTOP_UPDATE_SOURCE.replace(/\/+$/, '') + '/repos/PapilotAI/papilot' : DESKTOP_API;
export interface DesktopRelease { version: string; downloadUrl: string; layer?: DesktopLayer }
const asset = (release: any, name: unknown) => release.assets.find((asset: any) => asset.name === name && asset.state === 'uploaded' && asset.size > 0 && typeof asset.browser_download_url === 'string');
// desktop.json (written by scripts/desktop-layer.mjs) names the release's
// version, its update layer and the installer shell that layer runs on.
async function desktopManifest(release: any, fetcher: typeof fetch) {
  const listed = asset(release, 'desktop.json');
  if (!listed) return null;
  try { return JSON.parse((await download(listed.browser_download_url, fetcher, 64 * 1024)).toString('utf8')); }
  catch { throw new Error('Could not check for updates.'); }
}
function desktopLayer(release: any, manifest: any, version: string, fingerprint: string): DesktopLayer | undefined {
  const layer = manifest?.layer, file = layer && asset(release, layer.name);
  if (!fingerprint || manifest?.format !== 1 || manifest.version !== version || manifest.fingerprint !== fingerprint || !file || file.size !== layer.size || !/^[a-f0-9]{64}$/.test(layer.sha256)) return undefined;
  return { url: file.browser_download_url, size: layer.size, sha256: layer.sha256 };
}
// Stable: npm can be published before desktop builds finish. Only advertise
// releases with an uploaded installer for this OS and CPU, and link to that
// exact release. Dev: the latest nightly build of main. Either includes the update layer
// when it was built for this installer's shell (fingerprint).
export async function latestDesktopRelease(platform = process.platform, arch = process.arch, fetcher = fetch, channel: UpdateChannel = 'stable', fingerprint = ''): Promise<DesktopRelease | null> {
  if (channel === 'dev') {
    const release = await releaseInfo(`${desktopApi()}/releases/tags/${DESKTOP_DEV_TAG}`, fetcher, 4 * 1024 * 1024, null);
    if (!release) return null;
    if (!Array.isArray(release.assets) || release.draft !== false) throw new Error('Invalid release information.');
    const manifest = await desktopManifest(release, fetcher);
    if (!manifest) return null;
    if (!devRevision(manifest.version)) throw new Error('Invalid release information.');
    const layer = desktopLayer(release, manifest, manifest.version, fingerprint);
    return { version: manifest.version, downloadUrl: `${DESKTOP_RELEASES}/tag/${DESKTOP_DEV_TAG}`, ...(layer ? { layer } : {}) };
  }
  const releases = await releaseInfo(`${desktopApi()}/releases?per_page=100`, fetcher, 4 * 1024 * 1024);
  if (!Array.isArray(releases)) throw new Error('Invalid release information.');
  let latest: { version: string; downloadUrl: string; release: any } | null = null;
  for (const release of releases) {
    const version = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : '';
    if (release.draft !== false || release.prerelease !== false || !stableVersion(version) || !Array.isArray(release.assets)) continue;
    const names = platform === 'darwin' && ['arm64', 'x64'].includes(arch) ? [`Papilot-${version}-mac-${arch}.dmg`, `Papilot-${version}-mac-${arch}.zip`]
      : platform === 'linux' && ['arm64', 'x64'].includes(arch) ? [`Papilot-${version}-linux-${arch === 'x64' ? 'x86_64' : arch}.AppImage`, `Papilot-${version}-linux-${arch === 'x64' ? 'amd64' : arch}.deb`] : [];
    if (!release.assets.some((asset: any) => asset.state === 'uploaded' && asset.size > 0 && names.includes(asset.name))) continue;
    if (!latest || newerVersion(version, latest.version)) latest = { version, downloadUrl: `${DESKTOP_RELEASES}/tag/${release.tag_name}`, release };
  }
  if (!latest) return null;
  const layer = fingerprint ? desktopLayer(latest.release, await desktopManifest(latest.release, fetcher), latest.version, fingerprint) : undefined;
  return { version: latest.version, downloadUrl: latest.downloadUrl, ...(layer ? { layer } : {}) };
}
const validTarget = (version: unknown, channel: UpdateChannel): version is string => channel === 'dev' ? Boolean(devRevision(version)) : stableVersion(version);
const available = (next: string, current: string, channel: UpdateChannel) => validTarget(next, channel)
  && (channel === 'dev' || devRevision(current) ? next !== current : newerVersion(next, current));
interface Options {
  desktop?: boolean;
  // A packaged desktop app: its bundled server and shell fingerprint.
  bundle?: { root: string; version: string; fingerprint: string };
  latestDesktop?: (channel: UpdateChannel) => Promise<DesktopRelease | null>;
  installLayer?: (data: string, version: string, layer: DesktopLayer, bundle: { root: string; fingerprint: string }) => Promise<string>;
  root: string; data: string; version: string; port: number;
  busy: () => boolean; shutdown: () => void;
  latest?: (channel: UpdateChannel) => Promise<string | Record<string, any>>; install?: (data: string, version: string) => Promise<string>;
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
  private channelFile: string;
  // Desktop: the release page when the update needs a new installer.
  private downloadUrl?: string;
  private target: DesktopRelease | null = null;
  // Only packaged desktop apps install layers; the development app links to releases.
  private layers: boolean;
  constructor(private options: Options) {
    const folder = path.join(options.data, options.desktop ? 'updates/desktop' : 'updates');
    this.file = path.join(folder, 'status.json'); this.lock = path.join(folder, 'install.lock'); this.channelFile = path.join(folder, 'channel.json');
    this.layers = Boolean(options.desktop && options.bundle?.fingerprint);
    if (options.desktop && !this.layers) this.downloadUrl = DESKTOP_RELEASES;
    const preference = readJson(this.channelFile)?.channel;
    this.channel = options.desktop && !this.layers ? 'stable' : preference === 'dev' || preference === 'stable' ? preference : devRevision(options.version) ? 'dev' : 'stable';
    let supported = options.desktop ? this.layers : options.supported ?? true;
    if (!options.desktop && options.supported === undefined) try { npmCli(); } catch { supported = false; }
    this.state = { currentVersion: options.version, latestVersion: null, phase: 'idle', checkedAt: null, error: null, canUpdate: supported };
    const saved = options.desktop && !this.layers ? null : readJson(this.file);
    if (saved && ['failed', 'updated', 'installing', 'waiting', 'restarting'].includes(saved.phase)) this.state = { ...this.state, ...saved, currentVersion: options.version, canUpdate: supported };
    if (saved && activePhases.has(saved.phase) && !alive(saved.pid)) this.change({ phase: 'failed', checkedAt: Date.now(), error: 'The update was interrupted. Your current installation is still available; retry the update.' });
  }
  snapshot(): UpdateStatus {
    const saved = readJson(this.file);
    if (saved && activePhases.has(this.state.phase) && ['updated', 'failed'].includes(saved.phase)) this.state = { ...this.state, ...saved, currentVersion: this.options.version };
    const { currentVersion, latestVersion, phase, checkedAt, error, canUpdate } = this.state, desktop = this.options.desktop;
    if (desktop && !this.layers) return { currentVersion, latestVersion, phase, checkedAt, error, canUpdate: false, downloadUrl: this.downloadUrl };
    return { currentVersion, latestVersion, phase, checkedAt, error, canUpdate, channel: this.channel, ...(this.downloadUrl ? { downloadUrl: this.downloadUrl } : {}) };
  }
  get restarting() { return this.snapshot().phase === 'restarting'; }
  enter() { this.inFlight++; let released = false; return () => { if (!released) { released = true; this.inFlight--; } }; }
  start() {
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
    if (this.options.desktop && !this.layers) throw new Error('Download desktop updates from GitHub Releases.');
    if (channel !== 'stable' && channel !== 'dev') throw new Error('Choose a valid update channel.');
    if (activePhases.has(this.state.phase)) throw new Error('Wait for the current update to finish before changing channels.');
    if (channel === this.channel) return this.check();
    this.channel = channel;
    writeJson(this.channelFile, { channel });
    this.checking = null; this.target = null;
    if (this.layers) this.downloadUrl = undefined;
    this.change({ latestVersion: null, checkedAt: null, phase: 'idle', error: null });
    return this.check();
  }
  check(): Promise<UpdateStatus> {
    if (this.checking) return this.checking;
    if (activePhases.has(this.state.phase)) return Promise.resolve(this.snapshot());
    this.change({ phase: 'checking' });
    const channel = this.channel;
    const discovery = this.options.desktop ? this.desktopRelease(channel) : (this.options.latest || latestManifest)(channel);
    const checking = discovery.then(found => {
      const manifest = typeof found === 'string' ? { version: found } : found;
      if (!manifest && this.options.desktop) {
        if (!this.closed && this.checking === checking && !activePhases.has(this.state.phase)) {
          this.target = null; this.downloadUrl = this.layers ? undefined : DESKTOP_RELEASES;
          this.change({ latestVersion: null, checkedAt: Date.now(), error: null, phase: 'idle' });
        }
        return this.snapshot();
      }
      const version = manifest?.version;
      if (!validTarget(version, channel)) throw new Error('Invalid release version.');
      if (!this.closed && this.checking === checking && !activePhases.has(this.state.phase)) {
        const newer = available(version, this.options.version, channel);
        if (this.options.desktop) {
          const release = manifest as DesktopRelease, bundled = version === this.options.bundle?.version;
          // A layer for this shell, or the installer's own server, installs in place.
          this.target = this.layers && newer && (release.layer || bundled) ? release : null;
          this.downloadUrl = this.layers ? newer && !this.target ? release.downloadUrl : undefined : release.downloadUrl;
        }
        this.change({ latestVersion: version, checkedAt: Date.now(), error: null, phase: newer ? 'available' : 'idle' });
      }
      return this.snapshot();
    }).catch(() => {
      if (!this.closed && this.checking === checking && !activePhases.has(this.state.phase)) this.change({ phase: this.state.latestVersion && available(this.state.latestVersion, this.options.version, channel) ? 'available' : 'idle', checkedAt: Date.now(), error: 'Could not check for updates. Try again when connected.' });
      return this.snapshot();
    }).finally(() => { if (this.checking === checking) this.checking = null; });
    this.checking = checking;
    return this.checking;
  }
  private desktopRelease(channel: UpdateChannel) {
    return (this.options.latestDesktop || (channel => latestDesktopRelease(process.platform, process.arch, fetch, channel, this.options.bundle?.fingerprint)))(channel);
  }
  // A retry after a restart finds the release again; the check that offered it
  // happened in the previous process.
  private async desktopLayer(version: string) {
    const bundle = this.options.bundle!;
    if (version === bundle.version) return bundle.root;
    let release = this.target;
    if (release?.version !== version) release = await this.desktopRelease(this.channel);
    if (release?.version !== version || !release.layer) throw new Error('Check for a newer release before updating.');
    return (this.options.installLayer || installLayer)(this.options.data, version, release.layer, bundle);
  }
  install(version: unknown) {
    if (this.options.desktop && !this.layers) throw new Error('Download desktop updates from GitHub Releases.');
    if (activePhases.has(this.state.phase)) return this.snapshot();
    if (this.options.desktop && this.downloadUrl) throw new Error('Download desktop updates from GitHub Releases.');
    if (!this.state.canUpdate) throw new Error('npm is unavailable to Papilot.');
    if (!validTarget(version, this.channel) || version !== this.state.latestVersion || !available(version, this.options.version, this.channel)) throw new Error('Check for a newer release before updating.');
    fs.mkdirSync(path.dirname(this.lock), { recursive: true, mode: 0o700 });
    const previous = readJson(this.lock);
    if (previous && alive(previous.pid)) throw new Error('Another Papilot instance is already updating.');
    if (previous) fs.rmSync(this.lock);
    const fd = fs.openSync(this.lock, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.closeSync(fd);
    this.change({ phase: 'installing', error: null });
    // Returning to the installer's own version needs no download.
    const installing = this.options.desktop ? this.desktopLayer(version) : (this.options.install || installRelease)(this.options.data, version);
    void installing.then(root => {
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
