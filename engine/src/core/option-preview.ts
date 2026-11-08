import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { App } from "../server.ts";
import type { Op, RenderedRound, RoundDetail, Unit } from "../types.ts";
import { codeVersion } from "../runtime.ts";
import { Builder, buildDate } from "./build.ts";
import { readJson, writeJson } from "./files.ts";
import { render } from "./publish.ts";
import type { OptionInput } from "./note-options.ts";

/** Keep annotation IDs and old ranges stable while adjusting candidate ranges.
 * This only constructs buffers: neither checkout nor review decisions change. */
export function optionCandidate(units: Unit[], edits: OptionInput["edits"], source: (file: string) => string) {
  const chosen = new Map(edits.map(edit => [edit.unit, edit.text]));
  const files: Record<string, Buffer> = {}, updated = structuredClone(units);
  for (const file of new Set(units.filter(unit => chosen.has(unit.id)).map(unit => unit.file))) {
    const original = source(file);
    const patches = units.filter(unit => unit.file === file && chosen.has(unit.id)).map(unit => {
      if (unit.text_ops?.length !== 1) throw new Error("This change cannot be previewed independently.");
      const [, , , start, end] = unit.text_ops[0];
      return { id: unit.id, start, end, text: chosen.get(unit.id)! };
    }).sort((a, b) => a.start - b.start);
    let text = original, boundary = original.length + 1;
    for (const patch of [...patches].reverse()) {
      if (patch.start < 0 || patch.end > original.length || patch.start > patch.end || patch.end >= boundary)
        throw new Error("These changes overlap and must be revised together.");
      text = text.slice(0, patch.start) + patch.text + text.slice(patch.end);
      // Adjacent nonempty replacements are independent; two insertions at
      // the same point are not.
      boundary = patch.start + (patch.start < patch.end ? 1 : 0);
    }
    files[file] = Buffer.from(text);
    const line = (offset: number) => text.slice(0, offset).split("\n").length - 1;
    for (const unit of updated.filter(unit => unit.file === file)) {
      if (!unit.text_ops?.length) throw new Error("This source range cannot be previewed independently.");
      unit.text_ops = unit.text_ops.map(([tag, i, j, x, y]): Op => {
        let shift = 0, own = patches.find(patch => patch.id === unit.id);
        for (const patch of patches) {
          if (patch === own) continue;
          if (patch.end <= x) shift += patch.text.length - (patch.end - patch.start);
          else if (patch.start < y) throw new Error("These changes overlap and must be revised together.");
        }
        return [tag, i, j, x + shift, own ? x + shift + own.text.length : y + shift];
      });
      unit.ops = unit.text_ops.map(([tag, , , x, y], index) => [tag, unit.ops[index][1], unit.ops[index][2], line(x), x === y ? line(x) : line(y - 1) + 1]);
      unit.new_start = unit.ops[0][3] + 1;
      unit.new_end = Math.max(unit.new_start, unit.ops.at(-1)![4]);
      if (chosen.has(unit.id)) unit.new_text = chosen.get(unit.id)!;
    }
  }
  return { files, units: updated };
}

const pending = new Map<string, Promise<RoundDetail>>();
export async function previewNoteOption(app: App, name: string, input: OptionInput): Promise<RoundDetail> {
  if (!input || !Array.isArray(input.edits) || !input.edits.length || input.edits.length > 100
    || input.edits.some(edit => !edit || typeof edit.unit !== "string" || typeof edit.text !== "string" || edit.text.includes("\0") || edit.text.length > 20000))
    throw new Error("Invalid note option.");
  const task = app.tasks.get(name), round = app.review.latestRound(name);
  app.delivery.assertReady(name);
  if (task.closed || !round || round.number !== input.round) throw new Error("A newer round is available. Reload the options.");
  if (app.publisher.busy(name)) throw new Error("Wait for the PDF build to finish.");
  const merge = app.reconciliation.get(name);
  if (merge && (!merge.ready || round.number <= merge.round)) throw new Error("Finish reviewing the merge suggestion first.");
  const decisions = app.review.decisions(name, round), ids = new Set<string>();
  for (const edit of input.edits) {
    const unit = round.units.find(unit => unit.id === edit.unit);
    if (!unit || unit.kind !== "text" || unit.truncated || unit.whole_file || unit.text_ops?.length !== 1 || ids.has(unit.id)) throw new Error("This change cannot be previewed independently.");
    if (decisions[unit.id] !== "pending") throw new Error("This option overlaps a reviewed change. Undo that decision before replacing it.");
    ids.add(unit.id);
  }
  const project = app.project, date = buildDate();
  const key = createHash("sha256").update(JSON.stringify([round.before, round.after, input.edits, project, date, codeVersion()])).digest("hex");
  const output = path.join(app.state, "cache/option-previews", name, String(round.number), key);
  const cached = readJson<RoundDetail | null>(path.join(output, "preview.json"), null);
  if (cached) return cached;
  if (pending.has(output)) return pending.get(output)!;
  const work = (async () => {
    const candidate = optionCandidate(round.units, input.edits, file => {
      const data = app.repo.blob(round.after, file);
      if (!data) throw new Error("The proposal source is unavailable.");
      return data.toString("utf8");
    });
    // An unreferenced Git object is safe to compile; no branch or index moves.
    const after = await app.repo.commitWithAsync(round.after, candidate.files, "Preview note option");
    const builder = new Builder(project, app.repo);
    const [old, next] = await Promise.all([
      builder.build(round.before, ["full"], null, { date, priority: "foreground" }),
      builder.build(after, ["full"], null, { date, priority: "foreground" }),
    ]);
    fs.mkdirSync(output, { recursive: true });
    await render(output, { main: project.main, source_dir: project.source_dir, figures: project.figures, old, new: next, units: candidate.units, indirect: false });
    const rendered = readJson<RenderedRound>(path.join(output, "round.json"), { units: {}, sections: [], loose: [] });
    fs.copyFileSync(next.pdf, path.join(output, "preview.pdf"));
    const files = `/option-files/${name}/${round.number}/${key}/`;
    const detail: RoundDetail = { ...rendered, task: name, round: round.number, before: round.before, after,
      units: candidate.units.map(unit => ({ ...unit, ...rendered.units[unit.id] })),
      warnings: [...old.warnings, ...next.warnings], files, pdf: files + "preview.pdf", build: { key: next.key, targets: ["full"] } };
    writeJson(path.join(output, "preview.json"), detail);
    return detail;
  })();
  pending.set(output, work);
  try { return await work; }
  catch (error) { fs.rmSync(output, { recursive: true, force: true }); throw error; }
  finally { pending.delete(output); }
}
