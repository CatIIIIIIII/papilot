import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGitDiff } from '../src/web/git-diff.ts';

test('source diffs keep original and current line numbers through separate changes and hunks', () => {
  const diff = parseGitDiff('diff --git a/main.tex b/main.tex\n--- a/main.tex\n+++ b/main.tex\n@@ -6,4 +6,5 @@ Results\n Context\n-Old\n+New\n+Added\n Middle\n-Last\n+Better\n@@ -100 +101 @@\n-Previous\n+Current\n\\ No newline at end of file\n');
  assert.deepEqual(diff.changes, [2, 6, 9]);
  assert.deepEqual([diff.added, diff.deleted], [4, 3]);
  assert.deepEqual(diff.lines.slice(1, 6).map(line => [line.kind, line.before, line.after]), [
    ['context', 6, 6], ['del', 7, undefined], ['add', undefined, 7], ['add', undefined, 8], ['context', 8, 9],
  ]);
  assert.equal(diff.lines[9].before, 100);
  assert.equal(diff.lines[10].after, 101);
  assert.equal(diff.lines[11].kind, 'note');
});

test('new, deleted, binary and long files retain every returned change', () => {
  assert.deepEqual(parseGitDiff('@@ -0,0 +1 @@\n+New\n').lines[1], { kind: 'add', text: 'New', after: 1 });
  assert.deepEqual(parseGitDiff('@@ -1 +0,0 @@\n-Old\n').lines[1], { kind: 'del', text: 'Old', before: 1 });
  assert.equal(parseGitDiff('Binary files a/image.png and b/image.png differ\n').lines[0].kind, 'note');
  const long = parseGitDiff('@@ -0,0 +1,10000 @@\n' + Array.from({ length: 10000 }, (_, i) => `+Line ${i + 1}\n`).join(''));
  assert.equal(long.lines.length, 10001);
  assert.equal(long.added, 10000);
  assert.equal(long.lines.at(-1)?.after, 10000);
});

test('file-type changes reset at each patch boundary without treating headers as code', () => {
  const diff = parseGitDiff('diff --git a/a.tex b/a.tex\ndeleted file mode 100644\n--- a/a.tex\n+++ /dev/null\n@@ -1 +0,0 @@\n-regular file\ndiff --git a/a.tex b/a.tex\nnew file mode 120000\n--- /dev/null\n+++ b/a.tex\n@@ -0,0 +1 @@\n+b.tex\n\\ No newline at end of file\n');
  assert.deepEqual(diff.lines.filter(line => line.kind === 'add' || line.kind === 'del'), [
    { kind: 'del', text: 'regular file', before: 1 }, { kind: 'add', text: 'b.tex', after: 1 },
  ]);
  assert.deepEqual([diff.added, diff.deleted, diff.changes], [1, 1, [1, 3]]);
  const headersInCode = parseGitDiff('@@ -1 +1 @@\n--- original source\n+++ revised source\n');
  assert.deepEqual(headersInCode.lines.slice(1).map(line => line.text), ['-- original source', '++ revised source']);
});
