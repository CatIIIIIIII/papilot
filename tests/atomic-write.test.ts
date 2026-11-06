import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteAsync } from '../engine/src/core/files.ts';

function fixture(t: TestContext, platform = 'win32') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-atomic-write-'));
  const file = path.join(root, 'latest.json');
  fs.writeFileSync(file, 'previous contents');
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform });
  t.after(() => {
    Object.defineProperty(process, 'platform', descriptor);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, file };
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) test(`atomic async replacement retries transient Windows ${code} without removing the old file`, async t => {
  const { root, file } = fixture(t);
  const rename = fs.promises.rename.bind(fs.promises);
  let attempts = 0;
  const temporary = new Set<string>();
  t.mock.method(fs.promises, 'rename', async (from: fs.PathLike, to: fs.PathLike) => {
    if (to !== file) return rename(from, to);
    attempts++;
    temporary.add(String(from));
    assert.equal(fs.readFileSync(file, 'utf8'), 'previous contents');
    assert.equal(fs.readFileSync(from, 'utf8'), 'replacement contents');
    if (attempts <= 2) throw Object.assign(new Error('temporary sharing violation'), { code });
    return rename(from, to);
  });
  await atomicWriteAsync(file, 'replacement contents');
  assert.equal(attempts, 3);
  assert.equal(temporary.size, 1, 'Retries must reuse the completed temporary file');
  assert.equal(fs.readFileSync(file, 'utf8'), 'replacement contents');
  assert.deepEqual(fs.readdirSync(root), ['latest.json']);
});

test('atomic async replacement bounds permanent Windows failures and preserves the old file', async t => {
  const { root, file } = fixture(t);
  const rename = fs.promises.rename.bind(fs.promises);
  const failure = Object.assign(new Error('persistent permission failure'), { code: 'EPERM' });
  let attempts = 0;
  t.mock.method(fs.promises, 'rename', async (from: fs.PathLike, to: fs.PathLike) => {
    if (to !== file) return rename(from, to);
    attempts++;
    assert.equal(fs.readFileSync(file, 'utf8'), 'previous contents');
    throw failure;
  });
  await assert.rejects(atomicWriteAsync(file, 'replacement contents'), error => error === failure);
  assert.ok(attempts > 1 && attempts <= 8, 'Transient-error retries must have a small finite bound');
  assert.equal(fs.readFileSync(file, 'utf8'), 'previous contents');
  assert.deepEqual(fs.readdirSync(root), ['latest.json'], 'Failed writes must remove their temporary file');
});

for (const { platform, code } of [{ platform: 'win32', code: 'ENOSPC' }, { platform: 'linux', code: 'EPERM' }]) {
  test(`atomic async replacement immediately rejects ${platform} ${code}`, async t => {
    const { root, file } = fixture(t, platform);
    const rename = fs.promises.rename.bind(fs.promises);
    const failure = Object.assign(new Error('not a retryable Windows sharing failure'), { code });
    let attempts = 0;
    t.mock.method(fs.promises, 'rename', async (from: fs.PathLike, to: fs.PathLike) => {
      if (to !== file) return rename(from, to);
      attempts++;
      throw failure;
    });
    await assert.rejects(atomicWriteAsync(file, 'replacement contents'), error => error === failure);
    assert.equal(attempts, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), 'previous contents');
    assert.deepEqual(fs.readdirSync(root), ['latest.json']);
  });
}
