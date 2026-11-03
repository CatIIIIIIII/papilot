import type * as Mupdf from 'mupdf';
import { GROUP_COLORS, canonicalGroup, type NoteGroup } from '../note-groups.ts';

type Rect = [number, number, number, number];
// A note as the export draws it. Rectangles are fractions of the page, as the
// PDF view stores them; a note without rects marks a region.
export interface ExportNote { page: number; rect: Rect; rects?: Rect[]; comment: string; group?: NoteGroup; review?: boolean; author?: string }

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255) as Rgb;
const PANEL = rgb('#f7f6f3'), DIVIDER = rgb('#e4e1da'), CARD = rgb('#ffffff'), CARD_LINE = rgb('#e2dfd8');
const TEXT = rgb('#1c1c1c'), AUTHOR = rgb('#6b6b6b');
// The PDF view's colours: blue for a personal note, amber for an AI finding,
// and each colour group's own swatch, with dark ink on yellow.
function colors(note: ExportNote) {
  if (note.group) {
    const group = canonicalGroup(note.group), color = rgb(GROUP_COLORS[group]);
    return { mark: color, tag: color, ink: rgb(group === 'yellow' ? '#422f00' : '#ffffff') };
  }
  if (note.review) return { mark: rgb('#d97706'), tag: rgb('#92400e'), ink: rgb('#ffffff') };
  return { mark: rgb('#2563eb'), tag: rgb('#2563eb'), ink: rgb('#ffffff') };
}

// Latin, Greek and Cyrillic set in Nimbus Sans; anything it lacks (Chinese,
// Japanese, Korean, most symbols) falls back to MuPDF's Droid Sans Fallback.
type Style = 'regular' | 'bold';
const FONT_NAMES: Record<Style | 'cjk', string> = { regular: 'Helvetica', bold: 'Helvetica-Bold', cjk: 'zh-Hans' };
const RESOURCE: Record<Style | 'cjk', string> = { regular: 'PplR', bold: 'PplB', cjk: 'PplC' };
interface Run { font: Style | 'cjk'; gids: number[]; width: number }

class Type {
  private fonts = new Map<Style | 'cjk', Mupdf.Font>();
  readonly used = new Map<Style | 'cjk', Set<number>>();
  private advances = new Map<string, { font: Style | 'cjk'; gid: number; advance: number } | null>();
  constructor(private mupdf: typeof Mupdf) {}
  font(kind: Style | 'cjk') {
    let font = this.fonts.get(kind);
    if (!font) { font = new this.mupdf.Font(FONT_NAMES[kind]); this.fonts.set(kind, font); }
    return font;
  }
  private glyph(char: string, style: Style) {
    const key = style + char;
    if (!this.advances.has(key)) {
      const code = char.codePointAt(0)!;
      let found: { font: Style | 'cjk'; gid: number; advance: number } | null = null;
      for (const kind of [style, 'cjk'] as const) {
        const font = this.font(kind), gid = font.encodeCharacter(code);
        if (gid > 0) { found = { font: kind, gid, advance: font.advanceGlyph(gid) }; break; }
      }
      this.advances.set(key, found);
    }
    return this.advances.get(key)!;
  }
  // The glyph runs for a line, one per font, with widths in points.
  runs(text: string, style: Style, size: number): Run[] {
    const runs: Run[] = [];
    for (const char of text) {
      const glyph = this.glyph(char, style) || this.glyph('?', style);
      if (!glyph) continue;
      let run = runs[runs.length - 1];
      if (!run || run.font !== glyph.font) { run = { font: glyph.font, gids: [], width: 0 }; runs.push(run); }
      run.gids.push(glyph.gid); run.width += glyph.advance * size;
    }
    return runs;
  }
  width(text: string, style: Style, size: number) { return this.runs(text, style, size).reduce((sum, run) => sum + run.width, 0); }
  // Wraps at spaces, and between any two CJK characters, keeping closing
  // punctuation on its line. Text past maxLines ends with an ellipsis.
  wrap(text: string, style: Style, size: number, width: number, maxLines = Infinity) {
    const lines: string[] = [];
    for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
      const tokens: string[] = [];
      for (const char of paragraph) {
        const last = tokens[tokens.length - 1];
        if (/\s/.test(char)) { if (last !== ' ') tokens.push(' '); }
        else if (WIDE.test(char)) tokens.push(char);
        else if (CLOSING.test(char) && last && last !== ' ') tokens[tokens.length - 1] += char;
        else if (last && last !== ' ' && !WIDE.test(last.slice(-1))) tokens[tokens.length - 1] += char;
        else tokens.push(char);
      }
      let line = '';
      const push = () => { lines.push(line.trimEnd()); line = ''; };
      for (const token of tokens) {
        if (token === ' ') { if (line) line += ' '; continue; }
        if (this.width(line + token, style, size) <= width) { line += token; continue; }
        if (line.trim()) push();
        // A word wider than the card breaks between letters.
        for (const char of token) {
          if (line && this.width(line + char, style, size) > width) push();
          line += char;
        }
      }
      if (line.trim() || !lines.length || paragraph.trim()) push();
    }
    while (lines.length > 1 && !lines[lines.length - 1]) lines.pop();
    if (lines.length <= maxLines) return lines;
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1].trimEnd();
    while (last && this.width(last + '…', style, size) > width) last = [...last].slice(0, -1).join('').trimEnd();
    kept[maxLines - 1] = last + '…';
    return kept;
  }
  record(runs: Run[]) {
    for (const run of runs) {
      let set = this.used.get(run.font);
      if (!set) { set = new Set(); this.used.set(run.font, set); }
      for (const gid of run.gids) set.add(gid);
    }
  }
}
const WIDE = /[ᄀ-ᇿ⺀-⿿　-ヿ㄀-ㇿ㈀-鿿가-힯豈-﫿︰-﹏＀-￯]/u;
const CLOSING = /[，。、！？；：）」』】〉》”’,.!?;:)\]}%]/u;

