// Laws of the engine's pure text and geometry functions, checked on generated
// inputs. A failure prints its seed and the smallest input that breaks the law;
// replay it with fc.assert(..., { seed, path }).
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { applyUnits, revertUnits, unitsOf } from "../../src/core/changes.ts";
import { mergeText, textEdits, textTokens } from "../../src/core/text-edits.ts";
import { structuralSource } from "../../src/core/tex-source.ts";
import { compactRanges, covers } from "../../src/core/outline.ts";
import { addInterval, subtractInterval, type Intervals } from "../../src/render/locate.ts";
import { wordDiff } from "../../src/web/model.ts";
import { latexTokens } from "../../src/web/LatexInput.tsx";
import type { Op, Span } from "../../src/types.ts";

// Manuscript-like text: commands, groups, math, comments, CJK, punctuation
// and the spacing and line endings authors leave.
const piece = fc.constantFrom(
  "word", "method", "the", "α", "数据", "，", "。", ".", ",", " ", "  ", "\t",
  "\\emph{", "\\cite{key}", "\\\\", "\\%", "{", "}", "$", "$x^2$", "\\(", "\\)",
  "% note", "\\begin{equation}", "\\end{equation}", "~", "\\verb|x|", "[", "]",
);
const line = fc.array(piece, { maxLength: 8 }).map((parts) => parts.join(""));
const text = fc
  .tuple(fc.array(line, { maxLength: 12 }), fc.constantFrom("\n", "\r\n"), fc.boolean())
  .map(([lines, end, last]) => lines.map((l) => l + end).join("") + (last ? "trailing" : ""));
// A text and an edit of it: lines inserted, deleted or rewritten in place.
const edited = fc
  .tuple(
    fc.array(line, { minLength: 1, maxLength: 20 }),
    fc.array(fc.tuple(fc.nat(), fc.constantFrom("insert", "delete", "replace"), line), { maxLength: 8 }),
    fc.boolean(),
  )
  .map(([lines, edits, trim]) => {
    const before = lines.map((l) => l + "\n");
    const after = [...before];
    for (const [at, kind, replacement] of edits) {
      const index = at % (after.length + 1);
      after.splice(index, kind === "insert" ? 0 : 1, ...(kind === "delete" ? [] : [replacement + "\n"]));
    }
    if (trim && after.length) after[after.length - 1] = after.at(-1)!.trimEnd();
    return [before.join(""), after.join("")] as const;
  });
const apply = (before: string, after: string, ops: Op[]) => {
  let result = "", at = 0;
  for (const [, i, j, x, y] of ops) {
    result += before.slice(at, i) + after.slice(x, y);
    at = j;
  }
  return result + before.slice(at);
};

describe("review units", () => {
  const file = "paper/method.tex", figure = () => false;
  it("accepting every change gives the new text and rejecting every change the old one", () => {
    fc.assert(fc.property(edited, ([before, after]) => {
      const old = Buffer.from(before), next = Buffer.from(after);
      const units = unitsOf([file], { [file]: old }, { [file]: next }, figure);
      expect(applyUnits(old, next, units)?.toString()).toBe(after);
      expect(revertUnits(old, next, units)?.toString()).toBe(before);
    }));
  });
  it("accepting some changes is rejecting the others", () => {
    fc.assert(fc.property(edited, fc.array(fc.boolean(), { minLength: 1 }), ([before, after], mask) => {
      const old = Buffer.from(before), next = Buffer.from(after);
      const units = unitsOf([file], { [file]: old }, { [file]: next }, figure);
      const chosen = units.filter((_, i) => mask[i % mask.length]), others = units.filter((u) => !chosen.includes(u));
      expect(applyUnits(old, next, chosen)?.toString()).toBe(revertUnits(old, next, others)?.toString());
    }));
  });
});

