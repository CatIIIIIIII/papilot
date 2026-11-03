import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { anchor, annotationTask, commitChanges, gitAbortMerge, gitCommit, gitDiff, gitFinishMerge, gitIgnore, gitRemote, gitStamp, gitStatus, mergeConflicts, parseStatus, parseSynctex, pdfWords, settleLines, sourceExcerpt, workingTree } from '../src/server/manuscript.ts';
import { readNotesInstructions } from '../src/notes.ts';
import type { Annotation } from '../src/shared.ts';

test('Git status parsing keeps branch counts, renames, untracked files and line counts', () => {
  const output = ['# branch.oid abc', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1', '1 .M N... 100644 100644 100644 a b chapters/intro file.tex', '2 R. N... 100644 100644 100644 a b R100 new.tex', 'old.tex', '? notes.md', ''].join('\0');
  const numstat = ['3\t1\tchapters/intro file.tex', '0\t0\t', 'old.tex', 'new.tex', ''].join('\0');
  assert.deepEqual(parseStatus(output, numstat), {
    branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1,
    files: [
      { path: 'chapters/intro file.tex', status: 'M', staged: false, unstaged: true, lines: [3, 1] },
      { path: 'new.tex', status: 'R', staged: true, unstaged: false, lines: [0, 0], from: 'old.tex' },
      { path: 'notes.md', status: '?', staged: false, unstaged: true },
    ],
  });
});

test('the working tree snapshot includes uncommitted edits without touching the index', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-manuscript-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root }).toString().trim();
  try {
    git('init', '-q');
    fs.writeFileSync(path.join(root, 'main.tex'), 'Original.\n');
    fs.writeFileSync(path.join(root, '.gitignore'), 'build/\n');
    git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'Initial');
    const committed = git('rev-parse', 'HEAD^{tree}');
    return Promise.resolve().then(async () => {
      assert.equal(await workingTree(root), committed);
      fs.writeFileSync(path.join(root, 'main.tex'), 'Accepted change.\n');
      fs.writeFileSync(path.join(root, 'notes.tex'), 'New file.\n');
      fs.mkdirSync(path.join(root, 'build')); fs.writeFileSync(path.join(root, 'build/main.pdf'), 'ignored');
      const tree = await workingTree(root);
      assert.notEqual(tree, committed);
      assert.equal(git('show', `${tree}:main.tex`), 'Accepted change.');
      assert.equal(git('show', `${tree}:notes.tex`), 'New file.');
      assert.throws(() => git('show', `${tree}:build/main.pdf`));
      assert.equal(git('diff', '--cached', '--name-only'), '', 'The real index stays untouched');
      assert.match(git('status', '--porcelain'), /\?\? notes\.tex/);
      const status = await gitStatus(root);
      assert.deepEqual(status.files.map(file => [file.path, file.status]), [['main.tex', 'M'], ['notes.tex', '?']]);
      assert.equal(status.head?.subject, 'Initial');
    }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
  } catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
});

test('SyncTeX output resolves to a normalized source path and line', () => {
  const output = 'SyncTeX result begin\nOutput:/b/src/build/main.pdf\nInput:/b/src/./chapters/intro.tex\nLine:21\nColumn:-1\nSyncTeX result end\n';
  assert.deepEqual(parseSynctex(output), { input: '/b/src/chapters/intro.tex', line: 21 });
  assert.equal(parseSynctex('SyncTeX result begin\nSyncTeX result end\n'), null);
});

test('PDF notes become one task that quotes each marked region and its source', () => {
  const note = (comment: string, extra: Partial<Annotation> = {}): Annotation => ({ id: comment, projectId: 'p', key: 'k', page: 1, rect: [0, 0, 1, 1], comment, quote: 'The operator applies a compatible revision.', source: { file: 'main.tex', lines: [31, 33] }, createdAt: 1, ...extra });
  const single = annotationTask([note('Define "compatible" here.')]);
  assert.equal(single.title, 'Define "compatible" here.');
  assert.match(single.instructions, /1\. Page 2 · main\.tex lines 31–33\n   PDF text: "The operator applies a compatible revision\."\n   Note: Define "compatible" here\./);
  const withSource = annotationTask([note('Explain the operator.', { source: { file: 'main.tex', lines: [30, 32], excerpt: '\\begin{equation}\n  D_{t+1} = D_t \\oplus \\Delta_t\n\\end{equation}' } })]);
  assert.match(withSource.instructions, /main\.tex lines 30–32\n   LaTeX source of the marked region:\n   ```latex\n   \\begin\{equation\}\n     D_\{t\+1\} = D_t \\oplus \\Delta_t\n   \\end\{equation\}\n   ```\n   PDF text:/);
  const many = annotationTask([note('Shorten.'), note('Redraw this figure.', { quote: '', source: { file: 'figures.tex', lines: [5, 5] }, page: 3 })]);
  assert.equal(many.title, 'Address 2 PDF notes');
  assert.match(many.instructions, /2\. Page 4 · figures\.tex line 5\n   Marked region: a figure, equation or other non-text area\n   Note: Redraw this figure\./);
});

