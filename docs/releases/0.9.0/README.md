# Papilot 0.9.0 release materials

The release introduction covers **v0.8.0 → v0.9.0**. The [changelog](../../../CHANGELOG.md) preserves the individual patch releases and records changes since v0.8.9 under 0.9.0. [#65](https://github.com/PapilotAI/papilot/pull/65) merged into main as `98c331b3c28602e55521a3656ba087942a6fa93b` on 2026-11-05 and is included.

## Publication copy

- [English release introduction](release-notes.md) — the GitHub release body, selected automatically by the Release workflow.
- [Chinese announcement](announcement.zh-CN.md) — the same release overview for Chinese readers.
- Title: **Papilot 0.9.0 — A desktop workspace for your papers**.

The workflow keeps validating the version's changelog entry, uses the introduction when `docs/releases/VERSION/release-notes.md` exists, and falls back to the changelog for other versions. Images in the English introduction use version-pinned URLs that become available when the release tag is pushed. Replace the Chinese announcement's relative image paths with the same version-pinned URLs when copying it outside the repository.

## Contributors

| Contributor | Contribution | Merged PRs |
| --- | --- | --- |
| [@chengluyu](https://github.com/chengluyu) | Conversation rendering, incremental polling, Git-status caching and consistent choice lists | [#24](https://github.com/PapilotAI/papilot/pull/24), [#25](https://github.com/PapilotAI/papilot/pull/25), [#26](https://github.com/PapilotAI/papilot/pull/26), [#27](https://github.com/PapilotAI/papilot/pull/27), [#28](https://github.com/PapilotAI/papilot/pull/28), [#32](https://github.com/PapilotAI/papilot/pull/32) |
| [@CatIIIIIIII](https://github.com/CatIIIIIIII) | Editing/deleting included notes and enabling online lookup in editing tasks | [#36](https://github.com/PapilotAI/papilot/pull/36), [#54](https://github.com/PapilotAI/papilot/pull/54) |
| [@RIvance](https://github.com/RIvance) | Nix packaging, extended into CLI and NixOS desktop support | [#45](https://github.com/PapilotAI/papilot/pull/45) |

The list covers the full release-introduction interval, checked against `git shortlog v0.8.0..98c331b` and GitHub authorship/merge records. `ivance` and `std::_Rb_tree` are commit identities in the same #45 contribution. The maintainer is omitted as requested. Dependency bot updates are linked in the security entries.

## Screenshots

The screenshots show the real Papilot UI and a disposable TeX-compiled example. The actual review engine renders the PDF comparison. Account, conversation, task-list and Git responses are illustrative fixtures; no live inference, personal account or private manuscript is used. [screenshots.json](screenshots.json) records the code base, displayed version and capture conditions.

| Image | Caption |
| --- | --- |
| [magic-pen.png](magic-pen.png) | Select a passage and choose a reusable instruction from the Magic pen wheel. |
| [review-feedback.png](review-feedback.png) | Review the typeset before/after change and send feedback from the chat composer. |
| [version-management.png](version-management.png) | Stage files and inspect a source diff in the dedicated Version Management workspace. |
| [version-history.png](version-history.png) | Browse earlier versions and inspect the restore action. |
| [inline-source.png](inline-source.png) | Make a precise LaTeX correction inside the PDF review. |

The first three images appear in the release introduction; the other two support follow-up posts. PNGs are 2880×1600, captured at 2× scale from a 1440×800 viewport. Regenerate with TeX, Chrome (or `PAPILOT_BROWSER_CHANNEL`) and the repository dependencies installed:

```sh
npm run build
npm --prefix engine run build
node --import tsx scripts/capture-release-0.9.0.mjs
```

## Release checks

Checked on the release branch based on `98c331b`, using Node.js 22.22.0 on macOS:

- Application tests: **647 passed, 1 skipped**; review-engine tests: **179 passed**.
- Type checking, application and review-engine builds, translation catalogue and application-locale checks passed.
- Every browser check in `test:ui` passed, including targeted reruns after updating stale fixtures for the settings endpoint, Version Management, unified review feedback and asynchronous annotation saves. No application behavior was changed by these test updates.
- `test:review-comments` passed (21 tests plus the unified feedback and PDF-note browser checks); source editing passed with a real PDF rebuild.
- Website checks, npm package dry run, development desktop smoke and native notifications passed. The desktop reported version `0.9.0`.
- All five screenshots were regenerated, visually inspected and checked for dimensions and asset links.
- The Release workflow's exact notes-extraction step passed for both the curated 0.9.0 introduction and the legacy 0.8.9 changelog fallback.
- [PR #66 checks](https://github.com/PapilotAI/papilot/pull/66/checks) cover Node 22/24 and packaged macOS ARM64/Linux desktop smoke tests. Full installer checks run again on the release tag before publication.

The release tag has not been pushed. Browser and screenshot fixtures do not make live provider calls.

## Publishing sequence

1. Review and merge the release branch after required CI passes. If main changes meanwhile, integrate it and repeat checks affected by those changes. Keep unmerged feature PRs out of the introduction.
2. Verify package and lockfile versions are `0.9.0`, the changelog date is the intended release date, and the release introduction and screenshot links are ready.
3. Tag the merged release commit `v0.9.0` and push the tag. This starts publication; the Release workflow gates npm and GitHub publication on Node 22/24 CI and full desktop installer checks.
4. Verify npm `papilot@0.9.0`, the GitHub release text and its eight assets: macOS ARM64/x64 DMG and ZIP, Linux x64 AppImage and deb, `papilot-app-0.9.0.tgz`, and `desktop.json`. The manifest is uploaded last so it only advertises available downloads.
5. Verify installer links and update metadata. This release changes the desktop shell: older shells need the new installer. Nix users update through Nix.
