import './desktop-chrome.css';
import { t } from './i18n.ts';

declare global {
  interface Window {
    papilotDesktop?: {
      platform: string; minimize(): void; maximize(): void; close(): void;
      chooseDirectory?(): Promise<string | null>;
      pathForFile?(file: File): string;
    };
  }
}
export const desktopWindow = Boolean(window.papilotDesktop);
if (desktopWindow) document.documentElement.dataset.desktop = window.papilotDesktop!.platform;

export function DesktopWindowChrome() {
  if (!desktopWindow) return null;
  const controls = window.papilotDesktop!;
  return <div className="desktop-window-drag">
    {controls.platform !== 'darwin' && <div className="desktop-window-buttons">
      <button className="desktop-window-close" aria-label={t('Close window')} title={t('Close window')} onClick={() => controls.close()}><svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8"/></svg></button>
      <button aria-label={t('Minimize window')} title={t('Minimize window')} onClick={() => controls.minimize()}><svg viewBox="0 0 16 16"><path d="M3 8h10"/></svg></button>
      <button aria-label={t('Maximize or restore window')} title={t('Maximize or restore window')} onClick={() => controls.maximize()}><svg viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="9" rx="1"/></svg></button>
    </div>}
  </div>;
}
