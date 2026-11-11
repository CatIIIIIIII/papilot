// The feedback route Papilot polls to bring the author's decisions, comments
// and build failures back to the agent.
import { beforeEach, afterEach, it, expect } from "vitest";
import { Fixture, METHOD, fakeRound } from "./helpers.ts";
import { createServer, App } from "../../src/server.ts";
import type { Feedback, Task } from "../../src/types.ts";
let f: Fixture, app: App, server: ReturnType<typeof createServer>, task: Task;
beforeEach(async () => {
  f = new Fixture();
  app = f.app();
  server = createServer(app);
  await server.listen({ host: "127.0.0.1", port: 0 });
  const address = server.server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  app.url = `http://127.0.0.1:${address.port}`;
  task = app.tasks.create("polish");
  f.edit(task, METHOD, "Method sentence 2.", "Agent A.");
  f.edit(task, METHOD, "Detail sentence 15.", "Agent B.");
  fakeRound(app, task.name);
});
afterEach(async () => {
  await server.close();
  await f.close();
});
async function post(route: string, data: unknown) {
  const response = await fetch(`${app.url}/api/tasks/${task.name}/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Review-Token": app.csrf },
    body: JSON.stringify(data),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  return response.json();
}
async function feedback(after = 0) {
  const response = await fetch(`${app.url}/api/tasks/${task.name}/feedback?after=${after}`);
  expect(response.ok).toBe(true);
  return (await response.json()) as Feedback;
}

it("returns every comment and message in full, with its source, and each only once", async () => {
  const long = "保留这个公式，解释边界。".repeat(600);
  await post("decide", { id: "first", action: "comment", round: 1, changes: ["c001"], body: long });
  await post("decide", { id: "second", action: "comment", round: 1, changes: ["c002"], body: "Second independent opinion." });
  for (let i = 0; i < 250; i++) app.review.note(task.name, `Opinion ${i}: keep this context.`);
  const answer = await feedback();
  expect(answer.state).toBe("revise");
  expect(answer.feedback).toHaveLength(252);
  expect(answer.feedback[0].text).toBe(long);
  expect(answer.feedback[0].changes?.[0]).toMatchObject({ file: METHOD, old: "Method sentence 2", new: "Agent A" });
  expect(answer.feedback.at(-1)?.text).toBe("Opinion 249: keep this context.");
  expect((await feedback(answer.cursor)).feedback).toEqual([]);
});

it("an undo after delivery reaches the agent, and the undone opinion is not replayed", async () => {
  await post("decide", { id: "comment", action: "comment", round: 1, changes: ["c001"], body: "First opinion." });
  const delivered = await feedback();
  expect(delivered.feedback[0].text).toBe("First opinion.");
  await post("undo", { id: "comment" });
  expect((await feedback(delivered.cursor)).feedback[0]).toMatchObject({ kind: "undo", undid: "comment" });
  expect((await feedback()).feedback).toEqual([]);
});

it("accepting every pending change keeps earlier comments", async () => {
  await post("decide", { id: "keep-comment", action: "comment", round: 1, changes: ["c001"], body: "This still needs revision." });
  await post("decide", { id: "accept-rest", action: "accept", round: 1, changes: ["c002"] });
  const answer = await feedback();
  expect(answer.state).toBe("revise");
  expect(answer.counts).toMatchObject({ accepted: 1, commented: 1, pending: 0 });
  expect(answer.feedback.map((item) => item.kind)).toEqual(["comment", "accept"]);
});

it("a failed build reports its diagnostics and log", async () => {
  app.store.execute(
    "INSERT INTO jobs(id,task,status,phase,result,created) VALUES('broken',?,'failed','build',?,?)",
    task.name,
    JSON.stringify({ error: "Your edits do not compile.", details: ["main.tex:17: Undefined control sequence"], log: "/tmp/compile.log", next: "Fix the macro." }),
    Date.now() / 1000 + 1,
  );
  const result = await feedback();
  expect(result.state).toBe("build_failed");
  expect(result.build_error).toMatchObject({ details: ["main.tex:17: Undefined control sequence"], log: "/tmp/compile.log" });
});
