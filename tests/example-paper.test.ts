import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyExamplePaper } from '../src/server/example-paper.ts';

test('a bundled read-only example becomes an editable copy without changing the source', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-example-'));
  const source = path.join(temporary, 'source'), destination = path.join(temporary, 'paper');
  const sections = path.join(source, 'sections'), main = path.join(sections, 'main.tex');
  try {
    fs.mkdirSync(sections, { recursive: true });
    fs.mkdirSync(path.join(source, 'preview'));
    fs.writeFileSync(main, 'Original.\n', { mode: 0o444 });
    fs.writeFileSync(path.join(source, 'build.sh'), '#!/bin/sh\n', { mode: 0o555 });
    fs.writeFileSync(path.join(source, 'preview/main.pdf'), 'preview', { mode: 0o444 });
    fs.chmodSync(sections, 0o555);
    fs.chmodSync(source, 0o555);

    copyExamplePaper(source, destination);
    fs.appendFileSync(path.join(destination, 'sections/main.tex'), 'Edited.\n');
    fs.writeFileSync(path.join(destination, 'sections/new.tex'), 'New.\n');
    assert.equal(fs.readFileSync(main, 'utf8'), 'Original.\n');
    assert.equal(fs.statSync(main).mode & 0o222, 0, 'bundled files stay read-only');
    assert.equal(fs.statSync(sections).mode & 0o222, 0, 'bundled directories stay read-only');
    assert.ok(fs.statSync(path.join(destination, 'build.sh')).mode & 0o100, 'executable files remain executable');
    assert.ok(fs.existsSync(path.join(destination, 'preview/main.pdf')));

    const desktop = path.join(temporary, 'desktop');
    copyExamplePaper(source, desktop, { excludePreview: true });
    assert.ok(!fs.existsSync(path.join(desktop, 'preview')));
    fs.appendFileSync(path.join(desktop, 'sections/main.tex'), 'Edited.\n');
  } finally {
    fs.chmodSync(source, 0o755);
    fs.chmodSync(sections, 0o755);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
