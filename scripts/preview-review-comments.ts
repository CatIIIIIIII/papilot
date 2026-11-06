// Seed an isolated, real review for trying the unified commenting UI.
// Run once with `node --import tsx scripts/preview-review-comments.ts`, then npm start.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DATA } from '../src/server/paths.ts';
import { Store } from '../src/server/store.ts';
import { App } from '../engine/src/server.ts';

fs.mkdirSync(DATA, { recursive: true });
const root = path.join(DATA, 'review-trial-paper');
const store = new Store(path.join(DATA, 'papilot.sqlite'));
if (store.tasks().some(task => task.id === 'review-comments-trial')) {
  console.log('The review trial already exists.'); store.close(); process.exit(0);
}
fs.mkdirSync(root, { recursive: true });
const original = String.raw`\documentclass[11pt]{article}
\usepackage[T1]{fontenc}
\usepackage{mathpazo}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath}
\title{Execution and Static Typing}
\author{Review interaction trial}
\date{}
\begin{document}
\maketitle
\section{From execution to types}
An operational semantics gives a precise account of what happens when a program runs:
how functions receive arguments, how intermediate results pass from one call to the next,
and where a computation would fail if incompatible values met.
Static typing follows the same structure without running the program,
using type annotations to verify that each call produces what the next call expects.
We can see how execution and static checking fit together in a small Scala program:
\begin{verbatim}
def twice(x: Int, f: Int => Int): Int = f(f(x))
\end{verbatim}
The function applies its argument twice. In the first call, the input is an integer.
The result is passed to the second call, which expects an integer as well.
\section{Local reasoning}
A local type checker checks each expression using information available nearby.
This makes error messages easy to connect to the source program.
The programmer can inspect the relevant expression without reconstructing an entire derivation.
\section{A useful boundary}
The annotation records the contract between the caller and the function.
It lets us reason about a call without inspecting every step of the function body.
The execution and typing accounts therefore describe the same computation from two perspectives.
\end{document}
`;
fs.writeFileSync(path.join(root, 'main.tex'), original);
fs.writeFileSync(path.join(root, '.latex-review.json'), JSON.stringify({ main: 'main.tex', engine: 'pdflatex' }));
fs.writeFileSync(path.join(root, '.gitignore'), '*.aux\n*.log\n*.pdf\n*.out\n*.fls\n*.fdb_latexmk\n*.synctex.gz\n');
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]);
git('init', '-q'); git('add', '.'); git('-c', 'user.name=Papilot Trial', '-c', 'user.email=trial@localhost', 'commit', '-qm', 'Add review trial paper');
const engine = new App(root); await engine.ready;
try {
  const task = engine.tasks.create('comment-trial', '体验词句评论与统一发送', [], [], true);
  const proposed = original.replace('incompatible values met', 'a value did not match the expected input')
    .replace('The function applies its argument twice.', 'The function composes its argument with itself.')
    .replace('This makes error messages easy to connect to the source program.', 'Consequently, diagnostics can identify the relevant source expression.');
  fs.writeFileSync(path.join(task.worktree, 'main.tex'), proposed);
  engine.publisher.submit(task.name); await engine.publisher.join();
  const summary = engine.review.summary(task.name);
  if (!summary.round) throw new Error(JSON.stringify(engine.publisher.current(task.name)));
  const at = Date.now();
  store.saveProject({ id: 'review-trial-paper', name: '审阅交互试验', path: root, createdAt: at });
  store.saveTask({ id: 'review-comments-trial', projectId: 'review-trial-paper', name: task.name, title: task.title, instructions: 'Improve the wording while preserving the technical meaning. Work only in this isolated trial paper.', worktree: task.worktree, deferred: true, threadId: null, turnId: null, agent: 'codex', model: null, status: 'reviewing', createdAt: at, updatedAt: at, feedbackCursor: 0, error: null, review: { state: summary.state, round: summary.round, counts: summary.counts, unsent: 0, comments: 0, files: [] } });
  store.saveItem({ id: 'trial-intro', taskId: 'review-comments-trial', type: 'assistant', text: '这里准备了几处措辞修改，可以直接体验：\n\n- 在修改前或修改后的 PDF 中划选几个词，点击「评论」。\n- 在右侧引用卡片里写意见，可以连续添加多条。\n- 也可以点击整处修改的「评论」，走同一个入口。\n- 最后通过聊天框的发送箭头，一次发送全部意见。\n\n这是一份独立的示例论文；发送后会调用你选择的智能体继续修改。', createdAt: at });
  console.log(`Trial ready: ${root} (${summary.counts.pending} changes)`);
} finally { await engine.close(); store.close(); }
