import { it, expect } from "vitest";
import { runAsync, stopAll } from "../../src/core/process.ts";

// stopAll() is final for the process, so this file stands alone.
it("a stopping server ends its children and starts no new ones", async () => {
  const sleeping = runAsync(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  stopAll();
  await expect(sleeping).rejects.toThrow(/failed/);
  // A build that retries or moves on after its compiler was stopped gets nothing.
  await expect(runAsync(process.execPath, ["-e", ""])).rejects.toThrow(/stopping/);
});
