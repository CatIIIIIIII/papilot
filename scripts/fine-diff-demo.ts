// A real review round in a disposable paper, using the normal Papilot UI.
// Run with Node >= 22.22: npx tsx scripts/fine-diff-demo.ts
import fs from 'node:fs';
import path from 'node:path';
import { Repo } from '../engine/src/core/git.ts';
import { App } from '../engine/src/server.ts';
import { Store } from '../src/server/store.ts';
import { noteOptionsKey } from '../src/server/note-options.ts';
import { DATA } from '../src/server/paths.ts';

const root = path.join(DATA, 'fine-diff-paper');
if (fs.existsSync(root)) throw new Error(`Demo already exists at ${root}. Use a fresh PAPILOT_DATA directory to start again.`);
fs.mkdirSync(root, { recursive: true });
const source = String.raw`\documentclass{article}
\usepackage[margin=1in]{geometry}
\usepackage{hyperref}
\title{Independent revisions}
\author{Papilot}
\date{}
\begin{document}
\maketitle
\section{Evaluation}
We evaluate the method on three public datasets. The model is fast and the estimates are stable. The results are useful for practical deployments.

Each dataset contains a held-out evaluation set. We use the same protocol for every model and report the average across repeated runs.
\end{document}
`;
fs.writeFileSync(path.join(root, 'main.tex'), source);
fs.writeFileSync(path.join(root, '.gitignore'), '*.aux\n*.log\n*.out\n*.pdf\n*.synctex.gz\n*.fls\n*.fdb_latexmk\n');
const repo = new Repo(root);
repo.run(['init', '-q']);
repo.run(['add', '.']);
repo.run(['-c', 'user.name=Papilot Demo', '-c', 'user.email=demo@localhost', 'commit', '-qm', 'Original paragraph']);
const app = new App(root);
try {
  const task = app.tasks.create('fine-diff', '按批注聚焦修改', [], [], true);
  fs.writeFileSync(path.join(task.worktree, 'main.tex'), source.replace('three public', 'five public').replace('is fast', 'is efficient').replace('are stable', 'are robust').replace('are useful', 'are informative'));
  console.log('Compiling the real before/after PDFs…');
  const result = await app.publisher.publish({ id: 'fine-diff-demo', task: task.name });
  const round = app.review.latestRound(task.name)!;
  const store = new Store(path.join(DATA, 'papilot.sqlite'));
  try {
    store.saveProject({ id: 'fine-diff-paper', name: 'Note-focused review', path: root, createdAt: Date.now() });
    store.saveTask({ id: 'fine-diff', projectId: 'fine-diff-paper', name: task.name, title: task.title, titleSource: 'manual',
      instructions: '点击 Note 1 或 Note 2，只高亮相关修改；Note 3 演示共享修改。' , worktree: task.worktree, deferred: true,
      threadId: null, turnId: null, agent: 'codex', model: null, status: 'reviewing', createdAt: Date.now(), updatedAt: Date.now(), feedbackCursor: 0, error: null,
      review: { state: 'reviewing', round: round.number, counts: { pending: round.units.length }, unsent: 0, comments: 0, files: ['main.tex'] } });
    const notes = [
      { quote: 'The model is fast', comment: '改进速度的措辞，给我几个表达选择。' },
      { quote: 'the estimates are stable', comment: '把稳定性的表达写得更自然。' },
      { quote: 'The model is fast and the estimates are stable.', comment: '这两个描述也一起检查，保持语气一致。' },
    ].map(note => ({ ...note, where: 'Page 1 · main.tex line 10', anchor: { sources: [{ file: 'main.tex', lines: [10, 10] as [number, number] }] } }));
    store.saveRun({ id: 'demo-notes', taskId: 'fine-diff', requestKey: 'demo-notes', prompt: 'Improve the annotations.', status: 'completed', createdAt: Date.now(), finishedAt: Date.now(), reviewRound: round.number });
    store.saveItem({ id: 'demo-notes', taskId: 'fine-diff', type: 'user', text: '请按下面的批注修改，提供备选表达。', meta: { notes }, createdAt: Date.now() });
    const speed = round.units.find(unit => unit.new_text === 'efficient')!, stability = round.units.find(unit => unit.new_text === 'robust')!;
    if (!speed || !stability) throw new Error('Demo units were not located.');
    const alternatives = [
      [[speed.id, 'quick'], [speed.id, 'computationally efficient']],
      [[stability.id, 'reliable'], [stability.id, 'numerically stable']],
    ];
    const reasons = [
      ['用更短的 quick，直接描述模型的速度。', '用 computationally efficient 明确强调计算效率。'],
      ['用常见的 reliable，让结果的描述更自然。', '用 numerically stable 明确指向数值稳定性。'],
      ['用 quick 和 reliable 统一为简短、直接的描述。', '分别明确计算效率和数值稳定性，让两处表述更具体。'],
    ];
    for (let index = 0; index < 3; index++) {
      const key = `demo-notes:${index}`;
      store.savePreference(noteOptionsKey('fine-diff', key, round.number), { round: round.number, key, options: [0, 1].map(choice => ({ id: `demo-${index}-${choice}`, label: choice === 0 ? '简洁表达' : '更具体', reason: reasons[index][choice], edits: (index === 2 ? [alternatives[0][choice], alternatives[1][choice]] : [alternatives[index][choice]]).map(([unit, text]) => ({ unit, text })) })) });
    }
  } finally { store.close(); }
  console.log(JSON.stringify({ data: DATA, root, result, edits: round.units.map(u => ({ id: u.id, before: u.old_text, after: u.new_text })) }, null, 2));
} finally { await app.close(); }
