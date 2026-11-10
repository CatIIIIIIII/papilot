import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import worker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { t } from "./i18n.ts";
import { cMapData } from "./pdf-cmaps.ts";
import { paintAppliedPages } from "./applied-pages.ts";

const besideChunk = (url: string) =>
  import.meta.env.DEV ? url : new URL(url.split("/").pop()!, import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = besideChunk(worker);
const CMapData = cMapData(
  import.meta.glob<string>("../../node_modules/pdfjs-dist/cmaps/*.bcmap", { eager: true, import: "default", query: "?url&no-inline" }),
  besideChunk,
);

// The paper as decided so far: its pages, with their text for selecting and
// notes, painted near the viewport. A newer version replaces the pages once
// it has loaded, keeping the place being read, but never under a selection
// the author is making: it waits until that ends.

interface Page { width: number; height: number; label: string }
interface Shown { url: string; key: string; pdf: PDFDocumentProxy; pages: Page[] }
interface Line { text: string; glyphs: { text: string; rect: [number, number, number, number] }[] }

let context: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();
function measure(text: string) {
  if (widths.has(text)) return widths.get(text)!;
  context ??= document.createElement("canvas").getContext("2d");
  if (!context) return 1;
  context.font = '100px "Times New Roman", serif';
  const measured = context.measureText(text).width / 100;
  widths.set(text, measured);
  return measured || 1;
}
function glyphStyle([x0, y0, x1, y1]: [number, number, number, number], text: string, page: Page): CSSProperties {
  const height = Math.max(y1 - y0, 0.1);
  return {
    left: `${(100 * x0) / page.width}%`,
    top: `${(100 * y0) / page.height}%`,
    fontSize: `${(100 * height) / page.width}cqw`,
    transform: `scaleX(${(x1 - x0) / (height * measure(text))})`,
  };
}
// pdf.js text runs, top-left based, one line per baseline.
async function textLines(pdf: PDFDocumentProxy, index: number): Promise<Line[]> {
  const page = await pdf.getPage(index + 1), viewport = page.getViewport({ scale: 1 }),
    content = await page.getTextContent();
  const lines: Line[] = [];
  let last: { y: number; line: Line } | null = null;
  for (const item of content.items) {
    if (!("str" in item) || !item.str.trim()) continue;
    const [, , c, d, e, f] = item.transform, size = Math.hypot(c, d) || 1,
      [x, y] = viewport.convertToViewportPoint(e, f),
      rect: [number, number, number, number] = [x, y - size * 0.85, x + item.width, y + size * 0.2];
    if (!last || Math.abs(last.y - y) > size * 0.5) {
      last = { y, line: { text: "", glyphs: [] } };
      lines.push(last.line);
    }
    last.line.glyphs.push({ text: item.str, rect });
    last.line.text += (last.line.text ? " " : "") + item.str;
  }
  return lines;
}

function PageText({ shown, index }: { shown: Shown; index: number }) {
  const [lines, setLines] = useState<Line[] | null>(null), page = shown.pages[index];
  useEffect(() => {
    let live = true;
    void textLines(shown.pdf, index).then((value) => { if (live) setLines(value); }, () => undefined);
    return () => { live = false; };
  }, [shown, index]);
  if (!lines?.length) return null;
  return (
    <div className="pdf-text" role="region" aria-label={t("PDF page {page}", { page: page.label })}>
      {lines.map((line, i) => (
        <span className="pdf-text-line" key={i}>
          {line.glyphs.map((glyph, j) => (
            <span key={j} className="pdf-glyph" style={glyphStyle(glyph.rect, glyph.text, page)}>
              {glyph.text}
            </span>
          ))}
          {"\n"}
        </span>
      ))}
    </div>
  );
}

export function AppliedPaper({ url, buildKey, scrollRoot, status }: {
  url: string;
  /** The build `url` shows; notes on its pages name it. */
  buildKey: string;
  scrollRoot: RefObject<HTMLElement | null>;
  /** Shown beside the pages while they are not the current decisions. */
  status?: React.ReactNode;
}) {
  const [shown, setShown] = useState<Shown | null>(null), [error, setError] = useState(""),
    box = useRef<HTMLDivElement>(null), current = useRef<Shown | null>(null),
    // The page being read and how far into it, kept across versions.
    anchor = useRef<{ page: number; offset: number } | null>(null);
  useEffect(() => {
    let live = true, adopted = false, task: ReturnType<typeof pdfjs.getDocument> | null = null, waiting: (() => void) | null = null;
    void (async () => {
      task = pdfjs.getDocument({ url, enableXfa: false, BinaryDataFactory: CMapData });
      const pdf = await task.promise, labels = await pdf.getPageLabels().catch(() => null),
        pages = await Promise.all(Array.from({ length: pdf.numPages }, async (_, i) => {
          const viewport = (await pdf.getPage(i + 1)).getViewport({ scale: 1 });
          return { width: viewport.width, height: viewport.height, label: labels?.[i] || String(i + 1) };
        }));
      if (!live) return;
      // A selection being made on the pages on screen keeps them.
      const selecting = () => {
        const selected = document.getSelection();
        return Boolean(selected && !selected.isCollapsed && selected.anchorNode && box.current?.contains(selected.anchorNode));
      };
      if (selecting()) await new Promise<void>((resolve) => {
        waiting = () => { if (!selecting()) { document.removeEventListener("selectionchange", waiting!); waiting = null; resolve(); } };
        document.addEventListener("selectionchange", waiting);
      });
      if (!live) return;
      const root = scrollRoot.current, list = box.current ? Array.from(box.current.querySelectorAll<HTMLElement>(".applied-page")) : [];
      const top = root?.getBoundingClientRect().top ?? 0,
        reading = list.find((element) => element.getBoundingClientRect().bottom > top + 1);
      anchor.current = reading ? { page: Number(reading.dataset.index), offset: (top - reading.getBoundingClientRect().top) / reading.getBoundingClientRect().height } : null;
      setError("");
      adopted = true;
      const previous = current.current;
      current.current = { url, key: buildKey, pdf, pages };
      setShown(current.current);
      if (previous) void previous.pdf.loadingTask.destroy().catch(() => undefined);
    })().catch((failure: Error) => { if (live) setError(failure.message); });
    return () => {
      live = false;
      if (waiting) document.removeEventListener("selectionchange", waiting);
      // A version not shown yet is dropped; the one on screen stays until
      // the next replaces it.
      if (task && !adopted) void task.destroy().catch(() => undefined);
    };
  }, [url]);
  useEffect(() => () => { void current.current?.pdf.loadingTask.destroy().catch(() => undefined); }, []);
  // The place being read stays on screen when a newer version comes in.
  useLayoutEffect(() => {
    const kept = anchor.current, root = scrollRoot.current;
    if (!kept || !root || !box.current) return;
    const element = box.current.querySelector<HTMLElement>(`.applied-page[data-index="${Math.min(kept.page, (shown?.pages.length ?? 1) - 1)}"]`);
    if (element) root.scrollTop += element.getBoundingClientRect().top - root.getBoundingClientRect().top + kept.offset * element.getBoundingClientRect().height;
    anchor.current = null;
  }, [shown]);
  useEffect(() => (shown && box.current ? paintAppliedPages(box.current, shown.pdf, scrollRoot.current) : undefined), [shown]);
  if (!shown)
    return error
      ? <div className="paper-status" role="alert"><p>{t("The full PDF could not be loaded.")}</p></div>
      : <div className="paper-status" role="status"><div className="pulse" /></div>;
  return (
    <>
      {status}
      <div className="paper applied-paper" ref={box} data-build={shown.key}>
        {shown.pages.map((page, index) => (
          <section
            key={`${shown.key}:${index}`}
            className="pdf-strip applied-page"
            data-index={index}
            data-page={page.label}
            data-note-key={`applied:${shown.key}:${index}`}
            style={{ aspectRatio: `${page.width}/${page.height}` }}
          >
            <PageText shown={shown} index={index} />
          </section>
        ))}
      </div>
    </>
  );
}

