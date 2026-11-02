import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { renderReadme, scopeCatalog, scopeDirectory, scopeValidation, type Scope } from '../scripts/i18n/scopes.ts';
import { LANGUAGES } from '../engine/src/locales.ts';
import { readLegacyChinese } from '../scripts/i18n/catalog.ts';
import { validateTranslation } from '../scripts/i18n/translate.ts';
// @ts-expect-error The static site's build helpers are plain JavaScript.
import { translatedSite } from '../scripts/site-i18n.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));

const locales = Object.keys(JSON.parse(fs.readFileSync(`${root}/i18n/config.json`, 'utf8')).locales);
for (const scope of ['review', 'site', 'readme', 'errors'] as Scope[]) for (const locale of locales) {
  test(`${scope} has complete ${locale} translations with preserved structure`, () => {
    const catalog = scopeCatalog(root, scope).messages;
    const file = `${root}/${scopeDirectory(scope)}/${locale}.json`;
    const translations = { ...(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}), ...(scope === 'review' && locale === 'zh-CN' ? readLegacyChinese(root, 'engine/src/web/zh-CN.ts') : {}) };
    assert.ok(catalog.length > 0);
    for (const { source } of catalog) {
      assert.equal(validateTranslation(source, translations[source]), null, source.slice(0, 100));
      assert.equal(scopeValidation(scope, source, translations[source]), null, source.slice(0, 100));
    }
    assert.deepEqual(Object.keys(translations).filter(key => !catalog.some(message => message.source === key)), []);
  });
}
test('website rendering requires translated content and retains inline markup', () => {
  const source = '<html lang="en"><head><title>Title</title></head><body><span lang="en">Read <b>PDF</b></span><span lang="zh-CN">阅读 PDF</span></body></html>';
  const rendered = translatedSite(source, { Title: '標題', 'Read <b>PDF</b>': '閱讀 <b>PDF</b>' });
  assert.doesNotMatch(rendered, /lang="(?:en|zh-CN)"/);
  assert.match(rendered, /<span lang="zh-Hant">閱讀 <b>PDF<\/b><\/span>/);
  assert.throws(() => translatedSite(source, { Title: '標題' }), /Missing website translation/);
  assert.equal(scopeValidation('site', 'Read <b>PDF</b>', '閱讀 <i>PDF</i>'), 'HTML tags or attributes changed');
  assert.equal(scopeValidation('site', 'Run <code>papilot</code> with <code>KEY</code>', '<code>KEY</code> を設定して <code>papilot</code> を起動'), null);
  assert.equal(scopeValidation('site', 'Run <code>papilot</code>', '<code>other</code> を起動'), 'Inline code changed');
});
test('public languages match the App exactly', () => {
  const names = JSON.parse(fs.readFileSync(`${root}/i18n/languages.json`, 'utf8'));
  assert.deepEqual(Object.keys(names), LANGUAGES.map(({ id }) => id === 'zh-Hans' ? 'zh-CN' : id));
});
for (const locale of locales) test(`README ${locale} retains its local anchors, code, and destinations`, () => {
  const markdown = fs.readFileSync(`${root}/docs/readme/README.${locale}.md`, 'utf8');
  const anchors = [...markdown.matchAll(/\]\(#([^)]+)\)/g)].map(match => match[1]);
  for (const anchor of anchors) assert.ok(markdown.includes(`id="${anchor}"`), anchor);
  assert.match(markdown, /href="\.\.\/\.\.\/README.md">English/);
  for (const match of markdown.matchAll(/\]\(([^)]+)\)|\b(?:href|src|srcset)="([^"]+)"/g)) {
    const link = match[1] || match[2];
    if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(link)) continue;
    assert.ok(fs.existsSync(path.resolve(root, 'docs/readme', link.split('#')[0])), link);
  }
});
test('README regeneration writes translations under docs and leaves the root entry in place', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-readme-'));
  try {
    fs.copyFileSync(path.join(root, 'README.md'), path.join(directory, 'README.md'));
    renderReadme(directory, JSON.parse(fs.readFileSync(path.join(root, 'i18n/readme/zh-CN.json'), 'utf8')), 'zh-CN');
    assert.deepEqual(fs.readdirSync(directory).sort(), ['README.md', 'docs']);
    assert.equal(fs.readFileSync(path.join(directory, 'docs/readme/README.zh-CN.md'), 'utf8'), fs.readFileSync(path.join(root, 'docs/readme/README.zh-CN.md'), 'utf8'));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
