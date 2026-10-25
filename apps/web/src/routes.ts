import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import {
  AgentError,
  AlreadyActiveError,
  ComfyError,
  DestroyFailedError,
  GalleryError,
  Semaphore,
  GenerateFailed,
  GenerateInputError,
  GpuNotAllowedError,
  NoActiveInstanceError,
  NoGpuConfiguredError,
  NoOffersError,
  OfferGoneError,
  VastError,
  StartFilterError,
  type StartFilters,
  ObjectStoreError,
  RefusedError,
  ResponseTooLarge,
  StartError,
  Unreachable,
  edit as runEdit,
  upscale as runUpscale,
  video as runVideo,
  checkVideoTemplate,
  checkVideoFamily,
  sniffVideo,
  type VideoFamily,
  type VideoFamilyStatus,
  type VideoExtraLora,
  type LorasStatus,
  type StoredLora,
  LORA_SIDES,
  LoraStoreError,
  lorasDigest,
  ModelLinkError,
  isLinkedModelName,
  parseModelLink,
  MODEL_LINK_MAX_CHARS,
  type VideoDeps,
  type VideoRequest,
  type UpscaleDeps,
  type UpscaleLimits,
  type UpscaleRequest,
  checkGuidanceDefault,
  generate,
  labelHostname,
  menuItems,
  pollResult,
  referenceLimits,
  tenthsOfSeconds,
  tuningSupport,
  userLabel,
  type AppsConfig,
  type CostEstimate,
  type EditDeps,
  type EditRequest,
  type GenerateDeps,
  type GenerateRequest,
  type ProgressLimits,
  type ReferenceLimits,
  type Viewer,
  type StartFailDetail,
  type StartFailReason,
  type StartFailureCode,
  type ServerInfo,
  type StatusView,
  type UsageItem,
  type VideoModelsStatus,
} from "@vast-comfy/core";
import { CreditCache, JobStore, LiveProgress, RateLimiter, type Job, type JobKind } from "./store.js";
import { sendError } from "./reply.js";
import type { ServerDeps } from "./server.js";

// The /api routes. Rules: identity and role are already checked by the server gate; bodies are
// validated by strict JSON schemas; nothing here returns an agent token, an instance hostname,
// a ComfyUI filename, a Vast key or a stack trace. Errors are {error: {code, message}}.

const READY_STATES = new Set(["ready", "idle-warning"]);
const HOUR_MS = 3_600_000;
const PROMPT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const REFUSAL_STATUSES = new Set([400, 409, 422]);
const HOSTNAME_TEXT = /\bvast-[A-Za-z0-9-]+/g;
const LABEL_TEXT = /\bvastcomfy:[A-Za-z0-9.-]*/g;
const URL_TEXT = /\bhttps?:\/\/\S+/gi; // config-lint: ok (pattern that removes URLs from messages)
const MESSAGE_MAX = 300;
/**
 * Status of every application-level failure of a dependency (Vast, Tailscale, the instance, ComfyUI,
 * the object store): 424 Failed Dependency. Never 502/504: Cloudflare answers an origin 502/504 with
 * its own branded error page, so the JSON body (the text the page shows) never reaches the browser.
 */
const UPSTREAM_FAILED = 424;
const GPU_NAME_MAX = 64;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

// Plain English per fixed start-failure reason (the page shows it as is): what happened, whether
// anything was rented, and what the owner can do. Never provider text.
const NOTHING_RENTED = "Nothing was rented.";
const START_FAIL_MESSAGES: Record<StartFailReason, string> = {
  ts_key_missing:
    `The Tailscale auth key is missing on the server (the OAuth client is not set and the TS_AUTHKEY_FILE key file is missing or empty). ${NOTHING_RENTED} ` +
    "Set TS_OAUTH_CLIENT_ID and TS_OAUTH_CLIENT_SECRET, or put a key in the key file, then try again.",
  ts_key_mint_failed:
    `A Tailscale auth key could not be created through the OAuth client. ${NOTHING_RENTED} Try again in a minute; the server log has the details.`,
  vast_unavailable:
    `The server could not get the list of offers from Vast (a network problem at the server, or a Vast outage). ${NOTHING_RENTED} ` +
    "Try again in a minute; if it keeps failing, check the server's internet connection.",
  config_invalid: `The server's start settings are incomplete or invalid. ${NOTHING_RENTED} Check the server settings (.env) against .env.example.`,
  vast_rejected: `Vast refused to create the machine (the offer may have just been taken). ${NOTHING_RENTED} Try Start again; another offer may be chosen.`,
  create_uncertain:
    "It is not clear whether Vast created the machine (its answer was lost). Do not start again yet: within a few minutes the server " +
    "either takes it over or releases it. Watch the Status card.",
  registry_failed: "The machine was created but could not be recorded, so it was destroyed again. Check the Status card, then try Start again.",
  unexpected: "The start failed for an unexpected reason. Check the Status card before trying again; the server log has the details.",
};

// ts_key_mint_failed, refined by the fixed TailscaleError code (StartError.detail).
const MINT_FAIL_MESSAGES: Record<StartFailDetail, string> = {
  tailscale_unavailable:
    `The server could not reach the Tailscale API (a network problem at the server; it retried a few times). ${NOTHING_RENTED} ` +
    "Check the server's internet connection and try again in a minute.",
  oauth_failed:
    `Tailscale refused the OAuth client. ${NOTHING_RENTED} Check TS_OAUTH_CLIENT_ID and TS_OAUTH_CLIENT_SECRET (both must be set) ` +
    "and that the client has the Auth Keys write scope.",
  key_rejected:
    `Tailscale refused to create the auth key. ${NOTHING_RENTED} Check TS_OAUTH_TAG and that this tag is in the ACL tagOwners for the OAuth client.`,
  invalid_response: `Tailscale sent an answer the server could not use. ${NOTHING_RENTED} Try again in a minute; the server log has the details.`,
};

/** The fixed text of a failed Start; a detail refines ts_key_mint_failed only. */
export function startFailText(reason: StartFailReason, detail: StartFailDetail | null): string {
  if (reason === "ts_key_mint_failed" && detail !== null) return MINT_FAIL_MESSAGES[detail];
  return START_FAIL_MESSAGES[reason];
}

// Plain text per fixed code of a start that failed after Start returned (GET /api/state start_failure).
const SLOW_NETWORK_TEXT = "The rented machine's network is too slow";
const RETRY_ELSEWHERE = "It was released; try Start again, a different machine is chosen.";
const TOO_LONG_TEXT = "The model download would not finish before the boot time limit";
const START_FAILURE_MESSAGES: Record<StartFailureCode, string> = {
  start_stuck: "The rented machine did not start. It was released; try Start again.",
  boot_stopped: "The rented machine stopped while it was starting. It was released; try Start again.",
  slow_boot: `The rented machine did not finish starting up in time. ${RETRY_ELSEWHERE}`,
  slow_download: `${SLOW_NETWORK_TEXT}. ${RETRY_ELSEWHERE}`,
  boot_too_long: `${TOO_LONG_TEXT}. ${RETRY_ELSEWHERE}`,
  boot_failed: "The rented machine's boot failed and it removed itself; try Start again.",
};

/**
 * The fixed text of a start failure. slow_download and boot_too_long name the measured speed and the limit in
 * minutes when known (numbers only): "too slow" is a speed under what the download limit allows; "too long" is a
 * download fast enough for that limit that would still end after the boot limit.
 */
export function startFailureMessage(code: StartFailureCode, measuredMbS: number | null, limitMin: number | null = null): string {
  const speed = measuredMbS !== null && Number.isFinite(measuredMbS) ? measuredMbS : null;
  const limit = limitMin !== null && Number.isSafeInteger(limitMin) && limitMin > 0 ? limitMin : null;
  if (code === "slow_download" && speed !== null) {
    const more = limit === null ? "" : `; the download would take more than ${limit} minutes`;
    return `${SLOW_NETWORK_TEXT} (about ${speed} MB/s to the model host${more}). ${RETRY_ELSEWHERE}`;
  }
  if (code === "boot_too_long" && (speed !== null || limit !== null)) {
    const parts = [...(speed === null ? [] : [`about ${speed} MB/s`]), ...(limit === null ? [] : [`limit ${limit} minutes`])];
    return `${TOO_LONG_TEXT} (${parts.join(", ")}). ${RETRY_ELSEWHERE}`;
  }
  return START_FAILURE_MESSAGES[code];
}

/** An error's class name for a log line, or a fixed word when it is not a plain identifier. */
function errorName(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  return ERROR_NAME.test(name) ? name : "Error";
}

/** The estimate as the browser may see it: the offer id stays inside the server. */
function publicEstimate(e: CostEstimate) {
  return {
    gpu_name: e.gpu_name, dph: e.dph, horizon_hours: e.horizon_hours, max_cost: e.max_cost,
    location: e.location, down_mbps: e.down_mbps,
  };
}

/** Where the server is: location and speeds for everyone, the Vast machine id for admins only. */
function publicServer(server: ServerInfo | null, isAdmin: boolean, scrub: (t: string) => string) {
  if (server === null) return null;
  const base = {
    location: server.location === null ? null : scrub(server.location),
    down_mbps: server.down_mbps,
    up_mbps: server.up_mbps,
    reliability: server.reliability,
  };
  return isAdmin ? { ...base, machine_id: server.machine_id } : base;
}

