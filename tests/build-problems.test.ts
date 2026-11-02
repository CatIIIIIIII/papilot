import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectProblems, countProblems, locateProblems, parseLatexLog, parseSynctexView, placementOrder, scrubLog, unwrapLog } from '../src/server/build-problems.ts';
import { Manuscripts } from '../src/server/manuscript.ts';
import { PdfDocument } from '../engine/src/render/pdf.ts';

const fixture = fs.readFileSync(new URL('./fixtures/problems.log', import.meta.url), 'utf8');
const methods = './chapters/a-rather-long-directory-name-for-wrapping/methods-and-a-long-file-name.tex';
const files = new Set(['./main.tex', methods, './chapters/results.tex', 'build/main.aux', 'build/main.out']);
const isFile = (name: string) => files.has(name) || name.startsWith('/usr/');
const brief = (problems: ReturnType<typeof parseLatexLog>) => problems.map(p => [p.kind, p.key ?? p.amount ?? null, p.input ?? null, p.line ?? null, p.end ?? null]);

test('a pdfTeX log yields each problem with the file and line it came from', () => {
  assert.deepEqual(brief(parseLatexLog(fixture, isFile)), [
    ['label', 'sec:intro', null, null, null],
    ['reference', 'sec:missing', './main.tex', 6, null],
    ['citation', 'knuth84', './main.tex', 6, null],
    // TeX broke this file name across two log lines.
    ['overfull', 285.5, methods, 2, 4],
    ['citation', 'missing2020', methods, 5, null],
    ['overfull', 157.2, './chapters/results.tex', 2, 3],
    ['overfull', 251.1, './chapters/results.tex', 4, 7],
    ['reference', 'sec:nope', './chapters/results.tex', 11, null],
    // Reported after results.tex closed, so it belongs to main.tex.
    ['reference', 'fig:nothing', './main.tex', 10, null],
  ]);
});

test('box contents and messages with parentheses do not change the current file', () => {
  const log = [
    '(./main.tex (./a.tex',
    'Overfull \\hbox (3.2pt too wide) in paragraph at lines 4--5',
    '\\OT1/cmr/m/n/10 an aside (which never closes',
    ' []',
    '',
    'Underfull \\hbox (badness 10000) in paragraph at lines 7--7',
    '[]\\OT1/cmr/m/n/10 text)',
    '',
    'Package natbib Warning: Citation `smith (2020)\' on page 2 undefined on input line',
    '(natbib)                9.',
    '',
    'LaTeX Warning: Reference `a\' on page 2 undefined on input line 12.',
    ') (fig. 2) (./b.tex',
    'Overfull \\hbox (0.4pt too wide) in paragraph at lines 3--3',
    '[]',
    '',
    'LaTeX Font Warning: Font shape `OT1/cmr/bx/sc\' undefined',
    '(Font)              using `OT1/cmr/bx/n\' instead on input line 2.',
    '',
    'Package hyperref Warning: Token not allowed in a PDF string (Unicode):',
    '(hyperref)                removing `math shift\' on input line 6.',
    '',
    'LaTeX Warning: There were undefined references.',
    '))',
  ].join('\n');
  const known = new Set(['./main.tex', './a.tex', './b.tex']);
  assert.deepEqual(brief(parseLatexLog(log, name => known.has(name))), [
    ['overfull', 3.2, './a.tex', 4, 5],
    ['citation', 'smith (2020)', './a.tex', 9, null],
    ['reference', 'a', './a.tex', 12, null],
    // Below the 1pt threshold: dropped. Font substitutions and summaries are ignored.
    ['other', null, './b.tex', 6, null],
  ]);
});

test('a failed build reports its error at the file and line TeX names', () => {
  const log = [
    '(./main.tex (./chapters/fig.tex',
    '',
    './chapters/fig.tex:2: LaTeX Error: File `figures/missing-plot\' not found.',
    '',
    'See the LaTeX manual or LaTeX Companion for explanation.',
    'Type  H <return>  for immediate help.',
    ' ...                                              ',
    '',
    'l.2 \\includegraphics{figures/missing-plot}',
    '                                          ',
    'I could not locate the file with any of these extensions: (and more',
    '.pdf,.png,.jpg',
    '',
    './chapters/fig.tex:2:  ==> Fatal error occurred, no output PDF file produced!',
  ].join('\n');
  const problems = parseLatexLog(log, name => ['./main.tex', './chapters/fig.tex'].includes(name));
  assert.deepEqual(brief(problems), [['missing-file', 'figures/missing-plot', './chapters/fig.tex', 2, null]]);
  assert.deepEqual(countProblems(problems), { errors: 1, warnings: 0, minor: 0 });
});

