import fs from 'node:fs';
import path from 'node:path';
import { collectCatalog, collectErrorCatalog, readLegacyChinese, type Message } from './catalog.ts';
// @ts-expect-error The static site's build helpers are plain JavaScript.
import { siteMessages, htmlStructure } from '../site-i18n.mjs';

export type Scope = 'workspace' | 'review' | 'site' | 'readme' | 'errors';
export const scopes: Scope[] = ['workspace', 'review', 'site', 'readme', 'errors'];
export function scopeCatalog(root: string, scope: Scope) {
  if (scope === 'workspace') return collectCatalog(root);
  if (scope === 'errors') return collectErrorCatalog(root);
  if (scope === 'review') {
    const file = 'engine/src/web/zh-CN.ts';
    return { messages: Object.keys(readLegacyChinese(root, file)).map(source => ({ source, occurrences: [{ file, line: 1, context: 'PDF change-review interface; English message key from the maintained review catalog.' }] })), dynamic: [] };
  }
  if (scope === 'site') {
    const html = fs.readFileSync(path.join(root, 'site/index.html'), 'utf8');
    return { messages: siteMessages(html) as Message[], dynamic: [] };
  }
  const source = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  return { messages: [{ source, occurrences: [{ file: 'README.md', line: 1, context: 'Complete README document. Translate ALL prose, headings, table cells, image alt text and link labels. Preserve Markdown and HTML structure, emoji, every URL/link destination/anchor/path, code blocks, inline code, versions, badges, command names and identifiers exactly. Keep existing language names. Output the whole document, without omitting or summarizing anything.' }] }], dynamic: [] };
}
export function scopeDirectory(scope: Scope) {
  return { workspace: 'src/web/locales', review: 'engine/src/web/locales', site: 'site/locales', readme: 'i18n/readme', errors: 'src/web/locales/errors' }[scope];
}
export function scopeValidation(scope: Scope, source: string, translated: string): string | null {
  if ((scope === 'site' || scope === 'readme') && typeof translated === 'string') {
    const code = (text: string) => scope === 'site'
      ? [...text.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)].map(match => match[1])
      : [...text.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)].map(match => match[1]);
    if (JSON.stringify(code(source).sort()) !== JSON.stringify(code(translated).sort())) return 'Inline code changed';
    for (const name of ['Papilot', 'Codex', 'Claude', 'Cursor', 'GitHub Copilot', 'Grok', 'Antigravity', 'Kimi', 'GLM', 'DeepSeek', 'Qwen', 'OpenCode', 'LaTeX', 'SyncTeX', 'Git']) {
      const count = (text: string) => (text.match(new RegExp(`(?<![A-Za-z])${name}(?![A-Za-z])`, 'g')) || []).length;
      if (count(source) !== count(translated)) return `Product name changed: ${name}`;
    }
  }
  if (scope === 'site' && htmlStructure(source) !== htmlStructure(translated)) return 'HTML tags or attributes changed';
  if (scope === 'readme') {
    const switcher = (text: string) => text.match(/<p data-language-switcher>[\s\S]*?<\/p>/)?.[0];
    if (switcher(source) !== switcher(translated)) return 'README language switcher changed';
    const blocks = (text: string) => text.match(/^```[^\n]*\n[\s\S]*?^```/gm) || [];
    if (JSON.stringify(blocks(source)) !== JSON.stringify(blocks(translated))) return 'README code blocks changed';
    const links = (text: string) => [...text.matchAll(/\]\(([^)]+)\)|\b(?:href|src|srcset)="([^"]+)"/g)].map(match => match[1] || match[2]).sort();
    if (JSON.stringify(links(source)) !== JSON.stringify(links(translated))) return 'README link destinations changed';
    if ((source.match(/^## /gm) || []).length !== (translated.match(/^## /gm) || []).length) return 'README sections were omitted';
  }
  return null;
}

// Catalogs keep root-relative destinations identical to the English source.
// Rebase only the generated document, so moving it never requires translation.
export function readmeLinks(text: string, directory: string) {
  const rebase = (url: string) => /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(url) ? url : path.posix.relative(directory, url);
  return text.replace(/(\]\()([^)]+)(\))|(\b(?:href|src|srcset)=")([^"]+)(")/g,
    (_match, before, url, after, htmlBefore, htmlUrl, htmlAfter) => before ? before + rebase(url) + after : htmlBefore + rebase(htmlUrl) + htmlAfter);
}

export function renderReadme(root: string, translations: Record<string, string>, locale = 'zh-Hant') {
  const source = scopeCatalog(root, 'readme').messages[0].source;
  let result = translations[source];
  if (!result) throw new Error('Translate the current README before rendering it.');
  const issue = scopeValidation('readme', source, result);
  if (issue) throw new Error(issue);
  const headings = [...source.matchAll(/^## (.+)$/gm)].map(match => match[1].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/ /g, '-'));
  let index = 0;
  result = result.replace(/^## /gm, () => `<a id="${headings[index++]}"></a>\n\n## `);
  const directory = 'docs/readme';
  fs.mkdirSync(path.join(root, directory), { recursive: true });
  fs.writeFileSync(path.join(root, directory, `README.${locale}.md`), readmeLinks(result, directory));
}
