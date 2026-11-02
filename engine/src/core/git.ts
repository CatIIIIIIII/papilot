import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { run, which } from "./process.ts";
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
    const result: Record<string, Buffer | null> = {};
    if (!names.length) return result;
    const output = this.run(["cat-file", "--batch", "-z"], {
      input: names.map((p) => `${rev}:${p}\0`).join(""),
    });
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
    return this.run([
      "ls-tree", "-r", "-l", "-z", rev, ...(folder ? ["--", folder] : []),
    ]).toString().split("\0").filter(Boolean).flatMap(entry => {
      const tab = entry.indexOf("\t"), [mode, type, oid, size] = entry.slice(0, tab).split(/ +/);
      return type === "blob" ? [{ mode, oid, size: Number(size), file: entry.slice(tab + 1) }] : [];
    });
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
  mode(rev: string, file: string) {
    return this.text(["ls-tree", rev, "--", file]).split(/\s+/)[0] || null;
  }
  treeId(rev: string, folder = "") {
    return this.text([
      "rev-parse",
      folder ? `${rev}:${folder}` : `${rev}^{tree}`,
    ]);
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
  deleteRefs(prefix: string) {
    const refs = this.text(["for-each-ref", "--format=%(refname)", prefix])
      .split("\n")
      .filter(Boolean);
    if (refs.length)
      this.run(["update-ref", "--stdin"], {
        input: refs.map((r) => `delete ${r}\n`).join(""),
      });
  }
  snapshot(include: string[] = [], exclude: readonly string[] = []) {
    const head = this.rev("HEAD");
    const staged = this.run([
      "diff",
      "--cached",
      "--name-only",
      "--diff-filter=A",
      "-z",
    ])
      .toString()
      .split("\0")
      .filter(Boolean);
    const tree = temporary("latex-review-index-", (folder) => {
      const env = {
        ...process.env,
        GIT_INDEX_FILE: path.join(folder, "index"),
      };
      const capture = () => {
        this.run(["read-tree", head], { env });
        this.run(["add", "-u"], { env });
        const untracked = this.run(
          ["ls-files", "--others", "--exclude-standard", "-z"],
          { env },
        )
          .toString()
          .split("\0");
        const chosen = new Set([
          ...untracked.filter(
            (p) =>
              p &&
              within(p, include) &&
              !exclude.some((suffix) => p.endsWith(suffix)),
          ),
          ...staged.filter((p) => fs.existsSync(path.join(this.root, p))),
        ]);
        if (chosen.size)
          this.run(["add", "--pathspec-from-file=-", "--pathspec-file-nul"], {
            env,
            input: [...chosen].sort().join("\0") + "\0",
          });
        return this.text(["write-tree"], { env });
      };
      const first = capture();
      if (first !== capture() || head !== this.rev("HEAD"))
        throw new GitError(
          "Files changed while the snapshot was taken. Wait for saves to finish and retry.",
        );
      return first;
    });
    return this.commitTree(tree, head, "latex-review snapshot");
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
  // Write a revision's files under destination. Given an earlier export of
  // another tree, files with the same Git object are cloned from it
  // (copy-on-write where the file system supports it), so only changed files
  // are read from Git.
  async export(rev: string, folder: string, destination: string, base?: { root: string; tree: string }) {
    const previous = new Map<string, string>();
    if (base) for (const entry of this.entries(base.tree)) previous.set(entry.file, entry.mode + " " + entry.oid);
    const wanted = this.entries(rev, folder).map(entry => {
      const relative = path.posix.relative(folder || ".", entry.file);
      cleanPath(relative);
      return { ...entry, relative, target: path.join(destination, relative) };
    });
    // On APFS, cp clones a whole folder far faster than creating each file
    // separately; files that are not in this tree are then removed again.
    let cloned = false;
    if (base && process.platform === "darwin" && !fs.existsSync(destination))
      try {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        cloned = run("/bin/cp", ["-c", "-R", base.root, destination], { check: false }).status === 0;
      }
      catch { /* Copy file by file below. */ }
    if (cloned) {
      const keep = new Set(wanted.map(entry => entry.relative));
      (function prune(directory: string, prefix: string) {
        for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
          const relative = prefix + item.name, file = path.join(directory, item.name);
          if (item.isDirectory()) prune(file, relative + "/");
          else if (!keep.has(relative)) fs.rmSync(file, { force: true });
        }
      })(destination, "");
    } else {
      fs.rmSync(destination, { recursive: true, force: true });
      fs.mkdirSync(destination, { recursive: true });
    }
    const folders = new Set<string>(), entries: typeof wanted = [];
    for (const entry of wanted) {
      const { relative, target } = entry;
      if (!folders.has(path.dirname(target))) { fs.mkdirSync(path.dirname(target), { recursive: true }); folders.add(path.dirname(target)); }
      if (entry.mode !== "120000" && previous.get(relative) === entry.mode + " " + entry.oid) {
        const source = cloned ? target : path.join(base!.root, relative);
        try {
          // A compiler may have rewritten a file in the earlier export.
          const stat = fs.lstatSync(source);
          if (stat.isFile() && stat.size === entry.size) {
            if (!cloned) fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
            if ((stat.mode & 0o777) !== (entry.mode === "100755" ? 0o755 : 0o644)) fs.chmodSync(target, entry.mode === "100755" ? 0o755 : 0o644);
            continue;
          }
        } catch { /* Read this file from Git. */ }
      }
      // A cloned link or rewritten file is replaced, never written through.
      if (cloned) fs.rmSync(target, { force: true });
      entries.push(entry);
    }
    if (!entries.length) return;
    // Keep one Git process and stream each blob to disk. Collecting the entire
    // snapshot with blobs() both duplicates memory and hits spawnSync's buffer
    // limit for ordinary repositories containing PDFs and figures.
    const child = spawn(gitBinary(), ["cat-file", "--batch"], {
      cwd: this.root, stdio: ["pipe", "pipe", "pipe"],
    });
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
        const linkParts: Buffer[] = [], fd = mode === "120000" ? null : fs.openSync(target, "w", mode === "100755" ? 0o755 : 0o644);
        try {
          while (remaining) {
            await available();
            const length = Math.min(remaining, chunk.length - offset), data = chunk.subarray(offset, offset + length);
            if (fd === null) linkParts.push(Buffer.from(data));
            else fs.writeFileSync(fd, data);
            remaining -= length; offset += length;
          }
        } finally { if (fd !== null) fs.closeSync(fd); }
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
      for (const [target, link] of links) fs.symlinkSync(link, target);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGKILL");
      await finished;
    }
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
