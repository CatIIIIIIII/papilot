import assert from 'node:assert/strict';
import test from 'node:test';
import { keyBinding, parseShortcuts, reservedBinding, resolveShortcuts, shortcutAction } from '../engine/src/web/shortcuts.ts';

const key = (key: string, modifiers: Partial<KeyboardEvent> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...modifiers });
test('review shortcuts replace all old aliases, support modifiers, and can be cleared', () => {
  const shortcuts = resolveShortcuts({ next: ['Shift+b'], accept: [] });
  assert.equal(shortcutAction(key('B', { shiftKey: true }), shortcuts), 'next');
  for (const name of ['b', 'j', 'ArrowRight', 'a']) assert.equal(shortcutAction(key(name), shortcuts), undefined);
  assert.equal(shortcutAction(key('k'), shortcuts), 'previous');
  assert.equal(shortcutAction(key('?', { shiftKey: true }), shortcuts), 'help');
  assert.equal(shortcutAction(key('r', { isComposing: true }), shortcuts), undefined);
  assert.equal(keyBinding(key('Shift', { shiftKey: true })), null);
});
test('invalid saved bindings fall back without breaking the other preferences', () => {
  const shortcuts = parseShortcuts(JSON.stringify({ accept: ['Meta+w'], next: ['b'], previous: 3 }));
  assert.deepEqual(shortcuts.accept, ['a']);
  assert.deepEqual(shortcuts.next, ['b']);
  assert.deepEqual(shortcuts.previous, ['k', 'ArrowLeft']);
  assert.deepEqual(parseShortcuts('broken'), resolveShortcuts({}));
});
test('browser navigation, native undo and text editing cannot be reassigned', () => {
  for (const value of ['Ctrl+z', 'Meta+z', 'Meta+Shift+z', 'Ctrl+c', 'Ctrl+r', 'Meta+w', 'Escape', 'Enter', 'Tab', 'Alt+ArrowLeft']) assert.equal(reservedBinding(value), true, value);
  for (const value of ['a', 'Shift+a', 'Alt+b', 'Ctrl+b', '?', 'ArrowRight']) assert.equal(reservedBinding(value), false, value);
});
