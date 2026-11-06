export interface DiffLine {
  kind: 'context' | 'add' | 'del' | 'hunk' | 'note';
  text: string;
  before?: number;
  after?: number;
}

// Only changed hunks are returned by Git; the two counters follow the original
// and current files independently, including zero-line additions and deletions.
export function parseGitDiff(patch: string) {
  const lines: DiffLine[] = [], changes: number[] = [];
  let before = 0, after = 0, inHunk = false, changing = false, added = 0, deleted = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) { inHunk = false; changing = false; continue; }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?: ?(.*))?$/.exec(line);
    if (hunk) {
      before = Number(hunk[1]); after = Number(hunk[2]); inHunk = true; changing = false;
      lines.push({ kind: 'hunk', text: hunk[3] || '', before, after });
    } else if (inHunk && (line[0] === '+' || line[0] === '-')) {
      if (!changing) changes.push(lines.length);
      changing = true;
      if (line[0] === '+') { added++; lines.push({ kind: 'add', text: line.slice(1), after: after++ }); }
      else { deleted++; lines.push({ kind: 'del', text: line.slice(1), before: before++ }); }
    } else if (inHunk && line[0] === ' ') {
      changing = false;
      lines.push({ kind: 'context', text: line.slice(1), before: before++, after: after++ });
    } else if (line.startsWith('\\') || line.startsWith('Binary')) {
      lines.push({ kind: 'note', text: line });
    }
  }
  return { lines, changes, added, deleted };
}
