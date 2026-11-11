import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { ROOT, codeVersion } from "../runtime.ts";
import { Builder, BuildError, auxiliaryBuildError, buildDate, reprioritize, type BuildPriority } from "./build.ts";
import { diffUnitsAsync, scopeViolationsAsync, withHashesAsync, withUnits } from "./changes.ts";
import { provisional, roundFolder, writeProvisional } from "./carry.ts";
import { acceptNoteOption, noteOptionUnits } from "./note-options.ts";
import { isFigure } from "./config.ts";
import { REFS } from "./git.ts";
import { now, readJson, writeJson } from "./files.ts";
import { Cancelled, runAsync } from "./process.ts";
import { Lease } from "./pool.ts";
import type { App } from "../server.ts";
import type {
  BuildInfo,
  BuildProgress,
  DocumentEffect,
  Job,
  JobResult,
  PlaceView,
  RenderedRound,
  RenderRequest,
  Round,
  Unit,
} from "../types.ts";
export class PublishError extends Error {
  constructor(
    message: string,
    public details: string[] = [],
    public next = "",
    public log?: string,
  ) {
    super(message);
  }
}
const RANK: Record<BuildPriority, number> = { background: 0, normal: 1, foreground: 2 };
// Nothing for a build that failed to compile; a cancelled one stays cancelled.
const compileFailure = (error: unknown) => {
  if (error instanceof BuildError) return null;
  throw error;
};
/** The cached build of `rev` past its errors, when the cache holds none of it
 *  as it is: that text does not compile as it is, and is not tried again
 *  until the date or the TeX installation changes. */
async function knownBroken(builder: Builder, rev: string, targets: string[], seed: BuildInfo | null, date: ReturnType<typeof buildDate>) {
  if (await builder.cached(rev, targets, seed, { date })) return null;
  return builder.cached(rev, targets, seed, { date, pastErrors: true });
}
// Seconds for which a review page that asked for its state counts as open.
const VIEWING = 15;
// Each rendering step takes its own share of the TeX pool, so a comparison
// waiting for variant builds between steps never holds one meanwhile.
const rendering = new Set<Lease>();
/** Rereads the priority of every rendering step under way, after someone
 *  started or stopped waiting for one. */
