// Regenerate the committed browser fixtures using the real compiler and diff
// renderer. Runtime and website builds only serve the resulting static assets.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { App } from '../engine/src/server.ts';
import { PdfDocument, union } from '../engine/src/render/pdf.ts';
import type { BuildInfo, Rect } from '../engine/src/types.ts';

const source = path.resolve(import.meta.dirname, '../examples/playground-paper');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-playground-example-')));
const output = path.join(temp, 'preview');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const plans = JSON.parse(fs.readFileSync(path.join(source, 'edits.json'), 'utf8')) as { id: string; title: string; edits: { old: string; new: string }[] }[];
const original = fs.readFileSync(path.join(source, 'main.tex'), 'utf8');
let app: App | undefined;
try {
  // Reuse the project's own brand artwork and product illustrations.
  // Only fixture regeneration needs librsvg; website builds serve the PDFs.
  const assets = path.join(temp, 'assets');
  fs.mkdirSync(assets);
  const brand = path.resolve(source, '../../docs/assets');
  execFileSync('rsvg-convert', ['--format', 'pdf', '--output', path.join(assets, 'wordmark.pdf'), path.join(brand, 'wordmark.svg')]);
  // Typeset the shared artwork's labels in the document's own font. Keeping
  // them in TeX avoids platform font substitution during SVG conversion.
  const agents = fs.readFileSync(path.join(brand, 'readme-agents/desktop.svg'), 'utf8');
  const dimensions = agents.match(/viewBox="0 0 (\d+) (\d+)"/);
  const labels = [...agents.matchAll(/<g transform="translate\(([\d.]+) ([\d.]+)\)">[\s\S]*?<text x="([\d.]+)" y="([\d.]+)"[^>]*>([^<]+)<\/text>/g)];
  if (!dimensions || labels.length !== (agents.match(/<text\b/g) || []).length) throw new Error('Cannot read agent artwork labels.');
  const [, width, height] = dimensions;
  execFileSync('rsvg-convert', ['--format', 'pdf', '--output', path.join(assets, 'agents.pdf')], {
    input: agents.replaceAll(/<text\b[^>]*>[\s\S]*?<\/text>/g, ''),
  });
  const tex = (text: string) => text.replace(/[\\&%$#_{}~^]/g, character => {
    if (character === '\\') return '\\textbackslash{}';
    if (character === '~') return '\\textasciitilde{}';
    if (character === '^') return '\\textasciicircum{}';
    return '\\' + character;
  });
  fs.writeFileSync(path.join(assets, 'agents.tex'), [
    '\\setlength{\\unitlength}{1bp}',
    `\\begin{picture}(${width},${height})`,
    `\\put(0,0){\\includegraphics[width=${width}bp,height=${height}bp]{assets/agents.pdf}}`,
    ...labels.map(([, x, y, dx, dy, label]) => `\\put(${Number(x) + Number(dx)},${Number(height) - Number(y) - Number(dy)}){\\makebox(0,0)[lb]{\\fontsize{14}{17}\\selectfont\\color{ink}${tex(label)}}}`),
    '\\end{picture}',
  ].join('%\n') + '%\n');
  for (const [input, output] of [['readme-showcase/hero.png', 'review.png'], ['readme-showcase/notes-app.png', 'notes.png']]) {
    fs.copyFileSync(path.join(brand, input), path.join(assets, output));
  }
  fs.writeFileSync(path.join(temp, 'main.tex'), original);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: temp, stdio: 'pipe' });
  git('init', '-q'); git('add', '.');
  fs.mkdirSync(path.join(temp, '.git/papilot'), { recursive: true });
  fs.writeFileSync(path.join(temp, '.git/papilot/settings.json'), JSON.stringify({ main: 'main.tex', partial_builds: false }));
  git('-c', 'user.name=Playground', '-c', 'user.email=playground@localhost', 'commit', '-qm', 'Example baseline');
  app = new App(temp); await app.ready;
  fs.mkdirSync(output, { recursive: true });
  for (const plan of plans) {
    const task = app.tasks.create(plan.id, plan.title, [], ['main.tex']);
    let revised = original;
    for (const edit of plan.edits) {
      if (!revised.includes(edit.old)) throw new Error(`Missing source for ${plan.id}: ${edit.old}`);
      revised = revised.replace(edit.old, edit.new);
    }
    fs.writeFileSync(path.join(task.worktree, 'main.tex'), revised);
    console.log(`Rendering ${plan.id}…`);
    const job = app.publisher.submit(task.name);
    const deadline = Date.now() + 240000;
    while (!['done', 'failed'].includes(app.publisher.job(job.id).status)) {
      if (Date.now() > deadline) throw new Error('Example rendering timed out.');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const result = app.publisher.job(job.id);
    if (result.status !== 'done') throw new Error(JSON.stringify(result.result));
    const detail = app.review.roundDetail(task.name, 1);
    // A crop split at a heading can leave an empty fragment in the next
    // section. Keep every real PDF/source change, but don't show an extra
    // source-only card for a unit whose PDF is already displayed elsewhere.
    const blocks = [...detail.sections.flatMap(section => section.blocks), ...detail.loose];
    const visible = new Set(blocks.flatMap(block => block.kind === 'change' && (block.before.length || block.after.length) ? block.units : []));
    const keep = (block: typeof blocks[number]) => block.kind !== 'change' || block.before.length || block.after.length || !block.units.every(id => visible.has(id));
    detail.sections = detail.sections.map(section => ({ ...section, blocks: section.blocks.filter(keep) })).filter(section => section.blocks.some(block => block.kind === 'change'));
    detail.loose = detail.loose.filter(keep);
    const target = path.join(output, plan.id);
    fs.mkdirSync(target, { recursive: true });
    const roundFolder = path.join(app.state, 'rounds', task.name, '001');
    for (const name of fs.readdirSync(roundFolder)) if (/\.(png|webp|svg)$/.test(name)) fs.copyFileSync(path.join(roundFolder, name), path.join(target, name));
    detail.files = `/demo/fixtures/${plan.id}/`;
    detail.pdf = `/demo/fixtures/${plan.id}/revised.pdf`;
    detail.before = hash(original); detail.after = hash(revised);
    delete detail.build;
    fs.writeFileSync(path.join(target, 'round.json'), JSON.stringify(detail));
    const round = app.review.round(task.name, 1);
    const readBuild = (key: string) => JSON.parse(fs.readFileSync(path.join(app!.state, 'cache/builds', key, 'result.json'), 'utf8')) as BuildInfo;
    const revisedPdf = readBuild(round.summary.builds.at(-1)!).pdf;
    const document = new PdfDocument(revisedPdf);
    try { if (document.length !== 2) throw new Error(`${plan.id} must fit on two pages, got ${document.length}.`); }
    finally { document.close(); }
    fs.copyFileSync(revisedPdf, path.join(target, 'revised.pdf'));
    if (plan === plans[0]) fs.copyFileSync(readBuild(round.summary.builds[0]).pdf, path.join(output, 'main.pdf'));
    console.log(`${plan.id}: ${detail.units.length} changes, ${detail.sections.length} sections`);
  }
  // Anchor notes to actual printed words, rather than hand-maintained pixels.
  const pdf = new PdfDocument(path.join(output, 'main.pdf'));
  try {
    if (pdf.length !== 2) throw new Error('The product tour must fit on two pages.');
    const anchors: { id: string; text: string; comment: string; group?: string; kind?: string; stamp?: string; after?: string; occurrence?: number; symbol?: boolean }[] = [
      { id: 'note-opening', text: 'one workspace.', comment: 'Make the opening a workflow: mark the PDF, let the agent edit the LaTeX, then review the typeset change.', group: 'yellow' },
      { id: 'note-claim', text: 'The author decides.', comment: 'Make this philosophy actionable: accept, reject, or request another pass.', group: 'purple' },
      { id: 'note-filler', text: 'of course,', comment: '', kind: 'delete' },
      { id: 'note-quick', text: 'At any time,', comment: 'Start with the action: “Inspect the LaTeX behind any edit.”', stamp: 'trim' },
      { id: 'note-equation', text: 'W', symbol: true, after: 'Its normalized coordinates are', occurrence: 1, comment: 'This assumes a zero origin. Use explicit page bounds and subtract the origin before normalizing, so cropped pages work too.', group: 'green' },
      { id: 'note-table', text: 'zero', comment: 'Show a nonzero page origin, such as (20,40), and shift the selection equally. The normalized box should stay the same.', kind: 'point' },
      { id: 'note-ending', text: 'your own project', comment: 'Use Download Papilot to run this workflow on a real project. Notes and the prepared reviews work here in the static demo.', group: 'orange' },
    ];
    const notes = anchors.map(anchor => {
      for (let page = 0; page < pdf.length; page++) {
        const current = pdf.page(page), words = current.words;
        const find = (text: string, start = 0) => {
          const tokens = text.split(' ');
          return words.flatMap((_, index) => index >= start && tokens.every((part, offset) => words[index + offset]?.text === part) ? [index] : []);
        };
        const context = anchor.after ? find(anchor.after) : [0];
        if (!context.length) continue;
        const start = anchor.after ? context[0] + anchor.after.split(' ').length : 0;
        const matches = anchor.symbol
          ? words.flatMap((word, index) => index >= start && word.text.normalize('NFKC').replace(/[,.]$/, '') === anchor.text ? [index] : [])
          : find(anchor.text, start);
        if (!matches.length) continue;
        if (!anchor.occurrence && matches.length !== 1) throw new Error(`Ambiguous note: ${anchor.text}`);
        const at = matches[(anchor.occurrence || 1) - 1];
        if (at === undefined) continue;
        // Keep only the matched words. Separate rectangles preserve precise
        // highlighting if a short phrase wraps, without selecting its neighbors.
        const selected = anchor.symbol
          ? current.lines.flatMap(line => line.chars).filter(char => char.text.normalize('NFKC') === anchor.text && char.rect[0] >= words[at].rect[0] && char.rect[2] <= words[at].rect[2] && char.rect[1] >= words[at].rect[1] && char.rect[3] <= words[at].rect[3])
          : words.slice(at, at + anchor.text.split(' ').length);
        if (!selected.length) throw new Error(`Cannot locate selected glyph: ${anchor.text}`);
        const lines: Rect[] = [];
        for (const word of selected) {
          const last = lines.at(-1);
          if (last && Math.abs(last[1] - word.rect[1]) < 2) lines[lines.length - 1] = union(last, word.rect);
          else lines.push([...word.rect]);
        }
        const [x0, y0, x1, y1] = current.bounds;
        const normalize = (box: Rect): Rect => [(box[0]-x0)/(x1-x0), (box[1]-y0)/(y1-y0), (box[2]-x0)/(x1-x0), (box[3]-y0)/(y1-y0)];
        const rect = normalize(lines.reduce(union));
        const { text: _, after: _after, occurrence: _occurrence, symbol: _symbol, ...note } = anchor;
        const point: Rect = [rect[2] + 0.015, (rect[1] + rect[3]) / 2, rect[2] + 0.015, (rect[1] + rect[3]) / 2];
        return { ...note, page, rect: anchor.kind === 'point' ? point : rect, ...(anchor.kind === 'point' ? {} : { rects: lines.map(normalize) }), quote: selected.map(w => w.text).join(' ') };
      }
      throw new Error(`Cannot locate note: ${anchor.text}`);
    });
    fs.writeFileSync(path.join(output, 'notes.json'), JSON.stringify(notes, null, 2) + '\n');
    console.log(`Example: ${pdf.length} pages, ${notes.length} anchored notes.`);
  } finally { pdf.close(); }
  const destination = path.join(source, 'preview');
  fs.writeFileSync(path.join(output, 'rounds.json'), JSON.stringify(Object.fromEntries(plans.map(plan => [plan.id, JSON.parse(fs.readFileSync(path.join(output, plan.id, 'round.json'), 'utf8'))]))));
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(output, destination, { recursive: true });
  const gitFixturePath = path.join(source, 'git.json');
  const gitFixture = JSON.parse(fs.readFileSync(gitFixturePath, 'utf8'));
  gitFixture.working['main.tex'] = original;
  fs.writeFileSync(gitFixturePath, JSON.stringify(gitFixture, null, 2) + '\n');
} finally { await app?.close(); fs.rmSync(temp, { recursive: true, force: true }); }
