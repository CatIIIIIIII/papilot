import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Repo } from '../engine/src/core/git.ts';
import { Builder } from '../engine/src/core/build.ts';
import { loadProject } from '../engine/src/core/config.ts';
import { findCommand } from '../engine/src/core/platform.mjs';

const { Fixture, METHOD, fakeRound } = await import(new URL('../engine/tests/ts/helpers.ts', import.meta.url).href);
const tex = (() => {
  try { execFileSync('latexmk', ['--version'], { stdio: 'ignore' }); execFileSync('pdflatex', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
})();
const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@localhost'];

function paper(files: Record<string, string>) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-fast-')), root = path.join(base, 'paper');
  fs.mkdirSync(root, { recursive: true });
  const repo = new Repo(root);
  repo.run(['init', '-q']);
  const write = (contents: Record<string, string>) => {
    for (const [file, text] of Object.entries(contents)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); }
  };
  const commit = (contents: Record<string, string>, message = 'Edit') => {
    write(contents);
    repo.run(['add', '-A']); repo.run([...identity, 'commit', '-qm', message]);
    return repo.rev('HEAD');
  };
  commit({ '.git/papilot/settings.json': JSON.stringify({ main: 'main.tex', engine: 'pdflatex' }), ...files }, 'Fixture');
  return { base, root, repo, write, commit, close: () => fs.rmSync(base, { recursive: true, force: true }) };
}
const tree = (repo: Repo, commit: string) => repo.text(['rev-parse', `${commit}^{tree}`]);

test('engine snapshots continue from their saved index, in the main checkout and in a linked worktree', async () => {
  const f = paper({ 'main.tex': 'One.\n', 'notes/keep.txt': 'Kept.\n', 'old.tex': 'Old.\n' });
  try {
    const index = fs.readFileSync(path.join(f.root, '.git/index'));
    const first = f.repo.snapshot(['']);
    assert.ok(fs.existsSync(path.join(f.root, '.git/papilot/snapshot-index')));
    f.write({ 'main.tex': 'Two.\n', 'added.tex': 'New.\n', 'build/main.aux': 'Generated.\n' });
    fs.rmSync(path.join(f.root, 'old.tex'));
    const second = f.repo.snapshot([''], ['.aux']);
    assert.notEqual(tree(f.repo, second), tree(f.repo, first));
    assert.equal(f.repo.blob(second, 'main.tex')?.toString(), 'Two.\n');
    assert.equal(f.repo.blob(second, 'added.tex')?.toString(), 'New.\n');
    assert.equal(f.repo.blob(second, 'old.tex'), null);
    assert.equal(f.repo.blob(second, 'build/main.aux'), null, 'excluded suffixes stay out');
    assert.equal(tree(f.repo, await f.repo.snapshotAsync([''], ['.aux'])), tree(f.repo, second), 'the asynchronous snapshot is the same');
    fs.rmSync(path.join(f.root, '.git/papilot/snapshot-index'));
    assert.equal(tree(f.repo, f.repo.snapshot([''], ['.aux'])), tree(f.repo, second), 'a snapshot from scratch is the same');
    fs.writeFileSync(path.join(f.root, '.git/papilot/snapshot-index'), 'corrupt');
    assert.equal(tree(f.repo, await f.repo.snapshotAsync([''], ['.aux'])), tree(f.repo, second), 'an unreadable saved index falls back to a fresh one');
    // A new commit moves HEAD; the saved index still describes the old one.
    f.commit({ 'main.tex': 'Three.\n' });
    assert.equal(f.repo.blob(f.repo.snapshot(['']), 'main.tex')?.toString(), 'Three.\n');
    assert.notDeepEqual(fs.readFileSync(path.join(f.root, '.git/index')), index, 'the commit changed the real index');
    const before = fs.readFileSync(path.join(f.root, '.git/index'));
    f.repo.snapshot(['']);
    assert.deepEqual(fs.readFileSync(path.join(f.root, '.git/index')), before, 'snapshots never touch the real index');
    // A linked worktree keeps its own saved index.
    const worktree = path.join(f.base, 'task');
    f.repo.run(['worktree', 'add', '--detach', worktree, 'HEAD']);
    fs.writeFileSync(path.join(worktree, 'main.tex'), 'In the task.\n');
    const task = new Repo(worktree), snapshot = await task.snapshotAsync(['']);
    assert.equal(task.blob(snapshot, 'main.tex')?.toString(), 'In the task.\n');
    assert.ok(fs.existsSync(path.join(f.root, '.git/worktrees/task/papilot/snapshot-index')));
    assert.equal(f.repo.blob(f.repo.snapshot(['']), 'main.tex')?.toString(), 'Three.\n', 'the main checkout is unaffected');
  } finally { f.close(); }
});

