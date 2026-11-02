import path from "node:path";
import { deepestNode } from "./outline.ts";
import { compact, doiOf } from "./verify.ts";
import type {
  Bibliography,
  BibliographyEntry,
  Heading,
  MissingCitation,
  ReferenceCitation,
  ReferenceEntry,
  ReferenceField,
  ReferenceProblem,
  References,
  Span,
  Unit,
} from "../types.ts";

// BibTeX entries as they are written, so that a review can show a .bib
// change entry by entry and check it. The reader follows BibTeX: text
// outside entries and @comment are ignored, @string macros resolve, and a
// value is {braced}, "quoted", a number or a macro name, joined with #.

interface BibSource {
  file: string;
  lines: Span;
}
type Macros = Map<string, { resolved: string; dependencies: BibSource[] }>;
export interface BibField {
  name: string;
  /** The value as written, without its outer braces or quotes. */
  value: string;
  /** The value with macros expanded and parts joined. */
  resolved: string;
  /** Source lines of @string definitions used here, including nested macros. */
  dependencies?: BibSource[];
}
export interface BibEntry {
  key: string;
  type: string;
  fields: BibField[];
  /** First and last line of the entry, counted from 1. */
  lines: Span;
  /** Why the entry could not be read to its end. */
  error?: string;
}

const MONTHS: Record<string, string> = {
  jan: "January",
  feb: "February",
  mar: "March",
  apr: "April",
  may: "May",
  jun: "June",
  jul: "July",
  aug: "August",
  sep: "September",
  oct: "October",
  nov: "November",
  dec: "December",
};
// Line breaks and indentation inside a value are one space when typeset.
export const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

class Unreadable extends Error {}

const defaultMacros = (): Macros => new Map(Object.entries(MONTHS).map(([name, resolved]) =>
  [name, { resolved, dependencies: [] }],
));

