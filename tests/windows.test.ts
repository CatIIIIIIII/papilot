import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from '../engine/src/core/commands.mjs';
import { findCommand, npmCli, terminateTree } from '../engine/src/core/platform.mjs';
import { cleanPath } from '../engine/src/core/git.ts';
import { relocate } from '../engine/src/core/build.ts';
import { SynctexIndex, utf8Synctex } from '../engine/src/render/synctex.ts';
import { backendEnvironment, linkBundle, startBackend } from '../desktop/runtime.ts';
import { gzipSync, gunzipSync } from 'node:zlib';
import { findExecutable, spawnSyncCommand, execCommand } from '../bin/agent-paths.mjs';
import { createRequire } from 'node:module';

const windows = process.platform === 'win32';
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'papilot 中文 & spaces '));

test('repository paths accept Windows separators and reject drive paths', () => {
  assert.equal(cleanPath('chapters\\intro.tex'), 'chapters/intro.tex');
  for (const name of ['C:\\paper\\main.tex', 'C:main.tex', '\\\\server\\paper', '..\\main.tex', '.GIT\\config']) assert.throws(() => cleanPath(name));
});

test('npm is a Node entry point and returns a version', () => {
  const result = spawnSync(process.execPath, [npmCli(), '--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /^\d+\./);
});

test('Windows Path and PATHEXT find native commands instead of POSIX npm shims', { skip: !windows }, () => {
  const dir = temporary();
  try {
    fs.writeFileSync(path.join(dir, 'example'), '#!/bin/sh');
    fs.writeFileSync(path.join(dir, 'example.cmd'), '@echo off');
    assert.equal(findCommand('example', { Path: dir, PATHEXT: '.EXE;.CMD' })?.toLowerCase(), path.join(dir, 'example.cmd').toLowerCase());
    for (const find of [findCommand, findExecutable]) {
      assert.equal(find('example.cmd', { Path: dir, PATHEXT: '.EXE;.CMD' })?.toLowerCase(), path.join(dir, 'example.cmd').toLowerCase());
    }
    const env = backendEnvironment(process.execPath, dir, dir, { Path: dir });
    assert.ok(env.PATH.split(';').includes(dir)); assert.equal('Path' in env, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Regression from https://github.com/PapilotAI/papilot/pull/13 (blessedcursed).
test('desktop retains every inherited Windows PATH casing variant', { skip: !windows }, () => {
  const inherited = { Path: 'C:\\TeXLive\\bin\\windows', PATH: 'C:\\custom-bin', pAtH: 'C:\\extra-tools', KEEP: 'yes' };
  const env = backendEnvironment(process.execPath, process.cwd(), process.cwd(), inherited);
  assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['PATH']);
  for (const dir of [inherited.Path, inherited.PATH, inherited.pAtH]) assert.ok(env.PATH.split(path.delimiter).includes(dir));
  assert.equal((env as NodeJS.ProcessEnv).KEEP, 'yes');
  assert.equal(inherited.Path, 'C:\\TeXLive\\bin\\windows');
});

test('npm agent shims preserve Unicode, spaces, quotes, shell characters and multiline prompts', { skip: !windows }, () => {
  const dir = temporary();
  try {
    fs.writeFileSync(path.join(dir, 'agent.cjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    fs.writeFileSync(path.join(dir, 'agent.cmd'), '@echo off\r\nSET dp0=%~dp0\r\nnode "%dp0%\\agent.cjs" %*\r\n');
    const args = ['中文路径', 'a b', '"quoted"', 'x & whoami', '%PATH%', '!x!', 'first\nsecond'];
    for (const launch of [spawnSync, spawnSyncCommand]) {
      const result = launch(path.join(dir, 'agent.cmd'), args, { encoding: 'utf8' });
      assert.equal(result.status, 0, String(result.stderr)); assert.deepEqual(JSON.parse(String(result.stdout)), args);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('native Windows wrappers keep their interpreter even when they quote a JavaScript data file', { skip: !windows }, () => {
  const dir = temporary();
  try {
    const script = path.join(dir, 'data.js'), wrapper = path.join(dir, 'native.cmd');
    fs.writeFileSync(script, 'not JavaScript; this is data');
    const where = path.join(process.env.SystemRoot!, 'System32', 'where.exe');
    fs.writeFileSync(wrapper, `@echo off\r\nrem "${script}"\r\n"${where}" cmd.exe\r\n`);
    const result = spawnSyncCommand(wrapper, [], { encoding: 'utf8' });
    assert.equal(result.status, 0, String(result.stderr));
    assert.match(String(result.stdout), /cmd\.exe/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('npm shims with Node flags preserve attachment JSON in local and global bins', { skip: !windows }, async () => {
  const dir = temporary();
  try {
    // Use npm's actual generator, including its second cmd.exe parse.
    const require = createRequire(import.meta.url);
    const cmdShim = require(path.join(path.dirname(npmCli()), '../node_modules/cmd-shim/lib/index.js'));
    const entry = path.join(dir, 'agent.cjs');
    fs.writeFileSync(entry, '#!/usr/bin/env node --no-warnings --title "Papilot fixture"\nconsole.log(JSON.stringify({args:process.argv.slice(2),flags:process.execArgv}))');
    const args = ['--settings', JSON.stringify({ permissions: { allow: ['read_file(C:\\论文 with space\\image & 1.png)'] } }), 'first\nsecond', '%PATH%'];
    const flags = ['--no-warnings', '--title', 'Papilot fixture'];
    for (const bin of ['node_modules/.bin/agent', 'global/agent']) {
      const shim = path.join(dir, bin);
      await cmdShim(entry, shim);
      const result = spawnSyncCommand(shim + '.cmd', args, { encoding: 'utf8' });
      assert.equal(result.status, 0, String(result.stderr));
      assert.deepEqual(JSON.parse(String(result.stdout)), { args, flags });
      assert.deepEqual(JSON.parse(await execCommand(shim + '.cmd', args)), { args, flags });
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('npm shims that expand Node flags in cmd preserve JSON through the shell fallback', { skip: !windows }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-npm-expanded-flags-'));
  try {
    const require = createRequire(import.meta.url);
    const cmdShim = require(path.join(path.dirname(npmCli()), '../node_modules/cmd-shim/lib/index.js'));
    const entry = path.join(dir, 'agent.cjs');
    fs.writeFileSync(entry, '#!/usr/bin/env node %PAPILOT_TEST_NODE_FLAGS%\nconsole.log(JSON.stringify({args:process.argv.slice(2),flags:process.execArgv}))');
    const args = ['--settings', JSON.stringify({ permissions: { allow: ['read_file(C:\\论文 with space\\image & 1.png)'] } })];
    const env = { ...process.env, PAPILOT_TEST_NODE_FLAGS: '--no-warnings' };
    for (const bin of ['node_modules/.bin/agent', 'global/agent']) {
      const shim = path.join(dir, bin);
      await cmdShim(entry, shim);
      const result = spawnSyncCommand(shim + '.cmd', args, { encoding: 'utf8', env });
      assert.equal(result.status, 0, String(result.stderr));
      assert.deepEqual(JSON.parse(String(result.stdout)), { args, flags: ['--no-warnings'] });
      assert.deepEqual(JSON.parse(await execCommand(shim + '.cmd', args, { env })), { args, flags: ['--no-warnings'] });
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('npm _prog wrappers only bypass cmd when both branches invoke Node', { skip: !windows }, () => {
  const dir = temporary();
  try {
    const script = path.join(dir, 'agent.cjs'), wrapper = path.join(dir, 'agent.cmd');
    fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    fs.writeFileSync(wrapper, '@echo off\r\nSET dp0=%~dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n SET "_prog=node"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\agent.cjs" %*\r\n');
    const args = ['first\nsecond', 'a & b', '%PATH%'];
    const result = spawnSyncCommand(wrapper, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, String(result.stderr)); assert.deepEqual(JSON.parse(String(result.stdout)), args);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('SyncTeX reads adjacent data from paths with spaces and Unicode', () => {
  const dir = temporary(), pdf = path.join(dir, 'main.pdf');
  try {
    const data = gunzipSync(fs.readFileSync('examples/papilot-paper/preview/main.synctex.gz')).toString().replaceAll('@PAPILOT_EXAMPLE@', dir.split(path.sep).join('/'));
    fs.writeFileSync(pdf.replace(/\.pdf$/, '.synctex.gz'), gzipSync(data));
    const index = new SynctexIndex(pdf);
    try {
      let matches = 0;
      for (let line = 1; line <= 100; line++) matches += index.view(path.join(dir, 'main.tex'), line).length;
      assert.ok(matches > 0, 'source lines should locate PDF positions');
    } finally { index.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('update dependency links work without symlink privileges', () => {
  const dir = temporary(), bundle = path.join(dir, 'bundle'), layer = path.join(dir, 'layer');
  try {
    for (const folder of [path.join(bundle, 'node_modules'), path.join(bundle, 'engine/node_modules'), path.join(layer, 'engine')]) fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(bundle, 'node_modules/marker'), 'bundled');
    linkBundle(layer, bundle);
    assert.equal(fs.readFileSync(path.join(layer, 'node_modules/marker'), 'utf8'), 'bundled');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stopping a compiler kills its descendant process too', { timeout: 20000 }, async () => {
  const dir = temporary(), marker = path.join(dir, 'child.pid');
  const code = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(marker)},String(child.pid)); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', code], { detached: !windows, stdio: 'ignore' });
  let descendant = 0;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    descendant = Number(fs.readFileSync(marker, 'utf8'));
    terminateTree(child, 'SIGKILL');
    for (let i = 0; i < 100 && alive(descendant); i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(alive(descendant), false);
  } finally {
    terminateTree(child, 'SIGKILL');
    if (descendant && alive(descendant)) process.kill(descendant, 'SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('desktop backend opens SQLite and exits cleanly through IPC', { timeout: 90000 }, async () => {
  const data = temporary(), root = process.cwd();
  const backend = startBackend({ node: process.execPath, root, data, log: path.join(data, 'backend.log'), env: { ...backendEnvironment(process.execPath, root, data), PAPILOT_UPDATE_PROBE: '1' } });
  try {
    const origin = await backend.ready;
    assert.equal((await (await fetch(origin + '/api/health')).json()).name, 'Papilot');
    assert.ok(fs.existsSync(path.join(data, 'papilot.sqlite')));
    assert.equal(await backend.idle(), true, 'Environment switching checks the live backend');
    await backend.stop();
    assert.equal(backend.child.exitCode, 0);
  } finally { await backend.stop(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('legacy Windows SyncTeX paths are decoded without changing UTF-8 output', () => {
  const legacy = Buffer.concat([Buffer.from('Input:1:C:/'), Buffer.from([0xc2, 0xdb, 0xce, 0xc4]), Buffer.from('/main.tex\n')]);
  assert.equal(gunzipSync(utf8Synctex(gzipSync(legacy), () => 'gbk')).toString(), 'Input:1:C:/论文/main.tex\n');
  const utf8 = gzipSync(Buffer.from('Input:1:C:/论文/main.tex\n'));
  assert.equal(utf8Synctex(utf8, () => { throw new Error('Do not reinterpret valid UTF-8'); }), utf8);
});

test('reused SyncTeX relocates cache keys while preserving legacy path bytes', async () => {
  const dir = temporary(), oldKey = 'a'.repeat(32), newKey = 'b'.repeat(32);
  const prefix = Buffer.concat([Buffer.from('Input:1:C:/'), Buffer.from([0xc2, 0xdb, 0xce, 0xc4]), Buffer.from('/cache/builds/')]);
  const file = path.join(dir, 'main.synctex.gz');
  try {
    fs.writeFileSync(file, gzipSync(Buffer.concat([prefix, Buffer.from(oldKey + '/src/main.tex\n')])));
    await relocate(file, path.join(dir, oldKey), path.join(dir, newKey));
    assert.deepEqual(gunzipSync(fs.readFileSync(file)), Buffer.concat([prefix, Buffer.from(newKey + '/src/main.tex\n')]));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
