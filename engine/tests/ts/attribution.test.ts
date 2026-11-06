import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { attribute } from "../../src/core/publish.ts";
import { Fixture, fakeRound } from "./helpers.ts";
import type { Unit } from "../../src/types.ts";

const units = ["A", "B", "C"].map((id) => ({ id }) as Unit);

it("returns one verified combination without claiming every alternative cause", async () => {
  const shown = async (group: Unit[]) => {
    const ids = new Set(group.map((u) => u.id));
    return [ids.has("A") || (ids.has("B") && ids.has("C"))];
  };
  const causes = await attribute(units, [{ within: [] }], ["A"], shown);
  expect(causes).toEqual([["A"]]);
  expect(await shown(units.filter((u) => causes[0].includes(u.id)))).toEqual([
    true,
  ]);
  // The same final effect also has a sufficient combination absent from the
  // returned explanation. The contract deliberately makes no completeness claim.
  expect(await shown(units.slice(1))).toEqual([true]);
});

it("verifies the union because independently sufficient edits can cancel", async () => {
  const shown = async (group: Unit[]) => {
    const ids = new Set(group.map((u) => u.id));
    return [ids.has("A") !== ids.has("B") || ids.size === 3];
  };
  expect(await shown(units.slice(0, 1))).toEqual([true]);
  expect(await shown(units.slice(1, 2))).toEqual([true]);
  expect(await shown(units.slice(0, 2))).toEqual([false]);
  expect(
    await attribute(units, [{ within: [] }], ["A", "B", "C"], shown),
  ).toEqual([["A", "B", "C"]]);
});

it("uses the verified final combination when a combined variant cannot be compared", async () => {
  expect(
    await attribute(units, [{ within: [] }], ["A", "B"], async (group) => {
      const ids = group.map((u) => u.id);
      if (ids.join() === "A,B") return null;
      return [ids.includes("A") || ids.includes("B")];
    }),
  ).toEqual([["A", "B", "C"]]);
});

it("returns sufficient groups for every three-edit boolean interaction", async () => {
  // Baseline is false and the complete edited build is true; all six other
  // results are independent, including non-monotone interactions.
  for (let table = 0; table < 64; table++) {
    const mask = (group: Unit[]) =>
        group.reduce((value, u) => value | (1 << units.indexOf(u)), 0),
      effect = (bits: number) =>
        bits === 7 || (bits > 0 && Boolean(table & (1 << (bits - 1)))),
      calls = new Set<number>(),
      causes = await attribute(
        units,
        [{ within: [] }],
        ["A", "B", "C"],
        async (group) => {
          expect(calls.has(mask(group))).toBe(false);
          calls.add(mask(group));
          return [effect(mask(group))];
        },
      );
    expect(
      effect(mask(units.filter((u) => causes[0].includes(u.id)))),
      `table ${table}`,
    ).toBe(true);
  }
});

it("keeps accepts and rejects scoped to the selected edit despite shared effects", async () => {
  const fixture = new Fixture();
  try {
    for (const id of ["A", "B", "C"]) fixture.write(`paper/${id}.tex`, "old\n");
    fixture.repo.run(["add", "."]);
    fixture.repo.run(["commit", "-qm", "Independent edit fixture"]);
    const app = fixture.app(),
      task = app.tasks.create("attribution", "Attribution", [], ["paper"]);
    for (const id of ["A", "B", "C"])
      fixture.edit(task, `paper/${id}.tex`, "old", "new");
    const round = fakeRound(app, task.name),
      [a, b, c] = round.units,
      folder = path.join(app.state, "rounds", task.name, "001");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, "round.json"),
      JSON.stringify({
        units: Object.fromEntries(
          round.units.map((u) => [
            u.id,
            {
              visual: "text",
              pages: ["1"],
              section: null,
              effects: {
                total: 1,
                verified: true,
                shown: [
                  {
                    page: "1",
                    section: null,
                    before: [],
                    after: [],
                    with: round.units
                      .filter((v) => v.id !== u.id)
                      .map((v) => v.id),
                  },
                ],
              },
            },
          ]),
        ),
        sections: [],
        loose: [],
      }),
    );
    const decide = (action: "accept" | "reject", unit: Unit) =>
      app.review.decide(task.name, {
        id: action,
        action,
        changes: [unit.id],
        round: round.number,
      });
    await decide("accept", a);
    expect(fixture.read(a.file)).toBe("new\n");
    expect(fixture.read(b.file)).toBe("old\n");
    expect(fixture.read(c.file)).toBe("old\n");
    await decide("reject", b);
    expect(fixture.read(b.file, task.worktree)).toBe("old\n");
    expect(fixture.read(c.file, task.worktree)).toBe("new\n");
    expect(app.review.pageState(task.name).decisions).toEqual({
      [a.id]: "accepted",
      [b.id]: "rejected",
      [c.id]: "pending",
    });
  } finally {
    await fixture.close();
  }
});
