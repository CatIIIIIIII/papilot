import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Publisher } from "../../src/core/publish.ts";
import { Cancelled, runAsync } from "../../src/core/process.ts";
import type { App } from "../../src/server.ts";
import type { BuildInfo, RenderRequest, Unit } from "../../src/types.ts";

vi.mock("../../src/core/process.ts", async (original) => ({
  ...await original<typeof import("../../src/core/process.ts")>(),
  runAsync: vi.fn(),
}));
vi.mock("../../src/core/pool.ts", () => ({
  Lease: class {
    ready = Promise.resolve();
    update() {}
    attach() {}
    async release() {}
  },
}));
const folders: string[] = [];
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
type Shared = { signal: AbortSignal; priority: () => "foreground" | "normal" | "background" };
type RenderCache = {
  renderCached(request: RenderRequest, variant: ((units: Unit[], shared: Shared) => Promise<BuildInfo>) | undefined,
    priority: Shared["priority"], signal?: AbortSignal): Promise<string>;
};
function fixture() {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "papilot-render-cache-"));
  folders.push(state);
  const publisher = new Publisher({ state, store: { execute() {} } } as unknown as App) as unknown as RenderCache;
  const request = { main: "main.tex", source_dir: "", figures: [], old: { key: "old" }, new: { key: "new" }, units: [], indirect: false } as unknown as RenderRequest;
  return { publisher, request };
}
afterEach(() => {
  vi.clearAllMocks();
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});
it("a publication replaces a cancelled speculative render while its worker is still stopping", async () => {
  const { publisher, request } = fixture(), entered = deferred(), cleanup = deferred(), stop = new AbortController();
  vi.mocked(runAsync).mockImplementationOnce(async (_command, _args, options) => {
    entered.resolve();
    await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), { once: true }));
    await cleanup.promise;
    throw new Cancelled();
  }).mockImplementation(async (_command, args) => {
    fs.writeFileSync(path.join(path.dirname(args.at(-1)!), "round.json"), "{}");
    return Buffer.alloc(0);
  });
  const speculation = publisher.renderCached(request, undefined, () => "background", stop.signal);
  await entered.promise;
  stop.abort();
  await expect(speculation).rejects.toBeInstanceOf(Cancelled);
  const publication = publisher.renderCached(request, undefined, () => "foreground");
  cleanup.resolve();
  await expect(publication).resolves.toEqual(expect.any(String));
  expect(runAsync).toHaveBeenCalledTimes(2);
});
it("shared indirect variants keep running when the speculative caller leaves", async () => {
  const { publisher, request } = fixture(), entered = deferred(), proceed = deferred(), stop = new AbortController();
  request.indirect = true;
  request.units = [{ id: "c1" }, { id: "c2" }] as Unit[];
  vi.mocked(runAsync).mockImplementation(async (_command, args) => {
    const file = args.at(-1)!, folder = path.dirname(file), input = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!("causes" in input) && !("effects" in input)) {
      entered.resolve();
      await proceed.promise;
      fs.writeFileSync(path.join(folder, "attribute.json"), JSON.stringify({ changes: [{ within: [], effect: {} }], silent: ["c1"], cards: [] }));
    } else if ("effects" in input) fs.writeFileSync(path.join(folder, "shown.json"), "[true]");
    else fs.writeFileSync(path.join(folder, "round.json"), "{}");
    return Buffer.alloc(0);
  });
  const variant = vi.fn(async (_units: Unit[], shared: Shared) => {
    if ((shared?.signal ?? stop.signal).aborted) throw new Cancelled();
    expect(shared.priority()).toBe("foreground");
    return request.new;
  });
  const speculation = publisher.renderCached(request, variant, () => "background", stop.signal);
  await entered.promise;
  const publication = publisher.renderCached(request, variant, () => "foreground");
  stop.abort();
  await expect(speculation).rejects.toBeInstanceOf(Cancelled);
  proceed.resolve();
  await expect(publication).resolves.toEqual(expect.any(String));
  expect(variant).toHaveBeenCalled();
  expect(variant.mock.calls[0][1].signal.aborted).toBe(false);
});
