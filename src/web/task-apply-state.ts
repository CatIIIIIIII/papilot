import type { TaskCommitReview } from '../shared.ts';
// Shared by Chat and PDF. Completion comes from server state, so a successful
// request never prevents retrying a later review or confirming a merge.
type State = { commitReview: TaskCommitReview | null; busy: boolean; action: 'workspace' | 'commit'; error: string; message: string; writing: boolean };
export class TaskApplyState {
  private state: State;
  private revision = 0;
  private generation = 0;
  constructor(message = '') { this.state = { commitReview: null, busy: false, action: 'workspace', error: '', message, writing: false }; }
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;
  private update(value: Partial<State>) { this.state = { ...this.state, ...value }; for (const listener of this.listeners) listener(); }
  edit(message: string) { this.revision++; this.update({ message }); }
  async write(generate: () => Promise<string>) {
    if (this.state.busy || this.state.writing) return;
    const generation = ++this.generation, revision = this.revision;
    this.update({ writing: true, error: '' });
    try {
      const message = await generate();
      if (generation === this.generation && revision === this.revision) this.update({ message });
    } catch (error) { if (generation === this.generation) this.update({ error: String(error instanceof Error ? error.message : error) }); }
    finally { if (generation === this.generation) this.update({ writing: false }); }
  }
  async apply(send: () => Promise<unknown>, action: State['action'] = 'workspace') {
    if (this.state.busy) return;
    this.generation++;
    this.update({ busy: true, action, writing: false, error: '' });
    try { const result = await send() as { commitReview?: TaskCommitReview } | undefined; this.update({ commitReview: result?.commitReview ?? null }); }
    catch (error) { this.update({ error: error instanceof Error ? error.message : String(error) }); }
    finally { this.update({ busy: false }); }
  }
}
