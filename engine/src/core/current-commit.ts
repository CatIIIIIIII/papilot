import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Repo } from "./git.ts";
import { merge3 } from "./git.ts";
import type { Delivery } from "../types.ts";

export interface CombinedCommitReview { token: string; files: string[]; diff: string }
export class CommitNeedsReview extends Error {
  constructor(public review: CombinedCommitReview) { super("Earlier edits to the same passages need to be included. Review the combined commit or apply without committing."); }
}

// Project only the task delta onto HEAD. The worktree and staging area are
// separate destinations: neither is used as the content of the commit.
export function planCurrentCommit(repo: Repo, data: Delivery, before: string, files: string[], message: string, confirmation?: string) {
  const ref = repo.text(["symbolic-ref", "-q", "HEAD"], { check: false });
  if (!ref.startsWith("refs/heads/")) throw new Error("Open a branch to commit this task, or apply it without committing.");
  const parent = repo.rev("HEAD"), index = repo.text(["write-tree"]);
  const base = repo.blobs(before, files), accepted = repo.blobs(data.accepted, files), head = repo.blobs(parent, files), staged = repo.blobs(index, files);
  const committed: Record<string, Buffer | null> = {}, nextIndex: Record<string, Buffer | null> = {};
  const dependencies: string[] = [];
  for (const file of files) {
    let [content, conflict] = merge3(head[file], base[file], accepted[file]);
    if (conflict) {
      // Include only the overlapping earlier passages, never the whole dirty
      // file. This is a proposal until the author confirms its exact diff.
      [content, conflict] = merge3(accepted[file], base[file], head[file], true);
      if (conflict) throw new Error(`The earlier changes in ${file} cannot be included automatically. Apply to workspace to save your reviewed result without a commit.`);
      dependencies.push(file);
    }
    let [combined, indexConflict] = merge3(staged[file], head[file], content);
    if (indexConflict && dependencies.includes(file) && !merge3(staged[file], base[file], accepted[file])[1])
      [combined, indexConflict] = merge3(content, head[file], staged[file], true);
    if (indexConflict) throw new Error(`A different version of ${file} is already selected for another commit. Apply to workspace to save this result without changing that selection.`);
    committed[file] = content;
    nextIndex[file] = combined;
  }
  const tree = repo.treeWith(parent, committed);
  if (tree === repo.treeId(parent)) throw new Error("These changes are already in the current commit. Apply without committing to finish this task.");
  if (dependencies.length || confirmation) {
    const token = createHash("sha256").update(JSON.stringify([ref, parent, index, before, data.accepted, tree, data.writes])).digest("hex");
    if (confirmation !== token) {
      const diff = repo.text(["diff", "--no-ext-diff", "--no-textconv", parent, tree, "--"]);
      if (diff.length > 500000) throw new Error("The combined changes are too large to preview here. Apply to workspace and review them in Git before committing.");
      throw new CommitNeedsReview({ token, files: dependencies, diff });
    }
  }
  data.branch = ref.slice("refs/heads/".length);
  data.parent = parent;
  data.indexBefore = index;
  data.indexAfter = repo.treeWith(index, nextIndex);
  data.commit = repo.text(["commit-tree", tree, "-p", parent, "-m", message.trim()]);
}

// Hold Git's index lock while checking and installing the recorded result.
// CAS on the branch prevents updating the wrong or concurrently moved HEAD.
// A retry recognizes our commit and completes its files/index without a
// duplicate commit. Unrelated staged entries (including their flags) survive.
export function finishCurrentCommit(repo: Repo, data: Delivery, validateFiles: () => void, writeFiles: () => void) {
  const index = path.resolve(repo.root, repo.text(["rev-parse", "--git-path", "index"]));
  const lock = index + ".lock";
  let fd: number;
  try { fd = fs.openSync(lock, "wx", fs.existsSync(index) ? fs.statSync(index).mode & 0o777 : 0o644); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Another Git operation is using the staging area. Wait for it to finish, then retry.");
    throw error;
  }
  let temp: string | undefined;
  try {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "papilot-task-index-"));
    const ref = `refs/heads/${data.branch}`;
    if (repo.text(["symbolic-ref", "-q", "HEAD"], { check: false }) !== ref)
      throw new Error("The current branch changed. Return to the original branch before retrying this task commit.");
    const head = repo.rev("HEAD");
    if (head !== data.parent && head !== data.commit)
      throw new Error("The current branch moved during this task commit. Nothing else was changed; inspect the Git history before retrying.");
    const target = path.join(temp, "index");
    fs.copyFileSync(index, target);
    const env = { ...process.env, GIT_INDEX_FILE: target };
    const currentIndex = repo.text(["write-tree"], { env });
    if (currentIndex !== data.indexBefore && currentIndex !== data.indexAfter)
      throw new Error("The staged changes changed during this task commit. Nothing else was changed; restore the previous staging selection before retrying.");
    validateFiles();
    if (currentIndex !== data.indexAfter) {
      const changed = repo.changedFiles(data.indexBefore!, data.indexAfter!);
      for (const file of changed) {
        const blob = repo.blob(data.indexAfter!, file);
        if (blob === null) repo.run(["update-index", "--force-remove", "--", file], { env });
        else repo.run(["update-index", "--add", "--cacheinfo", `${repo.mode(data.indexAfter!, file)},${repo.hashObject(blob)},${file}`], { env });
      }
    }
    if (repo.text(["write-tree"], { env }) !== data.indexAfter) throw new Error("Could not prepare the task's staging result.");
    fs.writeFileSync(fd, fs.readFileSync(target));
    fs.fsyncSync(fd);
    if (head !== data.commit) repo.run(["update-ref", "-m", "Papilot: commit reviewed task", ref, data.commit!, data.parent!]);
    writeFiles();
    fs.renameSync(lock, index);
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  }
}
