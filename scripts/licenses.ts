import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import type { AppInfo, LicenseNotice } from '../src/license-info.ts';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
// These ship in the browser even though npm lists them as development dependencies.
export const browserPackages = ['@simplewebauthn/browser', 'react', 'react-dom', 'pdfjs-dist', 'katex', 'react-markdown', 'remark-gfm', 'remark-math', 'rehype-katex'];
const readPackage = (directory: string) => JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
const readText = (file: string) => fs.readFileSync(file, 'utf8').trim();

function repositoryUrl(repository: string | { url: string } | undefined): string {
  const value = (typeof repository === 'string' ? repository : repository?.url || '').replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git\/?$/, '');
  return /^https?:\/\//.test(value) ? value : '';
}

export function appInfo(root = projectRoot): AppInfo {
  const pkg = readPackage(root);
  return { version: pkg.version, repository: repositoryUrl(pkg.repository), issues: pkg.bugs.url, license: pkg.license, licenseText: readText(path.join(root, 'LICENSE')) };
}

function resolvePackage(name: string, from: string): string | undefined {
  for (let directory = from; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    if (path.dirname(directory) === directory) return;
  }
}

// Include nested notices too: PDF.js, for example, ships separately licensed fonts and decoders.
function licenseFiles(directory: string, prefix = ''): LicenseNotice['notices'] {
  return fs.readdirSync(path.join(directory, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const name = path.join(prefix, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) return licenseFiles(directory, name);
    return entry.isFile() && /^(licen[cs]e|copying|notice|copyright)([._-]|$)/i.test(entry.name)
      ? [{ name, text: readText(path.join(directory, name)) }] : [];
  });
}

export function collectLicenses(root = projectRoot): LicenseNotice[] {
  const seen = new Set<string>(), packages = new Map<string, LicenseNotice>();
  function visit(name: string, from: string, optional = false) {
    const directory = resolvePackage(name, from);
    if (!directory) {
      if (optional) return;
      throw new Error(`Cannot collect license for ${name}. Install the project dependencies before building.`);
    }
    if (seen.has(directory)) return;
    seen.add(directory);
    const pkg = readPackage(directory);
    const key = `${pkg.name}@${pkg.version}`;
    if (!packages.has(key)) packages.set(key, {
      name: pkg.name, version: pkg.version, license: typeof pkg.license === 'string' ? pkg.license : pkg.license?.type || '',
      url: repositoryUrl(pkg.repository) || `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`,
      notices: licenseFiles(directory),
    });
    for (const dep of Object.keys(pkg.dependencies || {})) visit(dep, directory, dep in (pkg.optionalDependencies || {}));
    for (const dep of Object.keys(pkg.optionalDependencies || {})) visit(dep, directory, true);
    for (const dep of Object.keys(pkg.peerDependencies || {})) visit(dep, directory, Boolean(pkg.peerDependenciesMeta?.[dep]?.optional));
  }
  const reviewRoot = path.join(root, 'engine');
  for (const directory of [root, reviewRoot]) for (const name of Object.keys(readPackage(directory).dependencies)) visit(name, directory);
  for (const name of browserPackages) visit(name, root);
  const review = readPackage(reviewRoot);
  packages.set('latex-review', { name: 'latex-review', version: review.version, license: 'MIT', url: `${appInfo(root).repository}/tree/main/engine`, notices: [{ name: 'LICENSE', text: readText(path.join(reviewRoot, 'LICENSE')) }] });
  const fontNotice = (name: string, file: string) => ({ name, text: readText(path.join(root, file)) });
  packages.set('pagella', { name: 'TeX Gyre Pagella X / newpx', version: '', license: 'GUST Font License / LPPL-1.3c', url: 'https://ctan.org/pkg/newpx', notices: [
    fontNotice('GUST Font License', 'src/web/fonts/GUST-FONT-LICENSE.txt'),
    fontNotice('LPPL', 'engine/src/web/fonts/LPPL.txt'),
    fontNotice('Font manifest', 'engine/src/web/fonts/MANIFEST-newpx.txt'),
    fontNotice('newpx README', 'engine/src/web/fonts/README-newpx.txt'),
  ] });
  packages.set('inconsolata', { name: 'Inconsolata zi4', version: '', license: 'OFL-1.1', url: 'https://ctan.org/pkg/inconsolata', notices: [fontNotice('SIL Open Font License', 'src/web/fonts/OFL-Inconsolata.txt')] });
  packages.set('lobe-icons', { name: 'Lobe Icons', version: '1.101.0', license: 'MIT', url: 'https://github.com/lobehub/lobe-icons', notices: [fontNotice('MIT License', 'src/web/brand-icons/LICENSE-LobeHub.txt'), fontNotice('Icon sources', 'src/web/brand-icons/SOURCES.txt')] });
  packages.set('simple-icons', { name: 'Simple Icons', version: '16.36.0', license: 'CC0-1.0', url: 'https://github.com/simple-icons/simple-icons', notices: [fontNotice('CC0', 'src/web/brand-icons/LICENSE-Simple-Icons.txt')] });
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

// License text is a separate, on-demand chunk; it is available offline in packaged builds.
export function licenseInfoPlugin(): Plugin {
  return {
    name: 'papilot-license-info',
    resolveId(id) { if (id === 'virtual:papilot-info' || id === 'virtual:papilot-licenses') return `\0${id}`; },
    load(id) {
      if (id === '\0virtual:papilot-info') return `export default ${JSON.stringify(appInfo())}`;
      if (id === '\0virtual:papilot-licenses') return `export default ${JSON.stringify(collectLicenses())}`;
    },
  };
}
