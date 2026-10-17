import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from "jose";
import type { AppsConfig } from "@vast-comfy/core";
import { OidcError, createOidc, parsePublicUrl, sanitizeNext, type LoginTransaction, type OidcDeps } from "../src/oidc.js";
import { CLIENT_ID, CLIENT_SECRET, startFakeIdp, type FakeIdp } from "./fake-idp.js";

const PUBLIC_URL = "https://comfy.example.test";

let idp: FakeIdp;

beforeAll(async () => {
  idp = await startFakeIdp();
});

afterAll(async () => {
  await idp.close();
});

const baseDiscovery = () => ({
  issuer: idp.issuer,
  authorization_endpoint: `${idp.base}/application/o/authorize/`,
  token_endpoint: `${idp.base}/application/o/token/`,
  jwks_uri: `${idp.issuer}jwks/`,
  code_challenge_methods_supported: ["plain", "S256"],
});

beforeEach(() => {
  idp.discovery = baseDiscovery();
  idp.tokenOverride = undefined;
  idp.tokenRequests.length = 0;
  idp.discoveryHits = 0;
});

function config(over: Record<string, unknown> = {}): AppsConfig {
  return {
    authentikIssuer: idp.issuer,
    authentikClientId: CLIENT_ID,
    authentikClientSecret: CLIENT_SECRET,
    webPublicUrl: PUBLIC_URL,
    webOidcSkewS: 0,
    httpTimeoutSApps: 5,
    webJsonMaxBytes: 65536,
    secretNames: ["AUTHENTIK_CLIENT_SECRET", "WEB_SESSION_SECRET"],
    ...over,
  } as unknown as AppsConfig;
}

/** Run begin + the fake browser round trip; returns what the callback would receive. */
async function login(cfg = config(), claims: Record<string, unknown> = {}, deps: OidcDeps = {}, idToken?: (nonce: string) => Promise<string>) {
  const oidc = createOidc(cfg, deps);
  const { redirectUrl, transaction } = await oidc.begin("/after");
  const { code, state } = idp.authorize(redirectUrl, claims, idToken ? { idToken } : {});
  return { oidc, transaction, code, state, redirectUrl };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OidcError);
    return (e as OidcError).code;
  }
  throw new Error("expected an OidcError");
}

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

