// Each resource has one request in flight. Replacing its key cancels obsolete
// work and prevents even an already-resolving response from updating the UI.
export class ReadRequest<T> {
  private current: { key: string; controller: AbortController; promise: Promise<void> } | null = null;

  run(key: string, load: (signal: AbortSignal) => Promise<T>, apply: (value: T) => void): Promise<void> {
    if (this.current?.key === key) return this.current.promise;
    this.cancel();
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => load(controller.signal))
      .then(value => { if (!controller.signal.aborted) apply(value); })
      .catch(error => { if (!controller.signal.aborted) throw error; })
      .finally(() => { if (this.current?.controller === controller) this.current = null; });
    this.current = { key, controller, promise };
    return promise;
  }

  cancel() { this.current?.controller.abort(); this.current = null; }
}

// HTTP/1 browsers share a small connection pool across tabs. Long-lived event
// streams can fill that pool and block navigation, assets, and API requests.
export function canStreamUpdates(protocol: string) { return protocol === 'h2' || protocol === 'h3'; }

// A partial timeline read returns only the items written since the last one.
// Changed items replace their earlier version in place, new ones join in time
// order, and every unchanged item keeps its identity so its message is not
// rendered again.
export function mergeTimeline<T extends { id: string; createdAt: number }>(items: T[], changed: T[]): T[] {
  if (!changed.length) return items;
  const updates = new Map(changed.map(item => [item.id, item]));
  const merged = items.map(item => { const next = updates.get(item.id); if (next) updates.delete(item.id); return next || item; });
  return updates.size ? [...merged, ...updates.values()].sort((a, b) => a.createdAt - b.createdAt) : merged;
}

// Old Claude adapters stored a streamed block and its final envelope under
// different indexes. Hide only the unfinished copy of the very same message;
// retain the database, completed repeats, and identical text in other turns.
export function visibleTimeline<T extends { id: string; type: string; text: string; status?: string }>(items: T[]): T[] {
  const message = (item: T) => item.type === 'assistant' ? /^(.*:msg_[^:]+):\d+$/.exec(item.id)?.[1] : undefined;
  const completed = new Map<string, Set<string>>();
  for (const item of items) {
    const key = message(item);
    if (key && item.status === 'completed') {
      const texts = completed.get(key) || new Set<string>(); texts.add(item.text); completed.set(key, texts);
    }
  }
  return items.filter(item => {
    const key = message(item);
    return item.status !== undefined || !key || !completed.get(key)?.has(item.text);
  });
}
