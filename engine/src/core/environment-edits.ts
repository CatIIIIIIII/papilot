import type { Op } from "../types.ts";
import { structuralSource } from "./tex-source.ts";

/** Changing an environment's delimiters couples only the edits inside that
 * environment. Unrelated prose elsewhere in the file remains independent. */
export function groupEnvironmentEdits(
  before: string,
  after: string,
  edits: Op[],
): Op[] {
  const ranges: [number, number][] = [];
  const scan = (text: string, side: 1 | 3) => {
    const stack: { name: string; start: number; end: number }[] = [];
    const endSide = side === 1 ? 2 : 4;
    const touches = (op: Op, start: number, end: number) =>
      op[side] === op[endSide]
        ? start < op[side] && op[side] < end
        : op[side] < end && start < op[endSide];
    for (const match of structuralSource(text).matchAll(
      /\\(begin|end)\s*\{([^}]+)\}/g,
    )) {
      const token = {
        name: match[2],
        start: match.index,
        end: match.index + match[0].length,
      };
      if (match[1] === "begin") {
        stack.push(token);
        continue;
      }
      const opening = stack.at(-1);
      if (!opening || opening.name !== token.name) continue;
      stack.pop();
      if (
        !edits.some(
          (op) =>
            touches(op, opening.start, opening.end) ||
            touches(op, token.start, token.end),
        )
      )
        continue;
      const members = edits.flatMap((op, index) =>
        touches(op, opening.start, token.end) ? [index] : [],
      );
      if (members.length > 1) ranges.push([members[0], members.at(-1)!]);
    }
  };
  scan(before, 1);
  scan(after, 3);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1])
      previous[1] = Math.max(previous[1], range[1]);
    else merged.push([...range]);
  }
  const result: Op[] = [];
  for (let index = 0, group = 0; index < edits.length; index++) {
    const range = merged[group],
      first = edits[index];
    if (!range || range[0] !== index) {
      result.push(first);
      continue;
    }
    const last = edits[range[1]];
    result.push([
      first[1] === last[2]
        ? "insert"
        : first[3] === last[4]
          ? "delete"
          : "replace",
      first[1],
      last[2],
      first[3],
      last[4],
    ]);
    index = range[1];
    group++;
  }
  return result;
}
