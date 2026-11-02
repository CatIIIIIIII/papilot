import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopVersion, INSTALLER_SUFFIXES, reusableInstallers, shellFingerprint } from '../scripts/desktop-layer.mjs';

const write = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
function checkout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-shell-'));
  write(path.join(root, 'package.json'), { name: 'papilot', version: '0.9.0', devDependencies: { electron: '45.2.1', 'electron-builder': '26.18.0', '@openai/codex': '0.164.0', typescript: '7.0.0' } });
  write(path.join(root, 'package-lock.json'), { packages: { '': { name: 'papilot' }, 'node_modules/fastify': { version: '5.0.0', integrity: 'sha512-a' }, 'node_modules/typescript': { version: '7.0.0', integrity: 'sha512-b', dev: true } } });
  write(path.join(root, 'engine/package-lock.json'), { packages: { '': {}, 'node_modules/diff': { version: '9.0.0', integrity: 'sha512-c' } } });
  write(path.join(root, 'desktop/main.ts'), 'main'); write(path.join(root, 'desktop/README.md'), 'docs');
  write(path.join(root, 'scripts/desktop.mjs'), 'stage');
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
    for (const [message, change] of [
      ['a new Node major', () => {}],
      ['a production dependency', () => { lock.packages['node_modules/fastify'].version = '5.1.0'; write(path.join(root, 'package-lock.json'), lock); }],
      ['an engine dependency', () => write(path.join(root, 'engine/package-lock.json'), { packages: { 'node_modules/diff': { version: '9.1.0' } } })],
      ['the Electron app', () => write(path.join(root, 'desktop/main.ts'), 'changed main')],
      ['how the installer is staged', () => write(path.join(root, 'scripts/desktop.mjs'), 'changed stage')],
      ['Codex', () => { const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); pkg.devDependencies['@openai/codex'] = '0.165.0'; write(path.join(root, 'package.json'), pkg); }],
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
