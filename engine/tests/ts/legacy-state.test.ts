import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { Fixture } from "./helpers.ts";
import { loadProject } from "../../src/core/config.ts";
import { legacyServerHome, moveLegacyState } from "../../src/core/legacy-state.ts";
import { REFS, STATE, gitBinary, stateDir, stateOf } from "../../src/core/git.ts";
import { run } from "../../src/core/process.ts";
import { realPath } from "../../src/core/files.ts";
import { stopServerIn } from "../../src/client.ts";

// Papilot 0.9.4 and earlier kept a paper's state under the names of the review
// engine's former standalone skill. Opening the paper moves it.
let f: Fixture;
afterEach(() => f?.close());
const refs = (prefix: string) => f.repo.text(["for-each-ref", "--format=%(refname) %(objectname)", prefix]);
const git = (gitDir: string) => (args: string[], input?: string) =>
  run(gitBinary(), ["--git-dir", gitDir, ...args], { input }).stdout.toString();
const isLink = (file: string) => fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;

it("moves the state folder, task refs, worktree indexes and settings, and earlier paths stay valid", () => {
  f = new Fixture();
  const head = f.repo.rev("HEAD"), gitDir = path.join(realPath(f.root), ".git"), old = path.join(gitDir, "latex-review");
  f.write("rounds/polish/001/round.json", "{}", old);
  // Rounds, jobs and cached builds name files in the folder by absolute path.
  const places = JSON.stringify({ old: { pdf: path.join(old, "cache/builds/a/src/build/main.pdf") } });
  f.write("rounds/polish/001/places.json", places, old);
  f.write("cache/builds/a/src/build/main.pdf", "%PDF", old);
  f.repo.run(["update-ref", "refs/latex-review/polish/base", head]);
  f.repo.run(["update-ref", "refs/latex-review/polish/round-1", head]);
  f.repo.run(["pack-refs", "--all"]);
  f.repo.run(["update-ref", "refs/latex-review/polish/accepted", head]);
  const worktree = path.join(f.base, "polish");
  f.repo.run(["worktree", "add", "-q", "--detach", worktree]);
  const worktreeState = path.join(gitDir, "worktrees/polish");
  f.write("latex-review/snapshot-index", "index", worktreeState);
  f.write(".latex-review.json", JSON.stringify({ main: "paper/main.tex", engine: "lualatex", partial_builds: false }));

  const project = loadProject(f.root), state = path.join(gitDir, STATE);
  expect(project.state).toBe(state);
  expect([project.main, project.engine, project.partial_builds]).toEqual(["paper/main.tex", "lualatex", false]);
  expect(fs.existsSync(path.join(state, "rounds/polish/001/round.json"))).toBe(true);
  expect(isLink(old)).toBe(true);
  expect(fs.readFileSync(path.join(state, "rounds/polish/001/places.json"), "utf8")).toBe(places);
  expect(fs.readFileSync(JSON.parse(places).old.pdf, "utf8")).toBe("%PDF");
  expect(refs("refs/latex-review/")).toBe("");
  expect(refs(REFS).split("\n").sort()).toEqual(["accepted", "base", "round-1"].map((name) => `${REFS}polish/${name} ${head}`));
  expect(fs.readFileSync(path.join(worktreeState, STATE, "snapshot-index"), "utf8")).toBe("index");
  expect(isLink(path.join(worktreeState, "latex-review"))).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(state, "settings.json"), "utf8"))).toEqual({ main: "paper/main.tex", engine: "lualatex", partial_builds: false });
  // The author's file is left as it is; later changes go to the new settings.
  expect(fs.existsSync(path.join(f.root, ".latex-review.json"))).toBe(true);
  fs.writeFileSync(path.join(state, "settings.json"), JSON.stringify({ main: "paper/main.tex" }));
  expect(loadProject(f.root).engine).toBe("pdflatex");
  expect(legacyServerHome(gitDir)).toBe(null);
});

it("moves the whole state of a linked worktree that was added as a paper", () => {
  f = new Fixture();
  const worktree = path.join(f.base, "draft");
  f.repo.run(["worktree", "add", "-q", "--detach", worktree]);
  const own = path.join(realPath(f.root), ".git/worktrees/draft");
  f.write("latex-review/state.sqlite3", "tasks", own);
  f.write("latex-review/server/connection.json", "{}", own);
  expect(legacyServerHome(own)).toBe(path.join(own, "latex-review/server"));
  f.repo.run(["update-ref", "refs/latex-review/edit/base", f.repo.rev("HEAD")]);
  expect(stateOf(worktree)).toBe(path.join(own, STATE));
  expect(fs.readFileSync(path.join(own, STATE, "state.sqlite3"), "utf8")).toBe("tasks");
  expect(fs.existsSync(path.join(realPath(f.root), ".git", STATE))).toBe(false);
  expect(refs("refs/latex-review/")).toBe("");
});

