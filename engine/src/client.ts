import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT, codeVersion, environmentVersion } from "./runtime.ts";
import { gitDirOf } from "./core/git.ts";
import { readJson, sleep, withLock } from "./core/files.ts";
export interface Connection {
  url: string;
  port: number;
  pid: number;
  root?: string;
  version?: string;
}
export interface ServerInfo {
  root: string;
  version: string;
  environment?: string;
  pid: number;
  busy: boolean;
  csrf: string;
  build_workers: number;
  runtime?: string;
}
export class ServerError extends Error {}
export async function call<T>(
  url: string,
  route: string,
  data?: unknown,
  token = "",
  timeout = 30000,
): Promise<T> {
  const response = await fetch(url + route, {
    method: data === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-Review-Token": token },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(timeout),
    redirect: "error",
  });
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new ServerError(value.error || `HTTP ${response.status}`);
  return value;
}
export class Client {
  constructor(
    public url: string,
    public token: string,
  ) {}
  get<T>(route: string, timeout = 30000) {
    return call<T>(this.url, route, undefined, "", timeout);
  }
  post<T>(route: string, data: unknown = {}, timeout = 120000) {
    return call<T>(this.url, route, data, this.token, timeout);
  }
}
// Every request an app forwards connects first, so the Git directory is
// looked up once per repository rather than with a Git command each time.
export const serverHome = (root: string) => path.join(gitDirOf(root), "latex-review/server");
export async function probe(root: string, info: Partial<Connection> | null) {
  if (!info?.url) return null;
  const address = new URL(info.url);
  if (address.protocol !== "http:" || address.hostname !== "127.0.0.1")
    return null;
  try {
    const answer = await call<ServerInfo>(
      info.url,
      "/api/info",
      undefined,
      "",
      5000,
    );
    return path.resolve(answer.root) === path.resolve(root) ? answer : null;
  } catch {
    return null;
  }
}
async function waitForExit(url: string, pid: number) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const info = await call<ServerInfo>(
        url,
        "/api/info",
        undefined,
        "",
        1000,
      );
      if (info.pid !== pid) return;
    } catch {
      return;
    }
    await sleep(100);
  }
  throw new ServerError(
    "The review server has not stopped yet. Retry after it finishes.",
  );
}
// A CLI command exits right away, so the server it starts runs on its own.
// An app owns the server it starts: the server stops when the app's process
// ends, however it ends, because their IPC channel closes. Either way it
// gets its own process group, so killing the app's group cannot skip the
// server's cleanup.
async function launch(root: string, port: number, owned: boolean): Promise<Client> {
  const home = serverHome(root);
  fs.mkdirSync(home, { recursive: true });
  const log = path.join(home, "server.log");
  if (fs.existsSync(log) && fs.statSync(log).size > 2000000)
    fs.renameSync(log, log + ".1");
  const fd = fs.openSync(log, "a"),
    child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(ROOT, "src/cli.ts"),
        "serve",
        "--root",
        root,
        "--port",
        String(port),
      ],
      {
        // Process lists show this name instead of node. (process.title would
        // register the server with macOS as a background app.)
        argv0: owned ? "Papilot review server" : "latex-review server",
        cwd: ROOT,
        detached: true,
        stdio: owned ? ["ignore", fd, fd, "ipc"] : ["ignore", fd, fd],
        env: process.env,
      },
    );
  fs.closeSync(fd);
  let launchError: Error | undefined;
  child.on("error", (error) => {
    launchError = error;
  });
  child.unref();
  child.channel?.unref();
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (launchError) throw new ServerError(launchError.message);
    const info = readJson<Connection | null>(
      path.join(home, "connection.json"),
      null,
    );
    if (info && info.pid === child.pid) {
      const answer = await probe(root, info);
      if (answer) return new Client(info.url, answer.csrf);
    }
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  throw new ServerError(
    "The review server failed to start:\n" +
      fs.readFileSync(log, "utf8").slice(-1500),
  );
}
export async function connect(
  root: string,
  start: false,
): Promise<Client | null>;
export async function connect(
  root: string,
  start?: true,
  options?: { owned?: boolean },
): Promise<Client>;
/** With `owned`, a server this call starts stops with the calling process.
 *  A server that is already running is reused and keeps its own lifetime. */
export async function connect(
  root: string,
  start = true,
  { owned = false }: { owned?: boolean } = {},
): Promise<Client | null> {
  // Match the canonical repository path reported by the server (e.g. macOS /var).
  root = fs.realpathSync(root);
  const home = serverHome(root);
  // A reader neither starts nor upgrades the server. Do not wait behind an
  // upgrader holding start.lock while the job we need to inspect is building.
  if (!start) {
    const last = readJson<{ port: number } | null>(path.join(home, "last.json"), null);
    const info = readJson<Connection | null>(path.join(home, "connection.json"), null)
      ?? (last ? { url: `http://127.0.0.1:${last.port}`, port: last.port, pid: 0 } : null);
    const answer = await probe(root, info);
    return answer ? new Client(info!.url, answer.csrf) : null;
  }
  return withLock(path.join(home, "start.lock"), async () => {
    const last = readJson<{ port: number } | null>(
      path.join(home, "last.json"),
      null,
    );
    let info = readJson<Connection | null>(
      path.join(home, "connection.json"),
      null,
    );
    if (!info && last)
      info = { url: `http://127.0.0.1:${last.port}`, port: last.port, pid: 0 };
    let answer = await probe(root, info);
    if (
      answer &&
      answer.version === codeVersion() &&
      answer.environment === environmentVersion()
    )
      return new Client(info!.url, answer.csrf);
    if (answer && info) {
      const deadline = Date.now() + 900000;
      while (answer?.busy && Date.now() < deadline) {
        await sleep(1000);
        answer = await probe(root, info);
      }
      if (answer?.busy)
        throw new ServerError(
          "A round is still building. Wait for it before upgrading the server.",
        );
      if (answer) {
        await call(info.url, "/api/shutdown", {}, answer.csrf, 5000);
        await waitForExit(info.url, answer.pid);
      }
    }
    return launch(root, info?.port ?? last?.port ?? 0, owned);
  });
}
export async function stop(root: string, force = false) {
  const client = await connect(root, false);
  if (!client) return null;
  const answer = await client.get<ServerInfo>("/api/info");
  await client.post("/api/shutdown", { force });
  await waitForExit(client.url, answer.pid);
  return client.url;
}
