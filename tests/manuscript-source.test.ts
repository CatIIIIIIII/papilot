import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { opcodes } from '../engine/src/core/diff.ts';
import { sourceRange as paragraph } from '../engine/src/render/locate.ts';
import { PdfDocument } from '../engine/src/render/pdf.ts';
import { Manuscripts } from '../src/server/manuscript.ts';
import { editableRange, followRange, locateSource, placeSource, readFile, revision, saveSource } from '../src/server/manuscript-source.ts';

const numbered = (count: number, prefix = 'line') => Array.from({ length: count }, (_, index) => `${prefix} ${index}\n`);

test('a compiled passage is followed to the file as it is now', () => {
  const before = numbered(10);
  assert.deepEqual(followRange(10, 3, 5, opcodes(before, before)), { start: 3, end: 5, drifted: false }, 'an unchanged file keeps its lines');
  const shifted = ['new a\n', 'new b\n', ...before];
  assert.deepEqual(followRange(12, 3, 5, opcodes(before, shifted)), { start: 5, end: 7, drifted: false }, 'lines added above move the passage');
  const inside = [...before]; inside[4] = 'edited 4\n';
  assert.deepEqual(followRange(10, 3, 5, opcodes(before, inside)), { start: 3, end: 5, drifted: true }, 'an edit inside the passage marks it');
  const across = [...before.slice(0, 2), 'one line for 2-4\n', ...before.slice(5)];
  const widened = followRange(across.length, 3, 7, opcodes(before, across));
  assert.equal(widened.start, 2, 'an edit across the start widens the passage instead of cutting it');
  assert.equal(widened.drifted, true);
  assert.deepEqual(across.slice(widened.start, widened.end), ['one line for 2-4\n', 'line 5\n', 'line 6\n']);
  const gone = [...before.slice(0, 3), ...before.slice(5)];
  assert.deepEqual(followRange(gone.length, 3, 5, opcodes(before, gone)), { start: 3, end: 3, drifted: true }, 'a deleted passage leaves an empty range in its place');
  assert.deepEqual(followRange(4, 3, 9, null), { start: 3, end: 4, drifted: true }, 'without a comparison the same lines are kept, within the file');
});

test('the editable range is the paragraph, and long passages stay bounded', () => {
  const lines = ['\\section{Intro}\n', 'First paragraph one.\n', 'First paragraph two.\n', '\n', 'Second one.\n', 'Second two.\n', 'Second three.\n', '\n', 'Third.\n'];
  assert.deepEqual(editableRange(lines, 5, 6, paragraph), [4, 7], 'a click opens its whole paragraph');
  assert.deepEqual(editableRange(lines, 1, 2, paragraph), [1, 3], 'a section heading bounds a paragraph');
  const long = numbered(200, 'word');
  const [from, to] = editableRange(long, 120, 121, paragraph);
  assert.ok(from <= 120 && to >= 121 && to - from <= 40, `a long paragraph keeps the lines around the click: ${from}-${to}`);
  assert.deepEqual(editableRange(long, 10, 150, paragraph), [10, 150], 'a long passage is kept whole');
  assert.deepEqual(editableRange(numbered(400), 0, 400, paragraph), [0, 200], 'but never longer than 200 lines');
  assert.deepEqual(editableRange([], 0, 0, paragraph), [0, 0]);
});

