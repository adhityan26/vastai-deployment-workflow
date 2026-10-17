import type { AppsConfig } from "./config.js";
import type { AgentStatus } from "./agent.js";
import { AlreadyActiveError, type InstanceRecord, type Registry } from "./registry.js";
import {
  CreateRejected,
  DestroyError,
  offerFiltersFromConfig,
  type CreateRequest,
  type DestroyOutcome,
  type Offer,
  type OfferFilters,
  type VastInstance,
} from "./vast.js";

// Lifecycle orchestration for the one GPU instance: start (write-ahead registry record before
// any Vast call), status view, extend, destroy and reconcile. Safety rules:
// - never leave a billing instance without a non-gone registry record if we can help it;
// - never adopt or automatically destroy an instance the registry does not own;
// - a record becomes gone only when Vast confirms the instance is destroyed or absent.

/** Label prefix of every instance this project creates; the full label is `vastcomfy:<hostname>`. */
export const LABEL_PREFIX = "vastcomfy";
const LABEL_SEPARATOR = ":";

// Exact --onstart-cmd text from spec 7.2 (protocol constant; path is the default REPO_DIR).
export const ONSTART_CMD =
  '{ [ -d /opt/vast-comfy/.git ] || git clone "$REPO_URL" /opt/vast-comfy; } && git -C /opt/vast-comfy checkout "$REPO_COMMIT" && bash /opt/vast-comfy/instance/onstart.sh || vastai destroy instance "$CONTAINER_ID" --api-key "$CONTAINER_API_KEY"'; // config-lint: ok (spec 7.2 protocol text)

// Image contract from spec 7.2 / S1. The portal's own port (8188) is part of the image protocol.
const PORTAL_PORT = 8188; // config-lint: ok (vastai/comfy portal port, protocol constant)
const READY_STATES = new Set(["ready", "idle-warning"]);
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

export class NoOffersError extends Error {
  constructor() {
    super("no Vast offer matches the configured filters");
    this.name = "NoOffersError";
  }
}

export class NoActiveInstanceError extends Error {
  constructor() {
    super("no active instance");
    this.name = "NoActiveInstanceError";
  }
}

/** Start failed after the write-ahead record; `ambiguous` means the instance may exist on Vast. */
export class StartError extends Error {
  readonly ambiguous: boolean;
  constructor(message: string, ambiguous: boolean) {
    super(message);
    this.name = "StartError";
    this.ambiguous = ambiguous;
  }
}

/** Vast destroy kept failing; the record stays non-gone and the instance may still bill. */
export class DestroyFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DestroyFailedError";
  }
}

export interface AgentLike {
  status(): Promise<AgentStatus>;
  extend(kind: "idle" | "failsafe", minutes: number): Promise<Record<string, unknown>>;
  destroy(reason: "manual" | "watchdog"): Promise<void>;
}

export interface VastLike {
  searchOffers(filters: OfferFilters): Promise<Offer[]>;
  createInstance(offerId: number, req: CreateRequest): Promise<{ id: number }>;
  listInstances(): Promise<VastInstance[]>;
  destroyInstance(id: number): Promise<DestroyOutcome>;
}

export interface LifecycleDeps {
  cfg: AppsConfig;
  vast: VastLike;
  registry: Registry;
  agentFor(record: InstanceRecord): AgentLike;
  /** Epoch UTC seconds. */
  clock(): number;
  tsAuthKey(): Promise<string>;
  newToken(): string;
  newHostname(): string;
  /** Waits between destroy attempts; defaults to a real timer. */
  sleep?(seconds: number): Promise<void>;
}

/** A registry record as it may leave this module: never the agent token. */
export type PublicRecord = Omit<InstanceRecord, "agent_token">;

export interface CostEstimate {
  offer_id: number;
  gpu_name: string | null;
  dph: number;
  horizon_hours: number;
  max_cost: number;
}

export interface StartResult {
  record: PublicRecord;
  estimate: CostEstimate;
}

export interface UnknownInstance {
  vast_instance_id: number;
  label: string | null;
  actual_status: string | null;
  start_date: number;
  dph: number;
}

