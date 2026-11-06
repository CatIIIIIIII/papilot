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
import { mupdf } from '../engine/src/render/pdf.ts';

test('demo notes survive installing Git across restarts, including later restarts', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-demo-notes-'));
  const store = new Store(path.join(data, 'papilot.sqlite')), workspace = new Workspace(store);
  try {
    const initial = new Manuscripts();
    await desktopDemo(process.cwd(), data, store, workspace, initial, () => false);
    const [project] = store.projects(), before = await initial.state(project.id, project.path);
    const document = mupdf.Document.openDocument(fs.readFileSync(initial.pdf(project.id, before.build.key!)), 'application/pdf');
    const page = document.loadPage(0), [x0, y0, x1, y1] = page.getBounds(), [quad] = page.search('Papilot:', '')[0];
    const rect: [number, number, number, number] = [(Math.min(quad[0], quad[4]) - x0) / (x1 - x0), (Math.min(quad[1], quad[3]) - y0) / (y1 - y0),
      (Math.max(quad[2], quad[6]) - x0) / (x1 - x0), (Math.max(quad[5], quad[7]) - y0) / (y1 - y0)];
    page.destroy(); document.destroy();
    store.saveAnnotation({ id: 'note', projectId: project.id, key: before.build.key!, page: 0, rect, rects: [rect],
      quote: 'Papilot:', comment: 'Keep this note', source: null, createdAt: 1 });
    for (let restart = 0; restart < 2; restart++) {
      const manuscripts = new Manuscripts();
      await desktopDemo(process.cwd(), data, store, workspace, manuscripts, () => true);
      const after = await manuscripts.state(project.id, project.path);
      assert.notEqual(after.build.key, before.build.key);
      assert.equal(await manuscripts.cachedPdf(project.path, before.build.key!), path.join(data, 'demo-preview/main.pdf'));
      const [placed] = await manuscripts.reanchor(project.id, project.path, store.annotations(project.id));
      assert.equal(placed.key, after.build.key, 'The note is placed on the current PDF after every restart');
      assert.equal(placed.comment, 'Keep this note');
      assert.equal(store.projects()[0].id, project.id);
    }
  } finally { workspace.close(); store.close(); fs.rmSync(data, { recursive: true, force: true, maxRetries: 5 }); }
});

test('an edit during Git initialization cannot seed the bundled PDF for the edited tree', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-demo-initializing-'));
  const store = new Store(path.join(data, 'papilot.sqlite')), workspace = new Workspace(store), manuscripts = new Manuscripts();
  let git = false;
  try {
    const enable = await desktopDemo(process.cwd(), data, store, workspace, manuscripts, () => git);
    const [project] = store.projects(), before = await manuscripts.state(project.id, project.path);
    const register = workspace.addProject.bind(workspace);
    workspace.addProject = async (...args) => {
      fs.appendFileSync(path.join(project.path, 'main.tex'), '\n% Edited during initialization\n');
      return register(...args);
    };
    let seeded = false;
    manuscripts.seedPreview = async () => { seeded = true; };
    git = true; await enable();
    assert.equal(seeded, false, 'An edit across the asynchronous registration boundary invalidates the bundled PDF');
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'desktop-demo.json'), 'utf8')).tree, undefined);
    assert.throws(() => manuscripts.pdf(project.id, before.build.key!), /out of date/);
    assert.match(fs.readFileSync(path.join(project.path, 'main.tex'), 'utf8'), /Edited during initialization/);
  } finally { workspace.close(); store.close(); fs.rmSync(data, { recursive: true, force: true, maxRetries: 5 }); }
});

for (const edited of [false, true]) test(`legacy demo without Git preserves its PDF identity and detects ${edited ? 'edits' : 'unchanged sources'}`, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-demo-legacy-'));
  const store = new Store(path.join(data, 'papilot.sqlite')), workspace = new Workspace(store);
  try {
    const initial = new Manuscripts();
    await desktopDemo(process.cwd(), data, store, workspace, initial);
    const [project] = store.projects(), before = await initial.state(project.id, project.path);
    const marker = path.join(data, 'desktop-demo.json'), { id, tree } = JSON.parse(fs.readFileSync(marker, 'utf8'));
    fs.writeFileSync(marker, JSON.stringify({ id, tree }));
    if (edited) fs.appendFileSync(path.join(project.path, 'main.tex'), '\n% Preserve legacy edits\n');
    const manuscripts = new Manuscripts();
    await desktopDemo(process.cwd(), data, store, workspace, manuscripts, () => false);
    const after = await manuscripts.state(project.id, project.path);
    assert.equal(after.build.key, before.build.key, 'Existing annotations keep the same PDF identity');
    assert.equal(after.build.current, !edited);
    assert.equal(after.build.status, edited ? 'failed' : 'ready');
    assert.equal(fs.readFileSync(manuscripts.pdf(project.id, after.build.key!)).subarray(0, 5).toString(), '%PDF-');
  } finally { workspace.close(); store.close(); fs.rmSync(data, { recursive: true, force: true, maxRetries: 5 }); }
});

for (const edited of [false, true]) test(`demo without Git is readable and preserves ${edited ? 'edits' : 'the preview'} when Git is installed`, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-demo-no-git-'));
  const store = new Store(path.join(data, 'papilot.sqlite')), workspace = new Workspace(store);
  let git = false, registrations = 0;
  const register = workspace.addProject.bind(workspace);
  workspace.addProject = async (...args) => { assert.equal(git, true, 'No Git repository operations before installation'); registrations++; return register(...args); };
  try {
    const manuscripts = new Manuscripts();
    await desktopDemo(process.cwd(), data, store, workspace, manuscripts, () => git);
    const [project] = store.projects(), state = await manuscripts.state(project.id, project.path);
    assert.equal(state.build.status, 'ready'); assert.equal(state.build.current, true);
    assert.ok(state.build.pages!.length > 0);
    assert.equal(fs.readFileSync(manuscripts.pdf(project.id, state.build.key!)).subarray(0, 5).toString(), '%PDF-');
    assert.equal(fs.existsSync(path.join(project.path, '.git')), false);
    assert.match((await manuscripts.state(project.id, project.path, true)).build.error!, /Install Git/);
    const restarted = new Manuscripts(), enable = await desktopDemo(process.cwd(), data, store, workspace, restarted, () => git);
    assert.equal((await restarted.state(project.id, project.path)).build.status, 'ready', 'Still readable after restart');
    if (edited) {
      fs.appendFileSync(path.join(project.path, 'main.tex'), '\n% Keep my revision\n');
      const stale = await restarted.state(project.id, project.path);
      assert.equal(stale.build.current, false); assert.equal(stale.build.status, 'failed');
    }
    git = true;
    await Promise.all([enable(), enable(), enable()]);
    assert.equal(registrations, 1); assert.equal(store.projects()[0].id, project.id);
    assert.ok(fs.existsSync(path.join(project.path, '.git')));
    if (edited) {
      assert.match(fs.readFileSync(path.join(project.path, 'main.tex'), 'utf8'), /Keep my revision/);
      assert.throws(() => restarted.pdf(project.id, state.build.key!), /out of date/, 'Do not pair edited sources with the original preview');
    } else assert.equal((await restarted.state(project.id, project.path)).build.status, 'ready');
  } finally { workspace.close(); store.close(); fs.rmSync(data, { recursive: true, force: true }); }
});

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
    assert.ok(sync.includes(project.path.split(path.sep).join('/') + '/main.tex')); assert.ok(!sync.includes('@PAPILOT_EXAMPLE@'));
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
