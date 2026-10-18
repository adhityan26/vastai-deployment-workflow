import type { AppsConfig } from "./config.js";

// Shared plumbing for the instance clients (agent and ComfyUI): base URL from the configured
// port, the timeouts (HTTP_TIMEOUT_S_APPS for JSON calls, WEB_IMAGE_TIMEOUT_S for image downloads; each
// request is given its own), and the network-failure error type.

const MAX_ERROR_TEXT = 200;
const HOST_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

/** The instance could not be reached (refused, DNS failure, timeout). Never an HTTP response. */
export class Unreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Unreachable";
  }
}

export function positiveInt(name: string, raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function baseUrl(host: string, port: number): string {
  if (!HOST_PATTERN.test(host)) throw new Error("instance host must be a plain hostname");
  return `http://${host}:${port}`; // config-lint: ok (scheme is a protocol constant; host and port are injected)
}

/** Body cap for JSON calls to the instance (WEB_JSON_MAX_BYTES). */
export function jsonMaxBytes(cfg: AppsConfig): number {
  return positiveInt("WEB_JSON_MAX_BYTES", cfg["webJsonMaxBytes"]);
}

export function timeoutMs(cfg: AppsConfig): number {
  return positiveInt("HTTP_TIMEOUT_S_APPS", cfg["httpTimeoutSApps"]) * 1000;
}

/** Timeout of one image download from ComfyUI /view (WEB_IMAGE_TIMEOUT_S); JSON calls use timeoutMs. */
export function imageTimeoutMs(cfg: AppsConfig): number {
  return positiveInt("WEB_IMAGE_TIMEOUT_S", cfg["webImageTimeoutS"]) * 1000;
}

export function clip(text: string, secret?: string): string {
  let out = secret ? text.split(secret).join("[redacted]") : text;
  out = out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  return out.length > MAX_ERROR_TEXT ? `${out.slice(0, MAX_ERROR_TEXT)}...` : out;
}

export interface RawReply {
  status: number;
  body: Buffer;
  contentType: string;
}

/** The instance answered with a body larger than the caller allows; reading stopped early. */
export class ResponseTooLarge extends Error {
  readonly limit: number;
  constructor(path: string, limit: number) {
    super(`response to ${path} exceeds ${limit} bytes`);
    this.name = "ResponseTooLarge";
    this.limit = limit;
  }
}

export interface RequestOptions {
  /** Largest response body accepted; a larger one throws ResponseTooLarge as soon as it is seen. */
  maxBytes: number;
  /** Redacted from every error message. */
  secret?: string;
  /** Fetch implementation (tests inject one); defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** Read at most `maxBytes` of the body; cancels the stream as soon as the running total passes it. */
async function readCapped(res: Response, maxBytes: number, path: string, abort: AbortController): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    abort.abort();
    throw new ResponseTooLarge(path, maxBytes);
  }
  if (res.body === null) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      abort.abort();
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLarge(path, maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/**
 * One request, no retry. Network failures and timeouts become Unreachable; oversized bodies ResponseTooLarge.
 * A URLSearchParams body is sent form-encoded; any other defined body as JSON.
 */
export async function request(
  method: string,
  url: string,
  ms: number,
  headers: Record<string, string>,
  body: unknown,
  opts: RequestOptions,
): Promise<RawReply> {
  if (!Number.isInteger(opts.maxBytes) || opts.maxBytes <= 0) throw new Error("maxBytes must be a positive integer");
  const abort = new AbortController();
  const init: RequestInit = {
    method,
    headers: { ...headers },
    signal: AbortSignal.any([AbortSignal.timeout(ms), abort.signal]),
    redirect: "error",
  };
  if (body instanceof URLSearchParams) {
    init.body = body.toString();
    (init.headers as Record<string, string>)["Content-Type"] = "application/x-www-form-urlencoded";
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const path = new URL(url).pathname;
  try {
    const res = await (opts.fetch ?? fetch)(url, init);
    const bytes = await readCapped(res, opts.maxBytes, path, abort);
    return { status: res.status, body: bytes, contentType: res.headers.get("content-type") ?? "" };
  } catch (e) {
    if (e instanceof ResponseTooLarge) throw e;
    const err = e as Error & { cause?: { code?: string } };
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new Unreachable(`${method} ${path} timed out after ${ms} ms`);
    }
    const code = err.cause?.code ? ` (${err.cause.code})` : "";
    throw new Unreachable(clip(`${method} ${path} failed: ${err.message}${code}`, opts.secret));
  }
}

export function parseJson(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
}
