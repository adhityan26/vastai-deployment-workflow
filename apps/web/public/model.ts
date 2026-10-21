// Pure logic of the page: API shapes, formatting, button rules and polling choices. Nothing
// here touches the DOM, the network or timers, so it can be tested without a browser.

// Polling is derived from the page state; the API does not report an interval.
export const STATE_POLL_MS = 5_000;
export const STATE_POLL_IDLE_MS = 15_000; // no instance: nothing changes quickly
export const STATE_POLL_HIDDEN_MS = 30_000; // tab in the background
export const STATE_POLL_MAX_MS = 60_000; // ceiling when the API keeps failing
export const JOB_POLL_MS = 2_000;
export const JOB_POLL_FAST_MS = 1_000; // while a job runs and the server answers quickly (the step counter moves)
const JOB_POLL_FAST_LATENCY_MS = 500;
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
  upscale: "/api/upscale",
  video: "/api/video",
  credit: "/api/credit",
  offers: "/api/offers",
  history: "/api/history",
  gallery: "/api/gallery",
  galleryDelete: "/api/gallery/delete",
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
// The menu entry the user chose last (an entry id only; checked against the current menu before use).
export const TOOL_STORAGE_KEY = "vast-comfy.tool"; // config-lint: ok (browser storage key, not configuration)
// Layout rule (the same breakpoint as style.css): from this width the menu is a fixed sidebar, below it a drawer.
export const WIDE_SCREEN_QUERY = "(min-width: 900px)";
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
export interface EditInfo { max_references: number; max_bytes: number; max_pixels: number; types: string[]; resolutions: Resolution[]; /** Output sizes an edit may ask for; empty when none (then the result follows the first image). */ sizes: Size[] }
export type Mode = "generate" | "edit";
/** The page's modes: the two that take styles, upscale (one image in, a bigger one out) and video. */
export type PageMode = Mode | "upscale" | "video";
export type StyleValue = number | string | boolean;
/** One parameter of a style, as the server lists it (limits only; where it goes stays on the server). */
export interface StyleParam {
  id: string;
  title: string;
  type: "float" | "int" | "choice" | "bool";
  min?: number;
  max?: number;
  step?: number;
  choices?: string[];
  default: StyleValue;
}
/** How many reference images an edit style needs and what each is for, in order. */
export interface StyleReferences { min: number; max: number; labels: string[] }
export interface StyleInfo {
  id: string;
  title: string;
  modes: Mode[];
  params: StyleParam[];
  /** The style has its own prompt text: the user's prompt is optional notes. */
  promptOptional: boolean;
  references: StyleReferences | null;
  hint: string | null;
  /** What the form pre-fills when the style is chosen (the user can change each); only what the style sets. */
  defaults: StyleDefaults;
}
/** A style's suggested form values (names are checked against the current lists before use). */
export interface StyleDefaults {
  negativePrompt?: string;
  cfg?: number;
  preset?: string;
  size?: string;
  resolution?: string;
}
/** The guidance (cfg) range the server accepts; null in the state when it offers none. */
export interface GuidanceInfo { min: number; max: number; step: number; default: number }
/** Which optional knobs a mode's workflow takes. */
export interface Knobs { negativePrompt: boolean; cfg: boolean }
export interface AdvancedInfo { generate: Knobs; edit: Knobs; negativeMaxChars: number }
/** What the server offers for upscale (null in the state when upscale is off). */
export interface UpscaleInfo { scales: string[]; max_bytes: number; max_pixels: number; types: string[] }
/** One video length the server offers: its name and about how many seconds it lasts. */
export interface VideoDurationInfo { name: string; seconds: number }
/** What the server offers for video (null in the state when video is off); the start image is optional. */
export interface VideoInfo { sizes: Size[]; durations: VideoDurationInfo[]; max_bytes: number; max_pixels: number; types: string[] }
export interface UnknownInstance { vast_instance_id: number; actual_status: string | null; start_date: number; dph: number }

export interface ApiState {
  state: string;
  role: Role;
  agent: { queue: { running: number; pending: number } | null; gpu: { vram_total_mb: number | null; vram_used_mb: number | null } } | null;
  agent_unreachable: boolean;
  failed: { reason: string | null } | null;
  destroy_failed: { error: string } | null;
  /** The newest start failed after Start returned (fixed code plus the server's plain text). */
  start_failure: { code: string; message: string; server: ServerView | null; measured_mb_s: number | null } | null;
  /** Where the active instance's server is. */
  server: ServerView | null;
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
  /** Save and the gallery are available (the server has an object store). */
  gallery: boolean;
  styles: StyleInfo[];
  upscale: UpscaleInfo | null;
  /** Video (text to video, or image to video with one start image); null when the server does not offer it. */
  video: VideoInfo | null;
  guidance: GuidanceInfo | null;
  /** The Advanced section per mode (negative prompt, guidance). */
  advanced: AdvancedInfo;
  /** The tool menu as the server lists it; null when it sends none (the page then builds one: usableMenu). */
  menu: MenuInfo | null;
}

export interface Estimate {
  gpu_name: string | null;
  dph: number;
  horizon_hours: number;
  max_cost: number;
  location: string | null;
  down_mbps: number | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// ---- where the rented server is ----

/** What the page shows about a server: its location (plain text) and download speed. */
export interface ServerView { location: string | null; down_mbps: number | null }

const MAX_LOCATION = 64; // the API sends at most 64 characters (LOCATION_MAX in apps/core/src/vast.ts)

/** A location the API may send, else null (shown with textContent only). */
function locationOf(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" && v.length <= MAX_LOCATION ? v : null;
}

function mbpsOf(v: unknown): number | null {
  const n = num(v);
  return n !== null && n >= 0 ? Math.round(n) : null;
}

/** The server object of the state, an estimate or a GPU row; null when nothing usable is in it. */
export function parseServer(v: unknown): ServerView | null {
  if (!isObj(v)) return null;
  const out = { location: locationOf(v["location"]), down_mbps: mbpsOf(v["down_mbps"]) };
  return out.location === null && out.down_mbps === null ? null : out;
}

/** "Quebec, CA, 860 Mbps down"; the missing parts are left out; null when nothing is known. */
export function serverText(s: ServerView | null): string | null {
  if (s === null) return null;
  const parts: string[] = [];
  if (s.location !== null) parts.push(s.location);
  if (s.down_mbps !== null) parts.push(`${s.down_mbps} Mbps down`);
  return parts.length === 0 ? null : parts.join(", ");
}

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
  const sizes: Size[] = Array.isArray(v["sizes"])
    ? v["sizes"].flatMap((z): Size[] =>
        isObj(z) && typeof z["name"] === "string" && z["name"] !== "" && posInt(z["width"]) && posInt(z["height"]) ? [{ name: z["name"], width: z["width"], height: z["height"] }] : [],
      )
    : [];
  return { max_references: maxRefs, max_bytes: maxBytes, max_pixels: maxPixels, types: types as string[], resolutions, sizes };
}

