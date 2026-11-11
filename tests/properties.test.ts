// Laws of pure functions, checked on generated inputs. A failure prints its
// seed and the smallest input that breaks the law; replay it with
// fc.assert(..., { seed, path }).
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { notesInstructions, readNotesInstructions } from '../src/notes.ts';
import { NOTE_GROUPS } from '../src/note-groups.ts';
import type { Annotation, GitGraphCommit } from '../src/shared.ts';
import { taskCaptionFrom } from '../src/task-caption.ts';
import { setSkillInstructions, setSkillMetadata, skillInstructions, skillMetadata } from '../src/skill-metadata.ts';
import { graphRows } from '../src/web/git-graph.ts';

// Author-written text: any characters, plus the line breaks, list markers and
// labels that could be mistaken for the message's own structure.
const prose = fc.array(fc.oneof(
  fc.string({ unit: 'grapheme', maxLength: 6 }),
  fc.constantFrom('\n', '\n\n', '2. ', '   ', 'Note: ', 'PDF text: "', '"', '·', '```', '\\emph{x}', '标题'),
), { maxLength: 8 }).map(parts => parts.join(''));
const quote = fc.array(fc.oneof(fc.string({ unit: 'grapheme', maxLength: 6 }), fc.constantFrom('\n', '"', '·', '‸')), { maxLength: 6 }).map(parts => parts.join(''));
const note = fc.record({
  page: fc.nat({ max: 400 }),
  quote,
  comment: prose,
  source: fc.option(fc.record({
    file: fc.constantFrom('main.tex', 'chapters/intro.tex', 'figures.tex'),
    lines: fc.tuple(fc.integer({ min: 1, max: 900 }), fc.nat({ max: 20 })).map(([start, length]): [number, number] => [start, start + length]),
    excerpt: fc.option(prose, { nil: undefined }),
  }), { nil: null }),
  kind: fc.constantFrom(undefined, 'delete', 'point'),
  group: fc.constantFrom(undefined, ...NOTE_GROUPS),
  stamp: fc.constantFrom(undefined, 'Tighten', 'Line break', 'Verify this claim'),
}).map(({ kind, group, stamp, ...rest }): Annotation => ({
  id: 'note', projectId: 'paper', key: 'pdf', rect: [0, 0, 1, 1], createdAt: 1, ...rest,
  ...(kind ? { kind } : {}), ...(group ? { group } : {}), ...(stamp ? { stamp } : {}),
}));

test('the chat reads back every PDF note from the message that carried it', () => {
  fc.assert(fc.property(fc.array(note, { minLength: 1, maxLength: 5 }), notes => {
    const read = readNotesInstructions(notesInstructions(notes));
    assert.ok(read, 'the message is recognized as PDF notes');
    assert.deepEqual(read.map(({ kind, group, stamp, quote, comment }) => ({ kind, group, stamp, quote, comment })), notes.map(note => ({
      kind: note.kind, group: note.group, stamp: note.stamp,
      quote: note.kind !== 'point' && !note.quote ? '' : note.quote,
      comment: note.comment.trim(),
    })));
  }));
});

test('any other message is not mistaken for PDF notes', () => {
  fc.assert(fc.property(prose, text => assert.equal(readNotesInstructions(text), null)));
});

test('a task title is one trimmed line of at most 80 characters', () => {
  const reply = fc.array(fc.oneof(fc.string({ unit: 'grapheme', maxLength: 12 }), fc.constantFrom('Title: ', '标题：', '"', '“', '”', '**', '#', ' ', '.', '。', '😀')), { maxLength: 30 }).map(parts => parts.join(''));
  fc.assert(fc.property(reply, value => {
    let title: string;
    try { title = taskCaptionFrom(value); } catch { return; }
    assert.ok([...title].length <= 80, title);
    assert.equal(title, title.trim());
    assert.doesNotMatch(title, /[\r\n]/);
    assert.doesNotMatch(title, /\s{2}/);
    if (!/[\uD800-\uDFFF]/.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))) assert.doesNotMatch(title.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''), /[\uD800-\uDFFF]/, 'no half of a character');
  }));
});

