import { useSyncExternalStore } from 'react';
import { browserStorage } from './storage.ts';
import { SHORTCUT_STORAGE, parseShortcuts, type Shortcuts } from '../../engine/src/web/shortcuts.ts';

export * from '../../engine/src/web/shortcuts.ts';
const BINDINGS_STORAGE = 'latex-review:shortcut-bindings';
let bindings = parseShortcuts(browserStorage.getItem(BINDINGS_STORAGE));
let state = parseShortcuts(browserStorage.getItem(SHORTCUT_STORAGE));
const listeners = new Set<() => void>();
function apply(value: Shortcuts) { state = value; listeners.forEach(listener => listener()); }
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === BINDINGS_STORAGE || event.key === null) { bindings = parseShortcuts(browserStorage.getItem(BINDINGS_STORAGE)); listeners.forEach(listener => listener()); }
  if (event.key === SHORTCUT_STORAGE || event.key === null) apply(parseShortcuts(browserStorage.getItem(SHORTCUT_STORAGE)));
});
export function saveShortcuts(value: Shortcuts) {
  browserStorage.setItem(SHORTCUT_STORAGE, JSON.stringify(value)); apply(value);
}
export function useShortcuts() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state);
}

// Disabled shortcuts keep their assigned keys without reaching the review engine.
export function saveShortcutBindings(value: Shortcuts) {
  browserStorage.setItem(BINDINGS_STORAGE, JSON.stringify(value)); bindings = value; listeners.forEach(listener => listener());
}
export function useShortcutBindings() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => bindings);
}
