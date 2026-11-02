import type { Language } from '../../locales.ts';
import { zhCN } from '../zh-CN.ts';
import zhHant from './zh-Hant.json';
import ja from './ja.json';
import ko from './ko.json';
import de from './de.json';
import fr from './fr.json';
import es from './es.json';
import pt from './pt.json';
import it from './it.json';
import sv from './sv.json';

export const messages: Record<Language, Record<string, string>> = {
  en: {}, 'zh-Hans': zhCN, 'zh-Hant': zhHant,
  ja, ko, de, fr, es, pt, it, sv,
};
