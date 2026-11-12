# Papilot 0.10.1

## Review a task's changes in the source editor

0.10.0 opened your own passages from the PDF in a source editor. 0.10.1 brings the agent's changes there too; this part was meant to ship in 0.10.0.

In a task's review, LaTeX on a change opens its whole file in the source editor, in a tab beside the chat, at that change. The round's changes show in the text as the review's cards: each has a header with its title and Accept, Reject and Comment, then the lines before, with struck words marked, over the lines after. The buttons decide through the review itself, and moving through changes in the editor or in the review keeps the other in step.

Edit the agent's proposal right there and press **⌘S**. The file is saved into the task and reviewed again in a new round, where the review keeps its place.

When the editor opens from the PDF, the passage stays highlighted on the PDF too, until you start typing.

On phones and in the online demo, for an earlier round, and for changes the editor cannot show (a new file, a bibliography entry, a file with CRLF line endings), LaTeX still shows inline in the review.

## Also in this release

- **Drag the desktop window from any toolbar.** Empty toolbar space over a task's changes now moves the window, as it does elsewhere, while the review's buttons still take clicks. Toolbars side by side now share one height, so their lines meet.
- **A source save too large to read back is refused before writing.** Text within the character limit could exceed the file limit once encoded, as Chinese text or CRLF line endings do; the file was written, yet the save was reported as failed on every retry.

## Upgrading

Nothing changes in how papers, tasks or settings are stored. Coming from 0.9.4 or earlier, read the [0.10.0 notes](https://github.com/PapilotAI/papilot/releases/tag/v0.10.0) first: the desktop app needs Codex installed on the computer, and paper settings move into `.git/papilot`.

## Get 0.10.1

- **Windows x64:** installer and portable executable in the assets below.
- **macOS:** Apple Silicon and Intel installers in the assets below.
- **Linux x64:** AppImage and Debian/Ubuntu packages in the assets below.
- **CLI:** `npm install -g papilot@0.10.1` (Node.js 22.22+).

Existing desktop users can check **Settings → Updates** for a compatible in-place update or the matching installer. Compiling your own papers requires Git and a TeX distribution; AI tasks use your connected agent.

[Detailed changelog](https://github.com/PapilotAI/papilot/blob/v0.10.1/CHANGELOG.md) · [All changes since 0.10.0](https://github.com/PapilotAI/papilot/compare/v0.10.0...v0.10.1)