// Content stream drawing in MuPDF's page space: points, origin at the page's
// top-left corner, y growing downward.
class Canvas {
  private ops: string[] = [];
  private state = '';
  constructor(private type: Type) {}
  private n = (value: number) => (Math.round(value * 1000) / 1000).toString();
  private fill(color: Rgb) { this.ops.push(`${color.map(this.n).join(' ')} rg`); }
  private stroke(color: Rgb) { this.ops.push(`${color.map(this.n).join(' ')} RG`); }
  gs(name: string) { if (this.state !== name) { this.ops.push(`/${name} gs`); this.state = name; } }
  rect(x: number, y: number, w: number, h: number, color: Rgb) { this.fill(color); this.ops.push(`${this.n(x)} ${this.n(y)} ${this.n(w)} ${this.n(h)} re f`); }
  private rounded(x: number, y: number, w: number, h: number, r: number) {
    r = Math.min(r, w / 2, h / 2);
    const k = r * 0.4477, n = this.n;
    this.ops.push(`${n(x + r)} ${n(y)} m ${n(x + w - r)} ${n(y)} l ${n(x + w - k)} ${n(y)} ${n(x + w)} ${n(y + k)} ${n(x + w)} ${n(y + r)} c`
      + ` ${n(x + w)} ${n(y + h - r)} l ${n(x + w)} ${n(y + h - k)} ${n(x + w - k)} ${n(y + h)} ${n(x + w - r)} ${n(y + h)} c`
      + ` ${n(x + r)} ${n(y + h)} l ${n(x + k)} ${n(y + h)} ${n(x)} ${n(y + h - k)} ${n(x)} ${n(y + h - r)} c`
      + ` ${n(x)} ${n(y + r)} l ${n(x)} ${n(y + k)} ${n(x + k)} ${n(y)} ${n(x + r)} ${n(y)} c h`);
  }
  roundRect(x: number, y: number, w: number, h: number, r: number, fill: Rgb | null, line?: { color: Rgb; width: number }) {
    this.rounded(x, y, w, h, r);
    if (fill) this.fill(fill);
    if (line) { this.stroke(line.color); this.ops.push(`${this.n(line.width)} w`); }
    this.ops.push(fill && line ? 'B' : fill ? 'f' : 'S');
  }
  line(points: [number, number][], color: Rgb, width: number, curve = false) {
    this.stroke(color); this.ops.push(`${this.n(width)} w 1 J`);
    const [[x0, y0], ...rest] = points;
    let path = `${this.n(x0)} ${this.n(y0)} m`;
    if (curve && rest.length === 3) path += ` ${rest.flat().map(this.n).join(' ')} c`;
    else for (const [x, y] of rest) path += ` ${this.n(x)} ${this.n(y)} l`;
    this.ops.push(path + ' S');
  }
  text(text: string, x: number, baseline: number, style: Style, size: number, color: Rgb) {
    const runs = this.type.runs(text, style, size);
    this.type.record(runs);
    this.fill(color);
    this.ops.push(`BT 1 0 0 -1 ${this.n(x)} ${this.n(baseline)} Tm`);
    for (const run of runs) this.ops.push(`/${RESOURCE[run.font]} ${this.n(size)} Tf <${run.gids.map(gid => gid.toString(16).padStart(4, '0')).join('')}> Tj`);
    this.ops.push('ET');
  }
  // A number in a pill, centred on (x, y).
  badge(label: string, x: number, y: number, size: number, fill: Rgb, ink: Rgb) {
    const font = size * 0.6, width = Math.max(size, this.type.width(label, 'bold', font) + size * 0.62);
    this.roundRect(x - width / 2, y - size / 2, width, size, size / 2, fill);
    this.text(label, x - this.type.width(label, 'bold', font) / 2, y + font * 0.355, 'bold', font, ink);
    return width;
  }
  toString() { return this.ops.join('\n'); }
}

