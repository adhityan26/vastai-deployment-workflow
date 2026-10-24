import { readFile } from "node:fs/promises";
import type { AppsConfig } from "./config.js";
import { ResponseTooLarge, jsonMaxBytes, parseJson, request, timeoutMs, type RawReply } from "./http.js";

// Tailscale auth keys for new instances. With an OAuth client (TS_OAUTH_CLIENT_ID and
// TS_OAUTH_CLIENT_SECRET) every Start mints its own key: client-credentials token (cached until
// shortly before it expires), then POST /api/v2/tailnet/-/keys for a single-use, ephemeral,
// pre-approved key carrying only TS_OAUTH_TAG. Without OAuth the manually created key file
// (TS_AUTHKEY_FILE) is read. When OAuth is configured, or half-configured, there is never a
// fallback to the file. The client secret, the access token and the minted key never appear in
// an error or a log line: errors carry a fixed code, logs fixed text and HTTP status numbers.
// Network errors, timeouts and 5xx answers are retried (bounded by TS_RETRY_TOTAL_S); 4xx never.
// UNVERIFIED against the live API: the request shapes follow the public Tailscale API docs;
// the minimum accepted expirySeconds and the 400 wording for a rejected expiry are unmeasured.

const TOKEN_PATH = "/api/v2/oauth/token"; // Tailscale API protocol constant
const KEYS_PATH = "/api/v2/tailnet/-/keys"; // "-" is the OAuth client's own tailnet
const KEY_DESCRIPTION = "vast-comfy start";
/** Larger expiry retried once when Tailscale refuses TS_KEY_TTL_S (1 day, the console default). */
export const KEY_TTL_FALLBACK_S = 86400;
/** A cached token is renewed this long before Tailscale says it expires. */
const TOKEN_MARGIN_S = 60;
const EXPIRY_TEXT = /expir/i;
/** A key or token is one printable ASCII word: it goes into an env value or a header. */
const CREDENTIAL_TEXT = /^[\x21-\x7e]{1,1024}$/;
const TAG_TEXT = /^tag:[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
/** Attempts per Tailscale call (1 + 2 retries) and the back-off before each retry, plus up to RETRY_JITTER_MS. */
const RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1000, 2000] as const;
const RETRY_JITTER_MS = 500;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]); // config-lint: ok (loopback names allowed plain http for tests)

export type TailscaleErrorCode = "oauth_failed" | "key_rejected" | "tailscale_unavailable" | "invalid_response";

/** Minting failed. The message is the fixed code only: never a secret, token, key or provider text. */
export class TailscaleError extends Error {
  readonly code: TailscaleErrorCode;
  constructor(code: TailscaleErrorCode) {
    super(`tailscale: ${code}`);
    this.name = "TailscaleError";
    this.code = code;
  }
}

/** Where Start gets its auth key: the OAuth client, the key file, or nowhere (half-configured OAuth). */
export type TailscaleKeySource = "oauth" | "file" | "misconfigured";

type Level = "info" | "warn" | "error";

export interface TailscaleDeps {
  fetch?: typeof fetch;
  /** Milliseconds since the epoch (token expiry). */
  now?: () => number;
  /** Fixed-text log lines (no secrets). */
  log?: (level: Level, message: string) => void;
  /** Called with every access token and minted key before it is used, so callers can redact it. */
  onSecret?: (value: string) => void;
  /** Waits before a retry (tests record instead of waiting). */
  sleep?: (ms: number) => Promise<void>;
  /** 0 <= x < 1, for the retry jitter. */
  random?: () => number;
  /** Monotonic milliseconds for the retry deadline (TS_RETRY_TOTAL_S); defaults to performance.now. */
  monotonic?: () => number;
}

export interface TailscaleKeyMinter {
  /** "misconfigured": OAuth is half-set or invalid; mint() always refuses without a network call. */
  readonly source: "oauth" | "misconfigured";
  /** Why the OAuth path is refused (names keys only), or null. */
  readonly problem: string | null;
  mint(): Promise<string>;
}

