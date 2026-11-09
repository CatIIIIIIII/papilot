import test from 'node:test';
import assert from 'node:assert/strict';
import { noteComparisonScope } from '../src/web/note-comparison-scope.ts';
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
