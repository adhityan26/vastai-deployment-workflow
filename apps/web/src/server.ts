import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { readFile, realpath, lstat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type {
  AppsConfig,
  ComfyClient,
  Gallery,
  InstanceRecord,
  Lifecycle,
  Profile,
  LoraStore,
} from "@vast-comfy/core";
import type { Auth, Identity, Role } from "./auth.js";
import { registerAuthRoutes, type LoginDeps } from "./auth-routes.js";
import { parsePublicUrl } from "./oidc.js";
import { registerApiRoutes } from "./routes.js";
import { sendError } from "./reply.js";

// HTTP surface of the web app. Every request passes one onRequest gate: /api/* needs an
// identity from auth.identify() (a valid session cookie; 401) and the route's role (403); every
// state-changing request must come from our own origin (403 csrf, see sameOrigin) and be JSON
// (415). Public routes are exactly /healthz, the static files and /auth/{login,callback,logout}.
// Unknown routes are 404 with a JSON error. Responses carry strict security headers and never
// CORS headers; /api and /auth responses are never cacheable.

export type Access = "public" | "member" | "admin";

declare module "fastify" {
  interface FastifyContextConfig {
    access?: Access;
  }
  interface FastifyRequest {
    identity: Identity | null;
    role: Role;
  }
}

export interface ServerDeps {
  cfg: AppsConfig;
  auth: Pick<Auth, "identify" | "role">;
  lifecycle: Pick<Lifecycle, "view" | "estimate" | "gpuOptions" | "offers" | "parseFilters" | "start" | "destroy" | "destroyUnknown" | "extend" | "console" | "history"> &
    Partial<Pick<Lifecycle, "downloadVideoModels" | "downloadVideoFamily" | "syncLoras">>;
  /** The active registry record; used to route job polls to the instance that ran them. */
  registry: { active(): Promise<InstanceRecord | null> };
  /** A ComfyUI client for an instance hostname (built from config; never from the request). */
  comfyFor(hostname: string): Pick<ComfyClient, "submit" | "history" | "view" | "uploadImage" | "queue" | "deleteQueued" | "interrupt"> & Partial<Pick<ComfyClient, "progress">>;
  profile: Profile;
  /** The workflow template JSON named by the profile. */
  template: unknown;
  /** The edit workflow template named by the profile's edit section; absent or null turns edit off. */
  editTemplate?: unknown;
  /** The upscale workflow template; null/absent when the profile has no enabled upscale section. */
  upscaleTemplate?: unknown;
  /** The video workflow template; null/absent when the profile has no enabled video section (video is then off). */
  videoTemplate?: unknown;
  /** The workflows of the enabled video families besides the base section, by file name (each must be there). */
  videoFamilyTemplates?: Readonly<Record<string, unknown>>;
  /** Extra LoRAs admins add by link (LORA_STORE_PATH); absent turns that management off. */
  loraStore?: LoraStore;
  /** Reads the Vast account credit in USD (admin page); absent means GET /api/credit answers 404. */
  credit?(): Promise<number>;
  /** Saved images (MinIO); absent means saving and the gallery are off (the routes answer 503). */
  gallery?: Gallery;
  /** Directory of the static page (apps/web/public); may be empty or missing. */
  publicDir: string;
  /** Login routes; absent (or not configured) means /auth/login and /auth/callback answer 503. */
  login?: LoginDeps;
  /** Secret values that must never appear in a response (Vast key, Tailscale key, ...). */
  secrets(): readonly string[];
  /** Epoch milliseconds; injectable for tests. */
  now?(): number;
  /** One log line; never receives tokens, prompts or request bodies. Defaults to silence. */
  log?(level: "info" | "warn" | "error", message: string): void;
}

// Protocol constants: header values defined by the HTTP/CSP specifications.
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; " +
  "connect-src 'self'; manifest-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; " +
  "frame-ancestors 'none'";
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};
const JSON_TYPE = "application/json";
const SAME_ORIGIN = "same-origin";
const SAFE_METHODS = new Set(["GET", "HEAD"]);
const MIN_SECRET_LENGTH = 8;

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};
const STATIC_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STATIC_INDEX = "index.html";

function pathOf(req: FastifyRequest): string {
  const url = req.raw.url ?? "/";
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

function isApiPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower === "/api" || lower.startsWith("/api/");
}

function isAuthPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower === "/auth" || lower.startsWith("/auth/");
}

function single(value: string | string[] | undefined): string | undefined | null {
  if (Array.isArray(value)) return value.length === 1 ? value[0] : null;
  return value;
}

