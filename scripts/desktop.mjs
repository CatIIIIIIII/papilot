import { npmCli } from '../engine/src/core/platform.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync, spawn } from 'node:child_process';
import { buildLayer, desktopVersion, shellFingerprint } from './desktop-layer.mjs';
import { dedupeEngine } from './desktop-dedupe.mjs';
import { tarCommand } from '../bin/agent-paths.mjs';
import { buildWindowsIcon } from './build-windows-icon.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const require = createRequire(import.meta.url), pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const npm = npmCli();
const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with ${result.status ?? result.signal}`);
};
const runNpm = (args, cwd = root) => run(process.execPath, [npm, ...args], cwd);
// Only packaged apps record their shell, so only they install update layers;
// the development app always runs this checkout.
const writeApp = (fingerprint) => {
  fs.mkdirSync('.desktop/app', { recursive: true });
  fs.writeFileSync('.desktop/app/package.json', JSON.stringify({ name: 'papilot-desktop', productName: 'Papilot', version: pkg.version,
    description: pkg.description, author: pkg.author, homepage: pkg.homepage, license: pkg.license,
    desktopName: 'ai.papilot.desktop.desktop', desktopShell: pkg.desktopShell, ...(fingerprint ? { desktopFingerprint: fingerprint } : {}), type: 'module', main: 'main.js' }, null, 2) + '\n');
};

if (process.argv[2] === 'layer') {
  const release = buildLayer(root);
  console.log(`Built ${release.layer.name} (${(release.layer.size / 1048576).toFixed(1)} MB) for shell ${release.fingerprint.slice(0, 12)}.`);
} else if (process.argv[2] === 'dev') {
  writeApp();
  if (!fs.existsSync('engine/dist/web/index.html')) runNpm(['run', 'setup:review']);
  const env = { ...process.env, PAPILOT_DESKTOP_NODE: process.execPath };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), ['.desktop/app'], { stdio: 'inherit', env });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', code => process.exit(code ?? 1));
} else if (process.argv[2] === 'package') {
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) throw new Error('Desktop packaging currently supports macOS, Linux and Windows. Build on the target OS and CPU architecture.');
  if (process.platform === 'win32') buildWindowsIcon();
  writeApp(shellFingerprint(root));
  // Absent Actions secrets arrive as empty strings. electron-builder treats an
  // empty CSC_LINK as a certificate path, so omit unset signing credentials.
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
    if (process.env[key]?.trim() === '') delete process.env[key];
  }
  // A native Node runtime keeps node:sqlite, agent CLIs and review subprocesses
  // independent of Electron's Node ABI and ELECTRON_RUN_AS_NODE behavior.
  fs.rmSync('.desktop/runtime', { recursive: true, force: true });
  fs.mkdirSync('.desktop/runtime/bin', { recursive: true });
  fs.mkdirSync('.desktop/runtime/lib/node_modules', { recursive: true });
  const node = fs.realpathSync(process.execPath);
  const bundledNode = path.join('.desktop/runtime/bin', process.platform === 'win32' ? 'node.exe' : 'node');
  fs.copyFileSync(node, bundledNode);
  fs.chmodSync(bundledNode, 0o755);
  fs.cpSync(path.dirname(path.dirname(npm)), '.desktop/runtime/lib/node_modules/npm', { recursive: true,
    filter: source => path.basename(source) !== '__pycache__' });
  for (const name of ['npm', 'npx']) {
    if (process.platform === 'win32') fs.writeFileSync(`.desktop/runtime/bin/${name}.cmd`, `@echo off\r\n"%~dp0node.exe" "%~dp0..\\lib\\node_modules\\npm\\bin\\${name}-cli.js" %*\r\n`);
    else fs.symlinkSync(`../lib/node_modules/npm/bin/${name}-cli.js`, `.desktop/runtime/bin/${name}`);
  }
  const license = [path.join(path.dirname(node), 'LICENSE'), path.resolve(path.dirname(node), '../LICENSE'), path.resolve(path.dirname(node), '../share/doc/node/LICENSE'),
    path.resolve(path.dirname(node), '../share/doc/node/LICENSE.md')].find(file => fs.existsSync(file));
  if (!license) throw new Error('Use an official Node.js distribution with its LICENSE file to build the app.');
  fs.copyFileSync(license, '.desktop/runtime/LICENSE');

  // Use npm's existing package allowlist; never copy the checkout or user data.
  fs.rmSync('.desktop/server', { recursive: true, force: true });
  fs.mkdirSync('.desktop/server', { recursive: true });
  runNpm(['pack', '--ignore-scripts', '--pack-destination', '.desktop', '--loglevel=error']);
  const archive = `.desktop/${pkg.name}-${pkg.version}.tgz`;
  run(tarCommand(), ['-xzf', archive, '--strip-components=1', '-C', '.desktop/server']);
  fs.rmSync(archive);
  fs.copyFileSync('package-lock.json', '.desktop/server/package-lock.json');
  const serverPackage = JSON.parse(fs.readFileSync('.desktop/server/package.json', 'utf8'));
  // A main build reports the same dev version as its update layer.
  serverPackage.version = desktopVersion(pkg.version);
  // Codex is not bundled: the server uses the Codex installed on the computer
  // (src/server/codex-binary.ts).
  fs.writeFileSync('.desktop/server/package.json', JSON.stringify(serverPackage, null, 2) + '\n');
  runNpm(['install', '--omit=dev', '--no-audit', '--no-fund'], path.join(root, '.desktop/server'));
  runNpm(['ci', '--omit=dev', '--no-audit', '--no-fund'], path.join(root, '.desktop/server/engine'));
  console.log(`Removed ${(dedupeEngine(path.join(root, '.desktop/server')) / 1048576).toFixed(1)} MB of engine dependencies the server already has.`);
  if (process.platform === 'win32') {
    // Code and lockfiles only. Linux installs its own native dependencies;
    // Windows node_modules and Windows Node must never run inside WSL.
    fs.rmSync('.desktop/wsl', { recursive: true, force: true });
    fs.mkdirSync('.desktop/wsl', { recursive: true });
    run(tarCommand(), ['-czf', path.resolve('.desktop/wsl/server.tgz'), '--exclude=node_modules', '-C', '.desktop/server', '.']);
    for (const file of ['wsl-runtime.mjs', 'runtime.js', 'platform.mjs', 'agent-paths.mjs']) fs.copyFileSync('.desktop/app/' + file, '.desktop/wsl/' + file);
    fs.writeFileSync('.desktop/wsl/package.json', '{"type":"module"}\n');
    fs.writeFileSync('.desktop/wsl/manifest.json', JSON.stringify({ nodeMajor: process.versions.node.split('.')[0] }) + '\n');
  }
  run(process.execPath, [require.resolve('electron-builder/cli.js'), '--config', 'desktop/builder.cjs',
    process.platform === 'darwin' ? '--mac' : process.platform === 'win32' ? '--win' : '--linux', `--${process.arch}`, '--publish', 'never', ...process.argv.slice(3)]);
} else throw new Error('Expected dev, package or layer.');
