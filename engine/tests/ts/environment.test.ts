import { it, expect } from "vitest";
import { connect, stop } from "../../src/client.ts";
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
