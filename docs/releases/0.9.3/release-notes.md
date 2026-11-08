# Papilot 0.9.3

## Review complete slides, even without sections

Beamer decks and papers without section headings now show their PDF comparisons instead of falling back to source-only review. Slides keep their complete layout, including titles, artwork and columns, so you can judge the typeset result as a whole.

Comparisons preserve the correct before-and-after pages when an agent inserts text, deletes a slide, edits an included file or uses a custom frame wrapper. Literal TeX examples no longer interfere with frame discovery, and changes across multiple source files follow the PDF's page order.

## Use the same PDF controls throughout the workspace

Task reviews now share the manuscript's contents, page navigation, zoom and search controls. Each reader remembers its own position and zoom. Open searches are restored when the PDF updates, and Fit page includes expanded inline changes. Review actions and change numbers also remain usable in narrow panes.

## Choose OpenCode reasoning effort before starting a task

Reasoning effort choices are discovered for the selected model, including models other than OpenCode's default. Changing models retries stale responses and checks that OpenCode confirmed the selection before continuing.

## Upgrade note: Papilot is now a single-user workspace

This release removes multi-user collaboration: Sharing settings, member invitations, passkey sign-in, paper access permissions and the separate public account server.

Upgrading preserves existing papers, tasks, conversations, notes and the host's preferences. Old accounts, invitations and sessions are removed. If you previously shared a workspace, collaborators can no longer sign in through that setup. Personal access through Tailscale remains available.

## Get 0.9.3

- **Windows x64:** installer and portable executable in the assets below.
- **macOS:** Apple Silicon and Intel installers in the assets below.
- **Linux x64:** AppImage and Debian/Ubuntu packages in the assets below.
- **CLI:** `npm install -g papilot@0.9.3` (Node.js 22.22+).

Existing desktop users can check **Settings → Updates** for a compatible in-place update or the matching installer. Compiling your own papers requires Git and a TeX distribution; AI tasks use your connected agent.

[Detailed changelog](https://github.com/PapilotAI/papilot/blob/v0.9.3/CHANGELOG.md) · [All changes since 0.9.2](https://github.com/PapilotAI/papilot/compare/v0.9.2...v0.9.3)
