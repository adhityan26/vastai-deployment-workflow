import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppsConfig } from "@vast-comfy/core";
import { createAuth, createAuthStack, roleGroups } from "../src/auth.js";
import { SESSION_COOKIE, cookieNames, createSessions } from "../src/session.js";
import type { OidcIdentity } from "../src/oidc.js";
import { CLIENT_ID, CLIENT_SECRET, startFakeIdp, type FakeIdp } from "./fake-idp.js";

// Auth = a valid signed session cookie. These tests use real sessions; the login flow that issues
// them is covered end to end in routes.test.ts.

const SECRET = "test-session-secret-0123456789abcdef";
const ADMIN = "authentik Admins";
const MEMBER = "member";
const NAMES = cookieNames(true);

let idp: FakeIdp;
beforeAll(async () => {
  idp = await startFakeIdp();
});
afterAll(async () => {
  await idp.close();
});

function config(over: Record<string, unknown> = {}): AppsConfig {
  return {
    authentikIssuer: idp.issuer,
    authentikClientId: CLIENT_ID,
    authentikClientSecret: CLIENT_SECRET,
    webPublicUrl: "https://comfy.example.test",
    webSessionSecret: SECRET,
    webSessionTtlH: 8,
    webOidcSkewS: 0,
    httpTimeoutSApps: 5,
    webJsonMaxBytes: 65536,
    webAdminGroup: ADMIN,
    webMemberGroup: MEMBER,
    secretNames: ["AUTHENTIK_CLIENT_SECRET", "WEB_SESSION_SECRET"],
    ...over,
  } as unknown as AppsConfig;
}

const identity = (groups: string[] = [MEMBER], over: Partial<OidcIdentity> = {}): OidcIdentity => ({
  subject: "user-1",
  username: "ayu",
  name: "Ayu",
  email: "ayu@example.test",
  groups,
  ...over,
});

function stack(cfg = config()) {
  const warnings: string[] = [];
  const s = createAuthStack(cfg, { onMisconfigured: (m) => warnings.push(m) });
  return { ...s, warnings };
}

async function cookieFor(groups: string[]): Promise<string> {
  const value = await createSessions(SECRET, 8).issue(identity(groups));
  return `${NAMES.session}=${value}`;
}

describe("identify", () => {
  it("reads the identity from a valid session cookie", async () => {
    const { auth, warnings } = stack();
    expect(auth.configured).toBe(true);
    expect(warnings).toEqual([]);
    const id = await auth.identify({ cookie: `theme=dark; ${await cookieFor([MEMBER])}` });
    expect(id).toEqual(identity([MEMBER]));
  });

  it("anonymous without a cookie, with garbage, a tampered or a foreign-secret cookie", async () => {
    const { auth } = stack();
    const good = (await cookieFor([MEMBER])).split("=")[1]!;
    const [h, p, sig] = good.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, "base64url").toString()), groups: [ADMIN] })).toString("base64url");
    const foreign = await createSessions("another-secret-0123456789abcdefghij", 8).issue(identity([ADMIN]));
    for (const cookie of [undefined, "", "garbage", `${NAMES.session}=`, `${NAMES.session}=${h}.${forgedPayload}.${sig}`, `${NAMES.session}=${foreign}`]) {
      expect(await auth.identify(cookie === undefined ? {} : { cookie })).toBeNull();
    }
  });

  it("ignores identity headers entirely (the old X-authentik-jwt path is gone)", async () => {
    const { auth } = stack();
    const jwt = await idp.mint({ claims: { groups: [ADMIN] } });
    expect(
      await auth.identify({ "x-authentik-jwt": jwt, "x-authentik-username": "root", "x-authentik-groups": ADMIN, authorization: `Bearer ${jwt}` }),
    ).toBeNull();
  });

  it("ignores a plain-name cookie in secure mode (cookie tossing from a sibling subdomain)", async () => {
    const { auth } = stack();
    const value = await createSessions(SECRET, 8, { secure: false }).issue(identity([ADMIN]));
    expect(await auth.identify({ cookie: `${SESSION_COOKIE}=${value}` })).toBeNull();
  });

  it("uses the plain name for an http://localhost public URL", async () => {
    const { auth, sessions } = stack(config({ webPublicUrl: "http://localhost:3000" }));
    expect(sessions?.names.session).toBe(SESSION_COOKIE);
    const value = await sessions!.issue(identity([MEMBER]));
    expect(await auth.identify({ cookie: `${SESSION_COOKIE}=${value}` })).not.toBeNull();
    expect(await auth.identify({ cookie: `${NAMES.session}=${value}` })).toBeNull();
  });

  it("an array cookie header is joined; two session cookies are ambiguous and anonymous", async () => {
    const { auth } = stack();
    const a = await cookieFor([MEMBER]);
    expect(await auth.identify({ cookie: ["theme=dark", a] })).not.toBeNull();
    expect(await auth.identify({ cookie: [a, await cookieFor([ADMIN])] })).toBeNull();
  });
});

