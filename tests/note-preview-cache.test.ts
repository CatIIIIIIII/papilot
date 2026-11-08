import test from 'node:test';
import assert from 'node:assert/strict';
import { NotePreviewCache } from '../src/web/note-preview-cache.ts';

test('background preparation and repeated selection share one comparison load', async () => {
  const cache = new NotePreviewCache<object>();
  let loads = 0, finish!: (value: object) => void;
  const detail = { revision: 'candidate' };
  const load = () => { loads++; return new Promise<object>(resolve => { finish = resolve; }); };
  const prepared = cache.read('task:round:option', load);
  const selected = cache.read('task:round:option', load);
  await Promise.resolve();
  assert.equal(loads, 1); assert.equal(cache.peek('task:round:option'), undefined);
  finish(detail);
  assert.equal(await prepared, detail); assert.equal(await selected, detail);
  assert.equal(cache.peek('task:round:option'), detail);
  assert.equal(await cache.read('task:round:option', load), detail); assert.equal(loads, 1);
});
test('a failed background comparison can retry and different review rounds stay separate', async () => {
  const cache = new NotePreviewCache<string>();
  await assert.rejects(cache.read('round1', async () => { throw new Error('offline'); }), /offline/);
  assert.equal(await cache.read('round1', async () => 'old'), 'old');
  assert.equal(await cache.read('round2', async () => 'new'), 'new');
  assert.equal(cache.peek('round1'), 'old'); assert.equal(cache.peek('round2'), 'new');
});
