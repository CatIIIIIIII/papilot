// Profile a real manuscript rebuild without changing its sources. Arguments:
// node scripts/profile-compilation.mjs URL PROJECT_ID SERVER_PID OUTPUT_DIR
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

const [origin, projectId, pid, destination] = process.argv.slice(2);
if (!origin || !projectId || !/^\d+$/.test(pid || '') || !destination) throw new Error('Expected URL, project ID, server PID and output directory.');
const output = path.resolve(destination);
fs.mkdirSync(output, { recursive: true });
const trace = path.join(output, 'trace.jsonl');
if (fs.existsSync(trace)) throw new Error('Choose a new output directory to preserve earlier measurements.');
const execute = promisify(execFile), started = performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = (event, data = {}) => fs.appendFileSync(trace, JSON.stringify({ at: new Date().toISOString(), seconds: +((performance.now() - started) / 1000).toFixed(3), event, ...data }) + '\n');
const save = (file, data) => fs.writeFileSync(path.join(output, file), JSON.stringify(data, null, 2) + '\n');
async function request(route, body, csrf) {
  const begin = performance.now();
  const response = await fetch(new URL(route, origin), { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: new URL(origin).origin, 'x-papilot-token': csrf }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const result = await response.json();
  record('http', { route, method: body === undefined ? 'GET' : 'POST', status: response.status, milliseconds: +(performance.now() - begin).toFixed(1), build: result.build?.status });
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
const state = await request('/api/state'), project = state.projects.find(project => project.id === projectId);
if (!project) throw new Error('Project not found.');
const { stdout: common } = await execute('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: project.path });
const cache = path.join(common.trim(), 'latex-review/cache/builds');
const before = new Set(fs.readdirSync(cache));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const old = fs.readdirSync(cache).flatMap(name => { try { return [read(path.join(cache, name, 'result.json'))]; } catch { return []; } });
save('before.json', { project, builds: old });
record('start', { project, serverPid: Number(pid), platform: os.platform(), arch: os.arch(), cpus: os.cpus().length,
  sampling: 'Process CPU time is cumulative; output events are observed at 500 ms intervals. No environment values or process arguments are recorded.' });
async function memory(file) {
  if (process.platform !== 'darwin') return;
  try { const { stdout } = await execute('vm_stat'); fs.writeFileSync(path.join(output, file), stdout); } catch { /* Optional on non-macOS hosts. */ }
}
await memory('memory-before.txt');
const cpuTime = value => value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
const cpuTicks = () => os.cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle, total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
let previousCpu = cpuTicks(), stop = false;
const offsets = new Map(), fragments = new Map(), directories = new Set();
function compilerOutput() {
  for (const name of fs.readdirSync(cache).filter(name => !before.has(name) && !name.endsWith('.lock'))) {
    const file = path.join(cache, name, 'latexmk.log');
    if (!fs.existsSync(file)) continue;
    directories.add(name);
    const bytes = fs.readFileSync(file), offset = offsets.get(name) || 0;
    if (bytes.length <= offset) continue;
    const chunk = bytes.subarray(offset); offsets.set(name, bytes.length);
    fs.appendFileSync(path.join(output, `${name}.latexmk.log`), chunk);
    const lines = ((fragments.get(name) || '') + chunk.toString()).split(/\r?\n/);
    fragments.set(name, lines.pop());
    for (const line of lines) if (/^(Run number |Running |Output written|Latexmk: (All targets|applying rule|References changed))/.test(line)) record('compiler', { build: name, line });
  }
}
async function sample() {
  const current = cpuTicks(), delta = current.total - previousCpu.total;
  const cpuBusyPercent = delta ? +(100 * (1 - (current.idle - previousCpu.idle) / delta)).toFixed(1) : null;
  previousCpu = current;
  try {
    const { stdout } = await execute('ps', ['-axo', 'pid=,ppid=,pcpu=,time=,rss=,comm='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    const processes = stdout.split('\n').flatMap(line => {
      const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d:.]+)\s+(\d+)\s+(.+)$/.exec(line);
      return m ? [{ pid: Number(m[1]), parent: Number(m[2]), cpuPercent: Number(m[3]), cpuSeconds: cpuTime(m[4]), rssBytes: Number(m[5]) * 1024, name: path.basename(m[6]) }] : [];
    });
    const descendants = new Set([Number(pid)]);
    for (let size = -1; size !== descendants.size;) {
      size = descendants.size;
      for (const process of processes) if (descendants.has(process.parent)) descendants.add(process.pid);
    }
    record('sample', { load: os.loadavg(), cpuBusyPercent, freeMemoryBytes: os.freemem(),
      service: processes.filter(process => descendants.has(process.pid)), busy: processes.sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, 12) });
  } catch (error) { record('sample-error', { message: error.message }); }
  compilerOutput();
}
const sampling = (async () => { while (!stop) { await sample(); if (!stop) await sleep(500); } })();
let latest;
try {
  latest = await request(`/api/projects/${projectId}/manuscript`, {}, state.csrf);
  const deadline = performance.now() + 5 * 60 * 1000;
  while (latest.build.status === 'building' && performance.now() < deadline) {
    await sleep(1500);
    latest = await request(`/api/projects/${projectId}/manuscript`);
  }
  record('finished', { build: latest.build });
  if (latest.build.status === 'building') throw new Error('Profiling stopped after five minutes; the build is still running.');
} finally {
  stop = true; await sampling; compilerOutput(); await memory('memory-after.txt');
  for (const name of directories) {
    const folder = path.join(cache, name), target = path.join(output, 'builds', name);
    if (fs.existsSync(folder)) fs.cpSync(folder, target, { recursive: true });
  }
  const builds = [...directories].flatMap(name => { try { return [read(path.join(cache, name, 'result.json'))]; } catch { return []; } });
  const matching = builds.find(build => createHash('sha256').update(build.key + build.pdf).digest('hex').slice(0, 16) === latest?.build.key);
  save('summary.json', { totalSeconds: +((performance.now() - started) / 1000).toFixed(3), build: latest?.build, matchingBuild: matching, builds });
  console.log(JSON.stringify({ output, status: latest?.build.status, compilerSeconds: matching?.seconds }));
}
