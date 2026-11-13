import { afterEach, expect, it, vi } from "vitest";
import { Fixture } from "./helpers.ts";
import { Builder } from "../../src/core/build.ts";
import { loadProject } from "../../src/core/config.ts";
import * as processTools from "../../src/core/process.ts";
import type { BuildProgress } from "../../src/types.ts";

afterEach(() => vi.restoreAllMocks());

it.each([true, false])("shares current and subsequent progress when the first caller subscribes: %s", async (subscribed) => {
  const fixture = new Fixture(), project = loadProject(fixture.root);
  const firstBuilder = new Builder(project, fixture.repo), secondBuilder = new Builder(project, fixture.repo);
  const first: BuildProgress[] = [], second: BuildProgress[] = [];
  let started!: () => void, finish!: () => void, report!: (value: BuildProgress) => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  const done = new Promise<void>(resolve => { finish = resolve; });
  vi.spyOn(processTools, "commandVersion").mockResolvedValue("test compiler");
  // Only replace the compiler: keep the real build-key deduplication,
  // scheduling, and subscriber lifecycle across separate Builder instances.
  const compile = vi.spyOn(Builder.prototype as any, "compile").mockImplementation(async (...args: any[]) => {
    report = args[9];
    started();
    await done;
    return { key: args[2] };
  });
  const pending: Promise<unknown>[] = [];
  try {
    const rev = fixture.repo.rev("HEAD");
    pending.push(firstBuilder.build(rev, ["full"], null, subscribed ? { progress: value => first.push(value) } : {}));
    await begun;
    const current: BuildProgress = { step: "tex", pass: 2, pages: 87, total: 343 };
    report(current);
    pending.push(secondBuilder.build(rev, ["full"], null, { progress: value => second.push(value) }));
    await vi.waitFor(() => expect(second).toEqual([current]));
    const next: BuildProgress = { ...current, pages: 88 };
    report(next);
    expect(first).toEqual(subscribed ? [current, next] : []);
    expect(second).toEqual([current, next]);
    finish();
    const [a, b] = await Promise.all(pending);
    expect(a).toEqual(b);
    expect(compile).toHaveBeenCalledTimes(1);
    report({ ...next, pages: 89 });
    expect(second).toEqual([current, next]);
  } finally {
    finish();
    await Promise.allSettled(pending);
    await fixture.close();
  }
});
