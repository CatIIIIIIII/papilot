import fs from "node:fs";
import path from "node:path";
// Papilot 0.9.4 and earlier named a paper's state after the review engine's
// former standalone skill: .git/latex-review/, refs/latex-review/ and
// .latex-review.json in the working tree. A paper moves to the current names
// the first time a newer version opens it. Nothing else reads these names.
const FOLDER = "latex-review", REFS = "refs/latex-review/", SETTINGS = ".latex-review.json";
type Git = (args: string[], input?: string) => string;
const lstat = (file: string) => fs.lstatSync(file, { throwIfNoEntry: false });
// The Git directory that linked worktrees share with the main checkout.
function commonDir(gitDir: string) {
  try {
    return path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
  } catch {
    return gitDir;
  }
}
/** Moves a repository's state and refs from the former names to `folder`
 *  and `refs`. Each Git directory has a state folder of its own: the main
 *  checkout's, and each linked worktree's, which is a paper's whole state
 *  when that worktree was added as a paper. Several processes may open the
 *  paper at once: each step is atomic, and one that another process
 *  completed counts as done. Once nothing is left to move, this only checks
 *  a few paths, without running Git. */
export function moveLegacyState(gitDir: string, git: Git, folder: string, refs: string) {
  const common = commonDir(gitDir), worktrees = path.join(common, "worktrees");
  if (legacyRefs(common)) {
    moveRefs(git, refs);
    removeEmpty(path.join(common, "refs", "latex-review"));
  }
  for (const dir of [common, ...(lstat(worktrees)?.isDirectory() ? fs.readdirSync(worktrees).map((name) => path.join(worktrees, name)) : [])])
    try {
      moveFolder(path.join(dir, FOLDER), path.join(dir, folder));
    } catch (error) {
      // Another paper of the repository, whose earlier server may still hold
      // its files on Windows, moves when that paper opens.
      if (path.resolve(dir) === path.resolve(gitDir)) throw error;
    }
}
/** The former server folder of a Git directory, while its state has not
 *  moved: a review server of an earlier version may still be running. */
export function legacyServerHome(gitDir: string) {
  const old = path.join(gitDir, FOLDER);
  return lstat(old)?.isDirectory() ? path.join(old, "server") : null;
}
// Loose or packed refs under the former names. Git reads a reftable itself.
function legacyRefs(common: string) {
  if (lstat(path.join(common, "reftable"))) return true;
  try {
    if (fs.readdirSync(path.join(common, "refs", "latex-review"), { recursive: true, withFileTypes: true }).some((entry) => !entry.isDirectory())) return true;
  } catch { /* None loose. */ }
  try {
    return fs.readFileSync(path.join(common, "packed-refs"), "utf8").includes(" " + REFS);
  } catch {
    return false;
  }
}
// Git deletes moved refs but leaves their folders.
function removeEmpty(dir: string) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) removeEmpty(path.join(dir, entry.name));
    fs.rmdirSync(dir);
  } catch { /* Missing, or holds refs that stayed. */ }
}
// Rounds, jobs, cached builds and their SyncTeX record absolute paths into
// the state folder, and Papilot names a manuscript build by its PDF's path.
// A link under the former name keeps every one of them valid; SyncTeX cannot
// be rewritten to a path of another length.
function moveFolder(from: string, to: string) {
  const found = lstat(from);
  if (!found || found.isSymbolicLink() || !found.isDirectory()) return;
  // Both exist when an older version could not use the link and started
  // over. The current state stays, and the older one is left for the author.
  if (lstat(to)) return;
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (lstat(from)?.isDirectory() || !lstat(to))
      throw new Error(
        `Papilot could not move ${from} to ${to} (${(error as Error).message}). Quit other programs that have this paper open, then try again.`,
      );
    return;
  }
  try {
    // A Windows junction needs no special permission, but an absolute target.
    fs.symlinkSync(process.platform === "win32" ? to : path.basename(to), from, "junction");
  } catch {
    /* Another process linked it, or the file system has no links: earlier
       builds then compile again, as after the cache is pruned. */
  }
}
function moveRefs(git: Git, refs: string) {
  const list = (prefix: string) =>
    new Map(git(["for-each-ref", "--format=%(refname) %(objectname)", prefix])
      .split("\n").filter(Boolean).map((line) => line.split(" ") as [string, string]));
  for (let attempt = 1; ; attempt++) {
    const taken = list(refs),
      // A ref whose new name exists already stays, and keeps its commits.
      moves = [...list(REFS)].map(([ref, oid]) => [ref, refs + ref.slice(REFS.length), oid])
        .filter(([, target]) => !taken.has(target));
    if (!moves.length) return;
    try {
      // One transaction: every ref moves, or none does when another process
      // moved some meanwhile; the next attempt sees what is left.
      git(["update-ref", "--stdin"], moves.map(([ref, target, oid]) => `create ${target} ${oid}\ndelete ${ref} ${oid}\n`).join(""));
      return;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}
/** The settings of `.latex-review.json` in the working tree, or null if
 *  there is none. A file that cannot be used is reported, as it was. */
export function legacySettings(root: string): Record<string, unknown> | null {
  const file = path.join(root, SETTINGS), found = lstat(file);
  if (!found) return null;
  if (found.isSymbolicLink()) throw new Error(`${SETTINGS} must not be a symbolic link.`);
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${SETTINGS} is not valid JSON.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${SETTINGS} must contain an object.`);
  return value as Record<string, unknown>;
}
