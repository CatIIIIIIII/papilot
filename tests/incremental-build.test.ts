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
import { Changes } from '../src/server/changes.ts';
import * as mupdf from 'mupdf';
const pdfText = (file: string) => {
  const document = mupdf.Document.openDocument(fs.readFileSync(file), 'application/pdf');
  try {
    return Array.from({ length: document.countPages() }, (_, index) => {
      const page = document.loadPage(index), text = page.toStructuredText('');
      try { return text.asText(); } finally { text.destroy(); page.destroy(); }
    }).join(' ').replace(/\s+/g, ' ');
  } finally { document.destroy(); }
};

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
    assert.match(pdfText(second.pdf), /Second draft/);

    // A file TeX does not read changes: latexmk keeps the PDF, and the
    // SyncTeX data and log now name this build's folder.
    fs.writeFileSync(path.join(f.root, 'materials/notes.txt'), 'Still not part of the paper.\n');
    const third = await builder.build(await workingTree(f.root));
    assert.notEqual(third.key, second.key);
    assert.equal(runs(path.dirname(third.root)), 0, 'Unchanged inputs need no TeX run');
    const synctex = zlib.gunzipSync(fs.readFileSync(third.pdf.replace(/\.pdf$/, '.synctex.gz'))).toString().replaceAll('\\', '/');
    assert.ok(synctex.includes(third.cwd.split(path.sep).join('/') + '/') && !synctex.includes(path.dirname(second.root).split(path.sep).join('/')));
    assert.ok(!fs.readFileSync(third.pdf.replace(/\.pdf$/, '.log'), 'utf8').replaceAll('\\', '/').includes(path.dirname(second.root).split(path.sep).join('/')));
    assert.match(pdfText(third.pdf), /Second draft/);

    // The old .aux now calls a macro that no longer exists.
    fs.writeFileSync(path.join(f.root, 'main.tex'), paper('Third draft.'));
    const fourth = await builder.build(await workingTree(f.root));
    assert.match(pdfText(fourth.pdf), /Third draft/);
    assert.match(fs.readFileSync(path.join(project.state, 'logs', fourth.key + '.log'), 'utf8'), /build\/main\.aux:\d+: Undefined control sequence/, 'The continued build failed on stale state first');

    // A real error is reported once, without a clean retry hiding it.
    fs.writeFileSync(path.join(f.root, 'main.tex'), paper('Broken \\undefinedmacro draft.'));
    await assert.rejects(builder.build(await workingTree(f.root)), (error: any) => error.details.some((line: string) => /main\.tex:\d+: Undefined control sequence/.test(line)));
    fs.writeFileSync(path.join(f.root, 'main.tex'), paper('Fourth draft.'));
    const manual = await builder.build(await workingTree(f.root), ['full'], null, { force: true });
    assert.ok(runs(path.dirname(manual.root)) >= 2, 'Manual recompilation starts clean');
  } finally { f.close(); }
});

