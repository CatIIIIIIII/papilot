import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Workspace } from './workspace.ts';
import type { Store } from './store.ts';
import { workingTree, type Manuscripts } from './manuscript.ts';

// Seed once per data directory. Removing the sample is a lasting choice;
// upgrades must never replace an author's edits with a new example.
export async function desktopDemo(root: string, data: string, store: Store, workspace: Workspace, manuscripts: Manuscripts) {
  const marker = path.join(data, 'desktop-demo.json');
  let saved: { id?: string; tree?: string };
  if (fs.existsSync(marker)) saved = JSON.parse(fs.readFileSync(marker, 'utf8'));
  else {
    saved = {};
    if (!store.projects().length) {
      const source = path.join(root, 'examples/papilot-paper'), paper = path.join(data, 'example-paper');
      fs.accessSync(path.join(source, 'preview/main.pdf'));
      fs.accessSync(path.join(source, 'preview/main.synctex.gz'));
      const fresh = !fs.existsSync(paper);
      if (fresh) fs.cpSync(source, paper, { recursive: true, filter: file => path.basename(file) !== 'preview' });
      const project = await workspace.addProject(paper, 'Papilot · Demo paper');
      const preview = path.join(data, 'demo-preview');
      fs.mkdirSync(preview, { recursive: true });
      fs.copyFileSync(path.join(source, 'preview/main.pdf'), path.join(preview, 'main.pdf'));
      const synctex = gunzipSync(fs.readFileSync(path.join(source, 'preview/main.synctex.gz'))).toString();
      fs.writeFileSync(path.join(preview, 'main.synctex.gz'), gzipSync(synctex.replaceAll('@PAPILOT_EXAMPLE@', project.path)));
      saved = { id: project.id, ...(fresh ? { tree: await workingTree(project.path) } : {}) };
    }
    fs.writeFileSync(marker + '.tmp', JSON.stringify(saved), { mode: 0o600 });
    fs.renameSync(marker + '.tmp', marker);
  }
  const project = store.projects().find(project => project.id === saved.id);
  const pdf = path.join(data, 'demo-preview/main.pdf');
  if (project && saved.tree && fs.existsSync(pdf) && await workingTree(project.path) === saved.tree) {
    await manuscripts.seedPreview(project.id, project.path, saved.tree, pdf);
  }
}
