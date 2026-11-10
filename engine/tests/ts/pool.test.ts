import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Lease, SLOTS } from "../../src/core/pool.ts";
import { Builder } from "../../src/core/build.ts";
import { Fixture } from "./helpers.ts";

const posix = process.platform !== "win32";
const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check: () => boolean, ms = 10000) => {
  for (const end = Date.now() + ms; !check() && Date.now() < end; ) await sleep(25);
  expect(check()).toBe(true);
};
const stopped = (pid: number) => { try { return execFileSync("ps", ["-o", "stat=", "-p", String(pid)]).toString().trim().startsWith("T"); } catch { return false; } };
let dir = "", previous: string | undefined, leases: Lease[] = [], children: ChildProcess[] = [], groups: number[] = [];
const lease = (priority: "foreground" | "normal" | "background") => { const made = new Lease(() => priority); leases.push(made); return made; };
// A stand-in compiler in its own process group, as latexmk runs.
const compiler = (held: Lease) => { const child = spawn("sleep", ["120"], { detached: true, stdio: "ignore" }); groups.push(child.pid!); held.attach(child); return child.pid!; };
// A lease held by another process.
async function holder(priority: string, stale = "20000") {
  const child = spawn(process.execPath, ["--import", "tsx", path.join(ENGINE, "tests/ts/pool-holder.ts"), priority], { cwd: ENGINE, env: { ...process.env, PAPILOT_TEX_POOL: dir, PAPILOT_TEX_POOL_STALE: stale }, stdio: ["pipe", "pipe", "inherit"] });
  children.push(child);
  const line = await new Promise<string>((resolve, reject) => {
    createInterface({ input: child.stdout! }).once("line", resolve);
    child.once("exit", () => reject(new Error("The other process ended before it held a lease.")));
  });
  const held = JSON.parse(line) as { slot: number; borrowed: boolean; pgid: number };
  groups.push(held.pgid);
  return { child, ...held };
}
beforeEach(() => {
  previous = process.env.PAPILOT_TEX_POOL;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "papilot-pool-test-"));
  process.env.PAPILOT_TEX_POOL = dir;
});
afterEach(async () => {
  await Promise.all(leases.map((held) => held.release()));
  for (const child of children) child.kill("SIGKILL");
  for (const group of groups) for (const signal of ["SIGCONT", "SIGKILL"] as const) try { process.kill(-group, signal); } catch { /* Gone. */ }
  leases = []; children = []; groups = [];
  if (previous === undefined) delete process.env.PAPILOT_TEX_POOL; else process.env.PAPILOT_TEX_POOL = previous;
  fs.rmSync(dir, { recursive: true, force: true });
});

it("lets two TeX runs hold slots at once, and the next one waits for a slot", async () => {
  expect(SLOTS).toBe(2);
  const first = lease("normal"), second = lease("normal");
  await Promise.all([first.ready, second.ready]);
  expect(new Set([first.slot, second.slot])).toEqual(new Set([0, 1]));
  const third = lease("normal");
  let acquired = false;
  void third.ready.then(() => { acquired = true; });
  await sleep(400);
  expect(acquired).toBe(false);
  await first.release();
  await third.ready;
  expect(third.slot).toBe(first.slot);
});

it("lets background work use every free slot, and work someone waits for borrows one at once", async () => {
  const speculative = lease("background");
  await speculative.ready;
  const another = lease("background");
  await another.ready;
  expect(new Set([speculative.slot, another.slot])).toEqual(new Set([0, 1]));
  if (!posix) return;
  const group = compiler(another);
  // Work someone waits for stops the newest background run and takes its slot.
  const wanted = lease("normal");
  await wanted.ready;
  expect([wanted.borrowed, wanted.slot]).toEqual([true, another.slot]);
  expect(stopped(group)).toBe(true);
  await wanted.release();
  await until(() => !stopped(group));
});

it("gives a free slot to the highest priority first, then to whoever waited longest", async () => {
  const first = lease("normal"), second = lease("normal");
  await Promise.all([first.ready, second.ready]);
  const order: string[] = [];
  const older = lease("normal");
  void older.ready.then(() => order.push("older"));
  await sleep(100);
  const urgent = lease("foreground");
  void urgent.ready.then(() => order.push("urgent"));
  await sleep(300);
  expect(order).toEqual([]);
  await first.release();
  await until(() => order.length === 1);
  expect(order).toEqual(["urgent"]);
  await second.release();
  await until(() => order.length === 2);
  expect(order).toEqual(["urgent", "older"]);
});

