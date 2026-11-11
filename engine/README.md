# Papilot review engine

<p><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>

The review engine behind Papilot. For each task it keeps a Git worktree of the agent's edits, compiles the accepted text and the proposal with `latexmk`, and serves the PDF comparison in which the author accepts, rejects or comments on each change. Accepted edits merge into the working tree without creating a commit.

Papilot starts one engine per repository through `src/client.ts` (`src/cli.ts serve`) and talks to it over HTTP on 127.0.0.1. It is not installed or used on its own.

[Reference](docs/reference.md) · [Tests and corpus](docs/corpus.md) · [MIT License](LICENSE)