test('cached PDFs survive a new day; edits, manual rebuilds and explicit dates still compile', { skip: !tex && 'needs latexmk and pdflatex', timeout: 180000 }, async t => {
  const f = fixture(), epoch = process.env.SOURCE_DATE_EPOCH, forceDate = process.env.FORCE_SOURCE_DATE;
  delete process.env.SOURCE_DATE_EPOCH;
  delete process.env.FORCE_SOURCE_DATE;
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 6, 12) });
  const build = (rev: string, force = false) => new Builder(loadProject(f.root), new Repo(f.root)).build(rev, ['full'], null, { force });
  const text = pdfText;
  try {
    fs.writeFileSync(path.join(f.root, 'main.tex'), paper('First draft. \\today'));
    const rev = await workingTree(f.root), first = await build(rev);
    const bytes = fs.readFileSync(first.pdf);
    assert.match(text(first.pdf), /November 6, 2026/);

    t.mock.timers.setTime(new Date(2026, 10, 7, 12).getTime());
    const reopened = await build(rev);
    assert.equal(reopened.key, first.key, 'A new Builder on the next day reopens the same cached build');
    assert.deepEqual(fs.readFileSync(reopened.pdf), bytes);

    // A changed file outside TeX's inputs should not turn a new day into a
    // TeX pass either. Kept SyncTeX paths must still name the new folder.
    fs.writeFileSync(path.join(f.root, 'materials/notes.txt'), 'Not a TeX input.\n');
    const unrelated = await build(await workingTree(f.root));
    assert.notEqual(unrelated.key, first.key);
    assert.equal(runs(path.dirname(unrelated.root)), 0);
    assert.deepEqual(fs.readFileSync(unrelated.pdf), bytes);
    const synctex = zlib.gunzipSync(fs.readFileSync(unrelated.pdf.replace(/\.pdf$/, '.synctex.gz'))).toString().replaceAll('\\', '/');
    assert.ok(!synctex.includes(path.dirname(first.root).split(path.sep).join('/')));
    assert.ok(synctex.includes(unrelated.cwd.split(path.sep).join('/')));

    fs.writeFileSync(path.join(f.root, 'main.tex'), paper('Second draft. \\today'));
    const editedRev = await workingTree(f.root), edited = await build(editedRev);
    assert.equal(runs(path.dirname(edited.root)), 1);
    assert.match(text(edited.pdf), /Second draft/);
    assert.match(text(edited.pdf), /November 7, 2026/);

    t.mock.timers.setTime(new Date(2026, 10, 8, 12).getTime());
    const manual = await build(editedRev, true);
    assert.notEqual(manual.key, edited.key);
    assert.ok(runs(path.dirname(manual.root)) >= 2, 'Manual recompilation still starts clean');
    assert.match(text(manual.pdf), /November 8, 2026/);
    assert.equal((await build(editedRev)).key, manual.key, 'Reopening keeps the manually refreshed PDF');

    process.env.FORCE_SOURCE_DATE = '1';
    process.env.SOURCE_DATE_EPOCH = String(Date.UTC(2026, 10, 9, 12) / 1000);
    const fixed = await build(editedRev);
    assert.notEqual(fixed.key, edited.key);
    assert.match(text(fixed.pdf), /November 9, 2026/);
    assert.equal((await build(editedRev)).key, fixed.key, 'The explicit date can also be cached');
    const fixedBuilder = new Builder(loadProject(f.root), new Repo(f.root));
    t.mock.method(fixedBuilder, 'build', () => { throw new Error('An exact seed should need no build request'); });
    assert.equal((await fixedBuilder.buildSeed(editedRev)).key, fixed.key, 'Seed lookup uses the same explicit date context');
    process.env.SOURCE_DATE_EPOCH = String(Date.UTC(2026, 10, 10, 12) / 1000);
    const changedDate = await build(editedRev);
    assert.notEqual(changedDate.key, fixed.key);
    assert.match(text(changedDate.pdf), /November 10, 2026/);
  } finally {
    if (epoch === undefined) delete process.env.SOURCE_DATE_EPOCH; else process.env.SOURCE_DATE_EPOCH = epoch;
    if (forceDate === undefined) delete process.env.FORCE_SOURCE_DATE; else process.env.FORCE_SOURCE_DATE = forceDate;
    t.mock.timers.reset();
    f.close();
  }
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
    assert.match(pdfText(continued.pdf), /Second draft\. See Section 2\./);

    // Another chapter gains a section, so Section B is renumbered in the new seed.
    fs.writeFileSync(path.join(f.root, 'chapters/b.tex'), '\\section{Extra}\n\\section{B}\\label{sec:b}\nSee Section~\\ref{sec:a}.\n');
    const third = commit('Third');
    const renumbered = await builder.build(third, targets, await builder.build(third));
    assert.match(pdfText(renumbered.pdf), /Second draft\. See Section 3\./, 'References follow the seed, not the earlier build');
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
    const yesterdayBaseline = await builder.build(before, ['chapters/a'], seed);
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
    assert.notEqual(old.key, yesterdayBaseline.key, 'A cached chapter baseline must use the comparison date');
    assert.deepEqual(requested, [['chapters/a'], ['chapters/a']], 'both comparison builds compile only the affected chapter');
    assert.deepEqual(fs.readFileSync(path.join(path.dirname(seed.root), 'latexmk.log')), seedLog);
    const text = (pdf: string) => pdfText(pdf);
    const oldText = text(old.pdf), revisedText = text(revised.pdf);
    assert.match(revisedText, /Revised wording\. See Section 2\./);
    assert.doesNotMatch(revisedText, /Other chapter\./, 'the other chapter is not typeset');
    assert.equal(oldText.match(/Date: ([^.]+)\./)?.[1], revisedText.match(/Date: ([^.]+)\./)?.[1], 'both comparison sides use the same current date');
    assert.notEqual(text(seed.pdf).match(/Date: ([^.]+)\./)?.[1], revisedText.match(/Date: ([^.]+)\./)?.[1], 'the seed’s old date does not leak into the displayed comparison');

    // Ordinary PDF requests also retain the cached date. Only a forced
    // rebuild refreshes it, without changing the cached baseline in place.
    const full = await builder.build(before);
    assert.equal(full.key, seed.key);
    assert.match(text(full.pdf), /Other chapter\./);
    assert.equal(text(full.pdf).match(/Date: ([^.]+)\./)?.[1], text(seed.pdf).match(/Date: ([^.]+)\./)?.[1]);
    const forced = await builder.build(before, ['full'], null, { force: true });
    assert.notEqual(forced.key, full.key);
    assert.equal(text(forced.pdf).match(/Date: ([^.]+)\./)?.[1], revisedText.match(/Date: ([^.]+)\./)?.[1]);

    // Missing chapter auxiliaries cannot masquerade as a usable seed just
    // because the corresponding PDF still exists, including today's cache.
    for (const pdf of new Set([seed.pdf, full.pdf, forced.pdf])) fs.rmSync(path.join(path.dirname(pdf), 'chapters/b.aux'));
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

