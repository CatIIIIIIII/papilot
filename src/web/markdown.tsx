import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { MathPlugins } from './math-plugins.ts';
import { t, useLanguage } from './i18n.ts';

// Host paths are references, not routes on the Papilot web server. Clicking
// copies the path, including line numbers, even over Tailscale HTTP.
function FileReference({ path, children }: { path: string; children: ReactNode }) {
  // The reply around it is memoized, so its label follows the language itself.
  useLanguage();
  const [copied, setCopied] = useState(false);
  async function copy() {
    let value = path;
    try { value = decodeURI(path); } catch { /* Keep literal percent signs. */ }
    let ok = false;
    try { await navigator.clipboard.writeText(value); ok = true; }
    catch {
      const area = document.createElement('textarea');
      area.value = value; area.style.position = 'fixed'; area.style.opacity = '0';
      document.body.append(area); area.select();
      try { ok = document.execCommand('copy'); } finally { area.remove(); }
    }
    setCopied(ok);
  }
  return <button type="button" className="file-reference" title={path} aria-label={copied ? t('Copied path') : t('Copy path: {path}', { path })} onClick={() => void copy()}>{children}</button>;
}

// Code is never mathematics: fenced blocks, then inline code spans.
const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`)/;
export const hasMath = (text: string) => text.split(CODE).some((part, index) => index % 2 === 0 && /\$|\\\(|\\\[/.test(part));
// remark-math reads dollar delimiters. LaTeX's \[…\] on lines of its own
// becomes a $$ block at the same indentation, so lists and quotes keep their
// structure; within a line it becomes $$…$$, and \(…\) becomes $…$. A doubled
// backslash, as in the line break \\[4pt], is not a delimiter.
export function normalizeMath(text: string) {
  return text.split(CODE).map((part, index) => index % 2 ? part : literalDollars(part
    .replace(/(^|\n)([ \t]*)\\\[((?:(?!\\\]|\n[ \t]*\n)[\s\S])+?)\\\][ \t]*(?=\n|$)/g, (_, start: string, indent: string, body: string) => `${start}${indent}$$\n${displayLines(body, indent)}\n${indent}$$`)
    .replace(/(?<!\\)\\\[((?:(?!\\\])[^\n])+?)\\\]/g, (_, body: string) => `$$${body.trim()}$$`)
    .replace(/(?<!\\)\\\(((?:(?!\\\))[^\n])+?)\\\)/g, (_, body: string) => `$${body.trim()}$`))).join('');
}
// The formula's own lines keep their indentation; one written beside the
// delimiter takes the delimiter's.
function displayLines(body: string, indent: string) {
  const lines = body.split('\n');
  if (!lines[0].trim()) lines.shift(); else lines[0] = indent + lines[0].trim();
  if (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop(); else lines[lines.length - 1] = lines[lines.length - 1].trimEnd();
  return lines.join('\n');
}
// Single dollars pair as in Pandoc: the opening one comes before a non-space,
// and the next dollar closes it if it follows a non-space and precedes no
// digit. Any other dollar, such as a price, is escaped and stays literal.
function literalDollars(text: string) {
  let out = '';
  for (let i = 0; i < text.length;) {
    if (text[i] === '\\') { out += text.slice(i, i + 2); i += 2; continue; }
    if (text[i] !== '$') { out += text[i++]; continue; }
    if (text[i + 1] === '$') {
      const end = text.indexOf('$$', i + 2);
      out += text.slice(i, end < 0 ? i + 2 : end + 2); i = end < 0 ? i + 2 : end + 2; continue;
    }
    let close = -1;
    if (/\S/.test(text[i + 1] || '')) for (let j = i + 1; j < text.length; j++) {
      if (text[j] === '\\') { j++; continue; }
      if (text.startsWith('\n\n', j)) break;
      if (text[j] === '$') { if (text[j + 1] !== '$' && /\S/.test(text[j - 1]) && !/\d/.test(text[j + 1] || '')) close = j; break; }
    }
    if (close < 0) { out += '\\$'; i++; } else { out += text.slice(i, close + 1); i = close + 1; }
  }
  return out;
}

let loadedMath: MathPlugins | null = null, loadingMath: Promise<MathPlugins> | null = null;
function useMath(wanted: boolean) {
  const [math, setMath] = useState(loadedMath);
  useEffect(() => {
    if (!wanted || math) return;
    let live = true;
    loadingMath ??= import('./math.ts').then(module => loadedMath = module.math);
    loadingMath.then(value => { if (live) setMath(value); }, () => { loadingMath = null; });
    return () => { live = false; };
  }, [wanted, math]);
  return wanted ? math : null;
}

// Defined once: a component created during render is a new element type each
// time, so React would rebuild every heading, link and table on every render.
const components: Components = {
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h4>{children}</h4>,
  h3: ({ children }) => <h5>{children}</h5>,
  h4: ({ children }) => <h6>{children}</h6>,
  h5: ({ children }) => <h6>{children}</h6>,
  a: ({ href, children, title }) => !href ? <>{children}</> : /^(?:https?:\/\/|mailto:)/i.test(href)
    ? <a href={href} title={title} target="_blank" rel="noreferrer">{children}</a>
    : href.startsWith('#') ? <a href={href}>{children}</a> : <FileReference path={href}>{children}</FileReference>,
  table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>,
  pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
  // Do not load arbitrary images embedded in agent output automatically.
  img: ({ alt }) => <span>{alt}</span>,
};
const urlTransform = (url: string) => /^(?:https?:\/\/|mailto:|#)/i.test(url) || (!/^[a-z][a-z\d+.-]*:/i.test(url) && !url.startsWith('//')) ? url : '';
const plainPlugins = [remarkGfm];

// Renders agent replies. Raw HTML stays text, only web and mail links open,
// and mathematics is typeset once KaTeX has loaded (until then it shows as written).
export const MarkdownView = memo(function MarkdownView({ text, math }: { text: string; math?: MathPlugins | null }) {
  const remarkPlugins = useMemo(() => math?.remark ? [remarkGfm, ...math.remark] : plainPlugins, [math]);
  return <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={math?.rehype} urlTransform={urlTransform} components={components}>{math ? normalizeMath(text) : text}</ReactMarkdown>;
});

// Parsing is the costly part, so a reply renders again only when its text changes.
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <MarkdownView text={text} math={useMath(hasMath(text))}/>;
});
