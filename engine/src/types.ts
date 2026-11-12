export type Span = [number, number];
export type Rect = [number, number, number, number];
export type SourceBox = [
  page: number,
  top: number,
  bottom: number,
  left?: number,
  right?: number,
];
export type Ranges = Record<string, Span[]>;
export type Op = [
  "equal" | "replace" | "insert" | "delete",
  number,
  number,
  number,
  number,
];
export interface Heading {
  id: string;
  title: string;
  number: string;
  kind: string;
  level: number;
  file: string;
  line: number;
  parent: string | null;
  labels: string[];
  ranges: Ranges;
  files: string[];
}
export interface SectionRef {
  id: string;
  number: string;
  title: string;
}
export interface Scope {
  paths: string[];
  ranges: Ranges | null;
  sections: SectionRef[];
}
export interface Task {
  deferred?: number;
  name: string;
  title: string;
  worktree: string;
  base: string;
  accepted: string;
  scope: Scope;
  created: number;
  closed: number | null;
}
export interface Delivery {
  mode: "workspace" | "commit" | "branch";
  accepted: string;
  seq: number;
  branch?: string;
  commit?: string;
  parent?: string;
  indexBefore?: string;
  indexAfter?: string;
  previous?: string;
  done: boolean;
  writes: { file: string; before: string | null; after: string | null }[];
}
export interface Unit {
  id: string;
  file: string;
  status: "added" | "deleted" | "modified";
  kind: "text" | "figure" | "binary";
  whole_file: boolean;
  ops: Op[];
  /** Exact UTF-16 source ranges. Absent in older, line-based rounds. */
  text_ops?: Op[];
  old_start: number;
  old_end: number;
  new_start: number;
  new_end: number;
  old_text: string;
  old_context?: { text: string; start: number; source_hash?: string };
  new_text: string;
  truncated: boolean;
  /** Identifies this version of the change across rounds: its file and
   * complete old and new content with the lines around it. Absent in older
   * rounds, which compute it when needed. */
  hash?: string;
}
export interface Round {
  task: string;
  number: number;
  before: string;
  after: string;
  units: Unit[];
  summary: {
    warnings: string[];
    targets: string[];
    builds: string[];
    date?: { SOURCE_DATE_EPOCH: string; FORCE_SOURCE_DATE?: string };
    renderer?: string;
    /** Whether the round lists indirect changes; absent in older rounds,
     * which did. */
    indirect?: boolean;
    /** The build job that inserted the round. */
    job?: string;
    /** The accepted text does not compile: the errors that its side of the
     *  comparison was typeset past. */
    baselineErrors?: string[];
  };
  created: number;
  /** Whether its PDF comparison is rendered. A round is inserted first and
   * rendered afterwards; older rounds were inserted rendered. */
  visuals?: "pending" | "ready" | "failed";
}
export type ActionKind = "accept" | "reject" | "comment";
export type Decision = "accepted" | "rejected" | "commented" | "pending";
export interface ActionDetail {
  accepted_before?: string;
  accepted_after?: string;
  not_reverted?: string[];
  /** A decision that named an earlier round, applied to the latest one. */
  requested?: { round: number; changes: string[] };
  /** The comparison each change was decided with, when it came from another
   * round than the one the decision belongs to. */
  seen?: Record<string, { round: number; change: string }>;
  /** An accept undone after newer rounds: the round its undo inserts, with
   *  the change pending again. */
  republish?: number;
  /** A reject made while the agent worked, which waited for its turn to end. */
  queued?: true;
}
export interface Action {
  seq: number;
  id: string;
  task: string;
  round: number;
  kind: ActionKind;
  changes: string[];
  body: string;
  /** queued: a reject made while the agent works, applied once its turn ends. */
  status: "queued" | "applying" | "applied" | "undoing" | "undone" | "failed";
  detail: ActionDetail;
  created: number;
}
export interface Write {
  action: string;
  phase: "apply" | "undo";
  path: string;
  expected: Buffer | null;
  target: Buffer | null;
}
export interface MessageData {
  changes?: string[];
  not_reverted?: string[];
  undid?: string;
  message?: number;
}
export interface Message {
  id: number;
  task: string;
  round: number | null;
  kind: ActionKind | "undo" | "note";
  action: string | null;
  body: string;
  data: MessageData;
  created: number;
}
export interface JobResult {
  outcome?: "published" | "unchanged" | "empty";
  round?: number | null;
  changes?: number;
  kinds?: Record<string, number>;
  warnings?: string[];
  error?: string;
  details?: string[];
  next?: string;
  log?: string;
  /** Whether the baseline compiled ahead while the agent wrote was the one
   *  this round needed. */
  prefetch?: "hit" | "miss";
  /** A newer round replaced this job's round before it was rendered. */
  superseded?: boolean;
}
export interface Job {
  id: string;
  task: string;
  status: "queued" | "running" | "done" | "failed";
  phase: string;
  result: JobResult;
  created: number;
  finished?: number;
}
export interface BuildInfo {
  key: string;
  tree: string;
  targets: string[];
  root: string;
  cwd: string;
  pdf: string;
  seconds: number;
  warnings: string[];
  /** The errors TeX typeset past, in a build that went on after them. */
  errors?: string[];
}
// A running compilation: latexmk's current step, the TeX pass, and the
// pages typeset in it against the last known page count.
export interface BuildProgress {
  step: "tex" | "bibliography" | "pdf";
  pass: number;
  pages: number;
  total: number | null;
}
export interface Position {
  page: number;
  clip: Rect;
  label: string;
}
export interface Mark {
  /** context: words at the end of an old crop that the context strips show. */
  kind: "removed" | "added" | "moved" | "context";
  rect: Rect;
}
export interface Pair {
  old: Position | null;
  new: Position | null;
  before_marks: Mark[];
  after_marks: Mark[];
  /** Pairs of an aligned card in the same group show one region. */
  group?: number;
}
export type Visual = "unmapped" | "text" | "layout" | "position" | "identical";
export interface Card {
  id: string;
  file: string;
  pairs: Pair[];
  comparison: Visual;
  own?: { old: SourceBox[]; new: SourceBox[] };
  context_node?: string | null;
  /** The crops were cut at the same anchors of the whole comparison. */
  aligned?: boolean;
  /** Precisely located independent source edit; shared preview context is OK. */
  independent?: boolean;
}
export interface TextGlyph {
  text: string;
  rect: Rect;
}
export interface TextLine {
  text: string;
  chars: TextGlyph[];
}
export interface Strip {
  src: string;
  clean: string;
  width: number;
  height: number;
  /** Where the strip starts on its page, in points; absent in older rounds. */
  top?: number;
  /** Where the strip starts across its page, when it shows one column. */
  left?: number;
  page: number;
  label: string;
  text?: TextLine[];
  /** Native PDF coordinates relative to this strip, attributed to source edits. */
  marks?: (Mark & { unit: string })[];
}
export interface ChangeBlock {
  kind: "change";
  units: string[];
  identical: boolean;
  reflow?: boolean;
  /** Some words of the block moved here or away unchanged, drawn in blue. */
  moved?: boolean;
  before: Strip[];
  after: Strip[];
  /** Its PDF comparison is not rendered yet. */
  waiting?: boolean;
  /** The round whose comparison it shows while its own renders. */
  carried?: number;
  /** Edits this block shares with other blocks, and why: one edit's source
   *  prints in several places (`places`), or its text left one place and
   *  now prints far from it, on another page or as a float (`moved`). */
  linked?: { unit: string; reason: "places" | "moved" }[];
}
export type Block =
  ChangeBlock | { kind: "context"; image: Strip } | { kind: "gap" };
