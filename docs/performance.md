# Compilation performance

Papilot should compile about as fast as running `latexmk` (or `make`) in the paper's folder. Each build still gets its own folder, because reviews compare immutable versions and SyncTeX has to point to the version being shown. The goal is that this isolation costs about a second, not a clean rebuild.

## How a build runs

1. **Snapshot.** The working tree is recorded as a Git tree with a private index, `.git/latex-review/working-index`. It starts from the previous snapshot, or from the repository's own index, so Git rehashes only files whose size or modification time changed.
2. **Export.** The new build folder starts as a clone of a recent completed build: of the last 16 with the same chapters, the one whose sources differ from the new version in the fewest files, preferring the newer. After a task is reviewed or applied this is often not the manuscript's previous build but the task's own, which already has the edit's references and page numbers. On APFS, `cp -c` clones the whole folder in one step. Files outside the new tree are removed, files with a different Git object or size are streamed from Git, and nothing else is read. Other systems clone or copy file by file. The first build of a paper exports the whole tree from Git, streaming one blob at a time.
3. **LaTeX state.** latexmk's database, auxiliary files and minted cache carry over from the build the new one starts from. Within the same day, the PDF, SyncTeX data and log carry over too. latexmk then decides what to run, exactly as in the author's folder: nothing if no input changed, usually one pass after an edit. Paths in kept SyncTeX data and logs are rewritten in place for the new folder; build folders differ only in their equal-length key. On a new day the PDF is rebuilt, so `\today` stays current.
4. **First build.** When the author has compiled the paper with latexmk into `<main folder>/build`, that job's auxiliary state and minted cache seed the first build. Other editions and subfolders in that directory are ignored. The author's PDF and SyncTeX data are not reused: their paths have a different length, and SyncTeX records byte offsets.
5. **Review builds.** A review compiles only the changed chapters (`\includeonly`), before and after the change, on top of a full build of the task's base (the seed). The two versions compile at the same time. Each set of chapters continues from its own latest build in the same way, so a chapter that was compiled before needs one pass, not a clean build. The other chapters' auxiliary files come from the seed every time, so their cross-references stay current.
6. **Passes on screen.** An edit that moves page numbers, references or the bibliography needs more than one TeX pass. After every pass, latexmk (4.84 or later) runs a hook that copies the pass's output aside. Once latexmk starts more work after a pass, such as BibTeX or another pass, that pass's pages replace the previous PDF in the manuscript view (an `.xdv` is converted with `xdvipdfmx`, which takes under a second for a 324-page paper), with their own SyncTeX data. The edit shows after one pass; the later passes only settle numbers. If the build then fails, the previous PDF comes back.
7. **Fallbacks.** A build that fails on leftover state, with an error located in a generated file under `build/` (for example a stale `.aux` or `.bbl`), is retried once from a clean folder. **Recompile PDF** always starts clean.

## When builds start

The manuscript compiles as soon as something may have changed its files, not when its view is next opened: after a task is committed or applied, a Git action, or a review decision. A build started meanwhile is followed right away by one of the newest files. The view learns that a build started or finished from the server's event stream and reloads at once; edits saved in another editor are noticed within five seconds while the manuscript is open, and immediately when Papilot's window regains focus.

A task that waits to be applied (the default) changes the manuscript only when it is committed or applied, so that build could only start then. Instead, whenever a round is published or a change is accepted or rejected, Papilot asks the review engine what applying the task would write if every pending change were accepted, merged with the files on disk exactly as applying merges them, and compiles that version in the background. When the task is applied, the manuscript's build has the same key: its PDF is already there, or the build already under way is the one it waits for. A rejected change makes a new prediction, which continues from the previous one.

## The review's full paper

