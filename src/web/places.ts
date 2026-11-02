import { useEffect, type RefObject } from 'react';
import { browserStorage } from './storage.ts';

// Where the author was in each view: the manuscript's PDF page, a task's chat,
// the reference check. Leaving a view unmounts it, so coming back to it reads
// the place from here instead of opening at the top. Places are kept with the
// open task and paper, so a reload or Safari discarding the tab returns there too.
const STORAGE = 'papilot:places', LIMIT = 200;
let places: Map<string, unknown> | null = null, timer: ReturnType<typeof setTimeout> | undefined;
function all() {
  if (!places) {
    try { places = new Map(Object.entries(JSON.parse(browserStorage.getItem(STORAGE) || '{}'))); }
    catch { places = new Map(); }
  }
  return places;
}
function persist() {
  clearTimeout(timer); timer = undefined;
  if (places) browserStorage.setItem(STORAGE, JSON.stringify(Object.fromEntries(places)));
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', persist);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persist(); });
}
export function readPlace<T>(key: string): T | undefined {
  return all().get(key) as T | undefined;
}
// Scrolling saves often; the store is written once things settle. The most
// recently used places are kept, the oldest forgotten.
export function savePlace(key: string, value: unknown) {
  const map = all();
  map.delete(key);
  if (value !== undefined) map.set(key, value);
  for (const old of map.keys()) { if (map.size <= LIMIT) break; map.delete(old); }
  clearTimeout(timer); timer = setTimeout(persist, 400);
}

// A plain scrolling panel returns to where it was once its content is tall
// enough again; scrolling it first, or waiting too long, keeps it where it is.
export function useScrollPlace(ref: RefObject<HTMLElement | null>, key: string | null, ready = true) {
  useEffect(() => {
    const box = ref.current;
    if (!box || !key || !ready) return;
    const saved = readPlace<number>(key);
    let restoring = typeof saved === 'number' && saved > 0, frame = 0;
    const restore = () => {
      if (!restoring) return;
      box.scrollTop = saved!;
      if (Math.abs(box.scrollTop - saved!) < 2) restoring = false;
    };
    const content = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(restore); });
    const stop = setTimeout(() => { restoring = false; content.disconnect(); }, 3000);
    if (restoring) { restore(); content.observe(box); for (const child of box.children) content.observe(child); }
    const scroll = () => { if (!restoring) savePlace(key, Math.round(box.scrollTop)); };
    const take = () => { restoring = false; };
    box.addEventListener('scroll', scroll, { passive: true });
    const gestures = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
    for (const gesture of gestures) box.addEventListener(gesture, take, { passive: true });
    return () => {
      clearTimeout(stop); cancelAnimationFrame(frame); content.disconnect();
      box.removeEventListener('scroll', scroll);
      for (const gesture of gestures) box.removeEventListener(gesture, take);
    };
  }, [ref, key, ready]);
}
