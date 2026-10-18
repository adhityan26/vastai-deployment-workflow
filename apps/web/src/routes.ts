import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AgentError,
  AlreadyActiveError,
  ComfyError,
  DestroyFailedError,
  GenerateFailed,
  GenerateInputError,
  GpuNotAllowedError,
  NoActiveInstanceError,
  NoGpuConfiguredError,
  NoOffersError,
  RefusedError,
  ResponseTooLarge,
  StartError,
  Unreachable,
  generate,
  labelHostname,
  pollResult,
  type AppsConfig,
  type CostEstimate,
  type GenerateDeps,
  type GenerateRequest,
  type StartFailReason,
  type StatusView,
} from "@vast-comfy/core";
import { CreditCache, JobStore, RateLimiter, type Job } from "./store.js";
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
const GPU_NAME_MAX = 64;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

// Short English text per fixed start-failure reason (the page shows it as is).
const START_FAIL_MESSAGES: Record<StartFailReason, string> = {
  ts_key_missing: "the Tailscale auth key is missing or empty on the server",
  vast_unavailable: "Vast could not be asked for offers; nothing was rented",
  config_invalid: "the server start configuration is incomplete; nothing was rented",
  vast_rejected: "Vast refused to create the instance; nothing was rented",
  create_uncertain: "instance creation is uncertain; reconcile will resolve it",
  registry_failed: "the instance could not be recorded and was destroyed",
  unexpected: "the instance could not be started",
};

/** An error's class name for a log line, or a fixed word when it is not a plain identifier. */
function errorName(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  return ERROR_NAME.test(name) ? name : "Error";
}