test('the chat reads PDF notes back from the message that carried them', () => {
  const note = (comment: string, extra: Partial<Annotation> = {}): Annotation => ({ id: comment, projectId: 'p', key: 'k', page: 0, rect: [0, 0, 1, 1], comment, quote: 'Small Steps, Clearer Papers', source: { file: 'main.tex', lines: [10, 10], excerpt: '\\title{Small Steps}\n```' }, createdAt: 1, ...extra });
  const notes = [note('标题改一下'), note('Redraw this.\n\n2. Keep the axes.\n   Note: the legend too.', { quote: '', source: null, page: 2 }), note('Say "why".', { quote: 'two\nlines', source: { file: 'intro.tex', lines: [3, 5] } })];
  assert.deepEqual(readNotesInstructions(annotationTask(notes).instructions), [
    { where: 'Page 1 · main.tex line 10', quote: 'Small Steps, Clearer Papers', comment: '标题改一下' },
    { where: 'Page 3', quote: '', comment: 'Redraw this.\n\n2. Keep the axes.\n   Note: the legend too.' },
    { where: 'Page 1 · intro.tex lines 3–5', quote: 'two\nlines', comment: 'Say "why".' },
  ]);
  assert.equal(readNotesInstructions('Explain the operator more precisely.'), null);
  assert.equal(readNotesInstructions(annotationTask([note('x')]).instructions.replace('   Note: ', '   Comment: ')), null);
});

