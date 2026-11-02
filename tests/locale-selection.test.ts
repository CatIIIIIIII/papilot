import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, supportedLanguage, singularCount, interpolateMessage } from '../engine/src/locales.ts';

test('the agreed language list has exactly eleven canonical choices', () => {
  assert.deepEqual(LANGUAGES.map(item => item.id), ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es', 'pt', 'it', 'sv']);
});

test('numbers use the interface locale without changing supplied text or unknown placeholders', () => {
  assert.equal(interpolateMessage('{n}: {name} {missing}', 'de', { n: 1234.5, name: 'paper-1234.5' }), '1.234,5: paper-1234.5 {missing}');
  assert.equal(interpolateMessage('{n}', 'en', { n: 1234.5 }), '1,234.5');
  assert.equal(interpolateMessage('{n}', 'fr', { n: 1234.5 }), '1\u202f234,5');
  assert.equal(interpolateMessage('{constructor}', 'en', {}), '{constructor}');
});

test('locale matching accepts browser variants and legacy preferences', () => {
  for (const [input, expected] of [['zh-CN', 'zh-Hans'], ['zh-Hans', 'zh-Hans'], ['zh-Hant', 'zh-Hant'], ['en-GB', 'en'], ['ja-JP', 'ja'], ['ko-KR', 'ko'], ['de-DE', 'de'], ['fr-FR', 'fr'], ['es-ES', 'es'], ['pt-PT', 'pt'], ['it-IT', 'it'], ['sv-SE', 'sv']] as const) {
    assert.equal(supportedLanguage(input), expected, input);
  }
  assert.equal(supportedLanguage('zz'), null);
  assert.equal(supportedLanguage('zh_invalid'), null);
  assert.equal(supportedLanguage('system'), null);
  assert.equal(supportedLanguage(null), null);
});

test('plural choices follow each language, including zero and invariant forms', () => {
  assert.equal(singularCount('en', 0), false);
  assert.equal(singularCount('en', 1), true);
  assert.equal(singularCount('en', 2), false);
  assert.equal(singularCount('fr', 0), true);
  assert.equal(singularCount('fr', 1), true);
  assert.equal(singularCount('fr', 2), false);
  assert.equal(singularCount('pt', 0), true);
  for (const language of ['ja', 'ko', 'zh-Hans', 'zh-Hant'] as const) assert.equal(singularCount(language, 1), false);
  for (const language of ['de', 'es', 'it', 'sv'] as const) {
    assert.equal(singularCount(language, 0), false);
    assert.equal(singularCount(language, 1), true);
    assert.equal(singularCount(language, 2), false);
  }
});
