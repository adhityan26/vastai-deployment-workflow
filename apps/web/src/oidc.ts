import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { AppsConfig } from "@vast-comfy/core";

// OIDC relying party for the Authentik login: authorization code flow with PKCE (S256), a per-login
// state and nonce, server-side code exchange with the client secret, and ID token verification with
// pinned asymmetric algorithms. Nothing in this module ever puts a code, token or secret in an error.

/** Only asymmetric algorithms, pinned: rules out `none` and HS* forged with the public key text. */
const ID_TOKEN_ALGORITHMS = ["RS256", "ES256"];
/**
 * Oldest ID token accepted, by its `iat`: the token is minted during the code exchange a moment
 * before we verify it, so a few minutes is generous. jose adds the configured clock skew
 * (WEB_OIDC_SKEW_S) on top of this, and also rejects an `iat` or `nbf` in the future beyond it.
 */
const MAX_ID_TOKEN_AGE_S = 300;
/** Scopes requested from the provider; Authentik's `profile` scope carries the `groups` claim. */
const SCOPES = "openid profile email";
/** Path of the callback route, appended to the WEB_PUBLIC_URL origin (never taken from a request). */
export const CALLBACK_PATH = "/auth/callback";
const DISCOVERY_SUFFIX = "/.well-known/openid-configuration";
/** Random bytes behind state and nonce (base64url) and the PKCE verifier (RFC 7636 asks for 32). */
const STATE_BYTES = 32;
const VERIFIER_BYTES = 32;
/** Longest `next` return path kept; anything longer becomes `/`. */
const MAX_NEXT_LENGTH = 2048;
/** Longest authorization code forwarded to the token endpoint; a longer one is not exchanged. */
const MAX_CODE_LENGTH = 4096;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]); // config-lint: ok (loopback names allowed plain http for local development)
/** Placeholder origin used only to parse relative return paths; never emitted. */
const PARSE_BASE = "https://next.invalid"; // config-lint: ok (parsing base for relative paths, not an endpoint)

export type OidcErrorCode =
  | "not_configured"
  | "discovery_failed"
  | "state_mismatch"
  | "provider_error"
  | "exchange_failed"
  | "token_invalid"
  | "nonce_mismatch"
  | "no_subject";

/** A failed login step. The message is the fixed code only: never a code, token, secret or provider text. */
export class OidcError extends Error {
  readonly code: OidcErrorCode;
  constructor(code: OidcErrorCode) {
    super(`oidc: ${code}`);
    this.name = "OidcError";
    this.code = code;
  }
}

export interface OidcIdentity {
  readonly subject: string;
  readonly username: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly groups: readonly string[];
}

/** What the login-transaction cookie remembers between /auth/login and /auth/callback. */
export interface LoginTransaction {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly next: string;
}

export interface OidcDeps {
  fetch?: typeof fetch;
  /** Milliseconds since the epoch; used for ID token time checks. */
  now?: () => number;
  /** ID token key resolver; defaults to the provider's JWKS (jwks_uri from discovery), created lazily. */
  jwks?: JWTVerifyGetKey;
}

export interface Oidc {
  /** True only when issuer, client id, client secret and a valid public URL are all set. */
  readonly configured: boolean;
  /** Origin of WEB_PUBLIC_URL ("" when not configured). */
  readonly publicOrigin: string;
  /** Whether cookies get the Secure attribute (true unless the public URL is http on localhost). */
  readonly secureCookies: boolean;
  /** The exact redirect_uri sent to the provider ("" when not configured). */
  readonly redirectUri: string;
  begin(next: unknown): Promise<{ redirectUrl: string; transaction: LoginTransaction }>;
  finish(params: { code?: string; state?: string; error?: string }, tx: LoginTransaction): Promise<OidcIdentity>;
}

interface Discovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}

function str(cfg: AppsConfig, key: string): string {
  const value = cfg[key];
  return typeof value === "string" ? value : "";
}

