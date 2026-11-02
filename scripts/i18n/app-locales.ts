import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGES } from '../../engine/src/locales.ts';
import { scopeCatalog, scopeDirectory, type Scope } from './scopes.ts';
import { readLegacyChinese } from './catalog.ts';
import { pendingMessages, validateTranslation, type LocaleConfig, type TranslationState } from './translate.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(root, 'i18n/config.json'), 'utf8')) as { locales: Record<string, LocaleConfig> };
const issues: string[] = [];
for (const scope of ['workspace', 'review', 'errors'] as Scope[]) {
  const messages = scopeCatalog(root, scope).messages;
  for (const { id } of LANGUAGES) {
    if (id === 'en') continue;
    // The existing curated catalogs retain their file names for compatibility.
    const locale = id === 'zh-Hans' ? 'zh-CN' : id;
    const file = path.join(root, scopeDirectory(scope), `${locale}.json`);
    const curated = locale === 'zh-CN' && scope !== 'errors' ? readLegacyChinese(root, scope === 'review' ? 'engine/src/web/zh-CN.ts' : undefined) : {};
    const generated: Record<string, string> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const dictionary: Record<string, string> = { ...generated, ...curated };
    const stateFile = path.join(root, 'i18n/state', `${scope === 'workspace' ? '' : scope + '.'}${locale}.json`);
    const state: TranslationState = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
    const before = issues.length;
    for (const { source } of messages) {
      const error = validateTranslation(source, Object.hasOwn(dictionary, source) ? dictionary[source] : undefined);
      if (error) issues.push(`${scope}/${id}: ${source}: ${error}`);
    }
    for (const message of pendingMessages(messages, locale, config.locales[locale], generated, state, curated)) {
      if (Object.hasOwn(dictionary, message.source)) issues.push(`${scope}/${id}: outdated translation: ${message.source}`);
    }
    const keys = new Set(messages.map(message => message.source));
    for (const key of Object.keys(dictionary)) if (!keys.has(key)) issues.push(`${scope}/${id}: unused translation: ${key}`);
    if (issues.length === before) console.log(`${scope}/${id}: ${messages.length} messages checked`);
  }
}
if (issues.length) {
  console.error(`${issues.length} translation issues:\n${issues.slice(0, 30).join('\n')}`);
  process.exitCode = 1;
}