test('a remark repeated for many objects is listed once, and cleveref copies of labels are skipped', () => {
  const log = [
    '(./main.tex',
    ...[1, 2, 3].map(n => `pdfTeX warning (ext4): destination with the same identifier (name{equation.${n}}) has been already used, duplicate ignored`),
    '',
    "LaTeX Warning: Label `s:one' multiply defined.",
    '',
    "LaTeX Warning: Label `s:one@cref' multiply defined.",
    ')',
  ].join('\n');
  const problems = parseLatexLog(log, name => name === './main.tex');
  assert.deepEqual(problems.map(p => [p.kind, p.key ?? null, p.count ?? 1]), [['other', null, 3], ['label', 's:one', 1]]);
});

test('the source context after a pdfTeX warning cannot close the current file', () => {
  // hyperref's duplicate page anchor quotes the line from its left edge, so
  // the ")" of a parenthetical remark arrives without its "(".
  const log = [
    '(./main.tex (./chap.tex [1]',
    'pdfTeX warning (ext4): destination with the same identifier (name{page.1}) has ',
    'been already used, duplicate ignored',
    '<to be read again> ',
    '                   \\relax ',
    'l.4 ...that goes on and on and on and on) \\newpage',
    '                                                   [1]',
    '',
    "LaTeX Warning: Reference `c:missing' on page 2 undefined on input line 5.",
    '',
    ')',
    '',
    "LaTeX Warning: Reference `m:after' on page 2 undefined on input line 5.",
    ')',
  ].join('\n');
  const problems = parseLatexLog(log, name => ['./main.tex', './chap.tex'].includes(name));
  assert.deepEqual(problems.filter(p => p.kind === 'reference').map(p => [p.key, p.input]), [['c:missing', './chap.tex'], ['m:after', './main.tex']]);
  // TeX goes on printing after the context's indented second half, so a file
  // that ends there closes, and the next one opens, on that line.
  const next = [
    '(./main.tex (./a.tex',
    'pdfTeX warning (ext4): destination with the same identifier (name{equation.5}) ',
    'has been already used, duplicate ignored',
    '<to be read again> ',
    '                   \\relax ',
    'l.105 \\begin{equation}',
    '                      ) (./b.tex',
    "LaTeX Warning: Reference `b:one' on page 3 undefined on input line 4.",
    '',
    '))',
  ].join('\n');
  assert.deepEqual(parseLatexLog(next, name => ['./main.tex', './a.tex', './b.tex'].includes(name)).filter(p => p.kind === 'reference').map(p => [p.key, p.input]), [['b:one', './b.tex']]);
});

test('file names TeX wrapped inside a character, or with spaces, keep their file', () => {
  const name = './章节目录/第一部分的很长的目录名称用于测试/引言和背景介绍.tex', opened = Buffer.from('(' + name);
  // pdfTeX cuts at 79 bytes, here inside 背; LuaTeX breaks before a character that would not fit.
  let lua = 79; while ((opened[lua] & 0xc0) === 0x80) lua--;
  const isFile = (file: string) => ['./main.tex', name, './sub dir/my chapter.tex'].includes(file);
  for (const cut of [79, lua]) {
    const log = Buffer.concat([Buffer.from('(./main.tex\n'), opened.subarray(0, cut), Buffer.from('\n'), opened.subarray(cut), Buffer.from("\n\nLaTeX Warning: Reference `a:inside' on page 1 undefined on input line 3.\n\n)\n)\n")]);
    assert.deepEqual(brief(parseLatexLog(log, isFile)), [['reference', 'a:inside', name, 3, null]], `cut at ${cut} bytes`);
  }
  // pdfTeX prints a name with spaces without quotes.
  const spaced = "(./main.tex (./sub dir/my chapter.tex\n\nLaTeX Warning: Reference `c:in' on page 1 undefined on input line 1.\n\n)\n)";
  assert.deepEqual(brief(parseLatexLog(spaced, isFile)), [['reference', 'c:in', './sub dir/my chapter.tex', 1, null]]);
});