/** The estimate as the browser may see it: the offer id stays inside the server. */
function publicEstimate(e: CostEstimate) {
  return { gpu_name: e.gpu_name, dph: e.dph, horizon_hours: e.horizon_hours, max_cost: e.max_cost };
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
const START_BODY = {
  type: "object",
  additionalProperties: false,
  required: ["confirm"],
  properties: { confirm: { const: true }, gpu: GPU_FIELD },
} as const;
const ESTIMATE_QUERY = {
  type: "object",
  additionalProperties: false,
  properties: { gpu: GPU_FIELD },
} as const;
const ID_PARAMS = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", pattern: PROMPT_ID.source } },
} as const;
const IMAGE_PARAMS = {
  type: "object",
  additionalProperties: false,
  required: ["id", "index"],
  properties: { id: { type: "string", pattern: PROMPT_ID.source }, index: { type: "string", pattern: "^[0-9]{1,3}$" } },
} as const;
// Field values are validated by the generate service so its error codes reach the client.
const GENERATE_BODY = {
  type: "object",
  additionalProperties: false,
  required: ["prompt", "preset", "size"],
  properties: { prompt: {}, preset: {}, size: {}, seed: {} },
} as const;

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
    sendError(reply, 502, code, "the instance sent a response larger than allowed");
  const admin = { config: { access: "admin" as const } };
  const member = { config: { access: "member" as const } };

  const generateDeps = (hostname: string): GenerateDeps => ({
    comfy: deps.comfyFor(hostname),
    profile: deps.profile,
    template: deps.template,
    cfg,
  });

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
    const isAdmin = req.role === "admin";
    // The view passes agent-provided text (reason) through unscrubbed: remove the token too.
    const token = (await deps.registry.active())?.agent_token ?? "";
    return {
      ...publicView(view, isAdmin, scrubber(deps, [token, ...hostnamesOf(view)])),
      role: req.role,
      presets: deps.profile.generate.qualityPresets.map((p) => ({ name: p.name, steps: p.steps })),
      sizes: deps.profile.generate.sizes.map((s) => ({ name: s.name, width: s.width, height: s.height })),
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
    return null;
  };

  app.get("/api/gpus", admin, async (_req, reply) => {
    try {
      return { gpus: await deps.lifecycle.gpuOptions() };
    } catch (err) {
      const refused = gpuRefusal(reply, err);
      if (refused) return refused;
      log("warn", `gpu list failed: ${errorName(err)}`);
      return sendError(reply, 502, "vast_unavailable", "could not read Vast offers");
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
      return sendError(reply, 502, "vast_unavailable", "could not read the Vast account credit");
    }
  });

  app.get("/api/estimate", { ...admin, schema: { querystring: ESTIMATE_QUERY } }, async (req, reply) => {
    const { gpu } = req.query as { gpu?: string };
    try {
      return publicEstimate(await deps.lifecycle.estimate(gpu));
    } catch (err) {
      const refused = gpuRefusal(reply, err);
      if (refused) return refused;
      log("warn", `estimate failed: ${errorName(err)}`);
      return sendError(reply, 502, "vast_unavailable", "could not read Vast offers");
    }
  });

  app.post("/api/start", { ...admin, schema: { body: START_BODY } }, async (req, reply) => {
    // Every admitted attempt counts, failed or not: the limit protects Vast and the bill.
    if (!startLimiter.take("start")) return sendError(reply, 429, "rate_limited", "too many start requests this hour");
    const { gpu } = req.body as { gpu?: string };
    log("info", `start requested by ${req.identity?.username ?? "?"}`);
    try {
      const { record, estimate } = await deps.lifecycle.start(gpu);
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
      const ambiguous = err instanceof StartError && err.ambiguous;
      log("warn", `start failed: ${errorName(err)} (internal: ${reason})${ambiguous ? " (ambiguous)" : ""}`);
      const code = ambiguous ? "start_uncertain" : "start_failed";
      const text = ambiguous && reason !== "create_uncertain" ? START_FAIL_MESSAGES.create_uncertain : START_FAIL_MESSAGES[reason];
      return sendError(reply, 502, code, text, reason);
    }
  });

  app.post("/api/destroy", { ...admin, schema: { body: EMPTY_BODY } }, async (req, reply) => {
    log("info", `destroy requested by ${req.identity?.username ?? "?"}`);
    try {
      const result = await deps.lifecycle.destroy();
      return { outcome: result.outcome, agent_reached: result.agent_error === null };
    } catch (err) {
      log("warn", `destroy failed: ${(err as Error).name}`);
      if (err instanceof DestroyFailedError) {
        return sendError(reply, 502, "destroy_failed", "Vast destroy failed; it will be retried");
      }
      return sendError(reply, 502, "destroy_error", "destroy could not be completed");
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
        return sendError(reply, 502, "agent_unavailable", "the instance agent could not be reached");
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
      log("info", `destroy-unknown ${vast_id} requested by ${req.identity?.username ?? "?"}`);
      try {
        return { outcome: await deps.lifecycle.destroyUnknown(vast_id) };
      } catch (err) {
        if (err instanceof DestroyFailedError) return sendError(reply, 502, "destroy_failed", "Vast destroy failed");
        // Not a project instance, or the active one.
        if (err instanceof RefusedError) return sendError(reply, 409, "refused", (await activeScrubber())(err.message));
        log("warn", `destroy-unknown failed: ${(err as Error).name}`);
        return sendError(reply, 502, "vast_unavailable", "Vast could not be reached");
      }
    },
  );

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
    try {
      ({ promptId } = await generate(generateDeps(hostname), req.body as GenerateRequest));
    } catch (err) {
      if (err instanceof GenerateInputError) {
        if (err.code === "workflow_mismatch") {
          log("error", "the profile does not match its workflow template");
          return sendError(reply, 500, "profile_mismatch", "the server profile is misconfigured");
        }
        return sendError(reply, 400, err.code, err.message);
      }
      log("warn", `generate submit failed: ${(err as Error).name}`);
      if (err instanceof ResponseTooLarge) return tooLarge(reply);
      return sendError(reply, 502, "comfy_unavailable", "ComfyUI could not accept the job");
    }
    if (!PROMPT_ID.test(promptId)) return sendError(reply, 502, "comfy_unavailable", "ComfyUI returned an unusable id");
    jobs.add({ id: promptId, owner: identity.subject, hostname });
    return reply.code(202).send({ id: promptId });
  });

  app.get("/api/generate/:id", { ...member, schema: { params: ID_PARAMS } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = ownJob(req, id);
    if (job === null) return sendError(reply, 404, "not_found", "no such job");
    if (job.state.kind === "pending") {
      if (now() - job.createdAt >= generateTimeoutMs) {
        job.state = { kind: "failed", message: "generation timed out" };
      } else if (!(await sameInstance(job))) {
        job.state = { kind: "failed", message: "the instance that ran this job is gone" };
      } else {
        try {
          const result = await pollResult(generateDeps(job.hostname), job.id);
          if (result !== null) job.state = { kind: "done", images: result.images };
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
            return sendError(reply, 502, "comfy_unavailable", "ComfyUI could not be reached");
          }
        }
      }
    }
    const state = job.state;
    if (state.kind === "done") {
      return {
        status: "done",
        images: state.images.map((_img, index) => ({ index, url: `/api/image/${encodeURIComponent(job.id)}/${index}` })),
      };
    }
    if (state.kind === "failed") return { status: "failed", message: state.message };
    return { status: "pending" };
  });

  app.get("/api/image/:id/:index", { ...member, schema: { params: IMAGE_PARAMS } }, async (req, reply: FastifyReply) => {
    const { id, index } = req.params as { id: string; index: string };
    const job = ownJob(req, id);
    if (job === null) return sendError(reply, 404, "not_found", "no such job");
    if (job.state.kind !== "done") return sendError(reply, 404, "not_found", "no such image");
    const image = job.state.images[Number(index)];
    if (image === undefined) return sendError(reply, 404, "not_found", "no such image");
    if (!(await sameInstance(job))) return sendError(reply, 410, "gone", "the instance that made this image is gone");
    let fetched: { bytes: Buffer; contentType: string };
    try {
      fetched = await deps.comfyFor(job.hostname).view(image.filename, image.subfolder, image.type);
    } catch (err) {
      if (err instanceof ComfyError && err.status === 0) {
        log("warn", "ComfyUI history named an unsafe image path; refused");
        return sendError(reply, 502, "image_rejected", "the image reference was refused");
      }
      if (err instanceof ResponseTooLarge) {
        log("warn", "image larger than WEB_IMAGE_MAX_BYTES; refused");
        return tooLarge(reply, "image_too_large");
      }
      if (!(err instanceof ComfyError) && !(err instanceof Unreachable)) throw err;
      return sendError(reply, 502, "image_unavailable", "the image could not be fetched");
    }
    const type = fetched.contentType.split(";")[0]!.trim().toLowerCase();
    const ext = IMAGE_TYPES[type];
    if (ext === undefined) return sendError(reply, 502, "image_rejected", "ComfyUI did not return an image");
    return reply
      .code(200)
      .header("cache-control", "no-store")
      .header("content-disposition", `inline; filename="image-${Number(index)}.${ext}"`)
      .type(type)
      .send(fetched.bytes);
  });
}
