# Reference

How Papilot's review engine works, for contributors. Papilot drives every step below over the engine's HTTP API.

## How it works

```
agent:  task created ─▶ edit worktree ─▶ round published ─────▶ feedback ─▶ revise ─▶ next round …
                                              │                    ▲
                                              ▼                    │
author:                             review page: Accept · Reject · Comment, per change
```

- Creating a task snapshots the repository and creates a worktree, outside the repository at `../<repository>-tasks/<task>`, limited to the requested sections or files.
- Publishing a round snapshots the worktree and compiles the accepted text and the agent's version with `latexmk`. If the document uses `\include`, only the affected chapters are compiled. SyncTeX tells which part of each PDF belongs to a change; the crops and their marks come from one comparison of the two whole PDFs (below), and render as vector SVG with an aligned HTML text layer for native selection and copy. Edits that only touch comments or line breaks are shown as LaTeX diffs.
- **Accept** merges the change into the user's working tree with a three-way merge and records it as accepted. **Reject** reverts it in the worktree. **Comment** marks it for revision. The user can undo decisions within the current round.
- Edits whose typeset output overlaps, such as a table file and the line that inputs it, appear as one change marked "2 edits". The buttons act on all of them; the change's LaTeX view decides on each one.
- One whole-document comparison supplies the words and marks for every crop. It uses unique eight-word anchors, then exact bit-parallel LCS with linear-space reconstruction between anchors. Headers and footers supply reading-flow hints without discarding repeated text. Every extracted glyph retains its physical footprint, including overlapping rows and words interrupted by floats or page headers. Observed line-break boundaries produce a shared word segmentation; ordinary word spaces remain meaningful. A line-end hyphen is ignored only when its surrounding pieces reconstruct a matched word; identical printed hard and discretionary hyphens cannot always be distinguished from PDF data.
- SyncTeX associates changed output with its source edits. Text crops include their changed words and painted glyph extents; layout crops use corresponding unchanged lines as boundaries. Columns and bands spanning columns retain their reading order. Unchanged context keeps the original PDF colours. Crops trim white rows without treating faint coloured ink as blank.
- Exact equal word fragments nominate moved passages. A passage must share at least 20 letters and digits, or complete an already matched word split by typesetting. Matched occurrences are consumed individually, allowing compound moves. Source-owned moved words appear in light blue; untouched text reordered around a float remains context.
- Equal text is also checked for glyph shape, colour, size and relative placement. Source layout and matched glyphs provide the alignment reference; aligned page ink at 2x resolution verifies candidate differences. This finite sampling is not a proof of arbitrary PDF equivalence.
- Indirect comparison also includes non-text paths, images, masks and shading. PDF clip scopes provide shared drawing coordinates, so an entire clipped figure can reflow while a point moving within it remains a change. Without a separate scope, drawing primitives share the page frame; PDF does not always preserve an author's intended figure boundaries. Matched text glyphs provide the reference for changes in drawing/text overlap. Final composed pixels verify candidate effects, and their previews retain the full physical area, including margins and column boundaries.
- Indirect changes, a setting in Papilot, additionally find effects outside an edit's own crop, such as macro uses and renumbered references. This option is off by default and persists for later publishes of the task. Extra variant compilations determine which combination of edits reproduces each final effect; identical requests are cached. The displayed combination is verified to be sufficient, including when individually sufficient edits cancel each other. It need not be minimal or enumerate every alternative cause. Accepting or rejecting still applies only to the selected edit. The first three previews load with the round; more load on request.
- The comparison has no time-based partial result or variant-count cap. A renderer process timeout or compilation failure is reported as a failure, never as a successful truncated diff, and cannot establish a smaller sufficient combination.
- Every build of a day prints the same date: TeX's `SOURCE_DATE_EPOCH` is set to noon UTC of the local date (with `FORCE_SOURCE_DATE`), unless you set it yourself, and it is part of the build cache key. A build kept from an earlier day therefore never differs from today's by `\today` alone; `\time` prints 12:00.
- Each round shows what is still proposed and not accepted. Undecided changes carry over, and revised changes show the comment they answer.
- The user can keep deciding while the next round is queued or compiling. A build that a decision makes outdated starts over, so the new round includes it; builds are cached, so mostly only the accepted text compiles again.

