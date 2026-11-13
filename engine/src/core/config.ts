import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Repo, STATE, cleanPath, gitDirOf, stateOf, within } from "./git.ts";
import { readJson, realPath, writeJson } from "./files.ts";
import { legacySettings } from "./legacy-state.ts";
export const ENGINES = ["pdflatex", "xelatex", "lualatex"] as const;
type Engine = (typeof ENGINES)[number];
interface Settings {
  main?: string;
  engine?: Engine;
  latexmkrc?: string;
  source_dir?: string;
  partial_builds?: boolean;
  preload?: Record<string, string>;
  dependencies?: Record<string, string[]>;
  figures?: string[];
  worktrees?: string;
  build_workers?: number;
}
export type BuildOverrides = Pick<Settings, "engine" | "source_dir"> & { ignoreLatexmkrc?: boolean };
interface BuildOverrideRecord { project: string; defaults: string; settings: BuildOverrides }

const buildDefaults = (settings: Record<string, unknown>) => JSON.stringify([settings.main, settings.engine, settings.source_dir, settings.latexmkrc]);

// Agent repairs belong to this installation and compiler host, even when
// the same checkout can be opened by both the Windows and WSL backends.
export function buildOverridesFile(root: string) {
  const data = process.env.PAPILOT_DATA;
  if (!data) return null;
  const key = createHash("sha256")
    .update(JSON.stringify([process.platform, process.arch, process.env.WSL_DISTRO_NAME || "", realPath(root)]))
    .digest("hex");
  return path.join(data, "latex-builds", `${key}.json`);
}
export function readBuildOverrides(root: string, defaults?: Record<string, unknown>): BuildOverrides {
  const file = buildOverridesFile(root);
  const record = file && readJson<BuildOverrideRecord | null>(file, null);
  // A later explicit choice in the paper's settings takes precedence.
  return record && record.defaults === buildDefaults(defaults ?? readSettings(root)) ? record.settings ?? {} : {};
}
export function saveBuildOverrides(root: string, settings: BuildOverrides) {
  const file = buildOverridesFile(root);
  if (!file) throw new Error("The Papilot data directory is unavailable.");
  const project = realPath(root), folder = path.resolve(path.dirname(file));
  let ancestor = folder;
  while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
  const location = path.join(realPath(ancestor), path.relative(ancestor, folder));
  const relative = path.relative(project, location);
  if (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
    throw new Error("The Papilot data directory for build settings must be outside the paper.");
  writeJson(file, { project, defaults: buildDefaults(readSettings(root)), settings }, 0o600);
}

export interface Project {
  root: string;
  state: string;
  main: string;
  engine: Engine;
  latexmkrc: string | null;
  source_dir: string;
  partial_builds: boolean;
  preload: Record<string, string>;
  dependencies: Record<string, string[]>;
  figures: string[];
  worktrees: string;
  build_workers: number;
  doc_dir: string;
}
const SKIP = new Set(["build", "out", "output", "node_modules", "__pycache__"]);
const PREFERRED = [
  "main",
  "thesis",
  "paper",
  "manuscript",
  "document",
  "ms",
  "article",
  "report",
  "book",
];
const read = (root: string, file: string) =>
  fs.readFileSync(path.join(root, file), "utf8");
/** A paper's settings, in its Git directory. Usually there are none: the
 *  root document and engine are detected, and Papilot saves what the author
 *  chooses instead. */
export const settingsFile = (root: string) => path.join(stateOf(root), "settings.json");
// The settings file as the author finds it, for messages: relative to the
// paper, unless the paper is a linked worktree whose Git directory lies
// elsewhere. Naming it moves nothing.
function settingsName(root: string) {
  try {
    const file = path.join(gitDirOf(root), STATE, "settings.json"), relative = path.relative(realPath(root), file);
    return relative.startsWith("..") || path.isAbsolute(relative) ? file : relative.split(path.sep).join("/");
  } catch {
    return ".git/papilot/settings.json";
  }
}
export function readSettings(root: string): Record<string, unknown> {
  const file = settingsFile(root);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(`${settingsName(root)} cannot be read (${(error as Error).message}).`);
    // Settings an earlier version kept in the working tree move here once.
    const legacy = legacySettings(root);
    if (legacy) createOnce(file, JSON.stringify(legacy, null, 2) + "\n");
    return legacy ?? {};
  }
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    throw new Error(`${settingsName(root)} is not valid JSON.`);
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new Error(`${settingsName(root)} must contain an object.`);
  return settings as Record<string, unknown>;
}
// Creates `file` with `text` unless another process did, never showing a
// reader a partly written file.
function createOnce(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, text);
  try {
    fs.linkSync(temporary, file);
  } catch (error) {
    // Some file systems have no hard links.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST")
      try {
        fs.writeFileSync(file, text, { flag: "wx" });
      } catch (again) {
        if ((again as NodeJS.ErrnoException).code !== "EEXIST") throw again;
      }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
export function writeSettings(root: string, settings: Record<string, unknown>) {
  writeJson(settingsFile(root), settings);
}
export function detectMain(root: string) {
  const directories = [
    "",
    ...fs
      .readdirSync(root, { withFileTypes: true })
      .filter(
        (d) => d.isDirectory() && !d.name.startsWith(".") && !SKIP.has(d.name),
      )
      .map((d) => d.name)
      .sort(),
  ];
  for (const directory of directories)
    for (const rc of ["latexmkrc", ".latexmkrc"]) {
      const file = path.join(directory, rc);
      if (fs.existsSync(path.join(root, file))) {
        const match = read(root, file).match(
          /@default_files\s*=\s*\(\s*['"]([^'"]+)['"]/,
        );
        if (match && fs.existsSync(path.join(root, directory, match[1])))
          return path.posix.join(directory, match[1]);
      }
    }
  const found = directories
    .flatMap((directory) =>
      fs
        .readdirSync(path.join(root, directory))
        .filter((name) => name.endsWith(".tex"))
        .map((name) => path.posix.join(directory, name)),
    )
    .filter((file) => {
      const text = read(root, file).slice(0, 300000);
      return (
        /^[^%\n]*\\documentclass/m.test(text) &&
        text.includes("\\begin{document}")
      );
    });
  if (found.length === 1) return found[0];
  if (!found.length)
    throw new Error(
      `No root document found. Set "main" in ${settingsName(root)}, e.g. {"main":"path/to/main.tex"}.`,
    );
  const rank = (file: string) => [
    file.split("/").length,
    PREFERRED.includes(path.basename(file, ".tex").toLowerCase())
      ? PREFERRED.indexOf(path.basename(file, ".tex").toLowerCase())
      : PREFERRED.length,
  ];
  found.sort((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1] - rank(b)[1]);
  if (
    JSON.stringify(rank(found[0])) !== JSON.stringify(rank(found[1])) &&
    rank(found[0])[1] < PREFERRED.length
  )
    return found[0];
  throw new Error(
    `Several root documents were found (${found.slice(0, 6).join(", ")}). Set "main" in ${settingsName(root)}.`,
  );
}
/** Identify the existing inputs even when another build setting is invalid. */
export function loadBuildDocuments(root: string, settings: { main?: unknown; latexmkrc?: unknown }, ignoreLatexmkrc = false) {
  for (const key of ["main", "latexmkrc"] as const)
    if (settings[key] !== undefined && typeof settings[key] !== "string")
      throw new Error(`"${key}" must be a string.`);
  const main = settings.main ? cleanPath(settings.main as string) : detectMain(root),
    doc_dir = path.posix.dirname(main) === "." ? "" : path.posix.dirname(main);
  if (!fs.existsSync(path.join(root, main)))
    throw new Error(`Root document not found: ${main}`);
  const latexmkrc = ignoreLatexmkrc ? null : settings.latexmkrc
    ? cleanPath(settings.latexmkrc as string)
    : ([...new Set([doc_dir, ""])]
        .flatMap((dir) =>
          ["latexmkrc", ".latexmkrc"].map((n) => path.posix.join(dir, n)),
        )
        .find((f) => fs.existsSync(path.join(root, f))) ?? null);
  return { main, doc_dir, latexmkrc };
}
export function loadProject(root: string, overrides?: BuildOverrides): Project {
  root = realPath(root);
  const defaults = readSettings(root);
  const { ignoreLatexmkrc, ...buildSettings } = overrides ?? readBuildOverrides(root, defaults);
  const settings = { ...defaults, ...buildSettings } as Settings;
  const allowed = new Set([
    "main",
    "engine",
    "latexmkrc",
    "source_dir",
    "partial_builds",
    "preload",
    "dependencies",
    "figures",
    "worktrees",
    "build_workers",
  ]);
  const unknown = Object.keys(settings).filter((k) => !allowed.has(k));
  if (unknown.length)
    throw new Error(`Unknown settings: ${unknown.join(", ")}`);
  for (const key of [
    "engine",
    "source_dir",
    "worktrees",
  ] as const)
    if (settings[key] !== undefined && typeof settings[key] !== "string")
      throw new Error(`"${key}" must be a string.`);
  if (
    settings.partial_builds !== undefined &&
    typeof settings.partial_builds !== "boolean"
  )
    throw new Error('"partial_builds" must be a boolean.');
  if (
    settings.figures !== undefined &&
    (!Array.isArray(settings.figures) ||
      settings.figures.some((f) => typeof f !== "string"))
  )
    throw new Error('"figures" must be a list of paths.');
  if (settings.preload === null || settings.dependencies === null)
    throw new Error('"preload" and "dependencies" must be objects.');
  const { main, doc_dir, latexmkrc } = loadBuildDocuments(root, settings, ignoreLatexmkrc);
  const text = read(root, main),
    magic = text
      .split("\n")
      .slice(0, 40)
      .join("\n")
      .match(/^%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*(\w+)/im)?.[1]
      .toLowerCase();
  const aliases: Record<string, Engine> = {
    xetex: "xelatex",
    luatex: "lualatex",
    pdftex: "pdflatex",
    pdflatex: "pdflatex",
    xelatex: "xelatex",
    lualatex: "lualatex",
  };
  const mode = latexmkrc
    ? read(root, latexmkrc).match(/^\s*\$pdf_mode\s*=\s*(\d)/m)?.[1]
    : null;
  const hinted =
    /^[^%\n]*(?:\\usepackage(?:\[[^\]]*\])?\{[^}]*\b(?:fontspec|xeCJK|unicode-math|polyglossia)\b|\\documentclass(?:\[[^\]]*\])?\{ctex)/m.test(
      text,
    );
  const engine =
    settings.engine ??
    ((magic && aliases[magic]) ||
      (
        { "1": "pdflatex", "4": "lualatex", "5": "xelatex" } as Record<
          string,
          Engine
        >
      )[mode ?? ""] ||
      (hinted ? "xelatex" : "pdflatex"));
  if (!ENGINES.includes(engine as Engine))
    throw new Error(`"engine" must be one of ${ENGINES.join(", ")}.`);
  const source_dir = cleanPath(settings.source_dir ?? doc_dir);
  if (
    !within(main, [source_dir]) ||
    (latexmkrc && !within(latexmkrc, [source_dir]))
  )
    throw new Error(
      '"source_dir" must contain the root document and its latexmkrc.',
    );
  const preload = settings.preload ?? {},
    dependencies = settings.dependencies ?? {};
  if (
    Array.isArray(preload) ||
    typeof preload !== "object" ||
    Object.values(preload).some((v) => typeof v !== "string")
  )
    throw new Error('"preload" maps include targets to filenames.');
  if (
    Array.isArray(dependencies) ||
    typeof dependencies !== "object" ||
    Object.values(dependencies).some(
      (v) => !Array.isArray(v) || v.some((x) => typeof x !== "string"),
    )
  )
    throw new Error('"dependencies" maps include targets to lists of targets.');
  const figures =
    settings.figures?.map(cleanPath) ??
    ["figures", "figs"]
      .map((n) => path.posix.join(doc_dir, n))
      .filter(
        (n) =>
          fs.existsSync(path.join(root, n)) &&
          fs.statSync(path.join(root, n)).isDirectory(),
      );
  const worktrees = settings.worktrees
    ? path.resolve(root, settings.worktrees)
    : path.join(path.dirname(root), path.basename(root) + "-tasks");
  if (worktrees === root || worktrees.startsWith(root + path.sep))
    throw new Error('"worktrees" must be outside the repository.');
  const build_workers = settings.build_workers ?? 1;
  if (
    !Number.isInteger(build_workers) ||
    build_workers < 1 ||
    build_workers > 8
  )
    throw new Error('"build_workers" must be an integer between 1 and 8.');
  return {
    root,
    state: stateOf(root),
    main,
    doc_dir,
    engine: engine as Engine,
    latexmkrc,
    source_dir,
    partial_builds: settings.partial_builds !== false,
    preload,
    dependencies,
    figures,
    worktrees,
    build_workers,
  };
}
export const signature = (p: Project) =>
  JSON.stringify([
    p.main,
    p.engine,
    p.latexmkrc,
    p.source_dir,
    p.preload,
    p.dependencies,
  ]);
export const isFigure = (p: Project, file: string) => within(file, p.figures);
