import fs from 'node:fs';
import path from 'node:path';

export function copyExamplePaper(source: string, destination: string, options: { excludePreview?: boolean } = {}) {
  fs.cpSync(source, destination, { recursive: true, filter: file => !options.excludePreview || path.basename(file) !== 'preview' });
  // Packaged sources can be read-only, notably in the Nix store. The user's
  // copy must be editable; leave the bundled files and symlink targets alone.
  const writable = (file: string) => fs.chmodSync(file, fs.statSync(file).mode | 0o200);
  writable(destination);
  for (const entry of fs.readdirSync(destination, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() || entry.isDirectory()) writable(path.join(entry.parentPath, entry.name));
  }
}
