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
  edit: "/api/edit",
  credit: "/api/credit",
  history: "/api/history",
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
export const CONSOLE_COLLAPSED_KEY = "vast-comfy.console-collapsed"; // config-lint: ok (browser storage key, not configuration)
export const HISTORY_COLLAPSED_KEY = "vast-comfy.history-collapsed"; // config-lint: ok (browser storage key, not configuration)
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
export interface Resolution { name: string; value: number }
/** What the server offers for edit with reference images (null in the state when edit is off). */
export interface EditInfo { max_references: number; max_bytes: number; max_pixels: number; types: string[]; resolutions: Resolution[] }
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
  edit: EditInfo | null;
}

export interface Estimate { gpu_name: string | null; dph: number; horizon_hours: number; max_cost: number }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const EDIT_TYPES = ["png", "jpeg", "webp"];
const posInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

function parseEdit(v: unknown): EditInfo | null {
  if (!isObj(v)) return null;
  const { max_references: maxRefs, max_bytes: maxBytes, max_pixels: maxPixels } = v;
  if (!posInt(maxRefs) || !posInt(maxBytes) || !posInt(maxPixels)) return null;
  const types = v["types"];
  if (!Array.isArray(types) || types.length === 0 || !types.every((t) => typeof t === "string" && EDIT_TYPES.includes(t))) return null;
  const res = v["resolutions"];
  if (!Array.isArray(res) || res.length === 0) return null;
  const resolutions: Resolution[] = [];
  for (const r of res) {
    if (!isObj(r) || typeof r["name"] !== "string" || r["name"] === "" || !posInt(r["value"])) return null;
    resolutions.push({ name: r["name"], value: r["value"] });
  }
  return { max_references: maxRefs, max_bytes: maxBytes, max_pixels: maxPixels, types: types as string[], resolutions };
}

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
    edit: parseEdit(json["edit"]),
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

/** How often the admin page asks for the Vast credit; the server caches it for about as long. */
export const CREDIT_REFRESH_MS = 60_000;

/** "$4.54", or "-$1.25" when the credit is used up; a rounding to zero never shows a minus sign. */
export function formatCredit(usd: number): string {
  const text = Math.abs(usd).toFixed(2);
  return usd < 0 && text !== "0.00" ? `-$${text}` : `$${text}`;
}

export interface CreditReading { credit: number; asOf: number | null }

/** Check GET /api/credit; null when the credit is not a usable number. */
export function parseCredit(json: unknown): CreditReading | null {
  if (!isObj(json)) return null;
  const credit = num(json["credit"]);
  if (credit === null) return null;
  return { credit, asOf: num(json["as_of"]) };
}

