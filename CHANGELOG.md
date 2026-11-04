# Changelog

Notable changes to Papilot, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.8.9] - 2026-11-04

Papilot 0.8.9 displays CJK text from PDFs whose fonts lack Unicode maps and removes the global two-task concurrency limit.

### Fixed

- **Tasks no longer wait for a global slot.** Papilot ran at most two tasks at a time, counted across all agents and papers, so a third task stayed queued with "Waiting for an available Codex session" even when that agent was idle. Connected, signed-in agents can now start every eligible queued task. Each task still waits for its own active turn, build, review work or delivery, and PDF builds retain their worker limit.
- **Chinese, Japanese and Korean text shows in the PDF view.** Text in fonts that a PDF embeds without a Unicode map, such as the Fandol fonts xeCJK uses by default, was blank in the manuscript and in a review's full paper, while the changes view showed it. Papilot now ships the character maps that pdf.js needs to read these fonts and loads only the one a PDF uses.

## [0.8.8] - 2026-11-04

Papilot 0.8.8 keeps conversations responsive, brings consistent choice lists and comment cards to the workspace, starts AI reviews without waiting for the manuscript preview, and introduces a redesigned website with interactive demos.

### Changed

- **Choices open Papilot's own list.** Theme, accent, language, notifications, update channel, PDF appearance and zoom, the default model, and the LaTeX engine, main file and skill location fields no longer open the system's picker. The list matches Papilot's menus in light and dark mode, marks the current choice, shows theme and accent colours beside their names, groups models by agent, and becomes a sheet on a phone. Arrow keys, Home, End, typed letters, Enter and Escape work as in a system list.
- **Conversations do less work while you type and wait.** Typing no longer renders the conversation again, unchanged replies keep their rendered Markdown, and a running task fetches only new or changed timeline items. Polls that find no changes leave the workspace alone, and the manuscript reuses its Git status while its files and Git state stay unchanged.
- **Review comments match the chat composer.** The comment card has a compact heading, a close button, a field that grows with its text and a round send button. It follows the workspace's light and dark themes and keeps touch-sized controls on a phone.
- **Try the review workflow on the website.** The redesigned landing page opens with an interactive review and shows three animated feature windows, with dark mode and eleven languages. Demo annotations stay aligned while you scroll or resize, and note cards and translated content fit inside the paper view on desktop and mobile.

### Fixed

- **Start an AI review while the preview is compiling.** AI review compiles and reads its own copy of the manuscript, so a stale, running or failed preview no longer prevents it from starting. If that copy cannot compile or be read, it is discarded so retrying after a fix uses the corrected manuscript. The request also allows time for a full compilation.

## [0.8.7] - 2026-11-03

Papilot 0.8.7 prepares the manuscript's PDF while you review, keeps long builds responsive, exports PDFs with notes and makes adding notes to a task feel like sending a message.

### Added

- **Export the PDF, with or without your notes.** The paper's Open PDF button is now a Share menu: open the PDF, export it, or export it with your notes. With notes, every highlight and marked region keeps its colour, and each comment sits in a numbered card in a margin beside the page, joined to its mark. Chinese, Japanese and Korean comments are included. The paper's text, links and bookmarks still work. When a page has more comments than its margin can hold, the cut-off ones are printed in full at the end of the PDF and linked to and from their cards.
- **Delete a finished task in one click.** Once a task's changes are in your manuscript, applied or committed, its review offers Delete beside Archive. It removes the task with its conversation and worktree right away, without asking first; the changes stay in your manuscript. On a narrow phone the two buttons move below the result instead of squeezing it.

### Changed

