import { afterEach, beforeEach, expect, it } from "vitest";
import type { App } from "../../src/server.ts";
import { Fixture, METHOD, fakeRound } from "./helpers.ts";

// While the agent works, a reject is shown at once and reverts its files
// when the turn ends; one whose passage the agent edited again is not applied.
let f: Fixture, app: App;
beforeEach(async () => { f = new Fixture(); app = f.app(); await app.ready; });
afterEach(async () => { await f.close(); });

async function round() {
  const task = app.tasks.create("q", "Q", [], ["paper"], true);
  f.edit(task, METHOD, "Method sentence 2.", "Agent A.");
  f.edit(task, METHOD, "Method sentence 8.", "Agent B.");
  const first = fakeRound(app, task.name), id = (text: string) => first.units.find((u) => u.new_text === text)!.id;
  return { task, first, id };
}

it("shows a reject made while the agent works at once, reverts it when the turn ends, and compiles that ahead", async () => {
  const { task, id } = await round();
  const state = await app.review.decide(task.name, { id: "rq", action: "reject", round: 1, changes: [id("Agent B")], queue: true });
  expect(state.decisions[id("Agent B")]).toBe("rejected");
  expect(state.queued).toEqual([id("Agent B")]);
  expect(state.undo).toMatchObject({ id: "rq", kind: "reject", queued: true });
  // The agent's files are untouched while it works, and it keeps writing.
  expect(f.read(METHOD, task.worktree)).toContain("Agent B.");
  f.edit(task, METHOD, "Detail sentence 3.", "Agent C.");
  // What the turn's end will leave, compiled ahead: B reverted, C kept.
  const ahead = await app.review.queuedTree(task.name, await app.tasks.snapshotAsync(task));
  const text = app.repo.blob(ahead, METHOD)!.toString();
  expect(text).not.toContain("Agent B.");
  expect(text).toContain("Method sentence 8.");
  expect(text).toContain("Agent C.");
  // The turn ends.
  await app.exclusive(() => app.review.applyQueued(task.name));
  expect(f.read(METHOD, task.worktree)).toBe(text);
  expect(app.review.pageState(task.name, 1)).toMatchObject({ decisions: { [id("Agent B")]: "rejected" } });
  expect(app.review.pageState(task.name, 1).queued).toBeUndefined();
  expect(app.review.feedback(task.name).feedback.map((item) => item.kind)).toContain("reject");
});

it("does not apply a queued reject whose passage the agent edited again", async () => {
  const { task, id } = await round();
  await app.review.decide(task.name, { id: "rq", action: "reject", round: 1, changes: [id("Agent A")], queue: true });
  f.edit(task, METHOD, "Agent A.", "Agent A, said better.");
  await app.exclusive(() => app.review.applyQueued(task.name));
  expect(f.read(METHOD, task.worktree)).toContain("Agent A, said better.");
  expect(app.review.pageState(task.name, 1).decisions[id("Agent A")]).toBe("pending");
});

it("an undo drops a queued reject without touching the agent's files", async () => {
  const { task, id } = await round();
  const before = f.read(METHOD, task.worktree);
  await app.review.decide(task.name, { id: "rq", action: "reject", round: 1, changes: [id("Agent B")], queue: true });
  const undone = await app.review.undo(task.name, "rq");
  expect(undone.restored).toEqual([id("Agent B")]);
  expect(undone.decisions[id("Agent B")]).toBe("pending");
  await app.exclusive(() => app.review.applyQueued(task.name));
  expect(f.read(METHOD, task.worktree)).toBe(before);
  // A retried request for the queued reject is answered, not refused.
  await app.review.decide(task.name, { id: "rq2", action: "reject", round: 1, changes: [id("Agent B")], queue: true });
  await expect(app.review.decide(task.name, { id: "rq2", action: "reject", round: 1, changes: [id("Agent B")], queue: true })).resolves.toBeTruthy();
});
