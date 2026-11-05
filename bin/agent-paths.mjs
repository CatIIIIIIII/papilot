import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Keep wrapper paths intact: resolving symlinks can bypass Nix's environment.
export function agentDirs(env = process.env) {
  const home = env.HOME || os.homedir();
  return [path.join(home, '.nix-profile/bin'), path.join(env.XDG_STATE_HOME || path.join(home, '.local/state'), 'nix/profile/bin'),
    '/etc/profiles/per-user/' + path.basename(home) + '/bin', '/run/current-system/sw/bin', '/nix/var/nix/profiles/default/bin',
    ...['.local/bin', '.claude/local', '.kimi-code/bin', '.grok/bin', '.opencode/bin', '.bun/bin', '.npm-global/bin'].map(dir => path.join(home, dir)),
    '/opt/homebrew/bin', '/usr/local/bin'];
}
export function agentPath(env = process.env) {
  return [...new Set([...(env.PATH || '').split(path.delimiter).filter(Boolean), ...agentDirs(env)])].join(path.delimiter);
}
export function findExecutable(command, env = process.env) {
  const windows = process.platform === 'win32';
  const extensions = windows ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')] : [''];
  const candidates = command.includes('/') || (windows && command.includes('\\')) ? [path.resolve(command)]
    : agentPath(env).split(path.delimiter).map(dir => path.join(dir, command));
  for (const candidate of candidates) for (const extension of extensions) {
    const file = candidate + extension;
    try { if (!fs.statSync(file).isFile()) continue; fs.accessSync(file, windows ? fs.constants.F_OK : fs.constants.X_OK); return file; } catch { /* try next */ }
  }
  return null;
}
