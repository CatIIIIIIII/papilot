# Papilot 0.10.0

## Jump from the PDF to its LaTeX

Pick **Edit source** (E) in the marking tools, then click a passage or drag over text. Its file opens in a code editor in a tab beside New task, scrolled to the passage: the clicked lines are highlighted and the word you picked is marked. Bars beside the line numbers show what changed since the last commit.

Press **⌘S** to save. Papilot writes the file and compiles the manuscript, without an agent. The new PDF and the editor flash the saved lines; if the paper no longer compiles, the tab lists the errors on their lines and the last PDF stays.

The jump works both ways in a review. Picking a change in **Changes** opens its lines in the editor, and moving to a changed line in the editor shows its change. A passage edited since the PDF was compiled is followed into the current file. A save is refused if the file changed on disk while you typed, and unsaved drafts are kept.

## Review without waiting for TeX

Accepting or rejecting a change takes effect at once, and the next comparison is already loaded. Each decision compiles the paper as decided in the background, the next decision replaces that build, and unchanged work is reused. The PDF shows the decided paper, or the previous one while it compiles, and nothing locks meanwhile.

While the agent edits, Papilot already compiles and renders the round it will publish, so the comparison is ready when the turn ends. Background builds also run at full speed now: on Apple silicon, background priority had moved them to efficiency cores and made each pass about four times slower.

## Papilot on a phone

On phones the paper fills the screen under a slim translucent bar. The PDF and review toolbars fit on one row, the marking tools float in a bottom bar that a swipe collapses, and My notes, agent settings and menus open as bottom sheets. Decisions made on an iPhone survive locking the phone or switching apps.

## Also in this release

- **The manuscript PDF stays during task reviews**, and tasks open with the review and chat side by side.
- **Simpler Version Management and Add a paper dialogs.**
- **A much smaller desktop installer** that uses the Codex installed on the computer, and quicker streaming with a long history.
- **Codex:** Refresh restarts Codex when another Codex on the computer signed in again, instead of every task failing until Papilot restarts. Workspace tasks start on Windows.
- **DeepSeek** tasks offer sandboxed editing or bypass permissions. **Antigravity** tasks no longer fail after an API error that agy recovered from.
- **Tasks that fix a compilation error can be reviewed**, with the errors listed above the changes.
- Changes are located more precisely, notes around an edited LaTeX environment stay separate, and slow requests no longer time out while the server is still working.

## Upgrading from 0.9.4

- **Desktop app: Codex must be installed on the computer.** The app no longer includes its own Codex. If you use Codex and have not installed it yourself, install Codex 0.164.0 or newer, then open **Settings → Runtime → Agents** and select **Reconnect**. The `papilot` command still installs Codex when none is found.
- **Paper settings move into `.git/papilot`.** The first time 0.10.0 opens a paper, its settings, tasks, reviews and compiled PDFs move there; review shortcuts, preferences and drafts carry over. The `.latex-review.json` in your repository is no longer read and can be deleted. Once 0.10.0 has opened a paper, an older Papilot cannot work with its tasks, so update every Papilot that opens the same papers.
- **Tasks from Papilot 0.1–0.6** that wrote accepted changes straight into the manuscript still open, but can no longer be applied.
- **Papilot 0.8.2 or earlier** cannot update itself to this version. Reinstall once with `npm install -g papilot@latest`.
- The standalone review skill and its command line are retired; the review engine now serves only Papilot.

## Get 0.10.0

- **Windows x64:** installer and portable executable in the assets below.
- **macOS:** Apple Silicon and Intel installers in the assets below.
- **Linux x64:** AppImage and Debian/Ubuntu packages in the assets below.
- **CLI:** `npm install -g papilot@0.10.0` (Node.js 22.22+).

Existing desktop users can check **Settings → Updates** for a compatible in-place update or the matching installer. Compiling your own papers requires Git and a TeX distribution; AI tasks use your connected agent.

Thanks to @jiangsy for continuous note review with a single compile of the final selection, and for faster CI with cached TeX, and to @CatIIIIIIII for DeepSeek task permissions.

[Detailed changelog](https://github.com/PapilotAI/papilot/blob/v0.10.0/CHANGELOG.md) · [All changes since 0.9.4](https://github.com/PapilotAI/papilot/compare/v0.9.4...v0.10.0)
