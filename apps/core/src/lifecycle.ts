import { camelCase, type AppsConfig } from "./config.js";
import type { AgentStatus, VideoFamilyStatus, VideoModelsStatus } from "./agent.js";
import type { ModelSpec } from "./profile.js";
import { AlreadyActiveError, type InstanceRecord, type Registry } from "./registry.js";
import { TailscaleError, type TailscaleErrorCode } from "./tailscale.js";
import { BAD_MACHINE_CODES, measuredMbS, type StopReason, type StuckCode, type StuckStart, type UsageHistory, type UsageItem } from "./usage.js";
import {
  ConsoleBuffer,
  logLines,
  type ConsoleEndReason,
  type ConsoleLimits,
  type ConsoleLine,
  type ConsoleStoreLike,
  type PhaseInfo,
} from "./console.js";
import { filterAndSortOffers, parseStartFilters, publicOffer, type PublicOffer, type StartFilters } from "./offer-choice.js";
import {
  CreateRejected,
  DestroyError,
  MB_PER_GB,
  normalizeGpuName,
  offerFiltersFromConfig,
  serverInfo,
  type CreateRequest,
  type DestroyOutcome,
  type Offer,
  type OfferFilters,
  type ServerInfo,
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
// Vast counts disk in decimal gigabytes.
const BYTES_PER_GB = 1_000_000_000;
const VANISH_CONFIRMATIONS = 2; // consecutive lists without the instance before it counts as gone
const MB_PER_GIB = 1024; // Vast reports gpu_ram in MiB; shown as whole GiB (24564 -> 24)
const DOWNLOAD_STATE = "downloading";
const MODELS_PHASE = "models";
const VAST_LOADING = "loading";
const VAST_RUNNING = "running";
// Vast statuses of a container that is not running. "loading" (image pull) is progress and only
// meets the boot timeout; "created" is also the normal moment between the pull and the start, so
// it counts only together with a stopped intent or state.
const VAST_CREATED = "created";
const VAST_HALTED = new Set(["exited", "stopped"]);
const VAST_STOPPED = "stopped";
const STATUS_WORD = /^[a-z_]{1,32}$/; // a Vast status fit for a log line
// A stuck start is released only when it held on this many consecutive successful reconciles,
// the first and the last at least STUCK_DWELL_S apart: one Vast sample is never enough.
const STUCK_CONFIRMATIONS = 2;
const STUCK_DWELL_S = 60;
const STUCK_MEMORY_MAX = 16; // stuck starts kept in memory (the usage file keeps as many)
// A slow boot (agent silent, download too slow) is released under the same discipline as a stuck
// start: STUCK_CONFIRMATIONS consecutive samples, the first and the last STUCK_DWELL_S apart.
const BYTES_PER_MB = 1_000_000; // MB/s as people (and curl, and the page) count it
// What the instance's early network probe (instance/bootstrap.sh) prints into the container log
// when it gives up: the web shows it as slow_download (display only; never a release decision).
const INSTANCE_SLOW_NETWORK = "slow_network";
// A download is also too slow when it would end after BOOT_TIMEOUT_MIN: the elapsed boot, the time
// left at the measured speed and this much for the rest of the boot (workflows, ComfyUI restart).
const AFTER_DOWNLOAD_S = 120;
// Failure codes (instance boot marker or agent reason) that blame the rented machine itself when its
// boot vanished: its network to the model host or its disk. Every other code (Tailscale or key
// problems, download_failed which is mostly Hugging Face answering 401/403/5xx, git, node and ComfyUI
// failures, config, the generic boot_failed) is service-wide or a code problem and blames nothing.
// No code at all (the instance vanished without a word) blames the machine.
const MACHINE_FAILURE_CODES: ReadonlySet<string> = new Set([INSTANCE_SLOW_NETWORK, "disk_insufficient"]);
const AGENT_FAILURE_STATES: ReadonlySet<string> = new Set(["failed", "stopping", "destroy_failed"]);
const PERCENT = 100;
const PERCENT_STEP = 10; // agent progress lines change in steps of 10 %, not on every poll
const HOST_PLACEHOLDER = "[host]";
// Usage stop reason per web-side enforcement reason; destroy_retry keeps the reason recorded when
// the stop began (a later end without one is inferred).
const WATCHDOG_STOPS: Readonly<Record<string, { reason: StopReason }>> = {
  hard_cap: { reason: "hard_cap" },
  boot_timeout: { reason: "boot_failed" },
  start_stuck: { reason: "boot_failed" },
  boot_stopped: { reason: "boot_failed" },
  slow_boot: { reason: "boot_failed" },
  slow_download: { reason: "boot_failed" },
  unreachable: { reason: "agent_unreachable" },
};

/** The offer an admin picked is no longer available (or no longer passes the filters). Nothing was rented. */
export class OfferGoneError extends Error {
  constructor() {
    super("the chosen Vast offer is no longer available");
    this.name = "OfferGoneError";
  }
}

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
 * ts_key_missing: the Tailscale key file is unreadable or empty; ts_key_mint_failed: the Tailscale
 * OAuth client could not mint a key (or OAuth is half-configured); vast_unavailable: the offer
 * search failed; config_invalid: a start setting is missing; vast_rejected: Vast definitely
 * refused the create; create_uncertain: the create may or may not have happened;
 * registry_failed: the instance was created but could not be recorded.
 */
export type StartFailReason =
  | "ts_key_missing"
  | "ts_key_mint_failed"
  | "vast_unavailable"
  | "config_invalid"
  | "vast_rejected"
  | "create_uncertain"
  | "registry_failed"
  | "unexpected";

/**
 * The sub-cause of a start failure, as a fixed identifier (never provider text). Only
 * ts_key_mint_failed has one today: the TailscaleError code (tailscale_unavailable: the Tailscale
 * API could not be reached; oauth_failed: the OAuth client was refused or OAuth is half-configured;
 * key_rejected: Tailscale refused to create the key; invalid_response: an unusable answer).
 */
export type StartFailDetail = TailscaleErrorCode;

/** Start failed after the write-ahead record; `ambiguous` means the instance may exist on Vast. */
export class StartError extends Error {
  readonly ambiguous: boolean;
  readonly reason: StartFailReason;
  readonly detail: StartFailDetail | null;
  constructor(message: string, ambiguous: boolean, reason: StartFailReason = "unexpected", detail: StartFailDetail | null = null) {
    super(message);
    this.name = "StartError";
    this.ambiguous = ambiguous;
    this.reason = reason;
    this.detail = detail;
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
  startVideoModels?(url?: string): Promise<VideoModelsStatus>;
  startVideoFamily?(family: string, opts?: { mode?: "text" | "image"; links?: Record<string, string> }): Promise<VideoFamilyStatus>;
  destroy(reason: "manual" | "watchdog"): Promise<void>;
}

export interface VastLike {
  searchOffers(filters: OfferFilters): Promise<Offer[]>;
  createInstance(offerId: number, req: CreateRequest): Promise<{ id: number }>;
  listInstances(): Promise<VastInstance[]>;
  destroyInstance(id: number): Promise<DestroyOutcome>;
  /** Container log tail (VastClient.instanceLogs); without it the console shows no container logs. */
  instanceLogs?(id: number, tail: number): Promise<string>;
}

/** Why a start failed after Start returned, as a fixed code (GET /api/state start_failure). */
export type StartFailureCode = StuckCode;

export interface LifecycleDeps {
  cfg: AppsConfig;
  vast: VastLike;
  registry: Registry;
  agentFor(record: InstanceRecord): AgentLike;
  /** Epoch UTC seconds. */
  clock(): number;
  /** The auth key for the new instance; may reject with TailscaleError when minted through OAuth. */
  tsAuthKey(): Promise<string>;
  newToken(): string;
  newHostname(): string;
  /** Waits between destroy attempts; defaults to a real timer. */
  sleep?(seconds: number): Promise<void>;
  /** The profile's model files in download order, for the overall download progress. */
  profileModels?: readonly ModelSpec[];
  /**
   * The plain file names of the profile's video model files (empty without enabled video). A boot that does not
   * include video (the agent's video_models.boot) does not download them, so the overall progress leaves them out.
   */
  videoModelFiles?: readonly string[];
  /**
   * The plain file names of every video family of the profile by id (the base section's too). A boot downloads only
   * the families the agent marks `boot` (video_families), so the overall progress and the disk count only those.
   */
  videoFamilyFiles?: Readonly<Record<string, readonly string[]>>;
  /** Where the boot console persists (BOOT_LOG_PATH); without it the console lives in memory only. */
  consoleStore?: ConsoleStoreLike;
  /** The usage history (USAGE_LOG_PATH); without it nothing is recorded and history() is empty. */
  usage?: UsageHistory;
  /** Operational log lines (fixed text plus ids; never a hostname, token or key). */
  log?(level: "info" | "warn" | "error", message: string): void;
}

/** GET /api/console: the boot console after `after`. Every text is masked; no hostname or token. */
export interface ConsolePayload {
  /** Changes when a new Start clears the console (the page then drops its lines). */
  generation: number;
  instance: { state: string; ended: boolean; ended_reason: string | null };
  phases: PhaseInfo[];
  lines: ConsoleLine[];
  last_seq: number;
  truncated: boolean;
  /** The last Vast read for the console failed; the lines shown are the ones kept so far. */
  source_error: "vast_logs_unavailable" | null;
}

/** A registry record as it may leave this module: never the agent token. */
export type PublicRecord = Omit<InstanceRecord, "agent_token">;

export interface CostEstimate {
  offer_id: number;
  gpu_name: string | null;
  dph: number;
  horizon_hours: number;
  max_cost: number;
  /** Where the offer's server is and its download speed (Mbps), when Vast says. */
  location: string | null;
  down_mbps: number | null;
}

/** One selectable GPU model with its cheapest current offer (no offer id leaves the server). */
export interface GpuOption {
  name: string;
  dph: number | null;
  vram_gb: number | null;
  available: boolean;
  /** Location and download speed (Mbps) of that cheapest offer's server. */
  location: string | null;
  down_mbps: number | null;
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
  /** The newest start failed after Start returned (e.g. it was released as stuck); cleared by the next Start. */
  start_failure: { code: StartFailureCode; server: ServerInfo | null; measured_mb_s: number | null } | null;
  /** Where the active instance's server is: Vast's row, else the offer chosen at start (per field). */
  server: ServerInfo | null;
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

const NO_SERVER: ServerInfo = { location: null, down_mbps: null, up_mbps: null, reliability: null, machine_id: null };

/** Each field from `first` when known, else from `second`; null when nothing is known. */
function mergeServer(first: ServerInfo, second: ServerInfo): ServerInfo | null {
  const out: ServerInfo = {
    location: first.location ?? second.location,
    down_mbps: first.down_mbps ?? second.down_mbps,
    up_mbps: first.up_mbps ?? second.up_mbps,
    reliability: first.reliability ?? second.reliability,
    machine_id: first.machine_id ?? second.machine_id,
  };
  return Object.values(out).every((v) => v === null) ? null : out;
}

function positiveId(raw: unknown): number | null {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? raw : null;
}

/**
 * One Vast sample of a booting instance whose container does not run, or null:
 * - start_stuck: it never started (last_started null) and is exited/stopped, created with a stopped
 *   intent or state, or meant to be stopped without a status (the live case of 2026-10-19);
 * - boot_stopped: the same states after the container had started once (the boot stopped).
 * Running (agent not up yet), loading (image pull) and created with a running intent are not stuck.
 */
export function stuckKind(inst: VastInstance): StuckCode | null {
  const actual = inst.actual_status;
  if (actual === VAST_RUNNING || actual === VAST_LOADING) return null;
  const stoppedIntent = inst.intended_status === VAST_STOPPED || inst["cur_state"] === VAST_STOPPED;
  const neverStarted = (inst["last_started"] ?? null) === null;
  let stuck: boolean;
  if (actual === VAST_CREATED) stuck = stoppedIntent;
  else if (actual !== null && VAST_HALTED.has(actual)) stuck = true;
  else stuck = inst.intended_status === VAST_STOPPED && neverStarted;
  if (!stuck) return null;
  return neverStarted ? "start_stuck" : "boot_stopped";
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

/** One console line summarising the agent's /status (progress in steps of PERCENT_STEP). */
function agentLine(a: AgentStatus): string {
  const parts = [`agent: state=${a.state ?? "unknown"}`];
  if (a.reason) parts.push(`reason=${a.reason}`);
  const p = a.progress;
  if (p !== null) {
    parts.push(`phase=${p.phase}`);
    if (typeof p.file === "string" && p.file !== "") parts.push(`file=${baseName(p.file)}`);
    if (typeof p.bytes_total === "number" && p.bytes_total > 0 && Number.isFinite(p.bytes_done)) {
      const ratio = Math.min(1, Math.max(0, p.bytes_done / p.bytes_total));
      parts.push(`${Math.floor((ratio * PERCENT) / PERCENT_STEP) * PERCENT_STEP}%`);
    }
  }
  return parts.join(" ");
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
  // GPU model and machine of the offer the last start chose, until Vast's own row names them.
  private startedGpu: { hostname: string; gpu_name: string | null; server: ServerInfo } | null = null;
  // Stuck starts released by this process; the usage file keeps them too (survives a restart).
  // The registry file is never given these facts: an older web refuses unknown registry keys.
  private readonly memoryStuck: StuckStart[] = [];
  // The current stuck sighting: which instance, since when, how many consecutive reconciles.
  // In memory only: after a restart it starts over, which only delays a release (the safe side).
  private stuckSeen: { hostname: string; id: number; since: number; count: number } | null = null;
  // Slow boot sightings, in memory only like stuckSeen (a restart starts them over: it only delays).
  // silentSeen: Vast says running and the agent never answered. downloadSeen: the window the
  // download speed is measured over (first sample) and the run of consecutive too-slow samples.
  private silentSeen: { hostname: string; id: number; since: number; count: number } | null = null;
  private downloadSeen: {
    hostname: string;
    id: number;
    firstAt: number;
    firstBytes: number;
    lastBytes: number;
    slowSince: number | null;
    count: number;
  } | null = null;
  // The reason the agent of the active record gave when it was last seen failing (in memory; the
  // usage file keeps the last sighting for after a restart).
  private lastAgentFailure: { hostname: string; reason: string | null } | null = null;
  // The last hostname whose agent answered (one instance is active at a time).
  private agentAnsweredHost: string | null = null;
  // Where the active record's server is, from the last Vast row seen: an instance that vanished is no
  // longer listed, so its machine must be known from before.
  private lastServer: { hostname: string; server: ServerInfo } | null = null;
  // Boot console: the buffer (created on first use), when an admin last called console(), when
  // Vast was last read for it, the outcome of that read and the read in flight (single-flight).
  private consoleBuf: ConsoleBuffer | null = null;
  private consoleWatchedAt: number | null = null;
  private consolePolledAt: number | null = null;
  private consoleError: ConsolePayload["source_error"] = null;
  private consoleRefresh: Promise<void> | null = null;

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
    const server = serverInfo(offer);
    return {
      offer_id: offer.id,
      gpu_name: typeof offer.gpu_name === "string" ? offer.gpu_name : null,
      dph: offer.dph_total,
      horizon_hours: horizon,
      max_cost: offer.dph_total * horizon,
      location: server.location,
      down_mbps: server.down_mbps,
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

  /** The configured offer filters (throws VastError on a bad VAST_* value), with the disk this start needs. */
  private baseFilters(choice: StartFilters): OfferFilters {
    const base = offerFiltersFromConfig(this.cfg);
    return { ...base, diskGb: this.diskFor(choice) };
  }

  /**
   * The disk to rent: VAST_DISK_GB, or for a boot that includes the video model files at least VAST_VIDEO_DISK_GB
   * (read only then). An image-only start rents, searches and pays exactly as before.
   */
  private diskFor(choice: StartFilters): number {
    const disk = intCfg(this.cfg, "vastDiskGb", "VAST_DISK_GB", 1);
    if (choice.videoModels !== true) return disk;
    const video = Math.max(disk, intCfg(this.cfg, "vastVideoDiskGb", "VAST_VIDEO_DISK_GB", 1));
    // Chosen families: their pinned files (a shared file once) on top of the image disk, never below the video disk.
    const families = choice.videoFamilies ?? [];
    if (families.length === 0) return video;
    const names = new Set(families.flatMap((id) => this.deps.videoFamilyFiles?.[id] ?? []));
    const bytes = (this.deps.profileModels ?? []).filter((m) => names.has(baseName(m.file))).reduce((sum, m) => sum + m.size_bytes, 0);
    return Math.max(video, disk + Math.ceil(bytes / BYTES_PER_GB));
  }

  /** VIDEO_FAMILIES of this web app for the instance (nothing when it lists none). */
  private familiesEnv(): Record<string, string> {
    const v = this.cfg["videoFamilies"];
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) return {};
    if (!Array.isArray(v) || !v.every((id) => typeof id === "string" && /^[a-z][a-z0-9_]{0,31}$/.test(id))) {
      throw new Error("VIDEO_FAMILIES must list video family ids");
    }
    return { VIDEO_FAMILIES: v.join(",") };
  }

  /** VIDEO_MODEL_LINK_* of this web app for the instance (its own checks of a link use them). */
  private linkRules(): Record<string, string> {
    const list = (key: string, env: string): string => {
      const v = this.cfg[key];
      if (!Array.isArray(v) || v.length === 0 || !v.every((h) => typeof h === "string" && /^[a-z0-9.-]{1,253}$/.test(h))) {
        throw new Error(`${env} must list one or more host names`);
      }
      return v.join(",");
    };
    return {
      VIDEO_MODEL_LINK_HOSTS: list("videoModelLinkHosts", "VIDEO_MODEL_LINK_HOSTS"),
      VIDEO_MODEL_LINK_REDIRECT_DOMAINS: list("videoModelLinkRedirectDomains", "VIDEO_MODEL_LINK_REDIRECT_DOMAINS"),
      VIDEO_MODEL_LINK_MAX_BYTES: String(intCfg(this.cfg, "videoModelLinkMaxBytes", "VIDEO_MODEL_LINK_MAX_BYTES", 1)),
    };
  }

  /** The models this boot downloads, in order: every profile model, minus the video files unless it includes them. */
  private bootModels(agent: AgentStatus | null): readonly ModelSpec[] {
    const all = this.deps.profileModels ?? [];
    const byFamily = this.deps.videoFamilyFiles ?? {};
    const video = new Set([...(this.deps.videoModelFiles ?? []), ...Object.values(byFamily).flat()]);
    if (video.size === 0) return all;
    // The agent says which families this boot downloads (video_families), else whether it includes the base one.
    const keep = new Set(
      Array.isArray(agent?.video_families)
        ? agent.video_families.filter((f) => f.boot === true).flatMap((f) => byFamily[f.id] ?? [])
        : agent?.video_models?.boot === true
          ? (this.deps.videoModelFiles ?? [])
          : [],
    );
    return all.filter((m) => !video.has(baseName(m.file)) || keep.has(baseName(m.file)));
  }

  /**
   * One Vast search over `models`. Whatever Vast returns, an offer is kept only when it is one
   * of these models, has a finite positive price within VAST_MAX_DPH and reports at least
   * VAST_MIN_VRAM_GB (same MB unit as the query); a missing price or VRAM drops it.
   */
  private async offersFor(
    models: readonly string[],
    base: OfferFilters = this.baseFilters({}),
    avoid: ReadonlySet<number> = new Set(),
    choice: StartFilters = {},
  ): Promise<Offer[]> {
    const filters: OfferFilters = { ...base, allowedGpus: models };
    const minRamMb = filters.minVramGb * MB_PER_GB;
    const offers = await this.deps.vast.searchOffers(filters);
    const matching = offers
      .filter((o) => {
        const machine = positiveId(o["machine_id"]);
        return machine === null || !avoid.has(machine);
      })
      // VAST_MIN_DOWNLOAD_MBPS is in the query too; a reported speed below it is dropped here
      // (an offer without a speed is kept: the query already asked Vast for the minimum).
      .filter((o) => {
        const down = serverInfo(o).down_mbps;
        return down === null || down >= filters.minDownloadMbps;
      })
      .filter((o) => typeof o.gpu_name === "string" && models.includes(normalizeGpuName(o.gpu_name)))
      .filter((o) => typeof o.dph_total === "number" && Number.isFinite(o.dph_total) && o.dph_total > 0)
      .filter((o) => o.dph_total <= filters.maxDph)
      .filter((o) => typeof o.gpu_ram === "number" && Number.isFinite(o.gpu_ram) && o.gpu_ram >= minRamMb);
    // The admin's own region/price/speed filters and sort come after every configured limit: they only narrow.
    return filterAndSortOffers(matching, choice);
  }

  /** Check the filter members of a request against the configured limits (a request can only narrow them). */
  parseFilters(raw: unknown): StartFilters {
    return parseStartFilters(raw, { maxDph: this.baseFilters({}).maxDph });
  }

  /** The offer an explicit choice names, else the first of the filtered order; NoOffers/OfferGone when none. */
  private pickOffer(list: readonly Offer[], choice: StartFilters): Offer {
    if (choice.offerId !== undefined) {
      const found = list.find((o) => o.id === choice.offerId);
      if (found === undefined) throw new OfferGoneError();
      return found;
    }
    const first = list[0];
    if (first === undefined) throw new NoOffersError();
    return first;
  }

  /** The best offers now (after the configured limits, the bad-machine list and the filters), for the dialog. */
  async offers(gpu?: string, choice: StartFilters = {}): Promise<PublicOffer[]> {
    const models = this.modelsFor(gpu);
    const list = await this.offersFor(models, this.baseFilters(choice), await this.badMachines(), choice);
    return list.slice(0, intCfg(this.cfg, "startOfferListMax", "START_OFFER_LIST_MAX", 1)).map(publicOffer);
  }

  private badMachineTtl(): number {
    return intCfg(this.cfg, "vastBadMachineTtlMin", "VAST_BAD_MACHINE_TTL_MIN", 1) * SECONDS_PER_MINUTE;
  }

  /** The stuck starts known: the usage file's (kept across restarts), else this process's own. */
  private stuckStarts(): readonly StuckStart[] {
    try {
      return this.deps.usage?.stuckStarts() ?? this.memoryStuck;
    } catch {
      return this.memoryStuck;
    }
  }

  /** Machines a Start must not rent: those of a stuck start within VAST_BAD_MACHINE_TTL_MIN. */
  private async badMachines(): Promise<Set<number>> {
    const ttl = this.badMachineTtl();
    const now = this.now();
    const out = new Set<number>();
    for (const r of this.stuckStarts()) {
      if (r.machine_id !== null && now - r.at < ttl) out.add(r.machine_id);
    }
    return out;
  }

  /** Every allowed model in config order with its cheapest matching offer (one Vast search). */
  async gpuOptions(choice: StartFilters = {}): Promise<GpuOption[]> {
    const models = this.allowedModels();
    const offers = await this.offersFor(models, this.baseFilters(choice), await this.badMachines(), choice);
    return models.map((name) => {
      const best = offers.find((o) => normalizeGpuName(o.gpu_name as string) === name);
      if (best === undefined) return { name, dph: null, vram_gb: null, available: false, location: null, down_mbps: null };
      const ram = best.gpu_ram;
      const server = serverInfo(best);
      return {
        name,
        dph: best.dph_total,
        vram_gb: typeof ram === "number" && Number.isFinite(ram) && ram > 0 ? Math.round(ram / MB_PER_GIB) : null,
        available: true,
        location: server.location,
        down_mbps: server.down_mbps,
      };
    });
  }

  /**
   * Cheapest matching offer and its upper-bound cost; read-only (for the confirmation dialog).
   * `gpu` restricts the search to that allowed model; without it every allowed model counts.
   */
  async estimate(gpu?: string, choice: StartFilters = {}): Promise<CostEstimate> {
    const models = this.modelsFor(gpu);
    const list = await this.offersFor(models, this.baseFilters(choice), await this.badMachines(), choice);
    return this.estimateFor(this.pickOffer(list, choice));
  }

  private buildEnv(hostname: string, token: string, authKey: string, choice: StartFilters = {}): Record<string, string> {
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
      // The early network probe of instance/bootstrap.sh (read before the instance schema can be read).
      NET_PROBE_BYTES: String(intCfg(cfg, "netProbeBytes", "NET_PROBE_BYTES", 1048576)),
      NET_PROBE_MIN_MBPS: String(intCfg(cfg, "netProbeMinMbps", "NET_PROBE_MIN_MBPS", 0)),
      // Parallel ranged connections per model file (instance/agent/vastcomfy_agent/ranged.py).
      DOWNLOAD_CONNECTIONS: String(intCfg(cfg, "downloadConnections", "DOWNLOAD_CONNECTIONS", 1)),
      // The instance writes it into ComfyUI's arguments before its own ComfyUI restart (instance/bootstrap.sh).
      ...(typeof cfg["comfyPreviewMethod"] === "string" && cfg["comfyPreviewMethod"] !== ""
        ? { COMFY_PREVIEW_METHOD: cfg["comfyPreviewMethod"] }
        : {}),
      // Only when asked (Start dialog "Include video models"): without it the instance boots image-only (default).
      ...(choice.videoModels === true ? { INCLUDE_VIDEO_MODELS: "true" } : {}),
      // The families this boot downloads (checked by the route against the enabled ones); none: the base section.
      ...(choice.videoModels === true && (choice.videoFamilies ?? []).length > 0 ? { VIDEO_BOOT_FAMILIES: choice.videoFamilies!.join(",") } : {}),
      // A link that replaces the pinned diffusion model (already checked by the route; the instance checks again).
      ...(choice.videoModels === true && choice.videoModelUrl !== undefined ? { VIDEO_MODEL_URL: choice.videoModelUrl } : {}),
      // Video on (VIDEO_ENABLED): the instance gets the switch and the link rules, so an on-demand link is checked the
      // same way. Off: nothing is sent and an image-only instance env is unchanged.
      ...(cfg["videoEnabled"] === true ? { VIDEO_ENABLED: "true", ...this.linkRules(), ...this.familiesEnv() } : {}),
    };
  }

  /**
   * Create the instance. Single-flight: concurrent calls share one attempt. The registry record
   * (`creating`) is written before any Vast call. A definite failure marks it gone; an ambiguous
   * create failure leaves it `creating` for reconcile to resolve by its label.
   */
  start(gpu?: string, by?: string | null, choice: StartFilters = {}): Promise<StartResult> {
    // Validate the model before sharing an attempt or writing anything.
    let models: string[];
    try {
      models = this.modelsFor(gpu);
    } catch (err) {
      return Promise.reject(err);
    }
    if (this.starting) return this.starting;
    const run = this.exclusive(() => this.doStart(models, by ?? null, choice));
    this.starting = run;
    const clear = (): void => {
      if (this.starting === run) this.starting = null;
    };
    run.then(clear, clear);
    return run;
  }

  private async doStart(models: readonly string[], by: string | null, choice: StartFilters): Promise<StartResult> {
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
    // A new Start clears the console of the previous instance.
    this.withConsole((buf) => buf.reset(hostname));
    this.withUsage((u) => u.begin(hostname, record.created_at, by));

    // Until create is called nothing exists on Vast: every failure marks the record gone.
    const failBeforeCreate = async (err: unknown, reason: StartFailReason, detail: StartFailDetail | null = null): Promise<never> => {
      this.withUsage((u) => u.requestStop(hostname, "boot_failed"));
      await registry.markGone(record.tailnet_hostname);
      this.endUsage(hostname);
      this.endConsole(record.tailnet_hostname, "start_failed");
      if (err instanceof NoOffersError || err instanceof OfferGoneError) throw err;
      throw new StartError(this.scrub(`start failed before create: ${message(err)}`), false, reason, detail);
    };

    let authKey = "";
    try {
      authKey = await this.deps.tsAuthKey();
    } catch (err) {
      // Fixed text: a read error may name the file or, from a broken reader, echo its content.
      // A TailscaleError carries only a fixed code. Never a fallback to another key source.
      if (err instanceof TailscaleError) {
        return failBeforeCreate(new Error(`the Tailscale auth key could not be minted (${err.code})`), "ts_key_mint_failed", err.code);
      }
      return failBeforeCreate(new Error("the Tailscale auth key could not be read"), "ts_key_missing");
    }
    this.secrets.add(authKey);
    if (authKey === "") return failBeforeCreate(new Error("the Tailscale auth key is empty"), "ts_key_missing");

    let filters: OfferFilters;
    let avoid: Set<number>;
    try {
      filters = this.baseFilters(choice);
      avoid = await this.badMachines();
    } catch (err) {
      return failBeforeCreate(err, "config_invalid");
    }

    let offer: Offer;
    try {
      offer = this.pickOffer(await this.offersFor(models, filters, avoid, choice), choice);
    } catch (err) {
      return failBeforeCreate(err, "vast_unavailable");
    }

    let request: CreateRequest;
    try {
      request = {
        image: strCfg(this.cfg, "vastImage", "VAST_IMAGE"),
        disk: this.diskFor(choice),
        env: this.buildEnv(hostname, token, authKey, choice),
        onstart: ONSTART_CMD,
        label: `${LABEL_PREFIX}${LABEL_SEPARATOR}${hostname}`,
      };
    } catch (err) {
      return failBeforeCreate(err, "config_invalid");
    }
    const offerServer = serverInfo(offer);
    this.startedGpu = {
      hostname,
      gpu_name: typeof offer.gpu_name === "string" ? offer.gpu_name : null,
      server: offerServer,
    };
    this.withUsage((u) => u.noteOffer(hostname, offer.gpu_name, offer.dph_total, offerServer));

    let created: { id: number };
    try {
      created = await vast.createInstance(offer.id, request);
    } catch (err) {
      if (err instanceof CreateRejected) {
        this.withUsage((u) => u.requestStop(hostname, "boot_failed"));
        await registry.markGone(record.tailnet_hostname);
        this.endUsage(hostname);
        this.endConsole(record.tailnet_hostname, "start_failed");
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

    this.withUsage((u) => u.noteInstance(hostname, created.id));
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
      // When this destroy fails too, the record stays `creating` and reconcile later links and stops
      // the instance (boot timeout, hard cap or the Destroy button): the history still says
      // boot_failed, as the first stop request wins (rare; accepted).
      this.withUsage((u) => u.requestStop(hostname, "boot_failed"));
      const outcome = await this.vastDestroy(created.id).catch(() => null);
      if (outcome !== null) {
        await registry.markGone(record.tailnet_hostname).catch(() => undefined);
        this.endUsage(hostname);
        this.endConsole(record.tailnet_hostname, "start_failed");
      }
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
    stop: { reason: StopReason; by?: string | null } | null,
  ): Promise<DestroyResult> {
    const { registry } = this.deps;
    this.secrets.add(record.agent_token);
    // The reason is written before anything changes, so whoever notices the end agrees on it.
    if (stop !== null) this.withUsage((u) => u.requestStop(record.tailnet_hostname, stop.reason, stop.by));
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
    this.endUsage(record.tailnet_hostname);
    if (this.lastDestroyError?.hostname === record.tailnet_hostname) this.lastDestroyError = null;
    return { outcome, agent_error: agentError };
  }

  /** Destroy the active instance (the Destroy button; `by` is the user). Idempotent: no active record -> outcome "none". */
  destroy(by?: string | null): Promise<DestroyResult> {
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
          // Persisted, while destroyRequested is not: after a web restart the boot timeout destroys
          // this instance instead, and the history still says destroy_button (rare; accepted).
          this.withUsage((u) => u.requestStop(record.tailnet_hostname, "destroy_button", by));
          return { outcome: "pending", agent_error: null };
        }
        id = match.id;
      }
      const result = await this.destroyRecord(record, id, "manual", { reason: "destroy_button", by });
      this.endConsole(record.tailnet_hostname, "destroyed");
      return result;
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

  /**
   * Ask the active instance's agent to download the video model files (admin action). Errors keep the agent's
   * status and code (AgentError); messages are scrubbed of the token and hostname.
   */
  async downloadVideoModels(url?: string): Promise<VideoModelsStatus> {
    const record = await this.deps.registry.active();
    if (record === null || record.vast_instance_id === null || record.status === "stopping") {
      throw new NoActiveInstanceError();
    }
    this.secrets.add(record.agent_token);
    const agent = this.deps.agentFor(record);
    if (typeof agent.startVideoModels !== "function") throw new NoActiveInstanceError();
    try {
      return await agent.startVideoModels(url);
    } catch (err) {
      if (err instanceof Error) err.message = this.scrub(err.message);
      throw err;
    }
  }

  /** Ask the active instance's agent to download a video family (admin action); like downloadVideoModels. */
  async downloadVideoFamily(family: string, opts: { mode?: "text" | "image"; links?: Record<string, string> } = {}): Promise<VideoFamilyStatus> {
    const record = await this.deps.registry.active();
    if (record === null || record.vast_instance_id === null || record.status === "stopping") {
      throw new NoActiveInstanceError();
    }
    this.secrets.add(record.agent_token);
    const agent = this.deps.agentFor(record);
    if (typeof agent.startVideoFamily !== "function") throw new NoActiveInstanceError();
    try {
      return await agent.startVideoFamily(family, opts);
    } catch (err) {
      if (err instanceof Error) err.message = this.scrub(err.message);
      throw err;
    }
  }

  /** Merged status of registry, Vast and agent. Never throws because one source is down. */
  async view(): Promise<StatusView> {
    const now = this.now();
    // Taken before the first await: a Start while this view is in flight must not be undone by
    // the console update at its end (see feedConsole).
    const consoleEpoch = this.consoleEpoch();
    const record = await this.deps.registry.active();
    // The newest record (the active one, else the last one written): its start may have been
    // released as stuck. A new Start writes a newer record, which clears the failure.
    const latest = record ?? (await this.deps.registry.all().then((rs) => rs.at(-1) ?? null, () => null));
    const stuck = latest === null ? undefined : this.stuckStarts().findLast((r) => r.hostname === latest.tailnet_hostname);
    const startFailure: StatusView["start_failure"] =
      stuck === undefined
        ? null
        : {
            code: stuck.code,
            server: mergeServer(
              { ...NO_SERVER, location: stuck.location, down_mbps: stuck.down_mbps, machine_id: stuck.machine_id },
              NO_SERVER,
            ),
            measured_mb_s: stuck.measured_mb_s ?? null,
          };
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
    const startServer =
      record !== null && this.startedGpu?.hostname === record.tailnet_hostname ? this.startedGpu.server : NO_SERVER;
    const server = record === null ? null : mergeServer(inst !== undefined ? serverInfo(inst) : NO_SERVER, startServer);
    this.feedConsole(consoleEpoch, record, inst, agent, instances, now);
    if (record !== null) this.noteUsage(record, inst, agent, now);
    await this.syncUsage(record, now);

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
      start_failure: startFailure,
      server,
      download: overallDownload(state, progress, this.bootModels(agent)),
      remaining: {
        idle_s: left(agent?.idle_destroy_at),
        failsafe_s: left(agent?.failsafe_at),
        hard_cap_s: left(hardCapAt),
      },
      unknown,
    };
  }

  // ---- usage history ----

  /** Run `fn` on the usage history; it never makes a lifecycle operation fail. */
  private withUsage(fn: (u: UsageHistory) => void): void {
    const usage = this.deps.usage;
    if (usage === undefined) return;
    try {
      fn(usage);
    } catch {
      // best effort
    }
  }

  private endUsage(hostname: string): void {
    this.withUsage((u) => u.end(hostname, this.now()));
  }

  /** What a status read learned about the active record's session (adopting one without an entry). */
  private noteUsage(record: InstanceRecord, inst: VastInstance | undefined, agent: AgentStatus | null, now: number): void {
    if (record.status === "gone") return;
    const hostname = record.tailnet_hostname;
    this.withUsage((u) => {
      u.adopt(hostname, record.created_at);
      if (record.vast_instance_id !== null) u.noteInstance(hostname, record.vast_instance_id);
      if (inst !== undefined) {
        u.noteDph(hostname, inst.dph_total);
        u.noteServer(hostname, serverInfo(inst));
      }
      if (agent !== null) {
        u.observe(hostname, agent, now);
        if (READY_STATES.has(agent.state ?? "")) u.noteReady(hostname, now);
      }
    });
  }

  /**
   * Close every open entry whose registry record is gone (or missing). The open entries are taken
   * BEFORE the registry is read: an entry is only begun after the registry wrote its record, so a
   * read queued later always sees it, and a Start that begins meanwhile is never closed by a stale
   * read. `active` is the record the caller just read: when it owns the only open entry nothing
   * needs reading.
   */
  private async syncUsage(active: InstanceRecord | null, now: number): Promise<void> {
    const usage = this.deps.usage;
    if (usage === undefined) return;
    let open: string[];
    try {
      open = usage.openHostnames();
    } catch {
      return;
    }
    if (open.length === 0 || (active !== null && open.every((h) => h === active.tailnet_hostname))) return;
    let records: InstanceRecord[];
    try {
      records = await this.deps.registry.all();
    } catch {
      return; // the registry cannot be read: decide nothing
    }
    for (const hostname of open) {
      const record = records.find((r) => r.tailnet_hostname === hostname);
      if (record === undefined || record.status === "gone") this.withUsage((u) => u.end(hostname, now));
    }
  }

  /** GET /api/history: every session, newest first; open sessions whose record is gone are closed first. */
  async history(): Promise<UsageItem[]> {
    if (this.deps.usage === undefined) return [];
    const now = this.now();
    const active = await this.deps.registry.active().catch(() => null);
    if (active !== null) this.noteUsage(active, undefined, null, now);
    await this.syncUsage(active, now);
    return this.deps.usage.list(this.now());
  }

  // ---- boot console ----

  private consoleLimits(): ConsoleLimits & { pollMinS: number; watchS: number } {
    return {
      maxLines: intCfg(this.cfg, "bootLogMaxLines", "BOOT_LOG_MAX_LINES", 1),
      maxLineChars: intCfg(this.cfg, "bootLogMaxLineChars", "BOOT_LOG_MAX_LINE_CHARS", 2),
      tailLines: intCfg(this.cfg, "bootLogTailLines", "BOOT_LOG_TAIL_LINES", 1),
      pollMinS: intCfg(this.cfg, "bootLogPollMinS", "BOOT_LOG_POLL_MIN_S", 1),
      watchS: intCfg(this.cfg, "bootLogWatchS", "BOOT_LOG_WATCH_S", 1),
    };
  }

  /** The console buffer, restored from the store on first use (an unusable file starts empty). */
  private consoleBuffer(): ConsoleBuffer {
    if (this.consoleBuf !== null) return this.consoleBuf;
    const limits = this.consoleLimits();
    const secrets = (): string[] => [...this.secrets];
    const clock = (): number => this.now();
    let saved: unknown = null;
    try {
      saved = this.deps.consoleStore?.load() ?? null;
    } catch {
      saved = null;
    }
    let buf: ConsoleBuffer;
    try {
      buf = saved === null ? new ConsoleBuffer(limits, secrets, clock) : ConsoleBuffer.fromJSON(saved, limits, secrets, clock);
    } catch {
      buf = new ConsoleBuffer(limits, secrets, clock); // corrupt or foreign file: start empty
    }
    this.consoleBuf = buf;
    return buf;
  }

  /** Run `fn` on the console and persist it; the console never makes a lifecycle operation fail. */
  private withConsole(fn: (buf: ConsoleBuffer) => void): void {
    try {
      const buf = this.consoleBuffer();
      fn(buf);
      this.persistConsole(buf);
    } catch {
      // best effort (e.g. BOOT_LOG_* missing in a test config)
    }
  }

  private persistConsole(buf: ConsoleBuffer): void {
    if (!buf.takeDirty()) return;
    try {
      this.deps.consoleStore?.save(buf.toJSON());
    } catch {
      // best effort: the lines stay in memory
    }
  }

  private endConsole(hostname: string, reason: ConsoleEndReason): void {
    this.withConsole((buf) => {
      if (buf.owner === hostname) buf.markEnded(reason);
    });
  }

  /** Point the console at the active record: another instance starts a fresh console; no record ends it. */
  private syncConsoleOwner(buf: ConsoleBuffer, record: InstanceRecord | null): void {
    if (record === null) {
      if (buf.owner !== null && !buf.ended) buf.markEnded("gone");
      return;
    }
    this.secrets.add(record.agent_token);
    if (buf.owner !== record.tailnet_hostname) buf.reset(record.tailnet_hostname);
  }

  private feedVast(buf: ConsoleBuffer, inst: VastInstance | undefined, maxLines: number): void {
    if (inst === undefined) return;
    buf.setVastStatus(inst.actual_status);
    if (typeof inst.status_msg === "string" && inst.status_msg !== "") {
      buf.append("vast_status", inst.status_msg.split("\n").slice(-maxLines));
    }
  }

  /**
   * The console generation now, or null when the console cannot be used. Callers take it
   * synchronously BEFORE their first await and act on the console only while it is unchanged:
   * every reset (a Start, or another call pointing the console at a new owner) bumps it, and a
   * record read before that reset is stale (acting on it would end the new boot's console as
   * "gone" or reset it back to the old owner).
   */
  private consoleEpoch(): number | null {
    try {
      return this.consoleBuffer().generation;
    } catch {
      return null;
    }
  }

  /** From view(): Vast's status and the agent summary (no extra requests), then a watched refresh. */
  private feedConsole(
    epoch: number | null,
    record: InstanceRecord | null,
    inst: VastInstance | undefined,
    agent: AgentStatus | null,
    instances: VastInstance[] | null,
    now: number,
  ): void {
    this.withConsole((buf) => {
      const current = (): boolean => epoch !== null && buf.generation === epoch;
      if (!current()) return; // the console was reset while this view was in flight
      this.syncConsoleOwner(buf, record);
      if (record === null || buf.owner !== record.tailnet_hostname || buf.ended) return;
      this.feedVast(buf, inst, this.consoleLimits().maxLines);
      if (agent !== null) buf.append("agent", [agentLine(agent)]);
      // While an admin watches the console, the status poll keeps the container log fresh too.
      if (instances !== null) void this.refreshConsole(record, now, instances).catch(() => undefined);
    });
  }

  /**
   * Read Vast for the console under two rules: only while an admin watches (console() called
   * within BOOT_LOG_WATCH_S) and at most once per BOOT_LOG_POLL_MIN_S. Single-flight.
   */
  private refreshConsole(record: InstanceRecord, now: number, listed: VastInstance[] | null): Promise<void> {
    if (this.consoleRefresh !== null) return this.consoleRefresh;
    const limits = this.consoleLimits();
    if (this.consoleWatchedAt === null || now - this.consoleWatchedAt > limits.watchS) return Promise.resolve();
    if (this.consolePolledAt !== null && now - this.consolePolledAt < limits.pollMinS) return Promise.resolve();
    this.consolePolledAt = now;
    const run = this.doRefreshConsole(record, listed, limits.tailLines, limits.maxLines).finally(() => {
      this.consoleRefresh = null;
    });
    this.consoleRefresh = run;
    return run;
  }

  private async doRefreshConsole(
    record: InstanceRecord,
    listed: VastInstance[] | null,
    tail: number,
    maxLines: number,
  ): Promise<void> {
    const buf = this.consoleBuffer();
    const generation = buf.generation;
    const current = (): boolean => buf.generation === generation && buf.owner === record.tailnet_hostname && !buf.ended;
    let instances = listed;
    if (instances === null) {
      try {
        instances = await this.deps.vast.listInstances();
      } catch {
        this.consoleError = "vast_logs_unavailable";
        return;
      }
    }
    if (!current()) return;
    const inst = instances.find(
      (i) =>
        (record.vast_instance_id !== null && i.id === record.vast_instance_id) ||
        labelHostname(i.label) === record.tailnet_hostname,
    );
    this.feedVast(buf, inst, maxLines);
    this.persistConsole(buf);
    const vast = this.deps.vast;
    // While the image is pulled the container has no log yet; status_msg carries the progress.
    if (inst === undefined || vast.instanceLogs === undefined || inst.actual_status === VAST_LOADING) {
      this.consoleError = null;
      return;
    }
    let text: string;
    try {
      text = await vast.instanceLogs(inst.id, tail);
    } catch {
      // Fixed flag only: the error may carry provider text.
      this.consoleError = "vast_logs_unavailable";
      return;
    }
    this.consoleError = null;
    if (!current()) return;
    buf.append("vast_logs", logLines(text).slice(-tail));
    this.persistConsole(buf);
  }

  /** Waits for a console refresh in flight (tests; a refresh started by view() runs in the background). */
  async flushConsole(): Promise<void> {
    await (this.consoleRefresh ?? Promise.resolve()).catch(() => undefined);
  }

  /**
   * The boot console for an admin: lines with seq > `after`, the phases and whether the instance
   * ended. Counts as watching (see refreshConsole). Vast failures never throw: they set
   * source_error and the kept lines are returned. A new Start clears the console; when the
   * instance is gone the last lines stay until then.
   */
  async console(after: number): Promise<ConsolePayload> {
    if (!Number.isSafeInteger(after) || after < 0) throw new RangeError("after must be an integer >= 0");
    const now = this.now();
    this.consoleWatchedAt = now;
    // Taken before the first await (see consoleEpoch).
    const buf = this.consoleBuffer();
    const epoch = buf.generation;
    const current = (): boolean => buf.generation === epoch;
    let record = await this.deps.registry.active();
    if (current()) {
      this.syncConsoleOwner(buf, record);
      this.persistConsole(buf);
      if (record !== null && buf.owner === record.tailnet_hostname && !buf.ended) {
        await this.refreshConsole(record, now, null);
      }
    } else {
      // Reset (a Start) while the registry was read: that record is stale. Leave the console as
      // the reset made it and describe it with a fresh read.
      record = await this.deps.registry.active();
    }
    const owner = buf.owner;
    const page = buf.since(after);
    // The tailnet hostname never leaves the server (Tailscale prints it while joining).
    const lines = owner === null ? page.lines : page.lines.map((l) => ({ ...l, text: l.text.split(owner).join(HOST_PLACEHOLDER) }));
    const state = record !== null && !buf.ended ? record.status : null;
    const live = state !== null;
    return {
      generation: buf.generation,
      instance: { state: state ?? "none", ended: buf.ended, ended_reason: buf.endedReason },
      phases: buf.phases(),
      lines,
      last_seq: page.last_seq,
      truncated: page.truncated,
      source_error: live ? this.consoleError : null,
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
    const stuckLimit = intCfg(this.cfg, "vastStartStuckMin", "VAST_START_STUCK_MIN", 1) * SECONDS_PER_MINUTE;
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
        this.withUsage((u) => u.noteInstance(hostname, match.id));
        if (this.destroyRequested.has(hostname)) {
          // The user asked to destroy it while Vast did not list it yet: do it now.
          this.destroyRequested.delete(hostname);
          try {
            // The Destroy button's own request (with its user) was recorded when it was pressed.
            const result = await this.destroyRecord(record, match.id, "manual", { reason: "destroy_button" });
            this.endConsole(hostname, "destroy_requested");
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
        this.withUsage((u) => u.requestStop(hostname, "boot_failed"));
        await registry.markGone(hostname);
        this.endUsage(hostname);
        this.endConsole(hostname, "never_created");
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
          this.noteVanishedBoot(record, now);
          await registry.markGone(hostname);
          this.endUsage(hostname); // inferred from the last agent status seen
          this.endConsole(hostname, "vanished");
          report.gone.push({ tailnet_hostname: hostname, reason: "vanished" });
        } else {
          this.vanishMisses.set(hostname, misses);
        }
      }
      return report;
    }
    this.vanishMisses.delete(hostname);
    const rowServer = serverInfo(inst);
    const knownServer = this.lastServer?.hostname === hostname ? this.lastServer.server : NO_SERVER;
    this.lastServer = { hostname, server: mergeServer(rowServer, knownServer) ?? NO_SERVER };

    // 4. Read the agent; track readiness and the unreachable timer.
    let agent: AgentStatus | null = null;
    try {
      agent = await this.deps.agentFor(record).status();
    } catch {
      // Unreachable, and also an unusable /status (HTTP error, bad body): both start the
      // unreachable timer, the safer choice for a billing instance.
      agent = null;
    }
    this.noteUsage(record, inst, agent, now);
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

    // A stuck sighting counts per instance and only on consecutive successful reconciles (a failed
    // list returned above and changes nothing); any other sample of this instance resets it.
    const kind = record.status === "booting" && agent === null ? stuckKind(inst) : null;
    let stuckHeld: StuckCode | null = null;
    if (kind === null) {
      if (this.stuckSeen?.hostname === hostname) this.stuckSeen = null;
    } else {
      const seen = this.stuckSeen;
      const next =
        seen !== null && seen.hostname === hostname && seen.id === id
          ? { ...seen, count: seen.count + 1 }
          : { hostname, id, since: now, count: 1 };
      this.stuckSeen = next;
      if (next.count >= STUCK_CONFIRMATIONS && now - next.since >= STUCK_DWELL_S && now - record.created_at >= stuckLimit) {
        stuckHeld = kind;
      }
    }

    // Slow boots: only a record still booting (never one that reached ready) is judged.
    if (agent !== null) {
      this.agentAnsweredHost = hostname;
      const failing = AGENT_FAILURE_STATES.has(agent.state ?? "");
      this.lastAgentFailure = { hostname, reason: failing && typeof agent.reason === "string" ? agent.reason : null };
    }
    const silentHeld = this.sampleSilent(record, inst, agent, now);
    const slowDownload = this.sampleDownload(record, agent, now);

    // 5. Enforcement.
    let reason: string | null = null;
    if (record.status === "stopping") reason = "destroy_retry";
    else if (now - startedAt >= hardCap) reason = "hard_cap";
    else if (stuckHeld !== null) reason = stuckHeld;
    else if (silentHeld) reason = "slow_boot";
    else if (slowDownload !== null) reason = "slow_download";
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
    if (reason === "start_stuck" || reason === "boot_stopped") this.noteStuck(record, inst, now, reason);
    else if (reason === "slow_boot") this.noteStuck(record, inst, now, "slow_boot");
    else if (reason === "slow_download") this.noteStuck(record, inst, now, "slow_download", slowDownload);
    try {
      const result = await this.destroyRecord(record, id, "watchdog", WATCHDOG_STOPS[reason] ?? null);
      this.endConsole(hostname, reason as ConsoleEndReason);
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

  /**
   * One reconcile sample of "Vast says running, the agent has never answered" for a booting record.
   * Held (slow_boot) after STUCK_CONFIRMATIONS consecutive samples whose first and last lie at least
   * BOOT_AGENT_GRACE_MIN (and STUCK_DWELL_S) apart. The silence is counted from the first reconcile
   * that saw the container running, not from the creation: an image pull (Vast `loading`, not billed)
   * can take minutes, and the agent only starts after it. An agent that answered once (in this
   * process or, after a restart, in the usage file) is never silent here: the unreachable rule covers it.
   */
  private sampleSilent(record: InstanceRecord, inst: VastInstance, agent: AgentStatus | null, now: number): boolean {
    const hostname = record.tailnet_hostname;
    const id = record.vast_instance_id;
    const graceS = intCfg(this.cfg, "bootAgentGraceMin", "BOOT_AGENT_GRACE_MIN", 2) * SECONDS_PER_MINUTE;
    let answered = this.agentAnsweredHost === hostname;
    if (!answered) {
      try {
        answered = this.deps.usage?.agentSeen(hostname) ?? false;
      } catch {
        answered = false;
      }
    }
    const silent = record.status === "booting" && agent === null && inst.actual_status === VAST_RUNNING && !answered;
    if (!silent || id === null) {
      if (this.silentSeen?.hostname === hostname) this.silentSeen = null;
      return false;
    }
    const seen = this.silentSeen;
    const next =
      seen !== null && seen.hostname === hostname && seen.id === id
        ? { ...seen, count: seen.count + 1 }
        : { hostname, id, since: now, count: 1 };
    this.silentSeen = next;
    return next.count >= STUCK_CONFIRMATIONS && now - next.since >= Math.max(STUCK_DWELL_S, graceS);
  }

  /**
   * One reconcile sample of the model download of a booting record. The speed is the average since
   * the first sample of the window (overall bytes across the profile's files, from the agent's
   * /status), judged once the window is MODEL_ETA_MIN_OBSERVE_S long. Too slow means the bytes left
   * would take more than BOOT_MAX_DOWNLOAD_ETA_MIN at that speed. Returns the speed in MB/s when the
   * slow download held (STUCK_CONFIRMATIONS consecutive slow samples, STUCK_DWELL_S apart), else null.
   * Also too slow: a download that, at that speed, would end (plus AFTER_DOWNLOAD_S for the rest of the
   * boot) after BOOT_TIMEOUT_MIN, which would release it anyway without naming the machine.
   * A failed agent read is not a sample; a good sample resets the slow run; fewer bytes than at the
   * previous sample (a file restarted) start a new window.
   */
  private sampleDownload(record: InstanceRecord, agent: AgentStatus | null, now: number): number | null {
    const hostname = record.tailnet_hostname;
    const id = record.vast_instance_id;
    if (agent === null) return null;
    const reset = (): null => {
      if (this.downloadSeen?.hostname === hostname) this.downloadSeen = null;
      return null;
    };
    if (record.status !== "booting" || id === null) return reset();
    const dl = overallDownload(agent.state ?? "", agent.progress, this.bootModels(agent));
    if (dl === null) return reset();
    const observeS = intCfg(this.cfg, "modelEtaMinObserveS", "MODEL_ETA_MIN_OBSERVE_S", 1);
    const maxEtaS = intCfg(this.cfg, "bootMaxDownloadEtaMin", "BOOT_MAX_DOWNLOAD_ETA_MIN", 1) * SECONDS_PER_MINUTE;
    const bootTimeoutS = intCfg(this.cfg, "bootTimeoutMin", "BOOT_TIMEOUT_MIN", 1) * SECONDS_PER_MINUTE;
    const seen = this.downloadSeen;
    if (seen === null || seen.hostname !== hostname || seen.id !== id || dl.bytes_done < seen.lastBytes) {
      this.downloadSeen = { hostname, id, firstAt: now, firstBytes: dl.bytes_done, lastBytes: dl.bytes_done, slowSince: null, count: 0 };
      return null;
    }
    const observed = now - seen.firstAt;
    if (observed < observeS) {
      this.downloadSeen = { ...seen, lastBytes: dl.bytes_done };
      return null;
    }
    const rate = (dl.bytes_done - seen.firstBytes) / observed; // bytes per second
    const left = Math.max(0, dl.bytes_total - dl.bytes_done);
    const eta = left === 0 ? 0 : rate > 0 ? left / rate : Number.POSITIVE_INFINITY;
    const doomed = now - record.created_at + eta + AFTER_DOWNLOAD_S > bootTimeoutS;
    if (eta <= maxEtaS && !doomed) {
      this.downloadSeen = { ...seen, lastBytes: dl.bytes_done, slowSince: null, count: 0 };
      return null;
    }
    const next = { ...seen, lastBytes: dl.bytes_done, slowSince: seen.slowSince ?? now, count: seen.count + 1 };
    this.downloadSeen = next;
    if (next.count < STUCK_CONFIRMATIONS || now - next.slowSince < STUCK_DWELL_S) return null;
    return measuredMbS(rate / BYTES_PER_MB) ?? 0;
  }

  /**
   * Generic rule: the record's instance disappeared while it was still booting (it never reached
   * ready) and the web did not ask for that (no Destroy button, no web release: either sets the
   * record to stopping or records a stop first). The instance gave up by itself (for example its own
   * boot failure or the early network probe), so its machine is avoided for VAST_BAD_MACHINE_TTL_MIN
   * when the machine is known (the last Vast row or the chosen offer, in this process only; after a
   * restart it may be unknown and then nothing is avoided). When the boot console saw the probe's
   * `[boot] FAILED: slow_network`, the page says slow_download with the speed the probe printed.
   */
  private noteVanishedBoot(record: InstanceRecord, now: number): void {
    const hostname = record.tailnet_hostname;
    if (record.status !== "booting" || this.destroyRequested.has(hostname)) return;
    try {
      if (this.deps.usage?.stopRequested(hostname)) return;
    } catch {
      // the usage file is best effort; the registry status above already says the web did not stop it
    }
    let code: StuckCode = "boot_failed";
    let measured: number | null = null;
    const codes: string[] = [];
    try {
      const buf = this.consoleBuffer();
      if (buf.owner === hostname && buf.failedCode !== null) {
        codes.push(buf.failedCode);
        if (buf.failedCode === INSTANCE_SLOW_NETWORK) {
          code = "slow_download";
          measured = buf.netProbeMbS();
        }
      }
    } catch {
      // the console is optional
    }
    let agentReason = this.lastAgentFailure?.hostname === hostname ? this.lastAgentFailure.reason : null;
    if (agentReason === null) {
      try {
        agentReason = this.deps.usage?.lastAgentFailure(hostname) ?? null;
      } catch {
        agentReason = null;
      }
    }
    if (agentReason !== null) codes.push(agentReason);
    // Where the web cannot tell it is the machine, it does not blame it (see MACHINE_FAILURE_CODES).
    const blame = codes.length === 0 || codes.some((c) => MACHINE_FAILURE_CODES.has(c));
    const known = this.lastServer?.hostname === hostname ? this.lastServer.server : NO_SERVER;
    const offer = this.startedGpu?.hostname === hostname ? this.startedGpu.server : NO_SERVER;
    this.recordStuck(record, record.vast_instance_id, null, mergeServer(known, offer) ?? NO_SERVER, now, code, measured, blame);
  }

  /**
   * Remember a released start before its instance is destroyed: the page learns why and, for the
   * codes in BAD_MACHINE_CODES (never started, slow boot, slow download), the machine is avoided for
   * VAST_BAD_MACHINE_TTL_MIN. A container that started and then stopped (boot_stopped) does not blame
   * the machine. Called inside reconcile (exclusive): the record is the active one, never a newer Start's.
   */
  private noteStuck(record: InstanceRecord, inst: VastInstance, now: number, code: StuckCode, measured: number | null = null): void {
    const hostname = record.tailnet_hostname;
    const offerServer = this.startedGpu?.hostname === hostname ? this.startedGpu.server : NO_SERVER;
    const server = mergeServer(serverInfo(inst), offerServer) ?? NO_SERVER;
    const status = inst.actual_status !== null && STATUS_WORD.test(inst.actual_status) ? inst.actual_status : "unknown";
    this.recordStuck(record, inst.id, status, server, now, code, measured);
  }

  private recordStuck(
    record: InstanceRecord,
    instanceId: number | null,
    status: string | null,
    server: ServerInfo,
    now: number,
    code: StuckCode,
    measured: number | null,
    blame = true,
  ): void {
    const avoid = blame && BAD_MACHINE_CODES.has(code) ? server.machine_id : null;
    const entry: StuckStart = {
      hostname: record.tailnet_hostname,
      code,
      at: now,
      machine_id: avoid,
      location: server.location,
      down_mbps: server.down_mbps,
      measured_mb_s: code === "slow_download" ? measured : null,
    };
    this.memoryStuck.push(entry);
    this.memoryStuck.splice(0, Math.max(0, this.memoryStuck.length - STUCK_MEMORY_MAX));
    this.withUsage((u) => u.noteStuck(entry));
    const inst = instanceId ?? "unknown";
    const machine = server.machine_id ?? "unknown";
    const ttl = Math.round(this.badMachineTtl() / SECONDS_PER_MINUTE);
    const avoiding =
      avoid !== null
        ? `avoiding the machine for ${ttl} min`
        : !blame
          ? "the failure is not the machine's, it is not blamed"
          : "the machine is not known, nothing is avoided";
    const speed = entry.measured_mb_s !== null ? `about ${entry.measured_mb_s} MB/s` : "speed unknown";
    let text: string;
    switch (code) {
      case "start_stuck":
        text = `lifecycle: start stuck: instance ${inst} on machine ${machine} did not start (actual_status=${status ?? "unknown"}); ` +
          `releasing it and ${avoiding}`;
        break;
      case "boot_stopped":
        text = `lifecycle: boot stopped: instance ${inst} on machine ${machine} stopped during the boot ` +
          `(actual_status=${status ?? "unknown"}); releasing it`;
        break;
      case "slow_boot":
        text = `lifecycle: slow boot: instance ${inst} on machine ${machine} runs but its agent never answered; ` +
          `releasing it and ${avoiding}`;
        break;
      case "slow_download":
        text = status === null
          ? `lifecycle: slow network: instance ${inst} on machine ${machine} gave up during its boot (${speed}); ${avoiding}`
          : `lifecycle: slow download: instance ${inst} on machine ${machine} downloads the models at ${speed}; ` +
            `releasing it and ${avoiding}`;
        break;
      default:
        text = `lifecycle: boot failed: instance ${inst} on machine ${machine} disappeared during its boot; ${avoiding}`;
    }
    try {
      this.deps.log?.("warn", text);
    } catch {
      // logging never stops the release
    }
  }
}

export { AlreadyActiveError };
