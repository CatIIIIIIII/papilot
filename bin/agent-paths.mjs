import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

export const WINDOWS = process.platform === 'win32';

// Node's --import reads an absolute Windows path as a URL whose scheme is the
// drive letter, so a loader path must be a file URL there.
export function importLoader(file) {
  return pathToFileURL(file).href;
}
// Git for Windows often puts an MSYS tar on PATH, which cannot read Windows
// paths; the system bsdtar can.
export function tarCommand() {
  if (!WINDOWS) return 'tar';
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const absolute = path.join(root, 'System32', 'tar.exe');
  return fs.existsSync(absolute) ? absolute : 'tar';
}

// Keep wrapper paths intact: resolving symlinks can bypass Nix's environment.
export function agentDirs(env = process.env) {
  const home = env.HOME || os.homedir();
  // Windows per-user and system install locations for the tools Papilot drives.
  // They are only used there; the POSIX directories above are harmless elsewhere.
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const programData = env.ProgramData || 'C:\\ProgramData';
  return [path.join(home, '.nix-profile/bin'), path.join(env.XDG_STATE_HOME || path.join(home, '.local/state'), 'nix/profile/bin'),
    '/etc/profiles/per-user/' + path.basename(home) + '/bin', '/run/current-system/sw/bin', '/nix/var/nix/profiles/default/bin',
    ...['.local/bin', '.claude/local', '.kimi-code/bin', '.grok/bin', '.opencode/bin', '.bun/bin', '.npm-global/bin'].map(dir => path.join(home, dir)),
    '/opt/homebrew/bin', '/usr/local/bin',
    ...(WINDOWS ? [path.join(appData, 'npm'), path.join(localAppData, 'Programs'), path.join(home, '.volta/bin'),
      path.join(home, 'scoop/shims'), path.join(programData, 'chocolatey/bin'), path.join(programFiles, 'nodejs'),
      path.join(programFiles, 'Git/cmd'), path.join(programFiles, 'Git/bin'),
      path.join(programFiles, 'MiKTeX/bin/x64'), path.join(programFilesX86, 'MiKTeX/bin'),
      path.join(localAppData, 'Programs/MiKTeX/bin/x64')] : [])];
}
export function agentPath(env = process.env) {
  return [...new Set([...(env.PATH || '').split(path.delimiter).filter(Boolean), ...agentDirs(env)])].join(path.delimiter);
}
export function findExecutable(command, env = process.env) {
  // Windows executables carry an extension from PATHEXT; an extensionless file
  // is not runnable there, so it must not shadow a .cmd shim beside it.
  const extensions = WINDOWS ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  const explicit = command.includes('/') || (WINDOWS && command.includes('\\'));
  const candidates = explicit ? [path.resolve(command)]
    : agentPath(env).split(path.delimiter).map(dir => path.join(dir, command));
  // A path that already names an executable is used as it is; a bare name
  // found on PATH gets PATHEXT appended.
  const suffixes = explicit && /\.(exe|com|bat|cmd)$/i.test(command) ? [''] : extensions;
  for (const candidate of candidates) for (const extension of suffixes) {
    const file = candidate + extension;
    try { if (!fs.statSync(file).isFile()) continue; fs.accessSync(file, WINDOWS ? fs.constants.F_OK : fs.constants.X_OK); return file; } catch { /* try next */ }
  }
  return null;
}
// The executable PATH resolves a command to, as a shell would find it. This is
// the cross-platform `which`: Windows needs PATHEXT, POSIX needs the execute bit.
export function which(command, env = process.env) {
  return findExecutable(command, env);
}
// A system program, found without PATH: Papilot tools can run with a minimal
// environment that does not include System32, and cmd.exe starts .cmd shims.
function systemExecutable(name) {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const absolute = path.join(root, 'System32', name);
  return fs.existsSync(absolute) ? absolute : name;
}
// cmd.exe metacharacters. A caret keeps one literal in the command line the
// shell parses before the script sees it.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
const escapeCommand = arg => arg.replace(CMD_META, '^$1');
// Quotes one argument for cmd.exe and the program it starts. The backslash
// rules follow https://qntm.org/cmd, as cross-spawn does.
const escapeArgument = arg => {
  arg = String(arg);
  arg = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  arg = arg.replace(/(?=(\\+?)?)\1$/, '$1$1');
  return `"${arg}"`.replace(CMD_META, '^$1');
};
// An npm-installed CLI is a .cmd shim that runs a Node script and re-expands
// its arguments with %*. A shim cannot carry a multi-line prompt or one with
// shell metacharacters through that second parse, so run the script directly.
function shimScript(file) {
  let content;
  try { content = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const quoted = [...content.matchAll(/"([^"]+)"/g)].map(match => match[1]);
  const candidates = quoted.map(value => value.replaceAll('%dp0%', path.dirname(file) + path.sep))
    .map(value => path.resolve(path.dirname(file), value))
    .filter(candidate => candidate !== file && fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  return candidates.find(candidate => candidate.endsWith('.js'))
    || candidates.find(candidate => !/node(\.exe)?$/i.test(candidate)) || null;
}
// Windows cannot start .bat and .cmd files without a shell, and cmd.exe parses
// the command line before the script does. Every argument is quoted for the
// shell, then the whole line is handed over verbatim so a second parse cannot
// change it. Other platforms and executables run directly.
function shellOut(command, args, env) {
  const resolved = findExecutable(command, env)
    ?? ((command.includes('/') || command.includes('\\')) ? path.resolve(command) : null);
  const file = resolved || command;
  if (!WINDOWS || !/\.(bat|cmd)$/i.test(file)) return { file, args, options: {} };
  const script = shimScript(file);
  if (script) return { file: process.execPath, args: [script, ...args], options: {} };
  const line = [escapeCommand(file), ...args.map(escapeArgument)].join(' ');
  const shell = process.env.comspec || process.env.ComSpec || systemExecutable('cmd.exe');
  return { file: shell, args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } };
}
export function spawnCommand(command, args, options = {}) {
  const { file, args: shellArgs, options: shellOptions } = shellOut(command, args, options.env || process.env);
  const { timeout, killSignal, ...rest } = options;
  // Node's own timeout would kill only the shell; a .cmd shim's program would
  // keep the stdio pipes open and the caller waiting. On Windows, end the
  // whole tree instead and leave the timing to that timer.
  const child = WINDOWS
    ? spawn(file, shellArgs, { ...rest, ...shellOptions })
    : spawn(file, shellArgs, { ...rest, timeout, killSignal, ...shellOptions });
  if (WINDOWS && timeout) {
    const timer = setTimeout(() => { try { if (child.pid) killTree(child.pid, killSignal || 'SIGKILL'); } catch { child.kill(killSignal || 'SIGKILL'); } }, timeout);
    timer.unref?.();
    child.once('close', () => clearTimeout(timer));
    child.once('error', () => clearTimeout(timer));
  }
  return child;
}
export function spawnSyncCommand(command, args, options = {}) {
  const { file, args: shellArgs, options: shellOptions } = shellOut(command, args, options.env || process.env);
  return spawnSync(file, shellArgs, { ...options, ...shellOptions });
}
// Runs a command and resolves with its stdout. The rejection carries stdout and
// stderr, which callers such as login checks inspect without leaking them.
export function execCommand(command, args, options = {}) {
  const { timeout, env, cwd } = options;
  return new Promise((resolve, reject) => {
    const child = spawnCommand(command, args, { cwd, env, timeout, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout?.on('data', (data) => { stdout += data; });
    child.stderr?.on('data', (data) => { stderr += data; });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) { resolve(stdout); return; }
      const failure = new Error(stderr.trim() || `${command} failed (${code})`);
      failure.stdout = stdout; failure.stderr = stderr;
      reject(failure);
    });
  });
}
// Ends a command with everything it started. Windows has no process groups for
// plain spawn, so taskkill walks the tree instead; POSIX signals the group.
export function killTree(pid, signal = 'SIGTERM') {
  if (!pid) return;
  if (WINDOWS) { spawnSync(systemExecutable('taskkill.exe'), ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); return; }
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* already gone */ } }
}
// Replaces a directory link to a downloaded update layer. A junction needs no
// Developer Mode or elevation on Windows, and readlinkSync still resolves it.
export function linkDirectory(target, link) {
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(target, link, WINDOWS ? 'junction' : 'dir');
}
