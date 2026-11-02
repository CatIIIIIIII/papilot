import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Changes, stageLines, stagedLines, unstageLines } from '../src/server/changes.ts';
import { gitCommit, gitDiscard, gitStage, gitStatus } from '../src/server/manuscript.ts';
import { opcodes } from '../engine/src/core/diff.ts';

const lines = (...items: string[]) => items.map(item => item + '\n');
const hasTeX = (() => { try { execFileSync('latexmk', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-changes-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root }).toString().trim();
  git('init', '-q');
  // Papilot's own commits need an identity, which a CI runner lacks.
  for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@localhost'], ['commit.gpgsign', 'false']]) git('config', key, value);
  return { root, git, commit: (message: string) => git('commit', '-qm', message) };
}

test('one change is staged, found staged and unstaged without touching the others', () => {
  const head = lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k');
  const work = lines('a', 'B', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'K', 'l');
  // The working file replaces b and k and adds l; the first change is lines 1–2, the second 10–12.
  const first: [number, number] = [1, 2], second: [number, number] = [10, 12];
  const index = stageLines(head, work, second, opcodes);
  assert.deepEqual(index, lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'K', 'l'));
  assert.equal(stagedLines(index, work, second, opcodes), true);
  assert.equal(stagedLines(index, work, first, opcodes), false);
  assert.deepEqual(unstageLines(head, stageLines(index, work, first, opcodes), [10, 11], opcodes), lines('a', 'B', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'));
  // A deletion's working range is empty, and still meets its own difference.
  const removed = lines('a', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k');
  assert.equal(stagedLines(head, removed, [1, 1], opcodes), false);
  assert.deepEqual(stageLines(head, removed, [1, 1], opcodes), removed);
});

test('the Git panel stages whole files and commits only what is staged', async () => {
  const { root, git, commit } = repository();
  try {
    fs.writeFileSync(path.join(root, 'main.tex'), 'One.\n'); fs.writeFileSync(path.join(root, 'refs.bib'), '% refs\n');
    git('add', '.'); commit('Initial');
    fs.writeFileSync(path.join(root, 'main.tex'), 'One, revised.\n'); fs.writeFileSync(path.join(root, 'refs.bib'), '% refs, more\n');
    let status = await gitStage(root, ['main.tex'], true);
    assert.deepEqual(status.files.map(file => [file.path, file.staged, file.unstaged]), [['main.tex', true, false], ['refs.bib', false, true]]);
    await gitCommit(root, 'First batch', null);
    assert.equal(git('show', '--name-only', '--format=%s', 'HEAD'), 'First batch\n\nmain.tex');
    status = await gitStatus(root);
    assert.deepEqual(status.files.map(file => file.path), ['refs.bib']);
    await assert.rejects(gitCommit(root, 'Nothing staged', null), /Stage at least one change/);
    status = await gitStage(root, ['refs.bib'], true);
    status = await gitStage(root, ['refs.bib'], false);
    assert.equal(status.files[0].staged, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('discarding a file keeps its staged part and deletes only untracked files', async () => {
  const { root, git, commit } = repository();
  try {
    fs.writeFileSync(path.join(root, 'main.tex'), 'One.\n'); fs.writeFileSync(path.join(root, 'refs.bib'), '% refs\n');
    git('add', '.'); commit('Initial');
    fs.writeFileSync(path.join(root, 'main.tex'), 'One, staged.\n'); await gitStage(root, ['main.tex'], true);
    fs.writeFileSync(path.join(root, 'main.tex'), 'One, staged, then edited.\n');
    fs.writeFileSync(path.join(root, 'refs.bib'), '% refs, edited\n'); fs.writeFileSync(path.join(root, 'draft.tex'), 'Scratch.\n');
    await assert.rejects(gitDiscard(root, ['missing.tex']), /Select at least one changed file/);
    const status = await gitDiscard(root, ['main.tex', 'refs.bib', 'draft.tex']);
    assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), 'One, staged.\n', 'The staged version stays');
    assert.equal(fs.readFileSync(path.join(root, 'refs.bib'), 'utf8'), '% refs\n');
    assert.equal(fs.existsSync(path.join(root, 'draft.tex')), false);
    assert.deepEqual(status.files.map(file => [file.path, file.staged, file.unstaged]), [['main.tex', true, false]]);
    await assert.rejects(gitDiscard(root, ['main.tex']), /Select at least one changed file/, 'Only unstaged changes can be discarded');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the PDF comparison stages, reverts and restores single changes', { skip: !hasTeX && 'needs latexmk' }, async () => {
  const { root, git, commit } = repository();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-changes-state-'));
  const changes = new Changes(state);
  const paragraphs = (edits: Record<number, string>) => `\\documentclass{article}\n\\begin{document}\n${Array.from({ length: 24 }, (_, i) => `${edits[i] ?? `Paragraph ${i} of the paper.`}\n\n`).join('')}\\end{document}\n`;
  try {
    fs.writeFileSync(path.join(root, 'main.tex'), paragraphs({}));
    git('add', '.'); commit('Initial');
    fs.writeFileSync(path.join(root, 'main.tex'), paragraphs({ 2: 'Paragraph 2, now longer.', 20: 'A new paragraph 20.' }));
    fs.writeFileSync(path.join(root, 'main.aux'), 'build output');
    let page: any;
    for (let tries = 0; tries < 240; tries++) {
      page = await changes.state('p', root, 'token');
      if (page.state !== 'building') break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(page.state, 'reviewing', JSON.stringify(page.job));
    const [early, late] = changes.detail('p', page.latest).units;
    assert.deepEqual(changes.detail('p', page.latest).units.map((unit: any) => unit.file), ['main.tex', 'main.tex'], 'Untracked build output is left out');

    page = await changes.act('p', root, 'token', 'stage', page.latest, [late.id]);
    assert.deepEqual(page.decisions, { [early.id]: 'pending', [late.id]: 'accepted' });
    assert.match(git('diff', '--cached'), /\+A new paragraph 20\./);
    assert.doesNotMatch(git('diff', '--cached'), /now longer/);

    page = await changes.act('p', root, 'token', 'revert', page.latest, [early.id]);
    assert.equal(page.decisions[early.id], 'rejected');
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), /now longer/);
    assert.match(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), /A new paragraph 20\./);

    page = await changes.undo('p', root, 'token', page.undo.id);
    assert.deepEqual(page.restored, [early.id]);
    assert.match(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), /now longer/);
    assert.equal(page.decisions[late.id], 'accepted', 'Undoing a revert keeps what is staged');

    page = await changes.act('p', root, 'token', 'unstage', page.latest, [late.id]);
    assert.equal(git('diff', '--cached'), '');
  } finally {
    // Revert/undo can schedule another comparison. Let its build release the
    // repository lock before deleting the fixture, or it retries a missing path.
    for (let tries = 0; changes.busyForUpdate && tries < 240; tries++) await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(changes.busyForUpdate, false, 'Background comparisons must finish before removing the paper');
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true });
  }
});
