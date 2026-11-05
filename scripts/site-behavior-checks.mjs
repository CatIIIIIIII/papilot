import assert from 'node:assert/strict';

// Uses the same offline provider as check-site-analytics; only real UI input
// exercises action hooks. Clock control keeps visibility/engagement checks fast.
export async function checkSiteBehavior(context) {
  const page = await context.newPage();
  const events = name => page.evaluate(name => window.statistics.filter(event => event.name === name), name);
  const privacy = await context.newPage();
  await privacy.goto('https://papilot.ai/privacy/');
  const setEnabled = async enabled => {
    const button = privacy.locator(enabled ? '#statistics-enable' : '#statistics-disable');
    if (await button.isVisible()) await button.click();
    await page.waitForFunction(expected => window.papilotStatistics.enabled() === expected, enabled);
    if (enabled) await page.waitForFunction(() => window.statistics.some(event => !event.name));
  };
  const allow = () => setEnabled(true);
  const stop = () => setEnabled(false);
  const downloadLink = async selector => {
    const download = page.waitForEvent('download');
    await page.locator(selector).click();
    await (await download).cancel();
  };
  try {
    await page.goto('https://papilot.ai/');
    await stop();
    // A clipboard operation that began while disabled must not become an event.
    await page.evaluate(() => { navigator.clipboard.writeText = () => new Promise(resolve => { window.finishCopy = resolve; }); });
    await page.locator('.hero [data-copy]').click();
    await allow();
    await page.evaluate(() => window.finishCopy());
    assert.deepEqual(await events('copy_install'), []);
    await page.locator('.hero [data-copy]').click();
    await stop();
    await allow();
    await page.evaluate(() => window.finishCopy());
    assert.deepEqual(await events('copy_install'), [], 'an old collection period cannot leak a delayed result into a new one');

    await page.locator('.nav a[href="#features"]').click();
    assert.deepEqual((await events('navigation')).at(-1).data, { locale: 'en', target: 'features', placement: 'header' });
    await page.locator('#download-button').focus();
    await page.keyboard.press('ArrowDown');
    assert.deepEqual((await events('menu_open')).at(-1).data, { locale: 'en', menu: 'download', placement: 'hero' });
    await page.keyboard.press('Escape');
    await page.locator('#download-button').click();
    await downloadLink('#download-list a[href$="/releases/latest"]');
    assert.deepEqual((await events('outbound_click')).at(-1).data, { locale: 'en', destination: 'releases', placement: 'hero' });
    assert.deepEqual(await events('download_click'), [], 'all downloads is a destination click, not an installer click');
    await downloadLink('.topbar a[href="https://github.com/cu1ch3n/papilot"]');
    assert.deepEqual((await events('outbound_click')).at(-1).data, { locale: 'en', destination: 'github', placement: 'header' });
    await downloadLink('.footer a[href$="#readme"]');
    assert.deepEqual((await events('outbound_click')).at(-1).data, { locale: 'en', destination: 'readme', placement: 'footer' });

    await page.locator('#theme-button').click();
    assert.equal((await events('theme_change')).at(-1).data.theme, await page.locator('html').getAttribute('data-theme'));
    const themeCount = (await events('theme_change')).length;
    await page.evaluate(() => document.getElementById('theme-button').click());
    assert.equal((await events('theme_change')).length, themeCount, 'programmatic clicks do not masquerade as visitor actions');
    const hero = page.locator('.hero .review-change');
    await hero.locator('.review-accept').click();
    await hero.press('Enter');
    await hero.locator('.review-reject').click();
    await hero.press('Space');
    await hero.locator('.review-latex').click();
    await hero.locator('.review-latex').click();
    assert.deepEqual((await events('demo_interaction')).map(event => event.data.action), ['accept', 'reopen', 'reject', 'reopen', 'source_open', 'source_close']);
    await page.evaluate(() => document.querySelector('.hero .review-accept').click());
    assert.equal((await events('demo_interaction')).length, 6);
    await page.locator('#lang-button').click();
    assert.deepEqual((await events('menu_open')).at(-1).data, { locale: 'en', menu: 'language', placement: 'header' });
    const languageRequest = page.waitForRequest(request => request.url().endsWith('/api/send') && request.postDataJSON()?.name === 'language_change');
    await page.locator('#lang-list a[lang=fr]').click();
    assert.deepEqual((await languageRequest).postDataJSON().data, { locale: 'en', language: 'fr' });
    await page.waitForURL('https://papilot.ai/fr/');
    await page.waitForFunction(() => window.statistics.some(event => !event.name));
    const beforeInvalid = (await events('outbound_click')).length;
    await page.evaluate(() => window.umami.track('outbound_click', { destination: 'private@example.org', placement: 'footer' }));
    assert.equal((await events('outbound_click')).length, beforeInvalid, 'source metadata is restricted to fixed categories');
    await page.evaluate(() => window.umami.track('theme_change', { theme: 'dark', input: 'private@example.org', url: '/secret' }));
    assert.deepEqual((await events('theme_change')).at(-1).data, { locale: 'fr', theme: 'dark' });

    // Advance visible time independently from background time and scrolling.
    await page.evaluate(() => localStorage.clear());
    const base = new Date();
    await page.clock.install({ time: base });
    await page.goto('https://papilot.ai/');
    await page.waitForFunction(() => window.statistics.some(event => !event.name));
    await page.clock.pauseAt(new Date(base.getTime() + 1000));
    await page.evaluate(() => {
      window.testHidden = false;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.testHidden });
    });
    await page.clock.runFor(2000);
    assert.equal((await events('section_view')).filter(event => event.data.section === 'hero').length, 1);
    await page.clock.runFor(11000);
    assert.deepEqual(await events('engaged_time'), []);
    await page.evaluate(() => { window.testHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    await page.clock.fastForward(120000);
    assert.deepEqual(await events('engaged_time'), [], 'background time is not counted');
    await page.evaluate(() => { window.testHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    await page.clock.runFor(2000);
    assert.deepEqual((await events('engaged_time')).map(event => event.data.seconds), [15]);
    await page.clock.fastForward(105000);
    assert.deepEqual((await events('engaged_time')).map(event => event.data.seconds), [15, 30, 60, 120]);
    await page.clock.fastForward(30000);
    assert.equal((await events('engaged_time')).length, 4, 'each milestone occurs once');
    assert.equal((await events('section_view')).filter(event => event.data.section === 'hero').length, 1, 'section exposure is deduplicated');
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await page.clock.runFor(2500);
    assert.deepEqual((await events('scroll_depth')).map(event => event.data.percent), [25, 50, 75, 100]);
    await page.evaluate(() => scrollTo(0, 0));
    await page.clock.runFor(500);
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await page.clock.runFor(500);
    assert.equal((await events('scroll_depth')).length, 4, 'scroll milestones are not repeated');
    await page.clock.resume();
    await stop();
    const afterWithdrawal = await page.evaluate(() => window.statistics.length);
    await page.clock.fastForward(180000);
    assert.equal(await page.evaluate(() => window.statistics.length), afterWithdrawal, 'withdrawal stops timed and exposure events');

    // A late re-enable starts from the current viewport, without backfilling depth.
    await page.clock.resume();
    await page.evaluate(() => localStorage.clear());
    await page.goto('https://papilot.ai/');
    await stop();
    await page.goto('https://papilot.ai/');
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    const before = await page.evaluate(() => window.statistics.length);
    await page.clock.fastForward(20000);
    assert.equal(await page.evaluate(() => window.statistics.length), before, 'scrolling and waiting while disabled produce no events');
    await allow();
    await page.clock.runFor(2500);
    assert.deepEqual(await events('scroll_depth'), [], 'already passed depths are not replayed');
    assert.equal((await events('section_view')).some(event => event.data.section === 'hero'), false, 'offscreen sections are not replayed');
    console.log('Site behavior checks passed: real navigation, menus, outbound categories, demo actions, preferences, delayed clipboard gating, visibility time, exposure/depth deduplication and withdrawal.');
  } finally {
    await context.close();
  }
}
