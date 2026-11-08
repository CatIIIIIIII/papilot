import type { FastifyInstance } from 'fastify';
import type { Store } from './store.ts';
import { SkillLibrary } from './skill-library.ts';

export function registerSkillRoutes(app: FastifyInstance, store: Store, library = new SkillLibrary()) {
  function paper(id: unknown) {
    if (id === undefined) return undefined;
    if (typeof id !== 'string' || !id || id.length > 64) throw new Error('Select a valid paper.');
    return store.project(id).path;
  }
  type Query = { projectId?: string };
  type Params = { source: string; id: string };
  type Body = { projectId?: string; content?: unknown; revision?: unknown };
  app.get<{ Querystring: Query }>('/api/skills', request => library.list(paper(request.query.projectId)));
  app.get<{ Params: Params; Querystring: Query }>('/api/skills/:source/:id', request => library.read(request.params.source, request.params.id, paper(request.query.projectId)));
  app.post<{ Params: Params; Body: Body }>('/api/skills/:source/:id', request => library.save(request.params.source, request.params.id, request.body?.content, request.body?.revision, paper(request.body?.projectId)));
  app.post<{ Params: Params; Body: Body }>('/api/skills/:source/:id/remove', request => library.remove(request.params.source, request.params.id, request.body?.revision, paper(request.body?.projectId)));
}
