import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectLatex } from '../src/server/latex-installation.ts';

test('LaTeX detection identifies the active distribution and associates macOS receipts with its binary', { skip: process.platform === 'win32' && 'file links need Windows Developer Mode' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-tex-'));
  try {
    const binary = path.join(directory, 'pdftex'), executable = path.join(directory, 'pdflatex');
    fs.writeFileSync(binary, '', { mode: 0o755 });
    fs.symlinkSync(binary, executable);
    let banner = 'pdfTeX 3.141592653-2.6-1.40.27 (TeX Live 2025)', receipt = '';
    let root = path.join(directory, 'texlive');
    const env = { PATH: directory };
    const probe = async (file: string, args: string[]) => {
      if (file === executable) { assert.deepEqual(args, ['--version']); return banner; }
      if (file === path.join(directory, 'kpsewhich')) return args[0] === '-var-value=TEXMFROOT' ? root : null;
      assert.equal(file, '/usr/sbin/pkgutil');
      assert.deepEqual(args, ['--file-info', fs.realpathSync(binary)]);
      return receipt;
    };
    assert.deepEqual(await detectLatex(env, 'darwin', probe), { distribution: 'TeX Live', version: '2025', path: root });
    receipt = 'pkgid: org.tug.mactex.gui2025';
    assert.equal((await detectLatex(env, 'darwin', probe))?.distribution, 'TeX Live', 'GUI apps alone are not evidence of this engine’s distribution');
    receipt = 'pkgid: org.tug.mactex.texlive2025';
    assert.equal((await detectLatex(env, 'darwin', probe))?.distribution, 'MacTeX');
    receipt = 'pkgid: org.tug.mactex.basictex2025';
    assert.equal((await detectLatex(env, 'darwin', probe))?.distribution, 'BasicTeX');
    assert.equal((await detectLatex(env, 'linux', probe))?.distribution, 'TeX Live');
    banner = 'MiKTeX-pdfTeX 4.22 (MiKTeX 24.1)';
    assert.deepEqual(await detectLatex(env, 'linux', probe), { distribution: 'MiKTeX', version: '24.1', path: root });
    banner = 'Custom TeX build'; root = '';
    assert.deepEqual(await detectLatex(env, 'linux', probe), { distribution: null, version: null, path: path.dirname(fs.realpathSync(binary)) });
    await assert.rejects(detectLatex(env, 'linux', async () => null), /Could not read/);
    fs.unlinkSync(executable);
    assert.equal(await detectLatex(env, 'linux', async () => { throw new Error('No commands should run when LaTeX is absent'); }), null);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('LaTeX detection follows PATH order and can fall back to a working XeLaTeX', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-tex-path-'));
  try {
    const first = path.join(directory, 'first'), second = path.join(directory, 'second');
    for (const folder of [first, second]) {
      fs.mkdirSync(folder);
      for (const name of ['pdflatex', 'xelatex']) fs.writeFileSync(path.join(folder, name), '', { mode: 0o755 });
    }
    const visited: string[] = [];
    const result = await detectLatex({ PATH: [first, second].join(path.delimiter) }, 'linux', async file => {
      visited.push(file);
      return file === path.join(first, 'xelatex') ? 'XeTeX 3.141592653-2.6-0.999997 (TeX Live 2026)' : null;
    });
    assert.deepEqual(result, { distribution: 'TeX Live', version: '2026', path: fs.realpathSync(first) });
    assert.ok(visited.every(file => file.startsWith(first)), 'Do not query another installation’s kpsewhich or fall through PATH');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
