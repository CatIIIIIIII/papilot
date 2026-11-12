import { useEffect, useRef, useState, type RefObject } from 'react';
import type { BuildProblem, ManuscriptBuild, ManuscriptProblems, SourceFile, SourcePlace, SourceSave, TaskSourceSave } from '../shared.ts';
import type { PdfHandle, PdfPassage, Rect, Target } from './pdf-view.tsx';
import type { CurrentChange, ReviewChanges } from '../../engine/src/web/review-events.ts';
import type { SourceCodeEditor } from './source-codemirror.ts';
import { Icon } from './icons.tsx';
import { t, tn } from './i18n.ts';
import { browserStorage } from './storage.ts';
import { isPlayground } from './playground-mode.ts';
import { findPicked, lineSpan } from './source-match.ts';
import './source-panel.css';

// Editing the manuscript's LaTeX by hand. A click on the PDF, or a change
// picked in the Changes view, opens its file in a tab beside New task, at
// its lines, which are highlighted as the PDF highlights the passage, both
// until the author starts typing. The editor marks what changed since the
// last commit. A save writes the file and compiles the manuscript; the PDF
// and the editor then flash the saved lines, or the tab shows the errors in
// them and the last PDF stays.
// The same editor edits a task's files beside its review, opened from a
// change: it marks what the task changed, shows the round's changes in the
// text as the review's cards, with their actions, and a save is reviewed in a
// new round.

type Api = <T>(route: string, body?: unknown, signal?: AbortSignal, wait?: number) => Promise<T>;
type Lines = [number, number];
// A textarea or editor always gives \n; the server writes the file's own line endings.
const plain = (text: string) => text.replace(/\r\n/g, '\n');
const normalize = (file: SourceFile): SourceFile => ({ ...file, text: plain(file.text), base: file.base === null ? null : plain(file.base) });
const uuid = () => crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const DRAFTS = 10, DRAFT_SIZE = 1_000_000;

// Unsaved drafts survive closing the tab and reloading the page, for the same
// version of the same file. Very large files keep theirs in the tab only.
const draftPrefix = (project: string) => `papilot:source-draft:${project}:`;
const draftKey = (project: string, file: string) => draftPrefix(project) + file;
function keepDraft(project: string, file: SourceFile, text: string) {
  const key = draftKey(project, file.file);
  if (text === file.text || text.length > DRAFT_SIZE) { browserStorage.removeItem(key); return; }
  browserStorage.setItem(key, JSON.stringify({ revision: file.revision, text, at: Date.now() }));
  const kept = browserStorage.keys().filter(name => name.startsWith(draftPrefix(project))).map(name => {
    try { return { name, at: Number(JSON.parse(browserStorage.getItem(name) || '{}').at) || 0 }; } catch { return { name, at: 0 }; }
  }).sort((a, b) => b.at - a.at);
  for (const old of kept.slice(DRAFTS)) browserStorage.removeItem(old.name);
}
function readDraft(project: string, file: SourceFile): string | null {
  try {
    const draft = JSON.parse(browserStorage.getItem(draftKey(project, file.file)) || 'null');
    return draft && draft.revision === file.revision && typeof draft.text === 'string' ? draft.text : null;
  } catch { return null; }
}

interface Edit {
  // Where on the PDF the passage is, when it was picked there, and what of
  // it is highlighted: nothing once the author edits.
  anchor: { page: number; rect: Rect; marks: Rect[] } | null;
  state: 'loading' | 'ready' | 'missing' | 'failed';
  file?: SourceFile;
  error?: string;
  saving?: boolean;
  // The build of the last save, of `file`, recognized by the working tree it
  // compiles; `before` is the tree of the build shown when the save began,
  // and `since` when the file was written, by the server's clock.
  compile?: { file: string; tree: string; before?: string; since: number; lines: Lines; state: 'building' | 'ready' | 'failed'; problems?: BuildProblem[]; others?: number };
}
// What the editor shows next, once it holds the file: lines to scroll to and
// mark, and lines to flash.
interface Reveal { lines: Lines; mark: boolean; caret: boolean; marks?: Lines[]; word?: [number, number]; flash?: Lines[] }

