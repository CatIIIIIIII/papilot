import { createHash } from "node:crypto";
import type { App } from "../server.ts";
import type { Unit } from "../types.ts";
import { applyUnits, diffUnitsAsync } from "./changes.ts";
import { isFigure } from "./config.ts";
import { readBytes, same, writeOrDelete } from "./files.ts";
import { merge3Async } from "./git.ts";
import { safePath } from "./review.ts";
import { optionCandidate } from "./option-preview.ts";
import { textEdits } from "./text-edits.ts";

export interface OptionInput { id: string; round: number; edits: { unit: string; text: string }[]; accept?: boolean }
type Saved = { request: string; writes: { file: string; before: string; after: string }[]; applied: boolean; publishRequest?: string; comparison?: { before: string; after: string; units: Unit[] }; accept?: { id: string; before: string; units: Unit[] } };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

// Follow an unchanged source span across other decisions. Repeated wording is
// not an anchor: offsets come from the complete source comparison, and a
// replacement crossing this span must fail rather than pick a similar phrase.
function mappedRange(before: string, after: string, start: number, end: number): [number, number] {
  let shift = 0;
  for (const [, a, b, x, y] of textEdits(before, after)) {
    if (a === b && start === end && a === start)
      throw new Error('The selected source range changed. Review it before accepting.');
    if (b <= start) shift += y - x - (b - a);
    else if (a < end || (start === end && a < start && b > start))
      throw new Error('The selected source range changed. Review it before accepting.');
  }
  const result: [number, number] = [start + shift, end + shift];
  if (after.slice(...result) !== before.slice(start, end))
    throw new Error('The selected source range changed. Review it before accepting.');
  return result;
}

async function preserveRanges(app: App, before: string, after: string, anchors: Unit[], original: (file: string) => string, proposed: (file: string) => string) {
  const units = await diffUnitsAsync(app.repo, before, after, file => isFigure(app.project, file));
  const files = new Map<string, { old: string; next: string; original: string; proposed: string }>();
  const source = (file: string) => {
    if (!files.has(file)) files.set(file, {
      old: app.repo.blob(before, file)!.toString('utf8'), next: app.repo.blob(after, file)!.toString('utf8'),
      original: original(file), proposed: proposed(file),
    });
    return files.get(file)!;
  };
  const selected = anchors.map(unit => {
    const [, a, b, x, y] = unit.text_ops![0];
    const { old, next, original, proposed } = source(unit.file);
    const [i, j] = mappedRange(original, old, a, b);
    const [u, v] = mappedRange(proposed, next, x, y);
    const line = (text: string, offset: number) => text.slice(0, offset).split('\n').length - 1;
    const tag = i === j ? 'insert' : u === v ? 'delete' : 'replace';
    return { ...unit, old_start: line(old, i) + 1, old_end: line(old, Math.max(i, j - 1)) + 1,
      new_start: line(next, u) + 1, new_end: line(next, Math.max(u, v - 1)) + 1,
      text_ops: [[tag, i, j, u, v]], ops: [[tag, line(old, i), i === j ? line(old, i) : line(old, j - 1) + 1, line(next, u), u === v ? line(next, u) : line(next, v - 1) + 1]],
      old_text: old.slice(i, j), new_text: next.slice(u, v) } as Unit;
  });
  const overlaps = (a: number, b: number, x: number, y: number) => a === b || x === y ? a <= y && x <= b : a < y && x < b;
  const remaining = units.filter(unit => !selected.some(anchor => {
    if (unit.file !== anchor.file) return false;
    const [, i, j, x, y] = anchor.text_ops![0];
    if (!unit.text_ops?.length) throw new Error('This change cannot be replaced independently.');
    const { old, next } = source(unit.file);
    // Tokenization can include equal surrounding whitespace in a deletion.
    // Only bytes that actually change determine whether it crosses the
    // authorized span; the reconstruction check below preserves every byte.
    const exact = unit.text_ops.map(([, a, b, u, v]) => {
      while (a < b && u < v && old[a] === next[u]) { a++; u++; }
      while (a < b && u < v && old[b - 1] === next[v - 1]) { b--; v--; }
      return [a, b, u, v];
    });
    if (!exact.some(([a, b, u, v]) => overlaps(i, j, a, b) || overlaps(x, y, u, v))) return false;
    if (exact.some(([a, b, u, v]) => a < i || b > j || u < x || v > y))
      throw new Error('These changes overlap and must be revised together.');
    return true;
  }));
  const combined = [...remaining, ...selected].sort((a, b) => a.file.localeCompare(b.file) || a.old_start - b.old_start || (a.text_ops?.[0][1] ?? 0) - (b.text_ops?.[0][1] ?? 0));
  combined.forEach((unit, i) => { unit.id = `c${String(i + 1).padStart(3, '0')}`; });
  // Replacing narrower diffs with the chosen source span must neither include
  // a neighbor nor omit any part of the actual proposal.
  for (const file of new Set(selected.map(unit => unit.file))) {
    const { old, next } = source(file);
    if (applyUnits(Buffer.from(old), Buffer.from(next), combined.filter(unit => unit.file === file))?.toString('utf8') !== next)
      throw new Error('These changes overlap and must be revised together.');
  }
  return { comparison: { before, after, units: combined }, selected };
}

