// Times what an author waits for after committing a reviewed task, end to
// end: a deferred task inserts a paragraph, its round is published, every
// change is accepted, and the task is committed to the manuscript. Reports
// when the manuscript's PDF was ready after the commit, its TeX passes, and
// how long each server's event loop was held up meanwhile.
//
//   node --import tsx scripts/profile-commit.ts PAPER FILE LINE [--review S] [--think S] [--text TEXT]
//
// It commits to PAPER's repository, so give it a copy of a paper, never the
// original. Run it from an older checkout to compare versions: a version
// without predictions simply waits after the commit.
import fs from 'node:fs';
import path from 'node:path';
import { connect } from '../engine/src/client.ts';
import { Manuscripts } from '../src/server/manuscript.ts';

const [paper, file, lineText, ...rest] = process.argv.slice(2);
const option = (name: string, fallback: string) => { const at = rest.indexOf(name); return at >= 0 ? rest[at + 1] : fallback; };
if (!paper || !file || !/^\d+$/.test(lineText || '')) throw new Error('Expected PAPER FILE LINE: a copy of a paper, a TeX file in it and the line to insert a paragraph at.');
const root = fs.realpathSync(paper), review = Number(option('--review', '30')), think = Number(option('--think', '15'));
const text = option('--text', 'This paragraph was added to measure how long the manuscript takes to show a committed task. It is long enough to move the text that follows it, so that page numbers, references and the table of contents may change as they would after a real revision of the argument in this section.');
const sleep = (seconds: number) => new Promise(resolve => setTimeout(resolve, seconds * 1000));
const client = await connect(root, true), id = `profile-${Date.now().toString(36)}`;
const marks: Record<string, number> = {}, mark = (name: string) => { marks[name] = Date.now(); console.error(new Date().toISOString().slice(11, 19), name); };

// The engine's event loop: how long it takes to answer while it works.
const answers: [number, number][] = [];
let pinging = true;
const pinger = (async () => {
  while (pinging) {
    const begin = performance.now();
    await fetch(client.url + '/api/info', { signal: AbortSignal.timeout(60000) }).then(response => response.arrayBuffer()).catch(() => undefined);
    answers.push([Date.now(), Math.round(performance.now() - begin)]);
    await sleep(0.05);
  }
})();
const slowest = (from: number, to: number) => Math.max(0, ...answers.filter(([at]) => at >= from && at <= to).map(([, ms]) => ms));
// This process's event loop stands in for Papilot's, which runs the same
// manuscript code: the longest gap between ticks of a 2 ms timer.
// (monitorEventLoopDelay misses long synchronous stretches.)
const lag = (() => {
  let last = performance.now(), max = 0;
  setInterval(() => { const now = performance.now(); max = Math.max(max, now - last); last = now; }, 2).unref();
  return { get max() { return max; }, reset() { max = 0; last = performance.now(); } };
})();

const manuscripts = new Manuscripts() as Manuscripts & { refresh?: Manuscripts['refresh']; predict?: Manuscripts['predict'] };
async function ready(since: number) {
  for (;;) {
    const { build } = await manuscripts.state('paper', root);
    if (build.status === 'failed') throw new Error(build.error);
    if (build.status === 'ready' && build.current && (build.builtAt ?? 0) >= since) return build;
    await sleep(1.5);
  }
}
mark('warm'); await ready(0); mark('warm-done');

const task = await client.post<{ name: string; worktree: string }>('/api/tasks', { name: id, title: 'Profile ' + id, deferred: true });
const target = path.join(task.worktree, file), lines = fs.readFileSync(target, 'utf8').split('\n');
lines.splice(Number(lineText), 0, '', text, '');
fs.writeFileSync(target, lines.join('\n'));
lag.reset(); mark('publish');
const { job } = await client.post<{ job: string }>(`/api/tasks/${id}/publish`, {});
for (;;) {
  const current = await client.get<{ status: string; error?: string }>(`/api/jobs/${job}`);
  if (current.status === 'done') break;
  if (current.status === 'failed') throw new Error('The round failed to build: ' + JSON.stringify(current));
  await sleep(1);
}
mark('published');
const publishLag = lag.max;
// Papilot compiles what committing the task will write as soon as the round is ready.
if (manuscripts.predict) {
  const preview = await client.get<{ files: Record<string, string | null> | null }>(`/api/tasks/${id}/preview`);
  if (preview.files) void manuscripts.predict('paper', root, Object.fromEntries(Object.entries(preview.files).map(([name, data]) => [name, data === null ? null : Buffer.from(data, 'base64')])));
}
await sleep(review);
const state = await client.get<{ round: number; decisions: Record<string, string> }>(`/api/tasks/${id}/state`);
await client.post(`/api/tasks/${id}/decide`, { action: 'accept', changes: Object.keys(state.decisions).filter(unit => state.decisions[unit] === 'pending'), round: state.round });
mark('accepted');
await sleep(think);
lag.reset(); mark('commit');
await client.post(`/api/tasks/${id}/apply`, { mode: 'commit', message: `Profile commit ${id}` });
mark('committed');
void manuscripts.refresh?.('paper', root);
await ready(marks.commit);
mark('pdf');
const commitLag = lag.max;
pinging = false; await pinger;

const cache = path.join(root, '.git/latex-review/cache/builds');
const newest = fs.readdirSync(cache).filter(name => /^[0-9a-f]{32}$/.test(name) && fs.existsSync(path.join(cache, name, 'result.json')))
  .map(name => ({ name, at: fs.statSync(path.join(cache, name, 'result.json')).mtimeMs, result: JSON.parse(fs.readFileSync(path.join(cache, name, 'result.json'), 'utf8')) }))
  .filter(build => build.result.targets[0] === 'full').sort((a, b) => b.at - a.at)[0];
const passes = (fs.readFileSync(path.join(cache, newest.name, 'latexmk.log'), 'utf8').match(/^Running '(?:xe|pdf|lua)latex/gm) || []).length;
console.log(JSON.stringify({
  task: id, review, think,
  publishSeconds: (marks.published - marks.publish) / 1000,
  commitToPdfSeconds: (marks.pdf - marks.commit) / 1000,
  manuscriptBuild: { key: newest.name, seconds: newest.result.seconds, texPasses: passes },
  slowestEventLoopMs: { papilot: { publish: Math.round(publishLag), commitToPdf: Math.round(commitLag) }, engine: { publish: slowest(marks.publish, marks.published), commitToPdf: slowest(marks.commit, marks.pdf) } },
}));
process.exit(0);
