import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { Strip, TextGlyph } from "../types.ts";
import { t } from "./i18n.ts";
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
export const PdfStrip = memo(function PdfStrip({
  image,
  base,
  label,
  clean = false,
}: {
  image: Strip;
  base: string;
  label: string;
  clean?: boolean;
}) {
  // Keep every line searchable. Only visible strips need the individual
  // glyph boxes used for accurate pointer selection over the PDF image.
  const box = useRef<HTMLDivElement>(null),
    [detailed, setDetailed] = useState(false);
  useEffect(() => {
    const element = box.current!;
    let nearby = false;
    const update = () => {
      const selected = window.getSelection();
      // Keep the selected DOM intact, including a browser Find result, until
      // selection ends. Scrolling must never discard a quote being copied.
      if (
        selected &&
        !selected.isCollapsed &&
        (element.contains(selected.anchorNode) ||
          element.contains(selected.focusNode))
      )
        return;
      setDetailed(nearby);
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
        src={base + (clean ? image.clean : image.src)}
        alt={image.text?.length ? "" : label}
        width={image.width}
        height={image.height}
        loading="lazy"
        decoding="async"
        draggable={false}
        aria-hidden={Boolean(image.text?.length)}
      />
      {image.text?.length ? (
        <div
          className="pdf-text"
          role="region"
          aria-label={t("{label}, PDF page {page}", {
            label,
            page: image.label,
          })}
        >
          {text}
        </div>
      ) : null}
    </div>
  );
});
