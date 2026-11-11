import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import lockfile from "proper-lockfile";
import { capture, ProcessError, stopping } from "./process.ts";

/** How much a TeX run matters to the person waiting, as in build.ts. */
export type PoolPriority = "foreground" | "normal" | "background";
const RANK: Record<PoolPriority, number> = { background: 0, normal: 1, foreground: 2 };
/** TeX runs at once on this machine, across Papilot and every review
 *  engine it started: the manuscript preview, review rounds of several
 *  tasks, speculative builds and comparison rendering. */
export const SLOTS = 2;
const signals = process.platform !== "win32";

// The pool is a folder that Papilot passes to the review engines it starts
// (PAPILOT_TEX_POOL), so every process of one installation shares it. A
// process started without one has a pool of its own. A process holds a slot
// with a lock file that it keeps fresh; one that crashed leaves a lock that
// goes stale, and its slot is taken over. Waiting for a slot and borrowing
// one are files kept fresh the same way: the folder outlives the processes,
// and a process ID alone may since name another process.
let own: string | null = null;
function settings() {
  if (!process.env.PAPILOT_TEX_POOL && !own) {
    own = fs.mkdtempSync(path.join(os.tmpdir(), "papilot-tex-pool-"));
    const folder = own;
    process.once("exit", () => fs.rmSync(folder, { recursive: true, force: true }));
  }
  const dir = process.env.PAPILOT_TEX_POOL || own!,
    stale = Math.max(2000, Number(process.env.PAPILOT_TEX_POOL_STALE) || 20000);
  return { dir, stale, update: Math.max(1000, Math.floor(stale / 4)) };
}
const slotFile = (dir: string, slot: number) => path.join(dir, `slot-${slot}`);
const infoFile = (dir: string, slot: number) => path.join(dir, `slot-${slot}.json`);
const borrowFile = (dir: string, slot: number) => path.join(dir, `borrow-${slot}.json`);
// The lender writes the borrow's ID here once it keeps its run stopped for
// it, so that it resumes the run when the borrow ends, however short.
const ackFile = (dir: string, slot: number) => path.join(dir, `borrow-${slot}.ack`);
// paused: the holder's run is stopped for a borrower meanwhile. since: when
// it asked for the slot, so that the newest of the least important runs is
// the one stopped.
interface Holder { id: string; pid: number; pgid: number | null; priority: PoolPriority; paused?: boolean; since?: number }
interface Borrow { id: string; pid: number; pgid: number | null }
interface Waiter { id: string; pid: number; priority: PoolPriority; since: number }

export function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function writeAtomic(file: string, value: unknown) {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.promises.writeFile(temporary, JSON.stringify(value));
  await fs.promises.rename(temporary, file);
}
async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.promises.readFile(file, "utf8")) as T; }
  catch { return null; }
}
// A waiter's or borrower's file, and whether its process still keeps it:
// it lives, and refreshed the file within `stale`.
async function readKept<T extends { pid: number }>(file: string, stale: number): Promise<{ value: T | null; kept: boolean }> {
  const [value, stat] = await Promise.all([readJson<T>(file), fs.promises.stat(file).catch(() => null)]);
  return { value, kept: Boolean(value && stat && Date.now() - stat.mtimeMs <= stale && alive(value.pid)) };
}
const touch = (file: string) => { const now = new Date(); return fs.promises.utimes(file, now, now); };
// Whether every live process of a group is stopped. An empty group has ended.
async function groupState(pgid: number): Promise<"stopped" | "running" | "gone"> {
  const lines = (await capture("ps", ["-A", "-o", "pgid=,stat="], { check: false })).stdout.toString().split("\n");
  const states = lines.flatMap((line) => {
    const [group, stat] = line.trim().split(/\s+/);
    return Number(group) === pgid && stat && !stat.startsWith("Z") ? [stat] : [];
  });
  if (!states.length) return "gone";
  return states.every((stat) => stat.startsWith("T")) ? "stopped" : "running";
}
function signal(pgid: number | null, name: NodeJS.Signals) {
  if (!signals || !pgid) return;
  try { process.kill(-pgid, name); } catch { /* The group has exited. */ }
}

