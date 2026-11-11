import { it, expect } from "vitest";
import { Cancelled, runAsync } from "../../src/core/process.ts";

it.skipIf(process.platform === "win32")("a command that already exited keeps its result when cancelled before its output closes", async () => {
  // A background process holds the output open after the command exits, as
  // TeX's helpers can, so the cancellation lands between exit and close.
  const stop = new AbortController();
  const run = runAsync("sh", ["-c", "echo done; sleep 0.5 & exit 0"], {
    signal: stop.signal,
    started: (child) => { child.once("exit", () => stop.abort()); },
  });
  await expect(run).resolves.toEqual(Buffer.from("done\n"));
});

it.skipIf(process.platform === "win32")("a running command is cancelled", async () => {
  const stop = new AbortController();
  const run = runAsync("sh", ["-c", "echo started; sleep 30"], { signal: stop.signal, output: () => stop.abort() });
  await expect(run).rejects.toBeInstanceOf(Cancelled);
});