describe("role", () => {
  const roleOf = (groups: string[], cfg = config()) => stack(cfg).auth.role(identity(groups));

  it("maps admin, member, other and both", () => {
    expect(roleOf([ADMIN])).toBe("admin");
    expect(roleOf([MEMBER])).toBe("member");
    expect(roleOf(["staff"])).toBe("none");
    expect(roleOf([MEMBER, ADMIN])).toBe("admin");
    expect(roleOf([])).toBe("none");
  });

  it("matches group names exactly, case-sensitively", () => {
    for (const variant of ["Authentik Admins", "authentik Admins2", "xauthentik Admins", "authentik  Admins", "Member", "members"]) {
      expect(roleOf([variant])).toBe("none");
    }
  });

  it("honours configured group names and never matches an empty one", () => {
    expect(roleOf(["ops"], config({ webAdminGroup: "ops" }))).toBe("admin");
    expect(roleOf([""], config({ webAdminGroup: "", webMemberGroup: "" }))).toBe("none");
  });

  it("roleGroups keeps only the groups that map to a role", () => {
    expect(roleGroups(config(), ["staff", MEMBER, "x".repeat(500), ADMIN, MEMBER])).toEqual([MEMBER, ADMIN]);
    expect(roleGroups(config(), ["staff"])).toEqual([]);
    expect(roleGroups(config({ webAdminGroup: "", webMemberGroup: "" }), ["", MEMBER])).toEqual([]);
  });
});

describe("fail closed", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["AUTHENTIK_ISSUER empty", { authentikIssuer: "" }, /AUTHENTIK_ISSUER/],
    ["AUTHENTIK_CLIENT_ID empty", { authentikClientId: "" }, /AUTHENTIK_CLIENT_ID/],
    ["AUTHENTIK_CLIENT_SECRET empty", { authentikClientSecret: "" }, /AUTHENTIK_CLIENT_SECRET/],
    ["WEB_PUBLIC_URL empty", { webPublicUrl: "" }, /WEB_PUBLIC_URL/],
    ["WEB_PUBLIC_URL plain http", { webPublicUrl: "http://comfy.example.test" }, /WEB_PUBLIC_URL/],
    ["AUTHENTIK_ISSUER plain http", { authentikIssuer: "http://sso.example.test/application/o/vast/" }, /AUTHENTIK_ISSUER/],
    ["WEB_SESSION_SECRET empty", { webSessionSecret: "" }, /WEB_SESSION_SECRET/],
    ["WEB_SESSION_SECRET too short", { webSessionSecret: "short-secret-31-bytes-xxxxxxxxx" }, /WEB_SESSION_SECRET/],
  ];
  for (const [label, over, pattern] of cases) {
    it(`denies everything and warns loudly once when ${label}`, async () => {
      const { auth, warnings } = stack(config(over));
      expect(auth.configured).toBe(false);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/FAIL-CLOSED/);
      expect(warnings[0]).toMatch(pattern);
      // A cookie that would be valid under the configured secret still identifies nobody.
      expect(await auth.identify({ cookie: await cookieFor([ADMIN]) })).toBeNull();
      for (const value of [CLIENT_SECRET, SECRET, "short-secret-31-bytes-xxxxxxxxx"]) expect(warnings[0]).not.toContain(value);
    });
  }

  it("requires both: configured OIDC and a sessions object", async () => {
    const sessions = createSessions(SECRET, 8);
    const quiet = { onMisconfigured: () => undefined };
    expect(createAuth(config(), { sessions, oidc: { configured: true } }, quiet).configured).toBe(true);
    expect(createAuth(config(), { sessions: null, oidc: { configured: true } }, quiet).configured).toBe(false);
    const noOidc = createAuth(config(), { sessions, oidc: { configured: false } }, quiet);
    expect(noOidc.configured).toBe(false);
    expect(await noOidc.identify({ cookie: await cookieFor([ADMIN]) })).toBeNull();
  });

  it("a throwing session reader is anonymous, never an error or an identity", async () => {
    const auth = createAuth(config(), { sessions: { read: async () => { throw new Error("boom"); } }, oidc: { configured: true } });
    expect(await auth.identify({ cookie: "x=1" })).toBeNull();
  });
});

describe("secrecy", () => {
  it("never writes the cookie, the secrets or claims to the console", async () => {
    const seen: string[] = [];
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) => {
      const original = console[m];
      console[m] = (...args: unknown[]) => void seen.push(args.map(String).join(" "));
      return () => (console[m] = original);
    });
    try {
      const cookie = await cookieFor([ADMIN]);
      const { auth } = createAuthStack(config());
      await auth.identify({ cookie });
      await auth.identify({ cookie: cookie.slice(0, 40) });
      createAuthStack(config({ webSessionSecret: "too-short-secret" }));
      const dump = seen.join("\n");
      expect(dump).not.toContain(cookie.split("=")[1]!);
      expect(dump).not.toContain(SECRET);
      expect(dump).not.toContain("too-short-secret");
      expect(dump).not.toContain(CLIENT_SECRET);
      expect(dump).not.toContain("ayu@example.test");
    } finally {
      spies.forEach((restore) => restore());
    }
  });
});
