// Deliberately uses only Node built-ins: diagnostics must work before npm setup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const help = `Usage: papilot doctor [--repo <folder>] [--json] [--data <folder>] [--port <number>]

  --repo <folder>  Also check a LaTeX Git repository and its root document
  --json           Print one JSON report, suitable for scripts
  --data <folder>  Check this data folder (default: PAPILOT_DATA or ~/.papilot)
  --port <number>  Check this local server port (default: PAPILOT_PORT or 7274)
  --help           Show this help

Checks the current environment and, on macOS, installed service tool paths.
Does not install software, start Papilot, compile papers or send model prompts.
Exit codes: 0 = no blocking errors (warnings may remain), 1 = blocking errors,
2 = invalid command-line options. Agent configuration is not a live API test.`;

const expand = value => path.resolve(value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value);
const supportedNode = version => { const [major, minor] = version.split('.').map(Number); return major > 22 || (major === 22 && minor >= 22); };
const atLeast = (version, minimum) => {
  const a = version.split('.').map(Number), b = minimum.split('.').map(Number);
  return (a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) >= 0;
};
function executable(command, env = process.env) {
  const candidates = command.includes('/') || command.includes('\\') ? [path.resolve(command)]
    : (env.PATH || '').split(path.delimiter).map(dir => path.resolve(dir || '.', command));
  return candidates.find(file => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
  });
}
// Agent CLIs are also looked for where they install themselves, as the server does.
function agentExecutable(command) {
  if (command.includes('/') || command.includes('\\')) return executable(command);
  const home = process.env.HOME || os.homedir();
  const dirs = ['.local/bin', '.claude/local', '.kimi-code/bin', '.grok/bin', '.opencode/bin', '.bun/bin', '.npm-global/bin'].map(dir => path.join(home, dir)).concat('/opt/homebrew/bin', '/usr/local/bin');
  return executable(command) || executable(command, { PATH: dirs.join(path.delimiter) });
}
function command(file, args, options = {}) {
  return new Promise(resolve => {
    // Never return raw stderr: login commands can print credentials or account data.
    const child = execFile(file, args, { cwd: os.homedir(), timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024, ...options }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout, stderr, reason: error?.killed ? 'timed out' : error ? `failed (${error.code || 'unknown error'})` : '' });
    });
    child.stdin?.end();
  });
}
function writableDirectory(target) {
  let existing = target;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  try {
    if (!fs.statSync(existing).isDirectory()) return false;
    fs.accessSync(existing, fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch { return false; }
}
function installedModule(name, directory = root) {
  try { return createRequire(path.join(directory, 'package.json')).resolve(name); } catch { return null; }
}

export async function doctor(args) {
  if (args.includes('--help') || args.includes('-h')) { console.log(help); return 0; }
  const json = args.includes('--json');
  let data = expand(process.env.PAPILOT_DATA || path.join(os.homedir(), '.papilot'));
  let port = Number(process.env.PAPILOT_PORT || 7274), repo = null;
  try {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--json') continue;
      if (!['--data', '--port', '--repo'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value.`);
      if (arg === '--data') data = expand(value);
      if (arg === '--repo') repo = expand(value);
      if (arg === '--port') port = Number(value);
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port or PAPILOT_PORT must be an integer from 1 to 65535.');
  } catch (error) {
    if (json) console.log(JSON.stringify({ name: 'Papilot', version: pkg.version, ok: false, checks: [], error: error.message }));
    else console.error(`${error.message}\n\n${help}`);
    return 2;
  }
  const checks = [];
  // Redact known secret values even when they appear in a path or configuration error.
  const secrets = Object.entries(process.env).filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key) && value?.length >= 4).map(([, value]) => value);
  const clean = value => secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), String(value))
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  const check = (id, ok, severity, detail, fix = null) => checks.push({ id, ok: Boolean(ok), severity, detail: clean(detail), fix: ok || !fix ? null : clean(fix) });
  const engine = expand(process.env.PAPILOT_REVIEW_ENGINE || path.join(root, 'vendor/latex-review'));
  const sourceCheckout = fs.existsSync(path.join(root, '.git'));
  const repair = sourceCheckout ? 'Run npm ci in the Papilot checkout.' : 'Reinstall Papilot with npm install -g papilot.';

  check('node', supportedNode(process.versions.node), 'error', `Node.js ${process.versions.node} (${process.execPath})`, 'Install Node.js 22.22 or newer, then run papilot doctor again.');
  const missing = Object.keys(pkg.dependencies).filter(name => !installedModule(name));
  check('dependencies', !missing.length, 'error', missing.length ? `Missing packages: ${missing.join(', ')}.` : 'Runtime packages are installed.', repair);
  const frontend = fs.existsSync(path.join(root, 'dist/index.html'));
  check('frontend', frontend, 'error', frontend ? 'Papilot frontend build is present.' : 'Papilot frontend build is missing: dist/index.html.', sourceCheckout ? 'Run npm run build.' : repair);
  const missingEngine = ['src/client.ts', 'src/core/config.ts', 'dist/web/index.html'].filter(file => !fs.existsSync(path.join(engine, file)));
  check('review-engine', !missingEngine.length, 'error', `Review engine: ${engine}${missingEngine.length ? `; missing ${missingEngine.join(', ')}` : ''}`, process.env.PAPILOT_REVIEW_ENGINE ? 'Check PAPILOT_REVIEW_ENGINE and build that review engine.' : sourceCheckout ? 'Run npm run setup:review.' : repair);
  check('data', writableDirectory(data), 'error', `Data folder: ${data}${fs.existsSync(data) ? '' : ' (will be created on startup)'}`, 'Choose a writable directory with --data <folder>.');

  async function tool(name, args, fix, id = name, env = process.env, severity = 'error') {
    const file = executable(name, env);
    if (!file) { check(id, false, severity, `${name} was not found on PATH.`, fix); return null; }
    const result = await command(file, args, { env });
    check(id, result.ok, severity, `${file}${result.ok ? '' : `: ${result.reason}`}`, fix);
    return result.ok ? file : null;
  }
  const [git] = await Promise.all([
    tool('git', ['--version'], 'Install Git and open a new terminal.'),
    tool('latexmk', ['-v'], 'Install a full TeX distribution (MacTeX or TeX Live), and add its binaries to PATH.'),
    tool('synctex', ['--version'], 'Install SyncTeX from your TeX distribution and add its binaries to PATH.'),
  ]);
  const texEngines = await Promise.all(['pdflatex', 'xelatex', 'lualatex'].map(async name => {
    const file = executable(name);
    return file && (await command(file, ['--version'])).ok ? name : null;
  }));
  const availableEngines = texEngines.filter(Boolean);
  check('tex-engines', availableEngines.length > 0, 'error', availableEngines.length ? `TeX engines: ${availableEngines.join(', ')}.` : 'No working pdflatex, xelatex or lualatex was found.', 'Install a full TeX distribution and add its binaries to PATH.');

  async function codexCheck() {
    const minimum = pkg.devDependencies['@openai/codex'];
    const configured = process.env.PAPILOT_CODEX_BIN;
    const candidates = configured ? [configured] : ['codex', path.join(data, 'agents/node_modules/.bin/codex')];
    let found = false;
    for (const candidate of candidates) {
      const file = executable(candidate);
      if (!file) continue;
      found = true;
      const result = await command(file, ['--version']);
      const version = result.stdout.match(/\d+\.\d+\.\d+/)?.[0];
      if (!result.ok || !version || !atLeast(version, minimum)) {
        if (!configured) continue;
        check('agent.codex', false, 'warn', `Configured Codex ${result.ok ? 'is older than the supported version or its version is unknown' : result.reason}.`, `Set PAPILOT_CODEX_BIN to Codex ${minimum} or newer.`);
        return false;
      }
      const login = await command(file, ['login', 'status']);
      const ready = login.ok && /^\s*logged in\b/im.test(login.stdout + '\n' + login.stderr);
      check('agent.codex', ready, 'warn', `Codex ${version} (${file}): ${ready ? 'signed in' : login.reason || 'login could not be confirmed'}.`, 'Run papilot codex login, then rerun doctor.');
      return ready;
    }
    check('agent.codex', false, 'warn', configured ? 'PAPILOT_CODEX_BIN does not point to an executable.' : found ? `No installed Codex meets version ${minimum}.` : 'Codex is not installed.', configured ? 'Correct PAPILOT_CODEX_BIN or unset it to use automatic installation.' : 'Run papilot codex login; it installs the supported Codex when needed.');
    return false;
  }
  async function claudeCheck() {
    // With Claude Code installed, Claude runs claude -p on its own login; only the login state is read.
    const cli = agentExecutable(process.env.PAPILOT_CLAUDE_BIN || 'claude');
    if (cli) {
      const result = await command(cli, ['auth', 'status', '--json']);
      let login = null;
      try { login = JSON.parse(result.stdout); } catch { /* Reported below. */ }
      const ready = Boolean(login?.loggedIn);
      check('agent.claude', ready, 'warn', `${cli}: ${ready ? `Claude Code signed in${login.subscriptionType ? ` (${login.subscriptionType} plan)` : ''}; generation was not tested` : login ? 'Claude Code is not signed in' : result.reason || 'login status unavailable'}.`, 'Run claude auth login, then select Reconnect in Papilot. Set PAPILOT_CLAUDE_BIN if needed.');
      return ready;
    }
    const sdk = installedModule('@anthropic-ai/claude-agent-sdk') || installedModule('@anthropic-ai/claude-agent-sdk', path.join(data, 'agents'));
    const configured = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some(key => Boolean(process.env[key]));
    check('agent.claude', Boolean(sdk && configured), configured ? 'warn' : 'info', !configured ? 'Claude Code is not installed and no Claude API key is configured, so Papilot does not offer Claude.' : sdk ? 'Claude SDK installed; API credentials configured (not validated).' : 'Claude API credentials configured; the Agent SDK is not installed yet.', !configured ? 'Install Claude Code and sign in with claude auth login to use your Claude plan, or start Papilot with ANTHROPIC_API_KEY or a supported cloud provider configured.' : 'Start papilot once to install the Claude Agent SDK.');
    return Boolean(sdk && configured);
  }
  async function agyCheck() {
    const file = agentExecutable(process.env.PAPILOT_AGY_BIN || 'agy');
    if (!file) { check('agent.antigravity', false, 'info', missingAgent('agy', 'PAPILOT_AGY_BIN'), 'Install Antigravity and sign in to agy on this host. If already installed, correct PAPILOT_AGY_BIN or the server PATH, then restart Papilot.'); return false; }
    const proxy = process.env.PAPILOT_AGY_PROXY;
    const env = proxy ? { ...process.env, HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: '127.0.0.1,localhost' } : process.env;
    const result = await command(file, ['models'], { env });
    const ready = result.ok && result.stdout.split('\n').some(line => /^\S+\t\S/.test(line));
    check('agent.antigravity', ready, 'warn', `${file}: ${ready ? 'model listing succeeded (no generation tested)' : result.reason || 'no models returned'}.`, 'Sign in to agy and try agy models. If your region requires a proxy, set PAPILOT_AGY_PROXY.');
    return ready;
  }
  // ACP agents: the CLI must offer its ACP mode. Login is not checked, so no credential is read.
  function missingAgent(command, variable) {
    return process.env[variable] ? `${variable} does not resolve to a runnable executable in Papilot's environment.`
      : `${command} was not found on the PATH or in the standard agent folders available to Papilot. It may be installed for a different user or shell.`;
  }
  async function acpCheck(id, name, bin, help, install, update, supported = /\bACP\b|Agent Client Protocol/i) {
    const file = agentExecutable(process.env[bin.env] || bin.name);
    if (!file) { check(`agent.${id}`, false, 'info', missingAgent(bin.name, bin.env), `${install}. If already installed, correct ${bin.env} or the server PATH, then restart Papilot.`); return false; }
    const result = await command(file, help);
    const ready = result.ok && supported.test(result.stdout + '\n' + result.stderr);
    check(`agent.${id}`, ready, 'warn', `${file}: ${ready ? 'ACP command available; login and generation were not tested' : result.reason || 'ACP command unavailable'}.`, `${update} Set ${bin.env} if needed.`);
    return ready;
  }
  const kimiCheck = () => acpCheck('kimi', 'Kimi CLI', { env: 'PAPILOT_KIMI_BIN', name: 'kimi' }, ['acp', '--help'], 'Install Kimi Code CLI and run kimi login', 'Update Kimi Code CLI and run kimi login.');
  const copilotCheck = () => acpCheck('copilot', 'GitHub Copilot CLI', { env: 'PAPILOT_COPILOT_BIN', name: 'copilot' }, ['--help'], 'Install GitHub Copilot CLI with npm install -g @github/copilot and run copilot login', 'Update GitHub Copilot CLI and run copilot login.');
  const grokCheck = () => acpCheck('grok', 'Grok Build CLI', { env: 'PAPILOT_GROK_BIN', name: 'grok' }, ['--no-auto-update', 'agent', '--no-leader', 'stdio', '--help'], 'Install Grok Build CLI from https://x.ai/cli and run grok login or configure XAI_API_KEY', 'Update Grok Build CLI and run grok login or configure XAI_API_KEY.', /Usage:\s+grok agent stdio\b/i);
  const qwenCheck = () => acpCheck('qwen', 'Qwen Code', { env: 'PAPILOT_QWEN_BIN', name: 'qwen' }, ['--help'], 'Install Qwen Code and sign in by running qwen once', 'Update Qwen Code and sign in by running qwen once.');
  const deepseekCheck = () => acpCheck('deepseek', 'DeepSeek Harness (dsh)', { env: 'PAPILOT_DSH_BIN', name: 'dsh' }, ['acp', '--help'], 'Install DeepSeek Harness with npm install -g @deepseek-ai/dsh and set up a model in dsh', 'Update DeepSeek Harness and set up a model in dsh.');
  const opencodeCheck = () => acpCheck('opencode', 'OpenCode', { env: 'PAPILOT_OPENCODE_BIN', name: 'opencode' }, ['acp', '--help'], 'Install OpenCode and connect a provider with opencode auth login', 'Update OpenCode and connect a provider with opencode auth login.');
  // SDK agents: a key in the environment (or the SDK's own login) selects them; keys are not validated.
  async function cursorCheck() {
    const configured = Boolean(process.env.CURSOR_API_KEY) || fs.existsSync(path.join(os.homedir(), '.cursor/sdk/auth.json'));
    const sdk = installedModule('@cursor/sdk') || installedModule('@cursor/sdk', path.join(data, 'agents'));
    check('agent.cursor', Boolean(configured && sdk), configured ? 'warn' : 'info', !configured ? 'Neither CURSOR_API_KEY nor a saved Cursor SDK login was found for the user running Papilot.' : sdk ? 'Cursor SDK installed; SDK credentials detected (not validated).' : 'Cursor SDK credentials detected; the SDK is installed on first use.', !configured ? 'Start Papilot with CURSOR_API_KEY set to a key from the Cursor dashboard, or configure the Cursor SDK login. The Cursor app and CLI login are not used. Restart Papilot after changing its environment.' : 'Start papilot and choose Cursor once to install the SDK.');
    return configured;
  }
  async function glmCheck() {
    const configured = Boolean(process.env.ZHIPU_API_KEY || process.env.ZAI_API_KEY);
    const sdk = installedModule('@anthropic-ai/claude-agent-sdk') || installedModule('@anthropic-ai/claude-agent-sdk', path.join(data, 'agents'));
    check('agent.glm', Boolean(configured && sdk), configured ? 'warn' : 'info', !configured ? 'ZHIPU_API_KEY or ZAI_API_KEY is not set, so Papilot does not offer GLM.' : sdk ? `GLM key configured for ${process.env.ZHIPU_API_KEY ? 'open.bigmodel.cn' : 'api.z.ai'} (not validated).` : 'GLM key configured; the Claude Agent SDK that runs GLM is installed on first use.', !configured ? 'Start Papilot with ZHIPU_API_KEY (open.bigmodel.cn) or ZAI_API_KEY (api.z.ai) set to your GLM Coding Plan or API key.' : 'Start papilot and choose GLM once to install the Claude Agent SDK.');
    return configured;
  }
  const agents = await Promise.all([codexCheck(), claudeCheck(), cursorCheck(), copilotCheck(), grokCheck(), agyCheck(), kimiCheck(), glmCheck(), deepseekCheck(), qwenCheck(), opencodeCheck()]);
  check('agents', agents.some(Boolean), 'warn', agents.some(Boolean) ? 'At least one agent passed its configuration check; live editing was not tested.' : 'No agent passed its configuration check. PDF reading can still be used with a working TeX installation.', 'Configure one agent before starting editing tasks.');

  if (repo) {
    if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) check('project', false, 'error', `Paper folder does not exist: ${repo}`, 'Pass the Git repository root with --repo <folder>.');
    else if (git) {
      const top = await command(git, ['-C', repo, 'rev-parse', '--show-toplevel']);
      let atRoot = false;
      try { atRoot = top.ok && fs.realpathSync(top.stdout.trim()) === fs.realpathSync(repo); } catch { /* Missing repository. */ }
      check('project.git', atRoot, 'error', atRoot ? `Git repository: ${repo}` : 'The paper folder is not a Git repository root.', 'Pass the repository root; initialize Git first if the paper is not yet versioned.');
      if (atRoot) {
        const head = await command(git, ['-C', repo, 'rev-parse', '--verify', 'HEAD']);
        check('project.head', head.ok, 'error', head.ok ? 'The repository has an initial commit.' : 'The repository has no initial commit.', 'Create the first Git commit before adding this paper to Papilot.');
        try {
          const { register } = await import('tsx/esm/api');
          const unregister = register();
          let project;
          try { project = (await import(pathToFileURL(path.join(engine, 'src/core/config.ts')).href)).loadProject(repo); }
          finally { unregister(); }
          check('project.main', true, 'error', `${project.main} (${project.engine}); configuration loaded without compiling.`);
          await tool(project.engine, ['--version'], `Install ${project.engine} through your TeX distribution.`, 'project.engine');
          check('project.worktrees', writableDirectory(project.worktrees), 'error', `Task worktrees: ${project.worktrees}`, 'Choose a writable worktrees directory outside the repository in .latex-review.json.');
        } catch (error) {
          check('project.main', false, 'error', `Could not load the paper configuration: ${error.message}`, 'Check .latex-review.json, its main/source_dir settings, and the review-engine/dependencies checks above.');
        }
      }
    }
  } else check('project', true, 'info', 'No paper selected. Use --repo <folder> to check its Git history, main document and TeX engine.');

  const origin = process.env.PAPILOT_PUBLIC_ORIGIN || '', owner = process.env.PAPILOT_TAILSCALE_LOGIN || '';
  let remoteValid = !origin && !owner;
  if (origin && owner) {
    try { const url = new URL(origin); remoteValid = ['http:', 'https:'].includes(url.protocol) && url.origin === origin && !url.username && !url.password; } catch { /* Invalid origin. */ }
  }
  check('remote', remoteValid, 'error', origin || owner ? 'Tailscale origin and owner configuration.' : 'Local access only; remote access is optional.', 'Set both PAPILOT_PUBLIC_ORIGIN (scheme and host, optional port, no path) and PAPILOT_TAILSCALE_LOGIN, or unset both for local access.');
  // The collaborators' sign-in address: its own HTTPS origin and local port, apart from the tailnet endpoint.
  const accountOrigin = (process.env.PAPILOT_ACCOUNT_ORIGIN || '').replace(/\/+$/, ''), accountPort = Number(process.env.PAPILOT_ACCOUNT_PORT || 7275);
  let accountValid = !accountOrigin;
  if (accountOrigin) {
    try {
      const url = new URL(accountOrigin);
      accountValid = url.origin === accountOrigin && (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost'))
        && Number.isInteger(accountPort) && accountPort > 0 && accountPort < 65536 && accountPort !== port && !(origin && URL.canParse(origin) && new URL(origin).host === url.host);
    } catch { /* Invalid origin. */ }
  }
  check('accounts', accountValid, 'error', accountOrigin ? `Collaborators sign in at ${accountOrigin}, forwarded to 127.0.0.1:${accountPort}.` : 'No public sign-in for collaborators; it is optional.', 'Set PAPILOT_ACCOUNT_ORIGIN to an https:// origin without a path that differs from PAPILOT_PUBLIC_ORIGIN (for Funnel, port 10000), and PAPILOT_ACCOUNT_PORT to a free port other than the Papilot port. Papilot does not start otherwise.');
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    const health = await response.json();
    const ok = response.ok && health?.ok === true && health?.name === 'Papilot';
    check('server', ok, 'warn', ok ? `Papilot is responding on port ${port}.` : `Port ${port} is not serving a healthy Papilot instance.`, 'Check the running service or choose another --port.');
  } catch (error) {
    const offline = error.cause?.code === 'ECONNREFUSED';
    check('server', offline, offline ? 'info' : 'warn', offline ? `Papilot is not running on port ${port}; this is fine before startup.` : `Could not verify Papilot on port ${port}.`, 'Check the running service or choose another --port.');
  }

  if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library/LaunchAgents/local.papilot.plist');
    if (!fs.existsSync(plist)) check('service', true, 'info', 'macOS background service is not installed (optional).');
    else {
      const result = await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]);
      try {
        if (!result.ok) throw new Error('Unreadable service configuration.');
        const settings = JSON.parse(result.stdout), env = settings.EnvironmentVariables || {};
        const tools = ['git', 'latexmk', 'synctex', ...availableEngines];
        const missing = tools.filter(name => !executable(name, env));
        const different = tools.filter(name => executable(name, env) !== executable(name));
        const node = settings.ProgramArguments?.[2];
        const validNode = typeof node === 'string' && executable(node, env);
        check('service.tools', !missing.length && !different.length && validNode, 'warn', !validNode ? 'The service Node executable is missing.' : missing.length ? `The saved service PATH is missing: ${missing.join(', ')}.` : different.length ? `Service and terminal resolve different tools: ${different.join(', ')}.` : 'The saved service paths match the terminal tools.', 'Reinstall with papilot service install from the intended environment; use PAPILOT_SERVICE_PATH for your TeX/Python directory.');
        const serviceData = expand(env.PAPILOT_DATA || path.join(settings.WorkingDirectory || root, '.papilot'));
        check('service.data', serviceData === data, 'warn', serviceData === data ? 'The service data folder matches this diagnostic target.' : `The service uses a different data folder: ${serviceData}`, 'Run doctor with the service data folder (--data), or reinstall the service with the intended PAPILOT_DATA.');
      } catch { check('service', false, 'warn', 'The installed service configuration could not be read.', 'Run papilot service install to recreate the service configuration.'); }
    }
  }
  // Keep reports stable even though independent probes finish in any order.
  const order = ['node', 'dependencies', 'frontend', 'review-engine', 'data', 'git', 'latexmk', 'synctex', 'tex-engines', 'agent.codex', 'agent.claude', 'agent.cursor', 'agent.copilot', 'agent.grok', 'agent.antigravity', 'agent.kimi', 'agent.glm', 'agent.deepseek', 'agent.qwen', 'agent.opencode', 'agents', 'project', 'project.git', 'project.head', 'project.main', 'project.engine', 'project.worktrees', 'remote', 'server', 'service', 'service.tools', 'service.data'];
  checks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const report = { name: 'Papilot', version: pkg.version, ok: !checks.some(item => !item.ok && item.severity === 'error'), checks };
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Papilot ${pkg.version} doctor\n`);
    for (const item of checks) {
      console.log(`${item.ok ? '✓' : item.severity === 'error' ? '✗' : item.severity === 'info' ? '-' : '!'} ${item.id}: ${item.detail}`);
      if (item.fix) console.log(`  Fix: ${item.fix}`);
    }
    const errors = checks.filter(item => !item.ok && item.severity === 'error').length;
    const warnings = checks.filter(item => !item.ok && item.severity === 'warn').length;
    console.log(`\n${errors} blocking error(s), ${warnings} warning(s).${report.ok ? ' Environment checks passed.' : ' Fix blocking errors and run doctor again.'}`);
  }
  return report.ok ? 0 : 1;
}