function parseStyleParam(v: unknown): StyleParam | null {
  if (!isObj(v) || typeof v["id"] !== "string" || v["id"] === "" || typeof v["title"] !== "string") return null;
  const type = v["type"];
  const id = v["id"];
  const title = v["title"];
  const d = v["default"];
  if (type === "bool") return typeof d === "boolean" ? { id, title, type, default: d } : null;
  if (type === "choice") {
    const ch = v["choices"];
    if (!Array.isArray(ch) || ch.length === 0 || !ch.every((c) => typeof c === "string")) return null;
    return typeof d === "string" && ch.includes(d) ? { id, title, type, choices: ch as string[], default: d } : null;
  }
  if (type === "float" || type === "int") {
    const min = num(v["min"]);
    const max = num(v["max"]);
    const step = num(v["step"]);
    const dn = num(d);
    if (min === null || max === null || step === null || dn === null || step <= 0 || min > max || dn < min || dn > max) return null;
    return { id, title, type, min, max, step, default: dn };
  }
  return null;
}

const STYLE_REFERENCES_MAX = 16;

/** A style's reference rule: null when it has none, undefined when it is unusable (the style is left out). */
function parseStyleReferences(v: unknown): StyleReferences | null | undefined {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) return undefined;
  const { min, max, labels } = v;
  if (!Number.isInteger(min) || !Number.isInteger(max) || (min as number) < 1 || (min as number) > (max as number) || (max as number) > STYLE_REFERENCES_MAX) return undefined;
  const list = Array.isArray(labels) ? labels.filter((l): l is string => typeof l === "string").slice(0, max as number) : [];
  return { min: min as number, max: max as number, labels: list };
}

/** Only well-typed defaults are kept; anything else is simply not pre-filled. */
function parseStyleDefaults(v: unknown): StyleDefaults {
  if (!isObj(v)) return {};
  const out: StyleDefaults = {};
  const text = (x: unknown): x is string => typeof x === "string" && x !== "";
  if (text(v["negative_prompt"])) out.negativePrompt = v["negative_prompt"];
  if (num(v["cfg"]) !== null) out.cfg = v["cfg"] as number;
  if (text(v["preset"])) out.preset = v["preset"];
  if (text(v["size"])) out.size = v["size"];
  if (text(v["resolution"])) out.resolution = v["resolution"];
  return out;
}

function parseStyles(v: unknown): StyleInfo[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((st) => {
    if (!isObj(st) || typeof st["id"] !== "string" || st["id"] === "" || typeof st["title"] !== "string" || !Array.isArray(st["modes"])) return [];
    const modes = st["modes"].filter((m): m is Mode => m === "generate" || m === "edit");
    const rawParams = Array.isArray(st["params"]) ? st["params"] : [];
    const params = rawParams.map(parseStyleParam);
    // A style whose panel cannot be drawn faithfully is left out rather than drawn wrong.
    if (modes.length === 0 || params.some((p) => p === null)) return [];
    const references = parseStyleReferences(st["references"]);
    if (references === undefined) return [];
    return [{
      id: st["id"],
      title: st["title"],
      modes,
      params: params as StyleParam[],
      promptOptional: st["prompt_optional"] === true,
      references,
      hint: typeof st["hint"] === "string" && st["hint"] !== "" ? st["hint"] : null,
      defaults: parseStyleDefaults(st["defaults"]),
    }];
  });
}

function parseUpscale(v: unknown): UpscaleInfo | null {
  if (!isObj(v) || !posInt(v["max_bytes"]) || !posInt(v["max_pixels"])) return null;
  const { scales, types } = v;
  if (!Array.isArray(scales) || scales.length === 0 || !scales.every((x) => typeof x === "string" && x !== "")) return null;
  if (!Array.isArray(types) || types.length === 0 || !types.every((t) => typeof t === "string" && EDIT_TYPES.includes(t))) return null;
  return { scales: scales as string[], max_bytes: v["max_bytes"], max_pixels: v["max_pixels"], types: types as string[] };
}

const MAX_VIDEO_SECONDS = 600;

/** The video offer of the state; null when it is missing or anything in it is unusable. */
function parseVideo(v: unknown): VideoInfo | null {
  if (!isObj(v) || !posInt(v["max_bytes"]) || !posInt(v["max_pixels"])) return null;
  const { sizes, durations, types } = v;
  if (!Array.isArray(types) || types.length === 0 || !types.every((t) => typeof t === "string" && EDIT_TYPES.includes(t))) return null;
  if (!Array.isArray(sizes) || sizes.length === 0 || !Array.isArray(durations) || durations.length === 0) return null;
  const sizeList: Size[] = [];
  for (const z of sizes) {
    if (!isObj(z) || typeof z["name"] !== "string" || z["name"] === "" || !posInt(z["width"]) || !posInt(z["height"])) return null;
    sizeList.push({ name: z["name"], width: z["width"], height: z["height"] });
  }
  const durationList: VideoDurationInfo[] = [];
  for (const d of durations) {
    const seconds = d && isObj(d) ? d["seconds"] : undefined;
    if (!isObj(d) || typeof d["name"] !== "string" || d["name"] === "" || !Number.isInteger(seconds) || (seconds as number) < 0 || (seconds as number) > MAX_VIDEO_SECONDS) return null;
    durationList.push({ name: d["name"], seconds: seconds as number });
  }
  return { sizes: sizeList, durations: durationList, max_bytes: v["max_bytes"], max_pixels: v["max_pixels"], types: types as string[] };
}

function parseGuidance(v: unknown): GuidanceInfo | null {
  if (!isObj(v)) return null;
  const [min, max, step, def] = [num(v["min"]), num(v["max"]), num(v["step"]), num(v["default"])];
  if (min === null || max === null || step === null || def === null || step <= 0 || min > max || def < min || def > max) return null;
  return { min, max, step, default: def };
}

const NO_KNOBS: Knobs = { negativePrompt: false, cfg: false };
/** Longest negative prompt the page lets the user type when the server does not say (its default). */
const NEGATIVE_MAX_FALLBACK = 1000;

function parseKnobs(v: unknown): Knobs {
  return isObj(v) ? { negativePrompt: v["negative_prompt"] === true, cfg: v["cfg"] === true } : NO_KNOBS;
}

