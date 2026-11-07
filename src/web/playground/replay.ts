import type { TimelineItem } from '../../shared.ts';

export const replayDuration = 10_000;
export interface DemoReplay { startedAt: number; pausedAt?: number }
export function replayProgress(replay: DemoReplay, now: number) {
  const elapsed = Math.max(0, (replay.pausedAt ?? now) - replay.startedAt);
  const done = elapsed >= replayDuration;
  return { elapsed, done, paused: !done && replay.pausedAt !== undefined, step: Math.min(4, Math.floor(elapsed / 2500)) };
}

// Authored process summaries for the static demo, not output from a live model.
const thoughts: Record<string, string> = {
  'example-note-opening': 'Tracing the workflow from a PDF note to a reviewed edit. The opening should name each action in that order.',
  'example-note-choice': 'The sentence states a principle but leaves the available actions implicit. The revision can name accept, reject, and request another pass.',
  'example-note-filler': 'The marked words are an aside. Removing just “of course,” keeps the ownership statement intact.',
  'example-note-quick': 'The timing phrase delays the action. Starting with “Inspect” makes the instruction more direct.',
  'example-note-math': 'The formula assumes the page starts at zero. The example needs explicit page bounds and a selection shifted by the same offset.',
  'example-note-ending': 'The closing line needs a concrete next step: open a local project, connect an agent, and review a first edit.',
};
export function replayItem(id: string, replay: DemoReplay, now: number): TimelineItem {
  const { elapsed, step, paused, done } = replayProgress(replay, now);
  const details = [thoughts[id], 'Preparing a focused change in main.tex while preserving the surrounding content and typography.', 'Comparing the typeset before and after, and linking each change back to its note.', 'Writing a short explanation of the prepared revision.', 'Read the note, prepared the edit, and checked the typeset comparison.'];
  const detail = details[step];
  return { id: `${id}-process`, taskId: id, type: 'demo-progress', text: paused ? 'Paused' : ['Thinking', 'Preparing the edit', 'Comparing the PDF', 'Writing the response', 'Process complete'][step],
    detail: step === 0 ? detail.slice(0, Math.max(1, Math.ceil(elapsed / 2200 * detail.length))) : detail,
    status: paused ? 'paused' : done ? 'completed' : 'inProgress', createdAt: replay.startedAt,
  };
}
