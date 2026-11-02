import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { stop } from '../engine/src/client.ts';

// A zombie has exited; only an init that does not reap orphans keeps it listed.
const running = (pid: number) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z'); } catch { return false; }
};
const exited = async (pid: number, seconds = 5) => { for (let i = 0; i < seconds * 10 && running(pid); i++) await sleep(100); return !running(pid); };
const ps = (field: string, pid: number) => execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8' }).trim();
const module = (file: string) => JSON.stringify(pathToFileURL(path.resolve(file)).href);
const desktop = `const { reviewClient } = await import(${module('src/server/review.ts')});\nconst client = await reviewClient(root);`;
const cli = `const { connect } = await import(${module('engine/src/client.ts')});\nconst client = await connect(root);`;

// Each test gets a paper, and every process it starts is stopped afterwards.
async function withPaper(work: (root: string, clients: ChildProcess[]) => Promise<void>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-review-servers-')));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args], { cwd: root });
  git('init', '-q');
  fs.writeFileSync(path.join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nPaper.\n\\end{document}\n');
  fs.writeFileSync(path.join(root, '.latex-review.json'), JSON.stringify({ main: 'main.tex', engine: 'pdflatex', source_dir: '' }));
  git('add', '.'); git('commit', '-qm', 'Paper');
  const clients: ChildProcess[] = [];
  try { await work(root, clients); } finally {
    for (const child of clients) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await stop(root, true).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}
// Runs `code` in a new process that prints a PID, then stays alive like the
// desktop app's backend, or exits like a CLI command.
async function client(root: string, clients: ChildProcess[], code: string, options: { desktop?: boolean; exit?: boolean } = {}) {
  const script = path.join(root, '.git', `client-${clients.length}.mts`);
  fs.writeFileSync(script, `const root = ${JSON.stringify(root)};\n${code}\n${options.exit ? '' : 'setInterval(() => {}, 1000);'}\n`);
  const child = spawn(process.execPath, ['--import', 'tsx', script], { env: { ...process.env, ...(options.desktop ? { PAPILOT_DESKTOP: '1' } : {}) }, stdio: ['ignore', 'pipe', 'inherit'] });
  clients.push(child);
  let output = '';
  child.stdout!.on('data', chunk => { output += chunk; });
  const deadline = Date.now() + 60000;
  while (!/^\d+\n/.test(output) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(20);
  assert.match(output, /^\d+\n/, 'The client printed a PID');
  return { child, pid: Number(output.trim()) };
}
const printServer = `console.log((await client.get('/api/info')).pid);`;

test('the desktop app owns the review server it starts, so even a crash stops it', { timeout: 90000 }, () => withPaper(async (root, clients) => {
  const { child, pid: server } = await client(root, clients, `${desktop}\n${printServer}`, { desktop: true });
  assert.match(ps('command', server), /^Papilot review server /);
  assert.notEqual(ps('pgid', server), ps('pgid', child.pid!), 'Killing the app\'s process group leaves the server to clean up');
  child.kill('SIGKILL'); await once(child, 'exit');
  assert.ok(await exited(server), 'The review server stops when its app is killed');
}));

test('an owned review server that stops on its own exits while its app keeps running', { timeout: 90000 }, () => withPaper(async (root, clients) => {
  const { child, pid: server } = await client(root, clients, `${desktop}\n${printServer}`, { desktop: true });
  await stop(root);
  assert.ok(await exited(server), 'The stopped server exits');
  assert.equal(child.exitCode, null, 'The app is still running');
}));

test('a review server whose app quits while it starts does not keep running', { timeout: 90000 }, () => withPaper(async (root, clients) => {
  // The app quits as soon as the server process exists, before it listens.
  const { child, pid: server } = await client(root, clients, `const { connect } = await import(${module('engine/src/client.ts')});
const { execFileSync } = await import('node:child_process');
const fs = await import('node:fs');
void connect(root, true, { owned: true }).catch(() => {});
for (;;) {
  let pid = '';
  try { pid = execFileSync('pgrep', ['-f', 'serve --root ' + root], { encoding: 'utf8' }).trim().split('\\n')[0]; } catch {}
  if (pid) {
    console.log(pid);
    // Exit code 3 would mean the server was already listening.
    process.exit(fs.existsSync(root + '/.git/latex-review/server/connection.json') ? 3 : 0);
  }
  await new Promise(resolve => setTimeout(resolve, 10));
}`, { exit: true });
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  assert.equal(child.exitCode, 0, 'The app quit before its server was listening');
  assert.ok(await exited(server, 15), 'The orphaned server exits instead of serving for 12 hours');
}));

test('a review server started by the CLI outlives the desktop app that reused it', { timeout: 90000 }, () => withPaper(async (root, clients) => {
  const started = await client(root, clients, `${cli}\n${printServer}`, { exit: true });
  if (started.child.exitCode === null) await once(started.child, 'exit');
  assert.ok(running(started.pid), 'A CLI command leaves its review server running');
  assert.match(ps('command', started.pid), /^latex-review server /);
  const { child, pid: server } = await client(root, clients, `${desktop}\n${printServer}`, { desktop: true });
  assert.equal(server, started.pid, 'The app reuses the running server');
  child.kill('SIGKILL'); await once(child, 'exit');
  await sleep(1500);
  assert.ok(running(server), 'The app does not stop a server it did not start');
}));
