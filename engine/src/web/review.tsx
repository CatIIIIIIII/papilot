import {
  Fragment,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ActionKind,
  AppliedView,
  ChangeBlock,
  PageState,
  PlaceView,
  RoundDetail,
  Strip,
  Unit,
  VisualUnit,
} from "../types.ts";
import { PdfStrip } from "./PdfStrip.tsx";
import { SourceEditor } from "./SourceEditor.tsx";
import { ChangeMap } from "./ChangeMap.tsx";
import { placeable, type PlacedChange } from "./paper.ts";
// pdf.js loads only when the full paper is shown.
const FullPaper = lazy(() => import("./FullPaper.tsx").then((module) => ({ default: module.FullPaper })));
const AppliedPaper = lazy(() => import("./AppliedPaper.tsx").then((module) => ({ default: module.AppliedPaper })));
// A hidden tab or a locked phone still polls; the server then knows nobody reads it.
const stateRoute = (round?: number | null) => {
  const query = new URLSearchParams();
  if (round) query.set("round", String(round));
  if (typeof document !== "undefined" && document.hidden) query.set("hidden", "1");
  const text = query.toString();
  return `/state${text ? `?${text}` : ""}`;
};
import { EFFECTS_EVENT, EFFECTS_STORAGE, readExpandedEffects } from "./effect-preferences.ts";
import { readView, VIEW_EVENT, VIEW_CHOSEN_EVENT, VIEW_STORAGE, type ReviewView } from "./view-preferences.ts";
import { language, locale, t, tn, withLanguage } from "./i18n.ts";
import {
  ConfirmReferences,
  ReferenceBanner,
  ReferenceEntries,
  risks,
  useReferenceChecks,
} from "./references.tsx";
import { bindingLabel, readShortcuts, resolveShortcuts, shortcutAction, SHORTCUT_EVENT, SHORTCUT_STORAGE } from "./shortcuts.ts";
import { sendsMessage } from "./send-key.ts";
import { CURRENT_CHANGE_EVENT, DECIDE_EVENT, OPEN_SOURCE_EVENT, REVIEW_CHANGES_EVENT, SELECT_SOURCE_EVENT, SOURCE_SAVED_EVENT, type CurrentChange, type DecideChange, type OpenSource, type ReviewChanges, type SelectSource, type SourceSaved } from "./review-events.ts";
import { DecisionQueue, Unreachable, withQueued, type QueuedDecision } from "./decision-queue.ts";
import {
  STATE,
  buildStops,
  copyReference,
  changeKinds,
  describeLocation,
  shortLocation,
  nextPending,
  commentScope,
  pendingUnits,
  progress,
  resolvedSide,
  stopState,
  STATUS,
  visibleStop,
  wordDiff,
} from "./model.ts";
const KIND = {
  text: "Text",
  layout: "Layout",
  position: "Moved",
  identical: "No visible change",
  unmapped: "Source only",
};
const ACTION: Record<string, string> = {
  accept: "Accept",
  reject: "Reject",
  comment: "Comment",
};
// A host can show a repository's uncommitted changes instead of a task's
// round (Papilot does, with ?changes). Accepting stages a change in the Git
// index, rejecting reverts it on disk, and a staged change can be unstaged.
// Every change stays in view: staged ones remain uncommitted.
const CHANGE_ACTION: Record<string, string> = {
  accept: "Stage",
  reject: "Revert",
  unstage: "Unstage",
};
const CHANGE_STATE: Record<string, string> = {
  pending: "Unstaged",
  accepted: "Staged",
  rejected: "Reverted",
  commented: "Edited",
  mixed: "Partly staged",
};
type Kind = ActionKind | "unstage";
const PHASE: Record<string, string> = {
  snapshot: "Taking a snapshot",
  build: "Compiling LaTeX",
  render: "Rendering the diff",
};
type Composer = {
  changes: string[];
  stop: number;
  key: string;
};
// A decision shown at once and confirmed later: the change it was made on,
// the toast for the review it completed, and a comment's stored draft.
type Queued = QueuedDecision & { kind: Kind; stop: number; done: string; draft?: string };
const actionId = () =>
  crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(20)), byte => byte.toString(16).padStart(2, '0')).join('');
function readStorage<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Storage is optional. */
  }
}
// The comment box grows with its text up to the height its style allows.
function fitComposer(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "0";
  element.style.height = `${element.scrollHeight}px`;
}
function jobText(job: PageState["job"]) {
  return job?.status === "queued"
    ? job.ahead
      ? tn(
          job.ahead,
          "Queued behind {n} update…",
          "Queued behind {n} updates…",
        )
      : t("Queued…")
    : `${t(PHASE[job?.phase ?? ""] || "Starting")}…`;
}

