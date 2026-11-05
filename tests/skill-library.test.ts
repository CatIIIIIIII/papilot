import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillLibrary } from '../src/server/skill-library.ts';
import { loadSkills } from '../src/server/skills.ts';
import { skillRoots } from '../src/server/skills.ts';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-library-'));
  const roots = { builtin: path.join(root, 'builtin'), user: path.join(root, 'user') }, paper = path.join(root, 'paper');
  const write = (file: string, content: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
  write(path.join(roots.builtin, 'polish.md'), '---\nname: Polish\norder: 1\n---\nBuilt-in instructions.');
  fs.mkdirSync(paper);
  return { root, roots, paper, write, library: new SkillLibrary(roots), close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('global skills live in the user home independently of the workspace data directory', () => {
  assert.equal(skillRoots.user, path.join(os.homedir(), '.papilot', 'skills'));
});

test('skills saved from the library are available to composers with paper > global > built-in priority', () => {
  const f = fixture();
  try {
    const content = '---\nname: 我的润色\ndescription: 保留数学术语\nicon: book\ncustom-field: keep this\n---\n\nImprove the prose.\n';
    const global = f.library.save('user', 'polish', content, undefined, f.paper);
    assert.equal(global.location, path.join(f.roots.user, 'polish', 'SKILL.md'));
    assert.equal(fs.readFileSync(global.location, 'utf8'), content);
    assert.equal(global.content, content);
    assert.equal(global.icon, 'book');
    assert.equal(f.library.read('user', 'polish').icon, 'book');
    assert.equal(f.library.list().skills.find(skill => skill.source === 'user')?.icon, 'book');
    assert.equal(loadSkills(f.paper, f.roots)[0].icon, 'book');
    assert.equal(loadSkills(f.paper, f.roots)[0].source, 'user');
    const paper = f.library.save('paper', 'polish', 'Paper-specific instructions.', undefined, f.paper);
    const listed = f.library.list(f.paper);
    assert.deepEqual(listed.skills.map(skill => [skill.source, skill.active]), [['user', false], ['paper', true], ['builtin', false]]);
    assert.equal(listed.locations.paper, path.join(f.paper, '.papilot', 'skills'));
    assert.equal(loadSkills(f.paper, f.roots)[0].source, 'paper');
    assert.equal(f.library.list().skills.find(skill => skill.source === 'user')?.active, true);
    f.library.remove('paper', 'polish', paper.revision, f.paper);
    assert.equal(loadSkills(f.paper, f.roots)[0].body, 'Improve the prose.');
    f.library.remove('user', 'polish', global.revision);
    assert.equal(loadSkills(f.paper, f.roots)[0].source, 'builtin');
  } finally { f.close(); }
});

test('editing preserves legacy file locations and deleting a skill keeps its supporting files', () => {
  const f = fixture();
  try {
    const legacy = path.join(f.roots.user, 'legacy.md'); f.write(legacy, 'Original.');
    const read = f.library.read('user', 'legacy');
    const saved = f.library.save('user', 'legacy', 'Changed.\n', read.revision);
    assert.equal(saved.location, legacy);
    assert.equal(fs.existsSync(path.join(f.roots.user, 'legacy')), false);
    const bundled = f.library.save('user', 'bundle', 'Read references.md.', undefined);
    const reference = path.join(f.roots.user, 'bundle', 'references.md'); f.write(reference, 'Keep me.');
    f.library.remove('user', 'bundle', bundled.revision);
    assert.equal(fs.existsSync(bundled.location), false);
    assert.equal(fs.readFileSync(reference, 'utf8'), 'Keep me.');
  } finally { f.close(); }
});

test('stale updates, stale deletes and duplicate creates cannot overwrite external work', () => {
  const f = fixture();
  try {
    const saved = f.library.save('user', 'custom', 'Original.', undefined);
    f.write(saved.location, 'External edit.');
    for (const operation of [() => f.library.save('user', 'custom', 'Lost update.', saved.revision), () => f.library.remove('user', 'custom', saved.revision), () => f.library.save('user', 'custom', 'Duplicate.', undefined)]) assert.throws(operation, { statusCode: 409 });
    assert.equal(fs.readFileSync(saved.location, 'utf8'), 'External edit.');
    const current = f.library.read('user', 'custom');
    fs.unlinkSync(saved.location);
    assert.throws(() => f.library.save('user', 'custom', 'Recreated.', current.revision), { statusCode: 409 });
    assert.equal(fs.existsSync(saved.location), false);
  } finally { f.close(); }
});

test('skill writes validate identifiers, content and scope, and built-ins stay read-only', () => {
  const f = fixture();
  try {
    for (const id of ['../escape', '/absolute', 'a/b', '', 'CAPS', 'a'.repeat(49)]) assert.throws(() => f.library.save('user', id, 'Instructions.', undefined));
    for (const content of ['', '  ', '---\nname: Empty\n---\n', 'x\0y', 123]) assert.throws(() => f.library.save('user', 'custom', content, undefined));
    assert.throws(() => f.library.save('builtin', 'polish', 'Replace.', undefined), { statusCode: 403 });
    assert.throws(() => f.library.remove('builtin', 'polish', 'anything'), { statusCode: 403 });
    assert.throws(() => f.library.save('paper', 'custom', 'Instructions.', undefined));
    assert.throws(() => f.library.save('invalid', 'custom', 'Instructions.', undefined));
    assert.equal(fs.readFileSync(path.join(f.roots.builtin, 'polish.md'), 'utf8').includes('Built-in instructions.'), true);
  } finally { f.close(); }
});

test('paper skills cannot write through symlinked directories, files or hard links', () => {
  const f = fixture();
  try {
    const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(f.paper, '.papilot'));
    assert.throws(() => f.library.save('paper', 'escape', 'Escaped.', undefined, f.paper), /Linked/);
    assert.deepEqual(fs.readdirSync(outside), []);
    fs.unlinkSync(path.join(f.paper, '.papilot'));
    const saved = f.library.save('paper', 'custom', 'Original.', undefined, f.paper);
    const target = path.join(outside, 'target.md'); f.write(target, 'Untouched.');
    fs.unlinkSync(saved.location); fs.symlinkSync(target, saved.location);
    assert.throws(() => f.library.read('paper', 'custom', f.paper), /Linked/);
    assert.throws(() => f.library.save('paper', 'custom', 'Changed.', saved.revision, f.paper), /Linked/);
    assert.equal(f.library.list(f.paper).skills.some(skill => skill.source === 'paper'), false);
    fs.unlinkSync(saved.location); fs.linkSync(target, saved.location);
    assert.throws(() => f.library.remove('paper', 'custom', saved.revision, f.paper), /Linked/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'Untouched.');
  } finally { f.close(); }
});


test('long skills are saved, loaded and passed to the agent without truncation', () => {
  const f = fixture();
  try {
    const content = 'Follow the author’s review instructions. '.repeat(1000) + 'FINAL INSTRUCTION';
    const saved = f.library.save('user', 'long-review', content, undefined);
    assert.equal(saved.content, content);
    assert.equal(f.library.read('user', 'long-review').content, content);
    assert.equal(loadSkills(undefined, f.roots).find(skill => skill.id === 'long-review')?.body, content);
  } finally { f.close(); }
});
