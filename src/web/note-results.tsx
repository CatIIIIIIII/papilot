import type { RoundDetail } from '../../engine/src/types.ts';
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { NoteChange, NoteResult, NoteOption, NoteOptions, Task, TimelineItem } from '../shared.ts';
import { readNotesInstructions } from '../notes.ts';
import { NoteOptionDiff, NoteOptionSource } from './note-option-diff.tsx';
import { Icon } from './icons.tsx';
import { errorText, t } from './i18n.ts';
import { reviewDraft, useReviewDraft } from './review-draft.ts';
import { browserStorage } from './storage.ts';
import { NotePreviewCache } from './note-preview-cache.ts';

export interface NoteFocus { key: string; change: NoteChange; sequence: number; historical: boolean }
type OptionsRequest = (id: string, key: string, body?: { round: number; option?: string; id?: string; accept?: boolean; reject?: boolean }) => Promise<NoteOptions | { building: true }>;
type Preview = { key: string; round: number; detail?: RoundDetail } | null;
type PreviewRequest = (id: string, key: string, round: number, option: string, retry?: boolean, version?: string) => Promise<RoundDetail>;
const previewKey = (id: string, key: string, round: number, option: string, version?: string) => JSON.stringify([id, key, round, option, version]);
const comparisonCache = new NotePreviewCache<RoundDetail>();
const optionCache = new Map<string, NoteOptions>();
const optionStateKey = (task: Task | undefined, notes: NoteResult[], note: NoteResult) => JSON.stringify([
  task?.id, note.key, note.round, task?.updatedAt, task?.review?.counts,
  notes.map(note => [note.key, note.round, note.changes.map(change => [change.stop, change.state])]),
]);
function rememberOptions(key: string, options: NoteOptions) {
  optionCache.delete(key); optionCache.set(key, options);
  if (optionCache.size > 24) optionCache.delete(optionCache.keys().next().value!);
}
function rememberedChoice(key: string, options?: NoteOptions | null) {
  try {
    const saved = JSON.parse(browserStorage.getItem(key) || 'null');
    if (options && !options.locked && saved?.round === options.round && options.options.some(option => option.id === saved.option)) return saved.option as string;
  } catch { /* Ignore a stale local choice. */ }
  return options?.selected || 'current';
}
function optionLockText(reason: string) {
  switch (reason) {
    case 'Options are available on the latest open review.': return t('Options are available on the latest open review.');
    case 'Options are not available for this source range yet.': return t('Options are not available for this source range yet.');
    case 'This note includes a reviewed change. Undo that decision before replacing it.': return t('This note includes a reviewed change. Undo that decision before replacing it.');
    case 'Wait for the current task and review actions to finish.': return t('Wait for the current task and review actions to finish.');
    default: return errorText(reason);
  }
}
async function warmComparison(detail: RoundDetail) {
  const strips = [...detail.sections.flatMap(section => section.blocks), ...detail.loose].flatMap(block => block.kind === 'context' ? [block.image] : block.kind === 'change' ? [...block.before, ...block.after] : []);
  // Decode the first visible strips before swapping, so a ready comparison
  // does not briefly show a blank page while its SVGs arrive.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled([...new Set(strips.map(strip => detail.files + (strip.clean || strip.src)))].slice(0, 16).map(src => {
        const image = new Image(); image.src = src; return image.decode();
      })),
      new Promise(resolve => { timer = setTimeout(resolve, 500); }),
    ]);
  } finally { clearTimeout(timer); }
  return detail;
}
interface Links {
  task?: Task; optionsRequest?: OptionsRequest; previewRequest?: PreviewRequest; preview: Preview; setPreview: (preview: Preview) => void;
  cachedPreview: (id: string, key: string, round: number, option: string, version?: string) => RoundDetail | undefined;
  notes: NoteResult[]; error: boolean; loading: boolean; selected: string; reveal: number;
  focus: NoteFocus | null; scope: 'all' | 'note'; setScope: (scope: 'all' | 'note') => void; reload: () => void;
  clearFocus: () => void;
  alternativeCounts: Record<string, number>;
  focusNote: (key: string) => void;
  showChange: (key: string, change: NoteChange) => void; showNote: (key: string) => void;
}
const Context = createContext<Links | null>(null);
export const useNoteResults = () => useContext(Context);

