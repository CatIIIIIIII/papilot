import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import type { SystemRequirements } from '../shared.ts';

type Probe = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<boolean>;
const command: Probe = (file, args, env) => new Promise(resolve => {
  const child = execFile(file, args, { env, cwd: os.homedir(), windowsHide: true, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024 }, error => resolve(!error));
  child.stdin?.end();
});

export async function checkSystemRequirements(env = process.env, platform = process.platform, probe: Probe = command): Promise<SystemRequirements> {
  // Windows treats environment names as case-insensitive; match Node's choice
  // if a supplied environment contains both PATH and Path.
  const pathKey = platform === 'win32' ? Object.keys(env).sort().find(key => key.toLowerCase() === 'path') || 'PATH' : 'PATH';
  const directories = (env[pathKey] || '').split(platform === 'win32' ? ';' : path.delimiter).filter(Boolean).map(dir => platform === 'win32' ? dir.replace(/^"|"$/g, '') : dir);
  async function available(name: string, args = ['--version']) {
    // Use the server's actual PATH, just like compilation and Git operations.
    const file = directories.map(dir => path.resolve(dir, name + (platform === 'win32' ? '.exe' : ''))).find(candidate => {
      try { fs.accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch { return false; }
    });
    if (!file) return false;
    // Apple's Git stub may open an OS installation prompt. Keep detection quiet.
    if (platform === 'darwin' && file === '/usr/bin/git' && !await probe('/usr/bin/xcode-select', ['-p'], env)) return false;
    return probe(file, args, env);
  }
  const [git, latexmk, synctex, ...engines] = await Promise.all([
    available('git'), available('latexmk', ['-v']), available('synctex'),
    ...['pdflatex', 'xelatex', 'lualatex'].map(name => available(name)),
  ]);
  return { platform, checks: [{ id: 'git', ok: git }, { id: 'latexmk', ok: latexmk }, { id: 'synctex', ok: synctex }, { id: 'tex-engine', ok: engines.some(Boolean) }] };
}

// Concurrent tabs share the probe; an explicit retry always gets fresh results.
let pending: Promise<SystemRequirements> | undefined;
export function systemRequirements() {
  return pending ||= checkSystemRequirements().finally(() => { pending = undefined; });
}