- **The manuscript's PDF is ready when you commit a task.** A reviewed task changes the manuscript only when you commit or apply it, and its PDF then compiled only once the manuscript was opened: one to four TeX passes, which on a 324-page paper took one and a half to three minutes. Papilot now compiles what committing the task will produce in the background, as soon as its round is ready and again after each decision, so the PDF is usually there the moment you commit: on that paper, 0.8 s after the commit instead of 94 s. Committing, applying a task, a Git action or a review decision starts the build right away, also when the manuscript is not open, and the PDF view updates as soon as a build starts or ends.
- **An edit shows after one TeX pass.** When an edit moves page numbers, references or the bibliography, LaTeX needs several passes. The manuscript now shows the pages of each pass as soon as the next one starts, so the edit appears after the first pass while the numbers settle, at the same place and zoom.
- **The PDF you are waiting for compiles first.** A compilation made ahead of time pauses while the manuscript you look at compiles, and on macOS drops to background priority while other TeX runs, so it takes little from your PDF or a review. When you start waiting for it, it gets full priority, and you see its passes. A build also continues from whichever recent build has the most similar sources, not only the newest one, so it keeps LaTeX's state from the closest version.
- **Papilot keeps responding while it compiles.** Neither Papilot nor the review engine waits for Git, the disk or a compiler while it compiles, so the task list, review page and PDF view stay responsive. After each build, moving your notes from the previous PDF searched every page's text in one go, which on a 324-page paper froze Papilot for about a second; it now lets other requests through between pages. On a 324-page paper the review engine stopped answering for over two seconds whenever a round was published, because each snapshot of the task rehashed all of its files twice, and for up to four seconds whenever a task was created, while its worktree was checked out; accepting a change, committing a task and removing a task also held it, for up to a quarter of a second. It now answers within a few tens of milliseconds throughout, and so does Papilot: from publishing a round to the committed manuscript's PDF, its event loop never waited more than 80 ms.
- **Review rounds are ready sooner.** A round compiles the text before and after the change at the same time, and so does the comparison of uncommitted changes.
- **The whole paper in a review shows at once.** A review shown in the whole paper waited, with only a timer on screen, until the complete new version had compiled, which on a 324-page paper took one to two and a half minutes after the round was ready. That build now starts as soon as the round starts compiling, not after it, and the review shows the round's own chapters with the changes in place right away, then each TeX pass of the whole paper, then the complete PDF, keeping the change you are looking at in place. On that paper the changes appeared 1.2–2.5 s after opening the review.
- **Adding a PDF note to a task works like sending a chat message.** A new note is one line that grows as you type, with a blue send arrow beside it like the chat box's; Enter sends it too. The note flies into the **New task** panel, or onto the **New task** tab when another panel is open, and its popover closes. A note already in the task shows **Included ×** at the bottom right, wherever it appears: in its popover, in **My notes** and in the **New task** panel. Clicking it takes the note back out, and the note flies back. **Clear selection** is now **Remove all from task**. Your own notes no longer show a separate close button; Escape or a click elsewhere closes them, and a new note shows its delete button once it has text.

### Fixed

- **A decided change no longer offers Accept, Reject and Comment.** In a task's review, a change that was already accepted or rejected, also after the task was applied, still showed buttons that did nothing. It now shows the way to the next undecided change, or that the review is complete; Undo changes a decision back.
- **Quitting the desktop app leaves nothing running.** After ⌘Q, the review server of each paper you had worked on kept running for up to 12 hours, so macOS listed Papilot under background activity. The desktop app now owns the review servers it starts, and they stop with it, even if it crashes. A PDF build that was still running is retried when you next open Papilot. In `ps` it is now called "Papilot review server" instead of `node`. Closing the window still keeps the app open, as on any Mac app.

## [0.8.6] - 2026-11-02

Papilot 0.8.6 compiles review builds of a chapter incrementally, so a commit no longer leaves several clean compilations running beside the manuscript's.

### Fixed

- **Review builds no longer recompile chapters from scratch.** A review compiles the changed chapters on their own (`\includeonly`), before and after the change. Those builds started clean every time: about three TeX passes and two BibTeX runs each, which on a thesis kept several compilations running for minutes after a commit and slowed the manuscript's own build. Now each set of chapters continues from its previous build, as full builds already did, and usually needs one pass. The other chapters' cross-references still come from the latest full build.

## [0.8.5] - 2026-11-02

Papilot 0.8.5 brings the Dev channel to the desktop app with small in-place updates, returns you to where you left off, recovers PDF comparisons after a lost connection and lays out the Git panel like Cursor's.

### Added

- **Dev channel and small in-place updates in the desktop app.** Settings → Updates in the desktop app now offers **Stable** and **Dev (GitHub main)**, like the web server. When a new version was built for the installer you have, **Update now** downloads only Papilot's own code, about 5 MB instead of a 330 MB installer, checks that it starts, and restarts when tasks and PDF builds are idle; if it does not start, the previous version and database are restored. A version that needs a newer Electron, Node, Codex or dependencies links to its installer. A nightly build of main is published to the `desktop-dev` prerelease when main has changed, with new installers only when the app shell changed.

### Fixed

