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
  const home = (WINDOWS ? env.USERPROFILE || env.HOME : env.HOME) || os.homedir();
  // Windows per-user and system install locations for the tools Papilot drives.
  // They are only used there; the POSIX directories above are harmless elsewhere.
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const programData = env.ProgramData || 'C:\\ProgramData';
  let texLive = [];
  if (WINDOWS) {
    const root = path.join(env.SystemDrive || 'C:', 'texlive');
    try { texLive = fs.readdirSync(root).filter(year => /^\d{4}$/.test(year)).sort().reverse().map(year => path.join(root, year, 'bin/windows')); } catch { /* optional */ }
  }
  return [path.join(home, '.nix-profile/bin'), path.join(env.XDG_STATE_HOME || path.join(home, '.local/state'), 'nix/profile/bin'),
    '/etc/profiles/per-user/' + path.basename(home) + '/bin', '/run/current-system/sw/bin', '/nix/var/nix/profiles/default/bin',
    ...['.local/bin', '.claude/local', '.kimi-code/bin', '.grok/bin', '.opencode/bin', '.bun/bin', '.npm-global/bin'].map(dir => path.join(home, dir)),
    '/opt/homebrew/bin', '/usr/local/bin',
    ...(WINDOWS ? [path.join(appData, 'npm'), path.join(localAppData, 'Programs'), path.join(home, '.volta/bin'),
      path.join(home, 'scoop/shims'), path.join(programData, 'chocolatey/bin'), path.join(programFiles, 'nodejs'),
      path.join(programFiles, 'Git/cmd'), path.join(programFiles, 'Git/bin'),
      path.join(localAppData, 'Programs/Git/cmd'),
      path.join(programFiles, 'MiKTeX/bin/x64'), path.join(programFilesX86, 'MiKTeX/bin'),
      path.join(localAppData, 'Programs/MiKTeX/bin/x64'),
      path.join(programFiles, 'MiKTeX/miktex/bin/x64'), path.join(localAppData, 'Programs/MiKTeX/miktex/bin/x64'), ...texLive] : [])];
}
export function agentPath(env = process.env) {
  const inherited = WINDOWS ? Object.keys(env).filter(key => key.toLowerCase() === 'path').map(key => env[key] || '').join(path.delimiter) : env.PATH || '';
  return [...new Set([...inherited.split(path.delimiter).filter(Boolean), ...agentDirs(env)])].join(path.delimiter);
}
export function findExecutable(command, env = process.env) {
  // Windows executables carry an extension from PATHEXT; an extensionless file
  // is not runnable there, so it must not shadow a .cmd shim beside it.
  const extensions = WINDOWS ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  const explicit = command.includes('/') || (WINDOWS && command.includes('\\'));
  const candidates = explicit ? [path.resolve(command)]
    : agentPath(env).split(path.delimiter).map(dir => path.join(dir.replace(/^"|"$/g, ''), command));
  // A path that already names an executable is used as it is; a bare name
  // found on PATH gets PATHEXT appended.
  const suffixes = WINDOWS && extensions.some(extension => command.toLowerCase().endsWith(extension.toLowerCase())) ? [''] : extensions;
  for (const candidate of candidates) for (const extension of suffixes) {
    const file = candidate + extension;
    try { if (!fs.statSync(file).isFile()) continue; fs.accessSync(file, WINDOWS ? fs.constants.F_OK : fs.constants.X_OK); return file; } catch { /* try next */ }
  }
  return null;
}
// Every executable PATH offers for a command, in order, each installation once
// (links to the same file count once). An early one may be broken.
export function findExecutables(command, env = process.env, extra = [], include = () => true) {
  const seen = new Set();
  return [...agentPath(env).split(path.delimiter), ...extra].filter(Boolean).filter(include).map(dir => findExecutable(path.join(dir.replace(/^"|"$/g, ''), command), env)).filter(file => {
    if (!file) return false;
    let real = file; try { real = fs.realpathSync(file); } catch { /* compared as it is */ }
    return !seen.has(real) && Boolean(seen.add(real));
  });
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
const escapeArgument = (arg, doubleEscape = false) => {
  arg = String(arg);
  arg = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  arg = arg.replace(/(?=(\\+?)?)\1$/, '$1$1');
  const escaped = `"${arg}"`.replace(CMD_META, '^$1');
  return doubleEscape ? escaped.replace(CMD_META, '^$1') : escaped;
};
// An npm-installed CLI is a .cmd shim that runs a Node script and re-expands
// its arguments with %*. A shim cannot carry a multi-line prompt or one with
// shell metacharacters through that second parse, so run the script directly.
function onlyNodeShim(lines, calls) {
  // Recognize the complete wrapper, not a Node line hidden among setup commands
  // or branches. Unknown batch programs must execute their own environment and
  // control flow. These are npm's current/legacy templates and simple shims.
  // Trailing spaces are part of an unquoted SET value, not formatting.
  if (lines.some(line => /^\s*@?set\s+[^"\s]/i.test(line) && /[\t ]$/.test(line))) return false;
  const body = lines.map(line => line.trim().replace(/^@/, '').replace(/[\t ]+/g, ' ').toLowerCase());
  if (body.filter(line => line === 'node').length !== calls) return false;
  const setup = new Set(['echo off', 'setlocal', 'set dp0=%~dp0', 'set "dp0=%~dp0"']);
  while (setup.has(body[0])) body.shift();
  const preamble = ['goto start', ':find_dp0', 'set dp0=%~dp0', 'exit /b', ':start', 'setlocal', 'call :find_dp0'];
  if (preamble.every((line, index) => body[index] === line)) body.splice(0, preamble.length);
  const pathext = 'set pathext=%pathext:;.js;=;%';
  return body.join('\n') === 'node'
    || [[], [pathext]].some(extra => body.join('\n') === [
      'if exist "%dp0%\\node.exe" (', 'set "_prog=%dp0%\\node.exe"', ') else (', 'set "_prog=node"', ...extra, ')', 'node',
    ].join('\n'))
    || body.join('\n') === [
      'if exist "%~dp0\\node.exe" (', 'node', ') else (', 'setlocal', pathext, 'node', ')',
    ].join('\n');
}
function shimScript(file, content) {
  // Only bypass a wrapper when its command really invokes Node. Quoted
  // paths elsewhere may name a native executable, a data file or another
  // interpreter's script. npm uses _prog for its bundled/system Node choice.
  const programs = [...content.matchAll(/\bset\s+"?_prog=([^"\r\n]+)/gi)].map(match => match[1].trim());
  const lines = content.split(/\r?\n/).filter(line => line.trim());
  const calls = [];
  for (const [index, line] of lines.entries()) {
    const command = line.replace(/^\s*endlocal\s*&\s*goto\s+#_undefined_#\s+2>NUL\s*\|\|\s*title\s+%COMSPEC%\s*&\s*/i, '').trim();
    const match = /^@?(?:"([^"]+)"|(node(?:\.exe)?))\s+((?:(?:"[^"\r\n]*"|[^\s"]+)\s+)*)"([^"\r\n]+)"\s+%\*\s*$/i.exec(command);
    if (!match) continue;
    const isNode = value => /^(?:%(?:dp0%|~dp0)[\\/]*|[^%]*[\\/])?node(?:\.exe)?$/i.test(value);
    const executable = match[1] || match[2];
    if (executable.toLowerCase() === '%_prog%' ? !programs.length || !programs.every(isNode) : !isNode(executable)) continue;
    // Preserve literal Node options (including quoted values). Expansion or
    // shell syntax in the option list must still be evaluated by the wrapper.
    if (/[%!^&|<>\r\n]/.test(match[3])) continue;
    const args = (match[3].match(/"[^"]*"|[^\s"]+/g) || []).map(arg => arg.startsWith('"') ? arg.slice(1, -1) : arg);
    const entry = match[4].replace(/%(?:dp0%|~dp0)/gi, path.dirname(file) + path.sep);
    if (entry.includes('%') || !path.isAbsolute(entry)) continue;
    const script = path.resolve(path.dirname(file), entry);
    try { if (script !== file && fs.statSync(script).isFile()) { calls.push({ script, args }); lines[index] = 'node'; } } catch { /* shell reports missing entries */ }
  }
  const first = calls[0];
  if (first && calls.every(call => call.script === first.script && JSON.stringify(call.args) === JSON.stringify(first.args)) && onlyNodeShim(lines, calls.length)) return first;
  return null;
}
// Windows cannot start .bat and .cmd files without a shell, and cmd.exe parses
// the command line before the script does. Every argument is quoted for the
// shell. npm shims expand %* through another parse, requiring a second layer
// of escaping when the wrapper cannot be bypassed. Other executables run directly.
function shellOut(command, args, env) {
  const resolved = findExecutable(command, env)
    ?? ((command.includes('/') || command.includes('\\')) ? path.resolve(command) : null);
  const file = resolved || command;
  if (!WINDOWS || !/\.(bat|cmd)$/i.test(file)) return { file, args, options: {} };
  let content = '';
  try { content = fs.readFileSync(file, 'utf8'); } catch { /* the shell reports unreadable wrappers */ }
  const shim = shimScript(file, content);
  if (shim) return { file: process.execPath, args: [...shim.args, shim.script, ...args], options: {} };
  if (args.some(arg => /[\r\n]/.test(arg))) throw new Error('This Windows batch launcher cannot accept multiline arguments. Use its executable or a standard npm launcher.');
  // npm and custom wrappers that forward %* parse their arguments again. Keep
  // wrapper setup intact and protect JSON/paths through that second parse.
  const forwardsArguments = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file)
    || /endlocal\s*&\s*goto\s+#_undefined_#\s+2>NUL\s*\|\|\s*title\s+%COMSPEC%\s*&/i.test(content)
    || content.split(/\r?\n/).some(line => !/^\s*@?rem\b/i.test(line) && /%\*/.test(line));
  const line = [escapeCommand(file), ...args.map(arg => escapeArgument(arg, forwardsArguments))].join(' ');
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
