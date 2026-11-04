import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authorize } from './security.ts';
import type { Accounts, Session, User } from './accounts.ts';
import type { Store } from './store.ts';
import type { Author, PendingRequest, Snapshot, Viewer as ViewerInfo } from '../shared.ts';

// Who may use a route. Every route declares one, and the server refuses to
// start if one does not, so a new route cannot skip the check:
// public: anyone, including people not signed in (sign-in, the app's files)
// any: anyone signed in
// owner: the owner only (adding papers by path, managing people)
// { project | task | request: param }: a signed-in person who can see the
// paper that the named route parameter (or body field, from: 'body') belongs to
export type Access = 'public' | 'any' | 'owner' | { project: string; from?: 'body' } | { task: string } | { request: string };
// The local listener serves this host and the owner's Tailscale Serve endpoint;
// the account listener serves the public URL, where people sign in with passkeys.
// hsts is off when the tailnet endpoint uses plain HTTP on the same host name,
// which a year of HSTS would break.
export type Listener = { kind: 'local'; port: number; publicOrigin: string; owner: string } | { kind: 'account'; origin: string; hsts?: boolean };
export type Viewer = { listener: 'local' } | { listener: 'account'; user: User; session: Session };

declare module 'fastify' {
  // hidden: 'ok' answers { ok: true } for a hidden paper's resource, as the route does for a missing one.
  interface FastifyContextConfig { access?: Access; csrf?: false; hidden?: 'ok' }
  interface FastifyRequest { viewer?: Viewer }
}

