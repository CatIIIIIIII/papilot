import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Fixture, fakeRound, METHOD, BODY } from "./helpers.ts";
import { createServer, type App } from "../../src/server.ts";
import type { SourceEditRequest, Task } from "../../src/types.ts";

let f: Fixture, app: App, task: Task;
beforeEach(async () => {
  f = new Fixture(); app = f.app(); await app.ready;
  task = app.tasks.create("polish", "Polish", [], ["paper"], true);
  f.edit(task, METHOD, "Method sentence 2.", "Agent wording.");
  f.edit(task, METHOD, "Detail sentence 15.", "Another proposal.");
  fakeRound(app, task.name);
  vi.spyOn(app.publisher, "publish").mockResolvedValue({ outcome: "unchanged", round: 1, changes: 2 });
});
afterEach(async () => { await f.close(); vi.restoreAllMocks(); });
function input(text = "My wording.", change = "c001"): SourceEditRequest {
  const source = app.sourceEdits.read(task.name, 1, change);
  return { id: "manual-edit", round: 1, change, revision: source.revision, text };
}
it("saves only the selected source in the task, preserves line boundaries, and publishes once on retry", async () => {
  const edit = input(), state = await app.sourceEdits.save(task.name, edit);
  await app.publisher.join();
  expect(state.job?.id).toBeTruthy();
  expect(f.read(METHOD, task.worktree)).toBe(BODY.replace("Method sentence 2.", "My wording.").replace("Detail sentence 15.", "Another proposal."));
  expect(f.read(METHOD)).toBe(BODY);
  expect(app.review.pageState(task.name).decisions).toEqual({ c001: "pending", c002: "pending" });
  await app.sourceEdits.save(task.name, edit);
  await app.publisher.join();
  expect(app.publisher.publish).toHaveBeenCalledTimes(1);
  await expect(app.sourceEdits.save(task.name, { ...edit, text: "Different" })).rejects.toThrow("already used");
});
it("refuses a stale draft without overwriting external edits", async () => {
  const edit = input();
  f.edit(task, METHOD, "Another proposal.", "Changed elsewhere.");
  await expect(app.sourceEdits.save(task.name, edit)).rejects.toThrow("source changed");
  expect(f.read(METHOD, task.worktree)).toContain("Agent wording.");
  expect(f.read(METHOD, task.worktree)).toContain("Changed elsewhere.");
  expect(app.publisher.publish).not.toHaveBeenCalled();
});
it("can correct saved source after compilation fails, including inserted lines", async () => {
  vi.mocked(app.publisher.publish).mockRejectedValueOnce(new Error("Compilation failed"));
  await app.sourceEdits.save(task.name, input("Broken first line.\nBroken second line."));
  await app.publisher.join();
  expect(app.publisher.current(task.name)?.status).toBe("failed");
  const source = app.sourceEdits.read(task.name, 1, "c001");
  expect(source.text).toBe("Broken first line.\nBroken second line.\n");
  await app.sourceEdits.save(task.name, { ...input("Corrected."), id: "repair" });
  await app.publisher.join();
  expect(f.read(METHOD, task.worktree)).toContain("Corrected.\nMethod sentence 3.");
});
it("follows source line shifts without resurrecting a rejected proposal", async () => {
  f.edit(task, METHOD, "Another proposal.", "Another proposal.\nExtra line.");
  const round = fakeRound(app, task.name);
  await app.review.decide(task.name, { action: "reject", changes: ["c001"], round: round.number });
  const source = app.sourceEdits.read(task.name, round.number, "c002");
  expect(source.text).toBe("Another proposal.\nExtra line.\n");
  await app.sourceEdits.save(task.name, { id: "second", round: round.number, change: "c002", revision: source.revision, text: "Handwritten." });
  await app.publisher.join();
  expect(f.read(METHOD, task.worktree)).toBe(BODY.replace("Detail sentence 15.", "Handwritten."));
  expect(() => app.sourceEdits.read(task.name, round.number, "c001")).toThrow("rejected");
  expect(() => app.sourceEdits.read(task.name, 1, "c002")).toThrow("newer round");
});
it("loads complete long changes instead of the truncated displayed diff", async () => {
  const long = "word ".repeat(1500);
  f.edit(task, METHOD, "Agent wording.", long);
  const round = fakeRound(app, task.name);
  expect(round.units[0].truncated).toBe(true);
  expect(app.sourceEdits.read(task.name, round.number, "c001").text).toBe(long + "\n");
});
it("refuses paths outside the task worktree", () => {
  const target = path.join(task.worktree, METHOD);
  fs.unlinkSync(target); fs.symlinkSync(path.join(f.root, METHOD), target);
  expect(() => app.sourceEdits.read(task.name, 1, "c001")).toThrow("outside");
  expect(f.read(METHOD)).toBe(BODY);
});
it("recovers an interrupted write without applying the replacement twice", async () => {
  const edit = input("One.\nTwo.");
  await app.sourceEdits.save(task.name, edit); await app.publisher.join();
  const record = app.store.one<{ data: { applied: boolean } }>("SELECT data FROM source_edits WHERE id=?", edit.id)!;
  record.data.applied = false;
  app.store.execute("UPDATE source_edits SET data=? WHERE id=?", JSON.stringify(record.data), edit.id);
  await app.sourceEdits.save(task.name, edit); await app.publisher.join();
  expect(f.read(METHOD, task.worktree).match(/One\./g)).toHaveLength(1);
  expect(app.publisher.publish).toHaveBeenCalledTimes(1);
});
it("protects source HTTP writes with CSRF, validates requests and ignores caller-supplied paths", async () => {
  const server = createServer(app), url = `/api/tasks/${task.name}/source`;
  try {
    const headers = { host: "127.0.0.1:9", "x-review-token": app.csrf };
    expect((await server.inject({ url: url + "?round=1&change=c001", headers })).json().text).toBe("Agent wording.\n");
    expect((await server.inject({ method: "POST", url, headers: { host: headers.host }, payload: input() })).statusCode).toBe(403);
    expect((await server.inject({ method: "POST", url, headers, payload: { ...input(), revision: "invalid" } })).statusCode).toBe(400);
    const result = await server.inject({ method: "POST", url, headers, payload: { ...input(), file: "../../outside" } });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().sourceEditing).toBe(true);
    expect(f.read(METHOD)).toBe(BODY);
  } finally { await server.close(); }
});

