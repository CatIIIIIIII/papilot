import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import type { SystemRequirements } from '../shared.ts';

type Probe = (file: string, args: string[], env: NodeJS.ProcessEnv, timeout: number) => Promise<boolean | 'timeout'>;
type Result = Omit<SystemRequirements['checks'][number], 'id'>;
export const probeRequiredTool: Probe = (file, args, env, timeout) => new Promise(resolve => {
  const child = execFile(file, args, { env, cwd: os.homedir(), windowsHide: true, timeout, killSignal: 'SIGKILL', maxBuffer: 128 * 1024 }, error => {
    resolve(error?.killed && error.signal === 'SIGKILL' && error.code == null ? 'timeout' : !error);
  });
  child.stdin?.end();
});

export async function checkSystemRequirements(env = process.env, platform = process.platform, probe: Probe = probeRequiredTool): Promise<SystemRequirements> {
  // Windows treats environment names as case-insensitive; match Node's choice
  // if a supplied environment contains both PATH and Path.
  const pathKey = platform === 'win32' ? Object.keys(env).sort().find(key => key.toLowerCase() === 'path') || 'PATH' : 'PATH';
  const directories = (env[pathKey] || '').split(platform === 'win32' ? ';' : path.delimiter).filter(Boolean).map(dir => platform === 'win32' ? dir.replace(/^"|"$/g, '') : dir);
  async function run(file: string, args: string[]): Promise<Result> {
    let result = await probe(file, args, env, 5000);
    // Cold starts can exceed the short probe deadline. Retry once, but never
    // tell users to reinstall a tool merely because its version probe failed.
    if (result === 'timeout') result = await probe(file, args, env, 10000);
    return result === true ? { ok: true } : { ok: false, failureReason: result === 'timeout' ? 'timeout' : 'failed' };
  }
  async function available(name: string, args = ['--version']): Promise<Result> {
    // Use the server's actual PATH, just like compilation and Git operations.
    const file = directories.map(dir => path.resolve(dir, name + (platform === 'win32' ? '.exe' : ''))).find(candidate => {
      try { fs.accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch { return false; }
    });
    if (!file) return { ok: false };
    // Apple's Git stub may open an OS installation prompt. Keep detection quiet.
    if (platform === 'darwin' && file === '/usr/bin/git') {
      const developerTools = await run('/usr/bin/xcode-select', ['-p']);
      if (!developerTools.ok) return developerTools.failureReason === 'timeout' ? developerTools : { ok: false };
    }
    return run(file, args);
  }
  const [git, latexmk, synctex, ...engines] = await Promise.all([
    available('git'), available('latexmk', ['-v']), available('synctex'),
    ...['pdflatex', 'xelatex', 'lualatex'].map(name => available(name)),
  ]);
  const engine = engines.find(result => result.ok) || engines.find(result => result.failureReason === 'timeout') || engines.find(result => result.failureReason) || { ok: false };
  return { platform, checks: [{ id: 'git', ...git }, { id: 'latexmk', ...latexmk }, { id: 'synctex', ...synctex }, { id: 'tex-engine', ...engine }] };
}

// Concurrent tabs share the probe; an explicit retry always gets fresh results.
let pending: Promise<SystemRequirements> | undefined;
export function systemRequirements() {
  return pending ||= checkSystemRequirements().finally(() => { pending = undefined; });
}
