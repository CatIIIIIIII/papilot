// Builds the static landing page with native, progressively enhanced UI demos.
// The sample manuscript is HTML + MathML, rendered without a browser or TeX.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { renderDemo } from '../site/demo-templates.mjs';
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
copy('site', ['style.css', 'demos.css', 'demos.js']);
const source = fs.readFileSync(path.join(root, 'site/index.html'), 'utf8');
// GitHub Pages lets browsers keep every file for ten minutes, so a fresh page
// could meet a stylesheet or script cached from the previous release. Their
// URLs carry a hash of their content instead.
const version = name => crypto.createHash('sha256').update(fs.readFileSync(path.join(out, name))).digest('hex').slice(0, 10);
const translations = JSON.parse(fs.readFileSync(path.join(root, 'site/locales/zh-Hant.json'), 'utf8'));
fs.writeFileSync(path.join(out, 'index.html'), translatedSite(source
  .replace(/<!-- demo:(\w+) -->/g, (_, kind) => renderDemo(kind)), translations)
  .replace(/(\s(?:href|src)=")(style\.css|demos\.css|demos\.js)"/g, (_, attr, name) => `${attr}${name}?v=${version(name)}"`));
copy('public', ['favicon.png', 'apple-touch-icon.png']);
copy('docs/assets', ['logo.svg', 'social-preview.png'], 'assets');
copy('src/web/fonts', fs.readdirSync(path.join(root, 'src/web/fonts')).filter(name => /\.(otf|txt)$/.test(name)), 'fonts');

const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8'), css = ['style.css', 'demos.css'].map(name => fs.readFileSync(path.join(out, name), 'utf8')).join('\n');
const refs = [
  ...[...html.matchAll(/\s(?:src|href|poster|data-zh-href)="([^"]*)"/g)].map(match => match[1]),
  ...[...html.matchAll(/\scontent="([^"]*)"/g)].map(match => match[1]).filter(value => value.startsWith(site)),
  ...[...css.matchAll(/url\("?([^")]*)"?\)/g)].map(match => match[1]),
];
const missing = refs
  .map(ref => (ref.startsWith(site) ? ref.slice(site.length) : ref).replace(/[?#].*/, ''))
  .filter(ref => !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(ref))
  .map(ref => ref === '' || ref.endsWith('/') ? ref + 'index.html' : ref)
  .filter(ref => !fs.existsSync(path.join(out, ref)));
if (missing.length) throw new Error(`The page points to files the build does not have: ${[...new Set(missing)].join(', ')}`);
console.log(`Site built in ${path.relative(process.cwd(), out) || '.'}`);
