import { camelCase, type AppsConfig } from "./config.js";
import type { AgentStatus } from "./agent.js";
import type { ModelSpec } from "./profile.js";
import { AlreadyActiveError, type InstanceRecord, type Registry } from "./registry.js";
import {
  CreateRejected,
  DestroyError,
  MB_PER_GB,
  normalizeGpuName,
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
const VANISH_CONFIRMATIONS = 2; // consecutive lists without the instance before it counts as gone
const MB_PER_GIB = 1024; // Vast reports gpu_ram in MiB; shown as whole GiB (24564 -> 24)
const DOWNLOAD_STATE = "downloading";
const MODELS_PHASE = "models";

export class NoOffersError extends Error {
  constructor() {
    super("no Vast offer matches the configured filters");
    this.name = "NoOffersError";
  }
}

/** VAST_ALLOWED_GPUS is empty: the web refuses to search or rent rather than take any GPU. */
export class NoGpuConfiguredError extends Error {
  constructor() {
    super("no GPU model is configured (VAST_ALLOWED_GPUS is empty)");
    this.name = "NoGpuConfiguredError";
  }
}

/** The requested GPU model is not in VAST_ALLOWED_GPUS; nothing was searched or recorded. */
export class GpuNotAllowedError extends Error {
  constructor() {
    super("this GPU model is not offered");
    this.name = "GpuNotAllowedError";
  }
}

export class NoActiveInstanceError extends Error {
  constructor() {
    super("no active instance");
    this.name = "NoActiveInstanceError";
  }
}

/**
 * Why a start failed, as a fixed identifier (safe to log and to show; never provider text).
 * ts_key_missing: the Tailscale key file is unreadable or empty; vast_unavailable: the offer
 * search failed; config_invalid: a start setting is missing; vast_rejected: Vast definitely
 * refused the create; create_uncertain: the create may or may not have happened;
 * registry_failed: the instance was created but could not be recorded.
 */
export type StartFailReason =
  | "ts_key_missing"
  | "vast_unavailable"
  | "config_invalid"
  | "vast_rejected"
  | "create_uncertain"
  | "registry_failed"
  | "unexpected";

/** Start failed after the write-ahead record; `ambiguous` means the instance may exist on Vast. */
export class StartError extends Error {
  readonly ambiguous: boolean;
  readonly reason: StartFailReason;
  constructor(message: string, ambiguous: boolean, reason: StartFailReason = "unexpected") {
    super(message);
    this.name = "StartError";
    this.ambiguous = ambiguous;
    this.reason = reason;
  }
}

/** The request was refused on purpose (e.g. not a project instance); the message is safe to show. */
export class RefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusedError";
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
  /** The profile's model files in download order, for the overall download progress. */
  profileModels?: readonly ModelSpec[];
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

/** One selectable GPU model with its cheapest current offer (no offer id leaves the server). */
export interface GpuOption {
  name: string;
  dph: number | null;
  vram_gb: number | null;
  available: boolean;
}

/** Overall model download progress across all profile files (the agent reports one file). */
export interface DownloadView {
  files_total: number;
  /** Files before the current one in profile order. */
  files_done: number;
  bytes_done: number;
  bytes_total: number;
  /** Basename of the file being downloaded, as named by the profile. */
  current_file: string;
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
  /** GPU model of the active instance: Vast's row, else the offer chosen at start. */
  gpu_name: string | null;
  download: DownloadView | null;
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

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Overall progress while models download: files before the current one (profile order) count as
 * done, the current one counts its bytes (clamped to its size), later ones count nothing. Any
 * doubt (other phase or state, unknown or ambiguous file name, a bad counter) gives null.
 */
export function overallDownload(
  state: string,
  progress: AgentStatus["progress"],
  models: readonly ModelSpec[],
): DownloadView | null {
  if (state !== DOWNLOAD_STATE || progress === null || progress.phase !== MODELS_PHASE || models.length === 0) return null;
  if (typeof progress.file !== "string" || typeof progress.bytes_done !== "number") return null;
  if (!Number.isFinite(progress.bytes_done)) return null;
  const name = baseName(progress.file);
  if (name === "") return null;
  const matches = models.map((m, i) => (baseName(m.file) === name ? i : -1)).filter((i) => i >= 0);
  if (matches.length !== 1) return null;
  const index = matches[0]!;
  const current = models[index]!;
  const before = models.slice(0, index).reduce((sum, m) => sum + m.size_bytes, 0);
  return {
    files_total: models.length,
    files_done: index,
    bytes_done: before + Math.min(Math.max(progress.bytes_done, 0), current.size_bytes),
    bytes_total: models.reduce((sum, m) => sum + m.size_bytes, 0),
    current_file: baseName(current.file),
  };
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
  // Hostnames whose destroy() returned "pending" (ambiguous create not yet listed by Vast).
  // In memory only: after a web restart boot_timeout still destroys the instance once linked.
  private readonly destroyRequested = new Set<string>();
  // Consecutive successful Vast lists that omitted a record's instance, per hostname.
  private readonly vanishMisses = new Map<string, number>();
  // GPU model of the offer the last start chose, until Vast's own row names it.
  private startedGpu: { hostname: string; gpu_name: string | null } | null = null;

  constructor(private readonly deps: LifecycleDeps) {
    this.cfg = deps.cfg;
    this.sleep = deps.sleep ?? realSleep;
    // Configured secrets (e.g. VAST_API_KEY) are scrubbed too, whoever echoes them.
    for (const name of this.cfg.secretNames ?? []) {
      const value = this.cfg[camelCase(name)];
      if (typeof value === "string" && value !== "") this.secrets.add(value);
    }
  }

  /** The agent's /status with every free-text field scrubbed (the agent is not trusted). */
  private scrubStatus(status: AgentStatus): AgentStatus {
    const clean = (v: unknown): unknown => {
      if (typeof v === "string") return this.scrub(v);
      if (Array.isArray(v)) return v.map(clean);
      if (v !== null && typeof v === "object") {
        return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, clean(x)]));
      }
      return v;
    };
    return clean(status) as AgentStatus;
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

  /** The allow-list in offer-query form (deduplicated, config order); empty fails closed. */
  private allowedModels(): string[] {
    const raw = this.cfg["vastAllowedGpus"];
    const list = Array.isArray(raw) ? raw.filter((g): g is string => typeof g === "string" && g !== "") : [];
    const models = [...new Set(list.map(normalizeGpuName))];
    if (models.length === 0) throw new NoGpuConfiguredError();
    return models;
  }

  /** The models a search may return: the requested one (exact match after normalisation) or all. */
  private modelsFor(gpu: string | undefined): string[] {
    const models = this.allowedModels();
    if (gpu === undefined) return models;
    const wanted = normalizeGpuName(gpu);
    if (!models.includes(wanted)) throw new GpuNotAllowedError();
    return [wanted];
  }

  /** The configured offer filters (throws VastError on a bad VAST_* value). */
  private baseFilters(): OfferFilters {
    return offerFiltersFromConfig(this.cfg);
  }

  /**
   * One Vast search over `models`. Whatever Vast returns, an offer is kept only when it is one
   * of these models, has a finite positive price within VAST_MAX_DPH and reports at least
   * VAST_MIN_VRAM_GB (same MB unit as the query); a missing price or VRAM drops it.
   */
  private async offersFor(models: readonly string[], base: OfferFilters = this.baseFilters()): Promise<Offer[]> {
    const filters: OfferFilters = { ...base, allowedGpus: models };
    const minRamMb = filters.minVramGb * MB_PER_GB;
    const offers = await this.deps.vast.searchOffers(filters);
    return offers
      .filter((o) => typeof o.gpu_name === "string" && models.includes(normalizeGpuName(o.gpu_name)))
      .filter((o) => typeof o.dph_total === "number" && Number.isFinite(o.dph_total) && o.dph_total > 0)
      .filter((o) => o.dph_total <= filters.maxDph)
      .filter((o) => typeof o.gpu_ram === "number" && Number.isFinite(o.gpu_ram) && o.gpu_ram >= minRamMb)
      .sort((a, b) => a.dph_total - b.dph_total);
  }

  /** Every allowed model in config order with its cheapest matching offer (one Vast search). */
  async gpuOptions(): Promise<GpuOption[]> {
    const models = this.allowedModels();
    const offers = await this.offersFor(models);
    return models.map((name) => {
      const best = offers.find((o) => normalizeGpuName(o.gpu_name as string) === name);
      if (best === undefined) return { name, dph: null, vram_gb: null, available: false };
      const ram = best.gpu_ram;
      return {
        name,
        dph: best.dph_total,
        vram_gb: typeof ram === "number" && Number.isFinite(ram) && ram > 0 ? Math.round(ram / MB_PER_GIB) : null,
        available: true,
      };
    });
  }

  /**
   * Cheapest matching offer and its upper-bound cost; read-only (for the confirmation dialog).
   * `gpu` restricts the search to that allowed model; without it every allowed model counts.
   */
  async estimate(gpu?: string): Promise<CostEstimate> {
    const offer = (await this.offersFor(this.modelsFor(gpu)))[0];
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
  start(gpu?: string): Promise<StartResult> {
    // Validate the model before sharing an attempt or writing anything.
    let models: string[];
    try {
      models = this.modelsFor(gpu);
    } catch (err) {
      return Promise.reject(err);
    }
    if (this.starting) return this.starting;
    const run = this.exclusive(() => this.doStart(models));
    this.starting = run;
    const clear = (): void => {
      if (this.starting === run) this.starting = null;
    };
    run.then(clear, clear);
    return run;
  }

  private async doStart(models: readonly string[]): Promise<StartResult> {
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

    // Until create is called nothing exists on Vast: every failure marks the record gone.
    const failBeforeCreate = async (err: unknown, reason: StartFailReason): Promise<never> => {
      await registry.markGone(record.tailnet_hostname);
      if (err instanceof NoOffersError) throw err;
      throw new StartError(this.scrub(`start failed before create: ${message(err)}`), false, reason);
    };

    let authKey = "";
    try {
      authKey = await this.deps.tsAuthKey();
    } catch {
      // Fixed text: a read error may name the file or, from a broken reader, echo its content.
      return failBeforeCreate(new Error("the Tailscale auth key could not be read"), "ts_key_missing");
    }
    this.secrets.add(authKey);
    if (authKey === "") return failBeforeCreate(new Error("the Tailscale auth key is empty"), "ts_key_missing");

    let filters: OfferFilters;
    try {
      filters = this.baseFilters();
    } catch (err) {
      return failBeforeCreate(err, "config_invalid");
    }

    let offer: Offer | undefined;
    try {
      offer = (await this.offersFor(models, filters))[0];
    } catch (err) {
      return failBeforeCreate(err, "vast_unavailable");
    }
    if (offer === undefined) return failBeforeCreate(new NoOffersError(), "vast_unavailable");

    let request: CreateRequest;
    try {
      request = {
        image: strCfg(this.cfg, "vastImage", "VAST_IMAGE"),
        disk: intCfg(this.cfg, "vastDiskGb", "VAST_DISK_GB", 1),
        env: this.buildEnv(hostname, token, authKey),
        onstart: ONSTART_CMD,
        label: `${LABEL_PREFIX}${LABEL_SEPARATOR}${hostname}`,
      };
    } catch (err) {
      return failBeforeCreate(err, "config_invalid");
    }
    this.startedGpu = { hostname, gpu_name: typeof offer.gpu_name === "string" ? offer.gpu_name : null };

    let created: { id: number };
    try {
      created = await vast.createInstance(offer.id, request);
    } catch (err) {
      if (err instanceof CreateRejected) {
        await registry.markGone(record.tailnet_hostname);
        throw new StartError(this.scrub(`Vast refused to create the instance: ${err.message}`), false, "vast_rejected");
      }
      // Ambiguous: the instance may exist. Keep the record `creating` (blocks another start)
      // so reconcile can link it by label or mark it gone after the grace period.
      throw new StartError(
        this.scrub(`instance creation is uncertain; reconcile will resolve it: ${message(err)}`),
        true,
        "create_uncertain",
      );
    }

    try {
      const updated = await registry.update(record.tailnet_hostname, {
        status: "booting",
        vast_instance_id: created.id,
        // Vast's own start timestamp only; reconcile fills it in from the instance list.
        vast_start_date: null,
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
        "registry_failed",
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
          // Vast does not list it (yet). Keep the record and remember the request: reconcile
          // destroys the instance as soon as it links it by label.
          this.destroyRequested.add(record.tailnet_hostname);
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
      if (!isProjectLabel(inst.label)) throw new RefusedError(`instance ${vastId} does not carry the project label`);
      const active = await this.deps.registry.active();
      if (
        active !== null &&
        (active.vast_instance_id === vastId || labelHostname(inst.label) === active.tailnet_hostname)
      ) {
        throw new RefusedError(`instance ${vastId} belongs to the active record; use destroy()`);
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
        agent = this.scrubStatus(await this.deps.agentFor(record).status());
      } catch (err) {
        agentError = this.scrub(message(err));
        agent = null;
      }
    }

    const dph = inst ? inst.dph_total : null;
    // Vast's start_date when known; otherwise the recorded start or created_at, which is never
    // later than the true start, so the hard cap and cost err on the safe side.
    const startedAt =
      inst && record !== null ? (inst.start_date > 0 ? inst.start_date : (record.vast_start_date ?? record.created_at)) : null;
    let uptime: number | null = null;
    if (startedAt !== null) uptime = Math.max(0, now - startedAt);
    else if (agent?.uptime_s != null) uptime = agent.uptime_s;
    const cost = dph !== null && uptime !== null ? (dph * uptime) / SECONDS_PER_HOUR : null;

    const left = (at: number | null | undefined): number | null => (at == null ? null : Math.max(0, at - now));
    let hardCapAt: number | null = agent?.hard_cap_at ?? null;
    if (startedAt !== null) {
      const byVast = startedAt + intCfg(this.cfg, "startHardCapHours", "START_HARD_CAP_HOURS", 1) * SECONDS_PER_HOUR;
      hardCapAt = hardCapAt === null ? byVast : Math.min(hardCapAt, byVast);
    }

    let state: string;
    if (record === null) state = "none";
    else if (record.status === "creating") state = "creating";
    else if (record.status === "stopping") state = "stopping";
    else if (agent?.state) state = agent.state;
    else state = record.status;

    const destroyFailed =
      record !== null && this.lastDestroyError?.hostname === record.tailnet_hostname
        ? { error: this.lastDestroyError.error }
        : agent?.state === "destroy_failed"
          ? { error: agent.destroy.last_error ?? "destroy failed on the instance" }
          : null;

    const rowGpu = inst !== undefined && typeof inst["gpu_name"] === "string" ? inst["gpu_name"] : null;
    const startGpu =
      record !== null && this.startedGpu?.hostname === record.tailnet_hostname ? this.startedGpu.gpu_name : null;
    const progress = agent?.progress ?? null;

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
      progress,
      gpu_name: record === null ? null : (rowGpu ?? startGpu),
      download: overallDownload(state, progress, this.deps.profileModels ?? []),
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
        if (this.destroyRequested.has(hostname)) {
          // The user asked to destroy it while Vast did not list it yet: do it now.
          this.destroyRequested.delete(hostname);
          try {
            const result = await this.destroyRecord(record, match.id, "manual");
            report.destroyed.push({
              tailnet_hostname: hostname,
              vast_instance_id: match.id,
              reason: "destroy_requested",
              outcome: result.outcome as DestroyOutcome,
            });
          } catch (err) {
            report.destroy_failed.push({
              tailnet_hostname: hostname,
              vast_instance_id: match.id,
              reason: "destroy_requested",
              error: this.scrub(message(err)),
            });
          }
          report.unknown = instances
            .filter((i) => isProjectLabel(i.label) && i.id !== match.id)
            .map(unknownOf);
          return report;
        }
      } else if (now - record.created_at >= grace) {
        this.destroyRequested.delete(hostname);
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

    // 3. The record's instance vanished from Vast: gone only after the grace period AND two
    // consecutive successful lists without it (one list may be stale or partial; a failed list
    // returned early above and never counts). A reappearance resets the counter.
    if (inst === undefined) {
      if (now - record.created_at >= grace) {
        const misses = (this.vanishMisses.get(hostname) ?? 0) + 1;
        if (misses >= VANISH_CONFIRMATIONS) {
          this.vanishMisses.delete(hostname);
          await registry.markGone(hostname);
          report.gone.push({ tailnet_hostname: hostname, reason: "vanished" });
        } else {
          this.vanishMisses.set(hostname, misses);
        }
      }
      return report;
    }
    this.vanishMisses.delete(hostname);

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
    if (agent !== null && READY_STATES.has(agent.state ?? "") && record.status === "booting") {
      patch.status = "ready";
      report.ready.push(hostname);
    }
    // Spec 7: the unreachable time counts only while Vast says running.
    const unreachableNow = agent === null && inst.actual_status === "running";
    if (unreachableNow) {
      if (record.unreachable_since == null) patch.unreachable_since = now;
    } else if (record.unreachable_since != null) {
      patch.unreachable_since = null;
    }
    if (inst.start_date > 0 && record.vast_start_date !== inst.start_date) patch.vast_start_date = inst.start_date;
    if (Object.keys(patch).length > 0) record = await registry.update(hostname, patch);
    report.unreachable_since = record.unreachable_since ?? null;
    // Vast's start_date when listed; otherwise the recorded start or created_at (never later
    // than the true start), so a missing start_date never switches the hard cap off.
    const startedAt = inst.start_date > 0 ? inst.start_date : (record.vast_start_date ?? record.created_at);

    // 5. Enforcement.
    let reason: string | null = null;
    if (record.status === "stopping") reason = "destroy_retry";
    else if (now - startedAt >= hardCap) reason = "hard_cap";
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
