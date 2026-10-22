import type { AppsConfig } from "./config.js";
import { randomBytes } from "node:crypto";
import { baseUrl, clip, imageTimeoutMs, jsonMaxBytes, parseJson, positiveInt, request, timeoutMs, RawBody, type RawReply } from "./http.js";
import { isPlainFileName } from "./profile.js";
import { watchProgress, type ProgressSink, type ProgressSocket } from "./progress.js";

export { ResponseTooLarge, Unreachable } from "./http.js";

/** ComfyUI answered with an HTTP error. Carries the status and a clipped message. */
export class ComfyError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ComfyError";
    this.status = status;
  }
}

export interface HistoryEntry {
  outputs: Record<string, { images?: { filename: string; subfolder: string; type: string }[]; [k: string]: unknown }>;
  status?: { completed?: boolean; status_str?: string; [k: string]: unknown };
  [k: string]: unknown;
}

const VIEW_TYPES = ["input", "output", "temp"] as const;
export type ViewType = (typeof VIEW_TYPES)[number];
const PROMPT_ID = /^[\w-]+$/;
const UPLOAD_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp"];
const BOUNDARY_BYTES = 12;
const SEGMENT_FORBIDDEN = /[\0\\]/;

/** Reject path traversal and absolute paths in a /view file or folder name. */
function safeSegment(name: string, value: string, allowEmpty: boolean): string {
  if (value === "") {
    if (allowEmpty) return value;
    throw new ComfyError(0, `${name} must not be empty`);
  }
  if (SEGMENT_FORBIDDEN.test(value) || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new ComfyError(0, `${name} must be a relative path`);
  }
  if (value.split("/").some((part) => part === ".." || part === ".")) {
    throw new ComfyError(0, `${name} must not contain path traversal`);
  }
  return value;
}

/** What a job's progress socket needs besides the instance address (read from config by the caller). */
export interface ProgressLimits {
  readonly lifetimeMs: number;
  readonly maxTextBytes: number;
  readonly maxPreviewBytes: number;
}

export class ComfyClient {
  private readonly base: string;
  private readonly host: string;
  private readonly port: number;
  private readonly ms: number;
  private readonly imageMs: number;
  private readonly jsonMax: number;
  private readonly imageMax: number;

  constructor(host: string, cfg: AppsConfig) {
    this.port = positiveInt("COMFY_PORT", cfg["comfyPort"]);
    this.base = baseUrl(host, this.port); // also the host allow-list check
    this.host = host;
    this.ms = timeoutMs(cfg);
    // Images are megabytes over the tailnet (a 1.8 MB PNG took 7.5 s), so /view has its own, longer timeout.
    this.imageMs = imageTimeoutMs(cfg);
    this.jsonMax = jsonMaxBytes(cfg);
    this.imageMax = positiveInt("WEB_IMAGE_MAX_BYTES", cfg["webImageMaxBytes"]);
  }

  // The instance is a rented third-party host: every body is size-capped and time-boxed (JSON vs image).
  private call(method: string, path: string, body?: unknown, maxBytes = this.jsonMax, ms = this.ms): Promise<RawReply> {
    return request(method, `${this.base}${path}`, ms, {}, body, { maxBytes });
  }

  private fail(what: string, reply: RawReply): never {
    throw new ComfyError(reply.status, clip(`${what} failed with HTTP ${reply.status}: ${reply.body.toString("utf8")}`));
  }

  /**
   * Queue a prompt. With a `clientId`, ComfyUI sends the prompt's progress and previews to the websocket
   * opened with the same id (see progress()).
   */
  async submit(prompt: unknown, clientId?: string): Promise<{ promptId: string }> {
    const reply = await this.call("POST", "/prompt", clientId === undefined ? { prompt } : { prompt, client_id: clientId });
    if (reply.status !== 200) this.fail("submit", reply);
    const id = (parseJson(reply.body) as { prompt_id?: unknown } | null)?.prompt_id;
    if (typeof id !== "string" || id === "") throw new ComfyError(reply.status, "submit: response has no prompt_id");
    return { promptId: id };
  }

