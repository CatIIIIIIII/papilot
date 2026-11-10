import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { applyUnits, revertUnits, withHashesAsync } from "./changes.ts";
import { comparable, fingerprint, origin, rendered } from "./carry.ts";
import { groupFormattingChanges } from "./formatting-changes.ts";
import { now, readBytes, readJson, same, writeOrDelete } from "./files.ts";
import { cleanPath, merge3Async } from "./git.ts";
import type { App } from "../server.ts";
import type {
  Action,
  ActionDetail,
  BuildInfo,
  ActionKind,
  Decision,
  Feedback,
  FeedbackItem,
  History,
  Message,
  MessageData,
  PageState,
  RenderedRound,
  Round,
  RoundDetail,
  Summary,
  Task,
  Unit,
  Write,
} from "../types.ts";
const DECIDED: Record<ActionKind, Decision> = {
  accept: "accepted",
  reject: "rejected",
  comment: "commented",
};
const LIVE = new Set(["queued", "applying", "applied", "undoing"]);
export class Conflict extends Error {}
const snippet = (text: string) => {
  text = text.replace(/\n+$/, "");
  return text.length <= 400 ? text : text.slice(0, 400) + " …";
};
export function safePath(root: string, file: string) {
  cleanPath(file);
  const target = path.resolve(root, file),
    realRoot = fs.realpathSync(root);
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Invalid path: " + file);
    current = parent;
  }
  const resolved = fs.realpathSync(current);
  if (
    (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) ||
    (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep))
  )
    throw new Error("Refusing to write outside the working tree: " + file);
  return target;
}
export class Review {
  // Strip positions recovered for earlier rounds, by round and strip image.
  private tops = new Map<string, Map<string, number>>();
  constructor(public app: App) {}
  latestRound(name: string) {
    return this.app.store.one<Round>(
      "SELECT * FROM rounds WHERE task=? ORDER BY number DESC LIMIT 1",
      name,
    );
  }
  round(name: string, number: number) {
    const found = this.app.store.one<Round>(
      "SELECT * FROM rounds WHERE task=? AND number=?",
      name,
      number,
    );
    if (!found)
      throw new Error(
        `Round ${number} of ${JSON.stringify(name)} does not exist.`,
      );
    return found;
  }
  actions(name: string, number: number) {
    return this.app.store.all<Action>(
      "SELECT * FROM actions WHERE task=? AND round=? ORDER BY seq",
      name,
      number,
    );
  }
  decisions(name: string, round: Round): Record<string, Decision> {
    const result: Record<string, Decision> = Object.fromEntries(
      round.units.map((u) => [u.id, "pending"]),
    );
    for (const action of this.actions(name, round.number))
      if (LIVE.has(action.status))
        for (const change of action.changes)
          result[change] = DECIDED[action.kind];
    return result;
  }
  comments(name: string, number: number) {
    return Object.fromEntries(
      this.actions(name, number)
        .filter((a) => a.kind === "comment" && LIVE.has(a.status))
        .flatMap((a) => a.changes.map((c) => [c, a.body])),
    );
  }
  counts(
    name: string,
    round = this.latestRound(name),
  ): Record<Decision, number> {
    const values = round ? Object.values(this.decisions(name, round)) : [];
    return {
      accepted: values.filter((v) => v === "accepted").length,
      rejected: values.filter((v) => v === "rejected").length,
      commented: values.filter((v) => v === "commented").length,
      pending: values.filter((v) => v === "pending").length,
    };
  }
  /** Undecided changes of a round that have a PDF comparison to decide with. */
  ready(name: string, round: Round, decisions = this.decisions(name, round)) {
    const shown = (round.visuals ?? "ready") === "ready" ? null : rendered(this.app, name, round.number);
    return round.units.filter((u) => decisions[u.id] === "pending" && (!shown || comparable(round, shown, u.id))).length;
  }
  /** Decided changes whose own comparison, rendered after the decision,
   *  looks different from the earlier round's comparison they were decided
   *  with. */
  reviewAgain(name: string, round: Round) {
    if ((round.visuals ?? "ready") !== "ready") return [];
    const result = new Set<string>();
    for (const action of this.actions(name, round.number)) {
      if (!LIVE.has(action.status) || !action.detail.seen) continue;
      const now = rendered(this.app, name, round.number);
      for (const [id, seen] of Object.entries(action.detail.seen))
        if (fingerprint(rendered(this.app, name, seen.round), seen.change) !== fingerprint(now, id)) result.add(id);
    }
    return [...result];
  }
  /** The decision Undo takes back: the latest one, unless it was applied or
   *  merged since. Rounds never change, so a decision of an earlier round is
   *  undone only when it is an accept that no decision followed, as when the
   *  author accepts while the agent works and the agent's round follows: the
   *  newer round's baseline is that accept, and the undo inserts the next
   *  round, with the change pending again (`republish`). */
  undoEntry(name: string): (Action & { republish?: true }) | null {
    const latest = this.latestRound(name),
      action = this.app.store.one<Action>(
        "SELECT * FROM actions WHERE task=? AND status IN ('applied','queued') ORDER BY seq DESC LIMIT 1",
        name,
      );
    const delivered = this.app.delivery.get(name), reconciliation = this.app.reconciliation.get(name);
    if (!action || !latest || (reconciliation && action.round <= reconciliation.round) || (delivered && action.seq <= delivered.seq)) return null;
    if (action.round === latest.number) return action;
    const followed = this.app.store.one(
      "SELECT 1 FROM actions WHERE task=? AND round>? AND status IN ('applying','applied','undoing') LIMIT 1",
      name,
      action.round,
    );
    return action.kind === "accept" && !followed && action.detail.accepted_after === latest.before && this.app.tasks.get(name).accepted === latest.before
      ? { ...action, republish: true }
      : null;
  }
  summary(name: string): Summary {
    const task = this.app.tasks.get(name),
      latest = this.latestRound(name),
      job = this.app.publisher.current(name),
      counts = this.counts(name, latest),
      number = latest?.number ?? null,
      ready = latest && counts.pending ? this.ready(name, latest) : 0;
    const notes =
      latest &&
      this.app.store.one(
        "SELECT id FROM messages WHERE task=? AND kind='note' AND created>? LIMIT 1",
        name,
        latest.created,
      );
    const notReverted =
      latest &&
      this.actions(name, latest.number).some(
        (a) =>
          a.kind === "reject" &&
          LIVE.has(a.status) &&
          a.detail.not_reverted?.length,
      );
    let state: Summary["state"], next: string;
    if (job && ["queued", "running"].includes(job.status)) {
      state = "building";
      next = "A round is being built. Run `publish` again to wait for it.";
    } else if (
      job?.status === "failed" &&
      (!latest || job.created > latest.created || latest.summary.job === job.id)
    ) {
      state = "build_failed";
      next =
        job.result.next ||
        "Fix the problem in the worktree, then publish again.";
    } else if (!latest) {
      state = "editing";
      next = "Edit files in the worktree, then run `publish`.";
    } else if (counts.pending) {
      state = "reviewing";
      next = `The user is reviewing round ${number} (${counts.pending} changes left). Keep this turn open with \`feedback --wait\`, then continue automatically.`;
    } else if (counts.commented || notes || notReverted) {
      state = "revise";
      next =
        "Revise the commented changes in the worktree, then `publish`. Rejected changes were already reverted in your worktree" +
        (notReverted ? " except where noted." : ".");
    } else {
      state = "done";
      next =
        "Every change is decided. Report completion and leave the review open for inspection and undo. Run `finish` only when the user asks to clean up the review.";
    }
    return {
      task: name,
      title: task.title,
      state,
      round: number,
      counts,
      ready,
      next,
    };
  }
  // A round's decisions and comments as its page shows them: also those made
  // on that page and applied to a later round (see decideNow).
  private shown(name: string, round: Round) {
    const decisions = this.decisions(name, round), comments: Record<string, string> = this.comments(name, round.number);
    for (const action of this.app.store.all<Action>("SELECT * FROM actions WHERE task=? AND round>? ORDER BY seq", name, round.number)) {
      if (!LIVE.has(action.status) || action.detail.requested?.round !== round.number) continue;
      for (const change of action.detail.requested.changes) {
        if (!Object.hasOwn(decisions, change)) continue;
        decisions[change] = DECIDED[action.kind];
        if (action.kind === "comment") comments[change] = action.body;
      }
    }
    return { decisions, comments };
  }
  /** `seen`: the page asking is on screen, so the author reads this task. */
  pageState(name: string, number?: number, seen = true): PageState {
    const task = this.app.tasks.get(name, false),
      latest = this.latestRound(name);
    number ||= latest?.number;
    const round = number ? this.round(name, number) : null,
      undo =
        round && latest && number === latest.number
          ? this.undoEntry(name)
          : null,
      job = this.app.publisher.current(name),
      again = round ? this.reviewAgain(name, round) : [];
    if (seen) this.app.viewers.set(name, now());
    return {
      csrf: this.app.csrf,
      sourceEditing: true,
      deferred: Boolean(task.deferred),
      task: name,
      title: task.title,
      closed: Boolean(task.closed),
      state: task.closed ? null : this.summary(name).state,
      latest: latest?.number ?? null,
      history: this.app.store.all<{ number: number; created: number }>(
        "SELECT number,created FROM rounds WHERE task=? ORDER BY number DESC",
        name,
      ),
      round: number ?? null,
      revision: round?.after ?? null,
      ...(round ? this.shown(name, round) : { decisions: {}, comments: {} }),
      ...(round && (round.visuals ?? "ready") !== "ready" ? { rendering: round.visuals as "pending" | "failed" } : {}),
      waiting: round ? round.units.filter(unit => !comparable(round, rendered(this.app, name, round.number), unit.id)).map(unit => unit.id) : [],
      ...(again.length ? { reviewAgain: again } : {}),
      undo: undo
        ? { id: undo.id, kind: undo.kind, changes: undo.changes, ...(undo.republish ? { republish: true as const } : {}), ...(undo.status === "queued" ? { queued: true as const } : {}) }
        : null,
      ...(round ? (() => {
        const queued = this.queuedActions(name).filter((a) => a.round === round.number).flatMap((a) => a.changes);
        return queued.length ? { queued } : {};
      })() : {}),
      job: job
        ? {
            id: job.id,
            status: job.status,
            phase: job.phase,
            created: job.created,
            ahead: job.status === "queued" ? this.app.publisher.ahead(job) : 0,
            ...job.result,
          }
        : null,
    };
  }
  // The full paper places each change by where its strips start on the page.
  // Rounds rendered before strips recorded that recover it from the round's
  // new PDF the first time they are shown.
  async positioned(detail: RoundDetail): Promise<RoundDetail> {
    const strips = [...detail.sections.flatMap((s) => s.blocks), ...detail.loose]
      .flatMap((block) => (block.kind === "change" ? block.after : []))
      .filter((strip) => strip.top === undefined);
    if (!strips.length) return detail;
    const key = `${detail.task}:${detail.round}`;
    let tops = this.tops.get(key);
    if (!tops) {
      tops = new Map();
      const build = this.round(detail.task, detail.round).summary.builds?.at(-1),
        info = build
          ? readJson<BuildInfo | null>(path.join(this.app.state, "cache/builds", build, "result.json"), null)
          : null;
      if (info && fs.existsSync(info.pdf)) {
        const { stripTops } = await import("../render/positions.ts");
        stripTops(info.pdf, strips);
        for (const strip of strips) if (strip.top !== undefined) tops.set(strip.src, strip.top);
      }
      this.tops.set(key, tops);
    }
    for (const strip of strips) {
      const top = tops.get(strip.src);
      if (top !== undefined) strip.top = top;
    }
    return detail;
  }
  roundDetail(name: string, number: number): RoundDetail {
    const round = this.round(name, number),
      render = readJson<RenderedRound>(
        path.join(
          this.app.state,
          "rounds",
          name,
          String(number).padStart(3, "0"),
          "round.json",
        ),
        { units: {}, sections: [], loose: [] },
      ),
      history = this.history(name, round),
      rendering = (round.visuals ?? "ready") !== "ready" ? (round.visuals as "pending" | "failed") : undefined;
    // Earlier releases stored a single after strip as an object. Keep those rounds readable.
    for (const block of [
      ...render.sections
        .flatMap((s) => s.blocks)
        .filter((b) => b.kind === "change"),
      ...render.loose,
    ]) {
      if (!Array.isArray(block.after))
        block.after = block.after ? [block.after] : [];
      block.kind = "change";
    }
    const sources = new Map<string, { text: string; hash?: string }>();
    const context = (unit: Unit) => {
      if (!unit.text_ops?.length) return {};
      if (!sources.has(unit.file)) {
        const data = this.app.repo.blob(round.before, unit.file);
        sources.set(unit.file, { text: data?.toString("utf8") || "", ...(data ? { hash: createHash("sha256").update(data).digest("hex") } : {}) });
      }
      // Identify the complete baseline file, not just this bounded excerpt.
      // Accepting another file changes the round's commit but not this source.
      const { text, hash } = sources.get(unit.file)!, offset = unit.text_ops[0][1], start = Math.max(0, offset - 2000);
      return { old_context: { text: text.slice(start, unit.text_ops.at(-1)![2] + 2000), start, ...(hash ? { source_hash: hash } : {}) } };
    };
    return groupFormattingChanges({
      task: name,
      round: number,
      before: round.before,
      after: round.after,
      units: round.units.map((u) => ({
        ...u,
        ...context(u),
        ...render.units[u.id],
        ...(rendering && !render.units[u.id] ? { waiting: true } : {}),
        ...(rendering && render.carried?.[u.id] ? { carried: render.carried[u.id].round } : {}),
        ...(history[u.id] ? { history: history[u.id] } : {}),
      })),
      ...(rendering ? { rendering } : {}),
      sections: render.sections,
      loose: render.loose,
      warnings: round.summary.warnings ?? [],
      builds: round.summary.builds ?? [],
      files: `/files/${name}/${number}/`,
      ...(round.summary.builds?.length
        ? { build: { key: round.summary.builds.at(-1)!, targets: round.summary.targets ?? ["full"] } }
        : {}),
      ...(render.references ? { references: render.references } : {}),
    }, file => this.app.repo.blob(round.before, file)?.toString("utf8") ?? null);
  }
  history(name: string, round: Round): Record<string, History[]> {
    if (round.number === 1) return {};
    const previous = this.round(name, round.number - 1),
      comments = this.comments(name, previous.number),
      result: Record<string, History[]> = {};
    for (const unit of round.units)
      for (const old of previous.units)
        if (
          comments[old.id] &&
          old.file === unit.file &&
          (old.text_ops && unit.text_ops
            ? previous.before === round.before
              ? old.text_ops.some((a) =>
                  unit.text_ops!.some((b) =>
                    a[1] === a[2] || b[1] === b[2]
                      ? a[1] === b[1]
                      : a[1] < b[2] && b[1] < a[2],
                  ),
                )
              : Boolean(
                  old.old_text &&
                  old.old_text === unit.old_text &&
                  round.units.filter(
                    (u) => u.file === unit.file && u.old_text === old.old_text,
                  ).length === 1,
                )
            : (old.old_text && old.old_text === unit.old_text) ||
              Math.max(old.old_start, unit.old_start) <=
                Math.min(old.old_end, unit.old_end))
        )
          (result[unit.id] ??= []).push({
            round: previous.number,
            change: old.id,
            comment: comments[old.id],
            new_text: old.new_text,
          });
    return result;
  }
  feedback(name: string, after = 0): Feedback {
    this.app.tasks.get(name);
    const rows = this.app.store.all<Message>(
        "SELECT * FROM messages WHERE task=? AND id>? ORDER BY id",
        name,
        after,
      ),
      undone = new Set(
        this.app.store
          .all<{ id: string }>(
            "SELECT id FROM actions WHERE task=? AND status='undone'",
            name,
          )
          .map((a) => a.id),
      ),
      items: FeedbackItem[] = [];
    for (const message of rows) {
      if (
        (message.kind === "undo" && (message.data.message ?? 0) > after) ||
        (message.kind !== "undo" &&
          message.action &&
          undone.has(message.action))
      )
        continue;
      const item: FeedbackItem = {
        id: message.id,
        kind: message.kind,
        round: message.round,
      };
      if (message.body) item.text = message.body;
      const changes = message.data.changes ?? [];
      if (changes.length && message.round) {
        const units = new Map(
          this.round(name, message.round).units.map((u) => [u.id, u]),
        );
        item.changes = ["comment", "reject"].includes(message.kind)
          ? changes
              .filter((c) => units.has(c))
              .map((c) => {
                const u = units.get(c)!;
                return {
                  id: c,
                  file: u.file,
                  lines: [u.new_start, u.new_end] as [number, number],
                  old: snippet(u.old_text),
                  new: snippet(u.new_text),
                };
              })
          : changes;
      }
      if (message.data.not_reverted?.length)
        item.not_reverted = message.data.not_reverted;
      if (message.data.undid) item.undid = message.data.undid;
      items.push(item);
    }
    const summary = this.summary(name);
    if (items.some((i) => i.kind === "note"))
      summary.next =
        "Read and act on the user's message in `feedback` first, even while changes are pending or a round is building. Then follow the task state.";
    const job = this.app.publisher.current(name);
    return {
      ...summary,
      feedback: items,
      cursor: rows.at(-1)?.id ?? after,
      ...(job?.status === "failed" ? { build_error: job.result } : {}),
      warnings: this.latestRound(name)?.summary.warnings ?? [],
    };
  }
  /** Accepts, rejects or comments on changes of the latest round. Runs after
   *  every other write of the review engine, never beside one. */
  decide(
    name: string,
    data: {
      action: ActionKind;
      id?: string;
      changes: string[];
      round: number;
      body?: string;
      /** The agent is working in the task's files: a reject waits for its
       *  turn to end. */
      queue?: boolean;
    },
    // A note option's checkmark was given with the option's own PDF preview.
    options: { previewed?: boolean } = {},
  ) {
    return this.app.exclusive(() => this.decideNow(name, data, options));
  }
  private async decideNow(
    name: string,
    data: {
      action: ActionKind;
      id?: string;
      changes: string[];
      round: number;
      body?: string;
      queue?: boolean;
    },
    options: { previewed?: boolean },
  ) {
    const task = this.app.tasks.get(name),
      kind = data.action;
    this.app.delivery.assertReady(name);
    const reconciliation = this.app.reconciliation.get(name);
    if (reconciliation && (!reconciliation.ready || data.round <= reconciliation.round))
      throw new Error("Review the new merge suggestion before changing decisions.");
    if (!Object.hasOwn(DECIDED, kind))
      throw new Error("The action must be accept, reject or comment.");
    const identity = data.id || randomUUID();
    if (!/^[A-Za-z0-9-]{1,80}$/.test(identity))
      throw new Error("Invalid action id.");
    const previous = this.app.store.one<Action>(
        "SELECT * FROM actions WHERE id=?",
        identity,
      ),
      chosen = data.changes;
    if (previous) {
      // A decision that named an earlier round is retried as it was sent.
      const sent = previous.detail.requested ?? { round: previous.round, changes: previous.changes };
      if (
        previous.task !== name ||
        sent.round !== data.round ||
        previous.kind !== kind ||
        (kind === "comment" && previous.body !== (data.body || "").trim()) ||
        JSON.stringify(sent.changes) !== JSON.stringify(chosen)
      )
        throw new Error(
          "This action id was already used for another decision.",
        );
      if (previous.status !== "applied" && previous.status !== "queued")
        throw new Error("That decision was undone or failed. Make it again.");
      return this.pageState(name, data.round);
    }
    const latest = this.latestRound(name),
      valid = Array.isArray(chosen) && chosen.length > 0 && new Set(chosen).size === chosen.length;
    if (!latest) throw new Error("A newer round is available. Reload the page.");
    let ids = chosen,
      seen: Record<string, { round: number; change: string }> = {},
      requested: ActionDetail["requested"];
    if (data.round !== latest.number) {
      // Changes decided on an earlier round's page apply to their exact
      // versions in the latest round, when each has exactly one there.
      const translated = valid && data.round < latest.number ? await this.translate(name, data.round, chosen, latest, kind !== "comment") : null;
      if (!translated) throw new Error("A newer round is available. Reload the page.");
      ({ ids, seen } = translated);
      requested = { round: data.round, changes: chosen };
    }
    const decisions = this.decisions(name, latest);
    if (!valid || ids.some((c) => decisions[c] !== "pending"))
      throw new Error("These changes were already decided. Reload the page.");
    const body = (data.body || "").trim();
    if (kind === "comment" && !body) throw new Error("Write a comment first.");
    if (!requested && (latest.visuals ?? "ready") !== "ready") {
      // The author decides with a PDF comparison: the round's own, or one an
      // earlier round rendered of the same version, until its own arrives.
      const shown = rendered(this.app, name, latest.number);
      if (kind !== "comment" && !options.previewed && ids.some((id) => !comparable(latest, shown, id)))
        throw new Error("Wait for the PDF comparison of this change before accepting or rejecting it.");
      for (const id of ids) {
        const found = origin(latest, shown, id);
        if (found) seen[id] = found;
      }
    }
    const extra: ActionDetail = { ...(requested ? { requested } : {}), ...(Object.keys(seen).length ? { seen } : {}) };
    const selected = ids.map((c) => latest.units.find((u) => u.id === c)!);
    if (kind === "accept") await this.accept(task, latest, identity, selected, extra);
    else if (kind === "reject" && data.queue)
      // Shown rejected now; its files are reverted when the agent stops.
      this.record(identity, task, latest, "reject", ids, "", { ...extra, queued: true }, [], "queued");
    else if (kind === "reject") {
      // Rejects queued earlier go first, in order.
      await this.applyQueued(name);
      await this.reject(this.app.tasks.get(name), latest, identity, selected, extra);
    }
    else
      this.app.store.transaction(() => {
        this.record(
          identity,
          task,
          latest,
          kind,
          ids,
          body,
          extra,
          [],
          "applied",
          false,
        );
        this.message(name, latest.number, "comment", identity, body, {
          changes: ids,
        });
      });
    // The page that sent it shows its own round, with this decision.
    return this.pageState(name, data.round);
  }
  // The latest round's changes with the exact versions of `chosen` in round
  // `number`, and the comparison each was seen with, or null unless each has
  // exactly one undecided match.
  private async translate(name: string, number: number, chosen: string[], latest: Round, needsComparison: boolean) {
    const round = this.app.store.one<Round>("SELECT * FROM rounds WHERE task=? AND number=?", name, number);
    if (!round) return null;
    const [older, newer] = await Promise.all([round, latest].map((r) => withHashesAsync(this.app.repo, r.before, r.after, r.units))),
      then = this.decisions(name, round),
      now = this.decisions(name, latest),
      shown = rendered(this.app, name, round.number),
      ids: string[] = [],
      seen: Record<string, { round: number; change: string }> = {};
    for (const id of chosen) {
      const unit = older.find((u) => u.id === id);
      if (!unit || then[id] !== "pending" || older.filter((u) => u.hash === unit.hash).length !== 1) return null;
      const matches = newer.filter((u) => u.hash === unit.hash && now[u.id] === "pending"),
        found = origin(round, shown, id);
      // Accept and reject need the comparison the author saw. Comments on
      // the exact same change stay available while that comparison renders.
      if (matches.length !== 1 || (needsComparison && !found)) return null;
      ids.push(matches[0].id);
      if (found) seen[matches[0].id] = found;
    }
    return { ids, seen };
  }
  byFile(units: Unit[]) {
    const groups: Record<string, Unit[]> = {};
    for (const unit of units) (groups[unit.file] ??= []).push(unit);
    return groups;
  }
  private async accept(task: Task, round: Round, identity: string, units: Unit[], extra: ActionDetail = {}) {
    const app = this.app,
      writes: [string, Buffer | null, Buffer | null][] = [],
      accepted: Record<string, Buffer | null> = {},
      conflicts: string[] = [],
      groups = this.byFile(units),
      files = Object.keys(groups),
      [before, after, records] = await Promise.all([round.before, round.after, task.accepted].map((rev) => app.repo.blobsAsync(rev, files)));
    for (const [file, group] of Object.entries(groups)) {
      const proposed = applyUnits(before[file], after[file], group),
        target = task.deferred ? "" : safePath(app.root, file),
        current = task.deferred ? records[file] : readBytes(target),
        [merged, conflict] = await merge3Async(current, before[file], proposed),
        [recorded, recordedConflict] = await merge3Async(
          records[file],
          before[file],
          proposed,
        );
      if (conflict || recordedConflict) conflicts.push(file);
      else if (!task.deferred && !same(merged, current)) writes.push([target, current, merged]);
      accepted[file] = recorded;
    }
    if (conflicts.length)
      throw new Conflict(
        `${units.map((u) => u.id).join(", ")} can't be applied: ${conflicts.join(", ")} changed in your manuscript since this round was published. Nothing was written. Comment on the change to have the agent redo it.`,
      );
    const afterCommit = await app.repo.commitWithAsync(
      task.accepted,
      accepted,
      "latex-review: accept " + units.map((u) => u.id).join(", "),
    );
    this.record(
      identity,
      task,
      round,
      "accept",
      units.map((u) => u.id),
      "",
      { accepted_before: task.accepted, accepted_after: afterCommit, ...extra },
      writes,
    );
    await this.carryOut(identity, "apply");
  }
  private async reject(task: Task, round: Round, identity: string, units: Unit[], extra: ActionDetail = {}) {
    const writes: [string, Buffer | null, Buffer | null][] = [],
      kept: string[] = [],
      groups = this.byFile(units),
      files = Object.keys(groups),
      [before, after] = await Promise.all([this.app.repo.blobsAsync(round.before, files), this.app.repo.blobsAsync(round.after, files)]);
    for (const [file, group] of Object.entries(groups)) {
      const reverted = revertUnits(before[file], after[file], group),
        target = safePath(task.worktree, file),
        current = readBytes(target),
        [merged, conflict] = await merge3Async(current, after[file], reverted);
      if (conflict) kept.push(file);
      else if (!same(merged, current)) writes.push([target, current, merged]);
    }
    this.record(
      identity,
      task,
      round,
      "reject",
      units.map((u) => u.id),
      "",
      { not_reverted: kept, ...extra },
      writes,
    );
    await this.carryOut(identity, "apply");
  }
  // The reverted contents of a reject's files, merged into `current`, or
  // null for a file whose passage was edited again since its round.
  private async reverts(round: Round, units: Unit[], current: (file: string) => Buffer | null) {
    const groups = this.byFile(units), files = Object.keys(groups),
      [before, after] = await Promise.all([this.app.repo.blobsAsync(round.before, files), this.app.repo.blobsAsync(round.after, files)]),
      result: Record<string, Buffer | null | undefined> = {};
    for (const [file, group] of Object.entries(groups)) {
      const reverted = revertUnits(before[file], after[file], group), now = current(file),
        [merged, conflict] = await merge3Async(now, after[file], reverted);
      result[file] = conflict ? undefined : merged;
    }
    return result;
  }
  private queuedActions(name: string) {
    return this.app.store.all<Action>("SELECT * FROM actions WHERE task=? AND status='queued' ORDER BY seq", name);
  }
  /** Reverts the rejects queued while the agent worked, in order. A reject
   *  whose passages the agent edited again is not applied: the next round
   *  shows the new version. The caller holds the engine's write turn. */
  async applyQueued(name: string) {
    for (const action of this.queuedActions(name)) {
      const task = this.app.tasks.get(name), round = this.round(name, action.round),
        units = round.units.filter((u) => action.changes.includes(u.id)),
        reverts = await this.reverts(round, units, (file) => readBytes(safePath(task.worktree, file))),
        kept = Object.keys(reverts).filter((file) => reverts[file] === undefined);
      if (kept.length === Object.keys(reverts).length) {
        this.app.store.execute("UPDATE actions SET status='failed', detail=? WHERE id=?", JSON.stringify({ ...action.detail, not_reverted: kept }), action.id);
        continue;
      }
      this.app.store.transaction(() => {
        this.app.store.execute("UPDATE actions SET status='applying', detail=? WHERE id=?", JSON.stringify({ ...action.detail, not_reverted: kept }), action.id);
        for (const [file, target] of Object.entries(reverts)) {
          if (target === undefined) continue;
          const path = safePath(task.worktree, file), expected = readBytes(path);
          if (!same(expected, target))
            this.app.store.execute("INSERT INTO writes(action,phase,path,expected,target) VALUES(?,?,?,?,?)", action.id, "apply", path, expected, target);
        }
      });
      await this.carryOut(action.id, "apply");
    }
  }
  /** `snapshot` as it is once the queued rejects are reverted, as their
   *  turn's end will make it, for compiling that ahead. */
  async queuedTree(name: string, snapshot: string) {
    const actions = this.queuedActions(name);
    if (!actions.length) return snapshot;
    const contents: Record<string, Buffer | null> = {};
    for (const action of actions) {
      const round = this.round(name, action.round), units = round.units.filter((u) => action.changes.includes(u.id));
      const files = Object.keys(this.byFile(units)), current = await this.app.repo.blobsAsync(snapshot, files);
      const reverts = await this.reverts(round, units, (file) => (file in contents ? contents[file] : current[file] ?? null));
      for (const [file, target] of Object.entries(reverts)) if (target !== undefined) contents[file] = target;
    }
    return Object.keys(contents).length ? this.app.repo.commitWithAsync(snapshot, contents, "Queued rejects") : snapshot;
  }
  record(
    identity: string,
    task: Task,
    round: Round,
    kind: ActionKind,
    changes: string[],
    body: string,
    detail: ActionDetail,
    writes: [string, Buffer | null, Buffer | null][],
    status: Action["status"] = "applying",
    transaction = true,
  ) {
    const work = () => {
      this.app.store.execute(
        "INSERT INTO actions(id,task,round,kind,changes,body,status,detail,created) VALUES(?,?,?,?,?,?,?,?,?)",
        identity,
        task.name,
        round.number,
        kind,
        JSON.stringify(changes),
        body,
        status,
        JSON.stringify(detail),
        now(),
      );
      for (const [file, expected, target] of writes)
        this.app.store.execute(
          "INSERT INTO writes(action,phase,path,expected,target) VALUES(?,?,?,?,?)",
          identity,
          "apply",
          file,
          expected,
          target,
        );
    };
    if (transaction) this.app.store.transaction(work);
    else work();
  }
  perform(identity: string, phase: Write["phase"]) {
    const rows = this.app.store.all<Write>(
        "SELECT * FROM writes WHERE action=? AND phase=?",
        identity,
        phase,
      ),
      current = new Map(rows.map((r) => [r.path, readBytes(r.path)])),
      stale = rows.filter(
        (r) =>
          !same(current.get(r.path)!, r.expected) &&
          !same(current.get(r.path)!, r.target),
      );
    if (stale.length)
      throw new Conflict(
        "These files changed while the decision was being applied: " +
          stale.map((r) => r.path).join(", "),
      );
    for (const row of rows)
      if (!same(current.get(row.path)!, row.target))
        writeOrDelete(row.path, row.target);
  }
  private async carryOut(identity: string, phase: Write["phase"]) {
    try {
      this.perform(identity, phase);
    } catch (error) {
      for (const row of this.app.store.all<Write>(
        "SELECT * FROM writes WHERE action=? AND phase=?",
        identity,
        phase,
      ))
        if (
          same(readBytes(row.path), row.target) &&
          !same(row.target, row.expected)
        )
          writeOrDelete(row.path, row.expected);
      this.app.store.transaction(() => {
        this.app.store.execute(
          "DELETE FROM writes WHERE action=? AND phase=?",
          identity,
          phase,
        );
        this.app.store.execute(
          "UPDATE actions SET status=? WHERE id=?",
          phase === "apply" ? "failed" : "applied",
          identity,
        );
      });
      throw error;
    }
    await this.complete(identity);
  }
  private async complete(identity: string) {
    const app = this.app,
      action = app.store.one<Action>(
        "SELECT * FROM actions WHERE id=?",
        identity,
      )!;
    if (!["applying", "undoing"].includes(action.status)) return;
    const applying = action.status === "applying",
      accepted = applying
        ? action.detail.accepted_after
        : action.detail.accepted_before;
    app.store.transaction(() => {
      if (action.kind === "accept")
        app.store.execute(
          "UPDATE tasks SET accepted=? WHERE name=?",
          accepted!,
          action.task,
        );
      app.store.execute(
        "UPDATE actions SET status=? WHERE id=?",
        applying ? "applied" : "undone",
        identity,
      );
      if (applying)
        this.message(action.task, action.round, action.kind, identity, "", {
          changes: action.changes,
          ...(action.detail.not_reverted?.length
            ? { not_reverted: action.detail.not_reverted }
            : {}),
        });
      else {
        const original = app.store.one<{ id: number }>(
          "SELECT id FROM messages WHERE action=? AND kind!='undo' ORDER BY id LIMIT 1",
          identity,
        );
        this.message(action.task, action.round, "undo", identity, "", {
          changes: action.changes,
          undid: action.kind,
          message: original?.id ?? 0,
        });
      }
    });
    if (action.kind === "accept") {
      await app.repo.updateRefAsync(
        `refs/latex-review/${action.task}/accepted`,
        accepted!,
      );
      // The paper as decided compiles at once, replacing the compilation
      // of the decisions before this one.
      app.applied.refresh(action.task);
      app.publisher.refollow(action.task);
    }
  }
  message(
    name: string,
    number: number | null,
    kind: Message["kind"],
    action: string | null,
    body: string,
    data: MessageData,
  ) {
    this.app.store.execute(
      "INSERT INTO messages(task,round,kind,action,body,data,created) VALUES(?,?,?,?,?,?,?)",
      name,
      number,
      kind,
      action,
      body,
      JSON.stringify(data),
      now(),
    );
  }
  note(name: string, body: string) {
    body = (body || "").trim();
    if (!body) throw new Error("Write a message.");
    this.app.tasks.get(name);
    this.message(
      name,
      this.latestRound(name)?.number ?? null,
      "note",
      null,
      body,
      {},
    );
    return this.pageState(name);
  }
  /** Undoes the latest decision, after every other write of the engine. */
  undo(name: string, identity: string) {
    return this.app.exclusive(() => this.undoNow(name, identity));
  }
  private async undoNow(name: string, identity: string): Promise<PageState & { restored: string[]; republished?: true }> {
    this.app.delivery.assertReady(name);
    const app = this.app,
      task = app.tasks.get(name),
      action = this.undoEntry(name);
    if (!action || action.id !== identity) {
      // A lost reply to an undo that inserted a round is answered again.
      const done = app.store.one<Action>("SELECT * FROM actions WHERE id=? AND task=?", identity, name);
      if (done?.status === "undone" && done.detail.republish) return { ...this.pageState(name), restored: done.changes, republished: true as const };
      throw new Error("Nothing to undo here any more. Reload the page.");
    }
    // A reject still queued never touched the task's files: it is dropped.
    if (action.status === "queued") {
      app.store.execute("UPDATE actions SET status='undone' WHERE id=?", identity);
      return { ...this.pageState(name), restored: action.changes };
    }
    const latest = this.latestRound(name)!;
    // The round it inserts compares the task's files as the newest round has
    // them, so nothing else is published with it, such as an agent's edits.
    if (action.republish && (await app.repo.treeIdAsync(await app.tasks.snapshotAsync(task))) !== (await app.repo.treeIdAsync(latest.after)))
      throw new Conflict("The task's files changed since the newest round. Nothing was undone.");
    if (
      action.kind === "accept" &&
      task.accepted !== action.detail.accepted_after
    )
      throw new Conflict(
        "The accepted text changed in an unexpected way; nothing was undone.",
      );
    const restores: [string, Buffer | null, Buffer | null][] = [],
      conflicts: string[] = [];
    for (const write of app.store.all<Write>(
      "SELECT * FROM writes WHERE action=? AND phase='apply'",
      identity,
    )) {
      const current = readBytes(write.path),
        [restored, conflict] = await merge3Async(current, write.target, write.expected);
      if (conflict) conflicts.push(write.path);
      else if (!same(restored, current))
        restores.push([write.path, current, restored]);
    }
    if (conflicts.length)
      throw new Conflict(
        `Can't undo: ${conflicts.map((p) => path.relative(app.root, p)).join(", ")} changed since the decision. Nothing was undone.`,
      );
    app.store.transaction(() => {
      app.store.execute(
        "UPDATE actions SET status='undoing', detail=? WHERE id=?",
        JSON.stringify(action.republish ? { ...action.detail, republish: latest.number + 1 } : action.detail),
        identity,
      );
      for (const [file, expected, target] of restores)
        app.store.execute(
          "INSERT INTO writes(action,phase,path,expected,target) VALUES(?,'undo',?,?,?)",
          identity,
          file,
          expected,
          target,
        );
    });
    await this.carryOut(identity, "undo");
    if (!action.republish) return { ...this.pageState(name), restored: action.changes };
    // Like a source edit's, the round is inserted now and compiles in the
    // background; a restart before the insert submits it (publisher.recover).
    const job = app.publisher.submit(name, undefined, latest.summary.indirect ?? true);
    await app.publisher.insertNow(job).catch(() => { /* The job inserts again when it starts, and fails with the reason. */ });
    return { ...this.pageState(name), restored: action.changes, republished: true as const };
  }
  // At start, before any other write.
  async recover() {
    for (const action of this.app.store.all<Action>(
      "SELECT * FROM actions WHERE status IN ('applying','undoing') ORDER BY seq",
    )) {
      try {
        await this.carryOut(
          action.id,
          action.status === "applying" ? "apply" : "undo",
        );
      } catch {
        /* Journal state records a recoverable conflict; leave later actions available. */
      }
    }
  }
}
