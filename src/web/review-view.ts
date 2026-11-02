import { useSyncExternalStore } from 'react';
import { browserStorage } from './storage.ts';
import { VIEW_STORAGE, type ReviewView } from '../../engine/src/web/view-preferences.ts';

// The view reviews open on, chosen in Settings: the changed sections unless the
// author prefers the whole paper. The review toolbar's switch changes only the
// open review, so looking at the whole paper once does not slow later reviews.
export { VIEW_EVENT, type ReviewView } from '../../engine/src/web/view-preferences.ts';
const read = (): ReviewView => browserStorage.getItem(VIEW_STORAGE) === 'paper' ? 'paper' : 'changes';
let view = read();
const listeners = new Set<() => void>();
function apply(value: ReviewView) { view = value; listeners.forEach(listener => listener()); }
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === VIEW_STORAGE || event.key === null) apply(read());
});
export function saveDefaultReviewView(value: ReviewView) {
  browserStorage.setItem(VIEW_STORAGE, value); apply(value);
}
export function useDefaultReviewView() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => view);
}
