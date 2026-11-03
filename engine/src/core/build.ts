import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type { ChildProcess } from "node:child_process";
import { Repo } from "./git.ts";
import { readJson, writeJsonAsync, withLock, now } from "./files.ts";
import { stripComments } from "./outline.ts";
import { signature, type Project } from "./config.ts";
import { capture, commandVersion, runAsync } from "./process.ts";
import { progressReader, writtenPages } from "./progress.ts";
import type { BuildInfo, BuildProgress } from "../types.ts";
export class BuildError extends Error {
  constructor(
    message: string,
    public details: string[] = [],
    public log?: string,
  ) {
    super(message);
  }
}
const AUXILIARY = new Set([
  ".aux",
  ".bbl",
  ".brf",
  ".toc",
  ".lof",
  ".lot",
  ".loe",
  ".out",
  ".thm",
]);
// Output that TeX writes for this folder: SyncTeX data and the log name its
// absolute path.
const OUTPUT = /\.(?:pdf|xdv|dvi|log|synctex(?:\.gz)?)$/i;
const unzip = promisify(gunzip), zip = promisify(gzip);
async function clone(file: string, target: string) {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.copyFile(file, target, fs.constants.COPYFILE_FICLONE);
}
// Every file below a folder, read without blocking the event loop.
async function filesIn(root: string): Promise<string[]> {
  let items: fs.Dirent[];
  try { items = await fs.promises.readdir(root, { withFileTypes: true }); }
  catch { return []; }
  return (await Promise.all(items.map((e) => e.isDirectory() ? filesIn(path.join(root, e.name)) : [path.join(root, e.name)]))).flat();
}
// Output that latexmk kept from an earlier build folder still names that
// folder. Build folders differ only in their equal-length key, so the paths
// are replaced in place without moving anything else in the file.
export async function relocate(file: string, from: string, to: string) {
  const old = Buffer.from(from + path.sep), next = Buffer.from(to + path.sep);
  if (old.length !== next.length || old.equals(next)) return;
  let data: Buffer;
  try { data = await fs.promises.readFile(file); }
  catch { return; }
  const zipped = file.endsWith(".gz");
  if (zipped) data = await unzip(data);
  let at = data.indexOf(old);
  if (at < 0) return;
  for (; at >= 0; at = data.indexOf(old, at + next.length)) next.copy(data, at);
  await fs.promises.writeFile(file, zipped ? await zip(data, { level: 1 }) : data);
}
/** How much a build matters to the person waiting: the PDF on screen comes
 *  first, a speculative build last. */