export function useSourceEdit({ api, projectId, taskId, version, build, head, pdf, onProblems, onLine, onTaskSaved, review }: {
  api: Api; projectId: string;
  /** Edits this task's files, in its worktree, rather than the paper's. */
  taskId?: string;
  /** Changes when the files may have changed elsewhere, such as a task's round. */
  version?: unknown;
  build?: ManuscriptBuild; head?: string | null; pdf?: RefObject<PdfHandle | null>;
  onProblems?: () => void;
  /** The author moved to a line (0-based) of the file, in the editor. */
  onLine?: (file: string, line: number) => void;
  /** A task's file was saved: the review after the save, and the line (0-based) the author is at. */
  onTaskSaved?: (state: unknown, file: string, line: number) => void;
  /** A task's review: its changes, shown in their files as its cards, and acting on a card's changes. */
  review?: { changes: ReviewChanges | null; decide: (changes: string[], action: string) => void };
}) {
  // Drafts are kept per paper, and per task. A task's changes show in the
  // text, so its passages are not highlighted as well.
  const scope = taskId ? `task:${taskId}` : projectId, marking = !taskId;
  const reviewing = useRef(review); reviewing.current = review;
  const read = async (file: string) => normalize(await api<SourceFile>(taskId ? `/tasks/${taskId}/source?file=${encodeURIComponent(file)}` : `/projects/${projectId}/manuscript/source?file=${encodeURIComponent(file)}`));
  const [edit, setEdit] = useState<Edit | null>(null);
  const latest = useRef(edit); latest.current = edit;
  // The task or paper the panel shows now; a save answered after a switch
  // must not reach the newly shown task's review.
  const currentScope = useRef(scope); currentScope.current = scope;
  const [dirty, setDirty] = useState(false);
  const editor = useRef<SourceCodeEditor | null>(null), host = useRef<HTMLDivElement | null>(null);
  // The file version the editor holds, and what to show once it does.
  const shown = useRef<SourceFile | null>(null), pending = useRef<Reveal | null>(null);
  const request = useRef(0), saving = useRef(false), shownBuild = useRef(build); shownBuild.current = build;
  // Set while a kept draft is put back into the editor.
  const restoring = useRef(false);
  // Asks for a sync when the file stays the same but there is something to show.
  const [tick, setTick] = useState(0), followed = useRef(-1);
  const show = (reveal: Reveal) => { pending.current = reveal; setTick(value => value + 1); };
  const update = (change: (edit: Edit) => Edit) => setEdit(current => {
    const next = current ? change(current) : current;
    latest.current = next;
    return next;
  });
  // An answer applies to the file that asked, not to one opened meanwhile.
  const settler = () => {
    const owner = request.current;
    return (change: (edit: Edit) => Edit) => { if (request.current === owner) update(change); };
  };
  useEffect(() => { setEdit(null); request.current++; }, [scope]);
  // The editor's code loads while the manuscript is idle, so the first
  // source opens without waiting for it.
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((work: () => void) => setTimeout(work, 1500));
    idle(() => void import('./source-codemirror.ts').catch(() => undefined));
  }, []);

  // The editor is created with its tab, and asks for whatever is current
  // through these, which change on every render.
  const actions = useRef<{ save: () => void; escape: () => boolean; typed: () => void; line: (line: number) => void; sync: () => void }>({ save: () => {}, escape: () => false, typed: () => {}, line: () => {}, sync: () => {} });
  // One callback for the tab's whole life: a new one on each render would
  // make React detach and attach the editor every time.
  const mount = useRef((element: HTMLDivElement | null) => {
    if (host.current === element) return;
    host.current = element;
    if (!element) { editor.current?.destroy(); editor.current = null; shown.current = null; return; }
    void import('./source-codemirror.ts').then(({ SourceCodeEditor }) => {
      if (host.current !== element || editor.current) return;
      editor.current = new SourceCodeEditor({
        parent: element, label: t('Edit LaTeX source'),
        onChange: () => actions.current.typed(), onSave: () => actions.current.save(), onEscape: () => actions.current.escape(),
        onCursor: line => actions.current.line(line), onChangeBar: line => actions.current.line(line),
        onDecide: (changes, action) => reviewing.current?.decide(changes, action),
      });
      actions.current.sync();
    });
  }).current;

  // Bring the editor to the current file version and show what is pending.
  function sync() {
    const view = editor.current, current = latest.current, file = current?.file;
    if (!view || !file) return;
    const held = shown.current, loaded = !held || held.file !== file.file || (held.revision !== file.revision && view.text !== file.text);
    if (loaded) {
      // Another file keeps the draft of the one it replaces.
      if (held && held.file !== file.file) keepDraft(scope, held, view.text);
      // A kept draft comes back as one edit over the file on disk, which ⌘Z undoes.
      const draft = held?.file === file.file ? null : readDraft(scope, file);
      view.load(file.text, file.base);
      if (draft !== null && draft !== file.text) {
        restoring.current = true;
        try { view.replace(draft); } finally { restoring.current = false; }
      }
    } else if (held.base !== file.base) view.setBase(file.base);
    shown.current = file;
    view.setReadOnly(Boolean(current?.saving));
    setDirty(view.text !== file.text);
    const reveal = pending.current;
    if (reveal) {
      pending.current = null;
      // A file just shown opens at the place; one already open glides there.
      view.reveal(reveal.lines, { mark: reveal.mark, caret: reveal.caret, marks: reveal.marks, word: reveal.word, smooth: !loaded });
      if (reveal.caret) view.focus();
      // A glide to the place ends before the lines flash.
      const flash = reveal.flash, owner = request.current;
      if (flash) setTimeout(() => { if (request.current === owner) editor.current?.flash(flash); }, loaded ? 0 : 260);
    }
    showReview();
  }

  // The review's changes in the open file, placed by where the round has
  // them, when it shows this very file.
  function showReview() {
    const view = editor.current, file = latest.current?.file, changes = reviewing.current?.changes;
    if (!view || !file) return;
    const before = file.before;
    if (!file.reviewed || before == null || !changes || changes.round !== file.round) { view.showReview(null); return; }
    // Rejected changes whose text came back are gone from the file; the
    // changes after them moved by the difference.
    const reverted = new Set(file.reverted ?? []), mine = changes.changes.filter(change => change.file === file.file);
    const parts = (change: ReviewChanges['changes'][number]) => change.ops.filter(op => op[0] !== 'equal');
    const shifts = mine.filter(change => reverted.has(change.id)).flatMap(parts).map(([, from, to, at, end]) => ({ end, by: (to - from) - (end - at) }));
    const place = (at: number) => at + shifts.reduce((sum, shift) => shift.end <= at ? sum + shift.by : sum, 0);
    view.showReview({ key: `${file.file}:${file.revision}:${changes.round}`, text: file.text, before, labels: changes.labels, cards: changes.stops,
      parts: new Map(mine.filter(change => !reverted.has(change.id)).map(change => [change.id, parts(change).map(([, from, to, at, end]) => ({ from, to, at: place(at), end: place(end) }))])),
      decisions: new Map(mine.map(change => [change.id, change.decision])) });
  }
  useEffect(showReview, [review?.changes]);
  actions.current.sync = sync;
  useEffect(sync, [edit?.file, edit?.saving, tick]);

  // A click or selection on the PDF named a passage.
  // `shownKey` names the PDF the click was on, which may still be on screen
  // while a newer one loads.
  async function open(target: Target, shownKey?: string) {
    const key = shownKey ?? build?.key;
    if (!key) return;
    // The demo has no files to write; it offers the download instead.
    if (isPlayground) { window.dispatchEvent(new Event('papilot:playground-download')); return; }
    const id = ++request.current;
    const anchor = { page: target.page, rect: target.rect, marks: target.point ? [] : target.rects.length ? target.rects : [target.rect] };
    setEdit(current => ({ ...(current?.file ? current : {}), anchor, state: current?.file ? 'ready' : 'loading', error: undefined, compile: current?.compile }));
    try {
      const { source } = await api<{ source: SourceFile | null }>(`/projects/${projectId}/manuscript/source/locate`, { key, page: target.page, rect: target.rect, rects: target.rects, quote: target.quote }, undefined, 30000);
      if (id !== request.current) return;
      if (!source) { update(current => ({ ...current, state: current.file ? 'ready' : 'missing', error: current.file ? t('No LaTeX source was found here. Click a line of text instead.') : undefined })); return; }
      const file = normalize(source);
      // A click names a point; the page then marks the whole passage, and
      // the whole passage flashes in the editor.
      let marked = anchor, lines: Lines = file.focus;
      if (target.point && !file.drifted) {
        const { place } = await api<{ place: SourcePlace | null }>(`/projects/${projectId}/manuscript/source/place?key=${encodeURIComponent(key)}&file=${encodeURIComponent(file.file)}&start=${file.passage[0]}&end=${file.passage[1]}&near=${target.page}`).catch(() => ({ place: null }));
        if (id !== request.current) return;
        if (place && place.page === target.page) { marked = { page: place.page, rect: place.rect, marks: [place.rect] }; lines = file.passage; }
      }
      // The caret and highlight go to what the click hit, and the words
      // picked on the page stand out within it.
      const pick = { quote: target.quote, word: target.word };
      const word = file.drifted ? null : findPicked(file.text, lineSpan(file.text, file.focus), pick) ?? findPicked(file.text, lineSpan(file.text, file.passage), pick);
      update(current => ({ ...current, anchor: marked, state: 'ready', file: replaces(current.file, file) }));
      show({ lines: file.focus, mark: true, caret: true, word: word ?? undefined, flash: [lines] });
    } catch (error) {
      if (id !== request.current) return;
      update(current => ({ ...current, state: current.file ? 'ready' : 'failed', error: message(error) }));
      // The PDF may have been replaced meanwhile; fetch the one shown now.
      window.dispatchEvent(new Event('papilot:manuscript'));
    }
  }
  // Another file, or the same one at another version, replaces what is open
  // only when it is not the version already there.
  const replaces = (current: SourceFile | undefined, next: SourceFile) => current && current.file === next.file && current.revision === next.revision ? current : next;

  // A change picked or followed in the Changes view.
  async function follow(change: CurrentChange, showTab: () => void) {
    if (change.from === 'source' || !change.units.length) return;
    const unit = change.units[0], lines: Lines = [Math.min(...unit.lines.map(range => range[0])), Math.max(...unit.lines.map(range => Math.max(range[1], range[0] + 1)))];
    const current = latest.current, again = followed.current === change.stop;
    followed.current = change.stop;
    if (change.from === 'scroll') {
      // An open editor follows the reading, without taking the keyboard
      // from the author, and keeps unsaved changes to another file.
      const view = editor.current;
      if (again || !current?.file || !view || view.view.hasFocus || (current.file.file !== unit.file && dirty)) return;
      if (current.file.file === unit.file) { view.reveal(lines, { mark: marking, caret: false, marks: unit.lines }); return; }
    } else showTab();
    await openAt(unit.file, { lines, mark: marking, caret: change.from === 'pick', marks: unit.lines, flash: change.from === 'pick' ? unit.lines : undefined });
  }

  // Opens a file, or moves within the one open, and shows `reveal` there.
  async function openAt(name: string, reveal: Reveal) {
    const id = ++request.current;
    if (latest.current?.file?.file === name) {
      update(value => ({ ...value, anchor: null, state: 'ready' }));
      show(reveal);
      return;
    }
    setEdit(value => ({ anchor: null, state: 'loading', compile: value?.compile }));
    try {
      const file = await read(name);
      if (id !== request.current) return;
      pending.current = reveal;
      update(value => ({ ...value, state: 'ready', file }));
    } catch (error) { if (id === request.current) update(value => ({ ...value, state: 'failed', error: message(error) })); }
  }

  function close() {
    // The draft is kept, or dropped, now: the editor goes with the tab.
    const view = editor.current, file = latest.current?.file;
    clearTimeout(typing.current.timer);
    if (view && file) keepDraft(scope, file, view.text);
    request.current++; setEdit(null); setDirty(false);
    pdf?.current?.focus();
  }

  // Each keystroke: whether there are unsaved changes, and the draft, a
  // moment later.
  const typing = useRef<{ frame: number; timer?: ReturnType<typeof setTimeout> }>({ frame: 0 });
  actions.current.typed = () => {
    // The passage stops standing out on the PDF, as it does in the editor;
    // a draft coming back is not the author typing.
    if (!restoring.current && latest.current?.anchor?.marks.length) update(value => value.anchor ? { ...value, anchor: { ...value.anchor, marks: [] } } : value);
    cancelAnimationFrame(typing.current.frame);
    typing.current.frame = requestAnimationFrame(() => {
      const view = editor.current, file = latest.current?.file;
      if (!view || !file) return;
      const text = view.text;
      setDirty(text !== file.text);
      if (latest.current?.error) update(value => ({ ...value, error: undefined }));
      clearTimeout(typing.current.timer);
      typing.current.timer = setTimeout(() => keepDraft(scope, file, text), 400);
    });
  };
  // Read from the editor itself: the dirty state renders a frame later.
  const unsaved = () => Boolean(editor.current && latest.current?.file && editor.current.text !== latest.current.file.text);
  actions.current.escape = () => {
    if (unsaved() || latest.current?.saving) return false;
    close(); return true;
  };
  const lineTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  actions.current.line = line => {
    const file = latest.current?.file?.file;
    clearTimeout(lineTimer.current);
    if (file && onLine) lineTimer.current = setTimeout(() => onLine(file, line), 120);
  };

  // Saving the same text over the same version of the same task's or paper's
  // file again reuses the request's identity, so a save whose answer was lost
  // is recognized, not refused. Another task's identical file gets its own.
  const lastSave = useRef<{ scope: string; file: string; revision: string; text: string; id: string } | null>(null);
  async function save(text = editor.current?.text) {
    const current = latest.current;
    if (!current?.file || saving.current || text === undefined || text === current.file.text) return;
    const { file } = current, before = shownBuild.current?.tree, owner = request.current, again = lastSave.current;
    const id = again && again.scope === scope && again.file === file.file && again.revision === file.revision && again.text === text ? again.id : uuid();
    lastSave.current = { scope, file: file.file, revision: file.revision, text, id };
    saving.current = true;
    update(value => ({ ...value, saving: true, error: undefined }));
    try {
      let saved: SourceFile, compile: Edit['compile'];
      if (taskId) {
        // A task's file names the round it was read in; the review
        // follows the save from the line the author is at.
        const result = await api<TaskSourceSave>(`/tasks/${taskId}/source`, { id, round: file.round, file: file.file, revision: file.revision, text }, undefined, 120000);
        saved = normalize(result.source);
        const view = editor.current?.view, line = view ? view.state.doc.lineAt(view.state.selection.main.head).number - 1 : 0;
        if (currentScope.current === scope) onTaskSaved?.(result.state, saved.file, line);
      } else {
        const result = await api<SourceSave>(`/projects/${projectId}/manuscript/source`, { id, file: file.file, revision: file.revision, text }, undefined, 60000);
        saved = normalize(result.source);
        compile = { file: saved.file, tree: result.tree, before, since: result.at, lines: result.changed, state: 'building' };
      }
      browserStorage.removeItem(draftKey(scope, file.file));
      // The save happened even if another passage was opened meanwhile; the
      // file shown takes the saved version when it is still this file of the
      // same task or paper. After a switch, another task's file of the same
      // name and revision must keep its own text.
      const here = currentScope.current === scope;
      if (here && shown.current?.file === saved.file) shown.current = saved;
      update(value => ({ ...value, saving: false, ...(compile && here ? { compile } : {}), ...(here && value.file?.file === saved.file && (request.current === owner || value.file.revision === file.revision) ? { file: saved } : {}) }));
    } catch (error) { update(value => ({ ...value, saving: false, ...(request.current === owner && currentScope.current === scope ? { error: message(error) } : {}) })); }
    finally { saving.current = false; }
  }
  actions.current.save = () => void save();

  // The file as it is on disk now, without the draft.
  async function reload() {
    const current = latest.current?.file, settle = settler();
    if (!current) return;
    try {
      const file = await read(current.file);
      browserStorage.removeItem(draftKey(scope, current.file));
      shown.current = null;
      settle(value => ({ ...value, error: undefined, file }));
    } catch (error) { settle(value => ({ ...value, error: message(error) })); }
  }

  // Another editor, an applied task or a commit changed the file or its last
  // commit, or the task's review moved to a new round: an editor without
  // unsaved changes shows the new version.
  useEffect(() => {
    const current = latest.current?.file;
    if (!current || dirty || saving.current) return;
    const settle = settler();
    void read(current.file).then(file => {
      const now = latest.current?.file;
      if (!now || now.file !== file.file) return;
      // Typing begun while the file was read keeps its text; saving it then
      // reports that the file changed.
      if (file.revision !== now.revision && (unsaved() || saving.current)) return;
      if (file.revision !== now.revision || file.base !== now.base || file.round !== now.round || file.reviewed !== now.reviewed || String(file.reverted) !== String(now.reverted))
        settle(value => value.file?.file === file.file ? { ...value, file } : value);
    }, () => undefined);
  }, [build?.tree, head, version]);

  // Follow the build of the last save. It succeeded when its tree compiled,
  // or a newer working tree did: one built after the save began, never the
  // build shown before it or a late answer about one, whose status may still
  // say current. It failed when its own tree did not compile.
  useEffect(() => {
    const compile = latest.current?.compile;
    if (!compile || compile.state !== 'building' || !build || build.status === 'building') return;
    const ours = build.tree === compile.tree, newer = build.current && build.tree !== compile.before && (build.builtAt ?? 0) >= compile.since;
    if (build.status === 'ready' && (ours || newer) && build.key) void compiled(build.key, compile.tree);
    else if (build.status === 'failed' && ours) void failed(compile.tree);
  }, [build?.status, build?.tree, build?.key, build?.current, edit?.compile?.tree]);

  // The saved lines flash in the PDF and the editor, while the editor still
  // shows the saved file; another file opened since is left as it is. They
  // only flash: the PDF keeps no highlight of what the author changed.
  async function compiled(key: string, tree: string) {
    update(value => value.compile?.tree === tree ? { ...value, compile: { ...value.compile, state: 'ready' } } : value);
    const compile = latest.current?.compile;
    if (!compile || compile.tree !== tree || compile.lines[1] <= compile.lines[0]) return;
    const [start, end] = compile.lines, near = latest.current?.anchor?.page ?? 0;
    const showing = () => latest.current?.file?.file === compile.file && latest.current?.compile?.tree === tree;
    try {
      const { place } = await api<{ place: SourcePlace | null }>(`/projects/${projectId}/manuscript/source/place?key=${encodeURIComponent(key)}&file=${encodeURIComponent(compile.file)}&start=${start}&end=${end}&near=${near}`);
      if (!showing()) return;
      if (!place || !pdf?.current) { editor.current?.flash([[start, end]]); return; }
      const anchor = { page: place.page, rect: place.rect, marks: [] };
      update(value => ({ ...value, anchor }));
      pdf.current.showPlace(place.page, place.rect, { keep: true });
      editor.current?.flash([[start, end]]);
    } catch { if (showing()) editor.current?.flash([[start, end]]); }
  }

  async function failed(tree: string) {
    const compile = latest.current?.compile;
    if (!compile || compile.tree !== tree) return;
    const file = compile.file, [start, end] = compile.lines;
    let problems: BuildProblem[] = [], others = 0;
    try {
      const errors = (await api<ManuscriptProblems>(`/projects/${projectId}/manuscript/problems`, undefined, undefined, 60000)).problems.filter(problem => problem.severity === 'error');
      // A TeX error is often reported a line or two from its cause.
      problems = errors.filter(problem => problem.file === file && problem.line !== undefined && problem.line >= start - 1 && problem.line <= end + 2);
      others = errors.length - problems.length;
    } catch { /* The problem list stays one click away. */ }
    update(value => value.compile?.tree === tree ? { ...value, compile: { ...value.compile, state: 'failed', problems, others } } : value);
  }

  function jump(line: number) {
    editor.current?.reveal([line - 1, line], { mark: false });
    editor.current?.focus();
  }

  const name = edit?.file ? edit.file.file.slice(edit.file.file.lastIndexOf('/') + 1) : t('LaTeX source');
  return {
    open, follow, close, editing: Boolean(edit),
    /** Opens a file at lines, with `marks` within them standing out and flashing. */
    reveal: (file: string, lines: Lines, marks: Lines[]) => void openAt(file, { lines, mark: marking, caret: true, marks, flash: marks }),
    passage: edit?.anchor ? { page: edit.anchor.page, marks: edit.anchor.marks } as PdfPassage : undefined,
    // The tab names the file, with a dot while there are unsaved changes.
    tab: edit ? { file: edit.file?.file || '', name, dirty, saving: Boolean(edit.saving) } : null,
    panel: edit ? <SourcePanel edit={edit} dirty={dirty} mount={mount} onClose={close}
      onReload={() => void reload()} onJump={jump} onProblems={onProblems ?? (() => undefined)}/> : null,
  };
}

