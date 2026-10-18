import type { AgentStatus } from "./agent.js";
import type { AppsConfig } from "./config.js";
import { JsonFileStore, type ConsoleStoreLike } from "./console.js";
import { MAX_MBPS, mbps, serverLocation } from "./vast.js";

// Usage history: one entry per instance session (Start accepted -> instance gone), persisted next
// to the registry and bounded. Rules:
// - the stop reason is a fixed identifier (STOP_REASONS). When the web service itself stops the
//   instance it says why (requestStop, BEFORE it acts, so a concurrent reader agrees); when the
//   instance disappears by itself the reason is inferred from the LAST agent status the web saw
//   (inferStop): the agent's own destroy state first, then a passed deadline, else `gone`;
// - names are plain user names (userLabel), never an email address; the tailnet hostname is kept
//   in the file only to match the registry and never leaves through list() or a log line;
// - nothing here performs I/O except through the store (one small JSON file, atomic writes), and a
//   store failure never makes a caller fail: the history then lives in memory.

/** Why a session ended. Documented in contracts/web.openapi.json (UsageStopReason). */
export const STOP_REASONS = [
  "destroy_button",
  "idle_timeout",
  "failsafe_deadline",
  "hard_cap",
  "boot_failed",
  "agent_unreachable",
  "gone",
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

const FILE_VERSION = 1;
const SECONDS_PER_HOUR = 3600;
const LABEL_MAX = 64;
const HOSTNAME = /^[A-Za-z0-9-]{1,63}$/;
const AGENT_TEXT = /^[a-z0-9_-]{1,64}$/;
const USER_CHARS = /[^A-Za-z0-9._ -]/g;
const GPU_CHARS = /[^A-Za-z0-9._ ()+-]/g;
const ENTRY_BYTES = 4096; // generous upper bound of one serialised entry (6 bytes per escaped char)
const FILE_SLACK_BYTES = 4096;
/** Stuck starts kept (newest last); they name bad machines and the page's failure message. */
export const STUCK_MAX = 16;
const STUCK_BYTES = 1024; // generous upper bound of one serialised stuck record
const SERVER_BYTES = 1024; // generous upper bound of one serialised server record (per entry)

// Agent destroy states and reasons (instance/agent/vastcomfy_agent/state.py).
const DESTROYING_STATES = new Set(["stopping", "destroy_failed"]);
const FAILED_STATE = "failed";
const AGENT_EXACT: Readonly<Record<string, StopReason>> = {
  idle_timeout: "idle_timeout",
  failsafe_deadline: "failsafe_deadline",
  hard_cap: "hard_cap",
  manual: "destroy_button",
};
const AGENT_BOOT_REASONS = new Set([
  "missing_container_credentials",
  "config_invalid",
  "hard_cap_missing",
  "failsafe_failed",
  "tailscale_failed",
  "node_install_failed",
  "download_failed",
  "disk_insufficient",
  "comfyui_start_failed",
  "agent_start_failed",
  "supervisor_failed",
  "boot_failed",
  "node_import_failed",
]);

/** What the inference needs from one agent /status, and when the web saw it. */
export interface AgentObservation {
  seen_at: number;
  state: string | null;
  reason: string | null;
  idle_destroy_at: number | null;
  failsafe_at: number | null;
  hard_cap_at: number | null;
  /** The standalone failsafe had started destroying. */
  destroy_pending: boolean;
}

/** One session as persisted (USAGE_LOG_PATH). */
export interface UsageEntry {
  hostname: string;
  instance_id: number | null;
  gpu_name: string | null;
  dph: number | null;
  started_at: number;
  ready_at: number | null;
  ended_at: number | null;
  started_by: string | null;
  reason: StopReason | null;
  stop_by: string | null;
  /** The web's own stop decision, written before it acted; it wins over any inference. */
  pending_stop: { reason: StopReason; by: string | null } | null;
  last_agent: AgentObservation | null;
}

/** Why a start was released after Start returned: never started, or stopped during the boot. */
export const STUCK_CODES = ["start_stuck", "boot_stopped"] as const;
export type StuckCode = (typeof STUCK_CODES)[number];

/**
 * One start the web released because its container did not run. Kept in the usage file under
 * the top-level `stuck` key, beside the sessions: an older web ignores that key, so a rollback
 * never meets an unknown field (the registry file is strict and is not touched).
 */
export interface StuckStart {
  hostname: string;
  code: StuckCode;
  at: number;
  /** Set only when the machine should be avoided (it never started the container). */
  machine_id: number | null;
  location: string | null;
  down_mbps: number | null;
}

const STUCK_KEYS = ["hostname", "code", "at", "machine_id", "location", "down_mbps"].sort().join(",");

function validStuck(v: unknown): v is StuckStart {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== STUCK_KEYS) return false;
  const machine = r["machine_id"];
  return (
    typeof r["hostname"] === "string" && HOSTNAME.test(r["hostname"]) &&
    (STUCK_CODES as readonly unknown[]).includes(r["code"]) &&
    typeof r["at"] === "number" && Number.isSafeInteger(r["at"]) &&
    (machine === null || (typeof machine === "number" && Number.isSafeInteger(machine) && machine > 0)) &&
    (r["location"] === null || (typeof r["location"] === "string" && serverLocation(r["location"]) === r["location"])) &&
    (r["down_mbps"] === null || (typeof r["down_mbps"] === "number" && mbps(r["down_mbps"]) === r["down_mbps"]))
  );
}

