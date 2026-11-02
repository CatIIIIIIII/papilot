import fs from "node:fs";
import path from "node:path";
import type { App } from "../server.ts";
import type { Delivery } from "../types.ts";
import { merge3 } from "./git.ts";
import { readBytes, same, writeOrDelete } from "./files.ts";
import { planCurrentCommit, finishCurrentCommit, CommitNeedsReview } from "./current-commit.ts";
import { safePath } from "./review.ts";

class DeliveryConflict extends Error {}

const encode = (data: Buffer | null) => data?.toString("base64") ?? null;
const decode = (data: string | null) => data === null ? null : Buffer.from(data, "base64");

// Acceptance stays in Git objects until the author chooses a destination.
// Persist the exact intended result before touching files or a branch so a
// lost response or a restart can finish the same operation without duplication.
export class Deliveries {
  constructor(public app: App) {}
  get(name: string) {
    return this.app.store.one<{ data: Delivery }>("SELECT data FROM deliveries WHERE task=?", name)?.data;
  }
  save(name: string, data: Delivery) {
    this.app.store.execute("INSERT OR REPLACE INTO deliveries(task,data) VALUES(?,?)", name, JSON.stringify(data));
  }
  assertReady(name: string) {
    const last = this.get(name);
    if (last && !last.done) throw new Error("Finish the pending delivery before changing this review. Retry the same destination.");
  }
  apply(name: string, keepCurrent = false, mode?: "workspace" | "commit", message?: string, confirmation?: string) {
    const active = this.app.reconciliation.get(name);
    mode ??= active?.intent?.mode ?? "workspace";
    message ??= active?.intent?.message ?? "";
    if (mode !== "workspace" && mode !== "commit") throw new Error("Choose a task commit or apply without committing.");
    if (mode === "commit" && (!message.trim() || message.length > 5000)) throw new Error("Write a commit message (at most 5,000 characters).");
    const last = this.get(name);
    if (last && !last.done) {
      const delivery = this.finish(name, last);
      if (last.mode !== "branch") return { delivery };
    }
    if (keepCurrent) {
      const task = this.app.tasks.get(name);
      if (!active?.ready || task.accepted !== active.reviewBase || this.app.repo.changedFiles(task.accepted, this.app.tasks.snapshot(task)).length)
        throw new Error("Review the merge suggestion before applying it, or ask the agent to keep the latest wording.");
    }
    if (active) this.app.reconciliation.intent(name, { mode, message });
    if (!keepCurrent && active && (!active.ready || (this.app.review.latestRound(name)?.number ?? 0) <= active.round))
      return { reconciliation: this.app.reconciliation.prepare(name, this.app.reconciliation.get(name)!) };
    try { return { delivery: this.deliver(name, mode, message, keepCurrent, confirmation) }; }
    catch (error) {
      if (error instanceof CommitNeedsReview) return { commitReview: error.review };
      if (!(error instanceof DeliveryConflict)) throw error;
      const reconciliation = this.app.reconciliation.start(name, keepCurrent, { mode, message });
      if (reconciliation) return { reconciliation };
      return { delivery: this.deliver(name, mode, message, keepCurrent, confirmation) };
    }
  }
  deliver(name: string, mode: Delivery["mode"], message = "", keepCurrent = false, confirmation?: string) {
    const app = this.app, task = app.tasks.get(name), last = this.get(name);
    if (!task.deferred) throw new Error("This task already applies accepted changes to the manuscript.");
    if (mode !== "workspace" && mode !== "commit" && mode !== "branch") throw new Error("Choose a working directory or task branch.");
    const reconciliation = app.reconciliation.get(name);
    if (reconciliation && (!reconciliation.ready || mode === "branch" || (!keepCurrent && (app.review.latestRound(name)?.number ?? 0) <= reconciliation.round)))
      throw new Error("Review the merge suggestion before applying it to the manuscript.");
    // Older task-branch commits remain available, but can now be applied
    // through the same manuscript action. Never move or merge those branches.
    if (last && last.mode !== mode && (!last.done || mode === "branch"))
      throw new Error("Finish the pending delivery before applying to the manuscript.");
    if (last && last.mode === mode && (!last.done || (!reconciliation && last.accepted === task.accepted))) return this.finish(name, last);
    if (app.publisher.busy(name) || app.review.counts(name).pending) throw new Error("Finish reviewing every change before choosing a destination.");
    const before = reconciliation?.base ?? (last && last.mode !== "branch" ? last.accepted : task.base);
    const files = app.repo.changedFiles(before, task.accepted);
    if (!files.length && !reconciliation) throw new Error("This task has no accepted changes left to deliver.");
    const base = app.repo.blobs(before, files), accepted = app.repo.blobs(task.accepted, files);
    const data: Delivery = { mode, accepted: task.accepted, seq: app.store.one<{ seq: number }>("SELECT MAX(seq) AS seq FROM actions WHERE task=?", name)!.seq, done: false, writes: [] };
    const contents: Record<string, Buffer | null> = {};
    let current: Record<string, Buffer | null>;
    if (mode === "branch") {
      if (!message.trim() || message.length > 5000) throw new Error("Write a commit message (at most 5,000 characters).");
      data.branch = `papilot/${name}`;
      data.previous = last?.commit;
      // The base snapshot may include the author's uncommitted edits. Apply
      // only the accepted delta onto its original HEAD, never commit those edits.
      data.parent = last?.commit ?? app.repo.rev(`${task.base}^`);
      current = app.repo.blobs(data.parent, files);
      const ref = app.repo.text(["show-ref", "--verify", "--hash", `refs/heads/${data.branch}`], { check: false });
      if (ref !== (data.previous ?? "")) throw new Error("The task branch was changed outside Papilot. Nothing was committed.");
      this.assertBranchAvailable(data.branch);
    } else {
      this.assertNoMerge();
      current = Object.fromEntries(files.map(file => [file, readBytes(safePath(app.root, file))]));
    }
    for (const file of files) {
      const [merged, conflict] = merge3(current[file], base[file], accepted[file]);
      if (conflict) throw new DeliveryConflict(`Cannot deliver ${file}: it conflicts with the destination. Nothing was written. Revise the task and try again.`);
      contents[file] = merged;
      if (mode !== "branch" && !same(current[file], merged)) data.writes.push({ file, before: encode(current[file]), after: encode(merged) });
    }
    if (mode === "branch") {
      const tree = app.repo.treeWith(data.parent!, contents);
      data.commit = app.repo.text(["commit-tree", tree, "-p", data.parent!, "-m", message.trim()]);
    }
    if (mode === "commit" && (!message.trim() || message.length > 5000)) throw new Error("Write a commit message (at most 5,000 characters).");
    if (mode === "commit") planCurrentCommit(app.repo, data, before, files, message, confirmation);
    this.save(name, data);
    return this.finish(name, data);
  }
  private assertBranchAvailable(branch: string) {
    if (this.app.repo.text(["worktree", "list", "--porcelain"]).split("\n").includes(`branch refs/heads/${branch}`))
      throw new Error("The task branch is checked out. Switch that worktree to another branch before committing here.");
  }
  private assertNoMerge() {
    if (fs.existsSync(path.resolve(this.app.root, this.app.repo.text(["rev-parse", "--git-path", "MERGE_HEAD"]))))
      throw new Error("Finish or abort the merge before applying changes.");
  }
  finish(name: string, data: Delivery) {
    if (data.done) { if (data.mode !== "branch") this.app.reconciliation.clear(name); return this.result(data); }
    const app = this.app;
    if (data.mode === "branch") {
      const ref = `refs/heads/${data.branch}`;
      const current = app.repo.text(["show-ref", "--verify", "--hash", ref], { check: false });
      if (current !== data.commit) {
        this.assertBranchAvailable(data.branch!);
        app.repo.run(["update-ref", ref, data.commit!, data.previous ?? "0".repeat(data.commit!.length)]);
      }
    } else {
      this.assertNoMerge();
      const writes = data.writes.map(write => ({ ...write, target: safePath(app.root, write.file) }));
      const validate = () => {
        for (const write of writes) {
          const current = readBytes(write.target);
          if (!same(current, decode(write.before)) && !same(current, decode(write.after)))
            throw new Error(`Cannot finish delivery: ${write.file} changed. Restore it to its state before delivery and retry.`);
        }
      };
      const applyFiles = () => { for (const write of writes) writeOrDelete(write.target, decode(write.after)); };
      if (data.mode === "commit") finishCurrentCommit(app.repo, data, validate, applyFiles);
      else { validate(); applyFiles(); }
    }
    this.save(name, { ...data, done: true, writes: [] });
    if (data.mode !== "branch") this.app.reconciliation.clear(name);
    return this.result(data);
  }
  result(data: Delivery) {
    const { mode, accepted, branch, commit } = data;
    return { mode, accepted, ...(branch ? { branch, commit } : {}) };
  }
  recover() {
    for (const row of this.app.store.all<{ task: string; data: Delivery }>("SELECT * FROM deliveries")) {
      if (row.data.done && row.data.mode !== "branch" && this.app.reconciliation.get(row.task) && this.app.tasks.get(row.task).accepted === row.data.accepted)
        this.app.reconciliation.clear(row.task);
      else if (!row.data.done) try { this.finish(row.task, row.data); } catch { /* Retain the journal for an explicit retry. */ }
    }
  }
}
