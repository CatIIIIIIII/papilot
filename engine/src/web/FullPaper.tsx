import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import worker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { ChangeBlock, Strip } from "../types.ts";
import { t } from "./i18n.ts";
import type { PlacedChange } from "./paper.ts";

// Built assets share one folder, and a host such as Papilot serves the viewer
// under its own prefix: find the worker next to this chunk, not at /assets.
pdfjs.GlobalWorkerOptions.workerSrc = import.meta.env.DEV
  ? worker
  : new URL(worker.split("/").pop()!, import.meta.url).href;

// The whole paper with its changes in place: the new PDF's pages, opened up
// where a change's new lines are, and that change shown there as in the
// changes view, old lines above new. Pages are painted only near the
// viewport, so a long thesis scrolls like a short paper.
interface Cut {
  top: number;
  bottom: number;
  // Changes shown at this cut: the one whose new lines start here, and
  // changes without new lines of their own that follow it.
  shown: PlacedChange[];
}
interface Paper {
  pdf: PDFDocumentProxy;
  width: number;
  height: number;
  pages: Cut[][];
  before: PlacedChange[];
}

// The page of this PDF that shows a strip of the round's PDF. A round may
// compile only the changed chapters, so pages are matched by their labels,
// moving forward through the paper.
function locator(count: number, labels: string[] | null) {
  let cursor = 0;
  return (strip: Strip) => {
    if (!labels) return strip.page - 1 < count ? strip.page - 1 : -1;
    for (const from of [cursor, 0]) {
      const found = labels.indexOf(strip.label, from);
      if (found >= 0) return (cursor = found);
    }
    return -1;
  };
}

function plan(count: number, labels: string[] | null, changes: PlacedChange[]) {
  const pages: Cut[][] = Array.from({ length: count }, () => []),
    before: PlacedChange[] = [],
    find = locator(count, labels);
  let last: Cut | null = null;
  for (const change of changes) {
    const spots = change.block.after.map((strip) => ({ strip, page: strip.top === undefined ? -1 : find(strip) }));
    if (!spots.length || spots.some((s) => s.page < 0)) {
      // No new lines here (a deletion), or none this PDF has: after the
      // previous change, or before the paper when it is the first.
      if (last) last.shown.push(change);
      else before.push(change);
      continue;
    }
    for (const [k, { strip, page }] of spots.entries()) {
      const cut: Cut = { top: strip.top!, bottom: strip.top! + strip.height, shown: k ? [] : [change] };
      pages[page].push(cut);
      if (!k) last = cut;
    }
  }
  for (const cuts of pages) {
    cuts.sort((a, b) => a.top - b.top);
    for (let i = 1; i < cuts.length; i++) {
      cuts[i].top = Math.max(cuts[i].top, cuts[i - 1].bottom);
      cuts[i].bottom = Math.max(cuts[i].bottom, cuts[i].top);
    }
  }
  return { pages, before };
}

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export function FullPaper({
  url,
  changes,
  render,
  scrollRoot,
  onReady,
  onUnavailable,
}: {
  url: string;
  changes: PlacedChange[];
  render: (block: ChangeBlock, index: number) => ReactNode;
  scrollRoot: RefObject<HTMLElement | null>;
  onReady: () => void;
  onUnavailable: () => void;
}) {
  const [loaded, setLoaded] = useState<{ pdf: PDFDocumentProxy; width: number; height: number; labels: string[] | null } | null>(null),
    [error, setError] = useState(""),
    [started] = useState(() => Date.now()),
    [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let live = true;
    setLoaded(null);
    setError("");
    const task = pdfjs.getDocument({ url, enableXfa: false });
    task.promise.then(
      async (pdf) => {
        const first = (await pdf.getPage(1)).getViewport({ scale: 1 }),
          labels = await pdf.getPageLabels().catch(() => null);
        if (live) setLoaded({ pdf, width: first.width, height: first.height, labels });
      },
      (failure: Error) => {
        if (live) setError(failure.message);
      },
    );
    return () => {
      live = false;
      void task.destroy();
    };
  }, [url]);
  useEffect(() => {
    if (loaded || error) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [loaded, error]);
  const paper = useMemo<Paper | null>(
    () =>
      loaded && {
        pdf: loaded.pdf,
        width: loaded.width,
        height: loaded.height,
        ...plan(loaded.pdf.numPages, loaded.labels, changes),
      },
    [loaded, changes],
  );
  if (error)
    return (
      <div className="paper-status" role="alert">
        <p>{t("The full PDF could not be loaded.")}</p>
        <button className="ghost" onClick={onUnavailable}>
          {t("Changes")}
        </button>
      </div>
    );
  if (!paper)
    return (
      <div className="paper-status" role="status">
        <div className="pulse" />
        <p>
          {t("Preparing the full PDF…")} <span className="paper-clock">{clock(now - started)}</span>
        </p>
      </div>
    );
  return (
    <Pages paper={paper} render={render} scrollRoot={scrollRoot} onReady={onReady} />
  );
}

