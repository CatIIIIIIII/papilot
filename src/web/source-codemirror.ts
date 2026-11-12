import { Compartment, EditorState, RangeSet, StateEffect, StateField, Text, type Extension } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, drawSelection, gutter, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { HighlightStyle, StreamLanguage, bracketMatching, syntaxHighlighting } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Chunk } from '@codemirror/merge';
import { tags } from '@lezer/highlight';

// The LaTeX editor of the manuscript's source tab, loaded when a source is
// first opened. It shows the whole file, with bars beside the lines that
// changed since the last commit and their places along the scrollbar. In a
// task, it also shows the review's changes in the text, each with Accept and
// Reject, as an editor shows an agent's edits.

export type ChangeKind = 'added' | 'modified' | 'deleted';
export interface SourceEditorOptions {
  parent: HTMLElement; label: string;
  onChange: () => void; onSave: () => void;
  /** Escape outside the search panel; returns whether it was used. */
  onEscape: () => boolean;
  /** The main cursor moved to another line (0-based) by the author. */
  onCursor?: (line: number) => void;
  /** A change bar was clicked, at a line (0-based) of its change. */
  onChangeBar?: (line: number) => void;
  /** An action of a review card shown in the text was pressed, for its changes. */
  onDecide?: (changes: string[], action: string) => void;
}

