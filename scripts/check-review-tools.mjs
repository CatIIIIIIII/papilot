// Reuse the real review fixture, stopping after the marking-tool checks.
process.env.PAPILOT_REVIEW_TOOLS_ONLY = '1';
await import('./check-unified-review.mjs');
process.env.PAPILOT_REVIEW_TOOLS_TOUCH = '1';
await import('./check-unified-review.mjs?touch');
