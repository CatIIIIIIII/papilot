// Runs inside the selected Linux distribution. The Windows process communicates
// through pipes; Node IPC stays entirely inside Linux.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { terminateTree } from './platform.mjs';

const [action, encoded] = process.argv.slice(2);
const options = JSON.parse(Buffer.from(encoded || '', 'base64').toString('utf8'));
const send = value => process.stdout.write('PAPILOT_CONTROL:' + JSON.stringify(value) + '\n');
const base = path.join(os.homedir(), '.local/share/papilot-desktop');
const target = path.join(base, 'runtime', options.id);
let installing, canceled = false;
const run = (command, args, cwd) => new Promise((resolve, reject) => {
  if (canceled) return reject(new Error('Setup canceled.'));
  const child = spawn(command, args, { cwd, detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
  installing = child;
  child.once('error', reject);
  child.once('exit', code => { installing = undefined; code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited with ${code}`)); });
});
if (!/^[a-f0-9]{64}$/.test(options.id)) throw new Error('Invalid runtime archive ID.');
if (process.platform !== 'linux' && !process.env.PAPILOT_TEST_WSL_RUNTIME) throw new Error('The WSL backend requires Linux Node.');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || major === 22 && minor < 22) throw new Error('Install Node.js 22.22 or newer inside this WSL distribution.');

if (action === 'install') {
  const cancel = () => { canceled = true; if (installing) terminateTree(installing, 'SIGKILL'); };
  process.stdin.resume(); process.stdin.on('end', cancel);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, cancel);
  if (fs.existsSync(path.join(target, 'ready.json'))) { send({ type: 'installed', target }); }
  else {
    const stage = target + '.' + process.pid;
    fs.mkdirSync(stage, { recursive: true });
    try {
      fs.mkdirSync(path.join(stage, 'server'));
      await run('tar', ['-xzf', options.archive, '-C', path.join(stage, 'server')]);
      const bridge = path.join(stage, 'bridge');
      fs.mkdirSync(bridge);
      const source = path.dirname(fileURLToPath(import.meta.url));
      for (const file of ['wsl-runtime.mjs', 'runtime.js', 'platform.mjs', 'agent-paths.mjs']) fs.copyFileSync(path.join(source, file), path.join(bridge, file));
      fs.writeFileSync(path.join(bridge, 'package.json'), '{"type":"module"}\n');
      const { npmCli } = await import('./platform.mjs');
      for (const dir of ['server', 'server/engine']) await run(process.execPath, [npmCli(), 'ci', '--omit=dev', '--prefer-offline', '--no-audit', '--no-fund'], path.join(stage, dir));
      fs.writeFileSync(path.join(stage, 'ready.json'), JSON.stringify({ id: options.id, node: process.versions.node }));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(stage, target);
      send({ type: 'installed', target });
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
  process.stdin.destroy();
} else if (action === 'serve') {
  if (!fs.existsSync(path.join(target, 'ready.json'))) throw new Error('Prepare this WSL environment before opening it.');
  const { BackendStopError, backendEnvironment, startBackend, startServer, switchServer } = await import(path.join(target, 'bridge/runtime.js'));
  if (options.data !== undefined && (typeof options.data !== 'string' || !path.isAbsolute(options.data))) throw new Error('PAPILOT_WSL_DATA must be an absolute Linux path.');
  const root = path.join(target, 'server'), data = options.data || path.join(base, 'data');
  const backendLog = path.join(data, 'logs/backend.log');
  const reportLog = () => { try { console.error(fs.readFileSync(backendLog, 'utf8').slice(-8000)); } catch {} };
  const bundle = { root, version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    fingerprint: options.nodeMajor === String(major) ? options.fingerprint : `${options.fingerprint}-wsl-node-${major}` };
  let backend, running = root, stopping = false, switching = false, instance, transition;
  // Switch checks the backend has not answered yet. A backend that closes its
  // channel cannot answer, and a write into a closing pipe does not always
  // fail, so its disconnect reports them busy.
  const unanswered = new Set();
  const busy = id => { if (unanswered.delete(id) && !stopping) send({ type: 'papilot:can-switch', id, busy: true }); };
  const stop = async () => {
    // Transition failures may also request shutdown. Do not let that request
    // wait on the transition currently unwinding its database rollback.
    if (stopping) return;
    stopping = true;
    let failure;
    try { await backend?.stop(); } catch (error) { failure = error; }
    try { await transition; } catch (error) { if (error instanceof BackendStopError) failure ||= error; }
    if (failure) console.error(failure);
    process.exit(failure ? 1 : 0);
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => void stop());
  const input = readline.createInterface({ input: process.stdin });
  input.on('close', () => void stop());
  const rebind = expected => {
    if (stopping || expected !== instance) return;
    // A ready message can reach Windows just before an update's finally block.
    // Keep that request until the switch completes instead of dropping it.
    if (switching) { setTimeout(() => rebind(expected), 50); return; }
    switching = true;
    transition = (async () => {
      if (!await backend.idle()) throw new Error('The WSL backend is busy; its port cannot change.');
      await backend.stop(); options.port = 0;
      await launch(running);
    })().catch(error => { console.error(error); void stop(); }).finally(() => { switching = false; });
  };
  input.on('line', line => {
    try {
      const message = JSON.parse(line);
      if (message.type === 'papilot:shutdown') void stop();
      else if (message.type === 'papilot:can-switch' && !stopping) {
        unanswered.add(message.id);
        if (!backend?.child.connected) busy(message.id);
        else {
          try { backend.child.send(message, error => { if (error) busy(message.id); }); }
          catch { busy(message.id); }
        }
      }
      else if (message.type === 'papilot:rebind') rebind(message.instance);
    } catch {}
  });
  const launch = async folder => {
    // A switch may finish stopping its old backend after application shutdown
    // has begun. Neither its candidate nor its rollback may create a new one.
    if (stopping) throw new Error('The WSL backend is shutting down.');
    const env = backendEnvironment(process.execPath, folder, data);
    instance = randomUUID(); env.PAPILOT_DESKTOP_INSTANCE = instance;
    env.NODE_USE_ENV_PROXY = '1';
    env.PAPILOT_DESKTOP_BUNDLE = root; env.PAPILOT_DESKTOP_FINGERPRINT = bundle.fingerprint;
    if (options.port) env.PAPILOT_PORT = String(options.port);
    if (options.probe) env.PAPILOT_UPDATE_PROBE = '1';
    const next = startBackend({ node: process.execPath, root: folder, data, log: backendLog, env });
    backend = next;
    let url;
    try { url = await next.ready; } catch (error) { await next.stop(); reportLog(); throw error; }
    // Reject an incompatible update here so startServer can fall back to the
    // bundled version before Windows checks localhost forwarding.
    const health = await fetch(url + '/api/health', { signal: AbortSignal.timeout(3000) }).then(response => response.json()).catch(() => null);
    if (health?.desktopInstance !== instance) { await next.stop(); throw new Error('The WSL backend did not identify this launch.'); }
    options.port = Number(new URL(url).port);
    next.child.once('exit', code => { if (!stopping && !switching && backend === next) { reportLog(); process.exit(code || 1); } });
    next.child.once('disconnect', () => { for (const id of [...unanswered]) busy(id); });
    next.child.on('message', message => {
      if (message?.type === 'papilot:can-switch') { unanswered.delete(message.id); send(message); return; }
      if (message?.type !== 'papilot:activate' || switching || stopping) return;
      switching = true;
      transition = switchServer(data, bundle, message, running, () => next.stop(), launch).then(root => { running = root; })
        .catch(error => { console.error(error); void stop(); }).finally(() => { switching = false; });
    });
    send({ type: 'papilot:ready', url, instance });
  };
  // Closing during initial startup is cancellation, not evidence that an
  // already active update is broken. Update transactions still use launch
  // directly so stopping their candidate rejects and restores the database.
  const launchInitial = async folder => {
    try { await launch(folder); }
    catch (error) { if (!stopping || error instanceof BackendStopError) throw error; }
  };
  try { transition = startServer(data, bundle, launchInitial); running = await transition; }
  catch (error) {
    if (!stopping) {
      console.error(error);
      try { await backend?.stop(); } catch (failure) { console.error(failure); }
      process.exit(1);
    }
  }
} else throw new Error('Unknown WSL action.');
