// Events between the review viewer and the workspace that embeds it.

/** The viewer's current change, sent on `window` whenever it changes:
 *  `from` says whether the author picked it, the viewer scrolled to it, or
 *  the workspace asked for it with SELECT_SOURCE_EVENT. Each unit's `lines`
 *  are 0-based line ranges (end excluded) in the new version of its file; a
 *  deletion is an empty range at the line after it. */
export const CURRENT_CHANGE_EVENT = "latex-review:current";
export interface CurrentChange {
  stop: number;
  from: "pick" | "scroll" | "source";
  units: { id: string; file: string; lines: [number, number][] }[];
}

/** Asks the viewer for the change at a line (0-based) of a file, sent on the
 *  viewer's `window` by the workspace. */
export const SELECT_SOURCE_EVENT = "latex-review:select-source";
export interface SelectSource { file: string; line: number }
