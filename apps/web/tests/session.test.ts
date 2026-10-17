import { describe, expect, it } from "vitest";
import { SignJWT, decodeJwt, decodeProtectedHeader } from "jose";
import { SESSION_COOKIE, TRANSACTION_COOKIE, cookieValues, createSessions } from "../src/session.js";
import type { LoginTransaction, OidcIdentity } from "../src/oidc.js";

const SECRET = "s".repeat(32);
const OTHER_SECRET = "o".repeat(32);

const identity: OidcIdentity = {
  subject: "user-1",
  username: "ayu",
  name: "Ayu",
  email: "ayu@example.test",
  groups: ["member", "authentik Admins"],
};

const tx: LoginTransaction = { state: "state-abc", nonce: "nonce-abc", verifier: "verifier-abc", next: "/gallery" };

const header = (value: string, name = SESSION_COOKIE) => `other=1; ${name}=${value}; theme=dark`;

describe("session cookie", () => {
  it("sign/verify round trip", async () => {
    const s = createSessions(SECRET, 8);
    const value = await s.issue(identity);
    expect(await s.read(header(value))).toEqual(identity);
  });

  it("carries only sub, username, name, email, groups, iat and exp, with the configured lifetime", async () => {
    const t = 1_800_000_000_000;
    const s = createSessions(SECRET, 8, () => t);
    const value = await s.issue({ ...identity, extra: "x" } as OidcIdentity);
    const claims = decodeJwt(value);
    expect(Object.keys(claims).sort()).toEqual(["email", "exp", "groups", "iat", "name", "sub", "username"]);
    expect(claims.exp! - claims.iat!).toBe(8 * 3600);
    expect(decodeProtectedHeader(value).alg).toBe("HS256");
  });

  it("keeps null name and email", async () => {
    const s = createSessions(SECRET, 1);
    const value = await s.issue({ ...identity, name: null, email: null, groups: [] });
    expect(await s.read(header(value))).toEqual({ ...identity, name: null, email: null, groups: [] });
  });

  it("rejects a tampered payload", async () => {
    const s = createSessions(SECRET, 8);
    const [h, , sig] = (await s.issue(identity)).split(".");
    const forged = Buffer.from(JSON.stringify({ ...decodeJwt(await s.issue(identity)), groups: ["authentik Admins", "root"] })).toString("base64url");
    expect(await s.read(header(`${h}.${forged}.${sig}`))).toBeNull();
  });

  it("rejects a cookie signed with another secret", async () => {
    const value = await createSessions(OTHER_SECRET, 8).issue(identity);
    expect(await createSessions(SECRET, 8).read(header(value))).toBeNull();
  });

  it("rejects an expired cookie", async () => {
    let t = 1_800_000_000_000;
    const s = createSessions(SECRET, 1, () => t);
    const value = await s.issue(identity);
    t += 3600 * 1000 - 1000;
    expect(await s.read(header(value))).not.toBeNull();
    t += 2000;
    expect(await s.read(header(value))).toBeNull();
  });

  it("rejects an alg swap (none, or HS256 with the raw secret instead of the derived key)", async () => {
    const s = createSessions(SECRET, 8);
    const claims = decodeJwt(await s.issue(identity));
    const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "vc-session+jwt" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
    expect(await s.read(header(none))).toBeNull();
    const raw = await new SignJWT(claims).setProtectedHeader({ alg: "HS256", typ: "vc-session+jwt" }).sign(new TextEncoder().encode(SECRET));
    expect(await s.read(header(raw))).toBeNull();
    const hs512 = await new SignJWT(claims).setProtectedHeader({ alg: "HS512", typ: "vc-session+jwt" }).sign(new TextEncoder().encode(SECRET.repeat(2)));
    expect(await s.read(header(hs512))).toBeNull();
  });

  it("rejects garbage, empty and missing cookies", async () => {
    const s = createSessions(SECRET, 8);
    for (const h of [undefined, "", "garbage", `${SESSION_COOKIE}=`, `${SESSION_COOKIE}=not.a.jwt`, `${SESSION_COOKIE}=a.b`, `${SESSION_COOKIE}="x"`]) {
      expect(await s.read(h)).toBeNull();
    }
  });

  it("rejects multiple cookies with the same name (ambiguity), even if both are valid", async () => {
    const s = createSessions(SECRET, 8);
    const a = await s.issue(identity);
    const b = await s.issue({ ...identity, subject: "user-2" });
    expect(await s.read(`${SESSION_COOKIE}=${a}; ${SESSION_COOKIE}=${b}`)).toBeNull();
    expect(await s.read(`${SESSION_COOKIE}=${a}; ${SESSION_COOKIE}=${a}`)).toBeNull();
    expect(cookieValues(`${SESSION_COOKIE}=1; x${SESSION_COOKIE}=2; ${SESSION_COOKIE}x=3`, SESSION_COOKIE)).toEqual(["1"]);
  });

  it("does not accept a login-transaction cookie as a session (and vice versa)", async () => {
    const s = createSessions(SECRET, 8);
    const txValue = await s.issueTransaction(tx);
    expect(await s.read(header(txValue))).toBeNull();
    const sessionValue = await s.issue(identity);
    expect(await s.readTransaction(header(sessionValue, TRANSACTION_COOKIE))).toBeNull();
  });

  it("cookie flags (HttpOnly, SameSite=Lax, Path=/, Secure when https)", async () => {
    const s = createSessions(SECRET, 8);
    const value = await s.issue(identity);
    const secure = s.serialize(value, { secure: true });
    expect(secure.startsWith(`${SESSION_COOKIE}=${value}; `)).toBe(true);
    const attrs = secure.split("; ").slice(1);
    expect(attrs).toEqual(expect.arrayContaining(["Path=/", "HttpOnly", "SameSite=Lax", "Secure", `Max-Age=${8 * 3600}`]));
    expect(secure).not.toMatch(/Domain=/i);
    expect(s.serialize(value, { secure: false })).not.toContain("Secure");
    expect(() => s.serialize("x; Domain=evil", { secure: true })).toThrow();
  });

  it("clear cookie", () => {
    const s = createSessions(SECRET, 8);
    const cleared = s.clear({ secure: true });
    expect(cleared.startsWith(`${SESSION_COOKIE}=; `)).toBe(true);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Path=/");
    expect(cleared).toContain("HttpOnly");
    expect(cleared).toContain("Secure");
    expect(s.clearTransaction({ secure: false }).startsWith(`${TRANSACTION_COOKIE}=; `)).toBe(true);
  });

  it("secret < 32 bytes throws", () => {
    expect(() => createSessions("", 8)).toThrow(/32 bytes/);
    expect(() => createSessions("s".repeat(31), 8)).toThrow(/32 bytes/);
    expect(() => createSessions(SECRET, 0)).toThrow();
    expect(() => createSessions(SECRET, 8)).not.toThrow();
  });

  it("the secret never appears in cookie values or errors", async () => {
    const s = createSessions(SECRET, 8);
    const value = await s.issue(identity);
    expect(value).not.toContain(SECRET);
    try {
      createSessions("short-secret", 8);
    } catch (e) {
      expect(String(e)).not.toContain("short-secret");
    }
  });
});

