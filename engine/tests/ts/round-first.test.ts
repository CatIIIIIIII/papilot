import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { Builder } from "../../src/core/build.ts";
import { which } from "../../src/core/process.ts";
import { rendered, roundFolder } from "../../src/core/carry.ts";
import { Fixture } from "./helpers.ts";
import type { App } from "../../src/server.ts";
import type { Task } from "../../src/types.ts";

const tex = Boolean(which("latexmk") && which("pdflatex"));
const FILE = "paper/sections/method.tex";
async function fixture() {
  const f = new Fixture();
  f.write("paper/main.tex", "\\documentclass{article}\n\\begin{document}\n\\input{sections/method}\n\\end{document}\n");
  f.write(FILE, "\\section{First}\nOriginal first paragraph.\n\\newpage\n\\section{Second}\nOriginal second paragraph.\n");
  f.repo.run(["add", "-A"]); f.repo.run(["commit", "-qm", "Separate pages"]);
  const app = f.app(); await app.ready;
  const task = app.tasks.create("rounds", "Rounds", [], ["paper"], true);
  f.edit(task, FILE, "Original first paragraph.", "Proposed first paragraph.");
  f.edit(task, FILE, "Original second paragraph.", "Proposed second paragraph.");
  await publish(app, task);
  return { f, app, task };
}
async function publish(app: App, task: Task) {
  const job = app.publisher.submit(task.name); await app.publisher.join();
  expect(app.publisher.job(job.id).status, JSON.stringify(app.publisher.job(job.id).result)).toBe("done");
  return app.review.latestRound(task.name)!;
}
function holdBuilds() {
  const original = Builder.prototype.build;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const spy = vi.spyOn(Builder.prototype, "build").mockImplementation(async function (this: Builder, ...args) {
    entered(); await gate; return original.apply(this, args);
  });
  return { release, started, spy };
}

it.skipIf(!tex)("inserts before rendering, gates only waiting changes, and keeps decisions without restarting publication", async () => {
  const { f, app, task } = await fixture(), held = holdBuilds();
  try {
    // The change before the corrected one, on an earlier page, keeps its comparison.
    f.edit(task, FILE, "Proposed second paragraph.", "A corrected second paragraph.");
    const job = app.publisher.submit(task.name); await held.started;
    const pending = app.review.latestRound(task.name)!;
    expect(pending).toMatchObject({ number: 2, visuals: "pending" });
    const detail = app.review.roundDetail(task.name, 2), waiting = detail.units.find(unit => unit.waiting)!, carried = detail.units.find(unit => unit.carried)!;
    expect(waiting.id).toBe("c002");
    expect(carried.id).toBe("c001");
    expect(app.review.summary(task.name).ready).toBe(1);
    await expect(app.review.decide(task.name, { action: "accept", round: 2, changes: [waiting.id] })).rejects.toThrow("PDF comparison");
    await app.review.decide(task.name, { id: "carried-accept", action: "accept", round: 2, changes: [carried.id] });
    const accepted = app.tasks.get(task.name).accepted;
    held.release(); await app.publisher.join();
    expect(app.publisher.job(job.id)).toMatchObject({ status: "done", result: { round: 2 } });
    expect(app.review.latestRound(task.name)?.number).toBe(2);
    expect(app.tasks.get(task.name).accepted).toBe(accepted);
    const text = app.repo.blob(accepted, FILE)!.toString();
    expect(text).toContain("Proposed first paragraph.");
    expect(text).toContain("Original second paragraph.");
    // Seen evidence remains tied to the comparison the author actually saw.
    const action = app.store.one<any>("SELECT * FROM actions WHERE id=?", "carried-accept");
    expect(action.detail.seen[carried.id]).toEqual({ round: 1, change: carried.id });
    expect(app.review.pageState(task.name).reviewAgain ?? []).toEqual([]);
    // If the final visible comparison differs, the decision is flagged.
    const folder = roundFolder(app, task.name, 2), file = path.join(folder, "round.json"), image = JSON.parse(fs.readFileSync(file, "utf8"));
    const blocks = [...image.sections.flatMap((section: any) => section.blocks), ...image.loose];
    const block = blocks.find((block: any) => block.units?.includes(carried.id));
    block.after[0].width += 10;
    fs.writeFileSync(file + ".new", JSON.stringify(image)); fs.renameSync(file + ".new", file);
    expect(app.review.pageState(task.name).reviewAgain).toContain(carried.id);
  } finally { held.release(); await f.close(); vi.restoreAllMocks(); }
}, 120000);

