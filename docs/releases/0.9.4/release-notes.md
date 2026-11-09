# Papilot 0.9.4

## Review one PDF note at a time

Select a sent note to focus its changes without losing the surrounding PDF. The bottom drawer compares the main proposal with prepared alternatives and their brief explanations. Switch to LaTeX to inspect the source, accept the selected wording, reject the note's edits, or draft a comment.

Rejecting a note restores its original source immediately through the undoable review journal. Other notes' changes stay intact. Alternative PDF previews are prepared and cached, so opening an existing choice does not start another AI request.

## Choose how many alternatives to prepare

In **Settings → Review preferences**, one compact slider offers **Off**, **Few (1–2)**, **Balanced (2–3)** and **More (3–5)**. Counts exclude the main proposal and are approximate. The choice applies to future editing requests; turning preparation off keeps existing review alternatives available.

## Smoother reviews and setup

- AI PDF review preparation keeps the server responsive during expensive PDF work.
- Keyboard switching works while saved notes animate, and interrupted view animations recover cleanly.
- Embedded alternative previews preserve the workspace language and translated page labels.
- Switching between manuscripts and tasks cancels pending PDF loads cleanly.
- Before/After labels fit short PDF changes.
- Startup tool detection and platform installation guidance are clearer.
- Failed attachment uploads remove partial files, and oversized update downloads stop early.
- The website adds an illustrated multilingual blog and a visible reset button for the interactive demo.

## Upgrading from 0.9.2

This release also includes the 0.9.3 changes: complete PDF comparisons for Beamer slides and documents without sections, shared manuscript and review PDF controls, and OpenCode reasoning effort discovery.

Papilot is now a **single-user workspace**. Sharing settings, member invitations, passkey sign-in, paper access permissions and the separate public account server have been removed. Upgrading preserves papers, tasks, conversations, notes and the host's preferences, while removing old accounts, invitations and sessions. Previous collaborators can no longer sign in through that setup. Personal Tailscale access remains available.

## Get 0.9.4

- **Windows x64:** installer and portable executable in the assets below.
- **macOS:** Apple Silicon and Intel installers in the assets below.
- **Linux x64:** AppImage and Debian/Ubuntu packages in the assets below.
- **CLI:** `npm install -g papilot@0.9.4` (Node.js 22.22+).

Existing desktop users can check **Settings → Updates** for a compatible in-place update or the matching installer. Compiling your own papers requires Git and a TeX distribution; AI tasks use your connected agent.

[Detailed changelog](https://github.com/PapilotAI/papilot/blob/v0.9.4/CHANGELOG.md) · [All changes since 0.9.2](https://github.com/PapilotAI/papilot/compare/v0.9.2...v0.9.4)
