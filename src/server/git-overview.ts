import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import type { GitGraphCommit, GitOverview, GitWorktree, Task } from '../shared.ts';
import { gitStatus } from './manuscript.ts';

const exec = promisify(execFile);
async function git(root: string, args: string[]) {
  return (await exec('git', args, { cwd: root, timeout: 15_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout;
}
const realPath = (value: string) => { try { return fs.realpathSync(value); } catch { return value; } };

// -z preserves spaces, newlines and backslashes in paths and lock reasons.
export function parseWorktrees(output: string, root: string): GitWorktree[] {
  const current = realPath(root);
  return output.split('\0\0').filter(Boolean).map(record => {
    const fields = new Map(record.split('\0').map(field => {
      const space = field.indexOf(' ');
      return space < 0 ? [field, ''] : [field.slice(0, space), field.slice(space + 1)];
    }));
    const path = fields.get('worktree') || '';
    const head = fields.get('HEAD');
    return {
      path, branch: fields.get('branch')?.replace(/^refs\/heads\//, '') || null,
      head: head && !/^0+$/.test(head) ? head : null,
      current: realPath(path) === current, bare: fields.has('bare'), status: null,
      ...(fields.has('locked') ? { locked: fields.get('locked')! } : {}),
      ...(fields.has('prunable') ? { prunable: fields.get('prunable')! } : {}),
    };
  });
}

export async function gitOverview(root: string, tasks: Pick<Task, 'id' | 'worktree'>[] = []): Promise<GitOverview> {
  const worktrees = parseWorktrees(await git(root, ['worktree', 'list', '--porcelain', '-z']), root);
  // Tasks can share a HEAD and use opaque branch names. Match their actual
  // checkout paths, including /var vs /private/var and other symlink aliases.
  const taskPaths = new Map(tasks.map(task => [realPath(task.worktree), task.id]));
  for (const tree of worktrees) {
    const taskId = taskPaths.get(realPath(tree.path));
    if (taskId) tree.taskId = taskId;
  }
  // Bound the number of simultaneous status processes for repositories with many tasks.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, worktrees.length) }, async () => {
    while (next < worktrees.length) {
      const tree = worktrees[next++];
      if (tree.bare) continue;
      try { tree.status = await gitStatus(tree.path); }
      catch { tree.error = 'Could not read this worktree.'; }
    }
  }));
  worktrees.sort((a, b) => Number(b.current) - Number(a.current));
  const refs = new Map<string, { refs: string[]; remotes: string[]; tags: string[] }>();
  const refOutput = await git(root, ['for-each-ref', '--format=%(objectname)%00%(refname)%00%(refname:short)%00%(*objectname)', 'refs/heads', 'refs/remotes', 'refs/tags']);
  for (const line of refOutput.trim().split('\n').filter(Boolean)) {
    const [object, full, name, peeled] = line.split('\0'), hash = peeled || object;
    // A remote's HEAD only names its default branch, which is listed anyway.
    if (full.startsWith('refs/remotes/') && full.endsWith('/HEAD')) continue;
    const entry = refs.get(hash) || { refs: [], remotes: [], tags: [] };
    (full.startsWith('refs/heads/') ? entry.refs : full.startsWith('refs/remotes/') ? entry.remotes : entry.tags).push(name);
    refs.set(hash, entry);
  }
  // Include detached worktree tips, which --branches alone would miss.
  const heads = [...new Set(worktrees.flatMap(tree => tree.head ? [tree.head] : []))];
  if (!heads.length && !refs.size) return { worktrees, commits: [], truncated: false };
  const limit = 80;
  const log = await git(root, ['log', '--topo-order', `-${limit + 1}`, '--format=%H%x00%P%x00%s%x00%an%x00%ct', '--branches', '--remotes', '--tags', ...heads, '--']);
  const commits: GitGraphCommit[] = log.trim().split('\n').filter(Boolean).map(line => {
    const [hash, parents, subject, author, date] = line.split('\0');
    return { hash, parents: parents ? parents.split(' ') : [], subject, author, date: Number(date) * 1000, refs: [], remotes: [], tags: [], ...refs.get(hash) };
  });
  return { worktrees, commits: commits.slice(0, limit), truncated: commits.length > limit };
}
