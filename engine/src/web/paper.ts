import type { ChangeBlock } from "../types.ts";

// A change block in the numbering of the changes view, for the full paper.
export interface PlacedChange {
  block: ChangeBlock;
  index: number;
}

// The full paper can show the changes when at least one strip knows where
// it starts on its page; a change whose strips do not follows the change
// before it.
export const placeable = (changes: PlacedChange[]) =>
  changes.some((c) => c.block.after.some((s) => s.top !== undefined));
