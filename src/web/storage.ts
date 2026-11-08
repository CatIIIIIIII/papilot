import { isPlayground } from './playground-mode.ts';
const storageKey = (key: string) => isPlayground ? 'playground:' + key : key;
// A blocked or full browser store must not prevent the workspace from opening.
// Keep this tab usable even when durable drafts/preferences are unavailable.
const fallback = new Map<string, string>();
export const browserStorage = {
  keys(): string[] {
    const keys = new Set(fallback.keys());
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!;
        if (isPlayground ? key.startsWith('playground:') : !key.startsWith('playground:')) keys.add(isPlayground ? key.slice(11) : key);
      }
    } catch { /* Only tab-local drafts are available. */ }
    return [...keys];
  },
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
