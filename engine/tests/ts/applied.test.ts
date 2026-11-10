import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { App } from "../../src/server.ts";
import { Fixture, METHOD, fakeRound } from "./helpers.ts";

// The paper as decided so far compiles the moment a decision changes the
// accepted text, and a newer decision replaces a compilation under way.
const posix = process.platform !== "win32";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check: () => boolean, ms = 15000) => {
  for (const end = Date.now() + ms; !check() && Date.now() < end; ) await sleep(25);
  expect(check()).toBe(true);
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let f: Fixture, app: App, gates = "", pool = "", previousPath: string | undefined, previousPool: string | undefined;
// Each compilation the fake latexmk ran: its key and which agent sentences
// its sources contain.
const runs = () => fs.readdirSync(gates).filter((name) => name.startsWith("pid-")).map((name) => {
  const key = name.slice(4);
  return { key, pid: Number(fs.readFileSync(path.join(gates, name), "utf8")), text: fs.readFileSync(path.join(gates, `text-${key}`), "utf8").trim() };
});
const go = (key: string) => fs.writeFileSync(path.join(gates, `go-${key}`), "");
const goAll = () => { for (const run of runs()) go(run.key); };
beforeEach(() => {
  f = new Fixture();
  gates = path.join(f.base, "gates");
  pool = fs.mkdtempSync(path.join(os.tmpdir(), "papilot-applied-pool-"));
  const bin = path.join(f.base, "bin");
  fs.mkdirSync(bin); fs.mkdirSync(gates);
  fs.writeFileSync(path.join(bin, "pdflatex"), "#!/bin/sh\necho 'pdfTeX 3.14 (fake)'\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "latexmk"), `#!/bin/sh
key=$(basename "$(dirname "$PWD")")
grep -o 'Agent [A-Z]' sections/method.tex | tr '\\n' ' ' > "${gates}/text-$key"
echo $$ > "${gates}/pid-$key"
i=0; while [ ! -e "${gates}/go-$key" ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done
mkdir -p build && echo pdf > build/main.pdf
`, { mode: 0o755 });
  previousPath = process.env.PATH;
  previousPool = process.env.PAPILOT_TEX_POOL;
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  process.env.PAPILOT_TEX_POOL = pool;
  app = f.app();
});
afterEach(async () => {
  goAll();
  await Promise.all(f.apps.map((open) => open.applied.join()));
  process.env.PATH = previousPath;
  if (previousPool === undefined) delete process.env.PAPILOT_TEX_POOL; else process.env.PAPILOT_TEX_POOL = previousPool;
  await f.close();
  fs.rmSync(pool, { recursive: true, force: true });
});
async function deferredRound() {
  await app.ready;
  const task = app.tasks.create("t", "T", [], ["paper"], true);
  f.edit(task, METHOD, "Method sentence 2.", "Agent A.");
  f.edit(task, METHOD, "Method sentence 4.", "Agent B.");
  f.edit(task, METHOD, "Detail sentence 15.", "Agent C.");
  const round = fakeRound(app, task.name), unit = (text: string) => round.units.find((u) => u.new_text === text)!.id;
  return { task, round, unit };
}

it.skipIf(!posix)("compiles the accepted text at once after each accept, and a newer accept replaces the compilation under way", async () => {
  const { task, unit } = await deferredRound();
  await app.review.decide(task.name, { id: "a", action: "accept", round: 1, changes: [unit("Agent A")] });
  await until(() => runs().length === 1);
  const first = runs()[0];
  expect(first.text).toBe("Agent A");
  expect((await app.applied.state(task.name)).building).toBe(true);
  // A reject changes nothing that the paper as decided contains.
  await app.review.decide(task.name, { id: "r", action: "reject", round: 1, changes: [unit("Agent C")] });
  await sleep(300);
  expect(runs().length).toBe(1);
  // The next accept stops the first compilation and compiles both.
  await app.review.decide(task.name, { id: "b", action: "accept", round: 1, changes: [unit("Agent B")] });
  await until(() => runs().length === 2);
  await until(() => !alive(first.pid));
  const second = runs().find((run) => run.key !== first.key)!;
  expect(second.text).toBe("Agent A Agent B");
  go(second.key);
  await app.applied.join();
  const state = await app.applied.state(task.name);
  expect(state).toMatchObject({ accepted: app.tasks.get(task.name).accepted, building: false, shown: { key: second.key, current: true } });
  expect(fs.existsSync(path.join(f.root, ".git/latex-review/cache/builds", first.key))).toBe(false);
}, 30000);

it.skipIf(!posix)("shows the latest compiled decisions while newer ones compile, and an undo reuses the earlier build", async () => {
  const { task, unit } = await deferredRound();
  await app.review.decide(task.name, { id: "a", action: "accept", round: 1, changes: [unit("Agent A")] });
  await until(() => runs().length === 1);
  const first = runs()[0];
  go(first.key);
  await app.applied.join();
  await app.review.decide(task.name, { id: "b", action: "accept", round: 1, changes: [unit("Agent B")] });
  await until(() => runs().length === 2);
  // Until it is ready, the earlier version is shown, marked as not current.
  expect(await app.applied.state(task.name)).toMatchObject({ building: true, shown: { key: first.key, current: false } });
  await app.review.undo(task.name, "b");
  // The undo needs the build that is already there: no TeX runs for it.
  await app.applied.join();
  expect(runs().length).toBe(2);
  expect(await app.applied.state(task.name)).toMatchObject({ building: false, shown: { key: first.key, current: true } });
}, 30000);

it.skipIf(!posix)("after a restart, compiles decisions its last compilation did not include", async () => {
  const { task, unit } = await deferredRound();
  await app.review.decide(task.name, { id: "a", action: "accept", round: 1, changes: [unit("Agent A")] });
  await until(() => runs().length === 1);
  const [first] = runs();
  // The server stops before the compilation ends.
  await app.close();
  f.apps.splice(f.apps.indexOf(app), 1);
  expect(app.applied.latest(task.name)).toBeNull();
  await until(() => !alive(first.pid));
  const restarted = f.app();
  await restarted.ready;
  // The same decisions compile again, in a build of the same key.
  await until(() => runs()[0].pid !== first.pid);
  expect(runs()).toMatchObject([{ key: first.key, text: "Agent A" }]);
  go(first.key);
  await restarted.applied.join();
  expect(await restarted.applied.state(task.name)).toMatchObject({ shown: { key: first.key, current: true } });
}, 30000);

it.skipIf(!posix)("a start compiles no task whose decisions were never asked to compile, until the author reads it", async () => {
  const { task, unit } = await deferredRound();
  await app.review.decide(task.name, { id: "a", action: "accept", round: 1, changes: [unit("Agent A")] });
  await until(() => runs().length === 1);
  const [first] = runs();
  await app.close();
  f.apps.splice(f.apps.indexOf(app), 1);
  await until(() => !alive(first.pid));
  // As if an older version recorded the decision: nothing asked to compile it.
  fs.rmSync(path.join(app.state, "applied", `${task.name}.wanted`));
  const restarted = f.app();
  await restarted.ready;
  await sleep(1000);
  expect(runs()[0].pid).toBe(first.pid);
  // The author opens the task: its paper as decided compiles now.
  expect(await restarted.applied.state(task.name)).toMatchObject({ building: true });
  await until(() => runs()[0].pid !== first.pid);
  expect(runs()).toMatchObject([{ key: first.key, text: "Agent A" }]);
  go(first.key);
  await restarted.applied.join();
  expect(await restarted.applied.state(task.name)).toMatchObject({ building: false, shown: { key: first.key, current: true } });
}, 30000);