describe("word edits", () => {
  it("tokens are never empty and join back to the text", () => {
    fc.assert(fc.property(text, (value) => {
      const tokens = textTokens(value);
      expect(tokens.every((token) => token.length > 0)).toBe(true);
      expect(tokens.join("")).toBe(value);
    }));
  });
  it("edits are ordered, disjoint, and turn the old text into the new", () => {
    fc.assert(fc.property(text, text, (before, after) => {
      const ops = textEdits(before, after);
      ops.forEach(([, i, j, x, y], k) => {
        expect(i <= j && x <= y).toBe(true);
        if (k) expect(i >= ops[k - 1][2] && x >= ops[k - 1][4]).toBe(true);
      });
      expect(apply(before, after, ops)).toBe(after);
    }));
  });
  it("a merge keeps a side the other left alone, and agrees with itself", () => {
    const b = Buffer.from;
    fc.assert(fc.property(text, text, (ours, base) => {
      expect(mergeText(b(ours), b(base), b(base))?.toString()).toBe(ours);
      expect(mergeText(b(base), b(base), b(ours))?.toString()).toBe(ours);
      expect(mergeText(b(ours), b(base), b(ours))?.toString()).toBe(ours);
    }));
  });
  it("a merge does not depend on which side is ours", () => {
    const b = Buffer.from;
    fc.assert(fc.property(text, text, text, (ours, base, theirs) => {
      expect(mergeText(b(ours), b(base), b(theirs))?.toString()).toBe(mergeText(b(theirs), b(base), b(ours))?.toString());
    }));
  });
});

describe("source views", () => {
  it("the changes view splits both sides into equal, deleted and inserted words", () => {
    fc.assert(fc.property(text, text, (before, after) => {
      const parts = wordDiff(before, after);
      expect(parts.filter((p) => p.type !== "ins").map((p) => p.text).join("")).toBe(before);
      expect(parts.filter((p) => p.type !== "del").map((p) => p.text).join("")).toBe(after);
    }));
  });
  it("highlighting LaTeX keeps every character", () => {
    fc.assert(fc.property(text, (value) => {
      expect(latexTokens(value).map((token) => token.text).join("")).toBe(value);
    }));
  });
  it("the structural view blanks characters in place and keeps line breaks", () => {
    fc.assert(fc.property(text, (value) => {
      const view = structuralSource(value);
      expect(view.length).toBe(value.length);
      for (let i = 0; i < value.length; i++) {
        if (value[i] === "\n" || value[i] === "\r") expect(view[i]).toBe(value[i]);
        else expect(view[i] === value[i] || view[i] === " ").toBe(true);
      }
    }));
  });
});

describe("outline and page geometry", () => {
  const span = fc.tuple(fc.integer({ min: 0, max: 200 }), fc.integer({ min: 0, max: 60 })).map(([top, height]): Span => [top, top + height]);
  const coverage = (spans: Span[], y: number) => spans.some(([a, b]) => a < y && y < b);
  it("compacted line ranges cover exactly the lines they came from", () => {
    fc.assert(fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 80 })), fc.integer({ min: 1, max: 80 }), fc.integer({ min: 0, max: 10 }), (lines, start, length) => {
      const spans = compactRanges({ main: new Set(lines) }).main, end = start + length;
      expect(covers(spans, start, end)).toBe(Array.from({ length: length + 1 }, (_, k) => start + k).every((n) => lines.includes(n)));
    }));
  });
  it("added intervals are sorted, disjoint and the same in any order", () => {
    fc.assert(fc.property(fc.array(span), (spans) => {
      const forward: Intervals = new Map(), backward: Intervals = new Map();
      for (const [a, b] of spans) addInterval(forward, 0, a, b);
      for (const [a, b] of [...spans].reverse()) addInterval(backward, 0, a, b);
      const result = forward.get(0) ?? [];
      expect(backward.get(0) ?? []).toEqual(result);
      result.forEach(([a, b], k) => { expect(b - a > 2).toBe(true); if (k) expect(a > result[k - 1][1]).toBe(true); });
      // Points between integers: covered exactly when an added span taller than 2 covers them.
      for (let y = 0.5; y < 262; y++) expect(coverage(result, y)).toBe(coverage(spans.filter(([a, b]) => b - a > 2), y));
    }));
  });
  it("a subtracted interval leaves nothing inside it and adds nothing", () => {
    fc.assert(fc.property(fc.array(span), span, (spans, [top, bottom]) => {
      const intervals: Intervals = new Map();
      for (const [a, b] of spans) addInterval(intervals, 0, a, b);
      const before = intervals.get(0) ?? [];
      subtractInterval(intervals, 0, top, bottom);
      const after = intervals.get(0) ?? [];
      for (const [a, b] of after) expect(b <= top || a >= bottom).toBe(true);
      for (let y = 0.5; y < 262; y++) if (coverage(after, y)) expect(coverage(before, y)).toBe(true);
    }));
  });
});
