import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from './store.ts';
import { Workspace } from './workspace.ts';
import { ROOT, DATA, PORT, PUBLIC_ORIGIN, OWNER, VERSION } from './paths.ts';
import { Manuscripts } from './manuscript.ts';
import { Changes } from './changes.ts';
import { buildApp, gitQueue } from './app.ts';
import { Updates } from './updates.ts';
import { readJson } from '../../bin/installation.mjs';
import { desktopDemo } from './desktop-demo.ts';

const store = new Store(path.join(DATA, 'papilot.sqlite'));
const workspace = new Workspace(store);
const manuscripts = new Manuscripts(), changes = new Changes();
const desktop = process.env.PAPILOT_DESKTOP === '1';
const prepareDemo = desktop ? await desktopDemo(ROOT, DATA, store, workspace, manuscripts).catch(error => console.error('Could not prepare the demo paper:', error)) : undefined;
// A packaged desktop app downloads only Papilot's own code built for its
// installer (see desktop/runtime.ts) and asks the app to switch to it. npm
// updates belong to the web server.
const bundleRoot = desktop && process.send ? process.env.PAPILOT_DESKTOP_BUNDLE : undefined, fingerprint = process.env.PAPILOT_DESKTOP_FINGERPRINT || '';
const bundle = bundleRoot && fingerprint ? { root: bundleRoot, version: readJson(path.join(bundleRoot, 'package.json'))?.version || '', fingerprint } : undefined;
const updates = new Updates({ root: ROOT, data: DATA, version: VERSION, port: PORT, desktop, bundle,
  ...(bundle ? { restart: async (root: string, version: string) => { process.send!({ type: 'papilot:activate', root, version }); } } : {}),
  busy: () => workspace.busyForUpdate || manuscripts.busyForUpdate || changes.busyForUpdate, shutdown: () => shutdown() });
const activation = desktop ? null : readJson(path.join(DATA, 'updates/active.json'));
const updateInstance = typeof activation?.root === 'string' && fs.existsSync(activation.root) && fs.realpathSync(activation.root) === fs.realpathSync(ROOT) ? activation.id : undefined;
const shared = {
  prepareDemo: prepareDemo || undefined,
  desktopInstance: desktop ? process.env.PAPILOT_DESKTOP_INSTANCE : undefined,
  store, workspace, manuscripts, changes, updates, updateInstance, csrf: randomBytes(32).toString('base64url'), serialGit: gitQueue(),
  dist: fs.existsSync(path.join(ROOT, 'dist/index.html')) ? path.join(ROOT, 'dist') : null, version: VERSION,
};
const localListener = { kind: 'local' as const, port: PORT, publicOrigin: PUBLIC_ORIGIN, owner: OWNER };
const app = await buildApp({ ...shared, listener: localListener });

// Agent SDKs and the PDF engine load before the first request, not in the
// middle of one.
if (!process.env.PAPILOT_UPDATE_PROBE) await Promise.race([Promise.all([workspace.preload(), manuscripts.warm()]), new Promise(resolve => setTimeout(resolve, 5000).unref())]);
const localUrl = await app.listen({ host: '127.0.0.1', port: PORT }).catch(error => {
  if (!desktop || error.code !== 'EADDRINUSE') throw error;
  return app.listen({ host: '127.0.0.1', port: 0 });
});
// Desktop requests an OS-assigned port. Keep Host/Origin checks exact after bind.
localListener.port = Number(new URL(localUrl).port);
store.recover();
console.log(`Papilot is running at ${localUrl}${PUBLIC_ORIGIN ? `\nRemote: ${PUBLIC_ORIGIN}` : ''}`);
if (!process.env.PAPILOT_UPDATE_PROBE) { void workspace.connect(); updates.start(); }
// Recompute cached feedback counts, including decisions from before this restart.
for (const task of store.tasks()) {
  if (task.pendingBuild || (task.review?.job?.id && (task.status === 'building' || (task.status === 'failed' && task.error === 'fetch failed')))) {
    void workspace.resumeBuild(task.id);
  } else if (task.status === 'building') {
    store.updateTask(task.id, { status: 'interrupted', error: 'The server restarted during the PDF build. Check the review and rebuild it if needed.' });
    void workspace.refresh(task.id);
  } else if (task.review?.round && task.status !== 'deleting') void workspace.refresh(task.id);
}
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return; shuttingDown = true; updates.close(); workspace.close(); void manuscripts.stop().catch(() => undefined);
  void app.close().finally(() => { store.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 2500).unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
if (desktop && process.send) {
  process.on('disconnect', shutdown);
  process.on('message', message => {
    const value = message as { type?: string; id?: string } | null;
    if (value?.type === 'papilot:shutdown') shutdown();
    if (value?.type === 'papilot:can-switch' && typeof value.id === 'string') process.send?.({ type: value.type, id: value.id,
      busy: workspace.busyForUpdate || manuscripts.busyForUpdate || changes.busyForUpdate || ['installing', 'waiting', 'restarting'].includes(updates.snapshot().phase) });
  });
  process.send({ type: 'papilot:ready', url: localUrl });
}
