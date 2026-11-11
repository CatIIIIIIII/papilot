import test from 'node:test';
import assert from 'node:assert/strict';
import { findPicked, lineSpan, readable } from '../src/web/source-match.ts';

const source = String.raw`A task proposes a \emph{revision} $E = \{e_1, \dots, e_m\}$, a finite set
of edits against the same base document. % a remark about the base
Each review round groups nearby edits into \emph{changes}, the unit the author decides on.
`;
const picked = (range: [number, number] | null) => range && source.slice(range[0], range[1]);

test('the letters of LaTeX skip commands, comments and markup and keep their places', () => {
  const { letters, at } = readable(source, 0, source.length);
  assert.ok(letters.startsWith('ataskproposesarevision'));
  assert.ok(!letters.includes('emph') && !letters.includes('remark') && !letters.includes('dots'));
  assert.equal(source[at[letters.indexOf('revision')]], 'r');
});

test('a selection on the PDF is found in its source, through markup and line breaks', () => {
  const all: [number, number] = [0, source.length];
  assert.equal(picked(findPicked(source, all, { quote: 'changes' })), 'changes');
  assert.equal(picked(findPicked(source, all, { quote: 'same base document.' })), 'same base document');
  assert.equal(picked(findPicked(source, all, { quote: 'finite set of edits' })), 'finite set\nof edits', 'across a source line break');
  assert.equal(picked(findPicked(source, all, { quote: 'compat-' })), null, 'text that is not there is not guessed');
  // A long selection whose formula prints differently matches by its ends.
  assert.equal(picked(findPicked(source, all, { quote: 'A task proposes a revision E = {e1, . . . , em}, a finite set' })),
    String.raw`A task proposes a \emph{revision} $E = \{e_1, \dots, e_m\}$, a finite set`);
});

test('a clicked word is found by the words before it on its line', () => {
  const all: [number, number] = [0, source.length];
  // "edits" occurs twice; the words before the click say which.
  const second = findPicked(source, all, { quote: '', word: { text: 'edits', context: 'Each review round groups nearby' } })!;
  assert.equal(source.slice(second[0], second[1]), 'edits');
  assert.ok(second[0] > source.indexOf('nearby'));
  const first = findPicked(source, all, { quote: '', word: { text: 'edits', context: 'of' } })!;
  assert.ok(first[0] < source.indexOf('nearby'));
  assert.equal(picked(findPicked(source, lineSpan(source, [2, 3]), { quote: 'the' })), 'the', 'the search stays within the given lines');
});
