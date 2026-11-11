import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Builder } from "../../src/core/build.ts";
import { loadProject } from "../../src/core/config.ts";
import { Lease } from "../../src/core/pool.ts";
import { Cancelled } from "../../src/core/process.ts";
import { Fixture } from "./helpers.ts";

// Cancelling a build stops its compilation in every state it can be in, and
// leaves nothing that a later build would continue from or show.
const posix = process.platform !== "win32";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check: () => boolean, ms = 10000) => {
  for (const end = Date.now() + ms; !check() && Date.now() < end; ) await sleep(25);
  expect(check()).toBe(true);
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const stopped = (pid: number) => { try { return execFileSync("ps", ["-o", "stat=", "-p", String(pid)]).toString().trim().startsWith("T"); } catch { return false; } };
let f: Fixture, gates = "", pool = "", previousPath: string | undefined, previousPool: string | undefined, builder: Builder;
let leases: Lease[] = [], children: ChildProcess[] = [];
const revisions: string[] = [];
const lease = (priority: "foreground" | "normal" | "background") => { const made = new Lease(() => priority); leases.push(made); return made; };
const compiler = (held: Lease) => { const child = spawn("sleep", ["120"], { detached: true, stdio: "ignore" }); children.push(child); held.attach(child); return child.pid!; };
const started = () => fs.readdirSync(gates).filter((name) => name.startsWith("pid-")).map((name) => name.slice(4));
const pidOf = (key: string, kind = "pid") => Number(fs.readFileSync(path.join(gates, `${kind}-${key}`), "utf8"));
const go = (key: string) => fs.writeFileSync(path.join(gates, `go-${key}`), "");
const runs = () => (fs.existsSync(path.join(gates, "runs")) ? fs.readFileSync(path.join(gates, "runs"), "utf8").trim().split("\n").filter(Boolean).length : 0);
const cache = () => path.join(f.root, ".git/latex-review/cache/builds");
// Nothing of a cancelled build remains to be continued from or shown. The
// request is cancelled at once; its folder goes once the compiler has ended.
async function leftNothing(key: string) {
  await until(() => !fs.existsSync(path.join(cache(), key)));
  expect(fs.existsSync(path.join(f.root, ".git/latex-review/logs", key + ".log"))).toBe(false);
  for (const name of fs.existsSync(cache()) ? fs.readdirSync(cache()) : [])
    if (/^(?:latest|recent)/.test(name)) expect(fs.readFileSync(path.join(cache(), name), "utf8")).not.toContain(key);
}
async function slotsFree() {
  const a = lease("normal"), b = lease("normal");
  await Promise.all([a.ready, b.ready]);
  await Promise.all([a.release(), b.release()]);
}
beforeEach(() => {
  f = new Fixture();
  gates = path.join(f.base, "gates");
  pool = fs.mkdtempSync(path.join(os.tmpdir(), "papilot-cancel-pool-"));
  const bin = path.join(f.base, "bin");
  fs.mkdirSync(bin); fs.mkdirSync(gates);
  fs.writeFileSync(path.join(bin, "pdflatex"), "#!/bin/sh\necho 'pdfTeX 3.14 (fake)'\n", { mode: 0o755 });
  // A latexmk that starts a child in its process group, can announce a pass
  // whose PDF needs xdvipdfmx, and finishes when told to.
  fs.writeFileSync(path.join(bin, "latexmk"), `#!/bin/sh
key=$(basename "$(dirname "$PWD")")
echo run >> "${gates}/runs"
sleep 300 &
echo $! > "${gates}/child-$key"
echo $$ > "${gates}/pid-$key"
if [ -n "$PAPILOT_PASS_DIR" ] && [ -e "${gates}/preview" ]; then
  mkdir -p "$PAPILOT_PASS_DIR/1" && echo xdv > "$PAPILOT_PASS_DIR/1/main.xdv"
  echo "Papilot: pass 1 output saved"
  echo "Run number 2 of rule 'pdflatex'"
fi
i=0; while [ ! -e "${gates}/go-$key" ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done
mkdir -p build && echo pdf > build/main.pdf
kill $(cat "${gates}/child-$key") 2>/dev/null
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "xdvipdfmx"), `#!/bin/sh\necho $$ > "${gates}/xdvipdfmx"\nsleep 300\n`, { mode: 0o755 });
  previousPath = process.env.PATH;
  previousPool = process.env.PAPILOT_TEX_POOL;
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  process.env.PAPILOT_TEX_POOL = pool;
  builder = new Builder(loadProject(f.root), f.repo);
  revisions.length = 0;
  revisions.push(f.repo.rev("HEAD"));
  for (const text of ["Second.", "Third."]) {
    f.write("paper/main.tex", f.read("paper/main.tex").replace("We conclude.", `We conclude. ${text}`));
    f.repo.run(["commit", "-qam", text]);
    revisions.push(f.repo.rev("HEAD"));
  }
});
afterEach(async () => {
  for (const key of started()) go(key);
  await Promise.all(leases.map((held) => held.release()));
  for (const child of children) try { process.kill(-child.pid!, "SIGKILL"); } catch { /* Gone. */ }
  leases = []; children = [];
  process.env.PATH = previousPath;
  if (previousPool === undefined) delete process.env.PAPILOT_TEX_POOL; else process.env.PAPILOT_TEX_POOL = previousPool;
  await sleep(100);
  await f.close();
  fs.rmSync(pool, { recursive: true, force: true });
});

it.skipIf(!posix)("stops a running compilation with everything it started, frees its slot and leaves nothing behind", async () => {
  const stop = new AbortController(), build = builder.build(revisions[0], ["full"], null, { signal: stop.signal });
  await until(() => started().length === 1);
  const [key] = started(), pid = pidOf(key), child = pidOf(key, "child");
  stop.abort();
  await expect(build).rejects.toBeInstanceOf(Cancelled);
  await until(() => !alive(pid) && !alive(child));
  await leftNothing(key);
  expect(runs()).toBe(1);
  await slotsFree();
}, 30000);

it.skipIf(!posix)("stops a compilation that is stopped for a borrower, and the borrower keeps its slot", async () => {
  const stop = new AbortController(), build = builder.build(revisions[0], ["full"], null, { signal: stop.signal, priority: "background" });
  await until(() => started().length === 1);
  const [key] = started(), pid = pidOf(key);
  const busy = lease("normal");
  await busy.ready;
  const urgent = lease("foreground");
  await urgent.ready;
  expect(urgent.borrowed).toBe(true);
  await until(() => stopped(pid));
  stop.abort();
  await expect(build).rejects.toBeInstanceOf(Cancelled);
  await until(() => !alive(pid));
  await leftNothing(key);
  // The borrowed slot stays taken until its borrower is done.
  const next = lease("background");
  let acquired = false;
  void next.ready.then(() => { acquired = true; }, () => undefined);
  await sleep(400);
  expect(acquired).toBe(false);
  await urgent.release();
  await until(() => acquired);
}, 30000);

it.skipIf(!posix)("stops a compilation that borrowed a slot, and its lender continues", async () => {
  const first = lease("background");
  await first.ready;
  const lender = compiler(first), busy = lease("normal");
  await busy.ready;
  const stop = new AbortController(), build = builder.build(revisions[0], ["full"], null, { signal: stop.signal, priority: "foreground" });
  await until(() => started().length === 1);
  const [key] = started(), pid = pidOf(key);
  expect(stopped(lender)).toBe(true);
  stop.abort();
  await expect(build).rejects.toBeInstanceOf(Cancelled);
  await until(() => !alive(pid));
  await until(() => !stopped(lender));
  await leftNothing(key);
}, 30000);

it.skipIf(!posix)("stops waiting for a slot at once and starts no compiler", async () => {
  const a = lease("normal"), b = lease("normal");
  await Promise.all([a.ready, b.ready]);
  const stop = new AbortController(), build = builder.build(revisions[0], ["full"], null, { signal: stop.signal });
  // Both slots stay held, so a build that rejects never waited for one.
  await until(() => fs.readdirSync(pool).some((name) => name.startsWith("wait-")));
  expect(started()).toEqual([]);
  stop.abort();
  await expect(build).rejects.toBeInstanceOf(Cancelled);
  await sleep(300);
  expect(runs()).toBe(0);
  expect(fs.readdirSync(pool).filter((name) => name.startsWith("wait-"))).toEqual([]);
  expect(fs.existsSync(cache()) ? fs.readdirSync(cache()).filter((name) => /^[0-9a-f]{32}$/.test(name)) : []).toEqual([]);
}, 30000);

it.skipIf(!posix)("a request cancelled before its build starts compiles nothing", async () => {
  const stop = new AbortController();
  stop.abort();
  await expect(builder.build(revisions[0], ["full"], null, { signal: stop.signal })).rejects.toBeInstanceOf(Cancelled);
  const late = new AbortController(), build = builder.build(revisions[1], ["full"], null, { signal: late.signal, onKey: () => late.abort() });
  await expect(build).rejects.toBeInstanceOf(Cancelled);
  await sleep(300);
  expect(runs()).toBe(0);
}, 30000);

it.skipIf(!posix)("keeps compiling for another request of the same build", async () => {
  const stop = new AbortController(), cancelled = builder.build(revisions[0], ["full"], null, { signal: stop.signal });
  await until(() => started().length === 1);
  const other = builder.build(revisions[0]);
  await sleep(100);
  stop.abort();
  await expect(cancelled).rejects.toBeInstanceOf(Cancelled);
  const [key] = started();
  expect(alive(pidOf(key))).toBe(true);
  go(key);
  expect((await other).key).toBe(key);
  expect(runs()).toBe(1);
}, 30000);

it.skipIf(!posix)("a replacement that needs the same build keeps its compilation; one that does not stops it", async () => {
  const first = new AbortController(), a = builder.build(revisions[0], ["full"], null, { signal: first.signal });
  await until(() => started().length === 1);
  const [key] = started();
  // Same content: the old request is cancelled once the new one waits.
  const second = new AbortController(), b = builder.build(revisions[0], ["full"], null, { signal: second.signal, onKey: () => first.abort() });
  await expect(a).rejects.toBeInstanceOf(Cancelled);
  await sleep(200);
  expect(alive(pidOf(key))).toBe(true);
  // Different content: the old compilation stops.
  const third = new AbortController(), c = builder.build(revisions[1], ["full"], null, { signal: third.signal, onKey: () => second.abort() });
  await expect(b).rejects.toBeInstanceOf(Cancelled);
  await until(() => !alive(pidOf(key)));
  await leftNothing(key);
  await until(() => started().length === 2);
  const next = started().find((name) => name !== key)!;
  go(next);
  expect((await c).key).toBe(next);
}, 30000);

it.skipIf(!posix)("keeps the result of a compilation TeX already finished", async () => {
  const stop = new AbortController(), build = builder.build(revisions[0], ["full"], null, { signal: stop.signal });
  await until(() => started().length === 1);
  const [key] = started(), pid = pidOf(key);
  go(key);
  await until(() => !alive(pid));
  stop.abort();
  await build.catch((error) => expect(error).toBeInstanceOf(Cancelled));
  await until(() => fs.existsSync(path.join(cache(), key, "result.json")));
  expect((await builder.completed(key))?.key).toBe(key);
}, 30000);

it.skipIf(!posix)("stops the xdvipdfmx that shows a pass", async () => {
  fs.writeFileSync(path.join(gates, "preview"), "");
  const stop = new AbortController(), build = builder.build(revisions[0], ["full"], null, { signal: stop.signal, pass: () => undefined });
  await until(() => fs.existsSync(path.join(gates, "xdvipdfmx")));
  const viewer = Number(fs.readFileSync(path.join(gates, "xdvipdfmx"), "utf8"));
  expect(alive(viewer)).toBe(true);
  stop.abort();
  await expect(build).rejects.toBeInstanceOf(Cancelled);
  await until(() => !alive(viewer));
  await leftNothing(started()[0]);
}, 30000);
