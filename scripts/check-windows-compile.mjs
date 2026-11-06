// Run with node --import tsx. Requires a real TeX installation, on any OS.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Repo } from '../engine/src/core/git.ts';
import { loadProject } from '../engine/src/core/config.ts';
import { Builder } from '../engine/src/core/build.ts';
import { SynctexIndex } from '../engine/src/render/synctex.ts';
import { stopAll } from '../engine/src/core/process.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Papilot 论文 & spaces '));
const repo = new Repo(root);
try {
  repo.run(['init', '-q']);
  fs.writeFileSync(path.join(root, '.latex-review.json'), JSON.stringify({ main: 'chapters\\main.tex', engine: 'pdflatex' }));
  fs.mkdirSync(path.join(root, 'chapters'));
  const main = path.join(root, 'chapters/main.tex');
  const document = text => `\\documentclass{article}\n\\begin{document}\n\\section{Test}\n${text}\n\\end{document}\n`;
  fs.writeFileSync(main, document('Windows source mapping.'));
  const commit = () => { repo.run(['add', '-A']); repo.run(['-c', 'user.name=Papilot Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'Test']); return repo.rev('HEAD'); };
  const first = commit(), project = loadProject(root), builder = new Builder(project, repo);
  assert.equal(project.main, 'chapters/main.tex');
  const before = await builder.build(first);
  assert.match(fs.readFileSync(before.pdf).subarray(0, 5).toString(), /%PDF-/);
  const locate = build => {
    const index = new SynctexIndex(build.pdf);
    try { assert.ok(index.view(path.join(build.cwd, 'main.tex'), 4).length > 0, 'real compiled SyncTeX must locate source lines'); }
    finally { index.close(); }
  };
  locate(before);
  fs.writeFileSync(main, document('The updated Windows manuscript.'));
  const after = await builder.build(commit());
  assert.notEqual(after.pdf, before.pdf);
  assert.match(fs.readFileSync(after.pdf).subarray(0, 5).toString(), /%PDF-/);
  locate(after);
  fs.writeFileSync(path.join(root, 'chapters/notes.txt'), 'A change outside the TeX document.\n');
  const reused = await builder.build(commit());
  assert.notEqual(reused.pdf, after.pdf);
  locate(reused);
  assert.equal(repo.text(['status', '--porcelain']), '');
  console.log('PASS: real compilation, revision rebuild, cached PDF reuse and SyncTeX in a Unicode/space/& path.');
} catch (error) {
  console.error('Compile fixture retained for diagnosis:', root);
  console.error(error);
  process.exitCode = 1;
} finally {
  stopAll();
  if (!process.exitCode) fs.rmSync(root, { recursive: true, force: true });
}
