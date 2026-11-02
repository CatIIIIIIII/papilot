import type { ChangeBlock } from "../types.ts";

// A change block in the numbering of the changes view, for the full paper.
export interface PlacedChange {
  block: ChangeBlock;
  index: number;
}

// The full paper can show the changes when their strips know where they
// start on the page (rounds rendered before that was recorded cannot).
export const placeable = (changes: PlacedChange[]) =>
  changes.some((c) => c.block.after.length) &&
  changes.every((c) => c.block.after.every((s) => s.top !== undefined));