function Pages({
  paper,
  render,
  scrollRoot,
  onReady,
}: {
  paper: Paper;
  render: (block: ChangeBlock, index: number) => ReactNode;
  scrollRoot: RefObject<HTMLElement | null>;
  onReady: () => void;
}) {
  const box = useRef<HTMLDivElement>(null),
    ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => paint(box.current!, paper, scrollRoot.current), [paper, scrollRoot]);
  // The pages exist now: the selected change can be scrolled to.
  useEffect(() => ready.current(), [paper]);
  const slice = (page: number, top: number, bottom: number) =>
    bottom - top > 0.5 && (
      <div className="paper-context" key={`${page}:${top}`}>
        <div
          className="paper-slice"
          data-top={top}
          data-bottom={bottom}
          style={{ aspectRatio: `${paper.width} / ${bottom - top}` }}
        />
      </div>
    );
  return (
    <div className="paper" ref={box}>
      {paper.before.map((c) => (
        <Fragment key={c.index}>{render(c.block, c.index)}</Fragment>
      ))}
      {paper.pages.map((cuts, page) => {
        let cursor = 0;
        const parts: ReactNode[] = [];
        for (const cut of cuts) {
          parts.push(slice(page, cursor, cut.top));
          for (const c of cut.shown) parts.push(<Fragment key={c.index}>{render(c.block, c.index)}</Fragment>);
          cursor = cut.bottom;
        }
        parts.push(slice(page, cursor, paper.height));
        return (
          <section className="paper-page" data-page={page} key={page}>
            {parts}
          </section>
        );
      })}
    </div>
  );
}

// Paints each page into its slices while it is within about a screen and a
// half of the viewport, and frees the canvases again further away.
function paint(container: HTMLElement, paper: Paper, root: HTMLElement | null) {
  const alive = new Map<number, { canvases: HTMLCanvasElement[]; task?: RenderTask }>(),
    wanted = new Set<number>();
  let running = 0,
    width = container.clientWidth,
    stopped = false;
  const pages = () => Array.from(container.querySelectorAll<HTMLElement>(".paper-page"));
  const release = (index: number) => {
    const entry = alive.get(index);
    if (!entry) return;
    alive.delete(index);
    entry.task?.cancel();
    for (const canvas of entry.canvases) {
      canvas.remove();
      canvas.width = canvas.height = 0;
    }
  };
  const pump = () => {
    while (!stopped && running < 2) {
      const middle = (root?.scrollTop ?? 0) + (root?.clientHeight ?? 0) / 2,
        list = pages(),
        next = [...wanted]
          .filter((i) => !alive.has(i))
          .sort((a, b) => Math.abs(list[a].offsetTop - middle) - Math.abs(list[b].offsetTop - middle))[0];
      if (next === undefined) return;
      void draw(next, list[next]);
    }
  };
  const draw = async (index: number, element: HTMLElement) => {
    running++;
    const entry: { canvases: HTMLCanvasElement[]; task?: RenderTask } = { canvases: [] };
    alive.set(index, entry);
    try {
      const page = await paper.pdf.getPage(index + 1);
      if (alive.get(index) !== entry) return;
      const slices = Array.from(element.querySelectorAll<HTMLElement>(".paper-slice")),
        cssWidth = slices[0]?.clientWidth || element.clientWidth,
        size = page.getViewport({ scale: 1 }),
        scale = (cssWidth * Math.min(window.devicePixelRatio || 1, 3)) / size.width,
        viewport = page.getViewport({ scale }),
        source = document.createElement("canvas");
      source.width = Math.floor(viewport.width);
      source.height = Math.floor(viewport.height);
      entry.task = page.render({ canvas: source, viewport });
      await entry.task.promise;
      if (alive.get(index) !== entry) return;
      for (const slice of slices) {
        const top = Math.round(Number(slice.dataset.top) * scale),
          bottom = Math.min(source.height, Math.round(Number(slice.dataset.bottom) * scale));
        if (bottom - top < 1) continue;
        const canvas = document.createElement("canvas");
        canvas.width = source.width;
        canvas.height = bottom - top;
        canvas.getContext("2d")!.drawImage(source, 0, top, source.width, bottom - top, 0, 0, source.width, bottom - top);
        slice.append(canvas);
        entry.canvases.push(canvas);
      }
      source.width = source.height = 0;
    } catch (failure) {
      if ((failure as Error)?.name !== "RenderingCancelledException") console.error(failure);
      if (alive.get(index) === entry) alive.delete(index);
    } finally {
      running--;
      pump();
    }
  };
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const index = Number((entry.target as HTMLElement).dataset.page);
        if (entry.isIntersecting) wanted.add(index);
        else {
          wanted.delete(index);
          release(index);
        }
      }
      pump();
    },
    { root, rootMargin: "1200px 0px" },
  );
  pages().forEach((page) => observer.observe(page));
  // A wider column needs sharper pages.
  const resized = new ResizeObserver(() => {
    if (Math.abs(container.clientWidth - width) < 1) return;
    width = container.clientWidth;
    for (const index of [...alive.keys()]) release(index);
    pump();
  });
  resized.observe(container);
  return () => {
    stopped = true;
    observer.disconnect();
    resized.disconnect();
    for (const index of [...alive.keys()]) release(index);
  };
}
