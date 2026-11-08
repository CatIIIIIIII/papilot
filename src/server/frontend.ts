import staticFiles from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';

export async function registerFrontend(app: FastifyInstance, root: string) {
  // Resolve assets at request time, so a frontend build can be deployed without
  // restarting the server or interrupting active Codex turns.
  await app.register(staticFiles, { root, prefix: '/', wildcard: true, cacheControl: false, dotfiles: 'deny' });
  app.setNotFoundHandler((request, reply) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (/^\/(api|review|assets|invite|sign-in)(\/|$)/.test(pathname)) return reply.code(404).send({ error: 'Not found' });
    return reply.type('text/html').send(fs.readFileSync(path.join(root, 'index.html')));
  });
}
