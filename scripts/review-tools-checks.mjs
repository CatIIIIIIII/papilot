import assert from 'node:assert/strict';
import { expect } from './playwright.mjs';

// Exercise the shared rail against the real embedded review, including drafts
// sent to the task rather than accept/reject mutations.
export async function checkReviewTools(page, writes, sent) {
  const viewer = () => page.frameLocator('.review-frame');
  const rail = () => page.getByRole('toolbar', { name: 'Marking tools' });
  const tool = name => rail().getByRole('button', { name, exact: true });
  const notes = () => page.locator('.review-draft-note');
  const select = async () => viewer().locator('.change[data-stop="0"] .after .pdf-glyph').first().evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }));
  });
  await expect(rail()).toBeVisible();
  if (process.env.PAPILOT_REVIEW_TOOLS_TOUCH === '1') {
    await tool('Magic pen').click();
    const glyph = viewer().locator('.change[data-stop="0"] .after .pdf-glyph').first();
    const rect = await glyph.boundingBox(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    await page.touchscreen.tap(x, y); await expect(page.locator('.stamp-wheel')).toBeVisible(); await page.keyboard.press('Escape');
    const strip = await viewer().locator('.change[data-stop="0"] .after .pdf-strip').boundingBox();
    await page.touchscreen.tap(strip.x + 200, strip.y + 10);
    await expect(page.locator('.stamp-wheel')).toBeVisible(); await page.keyboard.press('Escape');
    const client = await page.context().newCDPSession(page);
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await page.waitForTimeout(550);
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(viewer().locator('.review-select-menu')).toBeVisible();
    await expect(page.locator('.stamp-wheel')).toHaveCount(0);
    await viewer().locator('.review-select-menu button').click();
    await expect(page.locator('.stamp-wheel')).toBeVisible();
    await page.getByRole('menuitem', { name: 'Polish', exact: true }).click();
    await expect(notes()).toHaveCount(1);
    assert.equal(writes.length, 0);
    await client.detach();
    console.log('PASS: Touch magic pen on text and whitespace, with long-press selection');
    return;
  }
  await expect(tool('Undo')).toBeDisabled(); await expect(tool('Redo')).toBeDisabled();
  await tool('Collapse marking tools').click();
  await expect(rail()).toHaveAttribute('data-collapsed', 'true');
  await page.reload();
  await viewer().locator('.review-note-layer').first().waitFor({ state: 'attached' });
  await expect(tool('Expand marking tools')).toBeVisible();
  await tool('Expand marking tools').click();
  await expect.poll(() => viewer().locator('.review-body').evaluate(element => parseFloat(getComputedStyle(element).marginLeft))).toBe(46);
  await tool('Note').click(); await select();
  await expect(page.getByRole('textbox', { name: 'Comment 1', exact: true })).toBeFocused();
  await page.getByRole('textbox', { name: 'Comment 1', exact: true }).fill('Keep this phrase.');
  await tool('Undo').click(); await expect(notes()).toHaveCount(0);
  await tool('Redo').click(); await expect(notes()).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: 'Comment 1', exact: true })).toHaveValue('Keep this phrase.');
  await tool('Delete').click(); await select();
  await expect(notes()).toHaveCount(2);
  await expect(viewer().locator('.review-note-mark[data-kind="delete"]')).toHaveCount(1);
  await tool('Sticky note').click();
  await viewer().locator('.change[data-stop="0"] .after .review-point-capture').click({ position: { x: 20, y: 20 } });
  await expect(page.getByRole('textbox', { name: 'Comment 3', exact: true })).toBeFocused();
  await page.getByRole('textbox', { name: 'Comment 3', exact: true }).fill('Insert a definition here.');
  await tool('Region').click();
  const box = await viewer().locator('.change[data-stop="0"] .after .review-region-capture').boundingBox();
  await page.mouse.move(box.x + 30, box.y + 20); await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 70, { steps: 5 }); await page.mouse.up();
  await page.getByRole('textbox', { name: 'Comment 4', exact: true }).fill('Check this figure.');
  await tool('Magic pen').click(); await select();
  await expect(page.getByRole('menu', { name: 'Quick notes' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Polish', exact: true }).click();
  await expect(notes()).toHaveCount(5);
  await tool('Magic pen').click();
  await page.getByRole('menuitemradio', { name: /Shorten/ }).click();
  await select(); await expect(notes()).toHaveCount(6);
  await expect(notes().last()).toContainText('Shorten');
  // Clicking a blank spot with the pen uses a point anchor too.
  await viewer().locator('.change[data-stop="0"] .after .pdf-strip').click({ position: { x: 200, y: 10 } });
  await expect(notes()).toHaveCount(7);
  await tool('Select').click();
  await viewer().locator('#paper').evaluate(element => { element.tabIndex = -1; element.focus(); });
  await page.keyboard.press('h'); await expect(tool('Hand')).toHaveAttribute('aria-pressed', 'true');
  const paper = viewer().locator('#paper');
  await paper.evaluate(element => element.scrollTo(0, 0));
  const strip = await viewer().locator('.change[data-stop="0"] .after .pdf-strip').boundingBox();
  await page.mouse.move(strip.x + 25, strip.y + strip.height - 10); await page.mouse.down();
  await page.mouse.move(strip.x + 25, strip.y - 120, { steps: 8 }); await page.mouse.up();
  await expect.poll(() => paper.evaluate(element => element.scrollTop)).toBeGreaterThan(50);
  await page.keyboard.press('v'); await expect(tool('Select')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.down('Space'); await expect(viewer().locator('html')).toHaveAttribute('data-review-tool', 'hand');
  await page.keyboard.up('Space'); await expect(viewer().locator('html')).toHaveAttribute('data-review-tool', 'select');
  assert.equal(writes.length, 0, 'Tools never decide changes');
  await page.screenshot({ path: 'test-results/review-tools-desktop.png' });
  await page.getByRole('button', { name: 'Send instructions', exact: true }).click();
  await expect(notes()).toHaveCount(0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].notes[1].kind, 'delete'); assert.equal(sent[0].notes[1].comment, '');
  assert.equal(sent[0].notes[2].kind, 'point'); assert.match(sent[0].notes[2].quote, /‸/);
  assert.equal(sent[0].notes[4].stamp, 'Polish'); assert.ok(sent[0].notes[4].comment);
  assert.equal(sent[0].notes[6].kind, 'point'); assert.equal(sent[0].notes[6].stamp, 'Shorten');
  sent.length = 0;
  // Use real pointer gestures too: releasing beyond the last glyph and clicking
  // directly on text must both reach the magic pen, without obscuring old tags.
  await viewer().locator('#paper').evaluate(element => element.scrollTo(0, 0));
  await tool('Magic pen').click(); await tool('Magic pen').press('0');
  const glyph = viewer().locator('.change[data-stop="0"] .after .pdf-glyph').first();
  const glyphBox = await glyph.boundingBox();
  await page.mouse.move(glyphBox.x + 5, glyphBox.y + glyphBox.height / 2); await page.mouse.down();
  await page.mouse.move(glyphBox.x + glyphBox.width + 15, glyphBox.y + glyphBox.height / 2, { steps: 12 }); await page.mouse.up();
  await expect(page.locator('.stamp-wheel')).toBeVisible(); await page.keyboard.press('Escape');
  await glyph.click(); await expect(page.locator('.stamp-wheel')).toBeVisible(); await page.keyboard.press('Escape');
  await tool('Sticky note').click();
  await viewer().locator('.change[data-stop="0"] .after .review-point-capture').click({ position: { x: 30, y: 30 } });
  await expect(notes()).toHaveCount(1);
  const tag = viewer().locator('.change[data-stop="0"] .after .review-note-tag');
  for (const mode of ['Sticky note', 'Magic pen']) {
    if (mode === 'Magic pen') await tool(mode).click();
    await tag.click();
    await expect(notes()).toHaveCount(1);
    await expect(page.getByRole('textbox', { name: 'Comment 1', exact: true })).toBeFocused();
    await expect(page.locator('.stamp-wheel')).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Delete review note 1', exact: true }).click();
  await tool('Collapse marking tools').press('Space');
  await expect(rail()).toHaveAttribute('data-collapsed', 'true');
  await tool('Expand marking tools').click();
  const accept = viewer().locator('.change[data-stop="0"] .accept').first();
  // Observe native activation without deciding a change in the shared fixture.
  await accept.evaluate(element => element.addEventListener('click', event => { event.stopImmediatePropagation(); element.dataset.spaceClicked = 'true'; }, { once: true }));
  await accept.press('Space'); await expect(accept).toHaveAttribute('data-space-clicked', 'true');
  assert.equal(writes.length, 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: /^Review/ }).click();
  await expect(page.locator('.review-tools .markup-toggle')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mark region', exact: true })).toBeHidden();
  await expect(rail()).toBeVisible();
  await expect(rail()).toHaveAttribute('aria-orientation', 'horizontal');
  await expect(viewer().locator('.change.current .change-head .dock')).toBeVisible();
  await expect.poll(async () => {
    const dockBox = await viewer().locator('.change.current .change-head .dock').boundingBox();
    const railBox = await rail().boundingBox();
    return Boolean(dockBox && railBox && dockBox.y + dockBox.height <= railBox.y);
  }).toBe(true);
  await expect.poll(() => viewer().locator('.review-body').evaluate(element => parseFloat(getComputedStyle(element).marginLeft))).toBe(0);
  await tool('Collapse marking tools').click();
  await expect(rail()).toHaveAttribute('data-collapsed', 'true');
  await expect(tool('Expand marking tools')).toBeVisible();
  await tool('Expand marking tools').click();
  await expect(rail()).toHaveAttribute('data-collapsed', 'false');
  await expect(page.locator('html')).not.toHaveClass(/switching-workspace/);
  await page.screenshot({ path: 'test-results/review-tools-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await viewer().locator('.change.current').waitFor();
  console.log('PASS: Review marking tools, drafts, undo/redo, hand gestures, collapse and narrow layout');
}
