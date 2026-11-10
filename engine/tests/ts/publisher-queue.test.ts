import { expect, it } from "vitest";
import { now } from "../../src/core/files.ts";
import { Fixture } from "./helpers.ts";
import type { Job } from "../../src/types.ts";

it("builds the queued round whose review page was read last first, and a superseded round at its successor's priority", async () => {
  const f = new Fixture(), app = f.app();
  try {
    for (const name of ["first", "second", "third"]) app.tasks.create(name);
    const order: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    app.publisher.publish = async (job: Pick<Job, "id" | "task">) => {
      order.push(job.task);
      if (order.length === 1) await gate;
      return { outcome: "empty", round: null, changes: 0 };
    };
    const running = app.publisher.submit("first");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.publisher.job(running.id).status).toBe("running");
    expect(app.publisher.priority(running)).toBe("normal");
    app.viewers.set("first", now());
    expect(app.publisher.priority(running)).toBe("foreground");
    app.publisher.submit("second");
    app.publisher.submit("third");
    // The author reads the third task's review: it is built next.
    app.viewers.set("third", now());
    // A newer round of the first task supersedes the running one. The newer
    // one starts only when it ends and continues from its builds, so it
    // keeps the newer one's priority rather than waiting in the background.
    const newer = app.publisher.submit("first");
    expect(app.publisher.priority(running)).toBe("foreground");
    expect(app.publisher.priority(newer)).toBe("foreground");
    open();
    await app.publisher.join();
    expect(order).toEqual(["first", "third", "first", "second"]);
  } finally {
    await f.close();
  }
});
