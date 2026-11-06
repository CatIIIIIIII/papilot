# Papilot 0.9.1 — Windows Desktop

Papilot is now available on **Windows**, alongside macOS and Linux. Open a LaTeX paper, mark what needs attention on its PDF, and review the agent's typeset changes before saving them to your manuscript.

## Windows, with your choice of environment

Download the **Windows x64 installer** or **portable app** from this release. The desktop app bundles Node.js, npm and Codex. Its setup screen recommends **WSL** and lets you choose either native Windows or a Linux distribution, checks the tools that environment needs, and guides you through missing dependencies.

Use your Windows Git, TeX and agent installations, or keep them inside WSL while using the same desktop window. Switch environments in **Settings → General → Environment**; each keeps its own papers, tasks and agent sign-ins. The included example PDF is readable before Git or TeX is installed.

Windows installers are unsigned. See the [Windows setup guide](https://github.com/PapilotAI/papilot/blob/v0.9.1/docs/windows.md) for prerequisites, WSL preparation and installation details.

## Mark up proposed changes directly in Review

Review now has the PDF's collapsible **Tools** rail: Magic pen, colored notes, region marks, sticky notes, deletion marks, Select, Hand, Undo and Redo. Marks join your feedback draft and keep their original review round and location. Send a deletion without adding a comment, or write replacement text. Mouse, keyboard and touch controls work throughout.

PDF comparisons preserve reading order across lines and columns, moved content and faint colored ink. Selection menus stay visible, Find keeps precise selections, and review controls fit narrow panes. Review colors can follow the PDF or be chosen separately from the interface.

## Less waiting, clearer setup and permissions

- Chapter reviews reuse compatible baseline files across days and show live compilation progress to every waiting task. Incompatible cached auxiliary files are rebuilt once before retrying.
- Missing Git and LaTeX tools get installation guidance and a **Check again** action. The example paper's edits and notes survive Git setup.
- The model menu exposes each agent's native permission modes. Changes apply to the next turn while preserving the conversation.
- Claude replies no longer repeat after thinking blocks. Windows and WSL fixes cover paths, command wrappers, process cleanup and update rollback.

## Get 0.9.1

- **Windows x64:** [Installer](https://github.com/PapilotAI/papilot/releases/download/v0.9.1/Papilot-0.9.1-win-x64.exe) · [Portable app](https://github.com/PapilotAI/papilot/releases/download/v0.9.1/Papilot-0.9.1-win-x64-portable.exe)
- **macOS:** Apple Silicon and Intel installers in the assets below.
- **Linux x64:** AppImage and Debian/Ubuntu packages in the assets below.
- **CLI:** `npm install -g papilot@0.9.1` (Node.js 22.22+).

Compiling papers requires Git and a TeX distribution in the selected environment, plus your agent sign-in for AI tasks. Existing desktop users can check **Settings → Updates**; Papilot offers an in-place update when compatible, or the matching installer when needed.

Thanks to [@kilbertert](https://github.com/kilbertert) for the native Windows contribution, and [@CatIIIIIIII](https://github.com/CatIIIIIIII) for task permissions, review appearance and the Claude reply fix.

[Detailed changelog](https://github.com/PapilotAI/papilot/blob/v0.9.1/CHANGELOG.md) · [All changes since 0.9.0](https://github.com/PapilotAI/papilot/compare/v0.9.0...v0.9.1)
