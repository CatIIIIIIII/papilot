import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { decodeWsl, linuxArgs, linuxPath, readEnvironment, saveEnvironment, validEnvironment, reachableWsl } from '../desktop/wsl.ts';

test('WSL readiness rejects another Papilot and unrelated services on the Windows port', async () => {
  let health: any = { name: 'Papilot', desktopInstance: 'different-instance' };
  const server = http.createServer((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(health)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    assert.equal(await reachableWsl(url, 'our-instance'), false);
    health = { name: 'Papilot' }; assert.equal(await reachableWsl(url, 'our-instance'), false);
    health = { name: 'Other service', desktopInstance: 'our-instance' }; assert.equal(await reachableWsl(url, 'our-instance'), false);
    health = { name: 'Papilot', desktopInstance: 'our-instance' }; assert.equal(await reachableWsl(url, 'our-instance'), true);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('WSL distribution output handles UTF-16 and arguments remain literal', () => {
  assert.equal(decodeWsl(Buffer.from('\uFEFFUbuntu\r\nDebian\r\n', 'utf16le')), 'Ubuntu\r\nDebian');
  assert.equal(decodeWsl(Buffer.from('Ubuntu\n', 'utf8')), 'Ubuntu');
  const distro = 'Research & papers', filename = '/mnt/c/论文 & $HOME/main.tex';
  assert.deepEqual(linuxArgs(distro, 'exec "$1"', [filename]), ['--distribution', distro, '--cd', '~', '--exec', 'bash', '-lc', 'exec "$1"', 'papilot', filename]);
});

test('Windows environment preference and WSL UNC paths are kept separate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-environment-'));
  try {
    assert.equal(readEnvironment(dir), null);
    saveEnvironment(dir, { kind: 'native' }); assert.deepEqual(readEnvironment(dir), { kind: 'native' });
    saveEnvironment(dir, { kind: 'wsl', distribution: 'Ubuntu' }); assert.deepEqual(readEnvironment(dir), { kind: 'wsl', distribution: 'Ubuntu' });
    assert.equal(validEnvironment({ kind: 'wsl', distribution: 'Ubuntu\n--exec' }), false);
    assert.equal(await linuxPath('Ubuntu', '\\\\wsl.localhost\\Ubuntu\\home\\chen\\论文 & spaces'), '/home/chen/论文 & spaces');
    assert.equal(await linuxPath('Ubuntu', '\\\\wsl$\\Ubuntu\\home\\chen'), '/home/chen');
    await assert.rejects(linuxPath('Ubuntu', '\\\\wsl.localhost\\Debian\\home\\chen'), /selected WSL/);
    await assert.rejects(linuxPath('Ubuntu', '\\\\fileserver\\papers'), /Windows drive/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('WSL forwarding reports busy when the backend IPC closes during an idle check', { skip: process.platform === 'win32', timeout: 20000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-wsl-forward-')), root = process.cwd(), id = 'e'.repeat(64);
  const runtime = path.join(home, '.local/share/papilot-desktop/runtime', id), data = path.join(home, '.local/share/papilot-desktop/data');
  const write = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  const module = JSON.stringify(pathToFileURL(path.join(root, 'desktop/runtime.ts')).href);
  write(path.join(runtime, 'ready.json'), {}); write(path.join(runtime, 'bridge/package.json'), { type: 'module' });
  write(path.join(runtime, 'bridge/runtime.js'), `export * from ${module};`);
  const server = path.join(runtime, 'server');
  write(path.join(server, 'package.json'), { name: 'papilot', version: '0.9.0', type: 'module' });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(server, 'node_modules'), 'dir');
  write(path.join(server, 'src/server/start.ts'), `import fs from 'node:fs';import path from 'node:path';import http from 'node:http';const data=process.env.PAPILOT_DATA;
    fs.writeFileSync(path.join(data,'backend.pid'),String(process.pid));
    const server=http.createServer((req,res)=>res.end(JSON.stringify({name:'Papilot',desktopInstance:process.env.PAPILOT_DESKTOP_INSTANCE})));
    server.listen(0,'127.0.0.1',()=>process.send({type:'papilot:ready',url:'http://127.0.0.1:'+server.address().port}));
    process.on('message',message=>{if(message.type==='papilot:can-switch') process.disconnect();});`);
  const config = Buffer.from(JSON.stringify({ id, fingerprint: '', nodeMajor: process.versions.node.split('.')[0] })).toString('base64');
  const child = spawn(process.execPath, ['--import', 'tsx', 'desktop/wsl-runtime.mjs', 'serve', config], {
    cwd: root, env: { ...process.env, HOME: home, PAPILOT_TEST_WSL_RUNTIME: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '', pid = 0;
  child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
  const waitFor = async (check: () => boolean) => {
    const deadline = performance.now() + 10000;
    while (!check() && child.exitCode === null && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(check(), err || out || 'No bridge response');
  };
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    await waitFor(() => out.includes('papilot:ready'));
    pid = Number(fs.readFileSync(path.join(data, 'backend.pid'), 'utf8'));
    child.stdin.write('{"type":"papilot:can-switch","id":"closing-ipc"}\n');
    await waitFor(() => out.includes('closing-ipc'));
    const response = JSON.parse(out.split('\n').find(line => line.startsWith('PAPILOT_CONTROL:') && line.includes('closing-ipc'))!.slice(16));
    assert.deepEqual(response, { type: 'papilot:can-switch', id: 'closing-ipc', busy: true });
    assert.equal(child.exitCode, null); assert.equal(alive(), true);
    const ended = new Promise(resolve => child.once('exit', resolve)); child.stdin.end('{"type":"papilot:shutdown"}\n'); await ended;
    assert.equal(child.exitCode, 0, err); assert.equal(alive(), false);
    assert.doesNotMatch(err, /EPIPE|Unhandled 'error'/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await ended; }
    if (!pid && fs.existsSync(path.join(data, 'backend.pid'))) pid = Number(fs.readFileSync(path.join(data, 'backend.pid'), 'utf8'));
    if (pid && alive()) process.kill(pid, 'SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  }
});

for (const shutdown of ['message', 'pipe closed']) test(`WSL bridge runs the real backend and shuts down when ${shutdown}`, { skip: process.platform === 'win32', timeout: 30000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-wsl-'));
  const id = 'f'.repeat(64), root = process.cwd(), runtime = path.join(home, '.local/share/papilot-desktop/runtime', id);
  fs.mkdirSync(path.join(runtime, 'bridge'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'ready.json'), '{}');
  fs.writeFileSync(path.join(runtime, 'bridge/runtime.js'), `export * from ${JSON.stringify(pathToFileURL(path.join(root, 'desktop/runtime.ts')).href)};`);
  fs.writeFileSync(path.join(runtime, 'bridge/package.json'), '{"type":"module"}');
  fs.symlinkSync(root, path.join(runtime, 'server'), 'dir');
  const config = Buffer.from(JSON.stringify({ id, fingerprint: '', nodeMajor: process.versions.node.split('.')[0], probe: true })).toString('base64');
  const child = spawn(process.execPath, ['--import', 'tsx', 'desktop/wsl-runtime.mjs', 'serve', config], { cwd: root,
    env: { ...process.env, HOME: home, PAPILOT_TEST_WSL_RUNTIME: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
  try {
    // WSL wall time can jump during host clock synchronization.
    const deadline = performance.now() + 20000;
    while (!out.includes('PAPILOT_CONTROL:') && child.exitCode === null && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    const line = out.split('\n').find(line => line.startsWith('PAPILOT_CONTROL:'));
    assert.ok(line, err || out || 'No ready message');
    let { url, instance } = JSON.parse(line.slice(16));
    assert.equal((await (await fetch(url + '/api/health')).json()).desktopInstance, instance);
    child.stdin.write(JSON.stringify({ type: 'papilot:rebind', instance }) + '\n');
    for (let i = 0; i < 200 && out.split('\n').filter(line => line.includes('papilot:ready')).length < 2; i++) await new Promise(resolve => setTimeout(resolve, 25));
    const rebound = JSON.parse(out.split('\n').filter(line => line.includes('papilot:ready')).at(-1)!.slice(16));
    assert.notEqual(rebound.instance, instance, err); assert.notEqual(rebound.url, url);
    await assert.rejects(fetch(url + '/api/health', { signal: AbortSignal.timeout(2000) }));
    ({ url, instance } = rebound);
    assert.equal(await reachableWsl(url, instance), true);
    assert.ok(fs.existsSync(path.join(home, '.local/share/papilot-desktop/data/papilot.sqlite')));
    child.stdin.write('{"type":"papilot:can-switch","id":"test"}\n');
    for (let i = 0; i < 100 && !out.includes('"id":"test"'); i++) await new Promise(resolve => setTimeout(resolve, 25));
    const state = JSON.parse(out.split('\n').find(line => line.includes('"id":"test"'))!.slice(16));
    assert.deepEqual(state, { type: 'papilot:can-switch', id: 'test', busy: false });
    const ended = new Promise(resolve => child.once('exit', resolve));
    child.stdin.end(shutdown === 'message' ? '{"type":"papilot:shutdown"}\n' : undefined);
    await ended;
    assert.equal(child.exitCode, 0, err);
    await assert.rejects(fetch(url + '/api/health', { signal: AbortSignal.timeout(2000) }));
  } finally {
    if (child.exitCode === null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill(); await ended; }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

for (const updating of [false, true]) test(`WSL stops a timed-out candidate before ${updating ? 'rolling back an update' : 'falling back on startup'}`, { skip: process.platform === 'win32', timeout: 20000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-wsl-timeout-')), root = process.cwd();
  const id = 'd'.repeat(64), fingerprint = 'e'.repeat(64), base = path.join(home, '.local/share/papilot-desktop');
  const runtime = path.join(base, 'runtime', id), data = path.join(base, 'data'), bundle = path.join(runtime, 'server');
  const layer = path.join(data, 'updates/desktop/layers/timeout-layer/papilot');
  const write = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  const module = JSON.stringify(pathToFileURL(path.join(root, 'desktop/runtime.ts')).href);
  write(path.join(runtime, 'bridge/package.json'), { type: 'module' });
  // Shorten only the fixture candidate's ready deadline. Processes, shutdown,
  // fallback and database rollback all use the production implementation.
  write(path.join(runtime, 'bridge/runtime.js'), `export * from ${module}; import {startBackend as start} from ${module};
    export function startBackend(options) { const backend=start(options); if (!options.root.includes('timeout-layer')) return backend;
      let timer; const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('fixture ready timeout')),1500)});
      return {...backend,ready:Promise.race([backend.ready,deadline]).finally(()=>clearTimeout(timer))}; }`);
  write(path.join(runtime, 'ready.json'), {});
  write(path.join(bundle, 'package.json'), { name: 'papilot', version: '0.9.0', type: 'module' });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(bundle, 'node_modules'), 'dir');
  fs.mkdirSync(path.join(bundle, 'engine'), { recursive: true });
  fs.symlinkSync(path.join(root, 'engine/node_modules'), path.join(bundle, 'engine/node_modules'), 'dir');
  write(path.join(bundle, 'src/server/start.ts'), `import fs from 'node:fs';import path from 'node:path';import http from 'node:http';
    const data=process.env.PAPILOT_DATA;
    const server=http.createServer((req,res)=>{if(req.url==='/activate'){process.send({type:'papilot:activate',...JSON.parse(fs.readFileSync(path.join(data,'activation.json'),'utf8'))});res.end('ok');}
      else res.end(JSON.stringify({name:'Papilot',desktopInstance:process.env.PAPILOT_DESKTOP_INSTANCE}));});
    server.listen(0,'127.0.0.1',()=>process.send({type:'papilot:ready',url:'http://127.0.0.1:'+server.address().port}));
    process.on('message',m=>{if(m.type==='papilot:shutdown')process.exit(0);});`);
  const makeLayer = () => {
    write(path.join(layer, 'package.json'), { name: 'papilot', version: '0.9.1', type: 'module' });
    write(path.join(layer, 'desktop-layer.json'), { format: 1, version: '0.9.1', fingerprint });
    fs.mkdirSync(path.join(layer, 'engine'), { recursive: true });
    write(path.join(layer, 'src/server/start.ts'), `import fs from 'node:fs';import path from 'node:path';
    const data=process.env.PAPILOT_DATA;fs.writeFileSync(path.join(data,'candidate.pid'),String(process.pid));
    fs.writeFileSync(path.join(data,'papilot.sqlite'),'candidate changed database');
    setInterval(()=>fs.appendFileSync(path.join(data,'heartbeat'),'x'),50);
    process.on('message',m=>{if(m.type==='papilot:shutdown') {fs.writeFileSync(path.join(data,'stopped'),'yes');process.exit(0);}});`);
  };
  if (!updating) makeLayer();
  const active = { root: layer, version: '0.9.1', installer: '0.9.0', phase: 'active' };
  write(path.join(data, updating ? 'activation.json' : 'updates/desktop/active.json'), active);
  write(path.join(data, 'papilot.sqlite'), 'original database');
  const config = Buffer.from(JSON.stringify({ id, fingerprint, nodeMajor: process.versions.node.split('.')[0] })).toString('base64');
  const child = spawn(process.execPath, ['--import', 'tsx', 'desktop/wsl-runtime.mjs', 'serve', config], {
    cwd: root, env: { ...process.env, HOME: home, PAPILOT_TEST_WSL_RUNTIME: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '', candidate = 0;
  child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
  const messages = () => out.split('\n').filter(line => line.startsWith('PAPILOT_CONTROL:')).map(line => JSON.parse(line.slice(16)));
  const waitReady = async (count: number) => {
    const deadline = performance.now() + 10000;
    while (messages().length < count && child.exitCode === null && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(messages().length, count, err || out || 'No ready message');
    return messages()[count - 1];
  };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    let ready = await waitReady(1);
    if (updating) { makeLayer(); await fetch(ready.url + '/activate'); ready = await waitReady(2); }
    candidate = Number(fs.readFileSync(path.join(data, 'candidate.pid'), 'utf8'));
    assert.equal(alive(candidate), false, 'The candidate must exit before the fallback becomes ready');
    assert.equal(fs.readFileSync(path.join(data, 'stopped'), 'utf8'), 'yes');
    const heartbeat = fs.readFileSync(path.join(data, 'heartbeat'), 'utf8');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(fs.readFileSync(path.join(data, 'heartbeat'), 'utf8'), heartbeat, 'No writes after fallback');
    assert.equal((await (await fetch(ready.url + '/api/health')).json()).desktopInstance, ready.instance);
    if (updating) assert.equal(fs.readFileSync(path.join(data, 'papilot.sqlite'), 'utf8'), 'original database');
    const ended = new Promise(resolve => child.once('exit', resolve));
    child.stdin.end('{"type":"papilot:shutdown"}\n'); await ended;
    assert.equal(child.exitCode, 0, err); assert.equal(alive(candidate), false);
  } finally {
    if (child.exitCode === null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill(); await ended; }
    if (!candidate && fs.existsSync(path.join(data, 'candidate.pid'))) candidate = Number(fs.readFileSync(path.join(data, 'candidate.pid'), 'utf8'));
    if (candidate && alive(candidate)) process.kill(candidate, 'SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  }
});

for (const updating of [false, true]) test(`WSL shutdown prevents a new backend during ${updating ? 'an update' : 'a port rebind'}`, { skip: process.platform === 'win32', timeout: 20000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-wsl-shutdown-')), root = process.cwd();
  const id = 'a'.repeat(64), fingerprint = 'c'.repeat(64), base = path.join(home, '.local/share/papilot-desktop');
  const runtime = path.join(base, 'runtime', id), data = path.join(base, 'data'), bundle = path.join(runtime, 'server');
  const write = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  const module = JSON.stringify(pathToFileURL(path.join(root, 'desktop/runtime.ts')).href);
  write(path.join(runtime, 'bridge/package.json'), { type: 'module' });
  // Record actual spawns before a new process could outlive the bridge. This
  // catches the race even if its TypeScript loader has not started running yet.
  write(path.join(runtime, 'bridge/runtime.js'), `export * from ${module}; import {startBackend as start} from ${module};import fs from 'node:fs';import path from 'node:path';
    export function startBackend(options) { const backend=start(options);
      fs.appendFileSync(path.join(options.data,'launches.jsonl'),JSON.stringify({pid:backend.child.pid,root:options.root})+'\\n');return backend; }`);
  write(path.join(runtime, 'ready.json'), {});
  write(path.join(bundle, 'package.json'), { name: 'papilot', version: '0.9.0', type: 'module' });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(bundle, 'node_modules'), 'dir');
  const source = `import fs from 'node:fs';import path from 'node:path';import http from 'node:http';const data=process.env.PAPILOT_DATA;
    if(fs.existsSync(path.join(data,'first.pid'))) {setInterval(()=>fs.appendFileSync(path.join(data,'late-writes'),'x'),50);}
    else {fs.writeFileSync(path.join(data,'first.pid'),String(process.pid));let stopping=0;
      const server=http.createServer((req,res)=>{if(req.url==='/activate') {process.send({type:'papilot:activate',...JSON.parse(fs.readFileSync(path.join(data,'activation.json'),'utf8'))});res.end('ok');}
        else res.end(JSON.stringify({name:'Papilot',desktopInstance:process.env.PAPILOT_DESKTOP_INSTANCE}));});
      server.listen(0,'127.0.0.1',()=>process.send({type:'papilot:ready',url:'http://127.0.0.1:'+server.address().port}));
      process.on('message',m=>{if(m.type==='papilot:can-switch')process.send({...m,busy:false});
        if(m.type==='papilot:shutdown') {fs.writeFileSync(path.join(data,'stopping'),'yes');if(++stopping===2)process.exit(0);}});}`;
  write(path.join(bundle, 'src/server/start.ts'), source);
  const config = Buffer.from(JSON.stringify({ id, fingerprint, nodeMajor: process.versions.node.split('.')[0] })).toString('base64');
  const child = spawn(process.execPath, ['--import', 'tsx', 'desktop/wsl-runtime.mjs', 'serve', config], {
    cwd: root, env: { ...process.env, HOME: home, PAPILOT_TEST_WSL_RUNTIME: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
  const waitFor = async (condition: () => boolean) => {
    const deadline = performance.now() + 10000;
    while (!condition() && child.exitCode === null && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(condition(), err || out || 'The backend did not reach the expected state');
  };
  const launches = (): { pid: number; root: string }[] => fs.existsSync(path.join(data, 'launches.jsonl'))
    ? fs.readFileSync(path.join(data, 'launches.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    await waitFor(() => out.includes('PAPILOT_CONTROL:'));
    const ready = JSON.parse(out.split('\n').find(line => line.startsWith('PAPILOT_CONTROL:'))!.slice(16));
    if (updating) {
      const layer = path.join(data, 'updates/desktop/layers/shutdown-layer/papilot');
      write(path.join(layer, 'package.json'), { name: 'papilot', version: '0.9.1', type: 'module' });
      write(path.join(layer, 'desktop-layer.json'), { format: 1, version: '0.9.1', fingerprint });
      write(path.join(layer, 'src/server/start.ts'), source);
      write(path.join(data, 'activation.json'), { root: layer, version: '0.9.1' });
      write(path.join(data, 'papilot.sqlite'), 'original database');
      await fetch(ready.url + '/activate');
    } else child.stdin.write(JSON.stringify({ type: 'papilot:rebind', instance: ready.instance }) + '\n');
    // Hold the old backend until both the switch and application shutdown have
    // requested its exit, making their overlapping stop calls deterministic.
    await waitFor(() => fs.existsSync(path.join(data, 'stopping')));
    const ended = new Promise(resolve => child.once('exit', resolve));
    child.stdin.end('{"type":"papilot:shutdown"}\n'); await ended;
    assert.equal(child.exitCode, 0, err);
    assert.equal(launches().length, 1, 'Neither the new backend nor the rollback may start after shutdown begins');
    assert.equal(alive(launches()[0].pid), false);
    assert.equal(fs.existsSync(path.join(data, 'late-writes')), false);
    if (updating) assert.equal(fs.readFileSync(path.join(data, 'papilot.sqlite'), 'utf8'), 'original database');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await ended; }
    for (const { pid } of launches()) if (alive(pid)) process.kill(pid, 'SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  }
});

for (const { updating, active, health } of [
  { updating: false, active: false, health: false },
  { updating: false, active: true, health: false },
  { updating: false, active: true, health: true },
  { updating: true, active: false, health: false },
  { updating: true, active: false, health: true },
]) test(`WSL shutdown ${updating ? 'rolls back candidate database' : active ? 'preserves the active version' : 'cancels initial startup'} ${health ? 'during health checking' : 'before readiness'}`, { skip: process.platform === 'win32', timeout: 20000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-wsl-candidate-shutdown-')), root = process.cwd();
  const id = 'b'.repeat(64), fingerprint = 'c'.repeat(64), base = path.join(home, '.local/share/papilot-desktop');
  const runtime = path.join(base, 'runtime', id), data = path.join(base, 'data'), bundle = path.join(runtime, 'server');
  const layer = path.join(data, 'updates/desktop/layers/candidate/papilot');
  const write = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  const module = JSON.stringify(pathToFileURL(path.join(root, 'desktop/runtime.ts')).href);
  write(path.join(runtime, 'bridge/package.json'), { type: 'module' });
  write(path.join(runtime, 'bridge/runtime.js'), `export * from ${module}; import {startBackend as start} from ${module};import fs from 'node:fs';import path from 'node:path';
    export function startBackend(options) { const backend=start(options);
      fs.appendFileSync(path.join(options.data,'launches.jsonl'),String(backend.child.pid)+'\\n');return backend; }`);
  write(path.join(runtime, 'ready.json'), {});
  write(path.join(bundle, 'package.json'), { name: 'papilot', version: '0.9.0', type: 'module' });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(bundle, 'node_modules'), 'dir');
  const candidateSource = `import fs from 'node:fs';import path from 'node:path';import http from 'node:http';const data=process.env.PAPILOT_DATA;
    ${updating ? "fs.writeFileSync(path.join(data,'papilot.sqlite'),'candidate changed database');" : ''}
    fs.writeFileSync(path.join(data,'candidate.pid'),String(process.pid));setInterval(()=>{},1000);
    ${health ? `const server=http.createServer(()=>fs.writeFileSync(path.join(data,'health.waiting'),'yes'));
      server.listen(0,'127.0.0.1',()=>process.send({type:'papilot:ready',url:'http://127.0.0.1:'+server.address().port}));` : ''}
    process.on('message',m=>{if(m.type==='papilot:shutdown')process.exit(0);});`;
  write(path.join(bundle, 'src/server/start.ts'), updating || active ? `import fs from 'node:fs';import path from 'node:path';import http from 'node:http';const data=process.env.PAPILOT_DATA;
    const server=http.createServer((req,res)=>{if(req.url==='/activate'){process.send({type:'papilot:activate',...JSON.parse(fs.readFileSync(path.join(data,'activation.json'),'utf8'))});res.end('ok');}
      else res.end(JSON.stringify({name:'Papilot',desktopInstance:process.env.PAPILOT_DESKTOP_INSTANCE}));});
    server.listen(0,'127.0.0.1',()=>process.send({type:'papilot:ready',url:'http://127.0.0.1:'+server.address().port}));
    process.on('message',m=>{if(m.type==='papilot:shutdown')process.exit(0);});` : candidateSource);
  write(path.join(data, 'papilot.sqlite'), 'original database');
  const makeLayer = () => {
    write(path.join(layer, 'package.json'), { name: 'papilot', version: '0.9.1', type: 'module' });
    write(path.join(layer, 'desktop-layer.json'), { format: 1, version: '0.9.1', fingerprint });
    write(path.join(layer, 'src/server/start.ts'), candidateSource);
  };
  const activeRecord = { root: layer, version: '0.9.1', installer: '0.9.0', phase: 'active' };
  if (active) { makeLayer(); write(path.join(data, 'updates/desktop/active.json'), activeRecord); }
  const config = Buffer.from(JSON.stringify({ id, fingerprint, nodeMajor: process.versions.node.split('.')[0] })).toString('base64');
  let out = '', err = '';
  const start = () => {
    out = ''; err = '';
    const child = spawn(process.execPath, ['--import', 'tsx', 'desktop/wsl-runtime.mjs', 'serve', config], {
      cwd: root, env: { ...process.env, HOME: home, PAPILOT_TEST_WSL_RUNTIME: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
    return child;
  };
  let child = start();
  const waitFor = async (condition: () => boolean) => {
    const deadline = performance.now() + 10000;
    while (!condition() && child.exitCode === null && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(condition(), err || out || 'The candidate did not reach the expected state');
  };
  const ready = () => JSON.parse(out.split('\n').find(line => line.startsWith('PAPILOT_CONTROL:'))!.slice(16));
  const launches = (): number[] => fs.existsSync(path.join(data, 'launches.jsonl')) ? fs.readFileSync(path.join(data, 'launches.jsonl'), 'utf8').trim().split('\n').map(Number) : [];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const shutdown = async () => { const ended = new Promise(resolve => child.once('exit', resolve)); child.stdin.end('{"type":"papilot:shutdown"}\n'); await ended; assert.equal(child.exitCode, 0, err); };
  try {
    if (updating) {
      await waitFor(() => out.includes('PAPILOT_CONTROL:'));
      makeLayer();
      write(path.join(data, 'activation.json'), { root: layer, version: '0.9.1' });
      await fetch(ready().url + '/activate');
    }
    await waitFor(() => fs.existsSync(path.join(data, 'candidate.pid')) && (!health || fs.existsSync(path.join(data, 'health.waiting'))));
    if (updating) assert.equal(fs.readFileSync(path.join(data, 'papilot.sqlite'), 'utf8'), 'candidate changed database');
    await shutdown();
    assert.equal(launches().length, updating ? 2 : 1, 'Shutdown must not launch a fallback backend');
    assert.ok(launches().every(pid => !alive(pid)), 'Every backend must stop before the bridge exits');
    assert.equal(fs.readFileSync(path.join(data, 'papilot.sqlite'), 'utf8'), 'original database', 'Rollback must complete before bridge exit');
    if (active) {
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'updates/desktop/active.json'), 'utf8')), activeRecord, 'Cancellation must keep the previously active version');
      assert.equal(fs.existsSync(path.join(data, 'updates/desktop/status.json')), false, 'Cancellation is not a startup failure');
      assert.equal(out.includes('PAPILOT_CONTROL:'), false, 'A canceled launch is not ready');
    }
    if (updating) {
      assert.equal(fs.existsSync(path.join(data, 'updates/desktop/active.json')), false);
      assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'updates/desktop/status.json'), 'utf8')).phase, 'failed');
      child = start();
      await waitFor(() => out.includes('PAPILOT_CONTROL:'));
      assert.equal((await (await fetch(ready().url + '/api/health')).json()).desktopInstance, ready().instance);
      assert.equal(fs.readFileSync(path.join(data, 'papilot.sqlite'), 'utf8'), 'original database', 'The previous version restarts with its original database');
      await shutdown();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await ended; }
    for (const pid of launches()) if (alive(pid)) process.kill(pid, 'SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  }
});