it.skipIf(!posix)("stops another process's background run to lend its slot, and continues it when the borrower is done", async () => {
  const lender = await holder("background"), busy = lease("normal");
  await busy.ready;
  expect(busy.slot).not.toBe(lender.slot);
  expect(stopped(lender.pgid)).toBe(false);
  const urgent = lease("foreground");
  await urgent.ready;
  expect([urgent.borrowed, urgent.slot]).toEqual([true, lender.slot]);
  // Confirmed before the borrower runs.
  expect(stopped(lender.pgid)).toBe(true);
  await urgent.release();
  await until(() => !stopped(lender.pgid));
});

it.skipIf(!posix)("lets normal work borrow a running background slot, and foreground work the newest normal one", async () => {
  const lender = await holder("background"), busy = lease("normal");
  await busy.ready;
  const busyGroup = compiler(busy);
  // Normal work stops the background run that the busy slot leaves.
  const normal = lease("normal");
  await normal.ready;
  expect([normal.borrowed, normal.slot]).toEqual([true, lender.slot]);
  expect(stopped(lender.pgid)).toBe(true);
  await normal.release();
  await until(() => !stopped(lender.pgid));
  // Foreground work prefers the background run, the least important one.
  const urgent = lease("foreground");
  await urgent.ready;
  expect([urgent.borrowed, urgent.slot]).toEqual([true, lender.slot]);
  expect(stopped(busyGroup)).toBe(false);
  await urgent.release();
  await until(() => !stopped(lender.pgid));
});

it.skipIf(!posix)("stops the newest of two normal runs for foreground work", async () => {
  const older = lease("normal");
  await older.ready;
  const olderGroup = compiler(older);
  await sleep(20);
  const newer = lease("normal");
  await newer.ready;
  const newerGroup = compiler(newer);
  const urgent = lease("foreground");
  await urgent.ready;
  expect([urgent.borrowed, urgent.slot]).toEqual([true, newer.slot]);
  expect(stopped(newerGroup)).toBe(true);
  expect(stopped(olderGroup)).toBe(false);
  await urgent.release();
  await until(() => !stopped(newerGroup));
});

it.skipIf(!posix)("gives a borrowed slot back once its lender matters more, and continues when a slot is free again", async () => {
  let wanted: "background" | "foreground" = "background";
  const lender = new Lease(() => wanted);
  leases.push(lender);
  await lender.ready;
  const lenderGroup = compiler(lender), busy = lease("normal");
  await busy.ready;
  compiler(busy);
  const borrower = lease("normal");
  await borrower.ready;
  const borrowerGroup = compiler(borrower);
  expect(borrower.borrowed).toBe(true);
  await until(() => stopped(lenderGroup));
  // Someone starts waiting for the lent build.
  wanted = "foreground";
  lender.update();
  await until(() => borrower.revoked && stopped(borrowerGroup));
  await until(() => !stopped(lenderGroup));
  // A free slot again: the borrower continues on it.
  await busy.release();
  await until(() => !borrower.revoked && !stopped(borrowerGroup));
  expect([borrower.borrowed, borrower.slot >= 0]).toEqual([false, true]);
});

it.skipIf(!posix)("continues a lent run when its borrower dies", async () => {
  const lender = lease("background");
  await lender.ready;
  const pgid = compiler(lender), busy = lease("normal");
  await busy.ready;
  const borrower = await holder("foreground");
  expect([borrower.borrowed, borrower.slot]).toEqual([true, lender.slot]);
  expect(stopped(pgid)).toBe(true);
  borrower.child.kill("SIGKILL");
  await until(() => !stopped(pgid));
  // The slot is the lender's again: it is not free for other work.
  const next = lease("background");
  let acquired = false;
  void next.ready.then(() => { acquired = true; }, () => { /* Cleanup cancels the waiter. */ });
  await sleep(400);
  expect(acquired).toBe(false);
});

it.skipIf(!posix)("takes over the slot of a process that crashed once its lease goes stale", async () => {
  process.env.PAPILOT_TEX_POOL_STALE = "2000";
  try {
    const crashed = await holder("normal", "2000"), busy = lease("normal");
    await busy.ready;
    const waiting = lease("normal");
    let acquired = false;
    void waiting.ready.then(() => { acquired = true; });
    await sleep(300);
    expect(acquired).toBe(false);
    crashed.child.kill("SIGKILL");
    await until(() => acquired, 15000);
    expect(waiting.slot).toBe(crashed.slot);
  } finally { delete process.env.PAPILOT_TEX_POOL_STALE; }
});

