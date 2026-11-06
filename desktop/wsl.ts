import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { terminateTree } from './platform.mjs';
import { idleCheck } from './runtime.js';

export type Environment = { kind: 'native' } | { kind: 'wsl'; distribution: string };
export const validEnvironment = (value: any): value is Environment => value?.kind === 'native'
  || value?.kind === 'wsl' && typeof value.distribution === 'string' && Boolean(value.distribution.trim()) && !/[\r\n\0]/.test(value.distribution) && value.distribution.length <= 128;
export function readEnvironment(data: string): Environment | null {
  try { const value = JSON.parse(fs.readFileSync(path.join(data, 'environment.json'), 'utf8')); return validEnvironment(value) ? value : null; } catch { return null; }
}
export function saveEnvironment(data: string, value: Environment) {
  if (!validEnvironment(value)) throw new Error('Invalid environment.');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'environment.json'), JSON.stringify(value) + '\n');
}
export const decodeWsl = (buffer: Buffer) => (buffer.includes(0) ? buffer.toString('utf16le') : buffer.toString('utf8')).replace(/^\uFEFF/, '').trim();
const wsl = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/wsl.exe');
export async function wslCommand(args: string[], timeout = 30000) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(wsl(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    const timer = setTimeout(() => { terminateTree(child, 'SIGKILL'); reject(new Error('WSL did not respond. Open the distribution in Windows Terminal and try again.')); }, timeout);
    child.stdout.on('data', data => out.push(data)); child.stderr.on('data', data => err.push(data));
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve(decodeWsl(Buffer.concat(out))) : reject(new Error(decodeWsl(Buffer.concat(err.length ? err : out)) || 'WSL command failed.')); });
  });
}
export async function distributions() {
  return (await wslCommand(['--list', '--quiet'])).split(/\r?\n/).map(value => value.trim()).filter(Boolean);
}
// Scripts are fixed strings. Names, paths and config are always separate args.
export const NODE = `supported_node() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(process.platform==="linux"&&(a>22||a===22&&b>=22)?0:1)' >/dev/null 2>&1; }
if ! supported_node node; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node; do
    if supported_node "$candidate"; then export PATH="$(dirname "$candidate"):$PATH"; break; fi
  done
fi
`;
export const linuxArgs = (distribution: string, script: string, args: string[] = []) => ['--distribution', distribution, '--cd', '~', '--exec', 'bash', '-lc', script, 'papilot', ...args];
export async function probeWsl(distribution: string) {
  if (!(await distributions()).includes(distribution)) throw new Error('Choose an installed WSL distribution.');
  const output = await wslCommand(linuxArgs(distribution, NODE + `node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(process.platform!=="linux"||a<22||(a===22&&b<22))process.exit(2); console.log("PAPILOT_NODE:"+JSON.stringify({node:process.execPath,version:process.versions.node,home:require("os").homedir()}))'`));
  const line = output.split(/\r?\n/).find(line => line.startsWith('PAPILOT_NODE:'));
  if (!line) throw new Error('Install Linux Node.js 22.22+ and npm inside this distribution, then retry.');
  return JSON.parse(line.slice('PAPILOT_NODE:'.length)) as { node: string; version: string; home: string };
}
export async function linuxPath(distribution: string, selected: string) {
  const unc = /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(\\.*)?$/i.exec(selected);
  if (unc) {
    if (unc[1].toLowerCase() !== distribution.toLowerCase()) throw new Error('Choose a folder in the selected WSL distribution.');
    return (unc[2] || '/').replaceAll('\\', '/');
  }
  if (!/^[a-z]:[\\/]/i.test(selected)) throw new Error('Choose a Windows drive folder or a folder in the selected WSL distribution.');
  return wslCommand(['--distribution', distribution, '--exec', 'wslpath', '-a', '-u', selected]);
}
export function archiveInfo(assets: string) {
  const archive = path.join(assets, 'server.tgz');
  if (!fs.existsSync(archive)) throw new Error('This app has no WSL runtime archive. Build the Windows installer first.');
  const hash = createHash('sha256').update(fs.readFileSync(archive));
  for (const file of ['wsl-runtime.mjs', 'runtime.js', 'platform.mjs', 'agent-paths.mjs']) hash.update(fs.readFileSync(path.join(assets, file)));
  return { archive, id: hash.digest('hex') };
}
async function launchWsl(distribution: string, assets: string, action: 'install' | 'serve', extra: Record<string, unknown>) {
  const info = await probeWsl(distribution), archive = archiveInfo(assets);
  const [script, source] = await Promise.all([linuxPath(distribution, path.join(assets, 'wsl-runtime.mjs')), linuxPath(distribution, archive.archive)]);
  const config = Buffer.from(JSON.stringify({ ...extra, id: archive.id, archive: source })).toString('base64');
  return spawn(wsl(), linuxArgs(distribution, 'exec "$1" "$2" "$3" "$4"', [info.node, script, action, config]), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}
export async function prepareWsl(distribution: string, assets: string, progress: (text: string) => void, signal?: AbortSignal) {
  const child = await launchWsl(distribution, assets, 'install', {});
  return new Promise<void>((resolve, reject) => {
    const cancel = () => { child.stdin.end(); };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => { child.stdin.end(); terminateTree(child); reject(new Error('WSL setup timed out. Check the npm connection inside WSL and retry.')); }, 15 * 60000);
    const output = (data: Buffer) => progress(data.toString('utf8').replace(/PAPILOT_CONTROL:.*\n/g, ''));
    child.stdout.on('data', output); child.stderr.on('data', output);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); code === 0 && !signal?.aborted ? resolve() : reject(new Error(signal?.aborted ? 'WSL setup canceled.' : 'WSL setup failed. Check the setup output, install Node.js 22.22+ and npm in this distribution, then retry.')); });
  });
}
// The same localhost port can belong to different servers on Windows and in
// Linux. The application name alone cannot identify the backend we launched.
export async function reachableWsl(url: string, instance: string, signal?: AbortSignal) {
  for (let i = 0; i < 40 && !signal?.aborted; i++) {
    try {
      const response = await fetch(url + '/api/health', { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1000)]) : AbortSignal.timeout(1000) });
      const health = await response.json().catch(() => null);
      return response.ok && health?.name === 'Papilot' && health?.desktopInstance === instance;
    } catch { /* WSL may still be setting up localhost forwarding. */ }
    if (!signal?.aborted) await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}