test('source excerpts keep the marked lines and shorten long ranges', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-excerpt-')), 'main.tex');
  try {
    fs.writeFileSync(file, Array.from({ length: 40 }, (_, i) => `line ${i + 1}   `).join('\n'));
    assert.equal(sourceExcerpt(file, [3, 5]), 'line 3\nline 4\nline 5');
    assert.equal(sourceExcerpt(file, [1, 30], 2), 'line 1\nline 2\n…');
    assert.equal(sourceExcerpt(file + '.missing', [1, 2]), undefined);
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test('notes settle on the source line that holds the marked words, not the one SyncTeX credits for the space before them', () => {
  const source = ['\\begin{equation}', ' D_{t+1}=D_t\\oplus\\Delta_t', '\\end{equation}', 'The operator $\\oplus$ applies a compatible revision. If two changes conflict,', 'the author requests a new proposal instead of silently replacing accepted text.', 'Compilation is a useful check, but it does not establish that the mathematical', 'meaning of a revised passage is correct. % not printed', '\\section{Discussion}'];
  const chars = (text: string) => [...text].map(c => ({ text: c }));
  const printed = chars('proposal instead of silently replacing accepted text. Compilation is a useful check, but it does not');
  const word = printed.findIndex((_, index) => printed.slice(index).map(c => c.text).join('').startsWith('Compilation'));
  // SyncTeX says line 5 for "Compilation", which starts line 6 of the source.
  assert.deepEqual(settleLines(source, [5, 5], anchor(printed, word, false), anchor(printed, word + 10, true)), [6, 6]);
  // A selection from "accepted" to "Compilation" spans both lines.
  const accepted = printed.findIndex((_, index) => printed.slice(index).map(c => c.text).join('').startsWith('accepted'));
  assert.deepEqual(settleLines(source, [5, 5], anchor(printed, accepted, false), anchor(printed, word + 10, true)), [5, 6]);
  // Subscripts and macros reduce to the same letters as the printed line.
  const equation = chars('The operator ⊕ applies a compatible revision. If two changes conflict, the author');
  assert.deepEqual(settleLines(source, [4, 5], anchor(equation, 4, false), anchor(equation, 11, true)), [4, 4]);
  // Text that is not in the source, like a typeset formula, keeps SyncTeX's lines.
  const formula = chars('Dt+1 = Dt ⊕ Δt');
  assert.deepEqual(settleLines(source, [2, 2], anchor(formula, 0, false), anchor(formula, 13, true)), [2, 2]);
  assert.deepEqual(settleLines([], [3, 4], null, null), [3, 4]);
});

test('the Git panel commits only the chosen files, shows diffs and syncs with the remote', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-git-'));
  const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const clone = (target: string) => {
    run(base, 'clone', '-q', remote, target);
    for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@localhost'], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(base, 'no-hooks')]]) run(target, 'config', key, value);
  };
  const remote = path.join(base, 'remote.git'), root = path.join(base, 'paper'), other = path.join(base, 'other');
  try {
    run(base, 'init', '-q', '--bare', '-b', 'main', remote);
    clone(root);
    fs.writeFileSync(path.join(root, 'main.tex'), 'Original.\n'); fs.writeFileSync(path.join(root, 'old.tex'), 'Chapter.\n'); fs.writeFileSync(path.join(root, 'notes.md'), 'Notes.\n');
    run(root, 'add', '.'); run(root, 'commit', '-qm', 'Initial'); run(root, 'push', '-q', '-u', 'origin', 'main');
    // A modified file, a staged rename, a new file, and a change staged elsewhere.
    fs.writeFileSync(path.join(root, 'main.tex'), 'Changed.\n');
    run(root, 'mv', 'old.tex', 'chapter.tex');
    fs.writeFileSync(path.join(root, 'extra.tex'), 'New.\n');
    fs.writeFileSync(path.join(root, 'notes.md'), 'Staged elsewhere.\n'); run(root, 'add', 'notes.md');
    let status = await gitStatus(root);
    assert.equal(status.remote, true);
    assert.equal(status.files.find(file => file.path === 'chapter.tex')?.from, 'old.tex');
    const diff = await gitDiff(root, 'main.tex');
    assert.match(diff.diff, /^-Original\.$/m); assert.match(diff.diff, /^\+Changed\.$/m); assert.equal(diff.truncated, false);
    assert.match((await gitDiff(root, 'extra.tex')).diff, /^\+New\.$/m);
    await assert.rejects(gitDiff(root, 'missing.tex'), /no uncommitted changes/);
    await assert.rejects(gitCommit(root, 'Nothing', ['missing.tex']), /Select at least one/);
    const hash = await gitCommit(root, 'Revise the introduction', ['main.tex', 'extra.tex', 'chapter.tex']);
    assert.equal(run(root, 'log', '-1', '--format=%h %s'), `${hash} Revise the introduction`);
    assert.deepEqual(run(root, 'show', '--name-status', '--format=', 'HEAD').split('\n').sort(), ['A\textra.tex', 'M\tmain.tex', 'R100\told.tex\tchapter.tex']);
    status = await gitStatus(root);
    assert.deepEqual(status.files.map(file => [file.path, file.status, file.staged]), [['notes.md', 'M', true]], 'The change staged elsewhere stays staged and uncommitted');
    assert.equal(status.ahead, 1);
    await gitRemote(root, 'push');
    assert.equal((await gitStatus(root)).ahead, 0);
    assert.equal(run(remote, 'log', '-1', '--format=%s', 'main'), 'Revise the introduction');
    // Another clone moves the remote ahead; fetch shows it, and pull fast-forwards.
    clone(other);
    fs.writeFileSync(path.join(other, 'other.tex'), 'From elsewhere.\n'); run(other, 'add', '.'); run(other, 'commit', '-qm', 'Elsewhere'); run(other, 'push', '-q');
    await gitRemote(root, 'fetch');
    assert.equal((await gitStatus(root)).behind, 1);
    await gitRemote(root, 'pull');
    status = await gitStatus(root);
    assert.equal(status.behind, 0);
    assert.equal(fs.readFileSync(path.join(root, 'other.tex'), 'utf8'), 'From elsewhere.\n');
    const lone = path.join(base, 'lone');
    run(base, 'init', '-q', lone);
    await assert.rejects(gitRemote(lone, 'push'), /no remote/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('word places come from the printed glyphs, one per word, in reading order', async () => {
  const fixture = path.join(import.meta.dirname, 'fixtures/outline.pdf');
  const pages = [await pdfWords(fixture, 0), await pdfWords(fixture, 1)];
  // The UI check serves this file; it must match what the server extracts.
  assert.deepEqual(pages, JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/outline-words.json'), 'utf8')));
  const words = pages[0].words, find = (text: string) => words.find(word => word[0] === text)!;
  assert.deepEqual([pages[0].width, pages[0].height], [612, 792]);
  const [fixtureWord, sentence] = [find('Fixture'), find('sentence')];
  assert.equal(fixtureWord[2], sentence[2], 'Words on one line share a baseline');
  assert.ok(fixtureWord[1] + fixtureWord[4] < sentence[1], 'A word ends before the next begins');
  assert.equal(words.filter(word => word[5]).length >= 2, true, 'Line ends are marked');
  await assert.rejects(pdfWords(fixture, 2), /not part of the manuscript/);
});

test('word text keeps characters beyond U+FFFF, such as math italic letters', async () => {
  // A font whose ToUnicode maps A and B to 𝐹 and 𝐺, the way pdfTeX writes math fonts.
  const mupdf = await import('mupdf'), document = new mupdf.PDFDocument();
  const font = document.addSimpleFont(new mupdf.Font('Times-Roman'));
  font.resolve().put('ToUnicode', document.addStream('/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfrange <41> <42> <D835DC39> endbfrange endcmap CMapName currentdict /CMap defineresource pop end end', {}));
  const resources = document.addObject(document.newDictionary()), fonts = document.newDictionary();
  fonts.put('F1', font); resources.put('Font', fonts);
  document.insertPage(-1, document.addPage([0, 0, 200, 100], 0, resources, 'BT /F1 12 Tf 20 50 Td (AB) Tj ET'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-math-'));
  try {
    fs.writeFileSync(path.join(root, 'math.pdf'), document.saveToBuffer('').asUint8Array());
    assert.deepEqual((await pdfWords(path.join(root, 'math.pdf'), 0)).words.map(word => word[0]), ['𝐹𝐺']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('build output goes into .gitignore by kind, and a commit message reads only the chosen changes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-ignore-'));
  const run = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  try {
    run('init', '-q', '-b', 'main');
    for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@localhost'], ['commit.gpgsign', 'false']]) run('config', key, value);
    fs.writeFileSync(path.join(root, 'main.tex'), 'Original.\n'); fs.writeFileSync(path.join(root, '.gitignore'), '*.pdf');
    run('add', '.'); run('commit', '-qm', 'Start the paper');
    fs.writeFileSync(path.join(root, 'main.tex'), 'Changed.\n');
    for (const file of ['main.aux', 'main.log', 'chapter.aux', 'main.synctex.gz', 'figure.tex']) fs.writeFileSync(path.join(root, file), 'x\n');
    fs.mkdirSync(path.join(root, '_minted-main')); fs.writeFileSync(path.join(root, '_minted-main', 'style.pygstyle'), 'x\n');
    const chosen = ['main.aux', 'main.log', 'chapter.aux', 'main.synctex.gz', '_minted-main/style.pygstyle', 'figure.tex', 'main.tex'];
    const status = await gitIgnore(root, chosen);
    // One pattern per kind; files that are not build output, and tracked files, stay.
    assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), '*.pdf\n\n# Build output\n_minted*/\n*.aux\n*.log\n*.synctex.gz\n');
    assert.deepEqual(status.files.map(file => file.path).sort(), ['.gitignore', 'figure.tex', 'main.tex']);
    // A pattern already present is not repeated.
    fs.writeFileSync(path.join(root, 'notes.aux'), 'x\n'); fs.appendFileSync(path.join(root, '.gitignore'), '!notes.aux\n');
    await assert.rejects(gitIgnore(root, ['figure.tex']), /None of the chosen files/);
    await gitIgnore(root, ['notes.aux']);
    assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').match(/^\*\.aux$/gm)?.length, 1);
    const changes = await commitChanges(root, ['main.tex', 'figure.tex']);
    assert.deepEqual(changes.files.map(file => file.path), ['main.tex', 'figure.tex']);
    assert.match(changes.patch, /-Original\.\n\+Changed\./);
    assert.match(changes.patch, /\+x/);
    assert.doesNotMatch(changes.patch, /gitignore/);
    assert.deepEqual(changes.recent, ['Start the paper']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a branch that diverged from its upstream merges, and a conflicted merge is finished or abandoned', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-merge-'));
  const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const remote = path.join(base, 'remote.git'), mine = path.join(base, 'mine'), theirs = path.join(base, 'theirs');
  const clone = (target: string) => {
    run(base, 'clone', '-q', remote, target);
    for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@localhost'], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(base, 'no-hooks')], ['pull.ff', 'only']]) run(target, 'config', key, value);
  };
  const edit = (root: string, file: string, text: string, message: string) => { fs.writeFileSync(path.join(root, file), text); run(root, 'add', file); run(root, 'commit', '-qm', message); };
  try {
    run(base, 'init', '-q', '--bare', '-b', 'main', remote);
    clone(mine);
    edit(mine, 'main.tex', 'Intro.\nMethod.\n', 'Start'); edit(mine, 'refs.bib', 'A\n', 'Add references'); run(mine, 'push', '-q', '-u', 'origin', 'main');
    clone(theirs);
    // Changes to different files merge on their own, even where pull.ff=only.
    edit(theirs, 'refs.bib', 'A\nB\n', 'Cite B'); run(theirs, 'push', '-q');
    edit(mine, 'main.tex', 'Intro.\nBetter method.\n', 'Improve the method'); await gitRemote(mine, 'fetch');
    let status = await gitStatus(mine);
    assert.deepEqual([status.ahead, status.behind, status.merging], [1, 1, null]);
    await assert.rejects(gitRemote(mine, 'pull'), /fast-forward/i);
    await gitRemote(mine, 'merge');
    status = await gitStatus(mine);
    assert.deepEqual([status.ahead, status.behind, status.merging, fs.readFileSync(path.join(mine, 'refs.bib'), 'utf8')], [2, 0, null, 'A\nB\n']);
    run(mine, 'push', '-q');
    // The same line changed on both sides stops the merge at a conflict.
    run(theirs, 'pull', '-q');
    edit(theirs, 'main.tex', 'Intro.\nTheir method.\n', 'Reword the method');
    run(theirs, 'push', '-q');
    edit(mine, 'main.tex', 'Intro.\nMy method.\n', 'Rewrite the method');
    fs.writeFileSync(path.join(mine, 'notes.md'), 'Draft.\n');
    await gitRemote(mine, 'merge');
    status = await gitStatus(mine);
    assert.match(status.merging!.message, /^Merge branch 'main'/);
    assert.deepEqual(status.merging!.conflicts, ['main.tex']);
    assert.deepEqual(await mergeConflicts(mine), { files: ['main.tex'], branch: 'main', upstream: 'origin/main', ours: ['Rewrite the method'], theirs: ['Reword the method'] });
    await assert.rejects(gitCommit(mine, 'Other work', ['notes.md']), /Finish or abort the merge/);
    await assert.rejects(gitRemote(mine, 'push'), /Finish or abort the merge/);
    await assert.rejects(gitFinishMerge(mine), /Resolve the conflicts in main.tex first/);
    // Once no markers remain the merge commits, leaving unrelated files alone.
    fs.writeFileSync(path.join(mine, 'main.tex'), 'Intro.\nMy method, reworded.\n');
    assert.deepEqual((await gitStatus(mine)).merging!.conflicts, []);
    const hash = await gitFinishMerge(mine);
    assert.equal(run(mine, 'rev-list', '--parents', '-n', '1', hash).split(' ').length, 3);
    status = await gitStatus(mine);
    assert.deepEqual([status.merging, status.files.map(file => file.path)], [null, ['notes.md']]);
    // Abandoning a conflicted merge restores the branch as it was.
    run(mine, 'push', '-q'); run(theirs, 'pull', '-q');
    edit(theirs, 'main.tex', 'Intro.\nTheirs again.\n', 'Change it again'); run(theirs, 'push', '-q');
    edit(mine, 'main.tex', 'Intro.\nMine again.\n', 'Mine again');
    await gitRemote(mine, 'merge');
    assert.ok((await gitStatus(mine)).merging);
    await gitAbortMerge(mine);
    assert.deepEqual([(await gitStatus(mine)).merging, fs.readFileSync(path.join(mine, 'main.tex'), 'utf8')], [null, 'Intro.\nMine again.\n']);
    await assert.rejects(gitAbortMerge(mine), /No merge is in progress/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("Git's state stamp moves with staging and commits but not with reading the status", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-stamp-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: root });
    git('init', '-q'); fs.writeFileSync(path.join(root, 'main.tex'), 'one\n'); git('add', 'main.tex'); git('commit', '-qm', 'first');
    const committed = gitStamp(root);
    await gitStatus(root);
    assert.equal(gitStamp(root), committed, 'reading the status leaves the stamp alone');
    fs.writeFileSync(path.join(root, 'main.tex'), 'two\n'); git('add', 'main.tex');
    const staged = gitStamp(root);
    assert.notEqual(staged, committed);
    git('commit', '-qm', 'second');
    assert.notEqual(gitStamp(root), staged);
    assert.equal(gitStamp(path.join(root, 'missing')), '', 'a folder outside Git has no stamp');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