- **A PDF whose word positions fail to load no longer freezes the tab.** Papilot falls back to the PDF's own text once instead of retrying forever, which also blocked reloading while a manuscript or review PDF was still opening.
- **Come back to where you left off.** Returning to the manuscript from a task, or to a task from anywhere, opens it where you were instead of at the top: the PDF on the same page and spot, the **PDF / Changes** choice, a task's chat scrolled back through its history, the review within its current change and its PDF / Changes view, an AI review's PDF and the reference check. A chat that was following the latest messages keeps following them. Places survive a reload.
- **Sandboxed Cursor tasks run again.** When Papilot had fetched the Cursor SDK on first use, every sandboxed Cursor run failed with "sandboxing is not supported in this environment", because the SDK could not find its sandbox helper. It finds it now, and the sandbox stays on.
- **Recover PDF comparisons after a lost connection.** Papilot retries brief connection failures, resumes saved builds after a restart, and offers **Check status** when the service remains unavailable. Completed comparisons are recovered without rerunning the agent. Build submissions are deduplicated across retries; a build interrupted by a review-service restart is retried once.

### Changed

- **A Git panel like Cursor's.** The panel now has three views that fold away. **Changes** starts with the commit message and **✓ Commit**, whose arrow also offers **Commit and push**, and lists **Staged changes** and **Changes** with each file's status letter. Hovering over a file shows **+** to stage, **−** to unstage, and an undo arrow that discards its unstaged changes after asking. **Commit graph** shows the history in single rows with branch, remote and tag badges and HEAD as an open circle; its header names the branch, how far it is ahead or behind, and fetch, pull and push. **Worktrees** lists the tasks' checkouts. The tick boxes, the build-output banner (now in the **⋯** menu) and the **Git details** section are gone.
- **Enter sends a PDF note to the chat.** In the note popover, Enter now saves the note and quotes it in the chat, as the arrow does. A note already in the chat just saves, and the note library keeps Enter for saving edits.
- **Notes fly back to My notes.** Clearing the selection or removing a note in the new-task panel sends the cards along an arc into **My notes**, which shows +N for a moment; on a phone they land on the PDF view button, and reduced motion skips the flight. The note library is tighter: the region note and **Add all to task** share a row, and each card's buttons sit beside its location.

## [0.8.4] - 2026-11-02

Papilot 0.8.4 opens folders in the desktop app the way an editor does, starts reviews on the changed sections and keeps the commit step in view.

### Changed

- **The desktop app opens folders like an editor.** **Open a folder** in the paper menu, or **File › Open Folder…** (⌘O), goes straight to the system folder picker, and the chosen folder opens as a paper. There is no import window to fill in: Papilot detects the main file and engine, prepares Git history when needed, and compiles the PDF in the paper's own view. Only a folder with several possible main files asks which one to compile, and a folder that is already a paper opens again. The desktop app no longer offers ZIP imports or typed folder paths, and **Edit paper** shows the paper's folder, with **Change…** to pick another.
- **Reviews open on the changed sections.** The whole paper takes longer to show, so reviews now start on **Changes**. **Settings → Review preferences → Open reviews on** chooses **PDF** instead, and the switch in the review toolbar changes only the review in front of you.
- **The commit step stays in view.** Once every change is decided, the card with Papilot's next step, such as the commit message and **Commit**, floats at the top of the review while you scroll, instead of a bar that only jumped back to it.
- **A calmer Updates page in the desktop app.** **Download desktop updates** appears only when a newer desktop release exists, as the main action beside its version. An up-to-date app shows just its status; **Papilot › Download Updates…** in the app menu still opens the releases page.

## [0.8.3] - 2026-11-02

### Added

- **Review changes in the whole paper.** The review opens on the full paper: the new PDF's pages, with each change shown in place as before, old lines above new, and accepted, rejected or commented on with the same controls. **Changes only** in the review toolbar switches back to the changed sections. Pages are drawn only near where you read, so a 300-page thesis scrolls like a short paper. Reviews rendered by earlier releases open in the whole paper too.
- **Compilation progress while adding a paper.** The import window shows LaTeX's current pass, the pages typeset so far against the paper's page count, and the elapsed time, so a long first compile no longer looks stuck.

### Changed

- **PDF comparisons of long papers in seconds.** Placing each change in the PDF used to parse the paper's whole SyncTeX file once per source line, which on a 324-page thesis meant 2,910 parses and six and a half minutes. The file is now read once per build and every lookup answered from its index, so the same comparison takes about 11 seconds, with identical results.
- **A tidier repository.** Translated READMEs live in `docs/readme/`, community policies in `.github/`, and requirements in `docs/`. Documentation links, the website and translation generators follow the new locations.

### Fixed

