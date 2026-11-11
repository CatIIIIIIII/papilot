import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { findExecutable } from '../bin/agent-paths.mjs';

const root = path.resolve(import.meta.dirname, '..');
interface Check { id: string; ok: boolean; severity: string; detail: string; fix: string | null }
interface Report { ok: boolean; checks: Check[]; error?: string }
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-doctor-'));
  const app = path.join(dir, 'app'), tools = path.join(dir, 'tools'), data = path.join(dir, 'data'), home = path.join(dir, 'home');
  for (const folder of [app, tools, home, path.join(app, 'dist'), path.join(app, 'engine/dist/web')]) fs.mkdirSync(folder, { recursive: true });
  fs.cpSync(path.join(root, 'bin'), path.join(app, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(app, 'package.json'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(app, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(path.join(root, 'engine/src'), path.join(app, 'engine/src'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(app, 'dist/index.html'), '<html></html>');
  fs.writeFileSync(path.join(app, 'engine/dist/web/index.html'), '<html></html>');
  const log = path.join(dir, 'commands');
  const env: NodeJS.ProcessEnv = { PATH: tools, HOME: home, USERPROFILE: home, TMPDIR: os.tmpdir(), PAPILOT_DATA: data, PAPILOT_PORT: '65534' };
  function tool(name: string, script = 'console.log("test tool 1.0");') {
    const file = path.join(tools, name);
    fs.writeFileSync(file, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([${JSON.stringify(name)}, ...process.argv.slice(2)]) + '\\n');\n${script}\n`, { mode: 0o755 });
    // Node treats extensionless entry points as CJS unless their package is ESM.
    fs.writeFileSync(path.join(tools, 'package.json'), '{"type":"module"}');
    // Windows cannot start an extensionless script, so a .cmd shim runs Node
    // on it. Papilot spawns .cmd files through a shell.
    if (process.platform === 'win32') {
      const shim = path.join(tools, `${name}.cmd`);
      fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${file}" %*\r\n`);
      return shim;
    }
    return file;
  }
  function baseTools() { for (const name of ['git', 'latexmk', 'synctex', 'pdflatex']) tool(name); }
  async function run(args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}, timeout = 15000) {
    return new Promise<{ code: number; stdout: string; stderr: string; report: Report }>(resolve => {
      execFile(process.execPath, [path.join(app, 'bin/papilot.mjs'), 'doctor', ...args], { env: { ...env, ...extraEnv }, cwd: dir, timeout }, (error, stdout, stderr) => {
        let report: Report = { ok: false, checks: [] };
        try { report = JSON.parse(stdout); } catch { /* Human output. */ }
        resolve({ code: error ? Number((error as any).code) || 1 : 0, stdout, stderr, report });
      });
    });
  }
  return { dir, app, tools, data, env, log, tool, baseTools, run, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const item = (report: Report, id: string) => {
  const value = report.checks.find(check => check.id === id);
  assert.ok(value, `Missing check ${id}`); return value;
};

test('doctor help and invalid options never run tools or create data', async () => {
  const f = fixture();
  try {
    const help = await f.run(['--help']);
    assert.equal(help.code, 0); assert.match(help.stdout, /--repo/);
    for (const args of [['--json', '--repo'], ['--json', '--port', '0'], ['--json', '--unknown']]) {
      const result = await f.run(args);
      assert.equal(result.code, 2); assert.equal(result.report.ok, false); assert.ok(result.report.error);
    }
    assert.equal(fs.existsSync(f.log), false); assert.equal(fs.existsSync(f.data), false);
  } finally { f.cleanup(); }
});

test('doctor reports missing tools and actionable fixes without installing or starting anything', async () => {
  const f = fixture();
  try {
    f.tool('npm', 'process.exit(99);');
    const result = await f.run(['--json']);
    assert.equal(result.code, 1); assert.equal(result.report.ok, false);
    for (const name of ['git', 'latexmk', 'synctex']) {
      // A tool installed in a standard location off PATH is still found, so
      // only require a fix for tools Papilot cannot see at all.
      if (findExecutable(name, { ...process.env, PATH: f.env.PATH })) continue;
      assert.equal(item(result.report, name).ok, false); assert.ok(item(result.report, name).fix);
    }
    assert.equal(item(result.report, 'agents').severity, 'warn');
    assert.equal(fs.existsSync(f.log), false); assert.equal(fs.existsSync(f.data), false);
    assert.equal(fs.existsSync(path.join(f.dir, '.papilot')), false);
  } finally { f.cleanup(); }
});

test('optional agents do not block reading, and human output includes fixes and a summary', async () => {
  const f = fixture();
  try {
    f.baseTools();
    const result = await f.run(['--json']);
    assert.equal(result.code, 0, result.stdout); assert.equal(result.report.ok, true);
    assert.equal(item(result.report, 'agents').ok, false);
    const human = await f.run();
    assert.match(human.stdout, /Papilot .* doctor/); assert.match(human.stdout, /Fix: /); assert.match(human.stdout, /0 blocking error/);
    assert.equal(fs.existsSync(f.data), false);
  } finally { f.cleanup(); }
});

test('doctor still produces JSON when packages and build files are missing', async () => {
  const f = fixture();
  try {
    f.baseTools();
    fs.unlinkSync(path.join(f.app, 'node_modules'));
    fs.rmSync(path.join(f.app, 'dist'), { recursive: true });
    fs.rmSync(path.join(f.app, 'engine/dist'), { recursive: true });
    fs.writeFileSync(f.data, 'a file, not a directory');
    const result = await f.run(['--json']);
    assert.equal(result.code, 1);
    for (const id of ['dependencies', 'frontend', 'review-engine', 'data']) {
      assert.equal(item(result.report, id).ok, false); assert.ok(item(result.report, id).fix);
    }
    assert.equal(fs.readFileSync(f.data, 'utf8'), 'a file, not a directory');
  } finally { f.cleanup(); }
});

test('doctor compares installed macOS service paths and honors the selected data directory', { skip: process.platform !== 'darwin' }, async () => {
  const f = fixture();
  try {
    f.baseTools();
    const plist = path.join(f.env.HOME!, 'Library/LaunchAgents/local.papilot.plist');
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    const settings = { ProgramArguments: ['/usr/bin/caffeinate', '-i', process.execPath], WorkingDirectory: f.app,
      EnvironmentVariables: { PATH: f.tools, PAPILOT_DATA: f.data } };
    fs.writeFileSync(plist, JSON.stringify(settings));
    const matching = await f.run(['--json']);
    assert.equal(item(matching.report, 'service.tools').ok, true);
    assert.equal(item(matching.report, 'service.data').ok, true);
    settings.EnvironmentVariables.PATH = '/missing-tools';
    fs.writeFileSync(plist, JSON.stringify(settings));
    const otherData = path.join(f.dir, 'other-data');
    const mismatch = await f.run(['--json', '--data', otherData]);
    assert.equal(item(mismatch.report, 'service.tools').ok, false);
    assert.equal(item(mismatch.report, 'service.data').ok, false);
    assert.equal(item(mismatch.report, 'data').ok, true);
    assert.equal(fs.existsSync(otherData), false);
  } finally { f.cleanup(); }
});

test('doctor uses the supported managed Codex and never leaks login output or known secrets', async () => {
  const f = fixture();
  try {
    f.baseTools();
    f.tool('codex', 'console.log("codex-cli 0.1.0");');
    const managed = path.join(f.data, 'agents/node_modules/.bin'); fs.mkdirSync(managed, { recursive: true });
    const file = f.tool('managed-codex', 'if (process.argv.includes("--version")) console.log("codex-cli 0.164.0"); else console.error("Logged in using API key: top-secret-login");');
    if (process.platform === 'win32') fs.copyFileSync(file, path.join(managed, 'codex.cmd'));
    else fs.symlinkSync(file, path.join(managed, 'codex'));
    const result = await f.run(['--json'], { ANTHROPIC_API_KEY: 'secret-anthropic-value' });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(item(result.report, 'agent.codex').ok, true);
    assert.match(item(result.report, 'agent.codex').detail, /managed|agents/);
    assert.doesNotMatch(result.stdout + result.stderr, /top-secret-login|secret-anthropic-value/);
    assert.equal(fs.existsSync(path.join(f.data, 'papilot.sqlite')), false);
    const signedOut = f.tool('signed-out', 'if (process.argv.includes("--version")) console.log("codex-cli 0.164.0"); else { console.error("Not logged in top-secret-login"); process.exitCode = 1; }');
    const unavailable = await f.run(['--json'], { PAPILOT_CODEX_BIN: signedOut });
    assert.equal(item(unavailable.report, 'agent.codex').ok, false);
    assert.match(item(unavailable.report, 'agent.codex').fix!, /papilot codex login/);
    assert.doesNotMatch(unavailable.stdout + unavailable.stderr, /top-secret-login/);
    // The desktop app uses any installed Codex that runs, whatever its version.
    fs.rmSync(managed, { recursive: true, force: true });
    const desktop = item((await f.run(['--json'], { PAPILOT_DESKTOP: '1' })).report, 'agent.codex');
    assert.match(desktop.detail, /^Codex 0\.1\.0 /, 'an older version is not refused');
    assert.match(desktop.fix!, /^Run codex login/);
    assert.doesNotMatch(desktop.fix!, /papilot/);
  } finally { f.cleanup(); }
});

test('desktop doctor searches PATH, the package and data in order with the server probe PATH', async () => {
  const f = fixture();
  try {
    f.baseTools();
    // Keep real discovery, but exclude installations outside this fixture.
    const paths = path.join(f.app, 'bin/agent-paths.mjs');
    fs.renameSync(paths, path.join(f.app, 'bin/agent-paths-real.mjs'));
    fs.writeFileSync(paths, `
      import fs from 'node:fs';
      import * as real from './agent-paths-real.mjs';
      export * from './agent-paths-real.mjs';
      export function findExecutables(...args) { return real.findExecutables(...args).filter(file => fs.realpathSync(file).startsWith(${JSON.stringify(fs.realpathSync(f.dir) + path.sep)})); }
    `);
    fs.unlinkSync(path.join(f.app, 'node_modules'));
    const local = path.join(f.app, 'node_modules/.bin'), managed = path.join(f.data, 'agents/node_modules/.bin');
    const script = (version: string) => `
      if (!process.env.PATH.split(${JSON.stringify(path.delimiter)}).includes(${JSON.stringify(path.join(f.env.HOME!, '.local/bin'))})) process.exit(2);
      if (process.argv.includes('--version')) {
        console.log('codex-cli ${version}');
      } else console.log('Logged in');
    `;
    const install = (dir: string, name: string, version: string) => {
      fs.mkdirSync(dir, { recursive: true });
      const file = f.tool(name, script(version));
      if (process.platform === 'win32') fs.copyFileSync(file, path.join(dir, 'codex.cmd'));
      else fs.symlinkSync(file, path.join(dir, 'codex'));
    };
    f.tool('codex', script('0.1.0'));
    install(local, 'local-codex', '0.2.0'); install(managed, 'data-codex', '0.3.0');
    const check = async (version: string) => {
      const result = item((await f.run(['--json'], { PAPILOT_DESKTOP: '1' })).report, 'agent.codex');
      assert.equal(result.ok, true, result.detail);
      assert.ok(result.detail.startsWith(`Codex ${version} (`), result.detail);
    };
    await check('0.1.0');
    f.tool('codex', 'process.exit(1);');
    await check('0.2.0');
    f.tool('local-codex', 'process.exit(1);');
    await check('0.3.0');
  } finally { f.cleanup(); }
});

test('desktop doctor distinguishes failed probes from candidates not checked before the deadline', async () => {
  const f = fixture();
  try {
    f.baseTools();
    const candidates = ['first-codex', 'second-codex', 'untried-codex'].map(name => f.tool(name, 'process.exit(1);'));
    const paths = path.join(f.app, 'bin/agent-paths.mjs');
    fs.renameSync(paths, path.join(f.app, 'bin/agent-paths-real.mjs'));
    // Advance the probe budget on each failed candidate without a real wait.
    fs.writeFileSync(paths, `
      import * as real from './agent-paths-real.mjs';
      export * from './agent-paths-real.mjs';
      const candidates = ${JSON.stringify(candidates)}, now = Date.now;
      let elapsed = 0;
      Date.now = () => now() + elapsed;
      export function findExecutables() { return candidates; }
      export function spawnCommand(file, args, options) {
        const child = real.spawnCommand(file, args, options);
        if (candidates.includes(file) && args[0] === '--version') child.once('close', () => { elapsed += 10000; });
        return child;
      }
    `);
    const result = await f.run(['--json'], { PAPILOT_DESKTOP: '1' });
    const codex = item(result.report, 'agent.codex');
    assert.equal(codex.ok, false);
    assert.equal(codex.detail, `Codex could not be run (${candidates.slice(0, 2).join(', ')}). Codex candidates not checked in time (${candidates[2]}).`);
    const commands = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(commands.filter(([name]) => name.endsWith('-codex')), [['first-codex', '--version'], ['second-codex', '--version']]);
  } finally { f.cleanup(); }
});

test('desktop doctor gives login only the remaining probe budget, bounded to 3–10 seconds', async () => {
  const f = fixture();
  try {
    f.baseTools();
    const codex = f.tool('codex', 'console.log("codex-cli 0.1.0");');
    const paths = path.join(f.app, 'bin/agent-paths.mjs'), timeoutFile = path.join(f.dir, 'login-timeout');
    fs.renameSync(paths, path.join(f.app, 'bin/agent-paths-real.mjs'));
    // Advance the clock after --version and record login's actual deadline
    // without making each budget boundary cost twenty seconds.
    fs.writeFileSync(paths, `
      import { EventEmitter } from 'node:events';
      import fs from 'node:fs';
      import * as real from './agent-paths-real.mjs';
      export * from './agent-paths-real.mjs';
      const now = Date.now(), timer = globalThis.setTimeout;
      let elapsed = 0, login, loginTimer = false;
      Date.now = () => now + elapsed;
      globalThis.setTimeout = (callback, timeout, ...args) => {
        if (loginTimer) {
          loginTimer = false;
          fs.writeFileSync(${JSON.stringify(timeoutFile)}, String(timeout));
          return timer(callback, 0, ...args);
        }
        return timer(callback, timeout, ...args);
      };
      export function spawnCommand(file, args, options) {
        if (file !== process.env.PAPILOT_CODEX_BIN) return real.spawnCommand(file, args, options);
        if (args[0] === '--version') {
          const child = real.spawnCommand(file, args, options);
          child.once('close', () => { elapsed += Number(process.env.PROBE_ELAPSED); });
          return child;
        }
        login = new EventEmitter(); login.pid = -1; loginTimer = true;
        return login;
      }
      export function killTree(pid, signal) {
        if (pid !== -1) return real.killTree(pid, signal);
        login.emit('close', 1, null);
      }
    `);
    for (const [elapsed, timeout] of [[4000, 10000], [14000, 6000], [19500, 3000]]) {
      const result = await f.run(['--json'], { PAPILOT_DESKTOP: '1', PAPILOT_CODEX_BIN: codex, PROBE_ELAPSED: String(elapsed) });
      const check = item(result.report, 'agent.codex');
      assert.equal(check.ok, false);
      assert.match(check.detail, /timed out/);
      assert.equal(Number(fs.readFileSync(timeoutFile, 'utf8')), timeout, `login budget after ${elapsed} ms of probing`);
    }
  } finally { f.cleanup(); }
});

test('desktop doctor skips a hanging Codex and probes the working candidate only once', { timeout: 50000 }, async () => {
  const f = fixture();
  const pidFile = path.join(f.dir, 'codex.pid');
  try {
    f.baseTools();
    f.tool('codex', `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const secondDir = path.join(f.dir, 'second');
    fs.mkdirSync(secondDir);
    const working = f.tool('working-codex', `
      if (!process.env.PATH.split(${JSON.stringify(path.delimiter)}).includes(${JSON.stringify(path.join(f.env.HOME!, '.local/bin'))})) process.exit(2);
      if (process.argv.includes('--version')) console.log('codex-cli 0.1.0');
      else console.log('Logged in');
    `);
    const second = path.join(secondDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
    if (process.platform === 'win32') fs.copyFileSync(working, second);
    else fs.symlinkSync(working, second);
    const started = Date.now();
    const result = await f.run(['--json'], { PAPILOT_DESKTOP: '1', PATH: [f.tools, secondDir].join(path.delimiter) }, 45000);
    assert.ok(Date.now() - started < 40000, 'a hanging candidate must leave time within the 45 second diagnostics limit');
    assert.equal(result.code, 0, result.stdout);
    const codex = item(result.report, 'agent.codex');
    assert.equal(codex.ok, true, codex.detail);
    const reported = /^Codex 0\.1\.0 \((.+)\): signed in\.$/.exec(codex.detail);
    assert.ok(reported, codex.detail);
    const comparable = (file: string) => process.platform === 'win32' ? file.toLowerCase() : file;
    assert.equal(comparable(reported[1]), comparable(second));
    const commands = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(commands.filter(([name]) => name === 'codex' || name === 'working-codex'), [
      ['codex', '--version'], ['working-codex', '--version'], ['working-codex', 'login', 'status'],
    ]);
    assert.throws(() => process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0), { code: 'ESRCH' }, 'the hanging probe is stopped');
  } finally {
    if (fs.existsSync(pidFile)) { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already stopped */ } }
    f.cleanup();
  }
});

test('doctor checks real repository configuration without changing files or making worktrees', { skip: process.platform === 'win32' && 'uses the POSIX which command and file links' }, async () => {
  const f = fixture();
  try {
    f.baseTools(); f.tool('xelatex');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    fs.rmSync(path.join(f.tools, 'git')); fs.symlinkSync(realGit, path.join(f.tools, 'git'));
    fs.symlinkSync(execFileSync('which', ['which'], { encoding: 'utf8' }).trim(), path.join(f.tools, 'which'));
    const repo = path.join(f.dir, 'paper'); fs.mkdirSync(repo);
    const git = (...args: string[]) => execFileSync(realGit, ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q');
    fs.writeFileSync(path.join(repo, 'main.tex'), '\\documentclass{article}\n\\begin{document}Hello\\end{document}\n');
    fs.mkdirSync(path.join(repo, '.git/papilot'), { recursive: true }); fs.writeFileSync(path.join(repo, '.git/papilot/settings.json'), '{"main":"main.tex","engine":"xelatex"}');
    const noCommit = await f.run(['--json', '--repo', repo]);
    assert.equal(item(noCommit.report, 'project.head').ok, false);
    git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.org', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Initial paper');
    const before = git('status', '--porcelain');
    const result = await f.run(['--json', '--repo', repo]);
    assert.equal(result.code, 0, result.stdout);
    assert.match(item(result.report, 'project.main').detail, /main.tex \(xelatex\)/);
    assert.equal(item(result.report, 'project.engine').ok, true);
    assert.equal(git('status', '--porcelain'), before);
    assert.deepEqual(fs.readdirSync(path.join(repo, '.git/papilot')), ['settings.json']);
    assert.equal(fs.existsSync(repo + '-tasks'), false);
    fs.mkdirSync(path.join(repo, '.git/papilot'), { recursive: true }); fs.writeFileSync(path.join(repo, '.git/papilot/settings.json'), '{"main":"missing.tex"}');
    const invalid = await f.run(['--json', '--repo', repo]);
    assert.equal(invalid.code, 1); assert.equal(item(invalid.report, 'project.main').ok, false);
    assert.match(item(invalid.report, 'project.main').detail, /Root document not found/);
  } finally { f.cleanup(); }
});

test('doctor distinguishes a healthy local server from an occupied port and validates remote settings', async () => {
  const f = fixture();
  let healthy = true;
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(healthy ? { name: 'Papilot', ok: true } : { name: 'Other app' })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    f.baseTools();
    const port = String((server.address() as { port: number }).port);
    const good = await f.run(['--json', '--port', port]);
    assert.equal(item(good.report, 'server').ok, true);
    healthy = false;
    const bad = await f.run(['--json', '--port', port], { PAPILOT_PUBLIC_ORIGIN: 'https://host.example/path', PAPILOT_TAILSCALE_LOGIN: 'owner' });
    assert.equal(bad.code, 1);
    assert.equal(item(bad.report, 'server').ok, false); assert.equal(item(bad.report, 'remote').ok, false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); f.cleanup(); }
});

test('doctor marks a timeout before process cleanup reports a plain exit code', async () => {
  const f = fixture();
  try {
    f.baseTools();
    const agy = f.tool('agy', 'process.exit(1);');
    const failed = await f.run(['--json'], { PAPILOT_AGY_BIN: agy });
    assert.equal(item(failed.report, 'agent.antigravity').ok, false);
    assert.match(item(failed.report, 'agent.antigravity').detail, /failed \(1\)/);
    f.tool('agy', 'console.log("model\\tExample model");');
    const success = await f.run(['--json'], { PAPILOT_AGY_BIN: agy });
    assert.equal(item(success.report, 'agent.antigravity').ok, true);

    // Windows taskkill can close a .cmd probe with code 1 before a separately
    // registered deadline callback runs. Model that ordering on every host;
    // the integration test above separately verifies actual process cleanup.
    const paths = path.join(f.app, 'bin/agent-paths.mjs'), killed = path.join(f.dir, 'killed');
    fs.renameSync(paths, path.join(f.app, 'bin/agent-paths-real.mjs'));
    fs.writeFileSync(paths, `
      import { EventEmitter } from 'node:events';
      import fs from 'node:fs';
      import * as real from './agent-paths-real.mjs';
      export * from './agent-paths-real.mjs';
      let probe;
      export function spawnCommand(file, args, options = {}) {
        if (file !== process.env.PAPILOT_AGY_BIN) return real.spawnCommand(file, args, options);
        probe = new EventEmitter(); probe.pid = -1;
        probe.kill = () => { probe.emit('close', 1, null); return true; };
        if (options.timeout) setTimeout(() => probe.emit('close', 1, null), options.timeout);
        return probe;
      }
      export function killTree(pid, signal) {
        if (pid !== -1) return real.killTree(pid, signal);
        fs.writeFileSync(${JSON.stringify(killed)}, signal);
        probe.emit('close', 1, null);
      }
    `);
    const timedOut = await f.run(['--json'], { PAPILOT_AGY_BIN: agy });
    assert.equal(timedOut.code, 0, timedOut.stdout);
    assert.equal(item(timedOut.report, 'agent.antigravity').ok, false);
    assert.match(item(timedOut.report, 'agent.antigravity').detail, /timed out/);
    assert.equal(fs.readFileSync(killed, 'utf8'), 'SIGKILL', 'the deadline must still clean up the process tree');
  } finally { f.cleanup(); }
});

test('doctor checks Kimi ACP availability without login, prompts or reading credentials', async () => {
  const f = fixture();
  try {
    f.baseTools();
    const kimi = f.tool('kimi', `if (JSON.stringify(process.argv.slice(2)) !== '["acp","--help"]') process.exit(99); console.log('Run an Agent Client Protocol (ACP) server');`);
    const result = await f.run(['--json'], { PAPILOT_KIMI_BIN: kimi });
    assert.equal(item(result.report, 'agent.kimi').ok, true);
    assert.match(item(result.report, 'agent.kimi').detail, /login and generation were not tested/);
    assert.equal(item(result.report, 'agents').ok, true);
    assert.equal(fs.existsSync(f.data), false);
    const missing = await f.run(['--json'], { PAPILOT_KIMI_BIN: path.join(f.dir, 'absent') });
    assert.equal(item(missing.report, 'agent.kimi').ok, false);
    assert.match(item(missing.report, 'agent.kimi').detail, /PAPILOT_KIMI_BIN.*runnable executable/);
    assert.match(item(missing.report, 'agent.kimi').fix!, /kimi login/);
  } finally { f.cleanup(); }
});

test('doctor checks Copilot ACP support and reports missing or incompatible CLIs without signing in', async () => {
  const f = fixture();
  try {
    f.baseTools();
    const copilot = f.tool('copilot', `if (JSON.stringify(process.argv.slice(2)) !== '["--help"]') process.exit(99); console.log('--acp Start as Agent Client Protocol server');`);
    const result = await f.run(['--json'], { PAPILOT_COPILOT_BIN: copilot });
    assert.equal(item(result.report, 'agent.copilot').ok, true);
    assert.match(item(result.report, 'agent.copilot').detail, /login and generation were not tested/);
    assert.equal(fs.existsSync(f.data), false);
    const missing = await f.run(['--json'], { PAPILOT_COPILOT_BIN: path.join(f.dir, 'absent') });
    assert.equal(item(missing.report, 'agent.copilot').severity, 'info');
    assert.match(item(missing.report, 'agent.copilot').fix!, /copilot login/);
    f.tool('copilot', `console.log('Old CLI without agent protocol support');`);
    const old = await f.run(['--json'], { PAPILOT_COPILOT_BIN: copilot });
    assert.equal(item(old.report, 'agent.copilot').ok, false);
    assert.equal(item(old.report, 'agent.copilot').severity, 'warn');
    assert.match(item(old.report, 'agent.copilot').fix!, /Update GitHub Copilot CLI/);
  } finally { f.cleanup(); }
});

test('doctor detects Grok in its installer folder and checks only the isolated stdio help', async () => {
  const f = fixture();
  try {
    f.baseTools();
    const bin = f.tool('grok', `if (JSON.stringify(process.argv.slice(2)) !== '["--no-auto-update","agent","--no-leader","stdio","--help"]') process.exit(99); console.log('Usage: grok agent stdio [OPTIONS]');`);
    const dir = path.join(f.env.HOME!, '.grok/bin');
    fs.mkdirSync(dir, { recursive: true });
    const installed = path.join(dir, process.platform === 'win32' ? 'grok.cmd' : 'grok');
    fs.renameSync(bin, installed);
    const result = await f.run(['--json']);
    assert.equal(item(result.report, 'agent.grok').ok, true, JSON.stringify(result.report));
    assert.match(item(result.report, 'agent.grok').detail, /login and generation were not tested/);
    assert.equal(fs.existsSync(f.data), false);
    const missing = await f.run(['--json'], { PAPILOT_GROK_BIN: path.join(f.dir, 'absent') });
    assert.equal(item(missing.report, 'agent.grok').severity, 'info');
    assert.match(item(missing.report, 'agent.grok').fix!, /grok login.*XAI_API_KEY/);
    const wrong = f.tool('other-grok', `console.log('Unrelated grok pattern parser');`);
    const incompatible = await f.run(['--json'], { PAPILOT_GROK_BIN: wrong });
    assert.equal(item(incompatible.report, 'agent.grok').ok, false);
    assert.equal(item(incompatible.report, 'agent.grok').severity, 'warn');
    assert.match(item(incompatible.report, 'agent.grok').fix!, /Update Grok Build CLI/);
  } finally { f.cleanup(); }
});