export interface VisualUnit {
  visual: Visual;
  pages: string[];
  section: string | null;
  /** PDF changes produced by a verified combination containing this edit,
   * away from its own lines. The combination need not be minimal or unique.
   * The first places are rendered; the rest render on request. */
  effects?: { total: number; shown: PlaceView[]; verified?: boolean };
}
/** A PDF change produced by a verified combination containing this edit.
 * `with` lists the other members, not necessarily required members or every
 * alternative cause. Accept/reject still operates on the selected edit. */
export interface Place {
  page: string;
  section: string | null;
  pairs: Pair[];
  with?: string[];
}
export interface PlaceView {
  page: string;
  section: string | null;
  before: Strip[];
  after: Strip[];
  with?: string[];
}
export interface RenderedRound {
  units: Record<string, VisualUnit>;
  sections: { node: string; number: string; title: string; blocks: Block[] }[];
  loose: ChangeBlock[];
  references?: References;
  /** Changes shown with an earlier round's comparison while the round
   * renders: the round and change that rendered it. */
  carried?: Record<string, { round: number; change: string }>;
}
/** One field of a changed bibliography entry, before and after; null
 * where the entry lacks it. `resolved` is the new value with @string
 * macros expanded, when that differs; `oldResolved` is its old expansion. */
export interface ReferenceField {
  name: string;
  old: string | null;
  new: string | null;
  resolved?: string;
  oldResolved?: string;
}
export interface ReferenceCitation {
  file: string;
  line: number;
  section: string | null;
}
/** still-cited: a removed key that the document still cites.
 * not-in-bibliography: the document does not read this .bib file. */
