// Real multi-chapter compilation in a disposable repository. No agent calls
// or changes to the user's manuscript, application profile or review state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Fixture, METHOD } from '../engine/tests/ts/helpers.ts';
import { Builder } from '../engine/src/core/build.ts';
import { previewNoteOption } from '../engine/src/core/option-preview.ts';
import { noteComparisonScope } from '../src/web/note-comparison-scope.ts';

const f = new Fixture();
f.write('paper/main.tex', String.raw`\documentclass{book}
\begin{document}
\include{sections/method}
\include{sections/results}
\include{sections/conclusion}
\end{document}
`);
f.write(METHOD, String.raw`\chapter{Method}
A small example.

\[\begin{array}{c}x = 1\end{array}\]

The model is fast and the estimates are stable. The surrounding context remains here.

\begin{enumerate}
\item First check.
\item Second check.
\end{enumerate}

The surrounding discussion stays unchanged. It separates the independent observations below.

We evaluate the model on three datasets. This is a different note.
`);
f.write('paper/sections/results.tex', '\\chapter{Results}\n' + 'Unchanged results and their explanation.\n\n'.repeat(120));
f.write('paper/sections/conclusion.tex', '\\chapter{Conclusion}\nThe conclusion remains unchanged.\n');
f.repo.run(['add', '.']); f.repo.run(['commit', '-qm', 'Multi-chapter option fixture']);
const app = f.app(); await app.ready;
let appClosed = false;
const task = app.tasks.create('options', 'Prepared note options', [], ['paper'], true);
const source = f.read(METHOD);
f.edit(task, METHOD, 'fast', 'efficient');
f.edit(task, METHOD, 'three', 'five');
f.edit(task, METHOD, 'small', 'short');
f.edit(task, METHOD, 'x = 1', 'x = 2');
f.edit(task, METHOD, '\\begin{enumerate}\n\\item First check.\n\\item Second check.\n\\end{enumerate}', 'First check.\nSecond check.');
const originalBuild = Builder.prototype.build, builds = [];
Builder.prototype.build = function (rev, targets, seed, options) {
  builds.push({ rev, targets });
  return originalBuild.call(this, rev, targets, seed, options);
};
try {
  app.publisher.submit(task.name); await app.publisher.join();
  assert.equal(app.publisher.current(task.name)?.status, 'done', JSON.stringify(app.publisher.current(task.name)));
  const round = app.review.latestRound(task.name);
  assert.deepEqual(round.summary.targets, ['sections/method']);
  const selected = round.units.find(unit => unit.new_text === 'efficient');
  assert.ok(selected);
  const choices = ['quick', 'computationally efficient'].map((text, i) => ({ id: 'option-' + i, round: round.number, edits: [{ unit: selected.id, text }] }));
  const results = [], started = performance.now();
  builds.length = 0;
  for (const choice of choices) results.push(await previewNoteOption(app, task.name, choice));
  const preparationMs = Math.round(performance.now() - started);
  assert.equal(builds.length, 2, 'Only the two candidate PDFs compile; the baseline is reused');
  assert.ok(builds.every(build => JSON.stringify(build.targets) === '["sections/method"]'), 'No whole-document compilation for options');
  const first = results[0], scope = noteComparisonScope(first, [selected.id]);
  assert.ok(scope.sections.length || scope.loose.length);
  assert.ok(scope.units.every(unit => unit.new_text !== 'five'), 'The other note’s separate group stays outside the drawer: ' + JSON.stringify(scope.units.map(unit => [unit.id, unit.new_text])));
  assert.ok(scope.units.every(unit => unit.new_text !== 'short'), 'The leading edit does not appear in every note’s alternatives');
  assert.equal(results[0].units.find(unit => unit.id === selected.id).new_text, 'quick');
  assert.equal(results[1].units.find(unit => unit.id === selected.id).new_text, 'computationally efficient');
  assert.ok(first.units.some(unit => unit.new_text === 'five'), 'The complete candidate still preserves the other edit');
  const paths = results.map(detail => path.join(app.state, 'cache', detail.files.replace('/option-files/', 'option-previews/'), 'preview.json'));
  assert.ok(paths.every(file => fs.existsSync(file)), 'Both manifests persist on disk');
  const beforeRead = performance.now();
  const currentTime = process.env.SOURCE_DATE_EPOCH;
  process.env.SOURCE_DATE_EPOCH = '1893542400';
  try {
    for (let i = 0; i < choices.length; i++) assert.equal((await previewNoteOption(app, task.name, choices[i])).files, results[i].files);
    await app.close();
    appClosed = true;
    const reopened = f.app(); await reopened.ready;
    for (let i = 0; i < choices.length; i++) assert.equal((await previewNoteOption(reopened, task.name, choices[i])).files, results[i].files);
  } finally {
    if (currentTime === undefined) delete process.env.SOURCE_DATE_EPOCH; else process.env.SOURCE_DATE_EPOCH = currentTime;
  }
  assert.equal(builds.length, 2, 'Clicks, date changes and an engine restart never compile again');
  assert.equal(f.read(METHOD), source);
  assert.match(f.read(METHOD, task.worktree), /efficient/);
  console.log(JSON.stringify({ preparationMs, cachedReadsAndRestartMs: Math.round(performance.now() - beforeRead), candidateBuilds: builds.length, targets: round.summary.targets }));
  console.log('PASS: real chapter PDFs prepared once, disk cache survives restart/date changes, native context and current-group-only scope, source untouched.');
} finally {
  Builder.prototype.build = originalBuild;
  // app was closed to test recovery; do not close its SQLite handle twice.
  if (appClosed) f.apps = f.apps.filter(candidate => candidate !== app);
  await f.close();
}