function str(cfg: AppsConfig, key: string): string {
  const v = cfg[key];
  return typeof v === "string" ? v : "";
}

export function tailscaleKeySource(cfg: AppsConfig): TailscaleKeySource {
  const id = str(cfg, "tsOauthClientId") !== "";
  const secret = str(cfg, "tsOauthClientSecret") !== "";
  if (id && secret) return "oauth";
  return id || secret ? "misconfigured" : "file";
}

/** The API origin: https, or plain http on a loopback host; no credentials, query or fragment. */
function apiBase(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const httpsOk = url.protocol === "https:";
  const loopbackOk = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (!httpsOk && !loopbackOk) return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

function refusing(problem: string): TailscaleKeyMinter {
  return {
    source: "misconfigured",
    problem,
    mint: () => Promise.reject(new TailscaleError("oauth_failed")),
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A capabilities echo, when present, must be exactly what was asked for. */
function capabilitiesMatch(echo: unknown, tag: string): boolean {
  if (echo === undefined) return true;
  const create = isObject(echo) && isObject(echo["devices"]) ? echo["devices"]["create"] : undefined;
  if (!isObject(create)) return false;
  const tags = create["tags"];
  return (
    create["reusable"] === false &&
    create["ephemeral"] === true &&
    create["preauthorized"] === true &&
    Array.isArray(tags) &&
    tags.length === 1 &&
    tags[0] === tag
  );
}

/**
 * The OAuth key minter, or null when no OAuth key is set (the key-file path applies). Exactly one
 * OAuth key set, or an invalid TS_API_URL / TS_OAUTH_TAG / timeout or size setting, gives a minter
 * that always refuses: fail closed, never the key file.
 */
export function createTailscaleKeyMinter(cfg: AppsConfig, deps: TailscaleDeps = {}): TailscaleKeyMinter | null {
  const source = tailscaleKeySource(cfg);
  if (source === "file") return null;
  if (source === "misconfigured") {
    return refusing("TS_OAUTH_CLIENT_ID and TS_OAUTH_CLIENT_SECRET must both be set (exactly one is)");
  }
  const base = apiBase(str(cfg, "tsApiUrl"));
  if (base === null) return refusing("TS_API_URL must be an https origin (plain http only on a loopback host)");
  const tag = str(cfg, "tsOauthTag");
  if (!TAG_TEXT.test(tag)) return refusing("TS_OAUTH_TAG must be one tag such as tag:gpu");
  const ttl = cfg["tsKeyTtlS"];
  if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl <= 0) return refusing("TS_KEY_TTL_S must be a positive integer");
  const retryTotal = cfg["tsRetryTotalS"];
  if (typeof retryTotal !== "number" || !Number.isInteger(retryTotal) || retryTotal <= 0) {
    return refusing("TS_RETRY_TOTAL_S must be a positive integer");
  }
  let ms: number;
  let maxBytes: number;
  try {
    ms = timeoutMs(cfg);
    maxBytes = jsonMaxBytes(cfg);
  } catch {
    return refusing("HTTP_TIMEOUT_S_APPS and WEB_JSON_MAX_BYTES must be positive integers");
  }

  const clientId = str(cfg, "tsOauthClientId");
  const clientSecret = str(cfg, "tsOauthClientSecret");
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const onSecret = deps.onSecret ?? (() => undefined);
  const sleep = deps.sleep ?? ((wait: number) => new Promise<void>((r) => setTimeout(r, wait)));
  const random = deps.random ?? Math.random;
  const monotonic = deps.monotonic ?? (() => performance.now());
  const opts = { maxBytes, secret: clientSecret, ...(deps.fetch ? { fetch: deps.fetch } : {}) };

  let cached: { token: string; until: number } | null = null;
  let pending: Promise<string> | null = null;

  const fail = (code: TailscaleErrorCode, what: string, status?: number): never => {
    log("warn", `tailscale ${what} failed: ${code}${status === undefined ? "" : ` (HTTP ${status})`}`);
    throw new TailscaleError(code);
  };

  /**
   * One call, retried on a network error, a timeout or a 5xx only (never on a 4xx: auth, permission,
   * a rejected key or a rate limit), at most RETRY_ATTEMPTS times and only while the next attempt
   * starts before `deadline`. A retry's timeout is cut to what is left of the deadline; the first
   * attempt keeps the full HTTP_TIMEOUT_S_APPS. Transport problems become fixed codes (the
   * underlying message is dropped); a last 5xx reply is returned for the caller to map.
   */
  const send = async (what: string, url: string, headers: Record<string, string>, body: unknown, deadline: number): Promise<RawReply> => {
    for (let attempt = 1; ; attempt++) {
      const left = deadline - monotonic();
      const wait = attempt === 1 ? ms : Math.max(1, Math.min(ms, Math.floor(left)));
      let reply: RawReply | null = null;
      try {
        reply = await request("POST", url, wait, headers, body, opts);
      } catch (e) {
        if (e instanceof ResponseTooLarge) return fail("invalid_response", what);
      }
      if (reply !== null && reply.status < 500) return reply;
      const cause = reply === null ? "network error or timeout" : `HTTP ${reply.status}`;
      const backoff = attempt <= RETRY_BACKOFF_MS.length ? RETRY_BACKOFF_MS[attempt - 1]! + Math.floor(random() * RETRY_JITTER_MS) : 0;
      if (attempt >= RETRY_ATTEMPTS || monotonic() + backoff >= deadline) {
        if (reply !== null) return reply;
        return fail("tailscale_unavailable", what);
      }
      log("warn", `tailscale ${what} retry ${attempt + 1}/${RETRY_ATTEMPTS} after ${cause}`);
      await sleep(backoff);
    }
  };

  const fetchToken = async (deadline: number): Promise<string> => {
    const form = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret });
    const reply = await send("token request", `${base}${TOKEN_PATH}`, { Accept: "application/json" }, form, deadline);
    if (reply.status === 429 || reply.status >= 500) return fail("tailscale_unavailable", "token request", reply.status);
    if (reply.status < 200 || reply.status >= 300) return fail("oauth_failed", "token request", reply.status);
    const body = parseJson(reply.body);
    const token = isObject(body) ? body["access_token"] : undefined;
    const type = isObject(body) ? body["token_type"] : undefined;
    if (typeof token !== "string" || !CREDENTIAL_TEXT.test(token)) return fail("invalid_response", "token request");
    if (type !== undefined && (typeof type !== "string" || type.toLowerCase() !== "bearer")) {
      return fail("invalid_response", "token request");
    }
    onSecret(token);
    const expiresIn = isObject(body) ? body["expires_in"] : undefined;
    // Without a usable lifetime the token serves only the mint that asked for it.
    if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > TOKEN_MARGIN_S) {
      cached = { token, until: now() + (expiresIn - TOKEN_MARGIN_S) * 1000 };
    }
    return token;
  };

  /** The cached token, or one shared request for a new one. */
  const token = (deadline: number): Promise<string> => {
    if (cached !== null && now() < cached.until) return Promise.resolve(cached.token);
    cached = null;
    if (pending === null) {
      const p = fetchToken(deadline);
      pending = p;
      const clear = (): void => {
        if (pending === p) pending = null;
      };
      p.then(clear, clear);
    }
    return pending;
  };

  const keyRequest = (bearer: string, expirySeconds: number, deadline: number): Promise<RawReply> =>
    send(
      "key request",
      `${base}${KEYS_PATH}`,
      { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
      {
        capabilities: { devices: { create: { reusable: false, ephemeral: true, preauthorized: true, tags: [tag] } } },
        expirySeconds,
        description: KEY_DESCRIPTION,
      },
      deadline,
    );

  const mint = async (): Promise<string> => {
    // One retry budget (TS_RETRY_TOTAL_S) for the whole mint: token and key request together.
    const deadline = monotonic() + retryTotal * 1000;
    const bearer = await token(deadline);
    let reply = await keyRequest(bearer, ttl, deadline);
    if (reply.status === 400 && ttl !== KEY_TTL_FALLBACK_S && EXPIRY_TEXT.test(reply.body.toString("utf8"))) {
      log("warn", `tailscale key ttl fallback: TS_KEY_TTL_S=${ttl} was refused, retrying once with ${KEY_TTL_FALLBACK_S}`);
      reply = await keyRequest(bearer, KEY_TTL_FALLBACK_S, deadline);
    }
    if (reply.status === 401 || reply.status === 403) {
      // The token is no good (revoked client, lost scope): never reuse it.
      if (cached?.token === bearer) cached = null;
      return fail("oauth_failed", "key request", reply.status);
    }
    if (reply.status === 429 || reply.status >= 500) return fail("tailscale_unavailable", "key request", reply.status);
    if (reply.status < 200 || reply.status >= 300) return fail("key_rejected", "key request", reply.status);
    const body = parseJson(reply.body);
    const key = isObject(body) ? body["key"] : undefined;
    if (typeof key !== "string" || !CREDENTIAL_TEXT.test(key)) return fail("invalid_response", "key request");
    onSecret(key);
    if (!capabilitiesMatch(isObject(body) ? body["capabilities"] : undefined, tag)) {
      return fail("invalid_response", "key request");
    }
    log("info", "tailscale auth key minted");
    return key;
  };

  return { source: "oauth", problem: null, mint };
}

