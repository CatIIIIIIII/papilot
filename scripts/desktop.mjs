import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync, spawn } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const require = createRequire(import.meta.url), pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const npm = fs.realpathSync(process.env.npm_execpath || path.join(path.dirname(process.execPath), 'npm'));
const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with ${result.status ?? result.signal}`);
};
const runNpm = (args, cwd = root) => run(process.execPath, [npm, ...args], cwd);
fs.mkdirSync('.desktop/app', { recursive: true });
fs.writeFileSync('.desktop/app/package.json', JSON.stringify({ name: 'papilot-desktop', productName: 'Papilot', version: pkg.version,
  description: pkg.description, author: pkg.author, homepage: pkg.homepage, license: pkg.license,
  desktopName: 'ai.papilot.desktop.desktop', type: 'module', main: 'main.js' }, null, 2) + '\n');

if (process.argv[2] === 'dev') {
  if (!fs.existsSync('vendor/latex-review/dist/web/index.html')) runNpm(['run', 'setup:review']);
  const env = { ...process.env, PAPILOT_DESKTOP_NODE: process.execPath };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), ['.desktop/app'], { stdio: 'inherit', env });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', code => process.exit(code ?? 1));
} else if (process.argv[2] === 'package') {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Desktop packaging currently supports macOS and Linux. Build on the target OS and CPU architecture.');
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
  fs.copyFileSync(node, '.desktop/runtime/bin/node');
  fs.chmodSync('.desktop/runtime/bin/node', 0o755);
  fs.cpSync(path.dirname(path.dirname(npm)), '.desktop/runtime/lib/node_modules/npm', { recursive: true,
    filter: source => path.basename(source) !== '__pycache__' });
  for (const name of ['npm', 'npx']) fs.symlinkSync(`../lib/node_modules/npm/bin/${name}-cli.js`, `.desktop/runtime/bin/${name}`);
  const license = [path.resolve(path.dirname(node), '../LICENSE'), path.resolve(path.dirname(node), '../share/doc/node/LICENSE'),
    path.resolve(path.dirname(node), '../share/doc/node/LICENSE.md')].find(file => fs.existsSync(file));
  if (!license) throw new Error('Use an official Node.js distribution with its LICENSE file to build the app.');
  fs.copyFileSync(license, '.desktop/runtime/LICENSE');

  // Use npm's existing package allowlist; never copy the checkout or user data.
  fs.rmSync('.desktop/server', { recursive: true, force: true });
  fs.mkdirSync('.desktop/server', { recursive: true });
  runNpm(['pack', '--ignore-scripts', '--pack-destination', '.desktop', '--loglevel=error']);
  const archive = `.desktop/${pkg.name}-${pkg.version}.tgz`;
  run('tar', ['-xzf', archive, '--strip-components=1', '-C', '.desktop/server']);
  fs.rmSync(archive);
  fs.copyFileSync('package-lock.json', '.desktop/server/package-lock.json');
  const serverPackage = JSON.parse(fs.readFileSync('.desktop/server/package.json', 'utf8'));
  // The CLI installs this tested Codex on first run; desktop carries it so
  // opening the app for the first time works without an npm download.
  serverPackage.dependencies['@openai/codex'] = pkg.devDependencies['@openai/codex'];
  delete serverPackage.devDependencies['@openai/codex'];
  fs.writeFileSync('.desktop/server/package.json', JSON.stringify(serverPackage, null, 2) + '\n');
  runNpm(['install', '--omit=dev', '--no-audit', '--no-fund'], path.join(root, '.desktop/server'));
  runNpm(['ci', '--omit=dev', '--no-audit', '--no-fund'], path.join(root, '.desktop/server/vendor/latex-review'));
  run(process.execPath, [require.resolve('electron-builder/cli.js'), '--config', 'desktop/builder.cjs',
    process.platform === 'darwin' ? '--mac' : '--linux', `--${process.arch}`, '--publish', 'never', ...process.argv.slice(3)]);
} else throw new Error('Expected dev or package.');
