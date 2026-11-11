import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { moveLegacyStates } from '../src/server/state.ts';
import { moveLegacyStorage } from '../engine/src/web/legacy-storage.ts';

// Papilot 0.9.4 and earlier used the names of the review engine's former
// standalone skill for each paper's state and the viewer's browser storage.
test('startup moves each paper\'s review state before anything reads it, and skips papers it cannot reach', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-legacy-')), root = path.join(base, 'paper');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); fs.writeFileSync(path.join(root, 'main.tex'), 'x'); git('add', '.'); git('commit', '-qm', 'Paper');
  fs.mkdirSync(path.join(root, '.git/latex-review')); fs.writeFileSync(path.join(root, '.git/latex-review/state.sqlite3'), 'tasks');
  git('update-ref', 'refs/latex-review/task/accepted', 'HEAD');
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
  await moveLegacyStates([path.join(base, 'missing'), root]);
  // Node may also report node:sqlite as experimental the first time it loads.
  assert.deepEqual(errors.filter(args => String(args[0]).startsWith('Could not move')).map(args => String(args[0])), [`Could not move the review state of ${path.join(base, 'missing')}:`]);
  assert.equal(fs.readFileSync(path.join(root, '.git/papilot/state.sqlite3'), 'utf8'), 'tasks');
  // A link keeps the absolute paths that earlier records name valid.
  assert.ok(fs.lstatSync(path.join(root, '.git/latex-review')).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(root, '.git/latex-review/state.sqlite3'), 'utf8'), 'tasks');
  assert.equal(git('rev-parse', 'refs/papilot/task/accepted'), git('rev-parse', 'HEAD'));
  assert.equal(git('for-each-ref', 'refs/latex-review/'), '');
});

test('the review viewer\'s preferences and drafts move to their current keys, also in the demo', () => {
  const values = new Map<string, string>(Object.entries({
    'latex-review:shortcuts': '{"next":"j"}',
    'latex-review:default-view': 'paper',
    'playground:latex-review:effects': 'off',
    'latex-review:references': 'off',
    'papilot:review:references': 'on',
    'papilot:theme': 'dark',
  }));
  const storage = {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } as Storage;
  moveLegacyStorage(storage);
  assert.deepEqual(Object.fromEntries(values), {
    'papilot:review:shortcuts': '{"next":"j"}',
    'papilot:review:default-view': 'paper',
    'playground:papilot:review:effects': 'off',
    // A value saved under the current key since the update is kept.
    'papilot:review:references': 'on',
    'papilot:theme': 'dark',
  });
  moveLegacyStorage({ get length(): number { throw new Error('blocked'); } } as unknown as Storage);
  // Where the browser blocks storage, reading localStorage itself throws.
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } });
  try { moveLegacyStorage(); } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});
