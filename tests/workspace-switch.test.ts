import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceModifier, workspaceOrder, workspaceSwitchKey } from '../src/web/workspace-switch.ts';

test('workspace switching visits recent destinations before unvisited tasks and drops stale entries', () => {
  assert.deepEqual(workspaceOrder(['', 'a', 'b', 'new'], ['b', '', 'deleted', 'a'], 'a'), ['a', 'b', '', 'new']);
  assert.deepEqual(workspaceOrder(['', 'a', 'b'], ['a', 'b', ''], ''), ['', 'a', 'b']);
  assert.deepEqual(workspaceOrder(['', 'a'], ['a', ''], null), ['a', '']);
  assert.deepEqual(workspaceOrder([''], ['gone'], 'gone'), ['']);
});

test('workspace shortcut uses Control and leaves Command+Backquote to macOS', () => {
  assert.equal(workspaceModifier, 'Control');
  const key = { key: '`', code: 'Backquote', ctrlKey: true, metaKey: false, altKey: false, isComposing: false, keyCode: 192 };
  assert.equal(workspaceSwitchKey(key), true);
  assert.equal(workspaceSwitchKey({ ...key, key: '~' }), true);
  assert.equal(workspaceSwitchKey({ ...key, key: '§' }), true);
  for (const change of [{ ctrlKey: false }, { metaKey: true }, { ctrlKey: false, metaKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }, { key: 'Tab', code: 'Tab' }]) {
    assert.equal(workspaceSwitchKey({ ...key, ...change }), false);
  }
});
