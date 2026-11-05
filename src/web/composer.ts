import type { NoteSummary, ReviewSummary } from '../shared.ts';
export { reviewInstructions } from '../conversation.ts';
export { sendsMessage } from '../../engine/src/web/send-key.ts';

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
// Feedback sends the unsent review updates on their own; a skill runs with or without text.
export type Message = { text: string; requestKey: string; feedback?: true; skill?: string; attachments?: string[]; notes?: NoteSummary[] };

// The server counts undelivered feedback events, excluding those already queued.
// Older summaries only report decision totals; a confirmed zero takes precedence.
export const unsentReviewFeedback = (review: ReviewSummary | null) => review?.unsent ?? ['accepted', 'rejected', 'commented'].reduce((count, kind) => count + (review?.counts?.[kind] || 0), 0);

// Acceptance alone needs no extra agent turn. Confirmed delivery clears the chip,
// including when an older server still reports cumulative comment counts.
export const pendingReviewFeedback = (review: ReviewSummary | null) => {
  const unsent = unsentReviewFeedback(review);
  return unsent && ((review?.comments ?? review?.counts?.commented ?? 0) > 0 || (review?.counts?.rejected || 0) > 0) ? unsent : 0;
};

// Keep the submission identity separate from text being edited while a request
// is in flight. Feedback is its own submission and never consumes the draft.
export class ComposerDraft {
  text: string;
  sending = false;
  sendingSource: 'draft' | 'feedback' | null = null;
  private revision = 0;
  private requestKeys: Record<'draft' | 'feedback', string>;
  private listeners = new Set<() => void>();
  private snapshot: { text: string; sending: boolean; sendingSource: 'draft' | 'feedback' | null };
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private changed() { this.snapshot = { text: this.text, sending: this.sending, sendingSource: this.sendingSource }; for (const listener of this.listeners) listener(); }

  constructor(private key: string, private storage: DraftStorage, private newId: () => string) {
    this.text = storage.getItem(key) || '';
    this.requestKeys = { draft: newId(), feedback: newId() };
    this.snapshot = { text: this.text, sending: this.sending, sendingSource: this.sendingSource };
  }

  edit(text: string) {
    this.text = text;
    this.revision++;
    this.requestKeys.draft = this.newId();
    this.storage.setItem(this.key, text);
    this.changed();
  }

  async submit(source: 'draft' | 'feedback', send: (message: Message) => Promise<unknown>, skill?: string, attachments: string[] = [], notes: NoteSummary[] = [], instructions = ''): Promise<boolean> {
    const draftText = this.text;
    const text = source === 'draft' ? [draftText.trim(), instructions.trim()].filter(Boolean).join('\n\n') : '';
    if (this.sending || (source === 'draft' && !text.trim() && !skill && !attachments.length && !notes.length)) return false;
    const requestStorage = this.key + (source === 'draft' ? ':request' : ':feedback-request');
    {
      const signature = JSON.stringify([text.trim(), skill || '', attachments, notes]);
      let previous: { signature?: string; id?: string } = {};
      try { previous = JSON.parse(this.storage.getItem(requestStorage) || '{}'); } catch { /* Invalid saved request. */ }
      this.requestKeys[source] = previous?.signature === signature && previous.id ? previous.id : this.newId();
      this.storage.setItem(requestStorage, JSON.stringify({ signature, id: this.requestKeys[source] }));
    }
    this.sending = true; this.sendingSource = source;
    this.changed();
    const revision = this.revision;
    const requestKey = this.requestKeys[source], savedRequest = this.storage.getItem(requestStorage);
    try {
      await send({ text: text.trim(), requestKey, ...(source === 'feedback' ? { feedback: true as const } : {}), ...(notes.length ? { notes } : {}), ...(skill ? { skill } : {}), ...(source === 'draft' && attachments.length ? { attachments } : {}) });
      if (this.storage.getItem(requestStorage) === savedRequest) this.storage.removeItem(requestStorage);
      if (source === 'draft' && this.revision === revision) {
        // A task can be reopened while its previous request is still pending.
        // Preserve a newer draft saved by that mounted composer or another tab.
        const saved = this.storage.getItem(this.key);
        if (saved === draftText || saved === null) {
          this.text = '';
          this.storage.removeItem(this.key);
        } else this.text = saved;
      }
      if (source === 'feedback' || this.revision === revision) this.requestKeys[source] = this.newId();
      return true;
    } finally {
      this.sending = false; this.sendingSource = null;
      this.changed();
    }
  }
}

// New tasks start from a single prompt, like a chat. The sidebar title is its
// first line, shortened at a word boundary.
export function taskTitle(text: string) {
  const line = (text.split('\n').find(value => value.trim()) || '').replace(/^[\s#>*+-]+/, '').replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  if (!line) return 'Untitled task';
  if (line.length <= 80) return line;
  const cut = line.slice(0, 80), space = cut.lastIndexOf(' ');
  return (space > 40 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '') + '…';
}