it.skipIf(!posix)("runs at most two latexmk at once when three builds start together", async () => {
  const f = new Fixture(), bin = path.join(f.base, "bin"), runs = path.join(f.base, "runs"), previousPath = process.env.PATH;
  fs.mkdirSync(bin); fs.mkdirSync(runs);
  fs.writeFileSync(path.join(bin, "pdflatex"), "#!/bin/sh\necho 'pdfTeX 3.14 (fake)'\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "latexmk"), `#!/bin/sh\ntouch "${runs}/running-$$"\nls "${runs}" | grep -c running >> "${runs}/counts"\nsleep 0.7\nrm "${runs}/running-$$"\nmkdir -p build && echo pdf > build/main.pdf\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  try {
    const builder = new Builder((await import("../../src/core/config.ts")).loadProject(f.root), f.repo), revisions = [f.repo.rev("HEAD")];
    for (const text of ["Second.", "Third."]) {
      f.write("paper/main.tex", f.read("paper/main.tex").replace("We conclude.", `We conclude. ${text}`));
      f.repo.run(["commit", "-qam", text]);
      revisions.push(f.repo.rev("HEAD"));
    }
    const built = await Promise.all(revisions.map((rev) => builder.build(rev)));
    expect(new Set(built.map((b) => b.key)).size).toBe(3);
    const counts = fs.readFileSync(path.join(runs, "counts"), "utf8").trim().split("\n").map(Number);
    expect(counts).toHaveLength(3);
    expect(Math.max(...counts)).toBeLessThanOrEqual(2);
  } finally {
    process.env.PATH = previousPath;
    await f.close();
  }
});

// pid 1 answers kill(1, 0) with EPERM, so it looks alive, as a process ID
// that a crashed process left and the system has since reused.
const ghost = (name: string, value: object, age: number) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  const then = new Date(Date.now() - age);
  fs.utimesSync(file, then, then);
  return file;
};
const files = (pattern: RegExp) => fs.readdirSync(dir).filter((name) => pattern.test(name));
const staleAfter = async (ms: string, work: () => Promise<void>) => {
  process.env.PAPILOT_TEX_POOL_STALE = ms;
  try { await work(); } finally { delete process.env.PAPILOT_TEX_POOL_STALE; }
};

it("ignores a waiter whose process stopped keeping its file fresh, even when its process ID is in use", async () => {
  const left = ghost("wait-00dead00.json", { id: "00dead00", pid: 1, priority: "foreground", since: 0 }, 60000);
  const next = lease("normal");
  let acquired = false;
  void next.ready.then(() => { acquired = true; });
  await until(() => acquired, 3000);
  expect(fs.existsSync(left)).toBe(false);
});

it("keeps a waiter's place while it waits longer than a stale lock takes", () => staleAfter("2000", async () => {
  const first = lease("normal"), second = lease("normal");
  await Promise.all([first.ready, second.ready]);
  const order: string[] = [];
  const older = lease("normal");
  void older.ready.then(() => order.push("older"), () => undefined);
  await sleep(3000);
  const newer = lease("normal");
  void newer.ready.then(() => order.push("newer"), () => undefined);
  await sleep(200);
  await first.release();
  await until(() => order.length === 1);
  expect(order).toEqual(["older"]);
}), 15000);

it("leaves no waiter file behind when its priority changes as it gets a slot or gives up", async () => {
  const first = lease("normal"), second = lease("normal");
  await Promise.all([first.ready, second.ready]);
  // A priority change whose write is still on its way when the slot comes.
  let priority: "normal" | "foreground" = "normal";
  const changing = new Lease(() => priority);
  leases.push(changing);
  await until(() => files(/^wait-/).length === 1);
  const rename = fs.promises.rename;
  fs.promises.rename = (async (from: fs.PathLike, to: fs.PathLike) => {
    if (/wait-[0-9a-f]+\.json$/.test(String(to))) await sleep(300);
    return rename(from, to);
  }) as typeof rename;
  try {
    priority = "foreground";
    changing.update();
    await first.release();
    await changing.ready;
    await sleep(500);
    expect(files(/^wait-/)).toEqual([]);
  } finally { fs.promises.rename = rename; }
  // A priority change after a waiting lease was given up.
  let wanted: "normal" | "foreground" = "normal";
  const abandoned = new Lease(() => wanted);
  await until(() => files(/^wait-/).length === 1);
  await abandoned.release();
  wanted = "foreground";
  abandoned.update();
  await sleep(200);
  expect(files(/^wait-/)).toEqual([]);
});

