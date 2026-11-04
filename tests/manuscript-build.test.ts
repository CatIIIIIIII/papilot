import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Manuscripts, workingTree } from '../src/server/manuscript.ts';
import { PdfDocument } from '../engine/src/render/pdf.ts';
import type { Annotation } from '../src/shared.ts';

const latexmk = (() => {
  try {
    execFileSync('pdflatex', ['--version'], { stdio: 'ignore' });
    return execFileSync('which', ['latexmk'], { encoding: 'utf8' }).trim();
  } catch { return ''; }
})();

test('manual compilation runs TeX again on unchanged sources and preserves the last PDF on failure', { skip: !latexmk && 'needs latexmk and pdflatex', timeout: 60000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-recompile-'));
  const root = path.join(base, 'paper'), bin = path.join(base, 'bin');
  const calls = path.join(base, 'calls'), fail = path.join(base, 'fail');
  const previousPath = process.env.PATH;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root }).toString().trim();
  const manuscripts = new Manuscripts();
  const count = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').length : 0;
  async function settled(target = manuscripts) {
    for (let attempt = 0; attempt < 300; attempt++) {
      const { build } = await target.state('paper', root);
      if (build.status !== 'building') return build;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Compilation did not finish');
  }
  try {
    fs.mkdirSync(root); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nCompile this paper again.\n\\end{document}\n');
    git('init', '-q'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'Initial paper');
    // Count actual compiler launches, including a failure outside the source
    // tree; changing the TeX files would conceal the unchanged-source bug.
    fs.writeFileSync(path.join(bin, 'latexmk'), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)}, 'compile\\n');
