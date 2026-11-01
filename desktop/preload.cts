import { contextBridge, ipcRenderer, webUtils } from 'electron';

// Expose specific window and user-selected path actions, not generic IPC or
// filesystem access. File contents stay on disk for local directory imports.
contextBridge.exposeInMainWorld('papilotDesktop', {
  platform: process.platform,
  minimize: () => ipcRenderer.send('papilot:window', 'minimize'),
  maximize: () => ipcRenderer.send('papilot:window', 'maximize'),
  close: () => ipcRenderer.send('papilot:window', 'close'),
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke('papilot:choose-directory'),
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
});
