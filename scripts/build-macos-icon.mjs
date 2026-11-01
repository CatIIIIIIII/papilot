// Render the editable SVG and package the legacy macOS icon. Requires macOS,
// Google Chrome, and the Playwright dependency installed by setup:review.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from '../vendor/latex-review/node_modules/playwright/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'assets/macos');
const iconset = path.join(directory, 'Papilot.iconset');
const source = await fs.readFile(path.join(directory, 'Papilot.svg'), 'utf8');
await fs.mkdir(iconset, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  await page.setContent('<html><body style="margin:0;background:transparent"></body></html>');
  const sizes = [16, 32, 64, 128, 256, 512, 1024];
  for (const size of sizes) {
    const data = await page.evaluate(async ({ source, size }) => {
      const img = new Image();
      img.src = `data:image/svg+xml;base64,${btoa(source)}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const context = canvas.getContext('2d');
      context.drawImage(img, 0, 0, size, size);
      return canvas.toDataURL('image/png').split(',')[1];
    }, { source, size });
    const png = Buffer.from(data, 'base64');
    if (size === 1024) await fs.writeFile(path.join(directory, 'Papilot.png'), png);
    if ([16, 32, 128, 256, 512].includes(size)) {
      await fs.writeFile(path.join(iconset, `icon_${size}x${size}.png`), png);
    }
    if ([32, 64, 256, 512, 1024].includes(size)) {
      await fs.writeFile(path.join(iconset, `icon_${size / 2}x${size / 2}@2x.png`), png);
    }
  }
  const icon = `data:image/png;base64,${(await fs.readFile(path.join(directory, 'Papilot.png'))).toString('base64')}`;
  await page.setViewportSize({ width: 1200, height: 720 });
  const samples = [128, 64, 32, 16].map(size => `<figure><img src="${icon}" width="${size}" height="${size}"><figcaption>${size} px</figcaption></figure>`).join('');
  await page.setContent(`<!doctype html><html><head><style>
    *{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:grid;grid-template-columns:1fr 1fr}
    section{height:720px;padding:40px 48px;background:#edf1f6;color:#253b51}section.dark{background:#17222f;color:#dce7f3}
    header{display:flex;align-items:baseline;justify-content:space-between}h1{font-size:24px;font-weight:600;margin:0;letter-spacing:-.6px}
    header span{font-size:12px;letter-spacing:2px;opacity:.55}.hero{display:block;width:384px;height:384px;margin:18px auto 4px}
    .sizes{height:170px;display:flex;align-items:center;justify-content:space-between;gap:12px}figure{margin:0;text-align:center;min-width:48px}
    figure img{display:block;margin:auto}figcaption{font-size:11px;opacity:.55;margin-top:12px}
  </style></head><body>${['light','dark'].map(theme => `<section class="${theme}"><header><h1>Papilot</h1><span>macOS · ${theme.toUpperCase()}</span></header><img class="hero" src="${icon}"><div class="sizes">${samples}</div></section>`).join('')}</body></html>`);
  await page.evaluate(() => Promise.all([...document.images].map(img => img.decode())));
  await page.screenshot({ path: path.join(directory, 'preview.png') });
} finally {
  await browser.close();
}
execFileSync('/usr/bin/iconutil', ['--convert', 'icns', '--output', path.join(directory, 'Papilot.icns'), iconset]);
console.log('Rendered assets/macos/Papilot.png and Papilot.iconset; packaged Papilot.icns.');
