// Another process of the TeX pool, for pool.test.ts: takes a lease at the
// given priority, starts a stand-in compiler in its own process group, says
// which slot it holds, and lets go when its input closes.
import { spawn } from "node:child_process";
import { Lease, type PoolPriority } from "../../src/core/pool.ts";
const lease = new Lease(() => process.argv[2] as PoolPriority);
await lease.ready;
const child = spawn("sleep", ["120"], { detached: true, stdio: "ignore" });
lease.attach(child);
process.stdout.write(JSON.stringify({ slot: lease.slot, borrowed: lease.borrowed, pgid: child.pid }) + "\n");
process.stdin.resume();
process.stdin.on("end", async () => {
  try { process.kill(-child.pid!, "SIGKILL"); } catch { /* Already gone. */ }
  await lease.release();
  process.exit(0);
});
