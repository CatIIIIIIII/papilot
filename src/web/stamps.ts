import { useMemo, useSyncExternalStore } from 'react';
import { PRESET_QUICK_NOTES, QUICK_NOTE_LIMIT, type QuickNote } from '../shared.ts';
import { browserStorage } from './storage.ts';
import { t, useLanguage } from './i18n.ts';

// Quick notes for the magic pen: a short name for the wheel and the mark, and
// the instruction the agent receives. Each is complete with only a location,
// so marking needs no typing. Papilot starts with five; settings can change
// them or add more, up to the eight a direction picks reliably. They sit
// clockwise from the top, and number keys 1–8 pick the same slots in order.
export interface Stamp { id: string; label: string; instruction: string; icon: string }
export { QUICK_NOTE_LIMIT };
export const slotKey = (index: number) => String((index + 1) % 10);
export function presetStamps(): Stamp[] {
  const presets: Stamp[] = [
    { id: 'polish', icon: 'sparkles', label: t('Polish'), instruction: t('Polish only this sentence: fix grammar, wording and tone without changing its meaning or length.') },
    { id: 'tighten', icon: 'compress', label: t('Shorten'), instruction: t('Say this more concisely: cut repetition and filler, and keep the meaning.') },
    { id: 'runt', icon: 'runt', label: t('Runt'), instruction: t('The last line of this paragraph holds only a word or two. Reword slightly to pull it back.') },
    { id: 'connect', icon: 'link', label: t('Connect'), instruction: t('This does not follow from the previous sentence. Add a transition, or refer back to what came before.') },
    { id: 'verify', icon: 'verify', label: t('Verify'), instruction: t('Check this against the cited work or the original source. Change it only if it is wrong, and say what you checked.') },
  ];
  return PRESET_QUICK_NOTES.map(id => presets.find(preset => preset.id === id)!);
}
// Icons a quick note can take, drawn like the rest of the app's icons.
export const stampIcons = () => [
  { id: 'sparkles', label: t('Sparkles') }, { id: 'compress', label: t('Shorten') }, { id: 'runt', label: t('Runt') }, { id: 'link', label: t('Link') },
  { id: 'verify', label: t('Verify') }, { id: 'pen', label: t('Pen') }, { id: 'spellcheck', label: t('Spelling') }, { id: 'lineBreak', label: t('Line break') },
  { id: 'expand', label: t('Expand') }, { id: 'sigma', label: t('Math') }, { id: 'book', label: t('Book') }, { id: 'lightbulb', label: t('Idea') },
  { id: 'notes', label: t('Comments') }, { id: 'question', label: t('Question') }, { id: 'flag', label: t('Flag') }, { id: 'chart', label: t('Chart') },
  { id: 'globe', label: t('Globe') }, { id: 'code', label: t('Code') }, { id: 'checklist', label: t('Checklist') }, { id: 'tool', label: t('Tools') },
];

// A saved list in full: a preset that kept its id but not its text reads in
// the interface language, as the presets do.
export function resolveStamps(saved: QuickNote[] | null): Stamp[] {
  const presets = presetStamps();
  if (!saved) return presets;
  return saved.map(note => {
    const preset = presets.find(item => item.id === note.id);
    return { id: note.id, label: note.label ?? preset?.label ?? '', instruction: note.instruction ?? preset?.instruction ?? '', icon: note.icon ?? preset?.icon ?? 'notes' };
  }).filter(stamp => stamp.label && stamp.instruction);
}
export const samePresets = (stamps: Stamp[]) => JSON.stringify(stamps) === JSON.stringify(presetStamps());
function stored(stamps: Stamp[]): QuickNote[] | null {
  if (samePresets(stamps)) return null;
  const presets = presetStamps();
  return stamps.map(stamp => {
    const preset = presets.find(item => item.id === stamp.id);
    return { id: stamp.id, ...stamp.label !== preset?.label ? { label: stamp.label } : {}, ...stamp.instruction !== preset?.instruction ? { instruction: stamp.instruction } : {}, ...stamp.icon !== preset?.icon ? { icon: stamp.icon } : {} };
  });
}

// Each person's list lives on the server, so the phone and the computer offer
// the same notes. This browser keeps the last copy to show the wheel at once.
// The list loads the first time the magic pen or its settings are used, and
// again whenever the window regains focus after that.
type Api = <T>(route: string, body?: unknown) => Promise<T>;
const CACHE = 'papilot:quick-notes';
// Each save or sign-out starts a new version; a load begun before it is stale.
let request: Api | null = null, loaded = false, loading: Promise<void> | null = null, version = 0;
let saved = cached();
const listeners = new Set<() => void>();
function cached(): QuickNote[] | null {
  try { const value = JSON.parse(browserStorage.getItem(CACHE) || 'null'); return Array.isArray(value) ? value : null; } catch { return null; }
}
function apply(value: QuickNote[] | null) {
  loaded = true; saved = value;
  if (value) browserStorage.setItem(CACHE, JSON.stringify(value)); else browserStorage.removeItem(CACHE);
  listeners.forEach(listener => listener());
}
export function connectStamps(api: Api) { request = api; }
export function loadStamps() {
  if (!request || loading) return;
  const asked = version;
  loading = request<{ quickNotes: QuickNote[] | null }>('/quick-notes').then(value => { if (asked === version) apply(value.quickNotes); }, () => {}).finally(() => { loading = null; });
}
if (typeof window !== 'undefined') window.addEventListener('focus', () => { if (loaded) loadStamps(); });
export async function saveStamps(stamps: Stamp[]) {
  if (!request) throw new Error(t('Request failed. Please try again.'));
  version++;
  try { apply((await request<{ quickNotes: QuickNote[] | null }>('/quick-notes', { quickNotes: stored(stamps) })).quickNotes); }
  finally { version++; }
}
// Signing out forgets this person's list here too, not only in storage.
export function forgetStamps() {
  version++; loaded = false; saved = null;
  listeners.forEach(listener => listener());
}
export function useStamps() {
  const value = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => saved);
  const { language } = useLanguage();
  return useMemo(() => resolveStamps(value), [value, language]);
}
