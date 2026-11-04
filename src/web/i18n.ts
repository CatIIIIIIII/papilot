import { useSyncExternalStore } from 'react';
import { browserStorage } from './storage.ts';
import { LANGUAGES, supportedLanguage, singularCount, interpolateMessage, type Language } from '../../engine/src/locales.ts';
import { messages, errorMessages } from './locales/index.ts';
export { LANGUAGES, type Language };

// The interface uses English source messages and generated locale catalogs. The English text is
// the message key, so a string without a translation still reads correctly.
// Text the agent receives (prompts, note locations) stays in English.
export type LanguageChoice = Language | 'system';
const key = 'papilot:language';

// The first browser language Papilot speaks wins; outside a browser (tests) it is English.
export function browserLanguage(languages: readonly string[] = typeof window === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language]): Language {
  for (const tag of languages) {
    const supported = supportedLanguage(tag);
    if (supported) return supported;
  }
  return 'en';
}
function savedChoice(): LanguageChoice {
  const value = browserStorage.getItem(key);
  return supportedLanguage(value) || 'system';
}

let state = { choice: savedChoice(), language: 'en' as Language };
state.language = state.choice === 'system' ? browserLanguage() : state.choice;
const listeners = new Set<() => void>();
function apply(choice: LanguageChoice) {
  const language = choice === 'system' ? browserLanguage() : choice;
  if (choice !== state.choice || language !== state.language) { state = { choice, language }; listeners.forEach(listener => listener()); }
  if (typeof document !== 'undefined') document.documentElement.lang = language;
}
apply(state.choice);
if (typeof window !== 'undefined') {
  window.addEventListener('languagechange', () => apply(state.choice));
  window.addEventListener('storage', event => { if (event.key === key || event.key === null) apply(savedChoice()); });
}

export function setLanguage(choice: LanguageChoice) {
  if (choice === 'system') browserStorage.removeItem(key); else browserStorage.setItem(key, choice);
  apply(choice);
}
export const language = () => state.language;
// Dates and numbers follow the interface language.
export const locale = () => state.language;
export function useLanguage() {
  // The same snapshot on the server lets components that subscribe render in tests.
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state, () => state);
}

// t('Delete {name}?', { name }) fills {placeholders} after translating.
export function t(text: string, values?: Record<string, string | number>) {
  const template = Object.hasOwn(messages[state.language], text) ? messages[state.language][text] : text;
  return interpolateMessage(template, state.language, values);
}
export function errorText(text: string) {
  return Object.hasOwn(errorMessages[state.language], text) ? errorMessages[state.language][text] : t(text);
}
// Select the count form using the active locale; {n} is the count.
export function tn(count: number, one: string, other: string, values?: Record<string, string | number>) {
  return t(singularCount(state.language, count) ? one : other, { n: count, ...values });
}
