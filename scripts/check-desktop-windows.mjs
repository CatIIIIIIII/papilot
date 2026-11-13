import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect } from './playwright.mjs';

const run = promisify(execFile);
const script = fileURLToPath(new URL('./windows-hit-test.ps1', import.meta.url));

export async function checkWindowsHitRegions(application, page) {
  if (process.platform !== 'win32') return;
  const handle = await application.evaluate(({ BrowserWindow }) => {
    const buffer = BrowserWindow.getAllWindows()[0].getNativeWindowHandle();
    return buffer.length === 8 ? buffer.readBigUInt64LE().toString() : buffer.readUInt32LE().toString();
  });
  const buttons = page.locator('.desktop-window-buttons button');
  await expect(buttons).toHaveCount(3);
  for (const button of await buttons.all()) {
    const label = await button.getAttribute('aria-label');
    await expect.poll(async () => {
      const point = await button.evaluate(element => {
        const box = element.getBoundingClientRect();
        return { x: Math.round((box.x + box.width / 2) * devicePixelRatio), y: Math.round((box.y + box.height / 2) * devicePixelRatio) };
      });
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-Window', handle, '-X', String(point.x), '-Y', String(point.y)], { timeout: 10_000, windowsHide: true });
      return Number(stdout.trim());
    }, { message: `${label} must hit HTCLIENT (1), not HTCAPTION (2)` }).toBe(1);
  }
}
