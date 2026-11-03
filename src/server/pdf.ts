import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENGINE } from './paths.ts';
import { taskRoute } from './review.ts';

type Connect = (root: string) => Promise<{ get<T>(route: string): Promise<T> }>;

type Priority = 'foreground' | 'normal' | 'background';
const RANK: Record<Priority, number> = { background: 0, normal: 1, foreground: 2 };

// The complete PDF of one version of a paper, for the review's full paper. A
// round may compile only the changed chapters; this compiles them all, once.
// It can start before anyone asks, as soon as a round's new version exists;
// whoever then waits for it has it compile first and sees each TeX pass.
interface Paper {
  priority: Priority;
  following: boolean;
  // The passes shown so far, by number, while the PDF compiled.
  passes: Map<number, string>;
  pdf: string | null;
  failure: Error | null;
  done: Promise<void>;
  changed: Set<() => void>;
}
const papers = new Map<string, Paper>();
// Compiled papers are remembered for the passes they showed, a few at a time.
const REMEMBERED = 32;

async function builder(root: string) {
  const [{ Builder }, { Repo }, { loadProject }] = await Promise.all([
    import(pathToFileURL(path.join(ENGINE, 'src/core/build.ts')).href),
    import(pathToFileURL(path.join(ENGINE, 'src/core/git.ts')).href),
    import(pathToFileURL(path.join(ENGINE, 'src/core/config.ts')).href),
  ]);
  return new Builder(loadProject(root), new Repo(root));
}

const notFound = () => Object.assign(new Error('Review resource not found.'), { statusCode: 404 });
const changed = (paper: Paper) => { for (const notify of [...paper.changed]) notify(); };

/** Starts compiling the complete PDF of `revision`, or has the build already
 *  under way run at `priority` and, with `follow`, show its passes. */
export function preparePaper(root: string, revision: string, priority: Priority = 'normal', follow = false): Paper {
  const key = JSON.stringify([root, revision]);
  let paper = papers.get(key);
  const compile = (target: Paper, wanted: Priority, watch: boolean) => builder(root).then(b => b.build(revision, ['full'], null, {
    priority: wanted,
    ...(watch ? {
      pass: (preview: { pass: number; pdf: string }) => {
        if (target.pdf || target.passes.has(preview.pass)) return;
        target.passes.set(preview.pass, preview.pdf);
        changed(target);
      },
    } : {}),
  })) as Promise<{ pdf: string }>;
  if (paper) {
    papers.delete(key);
    papers.set(key, paper);
    if (!paper.pdf && !paper.failure && (RANK[priority] > RANK[paper.priority] || (follow && !paper.following))) {
      if (RANK[priority] > RANK[paper.priority]) paper.priority = priority;
      paper.following ||= follow;
      void compile(paper, paper.priority, follow).catch(() => undefined);
    }
    return paper;
  }
  const created: Paper = { priority, following: follow, passes: new Map(), pdf: null, failure: null, done: Promise.resolve(), changed: new Set() };
  created.done = compile(created, priority, follow).then(
    result => { created.pdf = result.pdf; },
    error => {
      created.failure = error instanceof Error ? error : new Error(String(error));
      // A later request compiles it again.
      if (papers.get(key) === created) papers.delete(key);
    },
  ).finally(() => changed(created));
  papers.set(key, created);
  for (const old of papers.keys()) {
    if (papers.size <= REMEMBERED) break;
    if (papers.get(old)!.pdf) papers.delete(old);
  }
  return created;
}

// A round does not change; what the full paper needs of it is looked up once.
interface RoundInfo { before: string; after: string; build?: { key: string; targets: string[] } }
const rounds = new Map<string, Promise<RoundInfo>>();
function roundInfo(connect: Connect, root: string, name: string, round: number) {
  const key = JSON.stringify([root, name, round]);
  let found = rounds.get(key);
  if (!found) {
    found = connect(root)
      .then(client => client.get<RoundInfo>(`${taskRoute(name)}/rounds/${round}`))
      .then(detail => {
        if (typeof detail?.before !== 'string' || typeof detail.after !== 'string') throw notFound();
        return { before: detail.before, after: detail.after, ...(detail.build ? { build: detail.build } : {}) };
      });
    rounds.set(key, found);
    found.catch(() => rounds.delete(key));
    if (rounds.size > 256) rounds.delete(rounds.keys().next().value!);
  }
  return found;
}

