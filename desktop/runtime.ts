import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';

export function backendEnvironment(node: string, root: string, data: string, inherited = process.env) {
  const home = os.homedir();
  const nvm = path.join(inherited.NVM_DIR || path.join(home, '.nvm'), 'versions/node');
  let nodeBins: string[] = [];
  try { nodeBins = fs.readdirSync(nvm).filter(version => /^v\d+\.\d+\.\d+$/.test(version)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(version => path.join(nvm, version, 'bin')); } catch { /* nvm is optional */ }
  // An installed release has its dependencies beside it in node_modules.
  const hoisted = path.basename(path.dirname(root)) === 'node_modules' ? [path.join(path.dirname(root), '.bin')] : [];
  const directories = [path.dirname(node), path.join(root, 'node_modules/.bin'), ...hoisted,
    ...(inherited.PATH || '').split(path.delimiter),
    ...['.local/bin', '.claude/local', '.kimi-code/bin', '.grok/bin', '.opencode/bin', '.bun/bin', '.npm-global/bin', '.volta/bin', '.asdf/shims'].map(dir => path.join(home, dir)), ...nodeBins,
    '/Library/TeX/texbin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const env = { ...inherited, PATH: [...new Set(directories.filter(dir => path.isAbsolute(dir)))].join(path.delimiter),
    NODE_ENV: 'production', PAPILOT_DESKTOP: '1', PAPILOT_DATA: data, PAPILOT_PORT: '0',
    PAPILOT_PUBLIC_ORIGIN: '', PAPILOT_ACCOUNT_ORIGIN: '', PAPILOT_TAILSCALE_LOGIN: '' };
  // The backend is ordinary Node, even when Electron itself was started by a tool.
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'PAPILOT_REVIEW_ENGINE']) delete (env as NodeJS.ProcessEnv)[key];
  return env;
}

export function startBackend(options: { node: string; root: string; data: string; log: string; env: NodeJS.ProcessEnv }) {
  fs.mkdirSync(options.data, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(options.log), { recursive: true });
  // Bound the log across launches without discarding the previous startup failure.
  if (fs.existsSync(options.log) && fs.statSync(options.log).size > 5 * 1024 * 1024) fs.renameSync(options.log, options.log + '.old');
  const fd = fs.openSync(options.log, 'a', 0o600);
  const loaders = [path.join(options.root, 'node_modules/tsx/dist/loader.mjs'), path.join(path.dirname(options.root), 'tsx/dist/loader.mjs')];
  let child: ChildProcess;
  try {
    child = spawn(options.node, ['--import', loaders.find(file => fs.existsSync(file)) || loaders[0], path.join(options.root, 'src/server/start.ts')], {
      cwd: options.root, env: options.env, stdio: ['ignore', fd, fd, 'ipc'], detached: process.platform !== 'win32',
    });
  } finally { fs.closeSync(fd); }
  const ready = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error('The local server did not start within 60 seconds.')), 60000);
    const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('error', fail); child.off('exit', exited); };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const exited = (code: number | null, signal: string | null) => fail(new Error(`The local server stopped (${signal || code}).`));
    const message = (value: unknown) => {
      if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'papilot:ready' || !('url' in value) || typeof value.url !== 'string') return;
      const url = new URL(value.url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !Number(url.port)) return;
      cleanup(); resolve(url.origin);
    };
    child.on('message', message); child.once('error', fail); child.once('exit', exited);
  });
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already stopped */ }
        resolve();
      }, 4000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }
  return { child, ready, stop };
}