export function parseBib(text: string, file = "", macros = defaultMacros()): BibEntry[] {
  const lineAt = lines(text),
    entries: BibEntry[] = [];
  let at = 0;
  const space = () => {
    while (at < text.length && /\s/.test(text[at])) at++;
  };
  // From an opening brace to just after its matching close.
  const braced = () => {
    const start = at;
    let depth = 0;
    // BibTeX counts every brace, \{ included.
    for (; at < text.length; at++) {
      if (text[at] === "{") depth++;
      else if (text[at] === "}" && --depth === 0) {
        at++;
        return text.slice(start + 1, at - 1);
      }
    }
    throw new Unreadable("A brace is not closed.");
  };
  const quoted = () => {
    const start = ++at;
    let depth = 0;
    for (; at < text.length; at++) {
      if (text[at] === "{") depth++;
      else if (text[at] === "}") depth--;
      else if (text[at] === '"' && depth === 0) {
        at++;
        return text.slice(start, at - 1);
      }
    }
    throw new Unreadable("A quotation mark is not closed.");
  };
  const name = () => {
    const match = /^[^\s=,{}()"#%]+/.exec(text.slice(at, at + 200));
    if (!match) return "";
    at += match[0].length;
    return match[0];
  };
  const value = (): Omit<BibField, "name"> => {
    const start = at,
      parts: { text: string; resolved: string }[] = [],
      dependencies: BibSource[] = [];
    for (;;) {
      space();
      const c = text[at];
      if (c === "{") {
        const inner = braced();
        parts.push({ text: inner, resolved: inner });
      } else if (c === '"') {
        const inner = quoted();
        parts.push({ text: inner, resolved: inner });
      } else {
        const word = name();
        if (!word) throw new Unreadable("A field has no value.");
        const macro = /^\d+$/.test(word) ? undefined : macros.get(word.toLowerCase());
        if (macro) dependencies.push(...macro.dependencies);
        parts.push({
          text: word,
          resolved: macro?.resolved ?? word,
        });
      }
      space();
      if (text[at] !== "#") break;
      at++;
    }
    return {
      value: collapse(parts.length === 1 ? parts[0].text : text.slice(start, at)),
      resolved: collapse(parts.map((p) => p.resolved).join("")),
      ...(dependencies.length ? { dependencies: uniqueSources(dependencies) } : {}),
    };
  };
  // `name = value` pairs up to the closing delimiter.
  const fields = (close: string) => {
    const result: BibField[] = [];
    for (;;) {
      space();
      if (text[at] === close) {
        at++;
        return result;
      }
      if (text[at] === ",") {
        at++;
        continue;
      }
      const field = name().toLowerCase();
      if (!field) {
        if (at >= text.length) throw new Unreadable("The entry is not closed.");
        throw new Unreadable(`Unexpected “${text[at]}” in the entry.`);
      }
      space();
      if (text[at] !== "=")
        throw new Unreadable(`The field “${field}” has no “=”.`);
      at++;
      result.push({ name: field, ...value() });
      space();
      if (text[at] !== "," && text[at] !== close)
        throw new Unreadable(`A comma is missing after the field “${field}”.`);
    }
  };
  for (;;) {
    const sign = text.indexOf("@", at);
    if (sign < 0) break;
    at = sign + 1;
    space();
    const type = /^[A-Za-z]+/.exec(text.slice(at, at + 40))?.[0].toLowerCase();
    if (!type) continue;
    at += type.length;
    space();
    const open = text[at];
    if (open !== "{" && open !== "(") continue;
    const close = open === "{" ? "}" : ")";
    if (type === "comment" || type === "preamble") {
      try {
        if (open === "{") braced();
        else at = Math.max(text.indexOf(")", at), at) + 1;
      } catch {
        at = text.length;
      }
      continue;
    }
    at++;
    if (type === "string") {
      try {
        for (const field of fields(close)) macros.set(field.name, {
          resolved: field.resolved,
          dependencies: uniqueSources([{ file, lines: [lineAt(sign), lineAt(at - 1)] }, ...(field.dependencies ?? [])]),
        });
      } catch {
        /* A broken macro leaves its uses unresolved. */
      }
      continue;
    }
    space();
    const keyStart = at;
    while (at < text.length && !/[,\s]/.test(text[at]) && text[at] !== close) at++;
    const entry: BibEntry = {
      key: text.slice(keyStart, at),
      type,
      fields: [],
      lines: [lineAt(sign), lineAt(sign)],
    };
    try {
      entry.fields = fields(close);
      entry.lines[1] = lineAt(at - 1);
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
      entry.error = error.message;
      // Read on from the next line that starts an entry.
      const next = /\n[ \t]*@/g;
      next.lastIndex = sign + 1;
      const found = next.exec(text);
      at = found ? found.index + 1 : text.length;
      entry.lines[1] = lineAt(Math.max(at - 1, sign));
    }
    entries.push(entry);
  }
  return entries;
}

export interface EntryChange {
  key: string;
  oldKey?: string;
  type: string;
  oldType?: string;
  status: "added" | "removed" | "modified";
  fields: ReferenceField[];
  /** Lines in the new file, or in the old one for a removed entry. */
  lines: Span;
  oldLines?: Span;
  /** Entry and macro definition lines that can change its effective values. */
  sources: BibSource[];
  oldSources?: BibSource[];
  error?: string;
}
const fieldMap = (entry: BibEntry) =>
  new Map(entry.fields.map((f) => [f.name, f]));
// Every field of an entry pair, those of the new entry in its order first.
function fieldChanges(old: BibEntry | null, next: BibEntry | null) {
  const before = old ? fieldMap(old) : new Map<string, BibField>(),
    after = next ? fieldMap(next) : new Map<string, BibField>(),
    names = [...after.keys(), ...[...before.keys()].filter((n) => !after.has(n))];
  return names.map((name): ReferenceField => {
    const a = before.get(name),
      b = after.get(name);
    return {
      name,
      old: a?.value ?? null,
      new: b?.value ?? null,
      ...(a && a.resolved !== a.value ? { oldResolved: a.resolved } : {}),
      ...(b && b.resolved !== b.value ? { resolved: b.resolved } : {}),
    };
  });
}
const plainTitle = (entry: BibEntry) =>
  (fieldMap(entry).get("title")?.resolved ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

// The entries a change of one .bib file adds, removes or modifies. Entries
// pair by key; an added and a removed entry with the same title are one
// entry under a new key.
export function entryChanges(oldText: string, newText: string): EntryChange[] {
  return compareEntries(parseBib(oldText), parseBib(newText), "");
}
function compareEntries(before: BibEntry[], after: BibEntry[], file: string): EntryChange[] {
  const unpaired = new Map<string, BibEntry[]>();
  for (const entry of before)
    unpaired.set(entry.key, [...(unpaired.get(entry.key) ?? []), entry]);
  const pairs: [BibEntry | null, BibEntry | null][] = [];
  for (const entry of after) {
    const old = unpaired.get(entry.key)?.shift() ?? null;
    pairs.push([old, entry]);
  }
  const removed = [...unpaired.values()].flat();
  for (const pair of pairs) {
    if (pair[0]) continue;
    const title = plainTitle(pair[1]!),
      index = title
        ? removed.findIndex(
            (old) => plainTitle(old) === title && old.type === pair[1]!.type,
          )
        : -1;
    if (index >= 0) pair[0] = removed.splice(index, 1)[0];
  }
  for (const old of removed) pairs.push([old, null]);
  const changes: EntryChange[] = [];
  for (const [old, next] of pairs) {
    const fields = fieldChanges(old, next),
      entry = (next ?? old)!;
    if (
      old &&
      next &&
      old.key === next.key &&
      old.type === next.type &&
      old.error === next.error &&
      fields.every((f) => f.old === f.new && (f.oldResolved ?? f.old) === (f.resolved ?? f.new))
    )
      continue;
    changes.push({
      key: entry.key,
      ...(old && next && old.key !== next.key ? { oldKey: old.key } : {}),
      type: entry.type,
      ...(old && next && old.type !== next.type ? { oldType: old.type } : {}),
      status: !old ? "added" : !next ? "removed" : "modified",
      fields,
      lines: entry.lines,
      ...(old && next ? { oldLines: old.lines } : {}),
      sources: entrySources(entry, file),
      ...(old && next ? { oldSources: entrySources(old, file) } : {}),
      ...(next?.error ? { error: next.error } : {}),
    });
  }
  return changes.sort(
    (a, b) =>
      (a.status === "removed" ? 1 : 0) - (b.status === "removed" ? 1 : 0) ||
      a.lines[0] - b.lines[0],
  );
}

// Line ranges [start, end) of each entry, counted from 0, for grouping a
// .bib diff's hunks by entry.
const uniqueSources = (sources: BibSource[]): BibSource[] =>
  [...new Map(sources.map((source) => [JSON.stringify([source.file, source.lines]), source])).values()];
const entrySources = (entry: BibEntry, file: string) =>
  uniqueSources([{ file, lines: entry.lines }, ...entry.fields.flatMap((f) => f.dependencies ?? [])]);
export function entrySpans(text: string) {
  return parseBib(text).flatMap((e) => entrySources(e, "").map(({ lines: span }) => ({
    key: e.key,
    span: [span[0] - 1, span[1]] as Span,
  })));
}

// TeX comments, blanked so offsets and line numbers stay.
export function uncomment(text: string) {
  return text.replace(/(^|[^\\])((?:\\\\)*)%[^\n]*/g, (match, before, slashes) =>
    before + slashes + " ".repeat(match.length - before.length - slashes.length),
  );
}
// Ignore comments and literal examples in one pass: a percent sign inside
// \verb is data, not the start of a comment. Preserve offsets and newlines.
function texSource(text: string) {
  const parts: string[] = [],
    tokens = /\\([A-Za-z]+)\*?|\\[^A-Za-z]|%[^\n]*/g,
    literal = /^(?:verbatim\*?|Verbatim\*?|BVerbatim|LVerbatim|SaveVerbatim|lstlisting|minted|comment)$/;
  let from = 0;
  for (let token; (token = tokens.exec(text)); ) {
    let end = tokens.lastIndex;
    const command = token[1];
    if (token[0].startsWith("%")) {
      // The whole comment is already consumed.
    } else if (command === "begin") {
      const env = /^\s*\{([^}]+)\}/.exec(text.slice(end));
      if (!env || !literal.test(env[1])) continue;
      const close = new RegExp(String.raw`\\end\s*\{${env[1].replace("*", "\\*")}\}`, "g");
      close.lastIndex = end + env[0].length;
      const found = close.exec(text);
      end = found ? close.lastIndex : text.length;
    } else if (command === "verb" || command === "Verb" || command === "lstinline" || command === "mintinline") {
      if (command !== "verb") end += /^\s*(?:\[[^\]]*\])?/.exec(text.slice(end))![0].length;
      if (command === "mintinline") {
        const language = /^\s*\{[^}]*\}\s*/.exec(text.slice(end));
        if (!language) continue;
        end += language[0].length;
      }
      const delimiter = text[end];
      if (!delimiter || /\s/.test(delimiter)) continue;
      if (delimiter === "{" && (command === "lstinline" || command === "mintinline")) {
        let depth = 1;
        while (++end < text.length && depth) {
          if (text[end] === "{") depth++;
          else if (text[end] === "}") depth--;
        }
        end = Math.min(end, text.length);
      } else {
        const close = text.indexOf(delimiter, end + 1), newline = text.indexOf("\n", end + 1);
        end = close >= 0 && (newline < 0 || close < newline)
          ? close + 1 : newline >= 0 ? newline : text.length;
      }
    } else if (token[0] !== "\\\\") {
      continue;
    }
    parts.push(text.slice(from, token.index), text.slice(token.index, end).replace(/[^\n\r]/g, " "));
    from = end;
    tokens.lastIndex = end;
  }
  return parts.join("") + text.slice(from);
}
// The line of each offset, counted from 1.
function lines(text: string) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return (offset: number) => {
    let low = 0,
      high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}
