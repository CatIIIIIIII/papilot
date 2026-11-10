import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { Strip, TextGlyph } from "../types.ts";
import { language as viewerLanguage, t, type Language } from "./i18n.ts";
let context: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();
function width(text: string) {
  if (widths.has(text)) return widths.get(text)!;
  context ??= document.createElement("canvas").getContext("2d");
  if (!context) return 1;
  context.font = '100px "Times New Roman", serif';
  const measured = context.measureText(text).width / 100;
  widths.set(text, measured);
  return measured || 1;
}
function style(glyph: TextGlyph, image: Strip): CSSProperties {
  const [x0, y0, x1, y1] = glyph.rect,
    height = Math.max(y1 - y0, 0.1),
    scaleX = (x1 - x0) / (height * width(glyph.text));
  return {
    left: `${(100 * x0) / image.width}%`,
    top: `${(100 * y0) / image.height}%`,
    fontSize: `${(100 * height) / image.width}cqw`,
    transform: `scaleX(${scaleX})`,
  };
}
// Glyph boxes are hundreds of positioned spans per strip. Building or dropping
// them as strips cross the viewport stalled every scroll for 0.1–0.5 s, so
// they change only once the scroll has settled, one strip per idle moment.
const SETTLE = 200;
let scrolled = 0, pumping = false;
const settling = new Set<() => void>();
if (typeof document !== "undefined")
  document.addEventListener("scroll", () => { scrolled = performance.now(); }, { capture: true, passive: true });
const idle = (run: () => void) =>
  typeof requestIdleCallback === "function" ? requestIdleCallback(run, { timeout: 500 }) : setTimeout(run, 16);
