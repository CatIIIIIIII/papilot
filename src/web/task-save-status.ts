import type { Task } from '../shared.ts';

// A saved result describes the current accepted changes only. New work and
// undecided changes take precedence over any previous delivery or commit.
export function taskSaveStatus(task: Task): 'committed' | 'applied' | null {
  if (task.reconciliation || task.status !== 'reviewing' || task.review?.state !== 'done' || task.review.round === null
    || task.review.counts.pending || task.review.files?.length !== 0 || task.pendingReview || task.delivery?.pending) return null;
  if (task.delivery?.mode === 'commit') return 'committed';
  if (task.delivery?.mode === 'workspace') return 'applied';
  return null;
}