describe("begin", () => {
  it("begin builds an authorize URL with state, nonce, PKCE S256 and the exact redirect_uri from WEB_PUBLIC_URL", async () => {
    const oidc = createOidc(config({ webPublicUrl: `${PUBLIC_URL}/` }));
    expect(oidc.configured).toBe(true);
    expect(oidc.secureCookies).toBe(true);
    const { redirectUrl, transaction } = await oidc.begin("/gallery?x=1");
    const url = new URL(redirectUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${idp.base}/application/o/authorize/`);
    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe(CLIENT_ID);
    expect(p.get("redirect_uri")).toBe(`${PUBLIC_URL}/auth/callback`);
    expect(p.get("scope")).toBe("openid profile email");
    expect(p.get("state")).toBe(transaction.state);
    expect(p.get("nonce")).toBe(transaction.nonce);
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toBe(createHash("sha256").update(transaction.verifier).digest("base64url"));
    expect(redirectUrl).not.toContain(CLIENT_SECRET);
    expect(Buffer.from(transaction.state, "base64url").length).toBeGreaterThanOrEqual(16);
    expect(Buffer.from(transaction.nonce, "base64url").length).toBeGreaterThanOrEqual(16);
    expect(Buffer.from(transaction.verifier, "base64url").length).toBeGreaterThanOrEqual(32);
    expect(transaction.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(transaction.next).toBe("/gallery?x=1");
  });

  it("uses fresh state, nonce and verifier for every login and sanitizes next", async () => {
    const oidc = createOidc(config());
    const a = await oidc.begin("//evil.example");
    const b = await oidc.begin("/a");
    expect(a.transaction.next).toBe("/");
    expect(a.transaction.state).not.toBe(b.transaction.state);
    expect(a.transaction.nonce).not.toBe(b.transaction.nonce);
    expect(a.transaction.verifier).not.toBe(b.transaction.verifier);
  });

  it("caches discovery after success but retries after a failure", async () => {
    idp.discovery = 503;
    const oidc = createOidc(config());
    expect(await codeOf(oidc.begin("/"))).toBe("discovery_failed");
    expect(idp.discoveryHits).toBe(1);
    idp.discovery = baseDiscovery();
    await oidc.begin("/");
    await oidc.begin("/");
    expect(idp.discoveryHits).toBe(2);
  });

  it("discovery issuer mismatch is rejected", async () => {
    idp.discovery = { ...baseDiscovery(), issuer: `${idp.base}/application/o/other/` };
    expect(await codeOf(createOidc(config()).begin("/"))).toBe("discovery_failed");
    idp.discovery = { ...baseDiscovery(), issuer: idp.issuer.replace(/\/$/, "") };
    expect(await codeOf(createOidc(config()).begin("/"))).toBe("discovery_failed");
  });

  it("rejects a discovery document missing an endpoint, with a non-https endpoint, or without S256", async () => {
    for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
      const doc: Record<string, unknown> = baseDiscovery();
      delete doc[key];
      idp.discovery = doc;
      expect(await codeOf(createOidc(config()).begin("/"))).toBe("discovery_failed");
    }
    idp.discovery = { ...baseDiscovery(), token_endpoint: "http://idp.example.test/token" };
    expect(await codeOf(createOidc(config()).begin("/"))).toBe("discovery_failed");
    idp.discovery = { ...baseDiscovery(), code_challenge_methods_supported: ["plain"] };
    expect(await codeOf(createOidc(config()).begin("/"))).toBe("discovery_failed");
  });

  it("handles the issuer's trailing slash per OIDC discovery (no double slash)", async () => {
    const seen: string[] = [];
    const spy: typeof fetch = (input, init) => {
      seen.push(String(input));
      return fetch(input, init);
    };
    await createOidc(config(), { fetch: spy }).begin("/");
    expect(seen[0]).toBe(idp.discoveryUrl);
    expect(seen[0]).not.toContain("//.well-known");
  });
});

describe("configuration", () => {
  it("is fail-closed when any OIDC key is empty", async () => {
    for (const key of ["authentikIssuer", "authentikClientId", "authentikClientSecret", "webPublicUrl"]) {
      const oidc = createOidc(config({ [key]: "" }));
      expect(oidc.configured).toBe(false);
      expect(await codeOf(oidc.begin("/"))).toBe("not_configured");
      const tx: LoginTransaction = { state: "s", nonce: "n", verifier: "v", next: "/" };
      expect(await codeOf(oidc.finish({ code: "c", state: "s" }, tx))).toBe("not_configured");
    }
  });

  it("accepts only a bare https origin, or http on localhost/127.0.0.1", () => {
    expect(parsePublicUrl("https://comfy.example.test")).toEqual({ origin: "https://comfy.example.test", secure: true });
    expect(parsePublicUrl("https://comfy.example.test/")).toEqual({ origin: "https://comfy.example.test", secure: true });
    expect(parsePublicUrl("http://localhost:3000")).toEqual({ origin: "http://localhost:3000", secure: false });
    expect(parsePublicUrl("http://127.0.0.1:3000")?.secure).toBe(false);
    for (const bad of ["", "http://comfy.example.test", "https://comfy.example.test/app", "https://x.test/?a=1", "https://u:p@x.test", "ftp://x.test", "not a url"]) {
      expect(parsePublicUrl(bad)).toBeNull();
    }
    expect(createOidc(config({ webPublicUrl: "http://comfy.example.test" })).configured).toBe(false);
    const local = createOidc(config({ webPublicUrl: "http://localhost:3000" }));
    expect(local.secureCookies).toBe(false);
    expect(local.redirectUri).toBe("http://localhost:3000/auth/callback");
  });

  it("rejects a plain-http issuer that is not loopback", () => {
    expect(createOidc(config({ authentikIssuer: "http://sso.example.test/application/o/vast/" })).configured).toBe(false);
  });
});

describe("finish", () => {
  it("finish accepts a valid code and returns the identity with groups", async () => {
    const { oidc, transaction, code, state } = await login(config(), { groups: ["member", "authentik Admins"], name: "Ayu A" });
    const id = await oidc.finish({ code, state }, transaction);
    expect(id).toEqual({
      subject: "user-1",
      username: "ayu",
      name: "Ayu A",
      email: "ayu@example.test",
      groups: ["member", "authentik Admins"],
    });
    const req = idp.tokenRequests.at(-1)!;
    expect(req.form).toEqual({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${PUBLIC_URL}/auth/callback`,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code_verifier: transaction.verifier,
    });
    expect(req.authorization).toBeUndefined();
  });

  it("falls back to email then sub for the username", async () => {
    let r = await login(config(), { preferred_username: undefined });
    expect((await r.oidc.finish({ code: r.code, state: r.state }, r.transaction)).username).toBe("ayu@example.test");
    r = await login(config(), { preferred_username: undefined, email: undefined });
    const id = await r.oidc.finish({ code: r.code, state: r.state }, r.transaction);
    expect(id.username).toBe("user-1");
    expect(id.email).toBeNull();
  });

  it("verifies against the real JWKS endpoint by default", async () => {
    // no jwks override: the resolver is built lazily from the discovered jwks_uri
    const r = await login();
    expect((await r.oidc.finish({ code: r.code, state: r.state }, r.transaction)).subject).toBe("user-1");
  });

  it("rejects state mismatch / missing state / provider error param", async () => {
    const r = await login();
    expect(await codeOf(r.oidc.finish({ code: r.code, state: `${r.state}x` }, r.transaction))).toBe("state_mismatch");
    expect(await codeOf(r.oidc.finish({ code: r.code }, r.transaction))).toBe("state_mismatch");
    expect(await codeOf(r.oidc.finish({ code: r.code, state: "" }, { ...r.transaction, state: "" }))).toBe("state_mismatch");
    expect(await codeOf(r.oidc.finish({ state: r.state, error: "access_denied" }, r.transaction))).toBe("provider_error");
    expect(await codeOf(r.oidc.finish({ state: r.state }, r.transaction))).toBe("exchange_failed");
    expect(idp.tokenRequests).toHaveLength(0); // nothing was exchanged on any of these
  });

  it("a code is one-time: a replay fails the exchange", async () => {
    const r = await login();
    await r.oidc.finish({ code: r.code, state: r.state }, r.transaction);
    expect(await codeOf(r.oidc.finish({ code: r.code, state: r.state }, r.transaction))).toBe("exchange_failed");
  });

  it("a code from another login (other PKCE verifier) fails the exchange", async () => {
    const a = await login();
    const b = await login();
    expect(await codeOf(a.oidc.finish({ code: b.code, state: a.state }, a.transaction))).toBe("exchange_failed");
  });

  type Mint = (nonce: string) => Promise<string>;
  const cases: Array<[string, Mint, string]> = [
    ["wrong issuer", (nonce) => idp.mint({ nonce, iss: "https://evil.example.test/application/o/vast/" }), "token_invalid"],
    ["wrong audience", (nonce) => idp.mint({ nonce, aud: "other-client" }), "token_invalid"],
    ["expired", (nonce) => idp.mint({ nonce, exp: Math.floor(Date.now() / 1000) - 5 }), "token_invalid"],
    ["missing exp", (nonce) => idp.mint({ nonce, exp: null }), "token_invalid"],
    ["signed by another key", (nonce) => idp.mint({ nonce, key: idp.otherKey }), "token_invalid"],
    ["several audiences without azp", (nonce) => idp.mint({ nonce, aud: [CLIENT_ID, "other"] }), "token_invalid"],
    ["azp of another client", (nonce) => idp.mint({ nonce, claims: { azp: "other" } }), "token_invalid"],
    ["nonce mismatch", () => idp.mint({ nonce: "not-the-nonce" }), "nonce_mismatch"],
    ["missing nonce", () => idp.mint({ nonce: null }), "nonce_mismatch"],
    ["missing sub", (nonce) => idp.mint({ nonce, sub: null }), "no_subject"],
    [
      "alg none",
      async (nonce) => {
        const now = Math.floor(Date.now() / 1000);
        return `${b64({ alg: "none", typ: "JWT" })}.${b64({ iss: idp.issuer, aud: CLIENT_ID, sub: "root", nonce, iat: now, exp: now + 300, groups: ["authentik Admins"] })}.`;
      },
      "token_invalid",
    ],
    [
      "HS256 signed with the public key text",
      (nonce) =>
        new SignJWT({ nonce, groups: ["authentik Admins"] })
          .setProtectedHeader({ alg: "HS256", kid: "fake-k1" })
          .setIssuer(idp.issuer)
          .setAudience(CLIENT_ID)
          .setSubject("root")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(new TextEncoder().encode(idp.publicPem)),
      "token_invalid",
    ],
  ];
  for (const [label, mint, expected] of cases) {
    it(`rejects ${label}`, async () => {
      const r = await login(config(), {}, {}, mint);
      expect(await codeOf(r.oidc.finish({ code: r.code, state: r.state }, r.transaction))).toBe(expected);
    });
  }

  it("honours the configured clock skew and nothing more", async () => {
    const t0 = Date.now();
    const exp = Math.floor(t0 / 1000) + 60;
    const at = t0 + 90_000; // 30 s after exp
    const strict = await login(config(), {}, { now: () => at }, (nonce) => idp.mint({ nonce, exp }));
    expect(await codeOf(strict.oidc.finish({ code: strict.code, state: strict.state }, strict.transaction))).toBe("token_invalid");
    const lenient = await login(config({ webOidcSkewS: 60 }), {}, { now: () => at }, (nonce) => idp.mint({ nonce, exp }));
    expect((await lenient.oidc.finish({ code: lenient.code, state: lenient.state }, lenient.transaction)).subject).toBe("user-1");
  });

  /** An ID token for this login, signed with any key/alg and with explicit times (seconds). */
  async function signed(nonce: string, o: { key?: CryptoKey; alg?: string; kid?: string; iat?: number; nbf?: number; exp?: number } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const jwt = new SignJWT({ nonce, preferred_username: "ayu", groups: ["member"] })
      .setProtectedHeader({ alg: o.alg ?? "RS256", kid: o.kid ?? "fake-k1" })
      .setIssuer(idp.issuer)
      .setAudience(CLIENT_ID)
      .setSubject("user-1")
      .setIssuedAt(o.iat ?? now)
      .setExpirationTime(o.exp ?? now + 300);
    if (o.nbf !== undefined) jwt.setNotBefore(o.nbf);
    return jwt.sign(o.key ?? idp.signing);
  }

  /** A JWKS that serves one public key WITHOUT an `alg` member, so only our pin limits the algorithm. */
  async function jwksWithoutAlg(alg: string, kid: string) {
    const pair = await generateKeyPair(alg, { extractable: true });
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid, use: "sig" };
    expect(jwk.alg).toBeUndefined();
    return { privateKey: pair.privateKey, jwks: createLocalJWKSet({ keys: [jwk] }) };
  }

  it("accepts an ES256 token from a JWK without an alg member", async () => {
    const ec = await jwksWithoutAlg("ES256", "ec-1");
    const r = await login(config(), {}, { jwks: ec.jwks }, (nonce) => signed(nonce, { key: ec.privateKey, alg: "ES256", kid: "ec-1" }));
    expect((await r.oidc.finish({ code: r.code, state: r.state }, r.transaction)).subject).toBe("user-1");
  });

  for (const alg of ["PS256", "RS512"]) {
    it(`rejects a ${alg} token signed with an RSA key served from a JWK without an alg member (algorithm pin)`, async () => {
      const rsa = await jwksWithoutAlg(alg, "rsa-1");
      const r = await login(config(), {}, { jwks: rsa.jwks }, (nonce) => signed(nonce, { key: rsa.privateKey, alg, kid: "rsa-1" }));
      expect(await codeOf(r.oidc.finish({ code: r.code, state: r.state }, r.transaction))).toBe("token_invalid");
    });
  }

  it("rejects a future nbf, a future iat and an old iat; accepts a recent iat", async () => {
    const now = Math.floor(Date.now() / 1000);
    const bad: Array<Parameters<typeof signed>[1]> = [
      { nbf: now + 60 },
      { iat: now + 60 },
      { iat: now - 3600, exp: now + 300 },
      { iat: now - 301, exp: now + 300 },
    ];
    for (const times of bad) {
      const r = await login(config(), {}, {}, (nonce) => signed(nonce, times));
      expect(await codeOf(r.oidc.finish({ code: r.code, state: r.state }, r.transaction)), JSON.stringify(times)).toBe("token_invalid");
    }
    const ok = await login(config(), {}, {}, (nonce) => signed(nonce, { iat: now - 60 }));
    expect((await ok.oidc.finish({ code: ok.code, state: ok.state }, ok.transaction)).subject).toBe("user-1");
    // The configured skew widens the iat window by exactly that much.
    const lenient = await login(config({ webOidcSkewS: 60 }), {}, {}, (nonce) => signed(nonce, { iat: now - 330 }));
    expect((await lenient.oidc.finish({ code: lenient.code, state: lenient.state }, lenient.transaction)).subject).toBe("user-1");
  });

  it("groups claim as a string or with non-strings is sanitized to []", async () => {
    for (const groups of ["authentik Admins", { 0: "authentik Admins" }, ["authentik Admins", 1], [null], undefined]) {
      const r = await login(config(), { groups });
      expect((await r.oidc.finish({ code: r.code, state: r.state }, r.transaction)).groups).toEqual([]);
    }
  });

  it("token endpoint failure/non-JSON/oversized body -> exchange_failed", async () => {
    const replies: Array<{ status: number; body: string }> = [
      { status: 400, body: JSON.stringify({ error: "invalid_grant" }) },
      { status: 500, body: "{}" },
      { status: 200, body: "<html>not json</html>" },
      { status: 200, body: JSON.stringify({ access_token: "a" }) },
      { status: 200, body: JSON.stringify({ id_token: 42 }) },
      { status: 200, body: JSON.stringify(["id_token"]) },
      { status: 200, body: JSON.stringify({ id_token: "x".repeat(70_000) }) },
    ];
    for (const reply of replies) {
      idp.tokenOverride = () => reply;
      const r = await login();
      expect(await codeOf(r.oidc.finish({ code: r.code, state: r.state }, r.transaction))).toBe("exchange_failed");
    }
  });

  it("an unreachable or hanging token endpoint -> exchange_failed", async () => {
    const r = await login();
    const failing: typeof fetch = async (input, init) => {
      if (String(input).includes("/token/")) throw new TypeError("fetch failed");
      return fetch(input, init);
    };
    const oidc = createOidc(config(), { fetch: failing });
    expect(await codeOf(oidc.finish({ code: r.code, state: r.state }, r.transaction))).toBe("exchange_failed");
    const hanging: typeof fetch = (input, init) => {
      if (!String(input).includes("/token/")) return fetch(input, init);
      return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    };
    const slow = createOidc(config({ httpTimeoutSApps: 1 }), { fetch: hanging });
    expect(await codeOf(slow.finish({ code: r.code, state: r.state }, r.transaction))).toBe("exchange_failed");
  });

  it("errors never contain the code, the client secret or tokens", async () => {
    const leaked = await idp.mint({ nonce: "wrong" });
    const messages: string[] = [];
    const collect = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        const err = e as Error;
        messages.push(`${err.message} ${err.stack ?? ""} ${JSON.stringify(err)} ${String(err)}`);
      }
    };
    idp.tokenOverride = () => ({ status: 400, body: JSON.stringify({ error: "invalid_client", error_description: `bad ${CLIENT_SECRET}` }) });
    let r = await login();
    await collect(r.oidc.finish({ code: r.code, state: r.state }, r.transaction));
    idp.tokenOverride = () => ({ status: 200, body: JSON.stringify({ id_token: leaked, access_token: "secret-access" }) });
    r = await login();
    await collect(r.oidc.finish({ code: r.code, state: r.state }, r.transaction));
    r = await login();
    await collect(r.oidc.finish({ code: r.code, state: "wrong", error: `boom ${r.code}` }, r.transaction));
    expect(messages).toHaveLength(3);
    for (const m of messages) {
      expect(m).not.toContain(r.code);
      expect(m).not.toContain(CLIENT_SECRET);
      expect(m).not.toContain(leaked);
      expect(m).not.toContain("secret-access");
      expect(m).not.toContain("invalid_client");
    }
  });
});

