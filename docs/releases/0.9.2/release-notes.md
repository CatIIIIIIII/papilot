# Papilot 0.9.2 — Faster previews and a live demo

## Try the paper workflow without installing anything

Open the [live demo](https://papilot.ai/demo/) to annotate a PDF, explore prepared editing tasks, compare typeset changes, read AI review suggestions and try version management. It uses Papilot's application interface with prepared content; no LaTeX installation or agent sign-in is required. Notes and preferences stay in your browser. Download Papilot to work on your own papers and send custom requests to an agent.

## Keep unchanged PDFs ready across days

An unchanged paper no longer recompiles simply because the calendar date changed. Manual recompilation still refreshes the preview, and successful refreshes remain preferred even after older cache entries are evicted. Task reviews and uncommitted-change comparisons use one fixed date for the baseline and revision, including comparisons that cross midnight.

## Switch tasks without reaching for the sidebar

Hold **Ctrl** and press the **grave-accent key (`)** to choose between the current paper's manuscript and tasks in recently visited order. Release Ctrl to switch, add Shift to move backwards, or press Escape to cancel. Mouse navigation updates the same order. Open PDF annotation editors protect their drafts, and a slow save cannot override a newer destination.

The shortcut uses Ctrl on macOS too, since Command + grave accent belongs to the system's window switching.

## Get 0.9.2

- **Windows x64:** installer and portable executable in the assets below.
- **macOS:** Apple Silicon and Intel installers in the assets below.
- **Linux x64:** AppImage and Debian/Ubuntu packages in the assets below.
- **CLI:** `npm install -g papilot@0.9.2` (Node.js 22.22+).

Existing desktop users can check **Settings → Updates** for a compatible in-place update or the matching installer. Compiling your own papers requires Git and a TeX distribution; AI tasks use your connected agent.

[Detailed changelog](https://github.com/PapilotAI/papilot/blob/v0.9.2/CHANGELOG.md) · [All changes since 0.9.1](https://github.com/PapilotAI/papilot/compare/v0.9.1...v0.9.2)