/** The source tab, which closes itself like an editor's: a dot while
 *  unsaved, a cross under the pointer. */
export function SourceTab({ tab, selected, onSelect, onClose }: {
  tab: { file: string; name: string; dirty: boolean; saving: boolean }; selected: boolean;
  onSelect: () => void; onClose: () => void;
}) {
  const unsaved = `${t('Unsaved')} · ${t('Close (the draft is kept)')}`;
  return <span className="side-tab-closable" role="presentation" data-selected={selected}>
    <button role="tab" aria-selected={selected} title={tab.file || t('Edit source')} onClick={onSelect}><Icon name="toolSource" size={14}/><span className="tab-label">{tab.name}</span></button>
    <button type="button" className="side-tab-close" data-dirty={tab.dirty || tab.saving || undefined}
      aria-label={tab.dirty ? unsaved : t('Close')} title={tab.dirty ? unsaved : t('Close')} onClick={onClose}><Icon name="close" size={12}/></button>
  </span>;
}

function SourcePanel({ edit, dirty, mount, onClose, onReload, onJump, onProblems }: {
  edit: Edit; dirty: boolean;
  mount: (element: HTMLDivElement | null) => void;
  onClose: () => void; onReload: () => void;
  onJump: (line: number) => void; onProblems: () => void;
}) {
  const file = edit.file, compile = edit.compile;
  return <section className="source-panel" role="tabpanel" aria-label={t('Edit source')} data-state={edit.state}
    onKeyDown={event => {
      if (event.key === 'Escape' && !event.defaultPrevented && !dirty && !edit.saving) { event.preventDefault(); onClose(); }
    }}>
    {file?.drifted && <p className="source-panel-note">{t('This passage changed after the PDF was compiled. It is shown as it is now.')}</p>}
    {edit.state === 'missing' && <p className="source-panel-message" role="status">{t('No LaTeX source was found here. Click a line of text instead.')}</p>}
    {edit.state === 'failed' && <p className="source-panel-error" role="alert">{edit.error}</p>}
    <div className="source-panel-editor" ref={mount} hidden={!file} data-loading={edit.state === 'loading' || undefined}/>
    {edit.state === 'loading' && !file && <p className="source-panel-message" role="status"><span className="spinner"/>{t('Finding the source…')}</p>}
    {file && <>
      {compile?.state === 'failed' && <div className="source-panel-problems" role="alert">
        <strong className="source-panel-problems-title">{t('This version did not compile. The last PDF stays.')}</strong>
        {compile.problems?.map((problem, index) => <button key={index} type="button" className="source-panel-problem" onClick={() => onJump(problem.line!)}>
          <span className="source-panel-problem-line">{t('Line {n}', { n: problem.line! })}</span><span>{problem.message}</span>
        </button>)}
        {(compile.others || !compile.problems?.length) ? <button type="button" className="note-link" onClick={onProblems}>{compile.others ? tn(compile.others, 'Show {n} other problem', 'Show {n} other problems') : t('Show problems')}</button> : null}
      </div>}
      {edit.error && <p className="source-panel-error" role="alert">{edit.error}{' '}<button type="button" className="note-link" onClick={onReload}>{t('Load the current source')}</button></p>}
    </>}
  </section>;
}
