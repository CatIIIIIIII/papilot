import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';

const root = path.resolve(import.meta.dirname, '..');
interface Check { id: string; ok: boolean; severity: string; detail: string; fix: string | null }
interface Report { ok: boolean; checks: Check[]; error?: string }
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-doctor-'));
  const app = path.join(dir, 'app'), tools = path.join(dir, 'tools'), data = path.join(dir, 'data'), home = path.join(dir, 'home');
  for (const folder of [app, tools, home, path.join(app, 'dist'), path.join(app, 'vendor/latex-review/dist/web')]) fs.mkdirSync(folder, { recursive: true });
  fs.cpSync(path.join(root, 'bin'), path.join(app, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(app, 'package.json'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(app, 'node_modules'), 'dir');
  fs.symlinkSync(path.join(root, 'vendor/latex-review/src'), path.join(app, 'vendor/latex-review/src'), 'dir');
  fs.writeFileSync(path.join(app, 'dist/index.html'), '<html></html>');
  fs.writeFileSync(path.join(app, 'vendor/latex-review/dist/web/index.html'), '<html></html>');
  const log = path.join(dir, 'commands');
  const env: NodeJS.ProcessEnv = { PATH: tools, HOME: home, TMPDIR: os.tmpdir(), PAPILOT_DATA: data, PAPILOT_PORT: '65534' };
  function tool(name: string, script = 'console.log("test tool 1.0");') {
    const file = path.join(tools, name);
    fs.writeFileSync(file, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([${JSON.stringify(name)}, ...process.argv.slice(2)]) + '\\n');\n${script}\n`, { mode: 0o755 });
    // Node treats extensionless entry points as CJS unless their package is ESM.
    fs.writeFileSync(path.join(tools, 'package.json'), '{"type":"module"}');
    return file;
  }
  function baseTools() { for (const name of ['git', 'latexmk', 'synctex', 'pdflatex']) tool(name); }
  async function run(args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}) {
    return new Promise<{ code: number; stdout: string; stderr: string; report: Report }>(resolve => {
      execFile(process.execPath, [path.join(app, 'bin/papilot.mjs'), 'doctor', ...args], { env: { ...env, ...extraEnv }, cwd: dir, timeout: 15000 }, (error, stdout, stderr) => {
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
    fs.rmSync(path.join(f.app, 'vendor/latex-review/dist'), { recursive: true });
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
    fs.symlinkSync(file, path.join(managed, 'codex'));
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
  } finally { f.cleanup(); }
});

test('doctor checks real repository configuration without changing files or making worktrees', async () => {
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
    fs.writeFileSync(path.join(repo, '.latex-review.json'), '{"main":"main.tex","engine":"xelatex"}');
    const noCommit = await f.run(['--json', '--repo', repo]);
    assert.equal(item(noCommit.report, 'project.head').ok, false);
    git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.org', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Initial paper');
    const before = git('status', '--porcelain');
    const result = await f.run(['--json', '--repo', repo]);
    assert.equal(result.code, 0, result.stdout);
    assert.match(item(result.report, 'project.main').detail, /main.tex \(xelatex\)/);
    assert.equal(item(result.report, 'project.engine').ok, true);
    assert.equal(git('status', '--porcelain'), before);
    assert.equal(fs.existsSync(path.join(repo, '.git/latex-review')), false);
    assert.equal(fs.existsSync(repo + '-tasks'), false);
    fs.writeFileSync(path.join(repo, '.latex-review.json'), '{"main":"missing.tex"}');
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

test('a stalled agent probe times out while the rest of the report remains usable', async () => {
  const f = fixture();
  try {
    f.baseTools();
    const agy = f.tool('agy', 'setInterval(() => {}, 1000);');
    const start = Date.now();
    const result = await f.run(['--json'], { PAPILOT_AGY_BIN: agy });
    assert.equal(result.code, 0, result.stdout);
    assert.match(item(result.report, 'agent.antigravity').detail, /timed out/);
    assert.ok(Date.now() - start < 14000);
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
    const installed = path.join(dir, 'grok');
    fs.renameSync(bin, installed);
    const result = await f.run(['--json']);
    assert.equal(item(result.report, 'agent.grok').ok, true);
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