- **Separate desktop and web updates.** Desktop checks only published GitHub releases with an uploaded installer for the current OS and CPU, and links to that exact release. It always runs its bundled server, ignores legacy npm activation records, and keeps its update status separate from the web server. Existing desktop installers are directed to a new installer instead of installing future web packages. The web server retains its npm Stable and GitHub Dev channels, startup checks, idle restart and rollback.

## [0.8.2] - 2026-11-02

Papilot 0.8.2 opens local paper folders in place, compiles as fast as latexmk, updates the desktop app in place and speaks eleven languages.

### Added

- **Desktop updates in place.** Like Obsidian, the desktop app now installs newer Papilot releases itself instead of sending you to GitHub Releases. It downloads the release, checks that it starts, and restarts on it when tasks and PDF builds are idle; if it does not start, the previous version and database are restored. A new installer is needed only when a release changes what the app itself provides, and the update notice says so. Settings → Updates shows the installer version next to the running version.
- **Eleven interface languages.** The workspace, the review viewer and error messages read in English, Simplified Chinese, Traditional Chinese, Japanese, Korean, German, French, Spanish, Portuguese, Italian and Swedish. Papilot follows the browser's first supported language until you choose one in **Settings → Language**, and dates and numbers follow it. The website and README are available in the same languages. Prompts and note locations sent to agents stay in English.
- **Change the model during a task.** The model, reasoning effort and fast mode can be changed between turns of a task. Changes apply to the next turn; a turn already running keeps its settings.

### Changed

- **Open local paper folders in place.** In the desktop app, choose or drag in a folder and only its path is used: there are no upload size or file count limits, and existing configuration and main files are detected without scanning caches or reference material. Importing keeps the author's `.latex-review.json` unchanged unless the main file or engine changes. ZIP imports still create a separate copy.
- **Compilation as fast as latexmk in the paper's folder.** Each build continues from the previous one: unchanged files are cloned, latexmk keeps its auxiliary state and decides what to rerun, and a change to a file TeX does not read finishes in about two seconds without running TeX. On a 240 MB thesis, an edit now takes one XeLaTeX pass instead of a five-pass clean build, and opening or importing a paper continues from the author's own latexmk output when present. Working-tree snapshots rehash only changed files, large figures stream to disk, and opening a newly imported paper no longer compiles it again. **Recompile PDF** starts clean, and a build broken by leftover auxiliary files retries clean automatically. See [Compilation performance](docs/performance.md).
- Collapsing the manuscript panel puts its expand button at the far right of the PDF toolbar and hides **Open PDF** until the panel returns.

## [0.8.1] - 2026-11-01 — Desktop Apps and Agent Support

Papilot 0.8.1 adds desktop apps for macOS and Linux, an editable demo paper, and support for Copilot and Grok. It also fixes saving accepted changes to the manuscript while preserving other work in progress.

### Added

- **macOS and Linux desktop apps.** Electron reuses Papilot's React interface and local server, bundling Node, npm, Codex and the review engine. Window controls blend into the sidebar without a separate title bar, and first launch includes an editable example paper with a prebuilt PDF. Native CI builds and tests Apple Silicon/Intel DMG/ZIP and Linux x64 AppImage/deb packages, attaching them to each version release. Branch builds provide downloadable installers and screenshots. Desktop data and updates are separate from the CLI installation.
- **Grok Build CLI support.** Papilot connects through ACP with the CLI’s saved login or configured API credentials. It disables automatic approvals in new and restored sessions and supports streamed replies, tool approvals, images and model selection. Setup guidance and `papilot doctor` include Grok; use `PAPILOT_GROK_BIN` for a custom executable.
- **GitHub Copilot CLI support.** Papilot detects `copilot` and connects through ACP using its local login or configured provider. Tasks support streamed replies, tool approvals, images and session recovery. Papilot selects Agent mode and turns off allow-all for each new or resumed session. Settings and `papilot doctor` include setup guidance; use `PAPILOT_COPILOT_BIN` for a custom CLI path.

### Changed

- Fix task saving: **Commit to manuscript** creates one task-only commit on the current manuscript branch; **Apply to workspace** leaves accepted edits uncommitted. Both update the manuscript, including tasks previously saved to task branches, while preserving unrelated staged and unstaged edits. Conflicts are resolved automatically by AI before PDF review, retaining the save action and commit message; AI asks the author only when the intended content is unclear. When a final passage includes earlier uncommitted edits, preview and confirm **Commit together** instead of receiving a Git error. Worktree details are collapsed under **Git details**.

## [0.8.0] - 2026-11-01 — AI Review and PDF Notes

