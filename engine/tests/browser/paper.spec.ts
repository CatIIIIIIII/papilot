import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { mupdf, PdfDocument } from "../../src/render/pdf.ts";
import { renderDocument, Strips } from "../../src/render/inline.ts";
import type { Build } from "../../src/render/locate.ts";
import type { ChangeBlock, Rect, RoundDetail } from "../../src/types.ts";

test("full-paper review preserves unchanged ink beside a column change", async ({
  page,
}) => {
  const folder = fs.mkdtempSync(
    path.join(os.tmpdir(), "review-paper-columns-"),
  );
  const raw = new mupdf.PDFDocument(),
    font = new mupdf.Font("Helvetica"),
    resource = raw.addSimpleFont(font);
  let content = "";
  for (const [side, x] of [
    ["LEFT", 35],
    ["RIGHT", 335],
  ] as const)
    for (let row = 0; row < 14; row++)
      content += `BT /F1 10 Tf ${x} ${530 - row * 26} Td (${side} ROW ${String(row).padStart(2, "0")} must remain fully readable) Tj ET\n`;
  const sheet = raw.addPage(
    [0, 0, 600, 600],
    0,
    { Font: { F1: resource } },
    content,
  );
  raw.insertPage(-1, sheet);
  sheet.destroy();
  const bytes = raw.saveToBuffer("");
  fs.writeFileSync(path.join(folder, "paper.pdf"), bytes.asUint8Array());
  const document = new PdfDocument(bytes.asUint8Array());
  bytes.destroy();
  resource.destroy();
  font.destroy();
  raw.destroy();
  let block: ChangeBlock, unchanged: Rect;
  try {
    expect(document.page(0).twoColumns).toBe(true);
    const rect = document.page(0).search("LEFT ROW 05")[0];
    unchanged = document.page(0).search("RIGHT ROW 05")[0];
    const build = { document, outline: [] } as unknown as Build;
    block = renderDocument(
      build,
      build,
      [
        {
          id: "fixture",
          file: "paper.tex",
          comparison: "text",
          aligned: true,
          pairs: [
            {
              old: { page: 0, clip: rect, label: "1" },
              new: { page: 0, clip: rect, label: "1" },
              group: 0,
              before_marks: [],
              after_marks: [{ kind: "added", rect }],
            },
          ],
        },
      ],
      new Strips(folder),
      () => false,
    ).loose[0];
    expect(block.after[0].width).toBeLessThan(300);
  } finally {
    document.close();
  }
  try {
    await page.route("**/column-fixture/*", async (route) => {
      const name = path.basename(new URL(route.request().url()).pathname);
      await route.fulfill({
        body: fs.readFileSync(path.join(folder, name)),
        contentType: name.endsWith(".pdf")
          ? "application/pdf"
          : "image/svg+xml",
      });
    });
    await page.route(
      /\/api\/tasks\/tighten-design\/rounds\/\d+$/,
      async (route) => {
        const response = await route.fetch(),
          detail = (await response.json()) as RoundDetail;
        const unit = {
          ...detail.units[0],
          visual: "text" as const,
          effects: undefined,
        };
        await route.fulfill({
          json: {
            ...detail,
            units: [unit],
            sections: [],
            loose: [{ ...block, units: [unit.id] }],
            pdf: "/column-fixture/paper.pdf",
            files: "/column-fixture/",
            passes: undefined,
            references: undefined,
          },
        });
      },
    );
    await page.goto("/?task=tighten-design");
    await page.getByRole("button", { name: "PDF", exact: true }).click();
    await expect(page.locator(".paper .change")).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator(".paper .change img")
          .evaluateAll((images) =>
            images.every(
              (image) =>
                (image as HTMLImageElement).complete &&
                (image as HTMLImageElement).naturalWidth > 0,
            ),
          ),
      )
      .toBe(true);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      // Read the actual PDF canvas: the adjacent unchanged word must have
      // a visible owner and dark ink, including after a responsive repaint.
      await expect
        .poll(async () =>
          page.locator(".paper-slice").evaluateAll((slices, rect) => {
            const x = (rect[0] + rect[2]) / 2,
              y = (rect[1] + rect[3]) / 2;
            for (const element of slices) {
              const box = element as HTMLElement,
                left = Number(box.dataset.left ?? 0),
                right = Number(box.dataset.right ?? 600),
                top = Number(box.dataset.top),
                bottom = Number(box.dataset.bottom);
              if (x < left || x >= right || y < top || y >= bottom) continue;
              const canvas = box.querySelector("canvas"),
                context = canvas?.getContext("2d");
              if (!canvas || !context || !canvas.width || !canvas.height)
                continue;
              const x0 = Math.max(
                  0,
                  Math.floor(
                    ((rect[0] - left) / (right - left)) * canvas.width,
                  ),
                ),
                y0 = Math.max(
                  0,
                  Math.floor(
                    ((rect[1] - top) / (bottom - top)) * canvas.height,
                  ),
                );
              const x1 = Math.min(
                  canvas.width,
                  Math.ceil(((rect[2] - left) / (right - left)) * canvas.width),
                ),
                y1 = Math.min(
                  canvas.height,
                  Math.ceil(((rect[3] - top) / (bottom - top)) * canvas.height),
                );
              if (x1 <= x0 || y1 <= y0) continue;
              const pixels = context.getImageData(
                x0,
                y0,
                x1 - x0,
                y1 - y0,
              ).data;
              let dark = 0;
              for (let i = 0; i < pixels.length; i += 4)
                if (pixels[i] < 128 && pixels[i + 3] > 0) dark++;
              if (dark > 10) return true;
            }
            return false;
          }, unchanged),
        )
        .toBe(true);
      await page.screenshot({
        path: `.cache/browser-paper-columns-${width}.png`,
      });
    }
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
