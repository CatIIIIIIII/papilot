import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Repo } from '../vendor/latex-review/src/core/git.ts';
import { Builder } from '../vendor/latex-review/src/core/build.ts';
import { loadProject } from '../vendor/latex-review/src/core/config.ts';
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
