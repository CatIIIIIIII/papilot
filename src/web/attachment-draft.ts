import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_TOTAL, MAX_IMAGE_BYTES, type Attachment } from '../shared.ts';
import { t } from './i18n.ts';

export type UploadAttachment = (file: File, signal: AbortSignal) => Promise<Attachment>;
export interface DraftAttachment { key: string; name: string; size: number; file?: File; attachment?: Attachment; uploading: boolean; error?: string }
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'> & { keys?: () => string[] };

function savedDraft(key: string, storage: Storage) {
  const saved = storage.getItem(key);
  if (saved !== null) return saved;
  // Earlier versions included the account ID. Recover this browser's draft
  // only when it is unambiguous; never replace a current draft.
  const suffix = /^papilot:files:((?:task|new):.+)$/.exec(key)?.[1];
  const previous = suffix ? (storage.keys?.() || []).filter(candidate => /^papilot:files:[^:]+:(?:task|new):/.test(candidate) && candidate.endsWith(':' + suffix)) : [];
  if (previous.length !== 1) return null;
  const value = storage.getItem(previous[0]);
  if (value !== null) { storage.setItem(key, value); storage.removeItem(previous[0]); }
  return value;
}

// Uploads belong to the draft, not the mounted form. Switching tasks while a
// file uploads cannot attach it to the newly opened conversation.
export class AttachmentDraft {
  private entries: DraftAttachment[] = [];
  private error = '';
  private requests = new Map<string, AbortController>();
  private listeners = new Set<() => void>();
  private snapshot = { entries: this.entries, files: [] as Attachment[], blocked: false, error: '' };
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  constructor(private key: string, private storage: Storage) {
    try {
      const files: Attachment[] = JSON.parse(savedDraft(key, storage) || '[]');
      if (Array.isArray(files)) this.entries = files.filter(file => file && typeof file.id === 'string' && typeof file.projectId === 'string' && typeof file.name === 'string' && typeof file.size === 'number' && typeof file.mime === 'string').slice(0, MAX_ATTACHMENTS)
        .map(file => ({ key: file.id, name: file.name, size: file.size, attachment: file, uploading: false }));
    } catch { /* A damaged draft must not prevent the composer from opening. */ }
    this.changed();
  }
  private changed() {
    const files = this.entries.flatMap(entry => entry.attachment ? [entry.attachment] : []);
    this.snapshot = { entries: this.entries, files, blocked: this.entries.some(entry => entry.uploading || Boolean(entry.error)), error: this.error };
    if (files.length) this.storage.setItem(this.key, JSON.stringify(files)); else this.storage.removeItem(this.key);
    for (const listener of this.listeners) listener();
  }
  async add(files: File[], upload: UploadAttachment) {
    this.error = '';
    const added: DraftAttachment[] = [];
    for (const file of files) {
      const total = this.entries.reduce((sum, entry) => sum + entry.size, 0);
      if (this.entries.length >= MAX_ATTACHMENTS) { this.error = t('Attach up to 10 files per message.'); break; }
      if (!file.size) { this.error = t('The file “{name}” is empty.', { name: file.name }); continue; }
      if (file.size > MAX_ATTACHMENT_BYTES) { this.error = t('Files must be 25 MB or smaller.'); continue; }
      if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type) && file.size > MAX_IMAGE_BYTES) { this.error = t('Images must be 5 MB or smaller.'); continue; }
      if (total + file.size > MAX_ATTACHMENT_TOTAL) { this.error = t('Attachments must total 100 MB or less.'); continue; }
      const entry: DraftAttachment = { key: crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join(''), name: file.name, size: file.size, file, uploading: true };
      this.entries = [...this.entries, entry]; added.push(entry);
    }
    this.changed();
    await Promise.all(added.map(entry => this.upload(entry.key, upload)));
  }
  async upload(key: string, send: UploadAttachment) {
    const entry = this.entries.find(entry => entry.key === key);
    if (!entry?.file || this.requests.has(key)) return;
    const controller = new AbortController(); this.requests.set(key, controller);
    this.entries = this.entries.map(value => value.key === key ? { ...value, uploading: true, error: undefined } : value); this.changed();
    try {
      const attachment = await send(entry.file, controller.signal);
      this.entries = this.entries.map(value => value.key === key ? { key, name: attachment.name, size: attachment.size, attachment, uploading: false } : value);
    } catch (error) {
      this.entries = this.entries.map(value => value.key === key ? { ...value, uploading: false, error: error instanceof Error ? error.message : t('Upload failed. Please retry.') } : value);
    } finally { this.requests.delete(key); this.changed(); }
  }
  remove(key: string) {
    this.requests.get(key)?.abort();
    this.entries = this.entries.filter(entry => entry.key !== key); this.error = ''; this.changed();
  }
  clear(sent: Attachment[]) {
    const ids = new Set(sent.map(file => file.id));
    this.entries = this.entries.filter(entry => !entry.attachment || !ids.has(entry.attachment.id)); this.error = ''; this.changed();
  }
}

export const attachmentDrafts = new Map<string, AttachmentDraft>();
