import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Repo } from '../vendor/latex-review/src/core/git.ts';

async function digest(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-export-')), root = path.join(base, 'repo');
  fs.mkdirSync(root); const repo = new Repo(root);
  repo.run(['init', '-q']);
  const commit = () => {
    repo.run(['add', '.']);
    repo.run(['-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture']);
  };
  return { base, root, repo, commit, close: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('exports a snapshot with a blob larger than 128 MiB without buffering it or changing the repository', { timeout: 30000 }, async () => {
  const f = fixture();
  try {
    const name = 'large figure\t图\n.bin', original = path.join(f.root, name);
    fs.writeFileSync(original, Buffer.from([0, 255, 13, 10]));
    fs.truncateSync(original, 129 * 1024 * 1024);
    fs.appendFileSync(original, Buffer.from([255, 0, 10, 1]));
    fs.writeFileSync(path.join(f.root, 'empty.tex'), '');
    fs.writeFileSync(path.join(f.root, 'main.tex'), 'Original source.\n');
    fs.writeFileSync(path.join(f.root, '.gitattributes'), 'main.tex export-ignore\n');
    f.commit();
    const head = f.repo.rev('HEAD'), index = fs.readFileSync(path.join(f.root, '.git/index'));
    fs.writeFileSync(path.join(f.root, 'main.tex'), 'Unsaved snapshot changes stay here.\n');
    const out = path.join(f.base, 'export');
    await f.repo.export(head, '', out);
    assert.equal(fs.statSync(path.join(out, name)).size, 129 * 1024 * 1024 + 4);
    assert.equal(await digest(path.join(out, name)), await digest(original));
    assert.equal(fs.statSync(path.join(out, 'empty.tex')).size, 0);
    assert.equal(fs.readFileSync(path.join(out, 'main.tex'), 'utf8'), 'Original source.\n');
    assert.equal(fs.readFileSync(path.join(f.root, 'main.tex'), 'utf8'), 'Unsaved snapshot changes stay here.\n');
    assert.equal(f.repo.rev('HEAD'), head); assert.deepEqual(fs.readFileSync(path.join(f.root, '.git/index')), index);
  } finally { f.close(); }
});

test('subdirectory exports preserve executable files and internal links, and reject escaping links', async () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.root, 'paper'));
    fs.writeFileSync(path.join(f.root, 'outside.txt'), 'Keep outside the export.');
    fs.writeFileSync(path.join(f.root, 'paper/run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    fs.symlinkSync('run.sh', path.join(f.root, 'paper/link'));
    f.commit();
    const out = path.join(f.base, 'export');
    await f.repo.export('HEAD', 'paper', out);
    assert.deepEqual(fs.readdirSync(out).sort(), ['link', 'run.sh']);
    assert.equal(fs.statSync(path.join(out, 'run.sh')).mode & 0o777, 0o755);
    assert.equal(fs.readlinkSync(path.join(out, 'link')), 'run.sh');
    fs.symlinkSync('../outside.txt', path.join(f.root, 'paper/escape')); f.commit();
    await assert.rejects(f.repo.export('HEAD', 'paper', path.join(f.base, 'unsafe')), /outside the document/);
    await assert.rejects(f.repo.export('missing-revision', '', path.join(f.base, 'missing')));
  } finally { f.close(); }
});

test('an export from an earlier one reads only changed files from Git and never trusts a rewritten copy', async () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.root, 'paper/figures'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'paper/main.tex'), 'First draft.\n');
    fs.writeFileSync(path.join(f.root, 'paper/figures/plot.pdf'), Buffer.alloc(4096, 7));
    fs.writeFileSync(path.join(f.root, 'paper/notes.tex'), 'Rewritten by a tool.\n');
    fs.writeFileSync(path.join(f.root, 'paper/removed.tex'), 'Removed later.\n');
    fs.writeFileSync(path.join(f.root, 'paper/run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    fs.symlinkSync('main.tex', path.join(f.root, 'paper/current.tex'));
    f.commit();
    const first = path.join(f.base, 'first'), before = f.repo.treeId('HEAD', 'paper');
    await f.repo.export('HEAD', 'paper', first);
    // A compiler may change files in its own copy; a different size marks it.
    fs.appendFileSync(path.join(first, 'notes.tex'), 'Generated text.\n');
    fs.mkdirSync(path.join(first, 'build')); fs.writeFileSync(path.join(first, 'build/main.aux'), 'Generated.');
    fs.writeFileSync(path.join(f.root, 'paper/main.tex'), 'Second draft.\n');
    fs.rmSync(path.join(f.root, 'paper/removed.tex'));
    fs.writeFileSync(path.join(f.root, 'paper/added.tex'), 'New section.\n');
    fs.rmSync(path.join(f.root, 'paper/current.tex')); fs.symlinkSync('added.tex', path.join(f.root, 'paper/current.tex'));
    f.commit();
    const second = path.join(f.base, 'second');
    await f.repo.export('HEAD', 'paper', second, { root: first, tree: before });
    // Only this tree's files remain: generated files and removed sources are gone.
    assert.deepEqual(fs.readdirSync(second).filter(name => name !== 'build').sort(), ['added.tex', 'current.tex', 'figures', 'main.tex', 'notes.tex', 'run.sh']);
    assert.equal(fs.existsSync(path.join(second, 'build/main.aux')), false);
    assert.equal(fs.readlinkSync(path.join(second, 'current.tex')), 'added.tex');
    assert.equal(fs.readFileSync(path.join(first, 'main.tex'), 'utf8'), 'First draft.\n', 'Replacing a linked file leaves the earlier export intact');
    assert.equal(fs.readFileSync(path.join(second, 'main.tex'), 'utf8'), 'Second draft.\n');
    assert.equal(fs.readFileSync(path.join(second, 'added.tex'), 'utf8'), 'New section.\n');
    assert.equal(fs.readFileSync(path.join(second, 'notes.tex'), 'utf8'), 'Rewritten by a tool.\n');
    assert.deepEqual(fs.readFileSync(path.join(second, 'figures/plot.pdf')), Buffer.alloc(4096, 7));
    assert.equal(fs.statSync(path.join(second, 'run.sh')).mode & 0o777, 0o755);
    // The copies are independent: changing the new export leaves the old one intact.
    fs.writeFileSync(path.join(second, 'figures/plot.pdf'), 'changed');
    assert.deepEqual(fs.readFileSync(path.join(first, 'figures/plot.pdf')), Buffer.alloc(4096, 7));
  } finally { f.close(); }
});
