import fs from 'node:fs';
import path from 'node:path';

// Node's JavaScript realpath implementation retains Windows input casing and
// short names. Git may return a different spelling of that same directory.
// Ask Windows for the actual path; do not fold case on case-sensitive folders.
export function realPath(value: string): string {
  return process.platform === 'win32' ? fs.realpathSync.native(value) : fs.realpathSync(value);
}

// Historical worktrees can have been removed. Resolve their existing parent
// so drive letters, short names and junctions still identify the same location,
// while preserving the spelling of the missing tail (which has no identity).
export function pathIdentity(value: string): string {
  const absolute = path.resolve(value), tail: string[] = [];
  let current = absolute;
  for (;;) {
    try { return path.join(realPath(current), ...tail); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) return absolute;
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      tail.unshift(path.basename(current)); current = parent;
    }
  }
}
