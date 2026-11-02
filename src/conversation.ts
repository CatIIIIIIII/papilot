import type { BuildFailure, FeedbackSummary } from './shared.ts';

// What the agent receives when the author sends review feedback without a
// message of their own. The chat shows the feedback, never this prompt.
export const reviewInstructions = 'Continue this task using the decisions and comments from this review round. Preserve accepted changes and do not reintroduce rejected edits. Address any remaining revision requests; if no revision is needed, summarize the result.';
// Earlier versions stored the prompt itself as the author's message.
export const isFeedbackPrompt = (text: string) => text === reviewInstructions || text === 'Address the comments from this review round. Preserve accepted changes and do not reintroduce rejected edits.';

// Older AI reviews appended a generated copy of every PDF suggestion to the
// chat summary. Keep those records intact, but display only their summary.
export function aiReviewSummary(text: string) {
  return text.split(/\n\n1\. \*\*Page \d+\*\* — /, 1)[0].trimEnd();
}

// What the agent receives when its own edits stop the review build. The chat
// shows the error, never this prompt.
export function buildFixPrompt(failure: BuildFailure) {
  return [
    'Papilot could not build the PDF review after your last turn:',
    [failure.error, ...failure.details].join('\n'),
    failure.log ? `The compiler log is at ${failure.log}.` : '',
    'Fix this in the task worktree, then end your turn; Papilot builds the review again. Restore any file outside the review\'s scope to how it was when the task started, and mention in your summary any update that file still needs.',
  ].filter(Boolean).join('\n\n');
}

// A skill is a named set of instructions; the author's own words, if any, say where and how.
export function skillPrompt(skill: { name: string; body: string; folder?: string }, request: string) {
  return [
    `Use the "${skill.name}" skill below for this request.${skill.folder ? ` Files the skill mentions are in ${skill.folder}.` : ''}`,
    `<skill name="${skill.name}">\n${skill.body.trim()}\n</skill>`,
    request.trim() ? `Request: ${request.trim()}` : 'No further details were given: apply the skill to the whole paper.',
  ].join('\n\n');
}

interface FeedbackItem { kind?: string; round?: number | null; text?: string; changes?: (string | { file?: string; lines?: [number, number] })[] }
// The review engine's feedback (see engine FeedbackItem) as the chat shows it.
export function summarizeFeedback(feedback: { feedback?: FeedbackItem[]; build_error?: unknown }): FeedbackSummary | undefined {
  const items = feedback.feedback || [];
  if (!items.length && !feedback.build_error) return undefined;
  const summary: FeedbackSummary = { round: null, accepted: 0, rejected: 0, undone: 0, comments: [], ...(feedback.build_error ? { buildError: true } : {}) };
  for (const item of items) {
    if (item.round) summary.round = Math.max(summary.round || 0, item.round);
    const changes = item.changes || [];
    if (item.kind === 'accept') summary.accepted += changes.length || 1;
    else if (item.kind === 'reject') summary.rejected += changes.length || 1;
    else if (item.kind === 'undo') summary.undone++;
    else if ((item.kind === 'comment' || item.kind === 'note') && item.text?.trim()) {
      const first = changes.find(change => typeof change === 'object' && change.file) as { file: string; lines?: [number, number] } | undefined;
      const where = first ? `${first.file}${first.lines ? `:${first.lines[0]}` : ''}${changes.length > 1 ? ` +${changes.length - 1}` : ''}` : item.kind === 'note' ? 'Note on the review' : `Round ${item.round ?? ''}`.trim();
      summary.comments.push({ where, text: item.text.trim().slice(0, 2000) });
    }
  }
  return summary;
}
