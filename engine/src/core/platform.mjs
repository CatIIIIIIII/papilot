import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function envPath(env = process.env) {
  return env.PATH ?? env.Path ?? env.path ?? '';
}

export function findCommand(command, env = process.env, platform = process.platform) {
  const windows = platform === 'win32', paths = windows ? path.win32 : path;
  const extensions = windows ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  const suffixes = windows && extensions.some(ext => command.toLowerCase().endsWith(ext.toLowerCase())) ? [''] : extensions;
  const candidates = /[/\\]/.test(command) ? [paths.resolve(command)] : envPath(env).split(windows ? ';' : path.delimiter).filter(Boolean).map(dir => paths.join(dir.replace(/^"|"$/g, ''), command));
  for (const candidate of candidates) for (const suffix of suffixes) {
    const file = candidate + suffix;
    try { if (!fs.statSync(file).isFile()) continue; fs.accessSync(file, windows ? fs.constants.F_OK : fs.constants.X_OK); return file; } catch { /* next candidate */ }
  }
  return null;
}

// npm's Windows shims run Node scripts. Invoke the script directly: prompts
// can contain newlines, quotes and cmd metacharacters and must remain one arg.
export function commandSpec(command, args, env = process.env) {
  if (process.platform !== 'win32') return { command, args };
  const file = findCommand(command, env) || command;
  if (/\.(?:cmd|bat)$/i.test(file)) {
    let shim = '';
    try { shim = fs.readFileSync(file, 'utf8'); } catch { /* launch reports it */ }
    const entry = /"%(?:dp0|~dp0)%?[/\\]([^"\r\n]+\.(?:[cm]?js))"/i.exec(shim)?.[1];
    if (entry && /node(?:\.exe)?/i.test(shim)) {
      const script = path.resolve(path.dirname(file), entry);
      if (fs.existsSync(script)) return { command: process.execPath, args: [script, ...args] };
    }
    if (args.some(arg => /[\r\n]/.test(arg))) throw new Error('This Windows batch launcher cannot accept multiline arguments. Use the agent executable or its npm installation.');
  }
  return { command: file, args };
}

export function npmCli(env = process.env, executable = process.execPath) {
  const folders = [path.dirname(executable), ...envPath(env).split(path.delimiter).filter(Boolean)];
  const candidates = [env.npm_execpath, ...folders.flatMap(dir => [path.join(dir, 'node_modules/npm/bin/npm-cli.js'), path.join(dir, '../lib/node_modules/npm/bin/npm-cli.js'), path.join(dir, 'npm')])];
  for (const file of candidates) {
    if (!file) continue;
    try { const real = fs.realpathSync(file); if (real.endsWith('npm-cli.js')) return real; } catch { /* next installation */ }
  }
  throw new Error('npm is unavailable to Papilot.');
}

export function terminateTree(child, signal = 'SIGTERM') {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // taskkill must finish before the owner exits or starts another build.
    const result = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
    if (result.status !== 0) child.kill();
    return;
  }
  try {
    process.kill(-child.pid, signal);
    if (signal !== 'SIGKILL') process.kill(-child.pid, 'SIGCONT');
  } catch { child.kill(signal); }
}
