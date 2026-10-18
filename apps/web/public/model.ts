// Pure logic of the page: API shapes, formatting, button rules and polling choices. Nothing
// here touches the DOM, the network or timers, so it can be tested without a browser.

// Polling is derived from the page state; the API does not report an interval.
export const STATE_POLL_MS = 5_000;
export const STATE_POLL_IDLE_MS = 15_000; // no instance: nothing changes quickly
export const STATE_POLL_HIDDEN_MS = 30_000; // tab in the background
export const STATE_POLL_MAX_MS = 60_000; // ceiling when the API keeps failing
export const JOB_POLL_MS = 2_000;
export const JOB_POLL_MAX_ERRORS = 5;
export const CLOCK_TICK_MS = 1_000;
export const DEFAULT_EXTEND_MINUTES = 30;

// Protocol constants of the web API (paths and id format are defined by apps/web/src/routes.ts).
export const API = {
  state: "/api/state",
  estimate: "/api/estimate",
  gpus: "/api/gpus",
  start: "/api/start",
  destroy: "/api/destroy",
  extend: "/api/extend",
  destroyUnknown: "/api/destroy-unknown",
  generate: "/api/generate",
  me: "/api/me",
} as const;

// Protocol paths of the login routes (apps/web/src/auth-routes.ts). The login link is a plain
// <a href>, so it does not need JavaScript.
export const AUTH = {
  login: "/auth/login?next=/", // config-lint: ok (protocol path, not configuration)
  logout: "/auth/logout", // config-lint: ok (protocol path, not configuration)
} as const;
const LOGIN_ERROR_PARAM = "login_error";
const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SEED_TEXT = /^[0-9]{1,16}$/;
const MAX_IMAGE_INDEX = 999;
const SECONDS_PER_HOUR = 3600;
const MB_PER_GB = 1024;
const BYTES_PER_GB = 1e9; // download sizes are shown in decimal units
const BYTES_PER_MB = 1e6;
const BYTES_PER_KB = 1e3;
const MAX_GPU_NAME = 64; // the API refuses longer names
// Where the last GPU choice is remembered in the browser (only a model name, no secret).
export const GPU_STORAGE_KEY = "vast-comfy.gpu"; // config-lint: ok (browser storage key, not configuration)
// Speed/ETA: a moving window over the last few polls. A gap longer than this drops the window.
export const SPEED_WINDOW_SAMPLES = 6;
export const SPEED_MAX_GAP_MS = 120_000;
const MAX_ETA_SECONDS = 99 * SECONDS_PER_HOUR;
const DASH = "—";

export type Role = "admin" | "member";
export interface Preset { name: string; steps: number }
export interface Size { name: string; width: number; height: number }
export interface Progress { phase: string; file: string; bytes_done: number; bytes_total: number }
export interface Download { files_total: number; files_done: number; bytes_done: number; bytes_total: number; current_file: string }
export interface UnknownInstance { vast_instance_id: number; actual_status: string | null; start_date: number; dph: number }

export interface ApiState {
  state: string;
  role: Role;
  agent: { queue: { running: number; pending: number } | null; gpu: { vram_total_mb: number | null; vram_used_mb: number | null } } | null;
  agent_unreachable: boolean;
  failed: { reason: string | null } | null;
  destroy_failed: { error: string } | null;
  dph: number | null;
  uptime_s: number | null;
  cost_so_far: number | null;
  progress: Progress | null;
  gpu_name: string | null;
  download: Download | null;
  remaining: { idle_s: number | null; failsafe_s: number | null; hard_cap_s: number | null };
  unknown: UnknownInstance[];
  presets: Preset[];
  sizes: Size[];
}

export interface Estimate { gpu_name: string | null; dph: number; horizon_hours: number; max_cost: number }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parseDownload(v: unknown): Download | null {
  if (!isObj(v)) return null;
  const done = num(v["bytes_done"]);
  const total = num(v["bytes_total"]);
  const filesTotal = num(v["files_total"]);
  const filesDone = num(v["files_done"]);
  if (done === null || total === null || filesTotal === null || filesDone === null || done < 0 || total < 0 || filesTotal < 1 || filesDone < 0) return null;
  return {
    files_total: Math.floor(filesTotal),
    files_done: Math.floor(filesDone),
    bytes_done: total > 0 ? Math.min(done, total) : done,
    bytes_total: total,
    current_file: typeof v["current_file"] === "string" ? v["current_file"] : "",
  };
}