describe("login-transaction cookie", () => {
  it("round trips state, nonce, verifier and next", async () => {
    const s = createSessions(SECRET, 8);
    const value = await s.issueTransaction(tx);
    expect(await s.readTransaction(header(value, TRANSACTION_COOKIE))).toEqual(tx);
    const set = s.serializeTransaction(value, { secure: true });
    expect(set.split("; ")).toEqual(expect.arrayContaining(["HttpOnly", "SameSite=Lax", "Path=/", "Secure", "Max-Age=600"]));
  });

  it("transaction cookie expires after 10 minutes", async () => {
    let t = 1_800_000_000_000;
    const s = createSessions(SECRET, 8, () => t);
    const value = await s.issueTransaction(tx);
    t += 9 * 60 * 1000;
    expect(await s.readTransaction(header(value, TRANSACTION_COOKIE))).not.toBeNull();
    t += 2 * 60 * 1000;
    expect(await s.readTransaction(header(value, TRANSACTION_COOKIE))).toBeNull();
  });

  it("re-sanitizes next and rejects ambiguity or another secret", async () => {
    const s = createSessions(SECRET, 8);
    const value = await s.issueTransaction({ ...tx, next: "//evil.example" });
    expect((await s.readTransaction(header(value, TRANSACTION_COOKIE)))?.next).toBe("/");
    expect(await s.readTransaction(`${TRANSACTION_COOKIE}=${value}; ${TRANSACTION_COOKIE}=${value}`)).toBeNull();
    const foreign = await createSessions(OTHER_SECRET, 8).issueTransaction(tx);
    expect(await s.readTransaction(header(foreign, TRANSACTION_COOKIE))).toBeNull();
  });
});
