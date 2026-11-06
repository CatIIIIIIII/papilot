import { createHash } from "node:crypto";
import * as mupdf from "mupdf";
import { intersect, union, type PdfDocument, type Raster } from "./pdf.ts";
import type { PaintArea, PaintEffect, Rect } from "../types.ts";

/** Drawings have physical positions, independently of the word stream. */
export type { PaintArea, PaintEffect } from "../types.ts";
export interface PaintAnchor {
  before: { page: number; rect: Rect; appearance?: string };
  after: { page: number; rect: Rect; appearance?: string };
}
type Descriptor = (origin: number[]) => unknown;
interface Operation {
  page: number;
  rect: Rect;
  frame: Rect;
  key: string;
  order: number;
}
interface PagePaint {
  bounds: Rect;
  list: mupdf.DisplayList;
  operations: Operation[];
}
const hash = (value: string | Uint8Array | Uint8ClampedArray) =>
  createHash("sha256").update(value).digest("hex");
const box =
  (r: Rect, data: unknown[] = []): Descriptor =>
  (o) => [data, r[0] - o[0], r[1] - o[1], r[2] - o[0], r[3] - o[1]];
const overlaps = (a: Rect, b: Rect) =>
  a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const point = (x: number, y: number, m: mupdf.Matrix): number[] => [
  x * m[0] + y * m[2] + m[4],
  x * m[1] + y * m[3] + m[5],
];
const noStroke = null as unknown as mupdf.StrokeState;
function pathDescription(
  path: mupdf.Path,
  matrix: mupdf.Matrix,
  data: unknown[],
): Descriptor {
  const commands: [string, number[]][] = [];
  const add = (kind: string, coords: number[]) => {
    const points: number[] = [];
    for (let i = 0; i < coords.length; i += 2)
      points.push(...point(coords[i], coords[i + 1], matrix));
    commands.push([kind, points]);
  };
  path.walk({
    moveTo: (...p) => add("M", p),
    lineTo: (...p) => add("L", p),
    curveTo: (...p) => add("C", p),
    closePath: () => add("Z", []),
  });
  return (origin) => [
    data,
    commands.map(([kind, values]) => [
      kind,
      values.map((v, i) => v - origin[i % 2]),
    ]),
  ];
}
const strokeData = (s: mupdf.StrokeState, m: mupdf.Matrix) => [
  s.getLineWidth(),
  s.getLineCap(),
  s.getLineJoin(),
  s.getMiterLimit(),
  s.getDashPhase(),
  s.getDashes(),
  m.slice(0, 4),
];
function raster(list: mupdf.DisplayList, clip: Rect, alpha: boolean): Raster {
  const scale = 2,
    pixmap = new mupdf.Pixmap(
      mupdf.ColorSpace.DeviceRGB,
      [
        0,
        0,
        Math.ceil((clip[2] - clip[0]) * scale),
        Math.ceil((clip[3] - clip[1]) * scale),
      ],
      alpha,
    );
  pixmap.clear(alpha ? undefined : 255);
  const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
  try {
    list.run(device, [scale, 0, 0, scale, -clip[0] * scale, -clip[1] * scale]);
    device.close();
    return {
      width: pixmap.getWidth(),
      height: pixmap.getHeight(),
      channels: pixmap.getNumberOfComponents(),
      stride: pixmap.getStride(),
      pixels: new Uint8Array(pixmap.getPixels()),
    };
  } finally {
    device.destroy();
    pixmap.destroy();
  }
}
function collect(
  document: PdfDocument,
  page: number,
  omit = new Set<number>(),
  includeText = false,
): PagePaint {
  let sequence = 0;
  const raw = document.raw.loadPage(page),
    bounds = raw.getBounds() as Rect,
    list = new mupdf.DisplayList(bounds),
    target = new mupdf.DisplayListDevice(list),
    operations: Operation[] = [],
    clips: { rect: Rect; describe: Descriptor }[] = [],
    groups: Descriptor[] = [],
    masks: { rect: Rect; members: Descriptor[]; describe: Descriptor }[] = [],
    tiles: Rect[] = [],
    images = new Map<number, string>();
  const imageKey = (image: mupdf.Image): string => {
    const cached = images.get(image.pointer);
    if (cached) return cached;
    const pixmap = image.toPixmap(),
      rgb = pixmap.getColorSpace()
        ? pixmap.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, true)
        : pixmap,
      mask = image.getMask();
    try {
      const key = hash(
        JSON.stringify([
          rgb.getWidth(),
          rgb.getHeight(),
          hash(rgb.getPixels()),
          mask ? imageKey(mask) : null,
        ]),
      );
      images.set(image.pointer, key);
      return key;
    } finally {
      if (rgb !== pixmap) rgb.destroy();
      pixmap.destroy();
      mask?.destroy();
    }
  };
  const imageDescription = (
    image: mupdf.Image,
    matrix: mupdf.Matrix,
    data: unknown[],
  ): Descriptor => {
    const points = [
        [0, 0],
        [1, 0],
        [0, 1],
      ].map(([x, y]) => point(x, y, matrix)),
      key = imageKey(image);
    return (origin) => [
      data,
      key,
      points.map((p) => p.map((v, i) => v - origin[i])),
    ];
  };
  const record = (rect: Rect, describe: Descriptor) => {
    const order = sequence++;
    const state = [...clips.map((c) => c.describe), ...groups],
      descriptor: Descriptor = (origin) => [
        describe(origin),
        state.map((s) => s(origin)),
      ];
    if (masks.length) {
      masks.at(-1)!.members.push(descriptor);
      return;
    }
    rect = intersect(tiles.at(-1) ?? rect, bounds);
    for (const clip of clips) rect = intersect(rect, clip.rect);
    if (rect[2] <= rect[0] || rect[3] <= rect[1]) return;
    operations.push({
      page,
      rect,
      // Clip scopes are real PDF coordinate frames (including Form BBoxes).
      // Separate frames may reflow independently; points within one frame
      // keep their relative coordinates even when they do not intersect.
      frame:
        clips.find(
          (clip) => JSON.stringify(clip.rect) !== JSON.stringify(bounds),
        )?.rect ?? bounds,
      key: hash(JSON.stringify(descriptor(rect))),
      order,
    });
  };
  const textDescriptor = (
    text: mupdf.Text,
    matrix: mupdf.Matrix,
    draw: (device: mupdf.Device) => void,
  ): Descriptor => {
    const rect = text.getBounds(noStroke, matrix) as Rect,
      item = new mupdf.DisplayList(rect),
      output = new mupdf.DisplayListDevice(item);
    draw(output);
    output.close();
    output.destroy();
    try {
      const value = raster(item, rect, true);
      return box(rect, ["mask-text", hash(value.pixels)]);
    } finally {
      item.destroy();
    }
  };
  const device = new mupdf.Device({
    fillPath(path, even, matrix, space, color, alpha) {
      if (!omit.has(sequence))
        target.fillPath(path, even, matrix, space, color as mupdf.Color, alpha);
      record(
        path.getBounds(noStroke, matrix) as Rect,
        pathDescription(path, matrix, [
          "fill",
          even,
          space.getName(),
          color,
          alpha,
        ]),
      );
    },
    strokePath(path, stroke, matrix, space, color, alpha) {
      if (!omit.has(sequence))
        target.strokePath(
          path,
          stroke,
          matrix,
          space,
          color as mupdf.Color,
          alpha,
        );
      record(
        path.getBounds(stroke, matrix) as Rect,
        pathDescription(path, matrix, [
          "stroke",
          strokeData(stroke, matrix),
          space.getName(),
          color,
          alpha,
        ]),
      );
    },
    fillImage(image, matrix, alpha) {
      if (!omit.has(sequence)) target.fillImage(image, matrix, alpha);
      record(
        mupdf.Rect.transform([0, 0, 1, 1], matrix),
        imageDescription(image, matrix, ["image", alpha]),
      );
    },
    fillImageMask(image, matrix, space, color, alpha) {
      if (!omit.has(sequence))
        target.fillImageMask(image, matrix, space, color as mupdf.Color, alpha);
      record(
        mupdf.Rect.transform([0, 0, 1, 1], matrix),
        imageDescription(image, matrix, [
          "image-mask",
          space.getName(),
          color,
          alpha,
        ]),
      );
    },
    fillShade(shade, matrix, alpha) {
      if (!omit.has(sequence)) target.fillShade(shade, matrix, alpha);
      const rect = intersect(
          mupdf.Rect.transform(shade.getBounds(), matrix),
          bounds,
        ),
        item = new mupdf.DisplayList(rect),
        output = new mupdf.DisplayListDevice(item);
      output.fillShade(shade, matrix, alpha);
      output.close();
      output.destroy();
      try {
        record(
          rect,
          box(rect, ["shade", hash(raster(item, rect, true).pixels)]),
        );
      } finally {
        item.destroy();
      }
    },
    fillText(text, matrix, space, color, alpha) {
      if (includeText || masks.length) {
        target.fillText(text, matrix, space, color as mupdf.Color, alpha);
        if (masks.length)
          masks
            .at(-1)!
            .members.push(
              textDescriptor(text, matrix, (d) =>
                d.fillText(text, matrix, space, color as mupdf.Color, alpha),
              ),
            );
      }
    },
    strokeText(text, stroke, matrix, space, color, alpha) {
      if (includeText || masks.length) {
        target.strokeText(
          text,
          stroke,
          matrix,
          space,
          color as mupdf.Color,
          alpha,
        );
        if (masks.length)
          masks
            .at(-1)!
            .members.push(
              textDescriptor(text, matrix, (d) =>
                d.strokeText(
                  text,
                  stroke,
                  matrix,
                  space,
                  color as mupdf.Color,
                  alpha,
                ),
              ),
            );
      }
    },
    clipPath(path, even, matrix) {
      target.clipPath(path, even, matrix);
      clips.push({
        rect: path.getBounds(noStroke, matrix) as Rect,
        describe: pathDescription(path, matrix, ["clip", even]),
      });
    },
    clipStrokePath(path, stroke, matrix) {
      target.clipStrokePath(path, stroke, matrix);
      clips.push({
        rect: path.getBounds(stroke, matrix) as Rect,
        describe: pathDescription(path, matrix, [
          "clip-stroke",
          strokeData(stroke, matrix),
        ]),
      });
    },
    clipImageMask(image, matrix) {
      target.clipImageMask(image, matrix);
      clips.push({
        rect: mupdf.Rect.transform([0, 0, 1, 1], matrix),
        describe: imageDescription(image, matrix, ["clip-image"]),
      });
    },
    clipText(text, matrix) {
      target.clipText(text, matrix);
      clips.push({
        rect: text.getBounds(noStroke, matrix) as Rect,
        describe: textDescriptor(text, matrix, (d) =>
          d.fillText(text, matrix, mupdf.ColorSpace.DeviceGray, [0], 1),
        ),
      });
    },
    clipStrokeText(text, stroke, matrix) {
      target.clipStrokeText(text, stroke, matrix);
      clips.push({
        rect: text.getBounds(stroke, matrix) as Rect,
        describe: textDescriptor(text, matrix, (d) =>
          d.strokeText(
            text,
            stroke,
            matrix,
            mupdf.ColorSpace.DeviceGray,
            [0],
            1,
          ),
        ),
      });
    },
    popClip() {
      target.popClip();
      clips.pop();
    },
    beginMask(rect, luminosity, space, color) {
      target.beginMask(rect, luminosity, space, color as mupdf.Color);
      masks.push({
        rect: rect as Rect,
        members: [],
        describe: box(rect as Rect, [
          "mask",
          luminosity,
          space?.getName(),
          color,
        ]),
      });
    },
    endMask() {
      target.endMask();
      const mask = masks.pop()!;
      clips.push({
        rect: mask.rect,
        describe: (o) => [mask.describe(o), mask.members.map((m) => m(o))],
      });
    },
    beginGroup(rect, space, isolated, knockout, blend, alpha) {
      target.beginGroup(rect, space, isolated, knockout, blend, alpha);
      groups.push(
        box(rect as Rect, [
          "group",
          space?.getName(),
          isolated,
          knockout,
          blend,
          alpha,
        ]),
      );
    },
    endGroup() {
      target.endGroup();
      groups.pop();
    },
    beginTile(area, view, xstep, ystep, matrix, id, doc) {
      target.beginTile(area, view, xstep, ystep, matrix, id, doc);
      const rect = mupdf.Rect.transform(area, matrix);
      tiles.push(rect);
      groups.push(box(rect, ["tile", view, xstep, ystep, matrix.slice(0, 4)]));
      return 0;
    },
    endTile() {
      target.endTile();
      tiles.pop();
      groups.pop();
    },
    beginLayer(name) {
      target.beginLayer(name);
    },
    endLayer() {
      target.endLayer();
    },
  });
  try {
    raw.run(device, mupdf.Matrix.identity);
    device.close();
    target.close();
    return { list, operations, bounds };
  } catch (error) {
    list.destroy();
    throw error;
  } finally {
    device.destroy();
    target.destroy();
    raw.destroy();
  }
}