/** Check the parts of GET /api/state the page relies on; null when the payload is unusable. */
export function parseState(json: unknown): ApiState | null {
  if (!isObj(json) || typeof json["state"] !== "string") return null;
  if (json["role"] !== "admin" && json["role"] !== "member") return null;
  const rem = isObj(json["remaining"]) ? json["remaining"] : {};
  const agent = isObj(json["agent"]) ? json["agent"] : null;
  const q = agent && isObj(agent["queue"]) ? agent["queue"] : null;
  const gpu = agent && isObj(agent["gpu"]) ? agent["gpu"] : {};
  const prog = isObj(json["progress"]) ? json["progress"] : null;
  const failed = isObj(json["failed"]) ? json["failed"] : null;
  const df = isObj(json["destroy_failed"]) ? json["destroy_failed"] : null;
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  return {
    state: json["state"],
    role: json["role"],
    agent: agent
      ? {
          queue: q && num(q["running"]) !== null && num(q["pending"]) !== null
            ? { running: q["running"] as number, pending: q["pending"] as number }
            : null,
          gpu: { vram_total_mb: num(gpu["vram_total_mb"]), vram_used_mb: num(gpu["vram_used_mb"]) },
        }
      : null,
    agent_unreachable: json["agent_unreachable"] === true,
    failed: failed ? { reason: typeof failed["reason"] === "string" ? failed["reason"] : null } : null,
    destroy_failed: df ? { error: typeof df["error"] === "string" ? df["error"] : "" } : null,
    dph: num(json["dph"]),
    uptime_s: num(json["uptime_s"]),
    cost_so_far: num(json["cost_so_far"]),
    progress: prog
      ? {
          phase: typeof prog["phase"] === "string" ? prog["phase"] : "",
          file: typeof prog["file"] === "string" ? prog["file"] : "",
          bytes_done: num(prog["bytes_done"]) ?? 0,
          bytes_total: num(prog["bytes_total"]) ?? 0,
        }
      : null,
    gpu_name: typeof json["gpu_name"] === "string" && json["gpu_name"] !== "" ? json["gpu_name"] : null,
    download: parseDownload(json["download"]),
    remaining: { idle_s: num(rem["idle_s"]), failsafe_s: num(rem["failsafe_s"]), hard_cap_s: num(rem["hard_cap_s"]) },
    unknown: list(json["unknown"]).flatMap((u) => {
      if (!isObj(u)) return [];
      const id = num(u["vast_instance_id"]);
      if (id === null || !Number.isInteger(id)) return [];
      return [{ vast_instance_id: id, actual_status: typeof u["actual_status"] === "string" ? u["actual_status"] : null, start_date: num(u["start_date"]) ?? 0, dph: num(u["dph"]) ?? 0 }];
    }),
    presets: list(json["presets"]).flatMap((p) =>
      isObj(p) && typeof p["name"] === "string" && num(p["steps"]) !== null ? [{ name: p["name"], steps: p["steps"] as number }] : [],
    ),
    sizes: list(json["sizes"]).flatMap((s) =>
      isObj(s) && typeof s["name"] === "string" && num(s["width"]) !== null && num(s["height"]) !== null
        ? [{ name: s["name"], width: s["width"] as number, height: s["height"] as number }]
        : [],
    ),
  };
}

export function parseEstimate(json: unknown): Estimate | null {
  if (!isObj(json)) return null;
  const dph = num(json["dph"]);
  const hours = num(json["horizon_hours"]);
  const max = num(json["max_cost"]);
  if (dph === null || hours === null || max === null) return null;
  return { gpu_name: typeof json["gpu_name"] === "string" ? json["gpu_name"] : null, dph, horizon_hours: hours, max_cost: max };
}

// ---- GPU choice ----

export interface GpuOption { name: string; dph: number | null; vram_gb: number | null; available: boolean }

/** Check GET /api/gpus; null when the payload is unusable. An entry without a price is unavailable. */
export function parseGpus(json: unknown): GpuOption[] | null {
  if (!isObj(json) || !Array.isArray(json["gpus"])) return null;
  const out: GpuOption[] = [];
  for (const g of json["gpus"]) {
    if (!isObj(g) || typeof g["name"] !== "string" || g["name"] === "" || g["name"].length > MAX_GPU_NAME) continue;
    const dph = num(g["dph"]);
    out.push({ name: g["name"], dph, vram_gb: num(g["vram_gb"]), available: g["available"] === true && dph !== null && dph > 0 });
  }
  return out;
}

