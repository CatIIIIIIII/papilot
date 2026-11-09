import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Attachments } from '../src/server/attachments.ts';
import { Store } from '../src/server/store.ts';

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-attachment-storage-'));
  const store = new Store(path.join(directory, 'state.sqlite'));
  const attachments = new Attachments(store), files = path.join(directory, 'attachments');
  store.saveProject({ id: 'paper', path: directory, name: 'Paper', createdAt: 1 });
  t.after(() => { attachments.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const count = () => store.db.prepare('SELECT count(*) AS count FROM attachments').get()!.count;
  return { store, attachments, files, count };
}

for (const written of [0, 3]) {
  test(`failed attachment upload removes its file after writing ${written} bytes`, async t => {
    const f = fixture(t), bytes = Buffer.from('complete reference data');
    const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    const writeFile = fs.promises.writeFile.bind(fs.promises);
    const failingWrite = t.mock.method(fs.promises, 'writeFile', async (...args: Parameters<typeof fs.promises.writeFile>) => {
      await writeFile(args[0], bytes.subarray(0, written), args[2]);
      throw failure;
    });
    await assert.rejects(f.attachments.upload('paper', 'reference.txt', bytes), error => error === failure);
    assert.deepEqual(fs.readdirSync(f.files), [], 'Unregistered files must not survive a failed write');
    assert.equal(f.count(), 0);

    failingWrite.mock.restore();
    const uploaded = await f.attachments.upload('paper', 'reference.txt', bytes);
    assert.deepEqual(fs.readFileSync(f.attachments.path(uploaded)), bytes);
    assert.deepEqual(fs.readdirSync(f.files), [path.basename(f.attachments.path(uploaded))]);
    assert.equal(f.count(), 1, 'Retrying succeeds without accumulating orphaned files');
  });
}

test('attachment upload preserves a destination it could not exclusively create', async t => {
  const f = fixture(t), existing = path.join(f.files, 'existing.txt');
  fs.mkdirSync(f.files);
  fs.writeFileSync(existing, 'keep this file');
  t.mock.method(f.attachments, 'path', () => existing);
  await assert.rejects(f.attachments.upload('paper', 'reference.txt', Buffer.from('replacement')), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(existing, 'utf8'), 'keep this file');
  assert.deepEqual(fs.readdirSync(f.files), ['existing.txt']);
  assert.equal(f.count(), 0);
});

test('attachment upload removes its completed file if database registration fails', async t => {
  const f = fixture(t);
  f.store.db.exec("CREATE TRIGGER fail_attachment BEFORE INSERT ON attachments BEGIN SELECT RAISE(FAIL, 'injected registration failure'); END");
  await assert.rejects(f.attachments.upload('paper', 'reference.txt', Buffer.from('data')), /injected registration failure/);
  assert.deepEqual(fs.readdirSync(f.files), []);
  assert.equal(f.count(), 0);
});

test('attachment upload removes its file if the project disappears while writing', async t => {
  const f = fixture(t), writeFile = fs.promises.writeFile.bind(fs.promises);
  t.mock.method(fs.promises, 'writeFile', async (...args: Parameters<typeof fs.promises.writeFile>) => {
    await writeFile(...args);
    f.store.removeProject('paper');
  });
  await assert.rejects(f.attachments.upload('paper', 'reference.txt', Buffer.from('data')), /Paper project not found/);
  assert.deepEqual(fs.readdirSync(f.files), []);
  assert.equal(f.count(), 0);
});

test('successful attachment storage retains the complete bytes and read-only permissions', async t => {
  const f = fixture(t), bytes = Buffer.from([0, 255, 128, 1, 2]);
  const uploaded = await f.attachments.upload('paper', 'data.bin', bytes);
  assert.deepEqual(fs.readFileSync(f.attachments.path(uploaded)), bytes);
  assert.deepEqual(f.attachments.get('paper', uploaded.id), uploaded);
  assert.equal(uploaded.size, bytes.length);
  assert.equal(f.count(), 1);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.attachments.path(uploaded)).mode & 0o777, 0o400);
});