interface State {
  held: { slot: number; holder: Holder | null }[];
  free: number[];
  borrows: Map<number, Borrow>;
  waiters: Waiter[];
}
async function readState(dir: string, stale: number): Promise<State> {
  const names = await fs.promises.readdir(dir).catch(() => [] as string[]),
    borrows = new Map<number, Borrow>(), waiters: Waiter[] = [], held: State["held"] = [], free: number[] = [];
  await Promise.all(names.map(async (name) => {
    const borrowed = /^borrow-(\d+)\.json$/.exec(name), waiting = /^wait-([0-9a-f]+)\.json$/.test(name);
    if (!borrowed && !waiting) return;
    const file = path.join(dir, name);
    if (waiting) {
      const { value: waiter, kept } = await readKept<Waiter>(file, stale);
      if (waiter && kept) waiters.push(waiter);
      else if (waiter) await fs.promises.rm(file, { force: true });
      return;
    }
    const slot = Number(borrowed![1]), { value: borrow, kept } = await readKept<Borrow>(file, stale);
    if (borrow && kept) { borrows.set(slot, borrow); return; }
    // A borrower that died leaves its lender to resume. The lender does that
    // itself while it lives; a lender that died too is resumed here, so its
    // compiler can end.
    const holder = await readJson<Holder>(infoFile(dir, slot));
    if (borrow && (!holder || !alive(holder.pid))) {
      signal(borrow.pgid, "SIGCONT");
      await fs.promises.rm(file, { force: true });
    }
  }));
  for (let slot = 0; slot < SLOTS; slot++) {
    const locked = await lockfile.check(slotFile(dir, slot), { stale, realpath: false }).catch(() => false);
    if (locked) {
      const holder = await readJson<Holder>(infoFile(dir, slot));
      held.push({ slot, holder: holder && alive(holder.pid) ? holder : null });
    } else if (!borrows.has(slot)) free.push(slot);
  }
  return { held, free, borrows, waiters };
}

/** One TeX run's share of the machine. A slot is taken in priority order,
 *  oldest first within a priority; a free slot is never left idle. When no
 *  slot is free, someone waiting stops a run that matters less (SIGSTOP,
 *  confirmed before it starts), the newest of the least important ones, and
 *  borrows its slot until it is done; the lender continues then, also if
 *  the borrower died. Call `release` exactly once. */