const document = (sections: string) => `\\documentclass{article}\n\\begin{document}\n\\tableofcontents\n${sections}\n\\end{document}\n`;

test('a build continues from the recent build whose sources differ least, not only the newest', { skip: !tex && 'needs latexmk and pdflatex', timeout: 180000 }, async () => {
  const f = paper({ 'main.tex': document('\\input{one}\n\\input{two}'), 'one.tex': '\\section{One}\\label{one}First.\n', 'two.tex': '\\section{Two}See~\\ref{one}.\n' });
  try {
    const builder = new Builder(loadProject(f.root), f.repo), base = f.repo.rev('HEAD');
    await builder.build(base);
    // Another version far from the base becomes the newest build.
    const other = f.commit({ 'two.tex': '\\section{Two}\\label{two}Rewritten.\n\\section{Three}More.\n', 'three.tex': 'Unused.\n' });
    await builder.build(other);
    f.repo.run(['checkout', '-q', base]);
    const close = f.commit({ 'one.tex': '\\section{One}\\label{one}First, edited.\n' });
    const result = await builder.build(close);
    const log = fs.readFileSync(path.join(path.dirname(result.root), 'latexmk.log'), 'utf8'), changed = log.slice(log.indexOf('Changed files'), log.indexOf('------------', log.indexOf('Changed files')));
    assert.match(changed, /one\.tex/);
    assert.doesNotMatch(changed, /two\.tex/, 'it continued from the base build, where only one.tex differs');
    assert.ok(fs.existsSync(path.join(path.dirname(path.dirname(result.root)), 'recent.json')));
  } finally { f.close(); }
});

