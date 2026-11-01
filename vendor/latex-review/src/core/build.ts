import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { Repo } from "./git.ts";
import { listFiles, readJson, writeJson, withLock, now } from "./files.ts";
import { stripComments } from "./outline.ts";
import { signature, type Project } from "./config.ts";
import { run, runAsync } from "./process.ts";
import type { BuildInfo } from "../types.ts";
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
function clone(file: string, target: string) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(file, target, fs.constants.COPYFILE_FICLONE);
}
// Output that latexmk kept from an earlier build folder still names that
// folder. Build folders differ only in their equal-length key, so the paths
// are replaced in place without moving anything else in the file.
export function relocate(file: string, from: string, to: string) {
  if (!fs.existsSync(file)) return;
  const old = Buffer.from(from + path.sep), next = Buffer.from(to + path.sep);
  if (old.length !== next.length) return;
  const zipped = file.endsWith(".gz"),
    data = zipped ? gunzipSync(fs.readFileSync(file)) : fs.readFileSync(file);
  let at = data.indexOf(old);
  if (at < 0) return;
  for (; at >= 0; at = data.indexOf(old, at + next.length)) next.copy(data, at);
  fs.writeFileSync(file, zipped ? gzipSync(data) : data);
}
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
  plan(before: string, after: string, changed: string[]) {
    const p = this.project,
      old = this.documentTexts(before),
      next = this.documentTexts(after),
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
    options: { force?: boolean } = {},
  ): Promise<BuildInfo> {
    const p = this.project,
      partial = JSON.stringify(targets) !== '["full"]';
    if (partial && !seed)
      throw new BuildError(
        "A partial build needs a completed full build to start from.",
      );
    let version: string;
    try {
      version = run(p.engine, ["--version"]).stdout.toString().split("\n")[0];
    } catch {
      throw new BuildError(
        `${p.engine} was not found. Install TeX Live (or MacTeX) with latexmk.`,
      );
    }
    const tree = this.repo.treeId(rev, p.source_dir),
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
          hash(fs.readFileSync(fileURLToPath(import.meta.url))),
          // Manual recompilation gets a fresh output directory. Other previews
          // and review rounds may still be reading the previous cached PDF.
          ...(options.force ? [randomUUID()] : []),
        ]),
      ).slice(0, 32),
      folder = path.join(this.cache, key);
    return withLock(path.join(this.cache, key + ".lock"), async () => {
      const cached = readJson<BuildInfo | null>(
        path.join(folder, "result.json"),
        null,
      );
      if (cached && fs.existsSync(cached.pdf)) {
        fs.utimesSync(folder, new Date(), new Date());
        return cached;
      }
      // A full build continues from the latest completed one, or from the
      // author's own latexmk output, as latexmk does when a folder is
      // compiled again: unchanged files are cloned and LaTeX keeps its state,
      // so it reruns only as often as the edit requires. Manual recompilation
      // starts clean, and so does a retry when leftover state broke a build.
      const start = partial || options.force ? null : this.latest(context) ?? "author";
      let result: BuildInfo;
      try {
        result = await this.compile(rev, tree, key, targets, seed, date, start);
      } catch (error) {
        if (!start || (error instanceof BuildError && !error.details.some(line => /(?:^|\s|\()(?:\.\/)?build\//.test(line)))) throw error;
        result = await this.compile(rev, tree, key, targets, seed, date, null);
      }
      if (!partial) writeJson(path.join(this.cache, "latest.json"), { key, context, date: date.SOURCE_DATE_EPOCH });
      return result;
    });
  }
  private latest(context: string): { info: BuildInfo; date: unknown } | null {
    const latest = readJson<{ key?: unknown; context?: unknown; date?: unknown } | null>(path.join(this.cache, "latest.json"), null);
    if (typeof latest?.key !== "string" || !/^[0-9a-f]{32}$/.test(latest.key) || latest.context !== context) return null;
    const info = readJson<BuildInfo | null>(path.join(this.cache, latest.key, "result.json"), null);
    return info && JSON.stringify(info.targets) === '["full"]' && fs.existsSync(info.pdf) && fs.existsSync(info.root) ? { info, date: latest.date } : null;
  }
  private async compile(
    rev: string,
    tree: string,
    key: string,
    targets: string[],
    seed: BuildInfo | null,
    date: ReturnType<typeof buildDate>,
    start: { info: BuildInfo; date: unknown } | "author" | null,
  ): Promise<BuildInfo> {
    const p = this.project,
      partial = JSON.stringify(targets) !== '["full"]',
      folder = path.join(this.cache, key);
    fs.rmSync(folder, { recursive: true, force: true });
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
    fs.mkdirSync(out, { recursive: true });
    const included = includes(fs.readFileSync(path.join(cwd, main), "utf8"));
    for (const target of included)
      fs.mkdirSync(path.join(out, path.dirname(target)), { recursive: true });
    // The PDF, SyncTeX data and log carry over only within a day, so that
    // \today stays current; latexmk then skips TeX when no input changed.
    const reused = base !== null && start !== "author" && start?.date === date.SOURCE_DATE_EPOCH;
    if (base) {
      const previous = path.dirname(base.pdf);
      for (const file of listFiles(previous))
        if (!/\.fls$/i.test(file) && (reused || !OUTPUT.test(file)))
          clone(file, path.join(out, path.relative(previous, file)));
    } else if (start === "author") {
      // Only this job's state: the author's folder may hold other editions.
      const own = path.join(p.root, p.doc_dir, "build");
      if (fs.existsSync(path.join(own, job + ".fdb_latexmk")))
        for (const name of [
          ...fs.readdirSync(own).filter((name) => (name.startsWith(job + ".") && !OUTPUT.test(name) && !name.endsWith(".fls")) || name.startsWith("_minted")),
          ...included.map((target) => target + ".aux"),
        ])
          try {
            if (fs.statSync(path.join(own, name)).isDirectory()) fs.cpSync(path.join(own, name), path.join(out, name), { recursive: true });
            else clone(path.join(own, name), path.join(out, name));
          } catch {
            /* A missing file is regenerated. */
          }
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
      const seedOut = path.dirname(seed!.pdf);
      for (const file of listFiles(seedOut))
        if (AUXILIARY.has(path.extname(file))) {
          const target = path.join(out, path.relative(seedOut, file));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          if (!fs.existsSync(target)) fs.copyFileSync(file, target);
        }
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
    args.push(main);
    const transcript = path.join(folder, "latexmk.log"),
      fd = fs.openSync(transcript, "w"),
      started = now();
    let failure: Error | null = null;
    try {
      await runAsync("latexmk", args, {
        cwd,
        env: { ...process.env, ...date },
        timeout: 1800000,
        output: (chunk) => fs.writeSync(fd, chunk),
      });
    } catch (error) {
      failure = error as Error;
    } finally {
      fs.closeSync(fd);
    }
    const pdf = path.join(out, job + ".pdf"),
      log = path.join(out, job + ".log");
    if (reused && !failure)
      for (const file of [path.join(out, job + ".synctex.gz"), log])
        relocate(file, path.dirname(base!.root), folder);
    const logText = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
    if (failure || !fs.existsSync(pdf)) {
      const transcriptText = fs.readFileSync(transcript, "utf8"),
        details = compilerDiagnostics(logText, transcriptText),
        kept = path.join(p.state, "logs", key + ".log");
      fs.mkdirSync(path.dirname(kept), { recursive: true });
      fs.writeFileSync(
        kept,
        transcriptText + (logText ? "\n\n--- TeX log ---\n" + logText : ""),
      );
      const tail = transcriptText.split("\n").slice(-25);
      fs.rmSync(folder, { recursive: true, force: true });
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
    writeJson(path.join(folder, "result.json"), result);
    return result;
  }
  async prune(keep: Set<string>, maxAge = 3 * 86400) {
    if (!fs.existsSync(this.cache)) return;
    for (const entry of fs.readdirSync(this.cache, { withFileTypes: true })) {
      const folder = path.join(this.cache, entry.name);
      if (
        entry.isDirectory() &&
        !entry.name.endsWith(".lock") &&
        !keep.has(entry.name) &&
        now() - fs.statSync(folder).mtimeMs / 1000 > maxAge
      )
        await withLock(
          path.join(this.cache, entry.name + ".lock"),
          async () => {
            fs.rmSync(folder, { recursive: true, force: true });
          },
        );
    }
  }
}
