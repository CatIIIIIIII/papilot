import { createHash } from "node:crypto";
import * as mupdf from "mupdf";

// Font names are resource labels, not glyph identities. Fingerprint the actual
// painted glyph at a canonical scale, once per font/glyph, for appearance
// candidates. The caller still verifies those candidates against page ink.
function signature(
  font: mupdf.Font,
  gid: number,
  mode: number,
  cache: Map<string, string>,
) {
  const key = `${font.pointer}:${gid}:${mode}`,
    known = cache.get(key);
  if (known !== undefined) return known;
  const text = new mupdf.Text();
  text.showGlyph(font, [32, 0, 0, 32, 0, 0], gid, -1, mode);
  const stroke = new mupdf.StrokeState({
      lineWidth: 0,
      lineCap: "Butt",
      lineJoin: "Miter",
      miterLimit: 10,
    }),
    bounds = text.getBounds(stroke, mupdf.Matrix.identity),
    rect: mupdf.Rect = [
      Math.floor(bounds[0]),
      Math.floor(bounds[1]),
      Math.ceil(bounds[2]),
      Math.ceil(bounds[3]),
    ];
  stroke.destroy();
  let result = "empty";
  if (rect[2] > rect[0] && rect[3] > rect[1]) {
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, rect, false);
    pixmap.clear(255);
    const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
    device.fillText(
      text,
      mupdf.Matrix.identity,
      mupdf.ColorSpace.DeviceGray,
      [0],
      1,
    );
    device.close();
    device.destroy();
    result = JSON.stringify([
      rect,
      createHash("sha256").update(pixmap.getPixels()).digest("hex"),
    ]);
    pixmap.destroy();
  }
  text.destroy();
  cache.set(key, result);
  return result;
}
interface Cluster {
  font: number;
  origin: number[];
  chars: string[];
  shape: string[];
}
export function glyphShapes(page: mupdf.Page, cache: Map<string, string>) {
  const records: Cluster[] = [];
  const capture = (
    text: mupdf.Text,
    transform: mupdf.Matrix,
    paint: unknown[],
  ) => {
    let cluster: Cluster | undefined;
    text.walk({
      showGlyph(font, matrix, gid, unicode, mode) {
        const placed = mupdf.Matrix.concat(matrix, transform),
          appearance =
            gid >= 0
              ? JSON.stringify([
                  signature(font, gid, mode, cache),
                  placed.slice(0, 4),
                  paint,
                ])
              : "";
        if (gid >= 0 && unicode >= 0) {
          cluster = {
            font: font.pointer,
            origin: placed.slice(4),
            chars: [String.fromCodePoint(unicode)],
            shape: [appearance],
          };
          records.push(cluster);
        } else if (cluster && gid < 0 && unicode >= 0)
          cluster.chars.push(String.fromCodePoint(unicode));
        else if (cluster && gid >= 0 && unicode < 0)
          cluster.shape.push(appearance);
      },
    });
  };
  const stroke = (s: mupdf.StrokeState) => [
    s.getLineWidth(),
    s.getLineCap(),
    s.getLineJoin(),
    s.getMiterLimit(),
    s.getDashPhase(),
    s.getDashes(),
  ];
  const device = new mupdf.Device({
    fillText: (text, matrix, space, color, alpha) =>
      capture(text, matrix, ["fill", space.getName(), color, alpha]),
    ignoreText: (text, matrix) => capture(text, matrix, ["ignore"]),
    clipText: (text, matrix) => capture(text, matrix, ["clip"]),
    strokeText: (text, s, matrix, space, color, alpha) =>
      capture(text, matrix, [
        "stroke",
        stroke(s),
        space.getName(),
        color,
        alpha,
      ]),
    clipStrokeText: (text, s, matrix) =>
      capture(text, matrix, ["clipStroke", stroke(s)]),
  });
  page.run(device, mupdf.Matrix.identity);
  device.close();
  device.destroy();
  // Structured text can round origins by a few float32 ulps. Spatial buckets
  // avoid scanning every occurrence of a repeated letter for each character.
  const cell = Math.max(
      1e-5,
      ...page.getBounds().map((n) => Math.abs(n) * 2 ** -21),
    ),
    grid = new Map<string, Cluster[]>(),
    key = (font: number, char: string, x: number, y: number) =>
      `${font}:${char}:${x}:${y}`;
  for (const record of records) {
    const k = key(
      record.font,
      record.chars[0],
      Math.floor(record.origin[0] / cell),
      Math.floor(record.origin[1] / cell),
    );
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(record);
  }
  let pending: Cluster | undefined,
    offset = 0;
  return {
    line() {
      pending = undefined;
      offset = 0;
    },
    char(
      char: string,
      origin: number[],
      font: mupdf.Font,
    ): string[] | undefined {
      if (
        pending &&
        pending.font === font.pointer &&
        pending.chars[offset] === char
      ) {
        const shape = pending.shape;
        if (++offset >= pending.chars.length) pending = undefined;
        return shape;
      }
      pending = undefined;
      const x = Math.floor(origin[0] / cell),
        y = Math.floor(origin[1] / cell);
      let match: Cluster | undefined,
        distance = cell;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (const item of grid.get(
            key(font.pointer, char, x + dx, y + dy),
          ) ?? []) {
            const d = Math.max(
              Math.abs(item.origin[0] - origin[0]),
              Math.abs(item.origin[1] - origin[1]),
            );
            if (d <= distance) {
              distance = d;
              match = item;
            }
          }
      if (match && match.chars.length > 1) {
        pending = match;
        offset = 1;
      }
      return match?.shape;
    },
  };
}