test('each TeX pass that latexmk follows with more work is shown before the build ends', { skip: !tex && 'needs latexmk and pdflatex', timeout: 180000 }, async () => {
  const f = paper({ 'main.tex': document('\\section{One}\\label{one}See page~\\pageref{two}.\n\\section{Two}\\label{two}Text.\n') });
  try {
    const shown: { pass: number; pdf: string; exists: boolean }[] = [];
    const result = await new Builder(loadProject(f.root), f.repo).build(f.repo.rev('HEAD'), ['full'], null, {
      pass: preview => shown.push({ pass: preview.pass, pdf: preview.pdf, exists: fs.existsSync(preview.pdf) && fs.existsSync(preview.pdf.replace(/\.pdf$/, '.synctex.gz')) }),
    });
    const passes = (fs.readFileSync(path.join(path.dirname(result.root), 'latexmk.log'), 'utf8').match(/^Running 'pdflatex/gm) || []).length;
    assert.ok(passes >= 2, 'the table of contents needs another pass');
    assert.deepEqual(shown.map(s => s.pass), Array.from({ length: passes - 1 }, (_, i) => i + 1), 'every pass but the last one');
    assert.ok(shown.every(s => s.exists), 'each shown pass has its PDF and SyncTeX data');
    assert.ok(!fs.existsSync(path.join(path.dirname(result.root), 'passes', String(passes))), 'the last pass is the result itself');
    // A build that someone waits for without previews runs no hook.
    const plain = await new Builder(loadProject(f.root), f.repo).build(f.commit({ 'main.tex': document('\\section{One}Plain.\n') }));
    assert.doesNotMatch(fs.readFileSync(path.join(path.dirname(plain.root), 'latexmk.log'), 'utf8'), /Papilot: pass/);
  } finally { f.close(); }
});

test('a background build compiles beside another at full speed, lends its slot only when none is free, and gets it back once someone waits for it', { skip: process.platform === 'win32' && 'uses POSIX signals', timeout: 60000 }, async () => {
  const f = paper({ 'main.tex': document('Text.\n') });
  const bin = path.join(f.base, 'bin'), previousPath = process.env.PATH, previousPool = process.env.PAPILOT_TEX_POOL;
  const pool = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-pool-'));
  try {
    // A latexmk that records its process ID and finishes when told to, or
    // after a minute, so that a test stopped midway leaves nothing running.
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'pdflatex'), '#!/bin/sh\necho "pdfTeX 3.14 (fake)"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'latexmk'), `#!/bin/sh\necho $$ > "${f.base}/pid-$(basename "$(dirname "$PWD")")"\ni=0; while [ ! -e "${f.base}/go-$(basename "$(dirname "$PWD")")" ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done\nmkdir -p build && echo pdf > build/main.pdf\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${previousPath}`;
    process.env.PAPILOT_TEX_POOL = pool;
    const builder = new Builder(loadProject(f.root), f.repo), keyOf = (folder: string) => path.basename(path.dirname(folder));
    const state = (pid: string) => execFileSync('ps', ['-o', 'stat=', '-p', pid]).toString().trim();
    const waitFor = async (check: () => boolean) => { for (let i = 0; i < 1200 && !check(); i++) await new Promise(r => setTimeout(r, 25)); assert.ok(check()); };
    const pidOf = (key: string) => { try { return fs.readFileSync(path.join(f.base, `pid-${key}`), 'utf8').trim(); } catch { return ''; } };
    const pids = () => fs.readdirSync(f.base).filter(n => n.startsWith('pid-')).map(n => n.slice(4));
    const background = builder.build(f.repo.rev('HEAD'), ['full'], null, { priority: 'background' });
    await waitFor(() => pids().length === 1);
    const [speculative] = pids();
    // Another build takes the free slot; both compile.
    const other = f.commit({ 'main.tex': document('Other.\n') });
    const normal = builder.build(other);
    await waitFor(() => pids().length === 2);
    const [busy] = pids().filter(key => key !== speculative);
    await new Promise(r => setTimeout(r, 400));
    assert.doesNotMatch(state(pidOf(speculative)), /T/, 'a free slot is used at full speed');
    // A third finds no free slot and borrows the background build's.
    const third = builder.build(f.commit({ 'main.tex': document('Third.\n') }));
    await waitFor(() => pids().length === 3);
    const [borrower] = pids().filter(key => key !== speculative && key !== busy);
    await waitFor(() => /T/.test(state(pidOf(speculative))));
    // Someone starts waiting for the lent build: it gets its slot back, and
    // the borrower waits, stopped, for a slot of its own.
    f.repo.run(['checkout', '-q', 'HEAD~2']);
    const waiting = builder.build(f.repo.rev('HEAD'), ['full'], null, { priority: 'foreground' });
    await waitFor(() => !/T/.test(state(pidOf(speculative))));
    await waitFor(() => /T/.test(state(pidOf(borrower))));
    fs.writeFileSync(path.join(f.base, `go-${speculative}`), '');
    const [first, again] = await Promise.all([background, waiting]);
    assert.equal(first.key, again.key, 'the foreground request received the speculative build');
    // The borrower continues on the slot that became free.
    await waitFor(() => !/T/.test(state(pidOf(borrower))));
    fs.writeFileSync(path.join(f.base, `go-${busy}`), '');
    assert.equal(keyOf((await normal).root), busy);
    fs.writeFileSync(path.join(f.base, `go-${borrower}`), '');
    await third;
  } finally {
    for (const key of fs.readdirSync(f.base).filter(n => n.startsWith('pid-')).map(n => n.slice(4))) fs.writeFileSync(path.join(f.base, `go-${key}`), '');
    process.env.PATH = previousPath;
    if (previousPool === undefined) delete process.env.PAPILOT_TEX_POOL; else process.env.PAPILOT_TEX_POOL = previousPool;
    f.close(); fs.rmSync(pool, { recursive: true, force: true });
  }
});

test('a foreground waiter promotes recovery of a pruned preferred build and receives its progress', { skip: process.platform === 'win32' && 'uses POSIX signals', timeout: 60000 }, async () => {
  const f = paper({ 'main.tex': document('Original.\n') });
  const bin = path.join(f.base, 'bin'), gates = path.join(f.base, 'gates'), previousPath = process.env.PATH, previousGates = process.env.PAPILOT_RECOVERY_GATES;
  const pending: Promise<unknown>[] = [];
  fs.mkdirSync(bin); fs.mkdirSync(gates);
  const pids = () => fs.readdirSync(gates).filter(file => file.endsWith('.pid')).map(file => ({ key: file.slice(0, -4), pid: Number(fs.readFileSync(path.join(gates, file), 'utf8')) }));
  const state = (pid: number) => execFileSync('ps', ['-o', 'stat=', '-p', String(pid)]).toString().trim();
  const waitFor = async (check: () => boolean) => { for (let i = 0; i < 1200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 25)); assert.ok(check()); };
  try {
    fs.writeFileSync(path.join(bin, 'pdflatex'), '#!/bin/sh\necho "pdfTeX recovery test"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'latexmk'), `#!/bin/sh
key=$(basename "$(dirname "$PWD")")
echo $$ > "$PAPILOT_RECOVERY_GATES/$key.pid"
echo "Run number 1 of rule 'pdflatex'"
if [ -f "$PAPILOT_RECOVERY_GATES/block" ]; then
  i=0; while [ ! -f "$PAPILOT_RECOVERY_GATES/$key.go" ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done
fi
mkdir -p build
echo result > build/main.pdf
`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
    process.env.PAPILOT_RECOVERY_GATES = gates;
    const builder = new Builder(loadProject(f.root), f.repo), rev = f.repo.rev('HEAD');
    const first = await builder.build(rev), refreshed = await builder.build(rev, ['full'], null, { force: true });
    const other = f.commit({ 'main.tex': document('Other.\n') });
    fs.rmSync(path.dirname(refreshed.root), { recursive: true });
    for (const file of fs.readdirSync(gates)) fs.rmSync(path.join(gates, file));
    fs.writeFileSync(path.join(gates, 'block'), '');
    const background = builder.build(rev, ['full'], null, { priority: 'background' }); pending.push(background);
    await waitFor(() => pids().length === 1);
    const target = pids()[0];
    assert.notEqual(target.key, first.key, 'Recovery writes fresh immutable output');
    const competing = builder.build(other); pending.push(competing);
    await waitFor(() => pids().length === 2);
    // Both compile, each on its own slot.
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.doesNotMatch(state(target.pid), /T/);
    const progress: number[] = [];
    const foreground = builder.build(rev, ['full'], null, { priority: 'foreground', progress: value => progress.push(value.pass) }); pending.push(foreground);
    await waitFor(() => !/T/.test(state(target.pid)));
    await waitFor(() => progress.includes(1));
    fs.writeFileSync(path.join(gates, target.key + '.go'), '');
    const [recovered, shown] = await Promise.all([background, foreground]);
    assert.equal(recovered.key, shown.key);
    assert.equal(shown.key, target.key);
    assert.equal((await builder.build(rev)).key, recovered.key);
  } finally {
    for (const { key, pid } of pids()) {
      fs.writeFileSync(path.join(gates, key + '.go'), '');
      if (pid > 0) try { process.kill(-pid, 'SIGCONT'); } catch { /* Already finished. */ }
    }
    await Promise.allSettled(pending);
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousGates === undefined) delete process.env.PAPILOT_RECOVERY_GATES; else process.env.PAPILOT_RECOVERY_GATES = previousGates;
    f.close();
  }
});

test('a build runs at the highest priority of everyone waiting for it, also of those who asked before it started', { skip: process.platform === 'win32' && 'uses POSIX signals', timeout: 60000 }, async () => {
  const f = paper({ 'main.tex': document('Text.\n') });
  const bin = path.join(f.base, 'bin'), previousPath = process.env.PATH;
  try {
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'pdflatex'), '#!/bin/sh\necho "pdfTeX 3.14 (fake)"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'latexmk'), `#!/bin/sh\necho $$ > "${f.base}/pid-$(basename "$(dirname "$PWD")")"\ni=0; while [ ! -e "${f.base}/go-$(basename "$(dirname "$PWD")")" ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done\nmkdir -p build && echo pdf > build/main.pdf\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${previousPath}`;
    const builder = new Builder(loadProject(f.root), f.repo), rev = f.repo.rev('HEAD');
    const state = (pid: string) => execFileSync('ps', ['-o', 'stat=', '-p', pid]).toString().trim();
    const waitFor = async (check: () => boolean) => { for (let i = 0; i < 1200 && !check(); i++) await new Promise(r => setTimeout(r, 25)); assert.ok(check()); };
    const pidOf = (key: string) => { try { return fs.readFileSync(path.join(f.base, `pid-${key}`), 'utf8').trim(); } catch { return ''; } };
    const pids = () => fs.readdirSync(f.base).filter(n => n.startsWith('pid-')).map(n => n.slice(4));
    // Both ask at once, before anything compiles: whichever starts it, it is
    // the build someone waits for, and another build does not stop it.
    const speculative = builder.build(rev, ['full'], null, { priority: 'background' });
    const waiting = builder.build(rev, ['full'], null, { priority: 'foreground' });
    await waitFor(() => pids().length === 1);
    const [shared] = pids();
    const other = builder.build(f.commit({ 'main.tex': document('Other.\n') }));
    await waitFor(() => pids().length === 2);
    await new Promise(r => setTimeout(r, 400));
    assert.doesNotMatch(state(pidOf(shared)), /T/, 'the build that someone waits for keeps compiling');
    for (const key of pids()) fs.writeFileSync(path.join(f.base, `go-${key}`), '');
    const [first, again] = await Promise.all([speculative, waiting, other]);
    assert.equal(first.key, again.key);
  } finally { process.env.PATH = previousPath; f.close(); }
});

test('the whole paper of a version compiles ahead, and the review shows each of its passes until the complete PDF is ready', { skip: !tex && 'needs latexmk and pdflatex', timeout: 180000 }, async () => {
  const { preparePaper, nextPass, passPdf, paperPdf } = await import('../src/server/pdf.ts');
  const f = paper({ 'main.tex': document('\\section{One}\\label{one}See page~\\pageref{two}.\n\\section{Two}\\label{two}Text.\n') });
  const teX = slowTeX(f.base);
  try {
    const rev = f.repo.rev('HEAD');
    preparePaper(f.root, rev, 'background');
    // The reviewer opens the full paper once the first pass is over.
    for (let i = 0; i < 400 && teX.runs() < 2; i++) await new Promise(r => setTimeout(r, 25));
    const shown: number[] = [];
    for (let after = 0; ;) {
      const next = await nextPass(f.root, rev, after, 60000);
      if (next.pass === null) break;
      if (typeof next.pass === 'number') {
        assert.ok(fs.existsSync(passPdf(f.root, rev, next.pass)));
        shown.push(next.pass);
        after = next.pass;
      }
    }
    assert.ok(shown.length >= 1 && shown[0] === 1, `the pass before the reviewer came is shown first: ${shown}`);
    const pdf = await paperPdf(f.root, rev);
    assert.ok(fs.existsSync(pdf));
    const builds = path.join(f.root, '.git/papilot/cache/builds');
    assert.equal(fs.readdirSync(builds).filter(name => fs.existsSync(path.join(builds, name, 'result.json'))).length, 1, 'the reviewer waited for the build started ahead');
    // Once it is complete, the paper is answered at once and its passes stay.
    assert.deepEqual(await nextPass(f.root, rev, 0, 0), { pass: null });
    assert.ok(fs.existsSync(passPdf(f.root, rev, shown[0])));
    assert.throws(() => passPdf(f.root, rev, 99), /Review resource not found/);
  } finally { teX.restore(); f.close(); }
});

test('the review full paper shows the round\'s changed chapters at once, then each pass of the whole paper, then the complete PDF', { skip: !tex && 'needs latexmk and pdflatex', timeout: 180000 }, async () => {
  const { nextPaperPass, paperPassPdf, fullPaperPdf } = await import('../src/server/pdf.ts');
  const f = paper({ 'main.tex': document('\\section{One}\\label{one}See page~\\pageref{two}.\n\\section{Two}\\label{two}Text.\n') });
  const teX = slowTeX(f.base);
  try {
    const rev = f.repo.rev('HEAD');
    // The round compiled only its changed chapters; that PDF is in the build cache.
    const key = 'c'.repeat(32), folder = path.join(f.root, '.git/papilot/cache/builds', key), chapters = path.join(folder, 'chapters.pdf');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(chapters, '%PDF-1.4 chapters');
    fs.writeFileSync(path.join(folder, 'result.json'), JSON.stringify({ pdf: chapters }));
    const connect = async () => ({ get: async () => ({ before: rev, after: rev, build: { key, targets: ['one'] } }) as any });
    const versions: number[] = [], files: string[] = [];
    for (let after = 0; ;) {
      const next = await nextPaperPass(connect, f.root, 'p-task', 1, after, 60000);
      if (next.pass === null) break;
      if (typeof next.pass !== 'number') continue;
      versions.push(next.pass);
      files.push(await paperPassPdf(connect, f.root, 'p-task', 1, next.pass));
      after = next.pass;
    }
    assert.deepEqual([versions[0], files[0]], [1, chapters], 'the changed chapters come first');
    assert.ok(versions.length >= 2, `then a pass of the whole paper: ${versions}`);
    assert.ok(files.slice(1).every(file => file !== chapters && fs.existsSync(file)));
    assert.ok(fs.existsSync(await fullPaperPdf(connect, f.root, 'p-task', 1, 'after')));
    // Once the whole paper is there, it is shown right away.
    assert.deepEqual(await nextPaperPass(connect, f.root, 'p-task', 1, 0, 0), { pass: null });
  } finally { teX.restore(); f.close(); }
});

test('the full paper of a round that compiled the whole paper is that round\'s own PDF', { skip: process.platform === 'win32' && 'uses a POSIX shell script', timeout: 60000 }, async () => {
  const { nextPaperPass, fullPaperPdf } = await import('../src/server/pdf.ts');
  const f = paper({ 'main.tex': document('Text.\n') });
  const bin = path.join(f.base, 'bin'), calls = path.join(f.base, 'calls'), previousPath = process.env.PATH;
  try {
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'pdflatex'), '#!/bin/sh\necho "pdfTeX 3.14 (fake)"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'latexmk'), `#!/bin/sh\necho run >> "${calls}"\nmkdir -p build && echo pdf > build/main.pdf\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
    const project = loadProject(f.root), rev = f.repo.rev('HEAD'), other = f.commit({ 'main.tex': document('Other.\n') });
    // A build the round published, with its own date, as the publisher leaves it.
    const publish = async (key: string, revision: string) => {
      const folder = path.join(project.state, 'cache/builds', key), pdf = path.join(folder, 'src/build/main.pdf');
      fs.mkdirSync(path.dirname(pdf), { recursive: true });
      fs.writeFileSync(pdf, '%PDF-1.4 round');
      fs.writeFileSync(path.join(folder, 'result.json'), JSON.stringify({ key, tree: await f.repo.treeIdAsync(revision, project.source_dir), targets: ['full'], root: path.join(folder, 'src'), cwd: path.join(folder, 'src'), pdf, seconds: 1, warnings: [] }));
      return pdf;
    };
    const round = (after: string, key: string) => async () => ({ get: async () => ({ before: after, after, build: { key, targets: ['full'] } }) as any });
    const published = await publish('d'.repeat(32), rev), whole = round(rev, 'd'.repeat(32));
    assert.deepEqual(await nextPaperPass(whole, f.root, 'p-task', 1, 0, 0), { pass: null }, 'the complete PDF is there at once');
    assert.equal(await fullPaperPdf(whole, f.root, 'p-task', 1, 'after'), published);
    const baseline = await publish('b'.repeat(32), other);
    const both = async () => ({ get: async () => ({ before: other, after: rev, builds: ['b'.repeat(32), 'd'.repeat(32)], build: { key: 'd'.repeat(32), targets: ['full'] } }) as any });
    assert.equal(await fullPaperPdf(both, f.root, 'p-task', 3, 'before'), baseline, 'the before side adopts its dated baseline PDF too');
    assert.ok(!fs.existsSync(calls), 'nothing compiled that version again');
    // A published build of another version, such as an empty round's
    // baseline, is not shown for this one.
    const different = f.commit({ 'main.tex': document('Different.\n') });
    const stray = round(different, 'e'.repeat(32));
    await publish('e'.repeat(32), rev);
    assert.notEqual(await fullPaperPdf(stray, f.root, 'p-task', 2, 'after'), published);
    assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 1);
  } finally { process.env.PATH = previousPath; f.close(); }
});