/** Missing or malformed means "no knobs": the page then sends exactly what it sent before. */
function parseAdvanced(v: unknown): AdvancedInfo {
  if (!isObj(v)) return { generate: NO_KNOBS, edit: NO_KNOBS, negativeMaxChars: NEGATIVE_MAX_FALLBACK };
  return { generate: parseKnobs(v["generate"]), edit: parseKnobs(v["edit"]), negativeMaxChars: posInt(v["negative_prompt_max_chars"]) ? v["negative_prompt_max_chars"] : NEGATIVE_MAX_FALLBACK };
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
  const sf = isObj(json["start_failure"]) ? json["start_failure"] : null;
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
    start_failure:
      sf && typeof sf["code"] === "string"
        ? {
            code: sf["code"],
            message: typeof sf["message"] === "string" ? sf["message"] : "",
            server: parseServer(sf["server"]),
            measured_mb_s: measuredMbS(sf["measured_mb_s"]),
          }
        : null,
    server: parseServer(json["server"]),
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
    gallery: json["gallery"] === true,
    styles: parseStyles(json["styles"]),
    upscale: parseUpscale(json["upscale"]),
    video: parseVideo(json["video"]),
    guidance: parseGuidance(json["guidance"]),
    advanced: parseAdvanced(json["advanced"]),
    menu: parseMenu(json["menu"]),
  };
}

export function parseEstimate(json: unknown): Estimate | null {
  if (!isObj(json)) return null;
  const dph = num(json["dph"]);
  const hours = num(json["horizon_hours"]);
  const max = num(json["max_cost"]);
  if (dph === null || hours === null || max === null) return null;
  return {
    gpu_name: typeof json["gpu_name"] === "string" ? json["gpu_name"] : null,
    dph,
    horizon_hours: hours,
    max_cost: max,
    location: locationOf(json["location"]),
    down_mbps: mbpsOf(json["down_mbps"]),
  };
}

// ---- GPU choice ----

export interface GpuOption {
  name: string;
  dph: number | null;
  vram_gb: number | null;
  available: boolean;
  location: string | null;
  down_mbps: number | null;
}

/** Check GET /api/gpus; null when the payload is unusable. An entry without a price is unavailable. */
export function parseGpus(json: unknown): GpuOption[] | null {
  if (!isObj(json) || !Array.isArray(json["gpus"])) return null;
  const out: GpuOption[] = [];
  for (const g of json["gpus"]) {
    if (!isObj(g) || typeof g["name"] !== "string" || g["name"] === "" || g["name"].length > MAX_GPU_NAME) continue;
    const dph = num(g["dph"]);
    out.push({
      name: g["name"],
      dph,
      vram_gb: num(g["vram_gb"]),
      available: g["available"] === true && dph !== null && dph > 0,
      location: locationOf(g["location"]),
      down_mbps: mbpsOf(g["down_mbps"]),
    });
  }
  return out;
}