interface Card { note: ExportNote; number: number; anchor: number; colors: ReturnType<typeof colors>; comment: string[]; author: string; top: number; height: number; cut: boolean }

// Card typography, in points. The badge sits on the card's first row, the
// author's name when there is one.
const PAD = 7, COMMENT = 8.6, LEADING = 11.6, AUTHOR_SIZE = 7.4, GAP = 6, BADGE = 12, MAX_LINES = 24;
const cardHeight = (lines: number, author: boolean) => PAD * 2 + ((author ? 1 : 0) + lines) * LEADING;

// Cards sit beside their marks, pushed apart where they would overlap and
// shortened, longest first, when a page has more comments than its margin can
// hold. Shortened comments are printed in full at the end of the document.
function layout(cards: Card[], top: number, bottom: number, type: Type, textWidth: number) {
  const fits = () => cards.reduce((sum, card) => sum + card.height, 0) + GAP * Math.max(0, cards.length - 1) <= bottom - top;
  while (!fits()) {
    const longest = cards.reduce((a, b) => b.comment.length > a.comment.length ? b : a);
    if (longest.comment.length <= 1) break;
    longest.comment = type.wrap(longest.note.comment.trim(), 'regular', COMMENT, textWidth, longest.comment.length - 1);
    longest.height = cardHeight(longest.comment.length, Boolean(longest.author));
    longest.cut = true;
  }
  let next = top;
  for (const card of cards) { card.top = Math.max(card.anchor - PAD - LEADING / 2, next); next = card.top + card.height + GAP; }
  let limit = bottom;
  for (const card of [...cards].reverse()) { card.top = Math.max(top, Math.min(card.top, limit - card.height)); limit = card.top - GAP; }
}

type Matrix = [number, number, number, number, number, number];
const apply = (m: Matrix | number[], x: number, y: number) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
const bounds = (m: Matrix | number[], [x0, y0, x1, y1]: number[]) => {
  const points = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)];
  return [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))] as Rect;
};
const multiply = (a: number[], b: number[]): Matrix => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];