export interface StatusView {
  state: string;
  record: PublicRecord | null;
  vast: { actual_status: string | null; start_date: number; dph: number } | null;
  vast_error: string | null;
  agent: AgentStatus | null;
  agent_error: string | null;
  /** Vast says running but the agent cannot be reached. */
  agent_unreachable: boolean;
  failed: { reason: string | null } | null;
  destroy_failed: { error: string } | null;
  dph: number | null;
  uptime_s: number | null;
  cost_so_far: number | null;
  progress: AgentStatus["progress"];
  remaining: { idle_s: number | null; failsafe_s: number | null; hard_cap_s: number | null };
  unknown: UnknownInstance[];
}

export interface ReconcileReport {
  vast_error: string | null;
  unknown: UnknownInstance[];
  linked: { tailnet_hostname: string; vast_instance_id: number }[];
  gone: { tailnet_hostname: string; reason: "vanished" | "never_created" }[];
  destroyed: { tailnet_hostname: string; vast_instance_id: number; reason: string; outcome: DestroyOutcome }[];
  destroy_failed: { tailnet_hostname: string; vast_instance_id: number; reason: string; error: string }[];
  ready: string[];
  unreachable_since: number | null;
}

export interface DestroyResult {
  outcome: "none" | "pending" | DestroyOutcome;
  agent_error: string | null;
}

function intCfg(cfg: AppsConfig, key: string, envName: string, min: number): number {
  const value = cfg[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new Error(`${envName} must be an integer >= ${min}`);
  }
  return value;
}

function strCfg(cfg: AppsConfig, key: string, envName: string): string {
  const value = cfg[key];
  if (typeof value !== "string" || value === "") throw new Error(`${envName} is not configured`);
  return value;
}

export function publicRecord(record: InstanceRecord): PublicRecord {
  const { agent_token: _omit, ...rest } = record;
  return rest;
}

/** The hostname an owned label names, or null when the label is not one of ours (or is the bare prefix). */
export function labelHostname(label: string | null): string | null {
  if (label === null) return null;
  const prefix = LABEL_PREFIX + LABEL_SEPARATOR;
  return label.startsWith(prefix) && label.length > prefix.length ? label.slice(prefix.length) : null;
}

export function isProjectLabel(label: string | null): boolean {
  return label === LABEL_PREFIX || labelHostname(label) !== null;
}

