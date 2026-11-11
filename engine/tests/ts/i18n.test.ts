import { it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { messages } from "../../src/web/locales/index.ts";
import { LANGUAGES } from "../../src/locales.ts";
import { STATE, STATUS } from "../../src/web/model.ts";
import { pageLanguage, t, language } from "../../src/web/i18n.ts";

const web = new URL("../../src/web/", import.meta.url);
// Every literal passed to t(), tn() or a translator, plus the label maps the
// viewer translates where it shows them.
function keys() {
  const found = new Set<string>([
    ...Object.values(STATUS),
    ...Object.values(STATE),
  ]);
  for (const file of readdirSync(web).filter((f) => /\.tsx?$/.test(f))) {
    if (file === "zh-CN.ts" || file === "i18n.ts") continue;
    const source = readFileSync(new URL(file, web), "utf8");
    for (const call of source.matchAll(
      /\b(?:t|tn|say)\(\s*(?:[\w.]+,\s*)?((?:"(?:[^"\\]|\\.)*"\s*[,:?]?\s*)+)/g,
    ))
      for (const [, text] of call[1].matchAll(/"((?:[^"\\]|\\.)*)"/g))
        found.add(text);
    for (const map of source.matchAll(
      /const (?:KIND|PHASE|ACTION|CHANGE_ACTION|CHANGE_STATE|FIELD|ENTRY_STATUS|CHECK|PROBLEM)\b[^{]*\{([^}]*)\}/g,
    ))
      for (const [, text] of map[1].matchAll(/:\s*"([^"]*)"/g))
        found.add(text);
  }
  return [...found];
}
const placeholders = (text: string) =>
  [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

it("reads the language from the page address only", () => {
  expect(pageLanguage("?task=a&lang=zh-CN")).toBe("zh-Hans");
  expect(pageLanguage("?lang=zh")).toBe("zh-Hans");
  expect(pageLanguage("?task=a")).toBe("en");
  expect(pageLanguage("?lang=fr")).toBe("fr");
  expect(pageLanguage("?lang=zh-Hant")).toBe("zh-Hant");
  expect(pageLanguage("?lang=zh-Hans")).toBe("zh-Hans");
  for (const { id } of LANGUAGES) expect(pageLanguage(`?lang=${id}`)).toBe(id);
});

it("importing shared viewer translations leaves the host document language alone", async () => {
  const document = { documentElement: { lang: "fr" } };
  vi.resetModules();
  vi.stubGlobal("document", document);
  vi.stubGlobal("location", { search: "?lang=de" });
  try {
    const viewer = await import("../../src/web/i18n.ts");
    expect(viewer.language()).toBe("de");
    expect(document.documentElement.lang).toBe("fr");
  } finally {
    vi.unstubAllGlobals();
    vi.resetModules();
  }
});

it("shared components can translate in their host language without changing the viewer language", () => {
  const original = language();
  expect(t("{label}, PDF page {page}", { label: "Avant", page: "1" }, "fr")).toBe("Avant, page PDF 1");
  expect(t("{label}, PDF page {page}", { label: "Vorher", page: "1" }, "de")).toBe("Vorher, PDF-Seite 1");
  expect(language()).toBe(original);
});

it("translates every review message into every supported language with intact placeholders", () => {
  const all = keys();
  for (const { id } of LANGUAGES) {
    if (id === 'en') continue;
    const dictionary = messages[id];
    expect(all.filter(key => !Object.hasOwn(dictionary, key)), id).toEqual([]);
    for (const key of all) expect(placeholders(dictionary[key]), `${id}: ${key}`).toEqual(placeholders(key));
  }
});