/** Option text: "RTX A5000 - $0.24/h", or "RTX 3090 - no offers now". */
export function gpuOptionLabel(g: GpuOption): string {
  return g.available && g.dph !== null ? `${g.name} - $${g.dph.toFixed(2)}/h` : `${g.name} - no offers now`;
}

/** The remembered model if it is listed and available, else the cheapest available one, else null. */
export function chooseGpu(remembered: string | null, list: readonly GpuOption[]): string | null {
  if (remembered !== null) {
    const hit = list.find((g) => g.name === remembered && g.available);
    if (hit) return hit.name;
  }
  let best: GpuOption | null = null;
  for (const g of list) {
    if (g.available && g.dph !== null && (best === null || g.dph < (best.dph ?? Infinity))) best = g;
  }
  return best === null ? null : best.name;
}

/** GET /api/estimate path for a model name (encoded); the bare path when no model is chosen. */
export function estimatePath(gpu: string | null): string {
  return gpu === null ? API.estimate : `${API.estimate}?gpu=${encodeURIComponent(gpu)}`;
}

/** The `reason` of an API error body, only when it is a short plain string. */
export function errorReason(body: unknown): string | null {
  if (!isObj(body) || !isObj(body["error"])) return null;
  const r = body["error"]["reason"];
  return typeof r === "string" && r !== "" && r.length <= 200 ? r : null;
}

// ---- formatting ----

/** "45s", "12m 05s", "2h 05m"; a dash when unknown. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return DASH;
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (s < SECONDS_PER_HOUR) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function formatCost(usd: number | null): string {
  return usd === null || !Number.isFinite(usd) ? DASH : `$${usd.toFixed(2)}`;
}

export function formatPrice(dph: number | null): string {
  return dph === null || !Number.isFinite(dph) ? DASH : `$${dph.toFixed(2)}/hour`;
}

/** Whole percent 0-100, or null when the total is unknown. */
export function progressPercent(p: Progress | null): number | null {
  if (p === null || !(p.bytes_total > 0)) return null;
  return Math.min(100, Math.max(0, Math.floor((p.bytes_done / p.bytes_total) * 100)));
}

/** Whole percent 0-100 of the overall download, or null when the total is unknown. */
export function downloadPercent(d: Download | null): number | null {
  if (d === null || !(d.bytes_total > 0)) return null;
  return Math.min(100, Math.max(0, Math.floor((d.bytes_done / d.bytes_total) * 100)));
}

export interface Sample { t: number; bytes: number }

/**
 * The speed window after a new poll. It is only kept while downloading; it restarts when the
 * overall counter goes down (a new instance), the clock goes back or the gap is too long.
 */
export function nextSamples(prev: readonly Sample[], t: number, state: string, d: Download | null): Sample[] {
  if (state !== "downloading" || d === null || !Number.isFinite(t)) return [];
  const sample = { t, bytes: d.bytes_done };
  const last = prev[prev.length - 1];
  if (last === undefined || t < last.t || t - last.t > SPEED_MAX_GAP_MS || d.bytes_done < last.bytes) return [sample];
  const kept = t === last.t ? prev.slice(0, -1) : prev.slice();
  kept.push(sample);
  return kept.slice(-SPEED_WINDOW_SAMPLES);
}

/** Bytes per second over the window; null until two samples exist or when nothing moved. */
export function windowSpeed(samples: readonly Sample[]): number | null {
  if (samples.length < 2) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const seconds = (last.t - first.t) / 1000;
  const delta = last.bytes - first.bytes;
  if (!(seconds > 0) || !(delta > 0)) return null;
  const speed = delta / seconds;
  return Number.isFinite(speed) && speed > 0 ? speed : null;
}

/** Seconds until the download ends at this speed; null when it cannot be told. */
export function etaSeconds(d: Download, speed: number | null): number | null {
  if (speed === null || !(speed > 0) || !(d.bytes_total > d.bytes_done)) return null;
  const eta = (d.bytes_total - d.bytes_done) / speed;
  return Number.isFinite(eta) && eta >= 0 ? eta : null;
}

