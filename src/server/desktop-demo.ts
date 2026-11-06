import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import type { Workspace } from './workspace.ts';
import type { Store } from './store.ts';
import { workingTree, type Manuscripts } from './manuscript.ts';
import { copyExamplePaper } from './example-paper.ts';
import { findExecutable } from '../../bin/agent-paths.mjs';

// A source fingerprint without Git lets the bundled preview remain readable
// before installation, without claiming an edited paper matches that PDF.
function sourceTree(root: string, legacy = false) {
  const hash = createHash('sha256');
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git' || entry.name === 'preview') continue;
      // npm omits this metadata from the bundle; Git initialization recreates
      // it without changing the paper that produced the bundled PDF.
      if (!legacy && directory === root && entry.name === '.gitignore') continue;
      const file = path.join(directory, entry.name);
      hash.update(JSON.stringify(path.relative(root, file).split(path.sep)));
      if (entry.isDirectory()) walk(file);
      else hash.update(entry.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file));
    }
  };
  walk(root); return hash.digest('hex');
}

// Seed once per data directory. Removing the sample is a lasting choice;
// upgrades must never replace an author's edits with a new example.
export async function desktopDemo(root: string, data: string, store: Store, workspace: Workspace, manuscripts: Manuscripts, hasGit = () => Boolean(findExecutable('git'))) {
  const marker = path.join(data, 'desktop-demo.json');
  let saved: { id?: string; tree?: string; source?: string; pendingGit?: boolean };
  const save = () => { fs.writeFileSync(marker + '.tmp', JSON.stringify(saved), { mode: 0o600 }); fs.renameSync(marker + '.tmp', marker); };
  if (fs.existsSync(marker)) saved = JSON.parse(fs.readFileSync(marker, 'utf8'));
  else {
    saved = {};
    if (!store.projects().length) {
      const source = path.join(root, 'examples/papilot-paper'), paper = path.join(data, 'example-paper');
      fs.accessSync(path.join(source, 'preview/main.pdf'));
      fs.accessSync(path.join(source, 'preview/main.synctex.gz'));
      const fresh = !fs.existsSync(paper);
      if (fresh) copyExamplePaper(source, paper, { excludePreview: true });
      const expectedSource = sourceTree(source);
      const git = hasGit();
      const project = git ? await workspace.addProject(paper, 'Papilot · Demo paper')
        : { id: randomUUID(), name: 'Papilot · Demo paper', path: fs.realpathSync(paper), createdAt: Date.now() };
      if (!git) store.saveProject(project);
      const preview = path.join(data, 'demo-preview');
      fs.mkdirSync(preview, { recursive: true });
      fs.copyFileSync(path.join(source, 'preview/main.pdf'), path.join(preview, 'main.pdf'));
      const synctex = gunzipSync(fs.readFileSync(path.join(source, 'preview/main.synctex.gz'))).toString();
      fs.writeFileSync(path.join(preview, 'main.synctex.gz'), gzipSync(synctex.replaceAll('@PAPILOT_EXAMPLE@', project.path.split(path.sep).join('/'))));
      const tree = git ? await workingTree(project.path) : undefined;
      const matches = sourceTree(project.path) === expectedSource;
      saved = { id: project.id, pendingGit: !git, ...(matches ? { source: expectedSource, tree } : {}) };
    }
    save();
  }
  const project = store.projects().find(project => project.id === saved.id);
  const pdf = path.join(data, 'demo-preview/main.pdf');
  // Older installations saved only a Git tree. Recover the source fingerprint
  // only when both their paper and cached PDF still match the bundled pair.
  // Otherwise the old PDF remains readable, but is never labelled current.
  if (project && saved.tree && !saved.source && fs.existsSync(pdf)) {
    const source = path.join(root, 'examples/papilot-paper');
    if (fs.readFileSync(pdf).equals(fs.readFileSync(path.join(source, 'preview/main.pdf')))) {
      const fingerprint = sourceTree(source);
      if (sourceTree(project.path) === fingerprint) { saved.source = fingerprint; save(); }
    }
  }
  if (project && fs.existsSync(pdf)) {
    for (const tree of new Set([saved.source, saved.tree])) if (tree) await manuscripts.rememberPreview(project.path, tree, pdf);
  }
  let previewOnly = false;
  const unchanged = () => {
    try {
      // Keep fingerprints written before Git metadata was excluded readable.
      return Boolean(saved.source) && (sourceTree(project!.path) === saved.source || sourceTree(project!.path, true) === saved.source);
    } catch { return false; }
  };
  const seed = async () => {
    if (!project || !fs.existsSync(pdf)) return;
    if (!hasGit()) {
      const tree = saved.tree || saved.source;
      if (tree) { await manuscripts.seedPreview(project.id, project.path, tree, pdf, unchanged); previewOnly = true; }
    } else if (saved.tree && await workingTree(project.path) === saved.tree) await manuscripts.seedPreview(project.id, project.path, saved.tree, pdf);
  };
  // Called by state refreshes. Install Git without losing the demo's identity,
  // notes or source edits; concurrent readers share the same initialization.
  let enabling: Promise<void> | undefined;
  const enableGit = async () => {
    if (enabling) return enabling;
    if (!project || (!saved.pendingGit && !previewOnly) || !hasGit() || !store.projects().some(item => item.id === project.id)) return;
    enabling = (async () => {
      if (saved.pendingGit) {
        await workspace.addProject(project.path, project.name);
        const tree = await workingTree(project.path);
        saved.tree = unchanged() ? tree : undefined;
      }
      saved.pendingGit = false; save();
      manuscripts.releasePreview(project.id);
      previewOnly = false;
      await seed();
    })().finally(() => { enabling = undefined; });
    return enabling;
  };
  await enableGit();
  await seed();
  return enableGit;
}
