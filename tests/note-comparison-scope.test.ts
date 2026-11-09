import test from 'node:test';
import assert from 'node:assert/strict';
import { noteComparisonCrop, noteComparisonScope } from '../src/web/note-comparison-scope.ts';
import type { ChangeBlock, RoundDetail, Strip } from '../engine/src/types.ts';

test('only the current group appears, with native context and shared units but no empty PDF rows', () => {
  const image = { src: 'strip.svg', clean: 'clean.svg', width: 600, height: 30, page: 1, label: '1' } as Strip;
  const block = (ids: string[], visible = true): ChangeBlock => ({ kind: 'change', units: ids, identical: !visible, before: visible ? [image] : [], after: visible ? [image] : [] });
  const context = { kind: 'context' as const, image };
  const focused = block(['one', 'shared']), other = block(['other']), whitespace = block(['space'], false);
  const detail = { units: ['one', 'shared', 'other', 'space'].map(id => ({ id })), sections: [{ node: 'intro', title: 'Intro', number: '1', blocks: [other, context, focused, context] }], loose: [whitespace] } as RoundDetail;
  const scoped = noteComparisonScope(detail, ['one', 'space']);
  assert.deepEqual(scoped.sections[0].blocks, [context, focused, context]);
  assert.deepEqual(scoped.loose, []);
  assert.deepEqual(scoped.units.map(unit => unit.id), ['one', 'shared', 'space']);
  assert.deepEqual(noteComparisonScope(detail, ['restored-to-original']).sections, []);
  assert.equal(detail.sections[0].blocks.length, 4, 'The main review is unchanged');
});

test('shared PDF groups open at the selected note, excluding unrelated strips and source edits', () => {
  const image = (unit: string, y: number): Strip => ({ src: unit + '.png', clean: unit + '-clean.png', width: 600, height: 800, page: 1, label: '1', marks: [{ kind: 'added', unit, rect: [100, y, 300, y + 10] }] });
  const first = image('one', 20), shared = { ...image('two', 400), marks: [...image('two', 400).marks!, ...image('three', 700).marks!] };
  const group: ChangeBlock = { kind: 'change', units: ['one', 'two', 'three'], identical: false, before: [first, shared], after: [first, shared] };
  const moved: ChangeBlock = { ...group, before: [], after: [{ ...first, marks: [] }] };
  const detail = { units: ['one', 'two', 'three'].map(id => ({ id })), sections: [], loose: [group, moved] } as unknown as RoundDetail;
  const scoped = noteComparisonScope(detail, ['two']);
  assert.deepEqual(scoped.units.map(unit => unit.id), ['two']);
  assert.deepEqual(scoped.loose, [{ ...group, units: ['two'], before: [shared], after: [shared] }]);
  assert.deepEqual(noteComparisonCrop(shared, ['two']), { top: 376, height: 58 });
  assert.deepEqual(noteComparisonCrop(shared, ['three']), { top: 676, height: 58 });
  assert.equal(group.after.length, 2, 'The main review retains its complete group');
});

test('focused crops retain whole intersecting lines and legacy strips without marks', () => {
  const image: Strip = { src: 'a.png', clean: 'b.png', width: 600, height: 800, page: 1, label: '1', marks: [{ kind: 'removed', unit: 'one', rect: [100, 100, 200, 110] }], text: [
    { text: 'preceding', chars: [{ text: 'preceding', rect: [100, 70, 200, 80] }] },
    { text: 'following', chars: [{ text: 'following', rect: [100, 130, 200, 140] }] },
  ] };
  assert.deepEqual(noteComparisonCrop(image, ['one']), { top: 70, height: 70 });
  assert.deepEqual(noteComparisonCrop({ ...image, marks: undefined }, ['one']), { top: 0, height: 800 });
});
