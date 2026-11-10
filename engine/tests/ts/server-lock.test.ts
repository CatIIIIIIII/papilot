import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { Fixture } from "./helpers.ts";

// Another engine took over this paper, for example after this one stalled
// past the lock's stale time, or removed its lock. Two engines must not both
// write the paper's review state: the one that lost the lock stops serving.
it("an engine that loses its server lock stops serving", async () => {
  const f = new Fixture(), home = path.join(f.root, ".git/latex-review/server");
  const engine = spawn(process.execPath, ["--import", "tsx", path.join(import.meta.dirname, "../../src/cli.ts"), "serve", "--root", f.root, "--port", "0"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; engine.stderr!.on("data", chunk => { stderr += chunk; });
  const exited = new Promise<number | null>(resolve => engine.once("exit", resolve));
  try {
    for (const end = Date.now() + 20000; !fs.existsSync(path.join(home, "connection.json")); await new Promise(resolve => setTimeout(resolve, 100)))
      expect(Date.now() < end && engine.exitCode === null, stderr).toBe(true);
    const { url } = JSON.parse(fs.readFileSync(path.join(home, "connection.json"), "utf8"));
    expect((await fetch(url + "/api/info")).ok).toBe(true);
    fs.rmSync(path.join(home, "server.lock.lock"), { recursive: true, force: true });
    // The lock is renewed every ten seconds; the next renewal finds it gone.
    expect(await exited).toBe(0);
    expect(await fetch(url + "/api/info").then(() => "served", () => "refused")).toBe("refused");
    expect(fs.existsSync(path.join(home, "connection.json"))).toBe(false);
  } finally {
    engine.kill();
    await f.close();
  }
}, 40000);