async function optionComparison(app: App, name: string, edits: OptionInput['edits'], writes: Saved['writes']) {
  const task = app.tasks.get(name), round = app.review.latestRound(name)!;
  const candidate = optionCandidate(round.units, edits, file => app.repo.blob(round.after, file)!.toString('utf8'));
  const before = task.accepted;
  // The actual worktree already contains rejections and independent manual
  // edits. Preserve those while preparing a comparison for the pending option.
  const current = await app.tasks.snapshotAsync(task);
  const after = await app.repo.commitWithAsync(current, Object.fromEntries(writes.map(write => [write.file, Buffer.from(write.after, 'base64')])), 'Selected note option');
  const chosen = new Set(edits.map(edit => edit.unit));
  return preserveRanges(app, before, after, candidate.units.filter(unit => chosen.has(unit.id)),
    file => app.repo.blob(round.before, file)!.toString('utf8'), file => candidate.files[file].toString('utf8'));
}

// An option changes wording inside an existing review unit. Keep that range
// through publication so selecting e.g. “numerically stable” does not turn
// the original “stable” unit into an unrelated insertion and lose its choices.
export async function noteOptionUnits(app: App, name: string, job: string, before: string, after: string) {
  const saved = app.store.one<{ data: Saved }>("SELECT s.data FROM source_edits s JOIN build_requests b ON b.id=json_extract(s.data,'$.publishRequest') WHERE b.job=? AND s.task=?", job, name)?.data;
  if (!saved?.applied || !saved.comparison) return;
  if (saved.comparison.before === before && await app.repo.treeIdAsync(saved.comparison.after) === await app.repo.treeIdAsync(after))
    return saved.comparison.units;
  // A decision made while this option compiles can move the accepted baseline
  // or revert another proposal. Rebase the authorized spans, not their narrower
  // fresh diffs, so retained old words do not become unrelated insertions.
  if (saved.accept) {
    const rebased = await preserveRanges(app, before, after, saved.accept.units,
      file => app.repo.blob(saved.comparison!.before, file)!.toString('utf8'),
      file => app.repo.blob(saved.comparison!.after, file)!.toString('utf8'));
    return rebased.comparison.units;
  }
}

/** The checkmark authorizes only this note's edits. Finish that decision after
 * its PDF is published, using the normal idempotent, undoable review journal. */
export async function acceptNoteOption(app: App, name: string, job: string) {
  const saved = app.store.one<{ data: Saved }>("SELECT s.data FROM source_edits s JOIN build_requests b ON b.id=json_extract(s.data,'$.publishRequest') WHERE b.job=? AND s.task=?", job, name)?.data;
  if (!saved?.accept) return;
  const round = app.review.latestRound(name);
  if (!round) throw new Error('The selected option has not been published.');
  const changes = saved.accept.units.map(original => {
    if (original.text_ops?.length !== 1) throw new Error('The selected source range changed. Review it before accepting.');
    const [, a, b] = original.text_ops[0];
    const prior = app.repo.blob(saved.accept!.before, original.file)?.toString('utf8');
    const next = app.repo.blob(round.before, original.file)?.toString('utf8');
    if (prior === undefined || next === undefined) throw new Error('The selected source range changed. Review it before accepting.');
    const [start, end] = mappedRange(prior, next, a, b);
    const matches = round.units.filter(unit => {
      if (unit.file !== original.file || unit.old_text !== original.old_text || unit.new_text !== original.new_text) return false;
      return unit.text_ops?.length === 1 && unit.text_ops[0][1] === start && unit.text_ops[0][2] === end;
    });
    if (matches.length !== 1) throw new Error('The selected source range changed. Review it before accepting.');
    return matches[0].id;
  });
  await app.review.decide(name, { id: saved.accept.id, round: round.number, changes, action: 'accept' });
}

