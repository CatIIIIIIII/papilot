import { supportedLanguage, singularCount, interpolateMessage, type Language } from '../locales.ts';
import { messages } from './locales/index.ts';
export type { Language };

export function pageLanguage(search = location.search): Language {
  return supportedLanguage(new URLSearchParams(search).get('lang')) || 'en';
}
const current: Language =
  typeof location === "undefined" ? "en" : pageLanguage();
if (typeof document !== "undefined") document.documentElement.lang = current;

export const language = () => current;
// Dates and numbers follow the interface language.
export const locale = () => current;

// Links inside the viewer keep the page's language.
export function withLanguage(href: string) {
  return current === "en"
    ? href
    : `${href}${href.includes("?") ? "&" : "?"}lang=${current}`;
}

// t("Change {n}", { n }) fills {placeholders} after translating.
export function t(text: string, values?: Record<string, string | number>) {
  const template = Object.hasOwn(messages[current], text) ? messages[current][text] : text;
  return interpolateMessage(template, current, values);
}
// Select the count form using the active locale; {n} is the count.
export function tn(
  count: number,
  one: string,
  other: string,
  values?: Record<string, string | number>,
) {
  return t(singularCount(current, count) ? one : other, { n: count, ...values });
}
