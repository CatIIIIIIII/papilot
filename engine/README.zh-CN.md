# Papilot 审阅引擎

<p><a href="README.md">English</a> · <strong>简体中文</strong></p>

Papilot 背后的审阅引擎。它为每个任务保存一个包含 agent 修改的 Git worktree，用 `latexmk` 分别编译已接受的文本和修改提案，并提供 PDF 对比页面，作者在其中逐处接受、拒绝或评论。接受的修改会合并到工作区，不会创建提交。

Papilot 通过 `src/client.ts`（`src/cli.ts serve`）为每个仓库启动一个引擎，并在 127.0.0.1 上通过 HTTP 与它通信。它不单独安装或使用。

[技术参考](docs/reference.md) · [测试与语料](docs/corpus.md) · [MIT 许可证](LICENSE)