A review can show its changes in the whole paper (**PDF** in the review's switch). A round compiles only the changed chapters, so the whole new version is a separate build. While the review engine publishes a round that compiles only some chapters, its job status names the round's new version (`revision`), and Papilot starts compiling the whole paper at once, in the background, alongside the round's own builds instead of after them. It is usually the same version that committing the task will produce, so the commit's prediction often finds it built. A round that compiles the whole paper names no version: its own build is the full PDF, and a build of it here would wait for that one, or hold up the round.

When the review opens on the full paper before that PDF is complete, it does not wait for it. It first shows the PDF the round itself compiled (`build` in the round's details): the changed chapters, with each change exactly where its strips come from. Then it shows each TeX pass of the whole paper once latexmk follows it with more work, and finally the complete PDF (`passes` in the round's details: `?after=N` answers with the next version, and the PDF route serves it with `?pass=N`). Each version replaces the previous one keeping the change being reviewed at the same place on screen, and pages already painted stay until the new version's replace them.

## Priorities

Builds have a priority: the manuscript the author is looking at first, then review builds, then predictions. While a build of higher priority compiles in the same process, a prediction's compiler is stopped (`SIGSTOP`) and continues afterwards. On macOS a prediction also yields to TeX running anywhere else, such as the review engine compiling another task: meanwhile its processes run at background priority (`taskpolicy -b`: efficiency cores, throttled disk), and once nothing else compiles they get normal priority back (`taskpolicy -B`), so on an idle machine a prediction runs at full speed. Unlike a nice value, both can be undone, so when someone starts waiting for a build that is running as a prediction, it takes the higher priority at once. A build runs at the highest priority among everyone in the process waiting for it, and shows its passes to all of them, also to those who asked before its compiler started. Someone who waits for a build already under way in the same process awaits it directly, so the result arrives the moment it is ready; the lock file, which a waiter polls every 100–500 ms, is only for builds in other processes.

## Event loops

Neither server waits for Git, the file system or a compiler on its event loop while it builds or changes a review: snapshots, exports, cloning LaTeX state, rewriting SyncTeX paths, reading logs and writing results all run asynchronously, so the PDF view, the review page and the task list keep answering. The review engine's snapshots of a task's worktree also start from a saved index (`latex-review/snapshot-index` in that worktree's Git directory) with `read-tree -m`, which keeps each file's size and modification time, instead of a fresh index that made Git rehash every tracked file twice per snapshot.

Accepting, rejecting and undoing changes, applying or committing a task, preparing a merge review and finishing a task run Git asynchronously as well (accepting took ten Git commands in a row, committing thirty-five). They used to be atomic because they never yielded; the engine now runs every write through one queue (`App.exclusive`), publishing takes its turn for the snapshot it compares and for recording the new round, and writes interrupted by a restart finish before the server listens.

Before the server listens it also loads what would otherwise stall the first requests: the agent SDKs already installed (evaluating the Cursor SDK takes about 300 ms) and the PDF engine, run once on the example paper to compile its WebAssembly and set up color conversion. Placing compilation problems reads a page's text only to search it for a missing reference or citation; every other problem needs only the page's size. When Papilot quits it stops the compilers it started, paused ones included.

## Measurements

Paper used for testing: 2,239 tracked files (240 MB), XeLaTeX, BibTeX with back-references, minted and `\include`d chapters. Measured on an Apple Silicon MacBook on 2026-11-02, compared with `latexmk -norc -r latexmkrc` on the main file in a copy of the same commit. Both columns in each table were run alternately under the same load. Other sessions kept the load average at 7–9, which is why one pass took 69 s here, compared with 43–51 s on an idle machine.

| Change | `latexmk` in the folder | Papilot, before | Papilot, now |
|---|---|---|---|
| Open or import the paper | 0.2 s, nothing to do | 230 s: 5 XeLaTeX passes, 4 BibTeX runs | 71.3 s: 1 pass |
| Edit a chapter | 69.2 s: 1 pass | 230 s: clean build | 71.2 s: 1 pass |
| Edit a file TeX does not read | 0.2 s, nothing to do | 230 s: clean build | 1.9 s, no TeX run |
| Clean build | 253 s: 5 passes, 4 BibTeX runs | 230 s | 230 s, only for **Recompile PDF** |

The same TeX pass costs the same in both folders. With the folder and `SOURCE_DATE_EPOCH` varied separately, the times were 51.4 s (author's folder), 44.4 s (Papilot folder), 42.7 s and 44.5 s (both with Papilot's date variables). All runs were single passes, and the spread is noise.

Papilot's own work per build, outside latexmk:

| Step | Before | Now |
|---|---|---|
| Snapshot of the working tree | 2.1 s (rehashes 240 MB) | 0.1 s |
| Export of the build folder | 240 MB per build, kept for three days | 0.76 s, copy-on-write |
| Copy LaTeX state | not done | 0.06 s |

Review builds of one chapter of the same paper, measured on 2026-11-02 at a load average of about 9, for a commit that revised the chapter's framing and title:

| Build | Before | Now |
|---|---|---|
| Chapter, the first build for this set of chapters | 88.5 s: 3 passes, 2 BibTeX runs | the same, clean |
| Chapter, every later build | 68.7–88.5 s: 3 passes, 2 BibTeX runs | 25.8 s: 1 pass |

Several tasks' reviews refresh after a commit, so these clean builds used to run side by side with the manuscript's own build.

When the import dialog compiled a paper, it used to force a clean build under a one-off key, so opening the paper afterwards compiled it a second time. Now it builds under the normal key, and the paper view reuses that PDF.

### Committing a reviewed task

The paper's seven commits of 2026-11-02, each built by continuing from the previous one as the manuscript does, needed 4, 2, 1, 1, 3, 4 and 2 XeLaTeX passes (330, 98, 88, 65, 163, 183 and 92 s at a load average of 5–25). These counts are LaTeX's own: an edit that moves a label, a cited page (back-references) or the bibliography needs another pass for each round of changes, exactly as with latexmk in the author's folder. What Papilot controls is when that work starts and when its pages appear.

End to end with `scripts/profile-commit.ts` on a copy of the paper: a deferred task adds a paragraph to chapter 4, its round is published, everything is accepted after a review, and 15 s later the task is committed to the manuscript. Measured on 2026-11-03 on an Apple M1 at a load average of 11–26; the manuscript's build after the commit took two passes in every run.

| | Before | Now |
|---|---|---|
| Round ready after the agent's edit | 108.7 s, 46.5 s | 23.1–47.2 s |
| PDF after the commit, after a 150 s review | 94.4 s, and only if the manuscript was open | 0.8 s |
| PDF after the commit, after a 30 s review | 94.3 s, 94.4 s | 51.8–65.1 s; the new pages after 18.3 s |
| First new pages when nothing was predicted | 113 s, the whole build | 55.2 s, the first pass |
| Review engine's slowest answer while a task is created | 4.1 s | 35 ms |
| Review engine's slowest answer while a round is published | 2.4 s | 16–35 ms |
| Review engine's slowest answer while the task is committed | 0.33 s | under 60 ms (it was 0.25–0.28 s until accepting and committing ran Git asynchronously too) |

Before, the manuscript started compiling when its view next asked, and "before" here assumes it was open the whole time. A 30 s review gives the prediction a 45 s head start on a 90–110 s build; the commit then promotes it, and the waiting view takes over its passes.

#### Through a running server

The same flow through two Papilot servers, the previous version and this one, each started on its own data folder with the agent SDKs installed, driven only through the HTTP routes the web app uses: publish the task's round, accept it on the review page after 60 s, commit it 15 s later, then open the manuscript as the app does. Meanwhile `/api/state`, which the app polls, and the review engine's `/api/info` were asked every 100 ms how long they take to answer, and a 2 ms timer preloaded into the server recorded every gap in its event loop over 50 ms. Four runs each, alternated, at a load average of 6–9 on 2026-11-03, the event-loop timer in the last two; the manuscript's build after the commit took two passes every time.

| | Before | Now |
|---|---|---|
| New pages after the commit | 95.0–99.6 s | 2.6–2.7 s |
| The whole PDF after the commit | 95.0–99.6 s | 21.6–26.7 s |
| Gaps in Papilot's event loop over 50 ms, publish to PDF | 4–5, up to 276 ms | 0–1, at most 80 ms |
| Review engine's slowest answer while the round is published | 2,408–2,736 ms | 10–84 ms |
| Review engine's slowest answer while the task is committed | 193–284 ms | 5–58 ms |

Papilot's own event loop, measured as the longest gap between ticks of a 2 ms timer while the manuscript compiles an edit of the paper (one pass, 47–49 s): 106 ms before, with seven gaps over 50 ms, and 34 ms now, with none. Placing a text note from an earlier version on the new PDF searches every page's text; on the 324-page paper that held the event loop for 1,076 ms after every build, and now for at most 42 ms at a time.

## Reproducing

`node --import tsx scripts/profile-commit.ts COPY FILE LINE [--review S] [--think S]` runs the whole flow above on a copy of a paper and prints the timings as JSON; it commits to the copy's repository. Run it from an older checkout to measure that version. `tests/fast-builds.test.ts` checks the snapshot index, continuing from the closest build, pass previews, background priorities, predicted builds and delivery previews on small papers.

`tests/incremental-build.test.ts` checks pass counts on a small paper: one pass when continuing from the author's latexmk output, one pass after an edit, no TeX run after an unrelated change, a clean retry after stale auxiliary state, and a clean manual recompile. It also checks that a chapter's review build needs one pass the second time and takes renumbered references from a new seed. To time a real paper, clone it outside its folder, run `latexmk` there for reference, then build the same commits with `Builder` from `engine/src/core/build.ts` and compare the `Running '…latex'` lines in each build's `latexmk.log`.
