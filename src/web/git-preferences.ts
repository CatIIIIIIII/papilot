import { useSyncExternalStore } from 'react';
import { browserStorage } from './storage.ts';
import { isPlayground } from './playground-mode.ts';

const KEY = 'papilot:advanced-git';
const readAdvanced = () => (browserStorage.getItem(KEY) ?? (isPlayground ? 'on' : 'off')) === 'on';
let advanced = readAdvanced();
const listeners = new Set<() => void>();
function apply(value: boolean) { advanced = value; listeners.forEach(listener => listener()); }
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === KEY || event.key === null) apply(readAdvanced());
});
export function saveAdvancedGit(value: boolean) {
  browserStorage.setItem(KEY, value ? 'on' : 'off'); apply(value);
}
export function useAdvancedGit() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => advanced);
}