// Updates follow the Obsidian model. The installer carries Electron, Node,
// Codex and a tested Papilot. Newer Papilot releases from npm install into the
// data directory and run on this installer when it provides the desktop shell
// level they declare in package.json (`desktopShell`). Otherwise the user
// downloads a new installer.
export interface Bundle { root: string; version: string; shell: number }
type Json = Record<string, any> | null;
const readJson = (file: string): Json => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
const parts = (value: unknown) => typeof value === 'string' ? /^(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number) : undefined;
export function newer(next: unknown, current: string) {
  const a = parts(next), b = parts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export const supports = (pkg: Json, shell: number) => Number.isInteger(pkg?.desktopShell) && pkg!.desktopShell >= 1 && pkg!.desktopShell <= shell;
const files = (data: string) => {
  const folder = path.join(data, 'updates');
  return { folder, releases: path.join(folder, 'releases'), active: path.join(folder, 'active.json'), status: path.join(folder, 'status.json'), lock: path.join(folder, 'install.lock') };
};
// A release this installer can run: newer than its own Papilot and installed
// by the updater under the data directory.
export function release(data: string, bundle: Bundle, root: unknown, version: unknown) {
  if (typeof root !== 'string' || typeof version !== 'string' || !newer(version, bundle.version)) return null;
  try { if (!fs.realpathSync(root).startsWith(fs.realpathSync(files(data).releases) + path.sep)) return null; } catch { return null; }
  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg?.name !== 'papilot' || pkg.version !== version || !supports(pkg, bundle.shell) || !fs.existsSync(path.join(root, 'src/server/start.ts'))) return null;
  return { root, version };
}
export function activeRelease(data: string, bundle: Bundle) {
  const active = readJson(files(data).active);
  return active?.phase === 'active' ? release(data, bundle, active.root, active.version) : null;
}
export function removeReleases(data: string, keep?: string) {
  const { releases } = files(data);
  let entries: string[] = [], kept = '';
  try { entries = fs.readdirSync(releases); } catch { return; }
  try { if (keep) kept = path.relative(fs.realpathSync(releases), fs.realpathSync(keep)).split(path.sep)[0]; } catch { /* keep nothing */ }
  for (const entry of entries) if (entry !== kept) fs.rmSync(path.join(releases, entry), { recursive: true, force: true });
}
// The updater installs a newer tested Codex beside a release that needs it.
export function codexFor(root: string, bundle: string) {
  return [path.join(root, 'node_modules/.bin/codex'), path.resolve(root, '../../codex/node_modules/.bin/codex'), path.join(bundle, 'node_modules/.bin/codex')].find(file => fs.existsSync(file));
}
export const STARTUP_FAILED = 'The updated version did not start, so Papilot is using the version included with the app. Retry the update or download the latest desktop app.';
// Starts the active release, or this installer's own Papilot when there is
// none or it fails. Returns the root that is running.
export async function startServer(data: string, bundle: Bundle, launch: (root: string) => Promise<void>) {
  // Development builds share the app's data directory; leave its updates alone.
  if (!bundle.shell) { await launch(bundle.root); return bundle.root; }
  const { active, status } = files(data), chosen = activeRelease(data, bundle);
  removeReleases(data, chosen?.root);
  if (!chosen) { fs.rmSync(active, { force: true }); await launch(bundle.root); return bundle.root; }
  try { await launch(chosen.root); return chosen.root; }
  catch (error) {
    console.error(`Papilot ${chosen.version} did not start:`, error);
    fs.rmSync(active, { force: true });
    writeJson(status, { ...readJson(status), phase: 'failed', checkedAt: Date.now(), error: STARTUP_FAILED, pid: process.pid });
    await launch(bundle.root);
    return bundle.root;
  }
}
// Replaces the running backend with an installed release once the backend has
// finished its work, as update-worker.ts does for the CLI. If the release does
// not start, the database and the previous version are restored. Returns the
// root that is running.
export async function switchServer(data: string, bundle: Bundle, request: unknown, current: string, stop: () => Promise<void>, launch: (root: string) => Promise<void>) {
  const paths = files(data), status = readJson(paths.status) || {};
  const value = request && typeof request === 'object' ? request as Record<string, unknown> : {};
  const target = release(data, bundle, value.root, value.version);
  if (!target) {
    writeJson(paths.status, { ...status, phase: 'failed', checkedAt: Date.now(), error: 'Invalid update activation.', pid: process.pid });
    fs.rmSync(paths.lock, { force: true });
    return current;
  }
  const previous = readJson(paths.active), id = randomUUID();
  const database = path.join(data, 'papilot.sqlite'), backup = path.join(paths.folder, 'before-update.sqlite');
  let backedUp = false;
  try {
    await stop();
    if (fs.existsSync(database)) {
      fs.copyFileSync(database, backup); backedUp = true;
      // A forced shutdown may leave committed pages in the WAL.
      if (fs.existsSync(database + '-wal')) fs.copyFileSync(database + '-wal', backup + '-wal');
      else fs.rmSync(backup + '-wal', { force: true });
    }
    writeJson(paths.status, { ...status, phase: 'restarting', pid: process.pid });
    writeJson(paths.active, { root: target.root, version: target.version, id, phase: 'starting' });
    try {
      await launch(target.root);
      writeJson(paths.active, { root: target.root, version: target.version, id, phase: 'active' });
      writeJson(paths.status, { ...status, phase: 'updated', currentVersion: target.version, error: null, pid: process.pid });
      removeReleases(data, target.root);
      return target.root;
    } catch (error) {
      if (previous) writeJson(paths.active, previous); else fs.rmSync(paths.active, { force: true });
      if (backedUp) {
        for (const suffix of ['-wal', '-shm']) fs.rmSync(database + suffix, { force: true });
        fs.copyFileSync(backup, database);
        if (fs.existsSync(backup + '-wal')) fs.copyFileSync(backup + '-wal', database + '-wal');
      }
      writeJson(paths.status, { ...status, phase: 'failed', checkedAt: Date.now(), error: `${error instanceof Error ? error.message : 'The update failed.'} The previous version has been restored.`, pid: process.pid });
      await launch(current);
      return current;
    }
  } finally { fs.rmSync(paths.lock, { force: true }); }
}
