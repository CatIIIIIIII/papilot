import type { Language } from '../../../engine/src/locales.ts';
import { zhCN } from '../zh-CN.ts';
import generatedZhCN from './zh-CN.json';
import zhHant from './zh-Hant.json';
import errorsZhCN from './errors/zh-CN.json';
import errorsZhHant from './errors/zh-Hant.json';
import ja from './ja.json';
import errors_ja from './errors/ja.json';
import ko from './ko.json';
import errors_ko from './errors/ko.json';
import de from './de.json';
import errors_de from './errors/de.json';
import fr from './fr.json';
import errors_fr from './errors/fr.json';
import es from './es.json';
import errors_es from './errors/es.json';
import pt from './pt.json';
import errors_pt from './errors/pt.json';
import it from './it.json';
import errors_it from './errors/it.json';
import sv from './sv.json';
import errors_sv from './errors/sv.json';

export const messages: Record<Language, Record<string, string>> = {
  en: {}, 'zh-Hans': { ...generatedZhCN, ...zhCN }, 'zh-Hant': zhHant,
  ja, ko, de, fr, es, pt, it, sv,
};
export const errorMessages: Record<Language, Record<string, string>> = {
  en: {}, 'zh-Hans': errorsZhCN, 'zh-Hant': errorsZhHant,
  ja: errors_ja, ko: errors_ko, de: errors_de, fr: errors_fr, es: errors_es, pt: errors_pt, it: errors_it, sv: errors_sv,
};
