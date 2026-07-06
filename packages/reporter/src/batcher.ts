/**
 * Holds pending items and flushes them in bounded batches. Flushes trigger
 * on (size reaches batchSize) OR (flushIntervalMs elapsed since the first
 * queued item). The flush function runs sequentially so calls don't overlap
 * for the same run.
 *
 * Fail-closed: if the flush function throws, the batch is handed to
 * `onFailure` instead of being retried in-band. The reporter decides what to do
 * with failed items — today it logs a warning and DROPS them (there is no
 * on-disk fallback yet), relying on the dashboard's stale-run watchdog to
 * finalize the run and on the prefilled `queued` rows to keep the missing tests
 * visible. A durable fallback (persist dropped batches, re-send next run) is a
 * possible future enhancement.
 */
export class Batcher<T> {
  private queue: T[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> = Promise.resolve();

  constructor(
    private options: {
      batchSize: number;
      flushIntervalMs: number;
      flush: (batch: T[]) => Promise<void>;
      onFailure: (batch: T[], err: Error) => void;
    },
  ) {}

  enqueue(item: T): void {
    this.queue.push(item);
    if (this.queue.length >= this.options.batchSize) {
      this.triggerFlush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(
        () => this.triggerFlush(),
        this.options.flushIntervalMs,
      );
    }
  }

  private triggerFlush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    this.flushing = this.flushing.then(async () => {
      try {
        await this.options.flush(batch);
      } catch (err) {
        this.options.onFailure(
          batch,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    });
  }

  /** Drain the queue and wait for all in-flight flushes to settle. */
  async drain(): Promise<void> {
    this.triggerFlush();
    await this.flushing;
  }
}