export type BuildPriority = "foreground" | "normal" | "background";
const RANK: Record<BuildPriority, number> = { background: 0, normal: 1, foreground: 2 };
interface Active {
  key: string;
  priority: BuildPriority;
  child?: ChildProcess;
  paused: boolean;
  yielding?: boolean;
  // Who is shown each pass, and the latest pass that more work followed.
  watchers: Set<(preview: PassPreview) => void>;
  followed?: () => void;
}
const active = new Set<Active>();
// Everyone in this process who waits for each build key. A build runs at the
// highest priority among them and shows its passes to all of them, also to
// those who asked before it started compiling.
interface Waiter { priority: BuildPriority; pass?: (preview: PassPreview) => void }
const waiting = new Map<string, Set<Waiter>>();
const building = new Map<string, Promise<BuildInfo>>();
// A background build's compiler stops while any other build of this process
// compiles, and continues once none does, so speculation never slows down a
// PDF someone is waiting for. A build that someone waits for is promoted.
function schedule() {
  const top = Math.max(-1, ...[...active].filter((a) => a.child).map((a) => RANK[a.priority]));
  for (const build of active) {
    const pause = build.priority === "background" && top > RANK.background;
    if (pause === build.paused || !build.child?.pid || build.child.exitCode !== null) continue;
    try {
      process.kill(-build.child.pid, pause ? "SIGSTOP" : "SIGCONT");
      build.paused = pause;
    } catch { /* The compiler has exited. */ }
  }
  watchOthers();
}
function promote(key: string, priority: BuildPriority) {
  let changed = false;
  for (const build of active)
    if (build.key === key && RANK[priority] > RANK[build.priority]) {
      build.priority = priority;
      if (build.yielding) void yieldTo(build, false);
      changed = true;
    }
  if (changed) schedule();
}
// On macOS a background build also yields to TeX that runs elsewhere, such as
// the review engine compiling another task: while any does, its compiler runs
// at background priority (efficiency cores, throttled disk). Unlike a nice
// value this is undone as soon as nothing else compiles, or when someone
// starts waiting for the build, so an idle machine gives it full speed.
const TASKPOLICY = "/usr/sbin/taskpolicy";
const darwinBackground = process.platform === "darwin" && fs.existsSync(TASKPOLICY);
const OTHER_TEX = /(?:^|\/)(?:latexmk|(?:pdf|xe|lua|luahb)(?:la)?tex|xdvipdfmx|bibtex8?|biber)(?:\s|$)/;
let watching: NodeJS.Timeout | null = null;
function watchOthers() {
  const waiting = darwinBackground && [...active].some((a) => a.priority === "background" && a.child);
  if (!waiting) { if (watching) clearInterval(watching); watching = null; return; }
  if (watching) return;
  watching = setInterval(() => void (async () => {
    const ours = new Set([...active].flatMap((a) => (a.child?.pid ? [String(a.child.pid)] : [])));
    const lines = (await capture("ps", ["-A", "-o", "pgid=,command="], { check: false })).stdout.toString().split("\n");
    const others = lines.some((line) => {
      const [, group, command] = /^\s*(\d+)\s+(.*)$/.exec(line) ?? [];
      return command !== undefined && !ours.has(group) && OTHER_TEX.test(command);
    });
    await Promise.all([...active].filter((a) => a.priority === "background" && a.child && Boolean(a.yielding) !== others).map((a) => yieldTo(a, others)));
  })().catch(() => undefined), 2000);
  watching.unref();
}
async function yieldTo(build: Active, others: boolean) {
  const group = build.child?.pid;
  if (!darwinBackground || !group) return;
  build.yielding = others;
  try {
    const members = (await capture("ps", ["-o", "pid=", "-g", String(group)], { check: false })).stdout.toString().split(/\s+/).filter(Boolean);
    await Promise.all(members.map((pid) => capture(TASKPOLICY, [others ? "-b" : "-B", "-p", pid], { check: false }).catch(() => undefined)));
  } catch { /* The compiler has exited. */ }
}
// This file is part of every build key, so a change to how builds run
// starts new build folders.
const SELF = createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex");
// latexmk (4.84 and later) runs this after every TeX pass: it copies the
// pass's output aside, so that the pages can be shown while later passes
// settle references, page numbers and the bibliography. Older versions
// have no hooks and skip it.
const PASS_HOOK = String.raw`if (defined &add_hook) { my $papilot_pass = 0; add_hook('after_xlatex', sub { my $dir = $ENV{PAPILOT_PASS_DIR}; return 0 unless $dir; $papilot_pass++; my $to = "$dir/$papilot_pass"; make_path($to); for my $file (split /\n/, $ENV{PAPILOT_PASS_FILES}) { next unless -f $file; my ($name) = $file =~ m{([^/]+)$}; copy($file, "$to/$name"); } print "Papilot: pass $papilot_pass output saved\n"; return 0; }); }`;
const SAVED = /^Papilot: pass (\d+) output saved/m, NEXT = /^Run number \d+ of rule '([^' ]+)/m;
/** A TeX pass's PDF, shown while the build goes on. */
export interface PassPreview { pass: number; pdf: string; root: string; cwd: string }
// Completed builds kept per set of targets, as candidates to continue from.
const RECENT = 16;
interface Recent { key: string; context: string; date: unknown; tree?: string }
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const includes = (text: string) =>
  [...stripComments(text).matchAll(/^\s*\\include\{([^}]+)\}/gm)].map((m) =>
    m[1].trim(),
  );
