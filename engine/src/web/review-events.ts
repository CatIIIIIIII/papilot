// Events between the review viewer and the workspace that embeds it.
import type { PageState } from "../types.ts";

/** The viewer's current change, sent on `window` whenever it changes:
 *  `from` says whether the author picked it, the viewer scrolled to it, or
 *  the workspace asked for it with SELECT_SOURCE_EVENT. Each unit's `lines`
 *  are 0-based line ranges (end excluded) in the new version of its file; a
 *  deletion is an empty range at the line after it. */
export const CURRENT_CHANGE_EVENT = "papilot:review:current";
export interface CurrentChange {
  stop: number;
  from: "pick" | "scroll" | "source";
  units: { id: string; file: string; lines: [number, number][] }[];
}

/** Asks the viewer for the change at a line (0-based) of a file, sent on the
 *  viewer's `window` by the workspace. */
export const SELECT_SOURCE_EVENT = "papilot:review:select-source";
export interface SelectSource { file: string; line: number }

/** The author asks to edit a change's source, sent on the viewer's `window`
 *  and cancelable: a workspace with its own editor cancels it and opens the
 *  file there, at `lines` (0-based, end excluded) with `marks` standing out;
 *  otherwise the change's lines open for editing in the viewer. */
export const OPEN_SOURCE_EVENT = "latex-review:open-source";
export interface OpenSource { round: number; change: string; file: string; lines: [number, number]; marks: [number, number][] }

/** The text changes the viewer reviews, sent on its `window` whenever they
 *  or their decisions change: each change's file, its `text_ops` (offsets in
 *  the round's before and after versions of the file), its decision as shown
 *  and as the engine confirmed it, which has written its files by then. The
 *  cards group them in `stops`, each with its title and the actions its
 *  header offers (with the reason one is locked), and the words that name
 *  the two versions. */
export const REVIEW_CHANGES_EVENT = "latex-review:changes";
export interface ReviewChanges {
  round: number;
  changes: { id: string; file: string; ops: [string, number, number, number, number][]; decision: string; confirmed: string }[];
  stops: { title: string; units: string[]; actions: { kind: string; label: string; lock: string | null }[] }[];
  labels: { before: string; after: string };
}

/** Asks the viewer to act on changes as a card's header does: accept,
 *  reject, or comment, which opens the card's composer. Sent on its `window`
 *  by the workspace. */
export const DECIDE_EVENT = "latex-review:decide";
export interface DecideChange { round: number; changes: string[]; action: string }

/** The workspace saved a file of the task, sent on the viewer's `window`:
 *  `state` is the review after the save, and the viewer stays at `line`
 *  (0-based) of `file`, as after an edit made in the viewer. */
export const SOURCE_SAVED_EVENT = "latex-review:source-saved";
export interface SourceSaved { state: PageState; file: string; line: number }