export class Lease {
  readonly id = randomBytes(8).toString("hex");
  readonly ready: Promise<void>;
  slot = -1;
  /** Running on a background run's slot, which is stopped meanwhile. */
  borrowed = false;
  /** This run's slot is lent: it must stay stopped. */
  lent = false;
  /** This run gave back the slot it borrowed, because its lender now
   *  matters more: it stays stopped until it has a slot again. */
  revoked = false;
  /** Told when `lent` or `revoked` changes. Without it, the lease stops and
   *  continues the attached run itself. */
  onLent?: () => void;
  private priority: PoolPriority;
  private pgid: number | null = null;
  private since = Date.now();
  private unlock?: () => Promise<void>;
  private released = false;
  private watching?: NodeJS.Timeout;
  private acknowledged = "";
  private settings = settings();
  // Until acquire() ends, the waiter file is this lease's to write.
  private waiting = true;
  private paused = false;
  // The lease's writes of its waiter and holder files, in order, so that
  // none lands after the file is removed.
  private writes: Promise<unknown> = Promise.resolve();
  // Keeps the waiter file and the borrow claim fresh (see readKept).
  private heartbeat?: NodeJS.Timeout;
  private claim: string | null = null;
  // While borrowing: watches whether the lender came to matter more.
  private guarding?: NodeJS.Timeout;
  // Waiting for a slot again after giving a borrowed one back.
  private again: Promise<void> | null = null;
  constructor(private wanted: () => PoolPriority) {
    this.priority = wanted();
    this.ready = this.acquire();
    this.ready.catch(() => undefined);
  }
  get waiterFile() { return path.join(this.settings.dir, `wait-${this.id}.json`); }
  /** Rewrites the priority others see, after the owner's changed. */
  update() {
    const next = this.wanted();
    if (next === this.priority) return;
    this.priority = next;
    if (this.slot >= 0 && !this.borrowed) this.describe();
    else if (this.slot < 0) this.write(() => this.waiting ? writeAtomic(this.waiterFile, this.waiter()) : undefined);
  }
  /** The process group of the run, which a borrower stops. */
  attach(child: ChildProcess) {
    this.pgid = child.pid ?? null;
    if (this.slot >= 0 && !this.borrowed) this.describe();
  }
  detach() {
    this.pgid = null;
    if (this.slot >= 0 && !this.borrowed) this.describe();
  }
  /** Says whether the run is stopped for a borrower. */
  pause(paused: boolean) {
    if (paused === this.paused) return;
    this.paused = paused;
    if (this.slot >= 0 && !this.borrowed) this.describe();
  }
  private write(work: () => Promise<unknown> | undefined) {
    this.writes = this.writes.then(work).catch(() => undefined);
  }
  private waiter(): Waiter { return { id: this.id, pid: process.pid, priority: this.priority, since: this.since }; }
  private describe() {
    this.write(() => {
      if (this.released) return;
      const holder: Holder = { id: this.id, pid: process.pid, pgid: this.pgid, priority: this.priority, since: this.since, ...(this.paused ? { paused: true } : {}) };
      return writeAtomic(infoFile(this.settings.dir, this.slot), holder);
    });
    return this.writes;
  }
  private beat() {
    const files = [this.waiting ? this.waiterFile : null, this.claim].filter((file) => file !== null);
    if (!files.length) clearInterval(this.heartbeat);
    for (const file of files) void touch(file).catch(() => undefined);
  }
  private async acquire() {
    const { dir, stale, update } = this.settings;
    await fs.promises.mkdir(dir, { recursive: true });
    this.write(() => writeAtomic(this.waiterFile, this.waiter()));
    await this.writes;
    this.heartbeat = setInterval(() => this.beat(), update);
    this.heartbeat.unref();
    try {
      for (;;) {
        if (this.released) throw new ProcessError("The build no longer needs to compile.");
        if (stopping()) throw new ProcessError("The review server is stopping.");
        this.update();
        const state = await readState(dir, stale), mine = RANK[this.priority];
        // Someone who asked at a higher priority, or earlier at the same
        // priority, goes first.
        const first = !state.waiters.some((w) => w.id !== this.id && (RANK[w.priority] > mine || (RANK[w.priority] === mine && (w.since < this.since || (w.since === this.since && w.id < this.id)))));
        // Any free slot is used, also by background work: whoever needs one
        // more later borrows it (see borrow).
        if (first)
          for (const slot of state.free) {
            await fs.promises.writeFile(slotFile(dir, slot), "", { flag: "a" });
            try {
              this.unlock = await lockfile.lock(slotFile(dir, slot), { stale, update, realpath: false, retries: 0, onCompromised: () => { /* Another process took over a lease that looked abandoned. */ } });
            } catch { continue; }
            this.slot = slot;
            await this.describe();
            this.watch();
            return;
          }
        if (first && signals && this.priority !== "background" && await this.borrow(state)) { this.guard(); return; }
        await delay(40 + Math.random() * 80);
      }
    } finally {
      this.waiting = false;
      if (!this.claim) clearInterval(this.heartbeat);
      await this.writes;
      await fs.promises.rm(this.waiterFile, { force: true });
    }
  }
  private async borrow(state: State) {
    const { dir } = this.settings, mine = RANK[this.priority];
    const lenders = state.held
      .filter(({ slot, holder }) => holder?.pgid && RANK[holder.priority] < mine && !state.borrows.has(slot))
      .sort((a, b) => RANK[a.holder!.priority] - RANK[b.holder!.priority] || (b.holder!.since ?? 0) - (a.holder!.since ?? 0));
    for (const { slot, holder } of lenders) {
      if (!holder?.pgid) continue;
      const file = borrowFile(dir, slot), claim: Borrow = { id: this.id, pid: process.pid, pgid: holder.pgid };
      try { await fs.promises.writeFile(file, JSON.stringify(claim), { flag: "wx" }); }
      catch { continue; }
      this.claim = file;
      signal(holder.pgid, "SIGSTOP");
      let confirmed: "stopped" | "running" | "gone" = "running";
      for (let i = 0; i < 60 && confirmed === "running"; i++) {
        confirmed = await groupState(holder.pgid);
        if (confirmed === "running") { await delay(50); signal(holder.pgid, "SIGSTOP"); }
      }
      // The lender acknowledges the borrow before this run starts, so it
      // resumes its run however soon the borrow ends. A lender that died
      // meanwhile is resumed on release instead.
      for (let i = 0; i < 100 && confirmed === "stopped" && alive(holder.pid); i++) {
        if ((await fs.promises.readFile(ackFile(dir, slot), "utf8").catch(() => "")) === this.id) break;
        if (i === 99) confirmed = "running";
        else await delay(50);
      }
      if (confirmed === "stopped") {
        this.slot = slot;
        this.borrowed = true;
        return true;
      }
      // The run ended meanwhile, would not stop, or its owner never saw the
      // claim: continue it as it was.
      this.claim = null;
      await fs.promises.rm(file, { force: true });
      if ((await fs.promises.readFile(ackFile(dir, slot), "utf8").catch(() => "")) !== this.id) signal(holder.pgid, "SIGCONT");
    }
    return false;
  }
  // A holder checks whether its slot was lent, and whether the borrower
  // still lives, and keeps its run stopped exactly while it is lent.
  private watch() {
    if (!signals) return;
    this.watching = setInterval(() => void this.check().catch(() => undefined), 150);
    this.watching.unref();
  }
  private async check() {
    if (this.released) return;
    const { dir, stale } = this.settings, file = borrowFile(dir, this.slot), { value: borrow, kept } = await readKept<Borrow>(file, stale);
    let lent = Boolean(borrow);
    if (borrow && !kept) {
      await fs.promises.rm(file, { force: true });
      lent = false;
    }
    if (lent !== this.lent) {
      this.lent = lent;
      if (this.onLent) this.onLent();
      else signal(this.pgid, lent ? "SIGSTOP" : "SIGCONT");
    }
    const acknowledged = borrow && lent ? borrow.id : "";
    if (acknowledged === this.acknowledged) return;
    this.acknowledged = acknowledged;
    if (acknowledged) await fs.promises.writeFile(ackFile(dir, this.slot), acknowledged);
    else await fs.promises.rm(ackFile(dir, this.slot), { force: true });
  }
  private stopped() {
    if (this.onLent) this.onLent();
    else signal(this.pgid, this.lent || this.revoked ? "SIGSTOP" : "SIGCONT");
  }
  // A borrower gives the slot back as soon as its lender matters more than
  // it, as when someone starts waiting for the lent build: the lender
  // continues at once, and the borrower waits for a slot again, stopped,
  // keeping its place in line.
  private guard() {
    if (!signals) return;
    this.guarding = setInterval(() => void (async () => {
      if (this.released || !this.borrowed || this.revoked) return;
      const holder = await readJson<Holder>(infoFile(this.settings.dir, this.slot));
      if (holder && alive(holder.pid) && RANK[holder.priority] > RANK[this.priority]) await this.revoke();
    })().catch(() => undefined), 150);
    this.guarding.unref();
  }
  private async revoke() {
    clearInterval(this.guarding);
    this.revoked = true;
    this.stopped();
    const { dir } = this.settings, file = borrowFile(dir, this.slot);
    if ((await readJson<Borrow>(file))?.id === this.id) {
      await fs.promises.rm(file, { force: true });
      await fs.promises.rm(ackFile(dir, this.slot), { force: true });
    }
    this.claim = null;
    clearInterval(this.heartbeat);
    this.borrowed = false;
    this.slot = -1;
    this.waiting = true;
    this.again = this.acquire();
    try {
      await this.again;
    } catch {
      return;
    } finally {
      this.again = null;
    }
    this.revoked = false;
    this.stopped();
  }
  async release() {
    if (this.released) return;
    this.released = true;
    await this.ready.catch(() => undefined);
    clearInterval(this.guarding);
    await this.again?.catch(() => undefined);
    if (this.watching) clearInterval(this.watching);
    clearInterval(this.heartbeat);
    await this.writes;
    const { dir } = this.settings;
    if (this.slot < 0) return;
    if (this.borrowed) {
      this.claim = null;
      const file = borrowFile(dir, this.slot), borrow = await readJson<Borrow>(file);
      if (borrow?.id === this.id) {
        await fs.promises.rm(file, { force: true });
        await fs.promises.rm(ackFile(dir, this.slot), { force: true });
        // A lender whose own process died cannot continue its run itself.
        const holder = await readJson<Holder>(infoFile(dir, this.slot));
        if (!holder || !alive(holder.pid)) signal(borrow.pgid, "SIGCONT");
      }
      return;
    }
    const holder = await readJson<Holder>(infoFile(dir, this.slot));
    if (holder?.id === this.id) await fs.promises.rm(infoFile(dir, this.slot), { force: true });
    await this.unlock?.().catch(() => undefined);
  }
}
