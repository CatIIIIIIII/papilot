// Builds the static landing page. Only Node is needed: its windows are
// drawn in HTML and CSS, not screenshots or video.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { translatedSite } from './site-i18n.mjs';

const root = path.resolve(import.meta.dirname, '..');
// The build empties this folder first, so it takes no folder argument that
// could name the source or the repository by mistake.
const out = path.join(root, '_site');
const site = 'https://papilot.ai/';
const copy = (from, names, to = '') => {
  fs.mkdirSync(path.join(out, to), { recursive: true });
  for (const name of names) fs.copyFileSync(path.join(root, from, name), path.join(out, to, name));
};

fs.rmSync(out, { recursive: true, force: true });
copy('site', ['style.css']);
const source = fs.readFileSync(path.join(root, 'site/index.html'), 'utf8');
// GitHub Pages lets browsers keep every file for ten minutes, so a fresh page
// could meet a stylesheet or script cached from the previous release. Their
// URLs carry a hash of their content instead.
const version = name => crypto.createHash('sha256').update(fs.readFileSync(path.join(out, name))).digest('hex').slice(0, 10);
// Download links name the release this commit belongs to.
const { version: release } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const names = JSON.parse(fs.readFileSync(path.join(root, 'i18n/languages.json'), 'utf8'));
const locales = ['en', ...Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'i18n/config.json'), 'utf8')).locales)];
if (JSON.stringify(Object.keys(names)) !== JSON.stringify(locales)) throw new Error('Website languages must match the App configuration.');
const urlFor = locale => site + (locale === 'en' ? '' : `${locale}/`);
const ogLocales = { en: 'en_US', 'zh-CN': 'zh_CN', 'zh-Hant': 'zh_TW', ja: 'ja_JP', ko: 'ko_KR', de: 'de_DE', fr: 'fr_FR', es: 'es_ES', pt: 'pt_BR', it: 'it_IT', sv: 'sv_SE' };
const alternates = locales.map(locale => `<link rel="alternate" hreflang="${locale}" href="${urlFor(locale)}">`).join('\n') + `\n<link rel="alternate" hreflang="x-default" href="${site}">`;
for (const locale of locales) {
  const translations = locale === 'en' ? {} : JSON.parse(fs.readFileSync(path.join(root, `site/locales/${locale}.json`), 'utf8'));
  const menu = locales.map(code => `<a href="${code === 'en' ? '/' : `/${code}/`}" role="menuitemradio" lang="${code}" aria-checked="${code === locale}" tabindex="-1">${names[code]}<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg></a>`).join('');
  const translated = translatedSite(source, translations, locale);
  const title = translated.match(/<title>([^<]*)<\/title>/)[1];
  let html = translated
    .replaceAll('{{version}}', release)
    .replace(/<link rel="alternate"[^>]*>/g, '')
    .replace(/<link rel="canonical"[^>]*>/, `<link rel="canonical" href="${urlFor(locale)}">\n${alternates}`)
    .replace(/<meta property="og:url"[^>]*>/, `<meta property="og:url" content="${urlFor(locale)}">\n<meta property="og:locale" content="${ogLocales[locale]}">`)
    .replace(/<meta property="og:title"[^>]*>/, `<meta property="og:title" content="${title.replaceAll('"', '&quot;')}">`)
    .replace(/(<div class="lang-list"[^>]*>)(<\/div>)/, `$1${menu}$2`)
    .replace('<body>', `<body><noscript><nav class="no-js-languages">${locales.map(code => `<a lang="${code}" href="${code === 'en' ? '/' : `/${code}/`}">${names[code]}</a>`).join('')}</nav></noscript>`)
    .replace(/(\s(?:href|src)=")(style\.css)"/g, (_, attr, name) => `${attr}/${name}?v=${version(name)}"`)
    .replace(/(\s(?:href|src)=")((?:assets|fonts)\/[^" ]+|favicon.png|apple-touch-icon.png)"/g, '$1/$2"');
  if (locale !== 'en') html = html.replace('https://github.com/cu1ch3n/papilot#readme', `https://github.com/cu1ch3n/papilot/blob/main/docs/readme/README.${locale}.md`);
  // Explicit URLs always win. Only the root restores a saved choice; browser
  // language never redirects visitors or crawlers. Old ?lang links still work.
  html = html.replace('<!-- language-preference -->', `<script>
  (() => {
    const languages = ${JSON.stringify(locales)};
    let choice = new URLSearchParams(location.search).get('lang');
    if (!choice && location.pathname === '/') { try { choice = localStorage.getItem('papilot-lang'); } catch {} }
    if (choice === 'zh-Hans') choice = 'zh-CN';
    if (languages.includes(choice)) {
      const target = choice === 'en' ? '/' : '/' + choice + '/';
      if (location.pathname !== target) location.replace(target + location.hash);
    }
  })();
  </script>`);
  const directory = path.join(out, locale === 'en' ? '' : locale);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'index.html'), html);
}
const sitemapAlternates = [...locales, 'x-default'].map(locale => `<xhtml:link rel="alternate" hreflang="${locale}" href="${urlFor(locale === 'x-default' ? 'en' : locale)}"/>`).join('');
fs.writeFileSync(path.join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${locales.map(locale => `<url><loc>${urlFor(locale)}</loc>${sitemapAlternates}</url>`).join('')}</urlset>\n`);
fs.writeFileSync(path.join(out, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${site}sitemap.xml\n`);
copy('public', ['favicon.png', 'apple-touch-icon.png']);
copy('docs/assets', ['logo.svg', 'social-preview.png'], 'assets');
// The agents' marks are the app's own icons, with their license.
copy('src/web/brand-icons', fs.readdirSync(path.join(root, 'src/web/brand-icons')).filter(name => /^(?!git|latex)[a-z]+\.svg$|^LICENSE-LobeHub\.txt$/.test(name)), 'assets/agents');
copy('src/web/fonts', fs.readdirSync(path.join(root, 'src/web/fonts')).filter(name => /\.(otf|txt)$/.test(name)), 'fonts');

// Resolve each reference against its actual page URL, including nested pages.
const missing = [];
for (const locale of locales) {
  const html = fs.readFileSync(path.join(out, locale === 'en' ? '' : locale, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/\s(?:src|href|poster)="([^"]*)"/g)].map(match => match[1]);
  refs.push(...[...html.matchAll(/\scontent="([^"]*)"/g)].map(match => match[1]).filter(value => value.startsWith(site)));
  for (const ref of refs) {
    const url = new URL(ref, urlFor(locale));
    if (url.origin !== new URL(site).origin) continue;
    const file = path.join(out, decodeURIComponent(url.pathname), url.pathname.endsWith('/') ? 'index.html' : '');
    if (!fs.existsSync(file)) missing.push(`${locale}: ${ref}`);
  }
}
for (const name of ['style.css']) {
  const css = fs.readFileSync(path.join(out, name), 'utf8');
  for (const [, ref] of css.matchAll(/url\("?([^"\)]*)"?\)/g)) {
    const url = new URL(ref, site + name);
    if (url.origin === new URL(site).origin && !fs.existsSync(path.join(out, url.pathname))) missing.push(ref);
  }
}
if (missing.length) throw new Error(`The page points to files the build does not have: ${[...new Set(missing)].join(', ')}`);
console.log(`Site built in ${path.relative(process.cwd(), out) || '.'}: ${locales.length} languages`);
