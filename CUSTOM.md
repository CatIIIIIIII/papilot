# Ning’s Papilot Preview

Personal distribution: **0.9.0-preview.16**, branch `custom/ning-preview`.

Based on official Papilot 0.9.0 and upstream main as of 2026-11-06, including the merged editing-network feature (#54). Integrates paper Q&A with saved conversations (#38), aligned PDF comparison (#40), and the compact reasoning slider (#37). The official note editing/deletion feature (#36) is retained.

The app is named **Papilot Preview** and continues using `~/Library/Application Support/Papilot Preview`. It can coexist with official Papilot. Official automatic updates are disabled for this distribution so they cannot replace its custom features. Paper Q&A retains the existing full-access behavior for the selected paper; editing tasks retain their workspace sandbox and network access.

## Build on Apple Silicon

Use the official 0.9.0 mac-arm64 app as the runtime base, with the dependencies in the lockfiles available in the source tree. Build the source:

```sh
npm run build
npm --prefix engine run build
npm run desktop:compile
python3 scripts/build-custom-preview.py --base-app /path/to/Papilot.app --output /path/to/preview-output
PAPILOT_PREVIEW_EXECUTABLE="/path/to/preview-output/Papilot Preview.app/Contents/MacOS/Papilot" node scripts/check-custom-preview.mjs
```

The packaging script preserves official Electron/Node/native dependencies, copies the newly built source and frontend, and applies local ad-hoc signing. It compares copied source contents directly; it does not run digest verification. This is a personal preview, not an official or notarized Papilot release.

## Updating

Merge upstream main into this branch, resolve conflicts while preserving the custom features, run the relevant tests, then rebuild against the matching official runtime. Quit the running preview before replacing the app. Keep the Preview application name and data path to preserve existing local history.

## Editing permissions (Preview.11)

The revision composer now has a **Task permissions** selector for Codex, Claude and GLM. New tasks default to workspace access with networking. Full access disables the task sandbox and command approvals, allowing authorized SSH and access outside the paper. SSH still requires working credentials and remote authorization. Permission choices are stored with each task. Pause an active task before changing its permissions; the next turn resumes the same conversation with the new policy. AI review follows the official policy and does not use this editing permission selector, and providers without this support do not show the selector.

Diff backgrounds follow the PDF appearance setting, so a light PDF keeps light comparison colors even when the application uses the dark theme.

Claude streaming and final replies share the original text block identity even after thinking blocks. Existing unfinished duplicate copies are hidden in the conversation view without changing stored history.

Desktop launches prefer Claude's executable native user installation over legacy PATH installations. Explicit PAPILOT_CLAUDE_BIN overrides and Nix environments retain their existing selection.
