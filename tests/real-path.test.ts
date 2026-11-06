import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathIdentity, realPath } from '../src/server/real-path.ts';

test('path identities resolve junctions and missing worktrees without folding case', () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-path-')));
  try {
    const root = path.join(base, 'Paper'), alias = path.join(base, 'Alias'); fs.mkdirSync(root);
    fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(realPath(alias), root);
    assert.equal(pathIdentity(path.join(alias, 'Missing', 'worktree')), path.join(root, 'Missing', 'worktree'));
    assert.notEqual(pathIdentity(path.join(root, 'Missing')), pathIdentity(path.join(root, 'missing')), 'Missing names must not be blindly lowercased');
    if (!fs.existsSync(path.join(base, 'paper'))) {
      fs.mkdirSync(path.join(base, 'paper'));
      assert.notEqual(realPath(root), realPath(path.join(base, 'paper')), 'Distinct case-sensitive directories retain their identity');
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('Windows native identity agrees across drive and directory casing', { skip: process.platform !== 'win32' }, () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'Papilot MixedCase ')));
  try {
    const lowerDrive = root[0].toLowerCase() + root.slice(1), upper = root.toUpperCase();
    for (const alias of [lowerDrive, upper]) {
      assert.equal(realPath(alias), root);
      assert.equal(pathIdentity(path.join(alias, 'Removed', 'checkout')), path.join(root, 'Removed', 'checkout'));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
