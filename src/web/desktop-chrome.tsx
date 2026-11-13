import './desktop-chrome.css';
import { createPortal } from 'react-dom';
import { t } from './i18n.ts';

declare global {
  interface Window {
    papilotDesktop?: {
      platform: string; minimize(): void; maximize(): void; close(): void;
      chooseDirectory?(): Promise<string | null>;
      openEnvironment?(): Promise<void>;
      environment?(): Promise<string>;
      onOpenFolder?(listener: (folder: string) => void): () => void;
      notify?(alert: { taskId: string | null; title: string; body: string; sound: boolean }): Promise<boolean>;
      onOpenTask?(listener: (taskId: string) => void): () => void;
    };
  }
}
export const desktopWindow = Boolean(window.papilotDesktop);
if (desktopWindow) document.documentElement.dataset.desktop = window.papilotDesktop!.platform;
// The desktop app opens papers in place, as folders from the system picker.
// Nothing is typed, uploaded or copied.
export const nativeFolders = Boolean(window.papilotDesktop?.chooseDirectory);
export const chooseDirectory = () => window.papilotDesktop!.chooseDirectory!();

export function DesktopWindowChrome() {
  if (!desktopWindow) return null;
  const controls = window.papilotDesktop!;
  const close = <button className="desktop-window-close" aria-label={t('Close window')} title={t('Close window')} onClick={() => controls.close()}><svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8"/></svg></button>;
  const chrome = <div className="desktop-window-drag">
    {controls.platform !== 'darwin' && <div className="desktop-window-buttons">
      {controls.platform !== 'win32' && close}
      <button aria-label={t('Minimize window')} title={t('Minimize window')} onClick={() => controls.minimize()}><svg viewBox="0 0 16 16"><path d="M3 8h10"/></svg></button>
      <button aria-label={t('Maximize or restore window')} title={t('Maximize or restore window')} onClick={() => controls.maximize()}><svg viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="9" rx="1"/></svg></button>
      {controls.platform === 'win32' && close}
    </div>}
  </div>;
  // Windows applies overlapping drag/no-drag rectangles in DOM order, even
  // when z-index paints these buttons above a later toolbar. Put its controls
  // after the workspace so their no-drag regions win native hit testing.
  return controls.platform === 'win32' ? createPortal(chrome, document.body) : chrome;
}
