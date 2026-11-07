# Static demo

The website's **Try online demo** link opens the static **Demo** at `/demo` (served
from `/demo/` by the static host). It uses the same React
entrypoint, PDF viewer, annotation tools, task list, composers and settings as
the installed app. There is no Papilot server, agent process, API endpoint or
service worker to deploy.

The homepage has one Demo text link in the right-hand controls, immediately
before the theme switcher. Solid accent text matches the site's flat controls,
with a subtle color transition on hover or keyboard focus. The link has no
underline, filled background, gradient, icon or idle animation. Reduced-motion
preferences disable the transition.

The two-page **Meet Papilot** tour uses the official wordmark (including the
product icon), product illustrations and supported-agent artwork from
`docs/assets/`. It explains three design principles: review the rendered page,
keep the author in control, and retain ownership of files and tools.
Headings, body text, captions and agent labels use TeX Gyre Pagella X, with
matching `newpxmath` formulas. Agent labels are typeset in TeX from the shared
artwork, so regeneration does not substitute a host system font.

The math describes actual product ideas: normalized annotation boxes, comparing
rendered PDFs, and applying accepted edits. A sample task generalizes the
coordinate formula to a nonzero page origin, with a matching table example.
The formulas are a conceptual explanation of the workflow, not a performance
claim or an automated proof of correctness.

The paper starts with seven notes on specific words, one math symbol and a table cell: grouped highlights, a deletion,
a quick note and a sticky note. Two sample tasks show real typeset before/after
diffs for writing, a formula and a table entry; visitors can inspect LaTeX,
accept/reject changes, undo decisions and draft review comments. A third task
shows AI suggestions that can be copied to the manuscript. Notes, decisions and
drafts stay in this browser. Six prepared tasks offer specific edits for all seven
seeded notes: the opening, author choices, filler words, quick-note wording,
cropped-page coordinates and the closing invitation. Each plays a ten-second
authored process: thinking, preparing the edit, comparing the PDF and streaming
the response. Its real pre-rendered diff and note-to-change links appear only
after the replay finishes. The replay can be paused and resumed, survives reloads,
and is labeled as a demo replay; no model is called. Opening the same
preset again replays the process and keeps its review decisions. Sending an unchanged seeded note without
extra instructions also opens its matching prepared task. Custom notes, extra
instructions and follow-ups open a download dialog and preserve the draft.
Compilation, imports and agent execution still point to download.

Version Management uses a browser-local mock repository with staged and unstaged
files, source diffs, version history, a commit graph and two task worktrees.
Staging, unstaging, discarding, generating a fixed commit message, committing,
syncing and restoring a version update persisted local snapshots. Restoration
creates a new version and preserves history. No filesystem or remote is changed;
the document and task PDFs remain pre-rendered. Advanced Git views default to on
in the Demo and respect subsequent settings changes.

The model picker lists every agent from the shared `AGENT_IDS` registry, with
static example models and GPT-6 Astra / xhigh selected by default. The existing
effort slider, Fast mode switch and permissions controls work locally, including in sample tasks;
no settings change starts an agent. A compact notice with a subtle theme accent links directly
to download and says “This is a static demo without LaTeX or LLM agent backends.
To experience the full workflow, please download Papilot.” The download link is
part of the sentence. “static demo” is bold; macOS, Windows and Linux download
menus use platform icons and the app's shared action menu. Each offers the same
installer choices and versioned URLs as the website, using `package.json` for
the release version. The notice shares the app's typography and surface colors
and wraps on phones. Dismissal persists locally;
download dialogs remain available when an action needs the installed app.

## Development and verification

```sh
npm ci
npm run dev:playground
# Open the printed local URL under /demo/.

npm run build:playground
# Output: _site/demo/
```

Serve `_site/` with any static web server and open `/demo`. The Vite
configuration sets the asset base path; no SPA rewrite is needed.

```sh
npm --prefix engine ci
npm run test:playground
```

The browser check uses Chrome by default, like the other UI checks. CI installs
Playwright Chromium and sets `PAPILOT_BROWSER_CHANNEL=chromium`. The test serves
only files, exercises notes, prepared-task replay and pause/resume, PDF diffs,
review decisions, comment drafts, version management and AI suggestions, checks
download prompts and mobile layout, and fails on any `/api`
request, failed asset or browser error.

## Keeping it current

`npm run site` builds both the landing page and playground. The Pages workflow
runs on every push to `main`, and CI checks the playground on changes. The
version comes from `package.json`. The PDF, diff strips and review data live in
`examples/playground-paper/preview/`. Both the PDF viewer and the diff viewer use
the application's components, with an in-browser transport in place of HTTP.
Website builds only package these fixtures and read PDF dimensions with MuPDF;
neither TeX nor the review engine server is needed.

To change the example, edit `examples/playground-paper/main.tex` and `edits.json`,
then run `npm run build:playground-example` with TeX, librsvg (`rsvg-convert`) and engine dependencies
installed. The generator reads shared brand and product images directly from `docs/assets/`. This runs the real compiler and diff renderer in a temporary project
and replaces the committed fixtures. Restart `dev:playground` after regeneration.

`src/web/playground/data.ts` implements an explicit allowlist of local reads and
annotation and review writes. Unknown routes never fall back to a network request. The
normal app build excludes the playground adapter, notice and sample content.
Browser storage is namespaced separately from a real workspace. Notes carry the
PDF's content hash, and review storage includes the example revisions, so an
updated example never reuses notes or decisions from a different paper. Blocked
or full browser storage falls back to the current tab, shared with its review
frames so decisions survive switching tasks. The internal reset endpoint is
used by checks; there is no reset action in the Demo header.