  /** The history entry once the prompt has finished, or null while it has not. */
  async history(promptId: string): Promise<HistoryEntry | null> {
    if (!PROMPT_ID.test(promptId)) throw new ComfyError(0, "promptId has an invalid format");
    const reply = await this.call("GET", `/history/${encodeURIComponent(promptId)}`);
    if (reply.status !== 200) this.fail("history", reply);
    const body = parseJson(reply.body);
    if (!body || typeof body !== "object") throw new ComfyError(reply.status, "history: response is not a JSON object");
    const entry = (body as Record<string, unknown>)[promptId];
    return entry && typeof entry === "object" ? (entry as HistoryEntry) : null;
  }

  /**
   * Download one file from /view. `limits` replaces the image bounds (WEB_IMAGE_MAX_BYTES, WEB_IMAGE_TIMEOUT_S) for
   * a larger file such as a video (VIDEO_MAX_BYTES, VIDEO_VIEW_TIMEOUT_S, read by the caller at startup).
   */
  async view(filename: string, subfolder: string, type: ViewType, limits?: { maxBytes: number; timeoutMs: number }): Promise<{ bytes: Buffer; contentType: string }> {
    safeSegment("filename", filename, false);
    safeSegment("subfolder", subfolder, true);
    if (!(VIEW_TYPES as readonly string[]).includes(type)) throw new ComfyError(0, "type must be input, output or temp");
    const q = new URLSearchParams({ filename, subfolder, type });
    const reply = await this.call("GET", `/view?${q.toString()}`, undefined, limits?.maxBytes ?? this.imageMax, limits?.timeoutMs ?? this.imageMs);
    if (reply.status !== 200) this.fail("view", reply);
    return { bytes: reply.body, contentType: reply.contentType };
  }

  /**
   * Upload one reference image to ComfyUI's input folder (POST /upload/image) and return the name it
   * stored the file under. The name we send is chosen by the caller (never by a browser) and must be
   * a plain file name; the name in the reply is checked again before it can reach a workflow.
   */
  async uploadImage(name: string, bytes: Buffer, contentType: string): Promise<{ name: string }> {
    if (!isPlainFileName(name)) throw new ComfyError(0, "upload name must be a plain file name");
    if (!UPLOAD_CONTENT_TYPES.includes(contentType)) throw new ComfyError(0, "upload content type must be png, jpeg or webp");
    if (bytes.length === 0) throw new ComfyError(0, "upload must not be empty");
    const boundary = `----vastcomfy${randomBytes(BOUNDARY_BYTES).toString("hex")}`;
    const field = (key: string, value: string) =>
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`, "latin1");
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${name}"\r\nContent-Type: ${contentType}\r\n\r\n`,
        "latin1",
      ),
      bytes,
      Buffer.from("\r\n", "latin1"),
      field("type", "input"),
      field("overwrite", "false"),
      Buffer.from(`--${boundary}--\r\n`, "latin1"),
    ]);
    // A megabytes-sized body over the tailnet needs the image timeout, like /view downloads.
    const reply = await request("POST", `${this.base}/upload/image`, this.imageMs, {}, new RawBody(body, `multipart/form-data; boundary=${boundary}`), {
      maxBytes: this.jsonMax,
    });
    if (reply.status !== 200) this.fail("upload", reply);
    const parsed = parseJson(reply.body) as { name?: unknown; subfolder?: unknown; type?: unknown } | null;
    // The reference must sit directly in input/: a subfolder or another type would need a different LoadImage value.
    if (!parsed || !isPlainFileName(parsed.name) || parsed.subfolder !== "" || parsed.type !== "input") {
      throw new ComfyError(reply.status, "upload: unexpected response");
    }
    return { name: parsed.name };
  }

  /**
   * Open the progress websocket of one job on the same instance and port as every other call (same host
   * check, the JSON timeout as the connect timeout). Never throws; see progress.ts for the limits.
   */
  progress(clientId: string, sink: ProgressSink, limits: ProgressLimits, progressNode: string | null): ProgressSocket {
    return watchProgress(
      { host: this.host, port: this.port, clientId, connectTimeoutMs: this.ms, progressNode, ...limits },
      sink,
    );
  }

  async queue(): Promise<{ running: unknown[]; pending: unknown[] }> {
    const reply = await this.call("GET", "/queue");
    if (reply.status !== 200) this.fail("queue", reply);
    const body = parseJson(reply.body) as { queue_running?: unknown; queue_pending?: unknown } | null;
    if (!body || !Array.isArray(body.queue_running) || !Array.isArray(body.queue_pending)) {
      throw new ComfyError(reply.status, "queue: malformed response");
    }
    return { running: body.queue_running, pending: body.queue_pending };
  }
}