export function affectedTargets(
  texts: Record<string, string>,
  changed: string[],
  targets: string[],
) {
  const owners: Record<string, Set<string>> = {};
  function visit(file: string, target: string, seen: Set<string>) {
    if (!path.posix.extname(file)) file += ".tex";
    if (seen.has(file) || !(file in texts)) return;
    seen.add(file);
    (owners[file] ??= new Set()).add(target);
    for (const m of stripComments(texts[file]).matchAll(
      /\\(?:input|include|subfile)\{([^}]+)\}/g,
    ))
      visit(path.posix.normalize(m[1].trim()), target, seen);
  }
  targets.forEach((t) => visit(t, t, new Set()));
  const selected = new Set<string>();
  for (const file of changed) {
    if (!owners[file]) return ["full"];
    for (const owner of owners[file]) selected.add(owner);
  }
  return [...selected].sort();
}
export function errors(text: string) {
  const lines = text.split(/\r?\n/),
    result: string[] = [];
  const startsError = (line: string) =>
    /^(\S[^\n]*):(\d+): (.+)$/.test(line) || line.startsWith("! ");
  for (const [i, line] of lines.entries())
    if (startsError(line)) {
      let message = line,
        last = line;
      // TeX hard-wraps even in the middle of words ("P\nackage"). Keep
      // continuations, but stop before help text, source context or a new error.
      let end = i + 1;
      for (; end < lines.length && end < i + 20; end++) {
        const next = lines[end];
        if (
          !next.trim() ||
          startsError(next) ||
          /^(?:See |Type |l\.\d+ |\s*\.\.\.|\s*<)/.test(next)
        )
          break;
        message += (last.length >= 78 ? "" : " ") + next;
        last = next;
      }
      const context = lines
        .slice(end, end + 12)
        .find((l) => /^l\.\d+ /.test(l))
        ?.trim();
      result.push(
        message
          .replace(/^! |^\.\//, "")
          .replace(/\s+/g, " ")
          .trim() + (context ? `  [${context}]` : ""),
      );
      if (result.length === 8) break;
    }
  return result;
}
export function compilerDiagnostics(log: string, transcript: string) {
  const details = errors(log);
  // Errors from shell-escape helpers go to latexmk's stderr, not the TeX log.
  for (const traceback of transcript
    .split("Traceback (most recent call last):")
    .slice(1)) {
    const exception = traceback
      .split(/\r?\n/)
      .find((line) => /^[\w.]+(?:Error|Exception): /.test(line));
    if (!exception) continue;
    const minted = traceback
      .slice(0, traceback.indexOf(exception))
      .includes("latexminted");
    details.push((minted ? "latexminted: " : "") + exception);
    if (minted && exception.includes("unexpected keyword argument 'color'"))
      details.push(
        "latexminted is incompatible with this Python version. Update latexminted or select a compatible Python on PATH, then restart the service and retry.",
      );
  }
  return [...new Set(details)];
}
export function warnings(text: string) {
  const patterns: [RegExp, string][] = [
    [/LaTeX Warning: Reference `([^']+)' on page/g, "Undefined reference: "],
    [/Warning: Citation [`']([^']+)' on page/g, "Undefined citation: "],
    [
      /LaTeX Warning: Label `([^']+)' multiply defined/g,
      "Label defined twice: ",
    ],
    [/Missing character: There is no (\S+)/g, "Missing glyph: "],
  ];
  return [
    ...new Set(
      patterns.flatMap(([re, label]) =>
        [...text.matchAll(re)].map((m) => label + m[1]),
      ),
    ),
  ].sort();
}
// The date every build of a day prints, so that a build kept from an earlier
// day differs from today's in its text alone, not in \today. TeX reads it
// from SOURCE_DATE_EPOCH; noon UTC of the local date shows the local date in
// every time zone. A SOURCE_DATE_EPOCH set by the user is kept as it is.
export function buildDate(now = new Date(), env = process.env) {
  return env.SOURCE_DATE_EPOCH
    ? { SOURCE_DATE_EPOCH: env.SOURCE_DATE_EPOCH }
    : {
        SOURCE_DATE_EPOCH: String(
          Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 12) / 1000,
        ),
        FORCE_SOURCE_DATE: "1",
      };
}
export class Builder {
  cache: string;
  constructor(
    public project: Project,
    public repo: Repo,
  ) {
    this.cache = path.join(project.state, "cache/builds");
  }
  documentTexts(rev: string) {
    const files = this.repo
        .files(rev, this.project.doc_dir)
        .filter((f) => f.endsWith(".tex")),
      blobs = this.repo.blobs(rev, files);
    return Object.fromEntries(
      files.map((f) => [
        path.posix.relative(this.project.doc_dir || ".", f),
        blobs[f]?.toString() ?? "",
      ]),
    );
  }
  async documentTextsAsync(rev: string) {
    const files = (await this.repo.runAsync(["ls-tree", "-r", "-z", "--name-only", rev, ...(this.project.doc_dir ? ["--", this.project.doc_dir] : [])]))
        .toString().split("\0").filter((f) => f.endsWith(".tex")),
      blobs = await this.repo.blobsAsync(rev, files);
    return Object.fromEntries(
      files.map((f) => [
        path.posix.relative(this.project.doc_dir || ".", f),
        blobs[f]?.toString() ?? "",
      ]),
    );
  }
  plan(before: string, after: string, changed: string[]) {
    return this.choose(this.documentTexts(before), this.documentTexts(after), changed);
  }
  /** `plan` for servers, which keep answering requests meanwhile. */
  async planAsync(before: string, after: string, changed: string[]) {
    const [old, next] = await Promise.all([this.documentTextsAsync(before), this.documentTextsAsync(after)]);
    return this.choose(old, next, changed);
  }
  private choose(old: Record<string, string>, next: Record<string, string>, changed: string[]) {
    const p = this.project,
      main = path.posix.basename(p.main),
      targets = includes(next[main] ?? "");
    if (
      !p.partial_builds ||
      targets.length < 2 ||
      JSON.stringify(targets) !== JSON.stringify(includes(old[main] ?? ""))
    )
      return ["full"];
    if (p.doc_dir && changed.some((f) => !f.startsWith(p.doc_dir + "/")))
      return ["full"];
    const local = changed.map((f) => path.posix.relative(p.doc_dir || ".", f)),
      selected = new Set([
        ...affectedTargets(old, local, targets),
        ...affectedTargets(next, local, targets),
      ]);
    if (selected.has("full") || !selected.size) return ["full"];
    for (const name of [...selected])
      for (const dependency of p.dependencies[name] ?? [])
        selected.add(dependency);
    return targets.filter((t) => selected.has(t));
  }
  async build(
    rev: string,
    targets = ["full"],
    seed: BuildInfo | null = null,
    options: { force?: boolean; progress?: (progress: BuildProgress) => void; priority?: BuildPriority; pass?: (preview: PassPreview) => void } = {},
  ): Promise<BuildInfo> {
    const p = this.project,
      partial = JSON.stringify(targets) !== '["full"]',
      priority = options.priority ?? "normal";
    if (partial && !seed)
      throw new BuildError(
        "A partial build needs a completed full build to start from.",
      );
    let version: string;
    try {
      version = await commandVersion(p.engine);
    } catch {
      throw new BuildError(
        `${p.engine} was not found. Install TeX Live (or MacTeX) with latexmk.`,
      );
    }
    const tree = await this.repo.treeIdAsync(rev, p.source_dir),
      date = buildDate(),
      context = hash(JSON.stringify([signature(p), version])),
      key = hash(
        JSON.stringify([
          tree,
          targets,
          seed?.key ?? null,
          signature(p),
          version,
          date,
          SELF,
          // Manual recompilation gets a fresh output directory. Other previews
          // and review rounds may still be reading the previous cached PDF.
          ...(options.force ? [randomUUID()] : []),
        ]),
      ).slice(0, 32),
      folder = path.join(this.cache, key);
    // Someone now waits for a build of this key that may already be running,
    // and sees its passes from now on, starting with the latest one.
    const waiter: Waiter = { priority, pass: options.pass };
    let waiters = waiting.get(key);
    if (!waiters) waiting.set(key, (waiters = new Set()));
    waiters.add(waiter);
    try {
      promote(key, priority);
      if (options.pass)
        for (const build of active)
          if (build.key === key) { build.watchers.add(options.pass); build.followed?.(); }
      // A build of this key under way in this process is awaited directly,
      // rather than by polling its lock, so its result arrives the moment it
      // is ready. The lock keeps other processes from building it twice.
      const ongoing = building.get(key);
      if (ongoing) {
        const result = await ongoing.catch(() => null);
        if (result) return result;
      }
      const attempt = (async () =>
        (await this.finished(folder)) ??
        withLock(path.join(this.cache, key + ".lock"), async () =>
          (await this.finished(folder)) ?? this.compileOnce(rev, tree, key, context, targets, seed, date, partial, options),
        ))();
      building.set(key, attempt);
      try {
        return await attempt;
      } finally {
        if (building.get(key) === attempt) building.delete(key);
      }
    } finally {
      waiters.delete(waiter);
      if (!waiters.size && waiting.get(key) === waiters) waiting.delete(key);
    }
  }
  private async compileOnce(
    rev: string,
    tree: string,
    key: string,
    context: string,
    targets: string[],
    seed: BuildInfo | null,
    date: ReturnType<typeof buildDate>,
    partial: boolean,
    options: { force?: boolean; progress?: (progress: BuildProgress) => void },
  ) {
    // A build continues from the completed one with the same targets whose
    // sources differ least from this one, or a full build from the author's
    // own latexmk output, as latexmk does when a folder is compiled again:
    // unchanged files are cloned and LaTeX keeps its state, so it reruns
    // only as often as the edit requires. Manual recompilation starts
    // clean, and so does a retry when leftover state broke a build.
    const start = options.force ? null : (await this.closest(context, targets, tree)) ?? (partial ? null : "author");
    const waiters = [...(waiting.get(key) ?? [])],
      priority = waiters.reduce<BuildPriority>((top, w) => (RANK[w.priority] > RANK[top] ? w.priority : top), "background");
    const run: Active = { key, priority, paused: false, watchers: new Set(waiters.flatMap((w) => (w.pass ? [w.pass] : []))) };
    active.add(run);
    let result: BuildInfo;
    try {
      try {
        result = await this.compile(rev, tree, key, targets, seed, date, start, options.progress, run);
      } catch (error) {
        if (!start || (error instanceof BuildError && !error.details.some(line => /(?:^|\s|\()(?:\.\/)?build\//.test(line)))) throw error;
        result = await this.compile(rev, tree, key, targets, seed, date, null, options.progress, run);
      }
    } finally {
      active.delete(run);
      schedule();
    }
    await this.remember(targets, { key, context, date: date.SOURCE_DATE_EPOCH, tree });
    return result;
  }
  // A completed build in this folder, whose PDF is still there.
  private async finished(folder: string) {
    try {
      const cached = JSON.parse(await fs.promises.readFile(path.join(folder, "result.json"), "utf8")) as BuildInfo;
      await fs.promises.access(cached.pdf);
      const time = new Date();
      await fs.promises.utimes(folder, time, time).catch(() => undefined);
      return cached;
    } catch {
      return null;
    }
  }
  // Review rounds build the same chapters again and again (\includeonly), so
  // each set of targets continues from its own recent builds.
  private latestFile(targets: string[]) {
    const name = JSON.stringify(targets) === '["full"]' ? "latest.json" : `latest-${hash(JSON.stringify(targets)).slice(0, 16)}.json`;
    return path.join(this.cache, name);
  }
  private recentFile(targets: string[]) {
    return this.latestFile(targets).replace(/latest(-[0-9a-f]+)?\.json$/, "recent$1.json");
  }
  private recent(targets: string[]): Recent[] {
    const list = readJson<unknown>(this.recentFile(targets), []),
      latest = readJson<Partial<Recent> | null>(this.latestFile(targets), null),
      valid = (r: unknown): r is Recent => typeof (r as Recent)?.key === "string" && /^[0-9a-f]{32}$/.test((r as Recent).key) && typeof (r as Recent).context === "string";
    const entries = (Array.isArray(list) ? list : []).filter(valid);
    // latest.json, also written by earlier versions, names the newest build.
    if (valid(latest) && !entries.some((r) => r.key === latest.key)) entries.unshift(latest);
    return entries;
  }
  private async remember(targets: string[], entry: Recent) {
    const entries = [entry, ...this.recent(targets).filter((r) => r.key !== entry.key)].slice(0, RECENT);
    await writeJsonAsync(this.recentFile(targets), entries);
    await writeJsonAsync(this.latestFile(targets), { key: entry.key, context: entry.context, date: entry.date });
  }
  // Of the recent builds that can be continued, the one whose sources differ
  // in the fewest files from `tree`, preferring the newer: after a review or a
  // speculative build, the manuscript's own previous build may be further
  // from the next version than either.
  private async closest(context: string, targets: string[], tree: string): Promise<{ info: BuildInfo; date: unknown } | null> {
    const candidates = (await Promise.all(this.recent(targets).filter((r) => r.context === context).map(async (r) => {
      try {
        const info = JSON.parse(await fs.promises.readFile(path.join(this.cache, r.key, "result.json"), "utf8")) as BuildInfo;
        if (JSON.stringify(info.targets) !== JSON.stringify(targets)) return null;
        await Promise.all([fs.promises.access(info.pdf), fs.promises.access(info.root)]);
        const changed = info.tree === tree ? 0 : (await this.repo.runAsync(["diff-tree", "-r", "--name-only", "-z", info.tree, tree])).toString().split("\0").filter(Boolean).length;
        return { info, date: r.date, changed };
      } catch {
        return null;
      }
    }))).filter((c) => c !== null);
    let best: (typeof candidates)[number] | null = null;
    for (const candidate of candidates) if (!best || candidate.changed < best.changed) best = candidate;
    return best && { info: best.info, date: best.date };
  }
  private async compile(
    rev: string,
    tree: string,
    key: string,
    targets: string[],
    seed: BuildInfo | null,
    date: ReturnType<typeof buildDate>,
    start: { info: BuildInfo; date: unknown } | "author" | null,
    progress?: (progress: BuildProgress) => void,
    scheduled?: Active,
  ): Promise<BuildInfo> {
    const p = this.project,
      partial = JSON.stringify(targets) !== '["full"]',
      folder = path.join(this.cache, key);
    await fs.promises.rm(folder, { recursive: true, force: true });
    const source = path.join(folder, "src");
    const base = start && start !== "author" ? start.info : null;
    await this.repo.export(rev, p.source_dir, source, base ? { root: base.root, tree: base.tree } : undefined);
    const cwd = path.join(
        source,
        path.posix.relative(p.source_dir || ".", p.doc_dir || "."),
      ),
      main = path.posix.basename(p.main),
      job = path.posix.basename(main, ".tex"),
      out = path.join(cwd, "build");
    await fs.promises.mkdir(out, { recursive: true });
    const included = includes(await fs.promises.readFile(path.join(cwd, main), "utf8"));
    await Promise.all(included.map((target) => fs.promises.mkdir(path.join(out, path.dirname(target)), { recursive: true })));
    // The PDF, SyncTeX data and log carry over only within a day, so that
    // \today stays current; latexmk then skips TeX when no input changed.
    const reused = base !== null && start !== "author" && start?.date === date.SOURCE_DATE_EPOCH;
    if (base) {
      const previous = path.dirname(base.pdf);
      await Promise.all((await filesIn(previous))
        .filter((file) => !/\.fls$/i.test(file) && (reused || !OUTPUT.test(file)))
        .map((file) => clone(file, path.join(out, path.relative(previous, file)))));
    } else if (start === "author") {
      // Only this job's state: the author's folder may hold other editions.
      const own = path.join(p.root, p.doc_dir, "build");
      if (fs.existsSync(path.join(own, job + ".fdb_latexmk")))
        await Promise.all([
          ...(await fs.promises.readdir(own)).filter((name) => (name.startsWith(job + ".") && !OUTPUT.test(name) && !name.endsWith(".fls")) || name.startsWith("_minted")),
          ...included.map((target) => target + ".aux"),
        ].map(async (name) => {
          try {
            if ((await fs.promises.stat(path.join(own, name))).isDirectory()) await fs.promises.cp(path.join(own, name), path.join(out, name), { recursive: true });
            else await clone(path.join(own, name), path.join(out, name));
          } catch {
            /* A missing file is regenerated. */
          }
        }));
    }
    const args = [
      "-norc",
      ...(p.latexmkrc
        ? ["-r", path.posix.relative(p.doc_dir || ".", p.latexmkrc)]
        : []),
      { pdflatex: "-pdf", xelatex: "-xelatex", lualatex: "-lualatex" }[
        p.engine
      ],
      "-outdir=build",
      `-jobname=${job}`,
      "-synctex=1",
      "-interaction=nonstopmode",
      "-halt-on-error",
      "-file-line-error",
    ];
    if (partial) {
      // Chapters outside \includeonly keep the seed's auxiliary files, also
      // when this build continues from an earlier one built on another seed.
      // latexmk compares contents, so an unchanged chapter causes no rerun.
      const seedOut = path.dirname(seed!.pdf),
        others = new Set(included.filter((target) => !targets.includes(target)).map((target) => path.join(...target.split("/")) + ".aux"));
      await Promise.all((await filesIn(seedOut)).filter((file) => AUXILIARY.has(path.extname(file))).map(async (file) => {
        const relative = path.relative(seedOut, file), target = path.join(out, relative);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        if (others.has(relative) || !fs.existsSync(target)) await fs.promises.copyFile(file, target);
      }));
      const preload = Object.entries(p.preload)
        .filter(
          ([name, file]) =>
            !targets.includes(name) && fs.existsSync(path.join(cwd, file)),
        )
        .map(([, file]) => `\\input{${file}}`)
        .join("");
      args.push(
        `-usepretex=\\includeonly{${targets.join(",")}}` +
          (preload ? `\\AtBeginDocument{${preload}}` : ""),
      );
    }
    // Each pass's pages are shown once latexmk decides to run more than that
    // pass: a bibliography or another pass. The last pass's are the result.
    // A background build keeps its passes too, for whoever starts waiting
    // for it before it ends.
    const passes = path.join(folder, "passes"),
      keeping = Boolean(scheduled && (scheduled.watchers.size || scheduled.priority === "background"));
    let saved = 0, followed = 0, shown = 0, previewing = Promise.resolve();
    const kept = new Set<number>();
    const preview = () => {
      if (!scheduled?.watchers.size || followed <= shown) return;
      const number = (shown = followed);
      kept.add(number);
      previewing = previewing.then(async () => {
        const dir = path.join(passes, String(number)), xdv = path.join(dir, job + ".xdv"), file = path.join(dir, job + ".pdf");
        if (fs.existsSync(xdv)) {
          await capture("xdvipdfmx", ["-q", "-E", "-o", file, xdv], { cwd, env: { ...process.env, ...date }, timeout: 300000 });
          await fs.promises.rm(xdv, { force: true });
        }
        await fs.promises.access(file);
        for (const watcher of scheduled.watchers) watcher({ pass: number, pdf: file, root: source, cwd });
      }).catch(() => undefined);
    };
    if (scheduled) scheduled.followed = preview;
    let pending = "";
    const watch = (chunk: Buffer) => {
      const lines = (pending + chunk.toString("latin1")).split("\n");
      pending = lines.pop()!;
      for (const line of lines) {
        const done = SAVED.exec(line), next = NEXT.exec(line);
        if (done) saved = Number(done[1]);
        else if (next && saved > followed && !/^(?:xdvipdfmx|dvipdfmx?|dvips|ps2pdf)$/.test(next[1])) { followed = saved; preview(); }
      }
    };
    if (keeping) args.push("-e", PASS_HOOK);
    args.push(main);
    const transcript = path.join(folder, "latexmk.log"),
      log = await fs.promises.open(transcript, "w"),
      started = now(),
      // Pages are counted against the build this one continues from.
      read = progress
        ? progressReader(
            progress,
            writtenPages(
              base
                ? path.join(path.dirname(base.pdf), job + ".log")
                : path.join(p.root, p.doc_dir, "build", job + ".log"),
            ),
          )
        : null;
    let failure: Error | null = null, writing = Promise.resolve();
    try {
      await runAsync("latexmk", args, {
        cwd,
        env: {
          ...process.env,
          ...date,
          ...(keeping ? { PAPILOT_PASS_DIR: passes, PAPILOT_PASS_FILES: ["xdv", "pdf", "synctex.gz"].map((ext) => `build/${job}.${ext}`).join("\n") } : {}),
        },
        timeout: 1800000,
        started: (child) => {
          if (!scheduled) return;
          scheduled.child = child;
          schedule();
        },
        output: (chunk) => {
          writing = writing.then(() => log.write(chunk)).then(() => undefined, () => undefined);
          read?.(chunk);
          if (keeping) watch(chunk);
        },
      });
    } catch (error) {
      failure = error as Error;
    } finally {
      if (scheduled) { scheduled.child = undefined; scheduled.paused = false; schedule(); }
      await writing;
      await log.close();
      await previewing;
    }
    // Passes that were not shown are not needed.
    if (scheduled) scheduled.followed = undefined;
    if (keeping) for (let number = 1; number <= saved; number++) if (!kept.has(number)) await fs.promises.rm(path.join(passes, String(number)), { recursive: true, force: true });
    const pdf = path.join(out, job + ".pdf"),
      texLog = path.join(out, job + ".log");
    if (reused && !failure)
      await Promise.all([path.join(out, job + ".synctex.gz"), texLog].map((file) => relocate(file, path.dirname(base!.root), folder)));
    const logText = await fs.promises.readFile(texLog, "utf8").catch(() => "");
    if (failure || !fs.existsSync(pdf)) {
      const transcriptText = await fs.promises.readFile(transcript, "utf8"),
        details = compilerDiagnostics(logText, transcriptText),
        kept = path.join(p.state, "logs", key + ".log");
      await fs.promises.mkdir(path.dirname(kept), { recursive: true });
      await fs.promises.writeFile(
        kept,
        transcriptText + (logText ? "\n\n--- TeX log ---\n" + logText : ""),
      );
      const tail = transcriptText.split("\n").slice(-25);
      await fs.promises.rm(folder, { recursive: true, force: true });
      throw new BuildError(
        failure?.message.includes("ENOENT")
          ? "latexmk was not found. Install TeX Live or MacTeX."
          : "LaTeX failed to compile.",
        details.length ? details : tail,
        kept,
      );
    }
    const result: BuildInfo = {
      key,
      tree,
      targets,
      root: source,
      cwd,
      pdf,
      seconds: Math.round((now() - started) * 10) / 10,
      warnings: warnings(logText),
    };
    await writeJsonAsync(path.join(folder, "result.json"), result);
    return result;
  }
  // Removes builds unused for `maxAge` seconds, except those in `keep` and the
  // two newest of each set of targets, which the next build continues from.
  async prune(keep: Set<string>, maxAge = 3 * 86400) {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(this.cache, { withFileTypes: true }); }
    catch { return; }
    const kept = new Set(keep);
    for (const entry of entries)
      if (entry.isFile() && /^(?:recent|latest)(?:-[0-9a-f]+)?\.json$/.test(entry.name)) {
        const value = readJson<unknown>(path.join(this.cache, entry.name), null),
          list = Array.isArray(value) ? value : [value];
        for (const item of list.slice(0, 2)) if (typeof (item as Recent)?.key === "string") kept.add((item as Recent).key);
      }
    for (const entry of entries) {
      const folder = path.join(this.cache, entry.name);
      if (!entry.isDirectory() || entry.name.endsWith(".lock") || kept.has(entry.name)) continue;
      const stat = await fs.promises.stat(folder).catch(() => null);
      if (!stat || now() - stat.mtimeMs / 1000 <= maxAge) continue;
      await withLock(path.join(this.cache, entry.name + ".lock"), () => fs.promises.rm(folder, { recursive: true, force: true }));
      await fs.promises.rm(path.join(this.cache, entry.name + ".lock"), { force: true });
    }
  }
}
