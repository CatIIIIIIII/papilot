import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopVersion, INSTALLER_SUFFIXES, reusableInstallers, shellFingerprint } from '../scripts/desktop-layer.mjs';
import { dedupeEngine } from '../scripts/desktop-dedupe.mjs';

const write = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
function checkout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-shell-'));
  write(path.join(root, 'package.json'), { name: 'papilot', version: '0.9.0', devDependencies: { electron: '45.2.1', 'electron-builder': '26.18.0', '@openai/codex': '0.164.0', typescript: '7.0.0' } });
  write(path.join(root, 'package-lock.json'), { packages: { '': { name: 'papilot' }, 'node_modules/fastify': { version: '5.0.0', integrity: 'sha512-a' }, 'node_modules/typescript': { version: '7.0.0', integrity: 'sha512-b', dev: true } } });
  write(path.join(root, 'engine/package-lock.json'), { packages: { '': {}, 'node_modules/diff': { version: '9.0.0', integrity: 'sha512-c' } } });
  write(path.join(root, 'desktop/main.ts'), 'main'); write(path.join(root, 'desktop/README.md'), 'docs');
  write(path.join(root, 'scripts/desktop.mjs'), 'stage');
  write(path.join(root, 'scripts/desktop-dedupe.mjs'), 'dedupe');
  write(path.join(root, 'src/server/start.ts'), 'server');
  return root;
}