test('labels are looked up only in files TeX read, count once, and generated files are named rather than shown', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-labels-'));
  try {
    fs.mkdirSync(path.join(root, 'build'));
    fs.writeFileSync(path.join(root, 'main.tex'), '\\section{A}\\label{dup}\n\\input{chap}\n');
    fs.writeFileSync(path.join(root, 'chap.tex'), 'Text.\n\\section{B}\\label{dup}\n');
    fs.writeFileSync(path.join(root, 'main_old.tex'), '\\label{dup}\n');
    fs.writeFileSync(path.join(root, 'build/main.bbl'), '\\begin{thebibliography}{1}\n');
    const log = [
      '(./main.tex (build/main.aux',
      '',
      "LaTeX Warning: Label `dup' multiply defined.",
      '',
      ') (./chap.tex) (build/main.bbl',
      '',
      'Package biblatex Warning: The following entry could not be found',
      '(biblatex)                in the database: knuth',
      '',
      'build/main.bbl:5: Misplaced alignment tab character &.',
      'l.5 \\newblock {\\em Tables &',
      '                            ',
      '))',
    ].join('\n');
    const problems = collectProblems(log, { cwd: root, root, sourceDir: 'paper' });
    assert.deepEqual(problems.map(p => [p.kind, p.file ?? null, p.line ?? null]), [['label', 'paper/main.tex', 1], ['label', 'paper/chap.tex', 2], ['other', null, null], ['error', null, null]]);
    assert.equal(problems[3].message, 'main.bbl:5: Misplaced alignment tab character &.');
    assert.deepEqual(countProblems(problems), { errors: 1, warnings: 1, minor: 1 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('errors and warnings are placed before typesetting remarks when there are too many', () => {
  const severities = ['minor', 'minor', 'warning', 'minor', 'error'] as const;
  assert.deepEqual([...placementOrder(severities.map(severity => ({ severity })), 2)].sort(), [2, 4]);
});

test('the served log hides the build folder and home, even when home is the root', () => {
  assert.equal(scrubLog('/data/build/x.tex in /Users/me/paper', '/data/build', '/Users/me'), '…/x.tex in ~/paper');
  assert.equal(scrubLog('(/usr/share/a.sty)', undefined, '/'), '(/usr/share/a.sty)');
});

test('log lines TeX wrapped at 79 characters are joined again', () => {
  const long = 'x'.repeat(79);
  assert.deepEqual(unwrapLog(`${long}\nend\nshort\n`), [`${long}end`, 'short', '']);
});

test('synctex view records become boxes on zero-based pages', () => {
  assert.deepEqual(parseSynctexView('SyncTeX result begin\nOutput:main.pdf\nPage:2\nx:257.4\ny:134.7\nh:133.7\nv:136.7\nW:343.7\nH:8.8\nbefore:\nSyncTeX result end\n'),
    [{ page: 1, x: 257.4, y: 134.7, h: 133.7, v: 136.7, W: 343.7, H: 8.8 }]);
});

const latexmk = (() => {
  try { execFileSync('pdflatex', ['--version'], { stdio: 'ignore' }); execFileSync('synctex', ['help'], { stdio: 'ignore' }); return execFileSync('which', ['latexmk'], { encoding: 'utf8' }).trim(); } catch { return ''; }
})();

test('duplicate references on one source line do not shift the next problem to an earlier mark', { skip: !latexmk && 'needs TeX and SyncTeX' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-repeat-reference-'));
  try {
    fs.writeFileSync(path.join(root, 'main.tex'), String.raw`\documentclass{article}
\begin{document}
First \ref{a}; second \ref{a}; third \ref{b}.
\end{document}
`);
    execFileSync(latexmk, ['-pdf', '-synctex=1', '-interaction=nonstopmode', 'main.tex'], { cwd: root, stdio: 'ignore' });
    const problems = collectProblems(fs.readFileSync(path.join(root, 'main.log')), { cwd: root, root, sourceDir: '' });
    assert.deepEqual(problems.filter(p => p.kind === 'reference').map(p => [p.key, p.occurrence]), [['a', 0], ['b', 2]]);
    const pdf = path.join(root, 'main.pdf'), document = new PdfDocument(pdf), page = document.page(0);
    try {
      const located = await locateProblems(problems, pdf, () => page);
      const marks = page.search('??').sort((a, b) => a[0] - b[0]);
      assert.equal(marks.length, 3);
      const b = located.find(p => p.key === 'b')!, center = (marks[2][0] + marks[2][2]) / 2;
      assert.ok(b.rect && b.rect[0] * page.width + page.bounds[0] < center && b.rect[2] * page.width + page.bounds[0] > center, JSON.stringify(b));
      assert.equal('occurrence' in b, false);
      assert.equal(countProblems(located).warnings, 2);
    } finally { page.close(); document.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a compiled paper lists its problems on the pages where they appear', { skip: !latexmk && 'needs latexmk, pdflatex and synctex', timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-problems-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root }).toString().trim();
  const manuscripts = new Manuscripts();
  async function settled() {
    for (let attempt = 0; attempt < 600; attempt++) {
      const { build } = await manuscripts.state('paper', root);
      if (build.status !== 'building') return build;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Compilation did not finish');
  }
  try {
    fs.mkdirSync(path.join(root, 'chapters'));
    fs.writeFileSync(path.join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\n\\section{One}\\label{s:one}\nSee \\ref{s:missing} and \\cite{nobody}.\n\\input{chapters/two}\n\\end{document}\n');
    fs.writeFileSync(path.join(root, 'chapters/two.tex'), '\\section{Two}\\label{s:one}\n\\newpage\nLater \\ref{s:gone} here.\n\n\\noindent\\hbox{\\rule{1.2\\textwidth}{1pt}}\n\nThe end.\n');
    git('init', '-q'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'Paper');
    const build = await settled();
    assert.equal(build.status, 'ready', build.error);
    // The label defined twice is listed at both places but counts once.
    assert.deepEqual(build.problems, { errors: 0, warnings: 4, minor: 1 });
    const result = await manuscripts.problems('paper');
    assert.equal(result.key, build.key);
    const brief = result.problems.map(p => [p.kind, p.key ?? null, p.file, p.line, p.page]);
    assert.deepEqual(brief, [
      ['label', 's:one', 'main.tex', 3, 0],
      ['reference', 's:missing', 'main.tex', 4, 0],
      ['citation', 'nobody', 'main.tex', 4, 0],
      ['label', 's:one', 'chapters/two.tex', 1, 0],
      ['reference', 's:gone', 'chapters/two.tex', 3, 1],
      ['overfull', null, 'chapters/two.tex', 5, 1],
    ]);
    for (const problem of result.problems) assert.ok(problem.rect && problem.rect.every(value => value >= 0 && value <= 1), problem.kind);
    // The reference's mark is its "??", far narrower than the line.
    const missing = result.problems.find(p => p.key === 's:missing')!.rect!;
    assert.ok(missing[2] - missing[0] < 0.08, String(missing));
    assert.match(manuscripts.log('paper'), /Reference `s:missing'/);
    assert.doesNotMatch(manuscripts.log('paper'), new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    // A failure lists its error. TeX stopped before references resolved, so
    // its own warnings are dropped; the previous PDF stays, with its warnings.
    fs.writeFileSync(path.join(root, 'chapters/two.tex'), '\\section{Two}\n\\includegraphics{nowhere}\n');
    const failed = await settled();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.key, build.key);
    assert.deepEqual(failed.problems, { errors: 1, warnings: 4, minor: 1 });
    const errors = await manuscripts.problems('paper');
    assert.equal(errors.key, build.key);
    assert.deepEqual(errors.problems.map(p => [p.kind, p.file, p.line, p.page]), [['error', 'chapters/two.tex', 2, undefined], ...brief.map(([kind, , file, line, page]) => [kind, file, line, page])]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a failure outside TeX, or in a file TeX generated, still says what went wrong', { skip: !latexmk && 'needs latexmk, pdflatex and bibtex', timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-bib-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root }).toString().trim();
  const manuscripts = new Manuscripts();
  async function settled() {
    for (let attempt = 0; attempt < 600; attempt++) {
      const { build } = await manuscripts.state('paper', root);
      if (build.status !== 'building') return build;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Compilation did not finish');
  }
  try {
    fs.writeFileSync(path.join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nHello \\cite{knuth}.\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n');
    fs.writeFileSync(path.join(root, 'refs.bib'), '@book{knuth, author={Donald Knuth}, title={The TeXbook}, year={1984}, publisher={AW}}\n@article{broken, author = {A, title = {unterminated\n');
    git('init', '-q'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'Paper');
    // BibTeX fails; the TeX log has no error at all.
    assert.equal((await settled()).status, 'failed');
    const bibtex = (await manuscripts.problems('paper')).problems.filter(p => p.severity === 'error');
    assert.equal(bibtex.length, 1);
    assert.match(bibtex[0].message, /Illegal end of database file---line 2 of file refs\.bib/);
    assert.doesNotMatch(bibtex[0].message, /cache\/builds/);
    // TeX fails inside the .bbl that BibTeX wrote.
    fs.writeFileSync(path.join(root, 'refs.bib'), '@book{knuth, author={Donald Knuth}, title={Tables & Alignment}, year={1984}, publisher={AW}}\n');
    assert.equal((await settled()).status, 'failed');
    const bbl = (await manuscripts.problems('paper')).problems.filter(p => p.severity === 'error');
    assert.deepEqual(bbl.map(p => [p.message, p.file]), [['main.bbl:5: Misplaced alignment tab character &.', undefined]]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