Papilot 0.8.0 adds AI reviews on task copies of your paper, with concise suggestions beside the relevant PDF passages. Keep selected suggestions on the main manuscript, write private reading notes, and decide which notes to send to an agent. This release also adds reference checks, more agents and a reorganized Settings interface.

### Added

- **AI review on a task copy.** Choose the **AI review** skill to ask Codex, Claude or GLM for short, specific comments without changing the manuscript. Each task preserves its own PDF and anchors suggestions to the reviewed passages. Use the bookmark action to keep selected comments on the main manuscript; the manuscript text stays unchanged. Ignore and restore suggestions, and use the left and right arrow keys to move between them. Reviews use extracted text, equations and captions; they do not inspect figure images.
- **Private PDF notes.** Reading notes stay on the PDF until you explicitly quote them into a task. Create and edit notes in the same compact card, click the text to edit, and save and close with Escape or a click outside. The notes library shares these controls and preserves drafts if saving fails.
- **A development update channel.** Choose **Dev (GitHub main)** in Settings → Updates to install a specific development build, or return to **Stable** for npm releases. Both channels preserve your data and retain the previous installation for rollback.

- **Codex can see the PDF.** New Codex tasks get a `view_pdf` tool: Codex asks for the pages where source lines or printed page numbers appear, in its worktree or in the accepted text, and Papilot compiles them and draws the pages as images that Codex opens with its image viewer. Codex uses it when the look of the page matters, such as line breaks and spacing, and the conversation shows each look. Only the chapters needed are compiled, and the review after the turn reuses the build.

- **Compilation problems beside Recompile.** A quiet log icon counts the last build's undefined references and citations, duplicate labels, missing files and errors; overfull lines and package remarks are listed but never counted. Open it to see each problem with its file, line and page, jump to the exact spot on the PDF (SyncTeX places it, down to the `??`), read the raw log, or prefill a Fix LaTeX warnings task. A failed rebuild keeps the last PDF and says so in one line.

- **One model menu for every agent.** The agent buttons and model list become one searchable menu, like OpenCode's: every available agent's models, grouped by agent with recent choices first, so one choice sets both the agent and the model. Type to search, or use the arrow keys and Enter; reasoning effort and fast mode follow the chosen model. An agent that cannot be used yet says why in its group.

- **Claude on your Claude plan.** With Claude Code installed and signed in, Claude tasks run `claude -p` on that login, so a Claude plan works without an API key. Edits in the worktree are accepted, commands run in Claude Code's sandbox, anything that would need approval is declined and noted, and each task resumes its session. Without Claude Code, Claude still runs through the Agent SDK with an API key.

