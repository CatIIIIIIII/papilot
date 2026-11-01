import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from './store.ts';
import { Workspace } from './workspace.ts';
import { Accounts } from './accounts.ts';
import { ROOT, DATA, PORT, PUBLIC_ORIGIN, OWNER, VERSION, ACCOUNT_ORIGIN, ACCOUNT_PORT } from './paths.ts';
import { accountHsts, accountProblem } from './security.ts';
import { Manuscripts } from './manuscript.ts';
import { Changes } from './changes.ts';
import { buildApp, gitQueue } from './app.ts';
import { Updates } from './updates.ts';
import { readJson } from '../../bin/installation.mjs';
import { desktopDemo } from './desktop-demo.ts';

const problem = accountProblem(ACCOUNT_ORIGIN, ACCOUNT_PORT, PORT, PUBLIC_ORIGIN);
if (problem) { console.error(problem); process.exit(1); }
const store = new Store(path.join(DATA, 'papilot.sqlite'));
const workspace = new Workspace(store);
const accounts = new Accounts(store, ACCOUNT_ORIGIN || null);
const manuscripts = new Manuscripts(), changes = new Changes();
const desktop = process.env.PAPILOT_DESKTOP === '1';
if (desktop) await desktopDemo(ROOT, DATA, store, workspace, manuscripts).catch(error => console.error('Could not prepare the demo paper:', error));
const updates = new Updates({ root: ROOT, data: DATA, version: VERSION, port: PORT,
  ...(desktop ? { supported: false, downloadUrl: 'https://github.com/PapilotAI/papilot/releases/latest' } : {}),
  busy: () => workspace.busyForUpdate || manuscripts.busyForUpdate || changes.busyForUpdate, shutdown: () => shutdown() });
const activation = readJson(path.join(DATA, 'updates/active.json'));
const updateInstance = typeof activation?.root === 'string' && fs.existsSync(activation.root) && fs.realpathSync(activation.root) === fs.realpathSync(ROOT) ? activation.id : undefined;
const shared = {
  store, workspace, accounts, manuscripts, changes, updates, updateInstance, csrf: randomBytes(32).toString('base64url'), serialGit: gitQueue(),
  dist: fs.existsSync(path.join(ROOT, 'dist/index.html')) ? path.join(ROOT, 'dist') : null, version: VERSION,
};
const localListener = { kind: 'local' as const, port: PORT, publicOrigin: PUBLIC_ORIGIN, owner: OWNER };
const apps = [await buildApp({ ...shared, listener: localListener })];
if (ACCOUNT_ORIGIN) apps.push(await buildApp({ ...shared, listener: { kind: 'account', origin: ACCOUNT_ORIGIN, hsts: accountHsts(ACCOUNT_ORIGIN, PUBLIC_ORIGIN) } }));

const localUrl = await apps[0].listen({ host: '127.0.0.1', port: PORT }).catch(error => {
  if (!desktop || error.code !== 'EADDRINUSE') throw error;
  return apps[0].listen({ host: '127.0.0.1', port: 0 });
});
// Desktop requests an OS-assigned port. Keep Host/Origin checks exact after bind.
localListener.port = Number(new URL(localUrl).port);
if (apps[1]) await apps[1].listen({ host: '127.0.0.1', port: ACCOUNT_PORT });
store.recover();
console.log(`Papilot is running at ${localUrl}${PUBLIC_ORIGIN ? `\nRemote: ${PUBLIC_ORIGIN}` : ''}${ACCOUNT_ORIGIN ? `\nSign-in for invited people: ${ACCOUNT_ORIGIN} (forwarded to 127.0.0.1:${ACCOUNT_PORT})` : ''}`);
if (!process.env.PAPILOT_UPDATE_PROBE) { void workspace.connect(); updates.start(); }
// Recompute cached feedback counts, including decisions from before this restart.
for (const task of store.tasks()) {
  if (task.status === 'building') {
    store.updateTask(task.id, { status: 'interrupted', error: 'The server restarted during the PDF build. Check the review and rebuild it if needed.' });
    void workspace.refresh(task.id);
  } else if (task.review?.round && task.status !== 'deleting') void workspace.refresh(task.id);
}
// Expired invites and sessions are removed as they lapse.
setInterval(() => accounts.purge(), 3600000).unref();
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return; shuttingDown = true; updates.close(); workspace.close();
  void Promise.all(apps.map(app => app.close())).finally(() => { store.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 2500).unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
if (desktop && process.send) {
  process.on('disconnect', shutdown);
  process.send({ type: 'papilot:ready', url: localUrl });
}