// Returns a copy of the PDF with every note drawn on its page: marks over the
// text, and the comment in a numbered card in a panel added to the right of
// the page, joined to its mark's height. Links, bookmarks and text stay as
// they were; notes without a comment are drawn as marks only. The marks show
// what each comment is about, so cards do not repeat the quote.
export function annotatePdf(mupdf: typeof Mupdf, input: Uint8Array, notes: ExportNote[]) {
  const pdf = new mupdf.PDFDocument(input), type = new Type(mupdf);
  try {
    const count = pdf.countPages();
    const placed = notes.filter(note => Number.isInteger(note.page) && note.page >= 0 && note.page < count);
    if (!placed.length) return input;
    const first = (note: ExportNote) => (note.rects?.length ? note.rects : [note.rect])[0];
    const middle = (note: ExportNote) => (first(note)[1] + first(note)[3]) / 2;
    // Numbers follow reading order: page, then line, then left to right.
    const commented = placed.filter(note => note.comment.trim()).sort((a, b) => a.page - b.page || (Math.abs(middle(a) - middle(b)) > 0.006 ? middle(a) - middle(b) : first(a)[0] - first(b)[0]));
    const numbers = new Map(commented.map((note, index) => [note, index + 1]));
    const pages = new Map<number, ExportNote[]>();
    for (const note of placed) pages.set(note.page, [...(pages.get(note.page) || []), note]);
    // Every page gets the same panel so the pages stay one width in a viewer.
    const firstPage = pdf.loadPage(0), [fx0, fy0, fx1, fy1] = firstPage.getBounds();
    firstPage.destroy();
    const panel = Math.round(Math.min(300, Math.max(210, (fx1 - fx0) * 0.4)));
    const states = { mark: 'PplMark', box: 'PplBox', link: 'PplLink', solid: 'PplSolid' };

    // Draw every page's marks and cards.
    const drawn: { index: number; canvas: Canvas; toPdf: Matrix; box: Rect; cut: { card: Card; rect: Rect }[] }[] = [];
    for (let index = 0; index < count; index++) {
      const page = pdf.loadPage(index), [x0, y0, x1, y1] = page.getBounds(), w = x1 - x0, h = y1 - y0;
      const ctm = mupdf.Matrix.invert(page.getTransform());
      page.destroy();
      const canvas = new Canvas(type);
      canvas.gs(states.solid);
      canvas.rect(w, 0, panel, h, PANEL);
      canvas.rect(w, 0, 0.6, h, DIVIDER);
      const list = pages.get(index) || [];
      // Marks first, under every tag and line.
      for (const note of list) {
        const color = colors(note).mark;
        if (note.rects?.length) {
          canvas.gs(states.mark);
          for (const [a, b, c, d] of note.rects) canvas.rect(a * w, b * h - 0.4, (c - a) * w, (d - b) * h + 0.8, color);
        } else {
          const [a, b, c, d] = note.rect;
          canvas.gs(states.box); canvas.roundRect(a * w, b * h, (c - a) * w, (d - b) * h, 2.5, color);
          canvas.gs(states.solid); canvas.roundRect(a * w, b * h, (c - a) * w, (d - b) * h, 2.5, null, { color, width: 1.1 });
        }
      }
      const cardX = w + 20, cardWidth = panel - 32, textX = cardX + PAD + BADGE + 5, textWidth = cardX + cardWidth - PAD - textX;
      const cards: Card[] = list.filter(note => numbers.has(note)).sort((a, b) => numbers.get(a)! - numbers.get(b)!).map(note => {
        // A text mark's card meets its first line; a region's meets its top edge.
        const [, top, , bottom] = first(note), anchor = note.rects?.length ? (top + bottom) / 2 * h : Math.min((top + bottom) / 2 * h, top * h + 9);
        const all = type.wrap(note.comment.trim(), 'regular', COMMENT, textWidth), comment = all.length > MAX_LINES ? type.wrap(note.comment.trim(), 'regular', COMMENT, textWidth, MAX_LINES) : all;
        const author = note.author?.trim() || '';
        return { note, number: numbers.get(note)!, anchor, colors: colors(note), author, comment, top: 0, height: cardHeight(comment.length, Boolean(author)), cut: all.length > MAX_LINES };
      });
      layout(cards, 16, h - 16, type, textWidth);
      // A dot on the margin's edge at the mark's height, joined to its card;
      // the number appears once, on the card.
      for (const card of cards) {
        const badgeY = card.top + PAD + LEADING / 2, to = cardX;
        canvas.gs(states.link);
        canvas.line([[w, card.anchor], [w + (to - w) * 0.55, card.anchor], [to - (to - w) * 0.45, badgeY], [to, badgeY]], card.colors.tag, 0.7, true);
        canvas.gs(states.solid);
        canvas.roundRect(w - 2.2, card.anchor - 2.2, 4.4, 4.4, 2.2, card.colors.tag);
      }
      for (const card of cards) {
        canvas.roundRect(cardX, card.top, cardWidth, card.height, 5, CARD, { color: CARD_LINE, width: 0.6 });
        let y = card.top + PAD;
        canvas.badge(String(card.number), cardX + PAD + BADGE / 2, y + LEADING / 2, BADGE, card.colors.tag, card.colors.ink);
        if (card.author) { canvas.text(card.author, textX, y + LEADING / 2 + AUTHOR_SIZE * 0.355, 'bold', AUTHOR_SIZE, AUTHOR); y += LEADING; }
        for (const line of card.comment) { canvas.text(line, textX, y + LEADING / 2 + COMMENT * 0.355, 'regular', COMMENT, TEXT); y += LEADING; }
      }
      // Drawing happens from the page's top-left corner; toPdf takes it to PDF
      // space, whatever the page's rotation and origin.
      const toPdf = multiply([1, 0, 0, 1, x0, y0], ctm);
      drawn.push({ index, canvas, toPdf, box: bounds(toPdf, [0, 0, w + panel, h]), cut: cards.filter(card => card.cut).map(card => ({ card, rect: [cardX, card.top, cardX + cardWidth, card.top + card.height] as Rect })) });
    }

    // Comments shortened in the margin, in full, on pages after the paper.
    const cut = drawn.flatMap(page => page.cut.map(entry => ({ ...entry, page: page.index })));
    const extra: { canvas: Canvas; links: { rect: Rect; page: number; y: number }[] }[] = [];
    const targets = new Map<Card, { page: number; y: number }>();
    if (cut.length) {
      const pageWidth = fx1 - fx0 + panel, pageHeight = fy1 - fy0, width = Math.min(440, pageWidth - 96), left = (pageWidth - width) / 2;
      const textX = left + PAD + BADGE + 5;
      let sheet: (typeof extra)[number] | undefined, y = 0;
      const open = () => { sheet = { canvas: new Canvas(type), links: [] }; sheet.canvas.gs(states.solid); sheet.canvas.rect(0, 0, pageWidth, pageHeight, PANEL); extra.push(sheet); y = 56; };
      for (const { card, page } of cut) {
        // Where the note is, at the end of the first row: a page glyph and the
        // page's number. The whole row links back to the mark.
        const label = String(page + 1), chip = 9 + type.width(label, 'bold', AUTHOR_SIZE), textWidth = left + width - PAD - chip - 10 - textX;
        let lines = type.wrap(card.note.comment.trim(), 'regular', COMMENT, textWidth), head = true;
        while (lines.length) {
          const author = head && Boolean(card.author);
          if (!sheet || y + cardHeight(Math.min(lines.length, 3), author) > pageHeight - 56) open();
          const room = Math.floor((pageHeight - 56 - y - PAD * 2) / LEADING) - (author ? 1 : 0);
          const part = lines.slice(0, Math.max(1, room)), height = cardHeight(part.length, author);
          const canvas = sheet!.canvas;
          canvas.roundRect(left, y, width, height, 5, CARD, { color: CARD_LINE, width: 0.6 });
          let row = y + PAD;
          if (head) {
            targets.set(card, { page: count + extra.length - 1, y });
            canvas.badge(String(card.number), left + PAD + BADGE / 2, row + LEADING / 2, BADGE, card.colors.tag, card.colors.ink);
            const end = left + width - PAD;
            canvas.roundRect(end - chip, row + LEADING / 2 - 4, 6, 8, 1, null, { color: AUTHOR, width: 0.7 });
            canvas.text(label, end - chip + 9, row + LEADING / 2 + AUTHOR_SIZE * 0.355, 'bold', AUTHOR_SIZE, AUTHOR);
            sheet!.links.push({ rect: [left, y, left + width, y + height], page, y: card.anchor });
            if (card.author) { canvas.text(card.author, textX, row + LEADING / 2 + AUTHOR_SIZE * 0.355, 'bold', AUTHOR_SIZE, AUTHOR); row += LEADING; }
          }
          for (const line of part) { canvas.text(line, textX, row + LEADING / 2 + COMMENT * 0.355, 'regular', COMMENT, TEXT); row += LEADING; }
          y += height + GAP; lines = lines.slice(part.length); head = false;
        }
      }
    }

    // Our fonts, cut down to the glyphs we used in a scratch document so the
    // paper's own fonts are never rewritten.
    const scratch = new mupdf.PDFDocument(), fonts = new Map<Style | 'cjk', Mupdf.PDFObject>();
    try {
      const resources = scratch.newDictionary(), fontDict = scratch.newDictionary();
      resources.put('Font', fontDict);
      let content = 'BT\n';
      for (const [kind, gids] of type.used) {
        fontDict.put(RESOURCE[kind], scratch.addFont(type.font(kind)));
        content += `/${RESOURCE[kind]} 10 Tf <${[...gids].map(gid => gid.toString(16).padStart(4, '0')).join('')}> Tj\n`;
      }
      scratch.insertPage(-1, scratch.addPage([0, 0, 100, 100], 0, resources, content + 'ET\n'));
      scratch.subsetFonts();
      for (const kind of type.used.keys()) fonts.set(kind, pdf.graftObject(fontDict.get(RESOURCE[kind])));
    } finally { scratch.destroy(); }
    const graphics = new Map<string, Mupdf.PDFObject>();
    const state = (name: string, entries: Record<string, number | string>) => {
      const dict = pdf.newDictionary(); dict.put('Type', pdf.newName('ExtGState'));
      for (const [key, value] of Object.entries(entries)) dict.put(key, typeof value === 'string' ? pdf.newName(value) : value);
      graphics.set(name, pdf.addObject(dict));
    };
    state(states.mark, { ca: 0.3, BM: 'Multiply' });
    state(states.box, { ca: 0.1, BM: 'Multiply' });
    state(states.link, { CA: 0.65, ca: 1 });
    state(states.solid, { CA: 1, ca: 1, BM: 'Normal' });
    const addResources = (resources: Mupdf.PDFObject) => {
      const entry = (key: string) => {
        let dict = resources.get(key);
        if (!dict.isDictionary()) { dict = pdf.newDictionary(); resources.put(key, dict); }
        return dict;
      };
      const fontDict = entry('Font'), stateDict = entry('ExtGState');
      for (const [kind, ref] of fonts) fontDict.put(RESOURCE[kind], ref);
      for (const [name, ref] of graphics) stateDict.put(name, ref);
    };
    const matrix = (m: number[]) => m.map(n => Math.round(n * 10000) / 10000).join(' ');

    for (const { index, canvas, toPdf, box } of drawn) {
      const page = pdf.loadPage(index), object = page.getObject();
      // Grow the page to the right, in whichever PDF direction that is after rotation.
      const array = () => { const value = pdf.newArray(); for (const n of box) value.push(n); return value; };
      object.put('MediaBox', array());
      object.put('CropBox', array());
      for (const key of ['TrimBox', 'BleedBox', 'ArtBox']) object.delete(key);
      let resources = object.getInheritable('Resources');
      if (resources.isNull()) { resources = pdf.newDictionary(); object.put('Resources', resources); }
      addResources(resources);
      // Isolate the original page in q … Q, whatever state it leaves behind.
      const contents = pdf.newArray(), old = object.get('Contents');
      contents.push(pdf.addStream('q\n', pdf.newDictionary()));
      if (old.isArray()) old.forEach(item => contents.push(item)); else if (!old.isNull()) contents.push(old);
      contents.push(pdf.addStream(`Q\nq ${matrix(toPdf)} cm\n${canvas}\nQ\n`, pdf.newDictionary()));
      object.put('Contents', contents);
      page.destroy();
    }
    for (const sheet of extra) {
      const resources = pdf.newDictionary();
      addResources(resources);
      const height = fy1 - fy0;
      pdf.insertPage(-1, pdf.addPage([0, 0, fx1 - fx0 + panel, height], 0, resources, `q 1 0 0 -1 0 ${height} cm\n${sheet.canvas}\nQ\n`));
    }
    // Links between a shortened card and its full text, both ways. A link's
    // area and destination are in the page's own space, after any rotation.
    const drawing = (index: number) => index < count ? drawn[index].toPdf : [1, 0, 0, -1, 0, fy1 - fy0];
    const link = (from: number, rect: Rect, to: number, y: number) => {
      const source = pdf.loadPage(from), destination = pdf.loadPage(to);
      try {
        const area = bounds(source.getTransform(), bounds(drawing(from), rect));
        const [, top] = apply(destination.getTransform(), ...apply(drawing(to), 0, Math.max(0, y - 24)) as [number, number]);
        source.createLink(area, pdf.formatLinkURI({ type: 'XYZ', page: to, x: NaN, y: top, width: 0, height: 0, zoom: NaN, chapter: 0 }));
      } finally { source.destroy(); destination.destroy(); }
    };
    for (const { card, page, rect } of cut) {
      const full = targets.get(card);
      if (full) link(page, rect, full.page, full.y);
    }
    extra.forEach((sheet, offset) => { for (const entry of sheet.links) link(count + offset, entry.rect, entry.page, entry.y); });
    return pdf.saveToBuffer('compress,garbage=compact,objstms').asUint8Array();
  } finally { pdf.destroy(); }
}
