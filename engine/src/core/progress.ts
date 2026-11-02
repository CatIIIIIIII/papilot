import fs from "node:fs";
import type { BuildProgress } from "../types.ts";

// What latexmk is doing, read from its output as it streams: the rule it
// runs, the TeX pass, and the pages TeX has shipped out in that pass. TeX
// prints "[n" for every page and flushes the terminal right after, so the
// count moves while a long document typesets.
const RUN = /^Run number (\d+) of rule '([^']+)'/;
const WRITTEN = /^Output written on .*?\((\d+) pages?\b/;
// A page marker is "[" with \count0 (and any nonzero \count1–9), closed by
// "]", a space, or the font map and image notes TeX prints inside it.
const PAGE = /\[-?\d+(?:\.-?\d+)*(?=[\]\s{<(])/g;

export function progressReader(
  report: (progress: BuildProgress) => void,
  total: number | null,
) {
  const state: BuildProgress = { step: "tex", pass: 0, pages: 0, total };
  let line = "",
    scanned = 0;
  const pages = (text: string, from: number) => {
    if (state.step !== "tex" || state.pass === 0) return text.length;
    PAGE.lastIndex = from;
    let end = from;
    while (PAGE.exec(text)) {
      state.pages++;
      end = PAGE.lastIndex;
    }
    // An unfinished marker at the end counts once it is complete.
    const open = text.lastIndexOf("[");
    return open >= end && /^\[-?[\d.]*$/.test(text.slice(open)) ? open : text.length;
  };
  report({ ...state });
  return (chunk: Buffer) => {
    const before = JSON.stringify(state),
      parts = (line + chunk.toString("latin1")).split("\n");
    line = parts.pop()!;
    for (const complete of parts) {
      const run = RUN.exec(complete),
        written = WRITTEN.exec(complete);
      if (run) {
        const rule = run[2].split(" ")[0];
        if (/^(?:pdf|xe|lua)?latex$/.test(rule))
          Object.assign(state, { step: "tex", pass: Number(run[1]), pages: 0 });
        else
          state.step = /^(?:xdvipdfmx|dvipdfmx?|dvips|ps2pdf)$/.test(rule)
            ? "pdf"
            : "bibliography";
      } else if (written) state.total = state.pages = Number(written[1]);
      else pages(complete, scanned);
      scanned = 0;
    }
    scanned = pages(line, scanned);
    if (JSON.stringify(state) !== before) report({ ...state });
  };
}

// The pages of the build a compilation continues from, as TeX reported them.
export function writtenPages(log: string): number | null {
  try {
    const text = fs.readFileSync(log, "latin1"),
      found = [...text.matchAll(/Output written on .*?\((\d+) pages?\b/g)].at(-1);
    return found ? Number(found[1]) : null;
  } catch {
    return null;
  }
}
