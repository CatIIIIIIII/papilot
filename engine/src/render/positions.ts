import { PdfDocument } from "./pdf.ts";
import type { Strip } from "../types.ts";

// Where strips start on their page, for rounds rendered before strips
// recorded it. A strip keeps its characters relative to its top, read from
// the same PDF page by the same code: the difference between a character's
// place on the page and in the strip is where the strip starts. A strip
// without text (a figure alone) stays unplaced.
export function stripTops(pdf: string, strips: Strip[]) {
  const document = new PdfDocument(pdf);
  try {
    for (const strip of strips) {
      if (strip.top !== undefined || strip.page < 1 || strip.page > document.length) continue;
      const page = document.page(strip.page - 1);
      found: for (const line of strip.text ?? []) {
        if (line.chars.length < 3) continue;
        for (const candidate of page.lines)
          if (
            candidate.chars.length === line.chars.length &&
            candidate.chars.every(
              (char, i) =>
                char.text === line.chars[i].text &&
                Math.abs(char.rect[0] - line.chars[i].rect[0]) < 0.01,
            )
          ) {
            strip.top = Math.round((candidate.chars[0].rect[1] - line.chars[0].rect[1]) * 100) / 100;
            break found;
          }
      }
    }
  } finally {
    document.close();
  }
}
