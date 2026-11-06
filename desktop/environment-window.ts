import { BrowserWindow, clipboard, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { distributions, prepareWsl, validEnvironment, type Environment } from './wsl.js';

import { inspectEnvironment, setupLinks, type SetupLink } from './environment-check.js';

let opened: BrowserWindow | undefined;
export function chooseEnvironment(options: { parent?: BrowserWindow; current: Environment | null; assets: string; root: string; error?: string; apply: (value: Environment) => Promise<void> }) {
  if (opened) { opened.focus(); return; }
  const file = fileURLToPath(new URL('./environment.html', import.meta.url));
  const page = new BrowserWindow({ title: 'Papilot · Environment', width: 820, height: 850, minWidth: 660, minHeight: 640,
    parent: options.parent, modal: Boolean(options.parent), autoHideMenuBar: true, backgroundColor: '#f7f8fa',
    webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  opened = page;
  page.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  page.webContents.on('will-navigate', event => event.preventDefault());
  const trusted = (event: IpcMainInvokeEvent) => event.sender === page.webContents && event.senderFrame === page.webContents.mainFrame && event.senderFrame?.url === pathToFileURL(file).href;
  let preparing = false;
  let preparation: AbortController | undefined;
  const handlers: Record<string, (event: IpcMainInvokeEvent, ...args: any[]) => unknown> = {
    info: async () => {
      let available: string[] = [], discoveryError = '';
      try { available = await distributions(); } catch (failure) { discoveryError = failure instanceof Error ? failure.message : String(failure); }
      return { current: options.current, distributions: available, startupError: options.error || '', discoveryError };
    },
    inspect: async (_event, value: Environment) => {
      if (preparing || !validEnvironment(value)) throw new Error('Choose an environment after setup finishes.');
      return inspectEnvironment(value, options.assets, options.root);
    },
    prepare: async (_event, distribution: string) => {
      if (preparing || typeof distribution !== 'string') throw new Error('Setup is already running.');
      preparing = true;
      preparation = new AbortController();
      try {
        const report = await inspectEnvironment({ kind: 'wsl', distribution }, options.assets, options.root);
        if (!report.canPrepare) throw new Error('Install Linux Node.js 22.22+ and npm, then check again.');
        await prepareWsl(distribution, options.assets, text => { if (!page.isDestroyed()) page.webContents.send('papilot:environment:progress', text); }, preparation.signal); return true; }
      finally { preparing = false; preparation = undefined; }
    },
    cancel: () => preparation?.abort(),
    apply: async (_event, value: Environment) => {
      if (preparing || !validEnvironment(value)) throw new Error('Choose an environment after setup finishes.');
      if (value.kind === 'wsl' && !(await distributions()).includes(value.distribution)) throw new Error('Choose an installed distribution.');
      await options.apply(value);
      page.close();
    },
    help: (_event, key: SetupLink = 'wsl') => {
      if (!Object.hasOwn(setupLinks, key)) throw new Error('Unknown installation guide.');
      return shell.openExternal(setupLinks[key]);
    },
    copyInstall: () => clipboard.writeText('wsl --install -d Ubuntu'),
  };
  for (const [name, handle] of Object.entries(handlers)) ipcMain.handle(`papilot:environment:${name}`, (event, ...args) => {
    if (!trusted(event)) throw new Error('This action is only available in the environment chooser.');
    return handle(event, ...args);
  });
  page.on('close', event => { if (preparing) event.preventDefault(); });
  page.on('closed', () => { opened = undefined; for (const name of Object.keys(handlers)) ipcMain.removeHandler(`papilot:environment:${name}`); });
  void page.loadFile(file);
}
