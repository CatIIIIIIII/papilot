import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

// Expose specific window and user-selected folder actions, not generic IPC or
// filesystem access. Papers open in place; their files stay on disk.
contextBridge.exposeInMainWorld('papilotDesktop', {
  platform: process.platform,
  minimize: () => ipcRenderer.send('papilot:window', 'minimize'),
  maximize: () => ipcRenderer.send('papilot:window', 'maximize'),
  close: () => ipcRenderer.send('papilot:window', 'close'),
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke('papilot:choose-directory'),
  openEnvironment: () => ipcRenderer.invoke('papilot:open-environment'),
  environment: (): Promise<string> => ipcRenderer.invoke('papilot:current-environment'),
  notify: (alert: { taskId: string | null; title: string; body: string; sound: boolean }): Promise<boolean> => ipcRenderer.invoke('papilot:notify', alert),
  onOpenTask: (listener: (taskId: string) => void) => {
    const receive = (_event: IpcRendererEvent, taskId: unknown) => { if (typeof taskId === 'string') listener(taskId); };
    ipcRenderer.on('papilot:open-task', receive);
    return () => { ipcRenderer.off('papilot:open-task', receive); };
  },
  // File › Open Folder… picks the folder in the main process and sends its path.
  onOpenFolder: (listener: (folder: string) => void) => {
    const receive = (_event: IpcRendererEvent, folder: unknown) => { if (typeof folder === 'string') listener(folder); };
    ipcRenderer.on('papilot:open-folder', receive);
    return () => { ipcRenderer.off('papilot:open-folder', receive); };
  },
});

// Every handler validates the local chooser window separately from app pages.
contextBridge.exposeInMainWorld('papilotEnvironment', {
  info: () => ipcRenderer.invoke('papilot:environment:info'),
  inspect: (value: unknown) => ipcRenderer.invoke('papilot:environment:inspect', value),
  copyInstall: () => ipcRenderer.invoke('papilot:environment:copyInstall'),
  prepare: (distribution: string) => ipcRenderer.invoke('papilot:environment:prepare', distribution),
  cancel: () => ipcRenderer.invoke('papilot:environment:cancel'),
  apply: (value: unknown) => ipcRenderer.invoke('papilot:environment:apply', value),
  help: (key?: string) => ipcRenderer.invoke('papilot:environment:help', key),
  onProgress: (listener: (text: string) => void) => {
    const receive = (_event: IpcRendererEvent, text: unknown) => { if (typeof text === 'string') listener(text); };
    ipcRenderer.on('papilot:environment:progress', receive);
    return () => ipcRenderer.off('papilot:environment:progress', receive);
  },
});
