import fs from "node:fs";
import path from "node:path";
import { shownBy } from "./effects.ts";
import { Build } from "./locate.ts";
import { renderMore, renderRound } from "./round.ts";
import type { Effect, RenderRequest } from "../types.ts";
const file = process.argv[2];
if (!file) throw new Error("Expected a renderer request file.");
const request = JSON.parse(fs.readFileSync(file, "utf8")) as RenderRequest & {
  effects?: Effect[];
  more?: string;
};
const out = path.dirname(file);
if (request.effects) {
  // `new` is a variant build: which of the changes it makes too.
  const old = new Build(request.old, request.main, request.source_dir),
    variant = new Build(request.new, request.main, request.source_dir);
  try {
    fs.writeFileSync(
      path.join(out, "shown.json"),
      JSON.stringify(shownBy(old, variant, request.effects)),
    );
  } finally {
    old.close();
    variant.close();
  }
} else if (request.more) renderMore(out, request.more);
else renderRound(request, out);
