import { it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { connect, probe, serverHome, stop } from "../../src/client.ts";
import { createServer } from "../../src/server.ts";
import { environmentVersion } from "../../src/runtime.ts";
import { Fixture } from "./helpers.ts";

it("fingerprints build settings without including unrelated credentials", () => {
  expect(environmentVersion({ PATH: "/python/bin:/bin" })).not.toBe(
    environmentVersion({ PATH: "/bin" }),
  );
  expect(environmentVersion({ PATH: "/bin", TOKEN: "one" })).toBe(
    environmentVersion({ TOKEN: "two", PATH: "/bin" }),
  );
  expect(environmentVersion({ PATH: "/bin", TEXINPUTS: "one" })).not.toBe(
    environmentVersion({ PATH: "/bin", TEXINPUTS: "two" }),
  );
});

it("recognizes repository aliases when probing a running review server", async () => {
  const fixture = new Fixture(),
    app = fixture.app(),
    server = createServer(app),
    alias = path.join(fixture.base, "alias"),
    other = path.join(fixture.base, "other");
  try {
    fs.symlinkSync(fixture.root, alias, process.platform === "win32" ? "junction" : "dir");
    fs.mkdirSync(other);
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.server.address();
    if (!address || typeof address === "string") throw new Error("No server address");
    const connection = { url: `http://127.0.0.1:${address.port}` };
    app.url = connection.url;
    const aliases = [alias, fixture.root];
    // Git and Node can spell the Windows temp directory differently, including
    // the RUNNER~1 short name. Native identity must agree for all spellings.
    if (process.platform === "win32") aliases.push(fixture.root.toUpperCase(), fixture.root.toLowerCase());
    for (const root of aliases) {
      expect((await probe(root, connection))?.pid).toBe(process.pid);
      expect(serverHome(root)).toBe(serverHome(fixture.root));
    }
    expect(await probe(other, connection)).toBeNull();
  } finally {
    await server.close();
    await fixture.close();
  }
});

it("restarts an idle detached review server when its build environment changes", async () => {
  const fixture = new Fixture(),
    previous = process.env.TEXINPUTS;
  try {
    process.env.TEXINPUTS = "/initial-tex-inputs:";
    const first = await connect(fixture.root);
    const initial = await first.get<{ pid: number; environment: string }>(
      "/api/info",
    );
    process.env.TEXINPUTS = "/changed-tex-inputs:";
    // Inspecting status must not restart a server.
    const observed = await connect(fixture.root, false);
    expect((await observed!.get<{ pid: number }>("/api/info")).pid).toBe(
      initial.pid,
    );
    const second = await connect(fixture.root);
    const updated = await second.get<{ pid: number; environment: string }>(
      "/api/info",
    );
    expect(updated.pid).not.toBe(initial.pid);
    expect(updated.environment).toBe(environmentVersion());
    expect(updated.environment).not.toBe(initial.environment);
  } finally {
    await stop(fixture.root);
    if (previous === undefined) delete process.env.TEXINPUTS;
    else process.env.TEXINPUTS = previous;
    await fixture.close();
  }
}, 60000);