function int(cfg: AppsConfig, key: string, fallback: number): number {
  const value = cfg[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function random(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

/** Constant-time string equality (hashing first makes the lengths equal). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** https anywhere; plain http only on a loopback host (local development and tests). */
function allowedUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url;
  return null;
}

/**
 * WEB_PUBLIC_URL parsed to its origin. Only a bare origin is accepted (an optional single trailing
 * slash is tolerated); a path, query, fragment or credentials make it invalid, so nothing surprising
 * ends up in the redirect_uri.
 */
export function parsePublicUrl(raw: string): { origin: string; secure: boolean } | null {
  if (raw === "") return null;
  const url = allowedUrl(raw);
  if (url === null || url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  return { origin: url.origin, secure: url.protocol === "https:" };
}

/**
 * Same-site relative return path, or "/". Accepts only a path that starts with a single "/", with no
 * backslash, no control characters and no scheme, that still resolves to the same origin and does not
 * normalise into a protocol-relative ("//host") path. The result is the parsed URL's percent-encoded
 * path, query and fragment (never the raw input), so it is always safe in a Location header.
 */
export function sanitizeNext(next: unknown): string {
  if (typeof next !== "string" || next === "" || next.length > MAX_NEXT_LENGTH) return "/";
  if (!next.startsWith("/") || next.startsWith("//")) return "/";
  if (next.includes("\\") || /[\u0000-\u001f\u007f]/.test(next)) return "/";
  let url: URL;
  try {
    url = new URL(next, PARSE_BASE);
  } catch {
    return "/";
  }
  if (url.origin !== new URL(PARSE_BASE).origin || url.pathname.startsWith("//")) return "/";
  const out = `${url.pathname}${url.search}${url.hash}`;
  if (!out.startsWith("/") || out.startsWith("//") || out.length > MAX_NEXT_LENGTH) return "/";
  return out;
}

/** Discovery URL per OpenID Connect Discovery 1.0 section 4: drop a terminating "/" then append the suffix. */
function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/$/, "")}${DISCOVERY_SUFFIX}`;
}

/** Read at most `maxBytes` of a response body; anything larger throws before it is buffered. */
async function readCapped(res: Response, maxBytes: number, abort: AbortController): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    abort.abort();
    throw new Error("response too large");
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
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

function jsonObject(buf: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(buf.toString("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function groupsOf(claims: JWTPayload): string[] {
  const raw: unknown = claims["groups"];
  if (!Array.isArray(raw) || !raw.every((g): g is string => typeof g === "string")) return [];
  return [...raw];
}

export function createOidc(cfg: AppsConfig, deps: OidcDeps = {}): Oidc {
  const issuer = str(cfg, "authentikIssuer");
  const clientId = str(cfg, "authentikClientId");
  const clientSecret = str(cfg, "authentikClientSecret");
  const publicUrl = parsePublicUrl(str(cfg, "webPublicUrl"));
  const skewS = int(cfg, "webOidcSkewS", 0);
  const timeoutMs = int(cfg, "httpTimeoutSApps", 0) * 1000;
  const maxBytes = int(cfg, "webJsonMaxBytes", 0);
  const doFetch = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;

  const configured =
    issuer !== "" &&
    allowedUrl(issuer) !== null &&
    clientId !== "" &&
    clientSecret !== "" &&
    publicUrl !== null &&
    timeoutMs > 0 &&
    maxBytes > 0;
  const redirectUri = publicUrl === null ? "" : `${publicUrl.origin}${CALLBACK_PATH}`;

  let discovered: Discovery | null = null;
  let pending: Promise<Discovery> | null = null;
  let jwks: JWTVerifyGetKey | null = deps.jwks ?? null;

  /** One capped, timed request; any transport problem, timeout or oversized body throws. */
  async function call(url: string, init: RequestInit): Promise<{ status: number; body: Buffer }> {
    const abort = new AbortController();
    const res = await doFetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), abort.signal]),
    });
    return { status: res.status, body: await readCapped(res, maxBytes, abort) };
  }

  async function fetchDiscovery(): Promise<Discovery> {
    let doc: Record<string, unknown> | null;
    try {
      const res = await call(discoveryUrl(issuer), { method: "GET", headers: { Accept: "application/json" } });
      doc = res.status === 200 ? jsonObject(res.body) : null;
    } catch {
      throw new OidcError("discovery_failed");
    }
    if (doc === null || doc["issuer"] !== issuer) throw new OidcError("discovery_failed");
    const endpoints = [doc["authorization_endpoint"], doc["token_endpoint"], doc["jwks_uri"]];
    if (!endpoints.every((e) => typeof e === "string" && allowedUrl(e) !== null)) throw new OidcError("discovery_failed");
    const methods = doc["code_challenge_methods_supported"];
    if (methods !== undefined && !(Array.isArray(methods) && methods.includes("S256"))) {
      throw new OidcError("discovery_failed");
    }
    const [authorizationEndpoint, tokenEndpoint, jwksUri] = endpoints as [string, string, string];
    return { issuer, authorizationEndpoint, tokenEndpoint, jwksUri };
  }

  /** Discovered once per process; a failure is not cached, so the next login tries again. */
  function discovery(): Promise<Discovery> {
    if (discovered !== null) return Promise.resolve(discovered);
    if (pending === null) {
      pending = fetchDiscovery().then(
        (doc) => {
          discovered = doc;
          pending = null;
          return doc;
        },
        (error: unknown) => {
          pending = null;
          throw error;
        },
      );
    }
    return pending;
  }

  function keys(doc: Discovery): JWTVerifyGetKey {
    if (jwks === null) {
      jwks = createRemoteJWKSet(new URL(doc.jwksUri), {
        timeoutDuration: timeoutMs,
        [customFetch]: doFetch as never,
      });
    }
    return jwks;
  }

  async function begin(next: unknown): Promise<{ redirectUrl: string; transaction: LoginTransaction }> {
    if (!configured) throw new OidcError("not_configured");
    const doc = await discovery();
    const transaction: LoginTransaction = Object.freeze({
      state: random(STATE_BYTES),
      nonce: random(STATE_BYTES),
      verifier: random(VERIFIER_BYTES),
      next: sanitizeNext(next),
    });
    const challenge = createHash("sha256").update(transaction.verifier, "ascii").digest("base64url");
    const url = new URL(doc.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("state", transaction.state);
    url.searchParams.set("nonce", transaction.nonce);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return { redirectUrl: url.toString(), transaction };
  }

  async function exchange(doc: Discovery, code: string, verifier: string): Promise<string> {
    // client_secret_post rather than client_secret_basic: Basic auth requires the id and secret to be
    // form-urlencoded before base64 (RFC 6749 section 2.3.1), which is easy to get subtly wrong for
    // secrets with special characters; Authentik accepts both, and the body travels only over TLS to
    // the token endpoint, so posting the secret in the form avoids that encoding pitfall.
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: verifier,
    });
    let res: { status: number; body: Buffer };
    try {
      res = await call(doc.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: form.toString(),
      });
    } catch {
      throw new OidcError("exchange_failed");
    }
    const body = res.status === 200 ? jsonObject(res.body) : null;
    const idToken = body === null ? null : optionalString(body["id_token"]);
    if (idToken === null) throw new OidcError("exchange_failed");
    return idToken;
  }

  async function finish(params: { code?: string; state?: string; error?: string }, tx: LoginTransaction): Promise<OidcIdentity> {
    if (!configured) throw new OidcError("not_configured");
    const state = typeof params.state === "string" ? params.state : "";
    if (state === "" || tx.state === "" || !safeEqual(state, tx.state)) throw new OidcError("state_mismatch");
    if (params.error !== undefined) throw new OidcError("provider_error");
    const code = typeof params.code === "string" ? params.code : "";
    if (code === "" || code.length > MAX_CODE_LENGTH) throw new OidcError("exchange_failed");

    const doc = await discovery();
    const idToken = await exchange(doc, code, tx.verifier);
    let claims: JWTPayload;
    try {
      ({ payload: claims } = await jwtVerify(idToken, keys(doc), {
        issuer: doc.issuer,
        audience: clientId,
        algorithms: ID_TOKEN_ALGORITHMS,
        requiredClaims: ["exp", "iat"],
        maxTokenAge: MAX_ID_TOKEN_AGE_S,
        clockTolerance: skewS,
        currentDate: new Date(now()),
      }));
    } catch {
      throw new OidcError("token_invalid");
    }
    // OIDC Core 3.1.3.7: with several audiences, or any azp, the azp must be this client.
    const azp = claims["azp"];
    if ((Array.isArray(claims.aud) && claims.aud.length > 1) || azp !== undefined) {
      if (azp !== clientId) throw new OidcError("token_invalid");
    }
    const nonce = claims["nonce"];
    if (typeof nonce !== "string" || tx.nonce === "" || !safeEqual(nonce, tx.nonce)) throw new OidcError("nonce_mismatch");
    const subject = optionalString(claims.sub);
    if (subject === null) throw new OidcError("no_subject");
    const email = optionalString(claims["email"]);
    return Object.freeze({
      subject,
      username: optionalString(claims["preferred_username"]) ?? email ?? subject,
      name: optionalString(claims["name"]),
      email,
      groups: Object.freeze(groupsOf(claims)),
    });
  }

  return {
    configured,
    publicOrigin: publicUrl?.origin ?? "",
    secureCookies: publicUrl?.secure ?? true,
    redirectUri,
    begin,
    finish,
  };
}
