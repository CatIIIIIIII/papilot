import { it, expect } from "vitest";
import { buildDate } from "../../src/core/build.ts";
import { attribute } from "../../src/core/publish.ts";
import {
  differences,
  furniture,
  type Words,
} from "../../src/render/effects.ts";
import type { Rect, Unit } from "../../src/types.ts";

// One printed line of words.
const words = (text: string) => {
  const tokens = text
    .split(" ")
    .map((t, i) => ({ text: t, start: i, end: i + 1 }));
  return { glyphs: [], tokens, lines: [[0, tokens.length]] } as Words;
};

it("treats a run that moves elsewhere as moved, both where it left and where it arrived", () => {
  // Either run can be the one that moves; both are long enough to tell.
  const caption = "Figure 2 shows the architecture of the whole system",
    text = "gamma delta epsilon zeta eta theta";
  expect(
    differences(
      words(`alpha ${caption} ${text} omega`),
      words(`alpha ${text} ${caption} omega`),
    ),
  ).toEqual([]);
  // Numbers shifted by one are changes, however often each number recurs.
  expect(
    differences(
      words("see ( 3 ) and ( 4 ) here"),
      words("see ( 4 ) and ( 5 ) here"),
    ),
  ).toHaveLength(2);
});

it("leaves out page numbers and running heads but keeps text at the top of a page", () => {
  const line = (text: string, top: number): { text: string; rect: Rect } => ({
    text,
    rect: [100, top, 300, top + 10],
  });
  const pages = [
    [line("3 THE MODEL", 40), line("A heading at the top", 80), line("3", 700)],
    [line("4 THE MODEL", 40), line("Another first line", 80), line("4", 700)],
    [line("Only text, then its number", 80), line("5", 700)],
    // Section numbers that open pages are text, though they look alike.
    [line("1.3", 80), line("Heading", 80), line("6", 700)],
    [line("2.7", 80), line("Another heading", 80), line("7", 700)],
  ];
  const document = {
    length: pages.length,
    page: (n: number) => ({ lines: pages[n], label: String(n + 3) }),
  } as unknown as Parameters<typeof furniture>[0];
  expect(furniture(document)).toEqual([
    [pages[0][0].rect, pages[0][2].rect],
    [pages[1][0].rect, pages[1][2].rect],
    [pages[2][1].rect],
    [pages[3][2].rect],
    [pages[4][2].rect],
  ]);
});

const unit = (id: string) => ({ id }) as Unit;

it("finds the edit behind each change by compiling halves, and lists edits needed together", async () => {
  const units = ["c001", "c002", "c003", "c004"].map(unit);
  // Change 0 comes from c003 alone; change 1 needs c001 and c004 together.
  const shown = async (group: Unit[]) => {
    const ids = group.map((u) => u.id);
    return [ids.includes("c003"), ids.includes("c001") && ids.includes("c004")];
  };
  expect(
    await attribute(units, [{ within: [] }, { within: [] }], [], shown),
  ).toEqual([["c003"], ["c001", "c002", "c003", "c004"]]);
});

it("counts the builds of silent edits against the same limit", async () => {
  const units = Array.from({ length: 21 }, (_, i) =>
    unit(`c${String(i + 1).padStart(3, "0")}`),
  );
  let builds = 0;
  const causes = await attribute(
    units,
    [{ within: [] }],
    units.slice(0, 20).map((u) => u.id),
    async (group) => {
      builds++;
      return [group.some((u) => u.id === "c021")];
    },
  );
  expect(builds).toBeLessThanOrEqual(16);
  expect(causes[0]).toContain("c021");
});

it("gives every build of a day the date of that day", () => {
  const morning = new Date(2026, 9, 30, 0, 5),
    night = new Date(2026, 9, 30, 23, 55),
    date = buildDate(morning, {});
  expect(buildDate(night, {})).toEqual(date);
  expect(new Date(Number(date.SOURCE_DATE_EPOCH) * 1000).toISOString()).toBe(
    "2026-10-30T12:00:00.000Z",
  );
  expect(date.FORCE_SOURCE_DATE).toBe("1");
  expect(buildDate(morning, { SOURCE_DATE_EPOCH: "42" })).toEqual({
    SOURCE_DATE_EPOCH: "42",
  });
});
