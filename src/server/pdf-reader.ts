import { Worker } from 'node:worker_threads';
import type { Annotation } from '../shared.ts';
import type { AnnotationPlacement } from './annotation-placement.ts';
import type { Located, MarkRequest } from './note-location.ts';
import { ENGINE } from './paths.ts';

/** Reads notes' places on manuscript PDFs in a worker thread. Opening a long
 *  paper's PDF, reading a page's text and rendering pages to compare them
 *  takes hundreds of milliseconds each, which on the server's event loop
 *  would hold up every other request, also while builds are running. The
 *  worker ends when it has been idle for a while, which frees the memory of
 *  the PDFs it read. */
export class PdfReader {
  private worker?: Worker;
  private jobs = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private counter = 0;
  private idle?: NodeJS.Timeout;
  private stopped = false;
  constructor(private idleMs = 30000) {}

  /** The text under a marked region of a PDF page and the source lines it
   *  came from; null when the page does not exist. */
  locate(request: MarkRequest): Promise<Located | null> { return this.call('locate', request); }
  /** Notes from earlier PDFs placed on the current one, in order; null for
   *  a note whose place is not proven. */
  place(current: string, notes: { note: Annotation; previous: string }[]): Promise<(AnnotationPlacement | null)[]> {
    return notes.length ? this.call('place', { current, notes }) : Promise.resolve([]);
  }

  private call<T>(op: string, args: unknown): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('The server is shutting down.'));
    clearTimeout(this.idle);
    const worker = this.worker ??= this.start(), id = ++this.counter;
    worker.ref();
    return new Promise<T>((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      worker.postMessage({ id, op, args });
    });
  }
  private start() {
    const worker = new Worker(new URL('./pdf-reader-worker.mjs', import.meta.url), {
      // Do not inherit watch/test/inspect flags or depend on a parent's loader.
      execArgv: [], workerData: { engine: ENGINE },
    });
    worker.on('message', ({ id, value, error }: { id: number; value?: unknown; error?: string }) => {
      const job = this.jobs.get(id);
      if (!job) return;
      this.jobs.delete(id);
      if (error !== undefined) job.reject(new Error(error)); else job.resolve(value);
      if (!this.jobs.size) this.rest(worker);
    });
    worker.on('error', error => this.lost(worker, error));
    worker.on('exit', code => this.lost(worker, new Error(`PDF reading stopped before finishing (exit ${code}).`)));
    return worker;
  }
  // Nothing waits for an idle worker: it does not keep the process running,
  // and it ends after a while.
  private rest(worker: Worker) {
    worker.unref();
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (this.worker !== worker || this.jobs.size) return;
      this.worker = undefined;
      void worker.terminate();
    }, this.idleMs);
    this.idle.unref();
  }
  private lost(worker: Worker, error: Error) {
    if (this.worker !== worker) return;
    this.worker = undefined;
    for (const job of this.jobs.values()) job.reject(error);
    this.jobs.clear();
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.idle);
    const worker = this.worker;
    if (worker) this.lost(worker, new Error('The server is shutting down.'));
    await worker?.terminate();
  }
}
