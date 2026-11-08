import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { authorize } from './security.ts';

export interface Listener { kind: 'local'; port: number; publicOrigin: string; owner: string }

declare module 'fastify' {
  // Resource metadata holds the paper's request lock while a route runs.
  interface FastifyContextConfig {
    resource?: { project: string; from?: 'body' } | { task: string } | { request: string };
    csrf?: false;
  }
}

export const equals = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export function guard(app: FastifyInstance, { listener, csrf }: { listener: Listener; csrf: string }) {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin').header('X-Frame-Options', 'SAMEORIGIN').header('Cache-Control', 'no-store');
    const denied = authorize(request.headers, request.raw.socket.remoteAddress, listener.port, listener.publicOrigin, listener.owner);
    if (denied) return reply.code(403).send({ error: denied });
    // Serve authenticates the owner; Funnel must never expose the workspace.
    if (request.headers['tailscale-funnel-request']) return reply.code(403).send({ error: 'Use your authorized Tailscale account to access Papilot.' });
    if (!request.is404 && request.method === 'POST' && request.routeOptions.config.csrf !== false && !equals(String(request.headers['x-papilot-token'] || ''), csrf)) {
      return reply.code(403).send({ error: 'This page has expired. Refresh it and try again.' });
    }
  });
}