for (const entry of ['task', 'uncommitted']) test(`${entry} full comparisons pin both dates across midnight without replacing ordinary preview caches`, { skip: !tex && 'needs latexmk and pdflatex', timeout: 180000 }, async t => {
  const f = fixture(), epoch = process.env.SOURCE_DATE_EPOCH;
  delete process.env.SOURCE_DATE_EPOCH;
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 6, 12) });
  let app: App | undefined;
  try {
    fs.writeFileSync(path.join(f.root, 'main.tex'), paper('Original wording. Date: \\today.'));
    const builder = new Builder(loadProject(f.root), f.repo);
    await builder.build(await workingTree(f.root));
    t.mock.timers.setTime(new Date(2026, 10, 7, 23, 59).getTime());
    fs.writeFileSync(path.join(f.root, 'materials/notes.txt'), 'Not a TeX input.\n');
    const before = await workingTree(f.root), preview = await builder.build(before);
    assert.equal(runs(path.dirname(preview.root)), 0);
    assert.match(pdfText(preview.pdf), /November 6, 2026/);
    f.repo.run(['add', '-A']);
    f.repo.run(['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'Fixture']);
    app = entry === 'task' ? new App(f.root) : undefined;
    const task = app?.tasks.create('dates');
    fs.writeFileSync(path.join(task?.worktree ?? f.root, 'main.tex'), paper('Revised wording. Date: \\today.'));
    const compile = Builder.prototype.build, dates: string[] = [], completed: BuildInfo[] = [];
    t.mock.method(Builder.prototype, 'build', function (this: Builder, ...args: Parameters<Builder['build']>) {
      const date = args[3]?.date;
      if (date) {
        dates.push(date.SOURCE_DATE_EPOCH);
        if (dates.length === 1) t.mock.timers.setTime(new Date(2026, 10, 8, 0, 1).getTime());
      }
      return compile.apply(this, args).then(built => { if (date) completed.push(built); return built; });
    });
    if (app && task) {
      const job = app.publisher.submit(task.name, undefined, true);
      await app.publisher.join();
      assert.equal(app.publisher.job(job.id).status, 'done', JSON.stringify(app.publisher.job(job.id).result));
    } else {
      const changes = new Changes(path.join(f.base, 'changes'));
      changes.indirectChanges = () => true;
      await changes.state('paper', f.root, 'csrf');
      while (changes.busyForUpdate) await new Promise(resolve => setTimeout(resolve, 25));
      const state = await changes.state('paper', f.root, 'csrf');
      assert.equal(state.state, 'reviewing', JSON.stringify(state.job));
    }
    assert.ok(dates.length >= 2);
    assert.equal(new Set(dates).size, 1, 'Baseline, revision and any variants share one date');
    assert.ok(completed.length >= 2);
    for (const built of completed) {
      assert.match(pdfText(built.pdf), /November 7, 2026/);
    }
    assert.equal((await builder.build(before)).key, preview.key, 'The ordinary preview remains cached across days');
  } finally {
    await app?.close();
    t.mock.timers.reset();
    if (epoch === undefined) delete process.env.SOURCE_DATE_EPOCH; else process.env.SOURCE_DATE_EPOCH = epoch;
    f.close();
  }
});

