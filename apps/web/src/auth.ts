import { jwtVerify, errors, type JWTVerifyGetKey } from "jose";
import type { AppsConfig } from "@vast-comfy/core";

/** Header the Authentik proxy outpost uses to forward the signed identity token (protocol constant). */
const JWT_HEADER = "x-authentik-jwt"; // config-lint: ok (header name defined by the Authentik outpost protocol)

/**
 * Only asymmetric algorithms are accepted, and the list is pinned. This rules out `none`, and rules out
 * HS* (a symmetric alg could be forged by using the public key text as the HMAC secret). Authentik signs
 * with RS256 by default; ES256 is allowed for deployments that use an EC signing key.
 */
const ALLOWED_ALGORITHMS = ["RS256", "ES256"];

export type RejectReason = "unconfigured" | "missing" | "ambiguous" | "expired" | "claims" | "invalid" | "no_subject";

export type Role = "admin" | "member" | "none";

export interface Identity {
  readonly subject: string;
  readonly username: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly groups: readonly string[];
}

export type HeaderBag = Record<string, string | string[] | undefined>;

export interface AuthOptions {
  /** Called with a coarse reason code only; never receives the token, its claims or any error message. */
  onReject?: (reason: RejectReason) => void;
  /** Called once at construction when the configuration leaves auth fail-closed. Defaults to console.error. */
  onMisconfigured?: (message: string) => void;
}

export interface Auth {
  /** True when issuer, audience and JWKS URL are all configured; false means every identify() returns null. */
  readonly configured: boolean;
  identify(headers: HeaderBag): Promise<Identity | null>;
  role(identity: Identity): Role;
}

const REQUIRED_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["authentikJwksUrl", "AUTHENTIK_JWKS_URL"],
  ["authentikIssuer", "AUTHENTIK_ISSUER"],
  ["authentikAudience", "AUTHENTIK_AUDIENCE"],
];

function str(cfg: AppsConfig, key: string): string {
  const value = cfg[key];
  return typeof value === "string" ? value : "";
}

/** The single value of the JWT header (case-insensitive), "missing" when absent, "ambiguous" when repeated. */
function readToken(headers: HeaderBag): string | "missing" | "ambiguous" {
  const found: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== JWT_HEADER || value === undefined) continue;
    if (Array.isArray(value)) found.push(...value);
    else found.push(value);
  }
  if (found.length === 0) return "missing";
  const only = found[0];
  if (found.length > 1 || only === undefined) return "ambiguous";
  const token = only.trim();
  return token === "" ? "missing" : token;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function reasonFor(error: unknown): RejectReason {
  if (error instanceof errors.JWTExpired) return "expired";
  if (error instanceof errors.JWTClaimValidationFailed) return "claims";
  return "invalid";
}

export function createAuth(cfg: AppsConfig, jwksResolver: JWTVerifyGetKey, options: AuthOptions = {}): Auth {
  const issuer = str(cfg, "authentikIssuer");
  const audience = str(cfg, "authentikAudience");
  const adminGroup = str(cfg, "webAdminGroup");
  const memberGroup = str(cfg, "webMemberGroup");
  const missing = REQUIRED_KEYS.filter(([key]) => str(cfg, key) === "").map(([, env]) => env);
  const configured = missing.length === 0;
  const reject = (reason: RejectReason): null => {
    try {
      options.onReject?.(reason);
    } catch {
      // a failing logger must never turn a rejection into an error or an acceptance
    }
    return null;
  };

  if (!configured) {
    const message = `auth is FAIL-CLOSED: ${missing.join(", ")} not configured; every request will be treated as unauthenticated`;
    (options.onMisconfigured ?? ((m: string) => console.error(m)))(message);
  }

  async function identify(headers: HeaderBag): Promise<Identity | null> {
    if (!configured) return reject("unconfigured");
    const token = readToken(headers);
    if (token === "missing" || token === "ambiguous") return reject(token);
    let claims;
    try {
      ({ payload: claims } = await jwtVerify(token, jwksResolver, {
        issuer,
        audience,
        algorithms: ALLOWED_ALGORITHMS,
        requiredClaims: ["exp", "sub"],
      }));
    } catch (error) {
      return reject(reasonFor(error));
    }
    const subject = optionalString(claims.sub);
    if (subject === null) return reject("no_subject");
    const rawGroups: unknown = claims["groups"];
    const groups = Array.isArray(rawGroups) ? rawGroups.filter((g): g is string => typeof g === "string") : [];
    return Object.freeze({
      subject,
      username: optionalString(claims["preferred_username"]) ?? subject,
      email: optionalString(claims["email"]),
      name: optionalString(claims["name"]),
      groups: Object.freeze(groups),
    });
  }

  function role(identity: Identity): Role {
    // Exact, case-sensitive equality; an unconfigured (empty) group name never matches anything.
    if (adminGroup !== "" && identity.groups.includes(adminGroup)) return "admin";
    if (memberGroup !== "" && identity.groups.includes(memberGroup)) return "member";
    return "none";
  }

  return { configured, identify, role };
}