/**
 * What the history keeps about the server of a session: where it was (Vast geolocation, plain and
 * short) and its download speed in Mbps. Kept under the top-level `servers` key by hostname, not
 * in the entry: an older web refuses (and then drops) an entry with unknown keys, but it ignores
 * an unknown top-level key, so a rollback loses no session.
 */
export interface SessionServer {
  location: string | null;
  down_mbps: number | null;
}

/** One session as GET /api/history shows it (no hostname). */
export interface UsageItem {
  instance_id: number | null;
  gpu_name: string | null;
  dph: number | null;
  started_at: number;
  ready_at: number | null;
  ended_at: number | null;
  duration_s: number;
  /** duration x dph; an estimate (disk and network are billed separately). Null without an instance or a price. */
  estimated_cost: number | null;
  started_by: string | null;
  reason: StopReason | null;
  stop_by: string | null;
  active: boolean;
  location: string | null;
  down_mbps: number | null;
}

export interface UsageLimits {
  maxEntries: number;
  /** Seconds a deadline may lie after the detection and still count as passed (clock skew). */
  slackS: number;
}

function intCfg(cfg: AppsConfig, key: string, envName: string, min: number): number {
  const value = cfg[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new Error(`${envName} must be an integer >= ${min}`);
  }
  return value;
}

export function usageLimits(cfg: AppsConfig): UsageLimits {
  return {
    // Two at least: a session adopted or begun always fits next to the one it closes.
    maxEntries: intCfg(cfg, "usageLogMaxEntries", "USAGE_LOG_MAX_ENTRIES", 2),
    slackS: intCfg(cfg, "usageReasonSlackS", "USAGE_REASON_SLACK_S", 0),
  };
}

/** Upper bound of the persisted file for `maxEntries` entries. */
export function usageFileCap(maxEntries: number): number {
  return maxEntries * (ENTRY_BYTES + SERVER_BYTES) + STUCK_MAX * STUCK_BYTES + FILE_SLACK_BYTES;
}

/** The usage history file (USAGE_LOG_PATH). */
export class UsageStore extends JsonFileStore {
  constructor(filePath: string, maxFileBytes: number) {
    super(filePath, maxFileBytes, "USAGE_LOG_PATH");
  }
}

function plain(raw: string, chars: RegExp): string | null {
  const text = raw.replace(chars, "").replace(/\s+/g, " ").trim().slice(0, LABEL_MAX).trim();
  return text === "" ? null : text;
}

