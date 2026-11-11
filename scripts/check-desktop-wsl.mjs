// Native Windows + WSL integration test. Uses isolated data on both systems.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { _electron as electron, expect } from './playwright.mjs';

const distro = process.env.PAPILOT_WSL_TEST_DISTRIBUTION;
if (process.platform !== 'win32' || !distro) throw new Error('Run on Windows with PAPILOT_WSL_TEST_DISTRIBUTION set to a prepared Linux distribution.');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-wsl-test-')), token = path.basename(data);
// Windows and WSL have distinct loopback sockets. A different Papilot on the
// remembered Windows port must never become this distribution's workspace.
const occupied = http.createServer((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ name: 'Papilot', collision: true })); });
await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
const occupiedPort = occupied.address().port;
fs.writeFileSync(path.join(data, `desktop-port-wsl-${Buffer.from(distro).toString('hex')}.json`), JSON.stringify(occupiedPort));
const winPaper = path.join(data, 'Windows 论文 & spaces');
const wsl = (args) => {
  const result = spawnSync('wsl.exe', ['--distribution', distro, '--exec', ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout); return result.stdout.trim();
};
const linuxNode = wsl(['bash', '-lc', 'command -v node']);
const linux = (code, args = []) => wsl([linuxNode, '-e', code, ...args]);
// WSL may stop after its last client exits, and Ubuntu clears /tmp at boot.
// Keep this isolated fixture in persistent user storage, like the real app.
const linuxData = linux('console.log(require("os").homedir())') + '/.local/share/' + token;
const linuxPaper = linuxData + '/WSL 论文 & spaces';
const executablePath = process.env.PAPILOT_DESKTOP_EXECUTABLE || path.resolve('release/desktop/win-unpacked/Papilot.exe');
const env = { ...process.env, PAPILOT_DESKTOP_DATA: data, PAPILOT_WSL_DATA: linuxData, PAPILOT_UPDATE_PROBE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const launch = () => electron.launch({ executablePath, env, chromiumSandbox: true, timeout: 120000 });
let app, address;
try {
  assert.equal(linux('console.log(process.platform)'), 'linux');
  app = await launch();
  const chooser = await app.firstWindow();
  await chooser.locator('input[value=wsl]').check();
  await expect(chooser.locator('#distribution')).toContainText(distro, { timeout: 30000 });
  await chooser.locator('#distribution').selectOption(distro);
  await expect(chooser.locator('#checks')).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });
  if (await chooser.locator('#prepare').isVisible()) await chooser.locator('#prepare').click();
  await expect.poll(async () => await chooser.locator('#continue').isEnabled() || await chooser.locator('#status.error').count() > 0, { timeout: 900000 }).toBe(true);
  await expect(chooser.locator('#continue')).toBeEnabled();
  console.log('WSL environment prepared.');
  fs.mkdirSync('test-results', { recursive: true });
  await chooser.screenshot({ path: 'test-results/desktop-wsl-ready.png' });
  await app.evaluate(({ app }) => { app.relaunch = () => {}; });
  const closed = app.waitForEvent('close'); await chooser.locator('#continue').click(); await closed; app = null;
  app = await launch();
  const main = await app.firstWindow();
  await main.waitForURL('http://127.0.0.1:*/', { timeout: 120000 });
  address = new URL(main.url()).origin;
  assert.notEqual(Number(new URL(address).port), occupiedPort, 'A Windows port collision must choose a different Linux port');
  const health = await (await fetch(address + '/api/health')).json();
  assert.equal(typeof health.desktopInstance, 'string'); assert.equal(health.collision, undefined);
  console.log('Windows port collision recovered with verified WSL instance.');
  await expect(main.locator('.pdf-toolbar')).toBeVisible();
  assert.equal(await main.evaluate(() => window.papilotDesktop.environment()), 'WSL · ' + distro);
  assert.equal(linux('console.log(require("fs").existsSync(process.argv[1]))', [linuxData + '/papilot.sqlite']), 'true');
  assert.equal(fs.existsSync(path.join(data, 'papilot.sqlite')), false, 'WSL owns its database inside Linux');
  console.log('Windows UI connected to the Linux backend.');
  const content = '\\documentclass{article}\n\\begin{document}\nHello from the WSL compiler.\n\\end{document}\n';
  linux('const fs=require("fs");fs.mkdirSync(process.argv[1],{recursive:true});fs.writeFileSync(process.argv[1]+"/main.tex",Buffer.from(process.argv[2],"base64"))', [linuxPaper, Buffer.from(content).toString('base64')]);
  fs.mkdirSync(winPaper); fs.writeFileSync(path.join(winPaper, 'main.tex'), content);
  const state = async () => (await fetch(address + '/api/state')).json();
  for (const folder of [`\\\\wsl.localhost\\${distro}${linuxPaper.replaceAll('/', '\\')}`, winPaper]) {
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, folder);
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('open-folder').click());
    let project;
    await expect.poll(async () => { project = (await state()).projects.find(p => p.name === (folder === winPaper ? 'Windows 论文 & spaces' : 'WSL 论文 & spaces')); return Boolean(project); }, { timeout: 30000 }).toBe(true);
    if (folder === winPaper) assert.ok(project.path.startsWith('/mnt/'), project.path);
    else assert.equal(project.path, linuxPaper);
    await expect.poll(async () => (await (await fetch(`${address}/api/projects/${project.id}/manuscript`)).json()).build?.status, { timeout: 120000 }).toBe('ready');
    await expect(main.locator('.pdf-viewer canvas, .pdfViewer canvas').first()).toBeVisible({ timeout: 30000 });
    console.log('Compiled and displayed:', project.path);
  }
  await main.screenshot({ path: 'test-results/desktop-wsl-paper.png' });
  // Switching back uses the native backend and keeps the WSL files in place.
  const popup = app.waitForEvent('window'); await main.evaluate(() => window.papilotDesktop.openEnvironment());
  const change = await popup;
  await expect(change.locator('input[value=wsl]')).toBeChecked();
  await change.locator('input[value=native]').check();
  await app.evaluate(({ app }) => { app.relaunch = () => {}; });
  const switched = app.waitForEvent('close'); await change.locator('#continue').click(); await switched; app = null;
  await assert.rejects(fetch(address + '/api/health', { signal: AbortSignal.timeout(3000) }));
  app = await launch();
  const native = await app.firstWindow(); await native.waitForURL('http://127.0.0.1:*/', { timeout: 120000 });
  assert.equal(await native.evaluate(() => window.papilotDesktop.environment()), 'Windows');
  assert.ok(fs.existsSync(path.join(data, 'papilot.sqlite')));
  assert.equal(linux('console.log(require("fs").existsSync(process.argv[1]))', [linuxData + '/papilot.sqlite']), 'true');
  console.log('PASS: WSL setup, native Windows UI with a Linux backend, WSL and Windows Unicode folder compilation, clean shutdown and switching back to Windows.');
} catch (error) {
  console.error(error);
  if (app) for (const page of app.windows()) {
    console.error('PAGE', page.url(), (await page.locator('body').innerText().catch(() => '')).slice(-6000));
  }
  throw error;
} finally {
  await app?.close();
  occupied.closeAllConnections(); await new Promise(resolve => occupied.close(resolve));
  linux('require("fs").rmSync(process.argv[1],{recursive:true,force:true})', [linuxData]);
  fs.rmSync(data, { recursive: true, force: true });
}
