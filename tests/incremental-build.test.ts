import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Repo } from '../engine/src/core/git.ts';
import { Builder, auxiliaryBuildError } from '../engine/src/core/build.ts';
import { loadProject } from '../engine/src/core/config.ts';
import { App } from '../engine/src/server.ts';
import { view } from '../engine/src/core/view.ts';
import type { BuildInfo } from '../engine/src/types.ts';
import { workingTree } from '../src/server/manuscript.ts';

const tex = (() => {
  try { execFileSync('latexmk', ['--version'], { stdio: 'ignore' }); execFileSync('pdflatex', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
})();
const runs = (folder: string) => (fs.readFileSync(path.join(folder, 'latexmk.log'), 'utf8').match(/^Running 'pdflatex/gm) || []).length;
const paper = (body: string, preamble = '') => `\\documentclass{article}\n${preamble}\n\\begin{document}\n\\tableofcontents\n\\section{Intro}\\label{intro}\n${body} See Section~\\ref{intro}.\n\\end{document}\n`;

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-incremental-')), root = path.join(base, 'paper');
  fs.mkdirSync(path.join(root, 'materials'), { recursive: true });
  const repo = new Repo(root);
  repo.run(['init', '-q']);
  fs.writeFileSync(path.join(root, '.latex-review.json'), JSON.stringify({ main: 'main.tex', engine: 'pdflatex' }));
  return { base, root, repo, close: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('working tree snapshots reuse index state and match a fresh snapshot without touching the real index', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, 'main.tex'), 'Committed.\n');
    fs.writeFileSync(path.join(f.root, 'materials/big.bin'), Buffer.alloc(1 << 20, 1));
    f.repo.run(['add', '.']); f.repo.run(['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'Fixture']);
    const index = fs.readFileSync(path.join(f.root, '.git/index'));
    const first = await workingTree(f.root);
    assert.ok(fs.existsSync(path.join(f.root, '.git/latex-review/working-index')));
    fs.writeFileSync(path.join(f.root, 'main.tex'), 'Edited after the snapshot.\n');
    fs.writeFileSync(path.join(f.root, 'added.tex'), 'Untracked.\n');
    fs.rmSync(path.join(f.root, 'materials/big.bin'));
    const second = await workingTree(f.root);
    assert.notEqual(second, first);
    assert.equal(f.repo.blob(second, 'main.tex')?.toString(), 'Edited after the snapshot.\n');
    assert.equal(f.repo.blob(second, 'added.tex')?.toString(), 'Untracked.\n');
    assert.equal(f.repo.blob(second, 'materials/big.bin'), null);
    fs.rmSync(path.join(f.root, '.git/latex-review/working-index'));
    assert.equal(await workingTree(f.root), second, 'A saved index gives the same tree as a fresh one');
    fs.writeFileSync(path.join(f.root, '.git/latex-review/working-index'), 'corrupt');
    assert.equal(await workingTree(f.root), second, 'An unreadable saved index falls back to a fresh snapshot');
    assert.deepEqual(fs.readFileSync(path.join(f.root, '.git/index')), index);
  } finally { f.close(); }
});

test('builds export every file and continue like latexmk in the same folder; stale auxiliary state falls back to a clean build', { skip: !tex && 'needs latexmk and pdflatex', timeout: 180000 }, async () => {
  const f = fixture();
  try {
    // A package outside the TeX search path, found only because the whole
    // tree is exported, and auxiliary output that a later edit makes invalid.
    const preamble = '\\usepackage{materials/local}\n\\newcommand\\stale{}\\makeatletter\\AtBeginDocument{\\immediate\\write\\@auxout{\\string\\stale}}\\makeatother';
    fs.writeFileSync(path.join(f.root, 'materials/local.sty'), '\\ProvidesPackage{local}\\newcommand\\note{From a local package.}\n');
    fs.writeFileSync(path.join(f.root, 'materials/notes.txt'), 'Not part of the paper.\n');
    fs.writeFileSync(path.join(f.root, '.gitignore'), 'build/\n');
    fs.writeFileSync(path.join(f.root, 'main.tex'), paper('First draft. \\note', preamble));
    // The author has compiled the paper with latexmk before.
    execFileSync('latexmk', ['-pdf', '-outdir=build', '-interaction=nonstopmode', 'main.tex'], { cwd: f.root, stdio: 'ignore' });
    const project = loadProject(f.root), builder = new Builder(project, f.repo);
    const first = await builder.build(await workingTree(f.root));
    assert.equal(runs(path.dirname(first.root)), 1, "The first build continues from the author's latexmk state");
    assert.ok(fs.existsSync(path.join(first.root, 'materials/local.sty')));

    fs.writeFileSync(path.join(f.root, 'main.tex'), paper('Second draft. \\note', preamble));
    const second = await builder.build(await workingTree(f.root));
    assert.equal(runs(path.dirname(second.root)), 1, 'An edit that keeps references stable needs one pass');
    assert.ok(fs.existsSync(first.pdf), 'The earlier build stays readable');
    assert.match(execFileSync('pdftotext', [second.pdf, '-']).toString(), /Second draft/);

    // A file TeX does not read changes: latexmk keeps the PDF, and the
    // SyncTeX data and log now name this build's folder.
    fs.writeFileSync(path.join(f.root, 'materials/notes.txt'), 'Still not part of the paper.\n');
    const third = await builder.build(await workingTree(f.root));
    assert.notEqual(third.key, second.key);
    assert.equal(runs(path.dirname(third.root)), 0, 'Unchanged inputs need no TeX run');
    const synctex = zlib.gunzipSync(fs.readFileSync(third.pdf.replace(/\.pdf$/, '.synctex.gz'))).toString();
    assert.ok(synctex.includes(path.join(third.cwd, 'main.tex').replace(/main\.tex$/, '')) && !synctex.includes(path.dirname(second.root)));
    assert.ok(!fs.readFileSync(third.pdf.replace(/\.pdf$/, '.log'), 'utf8').includes(path.dirname(second.root)));
    assert.match(execFileSync('pdftotext', [third.pdf, '-']).toString(), /Second draft/);

    // The old .aux now calls a macro that no longer exists.
    fs.writeFileSync(path.join(f.root, 'main.tex'), paper('Third draft.'));
    const fourth = await builder.build(await workingTree(f.root));
    assert.match(execFileSync('pdftotext', [fourth.pdf, '-']).toString(), /Third draft/);
    assert.match(fs.readFileSync(path.join(project.state, 'logs', fourth.key + '.log'), 'utf8'), /build\/main\.aux:\d+: Undefined control sequence/, 'The continued build failed on stale state first');

    // A real error is reported once, without a clean retry hiding it.
    fs.writeFileSync(path.join(f.root, 'main.tex'), paper('Broken \\undefinedmacro draft.'));
    await assert.rejects(builder.build(await workingTree(f.root)), (error: any) => error.details.some((line: string) => /main\.tex:\d+: Undefined control sequence/.test(line)));
    fs.writeFileSync(path.join(f.root, 'main.tex'), paper('Fourth draft.'));
    const manual = await builder.build(await workingTree(f.root), ['full'], null, { force: true });
    assert.ok(runs(path.dirname(manual.root)) >= 2, 'Manual recompilation starts clean');
  } finally { f.close(); }
});

test('review builds of a chapter continue from the previous one and take other chapters from their seed', { skip: !tex && 'needs latexmk and pdflatex', timeout: 180000 }, async () => {
  const f = fixture();
  try {
    const commit = (message: string) => { f.repo.run(['add', '-A']); f.repo.run(['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', message]); return f.repo.text(['rev-parse', 'HEAD']); };
    fs.mkdirSync(path.join(f.root, 'chapters'));
    fs.writeFileSync(path.join(f.root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\n\\tableofcontents\n\\include{chapters/a}\n\\include{chapters/b}\n\\end{document}\n');
    const chapterA = (text: string) => `\\section{A}\\label{sec:a}\n${text} See Section~\\ref{sec:b}.\n`;
    fs.writeFileSync(path.join(f.root, 'chapters/a.tex'), chapterA('First draft.'));
    fs.writeFileSync(path.join(f.root, 'chapters/b.tex'), '\\section{B}\\label{sec:b}\nSee Section~\\ref{sec:a}.\n');
    const first = commit('First');
    const builder = new Builder(loadProject(f.root), f.repo), targets = ['chapters/a'];
    const seed = await builder.build(first);
    const clean = await builder.build(first, targets, seed);
    assert.ok(runs(path.dirname(clean.root)) >= 2, 'The first build of a chapter starts clean');

    fs.writeFileSync(path.join(f.root, 'chapters/a.tex'), chapterA('Second draft.'));
    const second = commit('Second');
    const continued = await builder.build(second, targets, seed);
    assert.equal(runs(path.dirname(continued.root)), 1, 'An edit that keeps references stable needs one pass');
    assert.match(execFileSync('pdftotext', [continued.pdf, '-']).toString(), /Second draft\. See Section 2\./);

    // Another chapter gains a section, so Section B is renumbered in the new seed.
    fs.writeFileSync(path.join(f.root, 'chapters/b.tex'), '\\section{Extra}\n\\section{B}\\label{sec:b}\nSee Section~\\ref{sec:a}.\n');
    const third = commit('Third');
    const renumbered = await builder.build(third, targets, await builder.build(third));
    assert.match(execFileSync('pdftotext', [renumbered.pdf, '-']).toString(), /Second draft\. See Section 3\./, 'References follow the seed, not the earlier build');
  } finally { f.close(); }
});

test('chapter comparisons reuse yesterday’s exact seed without compiling the full paper again', { skip: !tex && 'needs latexmk and pdflatex', timeout: 180000 }, async t => {
  const f = fixture(), epoch = process.env.SOURCE_DATE_EPOCH;
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  t.mock.timers.enable({ apis: ['Date'], now: yesterday.getTime() });
  delete process.env.SOURCE_DATE_EPOCH;
  try {
    fs.mkdirSync(path.join(f.root, 'chapters'));
    fs.writeFileSync(path.join(f.root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nDate: \\today.\n\\include{chapters/a}\n\\include{chapters/b}\n\\end{document}\n');
    fs.writeFileSync(path.join(f.root, 'chapters/a.tex'), '\\section{A}\\label{sec:a}\nOriginal wording. See Section~\\ref{sec:b}.\n');
    fs.writeFileSync(path.join(f.root, 'chapters/b.tex'), '\\section{B}\\label{sec:b}\nOther chapter.\n');
    const before = await workingTree(f.root), project = loadProject(f.root), builder = new Builder(project, f.repo);
    const seed = await builder.build(before);
    const seedLog = fs.readFileSync(path.join(path.dirname(seed.root), 'latexmk.log'));
    t.mock.timers.setTime(yesterday.getTime() + 86400000);
    fs.writeFileSync(path.join(f.root, 'chapters/a.tex'), '\\section{A}\\label{sec:a}\nRevised wording. See Section~\\ref{sec:b}.\n');
    const after = await workingTree(f.root), targets = await builder.planAsync(before, after, ['chapters/a.tex']);
    assert.deepEqual(targets, ['chapters/a']);
    const compile = builder.build.bind(builder), requested: string[][] = [];
    t.mock.method(builder, 'build', (...args: Parameters<Builder['build']>) => { requested.push(args[1] ?? ['full']); return compile(...args); });
    const reused = await builder.buildSeed(before);
    assert.equal(reused.key, seed.key);
    assert.deepEqual(requested, [], 'a cached seed starts no compiler, even on a new day');
    const [old, revised] = await Promise.all([builder.build(before, targets, reused), builder.build(after, targets, reused)]);
    assert.deepEqual(requested, [['chapters/a'], ['chapters/a']], 'both comparison builds compile only the affected chapter');
    assert.deepEqual(fs.readFileSync(path.join(path.dirname(seed.root), 'latexmk.log')), seedLog);
    const text = (pdf: string) => execFileSync('pdftotext', [pdf, '-']).toString();
    const oldText = text(old.pdf), revisedText = text(revised.pdf);
    assert.match(revisedText, /Revised wording\. See Section 2\./);
    assert.doesNotMatch(revisedText, /Other chapter\./, 'the other chapter is not typeset');
    assert.equal(oldText.match(/Date: ([^.]+)\./)?.[1], revisedText.match(/Date: ([^.]+)\./)?.[1], 'both comparison sides use the same current date');
    assert.notEqual(text(seed.pdf).match(/Date: ([^.]+)\./)?.[1], revisedText.match(/Date: ([^.]+)\./)?.[1], 'the seed’s old date does not leak into the displayed comparison');

    // Ordinary PDF requests still update today, and forced rebuilds still
    // work. Neither is allowed to change a cached baseline in place.
    const full = await builder.build(before);
    assert.notEqual(full.key, seed.key);
    assert.match(text(full.pdf), /Other chapter\./);
    assert.equal(text(full.pdf).match(/Date: ([^.]+)\./)?.[1], revisedText.match(/Date: ([^.]+)\./)?.[1]);
    const forced = await builder.build(before, ['full'], null, { force: true });
    assert.notEqual(forced.key, full.key);

    // Missing chapter auxiliaries cannot masquerade as a usable seed just
    // because the corresponding PDF still exists, including today's cache.
    for (const built of [seed, full, forced]) fs.rmSync(path.join(path.dirname(built.pdf), 'chapters/b.aux'));
    const repaired = await builder.buildSeed(before);
    assert.ok(![seed.key, full.key, forced.key].includes(repaired.key));
    assert.ok(fs.existsSync(path.join(path.dirname(repaired.pdf), 'chapters/b.aux')));

    const changed = await builder.buildSeed(after);
    assert.notEqual(changed.tree, seed.tree, 'a seed of another source version is never reused');
    assert.match(text(changed.pdf), /Revised wording/);
    const configured = new Builder({ ...project, preload: { 'chapters/b': 'chapters/b.tex' } }, f.repo);
    assert.notEqual((await configured.buildSeed(before)).key, repaired.key, 'changed build settings invalidate seed reuse');
  } finally {
    t.mock.timers.reset();
    if (epoch === undefined) delete process.env.SOURCE_DATE_EPOCH; else process.env.SOURCE_DATE_EPOCH = epoch;
    f.close();
  }
});

for (const entry of ['comparison', 'agent preview']) test(`${entry} recovers an incompatible cached seed after an external package update`, { skip: !tex && 'needs latexmk and pdflatex', timeout: 180000 }, async t => {
  const f = fixture(), epoch = process.env.SOURCE_DATE_EPOCH, inputs = process.env.TEXINPUTS;
  const yesterday = Date.now() - 86400000, external = path.join(f.base, 'external');
  t.mock.timers.enable({ apis: ['Date'], now: yesterday });
  delete process.env.SOURCE_DATE_EPOCH;
  fs.mkdirSync(external);
  process.env.TEXINPUTS = `${external}//:${inputs ?? ''}`;
  let app: App | undefined;
  try {
    const style = path.join(external, 'seedcompat.sty');
    fs.writeFileSync(style, String.raw`\ProvidesPackage{seedcompat}
\newcommand\oldauxcommand{}
\makeatletter\AtBeginDocument{\immediate\write\@auxout{\string\oldauxcommand}}\makeatother
`);
    fs.writeFileSync(path.join(f.root, 'main.tex'), '\\documentclass{article}\n\\usepackage{seedcompat}\n\\begin{document}\n\\include{a}\n\\include{b}\n\\end{document}\n');
    fs.writeFileSync(path.join(f.root, 'a.tex'), '\\section{A}\nOriginal wording. See Section~\\ref{sec:b}.\n');
    fs.writeFileSync(path.join(f.root, 'b.tex'), '\\section{B}\\label{sec:b}\nOther chapter.\n');
    f.repo.run(['add', '-A']);
    f.repo.run(['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'Fixture']);
    app = new App(f.root);
    const task = app.tasks.create('recovery'), builder = new Builder(app.project, app.repo);
    const old = await builder.build(task.base);
    t.mock.timers.setTime(yesterday + 86400000);
    // Installed packages can change while the source tree and compiler's
    // version stay identical. Yesterday's readable aux is now incompatible.
    fs.writeFileSync(style, '\\ProvidesPackage{seedcompat}\n');
    fs.writeFileSync(path.join(task.worktree, 'a.tex'), '\\section{A}\nRevised wording. See Section~\\ref{sec:b}.\n');
    const original = Builder.prototype.build, requests: { targets: string[]; force: boolean; seed?: string }[] = [], completed: BuildInfo[] = [];
    let auxiliaryFailures = 0;
    t.mock.method(Builder.prototype, 'build', async function (this: Builder, ...args: Parameters<Builder['build']>) {
      requests.push({ targets: args[1] ?? ['full'], force: Boolean(args[3]?.force), seed: args[2]?.key });
      try { const built = await original.apply(this, args); completed.push(built); return built; }
      catch (error) { if (auxiliaryBuildError(error)) auxiliaryFailures++; throw error; }
    });
    if (entry === 'comparison') {
      const job = app.publisher.submit(task.name, undefined, false);
      await app.publisher.join();
      assert.equal(app.publisher.job(job.id).status, 'done', JSON.stringify(app.publisher.job(job.id).result));
    } else {
      const result = await view(app, task.name, { locations: ['a.tex:2'] });
      assert.equal(result.error, undefined, JSON.stringify(result.details));
      assert.equal(result.pages.length, 1);
    }
    assert.equal(auxiliaryFailures, entry === 'comparison' ? 2 : 1, 'the real compiler rejected the cached auxiliary file');
    assert.deepEqual(requests.filter(request => request.targets[0] === 'full'), [{ targets: ['full'], force: true, seed: undefined }], 'only the failed seed is rebuilt, exactly once');
    const fresh = await builder.buildSeed(task.base);
    assert.notEqual(fresh.key, old.key);
    assert.deepEqual(requests.filter(request => request.targets[0] !== 'full').map(request => request.seed), entry === 'comparison' ? [old.key, old.key, fresh.key, fresh.key] : [old.key, fresh.key]);
    const chapters = completed.filter(built => built.targets[0] !== 'full');
    assert.equal(chapters.length, entry === 'comparison' ? 2 : 1);
    for (const built of chapters) {
      const text = execFileSync('pdftotext', [built.pdf, '-']).toString();
      assert.match(text, /(?:Original|Revised) wording\. See Section 2\./);
      assert.doesNotMatch(text, /Other chapter\./);
    }
    if (entry === 'comparison') assert.equal(app.review.round(task.name, 1).summary.builds?.[0], fresh.key, 'the round retains the rebuilt seed for its comparison');
    assert.ok(fs.existsSync(old.pdf), 'recovery does not overwrite an existing PDF');
  } finally {
    await app?.close();
    t.mock.timers.reset();
    if (epoch === undefined) delete process.env.SOURCE_DATE_EPOCH; else process.env.SOURCE_DATE_EPOCH = epoch;
    if (inputs === undefined) delete process.env.TEXINPUTS; else process.env.TEXINPUTS = inputs;
    f.close();
  }
});
