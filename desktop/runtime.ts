import { envPath, terminateTree } from './platform.mjs';
import { pathToFileURL } from 'node:url';
import { agentDirs } from './agent-paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

// Installers update the registry, but a running Electron process retains its
// old PATH even across app.relaunch(). Use the same refresh for checks and launch.
export async function refreshWindowsPath(inherited = process.env): Promise<NodeJS.ProcessEnv> {
  if (process.platform !== 'win32') return inherited;
  try {
    const { stdout } = await promisify(execFile)(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetEnvironmentVariable("Path","Machine")+";"+[Environment]::GetEnvironmentVariable("Path","User")'], { windowsHide: true, timeout: 8000, maxBuffer: 65536 });
    const paths = Object.keys(inherited).filter(key => key.toLowerCase() === 'path').map(key => inherited[key]);
    return { ...inherited, PATH: [...paths, stdout.trim()].filter(Boolean).join(';') };
  } catch { return inherited; }
}

export function npmBinFolder(prefix: string, platform: NodeJS.Platform = process.platform) {
  return platform === 'win32' ? path.win32.normalize(prefix) : path.posix.join(prefix, 'bin');
}

export function backendEnvironment(node: string, root: string, data: string, inherited = process.env) {
  // Windows may supply both Path and PATH. Keep every inherited directory
  // before emitting a single canonical key for the backend.
  const inheritedPath = process.platform === 'win32'
    ? Object.keys(inherited).filter(key => key.toLowerCase() === 'path').map(key => inherited[key] || '').join(path.delimiter)
    : envPath(inherited);
  const home = (process.platform === 'win32' ? inherited.USERPROFILE || inherited.HOME : inherited.HOME) || os.homedir();
  const nvm = path.join(inherited.NVM_DIR || path.join(home, '.nvm'), 'versions/node');
  let nodeBins: string[] = [];
  try { nodeBins = fs.readdirSync(nvm).filter(version => /^v\d+\.\d+\.\d+$/.test(version)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(version => path.join(nvm, version, 'bin')); } catch { /* nvm is optional */ }
  let npmBin: string[] = [];
  try {
    const prefix = fs.readFileSync(path.join(home, '.npmrc'), 'utf8').match(/^\s*prefix\s*=\s*(.+?)\s*$/m)?.[1].replace(/^(['"])(.*)\1$/, '$2')
      .replace(/\$\{([^}]+)\}/g, (match, name) => inherited[name] ?? match);
    if (prefix) npmBin = [npmBinFolder(prefix.startsWith('~/') ? path.join(home, prefix.slice(2)) : prefix)];
  } catch { /* a custom npm prefix is optional */ }
  const fnm = [inherited.FNM_DIR || path.join(home, '.local/share/fnm'), path.join(home, 'Library/Application Support/fnm')];
  // An installed release has its dependencies beside it in node_modules.
  const hoisted = path.basename(path.dirname(root)) === 'node_modules' ? [path.join(path.dirname(root), '.bin')] : [];
  const directories = [path.dirname(node), path.join(root, 'node_modules/.bin'), ...hoisted,
    ...inheritedPath.split(path.delimiter), ...agentDirs(inherited),
    ...['.local/bin', '.claude/local', '.kimi-code/bin', '.grok/bin', '.opencode/bin', '.bun/bin', '.npm-global/bin', '.volta/bin', '.asdf/shims'].map(dir => path.join(home, dir)),
    // Finder does not load the shell setup that adds these Node/npm installations.
    inherited.PNPM_HOME || '', ...['Library/pnpm', '.local/share/pnpm', '.local/share/mise/shims', '.yarn/bin'].map(dir => path.join(home, dir)),
    ...fnm.map(dir => path.join(dir, 'aliases/default/bin')), ...npmBin, ...nodeBins,
    '/Library/TeX/texbin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const env = { ...inherited, PATH: [...new Set(directories.filter(dir => path.isAbsolute(dir)))].join(path.delimiter),
    NODE_ENV: 'production', PAPILOT_DESKTOP: '1', PAPILOT_DATA: data, PAPILOT_PORT: '0',
    PAPILOT_PUBLIC_ORIGIN: '', PAPILOT_TAILSCALE_LOGIN: '' };
  // The backend is ordinary Node, even when Electron itself was started by a tool.
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'PAPILOT_REVIEW_ENGINE', 'PAPILOT_DESKTOP_SHELL', 'PAPILOT_DESKTOP_INSTALLER', 'PAPILOT_DESKTOP_CODEX',
    'PAPILOT_DESKTOP_BUNDLE', 'PAPILOT_DESKTOP_FINGERPRINT']) delete (env as NodeJS.ProcessEnv)[key];
  if (process.platform === 'win32') for (const key of Object.keys(env)) if (key !== 'PATH' && key.toLowerCase() === 'path') delete (env as NodeJS.ProcessEnv)[key];
  return env;
}

// Callers must not replace a database or launch another server while its
// previous writer may still be running.
export class BackendStopError extends Error {}

export function startBackend(options: { node: string; root: string; data: string; log: string; env: NodeJS.ProcessEnv }) {
  fs.mkdirSync(options.data, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(options.log), { recursive: true });
  // Bound the log across launches without discarding the previous startup failure.
  if (fs.existsSync(options.log) && fs.statSync(options.log).size > 5 * 1024 * 1024) fs.renameSync(options.log, options.log + '.old');
  const fd = fs.openSync(options.log, 'a', 0o600);
  const loaders = [path.join(options.root, 'node_modules/tsx/dist/loader.mjs'), path.join(path.dirname(options.root), 'tsx/dist/loader.mjs')];
  let child: ChildProcess;
  try {
    child = spawn(options.node, ['--import', pathToFileURL(loaders.find(file => fs.existsSync(file)) || loaders[0]).href, path.join(options.root, 'src/server/start.ts')], {
      cwd: options.root, env: options.env, windowsHide: true, stdio: ['ignore', fd, fd, 'ipc'], detached: process.platform !== 'win32',
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
  let stopping: Promise<void> | undefined;
  function stop() {
    return stopping ??= new Promise<void>((resolve, reject) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return resolve();
      let forced: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        clearTimeout(timer); clearTimeout(forced);
        child.off('exit', ended); child.off('close', ended);
        if (error) reject(error); else resolve();
      };
      const ended = () => finish();
      const terminate = () => { try { terminateTree(child); } catch { /* The deadline still forces termination. */ } };
      const timer = setTimeout(() => {
        try { terminateTree(child, 'SIGKILL'); } catch { /* Report failure if exit cannot be confirmed. */ }
        // Rollback may replace the database immediately after stop resolves.
        // Sending SIGKILL alone does not confirm that the process has exited.
        forced = setTimeout(() => finish(new BackendStopError('The local server did not exit after termination.')), 4000);
      }, 4000);
      child.once('exit', ended); child.once('close', ended);
      if (child.connected) {
        try { child.send({ type: 'papilot:shutdown' }, error => { if (error) terminate(); }); }
        catch { terminate(); }
      } else terminate();
    });
  }
  return { child, ready, stop, idle: () => idleCheck(child, message => new Promise<void>((resolve, reject) => {
    child.send(message, error => { if (error) reject(error); else resolve(); });
  })) };
}

export function idleCheck(child: ChildProcess, send: (message: { type: string; id: string }) => void | Promise<void>) {
  return new Promise<boolean>((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { child.off('message', receive); reject(new Error('Could not check running tasks. Try again after Papilot responds.')); }, 5000);
    const receive = (message: any) => {
      if (message?.type !== 'papilot:can-switch' || message.id !== id) return;
      clearTimeout(timer); child.off('message', receive); resolve(message.busy === false);
    };
    const fail = (error: unknown) => { clearTimeout(timer); child.off('message', receive); reject(error); };
    child.on('message', receive);
    try { void Promise.resolve(send({ type: 'papilot:can-switch', id })).catch(fail); }
    catch (error) { fail(error); }
  });
}

// Updates download only Papilot's own code (a layer, see scripts/desktop-layer.mjs)
// into the data directory. A layer runs on this installer's Node and
// dependencies when it was built for the same shell fingerprint; installing
// another app version retires it.
export interface Bundle { root: string; version: string; fingerprint: string }
type Json = Record<string, any> | null;
const readJson = (file: string): Json => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
export const layerFiles = (data: string) => {
  const folder = path.join(data, 'updates/desktop');
  return { folder, layers: path.join(folder, 'layers'), active: path.join(folder, 'active.json'), status: path.join(folder, 'status.json'), lock: path.join(folder, 'install.lock') };
};
// The bundle can move between launches (an AppImage mounts at a new path), so
// links to its dependencies are renewed before each start.
export function linkBundle(root: string, bundle: string) {
  for (const folder of ['node_modules', 'engine/node_modules']) {
    const target = path.join(bundle, folder), link = path.join(root, folder);
    if (!fs.existsSync(target) || !fs.existsSync(path.dirname(link))) continue;
    try { if (fs.readlinkSync(link) === target) continue; } catch { /* absent or not a link */ }
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  }
}
// A layer this installer can run, downloaded by the updater.
export function layer(data: string, bundle: Bundle, root: unknown, version: unknown) {
  if (!bundle.fingerprint || typeof root !== 'string' || typeof version !== 'string') return null;
  try { if (!fs.realpathSync(root).startsWith(fs.realpathSync(layerFiles(data).layers) + path.sep)) return null; } catch { return null; }
  const pkg = readJson(path.join(root, 'package.json')), shell = readJson(path.join(root, 'desktop-layer.json'));
  if (pkg?.name !== 'papilot' || pkg.version !== version || shell?.version !== version || shell.fingerprint !== bundle.fingerprint || !fs.existsSync(path.join(root, 'src/server/start.ts'))) return null;
  return { root, version };
}
export function activeLayer(data: string, bundle: Bundle) {
  const active = readJson(layerFiles(data).active);
  return active?.phase === 'active' && active.installer === bundle.version ? layer(data, bundle, active.root, active.version) : null;
}
export function removeLayers(data: string, keep?: string) {
  const { layers } = layerFiles(data);
  let entries: string[] = [], kept = '';
  try { entries = fs.readdirSync(layers); } catch { return; }
  try { if (keep) kept = path.relative(fs.realpathSync(layers), fs.realpathSync(keep)).split(path.sep)[0]; } catch { /* keep nothing */ }
  for (const entry of entries) if (entry !== kept) fs.rmSync(path.join(layers, entry), { recursive: true, force: true });
}
export const STARTUP_FAILED = 'The updated version did not start, so Papilot is using the version included with the app. Retry the update or download the latest desktop app.';
// Starts the active layer, or the bundled server when there is none or it
// fails. Returns the root that is running.
export async function startServer(data: string, bundle: Bundle, launch: (root: string) => Promise<void>) {
  // The development app shares the data directory; leave its updates alone.
  if (!bundle.fingerprint) { await launch(bundle.root); return bundle.root; }
  const { active, status } = layerFiles(data), chosen = activeLayer(data, bundle);
  removeLayers(data, chosen?.root);
  if (!chosen) { fs.rmSync(active, { force: true }); await launch(bundle.root); return bundle.root; }
  try { linkBundle(chosen.root, bundle.root); await launch(chosen.root); return chosen.root; }
  catch (error) {
    if (error instanceof BackendStopError) throw error;
    console.error(`Papilot ${chosen.version} did not start:`, error);
    fs.rmSync(active, { force: true });
    writeJson(status, { ...readJson(status), phase: 'failed', checkedAt: Date.now(), error: STARTUP_FAILED, pid: process.pid });
    await launch(bundle.root);
    return bundle.root;
  }
}
// Replaces the running backend with a downloaded layer, or with the bundled
// server when the chosen version is the installer's own, once the backend has
// finished its work. If it does not start, the database and the previous
// version are restored. Returns the root that is running.
export async function switchServer(data: string, bundle: Bundle, request: unknown, current: string, stop: () => Promise<void>, launch: (root: string) => Promise<void>) {
  const paths = layerFiles(data), status = readJson(paths.status) || {};
  const value = request && typeof request === 'object' ? request as Record<string, unknown> : {};
  const target = value.root === bundle.root && value.version === bundle.version ? { root: bundle.root, version: bundle.version } : layer(data, bundle, value.root, value.version);
  if (!target) {
    writeJson(paths.status, { ...status, phase: 'failed', checkedAt: Date.now(), error: 'Invalid update activation.', pid: process.pid });
    fs.rmSync(paths.lock, { force: true });
    return current;
  }
  const previous = readJson(paths.active), database = path.join(data, 'papilot.sqlite'), backup = path.join(paths.folder, 'before-update.sqlite');
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
    const record = { root: target.root, version: target.version, installer: bundle.version, id: randomUUID() };
    if (target.root === bundle.root) fs.rmSync(paths.active, { force: true });
    else { linkBundle(target.root, bundle.root); writeJson(paths.active, { ...record, phase: 'starting' }); }
    try {
      await launch(target.root);
      if (target.root !== bundle.root) writeJson(paths.active, { ...record, phase: 'active' });
      writeJson(paths.status, { ...status, phase: 'updated', currentVersion: target.version, error: null, pid: process.pid });
      removeLayers(data, target.root === bundle.root ? undefined : target.root);
      return target.root;
    } catch (error) {
      if (error instanceof BackendStopError) throw error;
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
