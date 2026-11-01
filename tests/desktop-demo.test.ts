import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Store } from '../src/server/store.ts';
import { Workspace } from '../src/server/workspace.ts';
import { Manuscripts } from '../src/server/manuscript.ts';
import { desktopDemo } from '../src/server/desktop-demo.ts';

test('desktop seeds a readable example once and preserves edits and deletion', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-demo-test-'));
  const store = new Store(path.join(data, 'papilot.sqlite')), workspace = new Workspace(store), manuscripts = new Manuscripts();
  try {
    await desktopDemo(process.cwd(), data, store, workspace, manuscripts);
    const [project] = store.projects(); assert.ok(project);
    const state = await manuscripts.state(project.id, project.path);
    assert.equal(state.build.status, 'ready', 'The bundled PDF is ready without running TeX');
    assert.ok(state.build.pages!.length > 0);
    const sync = gunzipSync(fs.readFileSync(path.join(data, 'demo-preview/main.synctex.gz'))).toString();
    assert.ok(sync.includes(project.path + '/main.tex')); assert.ok(!sync.includes('@PAPILOT_EXAMPLE@'));
    await desktopDemo(process.cwd(), data, store, workspace, new Manuscripts());
    assert.equal(store.projects().length, 1);
    fs.appendFileSync(path.join(project.path, 'main.tex'), '\n% My own revision\n');
    const fresh = new Manuscripts(); let seeded = false;
    fresh.seedPreview = async () => { seeded = true; };
    await desktopDemo(process.cwd(), data, store, workspace, fresh);
    assert.equal(seeded, false, 'An edited source must not be paired with the original PDF');
    assert.match(fs.readFileSync(path.join(project.path, 'main.tex'), 'utf8'), /My own revision/);
    store.removeProject(project.id);
    await desktopDemo(process.cwd(), data, store, workspace, new Manuscripts());
    assert.equal(store.projects().length, 0, 'A removed demo stays removed');
    assert.ok(fs.existsSync(path.join(project.path, 'main.tex')), 'Removing the listing preserves the paper');
  } finally { workspace.close(); store.close(); fs.rmSync(data, { recursive: true, force: true }); }
});
