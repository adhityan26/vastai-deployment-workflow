import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv/dist/2020.js";
import type { AppsConfig } from "./config.js";
import { baseUrl, clip, jsonMaxBytes, parseJson, positiveInt, request, timeoutMs, type RawReply } from "./http.js";

export { ResponseTooLarge, Unreachable } from "./http.js";

const SUPPORTED_SCHEMA_VERSION = 1;

/** The agent answered with an HTTP error (or an unusable body). Carries the status and its message. */
export class AgentError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "AgentError";
    this.status = status;
    this.code = code;
  }
}

/** Shape of the agent's GET /status body (contracts/status.schema.json, schema_version 1). */
export interface AgentStatus {
  schema_version: 1;
  state: string | null;
  reason: string | null;
  progress: { phase: string; file: string; bytes_done: number; bytes_total: number } | null;
  now: number;
  boot_at: number | null;
  uptime_s: number | null;
  idle_destroy_at: number | null;
  failsafe_at: number | null;
  hard_cap_at: number | null;
  queue: { running: number; pending: number } | null;
  gpu: { util_percent?: number | null; vram_total_mb?: number | null; vram_used_mb?: number | null };
  profile: string;
  commit: string;
  failsafe_alive: boolean;
  destroy: { pending: boolean; attempts: number; last_error?: string | null };
  /** The video model files on the instance; absent from an agent without video support. */
  video_models?: VideoModelsStatus | null;
}

export type VideoModelsState = "unavailable" | "not_installed" | "downloading" | "ready" | "failed";
export interface VideoModelsStatus {
  state: VideoModelsState;
  /** This boot downloads them itself (INCLUDE_VIDEO_MODELS). */
  boot: boolean;
  bytes_done: number;
  bytes_total: number;
  reason?: string | null;
  /** The diffusion model in use: the pinned one, or a linked one (not integrity-pinned) with the sha256 that arrived. */
  model?: { file: string; linked: boolean; sha256?: string | null } | null;
}

export class AgentClient {
  private readonly base: string;
  private readonly ms: number;
  private readonly maxBytes: number;
  private readonly validate: ValidateFunction;

  /** `statusSchemaPath` is contracts/status.schema.json, passed in by the caller. */
  constructor(
    host: string,
    cfg: AppsConfig,
    private readonly token: string,
    statusSchemaPath: string,
  ) {
    if (token === "") throw new Error("agent token is empty");
    this.base = baseUrl(host, positiveInt("AGENT_PORT", cfg["agentPort"]));
    this.ms = timeoutMs(cfg);
    this.maxBytes = jsonMaxBytes(cfg);
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    this.validate = ajv.compile(JSON.parse(readFileSync(statusSchemaPath, "utf8")) as object);
  }

  private async call(method: string, path: string, body?: unknown): Promise<RawReply> {
    return request(method, `${this.base}${path}`, this.ms, { Authorization: `Bearer ${this.token}` }, body, {
      maxBytes: this.maxBytes,
      secret: this.token,
    });
  }

  private fail(what: string, reply: RawReply): never {
    const json = parseJson(reply.body) as { detail?: unknown } | null;
    let message = "";
    let code: string | undefined;
    const detail = json?.detail;
    if (typeof detail === "string") message = detail;
    else if (detail && typeof detail === "object" && !Array.isArray(detail)) {
      const d = detail as { code?: unknown; message?: unknown };
      if (typeof d.message === "string") message = d.message;
      if (typeof d.code === "string") code = d.code;
    } else if (Array.isArray(detail)) message = "request rejected as invalid";
    if (message === "") message = reply.body.toString("utf8");
    throw new AgentError(reply.status, clip(`${what} failed with HTTP ${reply.status}: ${message}`, this.token), code);
  }

  async status(): Promise<AgentStatus> {
    const reply = await this.call("GET", "/status");
    if (reply.status !== 200) this.fail("status", reply);
    const body = parseJson(reply.body);
    if (body === null || typeof body !== "object") throw new AgentError(reply.status, "status: response is not a JSON object");
    const version = (body as { schema_version?: unknown }).schema_version;
    if (version !== SUPPORTED_SCHEMA_VERSION) {
      throw new AgentError(reply.status, `status: unsupported schema_version ${String(version)} (expected ${SUPPORTED_SCHEMA_VERSION})`);
    }
    if (!this.validate(body)) {
      throw new AgentError(reply.status, clip(`status: response does not match the status schema: ${this.errors()}`));
    }
    return body as AgentStatus;
  }

  private errors(): string {
    return (this.validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`).join("; ");
  }

  async extend(kind: "idle" | "failsafe", minutes: number): Promise<Record<string, unknown>> {
    if (kind !== "idle" && kind !== "failsafe") throw new Error("kind must be idle or failsafe");
    if (!Number.isInteger(minutes) || minutes <= 0) throw new Error("minutes must be a positive integer");
    const reply = await this.call("POST", "/extend", { kind, minutes });
    if (reply.status < 200 || reply.status >= 300) this.fail("extend", reply);
    const body = parseJson(reply.body);
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  }

  /** Ask the agent to download the missing video model files in the background (POST /video-models). */
  async startVideoModels(url?: string): Promise<VideoModelsStatus> {
    const reply = await this.call("POST", "/video-models", url === undefined ? {} : { url });
    if (reply.status < 200 || reply.status >= 300) this.fail("video models", reply);
    const body = parseJson(reply.body) as VideoModelsStatus | null;
    if (body === null || typeof body !== "object" || typeof body.state !== "string") {
      throw new AgentError(reply.status, "video models: response is not a status");
    }
    return body;
  }

  async destroy(reason: "manual" | "watchdog"): Promise<void> {
    if (reason !== "manual" && reason !== "watchdog") throw new Error("reason must be manual or watchdog");
    const reply = await this.call("POST", "/destroy", { reason });
    if (reply.status < 200 || reply.status >= 300) this.fail("destroy", reply);
  }
}
