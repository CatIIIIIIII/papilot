import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { capture, run, startTracked, which } from "./process.ts";
import { same } from "./files.ts";
const IDENTITY = {
  GIT_AUTHOR_NAME: "latex-review",
  GIT_AUTHOR_EMAIL: "latex-review@localhost",
  GIT_COMMITTER_NAME: "latex-review",
  GIT_COMMITTER_EMAIL: "latex-review@localhost",
};
export class GitError extends Error {}
let binary: string | undefined;
export function gitBinary() {
  if (binary) return binary;
  binary = which("git") ?? "git";
  try {
    const candidate = path.join(
      run(binary, ["--exec-path"]).stdout.toString().trim(),
      "git",
    );
    fs.accessSync(candidate, fs.constants.X_OK);
    binary = candidate;
  } catch {
    /* The PATH executable remains usable. */
  }
  return binary;
}
// A repository's Git directory, looked up once: every build and connection
// asks for it, and each lookup would run Git. It is looked up again if the
// directory disappears, as when a repository is moved.
const gitDirs = new Map<string, string>();
export function gitDirOf(root: string) {
  let dir = gitDirs.get(root);
  if (!dir || !fs.existsSync(dir)) {
    dir = new Repo(root).gitDir();
    gitDirs.set(root, dir);
  }
  return dir;
}
export const within = (file: string, scopes: readonly string[]) =>
  scopes.some(
    (scope) =>
      !scope ||
      scope === "." ||
      file === scope ||
      file.startsWith(scope.replace(/\/+$/, "") + "/"),
  );