export function NoteResultsProvider({ task, items, read, optionsRequest, previewRequest, openReview, openChat, children }: {
  task?: Task; items: TimelineItem[]; read: (id: string) => Promise<{ notes: NoteResult[] }>;
  optionsRequest?: OptionsRequest; previewRequest?: PreviewRequest; openReview: () => void; openChat: () => void; children: ReactNode;
}) {
  const [notes, setNotes] = useState<NoteResult[]>([]), [error, setError] = useState(false), [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(''), [focus, setFocus] = useState<NoteFocus | null>(null);
  const [reveal, setReveal] = useState(0), [scope, setScope] = useState<'all' | 'note'>('all');
  const [preview, setPreview] = useState<Preview>(null);
  const [available, setAvailable] = useState<Record<string, { round: number; count: number }>>({});
  const sequence = useRef(0), actions = useRef({ read, openReview, openChat }); actions.current = { read, openReview, openChat };
  const signature = items.filter(item => item.type === 'user' && (item.meta?.notes?.length || readNotesInstructions(item.text))).map(item => item.id).join(',');
  const id = task?.id;
  const reload = useCallback(() => {
    if (!id || !signature) return;
    const request = ++sequence.current; setLoading(true); setError(false);
    void actions.current.read(id).then(result => { if (!Array.isArray(result.notes)) throw new Error('Invalid note results'); if (sequence.current === request) setNotes(result.notes); }).catch(() => { if (sequence.current === request) setError(true); }).finally(() => { if (sequence.current === request) setLoading(false); });
  }, [id, signature]);
  const decisions = JSON.stringify(task?.review?.counts);
  useEffect(() => { reload(); return () => { ++sequence.current; }; }, [reload, task?.review?.round, task?.status, task?.updatedAt, decisions]);
  useEffect(() => { setNotes([]); setAvailable({}); setScope('all'); setPreview(null); setFocus(null); setSelected(''); setError(false); }, [id]);
  const showNote = (key: string) => {
    setSelected(key); setReveal(value => value + 1); actions.current.openChat();
    requestAnimationFrame(() => {
      const element = [...document.querySelectorAll<HTMLElement>('[data-note-result]')].find(element => element.dataset.noteResult === key);
      element?.scrollIntoView({ block: 'center' }); element?.focus({ preventScroll: true });
    });
  };
  const showChange = (key: string, change: NoteChange) => {
    if (id) reviewDraft(id).clearReveal();
    setScope('note');
    setPreview(previous => previous?.key === key && previous.round === change.round ? previous : null); setSelected(key); setFocus(previous => ({ key, change, sequence: (previous?.sequence || 0) + 1, historical: change.round !== task?.review?.round })); actions.current.openReview();
  };
  const focusNote = (key: string) => {
    const note = notes.find(note => note.key === key);
    if (note?.changes[0]) showChange(key, note.changes[0]);
    else if (note) { setSelected(key); setFocus(null); actions.current.openReview(); }
  };
  useEffect(() => {
    if (!focus) return;
    const note = notes.find(note => note.key === focus.key);
    if (note?.changes[0] && note.changes[0].round !== focus.change.round) setFocus({ ...focus, change: note.changes[0], sequence: focus.sequence + 1, historical: note.changes[0].round !== task?.review?.round });
  }, [notes]);
  const requests = useRef({ optionsRequest, previewRequest }); requests.current = { optionsRequest, previewRequest };
  const noteSignature = JSON.stringify(notes.map(note => [note.key, note.round, note.changes.map(change => change.state)]));
  useEffect(() => {
    if (!id || task?.status !== 'reviewing') return;
    const { optionsRequest, previewRequest } = requests.current;
    if (!optionsRequest || !previewRequest) return;
    let cancelled = false;
    // Published choices are already rendered. Load their small manifests and
    // warm the images before a note is opened, including after an app restart.
    void (async () => {
      for (const note of notes) {
        if (cancelled) return;
        if (note.round !== task.review?.round || !note.changes.length) continue;
        try {
          const options = await optionsRequest(id, note.key);
          if (cancelled || !('options' in options)) continue;
          const count = options.locked ? 0 : Math.max(0, options.options.length - 1);
          setAvailable(previous => previous[note.key]?.round === options.round && previous[note.key]?.count === count ? previous : { ...previous, [note.key]: { round: options.round, count } });
          if (options.locked) continue;
          rememberOptions(optionStateKey(task, notes, note), options);
          await Promise.allSettled(options.options.filter(option => !option.previewError).map(option =>
            comparisonCache.read(previewKey(id, note.key, options.round, option.id, options.comparisonKey), () => previewRequest(id, note.key, options.round, option.id, false, options.comparisonKey).then(warmComparison))));
        } catch { /* Opening the note reports errors and offers Retry. */ }
      }
    })();
    return () => { cancelled = true; };
  }, [id, task?.status, task?.review?.round, task?.updatedAt, decisions, noteSignature]);
  const value: Links = { task, optionsRequest, previewRequest: previewRequest && ((id, key, round, option, retry, version) => comparisonCache.read(previewKey(id, key, round, option, version), () => previewRequest(id, key, round, option, retry, version).then(warmComparison))), cachedPreview: (id, key, round, option, version) => comparisonCache.peek(previewKey(id, key, round, option, version)), preview: preview?.key === focus?.key && preview?.round === task?.review?.round ? preview : null, setPreview, notes, loading, error, selected, reveal, focus, scope, setScope, reload, showNote, focusNote,
    alternativeCounts: Object.fromEntries(notes.map(note => [note.key, task?.status === 'reviewing' && note.round === task.review?.round && note.changes.every(change => change.state === 'pending') && available[note.key]?.round === note.round ? available[note.key].count : 0])),
    clearFocus: () => { setScope('all'); setPreview(null); setFocus(null); setSelected(''); }, showChange };

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

// The display scope is a global viewer control. It does not discard the
// candidate being compared or close the note's choices.
export function NoteReviewScope() {
  const links = useNoteResults();
  const note = links?.notes.find(note => note.key === links.focus?.key);
  if (!links || !note) return null;
  return <div className="note-review-scope" role="group" aria-label={t('Review scope')}>
    <button type="button" aria-pressed={links.scope === 'all'} aria-label={t('Show all changes')} onClick={() => links.setScope('all')}>{t('All changes')}</button>
    <button type="button" aria-pressed={links.scope === 'note'} title={t('View changes for this note')} onClick={() => links.setScope('note')} aria-label={t('Note {n}', { n: note.index + 1 })}><Icon name="notes" size={12}/>{note.index + 1}</button>
  </div>;
}

// Review controls belong to the PDF workspace. Sent annotations in the
// conversation remain the author's original record, with no added controls.
export function NoteReviewControls({ doc }: { doc: Document | null }) {
  const links = useNoteResults();
  const note = links?.notes.find(note => note.key === (links.focus?.key || links.selected));
  const panel = useRef<HTMLElement>(null), latest = useRef(links); latest.current = links;
  const [retained, setRetained] = useState(note);
  // Keep the contents mounted just long enough for the drawer to slide away.
  useEffect(() => {
    if (note) { setRetained(note); return; }
    const timer = setTimeout(() => setRetained(undefined), 280);
    return () => clearTimeout(timer);
  }, [note]);
  useEffect(() => {
    if (!note) return;
    const outside = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!event.isTrusted || !target || panel.current?.contains(target) || target.closest('[data-note-result], .papilot-note-links, .papilot-note-options, .note-review-scope')) return;
      latest.current?.clearFocus();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) latest.current?.clearFocus(); };
    window.document.addEventListener('click', outside); doc?.addEventListener('click', outside);
    window.document.addEventListener('keydown', escape); doc?.addEventListener('keydown', escape);
    return () => {
      window.document.removeEventListener('click', outside); doc?.removeEventListener('click', outside);
      window.document.removeEventListener('keydown', escape); doc?.removeEventListener('keydown', escape);
    };
  }, [doc, Boolean(note)]);
  const displayed = note || retained;
  useLayoutEffect(() => {
    const element = panel.current, root = doc?.documentElement, paper = doc?.getElementById('paper');
    if (!element || !root || !paper || !displayed) return;
    let pending = 0;
    const reveal = () => {
      if (!note) return;
      const frame = doc.defaultView?.frameElement?.getBoundingClientRect();
      const viewport = element.parentElement!.getBoundingClientRect();
      const bottom = viewport.bottom - element.offsetHeight - 12 - (frame?.top || 0);
      const marks = [...paper.querySelectorAll<SVGRectElement>('.papilot-linked-change .pdf-focus-marks rect')].map(mark => mark.getBoundingClientRect());
      if (!marks.length) return;
      const top = Math.min(...marks.map(mark => mark.top)), end = Math.max(...marks.map(mark => mark.bottom));
      const visibleTop = paper.getBoundingClientRect().top + 48;
      // Preserve the PDF's width and line breaks. Only scroll if its focused
      // marks would be hidden, including edits on the very last page.
      if (end > bottom) paper.scrollBy({ top: end - top <= bottom - visibleTop ? end - bottom : top - visibleTop, behavior: 'instant' });
    };
    const sync = () => {
      root.setAttribute('data-papilot-note-drawer', '');
      root.style.setProperty('--papilot-note-inset', `${element.offsetHeight + 12}px`);
      cancelAnimationFrame(pending); pending = requestAnimationFrame(reveal);
    };
    const resize = new ResizeObserver(sync); resize.observe(element); sync();
    return () => { resize.disconnect(); cancelAnimationFrame(pending); root.removeAttribute('data-papilot-note-drawer'); root.style.removeProperty('--papilot-note-inset'); };
  }, [doc, Boolean(displayed), Boolean(note), links?.focus?.sequence]);
  if (!links) return null;
  // A first failed lookup has no note to select yet. Keep retry reachable in
  // the PDF pane without adding controls to the original conversation.
  if (!displayed) return links.error ? <section className="review-note-controls" data-open="true" aria-label={t('Options for this note')}>
    <button type="button" className="note-result-retry" onClick={links.reload}><Icon name="refresh" size={12}/>{t('Retry linking changes')}</button>
  </section> : null;
  const siblings = links.notes.filter(other => other.itemId === displayed.itemId);
  const index = siblings.findIndex(other => other.key === displayed.key);
  const move = (offset: number) => {
    const next = siblings[index + offset];
    if (!next) return;
    links.focusNote(next.key);
    requestAnimationFrame(() => {
      const direction = offset < 0 ? 'previous' : 'next';
      const button = panel.current?.querySelector<HTMLButtonElement>(`.review-note-pager [data-direction="${direction}"]:not(:disabled)`) || panel.current?.querySelector<HTMLButtonElement>('.review-note-pager button:not(:disabled)');
      button?.focus({ preventScroll: true });
    });
  };
  const navigation = <nav className="review-note-pager" aria-label={t('Notes')} onKeyDown={event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault(); move(event.key === 'ArrowLeft' ? -1 : 1);
  }}>
    <button type="button" className="icon-button" data-direction="previous" aria-label={t('Previous note')} title={t('Previous note')} disabled={index <= 0} onClick={() => move(-1)}><Icon name="chevronLeft" size={14}/></button>
    <span className="review-note-position" aria-live="polite" aria-atomic="true" aria-label={t('Note {n} of {total}', { n: index + 1, total: siblings.length })}>{index + 1}<span aria-hidden="true"> / </span>{siblings.length}</span>
    <button type="button" className="icon-button" data-direction="next" aria-label={t('Next note')} title={t('Next note')} disabled={index >= siblings.length - 1} onClick={() => move(1)}><Icon name="chevronRight" size={14}/></button>
  </nav>;
  const emptyHeader = <div className="note-option-navigation">{navigation}</div>;
  return <section ref={panel} className="review-note-controls" data-open={Boolean(note)} inert={!note} aria-label={t('Options for this note')}>
    {links.error ? <>{emptyHeader}<button type="button" className="note-result-retry" onClick={links.reload}><Icon name="refresh" size={12}/>{t('Retry linking changes')}</button></> : displayed.changes.length > 0 ? <NoteAlternatives key={displayed.key} note={displayed} navigation={navigation}/> : <>{emptyHeader}<p className="note-option-hint">{displayed.state === 'waiting' ? t('Awaiting changes') : t('No linked change')}</p></>}
  </section>;
}