export const SESSION_COOKIE = '__Host-papilot-session';
export const equals = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
export function cookie(header: string | undefined, name: string) {
  for (const part of (header || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return '';
}
export const isOwner = (viewer: Viewer | undefined) => viewer?.listener === 'local' || viewer?.user.role === 'owner';
// Messages and notes record who wrote them; the owner's carry no author.
export const author = (viewer: Viewer | undefined): Author | undefined => viewer?.listener === 'account' && viewer.user.role !== 'owner' ? { id: viewer.user.id, name: viewer.user.name } : undefined;
export function viewerInfo(viewer: Viewer, accounts: Accounts): ViewerInfo {
  const user = viewer.listener === 'local' ? accounts.owner() : viewer.user;
  return { id: user.id, name: user.name, role: user.role, listener: viewer.listener, owner: accounts.owner().name };
}

// What a person sees of the workspace: the papers shared with them, their
// tasks and pending requests, and the agents without the owner's login.
export function visibleSnapshot(snapshot: Snapshot, viewer: Viewer, accounts: Accounts): Snapshot {
  if (isOwner(viewer) || viewer.listener !== 'account') return snapshot;
  const shown = new Set(snapshot.projects.filter(project => accounts.canSee(viewer.user, project.id)).map(project => project.id));
  const tasks = snapshot.tasks.filter(task => shown.has(task.projectId)), taskIds = new Set(tasks.map(task => task.id));
  const redact = <T extends { account: string | null } | undefined>(runtime: T): T => runtime && runtime.account ? { ...runtime, account: 'Signed in' } : runtime;
  return {
    ...snapshot, projects: snapshot.projects.filter(project => shown.has(project.id)), tasks,
    requests: snapshot.requests.filter(request => taskIds.has(request.taskId)),
    runtime: redact(snapshot.runtime),
    ...(snapshot.runtimes ? { runtimes: Object.fromEntries(Object.entries(snapshot.runtimes).map(([id, runtime]) => [id, redact(runtime)])) } : {}),
  };
}

// Attempts per client per minute for the sign-in endpoints. There is no
// overall cap, which one client could use up to lock everyone out; requests a
// proxy sent without the client's address share one larger allowance.
export class Limiter {
  private windows = new Map<string, { count: number; reset: number }>();
  constructor(private perClient = 30, private unknown = 600, private now = () => Date.now()) {}
  take(client: string) {
    const now = this.now();
    let window = this.windows.get(client);
    if (!window || window.reset <= now) {
      if (this.windows.size >= 1000) this.windows.delete(this.windows.keys().next().value!);
      window = { count: 0, reset: now + 60000 };
      this.windows.delete(client); this.windows.set(client, window);
    }
    if (window.count >= (client === 'unknown' ? this.unknown : this.perClient)) return false;
    window.count++;
    return true;
  }
}
// Every public connection reaches Papilot from the proxy on this host, which
// appends the client's address last. An IPv6 client counts by its /64, since
// one host can use any address in it.
export function clientAddress(request: FastifyRequest) {
  const address = String(request.headers['x-forwarded-for'] || '').split(',').map(part => part.trim()).filter(Boolean).at(-1)?.split('%', 1)[0] || '';
  if (!address) return 'unknown';
  const v4 = address.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4 || !address.includes(':')) return v4 ? v4[1] : address;
  const [head, tail] = address.toLowerCase().split('::'), front = head ? head.split(':') : [], back = tail ? tail.split(':') : [];
  const groups = tail === undefined ? front : [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill('0'), ...back];
  return groups.slice(0, 4).map(group => group.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

const deny = (reply: FastifyReply, code: number, error: string) => reply.code(code).send({ error });

export function guard(app: FastifyInstance, options: { listener: Listener; accounts: Accounts; store: Store; csrf: string; request: (id: string) => PendingRequest | undefined }) {
  const { listener, accounts, store } = options;
  app.addHook('onRoute', route => {
    // @fastify/static serves the built app's files under /*; it takes no config.
    const access = route.config?.access ?? (route.url === '/*' ? 'public' : undefined);
    if (!access) throw new Error(`${route.method} ${route.url} has no access rule.`);
    if (typeof access === 'object' && !('from' in access && access.from === 'body')) {
      const param = Object.values(access)[0];
      if (!new RegExp(`:${param}(/|$)`).test(route.url)) throw new Error(`${route.method} ${route.url} has no :${param} parameter for its access rule.`);
    }
    route.config = { ...route.config, access };
  });
  const csrfFor = (viewer: Viewer) => viewer.listener === 'local' ? options.csrf : viewer.session.csrf;
  // A paper the person cannot see answers like one that does not exist: the
  // error its route gives for a missing paper, task or request.
  const hidden = (viewer: Viewer, access: Access, values: Record<string, unknown>) => {
    if (isOwner(viewer) || typeof access !== 'object' || viewer.listener !== 'account') return null;
    const can = (projectId: string) => accounts.canSee(viewer.user, projectId);
    const value = String(values?.[Object.values(access)[0] as string] ?? '');
    if ('project' in access && !can(value)) return 'Paper project not found.';
    if ('task' in access) { const task = store.tasks().find(task => task.id === value); if (task && !can(task.projectId)) return 'Task not found.'; }
    if ('request' in access) {
      const pending = options.request(value), task = pending && store.tasks().find(task => task.id === pending.taskId);
      if (pending && (!task || !can(task.projectId))) return 'This request has ended or the connection has restarted.';
    }
    return null;
  };
  const refuse = (request: FastifyRequest, reply: FastifyReply, message: string) => request.routeOptions.config.hidden === 'ok' ? reply.send({ ok: true }) : deny(reply, 400, message);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin').header('X-Frame-Options', 'SAMEORIGIN').header('Cache-Control', 'no-store');
    // A request no route matched gets the app or a plain 404 from the not-found handler.
    const config = request.routeOptions.config, access = request.is404 ? 'public' : config?.access;
    if (listener.kind === 'local') {
      const denied = authorize(request.headers, request.raw.socket.remoteAddress, listener.port, listener.publicOrigin, listener.owner);
      if (denied) return deny(reply, 403, denied);
      // Funnel switched on for the tailnet endpoint would put it on the internet.
      if (request.headers['tailscale-funnel-request']) return deny(reply, 403, 'This address is only for your tailnet. People outside it sign in at PAPILOT_ACCOUNT_ORIGIN.');
      request.viewer = { listener: 'local' };
    } else {
      // Everything here came from the internet, whatever its headers claim.
      const origin = new URL(listener.origin);
      if (request.headers.host !== origin.host) return deny(reply, 403, 'Open Papilot at its public address.');
      // Other sites may link to the app's pages, such as an invite link in a
      // web mail, but may not request anything else from them.
      const site = request.headers['sec-fetch-site'];
      const page = (request.method === 'GET' || request.method === 'HEAD') && access === 'public' && request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document';
      if ((site === 'same-site' || site === 'cross-site') && !page) return deny(reply, 403, 'The request origin does not match.');
      if ((request.headers.origin || (request.method !== 'GET' && request.method !== 'HEAD')) && request.headers.origin !== listener.origin) return deny(reply, 403, 'The request origin does not match.');
      if (listener.hsts) reply.header('Strict-Transport-Security', 'max-age=31536000');
      const found = accounts.session(cookie(request.headers.cookie, SESSION_COOKIE));
      if (found) request.viewer = { listener: 'account', user: found.user, session: found.session };
    }
    if (!access) return deny(reply, 404, 'Not found');
    const viewer = request.viewer;
    if (access === 'public') return;
    if (!viewer) return deny(reply, 401, 'Sign in to continue.');
    if (request.method === 'POST' && config.csrf !== false && !equals(String(request.headers['x-papilot-token'] || ''), csrfFor(viewer))) return deny(reply, 403, 'This page has expired. Refresh it and try again.');
    if (access === 'owner' && !isOwner(viewer)) return deny(reply, 403, 'Only the owner of this Papilot can do this.');
    const message = typeof access === 'object' && !('from' in access) ? hidden(viewer, access, request.params as Record<string, unknown>) : null;
    if (message) return refuse(request, reply, message);
  });
  // The body can arrive long after the headers, so a signed-in person's
  // session and papers are checked again once it has, along with a paper
  // named in the body. Removal or unsharing meanwhile stops the request.
  app.addHook('preHandler', async (request, reply) => {
    const config = request.routeOptions.config, access = config?.access;
    if (request.viewer?.listener !== 'account' || request.is404 || !access || access === 'public') return;
    const found = accounts.session(cookie(request.headers.cookie, SESSION_COOKIE));
    if (!found || found.session.id !== request.viewer.session.id) return deny(reply, 401, 'Sign in to continue.');
    const viewer: Viewer = request.viewer = { listener: 'account', user: found.user, session: found.session };
    if (access === 'owner' && !isOwner(viewer)) return deny(reply, 403, 'Only the owner of this Papilot can do this.');
    const message = typeof access === 'object' ? hidden(viewer, access, ('from' in access ? request.body : request.params) as Record<string, unknown>) : null;
    if (message) return refuse(request, reply, message);
  });
  return { csrfFor };
}
