import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/server/store.ts';

test('upgrading a shared database preserves owner preferences and content but removes access credentials', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-single-user-')), file = path.join(directory, 'state.sqlite');
  let store = new Store(file);
  store.saveProject({ id: 'paper', path: directory, name: 'Paper', createdAt: 1 });
  const note = { id: 'note', projectId: 'paper', key: 'pdf', page: 0, rect: [0, 0, 1, 1] as [number, number, number, number], comment: 'Keep this.', quote: 'Text', source: null, createdAt: 1, author: { id: 'member', name: 'Ada' } };
  store.saveAnnotation(note);
  const task = store.saveTask({ id: 'task', projectId: 'paper', name: 'p-task', title: 'Existing task', instructions: 'Edit.', worktree: '/unused', threadId: null, turnId: null, model: null, status: 'reviewing', createdAt: 1, updatedAt: 1, feedbackCursor: 0, error: null, review: null });
  const message = { id: 'message', taskId: task.id, type: 'userMessage', text: 'Keep the conversation.', createdAt: 1, meta: { author: note.author } };
  store.saveItem(message);
  store.close();
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users(id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE preferences(user_id TEXT, key TEXT, data TEXT, PRIMARY KEY(user_id,key));
    CREATE TABLE credentials(id TEXT); CREATE TABLE invites(id TEXT);
    CREATE TABLE sessions(id TEXT); CREATE TABLE members(id TEXT); CREATE TABLE migrations(key TEXT);`);
  old.prepare('INSERT INTO users VALUES(?,?)').run('host', JSON.stringify({ role: 'owner' }));
  old.prepare('INSERT INTO users VALUES(?,?)').run('member', JSON.stringify({ role: 'member' }));
  old.prepare('INSERT INTO preferences VALUES(?,?,?)').run('host', 'quick-notes', JSON.stringify([{ id: 'verify' }]));
  old.prepare('INSERT INTO preferences VALUES(?,?,?)').run('host', 'indirect-changes', 'true');
  old.prepare('INSERT INTO preferences VALUES(?,?,?)').run('member', 'quick-notes', JSON.stringify([{ id: 'runt' }]));
  old.exec("INSERT INTO sessions VALUES('old-login'); INSERT INTO invites VALUES('old-invite');");
  old.close();
  try {
    store = new Store(file);
    assert.deepEqual(store.preference('quick-notes'), [{ id: 'verify' }]);
    assert.equal(store.preference('indirect-changes'), true);
    assert.deepEqual(store.annotation('paper', 'note'), note);
    assert.deepEqual(store.task(task.id), task);
    assert.deepEqual(store.items(task.id), [message]);
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
    for (const name of ['users', 'credentials', 'invites', 'sessions', 'members', 'preferences', 'migrations']) assert.equal(tables.includes(name), false, name);
    store.savePreference('quick-notes', [{ id: 'polish' }]);
    store.close(); store = new Store(file);
    assert.deepEqual(store.preference('quick-notes'), [{ id: 'polish' }], 'reopening does not replay the migration');
    store.removeProject('paper');
    assert.equal(store.projects().length, 0);
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a new workspace has settings without creating account or sharing tables', () => {
  const store = new Store(':memory:');
  try {
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
    for (const name of ['users', 'credentials', 'invites', 'sessions', 'members', 'preferences']) assert.equal(tables.includes(name), false, name);
    store.savePreference('indirect-changes', true);
    assert.equal(store.preference('indirect-changes'), true);
  } finally { store.close(); }
});