// The workspace's editor beside the review edits whole files of the task.
it("reads a whole file of the task beside the file before the task", () => {
  const file = app.sourceEdits.readFile(task.name, METHOD);
  expect(file.round).toBe(1);
  expect(file.text).toBe(f.read(METHOD, task.worktree));
  expect(file.base).toBe(BODY);
  expect(() => app.sourceEdits.readFile(task.name, "missing.tex")).toThrow("no longer exists");
});
it("saves a whole file once, reviews it in a new round, and refuses stale drafts", async () => {
  const file = app.sourceEdits.readFile(task.name, METHOD), text = file.text.replace("Agent wording.", "Typed in the editor.");
  const edit = { id: "whole-file", round: 1, file: METHOD, revision: file.revision, text };
  const state = await app.sourceEdits.saveFile(task.name, edit);
  await app.publisher.join();
  expect(state.job?.id).toBeTruthy();
  expect(state.source.text).toBe(text);
  expect(f.read(METHOD, task.worktree)).toBe(text);
  expect(f.read(METHOD)).toBe(BODY);
  await app.sourceEdits.saveFile(task.name, edit);
  await app.publisher.join();
  expect(app.publisher.publish).toHaveBeenCalledTimes(1);
  await expect(app.sourceEdits.saveFile(task.name, { ...edit, id: "stale", text: "Old draft." })).rejects.toThrow("source changed");
  // A newer round that left the file alone keeps the draft savable.
  fakeRound(app, task.name);
  const now = app.sourceEdits.readFile(task.name, METHOD);
  await app.sourceEdits.saveFile(task.name, { ...edit, id: "late", revision: now.revision, text: "Saved after a newer round.\n" });
  expect(f.read(METHOD, task.worktree)).toBe("Saved after a newer round.\n");
});
it("keeps a whole file's line endings and byte order mark", async () => {
  const target = path.join(task.worktree, METHOD);
  fs.writeFileSync(target, "﻿First line.\r\nSecond line.\r\n");
  const round = fakeRound(app, task.name), file = app.sourceEdits.readFile(task.name, METHOD);
  expect(file.text).toBe("First line.\r\nSecond line.\r\n");
  await app.sourceEdits.saveFile(task.name, { id: "crlf", round: round.number, file: METHOD, revision: file.revision, text: "First line.\nEdited line.\n" });
  expect(fs.readFileSync(target, "utf8")).toBe("﻿First line.\r\nEdited line.\r\n");
});
it("refuses a whole file too large in bytes before saving or reviewing it", async () => {
  const file = app.sourceEdits.readFile(task.name, METHOD), before = f.read(METHOD, task.worktree);
  // 700,000 characters pass the length check but are 2,100,000 bytes in UTF-8.
  await expect(app.sourceEdits.saveFile(task.name, { id: "wide", round: file.round, file: METHOD, revision: file.revision, text: "中".repeat(700_000) })).rejects.toThrow("too large");
  expect(f.read(METHOD, task.worktree)).toBe(before);
  expect(app.sourceEdits.readFile(task.name, METHOD).text).toBe(before);
});
it("refuses whole files outside the task worktree, over HTTP with the review token", async () => {
  const server = createServer(app), url = `/api/tasks/${task.name}/source/file`;
  try {
    const headers = { host: "127.0.0.1:9", "x-review-token": app.csrf };
    const read = await server.inject({ url: `${url}?file=${encodeURIComponent(METHOD)}`, headers });
    expect(read.statusCode, read.body).toBe(200);
    const edit = { id: "http-edit", round: 1, file: METHOD, revision: read.json().revision, text: "Replaced.\n" };
    expect((await server.inject({ method: "POST", url, headers: { host: headers.host }, payload: edit })).statusCode).toBe(403);
    expect((await server.inject({ method: "POST", url, headers, payload: { ...edit, file: "../outside.tex" } })).statusCode).toBe(400);
    expect((await server.inject({ url: `${url}?file=..%2Foutside.tex`, headers })).statusCode).toBe(400);
    const saved = await server.inject({ method: "POST", url, headers, payload: edit });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().source.text).toBe("Replaced.\n");
    expect(saved.json().csrf).toBe(app.csrf);
    expect(f.read(METHOD)).toBe(BODY);
  } finally { await server.close(); }
});
it("places the round's changes in a file whose rejected changes came back", async () => {
  const round = app.review.latestRound(task.name)!;
  expect(app.sourceEdits.readFile(task.name, METHOD)).toMatchObject({ reviewed: true, reverted: [] });
  vi.mocked(app.publisher.publish).mockClear();
  await app.review.decide(task.name, { action: "reject", changes: ["c001"], round: round.number });
  const file = app.sourceEdits.readFile(task.name, METHOD);
  expect(file.text).toContain("Method sentence 2.");
  expect(file).toMatchObject({ round: round.number, reviewed: true, reverted: ["c001"] });
  // Written by hand, the file is no longer the round's.
  fs.appendFileSync(path.join(task.worktree, METHOD), "Typed.\n");
  expect(app.sourceEdits.readFile(task.name, METHOD)).toMatchObject({ reviewed: false, reverted: [] });
});