function NoteAlternatives({ note, navigation }: { note: NoteResult; navigation: ReactNode }) {
  const links = useNoteResults()!, request = links.optionsRequest, task = links.task;
  const tabsId = useId();
  const tabs = useRef<HTMLDivElement>(null);
  const storageKey = `papilot:note-choice:${task?.id}:${note.key}`;
  const optionsKey = optionStateKey(task, links.notes, note);
  const remembered = optionCache.get(optionsKey);
  const draft = reviewDraft(task?.id || ''), feedback = useReviewDraft(task?.id || '');
  const [editor, setEditor] = useState<string | null>(null), commentInput = useRef<HTMLTextAreaElement>(null);
  const [actingOption, setActingOption] = useState(''), [actingKind, setActingKind] = useState<'accept' | 'reject'>('accept');
  const [source, setSource] = useState(false);
  const [data, setData] = useState<NoteOptions | null>(remembered || null), [selected, setSelected] = useState(() => rememberedChoice(storageKey, remembered));
  const [busy, setBusy] = useState(false), [applying, setApplying] = useState(false), [error, setError] = useState('');
  const [baseline, setBaseline] = useState<RoundDetail | null>(() => task && remembered ? links.cachedPreview(task.id, note.key, remembered.round, remembered.selected || 'current', remembered.comparisonKey) || null : null), [baselineError, setBaselineError] = useState('');
  const [retry, setRetry] = useState(0), [previewBusy, setPreviewBusy] = useState(false);
  const [shown, setShown] = useState<RoundDetail | null>(() => task && remembered ? links.cachedPreview(task.id, note.key, remembered.round, selected, remembered.comparisonKey) || baseline : null);
  const previewSequence = useRef(0), requestId = useRef<{ option: string; action: 'accept' | 'reject'; id: string } | null>(null);
  useEffect(() => {
    if (applying && task && ['failed', 'uncertain', 'interrupted'].includes(task.status)) {
      setApplying(false); setError(task.error || t('The choice could not be saved.'));
    }
  }, [applying, task?.status, task?.error]);
  useEffect(() => {
    if (!request || !task) return;
    let cancelled = false; setBusy(true); setError('');
    // Opening a note reads the choices prepared in the original editing turn.
    void request(task.id, note.key).then(result => {
      if (cancelled || !('options' in result)) return;
      rememberOptions(optionsKey, result);
      setData(result); setSelected(rememberedChoice(storageKey, result)); setApplying(false);
    }).catch(error => { if (!cancelled) setError(error.message); }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; ++previewSequence.current; links.setPreview(null); };
  }, [optionsKey, retry]);
  const saved = data?.selected || 'current';
  useEffect(() => { if (editor) commentInput.current?.focus(); }, [editor]);
  useEffect(() => {
    if (!task || !data || !links.previewRequest) return;
    let cancelled = false; setBaseline(links.cachedPreview(task.id, note.key, data.round, saved, data.comparisonKey) || null); setBaselineError('');
    void links.previewRequest(task.id, note.key, data.round, saved, false, data.comparisonKey).then(detail => {
      if (!cancelled) setBaseline(detail);
    }).catch(error => { if (!cancelled) setBaselineError(error.message); });
    return () => { cancelled = true; };
  }, [task?.id, note.key, data?.round, data?.comparisonKey, saved, retry]);
  useEffect(() => {
    const sequence = ++previewSequence.current;
    setPreviewBusy(false);
    if (!task || !data || !links.previewRequest || links.focus?.key !== note.key || selected === saved || data.locked) { links.setPreview(null); return; }
    const cached = links.cachedPreview(task.id, note.key, data.round, selected, data.comparisonKey);
    if (cached) { links.setPreview({ key: note.key, round: data.round, detail: cached }); return; }
    links.setPreview({ key: note.key, round: data.round }); setPreviewBusy(true);
    void links.previewRequest(task.id, note.key, data.round, selected, retry > 0, data.comparisonKey).then(detail => {
      if (previewSequence.current !== sequence) return;
      links.setPreview({ key: note.key, round: data.round, detail });
    }).catch(error => { if (previewSequence.current === sequence) setError(error.message); })
      .finally(() => { if (previewSequence.current === sequence) setPreviewBusy(false); });
    return () => { ++previewSequence.current; };
  }, [optionsKey, task?.id, note.key, data?.round, data?.comparisonKey, data?.locked, selected, saved, retry, links.focus?.key]);
  const optionIds = data?.options.map(option => option.id).join(',');
  useLayoutEffect(() => {
    const list = tabs.current;
    if (!list) return;
    const reveal = () => {
      const chosen = list.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!chosen) return;
      const item = chosen.getBoundingClientRect(), viewport = list.getBoundingClientRect();
      if (item.width > viewport.width || item.left < viewport.left) list.scrollLeft += item.left - viewport.left;
      else if (item.right > viewport.right) list.scrollLeft += item.right - viewport.right;
    };
    reveal();
    const resize = new ResizeObserver(reveal); resize.observe(list);
    return () => resize.disconnect();
  }, [selected, optionIds]);
  useEffect(() => {
    if (!task || !data || data.locked || !links.previewRequest) return;
    // Read the prepared comparisons; tab switches share the same decoded cache.
    for (const option of data.options.filter(option => !option.previewError)) void links.previewRequest(task.id, note.key, data.round, option.id, false, data.comparisonKey).catch(() => {});
  }, [task?.id, note.key, data?.round, data?.comparisonKey, data?.locked, optionIds]);
  const readyComparison = selected === saved ? baseline : links.preview?.detail;
  useEffect(() => { if (readyComparison) setShown(readyComparison); }, [readyComparison]);
  if (!request || !task) return null;
  const comparison = readyComparison || shown;
  const focusedUnits = [...new Set(note.changes.filter(change => change.round === comparison?.round).flatMap(change => change.units))];
  const locked = data?.locked || (note.changes.some(change => change.state !== 'pending') ? 'This note includes a reviewed change. Undo that decision before replacing it.' : task.status !== 'reviewing' || task.pendingReview ? 'Wait for the current task and review actions to finish.' : '');
  const choose = (option: string) => {
    if (!data || applying) return;
    links.setScope('note'); setSelected(option); setEditor(null); requestId.current = null; setError('');
    browserStorage.setItem(storageKey, JSON.stringify({ round: data.round, option }));
  };
  const decide = async (option: NoteOption, action: 'accept' | 'reject') => {
    if (!data || applying || locked || !links.previewRequest) return;
    if (selected !== option.id) choose(option.id);
    setApplying(true); setActingOption(option.id); setActingKind(action); setError('');
    try {
      // HTTP tailnet addresses provide random bytes without randomUUID.
      if (requestId.current?.option !== option.id || requestId.current.action !== action)
        requestId.current = { option: option.id, action, id: crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(20)), byte => byte.toString(16).padStart(2, '0')).join('') };
      // Rejection restores the original edit and never waits for an option PDF.
      if (action === 'accept') await links.previewRequest(task.id, note.key, data.round, option.id, false, data.comparisonKey);
      const result = await request(task.id, note.key, { round: data.round, option: option.id, id: requestId.current.id, ...(action === 'accept' ? { accept: true } : { reject: true }) });
      const rejected = optionFeedback(option.id, 'reject'); if (rejected) draft.remove(rejected.id);
      browserStorage.removeItem(storageKey);
      if ('options' in result) { setData(result); setSelected(result.selected || 'current'); setApplying(false); links.clearFocus(); }
      links.reload();
    }
    catch (error) { setError((error as Error).message); setApplying(false); }
  };
  const saving = applying || task.status === 'building';
  const label = (id: string, text: string) => id === 'latest' ? t('Current proposal')
    : id === 'current' && (text === 'Current proposal' || text === 'Initial proposal') ? t('Initial proposal') : text;
  const optionFeedback = (id: string, kind: 'comment' | 'reject') => feedback.notes.find(item => item.round === data?.round && item.option?.note === note.key && item.option.id === id && item.option.kind === kind);
  const addFeedback = (option: NoteOption) => draft.add({
    round: data!.round, strip: '', rects: [], region: false,
    where: `Round ${data!.round} · ${note.note.where} · Note ${note.index + 1} · Option: ${label(option.id, option.label)}`,
    quote: option.edits.map(edit => edit.text).join('\n'),
    option: { note: note.key, id: option.id, label: label(option.id, option.label), kind: 'comment' },
  }, false);
  const comment = (option: NoteOption) => {
    if (!locked) choose(option.id);
    setEditor(optionFeedback(option.id, 'comment')?.id || addFeedback(option) || null);
  };
  const editing = feedback.notes.find(item => item.id === editor);
  const active = data?.options.find(option => option.id === selected);
  const name = active ? label(active.id, active.label) : '';
  const commented = Boolean(active && optionFeedback(active.id, 'comment'));
  const multiple = (data?.options.length || 0) > 1;
  return <div className="note-options" onClick={event => event.stopPropagation()}>
    <div className="note-option-navigation">
    {data && (multiple ? <div ref={tabs} className="note-option-tabs" role="tablist" aria-label={t('Options for this note')} aria-busy={saving || previewBusy}>
      {data.options.map((option, index) => {
        const name = label(option.id, option.label);
        return <button type="button" className="note-option-tab" role="tab" key={option.id} id={`${tabsId}-${option.id}`} aria-controls={`${tabsId}-panel`} data-option={option.id} aria-selected={selected === option.id} tabIndex={selected === option.id ? 0 : -1} disabled={saving || Boolean(locked) || busy} aria-label={name} onClick={() => choose(option.id)} onKeyDown={event => {
          const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
          if (!offset && event.key !== 'Home' && event.key !== 'End') return;
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? data.options.length - 1 : (index + offset + data.options.length) % data.options.length;
          choose(data.options[next].id); (event.currentTarget.parentElement!.children[next] as HTMLButtonElement).focus();
        }}><span className="note-option-label">{name}{selected === option.id && previewBusy && <span className="spinner"/>}</span></button>;
      })}
    </div> : <span className="note-option-title" id={active ? `${tabsId}-${active.id}` : undefined} title={name}>{name}</span>)}
    {navigation}
    {active && <div className="note-option-actions" role="group" aria-label={t('Review {label}', { label: name })}>
      <button type="button" className="icon-button accept" aria-label={t('Accept {label}', { label: name })} title={t('Accept')} disabled={saving || Boolean(locked) || busy} onClick={() => void decide(active, 'accept')}>{saving && actingOption === active.id && actingKind === 'accept' ? <span className="spinner"/> : <Icon name="check" size={18}/>}</button>
      <button type="button" className="icon-button reject" aria-label={t('Reject {label}', { label: name })} title={t('Reject')} disabled={saving || Boolean(locked) || busy || feedback.busy} onClick={() => void decide(active, 'reject')}>{saving && actingOption === active.id && actingKind === 'reject' ? <span className="spinner"/> : <Icon name="close" size={18}/>}</button>
      <button type="button" className="icon-button comment" aria-label={t('Comment on {label}', { label: name })} aria-expanded={editing?.option?.id === active.id} data-commented={commented} title={t('Comment')} disabled={saving || feedback.busy} onClick={() => comment(active)}><Icon name="chat" size={18}/></button>
      <button type="button" className="icon-button source" aria-label={t('Show LaTeX source')} aria-pressed={source} title={t('Show LaTeX source')} disabled={!comparison} onClick={() => setSource(value => !value)}><Icon name="code" size={18}/></button>
    </div>}
    </div>
    <div className="note-option-content" role={multiple ? 'tabpanel' : undefined} id={`${tabsId}-panel`} aria-labelledby={active ? `${tabsId}-${active.id}` : undefined}>
    {active?.reason && <p className="note-option-reason">{active.reason}</p>}
    {editing && <div className="note-option-comment">
      <textarea ref={commentInput} rows={2} aria-label={t('Comment on {label}', { label: editing.option!.label })} placeholder={t('What should change here?')} value={editing.comment} readOnly={feedback.busy} onChange={event => draft.edit(editing.id, event.target.value)} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') setEditor(null); }}/>
      <button type="button" className="icon-button" aria-label={t('Close comment')} title={t('Close comment')} onClick={() => setEditor(null)}><Icon name="close" size={14}/></button>
    </div>}
    {comparison && (source ? <NoteOptionSource detail={comparison} focus={focusedUnits}/> : <NoteOptionDiff detail={comparison} focus={focusedUnits}/>)}
    {!comparison && !baselineError && !error && <p className="note-option-hint" role="status"><span className="spinner"/>{t('Loading PDF comparison…')}</p>}
    {baselineError && !comparison && <p className="note-option-error" role="alert">{baselineError} <button type="button" onClick={() => setRetry(value => value + 1)}>{t('Retry')}</button></p>}
    {(saving || previewBusy) && <span className="sr-only" role="status">{saving ? t('Saving choice…') : t('Preparing this option’s PDF diff…')}</span>}
    {locked && !saving && <p className="note-option-hint">{optionLockText(locked)}</p>}
    {error && <p role="alert" className="note-option-error">{errorText(error)} <button type="button" onClick={() => setRetry(value => value + 1)}>{t('Retry')}</button></p>}
    </div>
  </div>;
}