/** Replace only pending source ranges. The existing source-save build and
 * review journal retain responsibility for compilation and later acceptance. */
export function useNoteOption(app: App, name: string, input: OptionInput) {
  return app.exclusive(async () => {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(input.id) || !Array.isArray(input.edits) || !input.edits.length || input.edits.length > 100
      || input.edits.some(edit => typeof edit.unit !== "string" || typeof edit.text !== "string" || edit.text.includes("\0") || edit.text.length > 20000))
      throw new Error("Invalid note option.");
    const identity = `option-${input.id}`, request = hash(JSON.stringify(input));
    let saved = app.store.one<{ task: string; data: Saved }>("SELECT task,data FROM source_edits WHERE id=?", identity);
    if (saved && (saved.task !== name || saved.data.request !== request)) throw new Error("This option request was already used.");
    const task = app.tasks.get(name);
    app.delivery.assertReady(name);
    if (task.closed) throw new Error("This task is closed.");
    if (!saved) {
      const round = app.review.latestRound(name), merge = app.reconciliation.get(name);
      if (app.publisher.busy(name)) throw new Error("Wait for the PDF build to finish.");
      if (!round || round.number !== input.round) throw new Error("A newer round is available. Reload the options.");
      if (merge && (!merge.ready || round.number <= merge.round)) throw new Error("Finish reviewing the merge suggestion first.");
      const states = app.review.decisions(name, round), ids = new Set<string>();
      const groups = new Map<string, { unit: Unit; text: string }[]>();
      for (const edit of input.edits) {
        const unit = round.units.find(unit => unit.id === edit.unit);
        if (!unit || unit.truncated || unit.whole_file || unit.kind !== "text" || unit.text_ops?.length !== 1 || ids.has(unit.id)) throw new Error("This change cannot be replaced independently.");
        if (states[unit.id] !== "pending") throw new Error("This option overlaps a reviewed change. Undo that decision before replacing it.");
        ids.add(unit.id);
        if (!groups.has(unit.file)) groups.set(unit.file, []);
        groups.get(unit.file)!.push({ unit, text: edit.text });
      }
      const writes: Saved["writes"] = [];
      for (const [file, edits] of groups) {
        const original = app.repo.blob(round.after, file);
        if (!original) throw new Error("The proposal source is unavailable.");
        let text = original.toString("utf8"), boundary = text.length;
        for (const { unit, text: replacement } of edits.sort((a, b) => b.unit.text_ops![0][3] - a.unit.text_ops![0][3])) {
          const [, , , start, end] = unit.text_ops![0];
          if (end > boundary) throw new Error("These changes overlap and must be revised together.");
          text = text.slice(0, start) + replacement + text.slice(end); boundary = start;
        }
        const current = readBytes(safePath(task.worktree, file));
        const [merged, conflict] = await merge3Async(current, original, Buffer.from(text));
        if (conflict || !current || !merged) throw new Error("The source changed since these options were prepared. Reload the review.");
        writes.push({ file, before: current.toString("base64"), after: merged.toString("base64") });
      }
      const { comparison, selected } = await optionComparison(app, name, input.edits, writes);
      const accept = input.accept ? { id: `note-accept-${hash(identity)}`, before: comparison.before, units: selected } : undefined;
      saved = { task: name, data: { request, writes, applied: false, publishRequest: `source-${hash(identity)}`, ...(comparison ? { comparison } : {}), ...(accept ? { accept } : {}) } };
      app.store.execute("INSERT INTO source_edits(id,task,data) VALUES(?,?,?)", identity, name, JSON.stringify(saved.data));
    }
    if (!saved.data.applied) {
      // Validate every file before writing any. A retry also completes an
      // interrupted multi-file write without applying the replacement twice.
      for (const write of saved.data.writes) {
        const current = readBytes(safePath(task.worktree, write.file));
        if (!same(current, Buffer.from(write.before, "base64")) && !same(current, Buffer.from(write.after, "base64"))) throw new Error("The source changed before this option could be saved.");
      }
      for (const write of saved.data.writes) writeOrDelete(safePath(task.worktree, write.file), Buffer.from(write.after, "base64"));
      saved.data.applied = true;
      app.store.execute("UPDATE source_edits SET data=? WHERE id=?", JSON.stringify(saved.data), identity);
    }
    app.publisher.submit(name, `source-${hash(identity)}`);
    return app.review.pageState(name);
  });
}