test('the shell fingerprint changes exactly when an update would need a new installer', () => {
  const root = checkout();
  try {
    const base = shellFingerprint(root, '24.11.0');
    assert.match(base, /^[a-f0-9]{64}$/);
    assert.equal(shellFingerprint(root, '24.12.1'), base, 'Node patch releases keep the shell');
    const same = (change: () => void, message: string) => { change(); assert.equal(shellFingerprint(root, '24.11.0'), base, message); };
    same(() => write(path.join(root, 'src/server/start.ts'), 'changed server'), 'Papilot code ships in the layer');
    same(() => write(path.join(root, 'desktop/README.md'), 'changed docs'), 'Documentation is not part of the shell');
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    same(() => { lock.packages['node_modules/typescript'].version = '7.1.0'; write(path.join(root, 'package-lock.json'), lock); }, 'Development dependencies are not installed');
    same(() => { const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); pkg.devDependencies['@openai/codex'] = '0.165.0'; write(path.join(root, 'package.json'), pkg); }, 'Codex is a host tool, not part of the shell');
    for (const [message, change] of [
      ['a new Node major', () => {}],
      ['a production dependency', () => { lock.packages['node_modules/fastify'].version = '5.1.0'; write(path.join(root, 'package-lock.json'), lock); }],
      ['an engine dependency', () => write(path.join(root, 'engine/package-lock.json'), { packages: { 'node_modules/diff': { version: '9.1.0' } } })],
      ['the Electron app', () => write(path.join(root, 'desktop/main.ts'), 'changed main')],
      ['a helper copied into Electron', () => write(path.join(root, 'engine/src/core/platform.mjs'), 'updated process handling')],
      ['how the installer is staged', () => write(path.join(root, 'scripts/desktop.mjs'), 'changed stage')],
      ['how engine dependencies are deduplicated', () => write(path.join(root, 'scripts/desktop-dedupe.mjs'), 'changed dedupe')],
    ] as const) {
      const before = shellFingerprint(root, '24.11.0');
      change();
      assert.notEqual(shellFingerprint(root, message === 'a new Node major' ? '25.0.0' : '24.11.0'), before, message);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('main builds carry their commit in the version', () => {
  assert.equal(desktopVersion('0.9.0', ''), '0.9.0');
  assert.equal(desktopVersion('0.9.0', 'a'.repeat(40)), `0.9.0-dev.${'a'.repeat(40)}`);
  assert.throws(() => desktopVersion('0.9.0', 'main'), /full commit/);
});

test('a dev build reuses the published installers only for the same shell', () => {
  const fingerprint = 'f'.repeat(64), installers = INSTALLER_SUFFIXES.map(suffix => `Papilot-0.9.0-dev.abcdef1-${suffix}`);
  const previous = { format: 1, version: '0.9.0-dev.' + 'a'.repeat(40), fingerprint, installers };
  const assets = ['desktop.json', 'papilot-app-x.tgz', ...installers];
  assert.deepEqual(reusableInstallers(previous, assets, fingerprint), installers);
  assert.equal(reusableInstallers(previous, assets, 'e'.repeat(64)), null, 'The shell changed');
  assert.equal(reusableInstallers(null, assets, fingerprint), null, 'Nothing was published yet');
  assert.equal(reusableInstallers({ ...previous, format: 2 }, assets, fingerprint), null);
  assert.equal(reusableInstallers(previous, assets.slice(0, -1), fingerprint), null, 'An installer is missing from the release');
  assert.equal(reusableInstallers({ ...previous, installers: installers.slice(1) }, assets, fingerprint), null, 'Every platform needs an installer');
});

test('the engine keeps only dependencies the server does not already provide', () => {
  const server = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-dedupe-'));
  const locks: Record<string, { packages: Record<string, { version: string; integrity: string }> }> = { '.': { packages: {} }, engine: { packages: {} } };
  const pkg = (folder: string, name: string, version: string) => {
    write(path.join(server, folder, 'node_modules', name, 'package.json'), { name, version });
    locks[folder].packages[`node_modules/${name}`] = { version, integrity: `sha512-${name}-${version}` };
  };
  try {
    pkg('.', 'mupdf', '1.28.1'); pkg('.', '@fastify/static', '10.1.9'); pkg('.', 'react', '19.3.1');
    pkg('engine', 'mupdf', '1.28.1'); pkg('engine', '@fastify/static', '10.1.9'); pkg('engine', 'react', '19.2.0'); pkg('engine', 'only-engine', '1.0.0');
    write(path.join(server, 'engine/node_modules/mupdf/dist/mupdf.wasm'), 'x'.repeat(1000));
    const bin = path.join(server, 'engine/node_modules/.bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync('../mupdf/cli.js', path.join(bin, 'mupdf'));
    fs.symlinkSync('../only-engine/cli.js', path.join(bin, 'only-engine'));
    write(path.join(bin, 'static.cmd'), '@"%dp0%\\..\\@fastify\\static\\cli.js" %*');
    write(path.join(bin, 'keep.cmd'), '@"%dp0%\\..\\@scope\\kept\\cli.js" %*');
    pkg('engine', '@scope/kept', '2.0.0'); pkg('.', '@scope/kept', '1.0.0');
    write(path.join(server, 'engine/node_modules/only-engine/cli.js'), '');
    fs.mkdirSync(path.join(bin, 'directory'));
    for (const folder of ['.', 'engine']) write(path.join(server, folder, 'package-lock.json'), locks[folder]);
    assert.ok(dedupeEngine(server) >= 1000, 'reports what it removed');
    const left = (name: string) => fs.existsSync(path.join(server, 'engine/node_modules', name));
    assert.ok(!left('mupdf') && !left('@fastify'), 'identical versions resolve from the server');
    assert.ok(left('react') && left('only-engine') && left('@scope/kept'), 'other versions and engine-only packages stay');
    assert.deepEqual(fs.readdirSync(bin).sort(), ['directory', 'keep.cmd', 'only-engine'], 'directories stay; executables of removed packages are gone, Windows shims too');
  } finally { fs.rmSync(server, { recursive: true, force: true }); }
});

test('engine deduplication requires matching lock identities and installed versions', () => {
  const server = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-dedupe-'));
  const entry = { version: '1.0.0', integrity: 'sha512-same' }, resolved = { version: '1.0.0', resolved: 'https://example.com/pkg.tgz' };
  const cases = [
    ['different-integrity', entry, { ...entry, integrity: 'sha512-other' }, '1.0.0', true],
    ['missing-server-entry', undefined, entry, '1.0.0', true],
    ['missing-engine-entry', entry, undefined, '1.0.0', true],
    ['different-lock-version', entry, { ...entry, version: '2.0.0' }, '1.0.0', true],
    ['different-installed-version', entry, entry, '2.0.0', true],
    ['same-resolved', resolved, resolved, '1.0.0', false],
    ['different-resolved', resolved, { ...resolved, resolved: 'https://example.com/other.tgz' }, '1.0.0', true],
    ['missing-identity', { version: '1.0.0' }, { version: '1.0.0' }, '1.0.0', true],
  ] as const;
  try {
    for (const [name, , , installed] of cases) {
      write(path.join(server, 'node_modules', name, 'package.json'), { name, version: '1.0.0' });
      write(path.join(server, 'engine/node_modules', name, 'package.json'), { name, version: installed });
    }
    write(path.join(server, 'package-lock.json'), { packages: Object.fromEntries(cases.map(([name, outer]) => [`node_modules/${name}`, outer])) });
    write(path.join(server, 'engine/package-lock.json'), { packages: Object.fromEntries(cases.map(([name, , inner]) => [`node_modules/${name}`, inner])) });
    dedupeEngine(server);
    for (const [name, , , , kept] of cases) assert.equal(fs.existsSync(path.join(server, 'engine/node_modules', name)), kept, name);
  } finally { fs.rmSync(server, { recursive: true, force: true }); }
});

test('engine deduplication preserves dependency resolution for ordinary, optional and peer dependencies', () => {
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const scenario of ['matching', 'different-version', 'nested-engine', 'nested-server', 'missing-engine', 'missing-server', 'missing-both']) {
      const server = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-dedupe-'));
      const name = '@scope/consumer', dependency = '@scope/dependency';
      const entry = { version: '1.0.0', integrity: 'sha512-same', [field]: { [dependency]: '*' } };
      const top = `node_modules/${dependency}`, nested = `node_modules/${name}/node_modules/${dependency}`;
      const outer: Record<string, unknown> = { [`node_modules/${name}`]: entry, [top]: { version: '1.0.0' } };
      const inner: Record<string, unknown> = { [`node_modules/${name}`]: entry, [top]: { version: '1.0.0' } };
      if (scenario === 'different-version') inner[top] = { version: '2.0.0' };
      if (scenario === 'nested-engine') inner[nested] = { version: '1.0.0' };
      if (scenario === 'nested-server') outer[nested] = { version: '1.0.0' };
      if (scenario === 'missing-engine' || scenario === 'missing-both') delete inner[top];
      if (scenario === 'missing-server' || scenario === 'missing-both') delete outer[top];
      try {
        for (const folder of ['.', 'engine']) write(path.join(server, folder, 'node_modules', name, 'package.json'), { name, version: '1.0.0' });
        write(path.join(server, 'package-lock.json'), { packages: outer });
        write(path.join(server, 'engine/package-lock.json'), { packages: inner });
        dedupeEngine(server);
        assert.equal(fs.existsSync(path.join(server, 'engine/node_modules', name)), scenario !== 'matching', `${field}: ${scenario}`);
      } finally { fs.rmSync(server, { recursive: true, force: true }); }
    }
  }
});
