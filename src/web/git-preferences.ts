import { useSyncExternalStore } from 'react';
import { browserStorage } from './storage.ts';

const KEY = 'papilot:advanced-git';
let advanced = browserStorage.getItem(KEY) === 'on';
const listeners = new Set<() => void>();
function apply(value: boolean) { advanced = value; listeners.forEach(listener => listener()); }
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === KEY || event.key === null) apply(browserStorage.getItem(KEY) === 'on');
});
export function saveAdvancedGit(value: boolean) {
  browserStorage.setItem(KEY, value ? 'on' : 'off'); apply(value);
}
export function useAdvancedGit() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => advanced);
}
