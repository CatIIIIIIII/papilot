import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readLegacyChinese } from './i18n/catalog.ts';
import { scopes, scopeCatalog, scopeDirectory, scopeValidation, renderReadme, type Scope } from './i18n/scopes.ts';
import { hash, pendingMessages, revision, translationPrompt, validateResponse, validateTranslation, type LocaleConfig, type TranslationState } from './i18n/translate.ts';
import { translateWithAgy } from './i18n/agy.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const knownDynamic = new Set([
  'src/web/note-groups.tsx:GROUP_NAMES[group]',
  'src/web/skill-icon-picker.tsx:selected.label', 'src/web/skill-icon-picker.tsx:icon.label',
  'src/web/skills.tsx:skill.name', 'src/web/skills.tsx:skill.description',
]);

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
}
function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n'); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}
const ordered = <T>(value: Record<string, T>) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    locale: { type: 'string', default: 'zh-CN' }, model: { type: 'string', default: 'gemini-4-argon-medium' },
    scope: { type: 'string', default: 'workspace' },
    'batch-size': { type: 'string', default: '80' }, limit: { type: 'string' },
    'dry-run': { type: 'boolean', default: false }, 'out-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  const command = positionals[0];
  if (values.help || !command) {
    console.log('Usage: npm run i18n -- <extract|check|translate> [--scope workspace|review|site|readme|errors] [--locale zh-CN] [--dry-run] [--limit 12] [--batch-size 30] [--model gemini-4-argon-medium] [--out-dir directory]\n\nextract writes test-results/i18n/<scope>.json. translate writes each scope\'s locale dictionary and i18n/state metadata.\nWith --out-dir, translations and their .state directory both stay in that directory.');
    return;
  }
  if (!['extract', 'check', 'translate'].includes(command) || positionals.length !== 1) throw new Error('Choose extract, check, or translate.');
  if (command === 'check' && !values['out-dir'] && (!process.argv.includes('--scope') || !process.argv.includes('--locale'))) {
    const configuration = readJson<{ locales: Record<string, LocaleConfig> }>(path.join(root, 'i18n/config.json'), { locales: {} });
    let failed = false;
    for (const scope of process.argv.includes('--scope') ? [values.scope] : scopes) {
      for (const locale of process.argv.includes('--locale') ? [values.locale] : Object.keys(configuration.locales)) {
        const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'scripts/i18n.ts'), 'check', '--scope', scope, '--locale', locale, ...(values['out-dir'] ? ['--out-dir', values['out-dir']] : [])], { stdio: 'inherit' });
        if (result.status !== 0) failed = true;
      }
    }
    if (failed) process.exitCode = 1;
    return;
  }
  const scope = values.scope as Scope;
  if (!scopes.includes(scope)) throw new Error('Choose workspace, review, site, readme, or errors for --scope.');
  const catalog = scopeCatalog(root, scope);
  const unresolved = catalog.dynamic.filter(item => !knownDynamic.has(`${item.file}:${item.expression}`));
  if (unresolved.length) throw new Error(`Unregistered dynamic messages:\n${unresolved.map(item => `${item.file}:${item.line}: ${item.expression}`).join('\n')}\nUse literal messages or register a finite data source in the extractor.`);
  if (command === 'extract') {
    const file = path.join(root, `test-results/i18n/${scope}.json`);
    writeJson(file, catalog);
    console.log(`Extracted ${catalog.messages.length} messages with source context: ${file}`);
    return;
  }
  const locale = values.locale;
  const configuration = readJson<{ locales: Record<string, LocaleConfig> }>(path.join(root, 'i18n/config.json'), { locales: {} });
  if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale) || !Object.hasOwn(configuration.locales, locale)) throw new Error(`Add ${locale} to i18n/config.json first.`);
  const baseConfig = configuration.locales[locale];
  const config = { ...baseConfig, instructions: baseConfig.instructions + (baseConfig.scopeInstructions?.[scope] || ''), glossary: { ...baseConfig.glossary, ...baseConfig.scopeGlossary?.[scope] } };
  const directory = values['out-dir'] ? path.resolve(values['out-dir']) : path.join(root, scopeDirectory(scope));
  const file = path.join(directory, `${locale}.json`);
  const stateFile = path.join(values['out-dir'] ? path.join(directory, '.state') : path.join(root, 'i18n/state'), `${scope === 'workspace' ? '' : scope + '.'}${locale}.json`);
  const translations = readJson<Record<string, string>>(file, {});
  const state = readJson<TranslationState>(stateFile, {});
  const curated = locale === 'zh-CN' && (scope === 'workspace' || scope === 'review') ? readLegacyChinese(root, scope === 'review' ? 'engine/src/web/zh-CN.ts' : undefined) : {};
  const messages = catalog.messages.map(message => baseConfig.messageInstructions?.[message.source] ? { ...message, occurrences: [...message.occurrences, { file: 'i18n/config.json', line: 1, context: baseConfig.messageInstructions[message.source] }] } : message);
  const merged = { ...translations, ...curated };
  if (command === 'check') {
    const failures = messages.flatMap(message => {
      const error = validateTranslation(message.source, Object.hasOwn(merged, message.source) ? merged[message.source] : undefined) || scopeValidation(scope, message.source, merged[message.source]);
      return error ? [`${message.source}: ${error}`] : [];
    });
    const sources = new Set(messages.map(message => message.source));
    for (const source of Object.keys(merged)) if (!sources.has(source)) failures.push(`Unused translation: ${source}`);
    const stale = pendingMessages(messages, locale, config, translations, state, curated).filter(message => Object.hasOwn(merged, message.source));
    failures.push(...stale.map(message => `Translation needs updating: ${message.source}`));
    if (failures.length) throw new Error(`${locale}: ${failures.length} translation issues\n${failures.slice(0, 20).join('\n')}`);
    console.log(`${scope}/${locale}: all ${messages.length} messages have valid translations.`);
    return;
  }
  const batchSize = Number(values['batch-size']), limit = values.limit === undefined ? Infinity : Number(values.limit);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error('--batch-size must be between 1 and 100.');
  if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1)) throw new Error('--limit must be a positive integer.');
  const pending = pendingMessages(messages, locale, config, translations, state, curated);
  console.log(`${scope}/${locale}: ${messages.length} source messages; ${pending.length} pending; ${Math.min(limit, pending.length)} selected. Existing curated and hand-edited translations are preserved.`);
  if (values['dry-run']) return;
  if (!pending.length) { if (scope === 'readme' && !values['out-dir']) renderReadme(root, translations, locale); return; }
  const selected = pending.slice(0, limit);
  // Prevent two runs for the same locale from overwriting each other's progress.
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const lock = `${stateFile}.lock`;
  const descriptor = fs.openSync(lock, 'wx');
  fs.closeSync(descriptor);
  let expectedFile = JSON.stringify(translations), expectedState = JSON.stringify(state), completed = 0;
  const save = () => {
    if (JSON.stringify(readJson(file, {})) !== expectedFile || JSON.stringify(readJson(stateFile, {})) !== expectedState) throw new Error('Translations changed during this run. Progress was not written over those edits.');
    writeJson(file, ordered(translations));
    writeJson(stateFile, ordered(state));
    expectedFile = JSON.stringify(ordered(translations)); expectedState = JSON.stringify(ordered(state));
  };
  try {
    for (let start = 0; start < selected.length; start += batchSize) {
      let batch = selected.slice(start, start + batchSize), feedback = '';
      for (let attempt = 0; batch.length && attempt < 3; attempt++) {
        console.log(`Translating ${batch.length} messages with ${values.model} (${completed}/${selected.length} saved${attempt ? `, retry ${attempt}` : ''})…`);
        let response;
        try { response = await translateWithAgy(translationPrompt(batch, locale, config) + feedback, batch.length, values.model); }
        catch (error) {
          if (!(error as Error).message.startsWith('Invalid translation JSON:') || attempt === 2) throw error;
          console.warn((error as Error).message);
          feedback = '\nThe last response was not valid JSON. Return exactly one valid JSON object, without surrounding text or extra objects.';
          continue;
        }
        let validated;
        try { validated = validateResponse(batch, response); }
        catch (error) { feedback = `\nThe last response was invalid: ${(error as Error).message} Return exactly one entry per input ID.`; if (attempt === 2) throw error; continue; }
        for (const [source, text] of validated.accepted) {
          const issue = scopeValidation(scope, source, text);
          if (issue) { validated.accepted.delete(source); validated.errors.set(source, issue); }
        }
        for (const [source, issue] of validated.errors) console.warn(`Rejected ${JSON.stringify(source.slice(0, 160))}: ${issue}`);
        for (const message of batch) {
          const text = validated.accepted.get(message.source);
          if (text === undefined) continue;
          Object.defineProperty(translations, message.source, { value: text, enumerable: true, configurable: true, writable: true });
          Object.defineProperty(state, message.source, { value: { revision: revision(message, locale, config), textHash: hash(text), model: values.model }, enumerable: true, configurable: true, writable: true });
          completed++;
        }
        if (validated.accepted.size) save();
        batch = batch.filter(message => validated.errors.has(message.source));
        feedback = `\nCorrect these validation errors from the previous response: ${JSON.stringify([...validated.errors])}. IDs refer to the new input batch above.`;
      }
      if (batch.length) throw new Error(`${batch.length} messages still failed validation. Valid translations were saved; rerun to resume.`);
    }
  } finally { fs.rmSync(lock, { force: true }); }
  if (scope === 'readme' && !values['out-dir']) renderReadme(root, translations, locale);
  console.log(`Saved ${completed} translations to ${file}. Run check for full coverage before enabling a language.`);
}

main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