function unknownOf(inst: VastInstance): UnknownInstance {
  return {
    vast_instance_id: inst.id,
    label: inst.label,
    actual_status: inst.actual_status,
    start_date: inst.start_date,
    dph: inst.dph_total,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function realSleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export class Lifecycle {
  private readonly cfg: AppsConfig;
  private readonly sleep: (seconds: number) => Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private starting: Promise<StartResult> | null = null;
  private readonly secrets = new Set<string>();
  private lastDestroyError: { hostname: string; error: string } | null = null;

  constructor(private readonly deps: LifecycleDeps) {
    this.cfg = deps.cfg;
    this.sleep = deps.sleep ?? realSleep;
  }

  // Start, destroy and reconcile run one at a time so none of them acts on a stale record.
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Remove every secret this module handled (auth keys, agent tokens) from a message. */
  private scrub(text: string): string {
    let out = text;
    for (const s of this.secrets) if (s !== "") out = out.split(s).join("[redacted]");
    return out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  }

  private now(): number {
    return Math.floor(this.deps.clock());
  }

  private horizonHours(): number {
    return intCfg(this.cfg, "startFailsafeHours", "START_FAILSAFE_HOURS", 1);
  }

  private estimateFor(offer: Offer): CostEstimate {
    const horizon = this.horizonHours();
    return {
      offer_id: offer.id,
      gpu_name: typeof offer.gpu_name === "string" ? offer.gpu_name : null,
      dph: offer.dph_total,
      horizon_hours: horizon,
      max_cost: offer.dph_total * horizon,
    };
  }

  /** Cheapest matching offer and its upper-bound cost; read-only (for the confirmation dialog). */
  async estimate(): Promise<CostEstimate> {
    const offers = await this.deps.vast.searchOffers(offerFiltersFromConfig(this.cfg));
    const offer = offers[0];
    if (offer === undefined) throw new NoOffersError();
    return this.estimateFor(offer);
  }

  private buildEnv(hostname: string, token: string, authKey: string): Record<string, string> {
    const cfg = this.cfg;
    const comfyPort = intCfg(cfg, "comfyPort", "COMFY_PORT", 1);
    // Key names are the instance contract (spec 7.2); values come from config.
    return {
      AGENT_TOKEN: token,
      TS_AUTHKEY: authKey,
      TS_HOSTNAME: hostname,
      REPO_URL: strCfg(cfg, "repoUrl", "REPO_URL"),
      REPO_COMMIT: strCfg(cfg, "repoCommit", "REPO_COMMIT"),
      PROFILE: strCfg(cfg, "profile", "PROFILE"),
      IDLE_MINUTES: String(intCfg(cfg, "startIdleMinutes", "START_IDLE_MINUTES", 1)),
      FAILSAFE_HOURS: String(this.horizonHours()),
      HARD_CAP_HOURS: String(intCfg(cfg, "startHardCapHours", "START_HARD_CAP_HOURS", 1)),
      PORTAL_CONFIG: `localhost:${PORTAL_PORT}:${comfyPort}:/:ComfyUI`, // config-lint: ok (image portal protocol)
      COMFYUI_ARGS: `--disable-auto-launch --port ${comfyPort}`,
      WORKSPACE: "/workspace", // config-lint: ok (image contract, S1)
      DATA_DIRECTORY: "/workspace/", // config-lint: ok (image contract, S1)
    };
  }

  /**
   * Create the instance. Single-flight: concurrent calls share one attempt. The registry record
   * (`creating`) is written before any Vast call. A definite failure marks it gone; an ambiguous
   * create failure leaves it `creating` for reconcile to resolve by its label.
   */
  start(): Promise<StartResult> {
    if (this.starting) return this.starting;
    const run = this.exclusive(() => this.doStart());
    this.starting = run;
    const clear = (): void => {
      if (this.starting === run) this.starting = null;
    };
    run.then(clear, clear);
    return run;
  }

  private async doStart(): Promise<StartResult> {
    const { registry, vast } = this.deps;
    const hostname = this.deps.newHostname();
    const token = this.deps.newToken();
    this.secrets.add(token);
    const profile = strCfg(this.cfg, "profile", "PROFILE");
    // Write-ahead: throws AlreadyActiveError when an instance is already active.
    const record = await registry.begin({
      created_at: this.now(),
      profile,
      agent_token: token,
      tailnet_hostname: hostname,
    });

    let authKey: string;
    let offer: Offer;
    let request: CreateRequest;
    try {
      authKey = await this.deps.tsAuthKey();
      this.secrets.add(authKey);
      if (authKey === "") throw new Error("the Tailscale auth key is empty");
      const offers = await vast.searchOffers(offerFiltersFromConfig(this.cfg));
      const first = offers[0];
      if (first === undefined) throw new NoOffersError();
      offer = first;
      request = {
        image: strCfg(this.cfg, "vastImage", "VAST_IMAGE"),
        disk: intCfg(this.cfg, "vastDiskGb", "VAST_DISK_GB", 1),
        env: this.buildEnv(hostname, token, authKey),
        onstart: ONSTART_CMD,
        label: `${LABEL_PREFIX}${LABEL_SEPARATOR}${hostname}`,
      };
    } catch (err) {
      // Nothing was sent to Vast's create endpoint: the record can safely become gone.
      await registry.markGone(record.tailnet_hostname);
      if (err instanceof NoOffersError) throw err;
      throw new StartError(this.scrub(`start failed before create: ${message(err)}`), false);
    }

    let created: { id: number };
    try {
      created = await vast.createInstance(offer.id, request);
    } catch (err) {
      if (err instanceof CreateRejected) {
        await registry.markGone(record.tailnet_hostname);
        throw new StartError(this.scrub(`Vast refused to create the instance: ${err.message}`), false);
      }
      // Ambiguous: the instance may exist. Keep the record `creating` (blocks another start)
      // so reconcile can link it by label or mark it gone after the grace period.
      throw new StartError(
        this.scrub(`instance creation is uncertain; reconcile will resolve it: ${message(err)}`),
        true,
      );
    }

    try {
      const updated = await registry.update(record.tailnet_hostname, {
        status: "booting",
        vast_instance_id: created.id,
        vast_start_date: this.now(),
      });
      return { record: publicRecord(updated), estimate: this.estimateFor(offer) };
    } catch (err) {
      // The instance exists but the registry could not record it: destroy it right away.
      const outcome = await this.vastDestroy(created.id).catch(() => null);
      if (outcome !== null) await registry.markGone(record.tailnet_hostname).catch(() => undefined);
      throw new StartError(
        this.scrub(
          `could not record instance ${created.id}: ${message(err)}; ` +
            (outcome !== null ? "it was destroyed" : "destroy failed, reconcile will retry"),
        ),
        outcome === null,
      );
    }
  }

  /** One Vast destroy with retries per DestroyError; resolves only when Vast says destroyed/gone. */
  private async vastDestroy(id: number): Promise<DestroyOutcome> {
    const attempts = intCfg(this.cfg, "webDestroyRetries", "WEB_DESTROY_RETRIES", 1);
    const backoff = intCfg(this.cfg, "webDestroyBackoffS", "WEB_DESTROY_BACKOFF_S", 0);
    let last = "";
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await this.sleep(backoff);
      try {
        return await this.deps.vast.destroyInstance(id);
      } catch (err) {
        if (!(err instanceof DestroyError)) throw err;
        last = err.message;
      }
    }
    throw new DestroyFailedError(this.scrub(`Vast destroy of instance ${id} failed after ${attempts} attempts: ${last}`));
  }

  /**
   * Destroy a record's instance: agent /destroy first (best effort), then always Vast destroy.
   * The record becomes gone only after Vast answers destroyed or gone.
   */
  private async destroyRecord(
    record: InstanceRecord,
    id: number,
    reason: "manual" | "watchdog",
  ): Promise<DestroyResult> {
    const { registry } = this.deps;
    this.secrets.add(record.agent_token);
    let current = record;
    if (current.status !== "stopping") {
      current = await registry.update(record.tailnet_hostname, { status: "stopping", vast_instance_id: id });
    }
    let agentError: string | null = null;
    try {
      await this.deps.agentFor(current).destroy(reason);
    } catch (err) {
      agentError = this.scrub(message(err));
    }
    let outcome: DestroyOutcome;
    try {
      outcome = await this.vastDestroy(id);
    } catch (err) {
      const error = this.scrub(message(err));
      this.lastDestroyError = { hostname: record.tailnet_hostname, error };
      throw err instanceof DestroyFailedError ? err : new DestroyFailedError(error);
    }
    await registry.markGone(record.tailnet_hostname);
    if (this.lastDestroyError?.hostname === record.tailnet_hostname) this.lastDestroyError = null;
    return { outcome, agent_error: agentError };
  }

  /** Destroy the active instance. Idempotent: no active record -> outcome "none". */
  destroy(): Promise<DestroyResult> {
    return this.exclusive(async () => {
      const record = await this.deps.registry.active();
      if (record === null) return { outcome: "none", agent_error: null };
      let id = record.vast_instance_id;
      if (id === null) {
        // An ambiguous create: find our instance by its label before giving up.
        const match = (await this.deps.vast.listInstances()).find(
          (i) => labelHostname(i.label) === record.tailnet_hostname,
        );
        if (match === undefined) {
          // Vast does not list it (yet). Keep the record until reconcile's grace period ends.
          return { outcome: "pending", agent_error: null };
        }
        id = match.id;
      }
      return this.destroyRecord(record, id, "manual");
    });
  }

  /**
   * Destroy an instance the registry does not own, on an explicit user request only. Refuses
   * anything without the project label and anything owned by the active record.
   */
  destroyUnknown(vastId: number): Promise<DestroyOutcome> {
    return this.exclusive(async () => {
      const inst = (await this.deps.vast.listInstances()).find((i) => i.id === vastId);
      if (inst === undefined) return "gone";
      if (!isProjectLabel(inst.label)) throw new Error(`instance ${vastId} does not carry the project label`);
      const active = await this.deps.registry.active();
      if (
        active !== null &&
        (active.vast_instance_id === vastId || labelHostname(inst.label) === active.tailnet_hostname)
      ) {
        throw new Error(`instance ${vastId} belongs to the active record; use destroy()`);
      }
      return this.vastDestroy(vastId);
    });
  }

  async extend(kind: "idle" | "failsafe", minutes: number): Promise<Record<string, unknown>> {
    const record = await this.deps.registry.active();
    if (record === null || record.vast_instance_id === null || record.status === "stopping") {
      throw new NoActiveInstanceError();
    }
    this.secrets.add(record.agent_token);
    try {
      return await this.deps.agentFor(record).extend(kind, minutes);
    } catch (err) {
      if (err instanceof Error) err.message = this.scrub(err.message);
      throw err;
    }
  }

  /** Merged status of registry, Vast and agent. Never throws because one source is down. */
  async view(): Promise<StatusView> {
    const now = this.now();
    const record = await this.deps.registry.active();
    let instances: VastInstance[] | null = null;
    let vastError: string | null = null;
    try {
      instances = await this.deps.vast.listInstances();
    } catch (err) {
      vastError = this.scrub(message(err));
    }
    const inst =
      record === null || instances === null
        ? undefined
        : instances.find(
            (i) =>
              (record.vast_instance_id !== null && i.id === record.vast_instance_id) ||
              labelHostname(i.label) === record.tailnet_hostname,
          );
    const unknown = (instances ?? [])
      .filter((i) => isProjectLabel(i.label) && i !== inst)
      .filter((i) => record === null || i.id !== record.vast_instance_id)
      .map(unknownOf);

    let agent: AgentStatus | null = null;
    let agentError: string | null = null;
    if (record !== null && record.vast_instance_id !== null) {
      this.secrets.add(record.agent_token);
      try {
        agent = await this.deps.agentFor(record).status();
      } catch (err) {
        agentError = this.scrub(message(err));
        agent = null;
      }
    }

    const dph = inst ? inst.dph_total : null;
    let uptime: number | null = null;
    if (inst && inst.start_date > 0) uptime = Math.max(0, now - inst.start_date);
    else if (agent?.uptime_s != null) uptime = agent.uptime_s;
    const cost = dph !== null && uptime !== null ? (dph * uptime) / SECONDS_PER_HOUR : null;

    const left = (at: number | null | undefined): number | null => (at == null ? null : Math.max(0, at - now));
    let hardCapAt: number | null = agent?.hard_cap_at ?? null;
    if (inst && inst.start_date > 0) {
      const byVast = inst.start_date + intCfg(this.cfg, "startHardCapHours", "START_HARD_CAP_HOURS", 1) * SECONDS_PER_HOUR;
      hardCapAt = hardCapAt === null ? byVast : Math.min(hardCapAt, byVast);
    }

    let state: string;
    if (record === null) state = "none";
    else if (record.status === "creating") state = "creating";
    else if (agent?.state) state = agent.state;
    else state = record.status;

    const destroyFailed =
      record !== null && this.lastDestroyError?.hostname === record.tailnet_hostname
        ? { error: this.lastDestroyError.error }
        : agent?.state === "destroy_failed"
          ? { error: this.scrub(agent.destroy.last_error ?? "destroy failed on the instance") }
          : null;

    return {
      state,
      record: record === null ? null : publicRecord(record),
      vast: inst ? { actual_status: inst.actual_status, start_date: inst.start_date, dph: inst.dph_total } : null,
      vast_error: vastError,
      agent,
      agent_error: agentError,
      agent_unreachable: agent === null && inst?.actual_status === "running",
      failed: agent?.state === "failed" ? { reason: agent.reason } : null,
      destroy_failed: destroyFailed,
      dph,
      uptime_s: uptime,
      cost_so_far: cost,
      progress: agent?.progress ?? null,
      remaining: {
        idle_s: left(agent?.idle_destroy_at),
        failsafe_s: left(agent?.failsafe_at),
        hard_cap_s: left(hardCapAt),
      },
      unknown,
    };
  }

  /**
   * Match the registry against Vast and enforce the web-side limits (boot timeout, unreachable
   * agent, hard cap by Vast start_date). Unknown project instances are only reported.
   */
  reconcile(): Promise<ReconcileReport> {
    return this.exclusive(() => this.doReconcile());
  }

  private async doReconcile(): Promise<ReconcileReport> {
    const { registry, vast } = this.deps;
    const report: ReconcileReport = {
      vast_error: null,
      unknown: [],
      linked: [],
      gone: [],
      destroyed: [],
      destroy_failed: [],
      ready: [],
      unreachable_since: null,
    };
    let instances: VastInstance[];
    try {
      instances = await vast.listInstances();
    } catch (err) {
      // Without Vast's list nothing can be decided safely: change nothing.
      report.vast_error = this.scrub(message(err));
      return report;
    }
    const now = this.now();
    const grace = intCfg(this.cfg, "reconcileGraceMin", "RECONCILE_GRACE_MIN", 1) * SECONDS_PER_MINUTE;
    const bootTimeout = intCfg(this.cfg, "bootTimeoutMin", "BOOT_TIMEOUT_MIN", 1) * SECONDS_PER_MINUTE;
    const unreachableLimit = intCfg(this.cfg, "unreachableDestroyMin", "UNREACHABLE_DESTROY_MIN", 1) * SECONDS_PER_MINUTE;
    const hardCap = intCfg(this.cfg, "startHardCapHours", "START_HARD_CAP_HOURS", 1) * SECONDS_PER_HOUR;

    let record = await registry.active();

    // 1. A creating record without an id: link it to the instance carrying its own label.
    if (record !== null && record.vast_instance_id === null) {
      const hostname = record.tailnet_hostname;
      const match = instances.find((i) => labelHostname(i.label) === hostname);
      if (match !== undefined) {
        record = await registry.update(hostname, {
          status: "booting",
          vast_instance_id: match.id,
          vast_start_date: match.start_date > 0 ? match.start_date : null,
        });
        report.linked.push({ tailnet_hostname: hostname, vast_instance_id: match.id });
      } else if (now - record.created_at >= grace) {
        await registry.markGone(hostname);
        report.gone.push({ tailnet_hostname: hostname, reason: "never_created" });
        record = null;
      } else {
        record = null; // still within the grace period: leave it alone this cycle
      }
    }

    // 2. Every project instance the active record does not own is unknown: report only.
    const ownedId = record?.vast_instance_id ?? null;
    report.unknown = instances.filter((i) => isProjectLabel(i.label) && i.id !== ownedId).map(unknownOf);

    if (record === null || record.vast_instance_id === null) return report;
    const id = record.vast_instance_id;
    const hostname = record.tailnet_hostname;
    this.secrets.add(record.agent_token);
    const inst = instances.find((i) => i.id === id);

    // 3. The record's instance vanished from Vast (after the grace period): gone.
    if (inst === undefined) {
      if (now - record.created_at >= grace) {
        await registry.markGone(hostname);
        report.gone.push({ tailnet_hostname: hostname, reason: "vanished" });
      }
      return report;
    }

    // 4. Read the agent; track readiness and the unreachable timer.
    let agent: AgentStatus | null = null;
    try {
      agent = await this.deps.agentFor(record).status();
    } catch {
      // Unreachable, and also an unusable /status (HTTP error, bad body): both start the
      // unreachable timer, the safer choice for a billing instance.
      agent = null;
    }
    const patch: Partial<Omit<InstanceRecord, "tailnet_hostname">> = {};
    if (agent !== null) {
      if (record.unreachable_since != null) patch.unreachable_since = null;
      if (READY_STATES.has(agent.state ?? "") && record.status === "booting") {
        patch.status = "ready";
        report.ready.push(hostname);
      }
    } else if (record.unreachable_since == null) {
      patch.unreachable_since = now;
    }
    if (inst.start_date > 0 && record.vast_start_date !== inst.start_date) patch.vast_start_date = inst.start_date;
    if (Object.keys(patch).length > 0) record = await registry.update(hostname, patch);
    report.unreachable_since = record.unreachable_since ?? null;

    // 5. Enforcement.
    let reason: string | null = null;
    if (record.status === "stopping") reason = "destroy_retry";
    else if (inst.start_date > 0 && now - inst.start_date >= hardCap) reason = "hard_cap";
    else if (record.status !== "ready" && now - record.created_at >= bootTimeout) reason = "boot_timeout";
    else if (
      agent === null &&
      inst.actual_status === "running" &&
      record.unreachable_since != null &&
      now - record.unreachable_since >= unreachableLimit
    ) {
      reason = "unreachable";
    }
    if (reason === null) return report;
    try {
      const result = await this.destroyRecord(record, id, "watchdog");
      report.destroyed.push({
        tailnet_hostname: hostname,
        vast_instance_id: id,
        reason,
        outcome: result.outcome as DestroyOutcome,
      });
    } catch (err) {
      report.destroy_failed.push({ tailnet_hostname: hostname, vast_instance_id: id, reason, error: this.scrub(message(err)) });
    }
    return report;
  }
}

export { AlreadyActiveError };