/**
 * The one CSRF rule for every state-changing (non-GET/HEAD) request, /api/* and /auth/logout alike:
 * - an `Origin` header, when present, must equal the origin of WEB_PUBLIC_URL exactly;
 * - a `Sec-Fetch-Site` header, when present, must be `same-origin` (not `none`, `same-site` or
 *   `cross-site`: a sibling subdomain is another site for us);
 * - at least one of the two must be present and positive: without an `Origin` the request is
 *   allowed only with `Sec-Fetch-Site: same-origin`.
 * Browsers send Origin on every cross-origin POST and on same-origin fetch POSTs, so a forged form
 * or fetch from another site always fails. GET navigations (/auth/login, /auth/callback) are exempt.
 */
function sameOrigin(headers: FastifyRequest["headers"], publicOrigin: string): boolean {
  const origin = single(headers["origin"]);
  const site = single(headers["sec-fetch-site"]);
  if (origin === null || site === null) return false;
  if (site !== undefined && site.toLowerCase() !== SAME_ORIGIN) return false;
  if (origin !== undefined) return publicOrigin !== "" && origin === publicOrigin;
  return site !== undefined;
}

/**
 * True for an /api request, judged by BOTH the raw request path and the matched route pattern:
 * the router percent-decodes before matching, so `/%61pi/x` matches the route `/api/x` while its
 * raw path does not start with /api.
 */
function isApiRequest(req: FastifyRequest): boolean {
  return isApiPath(pathOf(req)) || isApiPath(req.routeOptions.url ?? "");
}

function isAuthRequest(req: FastifyRequest): boolean {
  return isAuthPath(pathOf(req)) || isAuthPath(req.routeOptions.url ?? "");
}

/** The access a request needs. /api requests are never public, whatever route matched or tag it has. */
function accessFor(req: FastifyRequest): Access {
  const declared = req.routeOptions.config?.access;
  if (isApiRequest(req)) return declared === "admin" ? "admin" : "member";
  return declared ?? "public";
}

function allowed(role: Role, access: Access): boolean {
  if (access === "public") return true;
  if (access === "admin") return role === "admin";
  return role === "admin" || role === "member";
}

function mediaType(header: string | undefined): string {
  return (header ?? "").split(";")[0]!.trim().toLowerCase();
}

const routeLists = new WeakMap<FastifyInstance, { method: string; url: string }[]>();

/** Every route registered on a server built by buildServer (method and Fastify path). */
export function registeredRoutes(app: FastifyInstance): { method: string; url: string }[] {
  return [...(routeLists.get(app) ?? [])];
}

/** Resolve a static file inside the public dir; null when missing, outside the dir or not a regular file. */
async function resolveStatic(publicDir: string, segments: string[]): Promise<string | null> {
  try {
    const root = await realpath(publicDir);
    const full = await realpath(resolve(root, ...segments));
    if (!full.startsWith(root + sep)) return null;
    if (!(await lstat(full)).isFile()) return null;
    return full;
  } catch {
    return null;
  }
}

// Exact attribute values only: the login link and any other href are never touched.
const VERSIONED_ASSETS = ["app.js", "style.css", "manifest.webmanifest", "icon.svg"];
const ASSET_REF = /\b(src|href)="\/(app\.js|style\.css|manifest\.webmanifest|icon\.svg)"/g;

/**
 * Content-based cache busting: append ?v=<first 10 hex of the SHA-256 of the file's current contents>
 * to the static asset references in the index page, so a CDN that overrides cache-control still serves
 * a new URL after a deploy. A missing or unreadable file leaves its reference untouched. Never throws.
 */
async function versionAssets(publicDir: string, page: string): Promise<string> {
  try {
    const versions = new Map<string, string>();
    for (const name of VERSIONED_ASSETS) {
      if (!page.includes(`"/${name}"`)) continue;
      const full = await resolveStatic(publicDir, [name]);
      if (full === null) continue;
      try {
        versions.set(name, createHash("sha256").update(await readFile(full)).digest("hex").slice(0, 10));
      } catch {
        // unreadable: leave the reference as is
      }
    }
    return page.replace(ASSET_REF, (match, attr: string, name: string) => {
      const v = versions.get(name);
      return v === undefined ? match : `${attr}="/${name}?v=${v}"`;
    });
  } catch {
    return page;
  }
}

async function serveStatic(publicDir: string, rest: string, reply: FastifyReply): Promise<FastifyReply> {
  const rel = rest === "" ? STATIC_INDEX : rest;
  const segments = rel.split("/");
  const type = STATIC_TYPES[extname(rel).toLowerCase()];
  if (type === undefined || !segments.every((s) => STATIC_SEGMENT.test(s))) {
    return sendError(reply, 404, "not_found", "not found");
  }
  try {
    const full = await resolveStatic(publicDir, segments);
    if (full === null) return sendError(reply, 404, "not_found", "not found");
    let body: Buffer | string = await readFile(full);
    if (rel === STATIC_INDEX) body = await versionAssets(publicDir, body.toString("utf8"));
    return reply.code(200).header("cache-control", "no-cache").type(type).send(body);
  } catch {
    return sendError(reply, 404, "not_found", "not found");
  }
}

