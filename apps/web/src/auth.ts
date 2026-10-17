import type { AppsConfig } from "@vast-comfy/core";
import { createOidc, parsePublicUrl, type Oidc, type OidcDeps } from "./oidc.js";
import { createSessions, type Sessions } from "./session.js";

// Identity of a request = a valid signed session cookie (set by /auth/callback after an OIDC login
// at Authentik). Anything else, including any identity header a client sends, is anonymous. Auth is
// fail-closed: without a complete OIDC configuration AND a usable session secret, every identify()
// returns null.

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
  /** Called once at construction when the configuration leaves auth fail-closed. Defaults to console.error. */
  onMisconfigured?: (message: string) => void;
}

export interface AuthDeps {
  /** null when WEB_SESSION_SECRET is missing or too short (createSessions refused it). */
  sessions: Pick<Sessions, "read"> | null;
  oidc: Pick<Oidc, "configured">;
}

export interface Auth {
  /** True only when OIDC is fully configured and the session secret is valid; false means every identify() returns null. */
  readonly configured: boolean;
  identify(headers: HeaderBag): Promise<Identity | null>;
  role(identity: Identity): Role;
}

function str(cfg: AppsConfig, key: string): string {
  const value = cfg[key];
  return typeof value === "string" ? value : "";
}

function int(cfg: AppsConfig, key: string): number {
  const value = cfg[key];
  return typeof value === "number" ? value : 0;
}

function groupNames(cfg: AppsConfig): { admin: string; member: string } {
  return { admin: str(cfg, "webAdminGroup"), member: str(cfg, "webMemberGroup") };
}

/** Role of a group list: admin wins, then member; exact, case-sensitive; an empty configured name never matches. */
export function roleOf(cfg: AppsConfig, groups: readonly string[]): Role {
  const { admin, member } = groupNames(cfg);
  if (admin !== "" && groups.includes(admin)) return "admin";
  if (member !== "" && groups.includes(member)) return "member";
  return "none";
}

/**
 * Only the groups that map to a role (WEB_ADMIN_GROUP / WEB_MEMBER_GROUP). The session cookie stores
 * just these, which keeps it small however many groups the account has, and changes no role.
 */
export function roleGroups(cfg: AppsConfig, groups: readonly string[]): string[] {
  const { admin, member } = groupNames(cfg);
  const wanted = [admin, member].filter((g) => g !== "");
  return [...new Set(groups.filter((g) => wanted.includes(g)))];
}

/** Names (never values) of the keys that leave auth fail-closed. */
function problems(cfg: AppsConfig, deps: AuthDeps): string[] {
  const out: string[] = [];
  const keys: Array<[string, string]> = [
    ["authentikIssuer", "AUTHENTIK_ISSUER"],
    ["authentikClientId", "AUTHENTIK_CLIENT_ID"],
    ["authentikClientSecret", "AUTHENTIK_CLIENT_SECRET"],
    ["webPublicUrl", "WEB_PUBLIC_URL"],
  ];
  for (const [key, env] of keys) if (str(cfg, key) === "") out.push(`${env} is empty`);
  if (str(cfg, "webPublicUrl") !== "" && parsePublicUrl(str(cfg, "webPublicUrl")) === null) {
    out.push("WEB_PUBLIC_URL is not a bare https origin (or http on localhost)");
  }
  if (out.length === 0 && !deps.oidc.configured) out.push("the OIDC settings are invalid (check AUTHENTIK_ISSUER)");
  if (deps.sessions === null) {
    out.push(str(cfg, "webSessionSecret") === "" ? "WEB_SESSION_SECRET is empty" : "WEB_SESSION_SECRET is unusable (at least 32 bytes)");
  }
  return out;
}

function cookieHeader(headers: HeaderBag): string | undefined {
  const raw = headers["cookie"];
  if (Array.isArray(raw)) return raw.join("; ");
  return raw;
}

export function createAuth(cfg: AppsConfig, deps: AuthDeps, options: AuthOptions = {}): Auth {
  const sessions = deps.sessions;
  const configured = deps.oidc.configured && sessions !== null;

  if (!configured) {
    const message =
      `auth is FAIL-CLOSED: ${problems(cfg, deps).join("; ")}; ` +
      "every /api request will be answered 401 and /auth/login 503";
    (options.onMisconfigured ?? ((m: string) => console.error(m)))(message);
  }

  async function identify(headers: HeaderBag): Promise<Identity | null> {
    if (!configured || sessions === null) return null;
    try {
      return await sessions.read(cookieHeader(headers));
    } catch {
      return null; // reading never throws, but a failure must never become an identity
    }
  }

  return { configured, identify, role: (identity) => roleOf(cfg, identity.groups) };
}

/** Everything main.ts (and the route tests) need for login: one wiring, so tests exercise the real one. */
export interface AuthStack {
  auth: Auth;
  oidc: Oidc;
  sessions: Sessions | null;
}

export function createAuthStack(cfg: AppsConfig, options: AuthOptions & { oidc?: OidcDeps; now?: () => number } = {}): AuthStack {
  const oidc = createOidc(cfg, options.oidc ?? {});
  let sessions: Sessions | null = null;
  try {
    sessions = createSessions(str(cfg, "webSessionSecret"), int(cfg, "webSessionTtlH"), {
      secure: oidc.secureCookies,
      ...(options.now ? { now: options.now } : {}),
    });
  } catch {
    sessions = null; // reported (by key name only) through onMisconfigured below
  }
  const auth = createAuth(cfg, { sessions, oidc }, options.onMisconfigured ? { onMisconfigured: options.onMisconfigured } : {});
  return { auth, oidc, sessions };
}
