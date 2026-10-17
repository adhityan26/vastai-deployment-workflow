import { createHmac } from "node:crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { sanitizeNext, type LoginTransaction, type OidcIdentity } from "./oidc.js";

// Signed cookies (HS256 JWTs) for the login session and for the short-lived login transaction.
// Each kind has its own key derived from WEB_SESSION_SECRET and its own `typ`, so one can never be
// replayed as the other. A tampered, expired, wrong-signature, ambiguous or malformed cookie reads
// as anonymous (null); reading never throws.

/** Base cookie names (protocol constants of this app, not configuration). */
export const SESSION_COOKIE = "vc_session";
export const TRANSACTION_COOKIE = "vc_login";
/**
 * With Secure cookies the names carry the `__Host-` prefix: browsers then only accept the cookie when
 * it is Secure, Path=/ and has no Domain, so a sibling subdomain cannot plant ("toss") one for us.
 * The plain names are used only for plain-http localhost development, where `__Host-` cannot work.
 */
const HOST_PREFIX = "__Host-";

export interface CookieNames {
  readonly session: string;
  readonly transaction: string;
}

/** The cookie names for a mode; a reader looks only for these and ignores the other mode's names. */
export function cookieNames(secure: boolean): CookieNames {
  const prefix = secure ? HOST_PREFIX : "";
  return Object.freeze({ session: `${prefix}${SESSION_COOKIE}`, transaction: `${prefix}${TRANSACTION_COOKIE}` });
}
/** The login transaction (state, nonce, PKCE verifier, return path) lives at most 10 minutes. */
export const TRANSACTION_TTL_S = 600;
const MIN_SECRET_BYTES = 32;
/** Browsers drop cookies above ~4096 bytes; refuse to issue one that would silently vanish. */
const MAX_COOKIE_VALUE = 3800;
const ALGORITHMS = ["HS256"];
const SESSION_TYP = "vc-session+jwt";
const TRANSACTION_TYP = "vc-login+jwt";
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export type SessionIdentity = OidcIdentity;

export interface SessionOptions {
  /** Secure cookies with `__Host-` names (default); false only for a plain-http localhost public URL. */
  secure?: boolean;
  /** Milliseconds since the epoch; injectable for tests. */
  now?: () => number;
}

export interface Sessions {
  /** Cookie names in use (they depend on the Secure mode). */
  readonly names: CookieNames;
  /** Signed session cookie value carrying only sub, username, name, email, groups, iat and exp. */
  issue(identity: SessionIdentity): Promise<string>;
  read(cookieHeader: string | undefined): Promise<SessionIdentity | null>;
  /** Set-Cookie header value for a session cookie. */
  serialize(value: string): string;
  /** Set-Cookie header value that removes the session cookie. */
  clear(): string;
  issueTransaction(tx: LoginTransaction): Promise<string>;
  readTransaction(cookieHeader: string | undefined): Promise<LoginTransaction | null>;
  serializeTransaction(value: string): string;
  clearTransaction(): string;
}

/** Every value of cookie `name` in a Cookie header (several means ambiguity, which callers reject). */
export function cookieValues(header: string | undefined, name: string): string[] {
  if (typeof header !== "string" || header === "") return [];
  const out: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) out.push(part.slice(eq + 1).trim());
  }
  return out;
}

function single(header: string | undefined, name: string): string | null {
  const values = cookieValues(header, name);
  if (values.length !== 1) return null;
  const value = values[0] ?? "";
  return value.length <= MAX_COOKIE_VALUE && JWT_SHAPE.test(value) ? value : null;
}