export async function startWsl(options: { distribution: string; assets: string; fingerprint: string; nodeMajor: string; port: number; log: string }) {
  const child = await launchWsl(options.distribution, options.assets, 'serve', { fingerprint: options.fingerprint, nodeMajor: options.nodeMajor, port: options.port, probe: Boolean(process.env.PAPILOT_UPDATE_PROBE), data: process.env.PAPILOT_WSL_DATA });
  fs.mkdirSync(path.dirname(options.log), { recursive: true });
  const log = fs.createWriteStream(options.log, { flags: 'a' });
  child.stderr.pipe(log, { end: false });
  const controller = new AbortController();
  let rebinds = 0, generation = 0, rejectReady: (error: Error) => void;
  const verifyReady = async (value: any) => {
    const cycle = ++generation;
    try {
      const url = new URL(value.url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !Number(url.port) || typeof value.instance !== 'string' || !value.instance) throw new Error('Invalid WSL backend identity.');
      const reachable = await reachableWsl(url.origin, value.instance, controller.signal);
      if (controller.signal.aborted || cycle !== generation) return;
      if (reachable) { rebinds = 0; child.emit('message', value); return; }
      if (++rebinds <= 2) { child.stdin.write(JSON.stringify({ type: 'papilot:rebind', instance: value.instance }) + '\n'); return; }
      throw new Error('Windows could not reach this Papilot instance in WSL. Check localhost forwarding and reopen Papilot.');
    } catch (error) { rejectReady(error instanceof Error ? error : new Error(String(error))); void stop(); }
  };
  let pending = '';
  child.stdout.on('data', data => {
    pending += data.toString('utf8');
    let at;
    while ((at = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, at); pending = pending.slice(at + 1);
      if (line.startsWith('PAPILOT_CONTROL:')) { try { const value = JSON.parse(line.slice(16)); if (value?.type === 'papilot:ready') void verifyReady(value); else child.emit('message', value); } catch {} }
      else log.write(line + '\n');
    }
  });
  child.once('exit', () => { controller.abort(); log.end(); });
  const ready = new Promise<string>((resolve, reject) => {
    rejectReady = error => { clearTimeout(timer); reject(error); };
    const timer = setTimeout(() => reject(new Error('The WSL backend did not start. See the backend log.')), 90000);
    const fail = () => { clearTimeout(timer); reject(new Error('The WSL backend stopped before it was ready.')); };
    child.once('error', fail); child.once('exit', fail);
    child.on('message', message => {
      const value = message as any;
      if (value?.type !== 'papilot:ready' || typeof value.url !== 'string') return;
      const url = new URL(value.url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !Number(url.port)) return;
      clearTimeout(timer); child.off('error', fail); child.off('exit', fail); resolve(url.origin);
    });
  });
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= new Promise<void>(resolve => {
    controller.abort();
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => { terminateTree(child); resolve(); }, 10000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.stdin.end(JSON.stringify({ type: 'papilot:shutdown' }) + '\n');
  });
  return { child: child as ChildProcess, ready, stop, idle: () => idleCheck(child, message => { child.stdin.write(JSON.stringify(message) + '\n'); }) };
}
