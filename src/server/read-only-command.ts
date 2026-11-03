import path from 'node:path';

// Agents without a sandbox (OpenCode, Kimi, Qwen…) ask before every shell
// command. Papilot answers for a command that can only read files in the task
// folder and print them, as Codex's and Claude's sandboxes let those run. The
// check is narrow on purpose: other programs, substitutions, variables,
// redirection to a file, paths outside the folder and sed scripts other than
// printing line ranges are still asked.

interface Word { value: string; quoted: boolean; glob: boolean; home: boolean }
const PLAIN = new Set(['cat', 'head', 'tail', 'wc', 'nl', 'ls', 'pwd', 'echo', 'printf', 'basename', 'dirname', 'realpath', 'cut', 'tr', 'diff', 'cmp', 'comm', 'grep', 'egrep', 'fgrep']);
const GIT = new Set(['status', 'diff', 'log', 'show', 'blame', 'ls-files', 'rev-parse', 'grep', 'shortlog', 'describe']);
const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls']);
const SED_RANGE = '(?:\\d+|\\$)(?:,(?:\\d+|\\$))?p';
const SED_PRINT = new RegExp(`^${SED_RANGE}(?:;${SED_RANGE})*;?$`);
// Discarding output or merging two streams: 2>/dev/null, >/dev/null, 2>&1.
const DISCARD = /^(?:&\d|[ \t]*\/dev\/null)(?=$|[ \t\n;|&])/;

// The simple commands of a command line, or null when it uses anything this
// parser does not model.
function parse(line: string): Word[][] | null {
  const commands: Word[][] = [];
  // Typed by a cast: the helpers below assign word, which TypeScript does not track.
  let words: Word[] = [], word = null as Word | null, quote: string | null = null;
  const current = () => (word ??= { value: '', quoted: false, glob: false, home: false });
  const end = () => { if (word) words.push(word); word = null; };
  const next = () => { end(); const found = words.length > 0; if (found) commands.push(words); words = []; return found; };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") { if (c === "'") quote = null; else current().value += c; continue; }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '$' || c === '`') return null;
      else if (c === '\\' && '$`"\\\n'.includes(line[i + 1] ?? '')) current().value += line[++i];
      else current().value += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; current().quoted = true; continue; }
    if (c === '\\') { if (i + 1 >= line.length) return null; if (line[++i] !== '\n') { current().value += line[i]; current().quoted = true; } continue; }
    if (c === ' ' || c === '\t') { end(); continue; }
    if (c === ';' || c === '\n') { next(); continue; }
    if (c === '|' || c === '&') {
      if (c === '&' && line[i + 1] !== '&') return null;
      if (line[i + 1] === c) i++;
      if (!next()) return null;
      continue;
    }
    if (c === '>') {
      // A file descriptor may come right before it, as in 2>/dev/null.
      if (word) { if (word.quoted || !/^\d$/.test(word.value)) return null; word = null; }
      const discard = DISCARD.exec(line.slice(i + 1));
      if (!discard) return null;
      i += discard[0].length;
      continue;
    }
    if ('<$`(){}'.includes(c)) return null;
    if ('*?['.includes(c)) current().glob = true;
    if (c === '~') current().home = true;
    current().value += c;
  }
  if (quote) return null;
  next();
  return commands.length ? commands : null;
}

const within = (root: string, file: string) => file === root || file.startsWith(root + path.sep);
// Whether an argument names nothing outside the task folder.
function stays(root: string, base: string, word: Word) {
  let value = word.value;
  if (value.startsWith('-')) {
    const equals = value.indexOf('=');
    if (equals < 0) return !value.includes('/');
    value = value.slice(equals + 1);
  }
  if (word.home) return false;
  // A pattern starting a name with "." can match "..".
  if (word.glob && value.split('/').some(part => part.startsWith('.') && /[*?[]/.test(part))) return false;
  return (!value.includes('/') && value !== '..') || within(root, path.resolve(base, value));
}

function sedPrints(args: string[]) {
  let quiet = false, script: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-n' || arg === '--quiet' || arg === '--silent') quiet = true;
    else if (arg === '-e' && script === null && i + 1 < args.length) script = args[++i];
    else if (arg.startsWith('-')) return false;
    else if (script === null) script = arg;
  }
  return quiet && script !== null && SED_PRINT.test(script);
}

function gitReads(args: string[]) {
  let i = 0;
  while (args[i] === '--no-pager' || args[i] === '-P') i++;
  const command = args[i];
  return GIT.has(command) && !args.slice(i + 1).some(arg => /^--(output|ext-diff|open-files-in-pager)/.test(arg) || (command === 'grep' && /^-[^-]*O/.test(arg)));
}

function reads([name, ...args]: string[]) {
  if (PLAIN.has(name)) return true;
  if (name === 'sed') return sedPrints(args);
  if (name === 'git') return gitReads(args);
  if (name === 'rg') return !args.some(arg => arg.startsWith('--pre') || arg === '--search-zip' || /^-[^-]*z/.test(arg));
  if (name === 'find') return !args.some(arg => FIND_ACTIONS.has(arg));
  if (name === 'sort') return !args.some(arg => /^--(output|compress-program|temporary-directory)/.test(arg) || /^-[^-]*[oT]/.test(arg));
  if (name === 'uniq') return args.every(arg => arg.startsWith('-'));
  return false;
}

// Whether a shell command line only reads files inside root and prints them.
// base is the folder the command runs in.
export function readsOnly(line: string, root: string, base = root) {
  if (process.platform === 'win32' || !within(root, base)) return false;
  const commands = parse(line);
  return Boolean(commands?.every(words => reads(words.map(word => word.value)) && words.slice(1).every(word => stays(root, base, word))));
}
