# Papilot 0.10.2

This patch fixes Windows window controls and MiKTeX compilation, improves recovery from LaTeX build failures, and distinguishes PDF-note questions from editing requests.

## What's fixed

- **Windows window buttons work with real mouse clicks.** Minimize, maximize/restore and close now respond correctly, including in compact windows and Version Management. Dragging the window from empty toolbar space still works.
- **MiKTeX compilation starts correctly.** On Windows, the latexmk launcher could lose quotes in Papilot's preview hooks and report a Perl syntax error before TeX ran. Foreground previews and background builds now load those hooks reliably, while preserving the paper's own configuration.
- **Ask about a passage without rewriting it.** A PDF note such as “Explain this content” now asks the agent to answer in chat without changing the manuscript. Editing remains the default for revision feedback; a message containing both questions and edit requests is handled accordingly.
- **Better recovery from compilation failures.** Compilation Problems can ask the selected agent to diagnose the error, test proposed build settings and keep settings that work. Builds handle nested output directories and missing TikZ checksum directories. If the original manuscript has no PDF, a repaired revision can still be reviewed and approved in the source.
- **Windows desktop Codex detection works with Volta-managed installations.** Codex starts from the user's home directory so it can resolve the installed runtime.

## Also in this release

- Continuing an older task moves it to the top of the sidebar, ordered by recent activity.
- Task PDFs stay tied to their published build.
- Updated Hono and Node server adapter dependencies.

## Upgrading

No data migration is required from 0.10.1. Existing desktop users can check **Settings → Updates** for a compatible in-place update or the matching installer.

## Get 0.10.2

- **Windows x64:** installer and portable executable in the assets below.
- **macOS:** Apple Silicon and Intel installers in the assets below.
- **Linux x64:** AppImage and Debian/Ubuntu packages in the assets below.
- **CLI:** `npm install -g papilot@0.10.2` (Node.js 22.22+).

Compiling your own papers requires Git and a TeX distribution; AI tasks use your connected agent.

Thanks to @HeeneFZ and @CatIIIIIIII for their contributions, and to @sourcexex, @nickmao1994 and @lnxlnxlnx for reporting these issues.

[Detailed changelog](https://github.com/PapilotAI/papilot/blob/v0.10.2/CHANGELOG.md) · [All changes since 0.10.1](https://github.com/PapilotAI/papilot/compare/v0.10.1...v0.10.2)
