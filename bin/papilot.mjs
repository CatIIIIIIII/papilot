#!/usr/bin/env node
// The papilot command: starts the workspace, or adds the example paper first.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentPath, findExecutable } from './agent-paths.mjs';
import { activeInstallation } from './installation.mjs';

const usage = `Usage: papilot [doctor | demo | codex <args> | service install | service stop] [--port <number>] [--data <folder>]

  papilot                  Start Papilot at http://127.0.0.1:7274
  papilot doctor           Check the environment; use doctor --help for options
  papilot demo             Add the example paper, then start
  papilot codex login      Sign in to Codex with the Codex that Papilot uses
  papilot service install  Run Papilot in the background after login (macOS)
  papilot service stop     Stop the background service
  --port <number>          Listen on another local port (PAPILOT_PORT)
  --data <folder>          Keep state in another folder (PAPILOT_DATA, default ~/.papilot)
  --version                Print the version`;

let pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const installedPackage = () => JSON.parse(readFileSync(path.join(activeInstallation(packageRoot, process.env.PAPILOT_DATA || path.join(os.homedir(), '.papilot')), 'package.json'), 'utf8'));
const args = process.argv.slice(2);
async function main() {
  const doctor = args[0] === 'doctor';
  // Doctor parses its own options and must never reach the installation/startup path.
  if (doctor && (args.includes('--help') || args.includes('-h'))) return (await import('./doctor.mjs')).doctor(args.slice(1));
  let demo = false, service = '', codexArgs = null;
  for (let i = 0; !doctor && i < args.length; i++) {
    const arg = args[i];
    if (arg === 'demo') demo = true;
    else if (arg === 'codex') { codexArgs = args.slice(i + 1); break; }
    else if (arg === 'service' && ['install', 'stop'].includes(args[i + 1])) service = args[++i];
    else if (arg === '--port') {
      const port = Number(args[++i]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('--port needs a number from 1 to 65535.'); process.exit(1); }
      process.env.PAPILOT_PORT = String(port);
    }
    else if (arg === '--data' && args[i + 1]) process.env.PAPILOT_DATA = path.resolve(args[++i]);
    else if (arg === '--version' || arg === '-v') {
      console.log(installedPackage().version);
      process.exit(0);
    } else {
      if (arg !== '--help' && arg !== '-h') console.error(`Unknown argument: ${arg}\n`);
      console.log(usage);
      process.exit(arg === '--help' || arg === '-h' ? 0 : 1);
    }
  }

  // Papilot needs Node 22.22+. When an older Node runs this command, use a newer
  // one from nvm or PATH, preferring LTS releases, without changing the default.
  const parse = version => version.replace(/^v/, '').split('.').map(Number);
  const supported = version => { const [major, minor] = parse(version); return major > 22 || (major === 22 && minor >= 22); };
  if (!supported(process.versions.node)) {
    const versions = path.join(process.env.NVM_DIR || path.join(os.homedir(), '.nvm'), 'versions/node');
    const nvm = existsSync(versions) ? readdirSync(versions).map(v => ({ file: path.join(versions, v, 'bin/node'), version: v })) : [];
    const others = [...new Set([...(process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, 'node')), '/opt/homebrew/bin/node', '/usr/local/bin/node'])]
      .filter(file => existsSync(file)).map(file => ({ file, version: (spawnSync(file, ['--version'], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' }).stdout || '0').trim() }));
    // nvm's versions come first, then any other Node; even majors are LTS releases,
    // and among those the newest wins.
    const rank = ({ version }) => { const [major, minor, patch] = parse(version); return (major % 2 === 0 ? 1e9 : 0) + major * 1e6 + minor * 1e3 + patch; };
    const best = list => list.filter(c => existsSync(c.file) && supported(c.version)).sort((a, b) => rank(b) - rank(a))[0];
    const node = best(nvm) || best(others);
    if (!node) {
      if (doctor) return (await import('./doctor.mjs')).doctor(args.slice(1));
      console.error(`Papilot needs Node.js 22.22 or newer; this is ${process.versions.node}. Install it with \`nvm install 22\` or from https://nodejs.org, then run papilot again.`);
      process.exit(1);
    }
    console.error(`Papilot needs Node.js 22.22+; using ${node.version.replace(/^v/, '')} from ${path.dirname(node.file)}.`);
    const child = spawn(node.file, [fileURLToPath(import.meta.url), ...args], { stdio: 'inherit', env: { ...process.env, PATH: path.dirname(node.file) + path.delimiter + process.env.PATH } });
    // Pass stop signals on, so stopping papilot also stops the server it started.
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
    await new Promise(() => child.on('exit', code => process.exit(code ?? 1)));
  }
  if (doctor) return (await import('./doctor.mjs')).doctor(args.slice(1));
  const tex = !spawnSync('latexmk', ['-v'], { stdio: 'ignore' }).error;

  // Node 22 marks node:sqlite as experimental; that notice is noise for users.
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) => String(warning).includes('SQLite') ? undefined : emitWarning.call(process, warning, ...rest);
  process.env.PAPILOT_DATA ||= path.join(os.homedir(), '.papilot');
  process.env.PATH = agentPath();
  pkg = installedPackage();

  // Papilot drives Codex through its app server. A codex on PATH at least as new
  // as the tested version is used as it is; otherwise that version is installed
  // once into the data folder.
  function findCodex() {
    if (process.env.PAPILOT_CODEX_BIN) return process.env.PAPILOT_CODEX_BIN;
    const tested = pkg.devDependencies['@openai/codex'];
    const version = file => (spawnSync(file, ['--version'], { encoding: 'utf8' }).stdout || '').match(/\d+\.\d+\.\d+/)?.[0] || '0.0.0';
    const recent = file => { const [a, b] = [parse(version(file)), parse(tested)]; return (a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) >= 0; };
    const onPath = findExecutable('codex');
    if (onPath && recent(onPath)) return onPath;
    const prefix = path.join(process.env.PAPILOT_DATA, 'agents'), installed = path.join(prefix, 'node_modules/.bin/codex');
    if (existsSync(installed) && recent(installed)) return installed;
    if (process.env.PAPILOT_INSTALL_METHOD === 'nix') {
      console.warn('Install a supported Codex separately with Nix, or set PAPILOT_CODEX_BIN to an existing installation.');
      return '';
    }
    console.log(`Installing Codex ${tested} for Papilot (first run only)...`);
    const result = spawnSync('npm', ['install', '--prefix', prefix, `@openai/codex@${tested}`, '--no-audit', '--no-fund', '--loglevel=error'], { stdio: 'inherit' });
    if (result.status === 0 && existsSync(installed)) return installed;
    console.warn('Codex could not be installed, so Codex tasks are unavailable. Install it with npm install -g @openai/codex and run papilot again.');
    return '';
  }
  if (codexArgs) {
    const codex = findCodex();
    process.exit(codex ? spawnSync(codex, codexArgs, { stdio: 'inherit' }).status ?? 1 : 1);
  }
  if (service !== 'stop') process.env.PAPILOT_CODEX_BIN = findCodex() || 'codex';
  const { register } = await import('tsx/esm/api');
  register();
  if (service) {
    process.argv.splice(2, Infinity, service);
    await import('../scripts/service.ts');
  } else {
    if (demo) await import('../scripts/demo.ts');
    try {
      await import('../src/server/main.ts');
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error;
      console.error(`Port ${process.env.PAPILOT_PORT || 7274} is already in use. Is Papilot already running? Start another copy with --port <number>.`);
      process.exit(1);
    }
    if (!tex) console.warn('\nlatexmk was not found, so PDFs cannot be built yet. Install MacTeX or TeX Live (the full distribution), open a new terminal and run papilot again.');
  }
}
process.exitCode = await main();
