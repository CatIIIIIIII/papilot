import { createHash } from "node:crypto";
import { revertUnits, splitLines, textOf } from "./changes.ts";
import { opcodesWithin } from "./diff.ts";
import { readBytes, same, writeOrDelete } from "./files.ts";
import { safePath } from "./review.ts";
import type { App } from "../server.ts";
import type { PageState, SourceExcerpt, SourceEditRequest, SourceFileRead, SourceFileSave } from "../types.ts";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const revision = (value: Buffer | null) => hash(value === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), value]));
type SavedEdit = { request: string; file: string; expected: string | null; target: string; applied: boolean };
const MAX_FILE = 2_000_000, BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** A whole file edited as text, with \n line breaks, as bytes in the file's
 *  own line endings and with its byte order mark. */
export function fileBytes(current: Buffer, text: string) {
  const plain = text.replace(/\r\n/g, "\n"), crlf = current.includes(Buffer.from("\r\n"));
  return Buffer.concat([current.subarray(0, 3).equals(BOM) ? BOM : Buffer.alloc(0), Buffer.from(crlf ? plain.replace(/\n/g, "\r\n") : plain, "utf8")]);
}

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

  // Source is edited in the latest round, with no delivery or merge
  // suggestion waiting.
  private writable(name: string, number: number) {
    const task = this.app.tasks.get(name), round = this.app.review.latestRound(name);
    this.app.delivery.assertReady(name);
    if (!round || round.number !== number) throw new Error("A newer round is available. Reload the page.");
    const reconciliation = this.app.reconciliation.get(name);
    if (reconciliation && (!reconciliation.ready || number <= reconciliation.round))
      throw new Error("Review the new merge suggestion before editing source.");
    return { task, round };
  }

  private context(name: string, number: number, change: string) {
    const { task, round } = this.writable(name, number);
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
    return this.app.exclusive(async () => {
      const identity = input.id;
      if (!/^[A-Za-z0-9-]{1,80}$/.test(identity) || typeof input.text !== "string" || input.text.includes("\0") || input.text.length > 200000)
        throw new Error("Invalid source edit.");
      const request = hash(JSON.stringify(input));
      let saved = this.app.store.one<{ task: string; data: SavedEdit }>("SELECT task,data FROM source_edits WHERE id=?", identity);
      if (saved && (saved.task !== name || saved.data.request !== request)) throw new Error("This edit ID was already used for another edit.");
      if (!saved) {
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
      return this.publish(name, identity, saved.data);
    });
  }

  /** A whole file of the task, for an editor beside the review. */
  readFile(name: string, file: string): SourceFileRead {
    const task = this.app.tasks.get(name), round = this.app.review.latestRound(name);
    if (!round) throw new Error("This task has no review yet.");
    const current = readBytes(safePath(task.worktree, file));
    if (current === null) throw new Error("This source file no longer exists.");
    if (current.length > MAX_FILE) throw new Error("This source file is too large to edit here.");
    const text = textOf(current);
    if (text === null) throw new Error("This file is not text that can be edited here.");
    const base = this.app.repo.blob(task.base, file), before = this.app.repo.blob(round.before, file), after = this.app.repo.blob(round.after, file);
    // A reject puts its text back in the worktree without a new round.
    const decisions = this.app.review.decisions(name, round), rejected = round.units.filter(unit => unit.file === file && unit.kind === "text" && decisions[unit.id] === "rejected");
    let reviewed = Boolean(after) && same(current, after), reverted: string[] = [];
    if (!reviewed && after && before && rejected.length && !rejected.some(unit => unit.whole_file) && same(current, revertUnits(before, after, rejected))) {
      reviewed = true; reverted = rejected.map(unit => unit.id);
    }
    return { round: round.number, file, revision: revision(current), text, base: base ? textOf(base) : null, before: before ? textOf(before) : null, reviewed, reverted };
  }

  /** Replaces a whole file of the task, keeping its line endings and byte
   *  order mark, and reviews it in a new round as an edited change is. */
  saveFile(name: string, input: SourceFileSave): Promise<PageState & { source: SourceFileRead }> {
    return this.app.exclusive(async () => {
      const identity = input.id;
      if (!/^[A-Za-z0-9-]{1,80}$/.test(identity) || typeof input.text !== "string" || input.text.includes("\0") || input.text.length > MAX_FILE)
        throw new Error("Invalid source edit.");
      const request = hash(JSON.stringify(input));
      let saved = this.app.store.one<{ task: string; data: SavedEdit }>("SELECT task,data FROM source_edits WHERE id=?", identity);
      if (saved && (saved.task !== name || saved.data.request !== request)) throw new Error("This edit ID was already used for another edit.");
      if (!saved) {
        // A round after the one the file was read in leaves the save valid
        // while the file is unchanged, which its revision proves.
        const { task } = this.writable(name, this.app.review.latestRound(name)?.number ?? input.round), current = readBytes(safePath(task.worktree, input.file));
        if (current === null || current.length > MAX_FILE || textOf(current) === null) throw new Error("This file is not text that can be edited here.");
        if (revision(current) !== input.revision) throw new Error("The source changed while you were editing. Your draft is kept.");
        // The text's length counts characters; the file is the encoded bytes,
        // which multi-byte characters and CRLF line endings make longer.
        // Refuse before publishing a file the editor could not read back.
        const target = fileBytes(current, input.text);
        if (target.length > MAX_FILE) throw new Error("This source file is too large to edit here.");
        const data: SavedEdit = { request, file: input.file, expected: current.toString("base64"), target: target.toString("base64"), applied: false };
        this.app.store.execute("INSERT INTO source_edits(id,task,data) VALUES(?,?,?)", identity, name, JSON.stringify(data));
        saved = { task: name, data };
      }
      const state = await this.publish(name, identity, saved.data);
      return { ...state, source: this.readFile(name, saved.data.file) };
    });
  }

  // Writes a saved edit once and reviews it in a new round.
  private async publish(name: string, identity: string, data: SavedEdit) {
    if (!data.applied) {
      const task = this.app.tasks.get(name), file = safePath(task.worktree, data.file), current = readBytes(file);
      const expected = data.expected === null ? null : Buffer.from(data.expected, "base64"), target = Buffer.from(data.target, "base64");
      if (!same(current, expected) && !same(current, target)) throw new Error("The source changed before this edit could be saved. Your draft is kept.");
      if (!same(current, target)) writeOrDelete(file, target);
      data.applied = true;
      this.app.store.execute("UPDATE source_edits SET data=? WHERE id=?", JSON.stringify(data), identity);
    }
    // The write and build have persistent identities. Retrying a lost
    // response must never apply the edit twice or start a second build.
    const job = this.app.publisher.submit(name, `source-${hash(identity)}`);
    // The edit's round is inserted now even while an earlier round renders:
    // only the changes the edit can affect wait for its comparison.
    await this.app.publisher.insertBehind(job);
    return this.app.review.pageState(name);
  }
}