const latex = StreamLanguage.define(stex);
// The colours of the review's LaTeX, for light and dark pages.
const highlight = HighlightStyle.define([
  { tag: tags.tagName, color: 'var(--latex-command)' },
  { tag: tags.keyword, color: 'var(--latex-math)' },
  { tag: tags.number, color: 'var(--latex-math)' },
  { tag: tags.bracket, color: 'var(--latex-bracket)' },
  { tag: tags.atom, color: 'var(--latex-parameter)' },
  { tag: tags.comment, color: 'var(--latex-comment)', fontStyle: 'italic' },
  { tag: tags.invalid, color: 'var(--danger)' },
]);
const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', color: 'var(--text)', backgroundColor: 'var(--bg)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.7' },
  '.cm-content': { padding: '6px 0 40vh', caretColor: 'var(--text)' },
  '.cm-line': { padding: '0 16px 0 10px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)', borderLeftWidth: '1.5px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--text-3)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '34px', padding: '0 6px 0 10px', fontSize: '11.5px', fontVariantNumeric: 'tabular-nums' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--text) 4%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--accent) 18%, transparent)', outline: 'none' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--amber, #d79b00) 28%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--amber, #d79b00) 55%, transparent)' },
  '.cm-panels': { backgroundColor: 'var(--bg-subtle)', color: 'var(--text)', borderColor: 'var(--line)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
  '.cm-panel.cm-search': { padding: '6px 10px', fontFamily: 'var(--sans)', fontSize: '12.5px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontFamily: 'var(--sans)', fontSize: '12.5px' },
  '.cm-textfield': { border: '1px solid var(--line)', borderRadius: '6px', backgroundColor: 'var(--bg)', color: 'var(--text)', padding: '3px 6px' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--bg)', border: '1px solid var(--line)', borderRadius: '6px', color: 'var(--text)', padding: '3px 8px' },
  // The lines a click on the PDF named, and lines shown briefly.
  '.cm-source-focus': { backgroundColor: 'color-mix(in srgb, var(--accent) 12%, transparent)' },
  '.cm-source-word': { backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent)', borderRadius: '2px' },
  // What changed since the last commit, beside the line numbers and along the scrollbar.
  // A review's changes in the text, a block per card, as on the PDF: the
  // header, then the lines before and after, whose text starts where the
  // editor's lines do; the changed words stand out of their line's tint.
  '.cm-review-card': { marginTop: '6px', fontFamily: 'var(--sans)' },
  '.cm-review-head': { display: 'flex', alignItems: 'center', gap: '8px', height: '30px', padding: '0 4px 0 9px', borderRadius: '6px 6px 0 0', backgroundColor: 'var(--bg-muted)', fontSize: '12.5px', fontWeight: '500', color: 'var(--text)' },
  '.cm-review-title': { flex: '1' },
  '.cm-review-buttons': { display: 'flex', gap: '2px' },
  '.cm-review-buttons > button': { display: 'grid', placeItems: 'center', width: '26px', height: '24px', padding: '0', border: '0', borderRadius: '5px', backgroundColor: 'transparent', cursor: 'pointer' },
  '.cm-review-buttons > button:hover:not(:disabled)': { backgroundColor: 'var(--bg-hover)' },
  '.cm-review-buttons > button:disabled': { opacity: '0.4', cursor: 'default' },
  '.cm-review-buttons svg': { width: '15px', height: '15px' },
  '.cm-review-accept': { color: 'var(--green)' },
  '.cm-review-reject': { color: 'var(--danger)' },
  '.cm-review-comment': { color: 'var(--accent)' },
  '.cm-review-before': { position: 'relative', margin: '0', padding: '0 64px 0 6px', borderLeft: '3px solid color-mix(in srgb, var(--danger) 60%, transparent)', backgroundColor: 'color-mix(in srgb, var(--danger) 6%, var(--bg))', fontFamily: 'var(--mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere', color: 'var(--text-2)' },
  '.cm-line.cm-review-after': { position: 'relative', padding: '0 64px 0 6px', borderLeft: '3px solid color-mix(in srgb, var(--green) 60%, transparent)', backgroundColor: 'color-mix(in srgb, var(--green) 7%, var(--bg))' },
  // The labels use ::before: a flash of the line draws with ::after.
  '.cm-review-before::before, .cm-review-after::before': { content: 'attr(data-label)', position: 'absolute', top: '0', right: '8px', fontFamily: 'var(--sans)', fontSize: '11px', letterSpacing: '.04em', textTransform: 'uppercase' },
  '.cm-review-before::before': { color: 'var(--danger)' },
  '.cm-review-after::before': { color: 'var(--green)' },
  '.cm-review-removed': { backgroundColor: 'color-mix(in srgb, var(--danger) 16%, transparent)', color: 'var(--danger)', textDecoration: 'line-through', textDecorationColor: 'color-mix(in srgb, var(--danger) 60%, transparent)', borderRadius: '2px' },
  '.cm-review-added': { backgroundColor: 'color-mix(in srgb, var(--green) 20%, transparent)', borderRadius: '2px' },
  '.cm-change-ruler': { position: 'absolute', top: '0', right: '0', bottom: '0', zIndex: '3', pointerEvents: 'none' },
  '.cm-ruler-mark': { position: 'absolute', left: '1px', right: '1px', borderRadius: '1px' },
  '.cm-ruler-added': { backgroundColor: 'var(--green, #2f9e44)' },
  '.cm-ruler-modified': { backgroundColor: 'var(--accent)' },
  '.cm-ruler-deleted': { backgroundColor: 'var(--danger)' },
  '.cm-change-bars': { width: '6px', marginRight: '2px' },
  '.cm-change-bars .cm-gutterElement': { position: 'relative', padding: '0', cursor: 'pointer' },
  '.cm-change-bar': { position: 'absolute', top: '0', bottom: '0', left: '1px', right: '1px' },
  '.cm-change-first': { top: '1px', borderTopLeftRadius: '1px', borderTopRightRadius: '1px' },
  '.cm-change-last': { bottom: '1px', borderBottomLeftRadius: '1px', borderBottomRightRadius: '1px' },
  '.cm-change-added': { backgroundColor: 'var(--green, #2f9e44)' },
  '.cm-change-modified': { backgroundColor: 'var(--accent)' },
  // A deletion has no lines left: a short mark where they were.
  '.cm-change-deleted': { top: '-1.5px', bottom: 'auto', height: '3px', backgroundColor: 'var(--danger)' },
});

// The focus: lines named by a click on the PDF or a change in the Changes
// view, and within them the words picked on the PDF, until the text is edited.
const setFocus = StateEffect.define<{ lines: [number, number][]; word?: [number, number] }>();
const focusField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setFocus)) {
      const doc = tr.state.doc, lines = new Set<number>(), word = effect.value.word;
      for (const [from, to] of effect.value.lines) for (let line = from; line < Math.max(to, from + 1) && line < doc.lines; line++) lines.add(line);
      const marks = [...lines].sort((a, b) => a - b).map(line => Decoration.line({ class: 'cm-source-focus' }).range(doc.line(line + 1).from));
      if (word && word[1] > word[0] && word[1] <= doc.length) marks.push(Decoration.mark({ class: 'cm-source-word' }).range(word[0], word[1]));
      return Decoration.set(marks, true);
    }
    return tr.docChanged ? Decoration.none : value;
  },
  provide: field => EditorView.decorations.from(field),
});