/** A user name fit to keep and show: the part before any "@", plain characters, at most 64. */
export function userLabel(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const at = raw.indexOf("@");
  return plain(at === -1 ? raw : raw.slice(0, at), USER_CHARS);
}

function gpuLabel(raw: unknown): string | null {
  return typeof raw === "string" ? plain(raw, GPU_CHARS) : null;
}

function price(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

function time(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : null;
}

function agentText(raw: unknown): string | null {
  return typeof raw === "string" && AGENT_TEXT.test(raw) ? raw : null;
}

export function observationOf(status: AgentStatus, seenAt: number): AgentObservation {
  return {
    seen_at: Math.floor(seenAt),
    state: agentText(status.state),
    reason: agentText(status.reason),
    idle_destroy_at: time(status.idle_destroy_at),
    failsafe_at: time(status.failsafe_at),
    hard_cap_at: time(status.hard_cap_at),
    destroy_pending: status.destroy?.pending === true,
  };
}

/**
 * Why an instance that disappeared by itself ended, and when, from the last agent status seen:
 * 1. the agent was destroying itself (or had failed its boot): its own reason;
 * 2. a deadline had passed by `detectedAt + slackS`: the earliest one (hard cap first on a tie,
 *    then the failsafe, then idle), dated at that deadline within [last sighting, detection];
 * 3. the standalone failsafe was destroying: failsafe_deadline;
 * 4. otherwise `gone` (e.g. Vast removed it).
 * Cases 1, 3 and 4 are dated at the last sighting (it was alive then and gone at the detection),
 * never after the detection; without any sighting the end is the detection.
 */
export function inferStop(obs: AgentObservation | null, detectedAt: number, slackS: number): { reason: StopReason; ended_at: number } {
  const at = Math.floor(detectedAt);
  if (obs === null) return { reason: "gone", ended_at: at };
  const seen = Math.min(at, obs.seen_at);
  if (obs.state !== null && (DESTROYING_STATES.has(obs.state) || obs.state === FAILED_STATE)) {
    const exact = obs.reason === null ? undefined : AGENT_EXACT[obs.reason];
    if (exact !== undefined) return { reason: exact, ended_at: seen };
    if (obs.reason !== null && AGENT_BOOT_REASONS.has(obs.reason)) return { reason: "boot_failed", ended_at: seen };
    if (obs.state === FAILED_STATE) return { reason: "boot_failed", ended_at: seen };
  }
  const deadlines: [number | null, StopReason][] = [
    [obs.hard_cap_at, "hard_cap"],
    [obs.failsafe_at, "failsafe_deadline"],
    [obs.idle_destroy_at, "idle_timeout"],
  ];
  let best: [number, StopReason] | null = null;
  for (const [when, reason] of deadlines) {
    if (when === null || when > at + slackS) continue;
    if (best === null || when < best[0]) best = [when, reason];
  }
  if (best !== null) return { reason: best[1], ended_at: Math.min(at, Math.max(best[0], obs.seen_at)) };
  if (obs.destroy_pending) return { reason: "failsafe_deadline", ended_at: seen };
  return { reason: "gone", ended_at: seen };
}

// ---- validation of a loaded file (anything unexpected drops that entry) ----

const ENTRY_KEYS = [
  "hostname", "instance_id", "gpu_name", "dph", "started_at", "ready_at", "ended_at",
  "started_by", "reason", "stop_by", "pending_stop", "last_agent",
].sort().join(",");
const SERVER_KEYS = ["down_mbps", "location"].join(",");
const OBS_KEYS = ["seen_at", "state", "reason", "idle_destroy_at", "failsafe_at", "hard_cap_at", "destroy_pending"].sort().join(",");

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const intOrNull = (v: unknown): boolean => v === null || isInt(v);
const nameOrNull = (v: unknown): boolean => v === null || (typeof v === "string" && v.length > 0 && v.length <= LABEL_MAX);
const isReason = (v: unknown): v is StopReason => typeof v === "string" && (STOP_REASONS as readonly string[]).includes(v);
const textOrNull = (v: unknown): boolean => v === null || (typeof v === "string" && AGENT_TEXT.test(v));
const locationOrNull = (v: unknown): boolean => v === null || (typeof v === "string" && serverLocation(v) === v);
const mbpsOrNull = (v: unknown): boolean => v === null || (isInt(v) && v >= 0 && v <= MAX_MBPS);

function validServer(v: unknown): v is SessionServer {
  return isObject(v) && Object.keys(v).sort().join(",") === SERVER_KEYS && locationOrNull(v["location"]) && mbpsOrNull(v["down_mbps"]);
}


function validObservation(v: unknown): boolean {
  if (v === null) return true;
  if (!isObject(v) || Object.keys(v).sort().join(",") !== OBS_KEYS) return false;
  return isInt(v["seen_at"]) && textOrNull(v["state"]) && textOrNull(v["reason"]) && intOrNull(v["idle_destroy_at"]) &&
    intOrNull(v["failsafe_at"]) && intOrNull(v["hard_cap_at"]) && typeof v["destroy_pending"] === "boolean";
}

function validEntry(v: unknown): v is UsageEntry {
  if (!isObject(v) || Object.keys(v).sort().join(",") !== ENTRY_KEYS) return false;
  const pending = v["pending_stop"];
  const pendingOk =
    pending === null ||
    (isObject(pending) && Object.keys(pending).sort().join(",") === "by,reason" && isReason(pending["reason"]) && nameOrNull(pending["by"]));
  return (
    typeof v["hostname"] === "string" && HOSTNAME.test(v["hostname"]) &&
    intOrNull(v["instance_id"]) && nameOrNull(v["gpu_name"]) && (v["dph"] === null || price(v["dph"]) !== null) &&
    isInt(v["started_at"]) && intOrNull(v["ready_at"]) && intOrNull(v["ended_at"]) &&
    nameOrNull(v["started_by"]) && (v["reason"] === null || isReason(v["reason"])) && nameOrNull(v["stop_by"]) &&
    pendingOk && validObservation(v["last_agent"]) &&
    // An ended entry has a reason and an open one has none.
    (v["ended_at"] === null) === (v["reason"] === null)
  );
}

/** A loaded entry's names under the same rules as when they were recorded; any other value is dropped. */
function cleanNames(e: UsageEntry): UsageEntry {
  const keep = (v: string | null, clean: (raw: string) => string | null) => (v !== null && clean(v) === v ? v : null);
  e.started_by = keep(e.started_by, userLabel);
  e.stop_by = keep(e.stop_by, userLabel);
  e.gpu_name = keep(e.gpu_name, gpuLabel);
  if (e.pending_stop !== null) e.pending_stop.by = keep(e.pending_stop.by, userLabel);
  return e;
}

// In the tie order of inferStop: hard cap, then the failsafe, then idle.
const DEADLINE_KEYS = ["hard_cap_at", "failsafe_at", "idle_destroy_at"] as const;

/** The non-null deadlines from earliest to latest (ties in DEADLINE_KEYS order), as a key. */
function deadlineOrder(o: AgentObservation): string {
  return DEADLINE_KEYS.filter((k) => o[k] !== null)
    .map((k, i) => ({ k, i, at: o[k] as number }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((x) => x.k)
    .join(",");
}

type Log = (level: "info" | "warn" | "error", message: string) => void;

export class UsageHistory {
  private entries: UsageEntry[] | null = null; // oldest first; loaded on first use
  private stuck: StuckStart[] = []; // oldest first; loaded with the entries
  private readonly servers = new Map<string, SessionServer>(); // by hostname, for kept entries only
  // The exact last agent sighting per hostname, in this process only. The entry's `last_agent` is
  // the copy last written to the file: it may lag behind, but a deadline in it is never later than
  // the exact one and at most `slackS` earlier (see observe()).
  private readonly fresh = new Map<string, AgentObservation>();

  constructor(
    private readonly limits: UsageLimits,
    private readonly store: ConsoleStoreLike | null,
    private readonly log: Log = () => undefined,
  ) {}

  private all(): UsageEntry[] {
    if (this.entries !== null) return this.entries;
    let saved: unknown = null;
    try {
      saved = this.store?.load() ?? null;
    } catch {
      saved = null;
    }
    const file = isObject(saved) && saved["version"] === FILE_VERSION ? saved : null;
    const list: unknown[] = file !== null && Array.isArray(file["entries"]) ? file["entries"] : [];
    // Tolerant: a bad stuck record is dropped on its own; the sessions never depend on them.
    const stuck: unknown[] = file !== null && Array.isArray(file["stuck"]) ? file["stuck"] : [];
    this.stuck = stuck.filter(validStuck).map((r) => ({ ...r })).slice(-STUCK_MAX);
    const servers = file !== null && isObject(file["servers"]) ? file["servers"] : {};
    const valid = list.filter(validEntry).map((e) => cleanNames(structuredClone(e)));
    // At most one open entry survives (the newest); a duplicate hostname keeps its first entry.
    const seen = new Set<string>();
    const unique = valid.filter((e) => (seen.has(e.hostname) ? false : (seen.add(e.hostname), true)));
    const open = unique.filter((e) => e.ended_at === null);
    const keep = new Set(open.slice(-1));
    this.entries = unique.filter((e) => e.ended_at !== null || keep.has(e)).slice(-this.limits.maxEntries);
    // Tolerant: a bad server record is dropped on its own; one without a kept session too.
    for (const e of this.entries) {
      const server = Object.hasOwn(servers, e.hostname) ? servers[e.hostname] : undefined;
      if (validServer(server)) this.servers.set(e.hostname, { location: server.location, down_mbps: server.down_mbps });
    }
    return this.entries;
  }

  private persist(): void {
    try {
      const entries = this.all();
      const servers: Record<string, SessionServer> = {};
      for (const e of entries) {
        const server = this.servers.get(e.hostname);
        if (server !== undefined) servers[e.hostname] = server;
      }
      this.store?.save({ version: FILE_VERSION, entries, servers, stuck: this.stuck });
    } catch {
      // best effort: the history stays in memory
    }
  }

  private find(hostname: string): UsageEntry | undefined {
    return this.all().find((e) => e.hostname === hostname);
  }

  private open(hostname: string): UsageEntry | undefined {
    const e = this.find(hostname);
    return e !== undefined && e.ended_at === null ? e : undefined;
  }

  private evict(): void {
    const list = this.all();
    while (list.length > this.limits.maxEntries) {
      const index = list.findIndex((e) => e.ended_at !== null);
      if (index === -1) break;
      this.servers.delete(list[index]!.hostname);
      list.splice(index, 1);
    }
  }

  private add(hostname: string, startedAt: number, by: string | null): void {
    if (!HOSTNAME.test(hostname)) return;
    const at = Math.floor(startedAt);
    // Only one instance is ever active: an entry still open here missed its end.
    for (const other of this.openHostnames()) if (other !== hostname) this.finish(other, at);
    this.all().push({
      hostname, instance_id: null, gpu_name: null, dph: null, started_at: at, ready_at: null, ended_at: null,
      started_by: by, reason: null, stop_by: null, pending_stop: null, last_agent: null,
    });
    this.evict();
    this.persist();
  }

  /** Start was accepted for `hostname` (after the registry's write-ahead record). */
  begin(hostname: string, startedAt: number, by: string | null | undefined): void {
    const who = userLabel(by);
    const existing = this.find(hostname);
    if (existing !== undefined) {
      // Adopted by a status read between the registry write and this call: fill in who started it.
      if (existing.ended_at === null && existing.started_by === null && who !== null) {
        existing.started_by = who;
        this.persist();
      }
      return;
    }
    this.add(hostname, startedAt, who);
  }

  /** An active registry record without any entry (older version, lost file): start one for it. */
  adopt(hostname: string, startedAt: number): void {
    if (this.find(hostname) === undefined) this.add(hostname, startedAt, null);
  }

  openHostnames(): string[] {
    return this.all().filter((e) => e.ended_at === null).map((e) => e.hostname);
  }

  private patch(hostname: string, fn: (e: UsageEntry) => boolean): void {
    const e = this.open(hostname);
    if (e !== undefined && fn(e)) this.persist();
  }

  /** The offer the Start chose (and where its server is, when the offer says). */
  noteOffer(hostname: string, gpu: unknown, dph: unknown, server?: SessionServer): void {
    this.patch(hostname, (e) => {
      e.gpu_name = gpuLabel(gpu) ?? e.gpu_name;
      e.dph = price(dph) ?? e.dph;
      if (server !== undefined) this.applyServer(e, server);
      return true;
    });
  }

  /** Vast's own row for the instance: its location and speed win over the offer's when known. */
  noteServer(hostname: string, server: SessionServer): void {
    this.patch(hostname, (e) => this.applyServer(e, server));
  }

  private applyServer(e: UsageEntry, server: SessionServer): boolean {
    const old = this.servers.get(e.hostname) ?? { location: null, down_mbps: null };
    const location = serverLocation(server.location) ?? old.location;
    const down = mbps(server.down_mbps) ?? old.down_mbps;
    if (location === old.location && down === old.down_mbps) return false;
    this.servers.set(e.hostname, { location, down_mbps: down });
    return true;
  }

  /** Vast created the instance: the session bills from here (logged once). */
  noteInstance(hostname: string, id: number): void {
    const e = this.open(hostname);
    if (e === undefined || !Number.isSafeInteger(id) || e.instance_id === id) return;
    const first = e.instance_id === null;
    e.instance_id = id;
    this.persist();
    if (first) this.logStart(e);
  }

  private logStart(e: UsageEntry): void {
    const dph = e.dph === null ? "?" : e.dph.toFixed(3);
    this.log("info", `usage: start gpu=${e.gpu_name ?? "?"} dph=${dph} by=${e.started_by ?? "?"}`);
  }

  /** Vast's own price for the instance (it may differ from the offer). */
  noteDph(hostname: string, dph: unknown): void {
    const value = price(dph);
    if (value === null) return;
    this.patch(hostname, (e) => (e.dph === value ? false : ((e.dph = value), true)));
  }

  /** The instance was seen ready; the first time counts. */
  noteReady(hostname: string, at: number): void {
    this.patch(hostname, (e) => (e.ready_at !== null ? false : ((e.ready_at = Math.floor(at)), true)));
  }

  /**
   * The last agent status. Kept exactly in memory; written to the file only when the state, the
   * reason or the failsafe flag changes, a deadline appears, disappears or moves earlier, it moves
   * later by more than the slack, the order of the deadlines changes, or the sighting is more than
   * the slack newer than the saved one. So a saved deadline is at most `slackS` earlier than the
   * true one, the saved earliest deadline is the true earliest, and the saved last sighting is at
   * most about `slackS` old (a busy queue moving the idle deadline on every poll costs about one
   * write per slack window, not one per poll).
   */
  observe(hostname: string, status: AgentStatus, at: number): void {
    const next = observationOf(status, at);
    if (this.open(hostname) === undefined) return;
    this.fresh.set(hostname, next);
    this.patch(hostname, (e) => {
      if (!this.worthSaving(e.last_agent, next)) return false;
      e.last_agent = next;
      return true;
    });
  }

  private worthSaving(saved: AgentObservation | null, next: AgentObservation): boolean {
    if (saved === null) return true;
    if (saved.state !== next.state || saved.reason !== next.reason || saved.destroy_pending !== next.destroy_pending) return true;
    for (const key of DEADLINE_KEYS) {
      const a = saved[key];
      const b = next[key];
      if (a === null || b === null) {
        if (a !== b) return true;
      } else if (b < a || b - a > this.limits.slackS) return true;
    }
    // The saved copy must name the same earliest deadline as the true one.
    if (deadlineOrder(saved) !== deadlineOrder(next)) return true;
    // About one write per slack window keeps the saved last sighting at most that stale.
    return next.seen_at - saved.seen_at > this.limits.slackS;
  }

  /** A start the web released because its container did not run (see StuckStart). */
  noteStuck(record: StuckStart): void {
    this.all();
    const clean: StuckStart = {
      ...record,
      at: Math.floor(record.at),
      location: serverLocation(record.location),
      down_mbps: mbps(record.down_mbps),
    };
    if (!validStuck(clean)) return;
    this.stuck.push(clean);
    this.stuck = this.stuck.slice(-STUCK_MAX);
    this.persist();
  }

  /** The stuck starts kept, oldest first. */
  stuckStarts(): readonly StuckStart[] {
    this.all();
    return this.stuck;
  }

  /** The web service is about to stop the instance for `reason`; the first request wins. */
  requestStop(hostname: string, reason: StopReason, by: string | null | undefined = null): void {
    this.patch(hostname, (e) => {
      if (e.pending_stop !== null) return false;
      e.pending_stop = { reason, by: reason === "destroy_button" ? userLabel(by) : null };
      return true;
    });
  }

  private finish(hostname: string, detectedAt: number): boolean {
    const e = this.open(hostname);
    if (e === undefined) return false;
    const at = Math.max(e.started_at, Math.floor(detectedAt));
    if (e.pending_stop !== null) {
      e.reason = e.pending_stop.reason;
      e.stop_by = e.pending_stop.by;
      e.ended_at = at;
    } else {
      // The exact sighting of this process uses the slack. A copy from the file may show a deadline
      // up to slackS too early, so it gets none: "saved <= detected" implies "true <= detected + slack",
      // and a deadline the exact rule would refuse is never named.
      const exact = this.fresh.get(hostname);
      const inferred = exact !== undefined ? inferStop(exact, at, this.limits.slackS) : inferStop(e.last_agent, at, 0);
      e.reason = inferred.reason;
      e.ended_at = Math.max(e.started_at, inferred.ended_at);
    }
    // Without an instance id the start line was never logged (it is logged at the create): log it now.
    if (e.instance_id === null) this.logStart(e);
    this.fresh.delete(hostname);
    const by = e.stop_by === null ? "" : ` by=${e.stop_by}`;
    this.log("info", `usage: stop reason=${e.reason} duration_s=${e.ended_at - e.started_at}${by}`);
    return true;
  }

  /** The instance is gone (detected at `detectedAt`); no-op unless the entry is open. */
  end(hostname: string, detectedAt: number): void {
    if (this.finish(hostname, detectedAt)) this.persist();
  }

  /** Every entry, newest first. */
  list(now: number): UsageItem[] {
    const t = Math.floor(now);
    return [...this.all()].reverse().map((e) => {
      const end = e.ended_at ?? Math.max(e.started_at, t);
      const duration = Math.max(0, end - e.started_at);
      return {
        instance_id: e.instance_id,
        gpu_name: e.gpu_name,
        dph: e.dph,
        started_at: e.started_at,
        ready_at: e.ready_at,
        ended_at: e.ended_at,
        duration_s: duration,
        estimated_cost: e.instance_id !== null && e.dph !== null ? (e.dph * duration) / SECONDS_PER_HOUR : null,
        started_by: e.started_by,
        reason: e.reason,
        stop_by: e.stop_by,
        active: e.ended_at === null,
        location: this.servers.get(e.hostname)?.location ?? null,
        down_mbps: this.servers.get(e.hostname)?.down_mbps ?? null,
      };
    });
  }
}
