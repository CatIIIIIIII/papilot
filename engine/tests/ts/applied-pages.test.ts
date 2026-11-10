import { afterEach, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { paintAppliedPages } from "../../src/web/applied-pages.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("leaves a failed page idle, paints other pages, and retries after the page reenters the viewport", async () => {
  let observe!: (entries: { target: unknown; isIntersecting: boolean }[]) => void;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: typeof observe) { observe = callback; }
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal("window", { devicePixelRatio: 1 });
  vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, className: "", remove() {} }) });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const pages = [0, 1].map((index) => ({
    dataset: { index: String(index) }, offsetTop: index * 800, clientWidth: 600,
    querySelectorAll: () => [], prepend: vi.fn(),
  }));
  const container = { querySelectorAll: () => pages } as unknown as HTMLElement;
  let failedCalls = 0, recovered = false;
  const pdf = {
    getPage: vi.fn(async (number: number) => {
      if (number === 1 && !recovered) {
        // Bound the fake failure so the broken implementation cannot starve
        // the test runner forever with its immediate retry loop.
        if (++failedCalls >= 10) return new Promise(() => {});
        throw new Error("This page cannot be rendered");
      }
      return {
        getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
        render: () => ({ promise: Promise.resolve(), cancel() {} }),
      };
    }),
  } as unknown as PDFDocumentProxy;
  const stop = paintAppliedPages(container, pdf, null);
  try {
    observe(pages.map((target) => ({ target, isIntersecting: true })));
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(failedCalls).toBe(1);
    expect(pages[1].prepend).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledOnce();
    recovered = true;
    observe([{ target: pages[0], isIntersecting: false }]);
    observe([{ target: pages[0], isIntersecting: true }]);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(pages[0].prepend).toHaveBeenCalledOnce();
  } finally { stop(); }
});
