// Shared by the workspace and the standalone review viewer.
export const LANGUAGES = [
  { id: 'en', name: 'English' },
  { id: 'zh-Hans', name: '简体中文' },
  { id: 'zh-Hant', name: '繁體中文' },
  { id: 'ja', name: '日本語' },
  { id: 'ko', name: '한국어' },
  { id: 'de', name: 'Deutsch' },
  { id: 'fr', name: 'Français' },
  { id: 'es', name: 'Español' },
  { id: 'pt', name: 'Português' },
  { id: 'it', name: 'Italiano' },
  { id: 'sv', name: 'Svenska' },
] as const;

export type Language = typeof LANGUAGES[number]['id'];

// Accept older saved choices and regional browser preferences, but expose only
// the canonical language/script choices in the interface.
export function supportedLanguage(tag: string | null | undefined): Language | null {
  if (!tag) return null;
  try {
    const locale = new Intl.Locale(tag);
    if (locale.language === 'zh') return locale.maximize().script === 'Hant' ? 'zh-Hant' : 'zh-Hans';
    return LANGUAGES.find(item => item.id === locale.language)?.id || null;
  } catch { return null; }
}

const rules = new Map<Language, Intl.PluralRules>();
export function singularCount(language: Language, count: number) {
  let rule = rules.get(language);
  if (!rule) { rule = new Intl.PluralRules(language); rules.set(language, rule); }
  return rule.select(count) === 'one';
}

const numberFormats = new Map<Language, Intl.NumberFormat>();
export function interpolateMessage(text: string, language: Language, values?: Record<string, string | number>) {
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (!Object.hasOwn(values, name)) return match;
    const value = values[name];
    if (typeof value !== 'number') return value;
    let format = numberFormats.get(language);
    if (!format) { format = new Intl.NumberFormat(language, { maximumFractionDigits: 20 }); numberFormats.set(language, format); }
    return format.format(value);
  });
}
