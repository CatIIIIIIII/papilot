import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

// Paints pages within about a screen and a half of the viewport, two at a
// time, and frees them further away.
export function paintAppliedPages(container: HTMLElement, pdf: PDFDocumentProxy, root: HTMLElement | null) {
  const alive = new Map<number, { canvas?: HTMLCanvasElement; task?: RenderTask }>(), wanted = new Set<number>();
  let running = 0, stopped = false;
  const pages = () => Array.from(container.querySelectorAll<HTMLElement>(".applied-page"));
  const release = (index: number) => {
    const entry = alive.get(index);
    alive.delete(index);
    entry?.task?.cancel();
    if (entry?.canvas) { entry.canvas.remove(); entry.canvas.width = entry.canvas.height = 0; }
  };
  const pump = () => {
    while (!stopped && running < 2) {
      const middle = (root?.scrollTop ?? 0) + (root?.clientHeight ?? 0) / 2, list = pages(),
        next = [...wanted].filter((i) => !alive.has(i)).sort((a, b) => Math.abs(list[a].offsetTop - middle) - Math.abs(list[b].offsetTop - middle))[0];
      if (next === undefined) return;
      void draw(next, list[next]);
    }
  };
  const draw = async (index: number, element: HTMLElement) => {
    running++;
    const entry: { canvas?: HTMLCanvasElement; task?: RenderTask } = {};
    alive.set(index, entry);
    try {
      const page = await pdf.getPage(index + 1);
      if (stopped || alive.get(index) !== entry) return;
      const size = page.getViewport({ scale: 1 }),
        viewport = page.getViewport({ scale: (element.clientWidth * Math.min(window.devicePixelRatio || 1, 3)) / size.width }),
        canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.className = "applied-canvas";
      entry.task = page.render({ canvas, viewport });
      await entry.task.promise;
      if (stopped || alive.get(index) !== entry) { canvas.width = canvas.height = 0; return; }
      element.querySelectorAll("canvas").forEach((old) => { old.remove(); old.width = old.height = 0; });
      element.prepend(canvas);
      entry.canvas = canvas;
    } catch (failure) {
      if (!stopped && (failure as Error)?.name !== "RenderingCancelledException") console.error(failure);
      // Keep a failed page accounted for until it leaves the viewport.
      // Removing it here made pump immediately retry a persistent PDF or
      // canvas failure forever, starving the rest of the review.
      if (alive.get(index) === entry) entry.task = undefined;
    } finally {
      running--;
      pump();
    }
  };
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const index = Number((entry.target as HTMLElement).dataset.index);
      if (entry.isIntersecting) wanted.add(index);
      else { wanted.delete(index); release(index); }
    }
    pump();
  }, { root, rootMargin: "1200px 0px" });
  pages().forEach((page) => observer.observe(page));
  return () => {
    stopped = true;
    observer.disconnect();
    for (const entry of alive.values()) entry.task?.cancel();
  };
}
