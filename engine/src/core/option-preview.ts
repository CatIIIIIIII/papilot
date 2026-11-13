import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { App } from "../server.ts";
import type { Op, RenderedRound, RoundDetail, Unit } from "../types.ts";
import { groupFormattingChanges } from "./formatting-changes.ts";
import { splitLines } from "./changes.ts";
import { Builder, buildDate } from "./build.ts";
import { readJson, writeJson } from "./files.ts";
import { render, sourceComparison } from "./publish.ts";
import type { OptionInput } from "./note-options.ts";

/** Keep annotation IDs and old ranges stable while adjusting candidate ranges.
 * This only constructs buffers: neither checkout nor review decisions change. */
export function optionCandidate(units: Unit[], edits: OptionInput["edits"], source: (file: string) => string,
  restored: { ids: Set<string>; source: (file: string) => Buffer | null } = { ids: new Set(), source: () => null }) {
  const chosen = new Map(edits.map(edit => [edit.unit, edit.text]));
  const files: Record<string, Buffer | null> = {}, updated = structuredClone(units.filter(unit => !restored.ids.has(unit.id)));
  for (const file of new Set(units.filter(unit => chosen.has(unit.id) || restored.ids.has(unit.id)).map(unit => unit.file))) {
    const rejected = units.filter(unit => unit.file === file && restored.ids.has(unit.id));
    const before = rejected.length ? restored.source(file) : null;
    if (rejected.some(unit => unit.whole_file)) {
      if (units.some(unit => unit.file === file && chosen.has(unit.id))) throw new Error("These changes overlap and must be revised together.");
      files[file] = before; continue;
    }
    const original = source(file);
    const patches = units.filter(unit => unit.file === file && chosen.has(unit.id)).map(unit => {
      if (unit.text_ops?.length !== 1) throw new Error("This change cannot be previewed independently.");
      const [, , , start, end] = unit.text_ops[0];
      return { id: unit.id, start, end, text: chosen.get(unit.id)! };
    });
    const offset = (text: string, line: number) => splitLines(text).slice(0, line).join("").length;
    for (const unit of rejected) {
      if (!before) throw new Error("The original source is unavailable.");
      const old = before.toString("utf8");
      const ops = unit.text_ops ?? unit.ops.map(([tag, i, j, x, y]): Op => [tag, offset(old, i), offset(old, j), offset(original, x), offset(original, y)]);
      for (const [, i, j, start, end] of ops) patches.push({ id: unit.id, start, end, text: old.slice(i, j) });
    }
    patches.sort((a, b) => a.start - b.start);
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
export async function previewNoteOption(app: App, name: string, input: OptionInput & { rejected?: string[] }): Promise<RoundDetail> {
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
  const project = app.project;
  // A saved round is immutable. Opening it tomorrow or after an app restart
  // must not invalidate its comparisons (or change \today in the document).
  const date = round.summary.date ?? buildDate(new Date(round.created * 1000), {});
  const targets = round.summary.targets.length ? round.summary.targets : ["full"];
  const rejected = round.units.filter(unit => decisions[unit.id] === "rejected").map(unit => unit.id).sort();
  // The host's comparison key describes the state it read before this request.
  // Check that state again here, before any await or cache lookup, so a racing
  // rejection/undo cannot put a different comparison under the browser's key.
  if (input.rejected !== undefined && JSON.stringify(input.rejected) !== JSON.stringify(rejected))
    throw new Error("The review changed. Reload the options.");
  const key = createHash("sha256").update(JSON.stringify([3, round.before, round.after, input.edits, rejected, project, targets, date, ...(round.summary.sourceOnly ? [true] : [])])).digest("hex");
  const output = path.join(app.state, "cache/option-previews", name, String(round.number), key);
  const cached = readJson<RoundDetail | null>(path.join(output, "preview.json"), null);
  if (cached) return cached;
  if (pending.has(output)) return pending.get(output)!;
  const work = (async () => {
    const candidate = optionCandidate(round.units, input.edits, file => {
      const data = app.repo.blob(round.after, file);
      if (!data) throw new Error("The proposal source is unavailable.");
      return data.toString("utf8");
    }, { ids: new Set(rejected), source: file => app.repo.blob(round.before, file) });
    // An unreferenced Git object is safe to compile; no branch or index moves.
    const after = await app.repo.commitWithAsync(round.after, candidate.files, "Preview note option");
    const builder = new Builder(project, app.repo);
    // Reuse precisely the baseline and chapter scope the author is reviewing.
    // Rebuilding the whole thesis here was both slow and a different comparison.
    const keys = round.summary.builds;
    const seed = targets.includes("full") ? null
      : (keys.length > 2 ? await builder.completed(keys[0]) : null) ?? await builder.buildSeed(task.base);
    const baseline = keys.length >= 2 ? await builder.completed(keys.at(-2)!) : null;
    const [old, next] = await Promise.all([
      round.summary.sourceOnly ? null : baseline ?? builder.build(round.before, targets, seed, { date }),
      builder.build(after, targets, seed, { date }),
    ]);
    fs.mkdirSync(output, { recursive: true });
    // A choice can restore part of the original wording (including cancelling
    // an insertion). Keep its decision ID in the saved round, but do not render
    // a before/after card for an edit that this candidate no longer contains.
    const visible = candidate.units.filter(unit => unit.kind !== "text" || unit.truncated || unit.whole_file || unit.old_text !== unit.new_text);
    if (old) await render(output, { main: project.main, source_dir: project.source_dir, figures: project.figures, old, new: next, units: visible, indirect: false });
    const rendered = old
      ? readJson<RenderedRound>(path.join(output, "round.json"), { units: {}, sections: [], loose: [] })
      : sourceComparison(visible);
    fs.copyFileSync(next.pdf, path.join(output, "preview.pdf"));
    const files = `/option-files/${name}/${round.number}/${key}/`;
    const detail: RoundDetail = groupFormattingChanges({ ...rendered, task: name, round: round.number, before: round.before, after,
      units: visible.map(unit => ({ ...unit, ...rendered.units[unit.id] })),
      warnings: [...(old?.warnings ?? []), ...next.warnings], files, pdf: files + "preview.pdf", build: { key: next.key, targets },
      ...(round.summary.sourceOnly ? { sourceOnly: true, baselineErrors: round.summary.baselineErrors } : {}),
    }, file => app.repo.blob(round.before, file)?.toString("utf8") ?? null);
    writeJson(path.join(output, "preview.json"), detail);
    return detail;
  })();
  pending.set(output, work);
  try { return await work; }
  catch (error) { fs.rmSync(output, { recursive: true, force: true }); throw error; }
  finally { pending.delete(output); }
}