function intCfg(cfg: AppsConfig, key: string, env: string): number {
  const v = cfg[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new Error(`${env} must be a positive integer`);
  return v;
}

/** Node/Fastify socket timeouts from config (Fastify 5's defaults are effectively unlimited). */
export function serverTimeouts(cfg: AppsConfig): { requestTimeout: number; connectionTimeout: number; keepAliveTimeout: number } {
  return {
    requestTimeout: intCfg(cfg, "webRequestTimeoutS", "WEB_REQUEST_TIMEOUT_S") * 1000,
    connectionTimeout: intCfg(cfg, "webConnectionTimeoutS", "WEB_CONNECTION_TIMEOUT_S") * 1000,
    keepAliveTimeout: intCfg(cfg, "webKeepaliveTimeoutS", "WEB_KEEPALIVE_TIMEOUT_S") * 1000,
  };
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const log = deps.log ?? (() => undefined);
  const app = Fastify({
    logger: false,
    bodyLimit: intCfg(deps.cfg, "webBodyLimitBytes", "WEB_BODY_LIMIT_BYTES"),
    ...serverTimeouts(deps.cfg),
    exposeHeadRoutes: false,
    return503OnClosing: true,
    // Strict validation: no coercion, no silent removal of unknown properties, no defaults.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false, allErrors: false } },
  });
  const routes: { method: string; url: string }[] = [];
  routeLists.set(app, routes);
  app.addHook("onRoute", (opts) => {
    for (const method of [opts.method].flat()) routes.push({ method: String(method).toUpperCase(), url: opts.url });
  });

  // Only JSON bodies are accepted; drop Fastify's default text/plain parser.
  app.removeContentTypeParser("text/plain");
  app.decorateRequest("identity", null);
  app.decorateRequest("role", "none");

  const publicOrigin = parsePublicUrl(typeof deps.cfg["webPublicUrl"] === "string" ? deps.cfg["webPublicUrl"] : "")?.origin ?? "";

  app.addHook("onRequest", async (req, reply) => {
    const access = accessFor(req);
    if (access !== "public") {
      const identity = await deps.auth.identify(req.headers);
      if (identity === null) return sendError(reply, 401, "unauthenticated", "sign-in required");
      const role = deps.auth.role(identity);
      if (!allowed(role, access)) return sendError(reply, 403, "forbidden", "your account may not do this");
      req.identity = identity;
      req.role = role;
    }
    if (!SAFE_METHODS.has(req.method)) {
      if (!sameOrigin(req.headers, publicOrigin)) return sendError(reply, 403, "csrf", "cross-site requests are refused");
      if (mediaType(req.headers["content-type"]) !== JSON_TYPE) {
        return sendError(reply, 415, "unsupported_media_type", "Content-Type must be application/json");
      }
    }
    return undefined;
  });

  app.addHook("onSend", async (req, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    if (isApiRequest(req) || isAuthRequest(req)) reply.header("cache-control", "no-store");
    else if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
    if (typeof payload !== "string") return payload;
    // Defense in depth: a configured secret must never leave in a body, whatever produced it.
    let out = payload;
    const token = (await deps.registry.active().catch(() => null))?.agent_token ?? "";
    for (const secret of [...deps.secrets(), token]) {
      if (secret.length >= MIN_SECRET_LENGTH && out.includes(secret)) {
        log("error", "a response contained a secret value; it was redacted");
        out = out.split(secret).join("[redacted]");
      }
    }
    return out;
  });

  app.addHook("onResponse", async (req, reply) => {
    log("info", `${req.method} ${req.routeOptions.url ?? "(unmatched)"} ${reply.statusCode}`);
  });

  app.setErrorHandler((err: { validation?: unknown; statusCode?: number; name?: string }, _req, reply) => {
    if (err.validation) return sendError(reply, 400, "invalid_body", "the request does not match the expected shape");
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    if (status === 413) return sendError(reply, 413, "body_too_large", "request body is too large");
    if (status === 415) return sendError(reply, 415, "unsupported_media_type", "Content-Type must be application/json");
    if (status >= 400 && status < 500) return sendError(reply, 400, "invalid_json", "request body is not valid JSON");
    log("error", `unhandled error: ${err.name ?? "Error"}`);
    return sendError(reply, 500, "internal_error", "internal error");
  });

  app.setNotFoundHandler((_req, reply) => sendError(reply, 404, "not_found", "not found"));

  app.get("/healthz", { config: { access: "public" } }, async () => ({ ok: true }));

  registerAuthRoutes(app, { cfg: deps.cfg, login: deps.login, log });
  registerApiRoutes(app, deps);

  app.get("/*", { config: { access: "public" } }, async (req, reply) => {
    const rest = (req.params as { "*"?: string })["*"] ?? "";
    if (isApiPath(`/${rest}`)) return sendError(reply, 404, "not_found", "not found");
    return serveStatic(deps.publicDir, rest, reply);
  });

  return app;
}
