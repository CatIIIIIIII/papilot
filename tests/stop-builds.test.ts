import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Repo } from '../engine/src/core/git.ts';

// Its own file: stopping ends every build this process starts afterwards too.
test('stopping ends every compiler, also a background build paused for another', { skip: process.platform === 'win32' && 'uses POSIX signals', timeout: 60000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-stop-')), root = path.join(base, 'paper'), bin = path.join(base, 'bin');
  const previousPath = process.env.PATH;
  try {
    fs.mkdirSync(root); fs.mkdirSync(bin);
    const repo = new Repo(root);
    repo.run(['init', '-q']);
    fs.writeFileSync(path.join(root, '.latex-review.json'), JSON.stringify({ main: 'main.tex', engine: 'pdflatex' }));
    fs.writeFileSync(path.join(root, 'main.tex'), '\\documentclass{article}\\begin{document}A\\end{document}\n');
    repo.run(['add', '-A']); repo.run(['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-qm', 'A']);
    const first = repo.rev('HEAD');
    fs.writeFileSync(path.join(root, 'main.tex'), '\\documentclass{article}\\begin{document}B\\end{document}\n');
    repo.run(['add', '-A']); repo.run(['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-qm', 'B']);
    // A latexmk that records its process ID and never finishes by itself.
    fs.writeFileSync(path.join(bin, 'pdflatex'), '#!/bin/sh\necho "pdfTeX 3.14 (fake)"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'latexmk'), `#!/bin/sh\necho $$ >> "${base}/pids"\nwhile true; do sleep 0.05; done\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${previousPath}`;
    // The builds run in a server process that stops them and exits at once, as Papilot quits.
    const script = path.join(base, 'server.mts');
    fs.writeFileSync(script, `
      import fs from 'node:fs';
      const { Builder } = await import(${JSON.stringify(new URL('../engine/src/core/build.ts', import.meta.url).href)});
      const { Repo } = await import(${JSON.stringify(new URL('../engine/src/core/git.ts', import.meta.url).href)});
      const { loadProject } = await import(${JSON.stringify(new URL('../engine/src/core/config.ts', import.meta.url).href)});
      const { stopAll } = await import(${JSON.stringify(new URL('../engine/src/core/process.ts', import.meta.url).href)});
      const root = ${JSON.stringify(root)}, base = ${JSON.stringify(base)}, repo = new Repo(root), builder = new Builder(loadProject(root), repo);
      const pids = () => fs.existsSync(base + '/pids') ? fs.readFileSync(base + '/pids', 'utf8').trim().split('\\n') : [];
      const until = async check => { while (!check()) await new Promise(r => setTimeout(r, 25)); };
      void builder.build(${JSON.stringify(first)}, ['full'], null, { priority: 'background' }).catch(() => {});
      await until(() => pids().length === 1);
      void builder.build('HEAD').catch(() => {});
      await until(() => pids().length === 2);
      await new Promise(r => setTimeout(r, 300));
      stopAll();
      process.exit(0);
    `);
    execFileSync(process.execPath, ['--import', 'tsx', script], { cwd: path.dirname(new URL(import.meta.url).pathname), env: process.env, stdio: 'ignore', timeout: 30000 });
    const pids = fs.readFileSync(path.join(base, 'pids'), 'utf8').trim().split('\n');
    assert.equal(pids.length, 2);
    const alive = (pid: string) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
    for (let i = 0; i < 200 && pids.some(alive); i++) await new Promise(r => setTimeout(r, 25));
    const left = pids.filter(alive);
    for (const pid of left) { try { process.kill(Number(pid), 'SIGCONT'); process.kill(Number(pid), 'SIGKILL'); } catch { /* Gone. */ } }
    assert.deepEqual(left, [], 'no compiler outlived the server, paused or not');
  } finally { process.env.PATH = previousPath; fs.rmSync(base, { recursive: true, force: true }); }
});
