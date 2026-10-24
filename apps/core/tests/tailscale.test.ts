import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AppsConfig } from "../src/config.js";
import {
  KEY_TTL_FALLBACK_S,
  TailscaleError,
  createTailscaleKeyMinter,
  createTsAuthKeyProvider,
  tailscaleKeySource,
  type TailscaleDeps,
} from "../src/tailscale.js";

// Obviously fake values; the fake server below is the only "Tailscale" these tests talk to.
const CLIENT_ID = "fake-client-id-0001";
const CLIENT_SECRET = "fake-client-secret-SECRET-0002";
const TOKEN_A = "fake-access-token-AAAA";
const TOKEN_B = "fake-access-token-BBBB";
const MINTED = "tskey-auth-fakeMINTED-0003";
const BODY_MARKER = "PROVIDER-BODY-MARKER";

interface Seen {
  method: string;
  path: string;
  auth: string | undefined;
  contentType: string | undefined;
  raw: string;
}

type Handler = (req: Seen, res: ServerResponse, n: { token: number; keys: number }) => void;

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections?.();
  server?.close();
  server = undefined;
});

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function tokenOk(res: ServerResponse, token = TOKEN_A, expiresIn = 3600): void {
  json(res, 200, { access_token: token, token_type: "Bearer", expires_in: expiresIn, scope: "auth_keys" });
}

function keyOk(res: ServerResponse, key = MINTED): void {
  json(res, 200, { id: "kFAKE", key, created: "2026-10-18T00:00:00Z", expires: "2026-10-18T01:00:00Z" });
}

