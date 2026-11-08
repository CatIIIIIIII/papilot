import { useSyncExternalStore } from 'react';
import { browserStorage } from './storage.ts';
import { EFFECTS_STORAGE } from '../../engine/src/web/effect-preferences.ts';

export { EFFECTS_EVENT } from '../../engine/src/web/effect-preferences.ts';
// Whether rounds find and show what each edit changes elsewhere, such as the
// uses of a macro. The server keeps it, since it publishes rounds when an
// agent finishes; the review shows them expanded when they are tracked. Like
// quick notes, it loads when the app starts, when Settings or a review opens
// and when the window regains focus; the value last seen here serves
// meanwhile, and other tabs follow a change through storage.
type Api = <T>(route: string, body?: unknown) => Promise<T>;
// Each save or sign-out starts a new version; a load begun before it is stale.
let request: Api | null = null, version = 0, tracked = browserStorage.getItem(EFFECTS_STORAGE) === 'on';
const listeners = new Set<() => void>();
function apply(value: boolean, keep = true) {
  if (keep) browserStorage.setItem(EFFECTS_STORAGE, value ? 'on' : 'off');
  if (tracked === value) return;
  tracked = value;
  listeners.forEach(listener => listener());
}
export function loadIndirectChanges() {
  if (!request) return;
  const asked = version;
  void request<{ indirectChanges: boolean }>('/indirect-changes').then(value => { if (asked === version) apply(value.indirectChanges); }, () => {});
}
export function connectIndirectChanges(api: Api) { request = api; loadIndirectChanges(); }
if (typeof window !== 'undefined') {
  window.addEventListener('focus', loadIndirectChanges);
  window.addEventListener('storage', event => {
    if (event.key === EFFECTS_STORAGE || event.key === null) apply(browserStorage.getItem(EFFECTS_STORAGE) === 'on', false);
  });
}
// The switch moves at once. A save that fails, or whose answer is lost,
// goes back and then takes the server's value.
export async function saveIndirectChanges(value: boolean) {
  const before = tracked;
  version++;
  apply(value);
  if (!request) return;
  let failed = false;
  try { apply((await request<{ indirectChanges: boolean }>('/indirect-changes', { indirectChanges: value })).indirectChanges); }
  catch { failed = true; apply(before); }
  finally { version++; if (failed) loadIndirectChanges(); }
}
export function useIndirectChanges() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => tracked);
}
