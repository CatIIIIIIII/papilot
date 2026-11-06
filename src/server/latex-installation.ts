import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnCommand } from '../../bin/agent-paths.mjs';
import type { LatexInstallation } from '../shared.ts';

type Probe = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string | null>;
const command: Probe = (file, args, env) => new Promise(resolve => {
  const child = spawnCommand(file, args, { env, cwd: os.homedir(), timeout: 5000, killSignal: 'SIGKILL' });
  let stdout = '';
  child.stdout?.on('data', (data) => { stdout += data; });
  child.on('error', () => resolve(null));
  child.on('close', code => resolve(code === 0 ? stdout.trim() : null));
  child.stdin?.end();
});

// MiKTeX and TeX Live install here on Windows, often without being on PATH.
function texDirectories(env: NodeJS.ProcessEnv) {
  const home = env.HOME || os.homedir();
  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [path.join(programFiles, 'MiKTeX', 'bin', 'x64'), path.join(programFilesX86, 'MiKTeX', 'bin'),
    path.join(localAppData, 'Programs', 'MiKTeX', 'bin', 'x64'), path.join(programFiles, 'texlive')];
}

// Identify the installation actually found on the server's PATH. In particular,
// a MacTeX receipt elsewhere on the machine must not relabel another TeX Live.
export async function detectLatex(env: NodeJS.ProcessEnv = process.env, platform = process.platform, probe: Probe = command): Promise<LatexInstallation | null> {
  const suffix = platform === 'win32' ? '.exe' : '';
  const executable = (name: string) => {
    const extensions = platform === 'win32' ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')] : [''];
    const directories = [...(env.PATH || '').split(path.delimiter).filter(Boolean), ...(platform === 'win32' ? texDirectories(env) : [])];
    return directories.flatMap(directory => extensions.map(extension => path.resolve(directory, name + extension))).find(candidate => {
      try { fs.accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch { return false; }
    });
  };
  let found = false;
  for (const engine of ['pdflatex', 'xelatex', 'lualatex']) {
    const file = executable(engine);
    if (!file) continue;
    found = true;
    const banner = await probe(file, ['--version'], env);
    if (!banner) continue;
    const texlive = banner.match(/\bTeX Live (\d{4})\b/i);
    const miktex = banner.match(/\bMiKTeX[ \t]+([\d.]+)/i);
    let distribution: LatexInstallation['distribution'] = texlive ? 'TeX Live' : /\bMiKTeX\b/i.test(banner) ? 'MiKTeX' : null;
    const resolved = fs.realpathSync(file);
    const root = await probe(path.join(path.dirname(file), 'kpsewhich' + suffix), ['-var-value=TEXMFROOT'], env);
    const location = root && path.isAbsolute(root) && !/[\r\n]/.test(root) ? root : path.dirname(resolved);
    if (platform === 'darwin' && texlive) {
      const receipt = await probe('/usr/sbin/pkgutil', ['--file-info', resolved], env);
      const ids = [...(receipt || '').matchAll(/^pkgid:\s*(\S+)/gm)].map(match => match[1]);
      if (ids.some(id => /^org\.tug\.mactex\.basictex\d*$/i.test(id))) distribution = 'BasicTeX';
      else if (ids.some(id => /^org\.tug\.mactex\.texlive\d*$/i.test(id))) distribution = 'MacTeX';
    }
    return { distribution, version: texlive?.[1] || miktex?.[1] || null, path: location };
  }
  if (found) throw new Error('Could not read the LaTeX installation.');
  return null;
}
