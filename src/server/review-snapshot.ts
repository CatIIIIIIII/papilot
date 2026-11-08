import { Worker } from 'node:worker_threads';
import { ENGINE } from './paths.ts';
import type { ReviewSnapshot } from './ai-review.ts';

interface Job {
  pdf: string;
  key?: string;
  resolve: (snapshot: ReviewSnapshot) => void;
  reject: (error: Error) => void;
}

// One extraction at a time per server. Each worker releases its MuPDF heap on
// exit, so idle servers retain neither a thread nor a long paper's page cache.
export class ReviewSnapshots {
  private queue: Job[] = [];
  private current?: { worker: Worker; job: Job };
  private stopped = false;
  private stopping?: Promise<void>;
  get busy() { return Boolean(this.current || this.queue.length); }

  run(pdf: string, key?: string): Promise<ReviewSnapshot> {
    if (this.stopped) return Promise.reject(new Error('PDF review preparation was stopped.'));
    return new Promise((resolve, reject) => {
      this.queue.push({ pdf, key, resolve, reject });
      this.next();
    });
  }

  private next() {
    if (this.stopped || this.current) return;
    const job = this.queue.shift();
    if (!job) return;
    let worker: Worker;
    try {
      worker = new Worker(new URL('./review-snapshot-worker.mjs', import.meta.url), {
        // Do not inherit watch/test/inspect flags or depend on a parent's loader.
        execArgv: [], workerData: { pdf: job.pdf, key: job.key, engine: ENGINE },
      });
    } catch (error) { job.reject(error as Error); this.next(); return; }
    this.current = { worker, job };
    let snapshot: ReviewSnapshot | undefined, failure: Error | undefined;
    worker.once('message', (value: ReviewSnapshot) => { snapshot = value; void worker.terminate(); });
    worker.once('error', (error: Error) => { failure = error; });
    worker.once('exit', code => {
      this.current = undefined;
      if (!this.stopped) {
        if (snapshot) job.resolve(snapshot);
        else job.reject(failure || new Error(`PDF extraction stopped before finishing (exit ${code}).`));
      }
      this.next();
    });
  }

  stop(): Promise<void> {
    this.stopped = true;
    const error = new Error('PDF review preparation was stopped.');
    for (const job of this.queue.splice(0)) job.reject(error);
    this.current?.job.reject(error);
    return this.stopping ??= this.current ? this.current.worker.terminate().then(() => undefined) : Promise.resolve();
  }
}
