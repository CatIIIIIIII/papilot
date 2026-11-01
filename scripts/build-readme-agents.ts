// Regenerate with: node --import tsx scripts/build-readme-agents.ts
// Use the Settings catalog and original brand artwork for a quiet README logo panel.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_IDS, AGENT_NAMES } from '../src/shared.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'docs/assets/readme-agents');
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const names = AGENT_IDS.map(id => AGENT_NAMES[id]).join(', ');
fs.mkdirSync(output, { recursive: true });

for (const compact of [false, true]) {
  const columns = compact ? 3 : 6;
  const cellWidth = compact ? 116 : 136;
  const rowHeight = 60;
  const width = columns * cellWidth;
  const height = Math.ceil(AGENT_IDS.length / columns) * rowHeight;
  for (const dark of [false, true]) {
    const ink = dark ? '#cbd5e1' : '#334155';
    const marks = AGENT_IDS.map((id, index) => {
      const source = fs.readFileSync(path.join(root, `src/web/brand-icons/${id}.svg`), 'utf8');
      const viewBox = source.match(/viewBox="([^"]+)"/)?.[1];
      if (!viewBox) throw new Error(`Missing viewBox: ${id}`);
      const artwork = source.replace(/^<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title>.*?<\/title>/, '');
      const row = Math.floor(index / columns);
      const count = Math.min(columns, AGENT_IDS.length - row * columns);
      const x = (width - count * cellWidth) / 2 + (index % columns) * cellWidth + (compact ? 2 : 10);
      const y = row * rowHeight;
      return `  <g transform="translate(${x} ${y})">
    <svg x="0" y="17" width="26" height="26" viewBox="${viewBox}" fill="${ink}" color="${ink}" fill-rule="evenodd">${artwork}</svg>
    <text x="36" y="35" fill="${ink}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif" font-size="14" font-weight="500">${escape(AGENT_NAMES[id])}</text>
  </g>`;
    }).join('\n');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title">
  <title id="title">${escape(names)}</title>
  <!-- Original brand paths from src/web/brand-icons; see SOURCES.txt. -->
${marks}
</svg>
`;
    fs.writeFileSync(path.join(output, `${compact ? 'compact' : 'desktop'}${dark ? '-dark' : ''}.svg`), svg);
  }
}

// A single panel has regular spacing. The compact version keeps names legible on phones.
const panel = `<!-- BEGIN AGENT ICONS -->
<p align="center">
  <a href="docs/guide.md#agents">
    <picture>
      <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="docs/assets/readme-agents/compact-dark.svg">
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme-agents/desktop-dark.svg">
      <source media="(max-width: 600px)" srcset="docs/assets/readme-agents/compact.svg">
      <img src="docs/assets/readme-agents/desktop.svg" alt="${names}" width="816">
    </picture>
  </a>
</p>
<!-- END AGENT ICONS -->`;
for (const file of ['README.md', 'README.zh-CN.md']) {
  const target = path.join(root, file);
  const markdown = fs.readFileSync(target, 'utf8');
  const updated = markdown.replace(/<!-- BEGIN AGENT ICONS -->[\s\S]*?<!-- END AGENT ICONS -->/, panel);
  if (updated !== markdown) fs.writeFileSync(target, updated);
}
