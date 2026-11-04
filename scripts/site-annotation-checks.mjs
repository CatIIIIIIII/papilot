import assert from 'node:assert/strict';

// Check the rendered targets, including while a drag is in flight. Merely
// checking the outer window misses annotations displaced by smooth scrolling.
export async function checkAnnotations(browser, origin) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    for (const [locale, width] of [['en', 1440], ['en', 1000], ['en', 390], ['zh-CN', 390]]) {
      console.log(`Checking annotations: ${locale}/${width}`);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(origin + (locale === 'en' ? '/' : `/${locale}/`));
      await page.evaluate(() => document.fonts.ready);
      const scene = page.locator('[data-scene=notes]');
      const showScene = () => scene.evaluate(app => scrollTo({ top: scrollY + app.getBoundingClientRect().top - 180, behavior: 'instant' }));
      await showScene();
      await page.mouse.move(0, 0);
      await page.waitForFunction(() => document.querySelector('[data-scene=notes] .app-cursor.shown'));
      // Scroll during the first glide, before the box opens.
      await page.evaluate(() => scrollBy({ top: 100, behavior: 'instant' }));
      const note = scene.locator('.demo-note');
      await note.waitFor({ state: 'visible' });
      await page.waitForTimeout(200);
      const aligned = async (label, figure = false) => {
        const geometry = await scene.evaluate((app, figure) => {
          const target = app.querySelector(figure ? '.scene-figure' : '.scene-text');
          const range = document.createRange(); range.selectNodeContents(target);
          const text = figure ? target.getBoundingClientRect() : range.getBoundingClientRect();
          const box = app.querySelectorAll('.demo-box')[figure ? 1 : 0].getBoundingClientRect();
          const note = app.querySelector('.demo-note').getBoundingClientRect();
          const pdf = app.querySelector('.app-pdf').getBoundingClientRect();
          return { text: text.toJSON(), box: box.toJSON(), note: note.toJSON(), pdf: pdf.toJSON() };
        }, figure);
        const { text, box, note, pdf } = geometry;
        const pad = figure ? 0 : 6;
        assert.ok(Math.abs(box.top - (text.top - pad)) < 2, `${label}: box follows target vertically: ${JSON.stringify(geometry)}`);
        assert.ok(Math.abs(box.bottom - (text.bottom + pad)) < 2, `${label}: box keeps target height`);
        assert.ok(box.left <= text.left + 1 && box.right >= text.right - 1, `${label}: box encloses target`);
        assert.ok(box.bottom <= pdf.bottom, `${label}: box stays out of the chat pane`);
        assert.ok(note.left >= pdf.left && note.right <= pdf.right && note.top >= pdf.top && note.bottom <= pdf.bottom, `${label}: note fits the PDF pane: ${JSON.stringify(geometry)}`);
      };
      await aligned(`${locale}/${width}/scroll`);
      // Reflow an already drawn annotation while its note is being typed.
      await page.setViewportSize({ width: width === 390 ? 320 : width - 160, height: 900 });
      await showScene();
      await page.waitForTimeout(200);
      await aligned(`${locale}/${width}/resize`);
      await note.waitFor({ state: 'hidden' });
      await note.waitFor({ state: 'visible' });
      await page.waitForTimeout(200);
      await aligned(`${locale}/${width}/figure`, true);
      await scene.screenshot({ path: `test-results/site/${locale}-${width}-annotations.png` });
    }
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
