import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';

export const blogLanguageNames = JSON.parse(fs.readFileSync(new URL('../i18n/languages.json', import.meta.url), 'utf8'));
export const blogLocales = Object.keys(blogLanguageNames);
export const blogOgLocales = { en: 'en_US', 'zh-CN': 'zh_CN', 'zh-Hant': 'zh_TW', ja: 'ja_JP', ko: 'ko_KR', de: 'de_DE', fr: 'fr_FR', es: 'es_ES', pt: 'pt_BR', it: 'it_IT', sv: 'sv_SE' };
export const blogRoute = (locale, slug = '') => `${locale === 'en' ? '' : '/' + locale}/blog/${slug ? slug + '/' : ''}`;
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const json = value => JSON.stringify(value).replaceAll('<', '\\u003c');
const text = node => node.type === 'text' ? node.value : (node.children || []).map(text).join('');
const readingMinutes = (value, locale) => {
  const prose = value.replace(/!\[[^\]]*\]\([^\n]*\)/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[`#*_]/g, '');
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  const characters = [...prose].filter(char => cjk.test(char)).length;
  const words = [...new Intl.Segmenter(locale, { granularity: 'word' }).segment(prose)].filter(word => word.isWordLike && !cjk.test(word.segment)).length;
  return Math.max(1, Math.ceil(characters / 450 + words / 220));
};

function date(value, file) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error(`Invalid blog date in ${file}`);
  return value;
}

export function loadBlogPosts(root) {
  const directory = path.join(root, 'site/blog/posts');
  const posts = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name, file = path.join(directory, slug, 'post.json');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error(`Invalid blog slug: ${slug}`);
    const post = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (post.draft === true) continue;
    date(post.published, file);
    if (post.updated) { date(post.updated, file); if (post.updated < post.published) throw new Error(`Blog update predates publication: ${slug}`); }
    if (!post.locales || !Object.keys(post.locales).length) throw new Error(`Missing blog translations: ${slug}`);
    for (const [locale, content] of Object.entries(post.locales)) {
      if (!blogLocales.includes(locale)) throw new Error(`Unsupported blog locale: ${locale}`);
      for (const key of ['title', 'description', 'lead', 'hero', 'heroAlt', 'heroCaption']) if (typeof content[key] !== 'string' || !content[key].trim()) throw new Error(`Missing ${locale}.${key}: ${slug}`);
      content.body = fs.readFileSync(path.join(directory, slug, `${locale}.md`), 'utf8');
      if (!content.body.trim() || /^# /m.test(content.body)) throw new Error(`Blog body must be nonempty and start headings at h2: ${slug}/${locale}`);
      content.minutes = readingMinutes(content.body, locale);
    }
    posts.push({ ...post, slug });
  }
  return posts.sort((a, b) => b.published.localeCompare(a.published) || a.slug.localeCompare(b.slug));
}

export function buildBlog({ root, out, site, analytics, version }) {
  const posts = loadBlogPosts(root), pages = [], sitemap = [];
  const copy = Object.fromEntries(blogLocales.map(locale => [locale, JSON.parse(fs.readFileSync(path.join(root, `site/blog/locales/${locale}.json`), 'utf8')).ui]));
  for (const locale of blogLocales) {
    for (const key of Object.keys(copy['zh-CN'])) {
      if (typeof copy[locale]?.[key] !== 'string' || !copy[locale][key].trim()) throw new Error(`Missing blog interface translation: ${locale}.${key}`);
    }
    if (!copy[locale].readingTime.includes('{minutes}')) throw new Error(`Missing reading-time placeholder: ${locale}`);
  }
  const assetDir = path.join(out, 'assets/blog');
  fs.mkdirSync(assetDir, { recursive: true });
  fs.cpSync(path.join(root, 'site/blog/assets'), assetDir, { recursive: true });
  for (const name of ['blog.css', 'blog.js']) fs.copyFileSync(path.join(root, 'site/blog', name), path.join(out, name));
  // Reuse the localized product illustrations, including their mobile and dark variants.
  for (const locale of ['en', 'zh-CN']) for (const [name, source] of [['review', 'hero'], ['notes', 'notes-app']]) {
    for (const variant of ['', '-dark', '-compact', '-compact-dark']) {
      fs.copyFileSync(path.join(root, 'docs/assets/readme-showcase', `${source}${variant}${locale === 'en' ? '' : '.' + locale}.png`), path.join(assetDir, `${name}${variant}.${locale}.png`));
    }
  }
  const url = route => new URL(route, site).href;
  const write = (route, html) => {
    const directory = route.replace(/^\//, '');
    fs.mkdirSync(path.join(out, directory), { recursive: true });
    fs.writeFileSync(path.join(out, directory, 'index.html'), html);
    pages.push(directory.replace(/\/$/, ''));
  };
  const dimensions = src => {
    if (!/^\/assets\/blog\/[\w.-]+\.(png|svg)$/.test(src)) throw new Error(`Blog images must be local assets: ${src}`);
    const data = fs.readFileSync(path.join(out, src));
    if (src.endsWith('.png')) return [data.readUInt32BE(16), data.readUInt32BE(20)];
    const viewBox = data.toString().match(/viewBox="0 0 (\d+) (\d+)"/);
    if (!viewBox) throw new Error(`Blog SVG needs a viewBox: ${src}`);
    return viewBox.slice(1).map(Number);
  };
  let illustrationId = 0;
  const picture = (src, alt, eager = false, responsive = true) => {
    const [width, height] = dimensions(src);
    const product = /\/(review|notes)\.(en|zh-CN)\.png$/.exec(src);
    const image = (file, className, mobile) => {
      const compact = responsive && mobile && dimensions(mobile);
      return React.createElement('picture', { className }, compact && React.createElement('source', { media: '(max-width: 600px)', srcSet: mobile, width: compact[0], height: compact[1] }), React.createElement('img', { src: file, alt, width, height, loading: eager ? 'eager' : 'lazy', decoding: 'async', ...(eager ? { fetchPriority: 'high' } : {}) }));
    };
    if (!product) {
      const compact = src.replace(/(\.[a-z]{2}(?:-[A-Za-z]+)?)?\.svg$/, '-compact$1.svg');
      if (src.endsWith('.svg')) {
        // These are trusted, repository-authored diagrams. Inline them so text
        // uses the same locally hosted serif fonts and theme as the article.
        const inline = (file, className) => {
          const prefix = `blog-art-${++illustrationId}-`;
          const svg = fs.readFileSync(path.join(out, file), 'utf8')
            .replace(/\bid="([^"]+)"/g, (_, id) => `id="${prefix}${id}"`)
            .replace(/url\(#([^)]+)\)/g, (_, id) => `url(#${prefix}${id})`)
            .replace(/aria-labelledby="([^"]+)"/g, (_, ids) => `aria-labelledby="${ids.split(/\s+/).map(id => prefix + id).join(' ')}"`);
          return React.createElement('span', { className, dangerouslySetInnerHTML: { __html: svg } });
        };
        const hasCompact = responsive && compact !== src && fs.existsSync(path.join(out, compact));
        return React.createElement('span', { className: `blog-illustration${hasCompact ? ' blog-illustration-responsive' : ''}`, role: 'img', 'aria-label': alt }, inline(src, 'blog-art-wide'), hasCompact && inline(compact, 'blog-art-compact'));
      }
      return image(src, 'blog-illustration');
    }
    const [, name, locale] = product, variant = suffix => `/assets/blog/${name}${suffix}.${locale}.png`;
    return React.createElement(React.Fragment, null, image(src, 'blog-image-light', variant('-compact')), image(variant('-dark'), 'blog-image-dark', variant('-compact-dark')));
  };
  const illustration = (src, alt, caption, eager = false, figureLabel = 'Figure') => `<figure class="blog-figure">${renderToStaticMarkup(picture(src, alt, eager))}${caption ? `<figcaption data-label="${escape(figureLabel)}">${escape(caption)}</figcaption>` : ''}</figure>`;
  const alternates = routes => Object.entries(routes).map(([locale, route]) => `<link rel="alternate" hreflang="${locale}" href="${url(route)}">`).join('\n') + `\n<link rel="alternate" hreflang="x-default" href="${url(routes.en || Object.values(routes)[0])}">`;
  const sitemapEntry = (route, routes, modified) => `<url><loc>${url(route)}</loc>${modified ? `<lastmod>${modified}</lastmod>` : ''}${Object.entries(routes).map(([locale, alternate]) => `<xhtml:link rel="alternate" hreflang="${locale}" href="${url(alternate)}"/>`).join('')}<xhtml:link rel="alternate" hreflang="x-default" href="${url(routes.en || Object.values(routes)[0])}"/></url>`;
  const localizedDate = (value, locale) => new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(value));
  function shell({ locale, title, description, route, routes, image, main, schema, article = false, imageAlt, published, updated }) {
    const t = copy[locale], home = locale === 'en' ? '/' : `/${locale}/`;
    const languages = Object.entries(routes).map(([code, href]) => `<a class="blog-language" lang="${code}" hreflang="${code}" href="${href}"${code === locale ? ' aria-current="true"' : ''}>${blogLanguageNames[code]}</a>`).join('');
    const canonical = url(route), social = url(image || '/assets/social-preview.png');
    const socialBytes = image ? null : fs.readFileSync(path.join(root, 'docs/assets/social-preview.png'));
    const [socialWidth, socialHeight] = image ? dimensions(image) : [socialBytes.readUInt32BE(16), socialBytes.readUInt32BE(20)];
    const pageTitle = article ? `${title} · Papilot` : title;
    const tracking = analytics.replace(/src="(statistics-preferences|analytics)\.js"/g, (_, name) => `src="/${name}.js?v=${version(name + '.js')}"`);
    return `<!doctype html>
<html lang="${locale}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(pageTitle)}</title><meta name="description" content="${escape(description)}">
<link rel="canonical" href="${canonical}">${alternates(routes)}
<meta name="robots" content="index,follow,max-image-preview:large">
<meta property="og:type" content="${article ? 'article' : 'website'}"><meta property="og:site_name" content="Papilot"><meta property="og:locale" content="${blogOgLocales[locale]}">
<meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}"><meta property="og:url" content="${canonical}"><meta property="og:image" content="${social}">
${Object.keys(routes).filter(code => code !== locale).map(code => `<meta property="og:locale:alternate" content="${blogOgLocales[code]}">`).join('')}
<meta property="og:image:width" content="${socialWidth}"><meta property="og:image:height" content="${socialHeight}"><meta property="og:image:alt" content="${escape(imageAlt || title)}">
${published ? `<meta property="article:published_time" content="${published}T00:00:00+08:00">` : ''}${updated ? `<meta property="article:modified_time" content="${updated}T00:00:00+08:00">` : ''}
<meta name="twitter:image:alt" content="${escape(imageAlt || title)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escape(title)}"><meta name="twitter:description" content="${escape(description)}"><meta name="twitter:image" content="${social}">
<link rel="alternate" type="application/rss+xml" title="${escape(t.blog)} · Papilot" href="${blogRoute(locale)}feed.xml">
<link rel="icon" href="/favicon.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preload" href="/fonts/TeXGyrePagellaX-Regular.otf" as="font" type="font/otf" crossorigin>
<script>try{const theme=localStorage.getItem('papilot-theme');if(theme==='light'||theme==='dark')document.documentElement.dataset.theme=theme;}catch{}</script>
<link rel="stylesheet" href="/style.css?v=${version('style.css')}"><link rel="stylesheet" href="/blog.css?v=${version('blog.css')}">
<script defer src="/blog.js?v=${version('blog.js')}"></script><script type="application/ld+json">${json(schema)}</script>${tracking}
</head><body class="blog-page">
<a class="blog-skip" href="#content">${t.skip}</a>
<header class="topbar"><div class="wrap topbar-inner">
<a class="brand" href="${home}"><img class="brand-mark" src="/assets/logo.svg" alt="" width="26" height="26"><span>Papilot</span></a>
<nav class="blog-nav" aria-label="${escape(t.mainNavigation)}"><a class="blog-product-link" href="${home}#why">${t.product}</a><a href="${blogRoute(locale)}" aria-current="${article ? 'location' : 'page'}">${t.blog}</a></nav>
<div class="topbar-actions"><details class="blog-languages"><summary aria-label="${escape(t.languageLabel)}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></svg><span>${blogLanguageNames[locale]}</span><svg class="blog-language-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg></summary><nav aria-label="${escape(t.languageLabel)}">${languages}</nav></details><button class="icon-button blog-theme" aria-label="${t.theme}" aria-pressed="false" hidden><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none"/></svg></button><a class="button compact blog-demo" href="/demo/">${t.demo}</a></div>
</div></header>
<main id="content">${main}</main>
<footer class="footer blog-footer"><div class="wrap footer-inner"><a class="brand" href="${home}">Papilot</a><nav aria-label="${escape(t.footerNavigation)}"><a href="${blogRoute(locale)}">${t.blog}</a><a href="${blogRoute(locale)}feed.xml">RSS</a><a href="https://github.com/PapilotAI/papilot">GitHub</a><a href="/privacy/">${t.privacy}</a></nav><p>MIT © 2026 PapilotAI</p></div></footer>
</body></html>`;
  }
  for (const locale of blogLocales) {
    const t = copy[locale], localized = posts.filter(post => post.locales[locale]);
    const indexRoutes = Object.fromEntries(blogLocales.map(code => [code, blogRoute(code)]));
    const cards = localized.map((post, index) => {
      const entry = post.locales[locale], route = blogRoute(locale, post.slug);
      const cover = renderToStaticMarkup(picture(entry.hero, entry.heroAlt, index === 0, false));
      return `<article class="blog-card"><a class="blog-card-image" href="${route}" aria-label="${escape(entry.title)}">${cover}</a><div class="blog-card-copy"><time datetime="${post.published}">${localizedDate(post.published, locale)}</time><h2><a href="${route}">${escape(entry.title)}</a></h2><p>${escape(entry.lead)}</p></div></article>`;
    }).join('');
    const main = `<div class="wrap blog-index"><header class="blog-index-head"><div><h1>${escape(t.indexTitle)}</h1><p>${escape(t.indexDescription)}</p></div><a class="blog-rss" href="${blogRoute(locale)}feed.xml" aria-label="${escape(t.rss)}">RSS <span aria-hidden="true">↗</span></a></header><section class="blog-list" aria-label="${escape(t.back)}">${cards || `<p>${escape(t.empty)}</p>`}</section></div>`;
    write(blogRoute(locale), shell({ locale, title: t.indexSeoTitle, description: t.indexSeoDescription, route: blogRoute(locale), routes: indexRoutes, main, schema: { '@context': 'https://schema.org', '@type': 'Blog', '@id': url(blogRoute(locale)) + '#blog', name: `Papilot ${t.blog}`, url: url(blogRoute(locale)), inLanguage: locale, description: t.indexSeoDescription, blogPost: localized.map(post => ({ '@type': 'BlogPosting', headline: post.locales[locale].title, url: url(blogRoute(locale, post.slug)) })) } }));
    const latestUpdate = localized.map(post => post.updated || post.published).sort().at(-1);
    sitemap.push(sitemapEntry(blogRoute(locale), indexRoutes, latestUpdate));
    const feed = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>Papilot ${t.blog}</title><link>${url(blogRoute(locale))}</link><description>${escape(t.indexDescription)}</description><language>${locale}</language><atom:link href="${url(blogRoute(locale) + 'feed.xml')}" rel="self" type="application/rss+xml"/>${localized.map(post => { const entry = post.locales[locale], link = url(blogRoute(locale, post.slug)); return `<item><title>${escape(entry.title)}</title><link>${link}</link><guid isPermaLink="true">${link}</guid><pubDate>${new Date(post.published + 'T00:00:00+08:00').toUTCString()}</pubDate><description>${escape(entry.description)}</description></item>`; }).join('')}</channel></rss>`;
    fs.writeFileSync(path.join(out, blogRoute(locale), 'feed.xml'), feed);
    for (const post of localized) {
      const entry = post.locales[locale], route = blogRoute(locale, post.slug), toc = [], ids = new Set();
      const routes = Object.fromEntries(Object.keys(post.locales).map(code => [code, blogRoute(code, post.slug)]));
      const heading = level => ({ node, children }) => {
        const label = text(node), base = label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section';
        let id = base, count = 1; while (ids.has(id)) id = base + '-' + ++count; ids.add(id);
        if (level === 'h2') toc.push({ id, label });
        return React.createElement(level, { id }, children);
      };
      const body = renderToStaticMarkup(React.createElement(Markdown, { skipHtml: true, components: {
        h2: heading('h2'), h3: heading('h3'),
        img: ({ src, alt }) => picture(src, alt),
        p: ({ node, children }) => {
          const images = node.children.filter(child => child.tagName === 'img');
          if (images.length && node.children.every(child => child.tagName === 'img' || child.type === 'text' && !child.value.trim())) return React.createElement('figure', { className: 'blog-figure' }, children, images[0].properties.title && React.createElement('figcaption', { 'data-label': t.figureLabel }, images[0].properties.title));
          return React.createElement('p', null, children);
        },
      } }, entry.body));
      const metadata = `<span>${t.author}</span><span aria-hidden="true">/</span><time datetime="${post.published}">${localizedDate(post.published, locale)}</time><span aria-hidden="true">/</span><span>${escape(t.readingTime.replace('{minutes}', new Intl.NumberFormat(locale).format(entry.minutes)))}</span>`;
      const main = `<article class="wrap blog-article" data-figure-label="${escape(t.figureLabel)}"><header class="blog-article-head"><nav class="blog-breadcrumb" aria-label="${escape(t.breadcrumb)}"><a href="${blogRoute(locale)}">${t.blog}</a><span aria-hidden="true">/</span><span>${t.category}</span></nav><h1>${escape(entry.title)}</h1><p class="blog-deck">${escape(entry.lead)}</p><div class="blog-meta">${metadata}</div></header><div class="blog-hero">${illustration(entry.hero, entry.heroAlt, entry.heroCaption, true, t.figureLabel)}</div><div class="blog-reading-layout"><div class="blog-prose">${body}</div><aside class="blog-toc"><nav aria-label="${t.contents}"><p>${t.contents}</p><ol>${toc.map(item => `<li><a href="#${escape(item.id)}">${escape(item.label)}</a></li>`).join('')}</ol><a class="blog-toc-back" href="${blogRoute(locale)}">← ${t.back}</a></nav></aside></div></article>`;
      const schema = { '@context': 'https://schema.org', '@graph': [
        { '@type': 'BlogPosting', '@id': url(route) + '#article', url: url(route), mainEntityOfPage: url(route), isPartOf: { '@id': url(blogRoute(locale)) + '#blog' }, headline: entry.title, description: entry.description, inLanguage: locale, datePublished: post.published + 'T00:00:00+08:00', ...(post.updated ? { dateModified: post.updated + 'T00:00:00+08:00' } : {}), image: [url(entry.hero)], author: { '@type': 'Organization', name: 'Papilot', url: site }, publisher: { '@type': 'Organization', name: 'Papilot', url: site, logo: { '@type': 'ImageObject', url: url('/apple-touch-icon.png') } } },
        { '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: t.blog, item: url(blogRoute(locale)) }, { '@type': 'ListItem', position: 2, name: entry.title, item: url(route) }] },
      ] };
      write(route, shell({ locale, title: entry.title, description: entry.description, route, routes, image: entry.hero, imageAlt: entry.heroAlt, published: post.published, updated: post.updated, main, schema, article: true }));
      sitemap.push(sitemapEntry(route, routes, post.updated || post.published));
    }
  }
  return { pages, sitemap: sitemap.join(''), posts };
}
