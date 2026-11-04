import { createHash } from "node:crypto";
import { splitLines, textOf } from "./changes.ts";
import { opcodesWithin } from "./diff.ts";
import { readBytes, same, writeOrDelete } from "./files.ts";
import { safePath } from "./review.ts";
import type { App } from "../server.ts";
import type { SourceExcerpt, SourceEditRequest } from "../types.ts";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const revision = (value: Buffer | null) => hash(value === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), value]));
type SavedEdit = { request: string; file: string; expected: string | null; target: string; applied: boolean };

// Follow this hunk through other decisions and earlier manual edits. Refuse
// changes crossing its boundaries rather than opening an unrelated passage.
export function sourceRange(before: string[], current: string[], start: number, end: number): [number, number] {
  const ops = opcodesWithin(before, current, 1000);
  if (!ops) throw new Error("The source could not be located. Rebuild the review and try again.");
  const boundary = (at: number, right: boolean) => {
    const positions: number[] = [];
    for (const [kind, a, b, x, y] of ops) {
      if (kind !== "equal" && a < at && at < b)
        throw new Error("This passage changed outside its displayed range. Rebuild the review and try again.");
      if (a === at && a === b) positions.push(x, y);
      else if (at >= a && at <= b) positions.push(kind === "equal" ? x + at - a : at === a ? x : y);
    }
    return positions.length ? (right ? Math.max(...positions) : Math.min(...positions)) : current.length;
  };
  return [boundary(start, false), boundary(end, true)];
}

export class SourceEdits {
  constructor(private app: App) {}

  private context(name: string, number: number, change: string) {
    const task = this.app.tasks.get(name), round = this.app.review.latestRound(name);
    this.app.delivery.assertReady(name);
    if (!round || round.number !== number) throw new Error("A newer round is available. Reload the page.");
    const reconciliation = this.app.reconciliation.get(name);
    if (reconciliation && (!reconciliation.ready || number <= reconciliation.round))
      throw new Error("Review the new merge suggestion before editing source.");
    const unit = round.units.find(unit => unit.id === change);
    if (!unit || unit.kind === "binary") throw new Error("This change has no editable text source.");
    if (this.app.review.decisions(name, round)[change] === "rejected")
      throw new Error("This change was rejected. Undo that decision before editing it.");
    return { task, round, unit };
  }

  read(name: string, number: number, change: string): SourceExcerpt {
    const { task, round, unit } = this.context(name, number, change);
    const current = readBytes(safePath(task.worktree, unit.file));
    const original = textOf(this.app.repo.blob(round.after, unit.file)), text = textOf(current);
    if (original === null || text === null) throw new Error("This change has no editable text source.");
    if (Buffer.byteLength(text) > 2_000_000) throw new Error("This source file is too large for inline editing.");
    const lines = splitLines(text), prior = splitLines(original);
    const [start, end] = unit.whole_file ? [0, lines.length] : sourceRange(prior, lines, unit.ops[0][3], unit.ops.at(-1)![4]);
    return { round: number, change, file: unit.file, revision: revision(current), start, end, text: lines.slice(start, end).join("") };
  }

  save(name: string, input: SourceEditRequest) {
    return this.app.exclusive(() => {
      const identity = input.id;
      if (!/^[A-Za-z0-9-]{1,80}$/.test(identity) || typeof input.text !== "string" || input.text.includes("\0") || input.text.length > 200000)
        throw new Error("Invalid source edit.");
      const request = hash(JSON.stringify(input));
      let saved = this.app.store.one<{ task: string; data: SavedEdit }>("SELECT task,data FROM source_edits WHERE id=?", identity);
      if (saved && (saved.task !== name || saved.data.request !== request)) throw new Error("This edit ID was already used for another edit.");
      if (!saved) {
        if (this.app.publisher.busy(name)) throw new Error("Wait for the PDF build before editing source.");
        const source = this.read(name, input.round, input.change);
        if (source.revision !== input.revision) throw new Error("The source changed while you were editing. Copy your draft before resetting to the saved source.");
        const task = this.app.tasks.get(name), file = safePath(task.worktree, source.file), current = readBytes(file);
        if (revision(current) !== source.revision) throw new Error("The source changed before this edit could be saved. Your draft is kept.");
        const lines = splitLines(current?.toString("utf8") ?? "");
        // Keep the following line separate when a user replaces the selection
        // without typing its final newline. Preserve CRLF files as well.
        const eol = current?.includes(Buffer.from("\r\n")) ? "\r\n" : "\n";
        let replacement = input.text.replace(/\r\n/g, "\n").replace(/\n/g, eol);
        if (replacement && !replacement.endsWith("\n") && (source.text.endsWith("\n") || source.end < lines.length)) replacement += eol;
        lines.splice(source.start, source.end - source.start, replacement);
        const data: SavedEdit = { request, file: source.file, expected: current?.toString("base64") ?? null, target: Buffer.from(lines.join("")).toString("base64"), applied: false };
        this.app.store.execute("INSERT INTO source_edits(id,task,data) VALUES(?,?,?)", identity, name, JSON.stringify(data));
        saved = { task: name, data };
      }
      if (!saved.data.applied) {
        const task = this.app.tasks.get(name), file = safePath(task.worktree, saved.data.file), current = readBytes(file);
        const expected = saved.data.expected === null ? null : Buffer.from(saved.data.expected, "base64"), target = Buffer.from(saved.data.target, "base64");
        if (!same(current, expected) && !same(current, target)) throw new Error("The source changed before this edit could be saved. Your draft is kept.");
        if (!same(current, target)) writeOrDelete(file, target);
        saved.data.applied = true;
        this.app.store.execute("UPDATE source_edits SET data=? WHERE id=?", JSON.stringify(saved.data), identity);
      }
      // The write and build have persistent identities. Retrying a lost
      // response must never apply the edit twice or start a second build.
      this.app.publisher.submit(name, `source-${hash(identity)}`);
      return this.app.review.pageState(name);
    });
  }
}
