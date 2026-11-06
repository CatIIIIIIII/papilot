import fs from 'node:fs';
import path from 'node:path';

// The npm CLI entry point, always run with this Node. Windows has no npm.exe,
// only .cmd shims that need a shell, so the script path works on every platform.
export function npmCli(env = process.env, executable = process.execPath) {
  const directory = path.dirname(executable);
  const candidates = [env.npm_execpath,
    path.join(directory, 'node_modules/npm/bin/npm-cli.js'),
    path.join(directory, '../lib/node_modules/npm/bin/npm-cli.js'),
    ...(env.PATH || env.Path || '').split(path.delimiter).flatMap(dir => [path.join(dir, 'node_modules/npm/bin/npm-cli.js'), path.join(dir, '../lib/node_modules/npm/bin/npm-cli.js'), path.join(dir, 'npm-cli.js'), path.join(dir, 'npm')])];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { const real = fs.realpathSync(candidate); if (real.endsWith('npm-cli.js')) return real; } catch { /* next installation */ }
  }
  throw new Error('npm is unavailable to Papilot.');
}
