import type { AppsConfig } from "./config.js";

// Vast REST client. Endpoint shapes were read from the vastai 1.8.3 CLI/SDK source and
// `--explain` of read-only commands (search offers: POST /bundles/, list: GET v1 /instances/,
// create: PUT /asks/{offer}/, destroy: DELETE /instances/{id}/). The API key is sent only
// in the Authorization header and is redacted from everything this module throws.

const MAX_ERROR_TEXT = 200;
const GONE_TEXT = /instance\b.*\bnot found/i;
const RUNTYPE_SSH_DIRECT = "ssh_direc ssh_proxy"; // ssh + direct, as built by the vastai CLI
const MB_PER_GB = 1000; // the CLI sends gpu_ram in MB using 1000 per GB

export class VastError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VastError";
  }
}

export class DestroyError extends VastError {
  constructor(message: string) {
    super(message);
    this.name = "DestroyError";
  }
}

export interface OfferFilters {
  minVramGb: number;
  maxDph: number;
  minDownloadMbps: number;
  minReliability: number;
  diskGb: number;
  allowedGpus: readonly string[];
}

export interface Offer {
  id: number;
  dph_total: number;
  gpu_name?: string;
  gpu_ram?: number;
  reliability?: number;
  inet_down?: number;
  [key: string]: unknown;
}

export interface CreateRequest {
  image: string;
  disk: number;
  env: Readonly<Record<string, string>>;
  onstart: string;
  label: string;
}

export interface VastInstance {
  id: number;
  label: string | null;
  actual_status: string | null;
  start_date: number;
  dph_total: number;
  [key: string]: unknown;
}

export type DestroyOutcome = "destroyed" | "gone";

function positiveNumber(name: string, raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
  if (!Number.isFinite(value) || value <= 0) throw new VastError(`${name} must be a positive number`);
  return value;
}

/** Offer filters from the typed config; VAST_MAX_DPH and VAST_MIN_RELIABILITY are decimal text. */
export function offerFiltersFromConfig(cfg: AppsConfig): OfferFilters {
  const reliability = positiveNumber("VAST_MIN_RELIABILITY", cfg["vastMinReliability"]);
  if (reliability > 1) throw new VastError("VAST_MIN_RELIABILITY must be between 0 and 1");
  return {
    minVramGb: positiveNumber("VAST_MIN_VRAM_GB", cfg["vastMinVramGb"]),
    maxDph: positiveNumber("VAST_MAX_DPH", cfg["vastMaxDph"]),
    minDownloadMbps: positiveNumber("VAST_MIN_DOWNLOAD_MBPS", cfg["vastMinDownloadMbps"]),
    minReliability: reliability,
    diskGb: positiveNumber("VAST_DISK_GB", cfg["vastDiskGb"]),
    allowedGpus: (cfg["vastAllowedGpus"] as string[] | undefined) ?? [],
  };
}

interface Reply {
  status: number;
  text: string;
  json: unknown;
}

export class VastClient {
  private readonly key: string;
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(cfg: AppsConfig) {
    this.key = String(cfg["vastApiKey"] ?? "");
    if (this.key === "") throw new VastError("VAST_API_KEY is not configured");
    const url = String(cfg["vastApiUrl"] ?? "");
    if (url === "") throw new VastError("VAST_API_URL is not configured");
    this.base = url.endsWith("/") ? url : `${url}/`;
    this.timeoutMs = positiveNumber("HTTP_TIMEOUT_S_APPS", cfg["httpTimeoutSApps"]) * 1000;
  }

  private redact(text: string): string {
    let out = text.split(this.key).join("[redacted]");
    out = out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
    return out.length > MAX_ERROR_TEXT ? `${out.slice(0, MAX_ERROR_TEXT)}...` : out;
  }