it("deletes nothing when an older version left a folder beside the current one", () => {
  f = new Fixture();
  const head = f.repo.rev("HEAD"), gitDir = path.join(realPath(f.root), ".git");
  f.repo.run(["worktree", "add", "-q", "--detach", path.join(f.base, "task")]);
  for (const dir of [gitDir, path.join(gitDir, "worktrees/task")]) {
    f.write("latex-review/state.sqlite3", "older", dir);
    f.write(`${STATE}/state.sqlite3`, "current", dir);
  }
  f.repo.run(["update-ref", "refs/latex-review/polish/base", head]);
  f.repo.run(["update-ref", `${REFS}polish/base`, head]);
  f.repo.run(["update-ref", "refs/latex-review/other/base", head]);
  for (let pass = 0; pass < 2; pass++) {
    moveLegacyState(gitDir, git(gitDir), STATE, REFS);
    for (const dir of [gitDir, path.join(gitDir, "worktrees/task")]) {
      expect(fs.readFileSync(path.join(dir, STATE, "state.sqlite3"), "utf8")).toBe("current");
      expect(fs.readFileSync(path.join(dir, "latex-review/state.sqlite3"), "utf8")).toBe("older");
    }
    // A ref whose new name is taken stays where it was, so its commits remain.
    expect(refs("refs/latex-review/")).toBe(`refs/latex-review/polish/base ${head}`);
    expect(refs(`${REFS}other/`)).toBe(`${REFS}other/base ${head}`);
  }
});

// A folder that cannot move yet, as one whose earlier server still holds its
// files on Windows, simulated here by a folder that cannot be changed.
it.skipIf(process.platform === "win32")("another paper's folder that cannot move yet does not keep this paper from opening", () => {
  f = new Fixture();
  f.repo.run(["worktree", "add", "-q", "--detach", path.join(f.base, "other")]);
  const gitDir = path.join(realPath(f.root), ".git"), other = path.join(gitDir, "worktrees/other");
  f.write("latex-review/state.sqlite3", "main", gitDir);
  f.write("latex-review/state.sqlite3", "other", other);
  fs.chmodSync(other, 0o555);
  try {
    expect(stateDir(gitDir)).toBe(path.join(gitDir, STATE));
    expect(fs.readFileSync(path.join(gitDir, STATE, "state.sqlite3"), "utf8")).toBe("main");
    expect(fs.readFileSync(path.join(other, "latex-review/state.sqlite3"), "utf8")).toBe("other");
    // That paper itself reports why it cannot open.
    expect(() => moveLegacyState(other, git(other), STATE, REFS)).toThrow("could not move");
  } finally {
    fs.chmodSync(other, 0o755);
  }
  moveLegacyState(other, git(other), STATE, REFS);
  expect(fs.readFileSync(path.join(other, STATE, "state.sqlite3"), "utf8")).toBe("other");
});

it("leaves a paper without earlier state as it is", () => {
  f = new Fixture();
  const gitDir = path.join(realPath(f.root), ".git");
  expect(stateDir(gitDir)).toBe(path.join(gitDir, STATE));
  expect(fs.existsSync(path.join(gitDir, STATE))).toBe(false);
  expect(fs.existsSync(path.join(gitDir, "latex-review"))).toBe(false);
});

it("reports settings that cannot be used instead of guessing", () => {
  f = new Fixture();
  fs.mkdirSync(path.join(f.root, ".git", STATE, "settings.json"), { recursive: true });
  expect(() => loadProject(f.root)).toThrow(".git/papilot/settings.json cannot be read");
  fs.rmSync(path.join(f.root, ".git", STATE), { recursive: true });
  f.write(".latex-review.json", "{broken");
  expect(() => loadProject(f.root)).toThrow(".latex-review.json is not valid JSON");
});

// On Windows a running server's open files keep its folder from moving, so
// Papilot stops an earlier version's server first, even mid-build.
it("stops the review server recorded in a folder and waits until it has exited", async () => {
  f = new Fixture();
  const home = path.join(f.root, ".git", STATE, "server");
  const engine = spawn(process.execPath, ["--import", "tsx", path.join(import.meta.dirname, "../../src/cli.ts"), "serve", "--root", f.root, "--port", "0"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; engine.stderr!.on("data", (chunk) => { stderr += chunk; });
  try {
    for (const end = Date.now() + 20000; !fs.existsSync(path.join(home, "connection.json")); await new Promise((resolve) => setTimeout(resolve, 100)))
      expect(Date.now() < end && engine.exitCode === null, stderr).toBe(true);
    await stopServerIn(home, f.root);
    expect(() => process.kill(engine.pid!, 0)).toThrow();
    // A folder whose server is gone, or that names none, is left alone.
    await stopServerIn(home, f.root);
    await stopServerIn(path.join(f.base, "missing"), f.root);
  } finally {
    engine.kill();
  }
}, 40000);