// Commands that print a citation or add one to the bibliography, in the
// forms of LaTeX, natbib and biblatex, including \cites{a}{b}.
const CITE = /\\([A-Za-z]*[cC]ite[A-Za-z]*|nocite)\*?(?![A-Za-z])/g;
const NOT_CITES = new Set(["citestyle", "citesetup", "citeindextrue", "citeindexfalse", "citename"]);
export function citations(text: string, file: string) {
  const source = texSource(text),
    lineAt = lines(source),
    found: { key: string; file: string; line: number }[] = [];
  for (const match of source.matchAll(CITE)) {
    if (NOT_CITES.has(match[1])) continue;
    let at = match.index + match[0].length;
    const groups = match[1].endsWith("cites") ? Infinity : 1;
    for (let taken = 0; taken < groups; ) {
      const rest = source.slice(at),
        options = /^\s*(?:\([^)]*\)\s*)*(?:\[[^\]]*\]\s*)*/.exec(rest)![0],
        body = /^\{([^{}]*)\}/.exec(rest.slice(options.length));
      if (!body) break;
      const line = lineAt(at + options.length);
      for (const key of body[1].split(",").map((k) => k.trim()).filter((k) => k && !/[\\#\s]/.test(k)))
        found.push({ key, file, line });
      at += options.length + body[0].length;
      taken++;
    }
  }
  return found;
}

// The document's files in reading order, from the main file through
// \input, \include, \subfile and \import, and the .bib files it names.
export function documentFiles(read: (file: string) => string | null, main: string) {
  const base = path.posix.dirname(main),
    files: string[] = [],
    bibs: string[] = [];
  const resolve = (name: string, dir = base, extension = ".tex") => {
    name = name.trim();
    if (!name || /[\\#]/.test(name)) return null;
    const file = path.posix.normalize(path.posix.join(dir, name));
    if (file.startsWith("../") || path.posix.isAbsolute(name)) return null;
    return path.posix.extname(file) ? file : file + extension;
  };
  const walk = (file: string) => {
    if (files.includes(file)) return;
    const text = read(file);
    if (text == null) return;
    files.push(file);
    const source = texSource(text),
      here = path.posix.dirname(file);
    for (const m of source.matchAll(
      /\\(?:input|include|subfile|InputIfFileExists)\s*\{([^}]+)\}|\\(sub)?(?:import|inputfrom|includefrom)\*?\s*\{([^}]*)\}\s*\{([^}]+)\}|\\bibliography\s*\{([^}]+)\}|\\add(?:bibresource|globalbib|sectionbib)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g,
    )) {
      if (m[5] || m[6]) {
        for (const name of m[5] ? m[5].split(",") : [m[6]]) {
          const bib = resolve(name, base, ".bib");
          if (bib && !bibs.includes(bib)) bibs.push(bib);
        }
        continue;
      }
      const target = m[1]
        ? resolve(m[1])
        : resolve(m[4], path.posix.join(m[2] ? here : base, m[3]));
      if (target) walk(target);
    }
  };
  walk(main);
  return { files, bibs };
}

