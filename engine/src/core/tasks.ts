import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Repo, cleanPath } from "./git.ts";
import { readJson, writeJson, now } from "./files.ts";
import { buildOutline, resolveSections, selectedRanges } from "./outline.ts";
import type { Task, Scope } from "../types.ts";
import type { App } from "../server.ts";
export const GENERATED = [
  ".aux",
  ".log",
  ".out",
  ".toc",
  ".lof",
  ".lot",
  ".loe",
  ".fls",
  ".fdb_latexmk",
  ".synctex.gz",
  ".bbl",
  ".blg",
  ".bcf",
  ".run.xml",
  ".xdv",
  ".dvi",
  ".nav",
  ".snm",
  ".vrb",
  ".idx",
  ".ilg",
  ".ind",
];
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
export function taskMarker(folder: string): [string, string | null] {
  const repo = new Repo(folder),
    marker = readJson<{ root: string; task: string } | null>(
      path.join(repo.gitDir(), "latex-review.json"),
      null,
    );
  return marker ? [marker.root, marker.task] : [repo.toplevel(), null];
}
export async function revisionReaderAsync(repo: Repo, rev: string, folder: string) {
  const files = (await repo.runAsync(["ls-tree", "-r", "-z", "--name-only", rev, ...(folder ? ["--", folder] : [])]))
      .toString().split("\0").filter((p) => p.endsWith(".tex")),
    blobs = await repo.blobsAsync(rev, files);
  return (file: string) => blobs[file]?.toString() ?? null;
}
export function revisionReader(repo: Repo, rev: string, folder: string) {
  const files = repo.files(rev, folder).filter((p) => p.endsWith(".tex")),
    blobs = repo.blobs(rev, files);
  return (file: string) => blobs[file]?.toString() ?? null;
}
export class Tasks {
  constructor(public app: App) {}
  get(name: string, openOnly = true): Task {
    const task = this.app.store.one<Task>(
      "SELECT * FROM tasks WHERE name=?",
      name,
    );
    if (!task || (openOnly && task.closed))
      throw new Error(`No open review task named ${JSON.stringify(name)}.`);
    return task;
  }
  list() {
    return this.app.store.all<Task>(
      "SELECT * FROM tasks WHERE closed IS NULL ORDER BY created",
    );
  }
  snapshot(task: Task) {
    return new Repo(task.worktree).snapshot(
      [this.app.project.source_dir, ...task.scope.paths],
      GENERATED,
    );
  }
  snapshotAsync(task: Task) {
    return new Repo(task.worktree).snapshotAsync(
      [this.app.project.source_dir, ...task.scope.paths],
      GENERATED,
    );
  }
  create(
    name?: string,
    title?: string,
    sections: string[] = [],
    files: string[] = [],
    deferred = false,
  ): Task {
    const reserved = this.reserve(name, title, sections, files);
    if ("existing" in reserved) return reserved.existing;
    const base = this.app.repo.snapshot([this.app.project.source_dir, ...reserved.paths], GENERATED);
    const scope = this.scopeOf(sections.length ? revisionReader(this.app.repo, base, this.app.project.doc_dir) : null, sections, reserved.paths);
    fs.mkdirSync(path.dirname(reserved.worktree), { recursive: true });
    this.app.repo.run(["worktree", "add", "--detach", reserved.worktree, base]);
    return this.record(reserved, base, scope, deferred);
  }
  /** `create` for the server: the snapshot and the checkout of the new
   *  worktree, seconds for a large paper, run while it answers requests. */
  async createAsync(
    name?: string,
    title?: string,
    sections: string[] = [],
    files: string[] = [],
    deferred = false,
  ): Promise<Task> {
    const reserved = this.reserve(name, title, sections, files);
    if ("existing" in reserved) return reserved.existing;
    this.creating.add(reserved.name);
    try {
      // The manuscript is read between writes, which may be changing it; the
      // much longer checkout of the worktree is not.
      const base = await this.app.exclusive(() => this.app.repo.snapshotAsync([this.app.project.source_dir, ...reserved.paths], GENERATED));
      const scope = this.scopeOf(sections.length ? await revisionReaderAsync(this.app.repo, base, this.app.project.doc_dir) : null, sections, reserved.paths);
      await fs.promises.mkdir(path.dirname(reserved.worktree), { recursive: true });
      await this.app.repo.runAsync(["worktree", "add", "--detach", reserved.worktree, base]);
      return this.record(reserved, base, scope, deferred);
    } finally {
      this.creating.delete(reserved.name);
    }
  }
  // Names of tasks whose worktree is being created.
  private creating = new Set<string>();
  // The task's name, title, worktree and scope paths, or the open task that
  // already covers this request.
  private reserve(name: string | undefined, title: string | undefined, sections: string[], files: string[]): { existing: Task } | { name: string; title: string; worktree: string; paths: string[] } {
    const { app } = this,
      project = app.project;
    if (sections.length && files.length)
      throw new Error("Choose sections or files for the scope, not both.");
    title = (title || name || "LaTeX review").trim().slice(0, 120);
    const explicit = Boolean(name);
    name ||= slug(title) || "review-" + randomBytes(3).toString("hex");
    if (!NAME.test(name))
      throw new Error(
        "Task names use lowercase letters, digits and hyphens (at most 64 characters).",
      );
    let candidate = name,
      suffix = 1;
    for (;; candidate = `${name.slice(0, 60)}-${++suffix}`) {
      if (this.creating.has(candidate)) {
        if (explicit) throw new Error(`Task ${JSON.stringify(name)} is being created. Try again in a moment.`);
        continue;
      }
      const existing = app.store.one<Task>(
        "SELECT * FROM tasks WHERE name=?",
        candidate,
      );
      if (!existing || existing.closed) break;
      if (this.matches(existing, sections, files)) return { existing };
      if (explicit)
        throw new Error(
          `Task ${JSON.stringify(name)} already exists with a different scope. Finish it first or choose another name.`,
        );
    }
    name = candidate;
    if (!app.repo.hasHead())
      throw new Error(
        "The repository needs at least one commit before a review can start.",
      );
    if (
      app.repo.text(["for-each-ref", "--count=1", `refs/latex-review/${name}/`])
    )
      throw new Error(
        `Task name ${JSON.stringify(name)} is still used by another working tree.`,
      );
    const worktree = path.join(project.worktrees, name);
    if (fs.existsSync(worktree))
      throw new Error(
        `The folder ${worktree} already exists. Remove it or choose another name.`,
      );
    return { name, title, worktree, paths: files.map(cleanPath) };
  }
  private scopeOf(read: ((file: string) => string | null) | null, sections: string[], paths: string[]): Scope {
    const project = this.app.project;
    if (!sections.length || !read)
      return {
        sections: [],
        ranges: null,
        paths: paths.length ? paths : [project.source_dir],
      };
    const outline = buildOutline(read, project.main);
    const [ranges, chosen] = selectedRanges(
      outline.nodes,
      resolveSections(outline.nodes, sections),
    );
    return { sections: chosen, ranges, paths: Object.keys(ranges).sort() };
  }
  // Records a task whose worktree was just checked out at `base`.
  private record({ name, title, worktree }: { name: string; title: string; worktree: string }, base: string, scope: Scope, deferred: boolean) {
    const { app } = this;
    try {
      writeJson(path.join(new Repo(worktree).gitDir(), "latex-review.json"), {
        task: name,
        root: app.project.root,
      });
      app.repo.updateRef(`refs/latex-review/${name}/base`, base);
      app.store.transaction(() => {
        app.store.execute(
          "DELETE FROM writes WHERE action IN (SELECT id FROM actions WHERE task=?)",
          name,
        );
        app.store.execute("DELETE FROM tasks WHERE name=?", name);
        for (const table of ["rounds", "actions", "messages", "jobs", "deliveries", "reconciliations"])
          app.store.execute(`DELETE FROM ${table} WHERE task=?`, name);
        app.store.execute(
          "INSERT INTO tasks(name,title,worktree,base,accepted,scope,created,deferred) VALUES(?,?,?,?,?,?,?,?)",
          name,
          title,
          worktree,
          base,
          base,
          JSON.stringify(scope),
          now(),
          Number(deferred),
        );
      });
    } catch (error) {
      app.repo.run(["worktree", "remove", "--force", worktree], {
        check: false,
      });
      app.repo.deleteRefs(`refs/latex-review/${name}/`);
      throw error;
    }
    return this.get(name);
  }
  matches(task: Task, sections: string[], files: string[]) {
    if (!sections.length && !files.length) return true;
    if (sections.length) {
      const known = new Set(
        task.scope.sections.flatMap((s) => [
          s.id,
          s.id.replace(/^label:/, ""),
          s.number,
          s.title,
        ]),
      );
      return sections.every((s) => known.has(s.trim().replace(/^label:/, "")));
    }
    return (
      task.scope.ranges === null &&
      JSON.stringify(files.map(cleanPath).sort()) ===
        JSON.stringify([...task.scope.paths].sort())
    );
  }
  /** Closes the task and removes its worktree, after every other write of
   *  the review engine; removing a large worktree takes a while. */
  async finish(name: string, force = false) {
    const result = await this.app.exclusive(() => this.finishNow(name, force));
    await this.app.publisher.pruneCache();
    return result;
  }
  private async finishNow(name: string, force: boolean) {
    this.app.delivery.assertReady(name);
    const app = this.app,
      task = this.get(name);
    if (app.publisher.busy(name))
      throw new Error(
        "A round is still being built. Wait for it before finishing.",
      );
    const counts = app.review.counts(name),
      problems: string[] = [];
    if (counts.pending || counts.commented)
      problems.push(
        `${counts.pending} pending and ${counts.commented} commented changes`,
      );
    const leftover = fs.existsSync(task.worktree)
      ? await app.repo.changedFilesAsync(task.accepted, await this.snapshotAsync(task))
      : [];
    if (leftover.length)
      problems.push(
        "edits not in the manuscript in " + leftover.slice(0, 5).join(", "),
      );
    if (problems.length && !force)
      throw new Error(
        `The task still has ${problems.join("; ")}. Publish and finish the review first, or use --force to discard them.`,
      );
    if (fs.existsSync(task.worktree))
      await app.repo.runAsync(["worktree", "remove", "--force", task.worktree]);
    await app.repo.runAsync(["worktree", "prune"], { check: false });
    await app.repo.deleteRefsAsync(`refs/latex-review/${name}/`);
    await fs.promises.rm(path.join(app.state, "rounds", name), {
      recursive: true,
      force: true,
    });
    app.store.execute("UPDATE tasks SET closed=? WHERE name=?", now(), name);
    return {
      changed: await app.repo.changedFilesAsync(task.base, task.accepted),
      discarded: counts,
    };
  }
}