describe("sanitizeNext", () => {
  it("keeps same-site relative paths", () => {
    expect(sanitizeNext("/a")).toBe("/a");
    expect(sanitizeNext("/a/b?c=1#d")).toBe("/a/b?c=1#d");
    expect(sanitizeNext("/")).toBe("/");
  });

  it("returns the parsed, percent-encoded path (safe in a Location header), never the raw input", () => {
    expect(sanitizeNext("/中")).toBe("/%E4%B8%AD");
    expect(sanitizeNext("/a?q=中#中")).toBe("/a?q=%E4%B8%AD#%E4%B8%AD");
    expect(sanitizeNext("/a/../b")).toBe("/b");
    // An encoded slash stays encoded: a single-slash same-origin path, not protocol-relative.
    expect(sanitizeNext("/%2f/evil")).toBe("/%2f/evil");
    expect(sanitizeNext("/..//evil")).toBe("/");
    expect(sanitizeNext("/.//evil")).toBe("/");
    for (const raw of ["/中", "/%2f/evil", "/a?q=中", "/é"]) {
      const out = sanitizeNext(raw);
      expect(out, raw).toMatch(/^\/(?!\/)[\x21-\x7e]*$/);
      expect(() => new Headers({ location: out })).not.toThrow();
    }
  });

  it("turns everything else into /", () => {
    for (const bad of [
      "//evil",
      "//evil.example/x",
      "/\\evil",
      "\\\\evil",
      "/a\\b",
      "https://x",
      "http://x/a",
      "javascript:alert(1)",
      "a/b",
      "",
      "/\t/evil",
      "/\n/evil",
      "/.//evil",
      " /a",
      "/" + "a".repeat(5000),
    ]) {
      expect(sanitizeNext(bad), JSON.stringify(bad.slice(0, 30))).toBe("/");
    }
    for (const notString of [undefined, null, 1, ["/a"], { a: "/a" }]) expect(sanitizeNext(notString)).toBe("/");
  });
});