export function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond >= BYTES_PER_GB) return `${(bytesPerSecond / BYTES_PER_GB).toFixed(1)} GB/s`;
  if (bytesPerSecond >= BYTES_PER_MB) {
    const mb = bytesPerSecond / BYTES_PER_MB;
    return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB/s`;
  }
  return `${Math.max(1, Math.round(bytesPerSecond / BYTES_PER_KB))} KB/s`;
}

/** "about 40 s left", "about 5 min left", "about 1 h 05 min left". */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds > MAX_ETA_SECONDS) return "more than 99 h left";
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `about ${s} s left`;
  const min = Math.round(s / 60);
  if (min < 60) return `about ${min} min left`;
  return `about ${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min left`;
}

function formatSize(bytes: number, asGb: boolean): string {
  return asGb ? (bytes / BYTES_PER_GB).toFixed(1) : (bytes / BYTES_PER_MB).toFixed(1);
}

/** "2.1 / 14.6 GB (14%) - file 1 of 3 - 38 MB/s - about 5 min left"; speed and ETA only when known. */
export function downloadText(d: Download, speed: number | null): string {
  const known = d.bytes_total > 0;
  const gb = (known ? d.bytes_total : d.bytes_done) >= BYTES_PER_GB;
  const unit = gb ? "GB" : "MB";
  const pct = downloadPercent(d);
  const size = known ? `${formatSize(d.bytes_done, gb)} / ${formatSize(d.bytes_total, gb)} ${unit}` : `${formatSize(d.bytes_done, gb)} ${unit}`;
  const parts = [pct === null ? size : `${size} (${pct}%)`, `file ${Math.min(d.files_done + 1, d.files_total)} of ${d.files_total}`];
  if (speed !== null) {
    parts.push(formatSpeed(speed));
    const eta = etaSeconds(d, speed);
    if (eta !== null) parts.push(formatEta(eta));
  }
  return parts.join(" - ");
}

export function formatVram(used: number | null, total: number | null): string {
  if (used === null || total === null || total <= 0) return DASH;
  return `${(used / MB_PER_GB).toFixed(1)} / ${(total / MB_PER_GB).toFixed(1)} GB`;
}

export function formatQueue(q: { running: number; pending: number } | null): string {
  return q === null ? DASH : `${q.running} running, ${q.pending} waiting`;
}

export type Tone = "ok" | "busy" | "warn" | "bad" | "idle";
const STATE_INFO: Record<string, { label: string; tone: Tone }> = {
  none: { label: "No instance running", tone: "idle" },
  creating: { label: "Creating instance", tone: "busy" },
  booting: { label: "Booting", tone: "busy" },
  downloading: { label: "Downloading models", tone: "busy" },
  ready: { label: "Ready", tone: "ok" },
  "idle-warning": { label: "Ready, will shut down soon (idle)", tone: "warn" },
  stopping: { label: "Stopping", tone: "warn" },
  failed: { label: "Failed", tone: "bad" },
  destroy_failed: { label: "Could not destroy the instance", tone: "bad" },
};

export function stateInfo(state: string, percent: number | null = null): { label: string; tone: Tone } {
  const info = STATE_INFO[state] ?? { label: state, tone: "warn" as Tone };
  if (state === "downloading" && percent !== null) return { ...info, label: `${info.label}: ${percent}%` };
  return info;
}

// ---- time passing between polls ----

/** A server-side "seconds left" reduced by the time since it was fetched. */
export function countdown(secondsAtFetch: number | null, elapsedMs: number): number | null {
  return secondsAtFetch === null ? null : Math.max(0, secondsAtFetch - Math.floor(elapsedMs / 1000));
}

export interface ClockView { uptime: string; cost: string; idle: string; failsafe: string; hardCap: string }

export function clockView(s: ApiState, elapsedMs: number): ClockView {
  const grow = s.uptime_s === null ? null : s.uptime_s + elapsedMs / 1000;
  const cost = s.cost_so_far === null ? null : s.cost_so_far + (s.dph === null ? 0 : (s.dph * elapsedMs) / 1000 / SECONDS_PER_HOUR);
  return {
    uptime: formatDuration(grow),
    cost: formatCost(cost),
    idle: formatDuration(countdown(s.remaining.idle_s, elapsedMs)),
    failsafe: formatDuration(countdown(s.remaining.failsafe_s, elapsedMs)),
    hardCap: formatDuration(countdown(s.remaining.hard_cap_s, elapsedMs)),
  };
}

// ---- controls ----

const GENERATE_STATES = new Set(["ready", "idle-warning"]);
const EXTEND_STATES = new Set(["booting", "downloading", "ready", "idle-warning"]);

export interface Controls {
  showAdmin: boolean;
  canStart: boolean;
  canExtend: boolean;
  canDestroy: boolean;
  canGenerate: boolean;
}

export function controls(s: ApiState | null, busy: boolean, jobPending: boolean): Controls {
  const admin = s?.role === "admin";
  const state = s?.state ?? "";
  return {
    showAdmin: admin,
    canStart: admin && state === "none" && !busy,
    canExtend: admin && EXTEND_STATES.has(state) && !busy,
    canDestroy: admin && state !== "none" && state !== "stopping" && !busy,
    canGenerate: s !== null && GENERATE_STATES.has(state) && !jobPending,
  };
}

/** Delay before the next GET /api/state. */
export function pollIntervalMs(state: string | null, hidden: boolean, failures: number): number {
  const base = hidden ? STATE_POLL_HIDDEN_MS : state === "none" ? STATE_POLL_IDLE_MS : STATE_POLL_MS;
  return Math.min(STATE_POLL_MAX_MS, base * 2 ** Math.min(failures, 6));
}

// ---- generate form ----

export type SeedResult = { ok: true; value: number | undefined } | { ok: false; message: string };

export function parseSeed(text: string): SeedResult {
  const t = text.trim();
  if (t === "") return { ok: true, value: undefined };
  if (!SEED_TEXT.test(t) || !Number.isSafeInteger(Number(t))) return { ok: false, message: "Seed must be a whole number, or empty for random." };
  return { ok: true, value: Number(t) };
}

export function isJobId(id: unknown): id is string {
  return typeof id === "string" && JOB_ID.test(id);
}

/** Image URL from a validated job id and a numeric index; null if either is unusable. */
export function imageUrl(id: string, index: unknown): string | null {
  if (!isJobId(id) || typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > MAX_IMAGE_INDEX) return null;
  return `/api/image/${id}/${index}`;
}

export function presetLabel(p: Preset): string {
  return `${p.name} (${p.steps} steps)`;
}

export function sizeLabel(s: Size): string {
  return `${s.name} (${s.width}×${s.height})`;
}

export function characterCount(text: string): string {
  return `${text.length} character${text.length === 1 ? "" : "s"}`;
}

/** Plain text for a failed request: the API's message, else a generic line. */
export function errorText(status: number, body: unknown): string {
  if (isObj(body) && isObj(body["error"]) && typeof body["error"]["message"] === "string" && body["error"]["message"] !== "") {
    return body["error"]["message"];
  }
  if (status === 401) return "You are signed out. Reload the page to sign in again.";
  if (status === 403) return "Your account may not do this.";
  return `The request failed (HTTP ${status}).`;
}

// ---- login screens ----

export const LOGIN_FAILED_MESSAGE = "Login failed, please try again.";
export const SESSION_EXPIRED_MESSAGE = "Your session expired, please log in again.";
// Fixed allowlist keyed by the codes of LOGIN_ERROR_CODES (apps/web/src/auth-routes.ts). Every
// other code, including session_too_large, gets the generic message.
const LOGIN_ERROR_MESSAGES = new Map<string, string>([["access_denied", "This account has no access."]]);

/** Human message for a `login_error` URL value. Only fixed strings come back, never the input. */
export function loginErrorMessage(code: string | null): string | null {
  if (code === null) return null;
  return LOGIN_ERROR_MESSAGES.get(code) ?? LOGIN_FAILED_MESSAGE;
}

/** The `login_error` value of a location search string (null when absent). */
export function loginErrorParam(search: string): string | null {
  return new URLSearchParams(search).get(LOGIN_ERROR_PARAM);
}

/** The same search string without `login_error`; "" when nothing else is left. */
export function withoutLoginError(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(LOGIN_ERROR_PARAM);
  const rest = params.toString();
  return rest === "" ? "" : `?${rest}`;
}

export interface Me { name: string; username: string; role: Role | "none" }
export type Screen = "app" | "login" | "noaccess" | "error";

/** Which screen an /api/me answer means: 200 with a usable body -> app, 401 -> login, 403 -> no access. */
export function screenForMe(status: number, json: unknown): { screen: Screen; me: Me | null } {
  if (status === 401) return { screen: "login", me: null };
  if (status === 403) return { screen: "noaccess", me: null };
  if (status !== 200 || !isObj(json)) return { screen: "error", me: null };
  const username = typeof json["username"] === "string" ? json["username"] : "";
  const name = typeof json["name"] === "string" && json["name"] !== "" ? json["name"] : username;
  const role = json["role"];
  if (role !== "admin" && role !== "member") return { screen: "noaccess", me: null };
  return { screen: "app", me: { name, username, role } };
}
