// Shared with the host settings; storage events also update standalone tabs.
export const EFFECTS_STORAGE = "latex-review:effects";
export const EFFECTS_EVENT = "latex-review:effects-changed";
export function readExpandedEffects() {
  try {
    return localStorage.getItem(EFFECTS_STORAGE) === "on";
  } catch {
    return false;
  }
}
