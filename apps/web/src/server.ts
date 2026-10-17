import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { readFile, realpath, lstat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type {
  AppsConfig,
  ComfyClient,
  InstanceRecord,
  Lifecycle,
  Profile,
} from "@vast-comfy/core";
import type { Auth, Identity, Role } from "./auth.js";
import { registerApiRoutes } from "./routes.js";
import { sendError } from "./reply.js";

// HTTP surface of the web app. Every request passes one onRequest gate: /api/* needs an
// identity from auth.identify() (401) and the route's role (403); POSTs must be JSON (415) and
// must not come from another site (403). Unknown routes are 404 with a JSON error. Responses
// carry strict security headers and never CORS headers.

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
  lifecycle: Pick<Lifecycle, "view" | "estimate" | "start" | "destroy" | "destroyUnknown" | "extend">;
  /** The active registry record; used to route job polls to the instance that ran them. */
  registry: { active(): Promise<InstanceRecord | null> };
  /** A ComfyUI client for an instance hostname (built from config; never from the request). */
  comfyFor(hostname: string): Pick<ComfyClient, "submit" | "history" | "view">;
  profile: Profile;
  /** The workflow template JSON named by the profile. */
  template: unknown;
  /** Directory of the static page (apps/web/public); may be empty or missing. */
  publicDir: string;
  /** Secret values that must never appear in a response (Vast key, Tailscale key, ...). */
  secrets(): readonly string[];
  /** Epoch milliseconds; injectable for tests. */
  now?(): number;
  /** One log line; never receives tokens, prompts or request bodies. Defaults to silence. */
  log?(level: "info" | "warn" | "error", message: string): void;
}

// Protocol constants: header values defined by the HTTP/CSP specifications.
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; " +
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
const ALLOWED_FETCH_SITES = new Set(["same-origin", "none"]);
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

/** The access a request needs. /api paths are never public, whatever route matched. */
function accessFor(req: FastifyRequest): Access {
  const declared = req.routeOptions.config?.access;
  if (isApiPath(pathOf(req))) return declared === "admin" ? "admin" : "member";
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

async function serveStatic(publicDir: string, rest: string, reply: FastifyReply): Promise<FastifyReply> {
  const rel = rest === "" ? STATIC_INDEX : rest;
  const segments = rel.split("/");
  const type = STATIC_TYPES[extname(rel).toLowerCase()];
  if (type === undefined || !segments.every((s) => STATIC_SEGMENT.test(s))) {
    return sendError(reply, 404, "not_found", "not found");
  }
  try {
    const root = await realpath(publicDir);
    const full = await realpath(resolve(root, ...segments));
    if (!full.startsWith(root + sep)) return sendError(reply, 404, "not_found", "not found");
    if (!(await lstat(full)).isFile()) return sendError(reply, 404, "not_found", "not found");
    const body = await readFile(full);
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

export function buildServer(deps: ServerDeps): FastifyInstance {
  const log = deps.log ?? (() => undefined);
  const app = Fastify({
    logger: false,
    bodyLimit: intCfg(deps.cfg, "webBodyLimitBytes", "WEB_BODY_LIMIT_BYTES"),
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
    if (req.method === "POST") {
      const site = req.headers["sec-fetch-site"];
      if (typeof site === "string" && !ALLOWED_FETCH_SITES.has(site.toLowerCase())) {
        return sendError(reply, 403, "cross_site", "cross-site requests are refused");
      }
      if (mediaType(req.headers["content-type"]) !== JSON_TYPE) {
        return sendError(reply, 415, "unsupported_media_type", "Content-Type must be application/json");
      }
    }
    return undefined;
  });

  app.addHook("onSend", async (_req, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
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

  registerApiRoutes(app, deps);

  app.get("/*", { config: { access: "public" } }, async (req, reply) => {
    const rest = (req.params as { "*"?: string })["*"] ?? "";
    if (isApiPath(`/${rest}`)) return sendError(reply, 404, "not_found", "not found");
    return serveStatic(deps.publicDir, rest, reply);
  });

  return app;
}
