import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";

// Git can expand Windows short names or use a different directory casing.
// Resolve the actual spelling rather than lowercasing case-sensitive folders.
export function realPath(value: string): string {
  return process.platform === "win32"
    ? fs.realpathSync.native(value)
    : fs.realpathSync(value);
}

export function atomicWrite(
  file: string,
  data: string | Uint8Array,
  mode?: number,
) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  try {
    const fd = fs.openSync(temporary, "w");
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (mode !== undefined) fs.chmodSync(temporary, mode);
    else if (fs.existsSync(file))
      fs.chmodSync(temporary, fs.statSync(file).mode & 0o7777);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
/** `atomicWrite` without blocking the event loop on the disk. */
export async function atomicWriteAsync(file: string, data: string | Uint8Array) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.promises.open(temporary, "w");
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Windows readers and virus scanners can briefly deny replacement. Keep
    // the old file intact; retry delays total at most 1.26 seconds.
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.rename(temporary, file);
        break;
      } catch (error) {
        if (
          process.platform !== "win32" || attempt >= 6 ||
          !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code || "")
        ) throw error;
        await sleep(20 * 2 ** attempt);
      }
    }
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}
export const writeJsonAsync = (file: string, value: unknown) =>
  atomicWriteAsync(file, JSON.stringify(value, null, 2) + "\n");
export function readBytes(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
export function same(a: Uint8Array | null, b: Uint8Array | null) {
  return a === null || b === null ? a === b : Buffer.from(a).equals(b);
}
export function writeOrDelete(file: string, data: Uint8Array | null) {
  if (data === null) fs.rmSync(file, { force: true });
  else atomicWrite(file, data);
}
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (e) {
    if (
      e instanceof SyntaxError ||
      (e as NodeJS.ErrnoException).code === "ENOENT"
    )
      return fallback;
    throw e;
  }
}
export function writeJson(file: string, value: unknown, mode?: number) {
  atomicWrite(file, JSON.stringify(value, null, 2) + "\n", mode);
}
export async function acquireLock(
  file: string,
  retry = true,
  options: { stale?: number; update?: number; onLost?: () => void } = {},
) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.closeSync(fs.openSync(file, "a"));
  for (let attempt = 0; ; attempt++) {
    try {
      let lost = false;
      const release = await lockfile.lock(file, {
        realpath: false,
        stale: options.stale ?? 30000,
        update: options.update ?? 10000,
        retries: 0,
        // A lock judged stale and taken over, or whose folder another process
        // removed, is lost. The default handler throws from a timer, which
        // took the whole app down. The work under it finishes, unless its
        // owner says what losing it means (onLost).
        onCompromised: (error) => {
          lost = true;
          console.warn(`Lost the lock on ${file}: ${error.message}`);
          options.onLost?.();
        },
      });
      return async () => {
        try {
          await release();
        } catch (error) {
          if (!lost) throw error;
        }
      };
    } catch (error) {
      // Only contention can be resolved by waiting for another owner. A
      // removed build directory or a permission error must not keep a
      // cancelled background build retrying for fifteen minutes.
      if (!retry || attempt >= 1800 || (error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
      await sleep(Math.min(100 * 2 ** attempt, 500));
    }
  }
}
export async function withLock<T>(
  file: string,
  work: () => Promise<T>,
  retry = true,
) {
  const release = await acquireLock(file, retry);
  try {
    return await work();
  } finally {
    await release();
  }
}
export function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? listFiles(path.join(root, e.name))
        : [path.join(root, e.name)],
    );
}
export const now = () => Date.now() / 1000;
export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
