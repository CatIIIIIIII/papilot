import { expect, it } from 'vitest';
import { groupFormattingChanges } from '../../src/core/formatting-changes.ts';
import type { ChangeBlock, RoundDetail } from '../../src/types.ts';

function fixture(old: string, next: string, format: [number, number, string, string]): RoundDetail {
  const unit = (id: string, start: number, end: number, old_text: string, new_text: string) => ({ id, file: 'main.tex', status: 'modified' as const, kind: 'text' as const, whole_file: false, truncated: false, old_start: 1, old_end: 2, new_start: 1, new_end: 2, old_text, new_text, ops: [], text_ops: [['replace', start, end, start, start + new_text.length] as ["replace", number, number, number, number]] });
  const at = old.indexOf('fast');
  const block = (id: string, identical: boolean): ChangeBlock => ({ kind: 'change', units: [id], identical, before: [], after: [] });
  return { task: 'task', round: 1, before: old, after: next, files: '', warnings: [], units: [unit('word', at, at + 4, 'fast', 'efficient'), unit('space', ...format)],
    sections: [{ node: 'intro', number: '1', title: 'Intro', blocks: [block('word', false)] }], loose: [block('space', true)] };
}

it('folds existing invisible wrap cards into a nearby prose card without losing exact units or mutating the saved round', () => {
  const old = 'The model is fast and\nthe result is stable.\n', at = old.indexOf('\n');
  // Rewrap this one interior break; preserve the file's final newline.
  const next = old.slice(0, at).replace('fast', 'efficient') + ' ' + old.slice(at + 1);
  const detail = fixture(old, next, [at, at + 1, '\n', ' ']);
  const grouped = groupFormattingChanges(detail, () => old);
  expect(grouped.loose).toEqual([]);
  expect((grouped.sections[0].blocks[0] as ChangeBlock).units).toEqual(['word', 'space']);
  expect(grouped.units.map(({ formattingFor, ...unit }) => unit)).toEqual(detail.units);
  expect(grouped.units[1].formattingFor).toBe('word');
  expect(detail.loose).toHaveLength(1);
  expect((detail.sections[0].blocks[0] as ChangeBlock).units).toEqual(['word']);
});

it('retains paragraph changes, whitespace-sensitive source and formatting without a related edit', () => {
  for (const old of ['The model is fast.\n\nAnother\nparagraph.\n', '\\begin{verbatim}\nThe model is fast and\nthe result is stable.\n\\end{verbatim}\n']) {
    const at = old.indexOf('\n', old.indexOf('Another') >= 0 ? old.indexOf('Another') : old.indexOf('fast'));
    const detail = fixture(old, old, [at, at + 1, '\n', ' ']);
    expect(groupFormattingChanges(detail, () => old).loose).toHaveLength(1);
  }
  const old = 'The model is fast and\nthe result is stable.\n', at = old.indexOf('\n');
  expect(groupFormattingChanges(fixture(old, old, [at, at + 1, '\n', '\n\n']), () => old).loose).toHaveLength(1);
  const alone = fixture(old, old, [at, at + 1, '\n', ' ']); alone.sections = [];
  expect(groupFormattingChanges(alone, () => old).loose).toHaveLength(1);
});
