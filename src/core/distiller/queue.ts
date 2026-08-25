import { EventEmitter } from 'node:events';
import type { Session } from '../types.js';
import type { Distiller, DistillResult } from './distiller.js';

export type JobState = 'queued' | 'running' | 'done' | 'failed';

export interface Job {
  session: Session;
  state: JobState;
  attempts: number;
  error?: string;
  result?: DistillResult;
}

export interface QueueOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Serial distill queue with exponential backoff.
 *
 * Serial on purpose: distilling is not latency-sensitive, and one call at a
 * time keeps token spend legible and stays far away from rate limits. A
 * permanently failing session is parked, not retried forever - its transcript
 * is still on disk and can be re-queued by hand.
 */
export class DistillQueue extends EventEmitter {
  private readonly jobs = new Map<string, Job>();
  private readonly pending: string[] = [];
  private running = false;
  private stopped = false;

  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(
    private readonly distiller: Distiller,
    opts: QueueOptions = {}
  ) {
    super();
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
    this.maxDelayMs = opts.maxDelayMs ?? 60_000;
  }

  enqueue(session: Session): void {
    const existing = this.jobs.get(session.id);
    if (existing && (existing.state === 'queued' || existing.state === 'running')) return;
    if (existing?.state === 'done') return;

    this.jobs.set(session.id, { session, state: 'queued', attempts: existing?.attempts ?? 0 });
    this.pending.push(session.id);
    this.emit('progress', this.stats());
    void this.drain();
  }

  stats() {
    let done = 0;
    let failed = 0;
    for (const j of this.jobs.values()) {
      if (j.state === 'done') done++;
      else if (j.state === 'failed') failed++;
    }
    return { total: this.jobs.size, done, failed, pending: this.pending.length };
  }

  listJobs(): Job[] {
    return [...this.jobs.values()];
  }

  stop(): void {
    this.stopped = true;
  }

  private async drain(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;

    try {
      while (this.pending.length > 0 && !this.stopped) {
        const id = this.pending.shift()!;
        const job = this.jobs.get(id);
        if (!job) continue;

        job.state = 'running';
        job.attempts++;
        this.emit('progress', this.stats());

        try {
          const result = await this.distiller.distill(job.session);
          job.state = 'done';
          job.result = result;
          delete job.error;
          this.emit('done', result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          job.error = message;

          if (job.attempts >= this.maxAttempts) {
            job.state = 'failed';
            this.emit('failed', { sessionId: id, error: message, attempts: job.attempts });
          } else {
            job.state = 'queued';
            const delay = Math.min(this.baseDelayMs * 2 ** (job.attempts - 1), this.maxDelayMs);
            this.emit('retry', { sessionId: id, attempt: job.attempts, delayMs: delay, error: message });
            setTimeout(() => {
              if (this.stopped) return;
              this.pending.push(id);
              void this.drain();
            }, delay).unref?.();
          }
        }
        this.emit('progress', this.stats());
      }
    } finally {
      this.running = false;
    }
  }
}