function pump() {
  const wait = scrolled + SETTLE - performance.now();
  if (wait > 0) return void setTimeout(pump, wait);
  const [next] = settling;
  if (next) { settling.delete(next); next(); }
  if (settling.size) idle(pump);
  else pumping = false;
}
function whenSettled(run: () => void) {
  settling.add(run);
  if (!pumping) { pumping = true; setTimeout(pump, SETTLE); }
}
// A line wrapper survives changes between line and glyph text. Save selection
// endpoints relative to that wrapper so native Find can receive precise boxes
// without losing the selected text or the direction of the selection.
function selectionPoint(node: Node, offset: number): () => [Node, number] {
  const line = (
    node.nodeType === 1 ? (node as Element) : node.parentElement
  )?.closest(".pdf-text-line");
  if (!line) return () => [node, offset];
  // These stable element boundaries are not interchangeable with the final
  // newline text node: Chromium may include a neighboring, absolutely
  // positioned equation number when copying through that newline.
  if (node === line && offset === 0) return () => [line, 0];
  if (node === line && offset === line.childNodes.length)
    return () => [line, line.childNodes.length];
  const prefix = document.createRange();
  prefix.selectNodeContents(line);
  prefix.setEnd(node, offset);
  const length = prefix.toString().length;
  return () => {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let remaining = length,
      text: Node | null;
    while ((text = walker.nextNode())) {
      const size = text.textContent!.length;
      if (remaining <= size) return [text, remaining];
      remaining -= size;
    }
    return [line, line.childNodes.length];
  };
}
export const PdfStrip = memo(function PdfStrip({
  image,
  base,
  label,
  clean = false,
  focus,
  language = viewerLanguage(),
}: {
  image: Strip;
  base: string;
  label: string;
  clean?: boolean;
  focus?: string[];
  language?: Language;
}) {
  // Keep every line searchable. Only visible strips need the individual
  // glyph boxes used for accurate pointer selection over the PDF image.
  const box = useRef<HTMLDivElement>(null),
    [detailed, setDetailed] = useState(false);
  const rendered = useRef(detailed),
    restoreSelection = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    rendered.current = detailed;
    restoreSelection.current?.();
    restoreSelection.current = null;
  }, [detailed]);
  useEffect(() => {
    const element = box.current!;
    let nearby = false;
    const apply = () => {
      if (nearby === rendered.current) return;
      const selected = window.getSelection();
      if (
        selected && !selected.isCollapsed &&
        (element.contains(selected.anchorNode) || element.contains(selected.focusNode))
      ) {
        // Keep precise selected glyphs alive outside the viewport. A Find
        // result in a compact line must instead expand as it comes into view.
        if (rendered.current) return;
        const anchor = selectionPoint(selected.anchorNode!, selected.anchorOffset),
          focus = selectionPoint(selected.focusNode!, selected.focusOffset);
        restoreSelection.current = () => selected.setBaseAndExtent(...anchor(), ...focus());
      }
      setDetailed(nearby);
    };
    const update = () => {
      if (nearby === rendered.current) return;
      const selected = window.getSelection();
      if (selected && !selected.isCollapsed &&
        (element.contains(selected.anchorNode) || element.contains(selected.focusNode)))
        apply();
      // Recheck the selection when the queued update actually runs: it may
      // have changed while scrolling settled, before selectionchange fires.
      else whenSettled(apply);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        nearby = entries[0].isIntersecting;
        update();
      },
      { root: element.closest("#paper") },
    );
    observer.observe(element);
    document.addEventListener("selectionchange", update);
    return () => {
      settling.delete(apply);
      observer.disconnect();
      document.removeEventListener("selectionchange", update);
    };
  }, []);
  const lines = useMemo(
    () =>
      image.text?.map((line) => ({
        ...line,
        rect: line.chars.reduce(
          ([x0, y0, x1, y1], glyph) => [
            Math.min(x0, glyph.rect[0]),
            Math.min(y0, glyph.rect[1]),
            Math.max(x1, glyph.rect[2]),
            Math.max(y1, glyph.rect[3]),
          ],
          [image.width, image.height, 0, 0],
        ) as TextGlyph["rect"],
      })),
    [image],
  );
  const edges = useMemo(
    () =>
      lines?.reduce(
        ([left, right], line) => [
          Math.min(left, line.rect[0] / image.width),
          Math.max(right, line.rect[2] / image.width),
        ],
        [1, 0],
      ),
    [lines, image.width],
  );
  const text = useMemo(
    () =>
      lines?.map((line, i) => (
        <span className="pdf-text-line" key={i}>
          {detailed ? (
            line.chars.map((glyph, j) => (
              <span key={j} className="pdf-glyph" style={style(glyph, image)}>
                {glyph.text}
              </span>
            ))
          ) : (
            <span className="pdf-line-preview" style={style(line, image)}>
              {line.text}
            </span>
          )}
          {"\n"}
        </span>
      )),
    [image, lines, detailed],
  );
  return (
    <div
      ref={box}
      className="pdf-strip"
      data-page={image.label}
      data-text-left={edges?.[0]}
      data-text-right={edges?.[1]}
      style={{ aspectRatio: `${image.width}/${image.height}` }}
    >
      <img
        src={base + (clean || focus ? image.clean : image.src)}
        alt={image.text?.length ? "" : label}
        width={image.width}
        height={image.height}
        loading="lazy"
        decoding="async"
        draggable={false}
        aria-hidden={Boolean(image.text?.length)}
      />
      {focus && !clean && <svg className="pdf-focus-marks" viewBox={`0 0 ${image.width} ${image.height}`} aria-hidden="true">
        {(image.marks || []).filter(mark => focus.includes(mark.unit)).map((mark, i) => {
          const [x, y, right, bottom] = mark.rect, color = mark.kind === "removed" ? "#c72938" : mark.kind === "moved" ? "#2563c9" : "#1f8c52";
          return <g key={i} data-unit={mark.unit}><rect x={x} y={y} width={right - x} height={bottom - y} fill={color} fillOpacity=".18"/>
            {mark.kind === "removed" && <path d={`M ${x} ${y + (bottom - y) * .55} H ${right}`} stroke={color} strokeWidth=".45"/>}</g>;
        })}
      </svg>}
      {image.text?.length ? (
        <div
          className="pdf-text"
          role="region"
          aria-label={t("{label}, PDF page {page}", {
            label,
            page: image.label,
          }, language)}
        >
          {text}
        </div>
      ) : null}
    </div>
  );
});