function ReviewProgress({ value, total, label }: { value: number; total: number; label: string }) {
  if (total === 0) return null;
  return (
    <div
      className="meter review-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={value}
      title={label}
    >
      <span aria-hidden="true"><span className="review-progress-value">{value}</span> / {total}</span>
    </div>
  );
}
export function ReviewApp({
  task,
  pinned,
  changes = false,
  transport,
  compileDecisions = true,
}: {
  task: string;
  pinned: number | null;
  changes?: boolean;
  /** A host can provide local review data without running the HTTP server. */
  transport?: <T>(route: string, body?: unknown) => Promise<T>;
  /** Static hosts use prepared comparisons without a compiler for decisions. */
  compileDecisions?: boolean;
}) {
  const [state, setState] = useState<PageState | null>(null),
    [publishedDetail, setDetail] = useState<RoundDetail | null>(null),
    [optionPreview, setOptionPreview] = useState<{ round: number; detail?: RoundDetail } | null>(null),
    [current, setCurrent] = useState(-1),
    [busy, setBusy] = useState(false),
    // Decisions not confirmed yet, and whether the state shown predates them.
    [queued, setQueued] = useState<readonly Queued[]>([]),
    [settling, setSettling] = useState(false),
    [online, setOnline] = useState(true),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [noteFocus, setNoteFocus] = useState<{ round: number; units: string[] | null } | null>(null),
    [openSource, setOpenSource] = useState<Set<number>>(new Set()),
    // Places past the first few of each edit, keyed by round and edit.
    [more, setMore] = useState<
      Record<string, PlaceView[] | "loading" | { error: string }>
    >({}),
    [composer, setComposer] = useState<Composer | null>(null),
    // Accepting bibliography entries that are not verified waits for this.
    [confirm, setConfirm] = useState<{
      kind: Kind;
      chosen: string[];
      body: string;
      items: { label: string; reasons: string[] }[];
    } | null>(null),
    [draft, setDraft] = useState(""),
    [help, setHelp] = useState(false),
    // A note can reveal a decided change without opening the history controls.
    [linkedChange] = useState(() => {
      const value = Number(new URLSearchParams(location.search).get("change") ?? -1);
      return Number.isSafeInteger(value) && value >= 0 ? value : -1;
    }),
    [history, setHistory] = useState(
      (Boolean(pinned) && linkedChange < 0) || new URLSearchParams(location.search).has("history"),
    );
  const previewing = Boolean(optionPreview && optionPreview.round === publishedDetail?.round);
  const detail = previewing && optionPreview?.detail ? optionPreview.detail : publishedDetail;
  const previewNow = useRef(previewing); previewNow.current = previewing;
  const paper = useRef<HTMLElement>(null),
    editedPlace = useRef<{ file: string; line: number; offset: number; paper: boolean } | null>(null),
    epoch = useRef(0),
    scrollUntil = useRef(0),
    // How far into the current change the author had read, restored once
    // when the review reopens on it in the same view.
    returning = useRef<{ index: number; offset: number; paper: boolean } | null>(null),
    // How the current change was reached, for the workspace: picked by the
    // author, followed while scrolling, or asked for from the source editor.
    reached = useRef<CurrentChange["from"]>("scroll"),
    snapshot = useRef({ state, detail: publishedDetail, busy, composer, current, open: openSource }),
    // Polls again at once, after the last queued decision is confirmed.
    pollNow = useRef(() => {}),
    failures = useRef(0),
    settle = useRef<{
      send: (entry: Queued) => Promise<PageState>;
      confirmed: (entry: Queued, next: PageState, remaining: readonly Queued[]) => void;
      failed: (entry: Queued, error: Error, dropped: Queued[]) => void;
    } | null>(null),
    queue = useRef<DecisionQueue<Queued, PageState> | null>(null);
  // Decisions go out one at a time, in order; the review moves on at once.
  // Uncommitted changes have no action journal to make a retry safe.
  // Unconfirmed decisions are kept in the browser, so that a reload, a closed
  // tab or a locked phone sends them later rather than losing them.
  const queueKey = changes ? null : `papilot:review:queue:${location.pathname}:${task}`;
  queue.current ??= new DecisionQueue<Queued, PageState>({
    send: entry => settle.current!.send(entry),
    confirmed: (entry, next, remaining) => settle.current!.confirmed(entry, next, remaining),
    failed: (entry, error, dropped) => settle.current!.failed(entry, error, dropped),
    retries: changes ? 0 : 4,
    ...(queueKey ? { storage: { key: queueKey } } : {}),
  });
  // What an earlier page decided and never had confirmed goes out once this
  // page has its state: the server takes decisions only with the token in it.
  const restored = useRef(false);
  useEffect(() => {
    if (!queueKey || transport || restored.current || !state?.csrf) return;
    restored.current = true;
    const saved = DecisionQueue.saved<Queued>(queueKey).filter((entry) => !queue.current!.pending.some((queued) => queued.id === entry.id));
    for (const entry of saved) queue.current!.push(entry);
    if (saved.length) { setQueued(queue.current!.pending); setSettling(true); }
  }, [Boolean(state?.csrf)]);
  useEffect(() => {
    if (!queueKey || transport) return;
    // A page that goes away sends what is left at once; the browser finishes
    // those requests even after the page is gone.
    const listener = (event: Event) => {
      if (document.visibilityState !== "hidden" && event.type !== "pagehide") return;
      const csrf = snapshot.current.state?.csrf ?? "";
      queue.current!.flush((entry) => {
        void fetch(`/api/tasks/${encodeURIComponent(task)}/decide`, {
          method: "POST",
          keepalive: true,
          headers: { "Content-Type": "application/json", "X-Review-Token": csrf },
          body: JSON.stringify({ id: entry.id, action: entry.kind, round: entry.round, changes: entry.changes, body: entry.body }),
        }).catch(() => undefined);
      });
    };
    document.addEventListener("visibilitychange", listener);
    window.addEventListener("pagehide", listener);
    return () => { document.removeEventListener("visibilitychange", listener); window.removeEventListener("pagehide", listener); };
  }, []);
  // Where each review was left; a host's uncommitted changes are kept per paper.
  const placeKey = `papilot:review:${location.pathname}:${changes ? 'changes' : task}`;
  const [shortcuts, setShortcuts] = useState(readShortcuts);
  // The whole paper with the changes in place, or the changed sections only.
  // A host may fix the view in the address (Papilot's manuscript chooses its
  // PDF with its own switch); otherwise it opens on the stored default.
  const [pinnedView] = useState<ReviewView | null>(() => {
    const value = new URLSearchParams(location.search).get("view");
    return value === "paper" || value === "changes" ? value : null;
  });
  const [view, setView] = useState<ReviewView>(() => pinnedView ?? readView());
  useEffect(() => {
    if (pinnedView) return;
    const chosen = (event: Event) => setView((event as CustomEvent).detail === "changes" ? "changes" : "paper");
    const stored = (event: StorageEvent) => { if (event.key === VIEW_STORAGE || event.key === null) setView(readView()); };
    window.addEventListener(VIEW_EVENT, chosen);
    window.addEventListener("storage", stored);
    return () => { window.removeEventListener(VIEW_EVENT, chosen); window.removeEventListener("storage", stored); };
  }, [pinnedView]);
  const [expandedEffects, setExpandedEffects] = useState(readExpandedEffects);
  // Per-edit disclosure is temporary and scoped to its round. Changing the
  // global preference resets those overrides without reloading the review.
  const [effectOverrides, setEffectOverrides] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const changed = (event: Event) => setExpandedEffects((event as CustomEvent).detail === true);
    const stored = (event: StorageEvent) => { if (event.key === EFFECTS_STORAGE || event.key === null) setExpandedEffects(readExpandedEffects()); };
    window.addEventListener(EFFECTS_EVENT, changed);
    window.addEventListener('storage', stored);
    return () => { window.removeEventListener(EFFECTS_EVENT, changed); window.removeEventListener('storage', stored); };
  }, []);
  useEffect(() => { setEffectOverrides({}); }, [expandedEffects]);
  useEffect(() => {
    const changed = (event: Event) => setShortcuts(resolveShortcuts((event as CustomEvent).detail));
    const stored = (event: StorageEvent) => { if (event.key === SHORTCUT_STORAGE || event.key === null) setShortcuts(readShortcuts()); };
    window.addEventListener(SHORTCUT_EVENT, changed);
    window.addEventListener('storage', stored);
    return () => { window.removeEventListener(SHORTCUT_EVENT, changed); window.removeEventListener('storage', stored); };
  }, []);
  useEffect(() => {
    const changed = (event: Event) => setNoteFocus((event as CustomEvent).detail || null);
    const preview = (event: Event) => {
      const value = (event as CustomEvent).detail || null;
      const transition = Boolean(value) !== previewNow.current;
      previewNow.current = Boolean(value);
      setOptionPreview(value);
      // Re-sending the current scope (including null) must not discard a
      // source editor or dialog the author just opened outside the drawer.
      if (transition) { setComposer(null); setConfirm(null); setOpenSource(new Set()); }
    };
    window.addEventListener("papilot:option-preview", preview);
    window.addEventListener("papilot:note-focus", changed);
    window.dispatchEvent(new Event("papilot:note-focus-ready"));
    return () => { window.removeEventListener("papilot:note-focus", changed); window.removeEventListener("papilot:option-preview", preview); };
  }, []);
  const focused = noteFocus?.round === detail?.round ? noteFocus?.units ?? undefined : undefined;
  const inFocus = (id: string) => !focused || focused.includes(id);
  function showHelp() {
    if (window.dispatchEvent(new Event('papilot:review:help', { cancelable: true }))) setHelp(true);
  }
  snapshot.current = { state, detail: publishedDetail, busy, composer, current, open: openSource };
  const units = useMemo(
      () => new Map(detail?.units.map((u) => [u.id, u]) ?? []),
      [detail],
    ),
    // Changes whose PDF comparison has not arrived: the author decides with
    // the comparison, so these cannot be accepted or rejected yet.
    waiting = useMemo(
      () => new Set(detail?.units.filter((u) => u.waiting).map((u) => u.id) ?? []),
      [detail],
    ),
    // Decided changes whose comparison changed after the decision.
    again = new Set(state?.round === detail?.round ? state?.reviewAgain ?? [] : []),
    stops = useMemo(() => (detail ? buildStops(detail) : []), [detail]),
    // The change blocks in the order and numbering of the changes view.
    placed = useMemo(() => {
      const list: PlacedChange[] = [];
      if (!detail) return list;
      for (const section of detail.sections)
        for (const block of section.blocks)
          if (block.kind === "change") list.push({ block, index: list.length });
      for (const block of detail.loose) list.push({ block, index: list.length });
      return list;
    }, [detail]),
    // An edit's places show under the first change that includes it.
    firstStop = useMemo(() => {
      const found = new Map<string, number>();
      stops.forEach((stop, i) =>
        stop.units.forEach((id) => found.has(id) || found.set(id, i)),
      );
      return found;
    }, [stops]),
    locations = useMemo(
      () =>
        stops.map((stop) =>
          describeLocation(
            stop.units.map((id) => units.get(id)!).filter(Boolean),
            t,
          ),
        ),
      [stops, units],
    ),
    // Queued decisions show as made until the server confirms or refuses them.
    decisions = useMemo(() => withQueued(state?.decisions ?? {}, queued), [state?.decisions, queued]),
    count = progress(decisions),
    undecided = Object.keys(decisions).filter(
      (id) => decisions[id] === "pending" && inFocus(id) && !waiting.has(id),
    ),
    references = useReferenceChecks(detail, api),
    hazards = useMemo(
      () => risks(detail?.references, references.checks, references.pending, references.confirmed),
      [detail, references.checks, references.pending, references.confirmed],
    ),
    // Batch acceptance leaves the changes whose entries need a look.
    batch = undecided.filter((id) => !hazards.has(id)),
    latest = Boolean(
      detail && state && detail.round === state.latest && !state.closed && !previewing,
    ),
    browsing = history || changes,
    label = (kind: string) => t((changes ? CHANGE_ACTION : ACTION)[kind] ?? kind),
    stateLabel = (value: string) =>
      t((changes ? CHANGE_STATE : STATE)[value] ?? value);
  // Keyboard handlers read the newest checks, not those of their render.
  const hazardsNow = useRef(hazards);
  hazardsNow.current = hazards;
  // What each button acts on: undecided changes, or in changes mode the
  // staged ones for Unstage and every change still on disk for Revert.
  const targets = (units: string[], kind: Kind) =>
    units.filter(inFocus).filter((id) => (kind === "comment" || !waiting.has(id)) && (
      kind === "unstage"
        ? decisions[id] === "accepted"
        : changes && kind === "reject"
          ? ["pending", "accepted"].includes(decisions[id])
          : decisions[id] === "pending"),
    );
  // Only undecided changes can be decided: a decided one is changed back
  // with Undo while that is possible. One still waiting for its comparison
  // can only be commented on.
  const kinds = (units: string[]): Kind[] =>
    !changes
      ? targets(units, "accept").length ? ["accept", "reject", "comment"] : targets(units, "comment").length ? ["comment"] : []
      : targets(units, "accept").length
        ? ["accept", "reject"]
        : targets(units, "unstage").length
          ? ["unstage", "reject"]
          : [];
  const navigation = stops
    .map((stop, index) => ({ stop, index }))
    .filter(({ stop, index }) => stop.units.some(inFocus) && (browsing || index === linkedChange || pendingUnits(stop, decisions).some(inFocus) || stop.units.some((id) => again.has(id))))
    .map(({ index }) => index);
  const adjacent = (index: number, direction: number) =>
    navigation[navigation.indexOf(index) + direction] ?? -1;
  const undoChanges = state?.undo
    ? stops.flatMap((stop, index) =>
        stop.units.some((id) => state.undo!.changes.includes(id))
          ? [index + 1]
          : [],
      )
    : [];
  useEffect(() => {
    if (browsing || composer) return;
    if (!navigation.includes(current)) setCurrent(navigation[0] ?? -1);
  }, [decisions, history, composer, detail, noteFocus]);
  useEffect(() => {
    if (changes && current < 0 && stops.length)
      setCurrent(Math.max(nextPending(stops, decisions), 0));
  }, [detail]);
  // What a change without its comparison shows instead of Accept and Reject.
  const waitingLabel = () =>
    detail?.rendering === "failed"
      ? t("PDF comparison failed")
      : detail && detail.round === state?.latest
        ? t("PDF comparison in progress")
        : t("No PDF comparison");
  // Lock reasons come from the host in English; known ones are translated.
  // Rejecting and editing source write the task's files, which a host can
  // lock on their own while its agent edits them; undoing a rejection too.
  const lockOf = (value: PageState | null | undefined, kind: Kind | "source") =>
    kind === "comment"
      ? value?.commentLock
      : value?.decisionLock || ((kind === "reject" && !value?.queueRejects) || kind === "source" ? value?.rejectLock : null);
  const actionLock = (kind: Kind | "source") => {
    if (previewing) return t("Confirm this option before reviewing its changes.");
    const reason = lockOf(state, kind);
    return reason ? t(reason) : reason;
  };
  // Undoing an accept of an earlier round publishes the task's files as a
  // new round, so like a rejection it waits while the agent edits them.
  // Undoing an applied rejection writes the task's files, like a source
  // edit; a reject still waiting for the agent's turn to end touched none.
  const undoKind = (value: PageState | null | undefined): Kind | "source" => (value?.undo?.kind === "reject" && !value.undo.queued) || value?.undo?.republish ? "source" : "accept";
  function blocked(kind: Kind | "source"): boolean {
    if (previewNow.current) { setToast(t("Confirm this option before reviewing its changes.")); return true; }
    const reason = lockOf(snapshot.current.state, kind);
    if (reason) setToast(t(reason));
    return Boolean(reason);
  }
  async function api<T>(route: string, body?: unknown): Promise<T> {
    if (body !== undefined && previewNow.current) throw new Error(t("Confirm this option before reviewing its changes."));
    if (transport) return transport<T>(route, body);
    const response = await fetch(
      `${changes ? "/api/changes" : `/api/tasks/${encodeURIComponent(task)}`}${route}`,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Review-Token": snapshot.current.state?.csrf ?? "",
            },
            body: JSON.stringify(body),
          },
    ).catch((error: Error) => {
      // The request may or may not have arrived.
      throw new Unreachable(error.message);
    });
    const value = await response.json().catch((error) => {
      if (response.ok) throw error;
      return {};
    });
    if (!response.ok) {
      const message = value.error || `HTTP ${response.status}`;
      // A gateway or a restarting host did not answer for the server. The
      // same decision sent again by a page that came back, while the server
      // still applies the first send, is refused for now: it is sent again
      // too, and then confirmed as applied.
      throw [502, 503, 504].includes(response.status) || (response.status === 400 && /review action is already in progress/i.test(message)) ? new Unreachable(message) : new Error(message);
    }
    return value as T;
  }
  function select(index: number, scroll = true) {
    if (index < 0 || index >= stops.length) return;
    if (scroll && reached.current !== "source") reached.current = "pick";
    if (scroll) returning.current = null;
    setCurrent(index);
    store(placeKey, {
      round: detail?.round,
      stop: stops[index].key,
    });
    if (scroll) {
      scrollUntil.current = Date.now() + 800;
      requestAnimationFrame(() => {
        const article = paper.current?.querySelector<HTMLElement>(
          `[data-stop="${index}"]`,
        );
        if (article) reveal(article, "smooth");
        article?.focus({ preventScroll: true });
      });
    }
  }
  // How far the paper is scrolled past the top of a change; 0 when revealed.
  function past(article: HTMLElement) {
    const root = paper.current!;
    // scrollIntoView also scrolls ancestors across the embedding iframe.
    // Navigation belongs to the paper, independently of the host's Chat.
    const padding = parseFloat(getComputedStyle(root).scrollPaddingTop) || 0;
    const margin = parseFloat(getComputedStyle(article).scrollMarginTop) || 0;
    return root.getBoundingClientRect().top + padding + margin - article.getBoundingClientRect().top;
  }
  function reveal(article: HTMLElement, behavior: ScrollBehavior = "instant") {
    const root = paper.current;
    if (!root) return;
    const index = Number(article.dataset.stop), back = returning.current;
    let offset = 0;
    if (back && back.index === index && back.paper === paperView) { offset = back.offset; returning.current = null; }
    root.scrollTo({ top: root.scrollTop - past(article) + offset, behavior });
  }
  // The place within the current change is kept as the author reads on.
  function remember(index: number) {
    const article = paper.current?.querySelector<HTMLElement>(`[data-stop="${index}"]`);
    if (!article || !stops[index]) return;
    store(placeKey, { round: detail?.round, stop: stops[index].key, offset: Math.round(past(article)), paper: paperView });
  }
  // Reading into the next change makes it current, which resizes its header;
  // measure the place again once it has, unless a reveal is on its way.
  useEffect(() => {
    if (current >= 0 && !returning.current && Date.now() >= scrollUntil.current && paper.current?.scrollTop) remember(current);
  }, [current]);
  // The workspace's source editor follows the current change, and asks for
  // the change at a line of a file.
  const unitLines = (unit: Unit): [number, number][] => unit.whole_file
    ? [[Math.max(0, unit.new_start - 1), unit.new_end]]
    : unit.ops.filter((op) => op[0] !== "equal").map((op) => [op[3], op[4]]);
  function announce(index: number) {
    const from = reached.current;
    reached.current = "scroll";
    if (!stops[index]) return;
    const detail: CurrentChange = {
      stop: index, from,
      units: stops[index].units.map((id) => units.get(id)).filter((unit): unit is NonNullable<typeof unit> => Boolean(unit && unit.kind === "text" && unit.status !== "deleted"))
        .map((unit) => ({ id: unit.id, file: unit.file, lines: unitLines(unit) })),
    };
    window.dispatchEvent(new CustomEvent(CURRENT_CHANGE_EVENT, { detail }));
  }
  useEffect(() => { if (current >= 0) announce(current); }, [current, detail]);
  // The workspace's editor shows the changes in their files, with Accept and
  // Reject, which decide them here as the buttons on the page do.
  function announceChanges() {
    if (!detail) return;
    const changes: ReviewChanges["changes"] = detail.units.filter((unit) => unit.kind === "text" && unit.status !== "deleted" && unit.text_ops?.length)
      .map((unit) => ({ id: unit.id, file: unit.file, ops: unit.text_ops!, decision: decisions[unit.id] ?? "pending", confirmed: state?.decisions?.[unit.id] ?? "pending" }));
    const cards: ReviewChanges["stops"] = stops.map((stop, index) => ({ title: t("Change {n}", { n: index + 1 }), units: stop.units,
      actions: kinds(stop.units).map((kind) => ({ kind, label: label(kind), lock: actionLock(kind) ?? null })) }));
    window.dispatchEvent(new CustomEvent<ReviewChanges>(REVIEW_CHANGES_EVENT, { detail: { round: detail.round, changes, stops: cards, labels: { before: t("Before"), after: t("After") } } }));
  }
  useEffect(announceChanges, [detail, decisions, state]);
  useEffect(() => {
    const chosen = (event: Event) => {
      const request = (event as CustomEvent<DecideChange & { again?: boolean }>).detail, { round, changes: ids, action } = request;
      if (detail?.round !== round || !["accept", "reject", "comment"].includes(action)) return;
      const kind = action as Kind;
      if (kind !== "comment") { void decide(kind, targets(ids, kind)); return; }
      // A comment belongs to its card, which becomes current first.
      const index = stops.findIndex((stop) => stop.units.some((id) => ids.includes(id)));
      if (index >= 0 && index !== current && !request.again) {
        select(index);
        requestAnimationFrame(() => window.dispatchEvent(new CustomEvent(DECIDE_EVENT, { detail: { ...request, again: true } })));
        return;
      }
      beginComposer(targets(ids, "comment"));
    };
    window.addEventListener(DECIDE_EVENT, chosen);
    return () => window.removeEventListener(DECIDE_EVENT, chosen);
  });
  // A change's source, offered to the workspace's editor: true when it opened there.
  function offerSource(chosen: Unit[]) {
    // The editor shows the task's files as they are now, with the latest
    // round's changes. An earlier round, a closed task or a previewed option
    // keeps the inline LaTeX, and so do changes without character-level
    // operations, such as a new file or a bibliography entry, which have no
    // card in the editor.
    if (!latest || !detail) return false;
    const shown = chosen.filter((item) => item.kind === "text" && item.status !== "deleted");
    if (!shown.length || shown.some((item) => !item.text_ops?.length)) return false;
    // Nor can the editor place cards in a file with CRLF line endings, whose
    // offsets count the carriage returns; its context shows them.
    if (shown.some((item) => /\r/.test(item.old_text + item.new_text + (item.old_context?.text ?? "")))) return false;
    const unit = shown[0];
    const marks = chosen.filter((item) => item.file === unit.file && item.kind === "text").flatMap(unitLines);
    if (!marks.length) return false;
    const request: OpenSource = { round: detail.round, change: unit.id, file: unit.file, marks,
      lines: [Math.min(...marks.map((range) => range[0])), Math.max(...marks.map((range) => Math.max(range[1], range[0] + 1)))] };
    // The editor shows the changes of the round it opens in.
    announceChanges();
    return !window.dispatchEvent(new CustomEvent(OPEN_SOURCE_EVENT, { detail: request, cancelable: true }));
  }
  useEffect(() => {
    const choose = (event: Event) => {
      const { file, line } = (event as CustomEvent<SelectSource>).detail;
      let best = -1, distance = Infinity;
      stops.forEach((stop, index) => stop.units.forEach((id) => {
        const unit = units.get(id);
        if (!unit || unit.file !== file) return;
        for (const [from, to] of unitLines(unit)) {
          const away = line < from ? from - line : line >= Math.max(to, from + 1) ? line - Math.max(to, from + 1) + 1 : 0;
          if (away < distance) { distance = away; best = index; }
        }
      }));
      // Only a line in or right beside a change has one.
      if (best < 0 || distance > 1 || best === current) return;
      reached.current = "source";
      select(best);
    };
    window.addEventListener(SELECT_SOURCE_EVENT, choose);
    return () => window.removeEventListener(SELECT_SOURCE_EVENT, choose);
  });
  // A file saved in the workspace's editor shows as an edit made here: the
  // review continues from the new state, at the edited place.
  useEffect(() => {
    const saved = (event: Event) => {
      const { state: next, file, line } = (event as CustomEvent<SourceSaved>).detail;
      const article = paper.current?.querySelector<HTMLElement>(`[data-stop="${current}"]`);
      editedPlace.current = { file, line: line + 1, offset: article ? past(article) : 0, paper: paperView };
      epoch.current++; setState(next);
    };
    window.addEventListener(SOURCE_SAVED_EVENT, saved);
    return () => window.removeEventListener(SOURCE_SAVED_EVENT, saved);
  });
  useEffect(() => {
    let cancelled = false,
      polling = false,
      again = false,
      timer: ReturnType<typeof setTimeout>;
    // While decisions wait for confirmation, a poll could show them undone.
    const waiting = () => snapshot.current.busy || queue.current!.pending.length > 0;
    async function poll() {
      if (polling) { again = true; return; }
      polling = true;
      clearTimeout(timer);
      const requestedEpoch = epoch.current;
      try {
        const previous = snapshot.current,
          number = pinned || previous.detail?.round,
          next = await api<PageState>(
            stateRoute(number),
          );
        if (
          cancelled ||
          epoch.current !== requestedEpoch ||
          waiting()
        )
          return;
        setOnline(true);
        setError("");
        setSettling(false);
        const unavailable = (value: PageState) => value.state === "building" || value.state === "build_failed" || Boolean(value.rendering);
        // A new source round can precede its PDF, or retain a failed build.
        // Clear only the previous build's success message, not action feedback.
        if (unavailable(next)) setToast(message => message === t("Changes are ready") ? "" : message);
        const target = pinned || next.latest;
        const changed = Boolean(
          target &&
          (target !== previous.detail?.round ||
            (next.revision && next.revision !== previous.detail?.after) ||
            // The round's own comparison arrived, or failed.
            (next.round === previous.detail?.round && (next.rendering ?? null) !== (previous.detail?.rendering ?? null))));
        if (changed && !snapshot.current.composer && !paper.current?.querySelector('.source-editor[data-dirty="true"]')) {
          const [loadedState, loaded] = await Promise.all([
            api<PageState>(stateRoute(target)),
            api<RoundDetail>(`/rounds/${target}`),
          ]);
          if (
            cancelled ||
            epoch.current !== requestedEpoch ||
            waiting()
          )
            return;
          const nextStops = buildStops(loaded),
            saved = readStorage<{ round?: number; stop?: string; offset?: number; paper?: boolean }>(
              placeKey,
              {},
            );
          let index =
            saved.round === target
              ? nextStops.findIndex((s) => s.key === saved.stop)
              : -1;
          if (
            index < 0 ||
            !pendingUnits(nextStops[index], loadedState.decisions).length
          )
            index = nextPending(nextStops, loadedState.decisions, index);
          if (linkedChange >= 0 && nextStops[linkedChange]) index = linkedChange;
          // The same round with its comparisons in place keeps the change the
          // author is on, and the changes whose source is open.
          const same = previous.detail?.round === loaded.round,
            oldStops = same ? buildStops(previous.detail!) : [],
            moved = (old: number) => {
              const ids = oldStops[old]?.units ?? [];
              return nextStops.findIndex((stop) => stop.units.some((id) => ids.includes(id)));
            },
            article = same ? paper.current?.querySelector<HTMLElement>(`[data-stop="${previous.current}"]`) : null;
          if (same && moved(previous.current) >= 0) index = moved(previous.current);
          if (index < 0) index = pinned && nextStops.length ? 0 : -1;
          const edited = editedPlace.current;
          if (edited) {
            const candidates = nextStops.flatMap((stop, i) => loaded.units.filter(unit => unit.file === edited.file && stop.units.includes(unit.id)).map(unit => ({ index: i, distance: Math.abs(unit.new_start - edited.line) })));
            candidates.sort((a, b) => a.distance - b.distance);
            if (candidates.length) index = candidates[0].index;
          }
          returning.current =
            edited && index >= 0 ? { index, offset: edited.offset, paper: edited.paper } : article && index >= 0 ? { index, offset: past(article), paper: Boolean(saved.paper) } : !previous.detail && index >= 0 && saved.round === target && nextStops[index].key === saved.stop && saved.offset
              ? { index, offset: saved.offset, paper: Boolean(saved.paper) }
              : null;
          if (
            previous.detail &&
            loaded.round !== previous.detail.round &&
            !pinned
          )
            setHistory(false);
          setState(loadedState);
          setDetail(loaded);
          setCurrent(index);
          setOpenSource(new Set(same ? [...previous.open].map(moved).filter((i) => i >= 0) : edited && index >= 0 ? [index] : []));
          editedPlace.current = null;
          if (same && index >= 0)
            requestAnimationFrame(() => {
              const shown = paper.current?.querySelector<HTMLElement>(`[data-stop="${index}"]`);
              if (shown) reveal(shown);
            });
          if (previous.detail && !loaded.rendering && !unavailable(loadedState) && (!same || previous.detail.rendering))
            setToast(t("Changes are ready"));
        } else {
          setState(next);
          // The PDF and job status are read separately. If the PDF arrived
          // first, announce it when the publication's status catches up. A
          // newer version held back by an open composer or unsaved source is
          // not shown yet, so it is not ready.
          if (!changed && previous.detail && !previous.detail.rendering && !unavailable(next) &&
              (previous.state?.state === "building" || previous.state?.state === "build_failed"))
            setToast(t("Changes are ready"));
        }
      } catch (e) {
        if (!cancelled) {
          setOnline(false);
          setError((e as Error).message);
        }
      } finally {
        polling = false;
        if (cancelled) { /* Stopped. */ }
        else if (again) { again = false; void poll(); }
        else timer = setTimeout(poll, document.hidden ? 10000 : 1500);
      }
    }
    pollNow.current = () => void poll();
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      pollNow.current = () => {};
    };
  }, [task, pinned, transport]);
  useEffect(() => {
    if (paperView) return;
    if (detail && current >= 0)
      requestAnimationFrame(() => {
        const article = paper.current?.querySelector<HTMLElement>(`[data-stop="${current}"]`);
        if (article) reveal(article);
      });
  }, [detail?.round]);
  useEffect(() => {
    if (state) document.title = `${t(state.title)} · LaTeX Review`;
  }, [state?.title]);
  // Host styles can tell the two modes apart.
  useEffect(() => {
    if (changes) document.documentElement.dataset.mode = "changes";
  }, [changes]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  function beginComposer(changes = targets(stops[current]?.units ?? [], "comment")) {
    if (
      !latest ||
      !changes.length ||
      busy ||
      state?.closed ||
      blocked("comment")
    )
      return;
    const scoped = focused !== undefined || changes.length !== stops[current]?.units.length;
    const event = new CustomEvent('papilot:review:comment', { cancelable: true, detail: {
      round: detail?.round, stop: current, changes,
      ...(scoped ? { scope: commentScope(changes.map(id => units.get(id)!).filter(Boolean)) } : {}),
    } });
    if (!window.dispatchEvent(event)) return;
    const key = `papilot:review:${task}:draft:${detail?.round}:${changes.join(",")}`;
    setDraft(readStorage(key, ""));
    setComposer({ changes, stop: current, key });
  }
  function closeComposer(sent = false) {
    if (composer) store(composer.key, sent ? "" : draft);
    setComposer(null);
  }
  async function decide(
    kind: Kind,
    chosen = targets(stops[current]?.units ?? [], kind),
    body = "",
    confirmed = false,
  ) {
    // A comment written while a newer round arrived goes out on the round it
    // was written on: the server carries it to the same change there.
    const sendable = latest || (kind === "comment" && Boolean(detail && state && !state.closed && !previewing));
    if (
      !chosen.length ||
      snapshot.current.busy ||
      !sendable ||
      !detail ||
      blocked(kind)
    )
      return;
    if (kind === "accept" && !confirmed) {
      const items = chosen.flatMap((id) => hazardsNow.current.get(id) ?? []);
      if (items.length) {
        setConfirm({ kind, chosen, body, items });
        return;
      }
    }
    // The review moves on at once; the server confirms decisions in order.
    const entry: Queued = { id: actionId(), kind, round: detail.round, changes: chosen, body, stop: current, done: "" };
    // A comment's draft stays stored until the server has the comment.
    if (kind === "comment" && composer) {
      entry.draft = composer.key;
      closeComposer();
    }
    const after = withQueued(snapshot.current.state?.decisions ?? {}, [...queue.current!.pending, entry]);
    const target = pendingUnits(stops[current], after).some(inFocus) ? current : nextPending(stops, after, current, focused);
    if (target < 0)
      entry.done = changes
        ? (kind === "accept" ? t("All changes are staged.") : "")
        : focused ? t("Review complete") : t("All changes reviewed. Your decisions are saved.");
    epoch.current++;
    queue.current!.push(entry);
    setQueued(queue.current!.pending);
    setSettling(true);
    if (target >= 0 && target !== current) select(target);
    if (target < 0 && !browsing) setCurrent(-1);
  }
  settle.current = {
    send: (entry) =>
      api<PageState>("/decide", {
        id: entry.id,
        action: entry.kind,
        round: entry.round,
        changes: entry.changes,
        body: entry.body,
      }),
    confirmed(entry, next, remaining) {
      epoch.current++;
      // Undo, waiting for the queue, reads the newest confirmed state.
      snapshot.current.state = next;
      setState(next);
      setQueued(remaining);
      // The host refreshes what depends on the decision, such as Git status.
      window.dispatchEvent(new CustomEvent("papilot:review:decided"));
      if (entry.draft) store(entry.draft, "");
      if (!remaining.length) {
        if (entry.done) setToast(entry.done);
        pollNow.current();
      }
    },
    failed(entry, error, dropped) {
      epoch.current++;
      failures.current++;
      setQueued([]);
      const message = dropped.length
        ? `${error.message} ${tn(dropped.length, "{n} later decision was not sent.", "{n} later decisions were not sent.")}`
        : error.message;
      setToast(message);
      // Back to the change whose decision failed, still undecided.
      if (entry.round === snapshot.current.detail?.round && stops[entry.stop]) select(entry.stop);
      if (entry.kind === "comment" && entry.draft && !snapshot.current.composer) { setDraft(entry.body); setComposer({ changes: entry.changes, stop: entry.stop, key: entry.draft }); }
      pollNow.current();
    },
  };
  async function undo() {
    // The snapshot has the decision confirmed a moment ago, before this
    // render's state does: Undo pressed right after a decision takes it back.
    if ((!snapshot.current.state?.undo && !queue.current!.pending.length) || !latest || snapshot.current.busy)
      return;
    // The latest decision has not been sent yet: it is simply dropped, and
    // nothing reaches the server or compiles.
    const withdrawn = queue.current!.withdraw();
    if (withdrawn) {
      epoch.current++;
      setQueued(queue.current!.pending);
      if (withdrawn.draft) store(withdrawn.draft, withdrawn.body);
      setHistory(false);
      if (withdrawn.round === detail?.round && stops[withdrawn.stop]) select(withdrawn.stop);
      setToast(changes ? t("Revert undone. The changes are back in your files.") : t("Last decision undone. The restored changes need review again."));
      return;
    }
    epoch.current++;
    setBusy(true);
    snapshot.current.busy = true;
    try {
      // Undo takes back the last decision, so the queued ones go first. If
      // one fails, the decision Undo was meant for was never made.
      const failed = failures.current;
      await queue.current!.drained();
      const last = snapshot.current.state?.undo;
      if (failures.current !== failed || !last || blocked(undoKind(snapshot.current.state))) return;
      const next = await api<PageState & { restored: string[] }>("/undo", {
        id: last.id,
      });
      setState(next);
      window.dispatchEvent(new CustomEvent("papilot:review:decided"));
      // An undo of an earlier round's accept inserted the next round.
      if (next.latest !== snapshot.current.detail?.round) pollNow.current();
      const target = stops.findIndex((s) =>
        s.units.some((id) => next.restored.includes(id)),
      );
      setHistory(false);
      if (target >= 0) select(target);
      setToast(
        changes
          ? t("Revert undone. The changes are back in your files.")
          : t("Last decision undone. The restored changes need review again."),
      );
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      epoch.current++;
      setBusy(false);
      snapshot.current.busy = false;
    }
  }
  async function submitComposer() {
    if (!composer || !draft.trim() || busy) return;
    await decide("comment", composer.changes, draft.trim());
  }
  function toggleSource(index: number) {
    // A workspace with its own editor shows the source there, not on the page.
    if (!openSource.has(index) && offerSource((stops[index]?.units ?? []).map((id) => units.get(id)!).filter(Boolean))) return;
    setOpenSource((previous) => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }
  async function copy(index: number) {
    if (!detail || !state) return;
    const selected = window.getSelection()?.toString().trim() ?? "",
      known = stops[index].units.map((id) => units.get(id)!).filter(Boolean);
    try {
      await navigator.clipboard.writeText(
        copyReference(
          state.title,
          detail.round,
          index + 1,
          describeLocation(known),
          selected,
        ),
      );
      setToast(
        selected
          ? t("Copied selected text with file, lines and PDF page.")
          : t("Copied the change location."),
      );
    } catch (e) {
      setToast(
        t(
          "Clipboard unavailable. Select the PDF text and use your browser’s Copy command.",
        ),
      );
    }
  }
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target as HTMLElement,
        typing =
          target.matches("input,textarea,select") || target.isContentEditable;
      if (event.key === "Escape") {
        if (confirm) setConfirm(null);
        else if (help) setHelp(false);
        else if (composer) closeComposer();
        return;
      }
      if (typing || help || confirm || window.getSelection()?.toString()) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void undo();
        return;
      }
      if (composer) return;
      const action = shortcutAction(event, shortcuts);
      if (!action || (changes && action === 'comment')) return;
      event.preventDefault();
      const waits = !changes && (stops[current]?.units ?? []).some((id) => waiting.has(id) && decisions[id] === "pending");
      if ((action === 'accept' || action === 'reject') && waits && !targets(stops[current]?.units ?? [], "accept").length)
        setToast(waitingLabel());
      else if (action === 'accept')
        void decide(kinds(stops[current]?.units ?? [])[0] ?? "accept");
      else if (action === 'reject') void decide("reject");
      else if (action === 'comment') beginComposer();
      else if (action === 'next')
        select(adjacent(current, 1));
      else if (action === 'previous')
        select(adjacent(current, -1));
      else if (action === 'pending') select(nextPending(stops, decisions, current, focused));
      else if (action === 'source') toggleSource(current);
      else if (action === 'undo') void undo();
      else if (action === 'help') showHelp();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [state, queued, detail, current, busy, composer, draft, help, confirm, history, shortcuts, noteFocus]);
  function onScroll() {
    if (
      !paper.current ||
      composer ||
      Date.now() < scrollUntil.current ||
      window.getSelection()?.toString()
    )
      return;
    const box = paper.current.getBoundingClientRect(),
      regions = [...paper.current.querySelectorAll<HTMLElement>("[data-stop]")]
        .filter((article) => navigation.includes(Number(article.dataset.stop)))
        .map((article) => {
          const b = article.getBoundingClientRect();
          return {
            index: Number(article.dataset.stop),
            top: b.top,
            bottom: b.bottom,
          };
        });
    const index = visibleStop(regions, current, box.top + 60, box.bottom - 100);
    if (index !== current) { reached.current = "scroll"; select(index, false); }
    if (index >= 0) remember(index);
  }
  const actionBar = (index: number) => {
    if (index !== current || !state) return null;
    const units = stops[index].units.filter(inFocus),
      available = kinds(units),
      remaining = nextPending(stops, decisions, current, focused),
      waits = !changes && units.some((id) => waiting.has(id) && decisions[id] === "pending");
    return (
      <div className="dock">
        <nav className="actions" aria-label={t("Review the current change")}>
          {navigation.length > 1 && (
            <>
              <button
                className="nav"
                aria-label={t("Previous change")}
                aria-keyshortcuts={shortcuts.previous.join(' ')}
                title={[t('Previous change'), shortcuts.previous.map(bindingLabel).join(' / ')].filter(Boolean).join(' · ')}
                disabled={adjacent(index, -1) < 0}
                onClick={() => select(adjacent(index, -1))}
              >
                ‹
              </button>
              <span className="position">
                {navigation.indexOf(index) + 1} / {navigation.length}
              </span>
            </>
          )}
          {available.length ? (
            <>
              {available.map((kind) => {
                const keys = shortcuts[kind === 'unstage' ? 'accept' : kind],
                  count = targets(units, kind).length;
                return (
                  <button
                    className={kind}
                    key={kind}
                    aria-keyshortcuts={keys.join(' ')}
                    title={
                      actionLock(kind) ||
                      [label(kind) + (count > 1 && kind !== "comment" ? ` (${count})` : ""), keys.map(bindingLabel).join(' / ')].filter(Boolean).join(' · ')
                    }
                    aria-describedby={
                      actionLock(kind) ? "review-lock" : undefined
                    }
                    disabled={busy || !latest || Boolean(actionLock(kind))}
                    // The next change's bar takes this one's place at once;
                    // a double click decides only the change it began on.
                    onClick={(event) =>
                      kind === "comment" ? beginComposer() : event.detail < 2 && void decide(kind)
                    }
                  >
                    {label(kind)}
                    {count > 1 && kind !== "comment" ? ` (${count})` : ""}
                  </button>
                );
              })}
              {waits && (
                <span className="comparison-pending" data-state={detail?.rendering ?? "pending"} role="status">
                  {waitingLabel()}
                </span>
              )}
            </>
          ) : remaining >= 0 ? (
            <button
              className="skip"
              aria-keyshortcuts={shortcuts.pending.join(' ')}
              title={[changes ? t("Next unstaged") : t("Next undecided"), shortcuts.pending.map(bindingLabel).join(' / ')].filter(Boolean).join(' · ')}
              onClick={() => select(remaining)}
            >
              {changes ? t("Next unstaged") : t("Next undecided")}
            </button>
          ) : (
            <span className="complete">
              {changes
                ? stateLabel(stopState(units, decisions))
                : latest
                  ? t("Review complete")
                  : t("Earlier changes")}
            </span>
          )}
          {navigation.length > 1 && (
            <button
              className="nav"
              aria-label={t("Next change")}
              aria-keyshortcuts={shortcuts.next.join(' ')}
              title={[t('Next change'), shortcuts.next.map(bindingLabel).join(' / ')].filter(Boolean).join(' · ')}
              disabled={adjacent(index, 1) < 0}
              onClick={() => select(adjacent(index, 1))}
            >
              ›
            </button>
          )}
        </nav>
      </div>
    );
  };
  async function loadPlaces(id: string) {
    const round = detail!.round,
      key = `${round}:${id}`;
    setMore((m) => ({ ...m, [key]: "loading" }));
    try {
      const { places } = await api<{ places: PlaceView[] }>(
        `/rounds/${round}/effects/${encodeURIComponent(id)}`,
      );
      setMore((m) => ({ ...m, [key]: places }));
    } catch (error) {
      setMore((m) => ({ ...m, [key]: { error: (error as Error).message } }));
    }
  }
  // Places produced by a verified combination containing this edit. These
  // previews do not change which source edit an accept/reject action applies.
  function effects(
    unit: Unit & Partial<VisualUnit>,
    clean: boolean,
  ): ReactNode {
    const { total, shown } = unit.effects!,
      key = `${detail!.round}:${unit.id}`,
      open = effectOverrides[key] ?? (expandedEffects || unit.visual === "unmapped" || unit.visual === "identical"),
      bodyId = `effects-${detail!.round}-${unit.id}`,
      loaded = more[key],
      places = [...shown, ...(Array.isArray(loaded) ? loaded : [])],
      strips = (items: Strip[], side: "before" | "after") =>
        items.length > 0 && (
          <div
            className={`side ${side}`}
            aria-label={side === "before" ? t("Before") : t("After")}
          >
            {items.map((image) => (
              <PdfStrip
                key={image.src}
                image={image}
                base={detail!.files}
                label={side === "before" ? t("Before") : t("After")}
                clean={clean}
              />
            ))}
          </div>
        );
    return (
      <section className="effects" key={unit.id}>
        <p className="effects-head">
          <button className="link effects-toggle" aria-expanded={open} aria-controls={bodyId}
            onClick={() => setEffectOverrides((values) => ({ ...values, [key]: !open }))}>
            <span aria-hidden="true">{open ? "▾" : "▸"}</span>{" "}
            {tn(total, "{n} related PDF change", "{n} related PDF changes")}
          </button>
        </p>
        <div id={bodyId} hidden={!open}>
          {open && (
            <>
              {unit.effects!.verified && (
                <p className="caption">
                  {t("These previews show one verified combination of edits. Other or smaller combinations may produce the same result. Accepting or rejecting applies only to the selected edit.")}
                </p>
              )}
              {places.map((place, i) => (
                <div className="place" key={i}>
                  <p className="place-where">
                    {t("p. {pages}", { pages: place.page })}
                    {place.section ? ` · ${place.section}` : ""}
                    {place.with
                      ? ` · ${t("with {changes}", {
                          changes: place.with
                            .map((id) =>
                              firstStop.has(id)
                                ? t("Change {n}", { n: firstStop.get(id)! + 1 })
                                : (units.get(id)?.file ?? id),
                            )
                            .join(", "),
                        })}`
                      : ""}
                  </p>
                  {strips(place.before, "before")}
                  {strips(place.after, "after")}
                </div>
              ))}
              {total > places.length && (
                <button
                  className="link more-places"
                  disabled={loaded === "loading"}
                  onClick={() => void loadPlaces(unit.id)}
                >
                  {loaded === "loading"
                    ? t("Loading…")
                    : tn(
                        total - places.length,
                        "Show {n} more",
                        "Show {n} more",
                      )}
                </button>
              )}
              {loaded && typeof loaded === "object" && "error" in loaded && (
                <p className="caption">{loaded.error}</p>
              )}
            </>
          )}
        </div>
      </section>
    );
  }
  function change(
    block: ChangeBlock,
    index: number,
    inline: boolean,
  ): ReactNode {
    const known = block.units.map((id) => units.get(id)!).filter(Boolean),
      // A .bib edit is shown entry by entry, every field, rather than as
      // the bibliography's typeset lines alone.
      bib = detail!.references?.entries.filter((e) => (e.units ?? [e.unit]).some((id) => block.units.includes(id))) ?? [],
      uncited = detail!.references?.missing.filter((m) => m.unit && block.units.includes(m.unit)) ?? [],
      status = stopState(block.units, decisions),
      reviewed = !pendingUnits(stops[index], decisions).length,
      // Focusing a note may reveal its own decided group. It must not expand
      // unrelated accepted/rejected groups or turn the review into history.
      focusedBlock = Boolean(focused?.some(id => block.units.includes(id))),
      // A decision made with an earlier comparison is shown again when this
      // change's own comparison looks different.
      reviewAgain = block.units.some((id) => again.has(id)),
      expanded = focusedBlock || browsing || index === linkedChange || reviewAgain,
      // A reverted change shows the text that is back on disk; staged and
      // unstaged ones keep their before and after.
      resolved = focusedBlock || history || index === linkedChange
        ? undefined
        : changes
          ? status === "rejected"
            ? "before"
            : undefined
          : resolvedSide(block.units, decisions) ||
            (status === "commented" ? "after" : undefined),
      source =
        openSource.has(index) ||
        (!bib.length && !block.waiting &&
          (block.identical || (!block.before.length && !block.after.length))),
      remarks = [
        ...new Set(
          block.units.map((id) => state?.comments[id]).filter(Boolean),
        ),
      ],
      location = describeLocation(known, t),
      kindLabel = bib.length
        ? t("Bibliography")
        : block.reflow
        ? t("Reflow")
        : changeKinds(known)
            .map((kind) => t(KIND[kind]))
            .join(", ");
    const images = (items: Strip[], side: "before" | "after") => (
      <div
        className={`side ${side}${block.identical ? " identical" : ""}`}
        aria-label={side === "before" ? t("Before") : t("After")}
      >
        {items.map((image) => (
          <PdfStrip
            key={image.src}
            image={image}
            base={detail!.files}
            label={side === "before" ? t("Before") : t("After")}
            clean={Boolean(resolved)}
            focus={focused}
          />
        ))}
      </div>
    );
    return (
      <article
        key={index}
        className={`change ${inline ? "inline" : "standalone"}${current === index ? " current" : ""}${reviewed && !expanded ? " reviewed-change" : ""}${reviewed && !expanded && !resolved ? " mixed-reviewed" : ""}`}
        data-note-focus={focused ? "true" : undefined}
        data-stop={index}
        data-units={block.units.join(" ")}
        data-option-preview={previewing ? "true" : undefined}
        data-state={status}
        data-resolved={resolved}
        tabIndex={-1}
        onClick={() => {
          if (!block.units.some(inFocus) || composer || (!expanded && reviewed)) return;
          reached.current = "pick";
          if (index !== current) select(index, false);
          else announce(index);
        }}
      >
        {reviewed && !expanded && !resolved && (
          <p className="reviewed-placeholder">
            <button
              className="link"
              onClick={() => {
                setHistory(true);
                select(index, false);
              }}
            >
              {t("Reviewed changes · View in History")}
            </button>
          </p>
        )}
        <header className="change-head">
          {/* The English number and location are kept for tools that quote
              them to an agent, whatever the interface language. */}
          <span className="change-number" data-change={index + 1} title={t("Change {n}", { n: index + 1 })}>
            <span className="change-number-full">{t("Change {n}", { n: index + 1 })}</span>
            <span className="change-number-short" aria-hidden="true">#{index + 1}</span>
          </span>
          <span
            className="change-where"
            title={location}
            data-location={describeLocation(known)}
          >
            {shortLocation(known, t)}
          </span>
          {actionBar(index)}
          {kindLabel && !block.waiting && <span className="change-kind" title={kindLabel}>{kindLabel}</span>}
          {(() => {
            // One edit that still sits in several changes says where else and why.
            const linked = (block.linked ?? []).flatMap((link) =>
              stops.flatMap((other, at) => (at !== index && other.units.includes(link.unit) ? [{ at, reason: link.reason }] : [])));
            if (!linked.length) return null;
            const others = [...new Set(linked.map((link) => link.at))];
            return (
              <button
                type="button"
                className="change-kind change-linked"
                title={t(linked.some((link) => link.reason === "moved")
                  ? "The same edit now prints elsewhere, on another page or in a float."
                  : "The same edit prints in several places in the PDF.")}
                onClick={(event) => { event.stopPropagation(); select(others[0]); }}
              >
                {t("Same edit as change {list}", { list: others.map((at) => at + 1).join(", ") })}
              </button>
            );
          })()}
          {block.carried !== undefined && (() => {
            // Rounds are named by when they were published, as in History.
            const published = state?.history?.find((entry) => entry.number === block.carried)?.created,
              time = published ? new Intl.DateTimeFormat(locale(), { timeStyle: "short" }).format(new Date(published * 1000)) : "";
            return (
              <span className="change-carried" title={t("This change's own PDF comparison is still rendering. This comparison was rendered for the same change in the changes published at {time}.", { time })}>
                {time ? t("PDF from {time}", { time }) : t("Earlier PDF")}
              </span>
            );
          })()}
          {reviewAgain && (
            <span className="change-again" title={t("The PDF comparison changed after your decision.")}>
              {t("Review again")}
            </span>
          )}
          {status !== "pending" && (
            block.units.some((id) => state?.queued?.includes(id)) && status === "rejected"
              ? <span className="badge" title={t("Rejected; reverted when the agent stops")}>{t("Rejected · reverted when the agent stops")}</span>
              : <span className="badge" title={stateLabel(status)}>{stateLabel(status)}</span>
          )}
          <button
            className="link copy-reference"
            title={t(
              "Copy selected text with this change’s file, line numbers and PDF page",
            )}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => void copy(index)}
          >
            {t("Copy reference")}
          </button>
          <button
            className={`link source-toggle ${source ? "active" : ""}`}
            title={[t('Show LaTeX source'), shortcuts.source.map(bindingLabel).join(' / ')].filter(Boolean).join(' · ')}
            aria-keyshortcuts={shortcuts.source.join(' ')}
            aria-expanded={source}
            onClick={() => toggleSource(index)}
          >
            {block.units.length > 1
              ? t("{n} edits · LaTeX", { n: block.units.length })
              : "LaTeX"}
          </button>
        </header>
        {known.some((u) => u.history?.length) && (
          <div className="histories">
            {known
              .flatMap((u) => u.history ?? [])
              .map((h, i) => (
                <p key={i}>
                  <strong>
                    {t("Revised after your comment: ")}
                  </strong>
                  “{h.comment}”
                </p>
              ))}
          </div>
        )}
        {block.waiting && (
          <p className="comparison-waiting" data-state={detail?.rendering ?? "pending"}>
            {detail?.rendering !== "failed" && detail?.round === state?.latest && <span className="pulse" aria-hidden="true" />}
            {waitingLabel()}
          </p>
        )}
        {!block.identical &&
          !block.reflow &&
          block.before.length > 0 &&
          images(block.before, "before")}
        {block.after.length > 0 && images(block.after, "after")}
        {block.identical && !bib.length && (
          <p className="caption">
            {t("No visible change in the PDF; see the LaTeX source.")}
          </p>
        )}
        {block.reflow && (
          <p className="caption">
            {t("Continued: only line breaks moved here.")}
          </p>
        )}
        {remarks.length > 0 && (
          <div className="remark">
            {remarks.map((r, i) => (
              <p key={i}>
                <strong>{t("Your comment: ")}</strong>
                {r}
              </p>
            ))}
          </div>
        )}
        {uncited.length > 0 && (
          <p className="reference-problem reference-uncited">
            {uncited
              .map((m) => t("Cites {key}, which no bibliography entry defines.", { key: m.key }))
              .join(language().startsWith("zh") ? "" : " ")}
          </p>
        )}
        {bib.length > 0 && (
          <ReferenceEntries
            entries={bib}
            checks={references.checks}
            pending={references.pending > 0}
            onRetry={references.retry}
            confirmed={references.confirmed}
            onConfirm={(id, on) =>
              void references.confirm(id, on).catch((e) => setToast((e as Error).message))
            }
          />
        )}
        {source && (
          <div className="source">
            {known.map((unit) => (
              <div
                className="source-unit"
                data-state={decisions[unit.id]}
                key={unit.id}
              >
                <SourceEditor key={`${detail!.round}:${unit.id}`} task={task} round={detail!.round} change={unit.id} api={api}
                  editable={Boolean(!previewing && state?.sourceEditing && !changes && !pinned && unit.kind !== "binary")}
                  building={Boolean(state?.job && ["queued", "running"].includes(state.job.status))}
                  locked={!latest ? t("A newer round is available. Reload the page.") : decisions[unit.id] === "rejected" ? t("This change was rejected. Undo that decision before editing it.") : actionLock("source") || (waiting.has(unit.id) && detail!.rendering !== "failed" ? t("PDF comparison in progress") : null)}
                  onSaving={saving => { snapshot.current.busy = saving; setBusy(saving); }}
                  onOpen={() => offerSource([unit])}
                  onSaved={next => {
                    const article = paper.current?.querySelector<HTMLElement>(`[data-stop="${index}"]`);
                    editedPlace.current = { file: unit.file, line: unit.new_start, offset: article ? past(article) : 0, paper: paperView };
                    epoch.current++; setState(next);
                  }}
                  title={<span className="source-location" title={unit.file}>
                    {unit.file.slice(unit.file.lastIndexOf("/") + 1)} ·{" "}
                    {t("lines {start}–{end}", {
                      start: unit.new_start,
                      end: unit.new_end,
                    })}
                  </span>}
                  actions={known.length > 1 && (
                    <span className="unit-actions">
                      <span className="unit-state">
                        {decisions[unit.id] !== "pending"
                          ? stateLabel(decisions[unit.id]).toLowerCase()
                          : ""}
                      </span>
                      {(changes || decisions[unit.id] === "pending") &&
                        kinds([unit.id]).map((kind) => (
                          <button
                            className={kind}
                            key={kind}
                            title={actionLock(kind) || label(kind)}
                            aria-describedby={
                              actionLock(kind) ? "review-lock" : undefined
                            }
                            disabled={
                              busy || !latest || Boolean(actionLock(kind))
                            }
                            onClick={(event) =>
                              kind === "comment"
                                ? beginComposer([unit.id])
                                : event.detail < 2 && void decide(kind, [unit.id])
                            }
                          >
                            {label(kind)}
                          </button>
                        ))}
                    </span>
                  )}>
                {unit.kind === "binary" ? (
                  <p>{t("Binary file changed.")}</p>
                ) : (
                  <pre className="source-code">
                    {wordDiff(unit.old_text, unit.new_text).map((part, i) =>
                      part.type === "del" ? (
                        <del key={i}>{part.text}</del>
                      ) : part.type === "ins" ? (
                        <ins key={i}>{part.text}</ins>
                      ) : (
                        <Fragment key={i}>{part.text}</Fragment>
                      ),
                    )}
                  </pre>
                )}
                {unit.truncated && (
                  <p className="muted">
                    {t("Long change: the source is shortened.")}
                  </p>
                )}
                </SourceEditor>
              </div>
            ))}
          </div>
        )}
        {known
          .filter((u) => u.effects && firstStop.get(u.id) === index)
          .map((u) => effects(u, Boolean(resolved)))}
      </article>
    );
  }
  // A deferred task's PDF is the paper as decided so far, compiled after each
  // decision: switching to it never starts a compilation.
  const appliedPaper = compileDecisions && Boolean(state?.deferred ?? state?.workspace?.deferred) && !changes && Boolean(detail),
    fullPaper = !pinnedView && (appliedPaper || (Boolean(detail?.pdf) && placeable(placed))),
    paperView = fullPaper && view === "paper";
  const applied = useApplied(appliedPaper && paperView, api);
  // The comparisons of the next few undecided changes are fetched and decoded
  // ahead, so the next one is on screen the moment a decision moves on. A
  // small window keeps a phone's memory free.
  const preloaded = useRef(new Map<string, HTMLImageElement>());
  useEffect(() => {
    if (!detail || paperView) return;
    const decided = withQueued(state?.decisions ?? {}, queued), wanted: string[] = [];
    for (let step = 0, seen = 0; step < stops.length && seen < 4; step++) {
      const index = ((current < 0 ? 0 : current) + step) % stops.length, block = placed[index]?.block;
      if (!block || stops[index].waiting || !pendingUnits(stops[index], decided).length) continue;
      seen++;
      for (const image of [...(block.before ?? []), ...(block.after ?? [])]) wanted.push(detail.files + (focused ? image.clean : image.src));
      // The strips on the page load now too, rather than when the scroll
      // to them nears: the next change is complete the moment it is current.
      paper.current?.querySelectorAll<HTMLImageElement>(`[data-stop="${index}"] .pdf-strip img`).forEach((img) => { img.loading = "eager"; });
    }
    const keep = new Set(wanted);
    for (const url of [...preloaded.current.keys()]) if (!keep.has(url)) preloaded.current.delete(url);
    for (const url of wanted) {
      if (preloaded.current.has(url)) continue;
      const image = new Image();
      image.decoding = "async";
      image.src = url;
      void image.decode().catch(() => undefined);
      preloaded.current.set(url, image);
    }
  }, [detail, stops, placed, current, queued, state?.decisions, focused, paperView]);
  // What the author reads now compiles first: the page says which view it
  // shows while it is on screen.
  useEffect(() => {
    if (changes || transport || !task) return;
    const mode = paperView ? "pdf" : "changes";
    // Only with the page's token, which the first state brings.
    const look = () => { if (!document.hidden && snapshot.current.state?.csrf) void api("/look", { mode }).catch(() => undefined); };
    look();
    const timer = setInterval(look, 5000);
    document.addEventListener("visibilitychange", look);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", look); };
  }, [task, paperView, changes, Boolean(state?.csrf)]);
  // A host shows its own switch while the whole paper can be shown.
  useEffect(() => {
    const root = document.documentElement;
    if (fullPaper) root.dataset.fullPaper = "available";
    else delete root.dataset.fullPaper;
  }, [fullPaper]);
  useEffect(() => {
    const root = document.documentElement;
    if (detail?.round) {
      root.dataset.papilotRound = String(detail.round);
      window.dispatchEvent(new Event("papilot:round"));
    } else delete root.dataset.papilotRound;
  }, [detail?.round]);
  // Keep the selected change in view when the view changes, from here or the host.
  const shownView = useRef(paperView);
  useEffect(() => {
    if (shownView.current === paperView) return;
    shownView.current = paperView;
    // FullPaper restores its own reading position after its pages are sized.
    if (paperView) return;
    requestAnimationFrame(() => {
      const article = paper.current?.querySelector<HTMLElement>(`[data-stop="${snapshot.current.current}"]`);
      if (article) reveal(article);
    });
  }, [paperView]);
  // The switch changes this review only; the default is a Papilot setting.
  function chooseView(next: ReviewView) {
    setView(next);
    window.dispatchEvent(new CustomEvent(VIEW_CHOSEN_EVENT, { detail: next }));
  }
  let index = 0;
  return (
    <>
      <header className="bar">
        <div className="identity">
          <h1>{state?.title ?? "LaTeX Review"}</h1>
          <span className="muted">
            {changes
              ? t("Since the last commit")
              : detail
                ? (detail.round === state?.latest ? t("Current changes") : t("Earlier changes"))
                : ""}
          </span>
        </div>
        <ReviewProgress
          value={changes ? count.accepted : count.decided}
          total={changes ? count.accepted + count.pending : count.total}
          label={changes
            ? t("{staged} of {total} staged", {
                staged: count.accepted,
                total: count.accepted + count.pending,
              })
            : t("{decided} of {total} decided", {
                decided: count.decided,
                total: count.total,
              })}
        />
        <div className="bar-end">
          {/* Batch decisions cover only undecided changes; accepted,
              rejected and commented changes keep their state. A single
              undecided change is decided from its own bar. */}
          {undecided.length > 1 && batch.length > 0 && (
            <button
              className="ghost accept accept-all"
              disabled={
                busy ||
                !latest ||
                Boolean(composer) ||
                Boolean(state?.decisionLock)
              }
              title={
                state?.decisionLock ||
                [
                  changes
                    ? tn(
                        batch.length,
                        "Stage the {n} unstaged change.",
                        "Stage the {n} unstaged changes.",
                      )
                    : tn(
                        batch.length,
                        "Accept {n} undecided change",
                        "Accept {n} undecided changes",
                      ),
                  undecided.length > batch.length
                    ? tn(
                        undecided.length - batch.length,
                        "Leaves {n} change with bibliography entries to check.",
                        "Leaves {n} changes with bibliography entries to check.",
                      )
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")
              }
              aria-label={
                changes
                  ? t("Stage all ({n})", { n: batch.length })
                  : t("Accept all ({n})", { n: batch.length })
              }
              aria-describedby={state?.decisionLock ? "review-lock" : undefined}
              onClick={() => void decide("accept", batch)}
            >
              <span className="batch-label">
                {changes ? t("Stage all") : t("Accept all")}
              </span>
              <span className="batch-count">{batch.length}</span>
            </button>
          )}
          {undecided.length > 1 && !changes && (
            <button
              className="ghost reject reject-all"
              disabled={
                busy ||
                !latest ||
                Boolean(composer) ||
                Boolean(lockOf(state, "reject"))
              }
              title={
                actionLock("reject") ||
                tn(
                  undecided.length,
                  "Reject {n} undecided change",
                  "Reject {n} undecided changes",
                )
              }
              aria-label={t("Reject all ({n})", { n: undecided.length })}
              aria-describedby={lockOf(state, "reject") ? "review-lock" : undefined}
              onClick={() => void decide("reject", undecided)}
            >
              <span className="batch-label">{t("Reject all")}</span>
              <span className="batch-count">{undecided.length}</span>
            </button>
          )}
          {/* "All decided" would repeat the meter's "N of N decided". */}
          {(!online ||
            state?.closed ||
            !["reviewing", "done"].includes(state?.state ?? "")) && (
            <span
              className="status"
              role="status"
              data-state={!online ? "offline" : state?.state}
            >
              {!online
                ? t("Reconnecting…")
                : state?.closed
                  ? t("Finished")
                  : state?.state === "building"
                    ? jobText(state.job)
                    : changes && state?.state === "build_failed"
                      ? t("Comparison failed")
                      : t(STATUS[state?.state ?? ""] ?? "")}
            </span>
          )}
          {/* Changes keep no history; the last revert can be undone. */}
          {changes && state?.undo && (
            <button
              className="ghost undo"
              disabled={!latest || busy || Boolean(lockOf(state, undoKind(state)))}
              title={actionLock(undoKind(state)) || [t('Undo revert'), shortcuts.undo.map(bindingLabel).join(' / ')].filter(Boolean).join(' · ')}
              aria-keyshortcuts={shortcuts.undo.join(' ')}
              onClick={() => void undo()}
            >
              {t("Undo revert")}
            </button>
          )}
          {fullPaper && (
            <div className="view-switch" role="group" aria-label={t("Review view")}>
              <button
                className={`ghost${view === "paper" ? " active" : ""}`}
                aria-pressed={view === "paper"}
                onClick={() => chooseView("paper")}
              >
                PDF
              </button>
              <button
                className={`ghost${view === "changes" ? " active" : ""}`}
                aria-pressed={view === "changes"}
                onClick={() => chooseView("changes")}
              >
                {t("Changes")}
              </button>
            </div>
          )}
          {/* History is a toolbar action; its own row appears only while
              browsing earlier decisions. */}
          {detail && !history && !changes && (
            <button
              className="ghost history"
              title={t("Review history")}
              onClick={() => {
                setHistory(true);
                if (current < 0 && stops.length) setCurrent(0);
              }}
            >
              {t("History")}
            </button>
          )}
          <button
            className="ghost round"
            aria-label={t("Keyboard shortcuts")}
            onClick={showHelp}
          >
            ?
          </button>
        </div>
      </header>
      {detail && history && (
        <nav className="review-mode" aria-label={t("Review view")}>
          <label>
            {t("History")}{" "}
            <select
              aria-label={t("Review history")}
              value={detail.round}
              onChange={(e) => {
                location.href = withLanguage(
                  `?task=${encodeURIComponent(task)}&round=${e.target.value}&history=1`,
                );
              }}
            >
              {Array.from(
                { length: state?.latest || detail.round },
                (_, i) => i + 1,
              )
                .reverse()
                .map((round) => (
                  <option key={round} value={round}>
                    {round === state?.latest ? t("Current changes") : (() => {
                      const published = state?.history?.find(entry => entry.number === round)?.created;
                      return published ? new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "medium" }).format(new Date(published * 1000)) : t("Earlier changes");
                    })()}
                  </option>
                ))}
            </select>
          </label>
          {state?.undo && (
            <button
              className="ghost undo"
              disabled={!latest || busy || Boolean(lockOf(state, undoKind(state)))}
              title={
                actionLock(undoKind(state)) ||
                t("Undo {action} · {changes}", {
                  action: t(
                    ACTION[state.undo.kind] ?? state.undo.kind,
                  ).toLowerCase(),
                  changes: tn(
                    undoChanges.length,
                    "Change {list}",
                    "Changes {list}",
                    { list: undoChanges.join(", ") },
                  ),
                })
              }
              onClick={() => void undo()}
            >
              {t("Undo last decision")}
            </button>
          )}
          <button
            className="ghost"
            onClick={() => {
              if (pinned)
                location.href = withLanguage(
                  `?task=${encodeURIComponent(task)}`,
                );
              else {
                setHistory(false);
                setCurrent(nextPending(stops, decisions, -1, focused));
              }
            }}
          >
            {t("Back to review")}
          </button>
        </nav>
      )}
      <div className="review-body">
        <main id="paper" ref={paper} tabIndex={-1} onScroll={onScroll}>
          {changes && detail && !count.pending && (count.accepted > 0 || !stops.length) && (
            <div className="review-complete" role="status" tabIndex={-1}>
              <strong>
                {count.accepted
                  ? t("All changes are staged")
                  : t("No uncommitted changes")}
              </strong>
              <span>
                {count.accepted
                  ? t("Commit them when you are ready.")
                  : t("The PDF matches the last commit.")}
              </span>
              <div className="review-complete-actions" />
            </div>
          )}
          {!changes && detail && !history && !count.pending && (
            <div className="review-complete" role="status" tabIndex={-1}>
              <strong>
                {t(
                  state?.workspace?.status === "waiting_input"
                    ? "Agent needs your input"
                    : state?.workspace?.status === "queued"
                      ? "Feedback queued"
                      : state?.workspace?.status === "running"
                        ? "Feedback sent · Agent is working"
                        : state?.workspace?.status === "building" ||
                            state?.state === "building"
                          ? "Preparing the next review…"
                          : state?.workspace?.merging ? "Merge review" : "All changes reviewed",
                )}
              </strong>
              {/* What the decisions leave to do is known once the host has
                  them all; until then the line stays empty, never stale. */}
              <span>
                {!settling && t(
                  state?.workspace?.status === "waiting_input"
                    ? "Open Chat to answer the agent's question."
                    : ["running", "queued", "building"].includes(
                          state?.workspace?.status || "",
                        ) || state?.state === "building"
                      ? "New changes will appear here when ready."
                      : state?.workspace?.merging
                        ? "Your manuscript is unchanged until you save the merged result."
                        : state?.workspace?.comments
                        ? "Your comments are saved. Continue in Chat to request a revision."
                        : state?.workspace?.deferred
                          ? state.workspace.accepted
                            ? "Choose how to save the accepted changes to your manuscript."
                            : state.workspace.destination === "branch"
                              ? "Choose how to save the accepted changes to your manuscript."
                              : (state.workspace.destination === "workspace" || state.workspace.destination === "commit")
                                ? "Accepted changes are in your manuscript."
                                : "There are no accepted changes to save."
                        : state?.workspace?.accepted
                          ? "Accepted changes are in your manuscript."
                          : state?.workspace?.unsent && !count.accepted
                            ? "Your decisions are saved. Send them to the agent to continue."
                            : count.commented && !state?.workspace
                              ? "Your comments are saved for the agent."
                              : "There are no new changes to review. Previous decisions are available in History.",
                )}
              </span>
              {/* A host such as Papilot puts its next step here, for example a commit. */}
              <div className="review-complete-actions" />
            </div>
          )}
          {(state?.commentLock || state?.decisionLock || state?.rejectLock) && (
            <div className="banner" id="review-lock" role="status">
              {t((state.commentLock || state.decisionLock || state.rejectLock)!)}
            </div>
          )}
          {state?.closed && !state.commentLock && (
            <div className="banner">
              {t(
                "This review is finished. Accepted changes are in your manuscript.",
              )}
            </div>
          )}
          {state?.state === "build_failed" && (
            <div className="banner">
              <strong>
                {changes
                  ? t("The comparison could not be built: ")
                  : t("The latest publish failed: ")}
              </strong>
              {state.job?.error}
              {state.job?.details && (
                <pre className="details">{state.job.details.join("\n")}</pre>
              )}
            </div>
          )}
          {state?.state === "building" && detail && !state.decisionLock && (
            <div className="banner">
              {changes
                ? t(
                    "Updating the comparison with your latest edits. You can keep staging and reverting meanwhile.",
                  )
                : t(
                    "Updating changes…",
                  )}
            </div>
          )}
          {!changes && detail && state?.latest && detail.round !== state.latest && (
            <div className="banner">
              {t("Viewing earlier changes.")}{" "}
              <a href={withLanguage(`?task=${encodeURIComponent(task)}`)}>
                {t("Back to current changes →")}
              </a>
            </div>
          )}
          {detail?.warnings.length ? (
            <div className="banner">
              <details>
                <summary>
                  {tn(
                    detail.warnings.length,
                    "{n} new LaTeX warning",
                    "{n} new LaTeX warnings",
                  )}
                </summary>
                <pre className="details">{detail.warnings.join("\n")}</pre>
              </details>
            </div>
          ) : null}
          {/* A task that fixes a compilation error starts from text that
              does not compile: its Before pages went on past the errors. */}
          {detail?.baselineErrors?.length ? (
            <div className="banner">
              <details>
                <summary>
                  {t("The text before these changes has compilation errors. Its pages show what LaTeX typeset after skipping them.")}
                </summary>
                <pre className="details">{detail.baselineErrors.join("\n")}</pre>
              </details>
            </div>
          ) : null}
          {detail?.references &&
            (detail.references.entries.length > 0 ||
              detail.references.missing.length > 0) && (
              <ReferenceBanner
                references={detail.references}
                checks={references.checks}
                pending={references.pending}
                confirmed={references.confirmed}
                changeOf={(unit) => (unit ? (firstStop.get(unit) ?? -1) : -1)}
                onSelect={(index) => select(index)}
                onRetry={references.retry}
              />
            )}
          <div className="document">
            {detail && paperView && appliedPaper ? (
              <Suspense fallback={<div className="paper-status" role="status"><div className="pulse" /></div>}>
                {applied?.shown ? (
                  <AppliedPaper
                    key={`${placeKey}:applied`}
                    url={applied.shown.pdf}
                    buildKey={applied.shown.key}
                    scrollRoot={paper}
                    status={<AppliedStatus applied={applied} />}
                  />
                ) : (
                  <div className="paper-status" role={applied?.error ? "alert" : "status"}>
                    {applied?.error ? <AppliedStatus applied={applied} /> : <><div className="pulse" /><p>{t("Compiling your decisions…")}</p></>}
                  </div>
                )}
              </Suspense>
            ) : detail && paperView ? (
              <>
                <Suspense fallback={<div className="paper-status" role="status"><div className="pulse" /></div>}>
                <FullPaper
                  key={`${placeKey}:pdf:${detail.round}:${detail.pdf}`}
                  url={detail.pdf!}
                  passes={detail.passes}
                  changes={placed}
                  render={(block, at) => change(block, at, true)}
                  scrollRoot={paper}
                  place={`${placeKey}:pdf:${detail.round}`}
                  restorePlace={linkedChange < 0}
                  onReady={restored => {
                    if (restored) return;
                    const article = paper.current?.querySelector<HTMLElement>(
                      `[data-stop="${snapshot.current.current}"]`,
                    );
                    if (article) reveal(article);
                  }}
                  onUnavailable={() => chooseView("changes")}
                />
                </Suspense>
                {!stops.length && !changes && (
                  <p className="empty">{t("No changes to review.")}</p>
                )}
              </>
            ) : detail ? (
              <>
                {detail.sections.map((section) => (
                  <section className="part" key={section.node}>
                    <h2 className="part-title">
                      <span className="number">{section.number}</span>
                      {section.title}
                    </h2>
                    <div className="sheet">
                      {section.blocks.map((block, b) =>
                        block.kind === "context" ? (
                          <div className="context" key={`context-${b}`}>
                            <PdfStrip
                              image={block.image}
                              base={detail.files}
                              label={t("Unchanged text")}
                            />
                          </div>
                        ) : block.kind === "gap" ? (
                          <div
                            className="fold"
                            key={`gap-${b}`}
                            title={t("Unchanged text is folded")}
                          >
                            ⋯
                          </div>
                        ) : (
                          change(block, index++, true)
                        ),
                      )}
                    </div>
                  </section>
                ))}
                {detail.loose.length > 0 && (
                  <section className="part">
                    {detail.sections.length > 0 && (
                      <h2 className="part-title">{t("Other changes")}</h2>
                    )}
                    {detail.loose.map((block) => change(block, index++, false))}
                  </section>
                )}
                {!stops.length && !changes && (
                  <p className="empty">{t("No changes to review.")}</p>
                )}
              </>
            ) : error ? (
              <p className="empty" role="alert">
                {error}
              </p>
            ) : (
              <div className="waiting">
                <div className="pulse" />
                <p>
                  {state?.state === "building"
                    ? jobText(state.job)
                    : changes
                      ? t("Comparing with the last commit…")
                      : t("Waiting for the agent to publish its changes.")}
                </p>
                <p className="muted">{t("This page updates by itself.")}</p>
              </div>
            )}
          </div>
        </main>
        <ChangeMap
          scrollRoot={paper}
          stops={stops}
          showReviewed={browsing}
          locations={locations}
          decisions={decisions}
          current={current}
          disabled={Boolean(composer)}
          onSelect={select}
        />
      </div>
      {composer && (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void submitComposer();
          }}
        >
          <div className="composer-head">
            <label htmlFor="composer-text">
              {t("Comment on change {n}", { n: composer.stop + 1 })}
            </label>
            <button
              type="button"
              className="composer-close"
              aria-label={t("Cancel")}
              title={t("Cancel")}
              onClick={() => closeComposer()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <textarea
            id="composer-text"
            ref={fitComposer}
            autoFocus
            rows={3}
            value={draft}
            onKeyDown={(event) => {
              if (sendsMessage(event.nativeEvent, window.matchMedia('(pointer: coarse)').matches)) {
                event.preventDefault();
                void submitComposer();
              }
            }}
            onChange={(e) => {
              setDraft(e.target.value);
              store(composer.key, e.target.value);
              fitComposer(e.target);
            }}
            placeholder={t("What should the agent change here?")}
          />
          <div className="composer-row">
            <span className="muted">{t("↵ send · Esc cancel")}</span>
            <button
              type="submit"
              className="composer-send"
              aria-label={t("Send")}
              title={state?.commentLock ? t(state.commentLock) : t("Send")}
              aria-describedby={state?.commentLock ? "review-lock" : undefined}
              disabled={busy || !draft.trim() || Boolean(state?.commentLock)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 19V5m-7 7 7-7 7 7" />
              </svg>
            </button>
          </div>
        </form>
      )}
      {toast && (
        <div className="toast" role="alert">
          {toast}
        </div>
      )}
      {confirm && (
        <ConfirmReferences
          items={confirm.items}
          staging={changes}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const chosen = confirm;
            setConfirm(null);
            void decide(chosen.kind, chosen.chosen, chosen.body, true);
          }}
        />
      )}
      {help && (
        <div className="help-backdrop" onClick={() => setHelp(false)}>
          <dialog
            open
            aria-labelledby="help-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="help-title">{t("Keyboard shortcuts")}</h2>
            <dl>
              {(changes
                ? [
                    [shortcuts.accept.map(bindingLabel).join(' / '), "Stage or unstage"],
                    [shortcuts.reject.map(bindingLabel).join(' / '), "Revert"],
                    [shortcuts.next.map(bindingLabel).join(' / '), "Next change"],
                    [shortcuts.previous.map(bindingLabel).join(' / '), "Previous change"],
                    [shortcuts.pending.map(bindingLabel).join(' / '), "Next unstaged"],
                    [shortcuts.source.map(bindingLabel).join(' / '), "Show LaTeX source"],
                    [["⌘Z / Ctrl+Z", ...shortcuts.undo.map(bindingLabel)].join(' / '), "Undo revert"],
                    ["⌘C / Ctrl+C", "Copy selected PDF text"],
                  ]
                : [
                    [shortcuts.accept.map(bindingLabel).join(' / '), "Accept"],
                    [shortcuts.reject.map(bindingLabel).join(' / '), "Reject"],
                    [shortcuts.comment.map(bindingLabel).join(' / '), "Comment"],
                    [shortcuts.next.map(bindingLabel).join(' / '), "Next change"],
                    [shortcuts.previous.map(bindingLabel).join(' / '), "Previous change"],
                    [shortcuts.pending.map(bindingLabel).join(' / '), "Next undecided"],
                    [shortcuts.source.map(bindingLabel).join(' / '), "Show LaTeX source"],
                    [["⌘Z / Ctrl+Z", ...shortcuts.undo.map(bindingLabel)].join(' / '), "Undo"],
                    ["⌘C / Ctrl+C", "Copy selected PDF text"],
                  ]
              ).map(([key, label]) => (
                <Fragment key={label}>
                  <dt>
                    <kbd>{t(key)}</kbd>
                  </dt>
                  <dd>{t(label)}</dd>
                </Fragment>
              ))}
            </dl>
            <p className="muted">
              {t(
                "Select text directly in the PDF preview. Copy reference includes the selection and its file, line numbers and page. Review shortcuts pause while text is selected.",
              )}
            </p>
            <button onClick={() => setHelp(false)}>{t("Close")}</button>
          </dialog>
        </div>
      )}
    </>
  );
}

