import {
  Fragment,
  useEffect,
  useLayoutEffect,
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
import { cMapData } from "./pdf-cmaps.ts";

// Built assets share one folder, and a host such as Papilot serves the viewer
// under its own prefix: find the worker and CMaps next to this chunk, not at /assets.
const besideChunk = (url: string) =>
  import.meta.env.DEV ? url : new URL(url.split("/").pop()!, import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = besideChunk(worker);
const CMapData = cMapData(
  import.meta.glob<string>("../../node_modules/pdfjs-dist/cmaps/*.bcmap", {
    eager: true,
    import: "default",
    query: "?url&no-inline",
  }),
  besideChunk,
);

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

interface Loaded {
  pdf: PDFDocumentProxy;
  width: number;
  height: number;
  labels: string[] | null;
  // An earlier version, shown while the complete PDF compiles.
  partial: boolean;
}

export function FullPaper({
  url,
  passes,
  changes,
  render,
  scrollRoot,
  onReady,
  onUnavailable,
}: {
  url: string;
  passes?: string;
  changes: PlacedChange[];
  render: (block: ChangeBlock, index: number) => ReactNode;
  scrollRoot: RefObject<HTMLElement | null>;
  onReady: () => void;
  onUnavailable: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null),
    [error, setError] = useState(""),
    [started, setStarted] = useState(() => Date.now()),
    [now, setNow] = useState(() => Date.now()),
    shown = useRef<PDFDocumentProxy | null>(null),
    announced = useRef(false),
    // Where the change being reviewed was on screen before a newer version
    // replaced the pages, so that it stays there.
    anchor = useRef<{ stop: string; offset: number } | null>(null);
  useEffect(() => {
    let live = true;
    const stop = new AbortController(),
      tasks: ReturnType<typeof pdfjs.getDocument>[] = [];
    setLoaded(null);
    setError("");
    setStarted(Date.now());
    announced.current = false;
    const open = async (source: string, partial: boolean) => {
      const task = pdfjs.getDocument({ url: source, enableXfa: false, BinaryDataFactory: CMapData });
      tasks.push(task);
      const pdf = await task.promise,
        first = (await pdf.getPage(1)).getViewport({ scale: 1 }),
        labels = await pdf.getPageLabels().catch(() => null);
      if (!live) return;
      const root = scrollRoot.current,
        current = root?.querySelector<HTMLElement>(".paper .change.current");
      anchor.current = root && current?.dataset.stop
        ? { stop: current.dataset.stop, offset: current.getBoundingClientRect().top - root.getBoundingClientRect().top }
        : null;
      setLoaded({ pdf, width: first.width, height: first.height, labels, partial });
    };
    void (async () => {
      // Earlier versions while the complete PDF compiles, such as the
      // chapters the round compiled and each TeX pass of the whole paper, so
      // the changes show long before every page number has settled.
      for (let after = 0; passes && live; ) {
        const response = await fetch(`${passes}?after=${after}`, { signal: stop.signal }),
          next = (await response.json()) as { pass?: number | null; error?: string };
        if (!response.ok) throw new Error(next.error || `HTTP ${response.status}`);
        if (next.pass === null) break;
        if (typeof next.pass === "number" && next.pass > after) {
          after = next.pass;
          // A version that cannot be shown is skipped for the next one.
          await open(`${url}${url.includes("?") ? "&" : "?"}pass=${after}`, true).catch(() => undefined);
        }
      }
      if (live) await open(url, false);
    })().catch((failure: Error) => {
      if (live) setError(failure.message);
    });
    return () => {
      live = false;
      stop.abort();
      for (const task of tasks) void task.destroy();
    };
  }, [url, passes]);
  // A newer version replaces the one on screen once its pages are in place.
  useEffect(() => {
    const previous = shown.current;
    shown.current = loaded?.pdf ?? null;
    if (previous && previous !== shown.current) void previous.loadingTask.destroy();
  }, [loaded]);
  useEffect(() => {
    if ((loaded && !loaded.partial) || error) return;
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
  const preparing = (
    <>
      {t("Preparing the full PDF…")} <span className="paper-clock">{clock(now - started)}</span>
    </>
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
        <p>{preparing}</p>
      </div>
    );
  return (
    <>
      {loaded?.partial && (
        <div className="paper-updating" role="status">
          <span className="pulse" />
          <span>{preparing}</span>
        </div>
      )}
      <Pages
        paper={paper}
        render={render}
        scrollRoot={scrollRoot}
        onReady={() => {
          if (!announced.current) {
            announced.current = true;
            onReady();
            return;
          }
          // Later versions keep the change being reviewed where it was.
          const root = scrollRoot.current,
            kept = anchor.current,
            current = kept && root?.querySelector<HTMLElement>(`.paper [data-stop="${kept.stop}"]`);
          if (root && kept && current)
            root.scrollTop += current.getBoundingClientRect().top - root.getBoundingClientRect().top - kept.offset;
        }}
      />
    </>
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
  // The pages exist now: the selected change can be scrolled to, before
  // they are painted.
  useLayoutEffect(() => ready.current(), [paper]);
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
  const free = (canvas: HTMLCanvasElement) => {
    canvas.remove();
    canvas.width = canvas.height = 0;
  };
  // Pages painted from an earlier version of the PDF stay until this one's
  // replace them, so a newer version comes in without the pages blanking.
  const release = (index: number) => {
    const entry = alive.get(index);
    alive.delete(index);
    entry?.task?.cancel();
    entry?.canvases.forEach(free);
    pages()[index]?.querySelectorAll("canvas").forEach(free);
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
      if (stopped || alive.get(index) !== entry) return;
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
      if (stopped || alive.get(index) !== entry) return;
      for (const slice of slices) {
        const top = Math.round(Number(slice.dataset.top) * scale),
          bottom = Math.min(source.height, Math.round(Number(slice.dataset.bottom) * scale));
        if (bottom - top < 1) continue;
        const canvas = document.createElement("canvas");
        canvas.width = source.width;
        canvas.height = bottom - top;
        canvas.getContext("2d")!.drawImage(source, 0, top, source.width, bottom - top, 0, 0, source.width, bottom - top);
        slice.querySelectorAll("canvas").forEach(free);
        slice.append(canvas);
        entry.canvases.push(canvas);
      }
      source.width = source.height = 0;
    } catch (failure) {
      if (!stopped && (failure as Error)?.name !== "RenderingCancelledException") console.error(failure);
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
    // Repainted at the new width over the current pages.
    for (const [index, entry] of [...alive]) {
      entry.task?.cancel();
      alive.delete(index);
    }
    pump();
  });
  resized.observe(container);
  return () => {
    stopped = true;
    observer.disconnect();
    resized.disconnect();
    // The canvases stay for the next version, or go with the page.
    for (const entry of alive.values()) entry.task?.cancel();
  };
}
