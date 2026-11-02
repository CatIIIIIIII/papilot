import fs from "node:fs";
import path from "node:path";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { Fixture, fakeRound, METHOD } from "./helpers.ts";
import { createServer, App } from "../../src/server.ts";
import { Builder } from "../../src/core/build.ts";
import { PublishError } from "../../src/core/publish.ts";
import { acquireLock, sleep, writeJson } from "../../src/core/files.ts";
import { connect, serverHome } from "../../src/client.ts";
let f: Fixture, app: App, server: ReturnType<typeof createServer>;
beforeEach(() => {
  f = new Fixture();
  app = f.app();
  server = createServer(app);
});
afterEach(async () => {
  await server.close();
  await f.close();
  vi.restoreAllMocks();
});
const headers = () => ({
  host: "127.0.0.1:9",
  origin: app.url,
  "x-review-token": app.csrf,
});
it("requires localhost origin and token for mutation", async () => {
  expect(
    (
      await server.inject({
        url: "/api/info",
        headers: { host: "evil.example" },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await server.inject({
        method: "POST",
        url: "/api/tasks",
        headers: { host: "127.0.0.1:9" },
        payload: { name: "test" },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await server.inject({
        method: "POST",
        url: "/api/tasks",
        headers: { ...headers(), origin: "http://evil.example" },
        payload: { name: "test" },
      })
    ).statusCode,
  ).toBe(403);
  const response = await server.inject({
    method: "POST",
    url: "/api/tasks",
    headers: headers(),
    payload: { name: "test" },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().task).toBe("test");
  expect(
    (await server.inject({ url: "/api/tasks", headers: headers() })).json()
      .tasks,
  ).toHaveLength(1);
});
it("validates action schemas and serves immutable compressed vectors", async () => {
  const task = app.tasks.create("test");
  f.edit(task, METHOD, "Method sentence 2.", "new");
  fakeRound(app, "test");
  const invalid = await server.inject({
    method: "POST",
    url: "/api/tasks/test/decide",
    headers: headers(),
    payload: { action: "toString", changes: ["c001"], round: 1 },
  });
  expect(invalid.statusCode).toBe(400);
  const directory = path.join(app.state, "rounds/test/001");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "s0001.svg"),
    "<svg>" + '<path d="M0 0 L1 1"/>'.repeat(1000) + "</svg>",
  );
  const response = await server.inject({
    url: "/files/test/1/s0001.svg",
    headers: { ...headers(), "accept-encoding": "gzip" },
  });
  expect(response.headers["cache-control"]).toContain("immutable");
  expect(response.headers["content-encoding"]).toBe("gzip");
  expect(
    (
      await server.inject({
        url: "/files/test/1/state.sqlite3",
        headers: headers(),
      })
    ).statusCode,
  ).toBe(404);
});
it("schedules distinct tasks concurrently but serializes the same task", async () => {
  f.write(".latex-review.json", JSON.stringify({ build_workers: 2 }));
  for (const name of ["a", "b", "c"]) app.tasks.create(name);
  const active = new Set<string>(),
    calls: string[] = [],
    release = new Map<string, () => void>();
  let peak = 0;
  vi.spyOn(app.publisher, "pruneCache").mockResolvedValue();
  vi.spyOn(app.publisher, "publish").mockImplementation(async (job) => {
    const key =
      job.task === "a" ? (calls.includes("a1") ? "a2" : "a1") : job.task;
    expect(active.has(job.task)).toBe(false);
    active.add(job.task);
    peak = Math.max(peak, active.size);
    calls.push(key);
    await new Promise<void>((resolve) => release.set(key, resolve));
    active.delete(job.task);
    if (key === "a1") throw new Error("Expected failure");
    return { outcome: "empty" };
  });
  const waitFor = async (key: string) => {
    for (let i = 0; i < 100 && !release.has(key); i++) await sleep(10);
    expect(release.has(key)).toBe(true);
  };
  const a1 = app.publisher.submit("a");
  await waitFor("a1");
  const a2 = app.publisher.submit("a");
  expect(app.publisher.submit("a").id).toBe(a2.id);
  const b = app.publisher.submit("b");
  await waitFor("b");
  const c = app.publisher.submit("c");
  expect(calls).toEqual(["a1", "b"]);
  release.get("b")!();
  await waitFor("c");
  release.get("a1")!();
  await waitFor("a2");
  release.get("c")!();
  release.get("a2")!();
  await app.publisher.join();
  expect([a1, a2, b, c].map((j) => app.publisher.job(j.id).status)).toEqual([
    "failed",
    "done",
    "done",
    "done",
  ]);
  expect(peak).toBe(2);
});
it("waits for cache cleanup before starting newly queued builds", async () => {
  app.tasks.create("a");
  let finish!: () => void;
  vi.spyOn(Builder.prototype, "prune").mockImplementation(
    () => new Promise<void>((r) => (finish = r)),
  );
  const publish = vi
    .spyOn(app.publisher, "publish")
    .mockResolvedValue({ outcome: "empty" });
  const cleaning = app.publisher.pruneCache();
  app.publisher.submit("a");
  await sleep(10);
  expect(publish).not.toHaveBeenCalled();
  app.publisher.stop();
  finish();
  await cleaning;
  await app.publisher.join();
});

it("replays build requests across lost responses and server restarts without new jobs", async () => {
  app.tasks.create("a");
  app.tasks.create("b");
  vi.spyOn(app.publisher, "pruneCache").mockResolvedValue();
  let finish!: () => void;
  const publish = vi.spyOn(app.publisher, "publish").mockImplementation(async () => {
    await new Promise<void>(resolve => { finish = resolve; });
    return { outcome: "empty" };
  });
  const first = app.publisher.submit("a", "request-a");
  // Distinct requests can share a queued build; both keys must remain replayable.
  expect(app.publisher.submit("a", "request-b").id).toBe(first.id);
  await sleep(10);
  expect(app.publisher.submit("a", "request-a").status).toBe("running");
  finish();
  await app.publisher.join();
  const restarted = f.app();
  expect(restarted.publisher.submit("a", "request-a").id).toBe(first.id);
  expect(restarted.publisher.submit("a", "request-b").id).toBe(first.id);
  expect(restarted.publisher.submit("a", "request-a").status).toBe("done");
  expect(() => restarted.publisher.submit("b", "request-a")).toThrow(/another task/);
  expect(app.store.all("SELECT * FROM jobs")).toHaveLength(1);
  expect(publish).toHaveBeenCalledTimes(1);
  const response = await server.inject({ method: "POST", url: "/api/tasks/a/publish", headers: headers(), payload: { requestId: "request-a" } });
  expect(response.json().job).toBe(first.id);
  const invalid = await server.inject({ method: "POST", url: "/api/tasks/a/publish", headers: headers(), payload: { requestId: "../invalid" } });
  expect(invalid.statusCode).toBe(400);
});

it("a build its server stopped is built again after the restart", async () => {
  app.tasks.create("a");
  vi.spyOn(app.publisher, "pruneCache").mockResolvedValue();
  let fail!: (error: Error) => void;
  vi.spyOn(app.publisher, "publish").mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
  const job = app.publisher.submit("a", "request-a");
  await sleep(10);
  app.publisher.stop();
  // Stopping kills the compiler, which fails like a broken document would.
  fail(new PublishError("The revised document could not be compiled.", ["killed"], "Fix it."));
  await app.publisher.join();
  expect(app.publisher.job(job.id).status).toBe("running");
  const restarted = f.app();
  expect(restarted.publisher.job(job.id).status).toBe("failed");
  // Papilot rebuilds a job that failed with exactly this error.
  expect(restarted.publisher.job(job.id).result).toMatchObject({ error: "The review server restarted during the build." });
});

it("read-only reconnection does not wait for the startup lock or upgrade a running server", async () => {
  const url = await server.listen({ host: "127.0.0.1", port: 0 });
  app.url = url;
  const home = serverHome(f.root);
  writeJson(path.join(home, "connection.json"), { url, pid: process.pid });
  const release = await acquireLock(path.join(home, "start.lock"));
  try {
    const result = await Promise.race([connect(f.root, false), sleep(1000).then(() => "blocked")]);
    expect(result).not.toBe("blocked");
    expect(result).toMatchObject({ url, token: app.csrf });
  } finally { await release(); }
});