export type ReferenceProblem =
  | "still-cited"
  | "duplicate-key"
  | "unreadable"
  | "not-in-bibliography";
/** A bibliography entry that a round adds, removes or modifies, shown whole
 * under the edit it belongs to. */
export interface ReferenceEntry {
  id: string;
  unit: string;
  /** All edits affecting this entry when macros span multiple files. */
  units?: string[];
  file: string;
  key: string;
  old_key?: string;
  type: string;
  old_type?: string;
  status: "added" | "removed" | "modified";
  fields: ReferenceField[];
  lines: Span;
  /** Where the revised document cites the key. */
  cited: ReferenceCitation[];
  /** Where it still cites a renamed entry's old key. */
  old_cited?: ReferenceCitation[];
  problems: ReferenceProblem[];
  error?: string;
}
/** A key the revised document newly cites with no bibliography entry. */
export interface MissingCitation {
  key: string;
  file: string;
  line: number;
  unit: string | null;
  section: string | null;
}
export interface References {
  entries: ReferenceEntry[];
  missing: MissingCitation[];
}
/** A published record a bibliography entry was compared with. */
export interface CheckRecord {
  source: "doi" | "crossref" | "arxiv" | "dblp";
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string | null;
  url: string;
}
export interface CheckDifference {
  field: "title" | "author" | "year" | "doi" | "arxiv";
  bib: string;
  record: string;
  /** Shown, but not a reason to doubt the entry: punctuation in a title,
   * or a preprint's year before the published version's. */
  minor?: boolean;
}
/** verified: a record agrees. mismatch: a record of the same work differs,
 * or the DOI names another work. unverified: no record was found.
 * failed: a source could not be reached. skipped: nothing to look up. */
export interface ReferenceCheck {
  status: "verified" | "mismatch" | "unverified" | "failed" | "skipped";
  record?: CheckRecord;
  differences: CheckDifference[];
  /** What the entry was looked up by. */
  via: "doi" | "arxiv" | "title" | null;
  reason?: "doi-not-found" | "arxiv-not-found" | "no-match" | "nothing-to-check";
  /** Sources that could not be reached for this check. */
  unavailable: string[];
  checked: number;
}
export interface ReferenceChecks {
  checks: Record<string, ReferenceCheck>;
  /** Entries still being looked up. */
  pending: number;
  /** Entries the author has checked by hand, with when (seconds). A
   * confirmation holds while the entry's looked-up fields stay the same. */
  confirmed?: Record<string, number>;
}
/** An entry of the paper's bibliography as it is now. */
export interface BibliographyEntry {
  id: string;
  file: string;
  key: string;
  type: string;
  fields: { name: string; value: string; resolved?: string }[];
  lines: Span;
  cited: ReferenceCitation[];
  error?: string;
}
/** The whole bibliography of a paper: its entries, where each is cited,
 * and what is wrong with them without looking anything up. */