test('a delivery preview is exactly what applying the task writes, with pending changes accepted', async () => {
  const disk = new Fixture(), app = disk.app();
  try {
    const task = app.tasks.create('preview', 'Review', [], ['paper'], true);
    disk.edit(task, METHOD, 'Method sentence 2.', 'First accepted sentence.');
    disk.edit(task, METHOD, 'Detail sentence 2.', 'Rejected sentence.');
    disk.edit(task, 'paper/main.tex', 'Intro sentence 2.', 'Pending introduction.');
    const round = fakeRound(app, task.name);
    // An independent hand edit in the manuscript is merged, as applying merges it.
    disk.write(METHOD, disk.read(METHOD).replace('Detail sentence 19.', 'A hand edit.'));
    const all = await app.delivery.preview(task.name);
    assert.match(all[METHOD].toString(), /First accepted sentence[\s\S]*Rejected sentence[\s\S]*A hand edit/);
    assert.match(all['paper/main.tex'].toString(), /Pending introduction/);
    const decide = (action: string, units: any[]) => app.review.decide(task.name, { id: crypto.randomUUID(), round: round.number, action, changes: units.map(unit => unit.id) });
    const rejected = round.units.find((unit: any) => unit.new_text.includes('Rejected'));
    await decide('reject', [rejected]);
    const preview = await app.delivery.preview(task.name);
    assert.doesNotMatch(preview[METHOD].toString(), /Rejected sentence/);
    await decide('accept', round.units.filter((unit: any) => unit !== rejected));
    assert.deepEqual(await app.delivery.preview(task.name), preview, 'accepting what was pending changes nothing');
    await app.delivery.deliver(task.name, 'workspace');
    for (const [file, data] of Object.entries(preview)) assert.equal(disk.read(file), (data as Buffer).toString());
  } finally { await disk.close(); }
});