function intCfg(cfg: AppsConfig, key: string, env: string): number {
  const v = cfg[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new Error(`${env} must be a positive integer`);
  return v;
}

/** Remove hostnames, labels, URLs, bearer tokens and secrets from a message meant for a browser. */
function scrubber(deps: ServerDeps, hostnames: readonly string[]): (text: string) => string {
  return (text: string) => {
    let out = text;
    for (const s of [...deps.secrets(), ...hostnames]) if (s !== "") out = out.split(s).join("[redacted]");
    out = out
      .replace(URL_TEXT, "[url]")
      .replace(LABEL_TEXT, "[label]")
      .replace(HOSTNAME_TEXT, "[host]")
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
    return out.length > MESSAGE_MAX ? `${out.slice(0, MESSAGE_MAX)}...` : out;
  };
}

function hostnamesOf(view: StatusView): string[] {
  const out: string[] = [];
  if (view.record) out.push(view.record.tailnet_hostname);
  for (const u of view.unknown) {
    const h = labelHostname(u.label);
    if (h !== null) out.push(h);
  }
  return out;
}

/** The video model files of the instance as the browser may see them; null when the agent does not say. */
function publicVideoModels(v: VideoModelsStatus | null | undefined, scrub: (t: string) => string) {
  if (v === null || v === undefined) return null;
  const total = Number.isSafeInteger(v.bytes_total) && v.bytes_total > 0 ? v.bytes_total : 0;
  const done = Number.isSafeInteger(v.bytes_done) ? Math.min(Math.max(v.bytes_done, 0), total) : 0;
  return {
    state: v.state,
    bytes_done: done,
    bytes_total: total,
    percent: total > 0 ? Math.floor((done / total) * 100) : null,
    reason: typeof v.reason === "string" && v.reason !== "" ? scrub(v.reason) : null,
  };
}

/** The diffusion model the instance uses, for admins: its file name, whether it came from a link, its sha256. */
function publicVideoModel(v: VideoModelsStatus | null | undefined) {
  const m = v?.model;
  if (m === null || m === undefined || typeof m.file !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(m.file)) return null;
  const sha = typeof m.sha256 === "string" && /^[0-9a-f]{64}$/.test(m.sha256) ? m.sha256 : null;
  return { file: m.file, linked: m.linked === true, sha256: sha };
}

/** A video family's experts as the instance reports them, for admins (file names and sha256 checked first). */
function publicExperts(v: VideoFamilyStatus | null | undefined) {
  if (v === null || v === undefined || !Array.isArray(v.experts)) return [];
  return v.experts
    .filter((e) => (e.mode === "text" || e.mode === "image") && typeof e.slot === "string" && /^[a-z][a-z0-9]{0,15}$/.test(e.slot)
      && typeof e.file === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(e.file))
    .map((e) => ({ mode: e.mode, slot: e.slot, file: e.file, linked: e.linked === true, sha256: typeof e.sha256 === "string" && /^[0-9a-f]{64}$/.test(e.sha256) ? e.sha256 : null }));
}

/** A video duration as the page sees it: its name and seconds, and `experimental: true` when it is one. */
function publicDuration(d: { name: string; seconds: number; experimental?: true }) {
  return { name: d.name, seconds: d.seconds, ...(d.experimental === true ? { experimental: true } : {}) };
}

/** Why a video job cannot run yet (null when the instance has its video models). */
function videoModelsRefusal(v: VideoModelsStatus | null | undefined): string | null {
  if (v?.state === "ready") return null;
  switch (v?.state) {
    case "not_installed":
      return "the video models are not installed on this instance yet; an admin can download them (Download video models)";
    case "downloading": {
      const pct = v.bytes_total > 0 ? ` (${Math.floor((Math.min(v.bytes_done, v.bytes_total) / v.bytes_total) * 100)}%)` : "";
      return `the video models are still downloading${pct}; try again when they are ready`;
    }
    case "failed":
      return "the video model download failed; an admin can try it again";
    case "unavailable":
      return "this instance has no video models";
    default:
      return "the instance does not report its video models yet";
  }
}

/** One usage history entry as the browser may see it: an explicit allowlist (no hostname). */
function publicUsage(e: UsageItem) {
  return {
    vast_instance_id: e.instance_id,
    gpu_name: e.gpu_name,
    dph: e.dph,
    started_at: e.started_at,
    ready_at: e.ready_at,
    ended_at: e.ended_at,
    duration_s: e.duration_s,
    estimated_cost: e.estimated_cost,
    started_by: e.started_by,
    reason: e.reason,
    stop_by: e.stop_by,
    active: e.active,
    location: e.location,
    down_mbps: e.down_mbps,
  };
}

/** The status view as the browser may see it: an explicit allowlist of fields. */
function publicView(view: StatusView, isAdmin: boolean, scrub: (t: string) => string) {
  const detail = (text: string | null): string | null => {
    if (text === null) return null;
    return isAdmin ? scrub(text) : "unavailable";
  };
  const a = view.agent;
  return {
    state: view.state,
    record: view.record
      ? {
          status: view.record.status,
          profile: view.record.profile,
          created_at: view.record.created_at,
          vast_instance_id: view.record.vast_instance_id,
        }
      : null,
    vast: view.vast,
    vast_error: detail(view.vast_error),
    agent: a
      ? {
          state: a.state,
          reason: a.reason === null ? null : scrub(a.reason),
          queue: a.queue,
          gpu: {
            util_percent: a.gpu.util_percent ?? null,
            vram_total_mb: a.gpu.vram_total_mb ?? null,
            vram_used_mb: a.gpu.vram_used_mb ?? null,
          },
          failsafe_alive: a.failsafe_alive,
          destroy: { pending: a.destroy.pending, attempts: a.destroy.attempts },
        }
      : null,
    agent_error: detail(view.agent_error),
    agent_unreachable: view.agent_unreachable,
    failed: view.failed ? { reason: view.failed.reason === null ? null : scrub(view.failed.reason) } : null,
    destroy_failed: view.destroy_failed ? { error: detail(view.destroy_failed.error) ?? "unavailable" } : null,
    dph: view.dph,
    uptime_s: view.uptime_s,
    cost_so_far: view.cost_so_far,
    progress: view.progress,
    gpu_name: view.gpu_name === null ? null : scrub(view.gpu_name).slice(0, GPU_NAME_MAX),
    // A fixed code and its fixed text, plus where the server was (machine id for admins only).
    start_failure: view.start_failure
      ? {
          code: view.start_failure.code,
          message: startFailureMessage(view.start_failure.code, view.start_failure.measured_mb_s, view.start_failure.limit_min),
          server: publicServer(view.start_failure.server, isAdmin, scrub),
          measured_mb_s: view.start_failure.measured_mb_s,
          limit_min: view.start_failure.limit_min,
        }
      : null,
    server: publicServer(view.server, isAdmin, scrub),
    // Numbers plus a profile file name: no instance internals.
    download: view.download,
    remaining: view.remaining,
    // Only admins can act on unknown instances; labels (which carry hostnames) are not sent.
    unknown: isAdmin
      ? view.unknown.map((u) => ({
          vast_instance_id: u.vast_instance_id,
          actual_status: u.actual_status,
          start_date: u.start_date,
          dph: u.dph,
        }))
      : [],
  };
}

const EMPTY_BODY = { type: "object", additionalProperties: false, properties: {} } as const;
// The browser sends only a model NAME; the server checks it against VAST_ALLOWED_GPUS.
const GPU_FIELD = { type: "string", minLength: 1, maxLength: GPU_NAME_MAX } as const;
// The advanced server choice: the same members in the query of the read routes and in the Start body. The shape is
// checked here; the values (region list, price cap, speed bound, offer id) are checked by the lifecycle.
// Query values are text (the server does not coerce types), so numbers are matched by pattern and converted below.
const FILTER_QUERY_PROPS = {
  region: { type: "string", maxLength: 32 },
  max_dph: { type: "string", pattern: "^[0-9]{1,6}(\\.[0-9]{1,6})?$" },
  min_down_mbps: { type: "string", pattern: "^[0-9]{1,9}$" },
  sort: { type: "string", maxLength: 16 },
  offer_id: { type: "string", pattern: "^[0-9]{1,15}$" },
  video_models: { type: "string", enum: ["true", "false"] },
  // Comma separated video family ids (only with video_models): the disk is sized for their files.
  video_families: { type: "string", pattern: "^[a-z0-9_,]{0,300}$" },
} as const;
const FILTER_BODY_PROPS = {
  region: { type: ["string", "null"], maxLength: 32 },
  max_dph: { type: ["number", "null"] },
  min_down_mbps: { type: ["integer", "null"] },
  sort: { type: ["string", "null"], maxLength: 16 },
  offer_id: { type: ["integer", "null"] },
  video_models: { type: ["boolean", "null"] },
  // The video families whose files the boot downloads (only with video_models); none: the base section.
  video_families: { type: ["array", "null"], maxItems: 8, items: { type: "string", maxLength: 32 } },
} as const;
const FILTER_KEYS = ["region", "max_dph", "min_down_mbps", "sort", "offer_id", "video_models"] as const;
const START_BODY = {
  type: "object",
  additionalProperties: false,
  required: ["confirm"],
  properties: {
    confirm: { const: true },
    gpu: GPU_FIELD,
    ...FILTER_BODY_PROPS,
    // A link that replaces the video diffusion model (only with video_models true); checked by parseModelLink.
    video_model_url: { type: ["string", "null"], maxLength: MODEL_LINK_MAX_CHARS },
  },
} as const;
const VIDEO_MODELS_BODY = {
  type: "object",
  additionalProperties: false,
  properties: {
    url: { type: ["string", "null"], maxLength: MODEL_LINK_MAX_CHARS },
    // A video family other than the base section; `links` (every expert slot of `mode`) replace that mode's experts.
    family: { type: ["string", "null"], maxLength: 32 },
    mode: { type: ["string", "null"], maxLength: 16 },
    links: { type: ["object", "null"], maxProperties: 4, additionalProperties: { type: "string", maxLength: MODEL_LINK_MAX_CHARS } },
  },
} as const;
// Extra LoRAs added by admins: the body shapes (the store checks every value again, the links too).
const LORA_PATCH_PROPS = {
  title: { type: "string", minLength: 1, maxLength: 60 },
  description: { type: "string", maxLength: 400 },
  modes: { type: "array", minItems: 1, maxItems: 2, items: { type: "string", enum: ["text", "image"] } },
  strength: { type: "number", minimum: 0, maximum: 1 },
  hidden: { type: "boolean" },
  trigger_words: { type: "string", maxLength: 200 },
} as const;
const LORA_BODY = {
  type: "object",
  additionalProperties: false,
  required: ["title", "family", "modes"],
  properties: {
    ...LORA_PATCH_PROPS,
    family: { type: "string", maxLength: 32 },
    high: { type: ["string", "null"], maxLength: MODEL_LINK_MAX_CHARS },
    low: { type: ["string", "null"], maxLength: MODEL_LINK_MAX_CHARS },
  },
} as const;
const LORA_PATCH_BODY = { type: "object", additionalProperties: false, minProperties: 1, properties: LORA_PATCH_PROPS } as const;
const LORA_ID_PARAMS = { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", pattern: "^[a-z0-9_]{3,32}$" } } } as const;
/** The header the page sends after the reveal gesture; the server honours it for admins only. */
const REVEAL_HEADER = "x-reveal-hidden";

const ESTIMATE_QUERY = {
  type: "object",
  additionalProperties: false,
  properties: { gpu: GPU_FIELD, ...FILTER_QUERY_PROPS },
} as const;
const ID_PARAMS = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", pattern: PROMPT_ID.source } },
} as const;
// The file name a downloaded video gets, per type (the type comes from the file's magic bytes).
const VIDEO_EXT: Record<string, string> = { "video/mp4": "mp4", "video/webm": "webm" };
const IMAGE_PARAMS = {
  type: "object",
  additionalProperties: false,
  required: ["id", "index"],
  properties: { id: { type: "string", pattern: PROMPT_ID.source }, index: { type: "string", pattern: "^[0-9]{1,3}$" } },
} as const;
// `after` is a decimal integer 0..2^53-1 (the range is checked again after parsing).
const CONSOLE_QUERY = {
  type: "object",
  additionalProperties: false,
  properties: { after: { type: "string", pattern: "^(0|[1-9][0-9]{0,15})$" } },
} as const;
// Public image id: <owner>.<time>.<job>.<index> (apps/core/src/gallery.ts).
const GALLERY_ID = "^[0-9a-f]{32}\\.[0-9]{13}\\.[A-Za-z0-9_-]{1,128}\\.[0-9]{1,3}$";
const GALLERY_ID_PARAMS = { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", pattern: GALLERY_ID } } } as const;
const GALLERY_SAVE_BODY = {
  type: "object",
  additionalProperties: false,
  required: ["job", "index"],
  properties: { job: { type: "string", pattern: PROMPT_ID.source }, index: { type: "integer", minimum: 0, maximum: 999 } },
} as const;
const GALLERY_DELETE_BODY = { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", pattern: GALLERY_ID } } } as const;
const GALLERY_QUERY = {
  type: "object",
  additionalProperties: false,
  properties: { cursor: { type: "string", pattern: GALLERY_ID }, scope: { type: "string", enum: ["mine", "all"] } },
} as const;
const JOB_PROMPT_KEPT = 500;
// The progress socket gets this long to connect before a job is submitted anyway (so ComfyUI's
// execution_start, and with it the queue time, is usually seen); it never fails a submit.
const PROGRESS_OPEN_WAIT_MS = 1000;
const CLIENT_ID_BYTES = 16;
const JOB_LABEL_KEPT = 120;

// Field values are validated by the generate service so its error codes reach the client.
const GENERATE_BODY = {
  type: "object",
  additionalProperties: false,
  required: ["prompt", "preset", "size"],
  properties: { prompt: {}, preset: {}, size: {}, seed: {}, style: {}, negative_prompt: {}, cfg: {} },
} as const;

// Edit: the references travel as base64 text in the JSON body (so every gate for JSON bodies applies
// unchanged); their number, size and type are validated by the edit service, which has the error codes.
const EDIT_BODY = {
  type: "object",
  additionalProperties: false,
  required: ["prompt", "preset", "resolution", "images"],
  properties: { prompt: {}, preset: {}, resolution: {}, size: {}, seed: {}, images: { type: "array" }, style: {}, negative_prompt: {}, cfg: {} },
} as const;
// Upscale: one base64 image and a scale name; the service validates both and has the error codes.
const UPSCALE_BODY = {
  type: "object",
  additionalProperties: false,
  required: ["image", "scale"],
  properties: { image: {}, scale: {} },
} as const;
// Video: a prompt, a size and a duration name, an optional seed and an optional base64 start image; the
// service validates each and has the error codes.
const VIDEO_BODY = {
  type: "object",
  additionalProperties: false,
  required: ["prompt", "size", "duration"],
  properties: { prompt: {}, size: {}, duration: {}, seed: {}, image: {}, family: { type: "string", maxLength: 32 }, extra_lora: {}, extra_lora_strength: {} },
} as const;
// JSON adds quotes and a comma around each image; the prompt may need escapes (up to 6 bytes a character).
const EDIT_JSON_OVERHEAD = 8;
const PROMPT_ESCAPE_FACTOR = 6;
const EDIT_BODY_SLACK = 1024;
const BASE64_PER_BYTES = 3;
const BASE64_CHARS_PER_GROUP = 4;

/** The service request from a body: the API spells it negative_prompt, the services negativePrompt. */
function withNegative<T extends object>(body: T): T & { negativePrompt?: unknown } {
  const raw = (body as { negative_prompt?: unknown }).negative_prompt;
  return raw === undefined ? body : { ...body, negativePrompt: raw };
}

/** Request body limit of POST /api/edit, derived from the reference limits (the global limit stays small). */
function editBodyLimit(limits: ReferenceLimits, maxTextChars: number): number {
  const perImage = Math.ceil(limits.maxBytes / BASE64_PER_BYTES) * BASE64_CHARS_PER_GROUP + EDIT_JSON_OVERHEAD;
  return limits.maxCount * perImage + maxTextChars * PROMPT_ESCAPE_FACTOR + EDIT_BODY_SLACK;
}

/** ", guidance 3.5" and ", negative prompt" for the label of a job that set them (validated before submit). */
function tuningSuffix(body: { negative_prompt?: unknown; cfg?: unknown }): string {
  const cfg = typeof body.cfg === "number" ? `, guidance ${body.cfg}` : "";
  const negative = typeof body.negative_prompt === "string" && body.negative_prompt.trim() !== "" ? ", negative prompt" : "";
  return `${cfg}${negative}`;
}

export function registerApiRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const cfg = deps.cfg;
  const startLimiter = new RateLimiter(intCfg(cfg, "startRateLimitPerHour", "START_RATE_LIMIT_PER_HOUR"), HOUR_MS, now);
  const generateLimiter = new RateLimiter(
    intCfg(cfg, "webGenerateRateLimitPerHour", "WEB_GENERATE_RATE_LIMIT_PER_HOUR"),
    HOUR_MS,
    now,
  );
  const jobs = new JobStore(
    intCfg(cfg, "webJobCacheMax", "WEB_JOB_CACHE_MAX"),
    intCfg(cfg, "webJobTtlS", "WEB_JOB_TTL_S") * 1000,
    now,
  );
  const generateTimeoutMs = intCfg(cfg, "generateTimeoutS", "GENERATE_TIMEOUT_S") * 1000;
  // Video is on only when the profile has an enabled video section AND its workflow template was loaded. The
  // template is checked against the section now: a mismatch stops the server instead of failing a job.
  const videoSpec = deps.profile.video;
  const videoTemplate = deps.videoTemplate ?? null;
  const videoLimits: ReferenceLimits | null = videoSpec !== null && videoTemplate !== null ? referenceLimits(cfg) : null;
  if (videoSpec !== null && videoLimits !== null) checkVideoTemplate(videoSpec, videoTemplate);
  // A clip takes many minutes: it has its own job timeout and its own size and time bounds for the result file.
  const videoTimeoutMs = videoLimits === null ? null : intCfg(cfg, "videoTimeoutS", "VIDEO_TIMEOUT_S") * 1000;
  const videoView =
    videoLimits === null
      ? null
      : { maxBytes: intCfg(cfg, "videoMaxBytes", "VIDEO_MAX_BYTES"), timeoutMs: intCfg(cfg, "videoViewTimeoutS", "VIDEO_VIEW_TIMEOUT_S") * 1000 };
  // A job is forgotten after WEB_JOB_TTL_S: a video job must time out (and be readable) before that.
  if (videoTimeoutMs !== null && videoTimeoutMs >= intCfg(cfg, "webJobTtlS", "WEB_JOB_TTL_S") * 1000) {
    throw new Error("VIDEO_TIMEOUT_S must be shorter than WEB_JOB_TTL_S");
  }
  // The size of the video model files (profile `models` entries the video section lists).
  const videoDownloadBytes =
    videoSpec === null
      ? 0
      : deps.profile.models
          .filter((m) => videoSpec.models.some((v) => v.file === m.file.split("/").pop()))
          .reduce((sum, m) => sum + m.size_bytes, 0);
  /** The size of the profile `models` entries of these video files. */
  const bytesOf = (files: readonly { file: string }[]): number =>
    deps.profile.models.filter((m) => files.some((v) => v.file === m.file.split("/").pop())).reduce((sum, m) => sum + m.size_bytes, 0);
  // More video families (VIDEO_FAMILIES): a workflow per mode, each checked now like the base section's.
  const baseFamily = deps.profile.videoFamilies.find((f) => f.base) ?? null;
  const extraFamilies: { family: VideoFamily; templates: { text: unknown; image: unknown }; downloadBytes: number }[] =
    videoLimits === null
      ? []
      : deps.profile.videoFamilies.filter((f) => !f.base).map((family) => {
          const load = (name: string): unknown => {
            const t = deps.videoFamilyTemplates?.[name];
            if (t === undefined || t === null) throw new Error(`video family ${family.id}: its workflow ${name} did not load`);
            return t;
          };
          const templates = { text: load(family.text.workflow), image: load(family.image.workflow) };
          checkVideoFamily(family, templates);
          return { family, templates, downloadBytes: bytesOf(family.models) };
        });
  /** The family a request names: null for the base section (no family, or its id), undefined for an unknown one. */
  const familyOf = (id: unknown): (typeof extraFamilies)[number] | null | undefined =>
    id === undefined || id === null || (baseFamily !== null && id === baseFamily.id) ? null : extraFamilies.find((x) => x.family.id === id);
  // ---- extra LoRAs added by admins (LORA_STORE_PATH): only where video and a family that takes extra LoRAs are on ----
  /** The families an added LoRA may apply to: those with a join point for an extra LoRA in some mode. */
  const loraFamilies = extraFamilies.filter((x) => Object.keys(x.family.text.loraAfter).length + Object.keys(x.family.image.loraAfter).length > 0);
  const loraStore = videoLimits === null || loraFamilies.length === 0 ? null : (deps.loraStore ?? null);
  const loraWriteLimiter = new RateLimiter(loraStore === null ? 1 : intCfg(cfg, "loraWriteRateLimitPerHour", "LORA_WRITE_RATE_LIMIT_PER_HOUR"), HOUR_MS, now);
  const loraSyncMs = loraStore === null ? 0 : intCfg(cfg, "loraSyncMinIntervalS", "LORA_SYNC_MIN_INTERVAL_S") * 1000;
  let lastLoraSync = Number.NEGATIVE_INFINITY;
  /** An added LoRA as an extra LoRA of its family (file names from the store only). */
  const asExtra = (l: StoredLora): VideoExtraLora => ({
    id: l.id, title: l.title, description: l.description, modes: [...l.modes], strength: l.strength, triggerWords: l.trigger_words,
    files: Object.fromEntries(LORA_SIDES.flatMap((side) => (l[side] ? [[side, l[side]!.name]] : []))),
  });
  /** The added LoRAs of a family a caller may see or use: hidden ones only when `withHidden` (admins). */
  const storedFor = (familyId: string, withHidden: boolean): StoredLora[] =>
    loraStore === null ? [] : loraStore.list().filter((l) => l.family === familyId && (withHidden || !l.hidden));
  /** The files the instance should have: every added LoRA of an enabled family, hidden ones too. */
  const wantedLoras = (): { name: string; url: string }[] =>
    loraStore === null
      ? []
      : loraStore.list().filter((l) => loraFamilies.some((x) => x.family.id === l.family))
          .flatMap((l) => LORA_SIDES.flatMap((side) => (l[side] ? [{ name: l[side]!.name, url: l[side]!.url }] : [])));
  /** An added LoRA's state on the instance: every file ready, else the least advanced; null when the agent does not say. */
  const storedStatus = (l: StoredLora, reported: LorasStatus | null | undefined): string | null => {
    if (reported === null || reported === undefined || !Array.isArray(reported.items)) return null;
    const states = LORA_SIDES.flatMap((side) => (l[side] ? [reported.items.find((i) => i.name === l[side]!.name)?.state ?? "not_installed"] : []));
    for (const s of ["failed", "not_installed", "downloading"]) if (states.includes(s as never)) return s;
    return "ready";
  };
  /** Send the wanted set to the instance; never throws (a failed sync is retried by a later state poll). */
  const syncLoras = async (): Promise<void> => {
    if (loraStore === null || typeof deps.lifecycle.syncLoras !== "function") return;
    lastLoraSync = now();
    try {
      await deps.lifecycle.syncLoras(wantedLoras());
    } catch (err) {
      if (!(err instanceof NoActiveInstanceError)) log("warn", `extra LoRA sync failed: ${errorName(err)}`);
    }
  };
  /** Why a LoRA's family and modes cannot take it (null when they can): each mode needs a join point per branch. */
  const loraFit = (familyId: unknown, modes: readonly string[], sides: readonly string[]): string | null => {
    const x = loraFamilies.find((f) => f.family.id === familyId);
    if (x === undefined) return "family must be a video family that takes extra LoRAs here";
    for (const mode of modes) {
      const spec = mode === "image" ? x.family.image : x.family.text;
      for (const side of sides) if (spec.loraAfter[side] === undefined) return `the ${mode} mode of this family takes no extra LoRA on the ${side} branch`;
    }
    return null;
  };
  // The hosts a video model link may name (read only while video is on).
  const linkHosts: string[] = (() => {
    if (videoLimits === null) return [];
    const v = cfg["videoModelLinkHosts"];
    if (!Array.isArray(v) || v.length === 0 || !v.every((h) => typeof h === "string" && h !== "")) {
      throw new Error("VIDEO_MODEL_LINK_HOSTS must list one or more host names");
    }
    return v as string[];
  })();
  /** A checked video model link (canonical URL), null for none, or the 400 reply already sent. */
  const readModelLink = (reply: FastifyReply, raw: unknown): string | null | FastifyReply => {
    if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return null;
    try {
      return parseModelLink(typeof raw === "string" ? raw.trim() : raw, linkHosts).url;
    } catch (err) {
      if (err instanceof ModelLinkError) return sendError(reply, 400, err.code, err.message);
      throw err;
    }
  };
  /** How long a job of this kind may run before it is given up. */
  const timeoutOf = (kind: JobKind): number => (kind === "video" && videoTimeoutMs !== null ? videoTimeoutMs : generateTimeoutMs);
  // Live progress and previews: one ComfyUI websocket per job, open at most as long as a job may run.
  const progressLimits: ProgressLimits | null =
    cfg["webProgressEnabled"] === true
      ? {
          lifetimeMs: Math.max(generateTimeoutMs, videoTimeoutMs ?? 0),
          maxTextBytes: intCfg(cfg, "webProgressMessageMaxBytes", "WEB_PROGRESS_MESSAGE_MAX_BYTES"),
          maxPreviewBytes: intCfg(cfg, "webPreviewMaxBytes", "WEB_PREVIEW_MAX_BYTES"),
        }
      : null;
  // Credit: only when a source is wired, so a deployment without one needs no VAST_CREDIT_CACHE_S.
  const creditCache =
    deps.credit === undefined
      ? null
      : new CreditCache(() => deps.credit!(), intCfg(cfg, "vastCreditCacheS", "VAST_CREDIT_CACHE_S") * 1000, now);
  const extendMax = intCfg(cfg, "webExtendMaxMinutes", "WEB_EXTEND_MAX_MINUTES");
  /** A scrubber that also knows the active record's token and hostname. */
  const activeScrubber = async (): Promise<(text: string) => string> => {
    const active = await deps.registry.active().catch(() => null);
    return scrubber(deps, active ? [active.agent_token, active.tailnet_hostname] : []);
  };
  const tooLarge = (reply: FastifyReply, code = "upstream_too_large") =>
    sendError(reply, UPSTREAM_FAILED, code, "the instance sent a response larger than allowed");
  const admin = { config: { access: "admin" as const } };
  const member = { config: { access: "member" as const } };

  // Edit is on only when the profile has an edit section AND its workflow template was loaded.
  const editSpec = deps.profile.edit;
  const editTemplate = deps.editTemplate ?? null;
  const limits: ReferenceLimits | null = editSpec !== null && editTemplate !== null ? referenceLimits(cfg) : null;
  // The edit body carries the prompt and the negative prompt; both are bounded here for its body limit.
  const maxTextChars =
    limits === null
      ? 0
      : intCfg(cfg, "generateMaxPromptChars", "GENERATE_MAX_PROMPT_CHARS") +
        intCfg(cfg, "generateMaxNegativePromptChars", "GENERATE_MAX_NEGATIVE_PROMPT_CHARS");
  // Read at startup like every other limit; a style's default negative prompt must fit it, or the page would
  // pre-fill a text the server then refuses.
  const maxNegativeChars = intCfg(cfg, "generateMaxNegativePromptChars", "GENERATE_MAX_NEGATIVE_PROMPT_CHARS");
  for (const st of deps.profile.styles) {
    const neg = st.defaults.negativePrompt;
    if (neg !== null && neg.length > maxNegativeChars) {
      throw new Error(`style ${st.id}: its default negative prompt is longer than GENERATE_MAX_NEGATIVE_PROMPT_CHARS (${maxNegativeChars})`);
    }
  }
  // The page shows the guidance default when nothing is chosen and then sends no cfg: it must be the workflows' own.
  checkGuidanceDefault(deps.profile, { generate: deps.template, edit: editTemplate });
  // What each mode's workflow takes (edit only when edit is on here).
  const advancedOf = (mode: "generate" | "edit") => {
    const t = mode === "edit" && limits === null ? { negativePrompt: false, cfg: false } : tuningSupport(deps.profile, mode);
    return { negative_prompt: t.negativePrompt, cfg: t.cfg && deps.profile.guidance !== null };
  };

  const gallery = deps.gallery ?? null;
  // Upscale is on only when the profile has an enabled upscale section AND its template was loaded.
  const upscaleSpec = deps.profile.upscale;
  const upscaleTemplate = deps.upscaleTemplate ?? null;
  const upscaleLimits: ReferenceLimits | null = upscaleSpec !== null && upscaleTemplate !== null ? referenceLimits(cfg) : null;
  // The pixel bounds are read here, at startup, like every other limit (a bad value stops the server).
  const upscalePixels: UpscaleLimits | null =
    upscaleLimits === null
      ? null
      : {
          maxOutputPixels: intCfg(cfg, "upscaleMaxOutputPixels", "UPSCALE_MAX_OUTPUT_PIXELS"),
          maxIntermediatePixels: intCfg(cfg, "upscaleMaxIntermediatePixels", "UPSCALE_MAX_INTERMEDIATE_PIXELS"),
        };

  // The tool menu is fixed at startup (profile and which modes are on here); only titles, descriptions, icon
  // names and ids, never templates, node ids or file names.
  const menuItemsOn = menuItems(deps.profile.menu, deps.profile.styles).map((item) => ({
    ...item,
    available:
      item.tool === "generate" ||
      (item.tool === "edit" ? limits !== null && editSpec !== null : item.tool === "video" ? videoLimits !== null : upscaleLimits !== null),
  }));
  const menuView = {
    categories: deps.profile.menu.categories.filter((c) => menuItemsOn.some((i) => i.category === c.id)).map((c) => ({ id: c.id, title: c.title })),
    items: menuItemsOn,
  };

  const generateDeps = (hostname: string, kind: JobKind = "generate"): GenerateDeps => ({
    comfy: deps.comfyFor(hostname),
    profile: deps.profile,
    template: kind === "edit" ? editTemplate : kind === "upscale" ? upscaleTemplate : kind === "video" ? videoTemplate : deps.template,
    cfg,
  });
  const upscaleDeps = (hostname: string, limits: UpscaleLimits): UpscaleDeps => ({
    comfy: deps.comfyFor(hostname),
    profile: deps.profile,
    template: upscaleTemplate,
    cfg,
    limits,
  });
  const videoDeps = (hostname: string): VideoDeps => ({
    comfy: deps.comfyFor(hostname),
    profile: deps.profile,
    template: videoTemplate,
    cfg,
  });
  const editDeps = (hostname: string): EditDeps => ({
    comfy: deps.comfyFor(hostname),
    profile: deps.profile,
    template: editTemplate,
    cfg,
  });

  /** The node whose progress is a sampler step, per kind of job (upscale has none: any progress counts). */
  const samplerNode = (kind: JobKind): string | null =>
    kind === "generate"
      ? deps.profile.generate.params.steps.node
      : kind === "edit"
        ? (deps.profile.edit?.params.steps.node ?? null)
        : kind === "video"
          ? (videoSpec?.params.seed.node ?? null)
          : null;

  /**
   * Open the progress socket of a job about to be submitted and wait briefly for it. Null when progress
   * is off or the client cannot open one; never throws and never delays a submit by more than
   * PROGRESS_OPEN_WAIT_MS.
   */
  const startLive = async (hostname: string, kind: JobKind, sampler: string | null = samplerNode(kind)): Promise<{ live: LiveProgress; clientId: string } | null> => {
    if (progressLimits === null) return null;
    const comfy = deps.comfyFor(hostname);
    if (typeof comfy.progress !== "function") return null;
    const clientId = randomBytes(CLIENT_ID_BYTES).toString("hex");
    const live = new LiveProgress(now);
    try {
      const socket = comfy.progress(clientId, live, progressLimits, sampler);
      live.socket = socket;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<void>((resolve) => (timer = setTimeout(resolve, PROGRESS_OPEN_WAIT_MS)));
      await Promise.race([socket.ready, waited]);
      clearTimeout(timer);
    } catch {
      live.end();
      return null;
    }
    return { live, clientId };
  };

  /** ", <style title>" for the label of a job that ran with a style (it was validated before submit). */
  const styleSuffix = (style: unknown): string => {
    const id = typeof style === "object" && style !== null ? (style as { id?: unknown }).id : undefined;
    const found = deps.profile.styles.find((st) => st.id === id);
    return found ? `, ${found.title}` : "";
  };

  /** The reply for a job that could not be submitted (shared by generate and edit). */
  const submitFailure = (reply: FastifyReply, err: unknown, what: string): FastifyReply => {
    if (err instanceof GenerateInputError) {
      if (err.code === "workflow_mismatch") {
        log("error", "the profile does not match its workflow template");
        return sendError(reply, 500, "profile_mismatch", "the server profile is misconfigured");
      }
      if (err.code === "upscale_unavailable") return sendError(reply, 404, "upscale_unavailable", "upscale is not available on this server");
      if (err.code === "edit_unavailable") return sendError(reply, 404, "edit_unavailable", "image edit is not available on this server");
      if (err.code === "video_unavailable") return sendError(reply, 404, "video_unavailable", "video is not available on this server");
      return sendError(reply, 400, err.code, err.message);
    }
    log("warn", `${what} submit failed: ${errorName(err)}`);
    if (err instanceof ResponseTooLarge) return tooLarge(reply);
    return sendError(reply, UPSTREAM_FAILED, "comfy_unavailable", "ComfyUI could not accept the job");
  };

  /** The job if the caller may read it; otherwise null (unknown and foreign jobs look alike). */
  const ownJob = (req: FastifyRequest, id: string): Job | null => {
    const job = jobs.get(id);
    if (job === null || req.identity === null) return null;
    return job.owner === req.identity.subject || req.role === "admin" ? job : null;
  };

  /** True when the job's instance is still the active one. */
  const sameInstance = async (job: Job): Promise<boolean> => {
    const active = await deps.registry.active();
    return active !== null && active.tailnet_hostname === job.hostname;
  };

  // Who is signed in: display fields and the role only (no subject, email or group list).
  app.get("/api/me", member, async (req) => ({
    name: req.identity?.name ?? null,
    username: req.identity?.username ?? "",
    role: req.role,
  }));

  app.get("/api/state", member, async (req) => {
    const view = await deps.lifecycle.view();
    // An instance destroyed without the Destroy button (idle, failsafe, hard cap, stuck release): every page
    // polls this, so no job's progress socket outlives its instance by more than one poll.
    const activeHost = view.record !== null && view.record.status !== "gone" ? view.record.tailnet_hostname : null;
    jobs.endLiveExcept(activeHost);
    const isAdmin = req.role === "admin";
    // Hidden added LoRAs: to admins only, and only when the page asks (after the reveal gesture); never to members.
    const reveal = isAdmin && req.headers[REVEAL_HEADER] === "1";
    // The instance's extra LoRA files follow the store: sync when its set differs (throttled; an add or a delete
    // syncs at once). Only while it serves and its agent reports them.
    const reportedLoras = view.agent?.extra_loras;
    if (loraStore !== null && READY_STATES.has(view.state) && typeof reportedLoras === "object" && reportedLoras !== null) {
      const wanted = wantedLoras();
      const differs = reportedLoras.digest !== lorasDigest(wanted) && !(reportedLoras.digest === null && wanted.length === 0);
      if (differs && now() - lastLoraSync >= loraSyncMs) void syncLoras();
    }
    // The view passes agent-provided text (reason) through unscrubbed: remove the token too.
    const token = (await deps.registry.active())?.agent_token ?? "";
    const scrub = scrubber(deps, [token, ...hostnamesOf(view)]);
    return {
      ...publicView(view, isAdmin, scrub),
      role: req.role,
      presets: deps.profile.generate.qualityPresets.map((p) => ({ name: p.name, steps: p.steps })),
      sizes: deps.profile.generate.sizes.map((s) => ({ name: s.name, width: s.width, height: s.height })),
      // Whether Save and the gallery are available (an object store is configured).
      gallery: gallery !== null,
      // The enabled styles with the limits the page needs to draw their panels. Never the LoRA file
      // name, the workflow nodes or where a value goes.
      styles: deps.profile.styles.map((st) => ({
        id: st.id,
        title: st.title,
        kind: st.kind,
        modes: [...st.modes],
        // A style with a prompt template takes the prompt as optional notes.
        prompt_optional: st.promptTemplate !== null,
        references: st.references === null ? null : { min: st.references.min, max: st.references.max, labels: [...st.references.labels] },
        hint: st.hint,
        // What the page pre-fills for this style (the user can change each); only the keys the style sets.
        defaults: {
          ...(st.defaults.negativePrompt === null ? {} : { negative_prompt: st.defaults.negativePrompt }),
          ...(st.defaults.cfg === null ? {} : { cfg: st.defaults.cfg }),
          ...(st.defaults.preset === null ? {} : { preset: st.defaults.preset }),
          ...(st.defaults.size === null ? {} : { size: st.defaults.size }),
          ...(st.defaults.resolution === null ? {} : { resolution: st.defaults.resolution }),
        },
        params: st.params.map((p) => ({
          id: p.id,
          title: p.title,
          type: p.type,
          ...(p.min === undefined ? {} : { min: p.min }),
          ...(p.max === undefined ? {} : { max: p.max }),
          ...(p.step === undefined ? {} : { step: p.step }),
          ...(p.choices === undefined ? {} : { choices: [...p.choices] }),
          default: p.default,
        })),
      })),
      // Guidance (cfg) limits and the negative prompt, only when the profile maps them. Never node ids.
      guidance:
        deps.profile.guidance === null
          ? null
          : {
              min: deps.profile.guidance.min,
              max: deps.profile.guidance.max,
              step: deps.profile.guidance.step,
              default: deps.profile.guidance.default,
            },
      // Which of the two knobs each mode's workflow takes, so the page offers only those.
      advanced: { generate: advancedOf("generate"), edit: advancedOf("edit"), negative_prompt_max_chars: maxNegativeChars },
      // Upscale for the page: the scale names and the image limits; null when upscale is off here.
      upscale:
        upscaleLimits === null || upscaleSpec === null
          ? null
          : {
              scales: upscaleSpec.scales.map((sc) => sc.name),
              max_bytes: upscaleLimits.maxBytes,
              max_pixels: upscaleLimits.maxPixels,
              types: [...upscaleLimits.types],
            },
      // The tool menu: categories and entries in display order; `available` is false while the entry's mode is off.
      menu: menuView,
      // Video for the page: size and duration names (seconds, never frames or nodes) and the start image limits;
      // null when video is off here.
      video:
        videoLimits === null || videoSpec === null
          ? null
          : {
              sizes: videoSpec.sizes.map((z) => ({ name: z.name, width: z.width, height: z.height })),
              durations: videoSpec.durations.map(publicDuration),
              // What "Download video models" fetches (all of them; the instance fetches only the missing ones).
              download_bytes: videoDownloadBytes,
              // The instance's own state of its video model files; null without an instance or an answer.
              models: publicVideoModels(view.agent?.video_models, scrub),
              // Which diffusion model is in use (admins only): pinned, or linked and NOT integrity-pinned.
              model: isAdmin ? publicVideoModel(view.agent?.video_models) : null,
              max_bytes: videoLimits.maxBytes,
              max_pixels: videoLimits.maxPixels,
              types: [...videoLimits.types],
            },
      // The video families to choose from (the base section first); null unless VIDEO_FAMILIES adds one. The same
      // public fields as video, plus the expert slots an admin may link; the expert file names for admins only.
      video_families:
        videoLimits === null || videoSpec === null || baseFamily === null || extraFamilies.length === 0
          ? null
          : [
              {
                id: baseFamily.id, title: baseFamily.title, base: true,
                sizes: videoSpec.sizes.map((z) => ({ name: z.name, width: z.width, height: z.height })),
                durations: videoSpec.durations.map(publicDuration),
                download_bytes: videoDownloadBytes,
                models: publicVideoModels(view.agent?.video_models, scrub),
                slots: null,
                experts: null,
                extra_loras: [],
              },
              ...extraFamilies.map(({ family, downloadBytes }) => {
                const reported = view.agent?.video_families?.find((f) => f.id === family.id) ?? null;
                return {
                  id: family.id, title: family.title, base: false,
                  sizes: family.sizes.map((z) => ({ name: z.name, width: z.width, height: z.height })),
                  durations: family.durations.map(publicDuration),
                  download_bytes: downloadBytes,
                  models: publicVideoModels(reported, scrub),
                  slots: { text: family.text.experts.map((e) => e.slot), image: family.image.experts.map((e) => e.slot) },
                  experts: isAdmin ? publicExperts(reported) : null,
                  // Profile data only; the file names for admins.
                  extra_loras: [
                    ...family.extraLoras.map((l) => ({
                      id: l.id, title: l.title, description: l.description, modes: [...l.modes], strength: l.strength, trigger_words: l.triggerWords,
                      files: isAdmin ? { ...l.files } : null, source: "profile", status: null,
                    })),
                    // Added by admins: hidden ones only to an admin who asked to reveal them.
                    ...storedFor(family.id, reveal).map((l) => ({
                      id: l.id, title: l.title, description: l.description, modes: [...l.modes], strength: l.strength, trigger_words: l.trigger_words,
                      files: isAdmin ? asExtra(l).files : null, source: "added", status: storedStatus(l, reportedLoras),
                      ...(l.hidden ? { hidden: true } : {}),
                    })),
                  ],
                };
              }),
            ],
      // What the page needs to offer edit; null when edit is off on this server.
      edit:
        limits === null || editSpec === null
          ? null
          : {
              max_references: limits.maxCount,
              max_bytes: limits.maxBytes,
              max_pixels: limits.maxPixels,
              types: [...limits.types],
              resolutions: editSpec.resolutions.map((r) => ({ name: r.name, value: r.value })),
              // Output sizes an edit may ask for; empty when the profile offers none (never the node they feed).
              sizes: editSpec.sizes.map((z) => ({ name: z.name, width: z.width, height: z.height })),
            },
    };
  });

  /** The GPU-choice refusals shared by /api/gpus, /api/estimate and /api/start, else null. */
  const gpuRefusal = (reply: FastifyReply, err: unknown): FastifyReply | null => {
    if (err instanceof NoGpuConfiguredError) {
      return sendError(reply, 503, "no_gpu_configured", "no GPU model is configured on the server");
    }
    if (err instanceof GpuNotAllowedError) return sendError(reply, 400, "gpu_not_allowed", "this GPU model is not offered");
    if (err instanceof NoOffersError) {
      return sendError(reply, 409, "no_offers", "no Vast offer matches for this GPU model right now");
    }
    if (err instanceof OfferGoneError) {
      return sendError(reply, 409, "offer_gone", "that offer is no longer available; choose another or refresh the list");
    }
    if (err instanceof StartFilterError) return sendError(reply, 400, "invalid_filter", err.message);
    return null;
  };

  /** The filter members of a query or body, checked against the configured limits; null after a 400 reply was sent. */
  const readFilters = (reply: FastifyReply, source: unknown, fromQuery = false): StartFilters | null => {
    const raw: Record<string, unknown> = {};
    const from = (source ?? {}) as Record<string, unknown>;
    for (const key of FILTER_KEYS) {
      const v = from[key];
      if (v === undefined) continue;
      if (fromQuery && key === "video_models") raw[key] = v === "true";
      else raw[key] = fromQuery && typeof v === "string" && key !== "region" && key !== "sort" ? Number(v) : v;
    }
    try {
      const parsed = deps.lifecycle.parseFilters(raw);
      // The video files can only be included where this server offers video.
      if (parsed.videoModels === true && videoLimits === null) {
        sendError(reply, 400, "video_unavailable", "video is not available on this server");
        return null;
      }
      // The families whose files the boot downloads: enabled ones, each once, only with the video files.
      const rawFamilies = from["video_families"];
      if (rawFamilies !== undefined && rawFamilies !== null) {
        const list = fromQuery ? String(rawFamilies).split(",").filter((x) => x !== "") : (rawFamilies as string[]);
        if (list.length > 0 && parsed.videoModels !== true) {
          sendError(reply, 400, "invalid_filter", "video_families needs video_models");
          return null;
        }
        if (new Set(list).size !== list.length) {
          sendError(reply, 400, "invalid_filter", "video_families lists a family twice");
          return null;
        }
        if (list.some((id) => familyOf(id) === undefined)) {
          sendError(reply, 400, "unknown_family", "video_families names a video family this server does not offer");
          return null;
        }
        if (list.length > 0) parsed.videoFamilies = list;
      }
      return parsed;
    } catch (err) {
      // A malformed VAST_* value is a server configuration problem, reported like the lifecycle's config_invalid.
      if (err instanceof VastError) {
        log("warn", `filters refused: ${errorName(err)} (internal: config_invalid)`);
        sendError(reply, UPSTREAM_FAILED, "config_invalid", "the server configuration for Vast offers is invalid");
        return null;
      }
      if (gpuRefusal(reply, err) === null) throw err;
      return null;
    }
  };

  app.get("/api/gpus", { ...admin, schema: { querystring: { type: "object", additionalProperties: false, properties: FILTER_QUERY_PROPS } } }, async (req, reply) => {
    const filters = readFilters(reply, req.query, true);
    if (filters === null) return reply;
    try {
      return { gpus: await deps.lifecycle.gpuOptions(filters) };
    } catch (err) {
      const refused = gpuRefusal(reply, err);
      if (refused) return refused;
      log("warn", `gpu list failed: ${errorName(err)}`);
      return sendError(reply, UPSTREAM_FAILED, "vast_unavailable", "could not read Vast offers");
    }
  });

  // The Vast account credit, for the admin status card. Only the number leaves: never the account record.
  app.get("/api/credit", admin, async (_req, reply) => {
    if (creditCache === null) return sendError(reply, 404, "credit_unavailable", "the Vast credit is not available on this server");
    try {
      const reading = await creditCache.get();
      return { credit: reading.credit, as_of: Math.floor(reading.at / 1000) };
    } catch (err) {
      log("warn", `credit read failed: ${errorName(err)}`);
      return sendError(reply, UPSTREAM_FAILED, "vast_unavailable", "could not read the Vast account credit");
    }
  });

  // The offers an admin may pick from in the advanced part of the Start dialog (ids are Vast offer ids, never machines).
  app.get("/api/offers", { ...admin, schema: { querystring: ESTIMATE_QUERY } }, async (req, reply) => {
    const { gpu } = req.query as { gpu?: string };
    const filters = readFilters(reply, req.query, true);
    if (filters === null) return reply;
    try {
      return reply.header("cache-control", "no-store").send({ offers: await deps.lifecycle.offers(gpu, filters) });
    } catch (err) {
      const refused = gpuRefusal(reply, err);
      if (refused) return refused;
      log("warn", `offers failed: ${errorName(err)}`);
      return sendError(reply, UPSTREAM_FAILED, "vast_unavailable", "could not read Vast offers");
    }
  });

  app.get("/api/estimate", { ...admin, schema: { querystring: ESTIMATE_QUERY } }, async (req, reply) => {
    const { gpu } = req.query as { gpu?: string };
    const filters = readFilters(reply, req.query, true);
    if (filters === null) return reply;
    try {
      return publicEstimate(await deps.lifecycle.estimate(gpu, filters));
    } catch (err) {
      const refused = gpuRefusal(reply, err);
      if (refused) return refused;
      log("warn", `estimate failed: ${errorName(err)}`);
      return sendError(reply, UPSTREAM_FAILED, "vast_unavailable", "could not read Vast offers");
    }
  });

  app.post("/api/start", { ...admin, schema: { body: START_BODY } }, async (req, reply) => {
    // A malformed filter is refused before it counts: only a well-formed attempt uses the hourly limit.
    const filters = readFilters(reply, req.body);
    if (filters === null) return reply;
    // A video model link: only with the video models, checked before anything counts, is rented or is sent.
    const link = readModelLink(reply, (req.body as { video_model_url?: unknown }).video_model_url);
    if (typeof link === "object" && link !== null) return link;
    if (link !== null && filters.videoModels !== true) {
      return sendError(reply, 400, "invalid_model_link", "a video model link needs Include video models");
    }
    if (link !== null && filters.videoFamilies !== undefined && !filters.videoFamilies.includes(baseFamily?.id ?? "")) {
      return sendError(reply, 400, "invalid_model_link", "a video model link replaces the base video model: include its family");
    }
    if (link !== null) filters.videoModelUrl = link;
    // Every admitted attempt counts, failed or not: the limit protects Vast and the bill.
    if (!startLimiter.take("start")) return sendError(reply, 429, "rate_limited", "too many start requests this hour");
    const { gpu } = req.body as { gpu?: string };
    log("info", `start requested by ${userLabel(req.identity?.username) ?? "?"}`);
    try {
      const { record, estimate } = await deps.lifecycle.start(gpu, req.identity?.username ?? null, filters);
      return { status: record.status, vast_instance_id: record.vast_instance_id, estimate: publicEstimate(estimate) };
    } catch (err) {
      if (err instanceof AlreadyActiveError) return sendError(reply, 409, "already_active", "an instance is already active");
      if (err instanceof NoOffersError) log("warn", "start failed: NoOffersError (internal: no_offers)");
      // Fixed codes only: the requested name is user input and is never logged.
      if (err instanceof GpuNotAllowedError) log("warn", "start refused: gpu_not_allowed");
      if (err instanceof NoGpuConfiguredError) log("warn", "start refused: no_gpu_configured");
      const refused = gpuRefusal(reply, err);
      if (refused) return refused;
      // A fixed reason only: the error message may carry provider text.
      const reason: StartFailReason = err instanceof StartError ? err.reason : "unexpected";
      const detail: StartFailDetail | null = err instanceof StartError && reason === "ts_key_mint_failed" ? err.detail : null;
      const ambiguous = err instanceof StartError && err.ambiguous;
      log("warn", `start failed: ${errorName(err)} (internal: ${reason}${detail === null ? "" : `/${detail}`})${ambiguous ? " (ambiguous)" : ""}`);
      const code = ambiguous ? "start_uncertain" : "start_failed";
      const text = ambiguous && reason !== "create_uncertain" ? START_FAIL_MESSAGES.create_uncertain : startFailText(reason, detail);
      // 424, not 502: a proxy in front (Cloudflare) replaces an origin 502/504 with its own page,
      // and the page would lose this text.
      return sendError(reply, UPSTREAM_FAILED, code, text, reason, detail ?? undefined);
    }
  });

  app.post("/api/destroy", { ...admin, schema: { body: EMPTY_BODY } }, async (req, reply) => {
    log("info", `destroy requested by ${userLabel(req.identity?.username) ?? "?"}`);
    try {
      const result = await deps.lifecycle.destroy(req.identity?.username ?? null);
      jobs.endAllLive(); // the instance is going away: no progress socket stays open to it
      return { outcome: result.outcome, agent_reached: result.agent_error === null };
    } catch (err) {
      log("warn", `destroy failed: ${(err as Error).name}`);
      if (err instanceof DestroyFailedError) {
        return sendError(reply, UPSTREAM_FAILED, "destroy_failed", "Vast destroy failed; it will be retried");
      }
      return sendError(reply, UPSTREAM_FAILED, "destroy_error", "destroy could not be completed");
    }
  });

  app.post(
    "/api/extend",
    {
      ...admin,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "minutes"],
          properties: {
            kind: { type: "string", enum: ["idle", "failsafe"] },
            minutes: { type: "integer", minimum: 1, maximum: extendMax },
          },
        },
      },
    },
    async (req, reply) => {
      const { kind, minutes } = req.body as { kind: "idle" | "failsafe"; minutes: number };
      try {
        const res = await deps.lifecycle.extend(kind, minutes);
        return { kind: res["kind"] === "failsafe" ? "failsafe" : kind, deadline: typeof res["deadline"] === "number" ? res["deadline"] : null };
      } catch (err) {
        if (err instanceof NoActiveInstanceError) return sendError(reply, 409, "no_instance", "no active instance");
        if (err instanceof AgentError && REFUSAL_STATUSES.has(err.status)) {
          const text = err.message.replace(/^extend failed with HTTP \d+:\s*/, "");
          return sendError(reply, 422, "extend_refused", (await activeScrubber())(text));
        }
        if (err instanceof ResponseTooLarge) return tooLarge(reply);
        log("warn", `extend failed: ${(err as Error).name}`);
        return sendError(reply, UPSTREAM_FAILED, "agent_unavailable", "the instance agent could not be reached");
      }
    },
  );

  app.post(
    "/api/destroy-unknown",
    {
      ...admin,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["vast_id"],
          properties: { vast_id: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
        },
      },
    },
    async (req, reply) => {
      const { vast_id } = req.body as { vast_id: number };
      log("info", `destroy-unknown ${vast_id} requested by ${userLabel(req.identity?.username) ?? "?"}`);
      try {
        return { outcome: await deps.lifecycle.destroyUnknown(vast_id) };
      } catch (err) {
        if (err instanceof DestroyFailedError) return sendError(reply, UPSTREAM_FAILED, "destroy_failed", "Vast destroy failed");
        // Not a project instance, or the active one.
        if (err instanceof RefusedError) return sendError(reply, 409, "refused", (await activeScrubber())(err.message));
        log("warn", `destroy-unknown failed: ${(err as Error).name}`);
        return sendError(reply, UPSTREAM_FAILED, "vast_unavailable", "Vast could not be reached");
      }
    },
  );

  // Boot console (admin only: the logs can reveal infrastructure details). Lines are masked by
  // the lifecycle; the server's onSend guard still removes any configured secret.
  app.get("/api/console", { ...admin, schema: { querystring: CONSOLE_QUERY } }, async (req, reply) => {
    const raw = (req.query as { after?: string }).after;
    const after = raw === undefined ? 0 : Number(raw);
    if (!Number.isSafeInteger(after) || after < 0) {
      return sendError(reply, 400, "invalid_query", "after must be an integer between 0 and 9007199254740991");
    }
    try {
      return await deps.lifecycle.console(after);
    } catch (err) {
      log("warn", `console failed: ${errorName(err)}`);
      return sendError(reply, 500, "console_unavailable", "the boot console is unavailable");
    }
  });

  // Usage history (admin only: it names users and shows the spend). Newest first.
  app.get("/api/history", admin, async (_req, reply) => {
    try {
      return { entries: (await deps.lifecycle.history()).map(publicUsage) };
    } catch (err) {
      log("warn", `history failed: ${errorName(err)}`);
      return sendError(reply, 500, "history_unavailable", "the usage history is unavailable");
    }
  });

  app.post("/api/generate", { ...member, schema: { body: GENERATE_BODY } }, async (req, reply) => {
    const identity = req.identity!;
    const view = await deps.lifecycle.view();
    const hostname = view.record?.tailnet_hostname;
    if (!READY_STATES.has(view.state) || hostname === undefined || view.record?.status === "stopping") {
      return sendError(reply, 409, "not_ready", "the instance is not ready");
    }
    if (!generateLimiter.take(identity.subject)) {
      return sendError(reply, 429, "rate_limited", "too many generate requests this hour");
    }
    let promptId: string;
    const started = await startLive(hostname, "generate");
    try {
      ({ promptId } = await generate({ ...generateDeps(hostname), ...(started ? { clientId: started.clientId } : {}) }, withNegative(req.body as GenerateRequest)));
    } catch (err) {
      started?.live.end();
      return submitFailure(reply, err, "generate");
    }
    if (!PROMPT_ID.test(promptId)) {
      started?.live.end();
      return sendError(reply, UPSTREAM_FAILED, "comfy_unavailable", "ComfyUI returned an unusable id");
    }
    started?.live.socket?.setPromptId(promptId);
    const asked = req.body as GenerateRequest;
    jobs.add({
      id: promptId,
      owner: identity.subject,
      hostname,
      live: started?.live ?? null,
      prompt: String(asked.prompt).slice(0, JOB_PROMPT_KEPT),
      label: `${asked.preset}, ${asked.size}${styleSuffix(asked.style)}${tuningSuffix(asked as { negative_prompt?: unknown; cfg?: unknown })}`.slice(0, JOB_LABEL_KEPT),
    });
    return reply.code(202).send({ id: promptId });
  });

  app.post(
    "/api/edit",
    // Own body limit, derived from the reference limits; every other route keeps WEB_BODY_LIMIT_BYTES.
    { ...member, schema: { body: EDIT_BODY }, ...(limits === null ? {} : { bodyLimit: editBodyLimit(limits, maxTextChars) }) },
    async (req, reply) => {
      const identity = req.identity!;
      if (limits === null) return sendError(reply, 404, "edit_unavailable", "image edit is not available on this server");
      const view = await deps.lifecycle.view();
      const hostname = view.record?.tailnet_hostname;
      if (!READY_STATES.has(view.state) || hostname === undefined || view.record?.status === "stopping") {
        return sendError(reply, 409, "not_ready", "the instance is not ready");
      }
      if (!generateLimiter.take(identity.subject)) {
        return sendError(reply, 429, "rate_limited", "too many generate requests this hour");
      }
      let promptId: string;
      const started = await startLive(hostname, "edit");
      try {
        ({ promptId } = await runEdit({ ...editDeps(hostname), ...(started ? { clientId: started.clientId } : {}) }, withNegative(req.body as EditRequest)));
      } catch (err) {
        started?.live.end();
        return submitFailure(reply, err, "edit");
      }
      if (!PROMPT_ID.test(promptId)) {
        started?.live.end();
        return sendError(reply, UPSTREAM_FAILED, "comfy_unavailable", "ComfyUI returned an unusable id");
      }
      started?.live.socket?.setPromptId(promptId);
      const asked = req.body as EditRequest;
      const refs = Array.isArray(asked.images) ? asked.images.length : 0;
      jobs.add({
        id: promptId,
        owner: identity.subject,
        hostname,
        live: started?.live ?? null,
        kind: "edit",
        prompt: String(asked.prompt).slice(0, JOB_PROMPT_KEPT),
        label: `${asked.preset}, ${asked.resolution}${typeof asked.size === "string" ? `, ${asked.size}` : ""}, ${refs} reference${refs === 1 ? "" : "s"}${styleSuffix(asked.style)}${tuningSuffix(asked as { negative_prompt?: unknown; cfg?: unknown })}`.slice(0, JOB_LABEL_KEPT),
      });
      return reply.code(202).send({ id: promptId });
    },
  );

  app.post(
    "/api/upscale",
    { ...member, schema: { body: UPSCALE_BODY }, ...(upscaleLimits === null ? {} : { bodyLimit: editBodyLimit({ ...upscaleLimits, maxCount: 1 }, 0) }) },
    async (req, reply) => {
      const identity = req.identity!;
      if (upscaleLimits === null || upscalePixels === null) return sendError(reply, 404, "upscale_unavailable", "upscale is not available on this server");
      const view = await deps.lifecycle.view();
      const hostname = view.record?.tailnet_hostname;
      if (!READY_STATES.has(view.state) || hostname === undefined || view.record?.status === "stopping") {
        return sendError(reply, 409, "not_ready", "the instance is not ready");
      }
      if (!generateLimiter.take(identity.subject)) {
        return sendError(reply, 429, "rate_limited", "too many generate requests this hour");
      }
      let submitted: Awaited<ReturnType<typeof runUpscale>>;
      const started = await startLive(hostname, "upscale");
      try {
        submitted = await runUpscale({ ...upscaleDeps(hostname, upscalePixels), ...(started ? { clientId: started.clientId } : {}) }, req.body as UpscaleRequest);
      } catch (err) {
        started?.live.end();
        return submitFailure(reply, err, "upscale");
      }
      const { promptId, width, height } = submitted;
      if (!PROMPT_ID.test(promptId)) {
        started?.live.end();
        return sendError(reply, UPSTREAM_FAILED, "comfy_unavailable", "ComfyUI returned an unusable id");
      }
      started?.live.socket?.setPromptId(promptId);
      // An upscale has no prompt; the label says what was done, so a saved image can say so too.
      const scale = String((req.body as UpscaleRequest).scale);
      const factor = upscaleSpec?.scales.find((sc) => sc.name === scale)?.factor ?? 1;
      jobs.add({
        id: promptId,
        owner: identity.subject,
        hostname,
        live: started?.live ?? null,
        kind: "upscale",
        prompt: "",
        label: `Upscale: ${scale}, ${width}x${height} to ${Math.round(width * factor)}x${Math.round(height * factor)}`.slice(0, JOB_LABEL_KEPT),
      });
      return reply.code(202).send({ id: promptId });
    },
  );

  app.post(
    "/api/video",
    // Own body limit: one optional start image plus the prompt; every other route keeps WEB_BODY_LIMIT_BYTES.
    {
      ...member,
      schema: { body: VIDEO_BODY },
      ...(videoLimits === null ? {} : { bodyLimit: editBodyLimit({ ...videoLimits, maxCount: 1 }, intCfg(cfg, "generateMaxPromptChars", "GENERATE_MAX_PROMPT_CHARS")) }),
    },
    async (req, reply) => {
      const identity = req.identity!;
      if (videoLimits === null) return sendError(reply, 404, "video_unavailable", "video is not available on this server");
      const chosen = familyOf((req.body as { family?: unknown }).family);
      if (chosen === undefined) return sendError(reply, 400, "unknown_family", "this video family is not offered here");
      const view = await deps.lifecycle.view();
      const hostname = view.record?.tailnet_hostname;
      if (!READY_STATES.has(view.state) || hostname === undefined || view.record?.status === "stopping") {
        return sendError(reply, 409, "not_ready", "the instance is not ready");
      }
      let extra: Partial<VideoDeps> = {};
      let hiddenLora = false;
      if (chosen === null) {
        // Never queue a video the instance cannot run: its model files must be there (boot or on-demand download).
        const missing = videoModelsRefusal(view.agent?.video_models);
        if (missing !== null) return sendError(reply, 409, "video_models_not_ready", missing);
        // A linked diffusion model replaces the pinned file name in the workflow (the name is the agent's: checked).
        const model = view.agent?.video_models?.model;
        if (model?.linked === true && !isLinkedModelName(model.file)) {
          return sendError(reply, 409, "video_models_not_ready", "the instance reports an unusable video model name");
        }
        if (model?.linked === true) extra = { diffusionFile: model.file as string };
      } else {
        const reported = view.agent?.video_families?.find((f) => f.id === chosen.family.id);
        const missing = videoModelsRefusal(reported);
        if (missing !== null) return sendError(reply, 409, "video_models_not_ready", missing);
        // The mode's linked experts as the instance reports them: all of them (checked names) or none.
        const image = (req.body as { image?: unknown }).image;
        const spec = image !== undefined && image !== null ? chosen.family.image : chosen.family.text;
        const linked = (reported?.experts ?? []).filter((e) => e.linked === true && e.mode === (spec === chosen.family.image ? "image" : "text"));
        if (linked.length > 0) {
          const usable = linked.length === spec.experts.length && linked.every((e) => isLinkedModelName(e.file) && spec.experts.some((x) => x.slot === e.slot));
          if (!usable) return sendError(reply, 409, "video_models_not_ready", "the instance reports unusable linked video models; an admin can download the family again");
        }
        // The family's extra LoRAs for this caller: the profile's and the added ones (hidden ones for admins only: a
        // member naming one gets exactly the answer of an unknown id). An added one must be on the instance.
        const added = storedFor(chosen.family.id, identity !== null && req.role === "admin");
        const pick = added.find((l) => l.id === (req.body as { extra_lora?: unknown }).extra_lora);
        if (pick !== undefined && storedStatus(pick, view.agent?.extra_loras) !== "ready") {
          return sendError(reply, 409, "extra_lora_not_ready", "this extra LoRA is not on the instance yet (it downloads after the instance is ready); try again shortly");
        }
        hiddenLora = pick?.hidden === true;
        const withAdded = (s: typeof chosen.family.text) => ({ ...s, extraLoras: [...s.extraLoras, ...added.map(asExtra)] });
        extra = {
          family: { text: { spec: withAdded(chosen.family.text), template: chosen.templates.text }, image: { spec: withAdded(chosen.family.image), template: chosen.templates.image } },
          ...(linked.length > 0 ? { links: Object.fromEntries(linked.map((e) => [e.slot, e.file])) } : {}),
        };
      }
      if (!generateLimiter.take(identity.subject)) {
        return sendError(reply, 429, "rate_limited", "too many generate requests this hour");
      }
      let submitted: Awaited<ReturnType<typeof runVideo>>;
      // A family's two samplers each run part of the steps: any progress counts there.
      const started = await startLive(hostname, "video", chosen === null ? samplerNode("video") : null);
      try {
        submitted = await runVideo(
          { ...videoDeps(hostname), ...(started ? { clientId: started.clientId } : {}), ...extra },
          req.body as VideoRequest,
        );
      } catch (err) {
        started?.live.end();
        return submitFailure(reply, err, "video");
      }
      const { promptId, startImage } = submitted;
      if (!PROMPT_ID.test(promptId)) {
        started?.live.end();
        return sendError(reply, UPSTREAM_FAILED, "comfy_unavailable", "ComfyUI returned an unusable id");
      }
      started?.live.socket?.setPromptId(promptId);
      const asked = req.body as VideoRequest;
      // A hidden LoRA's title never goes into the label.
      const loraTitle = hiddenLora
        ? undefined
        : [...(chosen?.family.extraLoras ?? []), ...(chosen === null ? [] : storedFor(chosen.family.id, false).map(asExtra))].find((l) => l.id === asked.extra_lora)?.title;
      const title = (chosen === null ? "" : `, ${chosen.family.title}`) + (loraTitle === undefined ? "" : `, ${loraTitle}`);
      jobs.add({
        id: promptId,
        owner: identity.subject,
        hostname,
        live: started?.live ?? null,
        kind: "video",
        prompt: String(asked.prompt).slice(0, JOB_PROMPT_KEPT),
        label: `Video: ${String(asked.size)}, ${String(asked.duration)}${title}${startImage ? ", from an image" : ""}`.slice(0, JOB_LABEL_KEPT),
      });
      return reply.code(202).send({ id: promptId });
    },
  );

  // Download the video model files onto the running instance (admin: it uses the instance's disk and network for
  // several minutes). The agent checks the instance state, the node classes and the disk first, and runs the download
  // in the background; GET /api/state video.models shows its progress.
  const VIDEO_MODEL_REFUSALS = new Set([
    "video_unavailable", "not_ready", "video_nodes_missing", "disk_insufficient", "comfy_unavailable",
    "invalid_model_link", "model_link_host_not_allowed", "model_link_unsupported_type", "model_link_name_clash",
    "model_link_too_large", "model_link_unreachable", "model_link_redirect_not_allowed", "video_gguf_loader_missing",
    "video_download_busy",
  ]);
  /** The reply for a failed download request (shared by the base section and the families). */
  const videoModelsFailure = async (reply: FastifyReply, err: unknown): Promise<FastifyReply> => {
    if (err instanceof NoActiveInstanceError) return sendError(reply, 409, "no_instance", "no active instance");
    if (err instanceof AgentError && err.code !== undefined && VIDEO_MODEL_REFUSALS.has(err.code)) {
      const text = err.message.replace(/^video models failed with HTTP \d+:\s*/, "");
      return sendError(reply, err.status === 400 ? 400 : 409, err.code, (await activeScrubber())(text));
    }
    if (err instanceof ResponseTooLarge) return tooLarge(reply);
    log("warn", `video model download failed: ${errorName(err)}`);
    return sendError(reply, UPSTREAM_FAILED, "agent_unavailable", "the instance agent could not be reached");
  };
  app.post("/api/video-models", { ...admin, schema: { body: VIDEO_MODELS_BODY } }, async (req, reply) => {
    if (videoLimits === null || typeof deps.lifecycle.downloadVideoModels !== "function") {
      return sendError(reply, 404, "video_unavailable", "video is not available on this server");
    }
    const body = (req.body ?? {}) as { url?: unknown; family?: unknown; mode?: unknown; links?: Record<string, string> | null };
    const chosen = familyOf(body.family);
    if (chosen === undefined) return sendError(reply, 400, "unknown_family", "this video family is not offered here");
    if (chosen === null) {
      if ((body.mode !== undefined && body.mode !== null) || (body.links !== undefined && body.links !== null)) {
        return sendError(reply, 400, "invalid_model_link", "the base video model takes one link (url), not expert links");
      }
      const link = readModelLink(reply, body.url);
      if (typeof link === "object" && link !== null) return link;
      log("info", `video model download requested by ${userLabel(req.identity?.username) ?? "?"}${link === null ? "" : " (linked model)"}`);
      try {
        const status = await deps.lifecycle.downloadVideoModels(...(link === null ? [] : [link]));
        return reply.code(202).send({ models: publicVideoModels(status, await activeScrubber()) });
      } catch (err) {
        return videoModelsFailure(reply, err);
      }
    }
    if (typeof deps.lifecycle.downloadVideoFamily !== "function") return sendError(reply, 404, "video_unavailable", "video is not available on this server");
    if (body.url !== undefined && body.url !== null && String(body.url).trim() !== "") {
      return sendError(reply, 400, "invalid_model_link", "a video family takes expert links (mode and links), not url");
    }
    // Expert links: every expert slot of the mode together (one-sided is refused), each checked like the base link.
    let links: Record<string, string> | undefined;
    let mode: "text" | "image" | undefined;
    if (body.links !== undefined && body.links !== null) {
      if (body.mode !== "text" && body.mode !== "image") return sendError(reply, 400, "invalid_model_link", "expert links need the mode they are for (text or image)");
      mode = body.mode;
      const slots = chosen.family[mode].experts.map((e) => e.slot);
      const given = Object.keys(body.links);
      if (given.length !== slots.length || !slots.every((x) => given.includes(x))) {
        return sendError(reply, 400, "invalid_model_link", `link every expert of the mode together: ${slots.join(", ")}`);
      }
      const names = new Set<string>();
      links = {};
      for (const slot of slots) {
        const raw = body.links[slot];
        if (typeof raw !== "string" || raw.trim() === "") return sendError(reply, 400, "invalid_model_link", `the ${slot} expert link is missing`);
        try {
          const parsed = parseModelLink(raw.trim(), linkHosts);
          if (names.has(parsed.name)) return sendError(reply, 400, "model_link_name_clash", "two expert links name the same file");
          names.add(parsed.name);
          links[slot] = parsed.url;
        } catch (err) {
          if (err instanceof ModelLinkError) return sendError(reply, 400, err.code, err.message);
          throw err;
        }
      }
    } else if (body.mode !== undefined && body.mode !== null && body.mode !== "text" && body.mode !== "image") {
      return sendError(reply, 400, "invalid_model_link", "the mode must be text or image");
    }
    log("info", `video family download requested by ${userLabel(req.identity?.username) ?? "?"}${links === undefined ? "" : " (linked experts)"}`);
    try {
      const status = await deps.lifecycle.downloadVideoFamily(chosen.family.id, links === undefined ? {} : { mode: mode!, links });
      return reply.code(202).send({ models: publicVideoModels(status, await activeScrubber()) });
    } catch (err) {
      return videoModelsFailure(reply, err);
    }
  });

  // ---- extra LoRAs added by admins (GET/POST /api/loras, PATCH/DELETE /api/loras/{id}) ----

  /** An added LoRA as an admin sees it: everything stored, its state per file on the instance (scrubbed reasons). */
  const adminLora = (l: StoredLora, reported: LorasStatus | null | undefined, scrub: (t: string) => string) => ({
    id: l.id, title: l.title, description: l.description, family: l.family, modes: [...l.modes], strength: l.strength,
    hidden: l.hidden, trigger_words: l.trigger_words, created_at: l.created_at, status: storedStatus(l, reported),
    sides: Object.fromEntries(
      LORA_SIDES.flatMap((side) => {
        const s = l[side];
        if (s === undefined) return [];
        const r = reported?.items?.find((i) => i.name === s.name);
        const sha = typeof r?.sha256 === "string" && /^[0-9a-f]{64}$/.test(r.sha256) ? r.sha256 : null;
        const size = Number.isSafeInteger(r?.size_bytes) && (r!.size_bytes as number) > 0 ? r!.size_bytes : null;
        return [[side, {
          url: s.url, repo: s.repo, revision: s.revision, path: s.path, name: s.name, state: r?.state ?? null, size_bytes: size, sha256: sha,
          reason: typeof r?.reason === "string" && r.reason !== "" ? scrub(r.reason) : null,
        }]];
      }),
    ),
  });
  const loraUnavailable = (reply: FastifyReply): FastifyReply =>
    sendError(reply, 404, "lora_unavailable", "adding LoRAs is not available on this server (video with a family that takes extra LoRAs is off)");
  const loraFailure = (reply: FastifyReply, err: unknown): FastifyReply => {
    if (err instanceof LoraStoreError) {
      const status = err.code === "unknown_lora" ? 404 : err.code === "lora_limit_reached" ? 409 : err.code === "lora_store_unavailable" ? 503 : 400;
      return sendError(reply, status, err.code, err.message);
    }
    if (err instanceof ModelLinkError) return sendError(reply, 400, err.code, err.message);
    log("warn", `LoRA store write failed: ${errorName(err)}`);
    return sendError(reply, 503, "lora_store_unavailable", "the LoRA store could not be written");
  };
  const loraContext = async () => {
    const view = await deps.lifecycle.view();
    return { reported: view.agent?.extra_loras, scrub: await activeScrubber() };
  };

  app.get("/api/loras", admin, async (_req, reply) => {
    if (loraStore === null) return loraUnavailable(reply);
    const { reported, scrub } = await loraContext();
    return {
      loras: loraStore.list().map((l) => adminLora(l, reported, scrub)),
      families: loraFamilies.map((x) => x.family.id),
      max_entries: intCfg(cfg, "loraMaxEntries", "LORA_MAX_ENTRIES"),
    };
  });

  app.post("/api/loras", { ...admin, schema: { body: LORA_BODY } }, async (req, reply) => {
    if (loraStore === null) return loraUnavailable(reply);
    const body = req.body as Record<string, unknown>;
    const sides = LORA_SIDES.filter((s) => typeof body[s] === "string" && (body[s] as string).trim() !== "");
    const misfit = loraFit(body["family"], (body["modes"] as string[]) ?? [], sides);
    if (misfit !== null && sides.length > 0) return sendError(reply, 400, "invalid_lora", misfit);
    if (!loraWriteLimiter.take(req.identity!.subject)) return sendError(reply, 429, "rate_limited", "too many LoRA changes this hour");
    let added: StoredLora;
    try {
      // Ids of the profile's extra LoRAs are never reused (a job names a LoRA by id).
      const taken = extraFamilies.flatMap((x) => x.family.extraLoras.map((l) => l.id));
      added = loraStore.add(body as never, taken);
    } catch (err) {
      return loraFailure(reply, err);
    }
    log("info", `extra LoRA added by ${userLabel(req.identity?.username) ?? "?"}`);
    await syncLoras();
    const { reported, scrub } = await loraContext();
    return reply.code(201).send({ lora: adminLora(added, reported, scrub) });
  });

  app.patch("/api/loras/:id", { ...admin, schema: { params: LORA_ID_PARAMS, body: LORA_PATCH_BODY } }, async (req, reply) => {
    if (loraStore === null) return loraUnavailable(reply);
    const { id } = req.params as { id: string };
    const patch = req.body as { modes?: string[] };
    const old = loraStore.get(id);
    if (old === null) return sendError(reply, 404, "unknown_lora", "no such LoRA");
    if (patch.modes !== undefined) {
      const misfit = loraFit(old.family, patch.modes, LORA_SIDES.filter((s) => old[s] !== undefined));
      if (misfit !== null) return sendError(reply, 400, "invalid_lora", misfit);
    }
    if (!loraWriteLimiter.take(req.identity!.subject)) return sendError(reply, 429, "rate_limited", "too many LoRA changes this hour");
    let updated: StoredLora;
    try {
      updated = loraStore.update(id, patch as never);
    } catch (err) {
      return loraFailure(reply, err);
    }
    const { reported, scrub } = await loraContext();
    return { lora: adminLora(updated, reported, scrub) };
  });

  app.delete("/api/loras/:id", { ...admin, schema: { params: LORA_ID_PARAMS, body: EMPTY_BODY } }, async (req, reply) => {
    if (loraStore === null) return loraUnavailable(reply);
    const { id } = req.params as { id: string };
    if (!loraWriteLimiter.take(req.identity!.subject)) return sendError(reply, 429, "rate_limited", "too many LoRA changes this hour");
    try {
      loraStore.remove(id);
    } catch (err) {
      return loraFailure(reply, err);
    }
    log("info", `extra LoRA deleted by ${userLabel(req.identity?.username) ?? "?"}`);
    // The instance deletes the file once ComfyUI is idle (a running job may be using it).
    await syncLoras();
    return reply.code(204).send();
  });

  app.get("/api/generate/:id", { ...member, schema: { params: ID_PARAMS } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = ownJob(req, id);
    if (job === null) return sendError(reply, 404, "not_found", "no such job");
    if (job.state.kind === "pending") {
      if (now() - job.createdAt >= timeoutOf(job.kind)) {
        job.state = { kind: "failed", message: "generation timed out" };
      } else if (!(await sameInstance(job))) {
        job.state = { kind: "failed", message: "the instance that ran this job is gone" };
      } else {
        try {
          const result = await pollResult(generateDeps(job.hostname, job.kind), job.id);
          if (result !== null) {
            // ComfyUI's own execution time; without it, the time this server saw from submit to done.
            const seconds = result.executionSeconds ?? tenthsOfSeconds(Math.max(0, now() - job.createdAt));
            const startedAt = job.live?.startedAt ?? null;
            const queuedSeconds = startedAt === null ? null : tenthsOfSeconds(Math.max(0, startedAt - job.createdAt));
            job.state = { kind: "done", images: result.images, seconds, queuedSeconds };
            log("info", `job done: kind=${job.kind} seconds=${seconds}`);
          }
        } catch (err) {
          if (err instanceof GenerateFailed) {
            job.state = { kind: "failed", message: scrubber(deps, [job.hostname])(err.message) };
          } else if (err instanceof ResponseTooLarge) {
            // A hostile or broken instance: stop polling it for this job.
            log("warn", "generate poll: oversized history response");
            job.state = { kind: "failed", message: "the instance sent an oversized response" };
            return tooLarge(reply);
          } else {
            // Unreachable or ComfyError: transient from the browser's view; it may poll again.
            log("warn", `generate poll failed: ${(err as Error).name}`);
            return sendError(reply, UPSTREAM_FAILED, "comfy_unavailable", "ComfyUI could not be reached");
          }
        }
      }
    }
    const state = job.state;
    // A finished or failed job needs no socket and no preview any more.
    if (state.kind !== "pending") job.live?.end();
    if (state.kind === "done") {
      // A video job's files are served by /api/video (checked as video), never by /api/image.
      const files = state.images.map((_img, index) => ({ index, url: `/api/${job.kind === "video" ? "video" : "image"}/${encodeURIComponent(job.id)}/${index}` }));
      return {
        status: "done",
        images: job.kind === "video" ? [] : files,
        ...(job.kind === "video" ? { videos: files } : {}),
        seconds: state.seconds,
        queued_seconds: state.queuedSeconds,
      };
    }
    if (state.kind === "failed") return { status: "failed", message: state.message };
    const live = job.live;
    return { status: "pending", progress: live?.step ?? null, preview_seq: live?.previewSeq ?? 0 };
  });

  // The newest live preview of a pending job (owner or admin, like the job). The type is the one its
  // magic bytes say (only JPEG or PNG are ever kept); 404 when there is none (yet, or any more).
  app.get("/api/generate/:id/preview", { ...member, schema: { params: ID_PARAMS } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = ownJob(req, id);
    if (job === null) return sendError(reply, 404, "not_found", "no such job");
    const frame = job.state.kind === "pending" ? (job.live?.frame ?? null) : null;
    if (frame === null) return sendError(reply, 404, "no_preview", "there is no preview for this job");
    return reply
      .code(200)
      .header("cache-control", "no-store")
      .header("content-disposition", `inline; filename="preview.${frame.contentType === "image/png" ? "png" : "jpg"}"`)
      .type(frame.contentType)
      .send(frame.bytes);
  });

  type JobImage = { job: Job; bytes: Buffer; type: string; ext: string };
  type Failure = { fail: { status: number; code: string; message: string } };
  const failure = (status: number, code: string, message: string): Failure => ({ fail: { status, code, message } });

  /** The bytes of one image of one of the caller's finished jobs, or the failure to report. */
  const loadJobImage = async (
    req: FastifyRequest,
    id: string,
    index: number,
    notDone: { status: number; code: string; message: string },
  ): Promise<JobImage | Failure> => {
    const job = ownJob(req, id);
    if (job === null) return failure(404, "not_found", "no such job");
    // A video job has no image (its file is served by /api/video, checked as video).
    if (job.kind === "video") return failure(404, "not_found", "no such image");
    if (job.state.kind !== "done") return { fail: notDone };
    const image = job.state.images[index];
    if (image === undefined) return failure(404, "not_found", "no such image");
    if (!(await sameInstance(job))) return failure(410, "gone", "the instance that made this image is gone");
    let fetched: { bytes: Buffer; contentType: string };
    try {
      fetched = await deps.comfyFor(job.hostname).view(image.filename, image.subfolder, image.type);
    } catch (err) {
      if (err instanceof ComfyError && err.status === 0) {
        log("warn", "ComfyUI history named an unsafe image path; refused");
        return failure(UPSTREAM_FAILED, "image_rejected", "the image reference was refused");
      }
      if (err instanceof ResponseTooLarge) {
        log("warn", "image larger than WEB_IMAGE_MAX_BYTES; refused");
        return failure(UPSTREAM_FAILED, "image_too_large", "the instance sent a response larger than allowed");
      }
      if (!(err instanceof ComfyError) && !(err instanceof Unreachable)) throw err;
      return failure(UPSTREAM_FAILED, "image_unavailable", "the image could not be fetched");
    }
    const type = fetched.contentType.split(";")[0]!.trim().toLowerCase();
    const ext = IMAGE_TYPES[type];
    if (ext === undefined) return failure(UPSTREAM_FAILED, "image_rejected", "ComfyUI did not return an image");
    return { job, bytes: fetched.bytes, type, ext };
  };

  app.get("/api/image/:id/:index", { ...member, schema: { params: IMAGE_PARAMS } }, async (req, reply: FastifyReply) => {
    const { id, index } = req.params as { id: string; index: string };
    const loaded = await loadJobImage(req, id, Number(index), { status: 404, code: "not_found", message: "no such image" });
    if ("fail" in loaded) return sendError(reply, loaded.fail.status, loaded.fail.code, loaded.fail.message);
    return reply
      .code(200)
      .header("cache-control", "no-store")
      .header("content-disposition", `inline; filename="image-${Number(index)}.${loaded.ext}"`)
      .type(loaded.type)
      .send(loaded.bytes);
  });

  // One result video of one of the caller's finished video jobs. Served only when its first bytes say mp4 or WebM
  // (never ComfyUI's content type), bounded by VIDEO_MAX_BYTES and VIDEO_VIEW_TIMEOUT_S, with nosniff (every
  // response) and a fixed file name; nothing about the instance or ComfyUI's file name leaves.
  app.get("/api/video/:id/:index", { ...member, schema: { params: IMAGE_PARAMS } }, async (req, reply) => {
    const { id, index } = req.params as { id: string; index: string };
    const job = ownJob(req, id);
    if (job === null || job.kind !== "video" || videoView === null) return sendError(reply, 404, "not_found", "no such video");
    if (job.state.kind !== "done") return sendError(reply, 404, "not_found", "no such video");
    const file = job.state.images[Number(index)];
    if (file === undefined) return sendError(reply, 404, "not_found", "no such video");
    if (!(await sameInstance(job))) return sendError(reply, 410, "gone", "the instance that made this video is gone");
    let fetched: { bytes: Buffer; contentType: string };
    try {
      fetched = await deps.comfyFor(job.hostname).view(file.filename, file.subfolder, file.type, videoView);
    } catch (err) {
      if (err instanceof ComfyError && err.status === 0) {
        log("warn", "ComfyUI history named an unsafe video path; refused");
        return sendError(reply, UPSTREAM_FAILED, "video_rejected", "the video reference was refused");
      }
      if (err instanceof ResponseTooLarge) {
        log("warn", "video larger than VIDEO_MAX_BYTES; refused");
        return sendError(reply, UPSTREAM_FAILED, "video_too_large", "the instance sent a response larger than allowed");
      }
      if (!(err instanceof ComfyError) && !(err instanceof Unreachable)) throw err;
      return sendError(reply, UPSTREAM_FAILED, "video_unavailable", "the video could not be fetched");
    }
    const type = sniffVideo(fetched.bytes);
    if (type === null) {
      log("warn", "ComfyUI returned a file that is not an mp4 or WebM video; refused");
      return sendError(reply, UPSTREAM_FAILED, "video_rejected", "ComfyUI did not return a video");
    }
    return reply
      .code(200)
      .header("cache-control", "no-store")
      .header("content-disposition", `inline; filename="video-${Number(index)}.${VIDEO_EXT[type]}"`)
      .type(type)
      .send(fetched.bytes);
  });

  // ---- gallery: images saved to the object store (MinIO) ----

  const viewerOf = (req: FastifyRequest): Viewer => ({ subject: req.identity!.subject, admin: req.role === "admin" });
  // Saves are rate limited per identity, and every save and image read holds a slot: at most
  // GALLERY_MAX_CONCURRENT images (each up to WEB_IMAGE_MAX_BYTES) are in memory for the gallery.
  const saveLimiter =
    gallery === null ? null : new RateLimiter(intCfg(cfg, "gallerySaveRateLimitPerHour", "GALLERY_SAVE_RATE_LIMIT_PER_HOUR"), HOUR_MS, now);
  const gallerySlots = gallery === null ? null : new Semaphore(intCfg(cfg, "galleryMaxConcurrent", "GALLERY_MAX_CONCURRENT"));
  const galleryOff = (reply: FastifyReply) => sendError(reply, 503, "gallery_unavailable", "saving to the gallery is not set up on this server");

  /** The reply for a gallery or object-store failure; anything else is not ours to handle. */
  const galleryFailure = (reply: FastifyReply, err: unknown, what: string): FastifyReply => {
    if (err instanceof GalleryError) {
      switch (err.code) {
        case "invalid_id":
          return sendError(reply, 400, "invalid_id", "not a valid image id");
        case "invalid_input":
          return sendError(reply, 400, "invalid_gallery_input", err.message);
        case "forbidden":
          return sendError(reply, 403, "forbidden", err.message);
        case "not_found":
          return sendError(reply, 404, "not_found", err.message);
        case "quota_images":
        case "quota_bytes":
          return sendError(reply, 409, "gallery_quota", err.message);
        case "invalid_image":
          return sendError(reply, UPSTREAM_FAILED, "image_rejected", "the image could not be stored");
      }
    }
    if (err instanceof ObjectStoreError) {
      // A fixed line: the store's own text may name hosts or buckets.
      log("warn", `gallery ${what} failed: ObjectStoreError`);
      return sendError(reply, UPSTREAM_FAILED, "gallery_error", "the gallery storage could not be reached");
    }
    throw err;
  };

  app.post("/api/gallery", { ...member, schema: { body: GALLERY_SAVE_BODY } }, async (req, reply) => {
    if (gallery === null || saveLimiter === null || gallerySlots === null) return galleryOff(reply);
    if (!saveLimiter.take(req.identity!.subject)) return sendError(reply, 429, "rate_limited", "too many gallery saves this hour");
    return gallerySlots.run(() => saveToGallery(req, reply, gallery));
  });

  const saveToGallery = async (req: FastifyRequest, reply: FastifyReply, gallery: NonNullable<ServerDeps["gallery"]>) => {
    const { job: jobId, index } = req.body as { job: string; index: number };
    // Phase 1 keeps the gallery to images (its types, sizes and quotas are image ones): a video is downloaded instead.
    if (ownJob(req, jobId)?.kind === "video") return sendError(reply, 400, "video_not_saveable", "videos cannot be saved to the gallery; use Download");
    const loaded = await loadJobImage(req, jobId, index, { status: 409, code: "job_not_done", message: "the job has not finished yet" });
    if ("fail" in loaded) return sendError(reply, loaded.fail.status, loaded.fail.code, loaded.fail.message);
    const identity = req.identity!;
    try {
      const saved = await gallery.save({
        owner: identity.subject,
        ownerName: identity.name ?? identity.username,
        jobId: loaded.job.id,
        index,
        createdMs: loaded.job.createdAt,
        bytes: loaded.bytes,
        contentType: loaded.type,
        kind: loaded.job.kind === "video" ? "generate" : loaded.job.kind, // never video: loadJobImage refuses those
        prompt: loaded.job.prompt,
        label: loaded.job.label,
        seconds: loaded.job.state.kind === "done" ? loaded.job.state.seconds : null,
      });
      return reply.code(saved.created ? 201 : 200).send(saved);
    } catch (err) {
      return galleryFailure(reply, err, "save");
    }
  };

  app.get("/api/gallery", { ...member, schema: { querystring: GALLERY_QUERY } }, async (req, reply) => {
    if (gallery === null) return galleryOff(reply);
    const { cursor, scope } = req.query as { cursor?: string; scope?: "mine" | "all" };
    try {
      const page = await gallery.list(viewerOf(req), { scope: scope ?? "mine", ...(cursor === undefined ? {} : { cursor }) });
      return {
        items: page.items.map((i) => ({
          id: i.id,
          url: `/api/gallery/${i.id}/image`,
          created_at: Math.floor(i.createdMs / 1000),
          kind: i.kind,
          prompt: i.prompt,
          label: i.label,
          owner_name: i.ownerName,
          mine: i.mine,
          size: i.size,
          seconds: i.seconds,
        })),
        next: page.next,
      };
    } catch (err) {
      return galleryFailure(reply, err, "list");
    }
  });

  app.get("/api/gallery/:id/image", { ...member, schema: { params: GALLERY_ID_PARAMS } }, async (req, reply) => {
    if (gallery === null || gallerySlots === null) return galleryOff(reply);
    const { id } = req.params as { id: string };
    try {
      const image = await gallerySlots.run(() => gallery.read(viewerOf(req), id));
      const ext = IMAGE_TYPES[image.contentType] ?? "bin";
      return reply
        .code(200)
        .header("cache-control", "no-store")
        .header("content-disposition", `inline; filename="gallery-image.${ext}"`)
        .type(image.contentType)
        .send(image.bytes);
    } catch (err) {
      return galleryFailure(reply, err, "read");
    }
  });

  app.post("/api/gallery/delete", { ...member, schema: { body: GALLERY_DELETE_BODY } }, async (req, reply) => {
    if (gallery === null) return galleryOff(reply);
    const { id } = req.body as { id: string };
    try {
      await gallery.remove(viewerOf(req), id);
      return { deleted: true };
    } catch (err) {
      return galleryFailure(reply, err, "delete");
    }
  });
}
