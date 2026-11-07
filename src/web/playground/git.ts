import type { GitDiff, GitFile, GitHistory, GitOverview, GitStatus, GitVersion, GitVersionDetail } from '../../shared.ts';
import fixture from '../../../examples/playground-paper/git.json';

type Files = Record<string, string>;
interface Version extends GitVersion { files: Files }
export interface DemoGit { versions: Version[]; working: Files; index: Files; remoteHead: string; sequence: number }
const copy = <T,>(value: T): T => structuredClone(value);
const head = (state: DemoGit) => state.versions[0];
const lines = (text = '') => text ? text.replace(/\n$/, '').split('\n') : [];
const paths = (...files: Files[]) => [...new Set(files.flatMap(file => Object.keys(file)))].sort();
const change = (before: string | undefined, after: string | undefined) => before === undefined ? '?' : after === undefined ? 'D' : 'M';
const setFile = (files: Files, path: string, text: string | undefined) => { if (text === undefined) delete files[path]; else files[path] = text; };
const summary = ({ files: _, ...version }: Version): GitVersion => version;

export function seedGit(): DemoGit {
  const index: Files = { ...fixture.versions[0].files };
  for (const path of fixture.staged) index[path] = (fixture.working as Files)[path];
  return { versions: copy(fixture.versions), working: copy(fixture.working), index, remoteHead: fixture.versions[1].hash, sequence: 0 };
}
function hunk(before = '', after = '') {
  const old = lines(before), next = lines(after);
  let start = 0, tail = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  while (tail < old.length - start && tail < next.length - start && old[old.length - tail - 1] === next[next.length - tail - 1]) tail++;
  return { old, next, start, oldEnd: old.length - tail, nextEnd: next.length - tail };
}
export function gitStatus(state: DemoGit): GitStatus {
  const files = paths(head(state).files, state.index, state.working).flatMap<GitFile>(path => {
    const before = head(state).files[path], index = state.index[path], after = state.working[path];
    const staged = before !== index, unstaged = index !== after;
    if (!staged && !unstaged) return [];
    const delta = hunk(before, after);
    return [{ path, status: staged ? change(before, after).replace('?', 'A') : change(before, after), index: staged ? change(before, index).replace('?', 'A') : ' ', staged, unstaged, lines: [delta.nextEnd - delta.start, delta.oldEnd - delta.start] }];
  });
  const remoteIndex = state.versions.findIndex(version => version.hash === state.remoteHead);
  return { branch: 'main', upstream: 'origin/main', ahead: remoteIndex < 0 ? 1 : remoteIndex, behind: 0, remote: true, merging: null, files, head: { hash: head(state).hash, subject: head(state).message, date: head(state).date } };
}
function diff(path: string, before: string | undefined, after: string | undefined): GitDiff {
  if (before === after) return { path, diff: '', truncated: false };
  const { old, next, start, oldEnd, nextEnd } = hunk(before, after);
  const from = Math.max(0, start - 3), oldTo = Math.min(old.length, oldEnd + 3), nextTo = Math.min(next.length, nextEnd + 3);
  const patch = [`diff --git a/${path} b/${path}`, `--- ${before === undefined ? '/dev/null' : 'a/' + path}`, `+++ ${after === undefined ? '/dev/null' : 'b/' + path}`, `@@ -${old.length ? from + 1 : 0},${oldTo - from} +${next.length ? from + 1 : 0},${nextTo - from} @@`, ...old.slice(from, start).map(line => ' ' + line), ...old.slice(start, oldEnd).map(line => '-' + line), ...next.slice(start, nextEnd).map(line => '+' + line), ...next.slice(nextEnd, nextTo).map(line => ' ' + line)];
  return { path, diff: patch.join('\n') + '\n', truncated: false };
}
function commit(state: DemoGit, files: Files, message: string, amend = false) {
  const hash = (`de${Date.now().toString(16)}${(++state.sequence).toString(16)}`).padEnd(40, '0');
  const version = { hash, files: copy(files), message, author: 'You', date: Date.now() };
  if (amend) state.versions[0] = version; else state.versions.unshift(version);
  return hash;
}

