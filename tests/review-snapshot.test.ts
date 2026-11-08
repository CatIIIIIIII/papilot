import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { Manuscripts } from '../src/server/manuscript.ts';
import { ReviewSnapshots } from '../src/server/review-snapshot.ts';
import type { ReviewSnapshot } from '../src/server/ai-review.ts';
import { PdfDocument, mupdf } from '../engine/src/render/pdf.ts';

const fixture = path.resolve('tests/fixtures/outline.pdf');
// The previous implementation is an independent oracle for persisted anchors,
// including blank-line numbering, glyph normalization and transformed pages.
function originalSnapshot(pdf: string, key: string): ReviewSnapshot {
  const document = new PdfDocument(pdf), lines: ReviewSnapshot['lines'] = [];
  try {
    for (let index = 0; index < document.length; index++) {
      const page = document.page(index), [left, top, right, bottom] = page.bounds;
      for (const [number, line] of page.lines.entries()) {
        const text = line.chars.map(char => char.text).join('').trim();
        if (!text) continue;
        const [x0, y0, x1, y1] = line.rect;
        const rect = [(x0 - left) / (right - left), (y0 - top) / (bottom - top), (x1 - left) / (right - left), (y1 - top) / (bottom - top)]
          .map(value => Math.max(0, Math.min(1, value))) as ReviewSnapshot['lines'][number]['rect'];
        if (rect[2] <= rect[0] || rect[3] <= rect[1]) continue;
        lines.push({ id: `p${index + 1}-l${number + 1}`, page: index, text, rect });
      }
    }
    return { key, lines };
  } finally { document.close(); }
}

