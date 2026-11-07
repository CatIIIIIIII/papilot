import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import * as mupdf from 'mupdf';

// Serve the committed, pre-rendered example and real diff strips. Website
// builds require neither TeX nor an application server.
export function playgroundAssets(): Plugin {
  const directory = fileURLToPath(new URL('../examples/playground-paper/preview/', import.meta.url));
  const file = path.join(directory, 'main.pdf');
  const assets = new Map<string, Buffer>();
  for (const name of fs.readdirSync(directory, { recursive: true }) as string[]) {
    const entry = path.join(directory, name);
    if (fs.statSync(entry).isFile() && /\.(pdf|svg|png|webp)$/.test(name)) assets.set(name === 'main.pdf' ? 'example.pdf' : 'fixtures/' + name.split(path.sep).join('/'), fs.readFileSync(entry));
  }
  const source = fs.readFileSync(file);
  const document = mupdf.Document.openDocument(source, 'application/pdf');
  const pages: [number, number][] = [];
  try {
    for (let index = 0; index < document.countPages(); index++) {
      const page = document.loadPage(index);
      try { const [x0, y0, x1, y1] = page.getBounds(); pages.push([x1 - x0, y1 - y0]); }
      finally { page.destroy(); }
    }
  } finally { document.destroy(); }
  const metadata = { key: crypto.createHash('sha256').update(source).digest('hex'), pages };
  return {
    name: 'playground-paper',
    resolveId(id) { if (id === 'virtual:playground-paper') return '\0playground-paper'; },
    load(id) { if (id === '\0playground-paper') return `export default ${JSON.stringify(metadata)}`; },
    generateBundle() { for (const [fileName, source] of assets) this.emitFile({ type: 'asset', fileName, source }); },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url?.split('?')[0] || '';
        const name = url.startsWith(server.config.base) ? url.slice(server.config.base.length) : url.slice(1);
        const asset = assets.get(name);
        if (!asset) return next();
        const mime: Record<string, string> = { '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };
        response.setHeader('Content-Type', mime[path.extname(name)]); response.end(asset);
      });
    },
  };
}