function cookie(name: string, value: string, maxAge: number, secure: boolean): string {
  // Only values this module signed (or "" to clear) may be written; no header injection via the value.
  if (value !== "" && !JWT_SHAPE.test(value)) throw new Error("refusing to serialize a cookie value that is not a signed token");
  // Never a Domain attribute: the cookie stays host-only (required by the __Host- prefix).
  const parts = [`${name}=${value}`, "Path=/", `Max-Age=${maxAge}`, "HttpOnly", "SameSite=Lax"];
  if (maxAge === 0) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** Set-Cookie values that remove both cookies of a mode; needs no secret (used by logout). */
export function clearCookies(secure: boolean): { session: string; transaction: string } {
  const names = cookieNames(secure);
  return { session: cookie(names.session, "", 0, secure), transaction: cookie(names.transaction, "", 0, secure) };
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

export function createSessions(secret: string, ttlHours: number, options: SessionOptions = {}): Sessions {
  const secure = options.secure ?? true;
  const now = options.now ?? Date.now;
  const names = cookieNames(secure);
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) {
    throw new Error(`WEB_SESSION_SECRET must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  if (!Number.isInteger(ttlHours) || ttlHours <= 0) throw new Error("WEB_SESSION_TTL_H must be a positive integer");
  const ttlS = ttlHours * 3600;
  // Domain separation: one HMAC key per cookie kind, derived from the configured secret.
  const derive = (label: string) => new Uint8Array(createHmac("sha256", secret).update(label).digest());
  const sessionKey = derive("vast-comfy session cookie v1");
  const transactionKey = derive("vast-comfy login transaction cookie v1");
  const seconds = () => Math.floor(now() / 1000);

  async function sign(claims: JWTPayload, typ: string, key: Uint8Array, lifetimeS: number): Promise<string> {
    const iat = seconds();
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", typ })
      .setIssuedAt(iat)
      .setExpirationTime(iat + lifetimeS)
      .sign(key);
    if (token.length > MAX_COOKIE_VALUE) throw new Error("signed cookie value is too large");
    return token;
  }

  async function verify(header: string | undefined, name: string, typ: string, key: Uint8Array): Promise<JWTPayload | null> {
    const token = single(header, name);
    if (token === null) return null;
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ALGORITHMS,
        typ,
        requiredClaims: ["iat", "exp"],
        currentDate: new Date(now()),
      });
      return payload;
    } catch {
      return null;
    }
  }

  async function issue(identity: SessionIdentity): Promise<string> {
    if (!nonEmpty(identity.subject)) throw new Error("a session needs a subject");
    return sign(
      {
        sub: identity.subject,
        username: identity.username,
        name: identity.name,
        email: identity.email,
        groups: [...identity.groups],
      },
      SESSION_TYP,
      sessionKey,
      ttlS,
    );
  }

  async function read(cookieHeader: string | undefined): Promise<SessionIdentity | null> {
    const claims = await verify(cookieHeader, names.session, SESSION_TYP, sessionKey);
    if (claims === null) return null;
    const name = nullableString(claims["name"]);
    const email = nullableString(claims["email"]);
    const groups: unknown = claims["groups"];
    if (!nonEmpty(claims.sub) || !nonEmpty(claims["username"]) || name === undefined || email === undefined) return null;
    if (!Array.isArray(groups) || !groups.every((g) => typeof g === "string")) return null;
    return Object.freeze({
      subject: claims.sub,
      username: claims["username"],
      name,
      email,
      groups: Object.freeze([...(groups as string[])]),
    });
  }

  async function issueTransaction(tx: LoginTransaction): Promise<string> {
    return sign(
      { state: tx.state, nonce: tx.nonce, verifier: tx.verifier, next: sanitizeNext(tx.next) },
      TRANSACTION_TYP,
      transactionKey,
      TRANSACTION_TTL_S,
    );
  }

  async function readTransaction(cookieHeader: string | undefined): Promise<LoginTransaction | null> {
    const claims = await verify(cookieHeader, names.transaction, TRANSACTION_TYP, transactionKey);
    if (claims === null) return null;
    const { state, nonce, verifier, next } = claims as Record<string, unknown>;
    if (!nonEmpty(state) || !nonEmpty(nonce) || !nonEmpty(verifier)) return null;
    return Object.freeze({ state, nonce, verifier, next: sanitizeNext(next) });
  }

  return {
    names,
    issue,
    read,
    serialize: (value) => cookie(names.session, value, ttlS, secure),
    clear: () => cookie(names.session, "", 0, secure),
    issueTransaction,
    readTransaction,
    serializeTransaction: (value) => cookie(names.transaction, value, TRANSACTION_TTL_S, secure),
    clearTransaction: () => cookie(names.transaction, "", 0, secure),
  };
}