/** A fake API that answers token and key requests through `handler` (default: both succeed). */
async function fake(handler?: Handler) {
  const seen: Seen[] = [];
  const n = { token: 0, keys: 0 };
  server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const entry: Seen = {
        method: req.method ?? "",
        path: req.url ?? "",
        auth: req.headers.authorization,
        contentType: req.headers["content-type"],
        raw,
      };
      seen.push(entry);
      if (entry.path === "/api/v2/oauth/token") n.token++;
      if (entry.path === "/api/v2/tailnet/-/keys") n.keys++;
      if (handler) return handler(entry, res, n);
      if (entry.path === "/api/v2/oauth/token") return tokenOk(res);
      return keyOk(res);
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`; // config-lint: ok (local fake server)
  return { seen, n, url };
}

function config(url: string, over: Record<string, unknown> = {}): AppsConfig {
  return {
    tsOauthClientId: CLIENT_ID,
    tsOauthClientSecret: CLIENT_SECRET,
    tsOauthTag: "tag:gpu",
    tsKeyTtlS: 3600,
    tsRetryTotalS: 15,
    tsApiUrl: url,
    tsAuthkeyFile: "",
    httpTimeoutSApps: 5,
    webJsonMaxBytes: 4096,
    secretNames: ["TS_OAUTH_CLIENT_ID", "TS_OAUTH_CLIENT_SECRET"],
    ...over,
  } as unknown as AppsConfig;
}

function harness(cfg: AppsConfig, extra: Partial<TailscaleDeps> = {}) {
  const logs: string[] = [];
  const secrets: string[] = [];
  const sleeps: number[] = [];
  const clock = { ms: 1_800_000_000_000 };
  const deps: TailscaleDeps = {
    now: () => clock.ms,
    log: (level, message) => logs.push(`${level} ${message}`),
    onSecret: (v) => secrets.push(v),
    // Retry back-off is recorded, not waited for (tests that need real time pass their own).
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    ...extra,
  };
  const minter = createTailscaleKeyMinter(cfg, deps);
  return { minter, logs, secrets, clock, sleeps };
}

async function codeOf(p: Promise<unknown>): Promise<TailscaleError> {
  const err = await p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TailscaleError);
  return err as TailscaleError;
}

/** Nothing secret and no provider body in any text the minter produced. */
function expectClean(texts: string[]): void {
  for (const text of texts) {
    for (const s of [CLIENT_ID, CLIENT_SECRET, TOKEN_A, TOKEN_B, MINTED, BODY_MARKER]) expect(text).not.toContain(s);
  }
}

describe("tailscaleKeySource", () => {
  it("is file without OAuth keys, oauth with both, misconfigured with exactly one", () => {
    expect(tailscaleKeySource(config("x", { tsOauthClientId: "", tsOauthClientSecret: "" }))).toBe("file");
    expect(tailscaleKeySource(config("x"))).toBe("oauth");
    expect(tailscaleKeySource(config("x", { tsOauthClientId: "" }))).toBe("misconfigured");
    expect(tailscaleKeySource(config("x", { tsOauthClientSecret: "" }))).toBe("misconfigured");
  });
});

describe("createTailscaleKeyMinter", () => {
  it("is null when OAuth is not configured", () => {
    expect(createTailscaleKeyMinter(config("x", { tsOauthClientId: "", tsOauthClientSecret: "" }))).toBeNull();
  });

  it("requests a token with the client-credentials form, then a least-privilege key with the bearer token", async () => {
    const api = await fake();
    const { minter, secrets } = harness(config(api.url));
    expect(minter?.source).toBe("oauth");
    await expect(minter!.mint()).resolves.toBe(MINTED);

    const [tok, key] = api.seen;
    expect(tok!.method).toBe("POST");
    expect(tok!.path).toBe("/api/v2/oauth/token");
    expect(tok!.contentType).toBe("application/x-www-form-urlencoded");
    expect(tok!.auth).toBeUndefined();
    const form = new URLSearchParams(tok!.raw);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("client_secret")).toBe(CLIENT_SECRET);

    expect(key!.method).toBe("POST");
    expect(key!.path).toBe("/api/v2/tailnet/-/keys");
    expect(key!.auth).toBe(`Bearer ${TOKEN_A}`);
    expect(key!.contentType).toBe("application/json");
    expect(JSON.parse(key!.raw)).toEqual({
      capabilities: { devices: { create: { reusable: false, ephemeral: true, preauthorized: true, tags: ["tag:gpu"] } } },
      expirySeconds: 3600,
      description: "vast-comfy start",
    });
    // The caller learns the token and the key so it can redact them.
    expect(secrets).toEqual(expect.arrayContaining([TOKEN_A, MINTED]));
  });

  it("takes the tag and expiry from config", async () => {
    const api = await fake();
    const { minter } = harness(config(api.url, { tsOauthTag: "tag:render", tsKeyTtlS: 600 }));
    await minter!.mint();
    const body = JSON.parse(api.seen[1]!.raw);
    expect(body.capabilities.devices.create.tags).toEqual(["tag:render"]);
    expect(body.expirySeconds).toBe(600);
  });

  it("caches the token until shortly before it expires, then requests a new one", async () => {
    const api = await fake((req, res, n) => {
      if (req.path === "/api/v2/oauth/token") return tokenOk(res, n.token === 1 ? TOKEN_A : TOKEN_B, 3600);
      return keyOk(res);
    });
    const { minter, clock } = harness(config(api.url));
    await minter!.mint();
    await minter!.mint();
    expect(api.n.token).toBe(1);
    expect(api.n.keys).toBe(2);
    clock.ms += 3600 * 1000 - 30 * 1000; // inside the safety margin
    await minter!.mint();
    expect(api.n.token).toBe(2);
    expect(api.seen.at(-1)!.auth).toBe(`Bearer ${TOKEN_B}`);
  });

  it("concurrent mints share one token request and each get their own key", async () => {
    let k = 0;
    const api = await fake((req, res) => {
      if (req.path === "/api/v2/oauth/token") return void setTimeout(() => tokenOk(res), 50);
      return keyOk(res, `tskey-auth-fakeMINTED-${k++}`);
    });
    const { minter } = harness(config(api.url));
    const keys = await Promise.all([minter!.mint(), minter!.mint(), minter!.mint()]);
    expect(api.n.token).toBe(1);
    expect(api.n.keys).toBe(3);
    expect(new Set(keys).size).toBe(3);
  });

  it("a refused token request is oauth_failed and nothing is cached", async () => {
    for (const status of [400, 401, 403]) {
      const api = await fake((req, res) => {
        if (req.path === "/api/v2/oauth/token") return json(res, status, { message: `invalid_client ${BODY_MARKER}` });
        return keyOk(res);
      });
      const { minter, logs } = harness(config(api.url));
      const err = await codeOf(minter!.mint());
      expect(err.code).toBe("oauth_failed");
      expect(api.n.keys).toBe(0);
      expectClean([err.message, ...logs]);
      await codeOf(minter!.mint());
      expect(api.n.token).toBe(2);
      server?.closeAllConnections?.();
      server?.close();
    }
  });

  it("401/403 on the key request is oauth_failed and drops the cached token", async () => {
    for (const status of [401, 403]) {
      let refuse = true;
      const api = await fake((req, res, n) => {
        if (req.path === "/api/v2/oauth/token") return tokenOk(res, n.token === 1 ? TOKEN_A : TOKEN_B);
        if (refuse) return json(res, status, { message: `forbidden ${BODY_MARKER} ${req.auth}` });
        return keyOk(res);
      });
      const { minter, logs } = harness(config(api.url));
      const err = await codeOf(minter!.mint());
      expect(err.code).toBe("oauth_failed");
      expectClean([err.message, ...logs]);
      refuse = false;
      await expect(minter!.mint()).resolves.toBe(MINTED);
      expect(api.n.token).toBe(2);
      expect(api.seen.at(-1)!.auth).toBe(`Bearer ${TOKEN_B}`);
      server?.closeAllConnections?.();
      server?.close();
    }
  });

  it("a 400 about the expiry is retried once with the documented larger value", async () => {
    const api = await fake((req, res) => {
      if (req.path === "/api/v2/oauth/token") return tokenOk(res);
      const body = JSON.parse(req.raw);
      if (body.expirySeconds !== KEY_TTL_FALLBACK_S) return json(res, 400, { message: `expirySeconds too short ${BODY_MARKER}` });
      return keyOk(res);
    });
    const { minter, logs } = harness(config(api.url));
    expect(KEY_TTL_FALLBACK_S).toBe(86400);
    await expect(minter!.mint()).resolves.toBe(MINTED);
    expect(api.n.keys).toBe(2);
    const retry = JSON.parse(api.seen.at(-1)!.raw);
    expect(retry.expirySeconds).toBe(86400);
    // Everything else stays least-privilege on the retry.
    expect(retry.capabilities).toEqual({
      devices: { create: { reusable: false, ephemeral: true, preauthorized: true, tags: ["tag:gpu"] } },
    });
    expect(logs.filter((l) => l.includes("tailscale key ttl fallback"))).toHaveLength(1);
    expectClean(logs);
  });

  it("the expiry retry happens only once", async () => {
    const api = await fake((req, res) => {
      if (req.path === "/api/v2/oauth/token") return tokenOk(res);
      return json(res, 400, { message: "invalid expiry" });
    });
    const { minter } = harness(config(api.url));
    expect((await codeOf(minter!.mint())).code).toBe("key_rejected");
    expect(api.n.keys).toBe(2);
  });

  it("any other 4xx on the key request is key_rejected without a retry", async () => {
    for (const status of [400, 404, 409, 422]) {
      const api = await fake((req, res) => {
        if (req.path === "/api/v2/oauth/token") return tokenOk(res);
        return json(res, status, { message: `tag:gpu is not owned by this client ${BODY_MARKER}` });
      });
      const { minter, logs } = harness(config(api.url));
      const err = await codeOf(minter!.mint());
      expect(err.code).toBe("key_rejected");
      expect(api.n.keys).toBe(1);
      expectClean([err.message, ...logs]);
      server?.closeAllConnections?.();
      server?.close();
    }
  });

  it("429, 5xx, network errors and timeouts are tailscale_unavailable", async () => {
    for (const status of [429, 500, 503]) {
      for (const where of ["/api/v2/oauth/token", "/api/v2/tailnet/-/keys"]) {
        const api = await fake((req, res) => {
          if (req.path === where) return json(res, status, { message: BODY_MARKER });
          if (req.path === "/api/v2/oauth/token") return tokenOk(res);
          return keyOk(res);
        });
        const { minter, logs } = harness(config(api.url));
        const err = await codeOf(minter!.mint());
        expect(err.code).toBe("tailscale_unavailable");
        expectClean([err.message, ...logs]);
        server?.closeAllConnections?.();
        server?.close();
      }
    }
    // Nothing listens on the port any more.
    const gone = await fake();
    server?.close();
    server = undefined;
    await new Promise((r) => setTimeout(r, 20));
    expect((await codeOf(harness(config(gone.url)).minter!.mint())).code).toBe("tailscale_unavailable");

    // A server that never answers: the configured timeout (1 s) applies.
    const slow = await fake(() => undefined);
    const err = await codeOf(harness(config(slow.url, { httpTimeoutSApps: 1, tsRetryTotalS: 1 })).minter!.mint());
    expect(err.code).toBe("tailscale_unavailable");
  });

  it("retries a network error or 5xx on the token and the key request, then succeeds", async () => {
    for (const where of ["/api/v2/oauth/token", "/api/v2/tailnet/-/keys"]) {
      const api = await fake((req, res, n) => {
        const count = where === "/api/v2/oauth/token" ? n.token : n.keys;
        if (req.path === where && count === 1) return void res.socket?.destroy(); // a dropped connection
        if (req.path === where && count === 2) return json(res, 503, { message: BODY_MARKER });
        if (req.path === "/api/v2/oauth/token") return tokenOk(res);
        return keyOk(res);
      });
      const { minter, logs, secrets, sleeps } = harness(config(api.url));
      await expect(minter!.mint()).resolves.toBe(MINTED);
      expect(where === "/api/v2/oauth/token" ? api.n.token : api.n.keys).toBe(3);
      expect(sleeps).toEqual([1000, 2000]);
      expect(logs.filter((l) => l.startsWith("warn tailscale") && l.includes("retry"))).toHaveLength(2);
      expect(secrets).toContain(MINTED);
      expectClean(logs);
      server?.closeAllConnections?.();
      server?.close();
    }
  });

  it("gives up after 3 attempts with tailscale_unavailable", async () => {
    const api = await fake((req, res) => json(res, 502, { message: BODY_MARKER }));
    const { minter, logs, sleeps } = harness(config(api.url));
    const err = await codeOf(minter!.mint());
    expect(err.code).toBe("tailscale_unavailable");
    expect(api.n.token).toBe(3);
    expect(api.n.keys).toBe(0);
    expect(sleeps).toHaveLength(2);
    expectClean([err.message, ...logs]);
  });

  it("adds jitter to the back-off", async () => {
    const api = await fake((req, res, n) => {
      if (req.path === "/api/v2/oauth/token" && n.token === 1) return json(res, 500, {});
      if (req.path === "/api/v2/oauth/token") return tokenOk(res);
      return keyOk(res);
    });
    const { minter, sleeps } = harness(config(api.url), { random: () => 0.5 });
    await expect(minter!.mint()).resolves.toBe(MINTED);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(1000);
    expect(sleeps[0]).toBeLessThan(1500);
  });

  it("never retries a 4xx (auth, permission, rejected key or rate limit)", async () => {
    for (const [where, status, code] of [
      ["/api/v2/oauth/token", 401, "oauth_failed"],
      ["/api/v2/oauth/token", 429, "tailscale_unavailable"],
      ["/api/v2/tailnet/-/keys", 401, "oauth_failed"],
      ["/api/v2/tailnet/-/keys", 403, "oauth_failed"],
      ["/api/v2/tailnet/-/keys", 404, "key_rejected"],
      ["/api/v2/tailnet/-/keys", 429, "tailscale_unavailable"],
    ] as const) {
      const api = await fake((req, res) => {
        if (req.path === where) return json(res, status, { message: BODY_MARKER });
        if (req.path === "/api/v2/oauth/token") return tokenOk(res);
        return keyOk(res);
      });
      const { minter, sleeps } = harness(config(api.url));
      expect((await codeOf(minter!.mint())).code).toBe(code);
      expect(where === "/api/v2/oauth/token" ? api.n.token : api.n.keys).toBe(1);
      expect(sleeps).toHaveLength(0);
      server?.closeAllConnections?.();
      server?.close();
    }
  });

  it("an endless timeout stops at the TS_RETRY_TOTAL_S deadline with tailscale_unavailable", async () => {
    const slow = await fake(() => undefined);
    const started = Date.now();
    const { minter, logs } = harness(config(slow.url, { httpTimeoutSApps: 1, tsRetryTotalS: 3 }), {
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    const err = await codeOf(minter!.mint());
    const took = Date.now() - started;
    expect(err.code).toBe("tailscale_unavailable");
    // Attempt 1 (1 s), back-off 1 s, attempt 2 capped by the deadline; no third attempt fits.
    expect(slow.n.token).toBe(2);
    expect(took).toBeGreaterThanOrEqual(2900);
    expect(took).toBeLessThan(4500);
    expectClean([err.message, ...logs]);
  }, 10_000);

  it("refuses a TS_RETRY_TOTAL_S that is not a positive integer", async () => {
    for (const bad of [0, -1, 1.5, "15", undefined]) {
      const { minter } = harness(config("https://api.tailscale.example", { tsRetryTotalS: bad })); // config-lint: ok (test fixture)
      expect(minter!.source).toBe("misconfigured");
      expect(minter!.problem).toMatch(/TS_RETRY_TOTAL_S/);
    }
  });

  it("a redirect is not followed", async () => {
    const api = await fake((req, res) => {
      res.writeHead(307, { location: "http://127.0.0.1:1/elsewhere" }); // config-lint: ok (test fixture)
      res.end();
    });
    const err = await codeOf(harness(config(api.url)).minter!.mint());
    expect(err.code).toBe("tailscale_unavailable");
    // A refused redirect looks like a network error (it may be retried), but it is never followed.
    expect(api.seen.length).toBeGreaterThanOrEqual(1);
    expect(api.seen.length).toBeLessThanOrEqual(3);
    for (const s of api.seen) expect(s.path).toBe("/api/v2/oauth/token");
  });

  it("non-JSON, oversized or keyless answers are invalid_response", async () => {
    const bad: ((res: ServerResponse) => void)[] = [
      (res) => json(res, 200, `not json ${BODY_MARKER}`),
      (res) => json(res, 200, { key: "x".repeat(5000) }),
      (res) => json(res, 200, { id: "k1" }),
      (res) => json(res, 200, { key: "" }),
      (res) => json(res, 200, { key: 42 }),
      (res) => json(res, 200, { key: "tskey-auth-has space" }),
      (res) => json(res, 200, null),
      // An echo of looser capabilities than requested: the key is not used.
      (res) =>
        json(res, 200, {
          key: MINTED,
          capabilities: { devices: { create: { reusable: true, ephemeral: true, preauthorized: true, tags: ["tag:gpu"] } } },
        }),
      (res) =>
        json(res, 200, {
          key: MINTED,
          capabilities: { devices: { create: { reusable: false, ephemeral: false, preauthorized: true, tags: ["tag:gpu"] } } },
        }),
      (res) =>
        json(res, 200, {
          key: MINTED,
          capabilities: { devices: { create: { reusable: false, ephemeral: true, preauthorized: true, tags: ["tag:gpu", "tag:admin"] } } },
        }),
    ];
    for (const answer of bad) {
      const api = await fake((req, res) => (req.path === "/api/v2/oauth/token" ? tokenOk(res) : answer(res)));
      const { minter, logs } = harness(config(api.url));
      const err = await codeOf(minter!.mint());
      expect(err.code).toBe("invalid_response");
      expectClean([err.message, ...logs]);
      server?.closeAllConnections?.();
      server?.close();
    }
    // The token answer is checked too.
    for (const answer of [
      (res: ServerResponse) => json(res, 200, "nope"),
      (res: ServerResponse) => json(res, 200, { token_type: "Bearer", expires_in: 3600 }),
      (res: ServerResponse) => json(res, 200, { access_token: TOKEN_A, token_type: "mac", expires_in: 3600 }),
      (res: ServerResponse) => json(res, 200, { access_token: "x".repeat(5000) }),
    ]) {
      const api = await fake((req, res) => (req.path === "/api/v2/oauth/token" ? answer(res) : keyOk(res)));
      const err = await codeOf(harness(config(api.url)).minter!.mint());
      expect(err.code).toBe("invalid_response");
      expect(api.n.keys).toBe(0);
      server?.closeAllConnections?.();
      server?.close();
    }
  });

  it("a matching capabilities echo is accepted", async () => {
    const api = await fake((req, res) => {
      if (req.path === "/api/v2/oauth/token") return tokenOk(res);
      return json(res, 200, {
        key: MINTED,
        capabilities: { devices: { create: { reusable: false, ephemeral: true, preauthorized: true, tags: ["tag:gpu"] } } },
      });
    });
    await expect(harness(config(api.url)).minter!.mint()).resolves.toBe(MINTED);
  });

  it("with exactly one OAuth key set, mint refuses without any network call", async () => {
    const api = await fake();
    for (const over of [{ tsOauthClientId: "" }, { tsOauthClientSecret: "" }]) {
      const { minter } = harness(config(api.url, over));
      expect(minter).not.toBeNull();
      expect(minter!.source).toBe("misconfigured");
      expect(minter!.problem).toMatch(/TS_OAUTH_CLIENT_ID and TS_OAUTH_CLIENT_SECRET/);
      expectClean([minter!.problem ?? ""]);
      expect((await codeOf(minter!.mint())).code).toBe("oauth_failed");
    }
    expect(api.seen).toHaveLength(0);
  });

  it("refuses an API URL that is not https (except loopback), or a tag that is not one plain tag", async () => {
    for (const over of [
      { tsApiUrl: "http://api.tailscale.example" }, // config-lint: ok (test fixture)
      { tsApiUrl: "not a url" },
      { tsApiUrl: "https://user:pw@api.tailscale.example" }, // config-lint: ok (test fixture)
      { tsOauthTag: "" },
      { tsOauthTag: "gpu" },
      { tsOauthTag: "tag:gpu,tag:admin" },
    ]) {
      const { minter } = harness(config("https://api.tailscale.example", over)); // config-lint: ok (test fixture)
      expect(minter!.source).toBe("misconfigured");
      expect((await codeOf(minter!.mint())).code).toBe("oauth_failed");
    }
  });
});

describe("createTsAuthKeyProvider", () => {
  it("file mode reads TS_AUTHKEY_FILE and logs the source", async () => {
    const logs: string[] = [];
    const reads: string[] = [];
    const p = createTsAuthKeyProvider(
      config("x", { tsOauthClientId: "", tsOauthClientSecret: "", tsAuthkeyFile: "/keys/ts" }), // config-lint: ok (test fixture)
      { log: (l, m) => logs.push(`${l} ${m}`), readKeyFile: async (f) => (reads.push(f), " tskey-auth-fromfile \n") },
    );
    expect(p.source).toBe("file");
    expect(logs).toEqual(["info tailscale auth key source: file"]);
    await expect(p.tsAuthKey()).resolves.toBe("tskey-auth-fromfile");
    expect(reads).toEqual(["/keys/ts"]); // config-lint: ok (test fixture)
  });

  it("oauth mode mints, logs the source and never reads the key file, even when minting fails", async () => {
    const api = await fake((req, res) => json(res, 500, {}));
    const logs: string[] = [];
    let reads = 0;
    const p = createTsAuthKeyProvider(config(api.url, { tsAuthkeyFile: "/keys/ts" }), { // config-lint: ok (test fixture)
      log: (l, m) => logs.push(`${l} ${m}`),
      readKeyFile: async () => (reads++, "tskey-auth-fromfile"),
      sleep: async () => undefined,
    });
    expect(p.source).toBe("oauth");
    expect(logs).toContain("info tailscale auth key source: oauth");
    expect((await codeOf(p.tsAuthKey())).code).toBe("tailscale_unavailable");
    expect(reads).toBe(0);
  });

  it("oauth mode hands each minted key to onSecret before returning it", async () => {
    const api = await fake();
    const secrets: string[] = [];
    const p = createTsAuthKeyProvider(config(api.url), { onSecret: (s) => secrets.push(s), log: () => undefined });
    const key = await p.tsAuthKey();
    expect(key).toBe(MINTED);
    expect(secrets).toContain(MINTED);
  });

  it("exactly one OAuth key set: loud startup line, Start refused, no key-file fallback", async () => {
    const api = await fake();
    for (const over of [{ tsOauthClientId: "" }, { tsOauthClientSecret: "" }]) {
      const logs: string[] = [];
      let reads = 0;
      const p = createTsAuthKeyProvider(config(api.url, { ...over, tsAuthkeyFile: "/keys/ts" }), { // config-lint: ok (test fixture)
        log: (l, m) => logs.push(`${l} ${m}`),
        readKeyFile: async () => (reads++, "tskey-auth-fromfile"),
      });
      expect(p.source).toBe("misconfigured");
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/^error tailscale auth key source: misconfigured/);
      expect(logs[0]).toContain("ts_key_mint_failed");
      expectClean(logs);
      await codeOf(p.tsAuthKey());
      expect(reads).toBe(0);
    }
    expect(api.seen).toHaveLength(0);
  });
});