// The round's own PDF when it compiled only the changed chapters: their pages
// with the changes, exactly where its strips come from, at once.
async function chaptersPdf(root: string, info: RoundInfo) {
  if (!info.build || !/^[0-9a-f]{32}$/.test(info.build.key) || JSON.stringify(info.build.targets) === '["full"]') return null;
  const { loadProject } = await import(pathToFileURL(path.join(ENGINE, 'src/core/config.ts')).href);
  try {
    const result = JSON.parse(await fs.promises.readFile(path.join(loadProject(root).state, 'cache/builds', info.build.key, 'result.json'), 'utf8')) as { pdf?: unknown };
    if (typeof result.pdf !== 'string') return null;
    await fs.promises.access(result.pdf);
    return result.pdf;
  } catch { return null; }
}

async function ready(root: string, revision: string, follow = false) {
  for (let attempt = 0; ; attempt++) {
    const paper = preparePaper(root, revision, 'foreground', follow);
    await paper.done;
    if (paper.failure) throw paper.failure;
    // The build cache may have removed an old PDF meanwhile.
    if (attempt || await fs.promises.access(paper.pdf!).then(() => true, () => false)) return paper.pdf!;
    papers.delete(JSON.stringify([root, revision]));
  }
}

/** The complete PDF of a round's version, once it has compiled. */
export async function fullPaperPdf(connect: Connect, root: string, name: string, round: number, side: 'before' | 'after'): Promise<string> {
  return ready(root, (await roundInfo(connect, root, name, round))[side]);
}

/** What the review's full paper shows next, after version `after`: a later
 *  version, `null` once the complete PDF is ready, or nothing when `wait`
 *  ends first. Until then it shows the round's changed chapters (version 1
 *  when the round compiled only those), then each TeX pass of the whole. */
export async function nextPaperPass(connect: Connect, root: string, name: string, round: number, after: number, wait = 20000): Promise<{ pass?: number | null }> {
  const info = await roundInfo(connect, root, name, round), chapters = await chaptersPdf(root, info), offset = chapters ? 1 : 0;
  if (chapters && after < 1) {
    // A complete PDF that is already there, or nearly, comes first.
    const paper = preparePaper(root, info.after, 'foreground', true);
    await Promise.race([paper.done, new Promise(resolve => setTimeout(resolve, 300))]);
    if (paper.pdf) return { pass: null };
    return { pass: 1 };
  }
  const next = await nextPass(root, info.after, Math.max(0, after - offset), wait);
  return typeof next.pass === 'number' ? { pass: next.pass + offset } : next;
}
export async function nextPass(root: string, revision: string, after: number, wait = 20000): Promise<{ pass?: number | null }> {
  const paper = preparePaper(root, revision, 'foreground', true);
  const deadline = Date.now() + wait;
  for (;;) {
    if (paper.failure) throw paper.failure;
    if (paper.pdf) return { pass: null };
    const newest = Math.max(0, ...paper.passes.keys());
    if (newest > after) return { pass: newest };
    const left = deadline - Date.now();
    if (left <= 0) return {};
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); paper.changed.delete(done); resolve(); };
      const timer = setTimeout(done, left);
      paper.changed.add(done);
    });
  }
}

/** The PDF of a version that `nextPaperPass` named. */
export async function paperPassPdf(connect: Connect, root: string, name: string, round: number, pass: number) {
  const info = await roundInfo(connect, root, name, round), chapters = await chaptersPdf(root, info);
  if (chapters && pass === 1) return chapters;
  return passPdf(root, info.after, pass - (chapters ? 1 : 0));
}
export function passPdf(root: string, revision: string, pass: number) {
  const pdf = papers.get(JSON.stringify([root, revision]))?.passes.get(pass);
  if (!pdf) throw notFound();
  return pdf;
}

/** The complete PDF of `revision`, once it has compiled. */
export const paperPdf = ready;