## Configuration

Usually none. The root document comes from `@default_files` in a `latexmkrc`, or is the only `.tex` file with `\documentclass`. The engine comes from a `% !TEX program` line, `$pdf_mode` in the latexmkrc, or the packages used (`fontspec` means XeLaTeX). To override, add `.latex-review.json` at the repository root:

| Setting | Meaning |
| --- | --- |
| `main` | Root document, e.g. `"paper/main.tex"` |
| `engine` | `"pdflatex"`, `"xelatex"` or `"lualatex"` |
| `latexmkrc` | latexmkrc to use (default: next to the root document) |
| `source_dir` | Folder copied for each build (default: the root document's folder; use `"."` if the document inputs files outside it) |
| `partial_builds` | `false` to always compile the whole document |
| `preload` | For partial builds: `\include` target → file to `\input` when that chapter is left out (e.g. macros it defines) |
| `dependencies` | For partial builds: `\include` target → targets that must be compiled with it |
| `figures` | Folders whose files are reviewed as whole figures (default: `figures/` or `figs/` beside the root document) |
| `worktrees` | Where task worktrees go (default: `../<repository>-tasks/`) |
| `build_workers` | Number of independent tasks compiled and rendered concurrently, from 1 to 8 (default: 1). Restart Papilot after changing it. |

For example, add `"build_workers": 2` to let a small edit run while another task
is building or rendering. Rounds of the same task still run in order, and repeated
requests for a waiting round coalesce. Shared build snapshots retain their cache
locks. Cache cleanup runs only when all publishing workers are idle.
Papilot starts the engine with the new setting after it restarts. Let active
builds finish before restarting.

## Limits and guarantees

- The in-context view needs PDF bookmarks, which `hyperref` provides. Without them, changes appear as standalone crops.
- Section scopes understand `\part` … `\subsubsection`, literal `\input`/`\include`/`\subfile`, and `\label`s.
- A task's first publish compiles the whole document once; later rounds reuse it.
- The user's branch, `HEAD` and staging area are never touched; snapshots use a private index. Writes are journaled, so an interrupted accept or undo completes when the server restarts.
- State lives in `.git/latex-review/` and `refs/latex-review/`. Deleting a task removes its worktree, rounds and refs.
- One local server per repository. It listens on 127.0.0.1 only, rejects cross-origin requests, restarts itself when Papilot is updated, and exits after 12 idle hours.

## The example

The end-to-end and browser tests use `examples/demo.ts`: it copies `examples/paper` into a temporary repository, and applying `examples/agent-edits.json` to a task on its *Design* section publishes seven changes. They cover an equation rewritten with `cases`, inline and `align` math, a reflowing sentence, a figure caption, a deletion, and a re-wrapped line with no visible effect.

## Development

`npm run check` runs TypeScript checks, Vitest and the Vite production build.
`npm run test:browser` tests the rendered UI with Playwright (run `npx playwright install chromium` first).
`npm run test:corpus` compiles and reviews the pinned Raft dissertation; see [corpus.md](corpus.md).

`npm run dev` serves the React UI on localhost. Point `REVIEW_API` to a running review server, for example `REVIEW_API=http://127.0.0.1:8765 npm run dev`. Start a development API with `npx tsx src/cli.ts serve --root /path/to/document-repo --port 8765`.

```
src/cli.ts, client.ts       server entry point, discovery and lifetime
src/server.ts              Fastify localhost API
src/core/                  Git snapshots, SQLite journal, decisions, build queue
src/render/                MuPDF WASM, SyncTeX, word diffs and SVG/text strips
src/web/                   React review page, Vite build
examples/                  example paper and edits for the tests
tests/ts/                  core, rendering and TeX integration tests
tests/browser/             native selection, clipboard and review interaction
scripts/                   pinned corpus validation
```

The server retains the existing SQLite schema, task refs, worktrees and API routes. Updating Papilot rebuilds the UI; the client waits for an idle old server before restarting it, normally on the same port. Old rendered rounds remain readable, but need rerendering to gain a selectable text layer.

The preview uses paths for exact PDF appearance and transparent positioned Unicode glyphs for selection. Copying equations follows the PDF’s text extraction order; it does not reconstruct LaTeX. Source view remains available for exact TeX.
