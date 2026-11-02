import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { browserLanguage, errorText, locale, setLanguage, t, tn } from '../src/web/i18n.ts';
import { zhCN } from '../src/web/zh-CN.ts';
import generatedZhCN from '../src/web/locales/zh-CN.json';
import zhHant from '../src/web/locales/zh-Hant.json';
import { messages, errorMessages } from '../src/web/locales/index.ts';
import { LANGUAGES } from '../engine/src/locales.ts';
import { collectCatalog } from '../scripts/i18n/catalog.ts';
import { placeholders } from '../scripts/i18n/translate.ts';

test('every workspace message has a Simplified Chinese translation with the same placeholders', () => {
  const all = new Set(collectCatalog(fileURLToPath(new URL('../', import.meta.url))).messages.map(message => message.source));
  const translations: Record<string, string> = { ...generatedZhCN, ...zhCN };
  assert.ok(all.size > 300);
  const missing = [...all].filter(text => !Object.hasOwn(translations, text));
  assert.deepEqual(missing, []);
  for (const text of all) assert.deepEqual(placeholders(translations[text]), placeholders(text), text);
  const unused = Object.keys(translations).filter(text => !all.has(text));
  assert.deepEqual(unused, [], 'translations no message uses');
});

test('messages fill placeholders and pick English plurals', () => {
  assert.equal(t('Reply to {agent}', { agent: 'Codex' }), 'Reply to Codex');
  assert.equal(tn(1, '{n} comment', '{n} comments'), '1 comment');
  assert.equal(tn(3, '{n} comment', '{n} comments'), '3 comments');
  assert.equal(t('An untranslated message'), 'An untranslated message');
});

test('every supported language covers the workspace catalog with intact placeholders', () => {
  const all = collectCatalog(fileURLToPath(new URL('../', import.meta.url))).messages;
  for (const { id } of LANGUAGES) {
    if (id === 'en') continue;
    const translations = messages[id];
    assert.deepEqual(all.filter(message => !Object.hasOwn(translations, message.source)).map(message => message.source), [], id);
    for (const message of all) assert.deepEqual(placeholders(translations[message.source]), placeholders(message.source), `${id}: ${message.source}`);
  }
});

test('the browser language picks the first one Papilot speaks', () => {
  assert.equal(browserLanguage(['zh-CN', 'en-US']), 'zh-Hans');
  assert.equal(browserLanguage(['zh-Hant']), 'zh-Hant');
  assert.equal(browserLanguage(['zh-Hans']), 'zh-Hans');
  assert.equal(browserLanguage(['zh_invalid', 'en']), 'en');
  assert.equal(browserLanguage(['ja-JP', 'en-GB', 'zh-CN']), 'ja');
  assert.equal(browserLanguage(['fr-FR']), 'fr');
  assert.equal(browserLanguage([]), 'en');
});

test('all language choices translate settings and product errors and retain an English fallback', () => {
  try {
    for (const { id } of LANGUAGES) {
      setLanguage(id);
      assert.equal(t('Settings'), id === 'en' ? 'Settings' : messages[id].Settings, id);
      assert.equal(errorText('Paper name is too long.'), id === 'en' ? 'Paper name is too long.' : errorMessages[id]['Paper name is too long.'], id);
      assert.equal(t('Unknown text'), 'Unknown text');
      assert.equal(t('constructor'), 'constructor');
      assert.equal(locale(), id);
    }
  } finally { setLanguage('system'); }
});

test('Traditional Chinese is used for interface messages, interpolation, dates and known API errors', () => {
  setLanguage('zh-Hant');
  try {
    assert.equal(t('Settings'), zhHant.Settings);
    assert.equal(t('AI suggestion {n}', { n: 3 }), zhHant['AI suggestion {n}'].replace('{n}', '3'));
    assert.equal(locale(), 'zh-Hant');
    assert.notEqual(errorText('Paper name is too long.'), 'Paper name is too long.');
    assert.equal(errorText('Unknown external diagnostic'), 'Unknown external diagnostic');
  } finally { setLanguage('system'); }
});