test('worker snapshots preserve all existing anchors, including math, rotated and cropped pages', { timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-snapshot-')), snapshots = new ReviewSnapshots();
  try {
    const transformed = path.join(root, 'transformed.pdf');
    const source = mupdf.Document.openDocument(fs.readFileSync(fixture), 'application/pdf') as mupdf.PDFDocument;
    try {
      const page = source.findPage(0);
      page.put('Rotate', 90);
      page.put('CropBox', [30, 40, 550, 720]);
      const blank = source.addPage([0, 0, 612, 792], 0, {}, '');
      source.insertPage(0, blank);
      const buffer = source.saveToBuffer('');
      try { fs.writeFileSync(transformed, buffer.asUint8Array()); } finally { buffer.destroy(); }
    } finally { source.destroy(); }
    for (const pdf of [fixture, path.resolve('examples/papilot-paper/preview/main.pdf'), transformed]) {
      const key = createHash('sha256').update(fs.readFileSync(pdf)).digest('hex').slice(0, 16);
      const expected = originalSnapshot(pdf, key);
      assert.ok(expected.lines.length);
      assert.deepEqual(await snapshots.run(pdf), expected);
    }
    assert.equal((await snapshots.run(fixture, 'caller-key')).key, 'caller-key');
    assert.equal(snapshots.busy, false);
  } finally { await snapshots.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('missing, malformed and empty PDFs reject without poisoning queued extractions', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-snapshot-errors-')), snapshots = new ReviewSnapshots();
  try {
    const invalid = path.join(root, 'invalid.pdf'), blank = path.join(root, 'blank.pdf');
    fs.writeFileSync(invalid, 'This is not a PDF.');
    const document = new mupdf.PDFDocument();
    try {
      document.insertPage(-1, document.addPage([0, 0, 612, 792], 0, {}, ''));
      const buffer = document.saveToBuffer('');
      try { fs.writeFileSync(blank, buffer.asUint8Array()); } finally { buffer.destroy(); }
    } finally { document.destroy(); }
    const failures = [snapshots.run(path.join(root, 'missing.pdf')), snapshots.run(invalid), snapshots.run(blank)];
    const settled = Promise.allSettled(failures);
    const next = snapshots.run(fixture, 'after-error');
    const results = await settled;
    for (const result of results) assert.equal(result.status, 'rejected');
    assert.match((results[2] as PromiseRejectedResult).reason.message, /no selectable text/);
    assert.equal((await next).key, 'after-error');
  } finally { await snapshots.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('stopping rejects active, queued and later snapshots and releases the worker', { timeout: 60000 }, async () => {
  const manuscripts = new Manuscripts();
  const pending = Promise.allSettled([manuscripts.snapshotPdf(fixture, 'one'), manuscripts.snapshotPdf(fixture, 'two')]);
  assert.equal(manuscripts.busyForUpdate, true);
  await manuscripts.stop();
  for (const result of await pending) {
    assert.equal(result.status, 'rejected');
    assert.match((result as PromiseRejectedResult).reason.message, /stopped/);
  }
  assert.equal(manuscripts.busyForUpdate, false);
  await assert.rejects(manuscripts.snapshotPdf(fixture), /stopped/);
  await manuscripts.stop();
});

test('the CLI loader keeps HTTP responsive during extraction and serializes concurrent PDFs', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-snapshot-http-'));
  try {
    const render = path.join(root, 'src/render'); fs.mkdirSync(render, { recursive: true });
    fs.mkdirSync(path.join(root, 'src/core'));
    fs.writeFileSync(path.join(root, 'src/core/process.ts'), 'export function stopAll() {}');
    const started = path.join(root, 'started'), release = path.join(root, 'release');
    // Gate a real synchronous text walk until the host answers an HTTP request.
    // If extraction regresses to the host thread, it times out rather than passing
    // merely because timers ran during module loading before extraction began.
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(render, 'pdf.ts'), `
      import fs from 'node:fs';
      import { walkText as walk, mupdf } from ${JSON.stringify(new URL('../engine/src/render/pdf.ts', import.meta.url).href)};
      export { mupdf };
      let first = true;
      export function walkText(...args) {
        if (first) {
          first = false; fs.appendFileSync(${JSON.stringify(started)}, 'started\\n');
          const deadline = Date.now() + 15000, signal = new Int32Array(new SharedArrayBuffer(4));
          while (!fs.existsSync(${JSON.stringify(release)})) {
            if (Date.now() > deadline) throw new Error('HTTP could not run during PDF extraction');
            Atomics.wait(signal, 0, 0, 10);
          }
        }
        return walk(...args);
      }
    `);
    const bootstrap = path.join(root, 'probe.mjs');
    const loader = import.meta.resolve('tsx/esm/api');
    fs.writeFileSync(bootstrap, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import http from 'node:http';
      import { register } from ${JSON.stringify(loader)};
      register();
      const { Manuscripts } = await import(${JSON.stringify(new URL('../src/server/manuscript.ts', import.meta.url).href)});
      const manuscripts = new Manuscripts();
      const server = http.createServer((_req, res) => res.end('responsive'));
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const pdf = ${JSON.stringify(fixture)}, started = ${JSON.stringify(started)}, release = ${JSON.stringify(release)};
      const jobs = Promise.all([manuscripts.snapshotPdf(pdf, 'one'), manuscripts.snapshotPdf(pdf, 'two')]);
      void jobs.catch(() => {});
      try {
        const deadline = Date.now() + 20000;
        while (!fs.existsSync(started)) { if (Date.now() > deadline) throw new Error('Worker did not start'); await delay(10); }
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/health', { signal: AbortSignal.timeout(5000) });
        assert.equal(await response.text(), 'responsive');
        assert.equal(fs.readFileSync(started, 'utf8'), 'started\\n', 'only one PDF extracts at a time');
        fs.writeFileSync(release, '');
        const snapshots = await jobs;
        assert.deepEqual(snapshots.map(s => s.key), ['one', 'two']);
        assert.deepEqual(snapshots[0].lines, snapshots[1].lines);
        assert.equal(fs.readFileSync(started, 'utf8'), 'started\\nstarted\\n');
        console.log('HTTP answered during synchronous PDF text extraction');
      } finally {
        fs.writeFileSync(release, ''); await manuscripts.stop();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      }
    `);
    const { stdout } = await promisify(execFile)(process.execPath, [bootstrap], {
      env: { ...process.env, PAPILOT_REVIEW_ENGINE: root }, timeout: 55000,
    });
    assert.match(stdout, /HTTP answered during synchronous PDF text extraction/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('async PDF preservation retains originals and publishes explicit replacements in order', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-preserve-review-')), manuscripts = new Manuscripts();
  const copyFile = fs.promises.copyFile.bind(fs.promises);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), copying = new Promise<void>(resolve => { started = resolve; });
  try {
    execFileSync('git', ['init', '-q', root]);
    fs.writeFileSync(path.join(root, '.latex-review.json'), JSON.stringify({ main: 'main.tex', engine: 'pdflatex' }));
    fs.writeFileSync(path.join(root, 'main.tex'), '\\documentclass{article}\\begin{document}Test\\end{document}');
    const first = path.join(root, 'first.pdf'), replacement = path.join(root, 'replacement.pdf');
    fs.copyFileSync(fixture, first);
    fs.copyFileSync(path.resolve('examples/papilot-paper/preview/main.pdf'), replacement);
    t.mock.method(fs.promises, 'copyFile', async (...args: Parameters<typeof copyFile>) => {
      if (args[0] === first) { started(); await gate; }
      return copyFile(...args);
    });
    const original = manuscripts.preserveReviewPdf(root, 'task', first);
    await copying;
    const updated = manuscripts.preserveReviewPdf(root, 'task', replacement, true);
    // Give the second request a chance to race the held copy. It must wait.
    let settled = false;
    void updated.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(settled, false);
    release();
    const [saved, newer] = await Promise.all([original, updated]);
    assert.equal(saved, newer);
    assert.deepEqual(fs.readFileSync(saved), fs.readFileSync(replacement));
    await manuscripts.preserveReviewPdf(root, 'task', first);
    assert.deepEqual(fs.readFileSync(saved), fs.readFileSync(replacement), 'ordinary retries retain the published PDF');
    await assert.rejects(manuscripts.preserveReviewPdf(root, 'task', path.join(root, 'missing.pdf'), true));
    await manuscripts.preserveReviewPdf(root, 'task', first, true);
    assert.deepEqual(fs.readFileSync(saved), fs.readFileSync(first), 'a failed copy does not poison the queue');
    assert.deepEqual(fs.readdirSync(path.dirname(saved)), ['review.pdf']);
  } finally { release(); t.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); }
});
