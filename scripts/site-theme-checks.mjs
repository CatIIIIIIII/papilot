import assert from 'node:assert/strict';

export async function checkSiteTheme(browser, origin, watch = () => {}) {
  const change = '.hero .app-window .review-change';
  // The entire product drawing follows the resolved theme, including paper,
  // chat, Git, popovers and the small comparison windows.
  const night = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', reducedMotion: 'reduce' });
  const nightPage = await night.newPage();
  watch(nightPage);
  await nightPage.goto(origin + '/');
  const drawingTheme = async (page, dark) => {
    const scheme = dark ? 'dark' : 'light';
    const surfaces = [
      ['body', dark ? 'rgb(17, 18, 20)' : 'rgb(255, 255, 255)'],
      ['.app-window, .mini, .app-chat, .app-git, .demo-note, .mini-comment', dark ? 'rgb(38, 39, 43)' : 'rgb(255, 255, 255)'],
      ['.review-page, .mini-page', dark ? 'rgb(41, 41, 41)' : 'rgb(255, 255, 255)'],
      ['.app-pdf', dark ? 'rgb(30, 31, 34)' : 'rgb(236, 238, 241)'],
      ['.review-head, .mini-head, .chat-pending', dark ? 'rgb(42, 43, 47)' : 'rgb(250, 250, 250)'],
      ['.chat-bubble', dark ? 'rgb(48, 49, 53)' : 'rgb(244, 244, 244)'],
    ];
    for (const [selector, background] of surfaces) {
      const styles = await page.locator(selector).evaluateAll(nodes => nodes.map(el => {
        const style = getComputedStyle(el);
        return { background: style.backgroundColor, scheme: style.colorScheme };
      }));
      assert.ok(styles.length, `${selector} is covered`);
      for (const style of styles) assert.deepEqual(style, { background, scheme }, `${scheme}: ${selector}`);
    }
    for (const selector of ['.review-page', '.mini-page', '.chat-bubble', '.demo-note', '.git-typed']) {
      const colors = await page.locator(selector).evaluateAll(nodes => nodes.map(el => getComputedStyle(el).color));
      for (const color of colors) {
        const channels = color.match(/\d+/g).slice(0, 3).map(Number);
        assert.ok(channels.every(channel => dark ? channel > 180 : channel < 60), `${scheme}: readable ${selector} ink (${color})`);
      }
    }
  };
  await drawingTheme(nightPage, true);
  assert.equal(await nightPage.locator('#theme-button').getAttribute('aria-pressed'), 'true');
  await nightPage.emulateMedia({ colorScheme: 'light' });
  await drawingTheme(nightPage, false);
  await nightPage.emulateMedia({ colorScheme: 'dark' });
  await drawingTheme(nightPage, true);
  await nightPage.locator('#theme-button').click();
  await drawingTheme(nightPage, false);
  await nightPage.reload();
  await drawingTheme(nightPage, false);
  assert.equal(await nightPage.locator('#theme-button').getAttribute('aria-pressed'), 'false', 'the choice is kept');
  await nightPage.screenshot({ path: 'test-results/site/light-chosen.png' });
  await nightPage.locator('#theme-button').click();
  await nightPage.emulateMedia({ colorScheme: 'light' });
  await nightPage.reload();
  await drawingTheme(nightPage, true);
  // Review controls keep dark surfaces after opening source or deciding.
  await nightPage.locator(`${change} .review-latex`).click();
  assert.equal(await nightPage.locator(`${change} .review-source`).isVisible(), true);
  for (const [selector, background] of [['.before', 'rgb(67, 44, 48)'], ['.after', 'rgb(40, 57, 45)'], ['.review-source del', 'rgb(70, 41, 46)'], ['.review-source ins', 'rgb(36, 58, 47)']]) {
    const backgrounds = await nightPage.locator(`${change} ${selector}`).evaluateAll(nodes => nodes.map(el => getComputedStyle(el).backgroundColor));
    assert.ok(backgrounds.length);
    for (const value of backgrounds) assert.equal(value, background, `dark ${selector}`);
  }
  await nightPage.screenshot({ path: 'test-results/site/dark.png' });
  await nightPage.locator(`${change} .review-accept`).click();
  await nightPage.waitForFunction(selector => getComputedStyle(document.querySelector(selector)).backgroundColor === 'rgb(41, 41, 41)', `${change} .after`);
  for (const selector of ['#why', '[data-scene=notes]', '[data-scene=revise]', '[data-scene=record]']) {
    await nightPage.locator(selector).screenshot({ animations: 'disabled', style: '.topbar{visibility:hidden!important}', path: `test-results/site/dark-${selector.replace(/[^a-z]/g, '')}.png` });
  }
  await nightPage.setViewportSize({ width: 390, height: 844 });
  await nightPage.goto(origin + '/zh-CN/');
  await drawingTheme(nightPage, true);
  assert.equal(await nightPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'dark mobile layout fits');
  await nightPage.screenshot({ path: 'test-results/site/dark-mobile.png' });
  const staticDark = await browser.newContext({ javaScriptEnabled: false, colorScheme: 'dark' });
  const staticDarkPage = await staticDark.newPage();
  await staticDarkPage.goto(origin);
  await drawingTheme(staticDarkPage, true);
  await staticDark.close();
  await night.close();
  console.log('Site themes passed: system changes, saved overrides, all demo surfaces, review interactions, dark mobile and no-JS.');
}
