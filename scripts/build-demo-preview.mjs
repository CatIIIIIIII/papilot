// Optional when changing the example; macOS release runners do not need TeX.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { gunzipSync, gzipSync } from 'node:zlib';
const source = fileURLToPath(new URL('../examples/papilot-paper', import.meta.url));
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-example-')));
try {
  fs.cpSync(source, temp, { recursive: true, filter: file => path.basename(file) !== 'preview' });
  execFileSync('latexmk', ['-pdf', '-synctex=1', '-interaction=nonstopmode', '-halt-on-error', 'main.tex'], { cwd: temp, stdio: 'inherit' });
  const preview = path.join(source, 'preview');
  fs.mkdirSync(preview, { recursive: true });
  fs.copyFileSync(path.join(temp, 'main.pdf'), path.join(preview, 'main.pdf'));
  const sync = gunzipSync(fs.readFileSync(path.join(temp, 'main.synctex.gz'))).toString();
  // Relative source inputs also need to resolve from the installed paper,
  // not from the user's current working directory or this build machine.
  const portable = sync.replace(/^Input:(\d+):(.+)$/gm, (line, id, file) => {
    const full = path.resolve(temp, file);
    return full.startsWith(temp + path.sep) ? `Input:${id}:@PAPILOT_EXAMPLE@/${path.relative(temp, full)}` : line;
  });
  fs.writeFileSync(path.join(preview, 'main.synctex.gz'), gzipSync(portable));
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
