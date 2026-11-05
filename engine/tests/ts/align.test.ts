import { afterEach, expect, it } from "vitest";
import { mupdf, PdfDocument, containsCenter } from "../../src/render/pdf.ts";
import { alignedCrops, alignment, marksIn } from "../../src/render/align.ts";
import type { Build } from "../../src/render/locate.ts";
import type { Position, Rect } from "../../src/types.ts";
const documents: PdfDocument[] = [];
afterEach(() => documents.splice(0).forEach((d) => d.close()));
const LINES = 26;
// Where the body starts and ends on a page, from the top.
const BODY = 40,
  END = 50 + LINES * 18;
// A PDF that prints the lines given, 26 to a page.
function pdf(lines: string[]) {
  const doc = new mupdf.PDFDocument(),
    font = new mupdf.Font("Helvetica"),
    resource = doc.addSimpleFont(font);
  for (let start = 0; start < Math.max(lines.length, 1); start += LINES) {
    // A running head, as a real page has: the first line of the body is
    // then never at the page's edge, where recurring lines are furniture.
    const content =
      `BT /F1 9 Tf 30 580 Td (Page ${start / LINES + 1}) Tj ET ` +
      "BT /F1 12 Tf 30 550 Td 18 TL " +
      lines
        .slice(start, start + LINES)
        .map(
          (line, i) =>
            (i ? "T* " : "") + "(" + line.replace(/[()\\]/g, "\\$&") + ") Tj",
        )
        .join("\n") +
      " ET";
    const page = doc.addPage(
      [0, 0, 600, 600],
      0,
      { Font: { F1: resource } },
      content,
    );
    doc.insertPage(-1, page);
    page.destroy();
  }
  const buffer = doc.saveToBuffer(""),
    result = new PdfDocument(buffer.asUint8Array());
  buffer.destroy();
  resource.destroy();
  font.destroy();
  doc.destroy();
  documents.push(result);
  return result;
}
// The engine's alignment needs only a build's document.
const build = (document: PdfDocument) => ({ document }) as unknown as Build;
function wrap(words: string[], width: number) {
  const lines: string[] = [];
  let line: string[] = [];
  for (const word of words) {
    if (line.length && [...line, word].join(" ").length > width) {
      lines.push(line.join(" "));
      line = [];
    }
    line.push(word);
  }
  if (line.length) lines.push(line.join(" "));
  return lines;
}
// A deterministic generator, so a failure names its seed.
function random(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}
const SENTENCES = [
  "A replicated state machine records commands in a durable log.",
  "Each replica applies committed commands in order.",
  "The invariant remains valid while leadership changes.",
  "Leaders append entries and followers acknowledge them.",
  "Terms increase monotonically across elections.",
];
// Every word of the pages' bodies in reading order, with where it prints.
function printed(document: PdfDocument) {
  const result: { text: string; page: number; rect: Rect }[] = [];
  for (let page = 0; page < document.length; page++)
    for (const word of [...document.page(page).words].sort(
      (a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0],
    ))
      if (word.rect[1] > BODY - 15)
        result.push({ text: word.text, page, rect: word.rect });
  return result;
}
const middle = (r: Rect) => (r[1] + r[3]) / 2;
const before = (w: { page: number; rect: Rect }, at: Position) =>
  w.page < at.page || (w.page === at.page && middle(w.rect) < at.clip[1]);
const after = (w: { page: number; rect: Rect }, at: Position) =>
  w.page > at.page || (w.page === at.page && middle(w.rect) > at.clip[3]);
const inside = (w: { page: number; rect: Rect }, crops: Position[]) =>
  crops.some((at) => at.page === w.page && containsCenter(at.clip, w.rect));
