import { expect, it } from "vitest";
import { partition, regions, type Tile } from "../../src/render/plan.ts";
import type { Card, Pair, Position, Rect } from "../../src/types.ts";

const at = (clip: Rect, page = 0): Position => ({
  page,
  clip,
  label: String(page + 1),
});
const pair = (
  old: Position | null,
  next: Position | null,
  group = 0,
): Pair => ({
  old,
  new: next,
  group,
  before_marks: [],
  after_marks: [],
});
const card = (
  id: string,
  pairs: Pair[],
  section: string | null = id,
): Card => ({
  id,
  file: id + ".tex",
  comparison: "text",
  aligned: true,
  pairs,
  context_node: section,
});

it("joins transitive overlap on either version across sections and loose figures", () => {
  const cards = [
      card("a", [pair(at([0, 0, 10, 10]), at([0, 0, 10, 10]))]),
      card("b", [pair(at([0, 5, 10, 15]), at([0, 20, 10, 30]))]),
      card("figure", [pair(at([0, 40, 10, 50]), at([0, 25, 10, 35]))], null),
    ],
    plan = regions(cards);
  expect(plan).toHaveLength(1);
  expect(plan[0].members.map((i) => cards[i].id)).toEqual(["a", "b", "figure"]);
  expect(plan[0].pairs).toHaveLength(3);
  expect(plan[0].old.map((p) => p.clip)).toEqual([
    [0, 0, 10, 15],
    [0, 40, 10, 50],
  ]);
  expect(plan[0].new.map((p) => p.clip)).toEqual([
    [0, 0, 10, 10],
    [0, 20, 10, 35],
  ]);
  const reversed = regions([...cards].reverse());
  expect(reversed[0].old).toEqual(plan[0].old);
  expect(reversed[0].new).toEqual(plan[0].new);
});

it("keeps corresponding pages together without joining separate regions of an edit", () => {
  const plan = regions([
    card("a", [
      pair(at([0, 0, 10, 10]), at([0, 0, 10, 10])),
      pair(at([0, 0, 10, 10], 1), null),
      pair(at([0, 20, 10, 30]), at([0, 20, 10, 30]), 1),
    ]),
  ]);
  expect(plan).toHaveLength(2);
  expect(plan[0].old.map((p) => p.page)).toEqual([0, 1]);
  expect(plan[0].new).toHaveLength(1);
  expect(plan[1].pairs).toEqual([[0, 2]]);
});

it("keeps touching rectangles, separate pages, and source-only edits independent", () => {
  const plan = regions([
    card("a", [pair(null, at([0, 0, 10, 10]))]),
    card("b", [pair(null, at([10, 0, 20, 10]))]),
    card("c", [pair(null, at([0, 0, 10, 10], 1))]),
    card("comment", []),
  ]);
  expect(plan.map((r) => r.members)).toEqual([[0], [1], [2], [3]]);
});

it("unions columns and spanning crops without filling their bounding box", () => {
  const plan = regions([
    card("column", [pair(at([0, 0, 10, 30]), null)]),
    card("band", [pair(at([0, 10, 30, 20]), null)]),
  ]);
  expect(plan).toHaveLength(1);
  expect(plan[0].old.map((p) => p.clip)).toEqual([
    [0, 0, 10, 10],
    [0, 10, 30, 20],
    [0, 20, 10, 30],
  ]);
});

it("partitions nested context and changes with no duplicate or missing area", () => {
  const input: Tile<number>[] = [
    { page: 0, rect: [0, 0, 10, 10], value: 0 },
    { page: 0, rect: [0, 5, 10, 10], value: 1 },
    { page: 0, rect: [0, 4, 10, 6], value: -1 },
  ];
  expect(
    partition(input, (values) =>
      values.includes(-1) ? undefined : Math.max(...values),
    ),
  ).toEqual([
    { page: 0, rect: [0, 0, 10, 4], value: 0 },
    { page: 0, rect: [0, 6, 10, 10], value: 1 },
  ]);
});

it("preserves adjoining reading lanes unless a footprint spans their seam", () => {
  const input: Tile<number>[] = [
    { page: 0, rect: [0, 0, 10, 30], value: 0 },
    { page: 0, rect: [10, 0, 20, 30], value: 0 },
  ];
  expect(partition(input, () => 0)).toEqual(input);
  expect(
    partition(
      [...input, { page: 0, rect: [0, 10, 20, 20], value: 0 }],
      () => 0,
    ).map((r) => r.rect),
  ).toEqual([
    [0, 0, 10, 10],
    [10, 0, 20, 10],
    [0, 10, 20, 20],
    [0, 20, 10, 30],
    [10, 20, 20, 30],
  ]);
});

it("conserves coverage and ownership for arbitrary overlapping rectangles", () => {
  let seed = 341;
  const random = (n: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  for (let trial = 0; trial < 100; trial++) {
    const input: Tile<number>[] = Array.from({ length: 20 }, (_, value) => {
        const x = random(10),
          y = random(10);
        return {
          page: random(2),
          rect: [x, y, x + 1 + random(10 - x), y + 1 + random(10 - y)],
          value,
        };
      }),
      output = partition(input, (values) => Math.max(...values));
    expect(
      partition([...input].reverse(), (values) => Math.max(...values)),
    ).toEqual(output);
    const covers = (r: Tile<number>, page: number, x: number, y: number) =>
      r.page === page &&
      r.rect[0] <= x &&
      r.rect[2] > x &&
      r.rect[1] <= y &&
      r.rect[3] > y;
    for (let page = 0; page < 2; page++)
      for (let x = 0.5; x < 10; x++)
        for (let y = 0.5; y < 10; y++) {
          const before = input.filter((r) => covers(r, page, x, y)),
            after = output.filter((r) => covers(r, page, x, y));
          expect(after.map((r) => r.value)).toEqual(
            before.length ? [Math.max(...before.map((r) => r.value))] : [],
          );
        }
  }
});

it("joins crops only where the given rule finds one place", () => {
  // Adjacent lines' boxes overlap by a point; with a rule that asks for a
  // shared line, the two edits stay separate changes.
  const cards = [
      card("word", [pair(at([0, 100, 10, 113]), at([0, 100, 10, 113]))]),
      card("paragraph", [pair(at([0, 112, 10, 150]), at([0, 112, 10, 160]))]),
    ],
    apart = regions(cards, () => false),
    together = regions(cards);
  expect(apart.map((r) => r.members)).toEqual([[0], [1]]);
  expect(together.map((r) => r.members)).toEqual([[0, 1]]);
});
