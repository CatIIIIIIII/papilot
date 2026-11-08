import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findCommand } from '../engine/src/core/platform.mjs';

// Missing tools are expected on clean CI hosts. Installed tools must still be
// detected, without mistaking Apple's Git installer stub for a working Git.
export function assertInstalledTools(report, env, platform = process.platform, locate = findCommand, probe = spawnSync) {
  const toolEnv = { ...env, PATH: [env.PATH, ...(platform === 'darwin' ? ['/Library/TeX/texbin'] : [])].join(path.delimiter) };
  for (const [id, tools] of [['git', ['git']], ['latexmk', ['latexmk']], ['synctex', ['synctex']], ['tex-engine', ['pdflatex', 'xelatex', 'lualatex']]]) {
    const installed = tools.some(tool => {
      const file = locate(tool, toolEnv, platform);
      if (!file) return false;
      if (platform === 'darwin' && file === '/usr/bin/git') {
        return probe('/usr/bin/xcode-select', ['-p'], { env: toolEnv, timeout: 5000, killSignal: 'SIGKILL', stdio: 'ignore' }).status === 0;
      }
      return true;
    });
    if (installed) assert.equal(report.checks.find(check => check.id === id)?.ok, true, `The packaged app must detect installed ${id}: ${JSON.stringify(report)}`);
  }
}