it.skipIf(!tex)("an inline save inserts the next round while an earlier comparison is held and skips obsolete rendering", async () => {
  const { f, app, task } = await fixture(), held = holdBuilds();
  try {
    f.edit(task, FILE, "Proposed first paragraph.", "First correction.");
    const old = app.publisher.submit(task.name); await held.started;
    const source = app.sourceEdits.read(task.name, 2, "c001");
    await app.sourceEdits.save(task.name, { id: "during-render", round: 2, change: "c001", revision: source.revision, text: "Second correction.\n" });
    expect(app.review.latestRound(task.name)).toMatchObject({ number: 3, visuals: "pending" });
    held.release(); await app.publisher.join();
    expect(app.publisher.job(old.id)).toMatchObject({ status: "done", result: { round: 2, superseded: true } });
    expect(app.review.latestRound(task.name)).toMatchObject({ number: 3, visuals: "ready" });
    expect(f.read(FILE, task.worktree)).toContain("Second correction.");
  } finally { held.release(); await f.close(); vi.restoreAllMocks(); }
}, 120000);

it.skipIf(!tex)("recovers an inserted pending round and restores its missing Git ref after restart", async () => {
  const f = new Fixture();
  try {
    const app = f.app(); await app.ready;
    const task = app.tasks.create("recover", "Recover", [], ["paper"], true);
    f.edit(task, FILE, "Method sentence 2.", "Recovered wording.");
    const job = app.publisher.submit(task.name);
    app.publisher.stop();
    await app.exclusive(() => app.publisher.insertNow(job));
    expect(app.review.latestRound(task.name)?.visuals).toBe("pending");
    app.repo.run(["update-ref", "-d", `refs/latex-review/${task.name}/round-1`]);
    await app.close(); f.apps.splice(f.apps.indexOf(app), 1);
    const restarted = f.app(); await restarted.ready; await restarted.publisher.join();
    const round = restarted.review.latestRound(task.name)!;
    expect(round.visuals).toBe("ready");
    expect(restarted.repo.rev(`refs/latex-review/${task.name}/round-1`)).toBe(round.after);
    expect(restarted.publisher.job(job.id).status).toBe("done");
  } finally { await f.close(); }
}, 120000);

for (const resumed of ["its job", "a new job"])
  it.skipIf(!tex)(`renders a pending round that lists indirect changes after restart with ${resumed}, without inserting another`, async () => {
    const f = new Fixture();
    try {
      const app = f.app(); await app.ready;
      const task = app.tasks.create("recover", "Recover", [], ["paper"], true);
      f.edit(task, FILE, "Method sentence 2.", "Recovered wording.");
      const job = app.publisher.submit(task.name, undefined, true);
      app.publisher.stop();
      await app.exclusive(() => app.publisher.insertNow(job));
      expect(app.review.latestRound(task.name)?.summary.indirect).toBe(true);
      // A job that no longer runs: recovery submits the task again.
      if (resumed === "a new job") app.store.execute("UPDATE jobs SET status='failed' WHERE id=?", job.id);
      await app.close(); f.apps.splice(f.apps.indexOf(app), 1);
      const restarted = f.app(); await restarted.ready; await restarted.publisher.join();
      const rounds = restarted.store.all<{ number: number; visuals: string }>("SELECT number,visuals FROM rounds WHERE task=?", task.name);
      expect(rounds).toEqual([{ number: 1, visuals: "ready" }]);
      expect(restarted.review.latestRound(task.name)?.summary.indirect).toBe(true);
    } finally { await f.close(); }
  }, 120000);

it.skipIf(!tex)("a failed render retains exact earlier comparisons and leaves the changed source repairable", async () => {
  const { f, app, task } = await fixture();
  try {
    f.edit(task, FILE, "Proposed first paragraph.", "Broken first paragraph.");
    vi.spyOn(Builder.prototype, "build").mockRejectedValue(new Error("Fixture compiler failure"));
    const job = app.publisher.submit(task.name); await app.publisher.join();
    expect(app.publisher.job(job.id).status).toBe("failed");
    expect(app.review.latestRound(task.name)).toMatchObject({ number: 2, visuals: "failed" });
    expect(app.review.summary(task.name).state).toBe("build_failed");
    expect(Object.keys(rendered(app, task.name, 2).carried ?? {})).toEqual(["c002"]);
    expect(app.sourceEdits.read(task.name, 2, "c001").text).toContain("Broken first");
    await expect(app.review.decide(task.name, { action: "reject", round: 2, changes: ["c001"] })).rejects.toThrow("PDF comparison");
  } finally { await f.close(); vi.restoreAllMocks(); }
}, 120000);