/** A built document as the reference check reads it. */
export interface Document {
  read(file: string): string | null;
  main: string;
  outline: Heading[];
}
function citationsOf(doc: Document) {
  const { files, bibs } = documentFiles((f) => doc.read(f), doc.main),
    cites = files.flatMap((file) => citations(doc.read(file) ?? "", file)),
    entries = bibliographyEntries(doc.read.bind(doc), bibs),
    keys = new Map<string, number>();
  for (const values of entries.values())
    for (const entry of values)
      keys.set(entry.key, (keys.get(entry.key) ?? 0) + 1);
  return { cites, bibs, entries, keys, all: cites.some((c) => c.key === "*") };
}
// BibTeX reads databases in declaration order, retaining @string definitions
// for subsequent files. Keep the defining file with every dependency.
function bibliographyEntries(read: (file: string) => string | null, bibs: string[]) {
  const macros = defaultMacros();
  return new Map(bibs.map((file) => [file, parseBib(read(file) ?? "", file, macros)]));
}
const sectionOf = (doc: Document, file: string, line: number) => {
  const node = deepestNode(doc.outline, file, line, line);
  return node ? `${node.number} ${node.title}`.trim() : null;
};
const meets = (a: Span, b: Span) => a[0] <= b[1] && b[0] <= a[1];
// A grouped macro edit can span unrelated entries. Match its actual edits,
// not the envelope between the first and last hunk.
function changesSources(unit: Unit, sources: BibSource[], side: "old" | "new") {
  const own = sources.filter((source) => source.file === unit.file);
  if (unit.whole_file) return own.length > 0;
  const ranges: Span[] = unit.ops.length
    ? unit.ops.map((op) => side === "old" ? [op[1], op[2]] : [op[3], op[4]])
    : [side === "old" ? [unit.old_start - 1, unit.old_end] : [unit.new_start - 1, unit.new_end]];
  return own.some(({ lines: [start, end] }) => ranges.some(([a, b]) =>
    a === b ? start - 1 < a && a < end : a < end && start - 1 < b,
  ));
}