- **More agents, found automatically.** Cursor (through the Cursor SDK, with `CURSOR_API_KEY`), GLM (Claude Code on Zhipu's Anthropic-compatible endpoint, with `ZHIPU_API_KEY` or `ZAI_API_KEY`), DeepSeek (`dsh acp` from DeepSeek Harness), Qwen Code (`qwen --acp`) and OpenCode (`opencode acp`) join the agent menu. Papilot offers only the agents it finds on the host, looks again on **Reconnect**, and names the rest in Settings → Runtime & diagnostics. DeepSeek keeps its workspace sandbox, Qwen runs in Auto Edit mode, and OpenCode asks before commands and anything outside the worktree. `papilot doctor` checks each of them and lists agents that are not set up for information only.
- **Bibliography checks.** A change to a `.bib` file is reviewed entry by entry, with every field and where the paper cites each entry; hunks of one entry are decided together. Papilot looks up added and modified entries in Crossref, DBLP and arXiv (DOIs through doi.org) and marks each as verified, differing from its record or not verified, with the record beside it. Accepting an entry that is not verified asks first, and **Accept all** leaves it for you. Removed entries the paper still cites, duplicate keys and new citations without an entry are flagged too, and agents are told never to invent references. Turn the lookups off in **Settings → Check references online**.
- **Reference check.** Under **More** in the sidebar, check the whole bibliography: citations without an entry, duplicate keys, the same work under two keys, uncited entries, and each entry against Crossref, DBLP and arXiv. Mark an entry no source knows as **I checked it myself**, which reviews then honour, and ask an agent to find out what happened with the rest, in a new task you can edit first; it reports and changes nothing.
- **Kimi Code support.** Choose Kimi for paper-editing tasks using your local Kimi Code CLI login. The ACP adapter supports model and thinking-level selection, streamed replies, image inputs, tool approvals, cancellation and session recovery. Diagnostics include Kimi CLI availability; set `PAPILOT_KIMI_BIN` for a custom executable path.

### Changed

- **Tasks stay available until you archive them.** Leaving a finished task or restarting Papilot keeps it in the task list, including AI reviews and conversations without manuscript edits. After applying or committing, the saved status offers **Archive**; it only archives when you click it, and the conversation and review remain available.
- **Settings organized by purpose.** Appearance, notifications, sharing, updates, skills and runtime setup have dedicated pages. Agent details show availability and setup instructions, LaTeX settings show the detected installation, shortcuts have an interactive keyboard overview, and custom skills can choose their own icons.
- **Quieter review navigation.** Indirect PDF changes start collapsed, with a preference to expand them. Scrolling and change navigation stay inside the review, and sending a task animates it into the sidebar while keeping the manuscript open.

### Fixed

- Jumping to a section from the contents no longer moves keyboard focus into the PDF later, the next time that page redraws, for example after collapsing the side panel.
- Unsaved note edits are saved before navigating away; failed saves keep the draft visible for retry.
- AI review annotation changes synchronize across browsers, and restoring a suggestion cannot create a duplicate during a simultaneous refresh.
- Preserved review PDFs remain available after moving a paper and updating its repository path. Keeping a suggestion on the manuscript verifies its current location and avoids duplicate copies.

## [0.7.0] - 2026-10-31 — Fully Modernized UI and Interactions

Papilot 0.7.0 brings a fully refreshed workspace for reading, annotating, revising and reviewing papers. Compact controls, clearer navigation and smoother transitions keep the manuscript at the center, with new ways to organize feedback and save accepted changes.

### Changed

- **A modernized workspace.** A simpler sidebar, compact search and archive controls, two-line task titles, clearer status indicators and consistent menus make tasks easier to scan. Agent, model and reasoning-effort controls use the provider's own labels.
- **View switches that feel like switches.** PDF / Changes and Review / Split / Chat use compact segmented controls. Workspace layouts transition smoothly, preserve keyboard focus and respect reduced-motion preferences. The new-tab action stays at the far right of the whole workspace.
- **More room for the paper.** Resize the PDF and conversation panels, or collapse the manuscript side panel while keeping its tab, draft and width. Resizing can restore fit-to-width, and narrow layouts keep review actions and navigation available instead of hiding them too early.
- **One place to compose a task.** PDF notes, group instructions, skills, attachments and the revision prompt share the task composer. Starting a task keeps the manuscript open; task titles are generated from prompts and annotations, with pending and retry states.
- **Clearer review controls.** Review progress, history, source display, batch decisions and navigation have a more compact presentation. Tasks that finish with an answer and no manuscript changes show a completed conversation without an empty review.
- **Choose where accepted changes go.** For new tasks, accepting an edit keeps it inside the task until review is complete. Choose **Apply to working directory** to leave the accepted changes uncommitted, or **Commit to task branch** to save them on a separate `papilot/…` branch. The inline commit editor offers an agent-generated message that you can edit, and preserves the draft across view changes. Existing tasks retain their original delivery behavior; later rounds of a new task use its chosen destination.

### Added

- **Color-grouped PDF annotations.** Mark passages with a compact pen and color palette, collect related notes into collapsible groups and give each group its own instructions. Select individual notes or whole groups for a task; unsent notes stay available for later work.
- **Editable, more precise notes.** Quotes show the selected words separately from your instructions in compact cards. Edit a note in place, undo note edits or deletion from the keyboard, and follow links between sent notes and the resulting review changes.
- **Files and images in conversations.** Add files, drag them onto the composer or paste images into new tasks and follow-up messages. Image previews, upload retries and persistent attachment drafts keep supporting material with the task.
- **A skill library in Settings.** Search and preview skills, create or edit global and paper-specific skills, and copy built-in skills to customize them. Saved skills become available in the composer immediately.
- **Guided paper imports.** Open a local LaTeX folder or drop a ZIP, detect the main document and compiler, prepare Git history and try compilation. A failed build can be retried, repaired with an assistant or saved to resume later.
- **Paper management from the picker.** Edit a paper's name and repository path, or remove it from Papilot while preserving its files and Git history on disk.
- **A compact Git overview.** See task worktrees and commit history alongside file changes, making it easier to follow revisions across tasks and branches.
- **Customizable review shortcuts.** Change or clear shortcut bindings in Settings, with conflict detection and a way to restore defaults.
- **Diagnostics inside Settings.** Check the host and a selected paper, inspect failures, retry checks and copy a report with sensitive details redacted. Settings also includes project, contribution, changelog and third-party license links.
- **In-app updates.** A new-version indicator offers installation from the browser. Papilot waits for active work to finish, restarts and reconnects, while retaining the previous installation for rollback.

### Fixed

- PDF annotations survive recompilation when their text can be placed again. Notes whose locations cannot be confirmed are flagged instead of silently moved to the wrong passage.
- Compilation controls distinguish building, successful and failed states, with clearer retry behavior and preserved notes and drafts.
- The selected paper and manuscript view return after reload, and creating a task no longer unexpectedly replaces the manuscript view.
- Review controls, long paths and comment editors fit narrow panels and phone screens; toolbar wrapping keeps actions accessible.
- Conversation, annotation and commit drafts survive layout changes, feedback submission and recoverable loading failures.
- The review's own bar stays under Papilot's PDF tools. When something scrolled the whole review page rather than its paper, the bar slid away and the tools sat over the PDF.

## [0.6.0] - 2026-10-30

### Added

- The PDF review lists the places an edit changes away from its own lines under that edit: the uses of a redefined macro, equations and references renumbered after an inserted equation, a new bibliography entry. The first three are shown and **Show N more** renders the rest. The places have no buttons; deciding the edit decides them. When a round has several edits, Papilot compiles the accepted text with some of them to tell which edit causes each change, so such a round can take longer to build.

### Changed

- On touch screens, the review and the PDF view select text with Papilot's own highlight, handles and **Add note** menu instead of the system's, which covered Papilot's: a long press picks a word, dragging extends it, and the handles move its ends.
- Every PDF build of a day prints the same date: Papilot sets TeX's `SOURCE_DATE_EPOCH` to the local date, unless you set it, so `\today` shows today and `\time` shows 12:00. A build kept from an earlier day is rebuilt rather than compared with today's.

### Fixed

- On phones, a long file path no longer widens the review past the screen, which cut the diff in half and put its buttons under the PDF tools.
- On phones, notes and comments are written in a card under the review toolbar, which the keyboard never covers. A note closed before it is written no longer blocks the next selection, and one left half-written reopens after a reload.

## [0.5.0] - 2026-10-29

### Added

- **Changes** beside **PDF** on the PDF page shows what changed since the last commit as a typeset diff, like a task's review. Each change can be staged, unstaged or reverted on its own (**Undo revert** puts a revert back), so one revision can become several commits.

### Changed

- The Git panel's checkboxes are the Git index: a ticked file is staged, a half-ticked one partly staged. **Commit** takes what is staged, or with nothing staged, every file but build output as before.

## [0.4.0] - 2026-10-29

### Added

- **People**: invite an advisor or co-authors to chosen papers. They sign in with a passkey at a public HTTPS address (`PAPILOT_ACCOUNT_ORIGIN`, for example Tailscale Funnel on port 10000), see only the papers you share, and can work in them as you do. Their messages and notes show their name. You can unshare a paper, remove a device or a person at any time, and get your own passkey to use the public address. Invite only people you would trust with access to the computer Papilot runs on: agents and builds can read any file on it.

### Changed

- Commit messages are written by the agent's small model (GPT Luna, Claude Haiku or Gemini Flash, when the agent offers one), and a finished review's message is written as soon as you decide the last change, so **Commit…** usually opens with it ready. The generate button writes a new one.

### Fixed

- Mathematical letters such as 𝐹 no longer turn into Hangul syllables in PDF note quotes, marked regions and review diffs.
- The **Language** setting uses the same menu as the model picker, instead of the browser's plain list with a different size and arrow.

## [0.3.0] - 2026-10-29

### Added

- A finished review offers an optional **Commit…**: the task's agent writes the message, and **Commit and push** pushes too. Accepted changes are still in the manuscript without it.
- The Git panel's ✨ button writes the commit message, like Cursor's: the agent you chose reads the ticked files' changes and follows the style of your recent commits.
- When your branch and its upstream have both changed, the Git panel offers **Merge**; an agent resolves the conflicts, and you read the diffs, then **Commit merge** or **Abort merge**.
- Untracked build output (LaTeX's `.aux`, `.log` and the like, minted's cache, `.DS_Store`) gets **Add to .gitignore**, which adds one pattern per kind of file.

### Fixed

- A task no longer stops at **This step needs attention** when the agent's own edits stop the PDF build, for example by also editing a project note outside the paper's source folder. The agent gets the error and fixes it in one more turn, and its instructions now say which files the review covers.
- Build output in the Git panel is unticked from the moment it appears, so a quick commit cannot include it.
- **Accept all** and **Reject all** no longer break onto two lines or slide under the PDF tools in a narrow review panel or on a phone. Their count is a badge, and the toolbar makes room in steps, down to each button's icon and count.

## [0.2.0] - 2026-10-29

### Added

- Skills: type `/` in any prompt, or pick a suggestion on the new-task page, to run **Polish**, **Proofread**, **Shorten**, **Check math**, **Consistency**, **Fix LaTeX warnings** or **Address reviewers** without writing the prompt. Add your own as Markdown files in `~/.papilot/skills` or a paper's `.papilot/skills`.
- **Settings** in the sidebar holds **Appearance** (light, dark or the system setting, for the workspace and the review viewer; in dark, PDF pages turn dark too), **Language** (English or Simplified Chinese, following the browser by default) and **Notifications** (a browser notification when a task needs your reply, its review is ready, or it stops with an error while Papilot is in the background).
- **Notes** in the PDF review: select any text, including accepted or unchanged text, or mark a region, and send the notes to the task's agent together.
- Agent replies typeset LaTeX mathematics.
- `papilot doctor` checks the environment and suggests fixes without installing software or changing papers; `--repo` checks a paper and `--json` outputs a report for scripts.

### Changed

- The chat shows what you did rather than the prompt the agent receives: a skill by name with your words, and sent review feedback as its decisions and comments.
- **Send feedback** asks only for comments, or for a round you rejected entirely; accepted and rejected decisions reach the agent with your next message.
- Decided changes leave the current review and become clean PDF text. **History** holds earlier diffs and **Undo last decision**; sending feedback shows the agent's progress until new changes arrive.
- The PDF's contents sit in the side panel beside Notes and Git.

### Fixed

- **Send feedback** includes accepted and rejected review decisions, so a round without comments can still be sent to the agent. Queued or delivered feedback no longer prompts another send.
- Claude is available with `ANTHROPIC_AUTH_TOKEN`, the key a gateway or another service's Anthropic-compatible `ANTHROPIC_BASE_URL` uses, instead of asking for an Anthropic API key. The guide shows how to map the model menu onto that service's models.
- The macOS background service keeps the tool search path of the shell it was installed from, and `PAPILOT_SERVICE_PATH` picks a particular TeX or Python installation for it.
- KOMA-Script papers build and review correctly.
- Build errors show the TeX diagnostic together with any Python helper exception, such as one from `latexminted`.

## [0.1.1] - 2026-10-27

### Changed

- Papilot listens on port 7274 by default, which spells PAPI on a phone keypad. Use `--port 4317` or `PAPILOT_PORT=4317` to keep the old port.

## [0.1.0] - 2026-10-27

The first release on npm.

### Added

- `npm install -g papilot` and the `papilot` command. `papilot demo` adds a 26-page example paper, and `papilot codex login` signs in to Codex.
- An existing Codex of the tested version or newer is used as it is; otherwise Codex is installed once on first start. The Claude Agent SDK is downloaded the first time Claude is used with an API key.
- Tasks run on Codex, Claude or Antigravity, each in its own Git worktree, with up to two at once.
- Every change comes back as a typeset PDF diff to accept, reject or comment on. Each decision can be undone, and Accept all and Reject all act only on undecided changes.
- A PDF reader with contents, search, zoom and exact text selection. Notes on a passage or a marked region reach the agent with their LaTeX lines.
- A Git panel to diff files, commit the chosen ones, and fetch, pull or push.
- Remote access through Tailscale, and a background service on macOS.

[Unreleased]: https://github.com/PapilotAI/papilot/compare/v0.8.9...HEAD
[0.8.9]: https://github.com/PapilotAI/papilot/compare/v0.8.8...v0.8.9
[0.8.8]: https://github.com/PapilotAI/papilot/compare/v0.8.7...v0.8.8
[0.8.7]: https://github.com/PapilotAI/papilot/compare/v0.8.6...v0.8.7
[0.8.6]: https://github.com/PapilotAI/papilot/compare/v0.8.5...v0.8.6
[0.8.5]: https://github.com/PapilotAI/papilot/compare/v0.8.4...v0.8.5
[0.8.4]: https://github.com/PapilotAI/papilot/compare/v0.8.3...v0.8.4
[0.8.3]: https://github.com/PapilotAI/papilot/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/PapilotAI/papilot/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/PapilotAI/papilot/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/PapilotAI/papilot/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/cu1ch3n/papilot/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/cu1ch3n/papilot/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/cu1ch3n/papilot/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/cu1ch3n/papilot/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/cu1ch3n/papilot/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/cu1ch3n/papilot/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/cu1ch3n/papilot/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/cu1ch3n/papilot/releases/tag/v0.1.0