// The paper as decided so far, polled while it is on screen.
function useApplied(active: boolean, api: <T>(route: string, body?: unknown) => Promise<T>) {
  const [applied, setApplied] = useState<AppliedView | null>(null), request = useRef(api);
  request.current = api;
  useEffect(() => {
    if (!active) return;
    let live = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await request.current<AppliedView>("/applied");
        if (live) setApplied((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
      } catch { /* The next poll tries again. */ }
      if (live) timer = setTimeout(poll, document.hidden ? 10000 : 1500);
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [active]);
  return applied;
}
// Beside the pages while they are not the current decisions: updating, or
// why the accepted changes did not compile together.
function AppliedStatus({ applied }: { applied: AppliedView }) {
  const [open, setOpen] = useState(false);
  if (applied.error && !applied.building)
    return (
      <div className="paper-updating applied-error" role="alert">
        <span>{t("Your accepted changes do not compile together.")}</span>
        <button type="button" className="ghost" onClick={() => setOpen(!open)}>{t("Details")}</button>
        {open && <pre className="applied-details">{[applied.error.message, ...applied.error.details].join("\n")}</pre>}
      </div>
    );
  if (applied.shown?.current && !applied.building) return null;
  return (
    <div className="paper-updating" role="status">
      <span className="pulse" />
      <span>{t("Updating with your latest decisions…")}</span>
    </div>
  );
}
