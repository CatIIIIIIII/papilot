// A desktop installer is a shell (Electron, Node, Codex and the production
// dependencies) around Papilot's own code. Updates download only that code, a
// few megabytes, when it was built for an identical shell. Anything else needs
// a new installer.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// The release manifest and layer layout are read by older installed apps:
// keep them compatible, or raise `format` so those apps ask for an installer.
export const LAYER_FORMAT = 1;
export const MANIFEST = 'desktop.json';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function files(folder) {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(folder, entry.name);
    return entry.isDirectory() ? files(file) : entry.isFile() && !entry.name.endsWith('.md') && entry.name !== '.DS_Store' ? [file] : [];
  });
}
// npm installs every lockfile entry not marked dev with --omit=dev.
const production = lock => Object.entries(read(lock).packages || {}).filter(([name, entry]) => name && !entry.dev)
  .map(([name, entry]) => [name, `${entry.version || ''} ${entry.integrity || entry.resolved || ''} ${entry.link ? 'link' : ''}`.trim()]).sort(([a], [b]) => a.localeCompare(b));

// Everything the installer provides that the layer does not.
export function shellFingerprint(root = process.cwd(), node = process.versions.node) {
  const pkg = read(path.join(root, 'package.json'));
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const shell = [...files(path.join(root, 'desktop')), path.join(root, 'scripts/desktop.mjs')]
    .map(file => [path.relative(root, file).split(path.sep).join('/'), hash(file)]).sort(([a], [b]) => a.localeCompare(b));
  const inputs = {
    format: LAYER_FORMAT, node: node.split('.')[0],
    electron: pkg.devDependencies?.electron, builder: pkg.devDependencies?.['electron-builder'], codex: pkg.devDependencies?.['@openai/codex'],
    dependencies: production(path.join(root, 'package-lock.json')), engine: production(path.join(root, 'engine/package-lock.json')), shell,
  };
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

// Nightly dev builds carry the commit, like the web server's GitHub dev channel.
export function desktopVersion(version, revision = process.env.PAPILOT_DESKTOP_REVISION) {
  if (!revision) return version;
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('PAPILOT_DESKTOP_REVISION must be a full commit hash.');
  return `${version}-dev.${revision}`;
}
export const layerName = version => `papilot-app-${version}.tgz`;
export const INSTALLER_SUFFIXES = ['mac-arm64.dmg', 'mac-arm64.zip', 'mac-x64.dmg', 'mac-x64.zip', 'linux-x86_64.AppImage', 'linux-amd64.deb'];
// A nightly build whose shell matches the published dev build keeps its
// installers and uploads only the layer.
export function reusableInstallers(previous, assets, fingerprint) {
  const installers = previous?.format === LAYER_FORMAT && previous.fingerprint === fingerprint && Array.isArray(previous.installers) ? previous.installers : [];
  const complete = INSTALLER_SUFFIXES.every(suffix => installers.some(name => typeof name === 'string' && name.endsWith('-' + suffix)));
  return complete && installers.every(name => assets.includes(name)) ? installers : null;
}

// Packs the files npm would publish, which is exactly the server the installer
// bundles, and records the shell it was built for.
export function buildLayer(root = process.cwd(), output = path.join(root, 'release/desktop'), revision = process.env.PAPILOT_DESKTOP_REVISION) {
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...options });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${path.basename(command)} exited with ${result.status ?? result.signal}`);
    return result.stdout;
  };
  const pkg = read(path.join(root, 'package.json')), version = desktopVersion(pkg.version, revision);
  for (const file of ['dist/index.html', 'engine/dist']) if (!fs.existsSync(path.join(root, file))) throw new Error('Run npm run build and npm run setup:review before building the desktop layer.');
  const stage = path.join(root, '.desktop/layer');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const npm = fs.realpathSync(process.env.npm_execpath || path.join(path.dirname(process.execPath), 'npm'));
  run(process.execPath, [npm, 'pack', '--ignore-scripts', '--pack-destination', stage, '--loglevel=error']);
  const packed = path.join(stage, `${pkg.name}-${pkg.version}.tgz`);
  run('tar', ['-xzf', packed, '-C', stage]);
  fs.rmSync(packed);
  const manifest = path.join(stage, 'package/package.json');
  fs.writeFileSync(manifest, JSON.stringify({ ...read(manifest), version }, null, 2) + '\n');
  const fingerprint = shellFingerprint(root);
  fs.writeFileSync(path.join(stage, 'package/desktop-layer.json'), JSON.stringify({ format: LAYER_FORMAT, version, fingerprint }, null, 2) + '\n');
  fs.mkdirSync(output, { recursive: true });
  const name = layerName(version), archive = path.join(output, name);
  // macOS tar would otherwise add AppleDouble files for extended attributes.
  run('tar', ['-czf', archive, '-C', stage, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const bytes = fs.readFileSync(archive);
  const release = { format: LAYER_FORMAT, version, fingerprint, layer: { name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
  fs.writeFileSync(path.join(output, MANIFEST), JSON.stringify(release, null, 2) + '\n');
  fs.rmSync(stage, { recursive: true, force: true });
  return release;
}
