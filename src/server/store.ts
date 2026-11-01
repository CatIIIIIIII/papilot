import type { ReviewSnapshot } from './ai-review.ts';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { Annotation, Project, Task, Run, TimelineItem } from '../shared.ts';

export class Store extends EventEmitter {
  db: DatabaseSync;
  constructor(public readonly file: string) {
    super();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, request_key TEXT UNIQUE NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, created INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deleted_tasks(id TEXT PRIMARY KEY, deleted INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_review_inputs(task_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS annotations(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invites(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL, expires INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members(project_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(project_id, user_id));
      CREATE TABLE IF NOT EXISTS migrations(key TEXT PRIMARY KEY, done INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS task_items ON items(task_id,created);
      CREATE INDEX IF NOT EXISTS task_runs ON runs(task_id,status);`);
  }
  private rows<T>(table: string): T[] { return (this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all() as { data: string }[]).map(r => JSON.parse(r.data)); }
  projects() { return this.rows<Project>('projects'); }
  tasks() { return this.rows<Task>('tasks'); }
  runs() { return this.rows<Run>('runs'); }
  project(id: string) { const v = this.projects().find(p => p.id === id); if (!v) throw new Error('Paper project not found.'); return v; }
  task(id: string) { const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id) as { data: string } | undefined; if (!row) throw new Error('Task not found.'); return JSON.parse(row.data) as Task; }
  projectByPath(p: string) { return this.projects().find(project => project.path === p); }
  saveProject(p: Project) { this.db.prepare('INSERT INTO projects VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,data=excluded.data').run(p.id, p.path, JSON.stringify(p)); this.emit('change'); }
  removeProject(id: string) {
    this.project(id);
    this.transaction(() => {
      // Only Papilot records are removed. Never finish review tasks or touch their files.
      this.db.prepare('INSERT OR IGNORE INTO deleted_tasks SELECT id, ? FROM tasks WHERE project_id=?').run(Date.now(), id);
      for (const table of ['items', 'runs', 'ai_review_inputs']) this.db.prepare(`DELETE FROM ${table} WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?)`).run(id);
      for (const table of ['tasks', 'annotations', 'members']) this.db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(id);
      this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
    });
    this.emit('change');
  }
  saveTask(t: Task) { t.updatedAt = Date.now(); this.db.prepare('INSERT INTO tasks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(t.id, t.projectId, JSON.stringify(t)); this.emit('change'); return t; }
  updateTask(id: string, update: Partial<Task>) { return this.saveTask({ ...this.task(id), ...update }); }
  saveRun(r: Run) { this.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data').run(r.id, r.taskId, r.requestKey, r.status, JSON.stringify(r)); this.emit('change'); }
  runByKey(key: string) { const row = this.db.prepare('SELECT data FROM runs WHERE request_key=?').get(key) as { data: string } | undefined; return row ? JSON.parse(row.data) as Run : undefined; }
  items(taskId: string) { return (this.db.prepare('SELECT data FROM items WHERE task_id=? ORDER BY created,rowid').all(taskId) as { data: string }[]).map(r => JSON.parse(r.data) as TimelineItem); }
  saveItem(item: TimelineItem) { this.db.prepare('INSERT INTO items VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(item.id, item.taskId, item.createdAt, JSON.stringify(item)); this.emit('change'); }
  saveReviewInput(taskId: string, snapshot: ReviewSnapshot) { this.db.prepare('INSERT INTO ai_review_inputs VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET data=excluded.data').run(taskId, JSON.stringify(snapshot)); }
  reviewInput(taskId: string): ReviewSnapshot {
    const row = this.db.prepare('SELECT data FROM ai_review_inputs WHERE task_id=?').get(taskId) as { data: string } | undefined;
    if (!row) throw new Error('The PDF snapshot for this review is unavailable. Start a new AI review.');
    return JSON.parse(row.data);
  }
  annotations(projectId: string) { return (this.db.prepare('SELECT data FROM annotations WHERE project_id=? ORDER BY rowid').all(projectId) as { data: string }[]).map(r => JSON.parse(r.data) as Annotation).filter(note => note.deletedAt === undefined); }
  annotation(projectId: string, id: string) {
    const row = this.db.prepare('SELECT data FROM annotations WHERE id=? AND project_id=?').get(id, projectId) as { data: string } | undefined;
    if (!row) throw new Error('Note not found.');
    return JSON.parse(row.data) as Annotation;
  }
  saveAnnotation(a: Annotation) { this.db.prepare('INSERT INTO annotations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(a.id, a.projectId, JSON.stringify(a)); this.emit('change'); return a; }
  deleteAnnotation(projectId: string, id: string) {
    const note = this.annotation(projectId, id);
    if (note.taskId) throw new Error('This note has already been sent.');
    this.saveAnnotation({ ...note, deletedAt: note.deletedAt ?? Date.now() });
  }
  taskDeleted(id: string) { return Boolean(this.db.prepare('SELECT 1 FROM deleted_tasks WHERE id=?').get(id)); }
  deleteTask(id: string) {
    this.transaction(() => {
      this.db.prepare('INSERT INTO deleted_tasks VALUES(?,?) ON CONFLICT(id) DO NOTHING').run(id, Date.now());
      this.db.prepare('DELETE FROM items WHERE task_id=?').run(id);
      this.db.prepare('DELETE FROM runs WHERE task_id=?').run(id);
      this.db.prepare('DELETE FROM ai_review_inputs WHERE task_id=?').run(id);
      this.db.prepare('DELETE FROM tasks WHERE id=?').run(id);
    });
    this.emit('change');
  }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  recover() {
    this.transaction(() => {
      for (const t of this.tasks().filter(t => t.titleGeneration === 'pending')) this.updateTask(t.id, { titleGeneration: 'failed' });
      for (const t of this.tasks().filter(t => t.status === 'deleting')) this.updateTask(t.id, { error: 'The server restarted during deletion. Retry deletion to confirm cleanup.' });
      for (const t of this.tasks().filter(t => t.pendingReview)) this.updateTask(t.id, { status: 'uncertain', error: 'The server restarted before a review action was confirmed. Select Check status before continuing.' });
      for (const r of this.runs().filter(r => r.status === 'running')) this.saveRun({ ...r, status: 'interrupted', finishedAt: Date.now() });
      for (const t of this.tasks().filter(t => ['running', 'waiting_input'].includes(t.status) || (t.mode === 'review' && t.status === 'building'))) this.updateTask(t.id, { status: 'interrupted', turnId: null, error: 'The server restarted and interrupted the previous turn. Continue in the same conversation.' });
    });
  }
  close() { this.db.close(); }
}
