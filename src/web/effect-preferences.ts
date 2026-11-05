import { useSyncExternalStore } from 'react';
import { browserStorage } from './storage.ts';
import { EFFECTS_STORAGE } from '../../engine/src/web/effect-preferences.ts';

export { EFFECTS_EVENT } from '../../engine/src/web/effect-preferences.ts';
// Whether rounds find and show what each edit changes elsewhere, such as the
// uses of a macro. The server keeps it, since it publishes rounds when an
// agent finishes; the review shows them expanded when they are tracked. The
// value last seen here serves until the server answers.
type Api = <T>(route: string, body?: unknown) => Promise<T>;
let request: Api | null = null, tracked = browserStorage.getItem(EFFECTS_STORAGE) === 'on';
const listeners = new Set<() => void>();
function apply(value: boolean) {
  tracked = value; browserStorage.setItem(EFFECTS_STORAGE, value ? 'on' : 'off');
  listeners.forEach(listener => listener());
}
export function connectIndirectChanges(api: Api) {
  request = api;
  void api<{ indirectChanges: boolean }>('/indirect-changes').then(value => apply(value.indirectChanges), () => {});
}
// The switch moves at once; a save that fails puts it back.
export async function saveIndirectChanges(value: boolean) {
  const before = tracked;
  apply(value);
  if (!request) return;
  try { apply((await request<{ indirectChanges: boolean }>('/indirect-changes', { indirectChanges: value })).indirectChanges); }
  catch { apply(before); }
}
export function useIndirectChanges() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => tracked);
}
