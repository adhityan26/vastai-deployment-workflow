import type { AppsConfig } from "./config.js";

// Shared plumbing for the instance clients (agent and ComfyUI): base URL from the configured
// port, one timeout for every call, and the network-failure error type.

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

export function timeoutMs(cfg: AppsConfig): number {
  return positiveInt("HTTP_TIMEOUT_S_APPS", cfg["httpTimeoutSApps"]) * 1000;
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

/** One request, no retry. Network failures and timeouts become Unreachable. */
export async function request(
  method: string,
  url: string,
  ms: number,
  headers: Record<string, string>,
  body: unknown,
  secret?: string,
): Promise<RawReply> {
  const init: RequestInit = { method, headers: { ...headers }, signal: AbortSignal.timeout(ms), redirect: "error" };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const path = new URL(url).pathname;
  try {
    const res = await fetch(url, init);
    const bytes = Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: bytes, contentType: res.headers.get("content-type") ?? "" };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new Unreachable(`${method} ${path} timed out after ${ms} ms`);
    }
    const code = err.cause?.code ? ` (${err.cause.code})` : "";
    throw new Unreachable(clip(`${method} ${path} failed: ${err.message}${code}`, secret));
  }
}

export function parseJson(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
}
