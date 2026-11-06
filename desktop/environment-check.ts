import fs from 'node:fs';
import path from 'node:path';
import { backendEnvironment, refreshWindowsPath } from './runtime.js';
import { findCommand } from './platform.mjs';
import { archiveInfo, distributions, linuxArgs, NODE, wslCommand, type Environment } from './wsl.js';

export const setupLinks = {
  wsl: 'https://learn.microsoft.com/windows/wsl/install',
  node: 'https://nodejs.org/en/download',
  gitWindows: 'https://git-scm.com/install/windows',
  gitLinux: 'https://git-scm.com/install/linux',
  texWindows: 'https://tug.org/texlive/windows.html',
  texLinux: 'https://tug.org/texlive/quickinstall.html',
} as const;
export type SetupLink = keyof typeof setupLinks;
export type EnvironmentReport = { checks: { id: 'node' | 'git' | 'tex'; ready: boolean; detail: string }[]; canPrepare: boolean; prepared: boolean };
export const supportedNode = (version: string) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return Boolean(match && (+match[1] > 22 || +match[1] === 22 && +match[2] >= 22));
};
// The probe only returns tool versions/presence and runtime readiness. It never
// reads agent credentials, installs packages, or asks a shell to evaluate input.
export const WSL_CHECK = NODE + `
linux_tool() { local p; p=$(type -P "$1") || return 1; case "$p" in /mnt/*|*.exe|*.cmd|*.bat) return 1;; esac; }
node_version=''; npm_ready=''
if linux_tool node && supported_node node; then
  node_version=$(node -p 'process.versions.node')
  if linux_tool npm && npm --version >/dev/null 2>&1; then npm_ready=yes; fi
fi
printf 'PAPILOT_CHECK:node=%s\n' "$node_version"
printf 'PAPILOT_CHECK:npm=%s\n' "$npm_ready"
if linux_tool git && git --version >/dev/null 2>&1; then printf 'PAPILOT_CHECK:git=yes\n'; fi
missing=''
for tool in latexmk synctex; do if ! linux_tool "$tool"; then missing="$missing $tool"; fi; done
if ! linux_tool pdflatex && ! linux_tool xelatex && ! linux_tool lualatex; then missing="$missing LaTeX"; fi
printf 'PAPILOT_CHECK:tex=%s\n' "$missing"
if [ -f "$HOME/.local/share/papilot-desktop/runtime/$1/ready.json" ]; then printf 'PAPILOT_CHECK:prepared=yes\n'; fi
`;
export function wslReport(output: string): EnvironmentReport {
  const values = new Map(output.split(/\r?\n/).filter(line => line.startsWith('PAPILOT_CHECK:')).map(line => {
    const i = line.indexOf('='); return [line.slice(14, i), line.slice(i + 1).trim()];
  }));
  if (!values.has('node') || !values.has('npm') || !values.has('tex')) throw new Error('The environment check did not finish. Open the distribution in Windows Terminal, then check again.');
  const node = supportedNode(values.get('node') || '') && values.get('npm') === 'yes';
  return { checks: [
    { id: 'node', ready: node, detail: node ? `Node.js ${values.get('node')} · npm` : 'Node.js 22.22+ / npm' },
    { id: 'git', ready: values.get('git') === 'yes', detail: '' },
    { id: 'tex', ready: values.get('tex') === '', detail: values.get('tex') || '' },
  ], canPrepare: node, prepared: values.get('prepared') === 'yes' };
}
export async function inspectEnvironment(environment: Environment, assets: string, root: string): Promise<EnvironmentReport> {
  if (environment.kind === 'wsl') {
    if (!(await distributions()).includes(environment.distribution)) throw new Error('Choose an installed WSL distribution.');
    const { id } = archiveInfo(assets);
    return wslReport(await wslCommand(linuxArgs(environment.distribution, WSL_CHECK, [id])));
  }
  const inherited = await refreshWindowsPath();
  const env = backendEnvironment(process.execPath, root, root, inherited);
  const missing = ['latexmk', 'synctex'].filter(tool => !findCommand(tool, env));
  if (!['pdflatex', 'xelatex', 'lualatex'].some(tool => findCommand(tool, env))) missing.push('LaTeX');
  const bundled = fs.existsSync(path.resolve(root, '../runtime/bin/node.exe'));
  return { checks: [
    { id: 'node', ready: true, detail: bundled ? 'bundled' : `Node.js ${process.versions.node}` },
    { id: 'git', ready: Boolean(findCommand('git', env)), detail: '' },
    { id: 'tex', ready: !missing.length, detail: missing.join(', ') },
  ], canPrepare: true, prepared: true };
}