interface Snapshot {
  area: PaintArea;
  paint: Raster;
  full: Raster;
  without: Raster;
  context: boolean;
  omitted?: PagePaint;
}
function snapshot(
  document: PdfDocument,
  page: number,
  layer: PagePaint,
  clip: Rect,
  omitted?: PagePaint,
  context = false,
): Snapshot {
  const source = document.page(page),
    paint = raster(layer.list, clip, true),
    full = source.raster(clip, 2, false, true);
  return {
    area: {
      page,
      clip,
      label: source.label,
      signature: hash(
        JSON.stringify([
          full.width,
          full.height,
          hash(full.pixels),
          hash(paint.pixels),
        ]),
      ),
    },
    paint,
    full,
    without: omitted ? raster(omitted.list, clip, false) : full,
    context,
    omitted,
  };
}
interface Region {
  page: number;
  rect: Rect;
  context?: boolean;
}
function coalesce(regions: Region[]): Region[] {
  const result: Region[] = [];
  for (let region of regions) {
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = result.length - 1; i >= 0; i--)
        if (
          result[i].page === region.page &&
          overlaps(result[i].rect, region.rect)
        ) {
          region = {
            ...region,
            rect: union(region.rect, result[i].rect),
            context: region.context || result[i].context,
          };
          result.splice(i, 1);
          merged = true;
        }
    }
    result.push(region);
  }
  return result;
}

