import { it, expect } from "vitest";
import {
  nextPending,
  pendingUnits,
  progress,
  resolvedSide,
  stopState,
  visibleStop,
  wordDiff,
  buildStops,
  changeKinds,
  commentScope,
} from "../../src/web/model.ts";
import type { RenderedRound, Decision, ChangeBlock, Unit } from "../../src/types.ts";
const change = (units: string[]): ChangeBlock => ({
  kind: "change",
  units,
  before: [],
  after: [],
  identical: false,
});
const detail: RenderedRound = {
  units: {},
  sections: [
    {
      node: "one",
      number: "1",
      title: "One",
      blocks: [change(["c002"]), { kind: "gap" }, change(["c001", "c003"])],
    },
    { node: "two", number: "2", title: "Two", blocks: [change(["c003"])] },
  ],
  loose: [change(["c004"])],
};
it("navigates in document order with unique stops and wraps pending edits", () => {
  const stops = buildStops(detail),
    decisions: Record<string, Decision> = {
      c001: "pending",
      c002: "accepted",
      c003: "commented",
      c004: "pending",
    };
  expect(stops.map((s) => s.units)).toEqual([
    ["c002"],
    ["c001", "c003"],
    ["c003"],
    ["c004"],
  ]);
  expect(new Set(stops.map((s) => s.key)).size).toBe(4);
  expect(nextPending(stops, decisions)).toBe(1);
  expect(nextPending(stops, decisions, 1)).toBe(3);
  expect(nextPending(stops, decisions, 3)).toBe(1);
  expect(pendingUnits(stops[1], decisions)).toEqual(["c001"]);
});
it("resolved blocks show chosen versions and counts remain source-unit based", () => {
  const decisions: Record<string, Decision> = {
    a: "accepted",
    b: "rejected",
    c: "commented",
    d: "pending",
  };
  expect(resolvedSide(["a"], decisions)).toBe("after");
  expect(resolvedSide(["b"], decisions)).toBe("before");
  expect(resolvedSide(["a", "b"], decisions)).toBeUndefined();
  expect(stopState(["a", "b"], decisions)).toBe("mixed");
  expect(stopState(["a", "d"], decisions)).toBe("pending");
  expect(progress(decisions)).toEqual({
    accepted: 1,
    rejected: 1,
    commented: 1,
    pending: 1,
    total: 4,
    decided: 3,
  });
});
it("pending navigation wraps within the focused units and skips unrelated pending edits", () => {
  const stops = buildStops(detail), decisions: Record<string, Decision> = {
    c001: "pending", c002: "pending", c003: "accepted", c004: "pending",
  };
  expect(nextPending(stops, decisions, -1, ["c001", "c004"])).toBe(1);
  expect(nextPending(stops, decisions, 1, ["c001", "c004"])).toBe(3);
  expect(nextPending(stops, decisions, 3, ["c001", "c004"])).toBe(1);
  expect(nextPending(stops, decisions, 0, ["c003"])).toBe(-1);
  expect(nextPending(stops, decisions, 0, [])).toBe(-1);
});
it("scoped comments quote only the selected source units, including deletions", () => {
  const unit = { id: "c001", file: "main.tex", status: "modified", old_start: 9, old_end: 9, new_start: 10, new_end: 10, old_text: "fast", new_text: "efficient" } as Unit;
  expect(commentScope([unit])).toEqual({ where: "After · main.tex:10", quote: "efficient" });
  expect(commentScope([{ ...unit, new_text: "" }])).toEqual({ where: "Before · main.tex:9", quote: "fast" });
});
it("keeps selected stop during scrolling when it remains visible", () => {
  const regions = [
    { index: 0, top: 85, bottom: 276 },
    { index: 1, top: 427, bottom: 618 },
  ];
  expect(visibleStop(regions, 1, 70, 645)).toBe(1);
  expect(visibleStop(regions, 1, 70, 400)).toBe(0);
  expect(visibleStop(regions, 0, 300, 645)).toBe(1);
});
it("source diff scales to long changes without marking shared context", () => {
  const text = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(" ");
  expect(
    wordDiff(text, text.replace("w1000", "changed"))
      .filter((p) => p.type !== "equal")
      .map((p) => p.text),
  ).toEqual(["w1000", "changed"]);
});
it("labels a change invisible only when none of its edits shows", () => {
  expect(changeKinds([{ visual: "text" }, { visual: "identical" }])).toEqual([]);
  expect(changeKinds([{ visual: "layout" }, { visual: "unmapped" }])).toEqual(["layout"]);
  expect(changeKinds([{ visual: "identical" }])).toEqual(["identical"]);
  expect(changeKinds([{ visual: "identical" }, {}])).toEqual(["identical", "unmapped"]);
  // Moved text is marked on the page, so the change is visible.
  expect(changeKinds([{ visual: "position" }, { visual: "identical" }])).toEqual([]);
  // An unmapped edit whose effects show elsewhere is not "Source only".
  expect(changeKinds([{ visual: "unmapped", effects: { total: 1, shown: [] } }])).toEqual([]);
});
