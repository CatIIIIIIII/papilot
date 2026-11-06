# Reference

Details for agents and contributors. Users only need the [README](../README.md); agents follow [SKILL.md](../SKILL.md) and read this page when they need more.

## How it works

```
agent:  start ─▶ edit worktree ─▶ publish ────────────▶ feedback --wait ─▶ revise ─▶ publish … ─▶ report completion
                                     │                        ▲
                                     ▼                        │
user:                       review page: Accept · Reject · Comment, per change
```

- `start` snapshots the repository and creates a worktree, outside the repository at `../<repository>-tasks/<task>`, limited to the requested sections or files.
- `publish` snapshots the worktree and compiles the accepted text and the agent's version with `latexmk`. If the document uses `\include`, only the affected chapters are compiled. SyncTeX tells which part of each PDF belongs to a change; the crops and their marks come from one comparison of the two whole PDFs (below), and render as vector SVG with an aligned HTML text layer for native selection and copy. Edits that only touch comments or line breaks are shown as LaTeX diffs.
- **Accept** merges the change into the user's working tree with a three-way merge and records it as accepted. **Reject** reverts it in the worktree. **Comment** marks it for revision. The user can undo decisions within the current round.
- Edits whose typeset output overlaps, such as a table file and the line that inputs it, appear as one change marked "2 edits". The buttons act on all of them; the change's LaTeX view decides on each one.
- One whole-document comparison supplies the words and marks for every crop. It uses unique eight-word anchors, then exact bit-parallel LCS with linear-space reconstruction between anchors. Headers and footers supply reading-flow hints without discarding repeated text. Every extracted glyph retains its physical footprint, including overlapping rows and words interrupted by floats or page headers. Observed line-break boundaries produce a shared word segmentation; ordinary word spaces remain meaningful. A line-end hyphen is ignored only when its surrounding pieces reconstruct a matched word; identical printed hard and discretionary hyphens cannot always be distinguished from PDF data.
- SyncTeX associates changed output with its source edits. Text crops include their changed words and painted glyph extents; layout crops use corresponding unchanged lines as boundaries. Columns and bands spanning columns retain their reading order. Unchanged context keeps the original PDF colours. Crops trim white rows without treating faint coloured ink as blank.
- Exact equal word fragments nominate moved passages. A passage must share at least 20 letters and digits, or complete an already matched word split by typesetting. Matched occurrences are consumed individually, allowing compound moves. Source-owned moved words appear in light blue; untouched text reordered around a float remains context.
- Equal text is also checked for glyph shape, colour, size and relative placement. Source layout and matched glyphs provide the alignment reference; aligned page ink at 2x resolution verifies candidate differences. This finite sampling is not a proof of arbitrary PDF equivalence.
- Indirect comparison also includes non-text paths, images, masks and shading. PDF clip scopes provide shared drawing coordinates, so an entire clipped figure can reflow while a point moving within it remains a change. Without a separate scope, drawing primitives share the page frame; PDF does not always preserve an author's intended figure boundaries. Matched text glyphs provide the reference for changes in drawing/text overlap. Final composed pixels verify candidate effects, and their previews retain the full physical area, including margins and column boundaries.
- `publish --indirect` additionally finds effects outside an edit's own crop, such as macro uses and renumbered references. This option is off by default and persists for later publishes of the task. Extra variant compilations determine which combination of edits reproduces each final effect; identical requests are cached. The displayed combination is verified to be sufficient, including when individually sufficient edits cancel each other. It need not be minimal or enumerate every alternative cause. Accepting or rejecting still applies only to the selected edit. The first three previews load with the round; more load on request.
- The comparison has no time-based partial result or variant-count cap. A renderer process timeout or compilation failure is reported as a failure, never as a successful truncated diff, and cannot establish a smaller sufficient combination.
- Every build of a day prints the same date: TeX's `SOURCE_DATE_EPOCH` is set to noon UTC of the local date (with `FORCE_SOURCE_DATE`), unless you set it yourself, and it is part of the build cache key. A build kept from an earlier day therefore never differs from today's by `\today` alone; `\time` prints 12:00.
- Each round shows what is still proposed and not accepted. Undecided changes carry over, and revised changes show the comment they answer.
- The user can keep deciding while the next round is queued or compiling. A build that a decision makes outdated starts over, so the new round includes it; builds are cached, so mostly only the accepted text compiles again.

## Commands

Each command prints one JSON object. Its `next` field says what to do. Failures exit with status 1 and include `error`, `details` and `next`.

Agents use the CLI throughout manuscript review: `publish` reports publication, `status` reports progress, `feedback` returns decisions and comments, and `list` lists tasks. Share the returned URL with the user; opening or inspecting the review UI is not a routine verification step. `--open` is an optional convenience when the user asks to open a page.