it("ignores a borrow claim nobody keeps fresh, for a free slot and for its lender", () => staleAfter("2000", async () => {
  for (let slot = 0; slot < SLOTS; slot++) ghost(`borrow-${slot}.json`, { id: "00dead00", pid: 1, pgid: null }, 60000);
  const free = lease("normal");
  let acquired = false;
  void free.ready.then(() => { acquired = true; });
  await until(() => acquired, 3000);
  await free.release();
  if (!posix) return;
  // A lender stops for a claim, and continues once nobody refreshes it.
  const lender = lease("background");
  await lender.ready;
  const pgid = compiler(lender);
  ghost(`borrow-${lender.slot}.json`, { id: "00dead00", pid: 1, pgid }, 0);
  await until(() => stopped(pgid));
  await until(() => !stopped(pgid), 6000);
}), 20000);

it.skipIf(!posix)("keeps a borrow for longer than a stale lock takes", () => staleAfter("2000", async () => {
  const lender = await holder("background", "2000"), busy = lease("normal");
  await busy.ready;
  const urgent = lease("foreground");
  await urgent.ready;
  expect([urgent.borrowed, urgent.slot]).toEqual([true, lender.slot]);
  await sleep(3500);
  expect(stopped(lender.pgid)).toBe(true);
  await urgent.release();
  await until(() => !stopped(lender.pgid));
}), 20000);

it.skipIf(!posix)("runs a speculative build at full speed beside a round, and stops it only when the round's other side needs its slot", async () => {
  const f = new Fixture(), bin = path.join(f.base, "bin"), gates = path.join(f.base, "gates"), previousPath = process.env.PATH;
  fs.mkdirSync(bin); fs.mkdirSync(gates);
  // A latexmk that records its process ID and finishes when told to, or
  // after a minute, so that a test stopped midway leaves nothing running.
  fs.writeFileSync(path.join(bin, "pdflatex"), "#!/bin/sh\necho 'pdfTeX 3.14 (fake)'\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "latexmk"), `#!/bin/sh\nkey=$(basename "$(dirname "$PWD")")\necho $$ > "${gates}/pid-$key"\ni=0; while [ ! -e "${gates}/go-$key" ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done\nmkdir -p build && echo pdf > build/main.pdf\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  const started = () => fs.readdirSync(gates).filter((name) => name.startsWith("pid-")).map((name) => name.slice(4));
  const pidOf = (key: string) => Number(fs.readFileSync(path.join(gates, `pid-${key}`), "utf8"));
  const go = (key: string) => fs.writeFileSync(path.join(gates, `go-${key}`), "");
  const builds: Promise<unknown>[] = [];
  try {
    const builder = new Builder((await import("../../src/core/config.ts")).loadProject(f.root), f.repo), revisions = [f.repo.rev("HEAD")];
    for (const text of ["Second.", "Third."]) {
      f.write("paper/main.tex", f.read("paper/main.tex").replace("We conclude.", `We conclude. ${text}`));
      f.repo.run(["commit", "-qam", text]);
      revisions.push(f.repo.rev("HEAD"));
    }
    builds.push(builder.build(revisions[0], ["full"], null, { priority: "background" }));
    await until(() => started().length === 1);
    const [speculative] = started();
    builds.push(builder.build(revisions[1]));
    await until(() => started().length === 2);
    // A free slot is used: nothing stops the speculative build.
    await sleep(500);
    expect(stopped(pidOf(speculative))).toBe(false);
    // The round's other side borrows the speculative build's slot.
    builds.push(builder.build(revisions[2]));
    await until(() => started().length === 3);
    expect(stopped(pidOf(speculative))).toBe(true);
    for (const key of started().filter((key) => key !== speculative)) go(key);
    await Promise.all(builds.slice(1));
    await until(() => !stopped(pidOf(speculative)));
    go(speculative);
    await builds[0];
  } finally {
    for (const key of fs.readdirSync(gates).filter((name) => name.startsWith("pid-")).map((name) => name.slice(4))) go(key);
    await Promise.allSettled(builds);
    process.env.PATH = previousPath;
    await f.close();
  }
}, 60000);