export interface TsAuthKeyProviderDeps extends TailscaleDeps {
  /** Reads TS_AUTHKEY_FILE (file mode only); defaults to the file system. */
  readKeyFile?: (path: string) => Promise<string>;
}

export interface TsAuthKeyProvider {
  readonly source: TailscaleKeySource;
  /** The Lifecycle's tsAuthKey dependency. Rejects with TailscaleError in oauth/misconfigured mode. */
  tsAuthKey(): Promise<string>;
}

/**
 * Chooses the auth key source once, at startup, and logs it in one line. OAuth when both client
 * keys are set; the key file when neither is; with exactly one set Start is refused
 * (ts_key_mint_failed) and the key file is never read.
 */
export function createTsAuthKeyProvider(cfg: AppsConfig, deps: TsAuthKeyProviderDeps = {}): TsAuthKeyProvider {
  const log = deps.log ?? (() => undefined);
  const onSecret = deps.onSecret ?? (() => undefined);
  const minter = createTailscaleKeyMinter(cfg, deps);
  if (minter === null) {
    log("info", "tailscale auth key source: file");
    const readKeyFile = deps.readKeyFile ?? ((path: string) => readFile(path, "utf8"));
    return {
      source: "file",
      tsAuthKey: async () => {
        const file = str(cfg, "tsAuthkeyFile");
        if (file === "") throw new Error("TS_AUTHKEY_FILE is not configured");
        const key = (await readKeyFile(file)).trim();
        if (key !== "") onSecret(key);
        return key;
      },
    };
  }
  if (minter.source === "misconfigured") {
    log(
      "error",
      `tailscale auth key source: misconfigured: ${minter.problem ?? "invalid OAuth settings"}; ` +
        "every Start is refused with ts_key_mint_failed and TS_AUTHKEY_FILE is NOT used as a fallback",
    );
    return { source: "misconfigured", tsAuthKey: () => minter.mint() };
  }
  log("info", "tailscale auth key source: oauth");
  return { source: "oauth", tsAuthKey: () => minter.mint() };
}
