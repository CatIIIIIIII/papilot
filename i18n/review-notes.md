# Localization review

English baseline: `origin/main` at `ab05417` (homepage redesign, desktop downloads, agent marks, quick start and current README). The English README changes only to add the shared language switcher.

## Editorial corrections

- Japanese homepage description: rejected the literal wording “組版済みの変更前後として返され”, which made the typeset comparison awkward and unclear. Added message-specific feedback to `i18n/config.json` for regeneration.
- Swedish website and README glossary: use “arbetsträd” for a Git worktree. “Arbetskatalog” means working directory and blurs the distinction between the isolated task copy and the manuscript workspace. The scope-specific glossary preserves the existing App catalogs while correcting the new public copy.

- Japanese setup labels: rejected repeated を constructions caused by enforcing English inline-code order. Allowed code fragments to move without changing their contents, and requested natural Japanese sentence order.
- Simplified Chinese quick start: rejected an isolated 您 amid otherwise consistent 你 wording; requested the same register as the rest of the homepage.

- German homepage description: rejected “bearbeitet das LaTeX”; requested natural wording that explicitly refers to the LaTeX source and the typeset comparison.

- Spanish, Portuguese and Italian homepage descriptions: rejected literal “comes back as a before-and-after” constructions. Requested direct, idiomatic explanations of comparing the typeset pages and accepting or rejecting changes.
- Portuguese copy uses Brazilian Portuguese conventions; Open Graph locale is `pt_BR`, while the language URL and hreflang remain the App’s `pt`.

## Review criteria

For every locale, review the hero, desktop download labels, every agent card, quick start and README introduction. Compare meaning and completeness with the English source; check academic tone, consistent glossary terms, commands, environment variables, URLs and product names. Automated validation additionally checks placeholders, inline code, HTML structure, README code blocks, link destinations, language names and section coverage.

## Locale decisions

| Locale | Homepage hero, downloads, agent cards, quick start | README introduction |
| --- | --- | --- |
| zh-CN | Accepted after register correction | Accepted |
| zh-Hant | Accepted | Accepted |
| ja | Accepted after comparison and setup-label revisions | Accepted |
| ko | Accepted | Accepted |
| de | Accepted after source/comparison wording revision | Accepted |
| fr | Accepted | Accepted |
| es | Accepted after comparison wording revision | Accepted |
| pt | Accepted after comparison wording revision | Accepted |
| it | Accepted after comparison wording revision | Accepted |
| sv | Accepted with corrected worktree glossary | Accepted |

All ten website catalogs contain 161 messages. Each README contains the complete current English document’s sections, links and code, translated without summarization. Product-name checks and structural validation pass for the public catalogs.

## Mechanical rejections and layout

- Rejected malformed Swedish and Korean JSON responses without accepting partial content; regenerated successfully.
- Rejected a Swedish inflection that changed the protected Cursor name; regenerated the card with the exact name.
- Early Chinese and Japanese setup-label batches retried code-order mismatches. Validation now permits natural word order while requiring the same exact code fragments.
- Screenshot checks cover zh-CN, ja, de and sv at 390px and 1440px. Download buttons, menus and all agent cards fit their containers. Japanese headline wrapping uses strict line-start rules so a prolonged-sound mark cannot start a line.
- Automated browser checks cover every language at 320, 390, 768 and 1440px, including static content, canonical/hreflang/sitemap, assets, demo playback, reduced motion and saved language choices.

## App catalog refresh

The merged source added or changed 55 workspace messages and four review-viewer messages in each non-curated locale, plus 11 error messages in every locale. Obsolete generated entries were removed. The final all-scope check passes for all ten locales: 1,137 workspace messages, 248 review messages, 236 errors, 161 website messages and one complete README document per locale.
