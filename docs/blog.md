# Publishing on the Papilot blog

The blog uses the website's static build and GitHub Pages deployment. Articles, language navigation and RSS are fully rendered without JavaScript. No CMS, database or additional runtime is needed.

## Add an article

Create `site/blog/posts/your-article-slug/` containing:

- `post.json`: publication date and localized title, description, lead and hero image metadata.
- One Markdown file per published locale, such as `en.md`, `zh-CN.md` or `ja.md`. Start headings at `##`; the template supplies the title. An image's optional Markdown title becomes its figure caption.

The supported languages follow `i18n/languages.json`: English, Simplified Chinese, Traditional Chinese, Japanese, Korean, German, French, Spanish, Portuguese, Italian and Swedish. Only include completed article translations in `post.json`; every listed locale must have its corresponding Markdown file. Interface and diagram translations live in `site/blog/locales/<locale>.json`.

Add `"draft": true` to exclude an article from pages, feeds and the sitemap. Dates use `YYYY-MM-DD`. An optional `updated` date must be at least the publication date and should reflect an actual content revision. The article displays its publication date; the update date remains in structured data and the sitemap. Structured data uses these editorial dates with the project's UTC+08:00 timezone. Dates are editorial metadata, not a publication scheduler.

## Typography and illustrations

The blog uses the manuscript's locally hosted TeX Gyre Pagella for Latin text, language-appropriate serif fallbacks for Chinese, Japanese and Korean, and Inconsolata for code. Navigation uses the site's system sans-serif. Titles, prose, captions and diagrams share the serif family. Layout rules live in `site/blog/blog.css`.

Put PNG or SVG images in `site/blog/assets/` and reference `/assets/blog/filename.png` from Markdown. SVGs need a numeric `viewBox="0 0 width height"`. A `filename-compact.<locale>.svg` beside `filename.<locale>.svg` supplies a readable phone layout. Include meaningful image alt text.

Repository-authored SVGs are inlined so they inherit the article fonts and theme. Only use trusted SVG source. Regenerate the explanatory diagrams with `node scripts/build-blog-illustrations.mjs` after editing the `illustrations` strings in locale JSON files or the generator's layouts. SVG identifiers are namespaced to keep arrow markers and accessible labels distinct. Check labels in both wide and compact layouts, especially after translation.

The build reuses the existing product screenshots. Simplified Chinese articles use the Chinese screenshots; other translations use the English screenshots with localized alt text and captions. Explanatory diagrams are fully localized.

## Translation

The founder-edited `zh-CN.md` is the editorial source for the first article. Its ten translations were generated with the actual `agy` CLI using `gemini-4-argon-medium`, then checked for preserved headings, paragraphs, image positions, code macros, links and technical terminology. Translation includes article metadata, interface labels, figure descriptions and explanatory diagrams. English was translated again from the finalized Chinese, replacing the earlier draft.

Preserve the author's first-person voice and chosen argument. In the opening example, a subtype relationship has been reversed; it is not a claim about a progress theorem. Distinguish an author's review of AI edits from peer review. Accepting a change records a review decision; applying, committing and pushing remain separate actions. Use natural, concise local-language metadata instead of repeating keywords.

## SEO and validation

English lives at `/blog/`; other languages live at `/<locale>/blog/`. Every index has its own RSS feed. Each article has a self-referencing canonical URL, reciprocal language alternatives (including itself), an `x-default` pointing to English when available (otherwise the first published locale), localized Open Graph/Twitter metadata, `BlogPosting` and breadcrumb structured data, and a sitemap entry. The language menu uses ordinary links without automatic redirection. Each localized homepage links to its own Blog index.

The index stays a simple article list. Its concise visible introduction and descriptive search metadata are separate fields (`indexDescription`, `indexSeoTitle`, `indexSeoDescription`). Article metadata should accurately summarize the article; do not add unsupported claims or arbitrary keyword lists.

The implementation follows Google's guidance for [localized versions](https://developers.google.com/search/docs/specialty/international/localized-versions), [article structured data](https://developers.google.com/search/docs/appearance/structured-data/article), [title links](https://developers.google.com/search/docs/appearance/title-link) and [search snippets](https://developers.google.com/search/docs/appearance/snippet). Correct metadata helps search engines interpret the pages; it does not guarantee indexing or ranking.

```sh
node scripts/build-blog-illustrations.mjs
npm run site
node scripts/check-site-blog.mjs
npm run test:site
```

Output goes to `_site/`. The build rejects unsupported locales, invalid metadata and missing local assets. Browser checks cover all languages, feeds, reciprocal links, structured data, responsive diagrams, narrow screens, language switching and dark mode. Preview the output with a local static HTTP server and inspect the resulting pages before publishing.

A merge to `main` runs the existing Pages workflow and publishes the site. Building locally does not publish it. After deployment, use Search Console to submit or inspect the production sitemap and monitor crawl/indexing status.
