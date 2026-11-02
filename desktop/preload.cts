import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

// Expose specific window and user-selected folder actions, not generic IPC or
// filesystem access. Papers open in place; their files stay on disk.
contextBridge.exposeInMainWorld('papilotDesktop', {
  platform: process.platform,
  minimize: () => ipcRenderer.send('papilot:window', 'minimize'),
  maximize: () => ipcRenderer.send('papilot:window', 'maximize'),
  close: () => ipcRenderer.send('papilot:window', 'close'),
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke('papilot:choose-directory'),
  // File › Open Folder… picks the folder in the main process and sends its path.
  onOpenFolder: (listener: (folder: string) => void) => {
    const receive = (_event: IpcRendererEvent, folder: unknown) => { if (typeof folder === 'string') listener(folder); };
    ipcRenderer.on('papilot:open-folder', receive);
    return () => { ipcRenderer.off('papilot:open-folder', receive); };
  },
});
