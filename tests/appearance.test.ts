import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_APPEARANCE, parseAppearance } from '../src/web/appearance.ts';

test('older or invalid appearance preferences default reviews to following the PDF', () => {
  for (const value of [null, '{broken', '{}', '{"pdf":"light"}', '{"review":"invalid"}', '{"review":false}']) {
    assert.equal(parseAppearance(value).review, 'pdf');
  }
  assert.equal(parseAppearance('{"pdf":"light"}').pdf, 'light');
  assert.equal(DEFAULT_APPEARANCE.review, 'pdf');
});

test('review appearance survives saving independently of the PDF preference', () => {
  for (const review of ['pdf', 'theme', 'light'] as const) {
    const saved = { ...DEFAULT_APPEARANCE, pdf: 'light' as const, review };
    const restored = parseAppearance(JSON.stringify(saved));
    assert.equal(restored.review, review);
    assert.equal(restored.pdf, 'light');
  }
});