test('manual refresh pointers survive recent eviction, concurrent refreshes and output pruning', { skip: process.platform === 'win32' && 'uses a POSIX compiler stub', timeout: 180000 }, async () => {
  const f = fixture(), previousPath = process.env.PATH, previousMarker = process.env.PAPILOT_CACHE_MARKER;
  const bin = path.join(f.base, 'bin'), marker = path.join(f.base, 'marker');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pdflatex'), '#!/bin/sh\necho "pdfTeX cache test"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'latexmk'), '#!/bin/sh\nmkdir -p build\nif [ -e "$PAPILOT_CACHE_MARKER.fail" ]; then exit 1; fi\ncat main.tex "$PAPILOT_CACHE_MARKER" > build/main.pdf\n', { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  process.env.PAPILOT_CACHE_MARKER = marker;
  try {
    const snapshot = (source: string) => {
      fs.writeFileSync(path.join(f.root, 'main.tex'), source + '\n');
      f.repo.run(['add', '-A']);
      return f.repo.text(['write-tree']);
    };
    const rev = snapshot('Source A');
    const project = loadProject(f.root), builder = new Builder(project, f.repo);
    fs.writeFileSync(marker, 'original');
    const first = await builder.build(rev);
    fs.writeFileSync(marker, 'refreshed');
    const refreshed = await builder.build(rev, ['full'], null, { force: true });
    for (let i = 0; i < 16; i++) await builder.build(snapshot('Source ' + i));
    const recent = JSON.parse(fs.readFileSync(path.join(builder.cache, 'recent.json'), 'utf8')) as { key: string }[];
    assert.ok(!recent.some(entry => entry.key === refreshed.key));
    assert.equal((await new Builder(project, f.repo).build(rev)).key, refreshed.key);

    const concurrent = await Promise.all([builder.build(rev, ['full'], null, { force: true }), new Builder(project, f.repo).build(rev, ['full'], null, { force: true })]);
    const preferred = await builder.build(rev);
    assert.ok(concurrent.some(built => built.key === preferred.key));
    fs.writeFileSync(marker + '.fail', '');
    await assert.rejects(builder.build(rev, ['full'], null, { force: true }), /LaTeX failed/);
    fs.rmSync(marker + '.fail');
    assert.equal((await builder.build(rev)).key, preferred.key, 'A failed refresh does not replace a successful one');

    // Evict the refresh from the protected recent entries, then let prune
    // remove it while an older review keeps the superseded original PDF.
    await builder.build(snapshot('Other newest 1'));
    await builder.build(snapshot('Other newest 2'));
    for (const built of concurrent) fs.utimesSync(path.dirname(built.root), new Date(0), new Date(0));
    await builder.prune(new Set([first.key]), 0);
    assert.ok(!fs.existsSync(preferred.pdf));
    assert.ok(fs.existsSync(first.pdf));
    fs.writeFileSync(marker, 'rebuilt after pruning');
    const rebuilt = await new Builder(project, f.repo).build(rev);
    assert.notEqual(rebuilt.key, first.key);
    assert.match(fs.readFileSync(rebuilt.pdf, 'utf8'), /rebuilt after pruning/);
    assert.match(fs.readFileSync(first.pdf, 'utf8'), /original/);
    assert.equal((await builder.build(rev)).key, rebuilt.key);

    fs.rmSync(path.dirname(first.root), { recursive: true });
    fs.rmSync(path.dirname(rebuilt.root), { recursive: true });
    await builder.prune(new Set(), 0);
    assert.ok(!fs.existsSync(path.join(builder.cache, first.key + '.preferred.json')), 'Orphaned pointers are cleaned up');
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousMarker === undefined) delete process.env.PAPILOT_CACHE_MARKER; else process.env.PAPILOT_CACHE_MARKER = previousMarker;
    f.close();
  }
});

for (const entry of ['comparison', 'agent preview']) test(`${entry} recovers an incompatible cached seed after an external package update`, { skip: !tex && 'needs latexmk and pdflatex', timeout: 180000 }, async t => {
  const f = fixture(), epoch = process.env.SOURCE_DATE_EPOCH, inputs = process.env.TEXINPUTS;
  const yesterday = Date.now() - 86400000, external = path.join(f.base, 'external');
  t.mock.timers.enable({ apis: ['Date'], now: yesterday });
  delete process.env.SOURCE_DATE_EPOCH;
  fs.mkdirSync(external);
  process.env.TEXINPUTS = `${external.split(path.sep).join('/')}//${path.delimiter}${inputs ?? ''}`;
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
      const text = pdfText(built.pdf);
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