export function paintChanges(
  old: PdfDocument,
  next: PdfDocument,
  anchors: Iterable<PaintAnchor> = [],
): PaintEffect[] {
  const left: PagePaint[] = [],
    right: PagePaint[] = [],
    extra: PagePaint[] = [];
  try {
    for (let n = 0; n < old.length; n++) left.push(collect(old, n));
    for (let n = 0; n < next.length; n++) right.push(collect(next, n));
    const a = left.flatMap((p) => p.operations),
      b = right.flatMap((p) => p.operations),
      paired = new Map<number, number>(),
      used = new Set<number>(),
      backdrop = new Map<Operation, boolean>();
    // A uniformly painted page supplies a viewport background rather than
    // coordinates inside a drawing. Its colour still participates in all
    // final compositing checks. Test pixels, never a colour/shape whitelist.
    const isBackdrop = (
      item: Operation,
      doc: PdfDocument,
      pages: PagePaint[],
    ) => {
      const saved = backdrop.get(item);
      if (saved !== undefined) return saved;
      const bounds = pages[item.page].bounds;
      if (JSON.stringify(item.rect) !== JSON.stringify(bounds)) {
        backdrop.set(item, false);
        return false;
      }
      const only = collect(
          doc,
          item.page,
          new Set(
            pages[item.page].operations
              .filter((op) => op !== item)
              .map((op) => op.order),
          ),
        ),
        image = raster(only.list, bounds, true);
      only.list.destroy();
      const uniform =
        image.pixels.length > 0 &&
        image.pixels[3] > 0 &&
        image.pixels.every((value, i) => value === image.pixels[i % 4]);
      backdrop.set(item, uniform);
      return uniform;
    };
    const position = (item: Operation, delta = [0, 0]) =>
      JSON.stringify([item.page, item.rect.map((v, i) => v - delta[i % 2])]);
    const offsets = new Map<number, number[]>();
    for (let page = 0; page < Math.min(left.length, right.length); page++) {
      const aa = left[page].operations.filter(
          (op) => !isBackdrop(op, old, left),
        ),
        bb = right[page].operations.filter(
          (op) => !isBackdrop(op, next, right),
        );
      if (!aa.length || !bb.length) continue;
      const ar = aa.map((op) => op.rect).reduce(union),
        br = bb.map((op) => op.rect).reduce(union),
        delta = [br[0] - ar[0], br[1] - ar[1]],
        keys = new Set(aa.map((op) => op.key + position(op))),
        score = (offset: number[]) =>
          bb.filter((op) => keys.has(op.key + position(op, offset))).length;
      offsets.set(page, score(delta) > score([0, 0]) ? delta : [0, 0]);
    }
    // Match repeated equal objects at their shared-frame positions first.
    // FIFO matching can attach a recoloured first point to a later copy.
    const exact = new Map<string, number[]>(),
      buckets = new Map<string, number[]>();
    b.forEach((item, i) => {
      const key =
        item.key +
        position(
          item,
          isBackdrop(item, next, right) ? [0, 0] : offsets.get(item.page),
        );
      if (!exact.has(key)) exact.set(key, []);
      exact.get(key)!.push(i);
      if (!buckets.has(item.key)) buckets.set(item.key, []);
      buckets.get(item.key)!.push(i);
    });
    const take = (indices: number[] | undefined) => {
      while (indices?.length) {
        const i = indices.pop()!;
        if (!used.has(i)) return i;
      }
      return undefined;
    };
    a.forEach((item, i) => {
      const j = take(exact.get(item.key + position(item)));
      if (j !== undefined) {
        paired.set(i, j);
        used.add(j);
      }
    });
    a.forEach((item, i) => {
      if (paired.has(i)) return;
      const j = take(buckets.get(item.key));
      if (j !== undefined) {
        paired.set(i, j);
        used.add(j);
      }
    });
    const changedA = new Set(a.map((_, i) => i).filter((i) => !paired.has(i))),
      changedB = new Set(b.map((_, i) => i).filter((i) => !used.has(i))),
      movingA = new Set<number>(),
      movingB = new Set<number>(),
      framesA = new Map<number, Rect>(),
      framesB = new Map<number, Rect>();
    const movements = new Map<string, [number, number][]>();
    for (const [i, j] of paired) {
      const key = JSON.stringify([
        a[i].page,
        a[i].frame,
        b[j].page,
        b[j].frame,
      ]);
      if (!movements.has(key)) movements.set(key, []);
      movements.get(key)!.push([i, j]);
    }
    for (const pairs of movements.values()) {
      const anchored = pairs.filter(
          ([i, j]) =>
            !isBackdrop(a[i], old, left) || !isBackdrop(b[j], next, right),
        ),
        delta = ([i, j]: [number, number]) => [
          b[j].rect[0] - a[i].rect[0],
          b[j].rect[1] - a[i].rect[1],
        ],
        common =
          new Set(anchored.map((pair) => JSON.stringify(delta(pair)))).size <=
          1;
      for (const [i, j] of anchored) {
        if (a[i].page === b[j].page && delta([i, j]).every((v) => v === 0))
          continue;
        changedA.add(i);
        changedB.add(j);
        movingA.add(i);
        movingB.add(j);
        if (!common) {
          // Relative movement stays in the common drawing coordinates,
          // even when the moved primitive never intersects another one.
          const rect = union(a[i].rect, b[j].rect),
            put = (frames: Map<number, Rect>, page: number) =>
              frames.set(
                page,
                frames.has(page) ? union(frames.get(page)!, rect) : rect,
              );
          put(framesA, a[i].page);
          put(framesB, b[j].page);
        }
      }
    }
    const contextA = new Set(movingA),
      contextB = new Set(movingB);
    type Spatial =
      | { rect: Rect; index: number }
      | { rect: Rect; left: Spatial; right: Spatial };
    const spatial = (
        items: Operation[],
        doc: PdfDocument,
        pages: PagePaint[],
      ) => {
        const byPage = new Map<number, number[]>(),
          result = new Map<number, Spatial>();
        items.forEach((item, i) => {
          if (isBackdrop(item, doc, pages)) return;
          if (!byPage.has(item.page)) byPage.set(item.page, []);
          byPage.get(item.page)!.push(i);
        });
        const build = (indices: number[]): Spatial => {
          const rect = indices.map((i) => items[i].rect).reduce(union);
          if (indices.length === 1) return { rect, index: indices[0] };
          const axis = rect[2] - rect[0] > rect[3] - rect[1] ? 0 : 1;
          indices.sort((i, j) => items[i].rect[axis] - items[j].rect[axis]);
          const mid = indices.length >> 1;
          return {
            rect,
            left: build(indices.slice(0, mid)),
            right: build(indices.slice(mid)),
          };
        };
        for (const [page, indices] of byPage) result.set(page, build(indices));
        return result;
      },
      indexA = spatial(a, old, left),
      indexB = spatial(b, next, right),
      touched = (glyph: PaintAnchor["before"], index: Map<number, Spatial>) => {
        const result: number[] = [],
          visit = (node: Spatial | undefined) => {
            if (!node || !overlaps(node.rect, glyph.rect)) return;
            if ("index" in node) result.push(node.index);
            else {
              visit(node.left);
              visit(node.right);
            }
          };
        visit(index.get(glyph.page));
        return result;
      };
    const sameRaster = (x: Raster, y: Raster) =>
      x.width === y.width &&
      x.height === y.height &&
      x.channels === y.channels &&
      x.pixels.every((v, i) => v === y.pixels[i]);
    // The text comparison supplies physical correspondences. Looking at
    // both paint and glyph anchors makes composition symmetric: either
    // the graphic or its text can move into/out of the other's coverage.
    for (const anchor of anchors) {
      const aa = touched(anchor.before, indexA),
        bb = touched(anchor.after, indexB);
      if (!aa.length && !bb.length) continue;
      const p = old
          .page(anchor.before.page)
          .raster(anchor.before.rect, 2, false, true),
        q = next
          .page(anchor.after.page)
          .raster(anchor.after.rect, 2, false, true);
      if (sameRaster(p, q)) continue;
      // Changed glyph shapes/colours already belong to the text layer;
      // unchanged glyphs with changed compositing belong to this layer.
      if (
        anchor.before.appearance !== anchor.after.appearance &&
        sameRaster(
          raster(left[anchor.before.page].list, anchor.before.rect, true),
          raster(right[anchor.after.page].list, anchor.after.rect, true),
        )
      )
        continue;
      const oldRect =
          anchor.before.page === anchor.after.page
            ? union(anchor.before.rect, anchor.after.rect)
            : anchor.before.rect,
        newRect =
          anchor.before.page === anchor.after.page
            ? oldRect
            : anchor.after.rect,
        expand = (frames: Map<number, Rect>, page: number, rect: Rect) =>
          frames.set(
            page,
            frames.has(page) ? union(frames.get(page)!, rect) : rect,
          );
      expand(framesA, anchor.before.page, oldRect);
      expand(framesB, anchor.after.page, newRect);
      for (const i of aa) {
        changedA.add(i);
        contextA.add(i);
        const j = paired.get(i);
        if (j !== undefined) {
          changedB.add(j);
          contextB.add(j);
        }
      }
      for (const j of bb) {
        changedB.add(j);
        contextB.add(j);
      }
    }
    // Compare interacting paints in the later paint's local frame. A
    // uniform backdrop covering that entire frame stays the same when the
    // foreground moves; partial occlusion and stacking changes do not.
    const reverse = new Map([...paired].map(([i, j]) => [j, i])),
      tested = new Set<string>();
    const interaction = (i: number, j: number) => {
      if (i === j) return;
      const key = [Math.min(i, j), Math.max(i, j)].join(":");
      if (tested.has(key)) return;
      tested.add(key);
      const x = paired.get(i)!,
        y = paired.get(j)!,
        oldOverlap = a[i].page === a[j].page && overlaps(a[i].rect, a[j].rect),
        newOverlap = b[x].page === b[y].page && overlaps(b[x].rect, b[y].rect);
      if (!oldOverlap && !newOverlap) return;
      const relative = (first: Operation, second: Operation) => {
        if (first.page !== second.page || !overlaps(first.rect, second.rect))
          return null;
        const front = first.order > second.order ? first : second,
          r = intersect(first.rect, second.rect);
        return [
          r[0] - front.rect[0],
          r[1] - front.rect[1],
          r[2] - front.rect[0],
          r[3] - front.rect[1],
        ];
      };
      const inverted =
        (a[i].order - a[j].order) * (b[x].order - b[y].order) < 0;
      if (
        inverted ||
        JSON.stringify(relative(a[i], a[j])) !==
          JSON.stringify(relative(b[x], b[y]))
      ) {
        changedA.add(i);
        changedA.add(j);
        changedB.add(x);
        changedB.add(y);
        return;
      }
      // Containment alone is not enough: a translucent foreground can pick
      // up a different part of a non-uniform backdrop after moving.
      if (
        oldOverlap &&
        newOverlap &&
        (a[i].rect[0] - a[j].rect[0] !== b[x].rect[0] - b[y].rect[0] ||
          a[i].rect[1] - a[j].rect[1] !== b[x].rect[1] - b[y].rect[1])
      ) {
        const oi = a[i].order > a[j].order ? i : j,
          ni = paired.get(oi)!,
          op = a[oi],
          np = b[ni],
          p = raster(left[op.page].list, op.rect, true),
          q = raster(right[np.page].list, np.rect, true);
        if (
          p.width !== q.width ||
          p.height !== q.height ||
          p.pixels.some((v, k) => v !== q.pixels[k])
        ) {
          changedA.add(oi);
          changedB.add(ni);
        }
      }
    };
    const interactions = (
      items: Operation[],
      indices: number[],
      original: (i: number) => number,
    ) => {
      const ordered = indices.sort(
        (i, j) =>
          items[i].page - items[j].page || items[i].rect[1] - items[j].rect[1],
      );
      let active: number[] = [];
      for (const i of ordered) {
        active = active.filter(
          (j) =>
            items[j].page === items[i].page &&
            items[j].rect[3] >= items[i].rect[1],
        );
        for (const j of active)
          if (overlaps(items[i].rect, items[j].rect))
            interaction(original(i), original(j));
        active.push(i);
      }
    };
    interactions(a, [...paired.keys()], (i) => i);
    interactions(b, [...reverse.keys()], (i) => reverse.get(i)!);
    // An exporter can split one compound path into several paint calls.
    // Compare the composed candidate ink before choosing strip boundaries,
    // so operator granularity cannot manufacture a visible change.
    const batches = (
      items: Operation[],
      selected: Set<number>,
      pages: PagePaint[],
      moving: Set<number>,
    ) => {
      const byPage = new Map<number, { rect: Rect; ids: number[] }>();
      for (const i of selected) {
        const item = items[i],
          entry = byPage.get(item.page);
        if (entry) {
          entry.rect = union(entry.rect, item.rect);
          entry.ids.push(i);
        } else byPage.set(item.page, { rect: item.rect, ids: [i] });
      }
      return [...byPage]
        .filter(([, group]) => !group.ids.some((i) => moving.has(i)))
        .map(([page, { rect, ids }]) => {
          const image = raster(pages[page].list, rect, true);
          return {
            ids,
            key: hash(
              JSON.stringify([image.width, image.height, hash(image.pixels)]),
            ),
          };
        });
    };
    const ba = batches(a, changedA, left, contextA),
      bb = batches(b, changedB, right, contextB),
      matchedBatches = new Set<number>();
    for (const batch of ba) {
      const index = bb.findIndex(
        (other, i) => !matchedBatches.has(i) && other.key === batch.key,
      );
      if (index >= 0) {
        matchedBatches.add(index);
        for (const i of batch.ids) changedA.delete(i);
        for (const i of bb[index].ids) changedB.delete(i);
      }
    }
    // Choose physical comparison regions jointly on both sides. This
    // preserves one-to-many equivalence when an exporter splits paths.
    const joint = coalesce(
      (
        [
          [a, changedA, movingA],
          [b, changedB, movingB],
        ] as const
      ).flatMap(([items, selected, moving]) =>
        [...selected]
          .filter((i) => !moving.has(i))
          .map((i) => ({ page: items[i].page, rect: items[i].rect })),
      ),
    );
    const regions = (
      items: Operation[],
      selected: Set<number>,
      doc: PdfDocument,
      pages: PagePaint[],
    ) => {
      const frames = items === a ? framesA : framesB,
        moving = items === a ? movingA : movingB,
        context = items === a ? contextA : contextB;
      const omitted = new Map<number, PagePaint>(),
        orders = new Map<number, Set<number>>();
      for (const i of selected) {
        const { page, order } = items[i];
        if (!orders.has(page)) orders.set(page, new Set());
        orders.get(page)!.add(order);
      }
      for (const [page, ids] of orders) {
        const layer = collect(doc, page, ids, true);
        omitted.set(page, layer);
        extra.push(layer);
      }
      const groups = coalesce(
        [...selected].map((i) => ({
          page: items[i].page,
          rect: frames.has(items[i].page)
            ? union(items[i].rect, frames.get(items[i].page)!)
            : moving.has(i)
              ? items[i].rect
              : joint.find(
                  (group) =>
                    group.page === items[i].page &&
                    overlaps(group.rect, items[i].rect),
                )!.rect,
          context: context.has(i),
        })),
      );
      return groups
        .sort(
          (x, y) =>
            x.page - y.page || x.rect[1] - y.rect[1] || x.rect[0] - y.rect[0],
        )
        .map(({ page, rect, context }) => {
          const clip = intersect(
            [rect[0] - 1, rect[1] - 1, rect[2] + 1, rect[3] + 1],
            pages[page].bounds,
          );
          return snapshot(
            doc,
            page,
            pages[page],
            clip,
            omitted.get(page),
            context,
          );
        })
        .filter((item) =>
          item.full.pixels.some((p, i) => p !== item.without.pixels[i]),
        );
    };
    const before = regions(a, changedA, old, left),
      after = regions(b, changedB, next, right),
      result: PaintEffect[] = [];
    const matched = new Set<number>(),
      remaining = before.filter((item) => {
        const i = after.findIndex(
          (other, index) =>
            !matched.has(index) &&
            other.area.signature === item.area.signature &&
            !differentContribution(item, other),
        );
        if (i < 0) return true;
        matched.add(i);
        return false;
      }),
      additions = after.filter((_, i) => !matched.has(i));
    const background = (
      reference: (typeof before)[number] | undefined,
      doc: PdfDocument,
      pages: PagePaint[],
    ) => {
      if (!reference || reference.area.page >= doc.length) return undefined;
      const page = reference.area.page,
        p = doc.page(page),
        clip = intersect(reference.area.clip, p.bounds);
      if (clip[2] <= clip[0] || clip[3] <= clip[1]) return undefined;
      return snapshot(doc, page, pages[page], clip);
    };
    for (let i = 0; i < Math.max(remaining.length, additions.length); i++) {
      let x = remaining[i] ?? background(additions[i], old, left),
        y = additions[i] ?? background(remaining[i], next, right);
      // A translated graphic can reveal/cover different fixed text even
      // when both normalized paint crops are solid white (an eraser).
      // Changed visible contribution supplies a stationary reference.
      if (
        x &&
        y &&
        (x.context || y.context) &&
        x.area.page === y.area.page &&
        (x.area.clip[0] !== y.area.clip[0] ||
          x.area.clip[1] !== y.area.clip[1]) &&
        differentContribution(x, y)
      ) {
        const clip = union(x.area.clip, y.area.clip);
        x = snapshot(
          old,
          x.area.page,
          left[x.area.page],
          clip,
          x.omitted,
          x.context,
        );
        y = snapshot(
          next,
          y.area.page,
          right[y.area.page],
          clip,
          y.omitted,
          y.context,
        );
      }
      if (visibleDifference(x, y))
        result.push({
          kind: "paint",
          before: x ? [x.area] : [],
          after: y ? [y.area] : [],
        });
    }
    return result;
  } finally {
    for (const page of [...left, ...right, ...extra]) page.list.destroy();
  }
}
function differentContribution(
  a: { full: Raster; without: Raster },
  b: { full: Raster; without: Raster },
) {
  if (a.full.width !== b.full.width || a.full.height !== b.full.height)
    return true;
  return a.full.pixels.some(
    (value, i) =>
      value - a.without.pixels[i] !== b.full.pixels[i] - b.without.pixels[i],
  );
}
function visibleDifference(
  a:
    | { paint: Raster; full: Raster; without: Raster; context: boolean }
    | undefined,
  b:
    | { paint: Raster; full: Raster; without: Raster; context: boolean }
    | undefined,
) {
  if (
    a &&
    b &&
    (a.context || b.context) &&
    differentContribution(a, b) &&
    (a.full.width !== b.full.width ||
      a.full.height !== b.full.height ||
      a.full.pixels.some((v, i) => v !== b.full.pixels[i]))
  )
    return true;
  const width = Math.max(a?.full.width ?? 0, b?.full.width ?? 0),
    height = Math.max(a?.full.height ?? 0, b?.full.height ?? 0);
  const pixel = (
    r: Raster | undefined,
    x: number,
    y: number,
    c: number,
    blank: number,
  ) =>
    r && x < r.width && y < r.height
      ? r.pixels[y * r.stride + x * r.channels + c]
      : blank;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const contributionChanged = [0, 1, 2].some(
        (c) =>
          pixel(a?.full, x, y, c, 255) - pixel(a?.without, x, y, c, 255) !==
          pixel(b?.full, x, y, c, 255) - pixel(b?.without, x, y, c, 255),
      );
      const changed =
        ((a?.context || b?.context) && contributionChanged) ||
        [0, 1, 2, 3].some(
          (c) => pixel(a?.paint, x, y, c, 0) !== pixel(b?.paint, x, y, c, 0),
        );
      if (
        changed &&
        [0, 1, 2].some(
          (c) => pixel(a?.full, x, y, c, 255) !== pixel(b?.full, x, y, c, 255),
        ) &&
        [0, 1, 2].some(
          (c) =>
            pixel(a?.full, x, y, c, 255) !== pixel(a?.without, x, y, c, 255) ||
            pixel(b?.full, x, y, c, 255) !== pixel(b?.without, x, y, c, 255),
        )
      )
        return true;
    }
  return false;
}