test('a save replaces the file, keeps line endings, reports the changed lines, and refuses stale or unsafe edits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-source-save-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root }).toString().trim();
  try {
    fs.writeFileSync(path.join(root, 'main.tex'), 'one\ntwo\nthree\nfour\n');
    git('init', '-q'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'Paper');
    fs.writeFileSync(path.join(root, 'main.tex'), 'one\ntwo\nthree\nfour\nfive\n');
    const first = await readFile(root, 'main.tex');
    assert.equal(first.text, 'one\ntwo\nthree\nfour\nfive\n');
    assert.equal(first.base, 'one\ntwo\nthree\nfour\n', 'the last commit comes along, to show what changed');
    const saved = await saveSource('paper', root, { id: 'edit-1', file: 'main.tex', revision: first.revision, text: 'one\nTWO and THREE\nfour\nfive\n' });
    assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), 'one\nTWO and THREE\nfour\nfive\n');
    assert.deepEqual(saved.changed, [1, 2], 'the changed lines, in the saved file');
    assert.equal(saved.source.revision, revision(fs.readFileSync(path.join(root, 'main.tex'))));
    assert.equal(saved.source.base, first.base);
    const again = await saveSource('paper', root, { id: 'edit-1', file: 'main.tex', revision: first.revision, text: 'one\nTWO and THREE\nfour\nfive\n' });
    assert.deepEqual(again, saved, 'a retried save returns its result instead of a conflict');
    await assert.rejects(saveSource('paper', root, { id: 'edit-1', file: 'main.tex', revision: first.revision, text: 'Other' }), /already used/);
    await assert.rejects(saveSource('paper', root, { id: 'edit-2', file: 'main.tex', revision: first.revision, text: 'Stale' }),
      (error: Error & { statusCode?: number }) => error.statusCode === 409 && /changed while you were editing/.test(error.message));
    assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), 'one\nTWO and THREE\nfour\nfive\n', 'a stale save writes nothing');

    fs.writeFileSync(path.join(root, 'crlf.tex'), '\uFEFFalpha\r\nbeta\r\ngamma');
    const crlf = await readFile(root, 'crlf.tex');
    assert.equal(crlf.text.startsWith('alpha'), true, 'the byte order mark is not part of the text');
    assert.equal(crlf.base, null, 'a file that was never committed has no base');
    await saveSource('paper', root, { id: 'edit-3', file: 'crlf.tex', revision: crlf.revision, text: 'alpha\nBETA\nmore\ngamma' });
    assert.deepEqual(fs.readFileSync(path.join(root, 'crlf.tex')), Buffer.from('\uFEFFalpha\r\nBETA\r\nmore\r\ngamma'), 'CRLF and the byte order mark survive');

    fs.writeFileSync(path.join(root, 'figure.pdf'), Buffer.from([0x25, 0x50, 0x00, 0x01]));
    await assert.rejects(readFile(root, 'figure.pdf'), /not text/);
    await assert.rejects(readFile(root, '../outside.tex'), /cannot be edited/);
    await assert.rejects(readFile(root, '.git/config'), /cannot be edited/);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-source-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.tex'), 'secret\n');
    fs.symlinkSync(path.join(outside, 'secret.tex'), path.join(root, 'link.tex'));
    await assert.rejects(readFile(root, 'link.tex'), /cannot be edited/, 'a symbolic link is never followed out of the paper');
    fs.rmSync(outside, { recursive: true });
    await assert.rejects(readFile(root, 'missing.tex'), /no longer exists/);
    // 700,000 characters pass the length check but are 2,100,000 bytes in UTF-8.
    const unchanged = fs.readFileSync(path.join(root, 'main.tex'));
    await assert.rejects(saveSource('paper', root, { id: 'wide', file: 'main.tex', revision: saved.source.revision, text: '中'.repeat(700_000) }), /too large/);
    assert.deepEqual(fs.readFileSync(path.join(root, 'main.tex')), unchanged, 'a file too large to read back is never written');
    await assert.rejects(saveSource('paper', root, { id: 'bad id!', file: 'main.tex', revision: saved.source.revision, text: '' }), /Invalid source edit/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const latexmk = (() => {
  try {
    execFileSync('pdflatex', ['--version'], { stdio: 'ignore' });
    execFileSync('synctex', ['help'], { stdio: 'ignore' });
    return execFileSync('which', ['latexmk'], { encoding: 'utf8' }).trim();
  } catch { return ''; }
})();

test('a click on the PDF opens its source, a save compiles it, and the saved lines are found again', { skip: !latexmk && 'needs latexmk, pdflatex and synctex', timeout: 180000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-source-paper-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root }).toString().trim();
  const manuscripts = new Manuscripts(), intro = path.join(root, 'sections/intro.tex');
  async function settled() {
    for (let attempt = 0; attempt < 1200; attempt++) {
      const { build } = await manuscripts.state('paper', root);
      if (build.status !== 'building') return build;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Compilation did not finish');
  }
  try {
    fs.mkdirSync(path.join(root, 'sections'));
    fs.writeFileSync(path.join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}\n');
    fs.writeFileSync(intro, '\\section{Introduction}\nAn opening paragraph that sets the scene.\nIt has a second line of prose.\n\nA separate paragraph about pelicans.\nPelicans glide over the water.\n');
    git('init', '-q'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'Paper');
    const first = await settled();
    assert.equal(first.status, 'ready', first.error);
    const rectOf = (key: string, text: string) => {
      const document = new PdfDocument(manuscripts.pdf('paper', key)), page = document.page(0);
      try {
        const [x0, y0, x1, y1] = page.search(text)[0];
        return [x0 / page.width, y0 / page.height, x1 / page.width, y1 / page.height] as [number, number, number, number];
      } finally { document.close(); }
    };
    const pelicans = rectOf(first.key!, 'pelicans');
    const lines = (file: { text: string }, [from, to]: [number, number]) => file.text.split('\n').slice(from, to).join('\n') + '\n';
    const located = (await locateSource(manuscripts, 'paper', root, first.key!, 0, pelicans, [pelicans], 'pelicans')).source!;
    assert.equal(located.file, 'sections/intro.tex');
    assert.equal(located.text, fs.readFileSync(intro, 'utf8'), 'the whole file opens');
    assert.equal(located.base, located.text, 'nothing changed since the last commit');
    assert.equal(lines(located, located.passage), 'A separate paragraph about pelicans.\nPelicans glide over the water.\n', 'the click names its paragraph');
    assert.ok(located.focus[0] >= located.passage[0] && located.focus[1] <= located.passage[1] && located.focus[1] > located.focus[0]);
    assert.equal(located.drifted, false);

    // Lines added above since the PDF was compiled move the passage, not the answer.
    fs.writeFileSync(intro, '% A comment added in another editor\n\n' + fs.readFileSync(intro, 'utf8'));
    const moved = (await locateSource(manuscripts, 'paper', root, first.key!, 0, pelicans, [pelicans], 'pelicans')).source!;
    assert.equal(moved.passage[0], located.passage[0] + 2);
    assert.equal(lines(moved, moved.passage), lines(located, located.passage));

    const edited = moved.text.replace('A separate paragraph about pelicans.\nPelicans glide over the water.', 'A separate paragraph about herons.\nHerons wade in the shallows.');
    const saved = await saveSource('paper', root, { id: 'pelicans', file: moved.file, revision: moved.revision, text: edited });
    const tree = await manuscripts.written('paper', root);
    assert.deepEqual(saved.changed, moved.passage, 'the saved lines are the edited paragraph');
    const second = await settled();
    assert.equal(second.status, 'ready', second.error);
    assert.equal(second.tree, tree, 'the build of the save is recognizable by its tree');
    assert.notEqual(second.key, first.key);
    const replaced = (await locateSource(manuscripts, 'paper', root, first.key!, 0, pelicans, [pelicans], 'pelicans')).source!;
    assert.equal(lines(replaced, replaced.passage), lines(saved.source, saved.changed), 'a click on the PDF replaced a moment ago still opens the passage');
    assert.equal(replaced.drifted, true);
    const { place } = await placeSource(manuscripts, 'paper', second.key!, saved.source.file, saved.changed[0], saved.changed[1], 0);
    const herons = rectOf(second.key!, 'herons');
    assert.ok(place, 'the saved lines are found in the new PDF');
    assert.equal(place!.page, 0);
    assert.ok(place!.rect[1] <= herons[1] + 0.01 && place!.rect[3] >= herons[3] - 0.01, `the box covers the saved text: ${place!.rect} vs ${herons}`);

    // A save that does not compile keeps the last PDF and reports the error on its lines.
    const broken = await saveSource('paper', root, { id: 'broken', file: saved.source.file, revision: saved.source.revision, text: edited.replace('Herons wade in the shallows.', 'Herons \\undefinedcommand{wade}.') });
    const brokenTree = await manuscripts.written('paper', root);
    const third = await settled();
    assert.equal(third.status, 'failed');
    assert.equal(third.tree, brokenTree);
    assert.equal(third.key, second.key, 'the last PDF stays');
    const { problems } = await manuscripts.problems('paper');
    assert.ok(problems.some(problem => problem.severity === 'error' && problem.file === 'sections/intro.tex' && problem.line! >= broken.changed[0] + 1 && problem.line! <= broken.changed[1]),
      JSON.stringify(problems));
    // The old PDF still opens the source as it is now, including the broken
    // edit, and says that the clicked line changed since it was compiled.
    const shallows = rectOf(second.key!, 'shallows');
    const again = (await locateSource(manuscripts, 'paper', root, second.key!, 0, shallows, [shallows], 'shallows')).source!;
    assert.match(lines(again, again.passage), /undefinedcommand/);
    assert.equal(again.drifted, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
