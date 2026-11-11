import { createHash } from "node:crypto";
import { Repo, within } from "./git.ts";
import { groups, opcodes } from "./diff.ts";
import { entrySpans } from "./bib.ts";
import { textEdits } from "./text-edits.ts";
import { groupEnvironmentEdits } from "./environment-edits.ts";
import type { Scope, Unit, Op } from "../types.ts";
export const EXCERPT = 6000;
export function textOf(data: Buffer | null): string | null {
  if (data === null) return "";
  if (data.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return null;
  }
}
export const splitLines = (text: string) =>
  text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
export function diffUnits(
  repo: Repo,
  before: string,
  after: string,
  isFigure: (p: string) => boolean = () => false,
): Unit[] {
  const files = repo.changedFiles(before, after);
  return unitsOf(
    files,
    repo.blobs(before, files),
    repo.blobs(after, files),
    isFigure,
  );
}
/** `diffUnits` for servers, which keep answering requests meanwhile. */
export async function diffUnitsAsync(
  repo: Repo,
  before: string,
  after: string,
  isFigure: (p: string) => boolean = () => false,
): Promise<Unit[]> {
  const files = await repo.changedFilesAsync(before, after),
    [old, next] = await Promise.all([
      repo.blobsAsync(before, files),
      repo.blobsAsync(after, files),
    ]);
  return unitsOf(files, old, next, isFigure);
}
function unitsOf(
  files: string[],
  oldBlobs: Record<string, Buffer | null>,
  newBlobs: Record<string, Buffer | null>,
  isFigure: (p: string) => boolean,
): Unit[] {
  const units: Unit[] = [];
  for (const file of files) {
    const old = oldBlobs[file],
      next = newBlobs[file],
      a = textOf(old),
      b = textOf(next);
    const status =
        old === null ? "added" : next === null ? "deleted" : "modified",
      binary = a === null || b === null;
    const left = binary ? [] : splitLines(a!),
      right = binary ? [] : splitLines(b!);
    let hunks = binary ? [] : groups(opcodes(left, right), 0);
    if (!binary && file.endsWith(".bib"))
      hunks = byEntry(hunks, entrySpans(a!), entrySpans(b!));
    const whole =
      binary || status !== "modified" || isFigure(file) || !hunks.length;
    if (whole) hunks = [[["replace", 0, left.length, 0, right.length]]];
    const offsets = (lines: string[]) => {
      const result = [0];
      for (const line of lines) result.push(result.at(-1)! + line.length);
      return result;
    };
    const l = offsets(left),
      r = offsets(right);
    const fine =
      !whole && !file.endsWith(".bib")
        ? groupEnvironmentEdits(a!, b!, textEdits(a!, b!))
        : null;
    const lineAt = (offsets: number[], offset: number) => {
      let lo = 0,
        hi = offsets.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (offsets[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return Math.min(lo, Math.max(0, offsets.length - 2));
    };
    if (fine)
      hunks = fine.map(([tag, i, j, x, y]) => [
        [
          tag,
          lineAt(l, i),
          i === j ? lineAt(l, i) : lineAt(l, j - 1) + 1,
          lineAt(r, x),
          x === y ? lineAt(r, x) : lineAt(r, y - 1) + 1,
        ],
      ]);
    for (const [index, edits] of hunks.entries()) {
      const [, i, , x] = edits[0],
        [, , j, , y] = edits.at(-1)!;
      const exact = fine?.[index],
        oldText = exact
          ? a!.slice(exact[1], exact[2])
          : left.slice(i, j).join(""),
        newText = exact
          ? b!.slice(exact[3], exact[4])
          : right.slice(x, y).join("");
      units.push({
        id: `c${String(units.length + 1).padStart(3, "0")}`,
        file,
        status,
        kind: binary ? "binary" : isFigure(file) ? "figure" : "text",
        whole_file: whole,
        ops: whole ? [] : edits,
        ...(exact ? { text_ops: [exact] } : {}),
        old_start: i + 1,
        old_end: Math.max(i + 1, j),
        new_start: x + 1,
        new_end: Math.max(x + 1, y),
        old_text: binary ? "" : oldText.slice(0, EXCERPT),
        new_text: binary ? "" : newText.slice(0, EXCERPT),
        truncated: oldText.length > EXCERPT || newText.length > EXCERPT,
      });
    }
  }
  return units;
}
// A bibliography entry is decided whole: hunks that touch the same entry,
// before or after, or the same key on either side, become one change, so
// accepting part of an entry cannot mix its old and new fields.
export function byEntry(
  hunks: Op[][],
  before: { key: string; span: [number, number] }[],
  after: { key: string; span: [number, number] }[],
) {
  // An empty range touches an entry it falls strictly inside.
  const touches = ([a, b]: [number, number], [s, e]: [number, number]) =>
    a === b ? s < a && a < e : a < e && s < b;
  const root = hunks.map((_, i) => i),
    find = (i: number): number =>
      root[i] === i ? i : (root[i] = find(root[i])),
    owner = new Map<string, number>();
  hunks.forEach((hunk, i) => {
    const old: [number, number] = [hunk[0][1], hunk.at(-1)![2]],
      next: [number, number] = [hunk[0][3], hunk.at(-1)![4]],
      keys = [
        ...before.filter((e) => touches(old, e.span)).map((e) => e.key),
        ...after.filter((e) => touches(next, e.span)).map((e) => e.key),
      ];
    for (const key of keys) {
      const j = owner.get(key);
      if (j === undefined) owner.set(key, i);
      else root[find(i)] = find(j);
    }
  });
  const merged = new Map<number, Op[]>();
  hunks.forEach((hunk, i) => {
    const r = find(i);
    merged.set(r, [...(merged.get(r) ?? []), ...hunk]);
  });
  return [...merged.values()].map((ops) =>
    ops.sort((p, q) => p[1] - q[1] || p[3] - q[3]),
  );
}
function edits(units: Unit[], old: string, next: string, index: 1 | 3): Op[] {
  const offset = (text: string, line: number) =>
    splitLines(text).slice(0, line).join("").length;
  return units
    .flatMap(
      (u) =>
        u.text_ops ??
        u.ops.map(([tag, i, j, x, y]): Op => [
          tag,
          offset(old, i),
          offset(old, j),
          offset(next, x),
          offset(next, y),
        ]),
    )
    .sort((a, b) => b[index] - a[index]);
}
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
// The text from the start of the line before `start` to the end of the line
// after the one that holds `end`.
function surroundings(text: string, start: number, end: number): [string, string] {
  const lineStart = (at: number) => text.lastIndexOf("\n", at - 1) + 1,
    lineEnd = (at: number) => {
      const found = text.indexOf("\n", at);
      return found < 0 ? text.length : found + 1;
    },
    first = lineStart(start);
  return [
    text.slice(first > 0 ? lineStart(first - 1) : 0, start),
    text.slice(end, lineEnd(lineEnd(end))),
  ];
}
/** A version hash of a change: its file and its complete old and new content,
 *  binary content included, with the lines around it. The same proposal hashes
 *  the same in another round even when other changes shift its offsets or its
 *  numbering; two identical edits on identical lines hash alike, and callers
 *  treat such a hash as ambiguous. */
export function versionHash(unit: Unit, old: Buffer | null, next: Buffer | null) {
  const whole = unit.kind === "binary" || unit.whole_file,
    a = whole ? null : textOf(old),
    b = whole ? null : textOf(next);
  if (a === null || b === null)
    return sha(JSON.stringify([1, unit.file, unit.status, unit.kind, old && sha(old), next && sha(next)]));
  let i: number, j: number, x: number, y: number;
  if (unit.text_ops?.length)
    [i, j, x, y] = [unit.text_ops[0][1], unit.text_ops.at(-1)![2], unit.text_ops[0][3], unit.text_ops.at(-1)![4]];
  else {
    const offset = (text: string, line: number) => splitLines(text).slice(0, line).join("").length;
    [i, j, x, y] = [offset(a, unit.ops[0][1]), offset(a, unit.ops.at(-1)![2]), offset(b, unit.ops[0][3]), offset(b, unit.ops.at(-1)![4])];
  }
  const [p, s] = surroundings(a, i, j), [q, t] = surroundings(b, x, y);
  return sha(JSON.stringify([1, unit.file, unit.status, unit.kind, p, a.slice(i, j), s, q, b.slice(x, y), t]));
}
/** The units with their version hashes, for the round from `before` to
 *  `after`. Units derived from another round's are hashed again. */
export async function withHashesAsync(repo: Repo, before: string, after: string, units: Unit[]) {
  const files = [...new Set(units.map((u) => u.file))],
    [old, next] = await Promise.all([repo.blobsAsync(before, files), repo.blobsAsync(after, files)]);
  return units.map((u) => ({ ...u, hash: versionHash(u, old[u.file] ?? null, next[u.file] ?? null) }));
}
export function applyUnits(
  old: Buffer | null,
  next: Buffer | null,
  units: Unit[],
) {
  if (units.some((u) => u.whole_file)) return next;
  let a = old!.toString();
  const b = next!.toString();
  for (const [, i, j, x, y] of edits(units, a, b, 1))
    a = a.slice(0, i) + b.slice(x, y) + a.slice(j);
  return Buffer.from(a);
}
// The tree of `before`, a commit or a tree, with only these units of
// `after` applied.
export function withUnits(
  repo: Repo,
  before: string,
  after: string,
  units: Unit[],
) {
  const files = [...new Set(units.map((u) => u.file))],
    old = repo.blobs(before, files),
    next = repo.blobs(after, files);
  return repo.treeWith(
    before,
    Object.fromEntries(
      files.map((f) => [
        f,
        applyUnits(
          old[f],
          next[f],
          units.filter((u) => u.file === f),
        ),
      ]),
    ),
  );
}
export function revertUnits(
  old: Buffer | null,
  next: Buffer | null,
  units: Unit[],
) {
  if (units.some((u) => u.whole_file)) return old;
  const a = old!.toString();
  let b = next!.toString();
  for (const [, i, j, x, y] of edits(units, a, b, 3))
    b = b.slice(0, x) + a.slice(i, j) + b.slice(y);
  return Buffer.from(b);
}
export async function scopeViolationsAsync(
  repo: Repo,
  base: string,
  revision: string,
  scope: Scope,
) {
  const files = await repo.changedFilesAsync(base, revision);
  if (scope.ranges === null)
    return files.filter((f) => !within(f, scope.paths));
  const [old, next] = await Promise.all([
    repo.blobsAsync(base, files),
    repo.blobsAsync(revision, files),
  ]);
  return violationsOf(files, old, next, scope);
}
function violationsOf(
  files: string[],
  old: Record<string, Buffer | null>,
  next: Record<string, Buffer | null>,
  scope: Scope,
) {
  const violations: string[] = [];
  for (const file of files) {
    const a = textOf(old[file]),
      b = textOf(next[file]),
      allowed = scope.ranges?.[file];
    if (!allowed || old[file] === null || a === null || b === null) {
      violations.push(file);
      continue;
    }
    for (const [tag, i, j] of opcodes(splitLines(a), splitLines(b))) {
      if (tag === "equal") continue;
      const permitted =
        i === j
          ? allowed.some(([s, e]) => s - 1 <= i && i <= e)
          : Array.from({ length: j - i }, (_, k) => i + k + 1).every((n) =>
              allowed.some(([s, e]) => s <= n && n <= e),
            );
      if (!permitted) {
        violations.push(`${file}:${i + 1}`);
        break;
      }
    }
  }
  return violations;
}
