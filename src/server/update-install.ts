import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { devRevision, readJson, stableVersion } from '../../bin/installation.mjs';
import { execCommand, importLoader, linkDirectory, tarCommand } from '../../bin/agent-paths.mjs';
import { npmCli } from '../../bin/npm-cli.mjs';

export { npmCli } from '../../bin/npm-cli.mjs';
export const DEV_REPOSITORY = 'https://github.com/PapilotAI/papilot.git';
const git = async (args: string[], cwd: string) => (await promisify(execFile)('git', args, { cwd, timeout: 120000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
export const loaderFor = (root: string) => createRequire(path.join(root, 'package.json')).resolve('tsx/esm');
export function runInstall(args: string[], cwd: string, log: number, timeout = 600000) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli(), ...args], { cwd, env: { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '') }, stdio: ['ignore', log, log] });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('The update download timed out.')); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('The new version could not be installed. Check the connection and available disk space, then retry.')); });
  });
}
export async function health(port: number, version: string, instance?: string) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    const value = await response.json();
    return response.ok && value.name === 'Papilot' && value.version === version && (!instance || value.updateInstance === instance);
  } catch { return false; }
}
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// A fresh desktop data directory also seeds the example paper. Cold disks
// and concurrent builds can take longer than ten seconds to initialize it.
export async function probeInstallation(root: string, version: string, stage: string, log: number, timeout = 60000) {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const child = spawn(process.execPath, ['--import', importLoader(loaderFor(root)), path.join(root, 'src/server/main.ts')], {
    cwd: root, env: { ...process.env, PAPILOT_DATA: path.join(stage, 'probe'), PAPILOT_PORT: String(port), PAPILOT_PUBLIC_ORIGIN: '', PAPILOT_UPDATE_PROBE: '1' }, stdio: ['ignore', log, log],
  });
  let ended = false, error: Error | undefined;
  child.once('error', e => { error = e; ended = true; }); child.once('exit', () => { ended = true; });
  try {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline && !ended) { if (await health(port, version)) return; await sleep(250); }
    throw error || new Error('The new version did not pass its startup check. Your current version is still running.');
  } finally {
    if (!ended) {
      child.kill('SIGTERM');
      for (let i = 0; i < 30 && !ended; i++) await sleep(100);
      if (!ended) child.kill('SIGKILL');
    }
  }
}
// Resolve main during discovery, then fetch that exact commit. Building in a
// managed directory keeps the running installation and any source checkout intact.
export async function prepareDev(root: string, version: string, log: number, run = runInstall, checkout = git) {
  const revision = devRevision(version);
  if (!revision) throw new Error('Invalid development version.');
  await checkout(['init', '--quiet'], root);
  await checkout(['-c', 'core.hooksPath=/dev/null', 'fetch', '--depth=1', DEV_REPOSITORY, revision], root);
  await checkout(['-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', 'FETCH_HEAD'], root);
  if (await checkout(['rev-parse', 'HEAD'], root) !== revision) throw new Error('The development checkout does not match the requested commit.');
  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg?.name !== 'papilot' || !stableVersion(pkg.version) || `${pkg.version}-dev.${revision}` !== version) throw new Error('The development checkout does not match the requested version.');
  const flags = ['--ignore-scripts', '--no-audit', '--no-fund'];
  // Test-only tools can exclude a Node version that supports the application.
  // Build first, then enforce engine compatibility for the retained runtime.
  await run(['ci', '--include=dev', '--engine-strict=false', ...flags], root, log);
  const engine = path.join(root, 'engine');
  await run(['ci', '--include=dev', '--engine-strict=false', ...flags], engine, log);
  // Only this installed snapshot gets a dev version; the repository stays unchanged.
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ ...pkg, version }, null, 2) + '\n');
  await run(['run', 'build'], engine, log);
  await run(['run', 'build'], root, log);
  for (const cwd of [root, engine]) {
    // npm 10 checks even omitted dev dependencies under --engine-strict, so they
    // are hidden while pruning. The manifest is then restored: the launcher and
    // the agents read the tested Codex and Claude SDK versions from it.
    const manifest = path.join(cwd, 'package.json'), original = fs.readFileSync(manifest, 'utf8');
    const { devDependencies: _, ...runtime } = JSON.parse(original);
    fs.writeFileSync(manifest, JSON.stringify(runtime, null, 2) + '\n');
    try { await run(['prune', '--omit=dev', '--engine-strict', ...flags], cwd, log); }
    finally { fs.writeFileSync(manifest, original); }
  }
}
async function installDev(data: string, version: string) {
  const releases = path.join(data, 'updates/releases'); fs.mkdirSync(releases, { recursive: true, mode: 0o700 });
  const space = fs.statfsSync(releases);
  if (space.bavail * space.bsize < 2 * 1024 ** 3) throw new Error('The dev build needs at least 2 GB of free disk space. Free some space and retry.');
  const stage = fs.mkdtempSync(path.join(releases, 'dev-')), root = path.join(stage, 'papilot');
  fs.mkdirSync(root);
  const log = fs.openSync(path.join(data, 'updates/install.log'), 'a', 0o600);
  try {
    await prepareDev(root, version, log);
    await probeInstallation(root, version, stage, log);
    return root;
  } catch (error) { fs.rmSync(stage, { recursive: true, force: true }); throw error; }
  finally { fs.closeSync(log); }
}
const INSTALL_FAILED = 'The new version could not be installed. Check the connection and available disk space, then retry.';
// Release assets redirect from github.com to GitHub's download hosts. Each hop
// stays on HTTPS and on those hosts (or on the smoke test's local source).
// With missing, a file that does not exist resolves to null.
export async function download(url: string, fetcher: typeof fetch, limit: number, missing: true): Promise<Buffer | null>;
export async function download(url: string, fetcher: typeof fetch, limit: number): Promise<Buffer>;
export async function download(url: string, fetcher: typeof fetch, limit: number, missing = false): Promise<Buffer | null> {
  const source = process.env.PAPILOT_DESKTOP_UPDATE_SOURCE ? new URL(process.env.PAPILOT_DESKTOP_UPDATE_SOURCE).origin : null;
  const trusted = (address: URL) => address.origin === source
    || address.protocol === 'https:' && (address.hostname === 'github.com' || address.hostname.endsWith('.githubusercontent.com'));
  let address = new URL(url);
  for (let hop = 0; hop < 5; hop++) {
    if (!trusted(address)) throw new Error(INSTALL_FAILED);
    const response = await fetcher(address.href, { signal: AbortSignal.timeout(300000), redirect: 'manual', headers: { Accept: 'application/octet-stream', 'User-Agent': 'Papilot' } });
    try {
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) { address = new URL(location, address); continue; }
      if (missing && response.status === 404) return null;
      if (!response.ok || Number(response.headers.get('content-length') || 0) > limit) throw new Error(INSTALL_FAILED);
      if (!response.body) return Buffer.alloc(0);
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          // Count decoded bytes before retaining them: Content-Length can be
          // missing or describe compressed data rather than the fetched body.
          size += value.byteLength;
          if (size > limit) throw new Error(INSTALL_FAILED);
          chunks.push(value);
        }
        return Buffer.concat(chunks, size);
      } finally { reader.releaseLock(); }
    } finally {
      // Stop oversized downloads and discard unused redirect/error bodies.
      // A cancellation failure must not replace the original download error.
      await response.body?.cancel().catch(() => {});
    }
  }
  throw new Error(INSTALL_FAILED);
}
export interface DesktopLayer { url: string; size: number; sha256: string }
// As in desktop/runtime.ts: a layer runs on the installer's dependencies.
function linkBundle(root: string, bundle: string) {
  for (const folder of ['node_modules', 'engine/node_modules']) {
    const target = path.join(bundle, folder), link = path.join(root, folder);
    if (!fs.existsSync(target) || !fs.existsSync(path.dirname(link))) continue;
    linkDirectory(target, link);
  }
}
// The desktop app downloads only Papilot's own code, built by the release
// workflow for this installer's shell, and checks that it starts. The app then
// switches to it (desktop/runtime.ts).
export async function installLayer(data: string, version: string, layer: DesktopLayer, bundle: { root: string; fingerprint: string }, fetcher = fetch) {
  const layers = path.join(data, 'updates/desktop/layers'); fs.mkdirSync(layers, { recursive: true, mode: 0o700 });
  const stage = fs.mkdtempSync(path.join(layers, version + '-')), root = path.join(stage, 'papilot'), archive = path.join(stage, 'layer.tgz');
  const log = fs.openSync(path.join(data, 'updates/desktop/install.log'), 'a', 0o600);
  try {
    const bytes = await download(layer.url, fetcher, layer.size);
    if (bytes.length !== layer.size || createHash('sha256').update(bytes).digest('hex') !== layer.sha256) throw new Error(INSTALL_FAILED);
    fs.writeFileSync(archive, bytes, { mode: 0o600 });
    fs.mkdirSync(root);
    await execCommand(tarCommand(), ['-xzf', archive, '-C', root, '--strip-components=1'], { timeout: 120000 });
    fs.rmSync(archive);
    const pkg = readJson(path.join(root, 'package.json')), shell = readJson(path.join(root, 'desktop-layer.json'));
    if (pkg?.name !== 'papilot' || pkg.version !== version || shell?.version !== version) throw new Error('The downloaded package does not match the requested release.');
    if (shell.fingerprint !== bundle.fingerprint) throw new Error('Download desktop updates from GitHub Releases.');
    for (const file of ['dist/index.html', 'src/server/start.ts', 'src/server/main.ts', 'engine/package.json']) {
      if (!fs.existsSync(path.join(root, file))) throw new Error('The downloaded release is incomplete.');
    }
    linkBundle(root, bundle.root);
    await probeInstallation(root, version, stage, log);
    return root;
  } catch (error) { fs.rmSync(stage, { recursive: true, force: true }); throw error; }
  finally { fs.closeSync(log); }
}
export async function installRelease(data: string, version: string) {
  if (process.env.PAPILOT_DESKTOP === '1') throw new Error('Download desktop updates from GitHub Releases.');
  if (devRevision(version)) return installDev(data, version);
  if (!stableVersion(version)) throw new Error('Invalid release version.');
  const releases = path.join(data, 'updates/releases'); fs.mkdirSync(releases, { recursive: true, mode: 0o700 });
  const stage = fs.mkdtempSync(path.join(releases, version + '-')), root = path.join(stage, 'node_modules/papilot');
  const log = fs.openSync(path.join(data, 'updates/install.log'), 'a', 0o600);
  try {
    const flags = ['--registry=https://registry.npmjs.org', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--engine-strict'];
    await runInstall(['install', '--prefix', stage, '--save-exact', ...flags, `papilot@${version}`], stage, log);
    const pkg = readJson(path.join(root, 'package.json'));
    if (pkg?.name !== 'papilot' || pkg.version !== version) throw new Error('The downloaded package does not match the requested release.');
    for (const file of ['dist/index.html', 'src/server/start.ts', 'src/server/main.ts', 'bin/papilot.mjs', 'engine/package-lock.json']) {
      if (!fs.existsSync(path.join(root, file))) throw new Error('The downloaded release is incomplete.');
    }
    await runInstall(['ci', '--prefix', path.join(root, 'engine'), ...flags], stage, log);
    await probeInstallation(root, version, stage, log);
    return root;
  } catch (error) { fs.rmSync(stage, { recursive: true, force: true }); throw error; }
  finally { fs.closeSync(log); }
}