// A flash: lines shown briefly, as the PDF marks a place it shows.
const setFlash = StateEffect.define<[number, number][]>();
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setFlash)) {
      const doc = tr.state.doc, lines = new Set<number>();
      for (const [from, to] of effect.value) for (let line = from; line < Math.max(to, from + 1) && line < doc.lines; line++) lines.add(line);
      return Decoration.set([...lines].sort((a, b) => a - b).map(line => Decoration.line({ class: 'cm-source-flash' }).range(doc.line(line + 1).from)));
    }
    return value.map(tr.changes);
  },
  provide: field => EditorView.decorations.from(field),
});

// One line's part of a change's bar: the bars of a change's lines join into
// one rounded mark, drawn like the marks along the scrollbar.
class ChangeBar extends GutterMarker {
  constructor(readonly name: string) { super(); }
  eq(other: ChangeBar) { return other.name === this.name; }
  toDOM() { const bar = document.createElement('div'); bar.className = this.name; return bar; }
}
const bars = new Map<string, ChangeBar>();
const bar = (kind: ChangeKind, first: boolean, last: boolean) => {
  const name = `cm-change-bar cm-change-${kind}${first ? ' cm-change-first' : ''}${last ? ' cm-change-last' : ''}`;
  if (!bars.has(name)) bars.set(name, new ChangeBar(name));
  return bars.get(name)!;
};

/** Lines (0-based, end excluded) that differ from `base`, by kind. A deletion
 *  is an empty range at the line after it. */
export function changedLines(base: Text, doc: Text, chunks = Chunk.build(base, doc)) {
  return chunks.map(chunk => {
    const kind: ChangeKind = chunk.fromA === chunk.toA ? 'added' : chunk.fromB === chunk.toB ? 'deleted' : 'modified';
    const from = doc.lineAt(Math.min(chunk.fromB, doc.length)).number - 1;
    const to = kind === 'deleted' ? from : doc.lineAt(Math.max(chunk.fromB, Math.min(chunk.toB, doc.length + 1) - 1)).number;
    return { kind, from, to };
  });
}

// Where changes are in the whole file, along the scrollbar: one mark per
// change at its height in the document, like an editor's overview ruler.
// It only shows; the scrollbar beneath it keeps working.
function changeRuler(changes: (view: EditorView) => ReturnType<typeof changedLines>) {
  return ViewPlugin.fromClass(class {
    dom = document.createElement('div');
    constructor(readonly view: EditorView) {
      this.dom.className = 'cm-change-ruler';
      this.dom.setAttribute('aria-hidden', 'true');
      view.dom.appendChild(this.dom);
      this.draw();
    }
    update(update: ViewUpdate) { if (update.docChanged || update.geometryChanged || update.heightChanged) this.draw(); }
    draw() {
      const view = this.view;
      view.requestMeasure({
        read: () => {
          const doc = view.state.doc, scroller = view.scrollDOM, height = Math.max(scroller.scrollHeight, 1), top = view.documentTop - scroller.getBoundingClientRect().top + scroller.scrollTop;
          return {
            width: Math.max(6, scroller.offsetWidth - scroller.clientWidth),
            marks: changes(view).map(change => {
              const start = view.lineBlockAt(doc.line(Math.min(change.from + 1, doc.lines)).from);
              const end = change.kind === 'deleted' ? start : view.lineBlockAt(doc.line(Math.min(Math.max(change.to, change.from + 1), doc.lines)).from);
              return { kind: change.kind, top: (start.top + top) / height, bottom: (change.kind === 'deleted' ? start.top + top : end.bottom + top) / height };
            }),
          };
        },
        write: ({ width, marks }) => {
          this.dom.style.width = `${width}px`;
          this.dom.replaceChildren(...marks.map(mark => {
            const element = document.createElement('div');
            element.className = `cm-ruler-mark cm-ruler-${mark.kind}`;
            element.style.top = `${(mark.top * 100).toFixed(3)}%`;
            element.style.height = `max(3px, ${((mark.bottom - mark.top) * 100).toFixed(3)}%)`;
            return element;
          }));
        },
      });
    }
    destroy() { this.dom.remove(); }
  });
}