// This repository exists only in browser storage. Every endpoint below updates
// snapshots in memory; no Git process, filesystem, remote or agent is contacted.
export function gitRequest(state: DemoGit, route: string, body?: unknown): unknown {
  const url = new URL(route, 'https://demo.invalid'), path = url.pathname;
  if (body === undefined) {
    if (path === '' || path === '/') return gitStatus(state);
    if (path === '/history') return { versions: url.searchParams.has('before') ? [] : state.versions.map(summary), next: null } satisfies GitHistory;
    const history = path.match(/^\/history\/([a-f0-9]+)(\/diff)?$/);
    if (history) {
      const index = state.versions.findIndex(version => version.hash === history[1]);
      if (index < 0) throw new Error('Example version not found.');
      const version = state.versions[index], before = state.versions[index + 1]?.files || {};
      if (history[2]) { const file = url.searchParams.get('path') || ''; return diff(file, before[file], version.files[file]); }
      return { version: summary(version), files: paths(before, version.files).filter(path => before[path] !== version.files[path]).map(path => ({ path, status: change(before[path], version.files[path]).replace('?', 'A') })) } satisfies GitVersionDetail;
    }
    if (path === '/diff') {
      const file = url.searchParams.get('path') || '', scope = url.searchParams.get('scope');
      return diff(file, scope === 'unstaged' ? state.index[file] : head(state).files[file], scope === 'staged' ? state.index[file] : state.working[file]);
    }
    if (path === '/overview') {
      const root = '/example/papilot-introduction';
      const branches = [
        { id: 'example-clarity', branch: 'papilot/design-philosophy', subject: 'Make author choices explicit', hash: 'f126de47546970af312b524f8cc624d599d51915' },
        { id: 'example-math', branch: 'papilot/cropped-page-coordinates', subject: 'Normalize notes against explicit page bounds', hash: 'e518bc5a3c92de115fa8dc8aed71451868164fc2' },
      ];
      return {
        worktrees: [{ path: root, branch: 'main', head: head(state).hash, current: true, bare: false, status: gitStatus(state) }, ...branches.map(branch => ({ path: `${root}/.papilot/worktrees/${branch.id}`, branch: branch.branch, head: branch.hash, current: false, bare: false, taskId: branch.id, status: { branch: branch.branch, upstream: null, ahead: 0, behind: 0, files: [], head: { hash: branch.hash, subject: branch.subject, date: head(state).date } } }))],
        commits: [...branches.map(branch => ({ hash: branch.hash, parents: [head(state).hash], subject: branch.subject, author: 'Papilot demo', date: head(state).date + 60000, refs: [branch.branch], remotes: [], tags: [] })), ...state.versions.map((version, index) => ({ hash: version.hash, parents: state.versions[index + 1] ? [state.versions[index + 1].hash] : [], subject: version.message, author: version.author, date: version.date, refs: index === 0 ? ['main'] : [], remotes: version.hash === state.remoteHead ? ['origin/main'] : [], tags: index === state.versions.length - 1 ? ['tour-v1'] : [] }))], truncated: false,
      } satisfies GitOverview;
    }
    return undefined;
  }
  const input = body as { paths?: string[]; stage?: boolean; staged?: boolean; message?: string; push?: boolean; amend?: boolean; hash?: string; head?: string };
  const chosen = Array.isArray(input.paths) ? input.paths.filter(path => typeof path === 'string') : [];
  if (path === '/stage') for (const file of chosen) setFile(state.index, file, input.stage ? state.working[file] : head(state).files[file]);
  else if (path === '/discard') for (const file of chosen) setFile(state.working, file, state.index[file]);
  else if (path === '/message') return { message: 'Polish the product tour and document the review workflow' };
  else if (['/fetch', '/pull', '/merge', '/push', '/sync'].includes(path)) {
    if (path === '/push' || path === '/sync') state.remoteHead = head(state).hash;
  } else if (path === '/commit') {
    if (!input.message?.trim()) throw new Error('Write a commit message first.');
    const files = { ...head(state).files }, selected = input.staged ? gitStatus(state).files.filter(file => file.staged).map(file => file.path) : chosen;
    if (!selected.length) throw new Error('Choose changes to commit.');
    for (const file of selected) setFile(files, file, input.staged ? state.index[file] : state.working[file]);
    const hash = commit(state, files, input.message.trim(), input.amend);
    for (const file of selected) setFile(state.index, file, files[file]);
    if (input.push) state.remoteHead = hash;
    return { git: gitStatus(state), commit: hash.slice(0, 7) };
  } else if (path === '/restore') {
    const version = state.versions.find(version => version.hash === input.hash);
    if (!version || input.head !== head(state).hash) throw new Error('Refresh the version history before restoring.');
    if (gitStatus(state).files.length) throw new Error('Commit or discard the example changes before restoring a version.');
    commit(state, version.files, `Restore: ${version.message}`);
    state.working = copy(version.files); state.index = copy(version.files);
  } else return undefined;
  return { git: gitStatus(state) };
}
