import fs from "node:fs";
import path from "node:path";
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnSyncOptionsWithBufferEncoding,
} from "node:child_process";
export class ProcessError extends Error {
  constructor(
    message: string,
    public stdout = Buffer.alloc(0),
    public stderr = Buffer.alloc(0),
    public code = 1,
  ) {
    super(message);
  }
}
export function run(
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithBufferEncoding & { check?: boolean } = {},
) {
  const { check = true, ...rest } = options;
  const result = spawnSync(command, args, {
    timeout: 300000,
    maxBuffer: 128 * 1024 * 1024,
    ...rest,
  });
  if (result.error) throw result.error;
  if (check && result.status !== 0)
    throw new ProcessError(
      result.stderr?.toString().trim() ||
        `${command} failed (${result.status})`,
      result.stdout,
      result.stderr,
      result.status ?? 1,
    );
  return {
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
    status: result.status ?? 1,
  };
}
const running = new Set<ChildProcess>();
let stopped = false;
/** Tracks a child that `start` spawns in its own process group (detached),
 *  so stopAll() ends it with everything it started. Once the server is
 *  stopping nothing new starts: a build must not retry or move on to its next
 *  step after its compiler was stopped. */
export function startTracked<T extends ChildProcess>(start: () => T): T {
  if (stopped) throw new ProcessError("The review server is stopping.");
  const child = start();
  running.add(child);
  child.once("close", () => running.delete(child));
  child.once("error", () => running.delete(child));
  return child;
}
export function stopAll() {
  stopped = true;
  for (const child of running) {
    try {
      if (child.pid) {
        process.kill(-child.pid, "SIGTERM");
        // A paused background build receives the signal once it continues.
        process.kill(-child.pid, "SIGCONT");
      }
    } catch {
      child.kill();
    }
  }
}
/** `run` without blocking the event loop: the same result and errors,
 *  delivered when the command exits. Servers call this so that a Git command
 *  never holds up the requests they answer meanwhile. */
export function capture(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string | Buffer;
    check?: boolean;
    timeout?: number;
    maxBuffer?: number;
  } = {},
) {
  const { check = true, timeout = 300000, maxBuffer = 128 * 1024 * 1024 } = options;
  return new Promise<{ stdout: Buffer; stderr: Buffer; status: number }>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = startTracked(() =>
        spawn(command, args, { cwd: options.cwd, env: options.env, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] }),
      );
    } catch (error) {
      reject(error);
      return;
    }
    const out: Buffer[] = [], err: Buffer[] = [];
    let size = 0, failure: Error | null = null;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop(new ProcessError(`${command} timed out`)), timeout);
    const collect = (into: Buffer[]) => (data: Buffer) => {
      size += data.length;
      if (size > maxBuffer) stop(new ProcessError(`${command} produced more output than expected`));
      else into.push(data);
    };
    child.stdout!.on("data", collect(out));
    child.stderr!.on("data", collect(err));
    if (options.input !== undefined) {
      child.stdin!.on("error", () => { /* The exit status reports the failure. */ });
      child.stdin!.end(options.input);
    }
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(failure ?? error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out), stderr = Buffer.concat(err), status = code ?? 1;
      if (failure) reject(failure);
      else if (check && status !== 0)
        reject(new ProcessError(stderr.toString().trim() || `${command} failed (${status})`, stdout, stderr, status));
      else resolve({ stdout, stderr, status });
    });
  });
}
export function runAsync(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    output?: (chunk: Buffer) => void;
    /** Receives the process group's leader, e.g. to pause and resume it. */
    started?: (child: ChildProcess) => void;
  } = {},
) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = startTracked(() =>
      spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    options.started?.(child);
    const chunks: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, options.timeout ?? 300000);
    const receive = (data: Buffer) => {
      chunks.push(data);
      options.output?.(data);
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const data = Buffer.concat(chunks);
      if (code === 0 && !timedOut) resolve(data);
      else
        reject(
          new ProcessError(
            timedOut ? `${command} timed out` : `${command} failed (${code})`,
            data,
            data,
            code ?? 1,
          ),
        );
    });
  });
}
export function which(command: string): string | null {
  const found = run("which", [command], { check: false });
  return found.status === 0 ? found.stdout.toString().trim() : null;
}
// A command's first output line (such as `xelatex --version`), read once per
// executable file: TeX is not replaced while a server runs, and when it is,
// the file's identity changes.
const versions = new Map<string, Promise<string>>();
export async function commandVersion(command: string, env: NodeJS.ProcessEnv = process.env) {
  const found = await resolveCommand(command, env);
  let identity = command;
  if (found) try {
    const stat = await fs.promises.stat(found);
    identity = `${found}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch { /* The command reports its own failure below. */ }
  let version = versions.get(identity);
  if (!version) {
    version = capture(found ?? command, ["--version"], { env, timeout: 60000 }).then((r) => r.stdout.toString().split("\n")[0]);
    versions.set(identity, version);
    version.catch(() => versions.delete(identity));
  }
  return version;
}
// The executable file PATH resolves a command to, as a shell would find it.
async function resolveCommand(command: string, env: NodeJS.ProcessEnv) {
  if (command.includes("/")) return path.resolve(command);
  for (const folder of (env.PATH ?? "").split(path.delimiter)) {
    if (!folder) continue;
    const file = path.join(folder, command);
    try {
      await fs.promises.access(file, fs.constants.X_OK);
      if ((await fs.promises.stat(file)).isFile()) return fs.promises.realpath(file);
    } catch { /* Try the next folder. */ }
  }
  return null;
}