if (fs.existsSync(${JSON.stringify(fail)})) { console.error('Compiler temporarily unavailable'); process.exit(1); }
const result = require('node:child_process').spawnSync(${JSON.stringify(latexmk)}, process.argv.slice(2), { stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
    process.env.PATH = bin + path.delimiter + previousPath;
    const tree = await workingTree(root);
    const first = await settled();
    assert.equal(first.status, 'ready', first.error);
    assert.equal(count(), 1);
    const originalPdf = manuscripts.pdf('paper', first.key!);
    const originalBytes = fs.readFileSync(originalPdf);
    const document = new PdfDocument(originalPdf), firstPage = document.page(0);
    const rects = firstPage.search('Compile this paper again.').map(([x0, y0, x1, y1]): Annotation['rect'] => [x0 / firstPage.width, y0 / firstPage.height, x1 / firstPage.width, y1 / firstPage.height]);
    document.close();
    assert.equal(rects.length, 1);
    const textNote: Annotation = { id: 'text', projectId: 'paper', key: first.key!, page: 0, rect: rects[0], rects, quote: 'Compile this paper again.', comment: 'Keep this instruction.', group: 'blue', source: null, createdAt: 1 };
    const regionNote: Annotation = { ...textNote, id: 'region', rects: undefined, group: undefined, comment: 'Keep the boxed region, too.' };
    await manuscripts.state('paper', root);
    assert.equal(count(), 1, 'Background reads reuse the successful build');

    const started = await manuscripts.state('paper', root, true);
    assert.equal(started.build.status, 'building', 'Clicking the green button must start a new build');
    assert.equal(started.build.key, first.key, 'Keep showing the last PDF while compiling');
    await Promise.all([manuscripts.state('paper', root, true), manuscripts.state('paper', root, true)]);
    const second = await settled();
    assert.equal(second.status, 'ready', second.error);
    assert.equal(count(), 2, 'Bypass the disk cache, but coalesce requests during a build');
    assert.notEqual(second.key, first.key, 'The browser receives a fresh PDF URL');
    assert.deepEqual(fs.readFileSync(originalPdf), originalBytes, 'Existing review PDFs are not overwritten');
    const preserved = await manuscripts.reanchor('paper', root, [textNote, regionNote]);
    assert.deepEqual(preserved.map(note => note.key), [second.key, second.key]);
    assert.deepEqual(preserved.map(note => [note.id, note.comment, note.quote, note.group]), [textNote, regionNote].map(note => [note.id, note.comment, note.quote, note.group]));
    const restarted = new Manuscripts(), restartedBuild = await settled(restarted);
    const recovered = await restarted.reanchor('paper', root, preserved);
    assert.deepEqual(recovered.map(note => note.key), [restartedBuild.key, restartedBuild.key], 'Saved PDF caches recover anchors after a server restart');

    const previousPdf = manuscripts.pdf('paper', second.key!);
    const previousBytes = fs.readFileSync(previousPdf);
    fs.writeFileSync(fail, 'fail');
    await manuscripts.state('paper', root, true);
    const failed = await settled();
    assert.equal(failed.status, 'failed');
    assert.equal(count(), 3);
    assert.equal(manuscripts.pdf('paper', failed.key!), previousPdf);
    assert.deepEqual(fs.readFileSync(previousPdf), previousBytes);
    await manuscripts.state('paper', root);
    assert.equal(count(), 3, 'A failed build waits for an explicit retry');

    fs.unlinkSync(fail);
    await manuscripts.state('paper', root, true);
    const retried = await settled();
    assert.equal(retried.status, 'ready', retried.error);
    assert.equal(count(), 4);
    assert.equal(await workingTree(root), tree, 'Recompiling does not edit the paper or its Git index');
    assert.equal(git('status', '--porcelain'), '');

    fs.writeFileSync(path.join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nA new opening paragraph.\\par\\vspace{2cm}\nCompile this paper again.\n\\end{document}\n');
    const movedBuild = await settled();
    assert.equal(movedBuild.status, 'ready', movedBuild.error);
    const moved = await manuscripts.reanchor('paper', root, preserved);
    assert.equal(moved[0].key, movedBuild.key, 'A unique text selection follows the paragraph');
    assert.ok(moved[0].rect[1] > preserved[0].rect[1]);
    assert.equal(moved[1].key, second.key, 'A region on a changed page waits for confirmation');
    fs.writeFileSync(path.join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nThe marked paragraph was removed.\n\\end{document}\n');
    await settled();
    const unresolved = await manuscripts.reanchor('paper', root, moved);
    assert.deepEqual(unresolved, moved, 'Removed or uncertain annotations are kept, not deleted or placed elsewhere');
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('AI review freezes the task copy and repositions only a surviving passage when copied to the manuscript', { skip: !latexmk && 'needs latexmk and pdflatex', timeout: 60000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-review-copy-')), root = path.join(base, 'paper'), worktree = path.join(base, 'task');
  fs.mkdirSync(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const manuscript = new Manuscripts();
  const tex = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
  async function ready() {
    for (let attempt = 0; attempt < 400; attempt++) {
      const { build } = await manuscript.state('paper', root);
      if (build.status !== 'building') { assert.equal(build.status, 'ready', build.error); return build; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Compilation did not finish');
  }
  try {
    const passage = 'The task copy keeps its original claim.';
    fs.writeFileSync(path.join(root, 'main.tex'), tex(passage));
    git('init', '-q'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'Initial');
    git('worktree', 'add', '--detach', worktree, 'HEAD');
    const changed = tex('New introductory material.\\newpage\n' + passage);
    fs.writeFileSync(path.join(root, 'main.tex'), changed);
    const captured = await manuscript.captureReview(root, worktree, 'review-copy');
    assert.ok(captured.pdf && fs.existsSync(captured.pdf));
    const originalPdf = fs.readFileSync(captured.pdf!);
    assert.ok(captured.lines.some(line => line.text === passage));
    assert.ok(!captured.lines.some(line => line.text.includes('New introductory')));
    const line = captured.lines.find(line => line.text === passage)!;
    const note: Annotation = { id: 'finding', projectId: 'paper', key: captured.key, page: line.page, rect: line.rect, rects: [line.rect], quote: passage, comment: 'Qualify this claim.', source: null, createdAt: 1 };
    await ready();
    const placed = await manuscript.placeReviewNote('paper', root, note, captured.pdf!);
    assert.equal(placed.page, 1);
    assert.equal(placed.comment, note.comment);
    assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), changed);
    assert.equal(fs.readFileSync(path.join(worktree, 'main.tex'), 'utf8'), tex(passage));
    assert.equal(git('diff', '--cached', '--name-only'), '');
    fs.writeFileSync(path.join(root, 'main.tex'), tex('An entirely different paper without the reviewed passage.'));
    await ready();
    await assert.rejects(manuscript.placeReviewNote('paper', root, note, captured.pdf!), /could not be located reliably/);
    assert.deepEqual(fs.readFileSync(captured.pdf!), originalPdf);
    const preserved = await new Manuscripts().preserveReviewPdf(root, 'review-copy', manuscript.pdf('paper', (await ready()).key!));
    assert.deepEqual(fs.readFileSync(preserved), originalPdf, 'a restarted server retains the original task PDF');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('AI review reports a task copy that does not compile and keeps no PDF for it', { skip: !latexmk && 'needs latexmk and pdflatex', timeout: 60000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-review-broken-')), root = path.join(base, 'paper'), worktree = path.join(base, 'task');
  fs.mkdirSync(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  try {
    fs.writeFileSync(path.join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\n\\undefinedcommand\n\\end{document}\n');
    git('init', '-q'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'Initial');
    git('worktree', 'add', '--detach', worktree, 'HEAD');
    const manuscript = new Manuscripts();
    await assert.rejects(manuscript.captureReview(root, worktree, 'broken-copy'), /could not be compiled for AI review/);
    assert.equal(await manuscript.savedReviewPdf(root, 'broken-copy'), null);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
