import { tokenGlyphs, type Token } from "./pdfdiff.ts";
import type { Words } from "./effects.ts";

interface Prefixes {
  end?: boolean;
  word?: string;
  next: Map<string, Prefixes>;
}
/** A printed line break may split a word while a floating block moves between
 * its pieces. Compare both documents with the same observed boundaries; the
 * comparison, not a guessed next line, decides which pieces correspond. */
export function sharedWords(...documents: Words[]): Words[] {
  if (
    documents[0]?.segmentation &&
    documents.every((w) => w.segmentation === documents[0].segmentation)
  )
    return documents;
  documents = documents.map((w) => w.original ?? w);
  const segmentation = {};
  const prefixes: Prefixes = { next: new Map() },
    suffixes: Prefixes = { next: new Map() };
  let found = false;
  for (const document of documents)
    for (const token of document.tokens) {
      if (!token.breaks?.length) continue;
      const cuts = new Set(token.breaks);
      let node = prefixes,
        offset = 0;
      for (const char of token.text) {
        if (!node.next.has(char)) node.next.set(char, { next: new Map() });
        node = node.next.get(char)!;
        offset += char.length;
        if (cuts.has(offset)) node.end = true;
      }
      found = true;
    }
  for (const document of documents)
    for (const token of document.tokens)
      if (token.afterHyphen) {
        let node = suffixes;
        for (const char of Array.from(token.text).reverse()) {
          if (!node.next.has(char)) node.next.set(char, { next: new Map() });
          node = node.next.get(char)!;
        }
        node.end = true;
      }
  if (!found) return documents;
  const lettersOf = new Map(
      documents.flatMap((w) =>
        w.tokens.map((t) => [t.text, Array.from(t.text)] as const),
      ),
    ),
    boundaries = new Map<string, Set<number>>();
  for (const [text, letters] of lettersOf) {
    const cuts = new Set([0, letters.length]);
    let node: Prefixes | undefined = prefixes;
    for (let i = 0; i < letters.length; i++) {
      node = node?.next.get(letters[i]);
      if (!node) break;
      if (node.end) cuts.add(i + 1);
    }
    node = suffixes;
    for (let i = letters.length - 1; i >= 0; i--) {
      node = node?.next.get(letters[i]);
      if (!node) break;
      if (node.end) cuts.add(i);
    }
    boundaries.set(text, cuts);
  }
  const vocabulary: Prefixes = { next: new Map() },
    lengths = [
      ...new Set([...lettersOf.values()].map((letters) => letters.length)),
    ].sort((a, b) => a - b);
  for (const [word, letters] of lettersOf) {
    let node = vocabulary;
    for (const char of letters) {
      if (!node.next.has(char)) node.next.set(char, { next: new Map() });
      node = node.next.get(char)!;
    }
    node.word = word;
  }
  // A word may be broken at different positions in different occurrences.
  // Its already observed fragments inherit the same internal boundaries.
  // Each update adds a boundary, so this refinement reaches a fixed point.
  const queue = [...boundaries.keys()],
    queued = new Set(queue),
    dependents = new Map<string, Set<string>>(),
    enqueue = (text: string) => {
      for (const key of [text, ...(dependents.get(text) ?? [])])
        if (!queued.has(key)) {
          queue.push(key);
          queued.add(key);
        }
    };
  while (queue.length) {
    const text = queue.pop()!;
    queued.delete(text);
    const letters = lettersOf.get(text)!,
      cuts = [...boundaries.get(text)!].sort((a, b) => a - b);
    for (let i = 0; i + 1 < cuts.length; i++) {
      // Only existing lexical fragments can transmit a boundary. Walk their
      // trie, never construct every possible substring of a long token.
      let lo = 0,
        hi = lengths.length;
      const available = letters.length - cuts[i] - (i === 0 ? 1 : 0);
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (lengths[mid] <= available) lo = mid + 1;
        else hi = mid;
      }
      if (!lo) continue;
      const limit = cuts[i] + lengths[lo - 1];
      let node: Prefixes | undefined = vocabulary;
      for (let end = cuts[i] + 1; end <= limit; end++) {
        node = node?.next.get(letters[end - 1]);
        if (!node) break;
        if (node.word === undefined || !boundaries.get(text)!.has(end))
          continue;
        const fragment = node.word,
          other = boundaries.get(fragment)!;
        if (!dependents.has(fragment)) dependents.set(fragment, new Set());
        dependents.get(fragment)!.add(text);
        let changed = false;
        for (let k = i + 1; k < cuts.length && cuts[k] < end; k++)
          if (!other.has(cuts[k] - cuts[i])) {
            other.add(cuts[k] - cuts[i]);
            changed = true;
          }
        if (changed) enqueue(fragment);
        const own = boundaries.get(text)!;
        changed = false;
        for (const cut of other)
          if (!own.has(cuts[i] + cut)) {
            own.add(cuts[i] + cut);
            changed = true;
          }
        if (changed) enqueue(text);
      }
    }
  }
  return documents.map((document) => {
    const tokens: Token[] = [];
    document.tokens.forEach((token, word) => {
      const letters = lettersOf.get(token.text)!,
        cuts = [...boundaries.get(token.text)!].sort((a, b) => a - b);
      if (cuts.length === 2) {
        tokens.push(token);
        return;
      }
      const semantic = tokenGlyphs(token, true),
        full = tokenGlyphs(token),
        positions = new Map(semantic.map((glyph, i) => [glyph, i])),
        footprints = cuts.slice(1).map(() => [] as number[]);
      let at = 0,
        part = 0;
      for (const glyph of full) {
        at = positions.get(glyph) ?? at;
        while (part + 1 < footprints.length && at >= cuts[part + 1]) part++;
        footprints[part].push(glyph);
      }
      for (let i = 0; i + 1 < cuts.length; i++) {
        const glyphs = footprints[i];
        tokens.push({
          text: letters.slice(cuts[i], cuts[i + 1]).join(""),
          start: glyphs[0],
          end: glyphs.at(-1)! + 1,
          glyphs,
          semanticGlyphs: semantic.slice(cuts[i], cuts[i + 1]),
          flow: token.flow,
          part: { word, index: i, total: cuts.length - 1 },
        });
      }
    });
    const ranges: [number, number][] = [];
    tokens.forEach((token, i) => {
      const first = token.part
          ? document.tokens[token.part.word].start
          : token.start,
        line = document.glyphs[first]?.pair ?? 0;
      ranges[line] = [ranges[line]?.[0] ?? i, i + 1];
    });
    return {
      ...document,
      tokens,
      lines: ranges.filter(Boolean),
      segmentation,
      original: document,
    };
  });
}
