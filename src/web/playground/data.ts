import type { Annotation, GitStatus, Manuscript, Snapshot, Task, TimelineItem, AgentId, Skill, NoteSummary, NoteResult, NoteOptions } from '../../shared.ts';
import type { ActionKind, Decision, PageState, RoundDetail } from '../../../engine/src/types.ts';
import plans from '../../../examples/playground-paper/edits.json';
import seededNotes from '../../../examples/playground-paper/preview/notes.json';
import preparedRounds from '../../../examples/playground-paper/preview/rounds.json';
import { demoRuntimes } from './models.ts';
import { seedGit, gitStatus, gitRequest, type DemoGit } from './git.ts';
import { replayDuration, replayProgress, replayItem, type DemoReplay } from './replay.ts';

const createdAt = Date.UTC(2026, 10, 1, 9);
export const projectId = 'playground-paper';
const rounds = preparedRounds as unknown as Record<string, RoundDetail>;
const validRect = (value: unknown): value is Annotation['rect'] => Array.isArray(value) && value.length === 4 && value.every(number => Number.isFinite(number) && number >= 0 && number <= 1) && value[0] <= value[2] && value[1] <= value[3];
const uuid = () => crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(20)), byte => byte.toString(16).padStart(2, '0')).join('');
interface Store { getItem(key: string): string | null; setItem(key: string, value: string): void }
interface ReviewState {
  decisions: Record<string, Decision>; comments: Record<string, string>;
  history: { id: string; kind: ActionKind; changes: string[]; decisions: Record<string, Decision>; comments: Record<string, string> }[];
}
type TaskSettings = Partial<Pick<Task, 'model' | 'effort' | 'serviceTier' | 'permissions'>>;
interface LocalState { annotations: Annotation[]; reviews: Record<string, ReviewState>; copied: Record<string, string>; hiddenSuggestions: string[]; taskSettings: Record<string, TaskSettings>; openedPresets: Record<string, number>; replays: Record<string, DemoReplay>; repository: DemoGit }
export class PlaygroundDownloadRequired extends Error {
  constructor() { super('Download Papilot to run tasks and use your own papers. Your draft is kept in this browser.'); this.name = 'PlaygroundDownloadRequired'; }
}

