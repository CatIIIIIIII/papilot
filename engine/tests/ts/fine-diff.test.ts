import { afterEach, beforeEach, expect, it } from "vitest";
import { Fixture, METHOD, fakeRound } from "./helpers.ts";
import { applyUnits, diffUnits, revertUnits } from "../../src/core/changes.ts";
import { merge3, merge3Async } from "../../src/core/git.ts";
import { textEdits, textTokens } from "../../src/core/text-edits.ts";
let f: Fixture;
beforeEach(() => {
  f = new Fixture();
});
afterEach(async () => f.close());

it("applies every subset of independent edits on the same source line exactly", () => {
  const old =
      "The method is fast, the estimate is stable, and the result is useful.\n",
    next =
      "The method is efficient, the estimate is robust, and the result is practical.\n";
  f.write(METHOD, old);
  const before = f.repo.snapshot(["paper"]);
  f.write(METHOD, next);
  const after = f.repo.snapshot(["paper"]),
    units = diffUnits(f.repo, before, after);
  expect(units.map((u) => [u.old_text, u.new_text])).toEqual([
    ["fast", "efficient"],
    ["stable", "robust"],
    ["useful", "practical"],
  ]);
  for (let mask = 0; mask < 8; mask++) {
    const selected = units.filter((_, i) => mask & (1 << i));
    let expected = old;
    for (const unit of selected)
      expected = expected.replace(unit.old_text, unit.new_text);
    expect(
      applyUnits(Buffer.from(old), Buffer.from(next), selected)?.toString(),
    ).toBe(expected);
    expect(
      revertUnits(
        Buffer.from(old),
        Buffer.from(next),
        units.filter((u) => !selected.includes(u)),
      )?.toString(),
    ).toBe(expected);
  }
});

it("keeps math and nested command arguments atomic and handles CJK prose", () => {
  expect(
    textTokens(
      String.raw`A \textbf{fast and {stable}} result $x + y$ is useful.`,
    ),
  ).toContain(String.raw`\textbf{fast and {stable}}`);
  expect(
    textEdits(
      String.raw`Use $x + y$ and $a + b$.`,
      String.raw`Use $x - y$ and $a - b$.`,
    ),
  ).toHaveLength(2);
  expect(
    textEdits("方法很快，结果稳定。", "方法高效，结果可靠。"),
  ).toHaveLength(2);
});

it("keeps prose line rewrapping together without exposing unchanged words as deletions", () => {
  const old = 'The editor keeps an undo\nhistory for every version, with a pointer\nto an older root.\n';
  const next = 'The editor keeps an\nundo history for every version, with a\npointer to an older root.\n';
  f.write(METHOD, old);
  const before = f.repo.snapshot(['paper']);
  f.write(METHOD, next);
  const after = f.repo.snapshot(['paper']), units = diffUnits(f.repo, before, after);
  expect(units).toHaveLength(1);
  expect(units[0].old_text.replace(/\s+/g, ' ').trim()).toBe(units[0].new_text.replace(/\s+/g, ' ').trim());
  expect(applyUnits(Buffer.from(old), Buffer.from(next), units)?.toString()).toBe(next);
  expect(revertUnits(Buffer.from(old), Buffer.from(next), units)?.toString()).toBe(old);
});

it("applies insertions and deletions precisely, while older line-based units still work", () => {
  const old = "A quick model is very useful.\r\nUnchanged.\r\n",
    next = "A new quick model is useful.\r\nUnchanged.\r\n";
  f.write(METHOD, old);
  const before = f.repo.snapshot(["paper"]);
  f.write(METHOD, next);
  const after = f.repo.snapshot(["paper"]),
    units = diffUnits(f.repo, before, after);
  expect(units).toHaveLength(2);
  expect(
    applyUnits(Buffer.from(old), Buffer.from(next), [units[0]])?.toString(),
  ).toBe(old.replace("A quick", "A new quick"));
  expect(
    applyUnits(Buffer.from(old), Buffer.from(next), [units[1]])?.toString(),
  ).toBe(old.replace("very ", ""));
  expect(
    revertUnits(Buffer.from(old), Buffer.from(next), units)?.toString(),
  ).toBe(old);
  const legacy = {
    ...units[0],
    text_ops: undefined,
    ops: [["replace", 0, 1, 0, 1] as const],
  };
  expect(
    applyUnits(Buffer.from(old), Buffer.from(next), [
      { ...legacy, ops: [["replace", 0, 1, 0, 1]] },
    ])?.toString(),
  ).toBe(next);
});

