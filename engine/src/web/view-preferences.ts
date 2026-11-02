// Whole paper or changed sections only. A host such as Papilot shows its own
// switch: it stores the choice and tells this frame; storage events also
// update other tabs.
export const VIEW_STORAGE = "latex-review:view";
export const VIEW_EVENT = "latex-review:view-changed";
export type ReviewView = "paper" | "changes";
export function readView(): ReviewView {
  try {
    return localStorage.getItem(VIEW_STORAGE) === "changes" ? "changes" : "paper";
  } catch {
    return "paper";
  }
}
