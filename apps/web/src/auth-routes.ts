import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppsConfig } from "@vast-comfy/core";
import { roleGroups, roleOf } from "./auth.js";
import { CALLBACK_PATH, OidcError, type Oidc, type OidcErrorCode } from "./oidc.js";
import { clearCookies, type Sessions } from "./session.js";
import { sendError } from "./reply.js";

// The login routes: /auth/login starts an authorization code flow at Authentik, /auth/callback
// finishes it and sets the session cookie, /auth/logout removes it. They are public (no identity
// needed). Failures never show provider text: the browser is sent to /?login_error=<code> with a
// code from LOGIN_ERROR_CODES, and only that coarse code is logged.

/** Every value /auth/callback may put in `login_error` (also documented in contracts/web.openapi.json). */
export const LOGIN_ERROR_CODES = [
  "access_denied",
  "state_mismatch",
  "provider_error",
  "exchange_failed",
  "token_invalid",
  "nonce_mismatch",
  "no_subject",
  "session_too_large",
  "failed",
] as const;
export type LoginErrorCode = (typeof LOGIN_ERROR_CODES)[number];

/** Protocol paths of the login routes (the callback path, CALLBACK_PATH, is also the redirect_uri path). */
export const LOGIN_PATH = "/auth/login";
export const LOGOUT_PATH = "/auth/logout";
const ERROR_LANDING = "/?login_error=";
/** The OAuth error value Authentik sends when the user may not use the application. */
const PROVIDER_ACCESS_DENIED = "access_denied";

export interface LoginDeps {
  /** auth.configured: OIDC complete and a usable session secret. */
  configured: boolean;
  oidc: Pick<Oidc, "begin" | "finish" | "secureCookies">;
  sessions: Pick<Sessions, "issue" | "serialize" | "issueTransaction" | "readTransaction" | "serializeTransaction" | "clearTransaction"> | null;
}

export interface AuthRouteDeps {
  cfg: AppsConfig;
  login?: LoginDeps | undefined;
  log(level: "info" | "warn" | "error", message: string): void;
}

const EMPTY_BODY = { type: "object", additionalProperties: false, properties: {} } as const;

/** A single string query parameter; a repeated or missing one is undefined. */
function param(req: FastifyRequest, name: string): string | undefined {
  const value = (req.query as Record<string, unknown> | undefined)?.[name];
  return typeof value === "string" ? value : undefined;
}

function callbackCode(err: unknown, providerError: string | undefined): LoginErrorCode {
  if (!(err instanceof OidcError)) return "failed";
  const code: OidcErrorCode = err.code;
  switch (code) {
    case "provider_error":
      return providerError === PROVIDER_ACCESS_DENIED ? "access_denied" : "provider_error";
    case "discovery_failed":
      return "provider_error";
    case "state_mismatch":
    case "exchange_failed":
    case "token_invalid":
    case "nonce_mismatch":
    case "no_subject":
      return code;
    default:
      return "failed";
  }
}

/**
 * The internal reason for the server log: the OidcError code (a fixed identifier such as
 * discovery_failed or token_invalid), or "unexpected". Never provider text, tokens, codes or secrets.
 */
function internalReason(err: unknown): string {
  return err instanceof OidcError ? err.code : "unexpected";
}

/** One coarse log line: the allowlisted code, plus the internal reason when it says more. */
function failureLine(code: LoginErrorCode, internal: string | undefined): string {
  return internal === undefined || internal === code ? `login failed: ${code}` : `login failed: ${code} (internal: ${internal})`;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const pub = { config: { access: "public" as const } };
  const ready = (): { oidc: LoginDeps["oidc"]; sessions: NonNullable<LoginDeps["sessions"]> } | null => {
    const login = deps.login;
    if (login === undefined || !login.configured || login.sessions === null) return null;
    return { oidc: login.oidc, sessions: login.sessions };
  };
  const notConfigured = (reply: FastifyReply) =>
    sendError(reply, 503, "auth_not_configured", "login is not configured on this server");

  app.get(LOGIN_PATH, pub, async (req, reply) => {
    const r = ready();
    if (r === null) return notConfigured(reply);
    let target: string;
    let cookie: string;
    try {
      const { redirectUrl, transaction } = await r.oidc.begin(param(req, "next") ?? "/");
      cookie = r.sessions.serializeTransaction(await r.sessions.issueTransaction(transaction));
      target = redirectUrl;
    } catch (err) {
      const code = callbackCode(err, undefined);
      deps.log("warn", failureLine(code, internalReason(err)));
      return reply.code(302).header("location", `${ERROR_LANDING}${code}`).header("set-cookie", r.sessions.clearTransaction()).send();
    }
    return reply.code(302).header("location", target).header("set-cookie", cookie).send();
  });

  app.get(CALLBACK_PATH, pub, async (req, reply) => {
    const r = ready();
    if (r === null) return notConfigured(reply);
    const clearTx = r.sessions.clearTransaction();
    // Every failure: drop the transaction cookie (one attempt per login), set no session.
    const fail = (code: LoginErrorCode, internal?: string) => {
      deps.log("warn", failureLine(code, internal));
      return reply.code(302).header("location", `${ERROR_LANDING}${code}`).header("set-cookie", clearTx).send();
    };
    try {
      const tx = await r.sessions.readTransaction(req.headers.cookie);
      if (tx === null) return fail("state_mismatch", "no_valid_transaction_cookie");
      const providerError = param(req, "error");
      const code = param(req, "code");
      const state = param(req, "state");
      let identity;
      try {
        identity = await r.oidc.finish(
          { ...(code === undefined ? {} : { code }), ...(state === undefined ? {} : { state }), ...(providerError === undefined ? {} : { error: providerError }) },
          tx,
        );
      } catch (err) {
        return fail(callbackCode(err, providerError), internalReason(err));
      }
      // The session keeps only role groups. An account without a role gets no session at all.
      const groups = roleGroups(deps.cfg, identity.groups);
      if (roleOf(deps.cfg, groups) === "none") return fail("access_denied", "no_role_group");
      let session: string;
      try {
        session = r.sessions.serialize(await r.sessions.issue({ ...identity, groups }));
      } catch {
        return fail("session_too_large");
      }
      deps.log("info", "login ok");
      return reply.code(302).header("location", tx.next).header("set-cookie", [session, clearTx]).send();
    } catch {
      return fail("failed", "unexpected");
    }
  });

  // Logout needs no identity (an expired session must still be able to clear its cookie), but the
  // server gate applies the Origin/Sec-Fetch-Site rule and the JSON-only rule to it like any POST.
  app.post(LOGOUT_PATH, { ...pub, schema: { body: EMPTY_BODY } }, async (_req, reply) => {
    const secure = deps.login?.oidc.secureCookies ?? true;
    const cleared = clearCookies(secure);
    deps.log("info", "logout");
    return reply.code(204).header("set-cookie", [cleared.session, cleared.transaction]).send();
  });
}