it("preserves empty source sides in the legacy line coordinates", () => {
  const old = 'Following line.\n', next = 'Inserted line.\n' + old;
  f.write(METHOD, old);
  const before = f.repo.snapshot(['paper']);
  f.write(METHOD, next);
  const after = f.repo.snapshot(['paper']);
  for (const [a, b] of [[before, after], [after, before]]) {
    const units = diffUnits(f.repo, a, b);
    expect(units).toHaveLength(1);
    const text = units[0].text_ops![0], lines = units[0].ops[0];
    expect(text[1] === text[2]).toBe(lines[1] === lines[2]);
    expect(text[3] === text[4]).toBe(lines[3] === lines[4]);
  }
});

it("keeps multiline math and arguments together even across unchanged source lines", () => {
  const old =
      "Text is fast.\n\\begin{align}\na &= x + y \\\\\n b &= c \\\\\n d &= p + q\n\\end{align}\n\\textbf{The result\nis useful\nand stable}\n",
    next = old
      .replace("fast", "efficient")
      .replace("x + y", "x - y")
      .replace("p + q", "p - q")
      .replace("useful", "practical")
      .replace("stable", "robust");
  f.write(METHOD, old);
  const before = f.repo.snapshot(["paper"]);
  f.write(METHOD, next);
  const after = f.repo.snapshot(["paper"]),
    units = diffUnits(f.repo, before, after);
  expect(units).toHaveLength(3);
  expect(units[1].old_text).toContain("\\begin{align}");
  expect(units[1].old_text).toContain("\\end{align}");
  expect(units[2].old_text).toBe("\\textbf{The result\nis useful\nand stable}");
  expect(
    applyUnits(Buffer.from(old), Buffer.from(next), units)?.toString(),
  ).toBe(next);
});

it("does not attach a comment to another change on the same source line", async () => {
  const old = "The method is fast and the result is useful.\n";
  f.write(METHOD, old);
  const app = f.app(),
    task = app.tasks.create("history", "History", [], ["paper"]);
  f.edit(
    task,
    METHOD,
    old,
    old.replace("fast", "efficient").replace("useful", "practical"),
  );
  const first = fakeRound(app, task.name);
  await app.review.decide(task.name, {
    action: "comment",
    changes: ["c001"],
    id: "comment",
    round: first.number,
    body: "Try another word.",
  });
  f.edit(task, METHOD, "efficient", "quick");
  const next = fakeRound(app, task.name),
    history = app.review.history(task.name, next);
  expect(history.c001).toHaveLength(1);
  expect(history.c002).toBeUndefined();
});

it("accepts, rejects and undoes same-line edits without losing other decisions or user edits", async () => {
  const old =
    "The method is fast, the estimate is stable, and the result is useful.\n";
  f.write(METHOD, old);
  const app = f.app(),
    task = app.tasks.create("fine", "Fine diff", [], ["paper"]);
  f.edit(
    task,
    METHOD,
    old,
    old
      .replace("fast", "efficient")
      .replace("stable", "robust")
      .replace("useful", "practical"),
  );
  const round = fakeRound(app, task.name);
  const decide = (action: "accept" | "reject", change: string, id: string) =>
    app.review.decide(task.name, {
      action,
      changes: [change],
      id,
      round: round.number,
    });
  f.write(METHOD, old.replace("The method", "Our method"));
  await decide("accept", "c001", "first");
  await decide("accept", "c003", "third");
  expect(f.read(METHOD)).toBe(
    old
      .replace("The method", "Our method")
      .replace("fast", "efficient")
      .replace("useful", "practical"),
  );
  await decide("reject", "c002", "second");
  expect(f.read(METHOD, task.worktree)).toBe(
    old.replace("fast", "efficient").replace("useful", "practical"),
  );
  await app.review.undo(task.name, "second");
  expect(f.read(METHOD, task.worktree)).toContain("robust");
  await app.review.undo(task.name, "third");
  expect(f.read(METHOD)).toBe(
    old.replace("The method", "Our method").replace("fast", "efficient"),
  );
});

it("merges disjoint same-line edits but preserves real overlap conflicts", async () => {
  const b = Buffer.from;
  for (const merge of [merge3, merge3Async]) {
    expect(
      await merge(
        b("fast and useful"),
        b("slow and useful"),
        b("slow and practical"),
      ),
    ).toEqual([b("fast and practical"), false]);
    expect(
      (await merge(b("fast result"), b("slow result"), b("quick result")))[1],
    ).toBe(true);
    expect(
      (await merge(b("a new result"), b("a result"), b("a better result")))[1],
    ).toBe(true);
    expect(
      (
        await merge(
          b(String.raw`\textbf{fast stable}`),
          b(String.raw`\textbf{slow stable}`),
          b(String.raw`\textbf{slow robust}`),
        )
      )[1],
    ).toBe(true);
  }
});