/** True when the credit should be read again: the interval is over and no read is running. */
export function creditDue(lastAskedAt: number, now: number, running: boolean): boolean {
  return !running && now - lastAskedAt >= CREDIT_REFRESH_MS;
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
  /** Generating is possible and the server offers edit with reference images. */
  canEdit: boolean;
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
    canEdit: s !== null && s.edit !== null && GENERATE_STATES.has(state) && !jobPending,
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

// ---- edit: reference images ----

const BYTES_PER_MIB = 1024 * 1024;
const MAX_NAME_SHOWN = 40;
const DATA_URL = /^data:[^,;]*;base64,([A-Za-z0-9+/]+={0,2})$/;

/** The value of the file input's accept attribute for the types the server lists. */
export function acceptTypes(edit: EditInfo): string {
  return edit.types.map((t) => `image/${t}`).join(",");
}

/** "8.0 MB" for a byte count (the server limit is a power-of-two size). */
export function formatMegabytes(bytes: number): string {
  return `${(bytes / BYTES_PER_MIB).toFixed(1)} MB`;
}

const typeNames = (edit: EditInfo): string => edit.types.map((t) => t.toUpperCase()).join(", ");

export function referenceHint(edit: EditInfo): string {
  return `Up to ${edit.max_references} images (${typeNames(edit)}), ${formatMegabytes(edit.max_bytes)} each. Refer to them as <image1>, <image2> in the prompt.`;
}

export interface PickedFile { name: string; type: string; size: number }
export interface PickResult { /** Indexes into the picked list, in order. */ accepted: number[]; errors: string[] }

const shown = (name: string): string => (name.length > MAX_NAME_SHOWN ? `${name.slice(0, MAX_NAME_SHOWN)}…` : name);

/**
 * Which of the picked files can be attached, given how many are attached already. The server checks
 * everything again (magic bytes, pixels); this only saves a round trip for the obvious mistakes.
 */
export function pickReferences(existing: number, picked: readonly PickedFile[], edit: EditInfo): PickResult {
  const accepted: number[] = [];
  const errors: string[] = [];
  let full = false;
  picked.forEach((f, i) => {
    if (!edit.types.some((t) => f.type === `image/${t}`)) {
      errors.push(`${shown(f.name)}: only ${typeNames(edit)} images are accepted.`);
    } else if (f.size <= 0) {
      errors.push(`${shown(f.name)}: the file is empty.`);
    } else if (f.size > edit.max_bytes) {
      errors.push(`${shown(f.name)}: larger than ${formatMegabytes(edit.max_bytes)}.`);
    } else if (existing + accepted.length >= edit.max_references) {
      if (!full) errors.push(`At most ${edit.max_references} images can be attached.`);
      full = true;
    } else {
      accepted.push(i);
    }
  });
  return { accepted, errors };
}

/** The base64 payload of a FileReader data URL, or null for anything that is not one. */
export function base64FromDataUrl(url: string): string | null {
  return DATA_URL.exec(url)?.[1] ?? null;
}

export function editLabel(presetLabelText: string, resolution: string, references: number): string {
  return `Edit: ${presetLabelText}, ${resolution}, ${references} reference${references === 1 ? "" : "s"}`;
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

// ---- boot console (admin only) ----

export const CONSOLE_POLL_MS = 3_000;
export const CONSOLE_POLL_MAX_MS = 30_000; // ceiling when the console endpoint keeps failing
export const CONSOLE_VIEW_MAX_LINES = 2_000; // the page keeps at most this many lines (the newest)
const CONSOLE_BOTTOM_SLACK_PX = 24; // closer than this to the end counts as "at the bottom"
export const CONSOLE_PATH = "/api/console";

export type PhaseStatus = "pending" | "running" | "done" | "failed";
export interface ConsolePhase { id: string; name: string; status: PhaseStatus }
export interface ConsoleLine { seq: number; t: number; source: string; text: string }
export interface ConsolePayload {
  generation: number;
  instance: { state: string; ended: boolean; ended_reason: string | null };
  phases: ConsolePhase[];
  lines: ConsoleLine[];
  last_seq: number;
  truncated: boolean;
  source_error: string | null;
}

const PHASE_STATUSES = new Set<string>(["pending", "running", "done", "failed"]);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Check GET /api/console; null when the payload is unusable. Bad lines or phases are dropped. */
export function parseConsole(json: unknown): ConsolePayload | null {
  if (!isObj(json) || !isObj(json["instance"])) return null;
  const inst = json["instance"];
  if (typeof inst["state"] !== "string" || typeof inst["ended"] !== "boolean") return null;
  if (!isCount(json["generation"]) || !isCount(json["last_seq"]) || !Array.isArray(json["lines"]) || !Array.isArray(json["phases"])) return null;
  return {
    generation: json["generation"],
    instance: { state: inst["state"], ended: inst["ended"], ended_reason: typeof inst["ended_reason"] === "string" ? inst["ended_reason"] : null },
    phases: json["phases"].flatMap((p: unknown) =>
      isObj(p) && typeof p["id"] === "string" && typeof p["name"] === "string" && typeof p["status"] === "string" && PHASE_STATUSES.has(p["status"])
        ? [{ id: p["id"], name: p["name"], status: p["status"] as PhaseStatus }]
        : [],
    ),
    lines: json["lines"].flatMap((l: unknown) =>
      isObj(l) && isCount(l["seq"]) && typeof l["text"] === "string"
        ? [{ seq: l["seq"], t: num(l["t"]) ?? 0, source: typeof l["source"] === "string" ? l["source"] : "", text: l["text"] }]
        : [],
    ),
    last_seq: json["last_seq"],
    truncated: json["truncated"] === true,
    source_error: typeof json["source_error"] === "string" ? json["source_error"] : null,
  };
}

export interface ConsoleView {
  generation: number | null;
  lines: ConsoleLine[];
  /** Highest sequence number received: the `after` of the next request. */
  lastSeq: number;
  /** Lines with seq <= this were hidden by "Clear view". */
  clearedUpTo: number;
}

export const EMPTY_CONSOLE_VIEW: ConsoleView = { generation: null, lines: [], lastSeq: 0, clearedUpTo: 0 };

/**
 * Merge an answer into the view: only lines newer than what is held are added (no duplicates,
 * no going back), a new generation (a new Start) replaces everything, and the newest lines are
 * kept when the cap is exceeded.
 */
export function mergeConsole(view: ConsoleView, payload: ConsolePayload, cap = CONSOLE_VIEW_MAX_LINES): ConsoleView {
  const fresh = view.generation !== null && view.generation !== payload.generation;
  const base: ConsoleView = fresh ? { ...EMPTY_CONSOLE_VIEW, generation: payload.generation } : { ...view, generation: payload.generation };
  let top = base.lines.length > 0 ? base.lines[base.lines.length - 1]!.seq : 0;
  const added: ConsoleLine[] = [];
  for (const l of payload.lines) {
    if (l.seq > top) {
      added.push(l);
      top = l.seq;
    }
  }
  const lines = base.lines.concat(added);
  return {
    generation: base.generation,
    lines: lines.length > cap ? lines.slice(lines.length - cap) : lines,
    lastSeq: Math.max(base.lastSeq, payload.last_seq, top),
    clearedUpTo: base.clearedUpTo,
  };
}

/** "Clear view": hide what is shown now; later lines still appear. */
export function clearConsoleView(view: ConsoleView): ConsoleView {
  return { ...view, clearedUpTo: view.lastSeq };
}

export function visibleLines(view: ConsoleView): ConsoleLine[] {
  return view.lines.filter((l) => l.seq > view.clearedUpTo);
}

/** True when the scroll position is at (or within a few pixels of) the end of the log. */
export function isNearBottom(scrollTop: number, clientHeight: number, scrollHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= CONSOLE_BOTTOM_SLACK_PX;
}

/** Short UTC time of a line, HH:MM:SS. */
export function lineTime(t: number): string {
  if (!Number.isFinite(t) || t <= 0) return "--:--:--";
  return new Date(t * 1000).toISOString().slice(11, 19);
}

/** One line as plain text, as shown (time, source tag, text). */
export function lineText(l: ConsoleLine): string {
  return `${lineTime(l.t)} [${l.source}] ${l.text}`;
}

/** The text copied or downloaded: exactly the visible lines. */
export function consoleExport(lines: readonly ConsoleLine[]): string {
  return lines.map(lineText).join("\n") + (lines.length > 0 ? "\n" : "");
}

/** Delay before the next console poll; null while it must not poll (tab hidden). */
export function consoleDelayMs(hidden: boolean, failures: number): number | null {
  if (hidden) return null;
  return Math.min(CONSOLE_POLL_MAX_MS, CONSOLE_POLL_MS * 2 ** Math.min(failures, 6));
}

/** Whether to keep polling after an answer: not once there is no instance any more. */
export function consoleKeepsPolling(stateName: string | null): boolean {
  return stateName !== null && stateName !== "none";
}

/** The card shows while an instance exists, and for the last ended one until a new Start. */
export function consoleCardVisible(role: Role | null, payload: ConsolePayload | null): boolean {
  if (role !== "admin" || payload === null) return false;
  return payload.instance.state !== "none" || payload.instance.ended;
}

const END_REASON_TEXT: Record<string, string> = {
  destroyed: "destroyed from the page",
  start_failed: "the start failed",
  hard_cap: "reached the hard cap",
  boot_timeout: "the boot took too long",
  unreachable: "the agent stayed unreachable",
  destroy_retry: "destroyed after a retry",
  destroy_requested: "destroy requested",
  vanished: "it vanished from Vast",
  never_created: "it was never created on Vast",
  gone: "it is gone",
};

export function endedText(reason: string | null): string {
  const why = reason === null ? undefined : END_REASON_TEXT[reason];
  return why === undefined ? "Instance ended." : `Instance ended: ${why}.`;
}

export const PHASE_MARKS: Record<PhaseStatus, string> = { pending: "○", running: "◐", done: "✓", failed: "✗" };

// Plain sentences per phase id (ids are BOOT_STEPS in apps/core/src/console.ts, plus image_pull).
const PHASE_SENTENCES: Record<string, string> = {
  image_pull: "Pulling the container image, usually 1-3 minutes",
  install_tools: "Installing tools, usually under a minute",
  failsafe: "Starting the failsafe timer, a few seconds",
  tailscale: "Installing tools and joining Tailscale, usually 2-4 minutes",
  agent: "Starting the agent, usually under a minute",
  nodes: "Installing ComfyUI nodes, usually 1-3 minutes",
  models: "Downloading models, this can take several minutes",
  comfyui: "Starting ComfyUI, usually 1-2 minutes",
};

/**
 * A plain sentence for the phase that is running now, or null when boot is not in progress
 * (no instance, ended, ready, failed, or no phase is running).
 */
export function bootSentence(payload: ConsolePayload | null): string | null {
  if (payload === null || payload.instance.ended || payload.instance.state === "none") return null;
  if (payload.phases.some((p) => p.status === "failed")) return null;
  const running = payload.phases.find((p) => p.status === "running");
  if (running === undefined || running.id === "ready") return null;
  const sentence = PHASE_SENTENCES[running.id];
  return sentence === undefined ? `${running.name}, in progress` : sentence;
}

// ---- usage history (admin only) ----

/** One session of GET /api/history (contracts/web.openapi.json HistoryEntry). */
export interface UsageEntry {
  vast_instance_id: number | null;
  gpu_name: string | null;
  dph: number | null;
  started_at: number;
  ready_at: number | null;
  ended_at: number | null;
  duration_s: number;
  estimated_cost: number | null;
  started_by: string | null;
  reason: string | null;
  stop_by: string | null;
  active: boolean;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOrNull = (v: unknown): boolean => v === null || isNum(v);
const strOrNull = (v: unknown): boolean => v === null || typeof v === "string";

/** The entries, or null when the body is not a usable history. */
export function parseHistory(json: unknown): UsageEntry[] | null {
  if (json === null || typeof json !== "object") return null;
  const list = (json as { entries?: unknown }).entries;
  if (!Array.isArray(list)) return null;
  const ok = list.every((e: unknown) => {
    if (e === null || typeof e !== "object") return false;
    const r = e as Record<string, unknown>;
    return (
      numOrNull(r["vast_instance_id"]) && strOrNull(r["gpu_name"]) && numOrNull(r["dph"]) && isNum(r["started_at"]) &&
      numOrNull(r["ready_at"]) && numOrNull(r["ended_at"]) && isNum(r["duration_s"]) && numOrNull(r["estimated_cost"]) &&
      strOrNull(r["started_by"]) && strOrNull(r["reason"]) && strOrNull(r["stop_by"]) && typeof r["active"] === "boolean"
    );
  });
  return ok ? (list as UsageEntry[]) : null;
}

const STOP_REASON_TEXT: Record<string, string> = {
  destroy_button: "Destroy button",
  idle_timeout: "Idle timeout",
  failsafe_deadline: "Failsafe deadline",
  hard_cap: "Hard cap",
  boot_failed: "Boot failed",
  agent_unreachable: "Agent unreachable",
  gone: "Disappeared",
};

/** Why a session stopped, in plain words ("Destroy button (by ayu)"); "Running" while active. */
export function stopReasonText(reason: string | null, stopBy: string | null, active: boolean): string {
  if (active) return "Running";
  const text = reason === null ? undefined : STOP_REASON_TEXT[reason];
  if (text === undefined) return "Stopped";
  return reason === "destroy_button" && stopBy !== null && stopBy !== "" ? `${text} (by ${stopBy})` : text;
}

/** The history is read once, then again only when the state changes to none or ready (no polling). */
export function historyRefreshDue(previous: string | null, next: string): boolean {
  if (previous === null) return true;
  return previous !== next && (next === "none" || next === "ready");
}

/** Local "YYYY-MM-DD HH:MM" of an epoch second. */
export function historyTime(t: number): string {
  if (!Number.isFinite(t) || t <= 0) return DASH;
  const d = new Date(t * 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
