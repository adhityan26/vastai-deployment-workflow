import type { PreviewFrame, ProgressSink, ResultImage } from "@vast-comfy/core";

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
  | {
      kind: "done";
      images: ResultImage[];
      /** How long the image took: ComfyUI's execution time, else the server's submit-to-done time. */
      seconds: number;
      /** Seconds the job waited before ComfyUI started it, when known (from the progress socket). */
      queuedSeconds: number | null;
    }
  | { kind: "failed"; message: string };

/** The part of a progress socket a job needs. */
export interface LiveSocket {
  setPromptId(id: string): void;
  close(): void;
}

/**
 * What the progress socket of a pending job saw: only the newest step and the newest preview (never a
 * history of previews), plus when ComfyUI started the prompt. `end()` closes the socket and drops the
 * preview; it is called when the job finishes, fails, is forgotten or its instance is destroyed.
 */
export class LiveProgress implements ProgressSink {
  step: { step: number; max: number } | null = null;
  frame: PreviewFrame | null = null;
  /** Bumped on every new preview, so the page fetches the image only when it changed. */
  previewSeq = 0;
  /** Server time when ComfyUI reported execution_start, or null. */
  startedAt: number | null = null;
  socket: LiveSocket | null = null;
  private ended = false;

  constructor(private readonly now: () => number) {}

  progress(step: number, max: number): void {
    if (!this.ended) this.step = { step, max };
  }

  preview(frame: PreviewFrame): void {
    if (this.ended) return;
    this.frame = frame;
    this.previewSeq += 1;
  }

  started(): void {
    if (!this.ended && this.startedAt === null) this.startedAt = this.now();
  }

  finished(): void {
    // The history poll decides when the job is done; the socket closes itself.
  }

  end(): void {
    this.ended = true;
    this.frame = null;
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      // best effort
    }
  }
}

/** Which workflow a job ran: its SaveImage (or SaveVideo) node is looked up in that template when polling. */
export type JobKind = "generate" | "edit" | "upscale" | "video";

export interface Job {
  readonly id: string;
  /** Identity subject of the submitter: only they (or an admin) may read the job. */
  readonly owner: string;
  readonly createdAt: number;
  /** Tailnet hostname of the instance that runs it; internal only, never sent to a client. */
  readonly hostname: string;
  readonly kind: JobKind;
  /** What the submitter asked for and a short summary of the settings; kept so a saved image can say so. */
  readonly prompt: string;
  readonly label: string;
  state: JobState;
  /** The job's progress socket and what it saw; null when progress is off or the socket could not be opened. */
  readonly live: LiveProgress | null;
}

/** Generate jobs by ComfyUI prompt id, bounded by count and age. */
export class JobStore {
  private readonly jobs = new Map<string, Job>();

  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  /** Forget a job; its progress socket (if any) is closed with it. */
  private forget(id: string): void {
    this.jobs.get(id)?.live?.end();
    this.jobs.delete(id);
  }

  private purge(): void {
    const t = this.now();
    for (const [id, job] of this.jobs) if (t - job.createdAt >= this.ttlMs) this.forget(id);
  }

  add(
    job: Omit<Job, "createdAt" | "state" | "kind" | "prompt" | "label" | "live"> & { kind?: JobKind; prompt?: string; label?: string; live?: LiveProgress | null },
  ): Job {
    this.purge();
    // Map iteration is insertion order: forget the oldest jobs first.
    while (this.jobs.size >= this.max) {
      const oldest = this.jobs.keys().next().value;
      if (oldest === undefined) break;
      this.forget(oldest);
    }
    const stored: Job = {
      ...job,
      kind: job.kind ?? "generate",
      prompt: job.prompt ?? "",
      label: job.label ?? "",
      live: job.live ?? null,
      createdAt: this.now(),
      state: { kind: "pending" },
    };
    this.forget(stored.id);
    this.jobs.set(stored.id, stored);
    return stored;
  }

  /** Close every progress socket (the instance is being destroyed); the jobs themselves stay readable. */
  endAllLive(): void {
    for (const job of this.jobs.values()) job.live?.end();
  }

  /**
   * Close the progress sockets of every job that ran on another instance than `hostname` (null: none is
   * active), for example after an idle, failsafe or hard-cap destroy or a stuck start was released.
   */
  endLiveExcept(hostname: string | null): void {
    for (const job of this.jobs.values()) if (job.hostname !== hostname) job.live?.end();
  }

  get(id: string): Job | null {
    this.purge();
    return this.jobs.get(id) ?? null;
  }

  get size(): number {
    return this.jobs.size;
  }
}

/** The Vast account credit as last read: USD and the epoch milliseconds of the read. */
export interface CreditReading {
  readonly credit: number;
  readonly at: number;
}

/**
 * Reuses one Vast credit read for `ttlMs` and lets simultaneous callers share one read in flight, so
 * any number of admin tabs cost at most one Vast API call per interval. A failed read is not cached.
 */
export class CreditCache {
  private reading: CreditReading | null = null;
  private inflight: Promise<CreditReading> | null = null;

  constructor(
    private readonly read: () => Promise<number>,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  get(): Promise<CreditReading> {
    if (this.reading !== null && this.now() - this.reading.at < this.ttlMs) return Promise.resolve(this.reading);
    if (this.inflight === null) {
      this.inflight = this.read()
        .then((credit) => (this.reading = { credit, at: this.now() }))
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }
}
