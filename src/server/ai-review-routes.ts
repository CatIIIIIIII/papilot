import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Store } from './store.ts';
import { pdfWords, type Manuscripts } from './manuscript.ts';
import { isTaskReviewNote } from '../shared.ts';

export function registerAiReviewRoutes(app: FastifyInstance, store: Store, manuscripts: Manuscripts) {
  const access = { config: { resource: { task: 'id' } } };
  function review(id: string) {
    const task = store.task(id);
    if (task.mode !== 'review') throw new Error('This task is not an AI review.');
    return task;
  }
  function finding(id: string, noteId: string) {
    const task = review(id), note = store.annotation(task.projectId, noteId);
    if (!isTaskReviewNote(note) || note.aiReview!.taskId !== id || note.taskId) throw new Error('This suggestion does not belong to this review task.');
    return note;
  }
  function changed(id: string) {
    const task = review(id);
    store.updateTask(id, { aiReview: { key: store.reviewInput(id).key, ...task.aiReview, revision: (task.aiReview?.revision || 0) + 1 } });
  }
  async function pdf(id: string) {
    const task = review(id), snapshot = store.reviewInput(id);
    if (snapshot.pdf && fs.existsSync(snapshot.pdf)) return snapshot.pdf;
    const root = store.project(task.projectId).path;
    // A repository move leaves the old absolute path stale, but the task's
    // preserved PDF moves with its repository state. Reuse those exact bytes.
    const relocated = await manuscripts.savedReviewPdf(root, id);
    if (relocated) { store.saveReviewInput(id, { ...snapshot, pdf: relocated }); return relocated; }
    // Older reviews retained geometry but not a PDF. Recover only that exact build.
    const original = await manuscripts.cachedPdf(root, snapshot.key);
    if (!original) throw new Error('The PDF copy for this review is unavailable. Start a new AI review.');
    const saved = await manuscripts.preserveReviewPdf(root, id, original);
    store.saveReviewInput(id, { ...snapshot, pdf: saved }); return saved;
  }
  app.get<{ Params: { id: string } }>('/api/tasks/:id/ai-review', access, async request => {
    const task = review(request.params.id), snapshot = store.reviewInput(task.id);
    await pdf(task.id);
    return { key: snapshot.key, notes: store.annotations(task.projectId).filter(note => isTaskReviewNote(note) && note.aiReview!.taskId === task.id && !note.taskId) };
  });
  app.get<{ Params: { id: string } }>('/api/tasks/:id/ai-review/pdf', access, async (request, reply) => {
    return reply.type('application/pdf').header('Cache-Control', 'private, no-cache').send(fs.createReadStream(await pdf(request.params.id)));
  });
  app.get<{ Params: { id: string }; Querystring: { page?: string } }>('/api/tasks/:id/ai-review/words', access, async request => pdfWords(await pdf(request.params.id), Number(request.query.page)));
  app.post<{ Params: { id: string; note: string } }>('/api/tasks/:id/ai-review/:note/copy', access, async request => {
    const { id, note: noteId } = request.params, original = finding(id, noteId);
    if (original.deletedAt !== undefined) throw new Error('Restore this suggestion before copying it.');
    if (original.aiReview!.copiedTo) return { note: original, copy: store.annotation(original.projectId, original.aiReview!.copiedTo) };
    const placed = await manuscripts.placeReviewNote(original.projectId, store.project(original.projectId).path, original, await pdf(id));
    return store.transaction(() => {
      const current = finding(id, noteId);
      if (current.deletedAt !== undefined) throw new Error('This suggestion was ignored while copying. Restore it first.');
      if (current.aiReview!.copiedTo) return { note: current, copy: store.annotation(current.projectId, current.aiReview!.copiedTo) };
      const copyId = 'adopt-' + createHash('sha256').update(`${id}:${noteId}`).digest('hex').slice(0, 40);
      const copy = store.saveAnnotation({ ...placed, id: copyId, createdAt: Date.now(), aiReview: { taskId: id, agent: current.aiReview!.agent, sourceId: noteId } });
      const note = store.saveAnnotation({ ...current, aiReview: { ...current.aiReview!, copiedTo: copyId } });
      changed(id);
      return { note, copy };
    });
  });
  app.post<{ Params: { id: string; note: string } }>('/api/tasks/:id/ai-review/:note/delete', access, request => {
    const note = finding(request.params.id, request.params.note);
    store.transaction(() => { store.deleteAnnotation(note.projectId, note.id); changed(request.params.id); });
    return { ok: true };
  });
  app.post<{ Params: { id: string; note: string } }>('/api/tasks/:id/ai-review/:note/restore', access, request => {
    const { deletedAt: _, ...note } = finding(request.params.id, request.params.note);
    return store.transaction(() => { const saved = store.saveAnnotation(note); changed(request.params.id); return saved; });
  });
}
