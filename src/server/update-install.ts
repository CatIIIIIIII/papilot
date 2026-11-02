import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { devRevision, newerVersion, readJson, stableVersion } from '../../bin/installation.mjs';

export const DEV_REPOSITORY = 'https://github.com/PapilotAI/papilot.git';
const git = async (args: string[], cwd: string) => (await promisify(execFile)('git', args, { cwd, timeout: 120000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();

export function npmCli(env = process.env, executable = process.execPath) {
  const candidates = [env.npm_execpath, path.join(path.dirname(executable), '../lib/node_modules/npm/bin/npm-cli.js'), path.join(path.dirname(executable), 'node_modules/npm/bin/npm-cli.js'),
    ...(env.PATH || '').split(path.delimiter).map(dir => path.join(dir, 'npm'))];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { const real = fs.realpathSync(candidate); if (real.endsWith('npm-cli.js')) return real; } catch { /* next installation */ }
  }
  throw new Error('npm is unavailable to Papilot.');
}
// A desktop installer runs a newer release when it provides the shell level the
// release declares and its bundled Node meets the release's engine range.
export const NEEDS_INSTALLER = 'This version needs the latest desktop app. Download it from GitHub Releases.';
export function desktopSupports(pkg: any, shell: number, node = process.versions.node) {
  if (!Number.isInteger(pkg?.desktopShell) || pkg.desktopShell < 1 || pkg.desktopShell > shell) return false;
  // npm's --engine-strict checks other range forms during installation.
  const minimum = typeof pkg.engines?.node === 'string' ? /^\s*>=\s*v?(\d+\.\d+\.\d+)\s*$/.exec(pkg.engines.node)?.[1] : undefined;
  return !minimum || !newerVersion(minimum, node);
}
// The installer's Codex serves releases that test the same or an older one.
export function codexVersion(bin: string | undefined) {
  try { return readJson(path.join(path.dirname(fs.realpathSync(bin!)), '../package.json'))?.version || null; } catch { return null; }
}
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
export async function probeInstallation(root: string, version: string, stage: string, log: number) {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const child = spawn(process.execPath, ['--import', loaderFor(root), path.join(root, 'src/server/main.ts')], {
    cwd: root, env: { ...process.env, PAPILOT_DATA: path.join(stage, 'probe'), PAPILOT_PORT: String(port), PAPILOT_PUBLIC_ORIGIN: '', PAPILOT_ACCOUNT_ORIGIN: '', PAPILOT_UPDATE_PROBE: '1' }, stdio: ['ignore', log, log],
  });
  let ended = false, error: Error | undefined;
  child.once('error', e => { error = e; ended = true; }); child.once('exit', () => { ended = true; });
  try {
    for (let i = 0; i < 40 && !ended; i++) { if (await health(port, version)) return; await sleep(250); }
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
export async function installRelease(data: string, version: string, desktop?: { shell: number; codex?: string }) {
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
    // Releases also ship an empty vendor/latex-review package, where 0.8.2 and
    // earlier look for the engine when they install an update.
    for (const file of ['dist/index.html', 'src/server/start.ts', 'src/server/main.ts', 'bin/papilot.mjs', 'engine/package-lock.json']) {
      if (!fs.existsSync(path.join(root, file))) throw new Error('The downloaded release is incomplete.');
    }
    if (desktop && !desktopSupports(pkg, desktop.shell)) throw new Error(NEEDS_INSTALLER);
    await runInstall(['ci', '--prefix', path.join(root, 'engine'), ...flags], stage, log);
    // Like the CLI's first run, Codex installs with its own scripts. The app
    // finds it beside the release.
    const tested = pkg.devDependencies?.['@openai/codex'], bundled = desktop && codexVersion(desktop.codex);
    if (desktop && stableVersion(tested) && (!bundled || newerVersion(tested, bundled))) {
      await runInstall(['install', '--prefix', path.join(stage, 'codex'), '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund', `@openai/codex@${tested}`], stage, log);
    }
    await probeInstallation(root, version, stage, log);
    return root;
  } catch (error) { fs.rmSync(stage, { recursive: true, force: true }); throw error; }
  finally { fs.closeSync(log); }
}