export function reprioritizeRenders() {
  for (const lease of rendering) lease.update();
}
async function work(output: string, request: object, priority: () => BuildPriority = () => "normal", signal?: AbortSignal) {
  if (signal?.aborted) throw new Cancelled();
  // Its own name, as several requests may render into one round's folder.
  const file = path.join(
    output,
    `request-${randomBytes(4).toString("hex")}.json`,
  );
  writeJson(file, request);
  const lease = new Lease(priority), release = () => void lease.release();
  rendering.add(lease);
  signal?.addEventListener("abort", release, { once: true });
  try {
    await lease.ready;
    if (signal?.aborted) throw new Cancelled();
    await runAsync(
      process.execPath,
      ["--import", "tsx", path.join(ROOT, "src/render/worker.ts"), file],
      { cwd: ROOT, timeout: 1200000, signal, started: (child) => lease.attach(child) },
    );
  } catch (error) {
    if (error instanceof Cancelled || signal?.aborted) throw new Cancelled();
    throw new PublishError(
      "Rendering the PDF comparison failed.",
      [
        (error as Error).message,
        ...String((error as { stderr?: Buffer }).stderr ?? "")
          .trim()
          .split("\n")
          .slice(-12),
      ],
      "Fix the renderer error, then publish again.",
    );
  } finally {
    signal?.removeEventListener("abort", release);
    rendering.delete(lease);
    await lease.release();
    fs.rmSync(file, { force: true });
  }
}
// One sufficient combination of edits for each whole-document change.
// An edit that prints nothing of its own, such as a macro definition, is
// compiled alone onto the accepted text: the changes that build makes are
// exactly what accepting it makes. Changes outside every crop that those
// builds leave unexplained are found by halving the other edits: each half is
// compiled alone, and a change one half makes has its cause there. A change
// neither half makes keeps the whole group, as it does when a variant cannot
// be compared. Partial singleton effects remain available to a joint group.
// This is not an enumeration of all causes or a proof of minimality: another
// combination, including one crossing the split, can produce the same effect.
export async function attribute(
  units: Unit[],
  changes: { within: string[] }[],
  silent: string[],
  shown: (units: Unit[]) => Promise<boolean[] | null>,
) {
  const causes = changes.map(() => new Set<string>()),
    cache = new Map<string, Promise<boolean[] | null>>(),
    compiled = async (group: Unit[]) => {
      const key = JSON.stringify(group.map((u) => u.id));
      if (!cache.has(key))
        cache.set(
          key,
          shown(group).catch((error) => {
            if (error instanceof BuildError) return null;
            throw error;
          }),
        );
      return cache.get(key)!;
    };
  for (const id of silent) {
    const unit = units.find((u) => u.id === id)!,
      seen = await compiled([unit]);
    seen?.forEach((s, i) => s && causes[i].add(id));
  }
  const all = (group: Unit[], indices: number[]) =>
    indices.forEach((i) => group.forEach((u) => causes[i].add(u.id)));
  const split = async (group: Unit[], indices: number[]): Promise<void> => {
    if (!indices.length) return;
    if (group.length <= 1) return all(group, indices);
    const halves = [
        group.slice(0, Math.ceil(group.length / 2)),
        group.slice(Math.ceil(group.length / 2)),
      ],
      seen: boolean[][] = [];
    for (const half of halves) {
      const result = await compiled(half);
      if (!result) return all(group, indices);
      seen.push(result);
    }
    all(
      group,
      indices.filter((i) => !seen[0][i] && !seen[1][i]),
    );
    await split(
      halves[0],
      indices.filter((i) => seen[0][i]),
    );
    await split(
      halves[1],
      indices.filter((i) => seen[1][i]),
    );
  };
  await split(
    units,
    changes.map((_, i) => i),
  );
  const result: string[][] = [],
    full = units.map((u) => u.id);
  for (const [index, set] of causes.entries()) {
    const group = units.filter((u) => set.has(u.id));
    // Different sufficient combinations can cancel when combined. Verify
    // their union before presenting it; the full set is already witnessed
    // by the final PDF. A failed variant never becomes a causal assertion.
    const verified =
      group.length === units.length ||
      (group.length > 0 && (await compiled(group))?.[index]);
    result.push(verified ? group.map((u) => u.id) : full);
  }
  return result;
}
// Renders a comparison. `variant` compiles the accepted text with only some
// of the edits; without it, changes outside every crop list every edit.
export async function render(
  output: string,
  request: RenderRequest,
  variant?: (units: Unit[]) => Promise<BuildInfo>,
  priority: () => BuildPriority = () => "normal",
  signal?: AbortSignal,
) {
  await work(output, request, priority, signal);
  const file = path.join(output, "attribute.json");
  if (!fs.existsSync(file)) return;
  const { changes, silent, cards } = readJson<{
    changes: { effect: DocumentEffect; within: string[] }[];
    silent: string[];
    cards: RenderRequest["cards"];
  }>(file, { changes: [], silent: [], cards: undefined });
  fs.rmSync(file);
  const effects = changes.map((c) => c.effect),
    causes = variant
      ? await attribute(request.units, changes, silent, async (units) => {
          await work(output, {
            ...request,
            final: request.new,
            new: await variant(units),
            effects,
          }, priority, signal);
          const shown = path.join(output, "shown.json"),
            result = readJson<boolean[] | null>(shown, null);
          fs.rmSync(shown, { force: true });
          return result;
        })
      : changes.map((c) =>
          c.within.length ? [] : request.units.map((u) => u.id),
        );
  await work(output, { ...request, causes, cards }, priority, signal);
}
// A comparison depends only on what it renders: the two builds, the edits
// with their contents, and how it lists changes. It is the same whichever
// round asks for it, so one rendered ahead while the agent worked serves the
// round its turn then publishes.
export function renderKey(request: RenderRequest) {
  return createHash("sha256").update(JSON.stringify([codeVersion(), request.main, request.source_dir, request.figures, request.old.key, request.new.key, request.units, request.indirect ?? true])).digest("hex").slice(0, 32);
}
async function cloneTree(from: string, to: string) {
  await fs.promises.mkdir(to, { recursive: true });
  for (const entry of await fs.promises.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name), target = path.join(to, entry.name);
    if (entry.isDirectory()) await cloneTree(source, target);
    else await fs.promises.copyFile(source, target, fs.constants.COPYFILE_FICLONE);
  }
}
// The places of an edit past those rendered with its round.
export async function more(output: string, unit: string) {
  const file = path.join(output, `places-${unit}.json`);
  if (!fs.existsSync(file)) {
    const saved = readJson<{ old: BuildInfo; new: BuildInfo } | null>(
      path.join(output, "places.json"),
      null,
    );
    if (!saved) return [];
    if (![saved.old, saved.new].every((b) => fs.existsSync(b.pdf)))
      throw new PublishError(
        "The builds of this round were removed.",
        [],
        "Publish again to see every place.",
      );
    // The review page waits for these places.
    await work(output, { more: unit }, () => "foreground");
  }
  return readJson<PlaceView[]>(file, []);
}
export class Publisher {
  private pruning: Promise<void> | null = null;
  pending = new Map<string, string>();
  running = new Map<string, Promise<void>>();
  queue: string[] = [];
  stopping = false;
  // The new version of each running job whose round compiles only some of
  // its chapters: a host may compile the whole paper meanwhile, without
  // waiting for or competing with a build of the same files here.
  private revisions = new Map<string, string>();
  // Page updates are transient, like revisions; polling must not write SQLite
  // for every page of a long baseline or either parallel comparison build.
  private builds = new Map<string, Partial<Record<"baseline" | "revised", BuildProgress>>>();
  progress(id: string) { return this.builds.get(id); }
  /** A job compiles in the foreground while its review page is open. A job
   *  that a newer one of its task supersedes keeps that priority: the newer
   *  job starts only when it ends, and continues from its builds. */
  priority(job: Pick<Job, "task">): BuildPriority {
    return now() - (this.app.viewers.get(job.task) ?? 0) < VIEWING ? "foreground" : "normal";
  }
  /** Someone opened or still reads a task's review page. */
  attend() {
    reprioritize();
  }
  // What the author reads in each task's review page, as the page reports
  // it: its changes or the paper as decided so far.
  private looking = new Map<string, "changes" | "pdf">();
  /** The review page shows `mode` of the task. */
  look(task: string, mode: "changes" | "pdf") {
    this.looking.set(task, mode);
    this.app.viewers.set(task, now());
    reprioritize();
  }
  /** How much work for `mode` of a task matters to the author now: what is
   *  on screen comes first, the rest of an open task next, a task nobody
   *  reads last. */
  attention(task: string, mode: "changes" | "pdf"): BuildPriority {
    if (now() - (this.app.viewers.get(task) ?? 0) >= VIEWING) return "background";
    return (this.looking.get(task) ?? "changes") === mode ? "foreground" : "normal";
  }
  // Viewing ends without a request, so running builds are looked at again.
  private watching: NodeJS.Timeout | null = null;
  // Each task whose agent's writes are being followed: the run under way,
  // which the next write cancels, and the baseline it built.
  private following = new Map<string, AbortController>();
  private speculations = new Set<Promise<void>>();
  private guesses = new Map<string, string>();
  private verdicts = new Map<string, "hit" | "miss">();
  /** How much following a task's agent matters: more while the author has
   *  the task open, though less than what is on their screen. */
  private followPriority(name: string): BuildPriority {
    return this.attention(name, "changes") === "background" ? "background" : "normal";
  }
  /** A task's agent wrote files. Compiles and renders, at once, what the
   *  round its turn publishes will show for the worktree as it is now: the
   *  revised version first, the accepted one if it is not compiled yet, then
   *  the comparison. A newer write cancels this, as latexmk's live mode
   *  does, as soon as its own build waits; whatever this left compiled is
   *  where the next build continues. Answers at once. */
  prefetch(name: string) {
    this.app.tasks.get(name);
    if (this.stopping) return;
    const previous = this.following.get(name), stop = new AbortController();
    this.following.set(name, stop);
    const promise = this.follow(name, stop.signal, () => previous?.abort())
      // A guess that does not compile is no error: the round reports it.
      .catch(() => previous?.abort())
      .finally(() => { if (this.following.get(name) === stop) this.following.delete(name); });
    this.speculations.add(promise);
    void promise.finally(() => this.speculations.delete(promise));
  }
  /** The accepted text changed while the agent's writes were being
   *  followed: the round its turn publishes compares against the new one. */
  refollow(name: string) {
    if (this.following.has(name) || this.guesses.has(name)) this.prefetch(name);
  }
  private async follow(name: string, signal: AbortSignal, replace: () => void) {
    const app = this.app, task = app.tasks.get(name), project = app.project;
    if (!fs.existsSync(task.worktree)) return replace();
    // The files as the turn's end will leave them: rejects queued meanwhile
    // reverted.
    const after = await app.review.queuedTree(name, await app.tasks.snapshotAsync(task)), before = task.accepted,
      files = await app.repo.changedFilesAsync(before, after);
    if (!files.length || signal.aborted) return replace();
    const builder = new Builder(project, app.repo),
      priority = () => this.followPriority(name);
    const date = buildDate(), options = { date, signal, priority };
    let targets = await builder.planAsync(before, after, files), seed: BuildInfo | null = null;
    // A starting text that does not compile is compiled as the round's
    // publication will compile it (see renderComparison).
    if (targets[0] !== "full") {
      if (!(await knownBroken(builder, task.base, ["full"], null, date).catch(compileFailure)))
        seed = await builder.buildSeed(task.base, { priority }).catch(compileFailure);
      if (!seed) targets = ["full"];
    }
    if (signal.aborted || this.stopping) return replace();
    const [baseline, revised] = await Promise.allSettled([
      knownBroken(builder, before, targets, seed, date).then((known) => known ?? builder.build(before, targets, seed, options)),
      builder.build(after, targets, seed, { ...options, onKey: replace }),
    ]);
    if (revised.status === "rejected") throw revised.reason;
    if (baseline.status === "rejected" && !(baseline.reason instanceof BuildError && !signal.aborted)) throw baseline.reason;
    const next = revised.value,
      old = baseline.status === "fulfilled" ? baseline.value : await builder.build(before, targets, seed, { ...options, pastErrors: true });
    this.guesses.set(name, old.key);
    const indirect = this.tracking.get(name) ?? false;
    const units = await withHashesAsync(app.repo, before, after, await diffUnitsAsync(app.repo, before, after, (f) => isFigure(project, f)));
    if (signal.aborted) return;
    await this.renderCached(
      { main: project.main, source_dir: project.source_dir, figures: project.figures, old, new: next, units, indirect },
      indirect ? (subset, shared) => builder.build(withUnits(app.repo, before, after, subset), targets, seed, { ...options, ...shared }) : undefined,
      priority,
      signal,
    );
  }
  // Comparisons rendering now, by key, with how much each matters to whoever
  // waits for it.
  private renders = new Map<string, { done: Promise<string>; wanted: Set<() => BuildPriority>; stop: AbortController }>();
  /** The folder of a rendered comparison: one rendered before, the one under
   *  way, or a new one. A caller that cancels stops waiting; the rendering
   *  stops once nobody waits for it. */
  private async renderCached(request: RenderRequest, variant: ((units: Unit[], shared: { signal: AbortSignal; priority: () => BuildPriority }) => Promise<BuildInfo>) | undefined, priority: () => BuildPriority, signal?: AbortSignal): Promise<string> {
    const key = renderKey(request), folder = path.join(this.app.state, "cache/renders", key);
    if (fs.existsSync(path.join(folder, "round.json"))) {
      const time = new Date();
      await fs.promises.utimes(folder, time, time).catch(() => undefined);
      return folder;
    }
    if (signal?.aborted) throw new Cancelled();
    let entry = this.renders.get(key);
    if (!entry) {
      const wanted = new Set<() => BuildPriority>(), stop = new AbortController(),
        top = () => [...wanted].reduce<BuildPriority>((best, get) => (RANK[get()] > RANK[best] ? get() : best), "background"),
        output = folder + ".pending-" + randomBytes(4).toString("hex");
      const done = (async () => {
        await fs.promises.mkdir(output, { recursive: true });
        try {
          // Variants belong to this shared render, not the first caller: a
          // speculative caller may leave while a publication still needs it.
          await render(output, request, variant ? (units) => variant(units, { signal: stop.signal, priority: top }) : undefined, top, stop.signal);
          await fs.promises.rm(folder, { recursive: true, force: true });
          await fs.promises.rename(output, folder);
          return folder;
        } finally {
          await fs.promises.rm(output, { recursive: true, force: true });
        }
      })();
      const created = { done, wanted, stop };
      entry = created;
      this.renders.set(key, created);
      void done.catch(() => undefined).finally(() => { if (this.renders.get(key) === created) this.renders.delete(key); });
    }
    const shared = entry;
    shared.wanted.add(priority);
    reprioritizeRenders();
    let leave = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      leave = () => {
        shared.wanted.delete(priority);
        if (!shared.wanted.size) shared.stop.abort();
        else reprioritizeRenders();
        reject(new Cancelled());
      };
      signal?.addEventListener("abort", leave, { once: true });
    });
    cancelled.catch(() => undefined);
    try {
      return await (signal ? Promise.race([shared.done, cancelled]) : shared.done);
    } catch (error) {
      // A new caller can arrive while a cancelled render is stopping. Once
      // it has cleaned up, start again for the caller that still needs it.
      if (error instanceof Cancelled && !signal?.aborted) {
        if (this.renders.get(key) === shared) this.renders.delete(key);
        return this.renderCached(request, variant, priority, signal);
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", leave);
      shared.wanted.delete(priority);
    }
  }
  private async compile(job: Pick<Job, "id" | "task">, side: "baseline" | "revised", builder: Builder, rev: string, targets = ["full"], seed: BuildInfo | null = null, { asSeed = false, force = false, date, pastErrors = false }: { asSeed?: boolean; force?: boolean; date?: ReturnType<typeof buildDate>; pastErrors?: boolean } = {}) {
    const progress = this.builds.get(job.id) ?? {};
    this.builds.set(job.id, progress);
    progress[side] = { step: "tex", pass: 0, pages: 0, total: null };
    try {
      const options = { force, date, priority: () => this.priority(job), progress: (value: BuildProgress) => { progress[side] = value; } };
      const result = await (asSeed ? builder.buildSeed(rev, options) : builder.build(rev, targets, seed, { ...options, pastErrors }));
      const guess = this.guesses.get(job.task);
      if (side === "baseline" && !asSeed && guess) this.verdicts.set(job.id, guess === result.key ? "hit" : "miss");
      return result;
    } finally {
      delete progress[side];
      if (!Object.keys(progress).length) this.builds.delete(job.id);
    }
  }
  // Whether each job lists indirect changes, and each task's latest choice:
  // a request that does not say, such as an inline source edit or the CLI
  // without --indirect, keeps the task's choice.
  private indirect = new Map<string, boolean>();
  private tracking = new Map<string, boolean>();
  constructor(public app: App) {
    // A job whose round is inserted renders it after the restart (`recover`).
    app.store.execute(
      `UPDATE jobs SET status='failed', finished=?, result=? WHERE status IN ('queued','running')
        AND id NOT IN (SELECT json_extract(summary,'$.job') FROM rounds AS r WHERE visuals='pending'
          AND json_extract(summary,'$.job') IS NOT NULL AND number=(SELECT MAX(number) FROM rounds WHERE task=r.task))`,
      now(),
      JSON.stringify({
        error: "The review server restarted during the build.",
        next: "Publish again.",
      }),
    );
  }
  submit(name: string, requestId?: string, indirect?: boolean) {
    this.app.tasks.get(name);
    if (indirect !== undefined) this.tracking.set(name, indirect);
    const job = this.app.store.transaction(() => this.enqueue(name, requestId));
    if (job.status === "queued" && (indirect !== undefined || !this.indirect.has(job.id)))
      this.indirect.set(job.id, this.tracking.get(name) ?? false);
    return job;
  }
  private enqueue(name: string, requestId?: string) {
    if (requestId) {
      const existing = this.app.store.one<Job>("SELECT jobs.* FROM jobs JOIN build_requests ON jobs.id=build_requests.job WHERE build_requests.id=?", requestId);
      if (existing) {
        if (existing.task !== name) throw new Error("This build request belongs to another task.");
        return existing;
      }
    }
    const remember = (job: Job) => {
      if (requestId) this.app.store.execute("INSERT INTO build_requests(id,task,job) VALUES(?,?,?)", requestId, name, job.id);
      return job;
    };
    if (this.stopping)
      throw new Error(
        "The review server is stopping. Publish again after it restarts.",
      );
    const current = this.pending.get(name);
    if (current) {
      const job = this.job(current);
      if (job.status === "queued") return remember(job);
    }
    const id = randomBytes(8).toString("hex");
    this.app.store.execute(
      "INSERT INTO jobs(id,task,status,created) VALUES(?,?,'queued',?)",
      id,
      name,
      now(),
    );
    this.pending.set(name, id);
    if (!this.running.has(name)) this.queue.push(id);
    queueMicrotask(() => this.drain());
    return remember(this.job(id));
  }
  job(id: string) {
    const job = this.app.store.one<Job>("SELECT * FROM jobs WHERE id=?", id);
    if (!job) throw new Error("Unknown job " + id);
    return job;
  }
  revision(id: string) {
    return this.revisions.get(id) ?? null;
  }
  current(name: string) {
    return this.app.store.one<Job>(
      "SELECT * FROM jobs WHERE task=? ORDER BY created DESC,rowid DESC LIMIT 1",
      name,
    );
  }
  busy(name?: string) {
    return name ? this.pending.has(name) : this.pending.size > 0;
  }
  ahead(job: Job) {
    return this.app.store.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running') AND created<?",
      job.created,
    )!.n;
  }
  update(
    id: string,
    fields: Partial<Pick<Job, "phase" | "status" | "finished">> & {
      result?: JobResult;
    },
  ) {
    const entries = Object.entries(fields);
    this.app.store.execute(
      "UPDATE jobs SET " +
        entries.map(([key]) => key + "=?").join(",") +
        " WHERE id=?",
      ...entries.map(([key, value]) =>
        key === "result" ? JSON.stringify(value) : (value as string | number),
      ),
      id,
    );
  }
  stop() {
    this.stopping = true;
    for (const run of this.following.values()) run.abort();
  }
  private phase(job: Pick<Job, "id">, phase: string) {
    if (this.stopping) throw new Error("Server stopped during publication.");
    this.update(job.id, { phase });
  }
  async join() {
    await Promise.resolve();
    while (this.running.size || this.pruning || this.speculations.size)
      await Promise.allSettled([
        ...this.running.values(),
        ...this.speculations,
        ...(this.pruning ? [this.pruning] : []),
      ]);
  }
  private drain() {
    if (this.pruning) return;
    while (
      !this.stopping &&
      this.queue.length &&
      this.running.size < this.app.project.build_workers
    ) {
      const job = this.next();
      this.update(job.id, { status: "running" });
      const promise = Promise.resolve().then(() => this.work(job));
      this.running.set(job.task, promise);
    }
    if (this.running.size && !this.watching) {
      this.watching = setInterval(() => reprioritize(), 5000);
      this.watching.unref();
    } else if (!this.running.size && this.watching) {
      clearInterval(this.watching);
      this.watching = null;
    }
  }
  // The queued job whose review page was looked at most recently, and of
  // those the oldest: the author waits for what they read.
  private next() {
    const jobs = this.queue.map((id) => this.job(id)),
      viewed = (job: Job) => this.app.viewers.get(job.task) ?? 0;
    let best = 0;
    for (let i = 1; i < jobs.length; i++) if (viewed(jobs[i]) > viewed(jobs[best])) best = i;
    this.queue.splice(best, 1);
    return jobs[best];
  }
  private async work(job: Job) {
    try {
      const result = await this.publish(job);
      // A newer round replaced this one before its PDF was ready: the note
      // option's checkmark waits for the author to review that round.
      if (!result.superseded) await acceptNoteOption(this.app, job.task, job.id);
      const verdict = this.verdicts.get(job.id);
      this.update(job.id, { status: "done", result: verdict ? { ...result, prefetch: verdict } : result, finished: now() });
    } catch (error) {
      // A build the server stopped stays unfinished: the next server marks it
      // as interrupted by a restart, and the app builds it again.
      if (this.stopping) return;
      const result: JobResult =
        error instanceof PublishError
          ? {
              error: error.message,
              details: error.details,
              next: error.next,
              ...(error.log ? { log: error.log } : {}),
            }
          : { error: (error as Error).message, next: "Publish again." };
      this.update(job.id, { status: "failed", result, finished: now() });
    } finally {
      this.revisions.delete(job.id);
      this.builds.delete(job.id);
      this.indirect.delete(job.id);
      // A guess serves the round after the writes it saw, once.
      if (this.verdicts.delete(job.id)) this.guesses.delete(job.task);
      this.running.delete(job.task);
      if (this.pending.get(job.task) === job.id) this.pending.delete(job.task);
      else if (!this.stopping) this.queue.push(this.pending.get(job.task)!);
      this.drain();
      if (!this.pending.size && !this.stopping) await this.pruneCache();
    }
  }
  /** Publishes the task's worktree: inserts its round, then renders the
   *  round's PDF comparison. */
  async publish(job: Pick<Job, "id" | "task">): Promise<JobResult> {
    const app = this.app,
      name = job.task;
    if (app.reconciliation.get(name)?.ready === false) throw new Error("Retry applying to finish preparing the merge review.");
    this.phase(job, "snapshot");
    // The agent's turn has ended: rejects made meanwhile are reverted first,
    // so the round compares the files as the author decided.
    const inserted = await app.exclusive(async () => {
      await app.review.applyQueued(name);
      return this.insertNow(job);
    });
    return "result" in inserted ? inserted.result : this.renderRound(job, inserted.round);
  }
  /** Inserts a round for the worktree as it is now, with its comparison
   *  pending. The caller holds the engine's write turn: the worktree, the
   *  accepted text and the latest round are read together with the insert, so
   *  a decision either comes before the round, or applies to it. */
  async insertNow(job: Pick<Job, "id" | "task">): Promise<{ result: JobResult } | { round: Round }> {
    const app = this.app,
      name = job.task,
      project = app.project;
    const task = app.tasks.get(name);
    if (!fs.existsSync(task.worktree))
      throw new PublishError(
        `The task worktree ${task.worktree} no longer exists.`,
        [],
        "Run `finish --force`, then start a new task.",
      );
    const after = await app.tasks.snapshotAsync(task),
      before = app.tasks.get(name).accepted,
      latest = app.review.latestRound(name);
    const violations = await scopeViolationsAsync(app.repo, task.base, after, task.scope);
    const reconciliation = app.reconciliation.get(name);
    if (reconciliation) {
      for (const file of await app.repo.changedFilesAsync(task.base, after))
        if (!reconciliation.files.includes(file) && !violations.includes(file)) violations.push(file);
    }
    if (violations.length)
      throw new PublishError(
        "Some edits are outside the task scope: " +
          violations.slice(0, 10).join(", "),
        [
          "Allowed: " +
            (reconciliation ? reconciliation.files : task.scope.sections.length
              ? task.scope.sections.map((s) => `${s.number} ${s.title}`)
              : task.scope.paths
            ).join(", "),
        ],
        "Undo edits outside the scope, then publish again.",
      );
    // A round from before the choice existed listed indirect changes.
    const indirect = this.indirect.get(job.id) ?? this.tracking.get(name) ?? false;
    if (
      latest &&
      latest.before === before &&
      (await app.repo.treeIdAsync(latest.after)) === (await app.repo.treeIdAsync(after)) &&
      latest.summary.renderer === codeVersion() &&
      (latest.summary.indirect ?? true) === indirect
    )
      // A round whose render failed or was interrupted renders again.
      return (latest.visuals ?? "ready") === "ready"
        ? { result: { outcome: "unchanged", round: latest.number, changes: latest.units.length } }
        : { round: latest };
    const files = await app.repo.changedFilesAsync(before, after);
    const optionUnits = await noteOptionUnits(app, name, job.id, before, after);
    const number = (latest?.number ?? 0) + 1,
      final = roundFolder(app, name, number);
    const insert = async (units: Unit[], summary: Round["summary"], visuals: Round["visuals"]) => {
      // The ref comes first: a round in the store always keeps its version
      // across Git's garbage collection.
      await app.repo.updateRefAsync(`${REFS}${name}/round-${number}`, after);
      app.store.execute(
        "INSERT INTO rounds(task,number,before,after,units,summary,created,visuals) VALUES(?,?,?,?,?,?,?,?)",
        name,
        number,
        before,
        after,
        JSON.stringify(units),
        JSON.stringify(summary),
        now(),
        visuals!,
      );
      return app.review.round(name, number);
    };
    if (!files.length && !optionUnits) {
      // A manual correction can remove the final proposal altogether. Give
      // it an empty latest round so the viewer cannot keep offering the old
      // wording for acceptance after it has disappeared from the worktree.
      if (latest && app.store.one("SELECT id FROM build_requests WHERE job=? AND id LIKE 'source-%'", job.id)) {
        await fs.promises.rm(final, { recursive: true, force: true });
        await insert([], { renderer: codeVersion(), indirect, warnings: [], targets: ["full"], builds: [], job: job.id }, "ready");
        return { result: { outcome: "empty", round: number, changes: 0 } };
      }
      return { result: { outcome: "empty", round: null, changes: 0 } };
    }
    const units = await withHashesAsync(app.repo, before, after, optionUnits ?? await diffUnitsAsync(app.repo, before, after, (f) =>
      isFigure(project, f),
    ));
    const targets = await new Builder(project, app.repo).planAsync(before, after, files),
      shown = await provisional(app, name, latest, { before, after, units }),
      pending = final + ".pending-" + randomBytes(4).toString("hex");
    try {
      await writeProvisional(pending, shown);
      await fs.promises.rm(final, { recursive: true, force: true });
      await fs.promises.rename(pending, final);
    } finally {
      await fs.promises.rm(pending, { recursive: true, force: true });
    }
    const round = await insert(units, { renderer: codeVersion(), indirect, warnings: [], targets, date: buildDate(), builds: [], job: job.id }, "pending");
    return { round };
  }
  /** Inserts the worktree's round now when an earlier build of the task is
   *  still running, so a source edit need not wait for it. The caller holds
   *  the engine's write turn. Problems are reported when the job runs. */
  async insertBehind(job: Pick<Job, "id" | "task" | "status">) {
    if (job.status !== "queued" || !this.running.has(job.task)) return;
    try {
      await this.insertNow(job);
    } catch {
      /* The job inserts again when it starts, and fails with the reason. */
    }
  }
  private roundSuperseded(round: Round) {
    return this.app.review.latestRound(round.task)?.number !== round.number;
  }
  /** Compiles and renders a round's PDF comparison and attaches it to that
   *  round. Running it again for the same round is safe. */
  private async renderRound(job: Pick<Job, "id" | "task">, round: Round): Promise<JobResult> {
    try {
      return await this.renderComparison(job, round);
    } catch (error) {
      // A build the server stopped renders again after the restart.
      if (!this.stopping) await this.app.exclusive(() => this.renderFailed(round)).catch((problem) => console.error("Marking a failed comparison:", problem));
      throw error;
    }
  }
  private async renderComparison(job: Pick<Job, "id" | "task">, round: Round): Promise<JobResult> {
    const app = this.app,
      name = job.task,
      project = app.project,
      { before, after, units } = round,
      superseded = { outcome: "published" as const, round: round.number, changes: units.length, superseded: true };
    // A newer round needs its own render; this one would only be replaced.
    if (this.roundSuperseded(round)) return superseded;
    this.phase(job, "build");
    const builder = new Builder(project, app.repo),
      date = round.summary.date ?? buildDate(new Date(round.created * 1000)),
      indirect = round.summary.indirect ?? true;
    let targets = round.summary.targets?.length ? round.summary.targets : ["full"];
    if (targets[0] !== "full") this.revisions.set(job.id, after);
    const failed = (what: string) => (error: unknown) => {
      if (error instanceof BuildError)
        throw new PublishError(
          what,
          error.details,
          "Check the compiler diagnostics, fix the document or build environment, then publish again.",
          error.log,
        );
      throw error;
    };
    const base = app.tasks.get(name).base;
    let seed: BuildInfo | null = null;
    if (targets[0] !== "full") {
      // Chapters cannot continue from a task's starting text that does not
      // compile, which an earlier build past its errors may already show:
      // both versions compile whole instead (see below).
      if (!(await knownBroken(builder, base, ["full"], null, date).catch(compileFailure)))
        seed = await this.compile(job, "baseline", builder, base, ["full"], null, { asSeed: true }).catch(compileFailure);
      if (!seed) {
        targets = ["full"];
        this.revisions.delete(job.id);
      }
    }
    // Both versions compile at once: each needs only the seed.
    const versions = async () => {
      const known = await knownBroken(builder, before, targets, seed, date).catch(compileFailure);
      return Promise.allSettled([
        known ?? this.compile(job, "baseline", builder, before, targets, seed, { date }),
        this.compile(job, "revised", builder, after, targets, seed, { date }),
      ]);
    };
    let builds: PromiseSettledResult<BuildInfo>[] = await versions();
    if (!this.stopping && seed && builds.some((built) => built.status === "rejected" && auxiliaryBuildError(built.reason))) {
      // An external package can invalidate readable aux files without
      // changing the source tree or engine version. Rebuild the seed once,
      // after both attempts finish, then use it for both comparison sides.
      seed = await this.compile(job, "baseline", builder, base, ["full"], null, { asSeed: true, force: true }).catch(failed("The comparison baseline could not be compiled."));
      builds = await versions();
    }
    // A task that fixes a compilation error starts from text that does not
    // compile. Its side of the comparison is what TeX typesets past the
    // errors; the revised version must still compile as it is.
    if (!this.stopping && builds[0].status === "rejected" && builds[0].reason instanceof BuildError && builds[1].status === "fulfilled") {
      const past = await this.compile(job, "baseline", builder, before, targets, seed, { date, pastErrors: true }).catch(compileFailure);
      if (past) builds = [{ status: "fulfilled", value: past }, builds[1]];
    }
    // A failure of either is reported once both have settled, the baseline's first.
    const [baseline, revised] = builds,
      old = baseline.status === "fulfilled" ? baseline.value : failed("The comparison baseline could not be compiled.")(baseline.reason),
      next = revised.status === "fulfilled" ? revised.value : failed("The revised document could not be compiled.")(revised.reason);
    if (this.roundSuperseded(round)) return superseded;
    const warnings = next.warnings.filter((w) => !old.warnings.includes(w));
    this.phase(job, "render");
    const final = roundFolder(app, name, round.number),
      output = final + ".pending-" + randomBytes(4).toString("hex");
    fs.mkdirSync(output, { recursive: true });
    const summary = {
      ...round.summary,
      warnings,
      targets,
      date,
      builds: [seed, old, next].filter((b) => b !== null).map((b) => b.key),
      baselineErrors: old.errors,
    };
    try {
      // The comparison the agent's writes were rendered into ahead, when it
      // shows exactly these builds and edits; otherwise it renders now.
      const rendered = await this.renderCached(
        {
          main: project.main,
          source_dir: project.source_dir,
          figures: project.figures,
          old,
          new: next,
          units,
          indirect,
        },
        // Only a round that lists indirect changes compiles variants to
        // find the edits behind them.
        indirect
          ? (subset, shared) =>
              builder.build(
                withUnits(app.repo, before, after, subset),
                targets,
                seed,
                { date, ...shared },
              )
          : undefined,
        () => this.priority(job),
      );
      await cloneTree(rendered, output);
      // Decisions go on meanwhile; they never change a round's versions.
      await app.exclusive(async () => {
        await fs.promises.mkdir(final, { recursive: true });
        // The page may still show the carried strips: keep them until it
        // reloads, and replace round.json last.
        for (const file of await fs.promises.readdir(output))
          if (file !== "round.json") await fs.promises.rename(path.join(output, file), path.join(final, file));
        await fs.promises.rename(path.join(output, "round.json"), path.join(final, "round.json"));
        app.store.execute(
          "UPDATE rounds SET visuals='ready', summary=? WHERE task=? AND number=?",
          JSON.stringify(summary),
          name,
          round.number,
        );
      });
    } finally {
      fs.rmSync(output, { recursive: true, force: true });
    }
    const visual = readJson<RenderedRound>(path.join(final, "round.json"), {
        units: {},
        sections: [],
        loose: [],
      }),
      kinds: Record<string, number> = {};
    for (const unit of Object.values(visual.units))
      kinds[unit.visual] = (kinds[unit.visual] ?? 0) + 1;
    return {
      outcome: "published",
      round: round.number,
      changes: units.length,
      kinds,
      warnings,
    };
  }
  // Without its own comparison, each change that exactly matches one of the
  // previous round shows that round's comparison, labelled with its round,
  // rather than none: the old version is better than no version. The rest
  // cannot be decided until a later round renders.
  private async renderFailed(round: Round) {
    const app = this.app,
      current = app.review.round(round.task, round.number);
    if ((current.visuals ?? "ready") !== "pending") return;
    if (!this.roundSuperseded(round) && round.number > 1) {
      const previous = app.review.round(round.task, round.number - 1);
      await writeProvisional(roundFolder(app, round.task, round.number), await provisional(app, round.task, previous, round, true));
    }
    app.store.execute("UPDATE rounds SET visuals='failed' WHERE task=? AND number=?", round.task, round.number);
  }
  /** At start, after interrupted writes are finished: renders each task's
   *  latest round whose comparison a restart interrupted, and restores round
   *  refs a restart between a round's ref and its insert left behind. */
  async recover() {
    const app = this.app;
    for (const task of app.tasks.list()) {
      const rounds = app.store.all<Pick<Round, "number" | "after">>("SELECT number,after FROM rounds WHERE task=?", task.name),
        refs = new Map(
          (await app.repo.textAsync(["for-each-ref", "--format=%(refname) %(objectname)", `${REFS}${task.name}/`]))
            .split("\n")
            .filter(Boolean)
            .map((line) => line.split(" ") as [string, string]),
        );
      for (const round of rounds) {
        const ref = `${REFS}${task.name}/round-${round.number}`;
        if (refs.get(ref) !== round.after) await app.repo.updateRefAsync(ref, round.after);
      }
      const latest = app.review.latestRound(task.name);
      // An undo that inserts a round stopped before the insert: its accept
      // is undone, so the round with the change pending again follows now.
      const undone = app.store.one<{ status: string; detail: { republish?: number } }>("SELECT status,detail FROM actions WHERE task=? ORDER BY seq DESC LIMIT 1", task.name);
      if (undone?.status === "undone" && undone.detail.republish && (latest?.number ?? 0) < undone.detail.republish) {
        if (!this.pending.has(task.name) && !this.stopping) this.submit(task.name, undefined, latest?.summary.indirect ?? true);
        continue;
      }
      if (!latest || latest.visuals !== "pending" || this.stopping) continue;
      // The job that inserted it continues, so a host polling it sees the
      // round it is waiting for. It lists indirect changes as the round
      // does, so it renders that round rather than inserting another.
      const job = latest.summary.job ? app.store.one<Job>("SELECT * FROM jobs WHERE id=? AND status IN ('queued','running')", latest.summary.job) : null,
        indirect = latest.summary.indirect ?? true;
      if (job && !this.pending.has(task.name)) {
        this.update(job.id, { status: "queued" });
        this.indirect.set(job.id, indirect);
        this.pending.set(task.name, job.id);
        this.queue.push(job.id);
        queueMicrotask(() => this.drain());
      } else if (!this.pending.has(task.name)) this.submit(task.name, undefined, indirect);
    }
  }
  // Comparisons rendered ahead and not used for three days, and folders a
  // rendering stopped by a restart left after an hour.
  private async pruneRenders(maxAge = 3 * 86400) {
    const root = path.join(this.app.state, "cache/renders");
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(root, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const folder = path.join(root, entry.name), pending = entry.name.includes(".pending-");
      if (!entry.isDirectory() || (!pending && this.renders.has(entry.name))) continue;
      const stat = await fs.promises.stat(folder).catch(() => null);
      if (stat && now() - stat.mtimeMs / 1000 > (pending ? 3600 : maxAge)) await fs.promises.rm(folder, { recursive: true, force: true });
    }
  }
  async pruneCache() {
    if (this.pruning) return this.pruning;
    if (this.busy()) return;
    const keep = new Set(
      this.app.store
        .all<Pick<Round, "summary">>(
          "SELECT summary FROM rounds JOIN tasks ON rounds.task=tasks.name WHERE tasks.closed IS NULL",
        )
        .flatMap((r) => r.summary.builds ?? []),
    );
    this.pruning = Promise.all([new Builder(this.app.project, this.app.repo).prune(keep), this.pruneRenders()]).then(() => undefined);
    try {
      await this.pruning;
    } catch (error) {
      console.error("Build cache cleanup:", error);
    } finally {
      this.pruning = null;
      this.drain();
    }
  }
}
