import assert from 'node:assert/strict';
import { expect } from './playwright.mjs';

// Exercise the actual sandboxed preload and main process without depending on
// an OS notification daemon, permission prompt or sound device in CI.
export async function checkDesktopNotifications(application, page, snapshot) {
  const soundControl = ['darwin', 'win32'].includes(process.platform);
  await application.evaluate(({ Notification }) => {
    globalThis.notificationOriginals = { show: Notification.prototype.show, close: Notification.prototype.close, supported: Notification.isSupported };
    globalThis.notificationCalls = [];
    globalThis.notificationFailure = false;
    Notification.isSupported = () => true;
    Notification.prototype.show = function () {
      globalThis.notificationCalls.push(this);
      this.emit(globalThis.notificationFailure ? 'failed' : 'show');
    };
    Notification.prototype.close = function () { this.emit('close'); };
  });
  const calls = () => application.evaluate(() => globalThis.notificationCalls.map(n => ({ title: n.title, body: n.body, silent: n.silent })));
  const openSettings = async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  };
  const fixture = structuredClone(snapshot);
  const task = { id: 'notification-fixture', projectId: fixture.projects[0].id, name: 'notification-fixture', title: 'Notification fixture', instructions: '', worktree: '/tmp/notification-fixture', threadId: null, turnId: null, model: null, status: 'running', createdAt: 1, updatedAt: 1, feedbackCursor: 0, error: null, review: null };
  fixture.tasks = [task];
  const route = route => route.fulfill({ json: fixture });
  await page.route('**/api/state', route);
  await page.route('**/api/tasks/notification-fixture/items*', route => route.fulfill({ json: { items: [] } }));
  const nativeWindowState = () => application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return { hidden: !window.isVisible() || window.isMinimized(), focused: window.isFocused() };
  });
  const expectBackgroundWindow = () => expect.poll(nativeWindowState).toEqual({ hidden: true, focused: false });
  let focusSession, windowState;
  const restoreWindowState = async () => {
    if (!windowState) return;
    await windowState.evaluate(fixture => fixture.restore());
    await windowState.dispose(); windowState = undefined;
  };
  try {
    await page.evaluate(projectId => { localStorage.setItem('papilot:language', 'en'); localStorage.setItem('papilot:task', ''); localStorage.setItem('papilot:project', projectId); }, task.projectId);
    await page.reload();
    await expect(page.getByRole('button', { name: /^Notification fixture/ })).toBeVisible();
    // Browser permission remains denied; native delivery must still work.
    assert.equal(await page.evaluate(() => Notification.requestPermission()), 'denied');
    await openSettings();
    const enabled = page.getByRole('switch', { name: 'Notifications', exact: true });
    const sound = page.getByRole('switch', { name: 'Play a sound', exact: true });
    await expect(enabled).not.toBeChecked();
    if (soundControl) await expect(sound).toBeDisabled();
    else {
      await expect(sound).toHaveCount(0);
      await expect(page.getByText('Notification sounds are managed by your system settings.', { exact: true })).toBeVisible();
    }
    await enabled.check();
    if (soundControl) await expect(sound).toBeChecked();
    const send = page.getByRole('button', { name: 'Send a test notification' });
    await send.click();
    await expect(page.getByRole('status').filter({ hasText: 'Sent.' })).toBeVisible();
    assert.equal((await calls())[0].silent, false);
    if (soundControl) await sound.uncheck();
    await send.click();
    await expect.poll(async () => (await calls()).length).toBe(2);
    assert.equal((await calls())[1].silent, soundControl);
    await application.evaluate(() => { globalThis.notificationFailure = true; });
    await send.click();
    await expect(page.getByRole('status').filter({ hasText: 'Papilot could not show the notification.' })).toBeVisible();
    await application.evaluate(() => { globalThis.notificationFailure = false; });
    await page.reload();
    await openSettings();
    await expect(enabled).toBeChecked();
    if (soundControl) await expect(sound).not.toBeChecked();
    else await expect(sound).toHaveCount(0);
    await page.screenshot({ path: 'test-results/desktop-notifications.png' });

    focusSession = await page.context().newCDPSession(page);
    await focusSession.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    // Closing the Mac window must keep observing tasks. Other systems minimize.
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (process.platform === 'darwin') window.close(); else window.minimize();
    });
    await expectBackgroundWindow();
    // Playwright forces renderer focus on its own CDP session. A second
    // session cannot reliably clear that override. After checking the native
    // window, supply its verified state to this notification fixture only.
    // The real preload, notification IPC and click handler still run below.
    if (!await page.evaluate(() => document.hidden || !document.hasFocus())) {
      windowState = await page.evaluateHandle(state => {
        const keys = ['hidden', 'visibilityState', 'hasFocus'];
        const descriptors = keys.map(key => Object.getOwnPropertyDescriptor(document, key));
        Object.defineProperties(document, {
          hidden: { configurable: true, get: () => state.hidden },
          visibilityState: { configurable: true, get: () => state.hidden ? 'hidden' : 'visible' },
          hasFocus: { configurable: true, value: () => state.focused },
        });
        document.dispatchEvent(new Event('visibilitychange'));
        return { restore() {
          keys.forEach((key, index) => {
            if (descriptors[index]) Object.defineProperty(document, key, descriptors[index]);
            else delete document[key];
          });
          document.dispatchEvent(new Event('visibilitychange'));
        } };
      }, await nativeWindowState());
    }
    await expect.poll(() => page.evaluate(() => document.hidden || !document.hasFocus())).toBe(true);
    task.status = 'reviewing'; task.review = { state: 'done', round: null, counts: {} };
    await expect.poll(async () => (await calls()).length, { timeout: 20000 }).toBe(4);
    assert.deepEqual((await calls())[3], { title: 'Codex finished', body: task.title, silent: soundControl });
    await expectBackgroundWindow();
    await application.evaluate(() => globalThis.notificationCalls[3].emit('click'));
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return window.isVisible() && !window.isMinimized();
    })).toBe(true);
    await restoreWindowState();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.task-link.active .task-title')).toHaveText(task.title);

    // A second page with the same origin and preload is not the app window.
    assert.equal(await application.evaluate(async ({ app, BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0];
      const other = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: `${app.getAppPath()}/preload.cjs` } });
      try {
        await other.loadURL(main.webContents.getURL());
        return await other.webContents.executeJavaScript(`window.papilotDesktop.notify({ taskId: null, title: 'Rejected', body: '', sound: true })`);
      } finally { other.destroy(); }
    }), false);
    assert.equal((await calls()).length, 4);
    console.log('PASS: Native notifications, sound, failure feedback, preferences, background completion, click navigation and IPC isolation');
  } finally {
    await restoreWindowState();
    if (focusSession) { await focusSession.send('Emulation.setFocusEmulationEnabled', { enabled: true }); await focusSession.detach(); }
    await page.unroute('**/api/state', route);
    await page.unroute('**/api/tasks/notification-fixture/items*');
    await page.evaluate(() => { localStorage.removeItem('papilot:notifications'); localStorage.removeItem('papilot:notifications:sound'); localStorage.setItem('papilot:task', ''); });
    await application.evaluate(({ Notification }) => {
      for (const notification of globalThis.notificationCalls) notification.close();
      Notification.prototype.show = globalThis.notificationOriginals.show;
      Notification.prototype.close = globalThis.notificationOriginals.close;
      Notification.isSupported = globalThis.notificationOriginals.supported;
      delete globalThis.notificationCalls; delete globalThis.notificationOriginals; delete globalThis.notificationFailure;
    });
    await page.reload();
  }
}