// Bars beside the lines that changed since the last commit, and their marks
// along the scrollbar, kept up to date as the author types.
function changeBars(base: Text, onClick?: (line: number) => void): Extension {
  const chunks = StateField.define<readonly Chunk[]>({
    create: state => Chunk.build(base, state.doc),
    update: (value, tr) => tr.docChanged ? Chunk.updateB(value, base, tr.newDoc, tr.changes) : value,
  });
  return [chunks, changeRuler(view => changedLines(base, view.state.doc, view.state.field(chunks))), gutter({
    class: 'cm-change-bars',
    markers: view => {
      const doc = view.state.doc, marks: { from: number; marker: GutterMarker }[] = [];
      for (const change of changedLines(base, doc, view.state.field(chunks))) {
        if (change.kind === 'deleted') marks.push({ from: doc.line(Math.min(change.from + 1, doc.lines)).from, marker: bar('deleted', true, true) });
        else for (let line = change.from; line < change.to; line++) marks.push({ from: doc.line(line + 1).from, marker: bar(change.kind, line === change.from, line === change.to - 1) });
      }
      return RangeSet.of(marks.map(mark => mark.marker.range(mark.from)), true);
    },
    domEventHandlers: { mousedown: (view, line) => { onClick?.(view.state.doc.lineAt(line.from).number - 1); return Boolean(onClick); } },
  })];
}

