import fs from 'node:fs';
import path from 'node:path';

export const stableVersion = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) && value.length < 40;
export const devRevision = value => typeof value === 'string' && value.length < 100 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-dev\.([a-f0-9]{40})$/.exec(value)?.[4] || null;
export const releaseVersion = value => stableVersion(value) || Boolean(devRevision(value));
export function newerVersion(next, current) {
  if (!stableVersion(next)) return false;
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(current);
  if (!match) return false;
  const parts = next.split('.').map(BigInt), previous = match.slice(1, 4).map(BigInt);
  for (let i = 0; i < 3; i++) if (parts[i] !== previous[i]) return parts[i] > previous[i];
  return match[4].startsWith('-');
}
export function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
// Updates live beside the database, never over a global installation or checkout.
// All launch methods (CLI, npm start, launchd) enter through main.ts.
export function activeInstallation(root, data) {
  if (process.env.PAPILOT_INSTALL_METHOD === 'nix') return root;
  const active = readJson(path.join(data, 'updates/active.json'));
  const version = readJson(path.join(root, 'package.json'))?.version;
  if (!active || !releaseVersion(active.version)) return root;
  // Explicit channel selections also cover dev builds and returning to stable.
  // Older activation records retain their upgrade-only behavior.
  if (!['stable', 'dev'].includes(active.channel) && !newerVersion(active.version, version)) return root;
  if (active.channel && (active.channel === 'dev') !== Boolean(devRevision(active.version))) return root;
  if (typeof active.root !== 'string') return root;
  try {
    const releases = fs.realpathSync(path.join(data, 'updates/releases')) + path.sep;
    if (!fs.realpathSync(active.root).startsWith(releases)) return root;
  } catch { return root; }
  const pkg = readJson(path.join(active.root, 'package.json'));
  if (pkg?.name !== 'papilot' || pkg.version !== active.version || !fs.existsSync(path.join(active.root, 'src/server/start.ts'))) return root;
  return active.root;
}
export async function waitForActivation(data) {
  if (process.env.PAPILOT_INSTALL_METHOD === 'nix') return;
  const file = path.join(data, 'updates/active.json');
  for (let attempt = 0; attempt < 200; attempt++) {
    const active = readJson(file);
    if (active?.phase !== 'pending') return;
    try { process.kill(active.pid, 0); }
    catch {
      if (active.previous) writeJson(file, active.previous); else fs.rmSync(file, { force: true });
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('The update is still restarting.');
}