// What a round changes in the bibliography: each added, removed or modified
// entry under the edit it belongs to, where the revised document cites it,
// and the keys it newly cites without an entry.
export function referenceChanges(
  units: Unit[],
  old: Document,
  next: Document,
): References | undefined {
  const bibUnits = units.filter((u) => u.file.endsWith(".bib") && u.kind === "text");
  const before = citationsOf(old),
    after = citationsOf(next),
    entries: ReferenceEntry[] = [];
  for (const file of new Set([...bibUnits.map((u) => u.file), ...before.bibs, ...after.bibs])) {
    const counts = new Map<string, number>(),
      a = before.entries.get(file) ?? parseBib(old.read(file) ?? "", file),
      b = after.entries.get(file) ?? parseBib(next.read(file) ?? "", file);
    for (const change of compareEntries(a, b, file)) {
      const affected = bibUnits.filter((u) =>
        change.status === "removed"
          ? changesSources(u, change.sources, "old")
          : changesSources(u, change.sources, "new") ||
            (change.oldSources !== undefined && changesSources(u, change.oldSources, "old")),
      );
      if (!affected.length) continue;
      const n = (counts.get(change.key) ?? 0) + 1;
      counts.set(change.key, n);
      const cited = (key: string) =>
          after.cites
            .filter((c) => c.key === key)
            .map(
              (c): ReferenceCitation => ({
                file: c.file,
                line: c.line,
                section: sectionOf(next, c.file, c.line),
              }),
            ),
        problems: ReferenceProblem[] = [];
      if (change.error) problems.push("unreadable");
      if (change.status !== "removed" && (after.keys.get(change.key) ?? 0) > 1)
        problems.push("duplicate-key");
      const gone = change.status === "removed" ? change.key : change.oldKey;
      if (gone && !after.keys.has(gone) && cited(gone).length)
        problems.push("still-cited");
      if (after.bibs.length && !after.bibs.includes(file))
        problems.push("not-in-bibliography");
      entries.push({
        id: `${file}#${change.key}${n > 1 ? `#${n}` : ""}`,
        unit: affected[0].id,
        ...(affected.length > 1 ? { units: affected.map((u) => u.id) } : {}),
        file,
        key: change.key,
        ...(change.oldKey ? { old_key: change.oldKey } : {}),
        type: change.type,
        ...(change.oldType ? { old_type: change.oldType } : {}),
        status: change.status,
        fields: change.fields,
        lines: change.lines,
        cited: cited(change.key),
        ...(gone && gone !== change.key ? { old_cited: cited(gone) } : {}),
        problems,
        ...(change.error ? { error: change.error } : {}),
      });
    }
  }
  // Keys the revised document cites with no entry in its bibliography, if
  // it names one and did not already lack them.
  const missing: MissingCitation[] = [];
  if (after.bibs.length) {
    // A key whose entry this round removes or renames is shown with it.
    const lacking = new Set([
      ...before.cites.filter((c) => !before.keys.has(c.key)).map((c) => c.key),
      ...entries.flatMap((e) => (e.status === "removed" ? [e.key] : e.old_key ? [e.old_key] : [])),
    ]);
    for (const cite of after.cites) {
      if (cite.key === "*" || after.keys.has(cite.key) || lacking.has(cite.key))
        continue;
      const unit = units.find(
        (u) =>
          u.file === cite.file &&
          u.status !== "deleted" &&
          meets([cite.line, cite.line], [u.new_start, u.new_end]),
      );
      missing.push({
        key: cite.key,
        file: cite.file,
        line: cite.line,
        unit: unit?.id ?? null,
        section: sectionOf(next, cite.file, cite.line),
      });
    }
  }
  if (!entries.length && !missing.length) return undefined;
  return { entries, missing };
}

