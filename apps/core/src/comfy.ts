import type { AppsConfig } from "./config.js";
import { baseUrl, clip, parseJson, positiveInt, request, timeoutMs, type RawReply } from "./http.js";

export { Unreachable } from "./http.js";

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

export class ComfyClient {
  private readonly base: string;
  private readonly ms: number;

  constructor(host: string, cfg: AppsConfig) {
    this.base = baseUrl(host, positiveInt("COMFY_PORT", cfg["comfyPort"]));
    this.ms = timeoutMs(cfg);
  }

  private call(method: string, path: string, body?: unknown): Promise<RawReply> {
    return request(method, `${this.base}${path}`, this.ms, {}, body);
  }

  private fail(what: string, reply: RawReply): never {
    throw new ComfyError(reply.status, clip(`${what} failed with HTTP ${reply.status}: ${reply.body.toString("utf8")}`));
  }

  async submit(prompt: unknown): Promise<{ promptId: string }> {
    const reply = await this.call("POST", "/prompt", { prompt });
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

  async view(filename: string, subfolder: string, type: ViewType): Promise<{ bytes: Buffer; contentType: string }> {
    safeSegment("filename", filename, false);
    safeSegment("subfolder", subfolder, true);
    if (!(VIEW_TYPES as readonly string[]).includes(type)) throw new ComfyError(0, "type must be input, output or temp");
    const q = new URLSearchParams({ filename, subfolder, type });
    const reply = await this.call("GET", `/view?${q.toString()}`);
    if (reply.status !== 200) this.fail("view", reply);
    return { bytes: reply.body, contentType: reply.contentType };
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