export interface Bibliography {
  /** The .bib files the paper names, and those of them that do not exist. */
  bibs: string[];
  absent: string[];
  entries: BibliographyEntry[];
  /** Citations of keys no entry defines, each place. */
  missing: (ReferenceCitation & { key: string })[];
  /** Entries sharing a key. */
  duplicates: string[][];
  /** Entries under different keys with the same DOI or title. */
  similar: { ids: string[]; by: "doi" | "title" }[];
  /** \nocite{*} puts every entry in the bibliography. */
  all_cited: boolean;
}
export interface RenderRequest {
  main: string;
  source_dir: string;
  figures: string[];
  old: BuildInfo;
  new: BuildInfo;
  /** Full edited build when `new` is an attribution variant. */
  final?: BuildInfo;
  units: Unit[];
  /** One verified sufficient combination per whole-document change. This
   * need not be minimal or include every alternative sufficient combination. */
  causes?: string[][];
  /** The cards of the first pass, reused with `causes`. */
  cards?: Card[];
  /** List the changes each edit makes away from its own lines, such as
   * renumbered references, and compile variants to find their edits. Off,
   * an edit shows only its own lines. */
  indirect?: boolean;
}
/** Words of the old and new PDF that changed, as ranges of each document's
 * words in reading order. */
export interface Effect {
  old: [number, number];
  new: [number, number];
  /** Equal text whose printed appearance changed. */
  kind?: "visual";
}
/** A non-text change has physical PDF positions, not word offsets. */
export interface PaintArea extends Position {
  signature: string;
}
export interface PaintEffect {
  kind: "paint";
  before: PaintArea[];
  after: PaintArea[];
}
export type DocumentEffect = Effect | PaintEffect;
export interface History {
  round: number;
  change: string;
  comment: string;
  new_text: string;
}
export interface RoundDetail extends Omit<RenderedRound, "units"> {
  task: string;
  round: number;
  before: string;
  after: string;
  units: (Unit & Partial<VisualUnit> & { history?: History[]; formattingFor?: string; waiting?: boolean; carried?: number })[];
  warnings: string[];
  /** The errors of the accepted text, when its side of the comparison was
   *  typeset past them. */
  baselineErrors?: string[];
  /** The round's own comparison is still rendering, or failed. */
  rendering?: "pending" | "failed";
  files: string;
  references?: References;
  /** The new version's complete PDF, when the host serves one, so the review
   * can show the changes in the whole paper. */
  pdf?: string;
  /** The build whose PDF the strips come from, and the chapters it compiled
   * (["full"] when it is the whole paper). */
  build?: { key: string; targets: string[] };
  /** Seed (when present), baseline and revised build keys. */
  builds?: string[];
  /** While that PDF compiles, a host may show each TeX pass of it: this URL
   * answers `?after=N` with `{ pass }`, a later pass whose PDF is `pdf?pass=`
   * that number, `{ pass: null }` once `pdf` is complete, or `{}` to ask
   * again. */
  passes?: string;
}
export type TaskState =
  "editing" | "building" | "build_failed" | "reviewing" | "revise" | "done";
