// Publishes the tested nightly build of main to the rolling desktop-dev
// prerelease, which desktop apps on the Dev channel check. Installers are uploaded only when the
// shell changed; otherwise apps update with the few-megabyte layer and the
// previous installers stay. Assets the previous manifest names are kept, so
// an app that just read it can still download them.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { INSTALLER_SUFFIXES, reusableInstallers } from './desktop-layer.mjs';

const folder = path.resolve(process.argv[2] || 'release/desktop');
const tag = 'desktop-dev', repo = process.env.GITHUB_REPOSITORY, commit = process.env.GITHUB_SHA;
if (!repo || !commit) throw new Error('Run this in GitHub Actions with GITHUB_REPOSITORY and GITHUB_SHA.');
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 16 * 1024 * 1024 });
const file = name => path.join(folder, name);

const manifest = JSON.parse(fs.readFileSync(file('desktop.json'), 'utf8'));
const revision = /^(\d+\.\d+\.\d+)-dev\.([a-f0-9]{40})$/.exec(manifest.version);
if (!revision || revision[2] !== commit) throw new Error(`The update layer ${manifest.version} was not built from ${commit}.`);
if (!fs.existsSync(file(manifest.layer.name))) throw new Error(`Missing ${manifest.layer.name}.`);
const base = revision[1], label = `${base}-dev.${commit.slice(0, 7)}`;
for (const suffix of INSTALLER_SUFFIXES) if (!fs.existsSync(file(`Papilot-${base}-${suffix}`))) throw new Error(`Missing the tested installer Papilot-${base}-${suffix}.`);

const title = `Papilot ${label}`;
const notes = `Development build of ${repo}@${commit} from main. It may be less stable than a release.\n\n`
  + 'Desktop apps on the **Dev** channel (Settings → Updates) install it in place, downloading only Papilot\'s own code '
  + `(${(manifest.layer.size / 1048576).toFixed(1)} MB) when their installer matches this build. Otherwise, download the installer for your system below; papers and settings stay in place.`;
let release;
try { release = JSON.parse(gh('api', `repos/${repo}/releases/tags/${tag}`)); }
catch {
  gh('release', 'create', tag, '--prerelease', '--latest=false', '--target', commit, '--title', title, '--notes', notes);
  release = JSON.parse(gh('api', `repos/${repo}/releases/tags/${tag}`));
}
const existing = new Set(release.assets.map(asset => asset.name));
const previous = existing.has('desktop.json') ? JSON.parse(gh('release', 'download', tag, '--pattern', 'desktop.json', '--output', '-')) : null;

let installers = reusableInstallers(previous, [...existing], manifest.fingerprint);
if (installers) console.log(`The shell is unchanged; keeping ${installers.join(', ')}.`);
else {
  installers = INSTALLER_SUFFIXES.map(suffix => `Papilot-${label}-${suffix}`);
  INSTALLER_SUFFIXES.forEach((suffix, index) => fs.renameSync(file(`Papilot-${base}-${suffix}`), file(installers[index])));
  gh('release', 'upload', tag, ...installers.map(file), '--clobber');
}
gh('release', 'upload', tag, file(manifest.layer.name), '--clobber');
// The manifest goes last: it only names assets that are already uploaded.
fs.writeFileSync(file('desktop.json'), JSON.stringify({ ...manifest, installers }, null, 2) + '\n');
gh('release', 'upload', tag, file('desktop.json'), '--clobber');

const keep = new Set(['desktop.json', manifest.layer.name, ...installers, ...(previous ? [previous.layer?.name, ...(previous.installers || [])] : [])]);
for (const name of existing) if (!keep.has(name)) gh('release', 'delete-asset', tag, name, '--yes');
gh('api', '-X', 'PATCH', `repos/${repo}/git/refs/tags/${tag}`, '-f', `sha=${commit}`, '-F', 'force=true');
gh('release', 'edit', tag, '--title', title, '--notes', notes, '--prerelease', '--latest=false');
console.log(`Published ${title}.`);
