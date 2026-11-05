import { useSyncExternalStore } from 'react';
import { browserStorage } from './storage.ts';
import { forgetAttachmentDrafts } from './attachment-draft.ts';
import { forgetStamps } from './stamps.ts';
import { forgetIndirectChanges } from './effect-preferences.ts';

// Whether the public URL asked this browser to sign in. Any request answered
// 401 sets it, which replaces the workspace with the sign-in page.
let signedOut = false;
const listeners = new Set<() => void>();
export function setSignedOut(value: boolean) {
  if (signedOut === value) return;
  signedOut = value;
  for (const listener of listeners) listener();
}
export const isSignedOut = () => signedOut;
export function useSignedOut() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => signedOut);
}
// Signing out leaves nothing of this person's work in the browser: drafts,
// layout and remembered choices (papilot:) and the review page's comment
// drafts (latex-review:). Appearance and language stay with the browser.
export function forgetBrowserState() {
  forgetAttachmentDrafts(); forgetStamps(); forgetIndirectChanges();
  try {
    for (const key of Object.keys(localStorage)) if ((key.startsWith('papilot:') || key.startsWith('latex-review:')) && key !== 'papilot:theme' && key !== 'papilot:appearance' && key !== 'papilot:language') browserStorage.removeItem(key);
  } catch { /* Storage may be unavailable; nothing was kept there then. */ }
}
