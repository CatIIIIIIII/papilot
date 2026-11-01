// Optional asset-authoring command; release builds use the checked-in PNGs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-dmg-fonts-'));
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
try {
  const config = path.join(temp, 'fonts.conf');
  fs.writeFileSync(config, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><include ignore_missing="yes">/opt/homebrew/etc/fonts/fonts.conf</include><include ignore_missing="yes">/usr/local/etc/fonts/fonts.conf</include><dir>${xml(path.join(root, 'src/web/fonts'))}</dir><cachedir>${xml(temp)}</cachedir></fontconfig>`);
  for (const scale of [1, 2]) execFileSync('rsvg-convert', ['-w', String(640 * scale), '-h', String(400 * scale),
    path.join(root, 'desktop/assets/dmg-background.svg'), '-o', path.join(root, `desktop/assets/dmg-background${scale === 2 ? '@2x' : ''}.png`)], { env: { ...process.env, FONTCONFIG_FILE: config }, stdio: 'inherit' });
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
