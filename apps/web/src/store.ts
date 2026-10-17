import type { ResultImage } from "@vast-comfy/core";

// Small in-memory state of the web process: a sliding-window rate limiter and the generate job
// table. Both are deliberately process-local (one web container); a restart forgets them, which
// is acceptable: the limiter then errs on the permissive side for at most one window, and job
// results stay on the instance (nothing is stored here but references).

/** Sliding one-window limiter: at most `limit` hits per `windowMs` per key. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}

  /** Record a hit for `key` and return true, or return false (recording nothing) when over the limit. */
  take(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => t - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}

export type JobState =
  | { kind: "pending" }
  | { kind: "done"; images: ResultImage[] }
  | { kind: "failed"; message: string };

export interface Job {
  readonly id: string;
  /** Identity subject of the submitter: only they (or an admin) may read the job. */
  readonly owner: string;
  readonly createdAt: number;
  /** Tailnet hostname of the instance that runs it; internal only, never sent to a client. */
  readonly hostname: string;
  state: JobState;
}

/** Generate jobs by ComfyUI prompt id, bounded by count and age. */
export class JobStore {
  private readonly jobs = new Map<string, Job>();

  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  private purge(): void {
    const t = this.now();
    for (const [id, job] of this.jobs) if (t - job.createdAt >= this.ttlMs) this.jobs.delete(id);
  }

  add(job: Omit<Job, "createdAt" | "state">): Job {
    this.purge();
    // Map iteration is insertion order: forget the oldest jobs first.
    while (this.jobs.size >= this.max) {
      const oldest = this.jobs.keys().next().value;
      if (oldest === undefined) break;
      this.jobs.delete(oldest);
    }
    const stored: Job = { ...job, createdAt: this.now(), state: { kind: "pending" } };
    this.jobs.delete(stored.id);
    this.jobs.set(stored.id, stored);
    return stored;
  }

  get(id: string): Job | null {
    this.purge();
    return this.jobs.get(id) ?? null;
  }

  get size(): number {
    return this.jobs.size;
  }
}