  private async send(method: string, url: URL, body?: unknown): Promise<Reply> {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.key}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, init);
      text = await res.text();
    } catch (e) {
      const err = e as Error;
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        throw new VastError(`Vast ${method} ${url.pathname} timed out after ${this.timeoutMs} ms`);
      }
      throw new VastError(this.redact(`Vast ${method} ${url.pathname} failed: ${err.message}`));
    }
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, text, json };
  }

  private url(path: string, query?: Record<string, string>): URL {
    const url = new URL(path, this.base);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    return url;
  }

  private describe(reply: Reply): string {
    const body = reply.json as Record<string, unknown> | null;
    const detail = body && typeof body === "object" ? (body["msg"] ?? body["error"] ?? body["detail"]) : undefined;
    return this.redact(typeof detail === "string" ? detail : reply.text);
  }

  private failIfNotOk(what: string, reply: Reply): void {
    if (reply.status < 200 || reply.status >= 300) {
      throw new VastError(`${what} failed with HTTP ${reply.status}: ${this.describe(reply)}`);
    }
    const body = reply.json as Record<string, unknown> | null;
    if (body && typeof body === "object" && (body["success"] === false || body["error"] === true)) {
      throw new VastError(`${what} was rejected: ${this.describe(reply)}`);
    }
  }

  async searchOffers(filters: OfferFilters): Promise<Offer[]> {
    const query: Record<string, unknown> = {
      verified: { eq: true },
      external: { eq: false },
      rentable: { eq: true },
      rented: { eq: false },
      num_gpus: { eq: 1 },
      gpu_ram: { gte: filters.minVramGb * MB_PER_GB },
      reliability: { gte: filters.minReliability },
      dph_total: { lte: filters.maxDph },
      inet_down: { gte: filters.minDownloadMbps },
      disk_space: { gte: filters.diskGb },
      order: [["dph_total", "asc"]],
      type: "on-demand",
      allocated_storage: filters.diskGb,
    };
    if (filters.allowedGpus.length > 0) {
      query["gpu_name"] = { in: filters.allowedGpus.map((g) => g.replace(/_/g, " ")) };
    }
    const reply = await this.send("POST", this.url("bundles/"), query);
    this.failIfNotOk("search offers", reply);
    const offers = (reply.json as { offers?: unknown } | null)?.offers;
    if (!Array.isArray(offers)) throw new VastError("search offers: response has no offers list");
    const parsed = offers.map((o) => {
      const row = o as Offer;
      if (typeof row?.id !== "number" || typeof row.dph_total !== "number") {
        throw new VastError("search offers: malformed offer in response");
      }
      return row;
    });
    return parsed.sort((a, b) => a.dph_total - b.dph_total);
  }

  async createInstance(offerId: number, req: CreateRequest): Promise<{ id: number }> {
    if (!Number.isInteger(offerId) || offerId <= 0) throw new VastError("offer id must be a positive integer");
    for (const name of Object.keys(req.env)) {
      // Vast reads "-p ..." style env keys as port mappings; the contract maps none.
      if (name.startsWith("-") || name === "") throw new VastError("env keys must be plain variable names");
    }
    const payload = {
      client_id: "me",
      image: req.image,
      env: req.env,
      disk: req.disk,
      label: req.label,
      onstart: req.onstart,
      runtype: RUNTYPE_SSH_DIRECT,
      cancel_unavail: true, // fail instead of creating a stopped instance when scheduling fails
    };
    const reply = await this.send("PUT", this.url(`asks/${offerId}/`), payload);
    this.failIfNotOk("create instance", reply);
    const id = (reply.json as { new_contract?: unknown } | null)?.new_contract;
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
      throw new VastError("create instance: response has no instance id");
    }
    return { id };
  }

  async listInstances(): Promise<VastInstance[]> {
    const rows: VastInstance[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = {
        select_filters: "{}",
        order_by: JSON.stringify([{ col: "id", dir: "asc" }]),
        limit: "25",
      };
      if (token) query["after_token"] = token;
      const reply = await this.send("GET", this.url("../v1/instances/", query));
      this.failIfNotOk("list instances", reply);
      const body = reply.json as { instances?: unknown; next_token?: unknown } | null;
      if (!body || !Array.isArray(body.instances)) throw new VastError("list instances: response has no instances list");
      for (const raw of body.instances) {
        const row = raw as Record<string, unknown>;
        if (typeof row?.["id"] !== "number") throw new VastError("list instances: malformed instance in response");
        rows.push({
          ...row,
          id: row["id"],
          label: typeof row["label"] === "string" ? row["label"] : null,
          actual_status: typeof row["actual_status"] === "string" ? row["actual_status"] : null,
          start_date: Number(row["start_date"] ?? 0),
          dph_total: Number(row["dph_total"] ?? 0),
        });
      }
      token = typeof body.next_token === "string" && body.next_token !== "" ? body.next_token : undefined;
    } while (token);
    return rows;
  }

  /** "destroyed" or "gone" (already absent); anything else, whatever the HTTP status, is a DestroyError. */
  async destroyInstance(id: number): Promise<DestroyOutcome> {
    if (!Number.isInteger(id) || id <= 0) throw new DestroyError("instance id must be a positive integer");
    let reply: Reply;
    try {
      reply = await this.send("DELETE", this.url(`instances/${id}/`), {});
    } catch (e) {
      throw new DestroyError((e as Error).message);
    }
    const body = reply.json as Record<string, unknown> | null;
    const obj = body && typeof body === "object" ? body : null;
    const innerStatus = obj && typeof obj["status_code"] === "number" ? obj["status_code"] : undefined;
    const notFoundText = GONE_TEXT.test(reply.text);
    if (reply.status === 404 || innerStatus === 404) return "gone";
    if (reply.status === 200 && notFoundText && obj?.["success"] !== true) return "gone";
    if (reply.status >= 200 && reply.status < 300 && obj?.["success"] === true) return "destroyed";
    throw new DestroyError(`destroy instance ${id} failed (HTTP ${reply.status}): ${this.describe(reply)}`);
  }
}
