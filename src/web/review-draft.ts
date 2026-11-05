import { useSyncExternalStore } from 'react';
import type { NoteSummary } from '../shared.ts';
import { canonicalGroup, type NoteGroup } from '../note-groups.ts';
import type { Rect } from './note-geometry.ts';
import { noteAnchor } from '../notes.ts';
import { browserStorage } from './storage.ts';

export type ReviewMark = { group?: NoteGroup; strip: string; round: number; stop?: number; where: string; quote: string; rects: Rect[]; region: boolean; whole?: boolean };
export type ReviewNote = ReviewMark & { id: string; comment: string };
type Snapshot = { notes: ReviewNote[]; instructions: string; editing?: { id: string; sequence: number }; reveal?: { note: ReviewNote; sequence: number }; busy: boolean };
const uuid = () => crypto.randomUUID();

// One persisted draft shared by the PDF selections and the chat composer.
// Geometry stays local; the message retains the quoted text, source and round.
export class ReviewDraft {
  private value: Snapshot;
  private listeners = new Set<() => void>();
  private deleted: { note: ReviewNote; index: number }[] = [];
  private sequence = 0;
  private added: string[] = [];
  constructor(private key: string, private storage: Pick<Storage, 'getItem' | 'setItem'> = browserStorage) {
    let saved: any;
    try { saved = JSON.parse(storage.getItem(key) || 'null'); } catch { /* Invalid local draft. */ }
    this.deleted = Array.isArray(saved?.deleted) ? saved.deleted : [];
    const notes: ReviewNote[] = Array.isArray(saved?.notes) ? saved.notes : [];
    // Recover an unfinished note from the former floating editor.
    if (saved?.editing?.comment?.trim()) {
      const note = { ...saved.editing, id: saved.editing.id || uuid() };
      const index = notes.findIndex(item => item.id === note.id);
      if (index < 0) notes.push(note); else notes[index] = note;
    }
    // Consolidate repeated overall-comment drafts from the first trial without
    // losing anything the author typed into them.
    const recovered: ReviewNote[] = [];
    for (const note of notes) {
      const existing = note.whole && recovered.find(item => item.whole && item.round === note.round && item.stop === note.stop);
      if (existing) {
        if (note.comment.trim() && note.comment !== existing.comment) existing.comment = [existing.comment, note.comment].filter(Boolean).join('\n\n');
      } else recovered.push({ ...note, strip: note.strip.replace(/-clean(?=\.)/, '') });
    }
    this.value = { notes: recovered, instructions: saved?.instructions || '', busy: false };
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = () => this.value;
  private update(next: Partial<Snapshot>) {
    this.value = { ...this.value, ...next };
    this.storage.setItem(this.key, JSON.stringify({ notes: this.value.notes, instructions: this.value.instructions, deleted: this.deleted }));
    this.listeners.forEach(listener => listener());
  }
  add(mark: ReviewMark, focus = true) {
    if (this.value.busy) return;
    // Comment is an entry point to this change's overall discussion. Repeated
    // clicks reopen that draft; distinct quotations can still have separate notes.
    const existing = mark.whole && this.value.notes.find(note => note.whole && note.round === mark.round && note.stop === mark.stop);
    if (existing) { this.focus(existing.id); return; }
    const note = { ...mark, id: uuid(), comment: '' };
    this.added.push(note.id);
    this.update({ notes: [...this.value.notes, note], ...(focus ? { editing: { id: note.id, sequence: ++this.sequence } } : {}) });
  }
  edit(id: string, comment: string) {
    if (!this.value.busy) this.update({ notes: this.value.notes.map(note => note.id === id ? { ...note, comment } : note) });
  }
  focus(id: string) { this.update({ editing: { id, sequence: ++this.sequence } }); }
  reveal(note: ReviewNote) { this.update({ reveal: { note, sequence: ++this.sequence } }); }
  clearReveal() { if (this.value.reveal) this.update({ reveal: undefined }); }
  instructions(text: string) { if (!this.value.busy) this.update({ instructions: text }); }
  remove(id: string) {
    if (this.value.busy) return;
    const index = this.value.notes.findIndex(note => note.id === id);
    if (index < 0) return;
    this.deleted.push({ note: this.value.notes[index], index });
    this.update({ notes: this.value.notes.filter(note => note.id !== id), ...(this.value.reveal?.note.id === id ? { reveal: undefined } : {}) });
  }
  undoAdded() {
    if (this.value.busy) return false;
    const id = this.added.pop(); if (!id) return false;
    this.update({ notes: this.value.notes.filter(note => note.id !== id) }); return true;
  }
  undo() {
    if (this.value.busy) return false;
    const removed = this.deleted.pop(); if (!removed) return false;
    const notes = [...this.value.notes]; notes.splice(removed.index, 0, removed.note); this.update({ notes }); return true;
  }
  setBusy(busy: boolean) { if (this.value.busy !== busy) this.update({ busy }); }
  clear(submitted: Snapshot) {
    // Keep edits saved by a reopened task or another tab while sending.
    let saved: Snapshot = this.value;
    try { saved = JSON.parse(this.storage.getItem(this.key) || 'null') || saved; } catch { /* Keep current draft. */ }
    const notes = saved.notes.filter(note => !submitted.notes.some(sent => JSON.stringify(sent) === JSON.stringify(note)));
    this.deleted = []; this.added = [];
    this.update({ notes, instructions: saved.instructions === submitted.instructions ? '' : saved.instructions, reveal: undefined });
  }
}
const drafts = new Map<string, ReviewDraft>();
export function reviewDraft(taskId: string) {
  let draft = drafts.get(taskId);
  if (!draft) { draft = new ReviewDraft(`papilot:review-notes:${taskId}`); drafts.set(taskId, draft); }
  return draft;
}
export const useReviewDraft = (taskId: string) => {
  const draft = reviewDraft(taskId);
  return useSyncExternalStore(draft.subscribe, draft.getSnapshot);
};
export const reviewNoteSummary = (note: ReviewNote): NoteSummary => ({
  id: note.id, ...(note.group ? { group: note.group } : {}),
  where: note.where + (note.region ? ` · Region in displayed strip: ${note.rects[0].map(v => `${Math.round(v * 100)}%`).join(', ')}` : ''),
  quote: note.quote, comment: note.comment.trim(), anchor: { ...noteAnchor(note), round: note.round },
});

// Unwritten individual comments remain drafts. A color group's shared direction
// can cover its empty per-location fields without blocking unrelated messages.
export function reviewSubmission(draft: Snapshot, text = '', skill?: string): Snapshot {
  const directedGroups = new Set(draft.notes.filter(note => note.group && note.comment.trim()).map(note => canonicalGroup(note.group!)));
  const shared = Boolean(text.trim() || draft.instructions.trim() || skill);
  return { ...draft, notes: draft.notes.filter(note => note.comment.trim() || (note.group && (shared || directedGroups.has(canonicalGroup(note.group))))) };
}
