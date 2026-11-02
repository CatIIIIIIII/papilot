import { useSyncExternalStore } from 'react';
import { browserStorage } from './storage.ts';
import { EFFECTS_STORAGE } from '../../engine/src/web/effect-preferences.ts';

export { EFFECTS_EVENT } from '../../engine/src/web/effect-preferences.ts';
let expanded = browserStorage.getItem(EFFECTS_STORAGE) === 'on';
const listeners = new Set<() => void>();
function apply(value: boolean) { expanded = value; listeners.forEach(listener => listener()); }
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === EFFECTS_STORAGE || event.key === null) apply(browserStorage.getItem(EFFECTS_STORAGE) === 'on');
});
export function saveExpandedEffects(value: boolean) {
  browserStorage.setItem(EFFECTS_STORAGE, value ? 'on' : 'off'); apply(value);
}
export function useExpandedEffects() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => expanded);
}