export interface Summary {
  task: string;
  title: string;
  state: TaskState;
  round: number | null;
  counts: Record<Decision, number>;
  /** Undecided changes of the latest round that have a PDF comparison. */
  ready?: number;
  next: string;
}
export interface PageState {
  sourceEditing?: boolean;
  /** Accepting collects changes for the paper as decided, applied at the end. */
  deferred?: boolean;
  csrf: string;
  task: string;
  title: string;
  closed: boolean;
  /** Optional host-provided reason that file decisions or comments are unavailable. */
  decisionLock?: string | null;
  commentLock?: string | null;
  /** Optional host-provided reason that rejecting, undoing a rejection and
   *  editing source, which write the task's files, are unavailable while
   *  accepting and comments remain. */
  rejectLock?: string | null;
  /** Optional host-provided: the agent works, so a reject waits for its turn
   *  to end before it reverts the task's files; rejecting is available. */
  queueRejects?: boolean;
  /**
   * Host activity, undelivered feedback (all updates, and the comments among them),
   * and how many manuscript files this task's accepted changes touched.
   */
  workspace?: {
    merging?: boolean;
    deferred?: boolean;
    destination?: "workspace" | "commit" | "branch";
    status: string;
    unsent: number;
    comments?: number;
    accepted?: number;
  };
  state: TaskState | null;
  latest: number | null;
  /** Publication times for browsing earlier changes without revision numbers. */
  history?: { number: number; created: number }[];
  round: number | null;
  revision: string | null;
  decisions: Record<string, Decision>;
  comments: Record<string, string>;
  /** The round's own comparison is still rendering, or failed. */
  rendering?: "pending" | "failed";
  /** Changes still waiting for a comparison, even though the round exists. */
  waiting?: string[];
  /** Decided changes whose comparison changed after the decision. */
  reviewAgain?: string[];
  /** republish: the decision belongs to an earlier round, so undoing it
   *  inserts a round with its change pending again. */
  undo: { id: string; kind: ActionKind; changes: string[]; republish?: true; queued?: true } | null;
  /** Changes rejected while the agent works: shown rejected, reverted in its
   *  files once its turn ends. */
  queued?: string[];
  job:
    | (Pick<Job, "id" | "status" | "phase" | "created"> &
        JobResult & { ahead: number })
    | null;
}
export interface SourceExcerpt {
  round: number;
  change: string;
  file: string;
  revision: string;
  /** Zero-based, half-open line range in the current worktree. */
  start: number;
  end: number;
  text: string;
}
export interface SourceEditRequest {
  id: string;
  round: number;
  change: string;
  revision: string;
  text: string;
}
/** A whole text file of a task, for an editor beside the review: as it is in
 *  the task's worktree, and as it was when the task started (`base`, null
 *  for a file the task added). `reviewed` says the text is the latest
 *  round's, apart from the rejected changes listed in `reverted`, whose text
 *  came back; its other changes' `text_ops` then place them in it, once the
 *  reverted ones are put back, and `before` is the text they changed (the
 *  round's before version of the file). */
export interface SourceFileRead {
  round: number;
  file: string;
  revision: string;
  text: string;
  base: string | null;
  before: string | null;
  reviewed: boolean;
  reverted: string[];
}
/** Replaces a whole file of a task, which must still be at `revision`, and
 *  reviews the result in a new round. `round` is the one the file was read in. */
export interface SourceFileSave {
  id: string;
  round: number;
  file: string;
  revision: string;
  text: string;
}
export interface FeedbackItem {
  id: number;
  kind: Message["kind"];
  round: number | null;
  text?: string;
  changes?:
    | string[]
    | { id: string; file: string; lines: Span; old: string; new: string }[];
  not_reverted?: string[];
  undid?: string;
}
export interface Feedback extends Summary {
  feedback: FeedbackItem[];
  cursor: number;
  build_error?: JobResult;
  warnings?: string[];
}
export interface TaskInfo extends Summary {
  worktree: string;
  url: string;
  viewing: boolean;
  scope: { sections: string[]; files: string[] };
}

/** The paper as decided so far (engine core/applied.ts), as the review page reads it. */
export interface AppliedView {
  accepted: string;
  shown: { accepted: string; key: string; targets: string[]; round: number; at: number; current: boolean; pdf: string } | null;
  building: boolean;
  error?: { message: string; details: string[]; log?: string };
}
