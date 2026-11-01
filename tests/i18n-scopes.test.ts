import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scopeCatalog, scopeDirectory, scopeValidation, type Scope } from '../scripts/i18n/scopes.ts';
import { validateTranslation } from '../scripts/i18n/translate.ts';
// @ts-expect-error The static site's build helpers are plain JavaScript.
import { translatedSite } from '../scripts/site-i18n.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));

for (const scope of ['review', 'site', 'readme', 'errors'] as Scope[]) {
  test(`${scope} has complete Traditional Chinese translations with preserved structure`, () => {
    const catalog = scopeCatalog(root, scope).messages;
    const translations = JSON.parse(fs.readFileSync(`${root}/${scopeDirectory(scope)}/zh-Hant.json`, 'utf8'));
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
  assert.match(rendered, /<span lang="zh-Hant">閱讀 <b>PDF<\/b><\/span>/);
  assert.throws(() => translatedSite(source, { Title: '標題' }), /Missing website translation/);
  assert.equal(scopeValidation('site', 'Read <b>PDF</b>', '閱讀 <i>PDF</i>'), 'HTML tags or attributes changed');
});
test('README retains its local anchors, code, and destinations', () => {
  const markdown = fs.readFileSync(`${root}/README.zh-Hant.md`, 'utf8');
  const anchors = [...markdown.matchAll(/\]\(#([^)]+)\)/g)].map(match => match[1]);
  for (const anchor of anchors) assert.ok(markdown.includes(`id="${anchor}"`), anchor);
  assert.match(markdown, /href="README.md">English/);
});
