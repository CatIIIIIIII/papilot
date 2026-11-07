import { isPlayground } from './playground-mode.ts';
const storageKey = (key: string) => isPlayground ? 'playground:' + key : key;
// A blocked or full browser store must not prevent the workspace from opening.
// Keep this tab usable even when durable drafts/preferences are unavailable.
const fallback = new Map<string, string>();
export const browserStorage = {
  getItem(key: string): string | null {
    if (fallback.has(key)) return fallback.get(key)!;
    try { return localStorage.getItem(storageKey(key)); } catch { return null; }
  },
  setItem(key: string, value: string) {
    fallback.set(key, value);
    try { localStorage.setItem(storageKey(key), value); fallback.delete(key); } catch { /* Tab-local fallback. */ }
  },
  removeItem(key: string) {
    fallback.set(key, '');
    try { localStorage.removeItem(storageKey(key)); fallback.delete(key); } catch { /* Mask a stale durable value. */ }
  },
};