/** Option text: "RTX A5000 - $0.24/h - Quebec, CA, 860 Mbps down", or "RTX 3090 - no offers now". */
export function gpuOptionLabel(g: GpuOption): string {
  if (!g.available || g.dph === null) return `${g.name} - no offers now`;
  const where = serverText({ location: g.location, down_mbps: g.down_mbps });
  return `${g.name} - $${g.dph.toFixed(2)}/h${where === null ? "" : ` - ${where}`}`;
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

/** GET /api/estimate path for a model name (encoded); the bare path when no model is chosen. `extra` is a ready query part. */
export function estimatePath(gpu: string | null, extra = ""): string {
  const query = [gpu === null ? "" : `gpu=${encodeURIComponent(gpu)}`, extra].filter((p) => p !== "").join("&");
  return query === "" ? API.estimate : `${API.estimate}?${query}`;
}

// ---- advanced server choice (Start dialog) ----

// Where the dialog's filter choice is remembered in this browser (a preference, no secret).
export const START_FILTERS_STORAGE_KEY = "vast-comfy.start-filters"; // config-lint: ok (browser storage key, not configuration)
export const REGION_CHOICES: readonly { value: string; label: string }[] = [
  { value: "any", label: "Anywhere" },
  { value: "north_america", label: "North America" },
  { value: "south_america", label: "South America" },
  { value: "europe", label: "Europe" },
  { value: "asia", label: "Asia" },
  { value: "oceania", label: "Oceania" },
  { value: "africa", label: "Africa" },
];
export const SORT_CHOICES: readonly { value: string; label: string }[] = [
  { value: "price", label: "Cheapest first" },
  { value: "speed", label: "Fastest download first" },
  { value: "reliability", label: "Most reliable first" },
];
const MAX_PRICE_TEXT = /^[0-9]{1,6}(\.[0-9]{1,6})?$/;
const WHOLE_TEXT = /^[0-9]{1,9}$/;

/** What the filter inputs hold, as text; the defaults mean "no filter". */
export interface StartFilterState { region: string; maxDph: string; minDown: string; sort: string }
export const DEFAULT_START_FILTERS: StartFilterState = { region: "any", maxDph: "", minDown: "", sort: "price" };

export function startFiltersAreDefault(f: StartFilterState): boolean {
  return f.region === "any" && f.maxDph.trim() === "" && f.minDown.trim() === "" && f.sort === "price";
}

/** Why the inputs cannot be sent, or null. The server checks again against its own limits. */
export function startFilterProblem(f: StartFilterState): string | null {
  if (!REGION_CHOICES.some((r) => r.value === f.region)) return "Choose a region from the list.";
  if (!SORT_CHOICES.some((r) => r.value === f.sort)) return "Choose an order from the list.";
  const price = f.maxDph.trim();
  if (price !== "" && (!MAX_PRICE_TEXT.test(price) || Number(price) <= 0)) return "Maximum price must be a number above 0, for example 0.40.";
  const speed = f.minDown.trim();
  if (speed !== "" && !WHOLE_TEXT.test(speed)) return "Minimum download speed must be a whole number of Mbps.";
  return null;
}

/** The query part for /api/estimate, /api/gpus and /api/offers: only the members that are set. */
export function filterQueryString(f: StartFilterState, offerId: number | null): string {
  const parts: string[] = [];
  if (f.region !== "any") parts.push(`region=${encodeURIComponent(f.region)}`);
  if (f.maxDph.trim() !== "") parts.push(`max_dph=${encodeURIComponent(f.maxDph.trim())}`);
  if (f.minDown.trim() !== "") parts.push(`min_down_mbps=${encodeURIComponent(f.minDown.trim())}`);
  if (f.sort !== "price") parts.push(`sort=${encodeURIComponent(f.sort)}`);
  if (offerId !== null) parts.push(`offer_id=${offerId}`);
  return parts.join("&");
}

/** The members added to the Start body: only what is set, so a plain Start sends exactly what it always did. */
export function filterBodyMembers(f: StartFilterState, offerId: number | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (f.region !== "any") out["region"] = f.region;
  if (f.maxDph.trim() !== "") out["max_dph"] = Number(f.maxDph.trim());
  if (f.minDown.trim() !== "") out["min_down_mbps"] = Number(f.minDown.trim());
  if (f.sort !== "price") out["sort"] = f.sort;
  if (offerId !== null) out["offer_id"] = offerId;
  return out;
}

/** The remembered choice when it parses and every member is valid; otherwise the defaults. */
export function parseStoredFilters(text: string | null): StartFilterState {
  if (text === null) return DEFAULT_START_FILTERS;
  try {
    const v: unknown = JSON.parse(text);
    if (!isObj(v)) return DEFAULT_START_FILTERS;
    const keys = Object.keys(v);
    if (keys.some((k) => !["region", "maxDph", "minDown", "sort"].includes(k))) return DEFAULT_START_FILTERS;
    const state = { ...DEFAULT_START_FILTERS };
    for (const k of ["region", "maxDph", "minDown", "sort"] as const) {
      if (v[k] === undefined) continue;
      if (typeof v[k] !== "string") return DEFAULT_START_FILTERS;
      state[k] = v[k];
    }
    return startFilterProblem(state) === null ? state : DEFAULT_START_FILTERS;
  } catch {
    return DEFAULT_START_FILTERS;
  }
}

/** One offer of GET /api/offers. Never a machine or host id (the server does not send one). */
export interface OfferView {
  id: number;
  gpu_name: string | null;
  dph: number;
  vram_gb: number | null;
  location: string | null;
  region: string | null;
  down_mbps: number | null;
  reliability: number | null;
}

/** Check GET /api/offers; entries that fail validation are dropped. Null when the payload is unusable. */
export function parseOffers(json: unknown): OfferView[] | null {
  if (!isObj(json) || !Array.isArray(json["offers"])) return null;
  return json["offers"].flatMap((o): OfferView[] => {
    if (!isObj(o) || !posInt(o["id"])) return [];
    const dph = num(o["dph"]);
    if (dph === null || dph <= 0) return [];
    const down = num(o["down_mbps"]);
    const rel = num(o["reliability"]);
    const place = typeof o["location"] === "string" && o["location"] !== "" && o["location"].length <= MAX_LOCATION ? o["location"] : null;
    return [{
      id: o["id"],
      gpu_name: typeof o["gpu_name"] === "string" && o["gpu_name"].length <= MAX_GPU_NAME ? o["gpu_name"] : null,
      dph,
      vram_gb: posInt(o["vram_gb"]) ? o["vram_gb"] : null,
      location: place,
      region: typeof o["region"] === "string" ? o["region"] : null,
      down_mbps: down !== null && down >= 0 ? down : null,
      reliability: rel !== null && rel >= 0 && rel <= 1 ? rel : null,
    }];
  });
}

/** "RTX 3090 - $0.31/h - Quebec, CA - 812 Mbps down - reliability 99%" (unknown parts left out). */
export function offerLabel(o: OfferView): string {
  const parts = [o.gpu_name, formatPrice(o.dph).replace(/\/hour$/, "/h")];
  if (o.location !== null) parts.push(o.location);
  if (o.down_mbps !== null) parts.push(`${o.down_mbps} Mbps down`);
  if (o.reliability !== null) parts.push(`reliability ${Math.round(o.reliability * 100)}%`);
  return parts.filter((p): p is string => p !== null).join(" - ");
}

/** The `code` of an API error body, only when it is a short plain identifier. */
export function errorCode(body: unknown): string | null {
  if (!isObj(body) || !isObj(body["error"])) return null;
  const c = body["error"]["code"];
  return typeof c === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(c) ? c : null;
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
  /** Generating is possible and the server offers upscale. */
  canUpscale: boolean;
  /** Generating is possible and the server offers video. */
  canVideo: boolean;
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
    canUpscale: s !== null && s.upscale !== null && GENERATE_STATES.has(state) && !jobPending,
    canVideo: s !== null && s.video !== null && GENERATE_STATES.has(state) && !jobPending,
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

/** The URL of a video job's file from a validated job id and a numeric index (never the server's text). */
export function videoUrl(id: string, index: unknown): string | null {
  const image = imageUrl(id, index);
  return image === null ? null : image.replace(/^\/api\/image\//, `${API.video}/`);
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
  return `Up to ${edit.max_references} images (${typeNames(edit)}), ${formatMegabytes(edit.max_bytes)} each. Refer to them as <image1>, <image2> in the prompt. You can also paste an image (Ctrl/Cmd+V).`;
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

// ---- styles ----

/** The styles the server allows in a mode, in the order it lists them. */
export function stylesForMode(styles: readonly StyleInfo[], mode: Mode): StyleInfo[] {
  return styles.filter((st) => st.modes.includes(mode));
}

/** The tag shown on the k-th attached reference: the style's label for it, else <imageK>. */
export function referenceTag(style: StyleInfo | null, index: number): string {
  return style?.references?.labels[index] ?? `<image${index + 1}>`;
}

/** What a style needs attached, in words; null when it has no rule. */
export function referenceRuleText(style: StyleInfo | null): string | null {
  const r = style?.references ?? null;
  if (r === null) return null;
  const count = r.min === r.max ? `exactly ${r.min}` : `${r.min} to ${r.max}`;
  const order = r.labels.length > 1 ? ` in this order: ${r.labels.join(", ")}` : r.labels.length === 1 ? ` (${r.labels[0]})` : "";
  return `${style!.title} needs ${count} image${r.max === 1 ? "" : "s"}${order}.`;
}

/** True when the number of attached references fits the style's rule (or it has none). */
export function referencesFit(style: StyleInfo | null, count: number): boolean {
  const r = style?.references ?? null;
  return r === null || (count >= r.min && count <= r.max);
}

/** The parameter values a style panel starts with. */
export function styleDefaults(style: StyleInfo): Record<string, StyleValue> {
  return Object.fromEntries(style.params.map((p) => [p.id, p.default]));
}

/** A slider value kept inside the limits and on the step grid (the server refuses anything else). */
export function snapToStep(p: StyleParam, value: number): number {
  if (p.min === undefined || p.max === undefined || p.step === undefined || !Number.isFinite(value)) return typeof p.default === "number" ? p.default : 0;
  const clamped = Math.min(p.max, Math.max(p.min, value));
  const snapped = p.min + Math.round((clamped - p.min) / p.step) * p.step;
  // Rounding away float noise such as 0.7000000000000001.
  return Math.min(p.max, Number(snapped.toFixed(6)));
}

/** The `style` member of a generate or edit body; undefined when no style is chosen. */
export function styleRequest(style: StyleInfo | null, values: Record<string, StyleValue>): { id: string; params: Record<string, StyleValue> } | undefined {
  if (style === null) return undefined;
  const params: Record<string, StyleValue> = {};
  for (const p of style.params) {
    const v = values[p.id];
    params[p.id] = (p.type === "float" || p.type === "int") && typeof v === "number" ? snapToStep(p, v) : v ?? p.default;
  }
  return { id: style.id, params };
}

/** A result may be chained only when it is one of our own same-origin image paths (a job result or a saved image). */
export function isChainableUrl(url: string): boolean {
  if (/^\/api\/image\/[A-Za-z0-9_-]+\/\d+$/.test(url)) return true;
  const saved = /^\/api\/gallery\/([^/]+)\/image$/.exec(url);
  return saved !== null && isGalleryId(saved[1]);
}

// ---- the tool menu ----

export interface MenuCategory { id: string; title: string }
/** One entry of the tool menu: which request it sends (tool) and with which style. */
export interface MenuEntry {
  id: string;
  title: string;
  description: string | null;
  /** A name of the page's built-in icon set (icons.ts draws an unknown one as the default icon). */
  icon: string;
  category: string;
  tool: PageMode;
  style: string | null;
  available: boolean;
}
export interface MenuInfo { categories: MenuCategory[]; items: MenuEntry[] }

const MENU_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const MENU_TOOLS: readonly PageMode[] = ["generate", "edit", "upscale", "video"];
const MENU_TEXT_MAX = 200; // the server sends at most 60 (title) and 120 (description) characters
const nonBlank = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && v.length <= MENU_TEXT_MAX;

/** The menu of GET /api/state; null when it is missing or unusable. Entries that cannot be drawn faithfully are left out. */
function parseMenu(v: unknown): MenuInfo | null {
  if (!isObj(v) || !Array.isArray(v["categories"]) || !Array.isArray(v["items"])) return null;
  const categories: MenuCategory[] = [];
  for (const c of v["categories"]) {
    if (!isObj(c) || typeof c["id"] !== "string" || !MENU_ID.test(c["id"]) || !nonBlank(c["title"])) continue;
    if (!categories.some((k) => k.id === c["id"])) categories.push({ id: c["id"], title: c["title"] });
  }
  const items: MenuEntry[] = [];
  for (const i of v["items"]) {
    if (!isObj(i) || typeof i["id"] !== "string" || !MENU_ID.test(i["id"]) || !nonBlank(i["title"])) continue;
    const tool = i["tool"] as PageMode;
    const style = i["style"];
    if (!MENU_TOOLS.includes(tool) || !categories.some((c) => c.id === i["category"]) || items.some((k) => k.id === i["id"])) continue;
    if (style !== null && (typeof style !== "string" || !MENU_ID.test(style) || tool === "upscale" || tool === "video")) continue;
    items.push({
      id: i["id"],
      title: i["title"],
      description: nonBlank(i["description"]) ? i["description"] : null,
      icon: typeof i["icon"] === "string" ? i["icon"] : "",
      category: i["category"] as string,
      tool,
      style: style as string | null,
      available: i["available"] === true,
    });
  }
  return { categories, items };
}

/** The category of the menu the page builds when the server sends none. */
const FALLBACK_CATEGORY: MenuCategory = { id: "tools", title: "Tools" };

/** A menu from what the state offers (the server's menu is missing): the plain tools, then each style per mode. */
function fallbackMenu(s: ApiState): MenuInfo {
  const plain = (id: string, title: string, icon: string, tool: PageMode): MenuEntry => ({ id, title, description: null, icon, category: FALLBACK_CATEGORY.id, tool, style: null, available: true });
  const items = [plain("generate", "Generate", "image", "generate"), plain("edit", "Edit images", "wand", "edit"), plain("upscale", "Upscale", "expand", "upscale"), plain("video", "Video", "film", "video")];
  for (const st of s.styles) {
    for (const m of st.modes) {
      items.push({ id: st.modes.length === 1 ? st.id : `${st.id}-${m}`, title: st.title, description: null, icon: m === "edit" ? "wand" : "image", category: FALLBACK_CATEGORY.id, tool: m, style: st.id, available: true });
    }
  }
  return { categories: [FALLBACK_CATEGORY], items };
}

/**
 * The entries the page offers now, in menu order: available on the server, their mode offered in this state
 * (edit and upscale can be off), and their style listed for that mode. Categories without an entry are left out.
 */
export function usableMenu(s: ApiState): MenuInfo {
  const menu = s.menu ?? fallbackMenu(s);
  const items = menu.items.filter((i) => {
    if (!i.available) return false;
    if ((i.tool === "edit" && s.edit === null) || (i.tool === "upscale" && s.upscale === null) || (i.tool === "video" && s.video === null)) return false;
    return i.style === null || ((i.tool === "generate" || i.tool === "edit") && s.styles.some((st) => st.id === i.style && st.modes.includes(i.tool as Mode)));
  });
  return { categories: menu.categories.filter((c) => items.some((i) => i.category === c.id)), items };
}

/** The wanted entry when the menu has it, else the first one; null for an empty menu. */
export function chooseEntry(wanted: string | null, items: readonly MenuEntry[]): MenuEntry | null {
  return items.find((i) => i.id === wanted) ?? items[0] ?? null;
}

/** True when an entry matches the search text (title or description, ignoring case); empty text matches all. */
export function matchesQuery(entry: MenuEntry, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  if (q === "") return true;
  return entry.title.toLocaleLowerCase().includes(q) || (entry.description ?? "").toLocaleLowerCase().includes(q);
}

/** The entries that match the search, under their category in menu order; categories without a match are left out. */
export function menuGroups(menu: MenuInfo, query: string): { category: MenuCategory; items: MenuEntry[] }[] {
  return menu.categories.flatMap((category) => {
    const items = menu.items.filter((i) => i.category === category.id && matchesQuery(i, query));
    return items.length === 0 ? [] : [{ category, items }];
  });
}

/** The ways to continue from a result: every edit entry ("Use as reference", with the style's title), upscale, then video. */
export function chainTargets(items: readonly MenuEntry[]): { id: string; title: string }[] {
  const edits = items.filter((i) => i.tool === "edit").map((i) => ({ id: i.id, title: i.style === null ? "Use as reference" : `Use as reference: ${i.title}` }));
  const ups = items.filter((i) => i.tool === "upscale").map((i) => ({ id: i.id, title: "Upscale" }));
  const videos = items.filter((i) => i.tool === "video").map((i) => ({ id: i.id, title: "Make a video" }));
  return [...edits, ...ups, ...videos];
}

// ---- Advanced: negative prompt and guidance, and the defaults a style pre-fills ----

/** What the Advanced section shows in a mode: each knob only when the mode's workflow takes it. */
export function knobsFor(s: ApiState, mode: PageMode): Knobs {
  if (mode === "upscale" || mode === "video") return NO_KNOBS;
  const k = s.advanced[mode];
  return { negativePrompt: k.negativePrompt, cfg: k.cfg && s.guidance !== null };
}

/** A guidance slider value kept inside the range and on the step grid. */
export function snapGuidance(g: GuidanceInfo, value: number): number {
  if (!Number.isFinite(value)) return g.default;
  const clamped = Math.min(g.max, Math.max(g.min, value));
  return Math.min(g.max, Number((g.min + Math.round((clamped - g.min) / g.step) * g.step).toFixed(6)));
}

/**
 * The knob members of a generate or edit body. Only what differs from "untouched": no negative prompt when
 * the box is blank, and no cfg while the slider is at the default (the workflows' own cfg), so a form the
 * user did not touch sends exactly the body it sent before this section existed.
 */
export function advancedRequest(opts: { knobs: Knobs; negative: string; guidance: GuidanceInfo | null; guidanceValue: number | null }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const negative = opts.negative.trim();
  if (opts.knobs.negativePrompt && negative !== "") out["negative_prompt"] = negative;
  if (opts.knobs.cfg && opts.guidance && opts.guidanceValue !== null) {
    const cfg = snapGuidance(opts.guidance, opts.guidanceValue);
    if (cfg !== opts.guidance.default) out["cfg"] = cfg;
  }
  return out;
}

/** ", guidance 3" and ", negative prompt" for a job label, the way the server labels the same job. */
export function advancedLabel(body: Record<string, unknown>): string {
  const cfg = typeof body["cfg"] === "number" ? `, guidance ${body["cfg"]}` : "";
  return `${cfg}${typeof body["negative_prompt"] === "string" ? ", negative prompt" : ""}`;
}

/** The form fields a style may pre-fill. cfg null means "at the guidance default". */
export interface FormValues {
  negativePrompt: string;
  cfg: number | null;
  preset: string;
  size: string;
  resolution: string;
}
type FormKey = keyof FormValues;
/** What the current style pre-filled, and what each field held before, so leaving the style can undo it. */
export type Prefilled = Partial<{ [K in FormKey]: { value: FormValues[K]; previous: FormValues[K] } }>;

/** A style's defaults that this server can use in this mode: offered names only, cfg on the grid, text bounded. */
export function usableDefaults(style: StyleInfo | null, s: ApiState, mode: PageMode): Partial<FormValues> {
  if (style === null || mode === "upscale" || mode === "video") return {};
  const d = style.defaults;
  const knobs = knobsFor(s, mode);
  const out: Partial<FormValues> = {};
  if (d.negativePrompt !== undefined && knobs.negativePrompt) out.negativePrompt = d.negativePrompt.slice(0, s.advanced.negativeMaxChars);
  if (d.cfg !== undefined && knobs.cfg && s.guidance) out.cfg = snapGuidance(s.guidance, d.cfg);
  if (d.preset !== undefined && s.presets.some((p) => p.name === d.preset)) out.preset = d.preset;
  if (mode === "generate" && d.size !== undefined && s.sizes.some((z) => z.name === d.size)) out.size = d.size;
  if (mode === "edit" && d.resolution !== undefined && s.edit?.resolutions.some((r) => r.name === d.resolution)) out.resolution = d.resolution;
  return out;
}

/**
 * Switch the form from one style's defaults to the next: a field the previous style pre-filled and the user
 * did not change goes back to what it held before; then the next style's defaults are put in. A field the
 * user changed is left alone when leaving a style.
 */
export function switchDefaults(current: FormValues, prefilled: Prefilled, next: Partial<FormValues>): { values: FormValues; prefilled: Prefilled } {
  const values: FormValues = { ...current };
  const put = <K extends FormKey>(key: K, value: FormValues[K]): void => {
    values[key] = value;
  };
  for (const key of Object.keys(prefilled) as FormKey[]) {
    const p = prefilled[key]!;
    if (values[key] === p.value) put(key, p.previous);
  }
  const fresh: Prefilled = {};
  for (const key of Object.keys(next) as FormKey[]) {
    const value = next[key]!;
    (fresh as Record<FormKey, { value: unknown; previous: unknown }>)[key] = { value, previous: values[key] };
    put(key, value);
  }
  return { values, prefilled: fresh };
}

// ---- upscale ----

/** The reference rules for the one image of an upscale, in the shape pickReferences takes. */
export function upscaleAsEdit(u: UpscaleInfo): EditInfo {
  return { max_references: 1, max_bytes: u.max_bytes, max_pixels: u.max_pixels, types: u.types, resolutions: [], sizes: [] };
}

export function upscaleHint(u: UpscaleInfo): string {
  return `One image (${u.types.map((t) => t.toUpperCase()).join(", ")}), ${formatMegabytes(u.max_bytes)} at most. The result size is limited by the server. You can also paste an image (Ctrl/Cmd+V).`;
}

export function upscaleLabel(scale: string): string {
  return `Upscale: ${scale}`;
}

// ---- video ----

/** The rules for the optional start image of a video, in the shape pickReferences takes (one image at most). */
export function videoAsEdit(v: VideoInfo): EditInfo {
  return { max_references: 1, max_bytes: v.max_bytes, max_pixels: v.max_pixels, types: v.types, resolutions: [], sizes: [] };
}

export function videoHint(v: VideoInfo): string {
  return `Optional: one start image (${v.types.map((t) => t.toUpperCase()).join(", ")}), ${formatMegabytes(v.max_bytes)} at most, brings that picture to life. Without one the video is made from the prompt alone. You can also paste an image (Ctrl/Cmd+V).`;
}

/** "About 5 s (5 s)" is redundant: the option shows the name, plus the seconds only when the name lacks them. */
export function durationLabel(d: VideoDurationInfo): string {
  return d.name.includes(`${d.seconds} s`) ? d.name : `${d.name} (about ${d.seconds} s)`;
}

/** The job label, the way the server labels the same job. */
export function videoLabel(size: string, duration: string, fromImage: boolean): string {
  return `Video: ${size}, ${duration}${fromImage ? ", from an image" : ""}`;
}

/** Shown while a video runs: it takes minutes, and the page must stay open for the result to appear. */
export const VIDEO_WAIT_TEXT = "A video takes several minutes, often 5 to 20 on these GPUs. Keep this page open: the result appears here when it is ready.";

// ---- a running job: step counter and live preview ----

export interface JobProgress { step: number; max: number }
const STEP_MAX = 100_000;

/** The step counter of a pending job, or null when the server sent none or nonsense. */
export function parseJobProgress(v: unknown): JobProgress | null {
  if (!isObj(v)) return null;
  const step = v["step"];
  const max = v["max"];
  if (!Number.isInteger(step) || !Number.isInteger(max)) return null;
  const s = step as number;
  const m = max as number;
  return m >= 1 && m <= STEP_MAX && s >= 0 && s <= m ? { step: s, max: m } : null;
}

/** How many previews the server has received for a job; 0 for anything unusable. */
export function parsePreviewSeq(v: unknown): number {
  return Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : 0;
}

export function stepText(p: JobProgress): string {
  return `Step ${p.step} of ${p.max}`;
}

/** The live preview path of a job; null for an id that is not one. */
export function previewPath(id: string): string | null {
  return isJobId(id) ? `${API.generate}/${id}/preview` : null;
}

/** Only these come back from the preview route; anything else is not shown. */
export function isPreviewType(type: string): boolean {
  return type === "image/jpeg" || type === "image/png";
}

/** Poll a running job every second while the server answers fast, otherwise at the normal pace. */
export function jobPollDelayMs(latencyMs: number): number {
  return latencyMs >= 0 && latencyMs < JOB_POLL_FAST_LATENCY_MS ? JOB_POLL_FAST_MS : JOB_POLL_MS;
}

/** "Running for 12 s" from the milliseconds since the job was submitted. */
export function elapsedText(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `Running for ${s < SECONDS_PER_MINUTE * 2 ? `${s} s` : `${Math.floor(s / SECONDS_PER_MINUTE)} min ${s % SECONDS_PER_MINUTE} s`}`;
}

// ---- how long a job took ----

export type JobKind = "generate" | "edit" | "upscale" | "video";
const DURATION_VERB: Record<JobKind, string> = { generate: "Generated", edit: "Edited", upscale: "Upscaled", video: "Made" };
const SECONDS_MAX_SHOWN = 86_400;
const SECONDS_PER_MINUTE = 60;
const ONE_DECIMAL_BELOW_S = 10;

/** A server-sent duration in seconds, or null for anything that is not a plausible number. */
export function parseSeconds(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= SECONDS_MAX_SHOWN ? v : null;
}

/** "4.2 s", "52 s", "2 min 5 s". */
export function formatSeconds(seconds: number): string {
  if (seconds < ONE_DECIMAL_BELOW_S) return `${(Math.round(seconds * 10) / 10).toFixed(1)} s`;
  const whole = Math.round(seconds);
  if (whole < SECONDS_PER_MINUTE * 2) return `${whole} s`;
  return `${Math.floor(whole / SECONDS_PER_MINUTE)} min ${whole % SECONDS_PER_MINUTE} s`;
}

/** "Generated in 52 s" (the verb follows the kind of job); null when the duration is unknown. */
export function durationText(kind: JobKind, seconds: number | null): string | null {
  return seconds === null ? null : `${DURATION_VERB[kind]} in ${formatSeconds(seconds)}`;
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
  start_stuck: "the rented machine did not start",
  boot_stopped: "the container stopped during the boot",
  slow_boot: "the rented machine did not finish starting up in time (the agent never answered)",
  slow_download: "the rented machine's model download was too slow",
  unreachable: "the agent stayed unreachable",
  destroy_retry: "destroyed after a retry",
  destroy_requested: "destroy requested",
  vanished: "it vanished from Vast",
  never_created: "it was never created on Vast",
  gone: "it is gone",
};

// Page text per start failure code; an unknown code shows the server's message.
const SLOW_NETWORK_TEXT = "The rented machine's network is too slow";
const RETRY_ELSEWHERE = "It was released; try Start again, a different machine is chosen.";
const START_FAILURE_TEXT: Record<string, string> = {
  start_stuck: "The rented machine did not start. It was released; try Start again.",
  boot_stopped: "The rented machine stopped while it was starting. It was released; try Start again.",
  slow_boot: `The rented machine did not finish starting up in time. ${RETRY_ELSEWHERE}`,
  slow_download: `${SLOW_NETWORK_TEXT}. ${RETRY_ELSEWHERE}`,
  boot_failed: "The rented machine's boot failed and it removed itself; try Start again.",
};

/** A measured speed in MB/s from the server: a finite number 0..100000, else null. */
function measuredMbS(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100_000 ? Math.round(v * 10) / 10 : null;
}

export function startFailureText(f: { code: string; message: string; measured_mb_s?: number | null }): string {
  const mbS = f.measured_mb_s ?? null;
  if (f.code === "slow_download" && mbS !== null) {
    return `${SLOW_NETWORK_TEXT} (about ${mbS} MB/s to the model host). ${RETRY_ELSEWHERE}`;
  }
  return START_FAILURE_TEXT[f.code] ?? (f.message !== "" ? f.message : "The start failed; try Start again.");
}

export function endedText(reason: string | null): string {
  const why = reason === null ? undefined : END_REASON_TEXT[reason];
  return why === undefined ? "Instance ended." : `Instance ended: ${why}.`;
}

export const PHASE_MARKS: Record<PhaseStatus, string> = { pending: "○", running: "◐", done: "✓", failed: "✗" };

// Plain sentences per phase id (ids are BOOT_STEPS in apps/core/src/console.ts, plus image_pull).
const PHASE_SENTENCES: Record<string, string> = {
  image_pull: "Pulling the container image, usually 1-3 minutes",
  net_probe: "Checking the network speed to the model host, a few seconds",
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
  /** Where the session's server was (null for older sessions or when unknown). */
  location: string | null;
  down_mbps: number | null;
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
      strOrNull(r["started_by"]) && strOrNull(r["reason"]) && strOrNull(r["stop_by"]) && typeof r["active"] === "boolean" &&
      (r["location"] === undefined || strOrNull(r["location"])) && (r["down_mbps"] === undefined || numOrNull(r["down_mbps"]))
    );
  });
  if (!ok) return null;
  // An older server sends no location fields: they read as unknown.
  return (list as Record<string, unknown>[]).map((r) => ({
    ...(r as unknown as UsageEntry),
    location: locationOf(r["location"]),
    down_mbps: mbpsOf(r["down_mbps"]),
  }));
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

// ---- gallery (saved images) ----

// Where the "save automatically" choice is remembered in this browser (a preference, no secret).
export const AUTOSAVE_STORAGE_KEY = "vast-comfy.autosave"; // config-lint: ok (browser storage key, not configuration)
const GALLERY_ID = /^[0-9a-f]{32}\.[0-9]{13}\.[A-Za-z0-9_-]{1,128}\.[0-9]{1,3}$/;
const KB = 1024;
const MB = 1024 * 1024;

export interface GalleryEntry {
  id: string;
  url: string;
  createdAt: number;
  kind: "generate" | "edit" | "upscale";
  prompt: string;
  label: string;
  ownerName: string;
  mine: boolean;
  size: number;
  /** How long the image took; null for older images. */
  seconds: number | null;
}

export function isGalleryId(v: unknown): v is string {
  return typeof v === "string" && GALLERY_ID.test(v);
}

/** The image URL for a gallery id; null for anything that is not exactly an id. */
export function galleryImageUrl(id: string): string | null {
  return isGalleryId(id) ? `${API.gallery}/${id}/image` : null;
}

/** GET /api/gallery path for a page; an unusable cursor is left out rather than sent. */
export function galleryPath(cursor: string | null, everyone: boolean): string {
  const query: string[] = [];
  if (everyone) query.push("scope=all");
  if (cursor !== null && isGalleryId(cursor)) query.push(`cursor=${cursor}`);
  return query.length === 0 ? API.gallery : `${API.gallery}?${query.join("&")}`;
}

/** Check GET /api/gallery; entries that fail validation are dropped, the URL is rebuilt from the id. */
export function parseGalleryPage(json: unknown): { items: GalleryEntry[]; next: string | null } | null {
  if (!isObj(json) || !Array.isArray(json["items"])) return null;
  const items: GalleryEntry[] = [];
  for (const raw of json["items"]) {
    if (!isObj(raw) || !isGalleryId(raw["id"])) continue;
    const createdAt = num(raw["created_at"]);
    const size = num(raw["size"]);
    if (createdAt === null || size === null) continue;
    items.push({
      id: raw["id"],
      url: `${API.gallery}/${raw["id"]}/image`,
      createdAt,
      kind: raw["kind"] === "edit" || raw["kind"] === "upscale" ? raw["kind"] : "generate",
      prompt: typeof raw["prompt"] === "string" ? raw["prompt"] : "",
      label: typeof raw["label"] === "string" ? raw["label"] : "",
      ownerName: typeof raw["owner_name"] === "string" ? raw["owner_name"] : "",
      mine: raw["mine"] === true,
      size,
      seconds: parseSeconds(raw["seconds"]),
    });
  }
  return { items, next: isGalleryId(json["next"]) ? json["next"] : null };
}

/** "2026-10-18 04:20 UTC": the same text on every device. */
export function formatSavedAt(epochSeconds: number): string {
  return `${new Date(epochSeconds * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= KB) return `${(bytes / KB).toFixed(1)} KB`;
  return `${Math.max(0, Math.floor(bytes))} B`;
}

// ---- server panel, header pill, floating widget ----

// The panel beside the page is remembered per browser: "open" or "collapsed" (any other value means open).
export const PANEL_STORAGE_KEY = "vast-comfy.panel"; // config-lint: ok (browser storage key, not configuration)
// Layout rule (the same breakpoints as style.css): three columns from 1280 px, the panel is a drawer below that,
// and below 900 px the menu is a drawer too.
const PANEL_WIDE_MIN_PX = 1280;
const MENU_WIDE_MIN_PX = 900;
/** About two hours at the current price, but never less than this, is "low". */
const CREDIT_LOW_HOURS = 2;
const CREDIT_LOW_MIN_USD = 1;

export type LayoutMode = "wide" | "medium" | "narrow";
export type PanelPref = "open" | "collapsed";
export type CreditTone = "ok" | "warn" | "bad" | "neutral";

/** "wide": sidebar, page and panel side by side; "medium": the panel is a drawer; "narrow": the menu is a drawer too. */
export function layoutMode(width: number): LayoutMode {
  if (!Number.isFinite(width)) return "narrow";
  if (width >= PANEL_WIDE_MIN_PX) return "wide";
  return width >= MENU_WIDE_MIN_PX ? "medium" : "narrow";
}

/** The stored panel choice; only the exact word "collapsed" collapses it. */
export function parsePanelPref(text: string | null): PanelPref {
  return text === "collapsed" ? "collapsed" : "open";
}

/** Used up at or below zero; low under about two hours at the current price (at least $1); neutral when unknown. */
export function creditTone(credit: number | null, dph: number | null): CreditTone {
  if (credit === null || !Number.isFinite(credit)) return "neutral";
  if (credit <= 0) return "bad";
  const price = dph !== null && Number.isFinite(dph) && dph > 0 ? dph : 0;
  return credit < Math.max(CREDIT_LOW_MIN_USD, CREDIT_LOW_HOURS * price) ? "warn" : "ok";
}

/** The word shown next to the credit, so the tone is never colour alone. */
export function creditToneText(tone: CreditTone): string {
  return tone === "warn" ? "low" : tone === "bad" ? "used up" : "";
}

const BOOTING_STATES = new Set(["creating", "booting", "downloading"]);
const PILL_LABELS: Record<string, string> = {
  none: "Stopped",
  ready: "Ready",
  stopping: "Stopping",
  failed: "Failed",
  destroy_failed: "Destroy failed",
};

/** The header pill: a short label ("Ready", "Booting 42%", "Idle 3m", "Stopped", "Failed") and the state's tone. */
export function pillView(state: string | null, percent: number | null, idleSeconds: number | null): { label: string; tone: Tone } {
  if (state === null) return { label: "Loading", tone: "idle" };
  const tone = stateInfo(state).tone;
  if (BOOTING_STATES.has(state)) return { label: percent === null ? "Booting" : `Booting ${percent}%`, tone };
  if (state === "idle-warning") {
    return { label: idleSeconds === null ? "Idle soon" : `Idle ${Math.ceil(Math.max(0, idleSeconds) / 60)}m`, tone };
  }
  return { label: PILL_LABELS[state] ?? "Unknown", tone };
}

/**
 * The floating status widget shows while the panel is not on screen (collapsed at the wide layout, or a closed drawer
 * below it), an instance has an uptime, and no overlay (a drawer, the log or a confirm dialog) covers the page.
 */
export function widgetVisible(v: { mode: LayoutMode; collapsed: boolean; overlayOpen: boolean; uptime: number | null }): boolean {
  const panelOnScreen = v.mode === "wide" && !v.collapsed;
  return !panelOnScreen && v.uptime !== null && !v.overlayOpen;
}

/** A warning for the Start dialog when the known credit is below the estimate's most; null otherwise. */
export function startCreditWarning(credit: number | null, maxCost: number): string | null {
  if (credit === null || !Number.isFinite(credit) || !Number.isFinite(maxCost) || credit >= maxCost) return null;
  return `Your Vast credit (${formatCredit(credit)}) is less than this estimate (${formatCost(maxCost)}). The instance may stop when the credit runs out.`;
}

export interface PanelActions {
  start: boolean;
  extend: boolean;
  /** Near the idle shutdown Extend is the first choice (open, primary). */
  extendPrimary: boolean;
  destroy: boolean;
  destroyLabel: string;
  /** A plain next step when no action fits (after a failure). */
  hint: string;
}

const RETRY_STATES = new Set(["failed", "destroy_failed"]);

/** Which admin actions the panel shows in a state (whether they are enabled is `controls`). */
export function panelActions(state: string | null): PanelActions {
  const s = state ?? "";
  const retry = RETRY_STATES.has(s);
  return {
    start: s === "none",
    extend: EXTEND_STATES.has(s),
    extendPrimary: s === "idle-warning",
    destroy: state !== null && s !== "none" && s !== "stopping",
    destroyLabel: retry ? "Destroy instance (retry)" : "Destroy instance…",
    hint: retry ? "Destroy it in the danger zone below, then start again." : "",
  };
}
