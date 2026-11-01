import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

export function backendEnvironment(node: string, root: string, data: string, inherited = process.env) {
  const home = os.homedir();
  const nvm = path.join(inherited.NVM_DIR || path.join(home, '.nvm'), 'versions/node');
  let nodeBins: string[] = [];
  try { nodeBins = fs.readdirSync(nvm).filter(version => /^v\d+\.\d+\.\d+$/.test(version)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(version => path.join(nvm, version, 'bin')); } catch { /* nvm is optional */ }
  const directories = [path.dirname(node), path.join(root, 'node_modules/.bin'),
    ...(inherited.PATH || '').split(path.delimiter),
    ...['.local/bin', '.claude/local', '.kimi-code/bin', '.grok/bin', '.opencode/bin', '.bun/bin', '.npm-global/bin', '.volta/bin', '.asdf/shims'].map(dir => path.join(home, dir)), ...nodeBins,
    '/Library/TeX/texbin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const env = { ...inherited, PATH: [...new Set(directories.filter(dir => path.isAbsolute(dir)))].join(path.delimiter),
    NODE_ENV: 'production', PAPILOT_DESKTOP: '1', PAPILOT_DATA: data, PAPILOT_PORT: '0',
    PAPILOT_PUBLIC_ORIGIN: '', PAPILOT_ACCOUNT_ORIGIN: '', PAPILOT_TAILSCALE_LOGIN: '' };
  // The backend is ordinary Node, even when Electron itself was started by a tool.
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'PAPILOT_REVIEW_ENGINE']) delete (env as NodeJS.ProcessEnv)[key];
  return env;
}

export function startBackend(options: { node: string; root: string; data: string; log: string; env: NodeJS.ProcessEnv }) {
  fs.mkdirSync(options.data, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(options.log), { recursive: true });
  // Bound the log across launches without discarding the previous startup failure.
  if (fs.existsSync(options.log) && fs.statSync(options.log).size > 5 * 1024 * 1024) fs.renameSync(options.log, options.log + '.old');
  const fd = fs.openSync(options.log, 'a', 0o600);
  let child: ChildProcess;
  try {
    child = spawn(options.node, ['--import', path.join(options.root, 'node_modules/tsx/dist/loader.mjs'), path.join(options.root, 'src/server/start.ts')], {
      cwd: options.root, env: options.env, stdio: ['ignore', fd, fd, 'ipc'], detached: process.platform !== 'win32',
    });
  } finally { fs.closeSync(fd); }
  const ready = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error('The local server did not start within 60 seconds.')), 60000);
    const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('error', fail); child.off('exit', exited); };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const exited = (code: number | null, signal: string | null) => fail(new Error(`The local server stopped (${signal || code}).`));
    const message = (value: unknown) => {
      if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'papilot:ready' || !('url' in value) || typeof value.url !== 'string') return;
      const url = new URL(value.url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !Number(url.port)) return;
      cleanup(); resolve(url.origin);
    };
    child.on('message', message); child.once('error', fail); child.once('exit', exited);
  });
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already stopped */ }
        resolve();
      }, 4000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }
  return { child, ready, stop };
}
