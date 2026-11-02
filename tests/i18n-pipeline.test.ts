import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { extractSource, type Message } from '../scripts/i18n/catalog.ts';
import { hash, pendingMessages, revision, validateResponse, type LocaleConfig } from '../scripts/i18n/translate.ts';
import { decodeAgyResponse } from '../scripts/i18n/agy.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const message = (source: string): Message => ({ source, occurrences: [{ file: 'src/web/example.tsx', line: 1, context: 'example' }] });
const config: LocaleConfig = { name: 'Traditional Chinese', instructions: 'Use Traditional Chinese characters.', glossary: {} };

test('AST extraction handles quotes, escapes, templates, aliases, conditionals and complex plural counts', () => {
  const source = `import { t as translate, tn } from './i18n.ts';
import * as i18n from './i18n.ts';
// translate('Not a message');
const text = "translate('Not a message either')";
translate("Don't delete");
translate('Line\\nnext');
translate(\`Static template\`);
translate(ok ? 'Yes' : "No");
tn(Math.max(1, count), '{n} note', '{n} notes');
i18n.t('Namespace');
translate(label);
t('Unrelated function');`;
  const result = extractSource(source, 'src/web/nested/component.tsx');
  assert.deepEqual(result.messages.map(item => item.source), ["Don't delete", 'Line\nnext', 'Static template', 'Yes', 'No', '{n} note', '{n} notes', 'Namespace']);
  assert.deepEqual(result.dynamic.map(item => item.expression), ['label']);
  assert.equal(result.messages[0].occurrences[0].line, 5);
});

test('incremental work preserves curated, locked, and hand-edited translations', () => {
  const messages = ['Current', 'Missing', 'Changed rules', 'Manual', 'Curated', 'Locked'].map(message);
  const translations = { Current: '目前', 'Changed rules': '規則', Manual: '人工修訂', Locked: '鎖定' };
  const state = Object.fromEntries(messages.map(item => [item.source, { revision: revision(item, 'zh-Hant', config), textHash: hash((translations as Record<string, string>)[item.source] || ''), model: 'argon' }]));
  state['Changed rules'].revision = 'previous rules';
  state.Manual.textHash = hash('原譯文');
  state.Locked.revision = 'previous rules';
  assert.deepEqual(pendingMessages(messages, 'zh-Hant', { ...config, locked: ['Locked'] }, translations, state, { Curated: '已有譯文' }).map(item => item.source), ['Missing', 'Changed rules']);
  assert.equal(revision(messages[0], 'zh-Hant', config), revision({ ...messages[0], occurrences: [{ ...messages[0].occurrences[0], line: 400 }] }, 'zh-Hant', config));
  assert.notEqual(revision(messages[0], 'zh-Hant', config), revision(messages[0], 'zh-Hant', { ...config, glossary: { note: '註解' } }));
});

test('validation accepts reordered IDs and isolates missing or damaged translations', () => {
  const messages = ['Delete {name}?', '{n} of {n}', 'Settings', 'Missing'].map(message);
  const result = validateResponse(messages, { translations: [{ id: 2, text: '設定' }, { id: 0, text: '刪除 {name}？' }, { id: 1, text: '共 {n}' }] });
  assert.deepEqual([...result.accepted], [['Settings', '設定'], ['Delete {name}?', '刪除 {name}？']]);
  assert.deepEqual([...result.errors.keys()], ['{n} of {n}', 'Missing']);
  assert.throws(() => validateResponse(messages, { translations: [{ id: 0, text: '設定' }, { id: 0, text: '設定' }] }), /duplicate/);
  assert.throws(() => validateResponse(messages, { translations: [{ id: 99, text: '設定' }] }), /Unexpected/);
  assert.throws(() => validateResponse(messages, {}), /translations array/);
});

test('agy envelope parsing requires success and structured translation output', () => {
  const value = { translations: [{ id: 0, text: '設定' }] };
  assert.deepEqual(decodeAgyResponse(JSON.stringify({ status: 'SUCCESS', response: JSON.stringify(value) })), value);
  assert.deepEqual(decodeAgyResponse(JSON.stringify({ status: 'SUCCESS', response: '```json\n' + JSON.stringify(value) + '\n```' })), value);
  assert.throws(() => decodeAgyResponse(JSON.stringify({ status: 'ERROR', error: 'Not authenticated' })), /Not authenticated/);
  assert.throws(() => decodeAgyResponse(JSON.stringify({ status: 'SUCCESS', response: 'Here is the answer: {}' })));
});

test('CLI retries only invalid entries, resumes saved progress, preserves manual edits, and never launches agy for dry runs', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-i18n-test-'));
  try {
    const binary = path.join(directory, 'fake-agy'), log = path.join(directory, 'calls.jsonl'), output = path.join(directory, 'output');
    fs.writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1];
const messages = JSON.parse(prompt.split('Messages: ')[1].split('\\n')[0]);
const log = process.env.I18N_TEST_LOG;
const first = !fs.existsSync(log);
fs.appendFileSync(log, JSON.stringify({messages, model: args[args.indexOf('--model') + 1], cwd: process.cwd()}) + '\\n');
if(process.env.I18N_TEST_FAIL) { process.stdout.write(JSON.stringify({status:'ERROR', error:'Provider unavailable'})); process.exit(3); }
const translations = messages.map((m, i) => ({id: m.id, text: first && i === 0 ? 'bad {unexpected}' : '譯：' + m.text}));
process.stdout.write(JSON.stringify({status:'SUCCESS', response: JSON.stringify({translations})}));
`, { mode: 0o755 });
    const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/i18n.ts', ...args, '--locale', 'zh-Hant', '--out-dir', output], { cwd: root, env: { ...process.env, PAPILOT_AGY_BIN: binary, I18N_TEST_LOG: log }, encoding: 'utf8', timeout: 30_000 });
    let result = run('translate', '--limit', '3', '--dry-run');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(log), false);
    result = run('translate', '--limit', '3', '--batch-size', '2');
    assert.equal(result.status, 0, result.stderr);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls.map(call => call.messages.length), [2, 1, 1]);
    assert.equal(calls[1].messages[0].text, calls[0].messages[0].text);
    assert.equal(calls[0].model, 'gemini-4-argon-medium');
    assert.notEqual(calls[0].cwd, root);
    const translationsFile = path.join(output, 'zh-Hant.json');
    const translations = JSON.parse(fs.readFileSync(translationsFile, 'utf8'));
    assert.equal(Object.keys(translations).length, 3);
    const source = Object.keys(translations)[0];
    translations[source] = '人工修訂';
    fs.writeFileSync(translationsFile, JSON.stringify(translations));
    result = run('translate', '--limit', '1');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(translationsFile, 'utf8'))[source], '人工修訂');
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(translationsFile, 'utf8'))).length, 4);
    assert.equal(fs.existsSync(path.join(output, '.state/zh-Hant.json.lock')), false);
    result = run('check');
    assert.equal(result.status, 1, 'Incomplete locales must fail coverage checks');
    const before = fs.readFileSync(translationsFile, 'utf8');
    const failed = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/i18n.ts', 'translate', '--locale', 'zh-Hant', '--limit', '1', '--out-dir', output], { cwd: root, env: { ...process.env, PAPILOT_AGY_BIN: binary, I18N_TEST_LOG: log, I18N_TEST_FAIL: '1' }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Provider unavailable/);
    assert.equal(fs.readFileSync(translationsFile, 'utf8'), before);
    assert.equal(fs.existsSync(path.join(output, '.state/zh-Hant.json.lock')), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
