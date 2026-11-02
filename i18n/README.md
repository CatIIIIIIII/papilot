# AI translations

Workspace UI messages stay in English in `t(...)` / `tn(...)`. This pipeline extracts them with Babel's TypeScript/JSX parser and translates changed messages through **agy, Gemini 4 Argon**. Generation happens during development; the browser never calls a model. The catalogs cover the workspace, review viewer, product errors, website (including demo UI), and README.

```sh
npm run i18n -- extract
npm run i18n -- check
npm run i18n -- translate --locale zh-CN --dry-run
```

`extract` writes a deterministic catalog with file, line and component context to `test-results/i18n/workspace.json`. Single/double quotes, static template literals, conditional strings, nested folders, aliases and plural calls are supported. Built-in skill metadata, annotation groups and icon labels are included as explicit data sources. Unknown dynamic arguments fail extraction rather than silently disappearing. Use literal messages where possible; register additional finite data sources in the extractor when needed. Add an `// i18n: ...` comment immediately above a call to give translators more context.

## Try Argon

Sign in to `agy` beforehand. Model discovery is available through `agy models`; the default for this experiment is `gemini-4-argon-medium`. The command accepts `--model` and respects `PAPILOT_AGY_BIN`, standard proxy environment variables, and `PAPILOT_AGY_PROXY` (an HTTP proxy applied only to the child process).

```sh
# Update each surface. Existing translations are skipped.
npm run i18n -- translate --locale zh-Hant
npm run i18n -- translate --scope review --locale zh-Hant
npm run i18n -- translate --scope site --locale zh-Hant
npm run i18n -- translate --scope readme --locale zh-Hant
npm run i18n -- translate --scope errors --locale zh-Hant

# Inspect remaining work without calling a model.
npm run i18n -- translate --locale zh-Hant --dry-run

# Translate all remaining messages, then require complete coverage.
npm run i18n -- translate --locale zh-Hant
npm run i18n -- check --locale zh-Hant
```

To keep an experiment out of source files, add `--out-dir test-results/i18n-trial`; metadata then lives in that directory's `.state` folder. Relative output directories resolve against the shell's working directory.

## Files and incremental behavior

- `i18n/config.json`: locale names, writing instructions, terminology and optional `locked` arrays of English source strings.
- `src/web/locales/<locale>.json`: generated plain dictionaries, ready for the UI to import.
- `i18n/state/<locale>.json`: source/rules/context fingerprints, translation hashes and model provenance. Commit this together with the dictionary.
- `src/web/zh-CN.ts`: the existing curated Chinese translations. They are always preserved and take precedence over generated Chinese entries.

Only missing or outdated machine-generated entries are sent to Argon. Changing the English message creates a new key. Changing instructions, glossary or translator context invalidates affected machine entries; changing line numbers does not. An existing translation without metadata, or one edited after generation, is treated as a human override. To regenerate an override, remove its generated dictionary entry (and its explicit lock, if present). To regenerate a curated entry, first remove it from `zh-CN.ts`.

Each batch uses a fresh temporary working directory and asks for structured JSON. Placeholder names and multiplicity, non-empty values, IDs and control characters are checked before saving. Successful entries are saved after each response; only invalid/missing entries are retried, up to three attempts. Provider/auth/network errors stop the run, retaining prior progress. Rerun to resume. Concurrent runs for the same output locale are rejected, and edits made while generation is running are not overwritten. If a process is forcibly killed, remove its `.lock` file after verifying it has stopped.

`check` fails on missing, malformed, outdated or unused translations. Remove obsolete source keys from generated dictionaries and metadata after reviewing their removal. Automated validation checks structure; inspect terminology and UI layout before shipping.

## Build and verify

`--scope` selects `workspace` (the default), `review`, `site`, `readme`, or `errors`. Each has its own dictionary and incremental state. `check` without filters validates every configured locale in all five scopes. `--scope` and `--locale` narrow the selection; an isolated `--out-dir` defaults to the workspace scope. The README command generates `docs/readme/README.<locale>.md` and preserves stable section anchors. Code blocks, inline code, protected product names and link destinations are validated before writing. Translations retain the English section IDs and the shared language switcher. Catalog links stay relative to the root English README; rendering rebases them to the output directory. Website translations retain inline HTML structure and code; the site build requires a complete catalog.

Run `npm run build` for the app, `npm --prefix engine run build` for the viewer, and `npm run site` for the website after updating translations. The website and README languages match `i18n/config.json`; native language names live in `i18n/languages.json`. The website build emits English at `/` and translations at `/<locale>/`, with localized metadata, canonical URLs, reciprocal hreflang links and a sitemap. It restores a saved language only when visiting `/`; explicit language paths always win, and browser language does not redirect visitors. The app passes its selected language to the embedded review viewer.

Workspace extraction finds explicitly marked messages; it does not yet lint unwrapped JSX text. The error catalog covers literal product errors; external compiler and provider diagnostics remain verbatim. More complex plural systems need locale-aware plural handling before adding those languages.

```sh
node --import tsx --test tests/i18n.test.ts tests/i18n-pipeline.test.ts tests/i18n-scopes.test.ts
npm run typecheck
```

Tests use a fake agy executable and never make model requests.
