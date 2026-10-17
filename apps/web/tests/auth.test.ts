import { beforeAll, describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, exportSPKI, generateKeyPair, type JWK } from "jose";
import type { AppsConfig } from "@vast-comfy/core";
import { createAuth, type RejectReason } from "../src/auth.js";

const ISSUER = "https://sso.example.test/application/o/vast/";
const AUDIENCE = "vast-web";
const KID = "k1";

let signing: CryptoKey;
let otherKey: CryptoKey;
let publicPem: string;
let resolver: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  signing = pair.privateKey;
  otherKey = other.privateKey;
  publicPem = await exportSPKI(pair.publicKey);
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  resolver = createLocalJWKSet({ keys: [jwk] });
});

function config(over: Record<string, string> = {}): AppsConfig {
  return {
    authentikJwksUrl: "https://sso.example.test/jwks/",
    authentikIssuer: ISSUER,
    authentikAudience: AUDIENCE,
    webAdminGroup: "authentik Admins",
    webMemberGroup: "member",
    secretNames: [],
    ...over,
  } as unknown as AppsConfig;
}

interface Opts {
  key?: CryptoKey;
  iss?: string;
  aud?: string;
  exp?: string | number;
  claims?: Record<string, unknown>;
  sub?: string | null;
}

async function mint(o: Opts = {}): Promise<string> {
  const jwt = new SignJWT({ preferred_username: "ayu", email: "ayu@example.test", groups: ["member"], ...(o.claims ?? {}) })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(o.iss ?? ISSUER)
    .setAudience(o.aud ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(o.exp ?? "5m");
  if (o.sub !== null) jwt.setSubject(o.sub ?? "user-1");
  return jwt.sign(o.key ?? signing);
}

function harness(cfg = config()) {
  const reasons: RejectReason[] = [];
  const warnings: string[] = [];
  const auth = createAuth(cfg, resolver, { onReject: (r) => reasons.push(r), onMisconfigured: (m) => warnings.push(m) });
  return { auth, reasons, warnings };
}

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

describe("identify", () => {
  it("accepts a valid token and reads identity from verified claims", async () => {
    const { auth } = harness();
    const id = await auth.identify({ "X-Authentik-Jwt": await mint({ claims: { name: "Ayu" } }) });
    expect(id).toMatchObject({ subject: "user-1", username: "ayu", email: "ayu@example.test", name: "Ayu", groups: ["member"] });
  });

  it("returns null for forged x-authentik headers without a jwt", async () => {
    const { auth, reasons } = harness();
    const id = await auth.identify({
      "x-authentik-username": "root",
      "x-authentik-groups": "authentik Admins",
      "x-authentik-email": "root@example.test",
    });
    expect(id).toBeNull();
    expect(reasons).toEqual(["missing"]);
  });

  it("ignores forged plain headers even when a valid jwt is present", async () => {
    const { auth } = harness();
    const id = await auth.identify({
      "x-authentik-jwt": await mint({ claims: { groups: ["member"], preferred_username: "ayu" } }),
      "x-authentik-username": "root",
      "x-authentik-groups": "authentik Admins",
    });
    expect(id?.username).toBe("ayu");
    expect(auth.role(id!)).toBe("member");
  });

  it("rejects a jwt signed by another key", async () => {
    const { auth, reasons } = harness();
    expect(await auth.identify({ "x-authentik-jwt": await mint({ key: otherKey }) })).toBeNull();
    expect(reasons).toEqual(["invalid"]);
  });

  it("rejects expired, wrong issuer and wrong audience", async () => {
    const { auth, reasons } = harness();
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect(await auth.identify({ "x-authentik-jwt": await mint({ exp: past }) })).toBeNull();
    expect(await auth.identify({ "x-authentik-jwt": await mint({ iss: "https://evil.example.test/" }) })).toBeNull();
    expect(await auth.identify({ "x-authentik-jwt": await mint({ aud: "other" }) })).toBeNull();
    expect(reasons).toEqual(["expired", "claims", "claims"]);
  });

  it("rejects a token without exp or sub", async () => {
    const { auth } = harness();
    const noSub = await mint({ sub: null });
    expect(await auth.identify({ "x-authentik-jwt": noSub })).toBeNull();
    const noExp = await new SignJWT({ groups: ["member"] })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("u")
      .sign(signing);
    expect(await auth.identify({ "x-authentik-jwt": noExp })).toBeNull();
  });

  it("rejects an alg none token", async () => {
    const { auth } = harness();
    const exp = Math.floor(Date.now() / 1000) + 300;
    const token = `${b64({ alg: "none", typ: "JWT" })}.${b64({ iss: ISSUER, aud: AUDIENCE, sub: "u", exp, groups: ["authentik Admins"] })}.`;
    expect(await auth.identify({ "x-authentik-jwt": token })).toBeNull();
  });

  it("rejects an HS256 token signed with the public key text as secret", async () => {
    const { auth } = harness();
    const token = await new SignJWT({ groups: ["authentik Admins"] })
      .setProtectedHeader({ alg: "HS256", kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("u")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(publicPem));
    expect(await auth.identify({ "x-authentik-jwt": token })).toBeNull();
  });

  it("rejects a repeated jwt header and accepts a single-element array", async () => {
    const { auth, reasons } = harness();
    const token = await mint();
    expect(await auth.identify({ "x-authentik-jwt": [token, token] })).toBeNull();
    expect(await auth.identify({ "x-authentik-jwt": token, "X-Authentik-JWT": token })).toBeNull();
    expect(reasons).toEqual(["ambiguous", "ambiguous"]);
    expect(await auth.identify({ "x-authentik-jwt": [token] })).not.toBeNull();
  });

  it("rejects garbage and an empty jwt header", async () => {
    const { auth } = harness();
    expect(await auth.identify({ "x-authentik-jwt": "not-a-jwt" })).toBeNull();
    expect(await auth.identify({ "x-authentik-jwt": "  " })).toBeNull();
  });

  it("tolerates a missing or malformed groups claim as no groups", async () => {
    const { auth } = harness();
    const absent = await auth.identify({ "x-authentik-jwt": await mint({ claims: { groups: undefined } }) });
    expect(absent?.groups).toEqual([]);
    const bad = await auth.identify({ "x-authentik-jwt": await mint({ claims: { groups: "authentik Admins" } }) });
    expect(bad?.groups).toEqual([]);
    expect(auth.role(bad!)).toBe("none");
  });
});

describe("role", () => {
  async function roleOf(groups: unknown, cfg = config()): Promise<string> {
    const { auth } = harness(cfg);
    const id = await auth.identify({ "x-authentik-jwt": await mint({ claims: { groups } }) });
    return auth.role(id!);
  }

  it("maps admin, member, other and both", async () => {
    expect(await roleOf(["authentik Admins"])).toBe("admin");
    expect(await roleOf(["member"])).toBe("member");
    expect(await roleOf(["staff"])).toBe("none");
    expect(await roleOf(["member", "authentik Admins"])).toBe("admin");
    expect(await roleOf([])).toBe("none");
  });

  it("matches group names exactly, case-sensitively", async () => {
    for (const variant of ["Authentik Admins", "authentik Admins2", "xauthentik Admins", "authentik  Admins", "Member", "members"]) {
      expect(await roleOf([variant])).toBe("none");
    }
  });

  it("honours configured group names and never matches an empty one", async () => {
    expect(await roleOf(["ops"], config({ webAdminGroup: "ops" }))).toBe("admin");
    expect(await roleOf([""], config({ webAdminGroup: "", webMemberGroup: "" }))).toBe("none");
  });
});

describe("fail closed", () => {
  for (const key of ["authentikJwksUrl", "authentikIssuer", "authentikAudience"]) {
    it(`denies everything and warns loudly when ${key} is empty`, async () => {
      const { auth, reasons, warnings } = harness(config({ [key]: "" }));
      expect(auth.configured).toBe(false);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/FAIL-CLOSED/);
      expect(await auth.identify({ "x-authentik-jwt": await mint() })).toBeNull();
      expect(reasons).toEqual(["unconfigured"]);
    });
  }
});

describe("secrecy", () => {
  it("never leaks the token or claims through the reject callback or console", async () => {
    const seen: string[] = [];
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) => {
      const original = console[m];
      console[m] = (...args: unknown[]) => void seen.push(args.map(String).join(" "));
      return () => (console[m] = original);
    });
    try {
      const bad = await mint({ key: otherKey, claims: { email: "secret-claim@example.test" } });
      const reasons: unknown[] = [];
      const auth = createAuth(config(), resolver, { onReject: (r) => reasons.push(r) });
      await auth.identify({ "x-authentik-jwt": bad });
      await auth.identify({ "x-authentik-jwt": bad.slice(0, 20) });
      const dump = JSON.stringify(reasons) + seen.join("\n");
      expect(dump).not.toContain(bad);
      expect(dump).not.toContain(bad.slice(0, 20));
      expect(dump).not.toContain("secret-claim");
      expect(reasons.every((r) => typeof r === "string" && r.length < 20)).toBe(true);
    } finally {
      spies.forEach((restore) => restore());
    }
  });

  it("does not let a throwing onReject change the outcome", async () => {
    const auth = createAuth(config(), resolver, { onReject: () => { throw new Error("log down"); } });
    expect(await auth.identify({})).toBeNull();
  });
});
