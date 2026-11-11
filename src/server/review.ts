import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { ENGINE } from './paths.ts';
import type { Task } from '../shared.ts';

export interface ReviewClient { url: string; token: string; get<T = any>(route: string): Promise<T>; post<T = any>(route: string, body?: unknown, timeout?: number): Promise<T> }
let modulePromise: Promise<{ connect: (root: string, start?: boolean, options?: { owned?: boolean }) => Promise<ReviewClient | null> }> | null = null;
// The desktop app owns the review servers it starts, so they stop with it,
// even after a crash. The web server leaves them running to finish builds
// across a restart.
const owned = process.env.PAPILOT_DESKTOP === '1';
export function reviewClient(root: string, reuse = false): Promise<ReviewClient> {
  modulePromise ??= import(pathToFileURL(path.join(ENGINE, 'src/client.ts')).href);
  // Polling an existing job must not replace a healthy server of another version.
  return modulePromise!.then(async module => (reuse && await module.connect(root, false)) || (await module.connect(root, true, { owned }))!);
}
export const taskRoute = (name: string) => `/api/tasks/${encodeURIComponent(name)}`;
export function reviewConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return ['AbortError', 'TimeoutError'].includes(error.name) || /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|The review server failed to start/.test(error.message);
}

// A repeatable read, even when the engine prepares its cache for it.
// Reconnect once if the engine restarted between connecting and reading.
// An engine that failed to start, or a read that timed out on a live one,
// would only fail again after the same wait.
export async function retryReviewRead<T>(connect: (root: string) => Promise<ReviewClient>, root: string, read: (client: ReviewClient) => Promise<T>): Promise<T> {
  const client = await connect(root);
  try { return await read(client); }
  catch (error) {
    if (!reviewConnectionError(error) || ['AbortError', 'TimeoutError'].includes((error as Error).name)) throw error;
    return read(await connect(root));
  }
}

export function confirmedReviewResponse(status: number, value: unknown, task: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  if (status === 400 || status === 409) return typeof result.error === 'string';
  return status >= 200 && status < 300 && result.task === task && typeof result.csrf === 'string' && typeof result.closed === 'boolean'
    && result.decisions !== null && typeof result.decisions === 'object' && !Array.isArray(result.decisions);
}

/** The statuses of a task whose agent is working or about to. */
export const AGENT_TURN: readonly string[] = ['running', 'waiting_input', 'queued'];
/** Add current workspace availability to viewer state; standalone engine state stays unchanged. */
export function annotateReviewState(value: unknown, tasks: readonly Task[]): unknown {
  if (!value || typeof value !== 'object' || typeof (value as any).task !== 'string'
    || !confirmedReviewResponse(200, value, (value as any).task)) return value;
  const state = value as Record<string, unknown>;
  const task = tasks.find(task => task.name === state.task);
  let decisionLock: string | null = null;
  let commentLock: string | null = null;
  let rejectLock: string | null = null;
  if (!task) decisionLock = commentLock = 'This task is no longer available in Papilot. Return to the workspace.';
  else if (state.closed) decisionLock = commentLock = 'This review is finished. Accepted changes are in your manuscript.';
  else if (task.status === 'deleting') decisionLock = commentLock = 'This task is being deleted. Review actions and comments are unavailable.';
  else if (task.status === 'uncertain') decisionLock = 'Select Check status in Papilot before accepting, rejecting, or undoing changes. You can still add comments.';
  else if (AGENT_TURN.includes(task.status) && !task.deferred) decisionLock = 'Pause this task in Papilot before accepting, rejecting, or undoing changes. You can still add comments.';
  else if (task.pendingReview) decisionLock = 'Wait for the current review action before accepting, rejecting, or undoing changes. You can still add comments.';
  else if (task.reconciliation && (!task.reconciliation.ready || Number(state.round) <= task.reconciliation.round)) decisionLock = 'Wait for the merge suggestion before changing review decisions.';
  else if (task.delivery?.pending) decisionLock = 'Retry the pending delivery before changing review decisions.';
  // While the agent works, accepting a deferred task writes only review refs,
  // and a reject waits for the turn to end before it reverts the agent's
  // files. Undoing an applied rejection and editing source write them now.
  const queueRejects = Boolean(task && !decisionLock && task.deferred && AGENT_TURN.includes(task.status));
  if (task && !decisionLock && AGENT_TURN.includes(task.status)) rejectLock = "The agent is editing this task's files. Pause it before editing changes or undoing a rejection. You can still accept, reject and comment.";
  // Task-branch commits from older versions still need manuscript application.
  return { ...state, decisionLock, commentLock, rejectLock, ...(queueRejects ? { queueRejects: true } : {}), ...(task ? { workspace: { ...(task.reconciliation ? { merging: true } : {}), status: task.status, unsent: task.review?.unsent ?? 0, comments: task.review?.comments ?? 0, accepted: task.review?.files?.length || (task.committed || task.delivery?.pending || task.delivery?.mode === 'branch' ? 1 : 0), ...(task.deferred ? { deferred: true, destination: task.delivery?.pending ? undefined : task.delivery?.mode } : {}) } } : {}) };
}

export function allowedReviewRoute(route: string, method: string): boolean {
  if (route.includes('..') || route.includes('\\')) return false;
  if (method === 'GET') return route === '/' || /^\/option-files\/[a-z0-9-]+\/\d+\/[a-f0-9]{64}\/[\w.-]+\.(svg|png|pdf)$/.test(route) || /^\/(assets|fonts)\/[\w./-]+$/.test(route) || /^\/files\/[a-z0-9-]+\/\d+\/[\w.-]+\.(svg|png)$/.test(route) || /^\/applied\/[a-z0-9-]+\/[a-f0-9]{32}\.pdf$/.test(route) || /^\/api\/tasks(?:\/[a-z0-9-]+(?:\/(?:state|source|applied|rounds\/\d+(?:\/effects\/c\d+|\/references)?))?)?$/.test(route);
  return method === 'POST' && /^\/api\/tasks\/[a-z0-9-]+\/(decide|undo|note|look|source(?:\/options)?|rounds\/\d+\/references\/confirm)$/.test(route);
}
export function rewriteReviewJson(value: any, prefix: string): any {
  if (Array.isArray(value)) return value.map(v => rewriteReviewJson(v, prefix));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'url' && typeof v === 'string' && /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(v) ? prefix + new URL(v).pathname + new URL(v).search : rewriteReviewJson(v, prefix)]));
  return typeof value === 'string' && (value.startsWith('/files/') || value.startsWith('/option-files/') || value.startsWith('/applied/')) ? prefix + value : value;
}
export function rewriteReviewHtml(html: string, prefix: string): string {
  const script = `<script>(()=>{const prefix=${JSON.stringify(prefix)};if(!crypto.randomUUID)crypto.randomUUID=()=>Array.from(crypto.getRandomValues(new Uint8Array(20)),b=>b.toString(16).padStart(2,'0')).join('');const original=window.fetch;window.fetch=(input,init)=>{if(typeof input==='string'&&input.startsWith('/api/'))input=prefix+input;return original.call(window,input,init);};})();</script>`;
  return html.replace(/(src|href)="\/(?!\/)/g, `$1="${prefix}/`).replace('<head>', '<head>' + script);
}
