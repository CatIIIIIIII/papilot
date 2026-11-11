// Native Windows test of the environment chooser. Run after desktop:build.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect } from './playwright.mjs';

if (process.platform !== 'win32') throw new Error('Run this test on Windows.');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-environments-test-'));
const executablePath = process.env.PAPILOT_DESKTOP_EXECUTABLE || path.resolve('release/desktop/win-unpacked/Papilot.exe');
const env = { ...process.env, PAPILOT_DESKTOP_DATA: data, PAPILOT_UPDATE_PROBE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
let app;
const launch = () => electron.launch({ executablePath, env, chromiumSandbox: true, timeout: 90000 });
try {
  app = await launch();
  const chooser = await app.firstWindow();
  await expect(chooser.locator('h1')).toHaveText(/A good home|为论文/);
  await expect(chooser.locator('input[value=wsl]')).toBeChecked();
  await chooser.locator('input[value=wsl]').check();
  await expect(chooser.locator('#wsl')).toBeVisible();
  await expect(chooser.locator('#check-summary')).not.toBeEmpty();
  await expect(chooser.locator('#checks')).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });
  if (await chooser.locator('#distribution option').count()) {
    await expect(chooser.locator('.check')).toHaveCount(3);
    await expect(chooser.locator('#status.error')).toHaveCount(0);
  }
  fs.mkdirSync('test-results', { recursive: true });
  await chooser.screenshot({ path: 'test-results/desktop-environments.png' });
  await chooser.locator('input[value=native]').check();
  // Relaunch explicitly below so the replacement stays under the test driver.
  await app.evaluate(({ app }) => { app.relaunch = () => {}; });
  const closed = app.waitForEvent('close');
  await chooser.locator('#continue').click(); await closed; app = null;
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'environment.json'), 'utf8')), { kind: 'native' });
  app = await launch();
  const main = await app.firstWindow();
  await main.waitForURL('http://127.0.0.1:*/', { timeout: 90000 });
  await expect(main.locator('.pdf-toolbar')).toBeVisible();
  assert.equal(await main.evaluate(() => window.papilotDesktop.environment()), 'Windows');
  assert.equal(await main.evaluate(() => window.papilotEnvironment.info().then(() => false, () => true)), true, 'A server page cannot invoke the local chooser handlers');
  assert.deepEqual(await main.evaluate(() => Promise.all([
    window.papilotEnvironment.inspect({ kind: 'native' }),
    window.papilotEnvironment.help('node'),
    window.papilotEnvironment.copyInstall(),
  ].map(request => request.then(() => false, () => true)))), [true, true, true], 'Detection, external guides and clipboard stay restricted to the chooser');
  const popup = app.waitForEvent('window');
  await main.evaluate(() => window.papilotDesktop.openEnvironment());
  const settings = await popup;
  await expect(settings.locator('input[value=native]')).toBeChecked();
  await expect(settings.locator('h1')).toHaveText(/A good home|为论文/);
  await settings.close();
  console.log('PASS: first-launch environment selection, saved native mode, settings entry and IPC isolation.');
} finally { await app?.close(); fs.rmSync(data, { recursive: true, force: true }); }