// A skill file: optional BOM, either line ending, an optional header of
// single-line fields, and instructions that do not start a header.
const skill = fc.record({
  bom: fc.boolean(),
  newline: fc.constantFrom('\n', '\r\n'),
  fields: fc.option(fc.dictionary(fc.constantFrom('name', 'description', 'icon', 'license', 'model'), fc.string({ maxLength: 20 }).map(value => value.replace(/[\r\n]/g, ' ')), { maxKeys: 4 }), { nil: null }),
  body: prose.filter(body => !body.startsWith('---')),
}).map(({ bom, newline, fields, body }) => {
  const header = fields ? `---${newline}${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(newline)}${newline}---${newline}` : '';
  return (bom ? '﻿' : '') + header + body.replace(/\n/g, newline);
});

// Values pasted into the editor: any characters, including line breaks and
// the Unicode line and paragraph separators.
const fieldValue = fc.array(fc.oneof(fc.string({ unit: 'grapheme', maxLength: 8 }), fc.constantFrom('\n', '\r\n', '\u2028', '\u2029', '"', '\\', ': ')), { maxLength: 6 }).map(parts => parts.join(''));

test('editing a skill field changes only that field', () => {
  fc.assert(fc.property(skill, fc.constantFrom('name', 'description') as fc.Arbitrary<'name' | 'description'>, fieldValue, (content, field, value) => {
    const edited = setSkillMetadata(content, field, value);
    assert.equal(skillMetadata(edited)[field], value.replace(/[\r\n\u2028\u2029]/g, ' '));
    const { [field]: _, ...others } = skillMetadata(content), { [field]: __, ...kept } = skillMetadata(edited);
    assert.deepEqual(kept, others);
    // A new header is followed by a blank line before the instructions.
    assert.equal(skillInstructions(edited).replace(skillInstructions(content) === skillInstructions(edited) ? '' : /^\r?\n/, ''), skillInstructions(content));
    assert.equal(edited.startsWith('﻿'), content.startsWith('﻿'));
    assert.equal(setSkillMetadata(edited, field, value), edited);
  }));
});

test('editing a skill\'s instructions keeps its header', () => {
  fc.assert(fc.property(skill, prose, (content, body) => {
    const edited = setSkillInstructions(content, body);
    assert.deepEqual(skillMetadata(edited), skillMetadata(content));
    if (skillInstructions(content) !== content.replace(/^﻿/, '') || !body.startsWith('---')) assert.equal(skillInstructions(edited), body);
  }));
});

// History as git log lists it: every commit before its parents, which are
// older commits or outside the listed range.
const history = fc.array(fc.tuple(fc.nat(), fc.nat(), fc.nat({ max: 2 }), fc.boolean()), { minLength: 1, maxLength: 25 }).map(specs => specs.map(([a, b, count, outside], index): GitGraphCommit => {
  const older = specs.length - index - 1, pick = (n: number) => `c${index + 1 + (n % Math.max(older, 1))}`;
  const parents = older ? [...new Set([pick(a), pick(b)].slice(0, count))] : outside && count ? ['outside'] : [];
  return { hash: `c${index}`, parents, subject: '', author: '', date: 1, refs: [] };
}));

test('every commit graph edge stays in its lanes and reaches its parent', () => {
  fc.assert(fc.property(history, commits => {
    const { rows, lanes } = graphRows(commits);
    for (const [index, row] of rows.entries()) {
      assert.ok(row.lane >= 0 && row.lane < lanes);
      assert.equal(row.incoming, commits.slice(0, index).some(commit => commit.parents.includes(row.commit.hash)));
      for (const edge of row.edges) assert.ok(edge.from >= 0 && edge.from < lanes && edge.to >= 0 && edge.to < lanes);
      for (const [parentIndex, parent] of row.commit.parents.entries()) {
        let lane = row.edges.filter(edge => edge.parent)[parentIndex].to;
        for (const following of rows.slice(index + 1)) {
          if (following.commit.hash === parent) { assert.equal(following.lane, lane); break; }
          const continuation = following.edges.find(edge => !edge.parent && edge.from === lane);
          assert.ok(continuation, `the edge to ${parent} continues through ${following.commit.hash}`);
          lane = continuation.to;
        }
      }
    }
  }));
});
