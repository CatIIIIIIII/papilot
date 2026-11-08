/** Share in-flight comparisons and decoded results across note switches. */
export class NotePreviewCache<T> {
  private entries = new Map<string, { promise: Promise<T>; value?: T }>();
  constructor(private limit = 24) {}
  peek(key: string) { return this.entries.get(key)?.value; }
  read(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);
    if (cached) { this.entries.delete(key); this.entries.set(key, cached); return cached.promise; }
    const entry: { promise: Promise<T>; value?: T } = { promise: Promise.resolve().then(load) };
    this.entries.set(key, entry);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    entry.promise = entry.promise.then(value => { entry.value = value; return value; }, error => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    });
    return entry.promise;
  }
}
