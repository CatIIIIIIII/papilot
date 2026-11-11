import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appInfo, browserPackages, collectLicenses } from '../scripts/licenses.ts';

test('the About page uses the release metadata and the unabridged project license', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const info = appInfo();
  assert.equal(info.version, pkg.version);
  assert.equal(info.repository, 'https://github.com/PapilotAI/papilot');
  assert.equal(info.issues, pkg.bugs.url);
  assert.equal(info.licenseText, fs.readFileSync('LICENSE', 'utf8').trim());
});

test('notices cover runtime and browser dependencies, nested notices and bundled fonts', () => {
  const notices = collectLicenses();
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const names = new Set(notices.map(item => item.name));
  for (const name of [...Object.keys(pkg.dependencies), ...browserPackages, 'TeX Gyre Pagella X / newpx', 'Inconsolata zi4', 'scheduler', 'hast-util-to-jsx-runtime']) assert.ok(names.has(name), name);
  assert.equal(new Set(notices.map(item => `${item.name}@${item.version}`)).size, notices.length);
  assert.ok(!names.has('typescript'), 'build-only tools are outside the runtime notices');
  const mupdf = notices.find(item => item.name === 'mupdf')!;
  assert.equal(mupdf.license, 'AGPL-3.0-or-later');
  assert.equal(mupdf.notices[0].text, fs.readFileSync('node_modules/mupdf/LICENSE', 'utf8').trim());
  const pdfjs = notices.find(item => item.name === 'pdfjs-dist')!;
  assert.equal(pdfjs.license, 'Apache-2.0');
  assert.ok(pdfjs.notices.some(item => item.name === 'standard_fonts/LICENSE_FOXIT'));
  assert.ok(pdfjs.notices.some(item => item.name === 'wasm/LICENSE_OPENJPEG'));
  assert.ok(notices.find(item => item.name === 'TeX Gyre Pagella X / newpx')!.notices.some(item => item.name === 'LPPL'));
  for (const notice of notices) assert.match(notice.url, /^https?:\/\//);
});