// A review's changes in the text, as its cards show them on the PDF: a block
// per card, under a header with the card's title and actions, the lines as
// they were (read-only, struck words marked), then the lines as they are now
// with the written words marked. The parts keep their places as the author
// types; a decided change leaves its block.
export interface ReviewState {
  /** The text each change replaced its parts of. */
  before: string;
  labels: { before: string; after: string };
  /** Each change's parts: [from, to) in `before`, [at, end) in the document. */
  parts: Map<string, { from: number; to: number; at: number; end: number }[]>;
  decisions: Map<string, string>;
  cards: { title: string; units: string[]; actions: { kind: string; label: string; lock: string | null }[] }[];
}
const setReview = StateEffect.define<ReviewState | null>();
const updateReview = StateEffect.define<Pick<ReviewState, 'decisions' | 'cards' | 'labels'>>();
const ICONS: Record<string, string> = {
  accept: '<path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  reject: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  comment: '<path d="M3 4.5A1.5 1.5 0 014.5 3h7A1.5 1.5 0 0113 4.5v5a1.5 1.5 0 01-1.5 1.5H7l-3 2.5V11h.5A1.5 1.5 0 013 9.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
};
class CardHead extends WidgetType {
  constructor(readonly card: ReviewState['cards'][number], readonly units: string[], readonly before: string, readonly removed: [number, number][], readonly label: string, readonly options: SourceEditorOptions) { super(); }
  eq(other: CardHead) {
    return other.before === this.before && other.label === this.label && JSON.stringify([other.card, other.units, other.removed]) === JSON.stringify([this.card, this.units, this.removed]);
  }
  toDOM() {
    const block = document.createElement('div'), head = document.createElement('div'), title = document.createElement('span'), buttons = document.createElement('span');
    block.className = 'cm-review-card'; head.className = 'cm-review-head'; title.className = 'cm-review-title'; buttons.className = 'cm-review-buttons';
    title.textContent = this.card.title;
    for (const action of this.card.actions) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = `cm-review-${action.kind}`;
      button.title = action.lock || action.label; button.setAttribute('aria-label', action.label); button.disabled = Boolean(action.lock);
      button.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[action.kind] ?? ''}</svg>`;
      // The caret stays where it was.
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', () => this.options.onDecide?.(this.units, action.kind));
      buttons.append(button);
    }
    head.append(title, buttons); block.append(head);
    if (this.before) {
      const row = document.createElement('div');
      row.className = 'cm-review-before'; row.dataset.label = this.label;
      let at = 0;
      for (const [from, to] of this.removed) {
        row.append(this.before.slice(at, from));
        const word = document.createElement('span');
        word.className = 'cm-review-removed'; word.textContent = this.before.slice(from, to);
        row.append(word); at = to;
      }
      row.append(this.before.slice(at));
      block.append(row);
    }
    return block;
  }
  ignoreEvent() { return true; }
}
// The start of the line holding `at`, and the end of the line holding the
// character before `end` (a part that ends with a line break ends its line).
const lineStart = (text: string, at: number) => text.lastIndexOf('\n', at - 1) + 1;
const lineEnd = (text: string, at: number, end: number) => { const last = end > at && text[end - 1] === '\n' ? end - 1 : end, next = text.indexOf('\n', last); return next < 0 ? text.length : next; };
function reviewDecorations(review: ReviewState | null, doc: Text, options: SourceEditorOptions) {
  if (!review) return Decoration.none;
  const ranges = [], text = doc.toString();
  for (const card of review.cards) {
    const units = card.units.filter(id => review.parts.has(id) && (review.decisions.get(id) ?? 'pending') === 'pending');
    const parts = units.flatMap(id => review.parts.get(id)!);
    if (!parts.length) continue;
    const removing = parts.filter(part => part.to > part.from), adding = parts.filter(part => part.end > part.at);
    const first = Math.min(...parts.map(part => part.at)), last = Math.max(...parts.map(part => part.end));
    // The lines as they were, around what was removed.
    let before = '', removed: [number, number][] = [];
    if (removing.length) {
      const from = lineStart(review.before, Math.min(...removing.map(part => part.from)));
      const to = lineEnd(review.before, from, Math.max(...removing.map(part => part.to)));
      before = review.before.slice(from, to);
      removed = removing.map(part => [part.from - from, Math.min(part.to, to) - from] as [number, number]).sort((a, b) => a[0] - b[0]);
    }
    const top = lineStart(text, first);
    ranges.push(Decoration.widget({ widget: new CardHead(card, units, before, removed, review.labels.before, options), block: true, side: -1 }).range(top));
    // The lines as they are now, with what was written.
    if (adding.length) {
      const end = lineEnd(text, first, last);
      for (let line = doc.lineAt(top); ; line = doc.line(line.number + 1)) {
        ranges.push(Decoration.line({ class: 'cm-review-after', attributes: line.from === top ? { 'data-label': review.labels.after } : {} }).range(line.from));
        if (line.to >= end || line.number === doc.lines) break;
      }
      for (const part of adding) ranges.push(Decoration.mark({ class: 'cm-review-added' }).range(part.at, part.end));
    }
  }
  return Decoration.set(ranges, true);
}
const reviewField = StateField.define<ReviewState | null>({
  create: () => null,
  update(review, tr) {
    for (const effect of tr.effects) if (effect.is(setReview)) return effect.value;
    if (!review) return review;
    let next = review;
    if (tr.docChanged) next = { ...next, parts: new Map([...next.parts].map(([id, parts]) => [id, parts.map(part => {
      const at = tr.changes.mapPos(part.at, 1);
      return { ...part, at, end: Math.max(at, tr.changes.mapPos(part.end, -1)) };
    })])) };
    for (const effect of tr.effects) if (effect.is(updateReview)) next = { ...next, ...effect.value };
    return next;
  },
});
const reviewView = (options: SourceEditorOptions) => EditorView.decorations.compute([reviewField, 'doc'], state => reviewDecorations(state.field(reviewField), state.doc, options));

export class SourceCodeEditor {
  readonly view: EditorView;
  private bars = new Compartment();
  private editable = new Compartment();
  private base = Text.empty;
  private silent = false;
  private review: Extension;
  // The version whose review changes are shown.
  private reviewKey: string | null = null;

  constructor(private options: SourceEditorOptions) {
    this.review = [reviewField, reviewView(options)];
    this.view = new EditorView({ parent: options.parent, state: this.state('') });
  }

  private state(text: string) {
    const options = this.options;
    return EditorState.create({ doc: text, extensions: [
      lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), history(), bracketMatching(),
      search({ top: false }), highlightSelectionMatches(), latex, syntaxHighlighting(highlight), EditorView.lineWrapping, theme,
      this.editable.of(EditorState.readOnly.of(false)), this.bars.of(changeBars(this.base, options.onChangeBar)), focusField, flashField, this.review,
      EditorView.contentAttributes.of({ 'aria-label': options.label, spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { options.onSave(); return true; } },
        { key: 'Mod-Enter', preventDefault: true, run: () => { options.onSave(); return true; } },
        ...searchKeymap, ...historyKeymap, indentWithTab, ...defaultKeymap,
        { key: 'Escape', run: () => options.onEscape() },
      ]),
      EditorView.updateListener.of(update => {
        if (update.docChanged && !this.silent) options.onChange();
        if (options.onCursor && update.selectionSet && !this.silent && update.transactions.some(tr => tr.isUserEvent('select') || tr.isUserEvent('input') || tr.isUserEvent('delete')))
          options.onCursor(update.state.doc.lineAt(update.state.selection.main.head).number - 1);
      }),
    ] });
  }

  get text() { return this.view.state.doc.toString(); }

  /** Shows a file, with a fresh undo history, beside its last commit. */
  load(text: string, base: string | null) {
    this.base = Text.of((base ?? '').split('\n'));
    if (base === null) this.base = Text.empty;
    this.silent = true;
    try { this.view.setState(this.state(text)); } finally { this.silent = false; }
    this.reviewKey = null;
  }

  /** Shows a review's changes in the text. `key` names the version of the
   *  file they were found in, `text`: they are placed only over that text,
   *  then follow the author's edits, and while the key stays only their
   *  decisions and cards change. */
  showReview(review: (ReviewState & { key: string; text: string }) | null) {
    if (!review) {
      if (this.reviewKey !== null) { this.reviewKey = null; this.view.dispatch({ effects: setReview.of(null) }); }
      return;
    }
    const { key, text, ...state } = review;
    if (key === this.reviewKey) {
      this.view.dispatch({ effects: updateReview.of({ decisions: state.decisions, cards: state.cards, labels: state.labels }) });
      return;
    }
    if (this.view.state.doc.toString() !== text) return;
    this.reviewKey = key;
    this.view.dispatch({ effects: setReview.of(state) });
  }

  /** The last commit changed, such as after a commit. */
  setBase(base: string | null) {
    this.base = base === null ? Text.empty : Text.of(base.split('\n'));
    this.view.dispatch({ effects: this.bars.reconfigure(changeBars(this.base, this.options.onChangeBar)) });
  }

  /** Replaces the whole text as one edit, which the author can undo. */
  replace(text: string) { this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text }, userEvent: 'input.replace' }); }

  setReadOnly(readOnly: boolean) { this.view.dispatch({ effects: this.editable.reconfigure(EditorState.readOnly.of(readOnly)) }); }

  /** Scrolls lines into view, a third down the editor, puts the caret at
   *  their start (or at `word`, characters picked within them) and, with
   *  `mark`, highlights them (or the `marks` within them) and the word until
   *  the text changes. */
  reveal([from, to]: [number, number], { mark = false, caret = true, marks, word, smooth = false }: { mark?: boolean; caret?: boolean; marks?: [number, number][]; word?: [number, number]; smooth?: boolean } = {}) {
    const view = this.view, doc = view.state.doc, first = doc.line(Math.min(Math.max(from, 0), doc.lines - 1) + 1);
    const picked = word && word[1] <= doc.length ? word : undefined, at = picked ? picked[0] : first.from;
    const margin = Math.round(view.scrollDOM.clientHeight / 3);
    this.silent = true;
    try {
      view.dispatch({
        ...(caret ? { selection: { anchor: at } } : {}),
        effects: [setFocus.of({ lines: mark ? marks ?? [[from, Math.max(to, from + 1)]] : [], word: mark ? picked : undefined }),
          ...(smooth ? [] : [EditorView.scrollIntoView(at, { y: 'start', yMargin: margin })])],
      });
    } finally { this.silent = false; }
    // Gliding to a place in a file already open keeps the reader oriented.
    if (smooth) view.scrollDOM.scrollTo({ top: Math.max(0, view.lineBlockAt(at).top - margin), behavior: 'smooth' });
  }

  /** Shows lines briefly, as the PDF marks a place. A flash starts over
   *  when one is still showing. */
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  flash(ranges: [number, number][]) {
    clearTimeout(this.flashTimer);
    this.view.dispatch({ effects: setFlash.of([]) });
    requestAnimationFrame(() => {
      if (!this.view.dom.isConnected) return;
      this.view.dispatch({ effects: setFlash.of(ranges) });
      this.flashTimer = setTimeout(() => { if (this.view.dom.isConnected) this.view.dispatch({ effects: setFlash.of([]) }); }, 1100);
    });
  }

  focus() { this.view.focus(); }

  destroy() { clearTimeout(this.flashTimer); this.view.destroy(); }
}
