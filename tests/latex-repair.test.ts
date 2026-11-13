import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Manuscripts } from '../src/server/manuscript.ts';
import { loadProject, readBuildOverrides, saveBuildOverrides, writeSettings } from '../engine/src/core/config.ts';

const instances: Manuscripts[] = [];
after(async () => { for (const manuscripts of instances) await manuscripts.stop(); });

const tex = (() => {
  try {
    for (const command of ['latexmk', 'pdflatex']) execFileSync(command, ['--version'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
})();

function fixture(rc: string) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-latex-repair-')), root = path.join(base, 'paper');
  const previousData = process.env.PAPILOT_DATA;
  process.env.PAPILOT_DATA = path.join(base, 'data');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(root, rc)), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/main.tex'), '\\documentclass{article}\n\\begin{document}\nA repaired paper.\n\\end{document}\n');
  fs.writeFileSync(path.join(root, rc), '# Existing compiler configuration\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'Initial paper');
  const manuscripts = new Manuscripts();
  instances.push(manuscripts);
  return {
    root, manuscripts, git,
    async settled(target = manuscripts) {
      for (let attempt = 0; attempt < 600; attempt++) {
        const { build } = await target.state('paper', root);
        if (build.status !== 'building') return build;
        await setTimeout(50);
      }
      throw new Error('Compilation did not finish');
    },
    async close() {
      if (previousData === undefined) delete process.env.PAPILOT_DATA; else process.env.PAPILOT_DATA = previousData;
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

for (const rc of ['latexmkrc', 'config/build.latexmkrc']) test(`repairs source_dir while retaining the existing ${rc}`, { skip: !tex && 'needs latexmk and pdflatex', timeout: 60000 }, async () => {
  const f = fixture(rc);
  try {
    if (rc !== 'latexmkrc') writeSettings(f.root, { latexmkrc: rc });
    const failed = await f.settled();
    assert.equal(failed.status, 'failed');
    assert.match(failed.error!, /"source_dir" must contain the root document and its latexmkrc/);
    let settings: { main?: string; latexmkrc?: string } = {};
    const result = await f.manuscripts.repair('paper', f.root, failed.failureId!, async prompt => {
      settings = JSON.parse(prompt).settings;
      return JSON.stringify({ kind: 'settings', summary: 'Include the existing compiler configuration.', settings: { source_dir: '' } });
    });
    assert.equal(result.kind, 'settings');
    assert.equal(settings.main, 'src/main.tex');
    assert.equal(settings.latexmkrc, rc);
    assert.equal((await f.settled()).status, 'ready');
    assert.deepEqual(readBuildOverrides(f.root), { source_dir: '' });
    assert.equal(loadProject(f.root).latexmkrc, rc);
    const restarted = new Manuscripts();
    instances.push(restarted);
    const restored = await f.settled(restarted);
    assert.equal(restored.status, 'ready', restored.error);
    assert.ok(fs.existsSync(restarted.pdf('paper', restored.key!)));
    assert.equal(f.git('status', '--porcelain'), '', 'Repair settings stay outside the manuscript');
  } finally { await f.close(); }
});

test('a configuration failure does not let a repair enable a previously disabled latexmkrc', async () => {
  const f = fixture('latexmkrc');
  try {
    writeSettings(f.root, { source_dir: 'missing' });
    saveBuildOverrides(f.root, { ignoreLatexmkrc: true });
    const failed = await f.settled();
    assert.equal(failed.status, 'failed');
    assert.match(failed.error!, /"source_dir" must contain/);
    await assert.rejects(f.manuscripts.repair('paper', f.root, failed.failureId!, async () => JSON.stringify({
      kind: 'settings', summary: 'Enable the root compiler configuration.', settings: { source_dir: '', ignoreLatexmkrc: false },
    })), /The proposed settings would enable a different latexmkrc/);
    assert.deepEqual(readBuildOverrides(f.root), { ignoreLatexmkrc: true });
  } finally { await f.close(); }
});
