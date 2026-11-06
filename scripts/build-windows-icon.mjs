// Builds desktop/assets/icon.ico from the checked-in iconset PNGs. Windows
// needs one .ico file; each size is stored as a PNG-compressed entry, which
// every supported Windows version reads. Run from the repository root.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const iconset = path.join(root, 'desktop/assets/icon.iconset');
const output = path.join(root, 'desktop/assets/icon.ico');
// The .ico directory entry stores dimensions in one byte, so 256 is the largest
// size it can name. The iconset provides 16, 32, 64, 128 and 256; the 64 px
// image is the checked-in 32 px Retina export.
const sizes = [16, 32, 64, 128, 256];
const sources = { 16: 'icon_16x16.png', 32: 'icon_32x32.png', 64: 'icon_32x32@2x.png', 128: 'icon_128x128.png', 256: 'icon_256x256.png' };

export function buildWindowsIcon(directory = iconset, file = output) {
  const images = sizes.map(size => {
    const source = path.join(directory, sources[size]);
    const png = fs.readFileSync(source);
    // A PNG-compressed entry keeps 32 bits per pixel and the PNG's own alpha.
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size === 256 ? 0 : size, 0);
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    return { entry, png };
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length + images.reduce((total, image) => total + image.entry.length, 0);
  for (const image of images) {
    image.entry.writeUInt32LE(offset, 12);
    offset += image.png.length;
  }
  // The directory comes first, then every image's PNG data.
  fs.writeFileSync(file, Buffer.concat([header, ...images.map(image => image.entry), ...images.map(image => image.png)]));
  return file;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = buildWindowsIcon();
  console.log(`Built ${built} (${(fs.statSync(built).size / 1024).toFixed(1)} KB).`);
}