// The paper's whole bibliography as it is, for a panel that checks it
// rather than a round's changes.
export function bibliographyReport(doc: Document): Bibliography {
  const read = (file: string) => doc.read(file),
    { files, bibs } = documentFiles(read, doc.main),
    parsed = bibliographyEntries(read, bibs),
    cites = files.flatMap((file) => citations(read(file) ?? "", file)),
    place = (c: { file: string; line: number }): ReferenceCitation => ({
      file: c.file,
      line: c.line,
      section: sectionOf(doc, c.file, c.line),
    }),
    entries: BibliographyEntry[] = [],
    absent: string[] = [],
    counts = new Map<string, number>();
  for (const file of bibs) {
    const text = read(file);
    if (text == null) {
      absent.push(file);
      continue;
    }
    for (const entry of parsed.get(file)!) {
      const n = (counts.get(`${file}#${entry.key}`) ?? 0) + 1;
      counts.set(`${file}#${entry.key}`, n);
      entries.push({
        id: `${file}#${entry.key}${n > 1 ? `#${n}` : ""}`,
        file,
        key: entry.key,
        type: entry.type,
        fields: entry.fields.map((f) => ({
          name: f.name,
          value: f.value,
          ...(f.resolved !== f.value ? { resolved: f.resolved } : {}),
        })),
        lines: entry.lines,
        cited: cites.filter((c) => c.key === entry.key).map(place),
        ...(entry.error ? { error: entry.error } : {}),
      });
    }
  }
  const keys = new Set(entries.map((e) => e.key)),
    group = (value: (e: BibliographyEntry) => string) => {
      const groups = new Map<string, BibliographyEntry[]>();
      for (const entry of entries) {
        const v = value(entry);
        if (v) groups.set(v, [...(groups.get(v) ?? []), entry]);
      }
      return [...groups.values()].filter((list) => list.length > 1);
    },
    field = (e: BibliographyEntry, name: string) => {
      const f = e.fields.find((x) => x.name === name);
      return f ? (f.resolved ?? f.value) : "";
    },
    titled = (e: BibliographyEntry) => {
      const title = compact(field(e, "title"));
      return title.length >= 15 ? title : "";
    },
    distinct = (list: BibliographyEntry[]) => new Set(list.map((e) => e.key)).size > 1;
  return {
    bibs,
    absent,
    entries,
    missing: bibs.length
      ? cites.filter((c) => c.key !== "*" && !keys.has(c.key)).map((c) => ({ key: c.key, ...place(c) }))
      : [],
    duplicates: group((e) => e.key).map((list) => list.map((e) => e.id)),
    similar: [
      ...group((e) => (doiOf(Object.fromEntries(e.fields.map((f) => [f.name, f.resolved ?? f.value]))) ?? "").toLowerCase())
        .filter(distinct)
        .map((list) => ({ ids: list.map((e) => e.id), by: "doi" as const })),
      ...group(titled)
        .filter(distinct)
        .map((list) => ({ ids: list.map((e) => e.id), by: "title" as const })),
    ],
    all_cited: cites.some((c) => c.key === "*"),
  };
}
