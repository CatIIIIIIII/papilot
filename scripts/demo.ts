import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DATA, ROOT } from '../src/server/paths.ts';
import { Store } from '../src/server/store.ts';
import { Workspace } from '../src/server/workspace.ts';
import { copyExamplePaper } from '../src/server/example-paper.ts';

// The example is Papilot's own README written as a paper, with plenty of
// mathematics to review; it is copied into its own Git repository.
const folder = path.join(DATA, 'example-paper');
if (!fs.existsSync(folder)) {
  copyExamplePaper(path.join(ROOT, 'examples/papilot-paper'), folder);
  execFileSync('git', ['init', '-q', folder]);
  execFileSync('git', ['-C', folder, 'add', '.']);
  execFileSync('git', ['-C', folder, '-c', 'user.name=Papilot Example', '-c', 'user.email=papilot@localhost', 'commit', '-qm', 'Add example paper']);
}
const store = new Store(path.join(DATA, 'papilot.sqlite'));
const workspace = new Workspace(store);
const project = await workspace.addProject(folder, 'Papilot paper');
console.log(`Example paper ready: ${project.name} (${folder})`);
store.close();
