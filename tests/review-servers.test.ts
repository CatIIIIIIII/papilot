import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { stop } from '../engine/src/client.ts';

const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const exited = async (pid: number) => { for (let i = 0; i < 50 && running(pid); i++) await sleep(100); return !running(pid); };
const module = (file: string) => JSON.stringify(pathToFileURL(path.resolve(file)).href);

function paper() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-review-servers-')));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args], { cwd: root });
  git('init', '-q');
  fs.writeFileSync(path.join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nPaper.\n\\end{document}\n');
  fs.writeFileSync(path.join(root, '.latex-review.json'), JSON.stringify({ main: 'main.tex', engine: 'pdflatex', source_dir: '' }));
  git('add', '.'); git('commit', '-qm', 'Paper');
  return root;
}
// Runs `code` in a new process that prints the review server's PID and then
// stays alive, like the desktop app's backend, unless `exit` is set, like a CLI command.
async function client(root: string, code: string, env: NodeJS.ProcessEnv = {}, exit = false) {
  const script = path.join(root, '.git', `client-${Date.now()}.mts`);
  fs.writeFileSync(script, `const root = ${JSON.stringify(root)};\n${code}\nconsole.log((await client.get('/api/info')).pid);\n${exit ? '' : 'setInterval(() => {}, 1000);'}\n`);
  const child = spawn(process.execPath, ['--import', 'tsx', script], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  while (!/^\d+\n/.test(output) && child.exitCode === null) await sleep(50);
  assert.match(output, /^\d+\n/, 'The client connected to a review server');
  return { child, server: Number(output.trim()) };
}
const desktop = `const { reviewClient } = await import(${module('src/server/review.ts')});\nconst client = await reviewClient(root);`;
const cli = `const { connect } = await import(${module('engine/src/client.ts')});\nconst client = await connect(root);`;

test('the desktop app owns the review server it starts, so even a crash stops it', { timeout: 90000 }, async () => {
  const root = paper();
  try {
    const { child, server } = await client(root, desktop, { PAPILOT_DESKTOP: '1' });
    assert.equal(execFileSync('ps', ['-o', 'command=', '-p', String(server)], { encoding: 'utf8' }).trim(), `Papilot review server ${root}`);
    child.kill('SIGKILL'); await once(child, 'exit');
    assert.ok(await exited(server), 'The review server stops when its app is killed');
  } finally {
    await stop(root, true).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a review server started by the CLI outlives the desktop app that reused it', { timeout: 90000 }, async () => {
  const root = paper();
  try {
    const started = await client(root, cli, {}, true);
    await once(started.child, 'exit');
    assert.ok(running(started.server), 'A CLI command leaves its review server running');
    const { child, server } = await client(root, desktop, { PAPILOT_DESKTOP: '1' });
    assert.equal(server, started.server, 'The app reuses the running server');
    child.kill('SIGKILL'); await once(child, 'exit');
    await sleep(1500);
    assert.ok(running(server), 'The app does not stop a server it did not start');
  } finally {
    await stop(root, true).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
