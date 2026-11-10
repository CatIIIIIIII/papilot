import fs from 'node:fs';
import path from 'node:path';
import { agentPath, findExecutables, killTree, spawnCommand, WINDOWS } from './agent-paths.mjs';

const kernelRelease = (() => {
  try { return process.platform === 'linux' ? fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8') : ''; }
  catch { return ''; }
})();
export function isWsl(env = process.env, platform = process.platform, release = kernelRelease) {
  return platform === 'linux' && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP || /microsoft/i.test(release));
}
export function windowsDrive(dir) {
  return /^\/mnt\/[a-z](?:\/|$)/i.test(dir.replace(/^"|"$/g, ''));
}
// Try PATH in order, then the checkout and the copy installed by the npm command.
export function codexCandidates(env, data, root, wsl = isWsl(env)) {
  // Windows shims do not supply WSL's Codex; avoid their slow 9P folders too.
  return env.PAPILOT_CODEX_BIN ? [env.PAPILOT_CODEX_BIN] : findExecutables('codex', env, [path.join(root, 'node_modules', '.bin'), path.join(data, 'agents', 'node_modules', '.bin')], dir => !wsl || !windowsDrive(dir));
}

/** The first candidate that runs, tried with the PATH Codex is started with. */
export async function firstRunnable(candidates, env = process.env, { timeout = 15000, budget = 30000, signal } = {}) {
  if (signal?.aborted) return null;
  const deadline = Date.now() + budget;
  const probe = { ...env, PATH: agentPath(env) };
  for (const file of candidates) {
    const remaining = deadline - Date.now();
    if (signal?.aborted || remaining <= 0) return null;
    try {
      const runs = await new Promise(resolve => {
        const child = spawnCommand(file, ['--version'], { env: probe, stdio: 'ignore', detached: !WINDOWS });
        let settled = false;
        const finish = runs => {
          if (settled) return;
          settled = true; clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve(runs);
        };
        // A wrapper's children must neither hold pipes open nor outlive the probe.
        const stop = () => {
          try { if (child.pid) killTree(child.pid, 'SIGKILL'); }
          catch { try { child.kill('SIGKILL'); } catch { /* already stopped */ } }
          finally { finish(false); }
        };
        const timer = setTimeout(stop, Math.min(timeout, remaining));
        child.once('exit', code => finish(code === 0));
        child.once('error', () => finish(false));
        signal?.addEventListener('abort', stop, { once: true });
        if (signal?.aborted) stop();
      });
      if (signal?.aborted) return null;
      if (runs) return file;
    } catch { /* a broken installation; try the next */ }
  }
  return null;
}
