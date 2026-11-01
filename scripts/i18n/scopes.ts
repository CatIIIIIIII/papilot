import fs from 'node:fs';
import path from 'node:path';
import { collectCatalog, collectErrorCatalog, readLegacyChinese, type Message } from './catalog.ts';
// @ts-expect-error The static site's build helpers are plain JavaScript.
import { renderDemo } from '../../site/demo-templates.mjs';
// @ts-expect-error The static site's build helpers are plain JavaScript.
import { siteMessages, htmlStructure } from '../site-i18n.mjs';

export type Scope = 'workspace' | 'review' | 'site' | 'readme' | 'errors';
export const scopes: Scope[] = ['workspace', 'review', 'site', 'readme', 'errors'];
export function scopeCatalog(root: string, scope: Scope) {
  if (scope === 'workspace') return collectCatalog(root);
  if (scope === 'errors') return collectErrorCatalog(root);
  if (scope === 'review') {
    const file = 'vendor/latex-review/src/web/zh-CN.ts';
    return { messages: Object.keys(readLegacyChinese(root, file)).map(source => ({ source, occurrences: [{ file, line: 1, context: 'PDF change-review interface; English message key from the maintained review catalog.' }] })), dynamic: [] };
  }
  if (scope === 'site') {
    const html = fs.readFileSync(path.join(root, 'site/index.html'), 'utf8').replace(/<!-- demo:(\w+) -->/g, (_, kind) => renderDemo(kind));
    return { messages: siteMessages(html) as Message[], dynamic: [] };
  }
  const source = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  return { messages: [{ source, occurrences: [{ file: 'README.md', line: 1, context: 'Complete README document. Translate ALL prose, headings, table cells, image alt text and link labels. Preserve Markdown and HTML structure, emoji, every URL/link destination/anchor/path, code blocks, inline code, versions, badges, command names and identifiers exactly. Keep existing language names. Output the whole document, without omitting or summarizing anything.' }] }], dynamic: [] };
}
export function scopeDirectory(scope: Scope) {
  return { workspace: 'src/web/locales', review: 'vendor/latex-review/src/web/locales', site: 'site/locales', readme: 'i18n/readme', errors: 'src/web/locales/errors' }[scope];
}
export function scopeValidation(scope: Scope, source: string, translated: string): string | null {
  if (scope === 'site' && htmlStructure(source) !== htmlStructure(translated)) return 'HTML tags or attributes changed';
  if (scope === 'readme') {
    const blocks = (text: string) => text.match(/^```[^\n]*\n[\s\S]*?^```/gm) || [];
    if (JSON.stringify(blocks(source)) !== JSON.stringify(blocks(translated))) return 'README code blocks changed';
    const links = (text: string) => [...text.matchAll(/\]\(([^)]+)\)|\b(?:href|src|srcset)="([^"]+)"/g)].map(match => match[1] || match[2]).sort();
    if (JSON.stringify(links(source)) !== JSON.stringify(links(translated))) return 'README link destinations changed';
    if ((source.match(/^## /gm) || []).length !== (translated.match(/^## /gm) || []).length) return 'README sections were omitted';
  }
  return null;
}

export function renderReadme(root: string, translations: Record<string, string>) {
  const source = scopeCatalog(root, 'readme').messages[0].source;
  let result = translations[source];
  if (!result) throw new Error('Translate the current README before rendering it.');
  const issue = scopeValidation('readme', source, result);
  if (issue) throw new Error(issue);
  const headings = [...source.matchAll(/^## (.+)$/gm)].map(match => match[1].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/ /g, '-'));
  let index = 0;
  result = result.replace(/^## /gm, () => `<a id="${headings[index++]}"></a>\n\n## `);
  result = result.replace(/<p>English · <a href="README.zh-CN.md">简体中文<\/a> · <a href="README.zh-Hant.md">繁體中文<\/a><\/p>/, '<p><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · 繁體中文</p>');
  fs.writeFileSync(path.join(root, 'README.zh-Hant.md'), result);
}
