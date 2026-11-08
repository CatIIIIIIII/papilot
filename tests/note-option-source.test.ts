import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RoundDetail, Unit } from '../engine/src/types.ts';
import { NoteOptionSource } from '../src/web/note-option-diff.tsx';

const unit = (id: string, old_text: string, new_text: string): Unit => ({ id, file: 'main.tex', kind: 'text', status: 'modified', whole_file: false, truncated: false, ops: [], old_start: 10, old_end: 10, new_start: 10, new_end: 10, old_text, new_text });
const candidate = (text: string) => ({ after: text, units: [unit('focused', 'fast', text), unit('unrelated', 'three', 'five')] }) as RoundDetail;
const render = (detail: RoundDetail) => renderToStaticMarkup(createElement(NoteOptionSource, { detail, focus: ['focused'] }));

test('LaTeX comparison uses the selected candidate and retains every other source edit without highlighting it', () => {
  const html = render(candidate('\\emph{computationally efficient}'));
  assert.match(html, /main\.tex/);
  assert.match(html, /10 → 10/);
  assert.match(html, /<del>fast<\/del>/);
  assert.match(html, /<ins>\\emph\{computationally efficient\}<\/ins>/);
  const unrelated = html.slice(html.indexOf('data-unit="unrelated"'));
  assert.match(unrelated, />three<\/pre>/);
  assert.match(unrelated, />five<\/pre>/);
  assert.doesNotMatch(unrelated, /<(?:ins|del)>/);
});

test('switching alternatives replaces source content without mutating the previous candidate', () => {
  const original = candidate('efficient'), alternate = candidate('quick');
  assert.match(render(original), /<ins>efficient<\/ins>/);
  assert.match(render(alternate), /<ins>quick<\/ins>/);
  assert.doesNotMatch(render(alternate), /efficient/);
  assert.equal(original.units[0].new_text, 'efficient');
});

test('insertions and deletions show an anchor line instead of a reversed empty range', () => {
  for (const change of [
    { ...unit('focused', '', 'inserted'), old_end: 9 },
    { ...unit('focused', 'deleted', ''), new_end: 9 },
  ]) {
    const html = render({ ...candidate(''), units: [change] });
    assert.match(html, /10 → 10/);
    assert.doesNotMatch(html, /10–9/);
  }
});
