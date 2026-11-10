import fs from "node:fs";
import path from "node:path";
import { Builder, BuildError, buildDate, type BuildPriority } from "./build.ts";
import { Cancelled } from "./process.ts";
import { now, readJson, writeJsonAsync } from "./files.ts";
import type { App } from "../server.ts";
import type { BuildInfo, Round } from "../types.ts";

// The paper as the author has decided so far: a deferred task's accepted text,
// with every accepted change and none rejected or undecided, compiled for the
// chapters its latest round compiles, with that round's seed and date. Before
// the first decision of a round it is that round's own baseline build.

/** A completed compilation of a task's accepted text. */
export interface AppliedBuild {
  accepted: string;
  key: string;
  targets: string[];
  round: number;
  at: number;
}
export interface AppliedState {
  /** The task's accepted text now. */
  accepted: string;
  /** What to show: the build of the accepted text, or until it is ready the
   *  latest earlier one. `current` says which. */
  shown: (AppliedBuild & { current: boolean }) | null;
  /** A compilation of the accepted text is under way. */
  building: boolean;
  /** The accepted text did not compile; `shown` is the latest that did. */
  error?: { message: string; details: string[]; log?: string };
}
interface Run { accepted: string; stop: AbortController; done: Promise<void> }

export class Applied {
  private runs = new Map<string, Run>();
  private failures = new Map<string, { accepted: string; error: NonNullable<AppliedState["error"]> }>();
  constructor(private app: App) {}
  private file(name: string) {
    return path.join(this.app.state, "applied", name + ".json");
  }
  // The accepted text a decision asked to compile, until that compilation
  // ends: a start resumes exactly these.
  private wantedFile(name: string) {
    return path.join(this.app.state, "applied", name + ".wanted");
  }
  /** The latest completed compilation of the task's accepted text. */
  latest(name: string) {
    const value = readJson<AppliedBuild | null>(this.file(name), null);
    return value && /^[0-9a-f]{32}$/.test(value.key) ? value : null;
  }
  /** How much the build matters to the author now: what they read comes
   *  first, a task nobody looks at last. */
  priority(name: string): BuildPriority {
    return this.app.publisher.attention(name, "pdf");
  }
  // The chapters, seed and date of the latest round's builds.
  private async scope(name: string, round: Round, builder: Builder) {
    const targets = round.summary.targets?.length ? round.summary.targets : ["full"],
      date = round.summary.date ?? buildDate(new Date(round.created * 1000)),
      keys = round.summary.builds ?? [];
    if (targets[0] === "full") return { targets, date, seed: null };
    // The round's own seed once it rendered; before that the one it builds.
    const seed = (keys.length > 2 ? await builder.completed(keys[0]) : null)
      ?? await builder.buildSeed(this.app.tasks.get(name).base, { priority: () => this.priority(name) });
    return { targets, date, seed };
  }
  /** The task's accepted text may have changed: compiles it now, at once. A
   *  compilation of an earlier accepted text stops as soon as this one waits
   *  for its own build, unless both need the same build. Answers at once. */
  refresh(name: string) {
    const task = this.app.tasks.get(name, false);
    if (!task.deferred || task.closed || this.app.publisher.stopping) return;
    const accepted = task.accepted, previous = this.runs.get(name);
    if (previous?.accepted === accepted) return;
    const round = this.app.review.latestRound(name);
    if (!round) return;
    const stop = new AbortController(), run: Run = { accepted, stop, done: Promise.resolve() };
    this.runs.set(name, run);
    if (this.failures.get(name)?.accepted !== accepted) this.failures.delete(name);
    const replace = () => previous?.stop.abort();
    run.done = (async () => {
      try {
        await fs.promises.mkdir(path.dirname(this.wantedFile(name)), { recursive: true });
        await fs.promises.writeFile(this.wantedFile(name), accepted);
        const builder = new Builder(this.app.project, this.app.repo),
          { targets, date, seed } = await this.scope(name, round, builder);
        if (stop.signal.aborted) return replace();
        const info = await builder.build(accepted, targets, seed, { date, signal: stop.signal, priority: () => this.priority(name), onKey: replace });
        await this.remember(name, { accepted, key: info.key, targets, round: round.number, at: now() });
      } catch (error) {
        replace();
        if (error instanceof Cancelled || stop.signal.aborted) return;
        const failure = error instanceof BuildError
          ? { message: error.message, details: error.details, ...(error.log ? { log: error.log } : {}) }
          : { message: (error as Error).message, details: [] };
        this.failures.set(name, { accepted, error: failure });
      } finally {
        if (this.runs.get(name) === run) {
          this.runs.delete(name);
          // Compiled or failed: nothing to resume. A stop at shutdown keeps it.
          if (!stop.signal.aborted) await fs.promises.rm(this.wantedFile(name), { force: true });
        }
      }
    })();
  }
  private async remember(name: string, build: AppliedBuild) {
    // A compilation that a newer one replaced was cancelled before it got
    // here, so this is the newest decision state compiled.
    await fs.promises.mkdir(path.dirname(this.file(name)), { recursive: true });
    await writeJsonAsync(this.file(name), build);
  }
  /** What the task's PDF view shows. */
  async state(name: string): Promise<AppliedState> {
    const task = this.app.tasks.get(name, false), accepted = task.accepted,
      round = this.app.review.latestRound(name), latest = this.latest(name),
      builder = new Builder(this.app.project, this.app.repo);
    const usable = async (build: AppliedBuild | null) => (build && (await builder.completed(build.key)) ? build : null);
    // Before a round's first decision, its own baseline is the accepted text.
    const baseline = async (): Promise<AppliedBuild | null> => {
      const keys = round?.summary.builds ?? [];
      if (!round || keys.length < 2 || (round.visuals ?? "ready") !== "ready") return null;
      const info = await builder.completed(keys.at(-2)!);
      return info ? { accepted: round.before, key: info.key, targets: info.targets, round: round.number, at: round.created } : null;
    };
    let shown: AppliedState["shown"] = null;
    const own = await usable(latest), base = await baseline();
    if (own?.accepted === accepted) shown = { ...own, current: true };
    else if (base?.accepted === accepted) shown = { ...base, current: true };
    else if (own ?? base) shown = { ...(own ?? base)!, current: false };
    const failure = this.failures.get(name);
    // Decisions no compilation was asked for, as those made before this
    // version: they compile once the author opens the task, not at start.
    if (!shown?.current && !this.runs.has(name) && failure?.accepted !== accepted && round && (round.visuals ?? "ready") === "ready")
      this.refresh(name);
    return {
      accepted,
      shown,
      building: this.runs.has(name),
      ...(failure?.accepted === accepted && !shown?.current ? { error: failure.error } : {}),
    };
  }
  /** The PDF of one of the task's applied builds, by key. */
  async pdf(name: string, key: string) {
    const state = await this.state(name);
    if (!state.shown || state.shown.key !== key) {
      const latest = this.latest(name);
      if (latest?.key !== key) return null;
    }
    return (await new Builder(this.app.project, this.app.repo).completed(key))?.pdf ?? null;
  }
  /** At start: the compilations a decision asked for that did not end. A
   *  repository's other tasks wait until the author opens them. */
  recover() {
    for (const task of this.app.tasks.list())
      if (task.deferred && !task.closed && fs.existsSync(this.wantedFile(task.name)) && this.latest(task.name)?.accepted !== task.accepted)
        this.refresh(task.name);
  }
  /** Settles once every compilation under way has ended, for tests. */
  async join() {
    while (this.runs.size) await Promise.allSettled([...this.runs.values()].map((run) => run.done));
  }
  stop() {
    for (const run of this.runs.values()) run.stop.abort();
  }
}
export type { BuildInfo };