export function cleanPath(value: string) {
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/").filter((p) => p && p !== ".");
  if (normalized.startsWith("/") || parts.includes("..") || parts[0] === ".git")
    throw new Error(`Use a repository-relative path: ${value}`);
  return parts.join("/");
}
function temporary<T>(prefix: string, work: (folder: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return work(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// `ls-tree -r -l -z` output as blob entries.
function parseEntries(output: Buffer) {
  return output.toString().split("\0").filter(Boolean).flatMap(entry => {
    const tab = entry.indexOf("\t"), [mode, type, oid, size] = entry.slice(0, tab).split(/ +/);
    return type === "blob" ? [{ mode, oid, size: Number(size), file: entry.slice(tab + 1) }] : [];
  });
}
// `cat-file --batch` output for these names, in order.
function parseBlobs(names: string[], output: Buffer) {
  const result: Record<string, Buffer | null> = {};
  let offset = 0;
  for (const name of names) {
    const end = output.indexOf(10, offset),
      header = output.subarray(offset, end).toString().split(" ");
    offset = end + 1;
    const size = Number(header[2]);
    result[name] =
      header[1] === "blob" && Number.isFinite(size)
        ? output.subarray(offset, offset + size)
        : null;
    if (Number.isFinite(size)) offset += size + 1;
  }
  return result;
}
// Copies an index file and keeps its modification time: Git compares a file's
// modification time with the index's own to catch edits made in the same
// instant the index was written, so a copy must not look newer than it is.
function copyIndex(from: string, to: string) {
  try {
    const stat = fs.statSync(from);
    fs.copyFileSync(from, to);
    fs.utimesSync(to, stat.atime, stat.mtime);
    return true;
  } catch {
    return false;
  }
}
// Where each checkout keeps the index its snapshots start from, and its own
// index. Linked worktrees have their own Git directory for both.
const indexes = new Map<string, { saved: string; own: string }>();
export class Repo {
  constructor(public root: string) {
    this.root = path.resolve(root);
  }
  run(
    args: string[],
    options: {
      input?: string | Buffer;
      env?: NodeJS.ProcessEnv;
      check?: boolean;
      timeout?: number;
    } = {},
  ) {
    try {
      return run(
        gitBinary(),
        ["-c", "core.quotepath=off", "--literal-pathspecs", ...args],
        { cwd: this.root, ...options },
      ).stdout;
    } catch (error) {
      throw new GitError((error as Error).message);
    }
  }
  text(args: string[], options: Parameters<Repo["run"]>[1] = {}) {
    return this.run(args, options).toString().trim();
  }
  /** `run` for servers: Git runs while the event loop answers other requests. */
  async runAsync(args: string[], options: Parameters<Repo["run"]>[1] = {}) {
    try {
      return (await capture(
        gitBinary(),
        ["-c", "core.quotepath=off", "--literal-pathspecs", ...args],
        { cwd: this.root, ...options },
      )).stdout;
    } catch (error) {
      throw new GitError((error as Error).message);
    }
  }
  async textAsync(args: string[], options: Parameters<Repo["run"]>[1] = {}) {
    return (await this.runAsync(args, options)).toString().trim();
  }
  toplevel() {
    return fs.realpathSync(this.text(["rev-parse", "--show-toplevel"]));
  }
  gitDir() {
    return fs.realpathSync(this.text(["rev-parse", "--absolute-git-dir"]));
  }
  rev(name: string) {
    return this.text(["rev-parse", "--verify", "--quiet", name + "^{commit}"]);
  }
  hasHead() {
    return (
      this.run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
        check: false,
      }).length > 0
    );
  }
  blobs(rev: string, paths: string[]) {
    const names = [...new Set(paths)];
    if (!names.length) return {} as Record<string, Buffer | null>;
    return parseBlobs(names, this.run(["cat-file", "--batch", "-z"], {
      input: names.map((p) => `${rev}:${p}\0`).join(""),
    }));
  }
  async blobsAsync(rev: string, paths: string[]) {
    const names = [...new Set(paths)];
    if (!names.length) return {} as Record<string, Buffer | null>;
    return parseBlobs(names, await this.runAsync(["cat-file", "--batch", "-z"], {
      input: names.map((p) => `${rev}:${p}\0`).join(""),
    }));
  }
  blob(rev: string, file: string) {
    return this.blobs(rev, [file])[file];
  }
  files(rev: string, folder = "") {
    return this.run([
      "ls-tree",
      "-r",
      "-z",
      "--name-only",
      rev,
      ...(folder ? ["--", folder] : []),
    ])
      .toString()
      .split("\0")
      .filter(Boolean);
  }
  entries(rev: string, folder = "") {
    return parseEntries(this.run(["ls-tree", "-r", "-l", "-z", rev, ...(folder ? ["--", folder] : [])]));
  }
  async entriesAsync(rev: string, folder = "") {
    return parseEntries(await this.runAsync(["ls-tree", "-r", "-l", "-z", rev, ...(folder ? ["--", folder] : [])]));
  }
  changedFiles(before: string, after: string) {
    return this.run([
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      before,
      after,
    ])
      .toString()
      .split("\0")
      .filter(Boolean);
  }
  async changedFilesAsync(before: string, after: string) {
    return (await this.runAsync(["diff", "--name-only", "--no-renames", "-z", before, after]))
      .toString().split("\0").filter(Boolean);
  }
  mode(rev: string, file: string) {
    return this.text(["ls-tree", rev, "--", file]).split(/\s+/)[0] || null;
  }
  treeId(rev: string, folder = "") {
    return this.text([
      "rev-parse",
      folder ? `${rev}:${folder}` : `${rev}^{tree}`,
    ]);
  }
  treeIdAsync(rev: string, folder = "") {
    return this.textAsync(["rev-parse", folder ? `${rev}:${folder}` : `${rev}^{tree}`]);
  }
  hashObject(data: Buffer) {
    return this.text(["hash-object", "-w", "--stdin"], { input: data });
  }
  commitTree(tree: string, parent: string | null, message: string) {
    return this.text(
      [
        "commit-tree",
        "--no-gpg-sign",
        tree,
        ...(parent ? ["-p", parent] : []),
        "-m",
        message,
      ],
      { env: { ...process.env, ...IDENTITY } },
    );
  }
  updateRef(ref: string, value: string) {
    this.run(["update-ref", ref, value]);
  }
  revAsync(name: string) {
    return this.textAsync(["rev-parse", "--verify", "--quiet", name + "^{commit}"]);
  }
  async blobAsync(rev: string, file: string) {
    return (await this.blobsAsync(rev, [file]))[file];
  }
  async modeAsync(rev: string, file: string) {
    return (await this.textAsync(["ls-tree", rev, "--", file])).split(/\s+/)[0] || null;
  }
  hashObjectAsync(data: Buffer) {
    return this.textAsync(["hash-object", "-w", "--stdin"], { input: data });
  }
  commitTreeAsync(tree: string, parent: string | null, message: string) {
    return this.textAsync(
      ["commit-tree", "--no-gpg-sign", tree, ...(parent ? ["-p", parent] : []), "-m", message],
      { env: { ...process.env, ...IDENTITY } },
    );
  }
  async commitWithAsync(parent: string, contents: Record<string, Buffer | null>, message: string) {
    return this.commitTreeAsync(await this.treeWithAsync(parent, contents), parent, message);
  }
  async updateRefAsync(ref: string, value: string) {
    await this.runAsync(["update-ref", ref, value]);
  }
  async deleteRefsAsync(prefix: string) {
    const refs = (await this.textAsync(["for-each-ref", "--format=%(refname)", prefix])).split("\n").filter(Boolean);
    if (refs.length) await this.runAsync(["update-ref", "--stdin"], { input: refs.map((r) => `delete ${r}\n`).join("") });
  }
  deleteRefs(prefix: string) {
    const refs = this.text(["for-each-ref", "--format=%(refname)", prefix])
      .split("\n")
      .filter(Boolean);
    if (refs.length)
      this.run(["update-ref", "--stdin"], {
        input: refs.map((r) => `delete ${r}\n`).join(""),
      });
  }
  // The index a snapshot of this checkout starts from: the previous
  // snapshot's, or else the checkout's own. Either records each file's size
  // and modification time, so Git rehashes only files changed since; a fresh
  // index from read-tree would make it rehash every tracked file.
  private indexFiles() {
    let found = indexes.get(this.root);
    if (!found) {
      const [saved, own] = this.text(["rev-parse", "--git-path", "latex-review/snapshot-index", "--git-path", "index"])
        .split("\n").map((file) => path.resolve(this.root, file));
      indexes.set(this.root, found = { saved, own });
    }
    return found;
  }
  private keepIndex(index: string) {
    const { saved } = this.indexFiles(), temporary = `${saved}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(saved), { recursive: true });
      if (copyIndex(index, temporary)) fs.renameSync(temporary, saved);
    } catch { /* The next snapshot rehashes more files. */ }
    finally { fs.rmSync(temporary, { force: true }); }
  }
  // The working tree as a commit on HEAD: tracked files as they are on disk,
  // untracked files within `include` and newly staged files, without
  // touching the checkout's index.
  snapshot(include: string[] = [], exclude: readonly string[] = []) {
    const head = this.rev("HEAD");
    const staged = this.run(["diff", "--cached", "--name-only", "--diff-filter=A", "-z"])
      .toString().split("\0").filter(Boolean);
    const { saved, own } = this.indexFiles();
    const tree = temporary("latex-review-index-", (folder) => {
      const index = path.join(folder, "index"), env = { ...process.env, GIT_INDEX_FILE: index };
      // read-tree -m keeps the stat data of entries that match HEAD.
      const capture = () => {
        this.run(["read-tree", "-m", head], { env });
        this.run(["add", "-u"], { env });
        const chosen = this.chosen(this.run(["ls-files", "--others", "--exclude-standard", "-z"], { env }), staged, include, exclude);
        if (chosen.length)
          this.run(["add", "--pathspec-from-file=-", "--pathspec-file-nul"], { env, input: chosen.join("\0") + "\0" });
        return this.text(["write-tree"], { env });
      };
      let first: string;
      try {
        if (!copyIndex(saved, index) && !copyIndex(own, index)) throw new Error();
        first = capture();
      } catch {
        // An index with unresolved conflicts cannot be merged: start empty.
        fs.rmSync(index, { force: true });
        this.run(["read-tree", head], { env });
        first = capture();
      }
      if (first !== capture() || head !== this.rev("HEAD"))
        throw new GitError("Files changed while the snapshot was taken. Wait for saves to finish and retry.");
      this.keepIndex(index);
      return first;
    });
    return this.commitTree(tree, head, "latex-review snapshot");
  }
  /** `snapshot` for servers, which keep answering requests meanwhile. */
  async snapshotAsync(include: string[] = [], exclude: readonly string[] = []) {
    const head = await this.textAsync(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    const staged = (await this.runAsync(["diff", "--cached", "--name-only", "--diff-filter=A", "-z"]))
      .toString().split("\0").filter(Boolean);
    const { saved, own } = this.indexFiles();
    const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), "latex-review-index-"));
    try {
      const index = path.join(folder, "index"), env = { ...process.env, GIT_INDEX_FILE: index };
      const capture = async () => {
        await this.runAsync(["read-tree", "-m", head], { env });
        await this.runAsync(["add", "-u"], { env });
        const chosen = this.chosen(await this.runAsync(["ls-files", "--others", "--exclude-standard", "-z"], { env }), staged, include, exclude);
        if (chosen.length)
          await this.runAsync(["add", "--pathspec-from-file=-", "--pathspec-file-nul"], { env, input: chosen.join("\0") + "\0" });
        return this.textAsync(["write-tree"], { env });
      };
      let first: string;
      try {
        if (!copyIndex(saved, index) && !copyIndex(own, index)) throw new Error();
        first = await capture();
      } catch {
        await fs.promises.rm(index, { force: true });
        await this.runAsync(["read-tree", head], { env });
        first = await capture();
      }
      if (first !== await capture() || head !== await this.textAsync(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]))
        throw new GitError("Files changed while the snapshot was taken. Wait for saves to finish and retry.");
      this.keepIndex(index);
      return await this.textAsync(["commit-tree", "--no-gpg-sign", first, "-p", head, "-m", "latex-review snapshot"], { env: { ...process.env, ...IDENTITY } });
    } finally {
      await fs.promises.rm(folder, { recursive: true, force: true });
    }
  }
  // The untracked files a snapshot adds: those within `include` that no
  // excluded suffix names, and files staged as new.
  private chosen(untracked: Buffer, staged: string[], include: string[], exclude: readonly string[]) {
    return [...new Set([
      ...untracked.toString().split("\0").filter((p) => p && within(p, include) && !exclude.some((suffix) => p.endsWith(suffix))),
      ...staged.filter((p) => fs.existsSync(path.join(this.root, p))),
    ])].sort();
  }
  commitWith(
    parent: string,
    contents: Record<string, Buffer | null>,
    message: string,
  ) {
    return this.commitTree(this.treeWith(parent, contents), parent, message);
  }
  // The tree of `base`, a commit or a tree, with these files replaced.
  treeWith(parent: string, contents: Record<string, Buffer | null>) {
    return temporary("latex-review-index-", (folder) => {
      const env = {
        ...process.env,
        GIT_INDEX_FILE: path.join(folder, "index"),
      };
      this.run(["read-tree", parent], { env });
      for (const [file, data] of Object.entries(contents).sort()) {
        if (data === null)
          this.run(["update-index", "--force-remove", "--", file], { env });
        else
          this.run(
            [
              "update-index",
              "--add",
              "--cacheinfo",
              `${this.mode(parent, file) || "100644"},${this.hashObject(data)},${file}`,
            ],
            { env },
          );
      }
      return this.text(["write-tree"], { env });
    });
  }
  /** `treeWith` for servers: one index update for every file. */
  async treeWithAsync(parent: string, contents: Record<string, Buffer | null>) {
    const files = Object.keys(contents).sort();
    const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), "latex-review-index-"));
    try {
      const env = { ...process.env, GIT_INDEX_FILE: path.join(folder, "index") };
      await this.runAsync(["read-tree", parent], { env });
      if (!files.length) return await this.textAsync(["write-tree"], { env });
      const modes = new Map<string, string>(), absent = "0".repeat((await this.textAsync(["rev-parse", `${parent}^{tree}`])).length);
      for (const entry of (await this.runAsync(["ls-tree", "-z", parent, "--", ...files])).toString().split("\0").filter(Boolean))
        modes.set(entry.slice(entry.indexOf("\t") + 1), entry.split(" ")[0]);
      const lines = await Promise.all(files.map(async (file) => {
        const data = contents[file];
        if (data === null) return `0 ${absent}\t${file}`;
        return `${modes.get(file) || "100644"} ${await this.textAsync(["hash-object", "-w", "--stdin"], { input: data })}\t${file}`;
      }));
      await this.runAsync(["update-index", "--index-info"], { env, input: lines.join("\n") + "\n" });
      return await this.textAsync(["write-tree"], { env });
    } finally {
      await fs.promises.rm(folder, { recursive: true, force: true });
    }
  }
  // Write a revision's files under destination. Given an earlier export of
  // another tree, files with the same Git object are cloned from it
  // (copy-on-write where the file system supports it), so only changed files
  // are read from Git.
  async export(rev: string, folder: string, destination: string, base?: { root: string; tree: string }) {
    const previous = new Map<string, string>();
    const [before, after] = await Promise.all([base ? this.entriesAsync(base.tree) : [], this.entriesAsync(rev, folder)]);
    for (const entry of before) previous.set(entry.file, entry.mode + " " + entry.oid);
    const wanted = after.map(entry => {
      const relative = path.posix.relative(folder || ".", entry.file);
      cleanPath(relative);
      return { ...entry, relative, target: path.join(destination, relative) };
    });
    // On APFS, cp clones a whole folder far faster than creating each file
    // separately; files that are not in this tree are then removed again.
    let cloned = false;
    if (base && process.platform === "darwin" && !fs.existsSync(destination))
      try {
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        cloned = (await capture("/bin/cp", ["-c", "-R", base.root, destination], { check: false })).status === 0;
      }
      catch { /* Copy file by file below. */ }
    if (cloned) {
      const keep = new Set(wanted.map(entry => entry.relative));
      const prune = async (directory: string, prefix: string): Promise<void> => {
        await Promise.all((await fs.promises.readdir(directory, { withFileTypes: true })).map(item => {
          const relative = prefix + item.name, file = path.join(directory, item.name);
          if (item.isDirectory()) return prune(file, relative + "/");
          return keep.has(relative) ? undefined : fs.promises.rm(file, { force: true });
        }));
      };
      await prune(destination, "");
    } else {
      await fs.promises.rm(destination, { recursive: true, force: true });
      await fs.promises.mkdir(destination, { recursive: true });
    }
    const folders = new Set<string>(), stale = new Set<(typeof wanted)[number]>();
    for (const entry of wanted) {
      const directory = path.dirname(entry.target);
      if (!folders.has(directory)) { folders.add(directory); await fs.promises.mkdir(directory, { recursive: true }); }
    }
    // Unchanged files come from the earlier export, a batch at a time.
    const reuse = async (entry: (typeof wanted)[number]) => {
      const { relative, target } = entry;
      if (entry.mode !== "120000" && previous.get(relative) === entry.mode + " " + entry.oid) {
        const source = cloned ? target : path.join(base!.root, relative);
        try {
          // A compiler may have rewritten a file in the earlier export.
          const stat = await fs.promises.lstat(source);
          if (stat.isFile() && stat.size === entry.size) {
            if (!cloned) await fs.promises.copyFile(source, target, fs.constants.COPYFILE_FICLONE);
            if ((stat.mode & 0o777) !== (entry.mode === "100755" ? 0o755 : 0o644)) await fs.promises.chmod(target, entry.mode === "100755" ? 0o755 : 0o644);
            return;
          }
        } catch { /* Read this file from Git. */ }
      }
      // A cloned link or rewritten file is replaced, never written through.
      if (cloned) await fs.promises.rm(target, { force: true });
      stale.add(entry);
    };
    for (let at = 0; at < wanted.length; at += 64) await Promise.all(wanted.slice(at, at + 64).map(reuse));
    const entries = wanted.filter(entry => stale.has(entry));
    if (!entries.length) return;
    // Keep one Git process and stream each blob to disk. Collecting the entire
    // snapshot with blobs() both duplicates memory and hits spawnSync's buffer
    // limit for ordinary repositories containing PDFs and figures.
    const child = startTracked(() => spawn(gitBinary(), ["cat-file", "--batch"], {
      cwd: this.root, detached: true, stdio: ["pipe", "pipe", "pipe"],
    }));
    let stderr = "", timedOut = false;
    child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-65536); });
    child.stdin.on("error", () => { /* Report process failures through finished. */ });
    const finished = new Promise<Error | null>(resolve => {
      child.once("error", resolve);
      child.once("close", code => resolve(code === 0 && !timedOut ? null : new GitError(
        timedOut ? "Git snapshot export timed out." : stderr.trim() || `Git snapshot export failed (${code}).`,
      )));
    });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 300000);
    const output = child.stdout[Symbol.asyncIterator]();
    let chunk: Buffer = Buffer.alloc(0), offset = 0;
    const available = async () => {
      if (offset < chunk.length) return;
      const next = await output.next();
      if (next.done) throw await finished || new GitError("Git snapshot export ended before a file was complete.");
      chunk = next.value; offset = 0;
    };
    const header = async () => {
      const parts: Buffer[] = [];
      while (true) {
        await available();
        const end = chunk.indexOf(10, offset);
        parts.push(chunk.subarray(offset, end < 0 ? chunk.length : end));
        offset = end < 0 ? chunk.length : end + 1;
        if (end >= 0) return Buffer.concat(parts).toString();
      }
    };
    const links: [string, string][] = [];
    try {
      for (const { file, mode, oid, target } of entries) {
        child.stdin.write(oid + "\n");
        const [object, type, size] = (await header()).split(" ");
        let remaining = Number(size);
        if (object !== oid || type !== "blob" || !Number.isSafeInteger(remaining) || remaining < 0)
          throw new GitError(`Git snapshot export could not read: ${file}`);
        const linkParts: Buffer[] = [], handle = mode === "120000" ? null : await fs.promises.open(target, "w", mode === "100755" ? 0o755 : 0o644);
        try {
          while (remaining) {
            await available();
            const length = Math.min(remaining, chunk.length - offset), data = chunk.subarray(offset, offset + length);
            if (handle === null) linkParts.push(Buffer.from(data));
            else await handle.write(data);
            remaining -= length; offset += length;
          }
        } finally { await handle?.close(); }
        await available();
        if (chunk[offset++] !== 10) throw new GitError(`Git snapshot export returned an invalid file boundary: ${file}`);
        if (mode === "120000") {
          const link = Buffer.concat(linkParts).toString(), resolved = path.resolve(path.dirname(target), link);
          if (path.isAbsolute(link) || !resolved.startsWith(path.resolve(destination) + path.sep))
            throw new GitError(`A link in the snapshot points outside the document: ${file}`);
          links.push([target, link]);
        }
      }
      child.stdin.end();
      if (!(await output.next()).done) throw new GitError("Git snapshot export returned unexpected output.");
      const failure = await finished;
      if (failure) throw failure;
      for (const [target, link] of links) await fs.promises.symlink(link, target);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGKILL");
      await finished;
    }
  }
}
/** `merge3` for servers, which keep answering requests meanwhile. */
export async function merge3Async(
  ours: Buffer | null,
  base: Buffer | null,
  theirs: Buffer | null,
  favorCurrent = false,
): Promise<[Buffer | null, boolean]> {
  if (same(ours, base) || same(ours, theirs)) return [theirs, false];
  if (same(theirs, base)) return [ours, false];
  if (ours === null || base === null || theirs === null || [ours, base, theirs].some((b) => b.includes(0))) return [null, true];
  const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), "latex-review-merge-"));
  try {
    const files = ["ours", "base", "theirs"].map((name) => path.join(folder, name));
    await Promise.all([ours, base, theirs].map((data, i) => fs.promises.writeFile(files[i], data)));
    const result = await capture(gitBinary(), ["merge-file", "-p", ...(favorCurrent ? ["--ours"] : []), ...files], { check: false });
    return [result.stdout, result.status !== 0];
  } finally {
    await fs.promises.rm(folder, { recursive: true, force: true });
  }
}
export function merge3(
  ours: Buffer | null,
  base: Buffer | null,
  theirs: Buffer | null,
  favorCurrent = false,
): [Buffer | null, boolean] {
  if (same(ours, base) || same(ours, theirs)) return [theirs, false];
  if (same(theirs, base)) return [ours, false];
  if (
    ours === null ||
    base === null ||
    theirs === null ||
    [ours, base, theirs].some((b) => b.includes(0))
  )
    return [null, true];
  return temporary("latex-review-merge-", (folder) => {
    const files = ["ours", "base", "theirs"].map((name) =>
      path.join(folder, name),
    );
    [ours, base, theirs].forEach((data, i) => fs.writeFileSync(files[i], data));
    const result = run(gitBinary(), ["merge-file", "-p", ...(favorCurrent ? ["--ours"] : []), ...files], {
      check: false,
    });
    return [result.stdout, result.status !== 0];
  });
}
