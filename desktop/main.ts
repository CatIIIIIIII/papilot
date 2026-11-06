import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, session, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { backendEnvironment, refreshWindowsPath, startBackend, startServer, switchServer, type Bundle } from './runtime.js';
import { desktopNotifications } from './notifications.js';
import { chooseEnvironment } from './environment-window.js';
import { readEnvironment, saveEnvironment, startWsl, linuxPath, type Environment } from './wsl.js';

const nix = process.env.PAPILOT_INSTALL_METHOD === 'nix';
const releases = 'https://github.com/PapilotAI/papilot/releases';
app.setName('Papilot');
if (process.platform === 'win32') app.setAppUserModelId('ai.papilot.desktop');
if (process.env.PAPILOT_DESKTOP_DATA) app.setPath('userData', path.resolve(process.env.PAPILOT_DESKTOP_DATA));
let window: BrowserWindow | null = null;
let backend: ReturnType<typeof startBackend> | Awaited<ReturnType<typeof startWsl>> | undefined;
let environment: Environment = { kind: 'native' };
let quitting = false, stopping = false, stopped = false, switching = false, origin = '';
const notifications = desktopNotifications({
  supported: () => Notification.isSupported(),
  create: options => {
    const notification = new Notification(options);
    notification.on('failed', (_event, error) => console.warn('Could not show a desktop notification:', error));
    return notification;
  },
  open: taskId => {
    showWindow();
    if (taskId) window?.webContents.send('papilot:open-task', taskId);
  },
});
function external(url: string) {
  try { if (['https:', 'http:'].includes(new URL(url).protocol)) void shell.openExternal(url); } catch { /* invalid link */ }
}
function showWindow() {
  if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); return; }
  if (!origin) return;
  window = new BrowserWindow({ title: 'Papilot', width: 1380, height: 900, minWidth: 900, minHeight: 620,
    titleBarStyle: 'hidden', trafficLightPosition: { x: 18, y: 16 },
    autoHideMenuBar: process.platform !== 'darwin',
    icon: process.platform === 'win32'
      ? path.join(nix && process.env.PAPILOT_DESKTOP_ROOT ? process.env.PAPILOT_DESKTOP_ROOT : app.isPackaged ? process.resourcesPath : path.resolve(fileURLToPath(new URL('../..', import.meta.url))), 'desktop/assets/icon.ico')
      : process.platform === 'linux' ? path.join(nix && process.env.PAPILOT_DESKTOP_ROOT ? process.env.PAPILOT_DESKTOP_ROOT : app.isPackaged ? process.resourcesPath : path.resolve(fileURLToPath(new URL('../..', import.meta.url))), 'desktop/assets/icon.png') : undefined,
    show: false, backgroundColor: '#ffffff', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)) } });
  window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) { event.preventDefault(); external(url); }
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  // macOS keeps tasks running after Close. Keep their notification observer too.
  window.on('close', event => {
    if (process.platform === 'darwin' && !quitting) { event.preventDefault(); window?.hide(); }
  });
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
    quitting = true;
    notifications.close();
    if (stopped || !backend) return;
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    void backend.stop().finally(() => { stopped = true; app.quit(); });
  });
  void app.whenReady().then(async () => {
    const data = app.getPath('userData'), log = path.join(app.getPath('logs'), 'backend.log');
    const wslAssets = app.isPackaged ? path.join(process.resourcesPath, 'wsl') : path.resolve(fileURLToPath(new URL('../wsl', import.meta.url)));
    const openEnvironment = (error?: string) => chooseEnvironment({ parent: window || undefined, current: readEnvironment(data), assets: wslAssets, root: app.isPackaged ? path.join(process.resourcesPath, 'server') : path.resolve(fileURLToPath(new URL('../..', import.meta.url))), error,
      apply: async value => {
        if (backend && !await backend.idle()) throw new Error('Finish or stop running tasks and builds before switching environments.');
        saveEnvironment(data, value);
        app.relaunch(); app.quit();
      },
    });
    const appPage = (event: Electron.IpcMainInvokeEvent) => window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame && new URL(event.senderFrame.url).origin === origin;
    ipcMain.handle('papilot:open-environment', event => { if (process.platform === 'win32' && appPage(event)) openEnvironment(); });
    ipcMain.handle('papilot:current-environment', event => appPage(event) ? environment.kind === 'wsl' ? `WSL · ${environment.distribution}` : 'Windows' : '');
    if (process.platform === 'win32') {
      const saved = readEnvironment(data);
      if (!saved) { openEnvironment(); return; }
      environment = saved;
    }
    ipcMain.handle('papilot:notify', (event, alert: unknown) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
      if (!event.senderFrame || new URL(event.senderFrame.url).origin !== origin) return false;
      return notifications.show(alert);
    });
    const chooseDirectory = async (parent: BrowserWindow) => {
      const result = await dialog.showOpenDialog(parent, { properties: ['openDirectory'],
        ...(environment.kind === 'wsl' ? { defaultPath: `\\\\wsl.localhost\\${environment.distribution}\\home` } : {}) });
      const selected = result.canceled ? null : result.filePaths[0] || null;
      return selected && environment.kind === 'wsl' ? linuxPath(environment.distribution, selected) : selected;
    };
    ipcMain.handle('papilot:choose-directory', async event => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return null;
      if (!event.senderFrame || new URL(event.senderFrame.url).origin !== origin) return null;
      return chooseDirectory(window);
    });
    // Like an editor's File › Open Folder…: the chosen folder opens as a paper.
    const openFolder = async () => {
      showWindow();
      const target = window;
      if (!target || !target.webContents.getURL().startsWith(origin + '/')) return;
      try {
        const folder = await chooseDirectory(target);
        if (folder && window === target) target.webContents.send('papilot:open-folder', folder);
      } catch (error) { dialog.showErrorBox('Could not open folder', error instanceof Error ? error.message : String(error)); }
    };
    ipcMain.on('papilot:window', (event, action: unknown) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
      if (!event.senderFrame || new URL(event.senderFrame.url).origin !== origin) return;
      if (action === 'minimize') window.minimize();
      else if (action === 'maximize') { if (window.isMaximized()) window.unmaximize(); else window.maximize(); }
      else if (action === 'close') window.close();
    });
    const root = nix && process.env.PAPILOT_DESKTOP_ROOT ? process.env.PAPILOT_DESKTOP_ROOT : app.isPackaged ? path.join(process.resourcesPath, 'server') : path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
    const node = nix ? process.env.PAPILOT_DESKTOP_NODE : app.isPackaged ? path.join(process.resourcesPath, 'runtime/bin', process.platform === 'win32' ? 'node.exe' : 'node') : process.env.PAPILOT_DESKTOP_NODE;
    if (!node) throw new Error('Use npm run desktop to start the development app.');
    const read = (file: string) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
    // Only packaged apps know their shell and install update layers.
    const bundle: Bundle = { root, version: read(path.join(root, 'package.json'))?.version || '',
      fingerprint: !nix && app.isPackaged ? String(read(path.join(app.getAppPath(), 'package.json'))?.desktopFingerprint || '') : '' };
    // A stable localhost origin preserves renderer drafts and preferences.
    const portFile = path.join(data, environment.kind === 'wsl' ? `desktop-port-wsl-${Buffer.from(environment.distribution).toString('hex')}.json` : 'desktop-port.json');
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
    const inheritedEnv = environment.kind === 'native' ? await refreshWindowsPath() : process.env;
    const backendEnv = (server: string) => {
      const env: NodeJS.ProcessEnv = backendEnvironment(node, server, data, inheritedEnv);
      if (port) env.PAPILOT_PORT = String(port);
      if (proxy) env.HTTPS_PROXY = env.HTTP_PROXY = proxy;
      env.NO_PROXY = [env.NO_PROXY || env.no_proxy, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',');
      // Node's fetch and SDK HTTP clients can use the system proxy as well.
      env.NODE_USE_ENV_PROXY = '1';
      if (bundle.fingerprint) { env.PAPILOT_DESKTOP_BUNDLE = root; env.PAPILOT_DESKTOP_FINGERPRINT = bundle.fingerprint; }
      return env;
    };
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Papilot', submenu: [{ role: 'about' }, { label: nix ? 'Updates managed by Nix' : 'Download Updates…', enabled: !nix, click: () => external(releases) }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { label: 'File', submenu: [{ id: 'open-folder', label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => void openFolder() }, { type: 'separator' }, process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }] },
      ...(process.platform === 'win32' ? [{ label: 'Environment', submenu: [{ label: environment.kind === 'wsl' ? `WSL · ${environment.distribution}…` : 'Windows…', click: () => openEnvironment() }] }] : []),
      { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
      { role: 'help', submenu: [{ label: 'Papilot Guide', click: () => external('https://github.com/PapilotAI/papilot#readme') }, { label: 'Show Logs', click: () => shell.showItemInFolder(log) }] },
    ]));
    let server = root;
    const fatal = (message: string) => { dialog.showErrorBox('Papilot stopped', `${message}\n\nLog: ${log}`); app.quit(); };
    // Starts a backend and resolves once it serves requests. The window follows
    // it if an occupied port moved it to a new origin.
    const launch = async (folder: string) => {
      const next = environment.kind === 'wsl'
        ? await startWsl({ distribution: environment.distribution, assets: wslAssets, fingerprint: bundle.fingerprint, nodeMajor: read(path.join(wslAssets, 'manifest.json'))?.nodeMajor || '', port, log })
        : startBackend({ node, root: folder, data, log, env: backendEnv(folder) });
      backend = next;
      let url: string;
      try { url = await next.ready; } catch (error) { await next.stop(); throw error; }
      next.child.once('exit', () => { if (!quitting && !switching && backend === next) fatal('The local server stopped unexpectedly. Reopen Papilot to continue.'); });
      // The backend asks for the switch once its update is ready and idle.
      next.child.on('message', message => {
        if (environment.kind === 'wsl' && (message as any)?.type === 'papilot:ready') {
          const url = new URL((message as any).url);
          if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !Number(url.port)) return;
          port = Number(url.port); fs.writeFileSync(portFile, JSON.stringify(port));
          if (origin && url.origin !== origin) { origin = url.origin; void window?.loadURL(origin); }
        }
        if (environment.kind === 'wsl' || nix || backend !== next || switching || quitting || (message as { type?: unknown } | null)?.type !== 'papilot:activate') return;
        switching = true;
        void switchServer(data, bundle, message, server, () => next.stop(), launch).then(running => { server = running; })
          .catch(error => fatal(`Papilot could not restart after the update: ${error instanceof Error ? error.message : error}`))
          .finally(() => { switching = false; });
      });
      port = Number(new URL(url).port);
      fs.writeFileSync(portFile, JSON.stringify(port), { mode: 0o600 });
      if (url !== origin) { const moved = Boolean(origin); origin = url; if (moved) void window?.loadURL(origin); }
    };
    // Legacy npm activations (updates/active.json) are never used.
    try {
      if (environment.kind === 'wsl') await launch(root);
      else server = await startServer(data, bundle, launch);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
      await backend?.stop(); backend = undefined;
      openEnvironment(error instanceof Error ? error.message : String(error)); return;
    }
    showWindow();
  }).catch(error => {
    dialog.showErrorBox('Could not start Papilot', `${error instanceof Error ? error.message : error}\n\nSee backend.log in ${app.getPath('logs')}.`);
    app.quit();
  });
}
