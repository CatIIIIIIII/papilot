import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ROOT, codeVersion } from "../runtime.ts";
import { Builder, BuildError, auxiliaryBuildError, buildDate } from "./build.ts";
import { diffUnitsAsync, scopeViolationsAsync, withUnits } from "./changes.ts";
import { acceptNoteOption, noteOptionUnits } from "./note-options.ts";
import { isFigure } from "./config.ts";
import { now, readJson, writeJson } from "./files.ts";
import { runAsync } from "./process.ts";
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
class Stale extends Error {}
async function work(output: string, request: object) {
  // Its own name, as several requests may render into one round's folder.
  const file = path.join(
    output,
    `request-${randomBytes(4).toString("hex")}.json`,
  );
  writeJson(file, request);
  try {
    await runAsync(
      process.execPath,
      ["--import", "tsx", path.join(ROOT, "src/render/worker.ts"), file],
      { cwd: ROOT, timeout: 1200000 },
    );
  } catch (error) {
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
) {
  await work(output, request);
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
          });
          const shown = path.join(output, "shown.json"),
            result = readJson<boolean[] | null>(shown, null);
          fs.rmSync(shown, { force: true });
          return result;
        })
      : changes.map((c) =>
          c.within.length ? [] : request.units.map((u) => u.id),
        );
  await work(output, { ...request, causes, cards });
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
    await work(output, { more: unit });
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
  private async compile(job: Pick<Job, "id">, side: "baseline" | "revised", builder: Builder, rev: string, targets = ["full"], seed: BuildInfo | null = null, { asSeed = false, force = false, date }: { asSeed?: boolean; force?: boolean; date?: ReturnType<typeof buildDate> } = {}) {
    const progress = this.builds.get(job.id) ?? {};
    this.builds.set(job.id, progress);
    progress[side] = { step: "tex", pass: 0, pages: 0, total: null };
    try {
      const options = { force, date, progress: (value: BuildProgress) => { progress[side] = value; } };
      return await (asSeed ? builder.buildSeed(rev, options) : builder.build(rev, targets, seed, options));
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
    app.store.execute(
      "UPDATE jobs SET status='failed', finished=?, result=? WHERE status IN ('queued','running')",
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
  }
  private phase(job: Pick<Job, "id">, phase: string) {
    if (this.stopping) throw new Error("Server stopped during publication.");
    this.update(job.id, { phase });
  }
  async join() {
    await Promise.resolve();
    while (this.running.size || this.pruning)
      await Promise.allSettled([
        ...this.running.values(),
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
      const id = this.queue.shift()!,
        job = this.job(id);
      this.update(id, { status: "running" });
      const promise = Promise.resolve().then(() => this.work(job));
      this.running.set(job.task, promise);
    }
  }
  private async work(job: Job) {
    try {
      let result: JobResult;
      for (;;) {
        try {
          result = await this.publish(job);
          break;
        } catch (error) {
          if (!(error instanceof Stale)) throw error;
          if (this.stopping)
            throw new Error("Server stopped during publication.");
        }
      }
      await acceptNoteOption(this.app, job.task, job.id);
      this.update(job.id, { status: "done", result, finished: now() });
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
      this.running.delete(job.task);
      if (this.pending.get(job.task) === job.id) this.pending.delete(job.task);
      else if (!this.stopping) this.queue.push(this.pending.get(job.task)!);
      this.drain();
      if (!this.pending.size && !this.stopping) await this.pruneCache();
    }
  }
  async publish(job: Pick<Job, "id" | "task">): Promise<JobResult> {
    const app = this.app,
      name = job.task,
      project = app.project;
    if (app.reconciliation.get(name)?.ready === false) throw new Error("Retry applying to finish preparing the merge review.");
    let task = app.tasks.get(name);
    if (!fs.existsSync(task.worktree))
      throw new PublishError(
        `The task worktree ${task.worktree} no longer exists.`,
        [],
        "Run `finish --force`, then start a new task.",
      );
    this.phase(job, "snapshot");
    // The worktree and the decisions are read together, between writes.
    const { after, before, latest, decided } = await app.exclusive(async () => {
      const after = await app.tasks.snapshotAsync(task);
      task = app.tasks.get(name);
      return { after, before: task.accepted, latest: app.review.latestRound(name), decided: app.review.lastChange(name) };
    });
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
      return {
        outcome: "unchanged",
        round: latest.number,
        changes: latest.units.length,
      };
    const files = await app.repo.changedFilesAsync(before, after);
    const optionUnits = await noteOptionUnits(app, name, job.id, before, after);
    if (!files.length && !optionUnits) {
      // A manual correction can remove the final proposal altogether. Give
      // it an empty latest round so the viewer cannot keep offering the old
      // wording for acceptance after it has disappeared from the worktree.
      if (latest && app.store.one("SELECT id FROM build_requests WHERE job=? AND id LIKE 'source-%'", job.id)) {
        this.phase(job, "build");
        const built = await this.compile(job, "baseline", new Builder(project, app.repo), before), number = latest.number + 1;
        await app.exclusive(async () => {
          if (app.review.lastChange(name) !== decided) throw new Stale();
          app.store.execute("INSERT INTO rounds(task,number,before,after,units,summary,created) VALUES(?,?,?,?,?,?,?)", name, number, before, after, "[]", JSON.stringify({ renderer: codeVersion(), indirect, warnings: [], targets: ["full"], builds: [built.key] }), now());
          await app.repo.updateRefAsync(`refs/latex-review/${name}/round-${number}`, after);
        });
        return { outcome: "empty", round: number, changes: 0 };
      }
      return { outcome: "empty", round: null, changes: 0 };
    }
    const units = optionUnits ?? await diffUnitsAsync(app.repo, before, after, (f) =>
      isFigure(project, f),
    );
    this.phase(job, "build");
    const builder = new Builder(project, app.repo),
      date = buildDate(),
      targets = await builder.planAsync(before, after, files);
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
    let seed = targets[0] !== "full" ? await this.compile(job, "baseline", builder, task.base, ["full"], null, { asSeed: true }).catch(failed("The comparison baseline could not be compiled.")) : null;
    // Both versions compile at once: each needs only the seed.
    const versions = () => Promise.allSettled([
      this.compile(job, "baseline", builder, before, targets, seed, { date }),
      this.compile(job, "revised", builder, after, targets, seed, { date }),
    ]);
    let builds = await versions();
    if (!this.stopping && seed && builds.some((built) => built.status === "rejected" && auxiliaryBuildError(built.reason))) {
      // An external package can invalidate readable aux files without
      // changing the source tree or engine version. Rebuild the seed once,
      // after both attempts finish, then use it for both comparison sides.
      seed = await this.compile(job, "baseline", builder, task.base, ["full"], null, { asSeed: true, force: true }).catch(failed("The comparison baseline could not be compiled."));
      builds = await versions();
    }
    // A failure of either is reported once both have settled, the baseline's first.
    const [baseline, revised] = builds,
      old = baseline.status === "fulfilled" ? baseline.value : failed("The comparison baseline could not be compiled.")(baseline.reason),
      next = revised.status === "fulfilled" ? revised.value : failed("The revised document could not be compiled.")(revised.reason);
    if (app.review.lastChange(name) !== decided) throw new Stale();
    const warnings = next.warnings.filter((w) => !old.warnings.includes(w));
    this.phase(job, "render");
    const number = (latest?.number ?? 0) + 1,
      rounds = path.join(app.state, "rounds", name),
      final = path.join(rounds, String(number).padStart(3, "0")),
      output = final + ".pending-" + randomBytes(4).toString("hex");
    fs.mkdirSync(output, { recursive: true });
    const summary = {
      renderer: codeVersion(),
      indirect,
      warnings,
      targets,
      date,
      builds: [seed, old, next].filter((b) => b !== null).map((b) => b.key),
    };
    try {
      await render(
        output,
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
          ? (subset) =>
              builder.build(
                withUnits(app.repo, before, after, subset),
                targets,
                seed,
                { date },
              )
          : undefined,
      );
      // No decision may come between this check and the new round.
      await app.exclusive(async () => {
        if (app.review.lastChange(name) !== decided) throw new Stale();
        await fs.promises.rm(final, { recursive: true, force: true });
        await fs.promises.rename(output, final);
        app.store.execute(
          "INSERT INTO rounds(task,number,before,after,units,summary,created) VALUES(?,?,?,?,?,?,?)",
          name,
          number,
          before,
          after,
          JSON.stringify(units),
          JSON.stringify(summary),
          now(),
        );
        await app.repo.updateRefAsync(`refs/latex-review/${name}/round-${number}`, after);
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
      round: number,
      changes: units.length,
      kinds,
      warnings,
    };
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
    this.pruning = new Builder(this.app.project, this.app.repo).prune(keep);
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
