import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { backendEnvironment, startBackend } from './runtime.js';

const releases = 'https://github.com/PapilotAI/papilot/releases';
app.setName('Papilot');
if (process.env.PAPILOT_DESKTOP_DATA) app.setPath('userData', path.resolve(process.env.PAPILOT_DESKTOP_DATA));
let window: BrowserWindow | null = null;
let backend: ReturnType<typeof startBackend> | undefined;
let quitting = false, stopped = false, origin = '';
function external(url: string) {
  try { if (['https:', 'http:'].includes(new URL(url).protocol)) void shell.openExternal(url); } catch { /* invalid link */ }
}
function showWindow() {
  if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); return; }
  if (!origin) return;
  window = new BrowserWindow({ title: 'Papilot', width: 1380, height: 900, minWidth: 900, minHeight: 620,
    titleBarStyle: 'hidden', trafficLightPosition: { x: 18, y: 16 },
    autoHideMenuBar: process.platform !== 'darwin',
    icon: process.platform === 'linux' ? path.join(app.isPackaged ? process.resourcesPath : path.resolve(fileURLToPath(new URL('../..', import.meta.url))), 'desktop/assets/icon.png') : undefined,
    show: false, backgroundColor: '#ffffff', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)) } });
  window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) { event.preventDefault(); external(url); }
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('closed', () => { window = null; });
  window.once('ready-to-show', () => window?.show());
  void window.loadURL(origin).catch(error => { if (!quitting) dialog.showErrorBox('Could not open Papilot', String(error)); });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    if (stopped || !backend) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void backend.stop().finally(() => { stopped = true; app.quit(); });
  });
  void app.whenReady().then(async () => {
    ipcMain.handle('papilot:choose-directory', async event => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return null;
      if (!event.senderFrame || new URL(event.senderFrame.url).origin !== origin) return null;
      const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
      return result.canceled ? null : result.filePaths[0] || null;
    });
    ipcMain.on('papilot:window', (event, action: unknown) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
      if (!event.senderFrame || new URL(event.senderFrame.url).origin !== origin) return;
      if (action === 'minimize') window.minimize();
      else if (action === 'maximize') { if (window.isMaximized()) window.unmaximize(); else window.maximize(); }
      else if (action === 'close') window.close();
    });
    const root = app.isPackaged ? path.join(process.resourcesPath, 'server') : path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
    const node = app.isPackaged ? path.join(process.resourcesPath, 'runtime/bin/node') : process.env.PAPILOT_DESKTOP_NODE;
    if (!node) throw new Error('Use npm run desktop to start the development app.');
    const data = app.getPath('userData'), log = path.join(app.getPath('logs'), 'backend.log');
    // A stable localhost origin preserves renderer drafts and preferences.
    const portFile = path.join(data, 'desktop-port.json');
    let port = 0;
    try {
      const saved = JSON.parse(fs.readFileSync(portFile, 'utf8'));
      if (Number.isInteger(saved) && saved > 0 && saved < 65536) port = saved;
    } catch { /* first launch */ }
    // Finder-launched apps do not inherit a terminal's proxy variables.
    let proxy = '';
    if (!process.env.HTTPS_PROXY && !process.env.https_proxy && !process.env.HTTP_PROXY && !process.env.http_proxy && !process.env.ALL_PROXY && !process.env.all_proxy) {
      const resolved = await session.defaultSession.resolveProxy('https://api.openai.com').catch(() => 'DIRECT');
      const address = /^PROXY ([^; ]+)/.exec(resolved)?.[1];
      if (address) proxy = `http://${address}`;
    }
    const environment = (server: string) => {
      const env: NodeJS.ProcessEnv = backendEnvironment(node, server, data);
      if (port) env.PAPILOT_PORT = String(port);
      if (proxy) env.HTTPS_PROXY = env.HTTP_PROXY = proxy;
      env.NO_PROXY = [env.NO_PROXY || env.no_proxy, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',');
      // Node's fetch and SDK HTTP clients can use the system proxy as well.
      env.NODE_USE_ENV_PROXY = '1';
      return env;
    };
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Papilot', submenu: [{ role: 'about' }, { label: 'Download Updates…', click: () => external(releases) }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
      { role: 'help', submenu: [{ label: 'Papilot Guide', click: () => external('https://github.com/PapilotAI/papilot#readme') }, { label: 'Show Logs', click: () => shell.showItemInFolder(log) }] },
    ]));
    const fatal = (message: string) => { dialog.showErrorBox('Papilot stopped', `${message}\n\nLog: ${log}`); app.quit(); };
    // Starts a backend and resolves once it serves requests. The window follows
    // it if an occupied port moved it to a new origin.
    const launch = async (folder: string) => {
      const next = startBackend({ node, root: folder, data, log, env: environment(folder) });
      backend = next;
      let url: string;
      try { url = await next.ready; } catch (error) { await next.stop(); throw error; }
      next.child.once('exit', () => { if (!quitting && backend === next) fatal('The local server stopped unexpectedly. Reopen Papilot to continue.'); });
      port = Number(new URL(url).port);
      fs.writeFileSync(portFile, JSON.stringify(port), { mode: 0o600 });
      if (url !== origin) { const moved = Boolean(origin); origin = url; if (moved) void window?.loadURL(origin); }
    };
    // Desktop always runs its bundled server, ignoring legacy npm activations.
    await launch(root);
    showWindow();
  }).catch(error => {
    dialog.showErrorBox('Could not start Papilot', `${error instanceof Error ? error.message : error}\n\nSee backend.log in ${app.getPath('logs')}.`);
    app.quit();
  });
}
