import assert from 'node:assert/strict';
import { expect } from '../engine/node_modules/@playwright/test/index.mjs';

// Exercise the real PdfView and PDF.js worker in the built static playground.
// Holding the first GetPage reply makes navigating away during initialization
// deterministic; releasing it during Terminate reproduces PDF.js's actual
// "Transport destroyed" rejection, without fabricating or filtering that error.
export async function checkPdfLifecycle(browser, origin) {
  for (const scenario of ['cancel', 'failure']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' });
    await context.addInitScript(() => {
      const NativeWorker = window.Worker;
      const state = window.pdfLifecycle = { held: false, released: 0, terminated: 0, releaseFailure: null };
      let armed = true;
      window.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args);
          let request, held;
          const release = failure => {
            const data = held; held = undefined; request = undefined;
            state.released++;
            this.dispatchEvent(new MessageEvent('message', { data: failure ? {
              ...data, callback: 2, reason: { name: 'UnknownErrorException', message: 'First page unavailable (test)', details: '' },
            } : data }));
          };
          this.addEventListener('message', event => {
            if (!request || !event.data.callback || event.data.callbackId !== request.callbackId || event.data.targetName !== request.sourceName) return;
            event.stopImmediatePropagation();
            held = event.data;
            state.held = true;
            state.releaseFailure = () => release(true);
          });
          const send = this.postMessage.bind(this);
          this.postMessage = (...args) => {
            const [data] = args;
            if (armed && data.action === 'GetPage' && data.data.pageIndex === 0) {
              armed = false;
              request = data;
            }
            if (data.action === 'Terminate') {
              state.terminated++;
              if (held) release(false);
            }
            return send(...args);
          };
        }
      };
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(origin + '/demo/');
      await page.waitForFunction(() => window.pdfLifecycle.held);
      if (scenario === 'failure') {
        await page.evaluate(() => window.pdfLifecycle.releaseFailure());
        await expect(page.locator('.pdf-view [role="alert"]')).toContainText('First page unavailable (test)');
        await expect.poll(() => page.evaluate(() => window.pdfLifecycle.terminated)).toBe(1);
      }
      await page.locator('.sidebar').getByRole('button', { name: /^Version Management/ }).click();
      await expect(page.locator('.git-workspace')).toBeVisible();
      await expect(page.locator('.pdf-view')).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => window.pdfLifecycle.released)).toBe(1);
      await expect.poll(() => page.evaluate(() => window.pdfLifecycle.terminated)).toBe(1);
      // A fresh reader still renders real text and a nonempty canvas after the
      // cancelled/failed load. No stale result reattaches the disposed reader.
      await page.getByRole('button', { name: 'Manuscript', exact: true }).click();
      await expect(page.locator('.page[data-page-number="1"] .textLayer span').first()).toBeVisible();
      await expect.poll(() => page.locator('.page[data-page-number="1"] canvas').evaluateAll(canvases => canvases.some(canvas => canvas.width > 0 && canvas.height > 0))).toBe(true);
      assert.deepEqual(errors, [], `${scenario}: PDF lifecycle must not cause unhandled browser errors`);
    } finally {
      await context.close();
    }
  }
  console.log('PASS: pending first-page cancellation, visible initialization failure, worker disposal and reader recovery.');
}
