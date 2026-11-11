type Action = 'commit' | 'push';
type State = { message: string; writing: boolean; busy: Action | ''; error: string; result: string };

export class TaskCommitDraft {
  private state: State = { message: '', writing: false, busy: '', error: '', result: '' };
  private revision = 0;
  private generation = 0;
  private requested = false;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;
  private update(value: Partial<State>) { this.state = { ...this.state, ...value }; for (const listener of this.listeners) listener(); }
  edit(message: string) { this.revision++; this.update({ message }); }
  async write(generate: (fresh: boolean) => Promise<string>, fresh = false) {
    if (this.state.busy || this.state.result || this.state.writing || (!fresh && this.requested)) return;
    this.requested = true;
    const generation = ++this.generation, revision = this.revision;
    this.update({ writing: true, error: '' });
    try {
      const message = await generate(fresh);
      if (generation === this.generation && revision === this.revision) this.update({ message });
    } catch (error) {
      if (generation === this.generation) this.update({ error: error instanceof Error ? error.message : String(error) });
    } finally { if (generation === this.generation) this.update({ writing: false }); }
  }
  async submit(action: Action, send: (message: string) => Promise<string>) {
    if (this.state.busy || this.state.result || !this.state.message.trim()) return;
    // The author's own message can be submitted while generation is running.
    // Its late response must not replace that message, including after failure.
    this.generation++;
    this.update({ busy: action, writing: false, error: '' });
    try { this.update({ result: await send(this.state.message.trim()) }); }
    catch (error) { this.update({ error: error instanceof Error ? error.message : String(error) }); }
    finally { this.update({ busy: '' }); }
  }
}
