# Compilation performance

Papilot should compile about as fast as running `latexmk` (or `make`) in the paper's folder. Each build still gets its own folder, because reviews compare immutable versions and SyncTeX has to point to the version being shown. The goal is that this isolation costs about a second, not a clean rebuild.

## How a build runs

1. **Snapshot.** The working tree is recorded as a Git tree with a private index, `.git/latex-review/working-index`. It starts from the previous snapshot, or from the repository's own index, so Git rehashes only files whose size or modification time changed.
2. **Export.** The new build folder starts as a clone of the latest completed build. On APFS, `cp -c` clones the whole folder in one step. Files outside the new tree are removed, files with a different Git object or size are streamed from Git, and nothing else is read. Other systems clone or copy file by file. The first build of a paper exports the whole tree from Git, streaming one blob at a time.
3. **LaTeX state.** latexmk's database, auxiliary files and minted cache carry over from that build. Within the same day, the PDF, SyncTeX data and log carry over too. latexmk then decides what to run, exactly as in the author's folder: nothing if no input changed, usually one pass after an edit. Paths in kept SyncTeX data and logs are rewritten in place for the new folder; build folders differ only in their equal-length key. On a new day the PDF is rebuilt, so `\today` stays current.
4. **First build.** When the author has compiled the paper with latexmk into `<main folder>/build`, that job's auxiliary state and minted cache seed the first build. Other editions and subfolders in that directory are ignored. The author's PDF and SyncTeX data are not reused: their paths have a different length, and SyncTeX records byte offsets.
5. **Fallbacks.** A build that fails on leftover state, with an error located in a generated file under `build/` (for example a stale `.aux` or `.bbl`), is retried once from a clean folder. **Recompile PDF** always starts clean.

## Measurements

Thesis used for testing: 2,239 tracked files (240 MB), XeLaTeX, BibTeX with back-references, minted and `\include`d chapters. Measured on an Apple Silicon MacBook on 2026-11-02, compared with `latexmk -norc -r latexmkrc Thesis.tex` in a copy of the same commit. Both columns in each table were run alternately under the same load. Other sessions kept the load average at 7–9, which is why one pass took 69 s here, compared with 43–51 s on an idle machine.

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

When the import dialog compiled a paper, it used to force a clean build under a one-off key, so opening the paper afterwards compiled it a second time. Now it builds under the normal key, and the paper view reuses that PDF.

## Reproducing

`tests/incremental-build.test.ts` checks pass counts on a small paper: one pass when continuing from the author's latexmk output, one pass after an edit, no TeX run after an unrelated change, a clean retry after stale auxiliary state, and a clean manual recompile. To time a real paper, clone it outside its folder, run `latexmk` there for reference, then build the same commits with `Builder` from `vendor/latex-review/src/core/build.ts` and compare the `Running '…latex'` lines in each build's `latexmk.log`.