it.each(Array.from({ length: 120 }, (_, seed) => seed))(
  "marks exactly the changed words and cuts both crops at the same lines (seed %i)",
  (seed) => {
    const next = random(seed + 1),
      pick = <T>(list: T[]) => list[Math.floor(next() * list.length)];
    // Paragraphs of repeated sentences, so that lines and runs of words
    // recur; a paragraph rewraps up to its end and no further.
    const paragraphs = Array.from({ length: 6 + Math.floor(next() * 8) }, () =>
        Array.from({ length: 2 + Math.floor(next() * 3) }, () =>
          pick(SENTENCES),
        )
          .join(" ")
          .split(" "),
      ),
      changed = paragraphs.map((p) => [...p]),
      removed: string[] = [],
      added: string[] = [];
    // One edit, or two with at least two paragraphs between them: a line or
    // two of context between changes joins them into one region.
    const count = pick([1, 1, 2]),
      first = Math.floor(next() * (paragraphs.length - 3)),
      spots =
        count === 1
          ? [first]
          : [
              first,
              first + 3 + Math.floor(next() * (paragraphs.length - first - 3)),
            ];
    // Or, once in a while, the same words in a paragraph set narrower: a
    // change of layout alone, with nothing to mark.
    const narrow = new Set<number>(),
      relayout = count === 1 && next() < 0.2;
    for (const [k, p] of spots.entries()) {
      if (relayout) {
        narrow.add(p);
        continue;
      }
      const kind = pick(["insert", "delete", "replace", "replace"]),
        length = 1 + Math.floor(next() * 3),
        at = Math.floor(next() * (paragraphs[p].length - length)),
        // New words are unique, so the smallest difference is the edit itself.
        fresh = Array.from({ length }, (_, n) => `Zq${seed}x${k}y${n}`);
      if (kind === "insert") {
        changed[p].splice(at, 0, ...fresh);
        added.push(...fresh);
      } else if (kind === "delete") {
        // Deleting from a repeated text is ambiguous only in which copy
        // goes; a unique word keeps the expected marks exact.
        paragraphs[p].splice(
          at,
          length,
          ...fresh.map((w) => w.replace("Zq", "Yq")),
        );
        changed[p].splice(at, length);
        removed.push(...paragraphs[p].slice(at, at + length));
      } else {
        removed.push(...changed[p].splice(at, length, ...fresh));
        added.push(...fresh);
      }
    }
    const width = 50 + Math.floor(next() * 30),
      lines = (list: string[][], set: Set<number> = new Set()) =>
        list.flatMap((p, k) => [
          ...wrap(p, set.has(k) ? width - 14 : width),
          "",
        ]),
      words = paragraphs.flat(),
      edited = changed.flat(),
      old = pdf(lines(paragraphs)),
      neu = pdf(lines(changed, narrow)),
      al = alignment(build(old), build(neu))!;
    expect(al).toBeTruthy();
    // SyncTeX's crops: around the edit, each side grown or shrunk on its
    // own by up to three lines, as float placement or padding would.
    // SyncTeX's crops cover the edit, each side reaching on its own up to
    // three lines further, as float placement or padding would: one crop
    // per page from the first changed word to the last.
    const around = (
      doc: PdfDocument,
      words: string[],
      index: number,
      count: number,
    ) => {
      const all = printed(doc),
        first = all[Math.min(index, all.length - 1)],
        last = all[Math.min(index + Math.max(count, 1) - 1, all.length - 1)],
        reach = () => Math.floor(next() * 4) * 18;
      // Within the body, as SyncTeX's crops are.
      const top = Math.max(BODY, first.rect[1] - reach()),
        bottom = Math.min(END, last.rect[3] + reach());
      return Array.from({ length: last.page - first.page + 1 }, (_, k) => ({
        page: first.page + k,
        clip: [
          0,
          k === 0 ? top : BODY,
          600,
          first.page + k === last.page ? bottom : END,
        ] as Rect,
        label: "",
      }));
    };
    // One SyncTeX crop over the whole edit: from the first changed word to
    // the last, on each side.
    // For a change of layout, the paragraph that was set again.
    const span = (doc: PdfDocument, list: string[], other: string[]) => {
      if (relayout) {
        const p = spots[0],
          start = paragraphs.slice(0, p).flat().length;
        return around(doc, list, start, paragraphs[p].length);
      }
      let a = 0,
        b = 0;
      while (list[a] === other[a]) a++;
      while (list[list.length - 1 - b] === other[other.length - 1 - b]) b++;
      return around(doc, list, a, Math.max(0, list.length - b - a));
    };
    const groups = alignedCrops(
      al,
      span(old, words, edited),
      span(neu, edited, words),
      false,
    )!;
    expect(groups.length).toBe(count);
    const crops = {
      left: groups.flatMap((g) => g.left),
      right: groups.flatMap((g) => g.right),
    };
    expect(groups.every((g) => g.left.length && g.right.length)).toBe(true);
    const marked = (doc: PdfDocument, list: Position[], side: "old" | "new") =>
      printed(doc)
        .filter((w) =>
          list.some(
            (p) =>
              p.page === w.page &&
              marksIn(al, side, p).some((m) => containsCenter(m.rect, w.rect)),
          ),
        )
        .map((w) => w.text.replace(/[.,]$/, ""));
    const clean = (list: string[]) =>
      list.map((w) => w.replace(/[.,]$/, "")).sort();
    expect(marked(old, crops.left, "old").sort()).toEqual(clean(removed));
    expect(marked(neu, crops.right, "new").sort()).toEqual(clean(added));
    // The new document outside the crops, with each region's old crops in
    // its place, reads as the old document; with its new crops, as the new.
    const compose = (doc: PdfDocument, side: "left" | "right") => {
      const result: string[] = [],
        entered = new Set<number>();
      for (const w of printed(neu)) {
        const g = groups.findIndex((group) => inside(w, group.right));
        if (g < 0) result.push(w.text);
        else if (!entered.has(g)) {
          entered.add(g);
          // Faded words of an old crop are the context strips' to show.
          const faded = side === "left" ? (groups[g].faded ?? []) : [];
          result.push(
            ...printed(doc)
              .filter(
                (x) =>
                  inside(x, groups[g][side]) &&
                  !faded.some(
                    (f) => f.page === x.page && containsCenter(f.rect, x.rect),
                  ),
              )
              .map((x) => x.text),
          );
        }
      }
      return result.join(" ");
    };
    expect(compose(old, "left")).toBe(words.join(" "));
    expect(compose(neu, "right")).toBe(edited.join(" "));
  },
);
it("leaves text that no edit printed out of an edit's crops when it only moved", () => {
  // An edit inserts two lines; next to them, two lines that it did not
  // touch now come before a table instead of after it, as when a float
  // settles elsewhere. The words did not change and no edit printed them.
  const opening = Array.from(
      { length: 6 },
      (_, i) => `Opening line ${i} about consensus protocols and their logs`,
    ),
    table = Array.from(
      { length: 6 },
      (_, i) => `Table row ${i} lists command ${100 * i} and its comment`,
    ),
    moved = [
      "Your figures should contain a caption describing them",
      "Figure captions are placed below every figure here",
    ],
    inserted = [
      "Inserted sentence explains the title command fully",
      "and why breaks in titles are not allowed at all",
    ],
    closing = Array.from(
      { length: 6 },
      (_, i) => `Closing line ${i} restates the invariant for leaders`,
    ),
    old = pdf([...opening, ...table, ...moved, ...closing]),
    neu = pdf([...opening, ...inserted, ...moved, ...table, ...closing]),
    al = alignment(build(old), build(neu))!,
    words = printed(neu),
    of = (line: string) =>
      words
        .filter((w) => line.split(" ").includes(w.text))
        .filter((w) =>
          neu
            .page(w.page)
            .lines.some(
              (l) => l.text.trim() === line && containsCenter(l.rect, w.rect),
            ),
        ),
    // SyncTeX's crop of the edit reaches over the lines after it.
    box = [...inserted, ...moved].flatMap(of).map((w) => w.rect),
    right: Position[] = [
      {
        page: 0,
        clip: [
          0,
          Math.min(...box.map((r) => r[1])) - 2,
          600,
          Math.max(...box.map((r) => r[3])) + 2,
        ],
        label: "",
      },
    ],
    text = (i: number) => {
      const [a, b] = al.new.words.lines[i];
      return al.new.words.tokens
        .slice(a, b)
        .map((t) => t.text)
        .join(" ");
    },
    ours = (i: number) => (/Inserted|titles/.test(text(i)) ? true : undefined),
    shown = (mine?: Parameters<typeof alignedCrops>[4]) => {
      const crops = alignedCrops(al, [], right, false, mine)!.flatMap(
        (g) => g.right,
      );
      return (line: string) => of(line).every((w) => inside(w, crops));
    };
  const owned = shown({ old: () => undefined, new: ours });
  expect(inserted.every(owned)).toBe(true);
  expect(owned(moved[1])).toBe(false);
  // Without knowing who printed what, every moved line counts.
  expect(shown()(moved[1])).toBe(true);
});
// A PDF of rows, each printed as pieces at the x positions given, as an
// inline formula prints apart from the words around it.
function rows(list: [number, string][][]) {
  const doc = new mupdf.PDFDocument(),
    font = new mupdf.Font("Helvetica"),
    resource = doc.addSimpleFont(font),
    content = list
      .flatMap((row, i) =>
        row.map(
          ([x, text]) =>
            `BT /F1 12 Tf ${x} ${550 - 18 * i} Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`,
        ),
      )
      .join("\n"),
    page = doc.addPage(
      [0, 0, 600, 600],
      0,
      { Font: { F1: resource } },
      content,
    );
  doc.insertPage(-1, page);
  page.destroy();
  const buffer = doc.saveToBuffer(""),
    result = new PdfDocument(buffer.asUint8Array());
  buffer.destroy();
  resource.destroy();
  font.destroy();
  doc.destroy();
  documents.push(result);
  return result;
}
it("fades the words before a change that print on its row as other pieces", () => {
  const around = (n: number) =>
      Array.from({ length: 6 }, (_, i): [number, string][] => [
        [30, `Steady line ${n + i} about logs and replicas of the state`],
      ]),
    row = (last: string): [number, string][] => [
      [30, "Context words before"],
      [250, "the formula"],
      [400, last],
    ],
    old = rows([...around(0), row("alpha omega."), ...around(10)]),
    neu = rows([...around(0), row("alpha sigma."), ...around(10)]),
    al = alignment(build(old), build(neu))!,
    at = (doc: PdfDocument, text: string): Position[] => {
      const word = printed(doc).find((w) => w.text === text)!;
      return [
        {
          page: 0,
          clip: [0, word.rect[1] - 1, 600, word.rect[3] + 1],
          label: "",
        },
      ];
    },
    [group] = alignedCrops(al, at(old, "omega."), at(neu, "sigma."), false)!;
  // The old crop holds the whole row; the words before the change fade.
  const faded = (text: string) =>
    printed(old)
      .filter((w) => w.text === text)
      .every((w) =>
        (group.faded ?? []).some(
          (f) => f.page === w.page && containsCenter(f.rect, w.rect),
        ),
      );
  expect(
    inside(
      printed(old).find((w) => w.text === "Context")!,
      group.left,
    ),
  ).toBe(true);
  for (const word of ["Context", "words", "before", "formula"])
    expect(faded(word)).toBe(true);
  expect(faded("omega.")).toBe(false);
});
it("takes a page for two columns only when most of its prose is in columns", () => {
  const prose = "Replicas apply committed commands in their order";
  // One column, with two displays set side by side.
  const one = rows([
    ...Array.from({ length: 12 }, (): [number, string][] => [
      [30, `${prose} and the leader keeps the log`],
    ]),
    ...Array.from({ length: 4 }, (): [number, string][] => [
      [30, prose],
      [330, prose],
    ]),
  ]);
  // Two columns from top to bottom.
  const two = rows(
    Array.from({ length: 20 }, (): [number, string][] => [
      [30, prose],
      [330, prose],
    ]),
  );
  expect(one.page(0).twoColumns).toBe(false);
  expect(two.page(0).twoColumns).toBe(true);
});
