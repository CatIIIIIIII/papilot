import test from 'node:test';
import assert from 'node:assert/strict';
import { connectNoteAlternatives, loadNoteAlternatives, saveNoteAlternatives } from '../src/web/note-option-preferences.ts';
import { browserStorage } from '../src/web/storage.ts';

test('quick slider changes persist in order and stale reads cannot replace the latest choice', async () => {
  const posts: { body: any; resolve: (value: any) => void }[] = [];
  const reads: ((value: any) => void)[] = [];
  connectNoteAlternatives(<T>(_route: string, body?: unknown) => new Promise<T>(resolve => {
    if (body) posts.push({ body, resolve }); else reads.push(resolve);
  }));
  const first = saveNoteAlternatives(true, 'balanced');
  const last = saveNoteAlternatives(true, 'many');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(posts.length, 1, 'A later write waits for the earlier response');
  assert.equal(browserStorage.getItem('papilot:note-alternative-range'), 'many', 'The thumb follows the latest choice immediately');
  loadNoteAlternatives();
  assert.equal(reads.length, 1, 'Focus refreshes wait for pending writes');
  reads[0]({ noteAlternatives: false, noteAlternativeRange: 'few' });
  posts[0].resolve(posts[0].body);
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(browserStorage.getItem('papilot:note-alternative-range'), 'many');
  assert.equal(posts.length, 2);
  assert.equal(posts[1].body.noteAlternativeRange, 'many');
  posts[1].resolve(posts[1].body);
  await last;
  reads[1]({ noteAlternatives: true, noteAlternativeRange: 'many' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(browserStorage.getItem('papilot:note-alternatives'), 'on');
  assert.equal(browserStorage.getItem('papilot:note-alternative-range'), 'many');
});