```sh
review="/path/to/skill/scripts/review.mjs"
node "$review" start NAME [--section 3.2]... [--file path]... [--title TEXT] [--open]   # in the repository
node "$review" publish [--no-wait] [--timeout S] [--indirect] [--open]   # in the worktree
node "$review" feedback [--wait [SECONDS]] [--all]
node "$review" accept --all [--round NUMBER]   # when the user explicitly delegates acceptance
node "$review" accept c001 c003              # selected pending changes
node "$review" undo                         # undo one decision or the entire last batch
node "$review" status | list | finish [--force] | doctor
node "$review" server status | stop [--force]
```

`--repo PATH` runs a command for another repository or worktree. `--task NAME` names the task outside its worktree.

`feedback` reads immediately. There is no 200-message cap: every undelivered opinion is returned, including its complete comment body and source location. `feedback --all` replays all active decisions, comments and messages across rounds without advancing the delivery cursor. Undone opinions are omitted from a replay; agents that already received them get an explicit `undo` event. Build failures include `build_error` with diagnostics and a log path; the response also includes current-round compiler warnings. An agent can obtain all this through the CLI, with no browser access.

 `feedback --wait` waits without a time limit until
the round is fully decided, a message to the agent arrives, or a build fails;
`feedback --wait 60` bounds the wait to 60 seconds. A new `note` ends the wait even
in `reviewing` or `building`: the agent handles that message before following the
task state. Each response consumes the feedback it returns, so the agent keeps
any comments already received for the next revision. Ordinary partial decisions
alone do not end the wait. The agent shares the review URL and keeps its turn open
waiting on the command, then acts on the returned feedback automatically. If a
bounded wait expires, it waits again. This works while the agent session is
running; it does not wake an ended session.

`done` means every change is decided. The agent reports completion and leaves the
task open, keeping the PDF review and undo available. `finish` is a separate
cleanup command used when the user asks to close the review; it removes the
worktree, rounds and refs and ends undo.

`accept --all` accepts every pending unit of the current round with one atomic decision. Previously rejected or commented units retain their decisions. If any proposed write conflicts with a user edit, the entire batch fails without writing. `undo` reverses the whole batch. A waiting `feedback --wait` process receives the acceptance once the round completes; no browser is needed.

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
| `build_workers` | Number of independent tasks compiled and rendered concurrently, from 1 to 8 (default: 1). Restart the review server after changing it. |

For example, add `"build_workers": 2` to let a small edit run while another task
is building or rendering. Rounds of the same task still run in order, and repeated
requests for a waiting round coalesce. Shared build snapshots retain their cache
locks. Cache cleanup runs only when all publishing workers are idle.
Stop an idle server with `REVIEW server stop`; the next command starts it with
the new setting. Let active builds finish before restarting.

## Limits and guarantees

- The in-context view needs PDF bookmarks, which `hyperref` provides. Without them, changes appear as standalone crops.
- Section scopes understand `\part` … `\subsubsection`, literal `\input`/`\include`/`\subfile`, and `\label`s.
- A task's first publish compiles the whole document once; later rounds reuse it.
- The user's branch, `HEAD` and staging area are never touched; snapshots use a private index. Writes are journaled, so an interrupted accept or undo completes when the server restarts.
- State lives in `.git/latex-review/` and `refs/latex-review/`. `finish` removes a task's worktree, rounds and refs.
- One local server per repository. It listens on 127.0.0.1 only, rejects cross-origin requests, restarts itself when the skill is updated, and exits after 12 idle hours.

## The example

`examples/demo.ts` copies `examples/paper` into a temporary repository, starts a task on its *Design* section, applies `examples/agent-edits.json` and publishes seven changes. They cover an equation rewritten with `cases`, inline and `align` math, a reflowing sentence, a figure caption, a deletion, and a re-wrapped line with no visible effect.

## Development

`npm run check` runs TypeScript checks, Vitest and the Vite production build.
`npm run test:browser` tests the rendered UI with Playwright (run `npx playwright install chromium` first).
`npm run test:corpus` compiles and reviews the pinned Raft dissertation; see [corpus.md](corpus.md).

`npm run dev` serves the React UI on localhost. Point `REVIEW_API` to a running review server, for example `REVIEW_API=http://127.0.0.1:8765 npm run dev`. Start a development API with `node scripts/review.mjs serve --root /path/to/document-repo --port 8765`.

```
src/cli.ts, client.ts       Commander CLI, discovery and feedback wait
src/server.ts              Fastify localhost API
src/core/                  Git snapshots, SQLite journal, decisions, build queue
src/render/                MuPDF WASM, SyncTeX, word diffs and SVG/text strips
src/web/                   React review page, Vite build
examples/                  demo paper and TypeScript demo runner
tests/ts/                  core, rendering and TeX integration tests
tests/browser/             native selection, clipboard and review interaction
scripts/                   CLI bootstrap and pinned corpus validation
```

The server retains the existing SQLite schema, task refs, worktrees and API routes. Updating the skill rebuilds the UI; the client waits for an idle old server before restarting it, normally on the same port. Old rendered rounds remain readable, but need rerendering to gain a selectable text layer.

The preview uses paths for exact PDF appearance and transparent positioned Unicode glyphs for selection. Copying equations follows the PDF’s text extraction order; it does not reconstruct LaTeX. Source view remains available for exact TeX.
