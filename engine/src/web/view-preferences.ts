// Whole paper ("paper") or changed sections only ("changes"). Reviews open on
// the stored default: the changed sections, which show fastest, unless the
// whole paper was chosen in Papilot's settings. Switching views lasts for the
// open review only. A host such as Papilot shows its own switch and tells this
// frame; storage events bring a new default to reviews already open.
export const VIEW_STORAGE = "latex-review:default-view";
export const VIEW_EVENT = "latex-review:view-changed";
export type ReviewView = "paper" | "changes";
export function readView(): ReviewView {
  try {
    return localStorage.getItem(VIEW_STORAGE) === "paper" ? "paper" : "changes";
  } catch {
    return "changes";
  }
}