// Decisions and annotations are local. Only the pre-rendered results are fixed:
// there is no agent, compiler, network fallback, or mutation of the source paper.
export function createPlaygroundData(storage: Store, version: string, pdfKey: string, pages: [number, number][], now: () => number = Date.now) {
  const storageKey = `papilot:playground:example:v2:${pdfKey}:${Object.values(rounds).map(round => round.after).join(':')}`;
  const seed = (): LocalState => ({
    annotations: seededNotes.map((note, index) => ({ ...note, projectId, key: pdfKey, source: null, createdAt: createdAt + index })) as Annotation[],
    reviews: Object.fromEntries(Object.entries(rounds).map(([id, detail]) => [id, { decisions: Object.fromEntries(detail.units.map(unit => [unit.id, 'pending'])), comments: {}, history: [] }])),
    copied: {}, hiddenSuggestions: [], taskSettings: {}, openedPresets: {}, replays: {}, repository: seedGit(),
  });
  let local = seed();
  const validNote = (note: Annotation) => note && typeof note.id === 'string' && note.projectId === projectId && note.key === pdfKey && Number.isInteger(note.page) && note.page >= 0 && note.page < pages.length && validRect(note.rect) && typeof note.comment === 'string' && typeof note.quote === 'string' && typeof note.createdAt === 'number';
  function restore() {
    try {
      const saved = JSON.parse(storage.getItem(storageKey) || 'null') as LocalState | null;
      if (!saved || !Array.isArray(saved.annotations) || !saved.reviews || !saved.copied || !Array.isArray(saved.hiddenSuggestions)) return;
      for (const [id, round] of Object.entries(rounds)) {
        const review = saved.reviews[id];
        if (!review || !Array.isArray(review.history) || !review.comments || !review.decisions || round.units.some(unit => !['pending', 'accepted', 'rejected', 'commented'].includes(review.decisions[unit.id]))) return;
      }
      saved.annotations = saved.annotations.filter(validNote);
      saved.taskSettings ||= {};
      saved.openedPresets ||= {};
      saved.replays ||= {};
      saved.repository ||= seedGit();
      local = saved;
    } catch { /* Keep this tab usable if durable storage is unavailable. */ }
  }
  const persist = () => { try { storage.setItem(storageKey, JSON.stringify(local)); } catch { /* Tab-local fallback. */ } };
  const counts = (id: string) => Object.values(local.reviews[id].decisions).reduce((result, decision) => { result[decision]++; return result; }, { pending: 0, accepted: 0, rejected: 0, commented: 0 });
  const phase = (id: string) => counts(id).pending ? 'reviewing' : counts(id).commented ? 'revise' : 'done';
  const progress = (id: string) => local.replays[id] ? replayProgress(local.replays[id], now()) : null;
  function pageState(id: string): PageState {
    const review = local.reviews[id], count = counts(id), last = review.history.at(-1);
    return { csrf: '', task: id, title: plans.find(plan => plan.id === id)!.title, closed: false, sourceEditing: false,
      state: phase(id), latest: 1, round: 1, revision: rounds[id].after, history: [{ number: 1, created: createdAt / 1000 }],
      decisions: review.decisions, comments: review.comments, undo: last ? { id: last.id, kind: last.kind, changes: last.changes } : null, job: null,
      workspace: { deferred: true, status: 'reviewing', unsent: count.accepted + count.rejected + count.commented, comments: count.commented, accepted: count.accepted },
    };
  }
  function task(plan: { id: string; title: string; prompt: string; agent: string }, index: number): Task {
    const replay = progress(plan.id), pending = replay && !replay.done;
    const status = pending ? replay.paused ? 'interrupted' : replay.step < 2 ? 'running' : 'building' : 'reviewing';
    const count = rounds[plan.id] ? counts(plan.id) : { pending: 0, accepted: 0, rejected: 0, commented: 0 };
    const agent = plan.agent as AgentId, model = demoRuntimes[agent].models.find(model => model.isDefault);
    const settings = { model: model?.id || null, effort: model?.defaultEffort || null, serviceTier: 'default', permissions: 'workspace', ...local.taskSettings[plan.id] };
    return { id: plan.id, projectId, name: plan.id, title: plan.title, instructions: plan.prompt,
      mode: rounds[plan.id] ? 'edit' : 'review', deferred: Boolean(rounds[plan.id]),
      ...(!rounds[plan.id] ? { aiReview: { key: pdfKey, notes: 3 } } : {}),
      worktree: '/example/papilot-introduction', threadId: null, turnId: null, agent,
      ...settings,
      status, createdAt: local.openedPresets[plan.id] || createdAt + index * 60000, updatedAt: local.replays[plan.id] ? local.replays[plan.id].pausedAt ?? local.replays[plan.id].startedAt + replay!.step * 2500 : local.openedPresets[plan.id] || createdAt + index * 60000, feedbackCursor: 0, error: null,
      review: pending ? { state: status, round: null, counts: { pending: 0, accepted: 0, rejected: 0, commented: 0 }, files: [], job: status === 'building' ? { id: plan.id + '-replay', phase: 'render', status: 'running', createdAt: local.replays[plan.id].startedAt + 5000 } : null }
        : { state: rounds[plan.id] ? phase(plan.id) : 'done', round: rounds[plan.id] ? 1 : null, counts: count, unsent: count.accepted + count.rejected + count.commented, comments: count.commented, files: count.accepted ? ['main.tex'] : [] },
    };
  }
  const reviewPlan = { id: 'example-review', title: 'Review the philosophy and the math', agent: 'codex', prompt: 'Review this illustrated Papilot tour. Check that its philosophy gives authors concrete choices, and that the annotation geometry states its assumptions. Keep the review tied to exact words, symbols and table cells.', answer: 'The tour connects the product images to three principles: **read the rendered page, keep editorial control, and own your files and tools**. I left three precise suggestions: name the author’s choices, generalize the coordinate formula beyond a zero origin, and demonstrate the same normalized box on an offset page. Open **AI suggestions** and use **Keep on manuscript** to keep a suggestion.' };
  const suggestions = () => ['note-claim', 'note-equation', 'note-table'].map(id => {
    const note = seededNotes.find(note => note.id === id)!;
    const suggestionId = `suggestion-${id}`;
    return { ...note, id: suggestionId, projectId, key: pdfKey, source: null, createdAt, aiReview: { taskId: reviewPlan.id, agent: 'codex', ...(local.copied[suggestionId] ? { copiedTo: local.copied[suggestionId] } : {}) } } as Annotation;
  });
  const planNotes = (plan: { notes?: string[] }): NoteSummary[] => (plan.notes || []).map(id => {
    const note = seededNotes.find(note => note.id === id)!;
    return { id, where: `Page ${note.page + 1}`, quote: note.quote, comment: note.comment, ...('group' in note ? { group: note.group } : {}), ...('kind' in note ? { kind: note.kind } : {}), ...('stamp' in note ? { stamp: note.stamp } : {}) } as NoteSummary;
  });
  function noteResults(example: { id: string; notes?: string[] }): NoteResult[] {
    const detail = rounds[example.id], itemId = `${example.id}-prompt`, notes = planNotes(example);
    if (progress(example.id) && !progress(example.id)!.done) return notes.map((note, index) => ({ key: `${itemId}:${index}`, itemId, index, note, round: null, state: 'waiting', changes: [] }));
    return notes.map((note, index): NoteResult => {
      const changes: NoteResult['changes'] = [...detail.sections.flatMap(section => section.blocks.filter(block => block.kind === 'change')), ...detail.loose].flatMap((block, stop) => {
        if (block.kind !== 'change') return [];
        const units = detail.units.filter(unit => block.units.includes(unit.id) && unit.old_text.normalize('NFKC').includes(note.quote.normalize('NFKC'))).map(unit => unit.id);
        if (!units.length) return [];
        const states = new Set(units.map(id => local.reviews[example.id].decisions[id]));
        return [{ round: 1, stop, units, state: states.size === 1 ? [...states][0] : 'mixed', match: 'quote' }];
      });
      return { key: `${itemId}:${index}`, itemId, index, note, round: 1, state: changes.length ? 'matched' : 'unmatched', changes };
    });
  }
  function noteOptions(id: string, key: string): NoteOptions {
    const example = plans.find(plan => plan.id === id), note = example && noteResults(example).find(note => note.key === key);
    if (!note?.round || !note.changes.length) throw new Error('This note has no linked changes.');
    const ids = new Set(note.changes.flatMap(change => change.units)), units = rounds[id].units.filter(unit => ids.has(unit.id));
    return { key, round: 1, selected: 'current', before: Object.fromEntries(units.map(unit => [unit.id, unit.old_text])),
      options: [{ id: 'current', label: 'Current proposal', edits: units.map(unit => ({ unit: unit.id, text: unit.new_text })) }],
      ...(units.some(unit => local.reviews[id].decisions[unit.id] !== 'pending') ? { locked: 'This note includes a reviewed change. Undo that decision before replacing it.' } : {}),
    };
  }
  function read(route: string, body?: unknown): unknown {
    restore();
    const path = route.split('?')[0], base = `/projects/${projectId}`;
    const git = gitStatus(local.repository);
    if (path === `${base}/git` || path.startsWith(`${base}/git/`)) {
      const result = gitRequest(local.repository, route.slice(`${base}/git`.length), body);
      if (result !== undefined) { if (body !== undefined) persist(); return result; }
    }
    if (path === '/playground/tasks' && body !== undefined) {
      const input = body as { preset?: string; annotations?: string[] };
      const ids = input.annotations;
      const plan = plans.find(plan => plan.preset && (input.preset ? plan.id === input.preset : Array.isArray(ids) && ids.length > 0 && ids.every(id => plan.notes.includes(id))));
      if (!plan) throw new PlaygroundDownloadRequired();
      // Only an unchanged seeded note can resolve implicitly to a fixed edit.
      // Explicit preset buttons always open their clearly labelled sample.
      if (!input.preset && ids?.some(id => {
        const note = local.annotations.find(note => note.id === id && !note.deletedAt), seed = seededNotes.find(note => note.id === id);
        return !note || !seed || note.comment !== seed.comment || note.quote !== seed.quote;
      })) throw new PlaygroundDownloadRequired();
      local.openedPresets[plan.id] ||= now();
      const replay = progress(plan.id);
      if (!replay || replay.done) local.replays[plan.id] = { startedAt: now() };
      else if (replay.paused) { const run = local.replays[plan.id]; run.startedAt += now() - run.pausedAt!; delete run.pausedAt; }
      persist();
      return task(plan, plans.indexOf(plan) + 1);
    }
    const replayAction = path.match(/^\/tasks\/([^/]+)\/(interrupt|publish)$/);
    if (replayAction && body !== undefined && local.replays[replayAction[1]]) {
      const [, id, action] = replayAction, run = local.replays[id];
      if (!progress(id)!.done) {
        if (action === 'interrupt') run.pausedAt ??= now();
        else if (run.pausedAt !== undefined) { run.startedAt += now() - run.pausedAt; delete run.pausedAt; }
        persist(); return task(plans.find(plan => plan.id === id)!, 0);
      }
    }
    if (path === '/playground/reset' && body !== undefined) {
      local = seed(); persist();
      for (const key of ['papilot:new-task', 'papilot:new-task-request', 'papilot:task', ...[...plans, reviewPlan].flatMap(plan => [`papilot:review-notes:${plan.id}`, `papilot:draft:${plan.id}`])]) {
        try { storage.setItem(key, ''); } catch { /* A reload also resets tab-local drafts. */ }
      }
      return { ok: true };
    }
    if (path === '/quick-notes') { if (body !== undefined) storage.setItem('playground:quick-notes', JSON.stringify(body)); try { return JSON.parse(storage.getItem('playground:quick-notes') || '{"quickNotes":null}'); } catch { return { quickNotes: null }; } }
    if (path === '/indirect-changes') return { indirectChanges: false };
    // The note drawer uses the same prepared comparison and local decision
    // journal as the iframe. Only an explicit request for new AI alternatives
    // needs the installed app; opening a note never triggers a download prompt.
    const optionRoute = path.match(/^\/tasks\/([^/]+)\/note-options(\/preview)?$/);
    if (optionRoute && rounds[optionRoute[1]]) {
      const [, id, preview] = optionRoute, query = new URLSearchParams(route.split('?')[1]);
      const input = body as { key?: string; round?: number; option?: string; id?: string; accept?: boolean } | undefined;
      const key = input?.key ?? query.get('key') ?? '', options = noteOptions(id, key);
      if (body === undefined && !preview) return options;
      if ((preview ? Number(query.get('round')) : input?.round) !== options.round) throw new Error('The review changed. Reload the options.');
      if (preview) {
        if (body !== undefined || query.get('option') !== 'current') throw new Error('This option is no longer available.');
        return rounds[id];
      }
      if (!input?.option) throw new PlaygroundDownloadRequired();
      if (input.option !== 'current') throw new Error('This option is no longer available.');
      if (!input.accept) return options;
      if (options.locked) throw new Error(options.locked);
      read(`/playground-reviews/${id}/decide`, { id: input.id, round: 1, action: 'accept', changes: options.options[0].edits.map(edit => edit.unit) });
      return noteOptions(id, key);
    }
    const match = path.match(/^\/playground-reviews\/([^/]+)(\/.*)$/);
    if (match && rounds[match[1]]) {
      const [, id, action] = match, review = local.reviews[id];
      if (progress(id) && !progress(id)!.done) throw new Error('The demo is still preparing this comparison.');
      if (body === undefined && action === '/state') return pageState(id);
      if (body === undefined && action === '/rounds/1') return rounds[id];
      if (body === undefined && action === '/rounds/1/references') return { checks: {}, confirmed: {}, pending: 0 };
      if (action === '/decide' && body !== undefined) {
        const input = body as { id: string; round: number; action: ActionKind; changes: string[]; body?: string };
        if (input.round !== 1 || typeof input.id !== 'string' || !['accept', 'reject', 'comment'].includes(input.action) || !Array.isArray(input.changes) || !input.changes.length || input.changes.some(id => !Object.hasOwn(review.decisions, id)) || (input.action === 'comment' && !input.body?.trim())) throw new Error('Invalid example review decision.');
        if (!review.history.some(entry => entry.id === input.id)) {
          review.history.push({ id: input.id, kind: input.action, changes: [...input.changes], decisions: { ...review.decisions }, comments: { ...review.comments } });
          for (const change of input.changes) { review.decisions[change] = ({ accept: 'accepted', reject: 'rejected', comment: 'commented' } as const)[input.action]; if (input.action === 'comment') review.comments[change] = input.body!.trim(); else delete review.comments[change]; }
          persist();
        }
        return pageState(id);
      }
      if (action === '/undo' && body !== undefined) {
        const previous = review.history.at(-1);
        if (!previous || previous.id !== (body as { id: string }).id) throw new Error('Only the latest decision can be undone.');
        review.history.pop(); review.decisions = previous.decisions; review.comments = previous.comments; persist();
        return { ...pageState(id), restored: previous.changes };
      }
    }
    if (path === `${base}/annotations` && body !== undefined) {
      const input = body as Annotation;
      if (input.key !== pdfKey || !Number.isInteger(input.page) || input.page < 0 || input.page >= pages.length || !validRect(input.rect) || (input.rects !== undefined && (!Array.isArray(input.rects) || !input.rects.every(validRect)))) throw new Error('Invalid note location.');
      const note: Annotation = { id: uuid(), projectId, key: pdfKey, page: input.page, rect: input.rect, ...(input.rects ? { rects: input.rects } : {}), comment: input.comment || '', quote: input.quote || '', source: null, createdAt: Date.now(), ...(input.group ? { group: input.group } : {}), ...(input.kind ? { kind: input.kind } : {}), ...(input.stamp ? { stamp: input.stamp } : {}) };
      local.annotations.push(note); persist(); return note;
    }
    if (path.startsWith(`${base}/annotations/`) && body !== undefined) {
      const [id, action] = path.slice(`${base}/annotations/`.length).split('/');
      const note = local.annotations.find(note => note.id === id);
      if (!note) throw new Error('Note not found.');
      if (action === 'delete') { note.deletedAt = Date.now(); persist(); return { ok: true }; }
      if (action === 'restore') { delete note.deletedAt; persist(); return { annotations: local.annotations.filter(note => !note.deletedAt) }; }
      if (!action && typeof (body as Annotation).comment === 'string') { note.comment = (body as Annotation).comment; persist(); return note; }
    }
    const copy = path.match(/^\/tasks\/example-review\/ai-review\/([^/]+)\/(copy|delete|restore)$/);
    if (copy && body !== undefined) {
      const note = suggestions().find(note => note.id === copy[1]);
      if (!note) throw new Error('Suggestion not found.');
      if (copy[2] === 'copy') {
        if (!local.copied[note.id] || !local.annotations.some(item => item.id === local.copied[note.id] && !item.deletedAt)) {
          const copied = { ...note, id: uuid(), aiReview: { ...note.aiReview!, sourceId: note.id } };
          local.annotations.push(copied); local.copied[note.id] = copied.id; persist();
        }
        return { note: { ...note, aiReview: { ...note.aiReview!, copiedTo: local.copied[note.id] } } };
      }
      local.hiddenSuggestions = copy[2] === 'delete' ? [...local.hiddenSuggestions, note.id] : local.hiddenSuggestions.filter(id => id !== note.id);
      persist(); return copy[2] === 'restore' ? note : { ok: true };
    }
    const modelTask = [reviewPlan, ...plans].find(plan => path === `/tasks/${plan.id}/model`);
    if (modelTask && body !== undefined) {
      const input = body as { model: string; effort: string; serviceTier?: string };
      const models = demoRuntimes[modelTask.agent as AgentId].models;
      const selected = models.find(model => input.model ? model.id === input.model : model.isDefault);
      if (!selected || typeof input.effort !== 'string' || (input.effort && !selected.efforts.includes(input.effort)) || (input.serviceTier && input.serviceTier !== 'default' && input.serviceTier !== selected.fastMode?.serviceTier)) throw new Error('Invalid demo model settings.');
      local.taskSettings[modelTask.id] = { ...local.taskSettings[modelTask.id], model: selected.id, effort: input.effort || null, serviceTier: input.serviceTier || 'default' };
      persist(); return task(modelTask, [reviewPlan, ...plans].indexOf(modelTask));
    }
    const permissionTask = plans.find(plan => path === `/tasks/${plan.id}/permissions`);
    if (permissionTask && body !== undefined) {
      const { permissions } = body as { permissions: string };
      if (!demoRuntimes[permissionTask.agent as AgentId].permissionOptions?.some(option => option.value === permissions)) throw new Error('Invalid demo permissions.');
      local.taskSettings[permissionTask.id] = { ...local.taskSettings[permissionTask.id], permissions };
      persist(); return task(permissionTask, plans.indexOf(permissionTask) + 1);
    }
    if (body !== undefined) throw new PlaygroundDownloadRequired();
    if (path === '/state') return { version, projects: [{ id: projectId, name: 'Meet Papilot', path: '/example/papilot-introduction', createdAt }], tasks: [task(reviewPlan, 0), ...plans.filter(plan => !plan.preset || local.openedPresets[plan.id]).map((plan, index) => task(plan, index + 1))], requests: [], runtime: demoRuntimes.codex, runtimes: demoRuntimes } satisfies Snapshot;
    if (path === `${base}/manuscript`) return { git, build: { status: 'ready', current: true, key: pdfKey, pages, builtAt: createdAt }, annotations: local.annotations.filter(note => !note.deletedAt) } satisfies Manuscript;
    if (path === `${base}/skills`) return { skills: [
      { id: 'polish', name: 'Polish', description: 'Improve clarity while preserving meaning.', hint: 'Which passage should be clearer?', source: 'builtin' },
      { id: 'review', name: 'Review', description: 'Review the paper and leave suggestions on the PDF.', hint: 'What should the reviewer focus on?', source: 'builtin', output: 'annotations' },
    ] satisfies Skill[] };
    if (path === `${base}/git`) return git;
    if (path === `${base}/manuscript/problems`) return { status: 'ready', key: pdfKey, problems: [], log: false };
    const example = [...plans, { ...reviewPlan, notes: [] as string[] }].find(example => path.startsWith(`/tasks/${example.id}/`));
    if (example) {
      const replay = local.replays[example.id], stage = progress(example.id);
      const timestamp = replay?.startedAt || createdAt;
      if (path.endsWith('/items') && replay && stage) {
        const items: TimelineItem[] = [{ id: `${example.id}-prompt`, taskId: example.id, type: 'user', text: example.prompt, createdAt: timestamp, meta: { notes: planNotes(example) } }, replayItem(example.id, replay, now())];
        if (stage.step >= 1) items.push({ id: `${example.id}-pdf`, taskId: example.id, type: 'pdf', text: 'Selected note and surrounding text', createdAt: timestamp + 2500 });
        if (stage.step >= 2) items.push({ id: `${example.id}-files`, taskId: example.id, type: 'files', text: 'main.tex', createdAt: timestamp + 5000 });
        if (stage.step >= 3) items.push({ id: `${example.id}-answer`, taskId: example.id, type: 'assistant', text: stage.done ? example.answer : example.answer.slice(0, Math.max(1, Math.floor((stage.elapsed - 7500) / (replayDuration - 7500) * example.answer.length))), status: stage.done ? 'completed' : 'inProgress', createdAt: timestamp + 7500 });
        return { items };
      }
      if (path.endsWith('/items')) return { items: [
        { id: `${example.id}-prompt`, taskId: example.id, type: 'user', text: example.prompt, createdAt, ...('notes' in example && example.notes.length ? { meta: { notes: planNotes(example) } } : {}) },
        { id: `${example.id}-pdf`, taskId: example.id, type: 'pdf', text: 'Pages 1–2 · product images, design philosophy and workflow equations', createdAt: createdAt + 10000 },
        ...(rounds[example.id] ? [{ id: `${example.id}-files`, taskId: example.id, type: 'files', text: 'main.tex', createdAt: createdAt + 20000 }] : []),
        { id: `${example.id}-answer`, taskId: example.id, type: 'assistant', text: example.answer, createdAt: createdAt + 30000 },
      ] satisfies TimelineItem[] };
      if (path.endsWith('/note-results')) {
        return { notes: noteResults(example) };
      }
      if (path.endsWith('/ai-review')) return { key: pdfKey, notes: suggestions().filter(note => !local.hiddenSuggestions.includes(note.id)) };
    }
    throw new PlaygroundDownloadRequired();
  }
  return async function request<T>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    return structuredClone(read(route, body)) as T;
  };
}
