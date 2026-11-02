import { randomUUID } from "node:crypto";
import type { App } from "../server.ts";
import { merge3 } from "./git.ts";
import { readBytes, same, writeOrDelete } from "./files.ts";
import { safePath } from "./review.ts";
import { GENERATED, revisionReader } from "./tasks.ts";
import { buildOutline, resolveSections, selectedRanges } from "./outline.ts";

export interface Reconciliation {
  id: string;
  round: number;
  files: string[];
  sourceBase: string;
  sourceAccepted: string;
  base: string;
  reviewBase: string;
  worktreeBefore: string;
  ready: boolean;
  intent?: { mode: "workspace" | "commit"; message: string };
}

// A conflict is another proposal in the same task. The manuscript and its
// index stay untouched; only the private proposal is rebased for PDF review.
export class Reconciliations {
  constructor(public app: App) {}
  get(name: string) {
    return this.app.store.one<{ data: Reconciliation }>("SELECT data FROM reconciliations WHERE task=?", name)?.data;
  }
  intent(name: string, intent: NonNullable<Reconciliation["intent"]>) {
    const data = { ...this.get(name)!, intent };
    this.app.store.execute("UPDATE reconciliations SET data=? WHERE task=?", JSON.stringify(data), name);
    return data;
  }
  clear(name: string) {
    this.app.store.execute("DELETE FROM reconciliations WHERE task=?", name);
  }
  start(name: string, force = false, intent?: Reconciliation["intent"]) {
    const app = this.app, task = app.tasks.get(name), previous = this.get(name);
    if (previous && (!previous.ready || (!force && (app.review.latestRound(name)?.number ?? 0) <= previous.round)))
      return this.prepare(name, previous);
    const worktreeBefore = app.tasks.snapshot(task);
    if (app.repo.changedFiles(task.accepted, worktreeBefore).length)
      throw new Error("Review the latest task edits before applying the manuscript changes.");
    const delivered = app.delivery.get(name);
    const sourceBase = previous?.base ?? (delivered && delivered.mode !== "branch" ? delivered.accepted : task.base);
    const base = app.repo.snapshot([app.project.source_dir, ...task.scope.paths], GENERATED);
    const changed = app.repo.changedFiles(sourceBase, task.accepted);
    const old = app.repo.blobs(sourceBase, changed), accepted = app.repo.blobs(task.accepted, changed), current = app.repo.blobs(base, changed);
    const files: string[] = [], contents: Record<string, Buffer | null> = {};
    for (const file of changed) {
      const [merged, conflict] = merge3(current[file], old[file], accepted[file]);
      if (!conflict) contents[file] = merged;
      else {
        files.push(file);
        // Keep clean hunks even in a file with conflicts. At overlapping
        // hunks keep the latest manuscript as the baseline for human review.
        const [kept, failed] = merge3(current[file], old[file], accepted[file], true);
        contents[file] = failed ? current[file] : kept;
      }
    }
    if (!files.length) return null; // The author may have resolved it meanwhile.
    const reviewBase = app.repo.commitWith(base, contents, "latex-review: prepare merge review");
    const data: Reconciliation = { id: randomUUID(), round: app.review.latestRound(name)?.number ?? 0, files, sourceBase, sourceAccepted: task.accepted, base, reviewBase, worktreeBefore, ready: false, ...(intent ? { intent } : {}) };
    for (const file of app.repo.changedFiles(worktreeBefore, reviewBase)) safePath(task.worktree, file);
    // Keep the three versions available to the agent and across Git GC.
    for (const [kind, rev] of Object.entries({ original: sourceBase, proposed: task.accepted, current: base, before: worktreeBefore, review: reviewBase }))
      app.repo.updateRef(`refs/latex-review/${name}/merge/${data.id}/${kind}`, rev);
    app.store.execute("INSERT OR REPLACE INTO reconciliations(task,data) VALUES(?,?)", name, JSON.stringify(data));
    return this.prepare(name, data);
  }
  prepare(name: string, data: Reconciliation) {
    if (data.ready) return data;
    const app = this.app, task = app.tasks.get(name);
    const files = app.repo.changedFiles(data.worktreeBefore, data.reviewBase);
    const before = app.repo.blobs(data.worktreeBefore, files), after = app.repo.blobs(data.reviewBase, files);
    const writes = files.map(file => ({ file, path: safePath(task.worktree, file) }));
    for (const write of writes) {
      const current = readBytes(write.path);
      if (!same(current, before[write.file]) && !same(current, after[write.file]))
        throw new Error("The task changed while preparing its merge review. Keep those edits and retry after reviewing them.");
    }
    let scope = task.scope;
    if (scope.sections.length) {
      const outline = buildOutline(revisionReader(app.repo, data.reviewBase, app.project.doc_dir), app.project.main);
      const [ranges, sections] = selectedRanges(outline.nodes, resolveSections(outline.nodes, scope.sections.map(section => section.id.replace(/^label:/, ""))));
      scope = { ranges, sections, paths: Object.keys(ranges).sort() };
    }
    for (const write of writes) writeOrDelete(write.path, after[write.file]);
    app.repo.updateRef(`refs/latex-review/${name}/base`, data.reviewBase);
    app.repo.updateRef(`refs/latex-review/${name}/accepted`, data.reviewBase);
    app.store.transaction(() => {
      app.store.execute("UPDATE tasks SET base=?,accepted=?,scope=? WHERE name=?", data.reviewBase, data.reviewBase, JSON.stringify(scope), name);
      app.store.execute("UPDATE reconciliations SET data=? WHERE task=?", JSON.stringify({ ...data, ready: true }), name);
    });
    return { ...data, ready: true };
  }
  recover() {
    for (const row of this.app.store.all<{ task: string; data: Reconciliation }>("SELECT * FROM reconciliations"))
      if (!row.data.ready) try { this.prepare(row.task, row.data); } catch { /* Retry without overwriting intervening edits. */ }
  }
}
