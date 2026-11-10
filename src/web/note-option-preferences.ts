import { useSyncExternalStore } from 'react';
import { noteAlternativeRange, type NoteAlternativeRange } from '../shared.ts';
import { browserStorage } from './storage.ts';

const key = 'papilot:note-alternatives', rangeKey = 'papilot:note-alternative-range';
type Api = <T>(route: string, body?: unknown) => Promise<T>;
type Preference = { enabled: boolean; range: NoteAlternativeRange };
type Response = { noteAlternatives: boolean; noteAlternativeRange?: unknown };
let request: Api | null = null, version = 0, pending = 0;
// Alternatives are prepared only once the author turns them on.
let snapshot: Preference = { enabled: browserStorage.getItem(key) === 'on', range: noteAlternativeRange(browserStorage.getItem(rangeKey)) };
let writes: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();
function apply(value: Preference, keep = true) {
  if (keep) { browserStorage.setItem(key, value.enabled ? 'on' : 'off'); browserStorage.setItem(rangeKey, value.range); }
  if (snapshot.enabled === value.enabled && snapshot.range === value.range) return;
  snapshot = value;
  listeners.forEach(listener => listener());
}
export function loadNoteAlternatives() {
  if (!request || pending) return;
  const asked = version;
  void request<Response>('/note-alternatives').then(value => {
    if (asked === version && !pending && typeof value.noteAlternatives === 'boolean') apply({ enabled: value.noteAlternatives, range: noteAlternativeRange(value.noteAlternativeRange ?? snapshot.range) });
  }, () => {});
}
export function connectNoteAlternatives(api: Api) { request = api; loadNoteAlternatives(); }
if (typeof window !== 'undefined') {
  window.addEventListener('focus', loadNoteAlternatives);
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === rangeKey || event.key === null) {
      version++;
      apply({ enabled: browserStorage.getItem(key) === 'on', range: noteAlternativeRange(browserStorage.getItem(rangeKey)) }, false);
    }
  });
}
export async function saveNoteAlternatives(enabled: boolean, range = snapshot.range) {
  const before = snapshot, asked = ++version;
  apply({ enabled, range });
  if (!request) return;
  pending++;
  const api = request;
  // A fast drag can cross several stops. Preserve write order on the server,
  // while the thumb follows the latest choice immediately.
  const write = writes.catch(() => {}).then(() => api<Response>('/note-alternatives', { noteAlternatives: enabled, noteAlternativeRange: range }));
  writes = write;
  try {
    const result = await write;
    if (typeof result.noteAlternatives !== 'boolean') throw new Error('Invalid preference response.');
    if (version === asked) apply({ enabled: result.noteAlternatives, range: noteAlternativeRange(result.noteAlternativeRange ?? range) });
  } catch {
    if (version === asked) { apply(before); version++; }
  } finally {
    pending--;
    if (!pending) loadNoteAlternatives();
  }
}
export function useNoteAlternatives() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot);
}
