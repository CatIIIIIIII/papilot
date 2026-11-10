import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { expect, it, vi } from "vitest";
import { acquireLock } from "../../src/core/files.ts";

it("a disappearing lock directory rejects instead of retrying after cleanup", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "review-lock-")),
    file = path.join(folder, "build.lock"), original = lockfile.lock.bind(lockfile);
  // Cleanup races with the first asynchronous mkdir after acquireLock has
  // prepared the parent. Exercise the real lock library's error handling.
  const locking = vi.spyOn(lockfile, "lock").mockImplementationOnce((file, options) => {
    fs.rmSync(folder, { recursive: true, force: true });
    return original(file, options);
  });
  let release: (() => Promise<void>) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const result = acquireLock(file).then(value => { release = value; return "acquired"; }, error => error.code);
  try {
    expect(await Promise.race([result, new Promise(resolve => { timer = setTimeout(() => resolve("still retrying"), 1000); })])).toBe("ENOENT");
  } finally {
    clearTimeout(timer);
    // A regressed implementation must still unwind, so a failed assertion
    // cannot leave its 15-minute retry loop running in the test process.
    fs.mkdirSync(folder, { recursive: true });
    await result;
    await release?.();
    locking.mockRestore();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

it("a competing lock waits for the current owner to release it", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "review-lock-")),
    file = path.join(folder, "build.lock");
  let first: (() => Promise<void>) | undefined, second: (() => Promise<void>) | undefined;
  try {
    first = await acquireLock(file);
    let acquired = false;
    const waiting = acquireLock(file).then(release => { second = release; acquired = true; });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(acquired).toBe(false);
    await first(); first = undefined;
    await waiting;
    expect(acquired).toBe(true);
  } finally {
    await second?.();
    await first?.();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

it("a non-waiting lock reports contention immediately", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "review-lock-")),
    file = path.join(folder, "build.lock"), release = await acquireLock(file);
  try {
    await expect(acquireLock(file, false)).rejects.toMatchObject({ code: "ELOCKED" });
  } finally {
    await release();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