// A pdflatex that takes a moment per pass, so a build can be watched while it runs.
function slowTeX(base: string) {
  const bin = path.join(base, 'bin'), real = findCommand('pdflatex')!, latexmk = findCommand('latexmk')!, runs = path.join(base, 'runs');
  fs.mkdirSync(bin, { recursive: true });
  const wrapper = (name: string, source: string) => {
    const script = path.join(bin, name + '.cjs'); fs.writeFileSync(script, source);
    if (process.platform === 'win32') fs.writeFileSync(path.join(bin, name + '.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0\\${name}.cjs" %*\r\n`);
    else fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
    return script.split(path.sep).join('/');
  };
  const slow = wrapper('pdflatex', `const args=process.argv.slice(2);if(args[0]!=='--version'){require('fs').appendFileSync(${JSON.stringify(runs)},'run\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,600);}const r=require('child_process').spawnSync(${JSON.stringify(real)},args,{stdio:'inherit'});process.exit(r.status??1);`);
  // Nix may prepend its own TeX to PATH; select the delayed compiler explicitly.
  const command = `-pdflatex="${process.execPath.split(path.sep).join('/')}" "${slow}" %O %S`;
  wrapper('latexmk', `const r=require('child_process').spawnSync(${JSON.stringify(latexmk)},[${JSON.stringify(command)},...process.argv.slice(2)],{stdio:'inherit'});process.exit(r.status??1);`);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous}`;
  return { runs: () => fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').trim().split('\n').length : 0, restore: () => { process.env.PATH = previous; } };
}

test('the manuscript compiles what applying a task will write ahead of time, and shows each pass while it builds', { skip: !tex && 'needs latexmk and pdflatex', timeout: 180000 }, async t => {
  const { Manuscripts } = await import('../src/server/manuscript.ts');
  const f = paper({ 'main.tex': document('\\section{One}\\label{one}See page~\\pageref{two}.\n\\section{Two}\\label{two}Text.\n') });
  const teX = slowTeX(f.base);
  const manuscripts = new Manuscripts(), changes: string[] = [], refreshing = new Set<Promise<void>>();
  const refresh = manuscripts.refresh.bind(manuscripts);
  // A stale build schedules refresh before its next build is marked busy.
  // Track that snapshot too, so teardown cannot remove its working directory.
  manuscripts.refresh = (...args) => {
    const pending = refresh(...args); refreshing.add(pending);
    void pending.then(() => refreshing.delete(pending), () => refreshing.delete(pending));
    return pending;
  };
  try {
    manuscripts.on('change', id => changes.push(id));
    const settled = async (current = false) => {
      const deadline = performance.now() + 60000;
      let last;
      while (performance.now() < deadline) {
        const { build } = await manuscripts.state('paper', f.root); last = build;
        if (build.status === 'failed' || build.status === 'ready' && (!current || build.current)) return build;
        await new Promise(r => setTimeout(r, 50));
      }
      throw new Error(`The build did not finish: ${JSON.stringify(last)}`);
    };
    const first = await settled();
    assert.equal(first.status, 'ready', first.error);
    assert.ok(changes.length >= 2, 'the start and the end of a build are announced');
    // A task that is about to be applied: its files compile in the background.
    const applied = document('\\section{One}\\label{one}See page~\\pageref{two}, now revised.\n\\section{Two}\\label{two}Text.\n');
    await manuscripts.predict('paper', f.root, { 'main.tex': Buffer.from(applied) });
    const before = teX.runs();
    fs.writeFileSync(path.join(f.root, 'main.tex'), applied);
    await manuscripts.refresh('paper', f.root);
    const ready = await settled();
    assert.equal(ready.status, 'ready', ready.error);
    assert.ok(ready.current);
    assert.equal(teX.runs(), before, 'applying the task needed no TeX run: its build was already done');
    // An edit needing several passes shows the first while the build goes on.
    fs.writeFileSync(path.join(f.root, 'main.tex'), document('\\section{One}\\label{one}See page~\\pageref{three}.\n\\section{Two}\\label{two}Text.\n\\section{Three}\\label{three}More.\n'));
    await manuscripts.refresh('paper', f.root);
    let preview: string | undefined, observed = ready;
    const previewDeadline = performance.now() + 60000;
    while (!preview && performance.now() < previewDeadline) {
      const { build } = await manuscripts.state('paper', f.root); observed = build;
      if (build.status === 'building' && build.key !== ready.key) preview = build.key;
      else if (build.status !== 'building') break;
      await new Promise(r => setTimeout(r, 25));
    }
    assert.ok(preview, `a pass replaced the previous PDF before the build finished: ${JSON.stringify(observed)}`);
    assert.ok(fs.existsSync(manuscripts.pdf('paper', preview!)));
    const done = await settled();
    assert.equal(done.status, 'ready', done.error);
    assert.notEqual(done.key, preview, 'the finished build replaces the pass');
    // An edit made while a build runs is compiled right after it, unasked.
    fs.writeFileSync(path.join(f.root, 'main.tex'), document('\\section{One}First edit.\n'));
    await manuscripts.refresh('paper', f.root);
    fs.writeFileSync(path.join(f.root, 'main.tex'), document('\\section{One}Second edit.\n'));
    await manuscripts.refresh('paper', f.root);
    const final = await settled(true);
    assert.equal(final.status, 'ready', final.error);
    assert.ok(final.current, `the second edit was compiled: ${JSON.stringify(final)}`);
  } finally {
    t.after(async () => {
      try {
        const deadline = performance.now() + 90000;
        while (manuscripts.busyForUpdate || refreshing.size) {
          if (performance.now() >= deadline) throw new Error(`Manuscript cleanup timed out; retained ${f.base}`);
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        await fs.promises.rm(f.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } finally { teX.restore(); }
    });
  }
});

test('someone who starts waiting for a background build sees its passes from the latest one on', { skip: !tex && 'needs latexmk and pdflatex', timeout: 180000 }, async () => {
  const f = paper({ 'main.tex': document('\\section{One}\\label{one}See page~\\pageref{two}.\n\\section{Two}\\label{two}Text.\n') });
  const teX = slowTeX(f.base);
  try {
    const builder = new Builder(loadProject(f.root), f.repo), rev = f.repo.rev('HEAD');
    const background = builder.build(rev, ['full'], null, { priority: 'background' });
    // The waiter arrives once the first pass is over.
    for (let i = 0; i < 400 && teX.runs() < 2; i++) await new Promise(r => setTimeout(r, 25));
    const shown: number[] = [];
    const waited = await builder.build(rev, ['full'], null, { priority: 'foreground', pass: preview => { assert.ok(fs.existsSync(preview.pdf)); shown.push(preview.pass); } });
    const done = await background;
    assert.equal(waited.key, done.key);
    assert.ok(shown.length >= 1 && shown[0] === 1, `the pass before the waiter came is shown first: ${shown}`);
    const passes = teX.runs();
    assert.ok(shown.every(pass => pass < passes), 'the last pass is the result itself');
    // A background build nobody waited for keeps no passes.
    const alone = await builder.build(f.commit({ 'main.tex': document('\\section{One}\\label{one}See~\\pageref{two}.\n\\section{Two}\\label{two}Again.\n') }), ['full'], null, { priority: 'background' });
    assert.ok(!fs.existsSync(path.join(path.dirname(alone.root), 'passes')) || !fs.readdirSync(path.join(path.dirname(alone.root), 'passes')).length);
  } finally { teX.restore(); f.close(); }
});

test('the review engine creates tasks while it answers requests, and concurrent ones get their own names', async () => {
  const disk = new Fixture(), app = disk.app();
  try {
    const [a, b] = await Promise.all([app.tasks.createAsync(undefined, 'Same title', [], ['paper'], true), app.tasks.createAsync(undefined, 'Same title', [], ['paper'], true)]);
    assert.notEqual(a.name, b.name);
    assert.ok(fs.existsSync(a.worktree) && fs.existsSync(b.worktree));
    const sync = app.tasks.create('sync', 'Sync', [], ['paper'], true), treeOf = (rev: string) => disk.repo.text(['rev-parse', `${rev}^{tree}`]);
    assert.equal(treeOf(a.base), treeOf(sync.base), 'the same snapshot as a synchronous creation');
    assert.equal((await app.tasks.createAsync(a.name, 'Again', [], ['paper'], true)).name, a.name, 'the same request returns the open task');
    const named = app.tasks.createAsync('named', 'Named', [], ['paper'], true);
    await assert.rejects(app.tasks.createAsync('named', 'Named', [], ['paper'], true), /being created/);
    assert.equal((await named).name, 'named');
  } finally { await disk.close(); }
});

test('decisions and commits let the review engine answer meanwhile, and concurrent ones never interleave', async () => {
  const disk = new Fixture(), app = disk.app();
  try {
    const task = app.tasks.create('concurrent', 'Review', [], ['paper'], true);
    disk.edit(task, METHOD, 'Method sentence 2.', 'First accepted sentence.');
    disk.edit(task, METHOD, 'Detail sentence 2.', 'Second accepted sentence.');
    const round = fakeRound(app, task.name);
    // While a decision runs Git, other work gets turns.
    let turned = false;
    setImmediate(() => { turned = true; });
    const decisions = round.units.map((unit: any) => app.review.decide(task.name, { id: crypto.randomUUID(), round: round.number, action: 'accept', changes: [unit.id] }));
    await Promise.all(decisions);
    assert.ok(turned, 'the event loop turned during the decisions');
    // Both took effect: neither overwrote the other's accepted text.
    const accepted = disk.repo.blob(app.tasks.get(task.name).accepted, METHOD)!.toString();
    assert.match(accepted, /First accepted sentence[\s\S]*Second accepted sentence/);
    turned = false;
    setImmediate(() => { turned = true; });
    const [first, second] = await Promise.all([app.delivery.apply(task.name, false, 'commit', 'Both sentences'), app.delivery.apply(task.name, false, 'commit', 'Both sentences')]);
    assert.ok(turned, 'the event loop turned during the commit');
    assert.equal(first.delivery?.commit, second.delivery?.commit, 'the second request finds the first one done');
    assert.equal(disk.repo.text(['log', '-1', '--format=%s']), 'Both sentences');
    assert.equal(disk.repo.text(['rev-list', '--count', 'HEAD~1..HEAD']), '1');
  } finally { await disk.close(); }
});
