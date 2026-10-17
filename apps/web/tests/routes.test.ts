import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from "jose";
import type { FastifyInstance } from "fastify";
import {
  AgentClient,
  ComfyClient,
  Lifecycle,
  Registry,
  loadProfile,
  type AppsConfig,
  type CreateRequest,
  type DestroyOutcome,
  type InstanceRecord,
  type Offer,
  type VastInstance,
} from "@vast-comfy/core";
import { createAuth } from "../src/auth.js";
import { buildServer, registeredRoutes } from "../src/server.js";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const REGISTRY_SCHEMA = repo("contracts/instance-registry.schema.json");
const STATUS_SCHEMA = repo("contracts/status.schema.json");
const OPENAPI = repo("contracts/web.openapi.json");
const profile = loadProfile(repo("instance/profiles/image.yaml"));
const template = JSON.parse(readFileSync(repo(`instance/workflows/${profile.generate.workflow}`), "utf8"));

const ISSUER = "https://sso.example.test/application/o/vast/"; // config-lint: ok (test fixture)
const AUDIENCE = "vast-web";
const KID = "k1";
const ADMIN_GROUP = "authentik Admins";
const MEMBER_GROUP = "member";

const TOKEN = "agenttoken-SECRET-0123456789abcdef";
const AUTH_KEY = "tskey-auth-SECRETKEY0123456789";
const VAST_KEY = "fixturevastkeyaaaaaaaaaaaaaaaaaaa";
const HOST = "vast-abc123";
const VAST_ID = 900;
const NOW_S = 1_800_000_000;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("UNIQUE-IMAGE-MARKER-7f3a")]);

let signing: CryptoKey;
let resolver: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signing = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  resolver = createLocalJWKSet({ keys: [jwk] });
});

async function jwt(sub: string, groups: string[]): Promise<string> {
  return new SignJWT({ groups, preferred_username: sub })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(sub)
    .setExpirationTime("5m")
    .sign(signing);
}
const as = async (sub: string, groups: string[]) => ({ "x-authentik-jwt": await jwt(sub, groups) });
const admin = () => as("root", [ADMIN_GROUP]);
const member = (sub = "ayu") => as(sub, [MEMBER_GROUP]);

// ---- fake HTTP servers (agent and ComfyUI) ----

interface Seen { method: string; url: string; auth: string | undefined; body: string }
type Handler = (s: Seen, res: ServerResponse) => void;
const servers: Server[] = [];
const apps: FastifyInstance[] = [];

async function fakeServer(handler: () => Handler): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const s = { method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body: raw };
      seen.push(s);
      handler()(s, res);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, seen };
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

function agentStatus(state: string, over: Record<string, unknown> = {}) {
  return {
    schema_version: 1, state, reason: null, progress: null, now: NOW_S, boot_at: NOW_S, uptime_s: 99,
    idle_destroy_at: NOW_S + 1800, failsafe_at: NOW_S + 3600, hard_cap_at: NOW_S + 7200,
    queue: { running: 0, pending: 0 }, gpu: {}, profile: "image", commit: "deadbeef", failsafe_alive: true,
    destroy: { pending: false, attempts: 0 }, ...over,
  };
}

class FakeVast {
  offers: Offer[] = [{ id: 11, dph_total: 0.3, gpu_name: "RTX A5000" }];
  instances: VastInstance[] = [];
  listError: Error | null = null;
  creates = 0;
  nextId = 1000;
  async searchOffers(): Promise<Offer[]> {
    return this.offers;
  }
  async createInstance(_offer: number, req: CreateRequest): Promise<{ id: number }> {
    this.creates++;
    const id = this.nextId++;
    this.instances.push({ id, label: req.label, actual_status: "loading", start_date: NOW_S, dph_total: 0.3 });
    return { id };
  }
  async listInstances(): Promise<VastInstance[]> {
    if (this.listError) throw this.listError;
    return this.instances.map((i) => ({ ...i }));
  }
  async destroyInstance(id: number): Promise<DestroyOutcome> {
    this.instances = this.instances.filter((i) => i.id !== id);
    return "destroyed";
  }
}

// ---- harness ----

interface Harness {
  app: FastifyInstance;
  vast: FakeVast;
  registry: Registry;
  dir: string;
  publicDir: string;
  agentSeen: Seen[];
  comfySeen: Seen[];
  setAgent(h: Handler): void;
  setComfy(h: Handler): void;
  clock: { ms: number };
}

let h: Harness;

async function harness(opts: { ready?: boolean; cfg?: Record<string, unknown> } = {}): Promise<Harness> {
  let agentHandler: Handler = (s, res) => {
    if (s.url === "/status") return json(res, 200, agentStatus("ready"));
    if (s.url === "/destroy") return json(res, 200, {});
    if (s.url === "/extend") return json(res, 200, { kind: "idle", deadline: NOW_S + 999 });
    json(res, 404, {});
  };
  let comfyHandler: Handler = (_s, res) => json(res, 500, {});
  const agent = await fakeServer(() => agentHandler);
  const comfy = await fakeServer(() => comfyHandler);
  const dir = mkdtempSync(join(tmpdir(), "web-routes-"));
  const publicDir = join(dir, "public");
  mkdirSync(publicDir);
  const cfg = {
    authentikJwksUrl: "https://sso.example.test/jwks/", // config-lint: ok (test fixture)
    authentikIssuer: ISSUER,
    authentikAudience: AUDIENCE,
    webAdminGroup: ADMIN_GROUP,
    webMemberGroup: MEMBER_GROUP,
    vastApiKey: VAST_KEY,
    repoUrl: "https://example.invalid/repo.git", // config-lint: ok (test fixture)
    repoCommit: "deadbeef",
    profile: "image",
    vastImage: "vastai/comfy:v0.41.0-cuda-12.9-py312",
    vastDiskGb: 50,
    vastMinVramGb: 24,
    vastMaxDph: "0.50",
    vastMinDownloadMbps: 500,
    vastMinReliability: "0.98",
    vastAllowedGpus: [],
    comfyPort: comfy.port,
    agentPort: agent.port,
    httpTimeoutSApps: 5,
    webJsonMaxBytes: 65536,
    webImageMaxBytes: 65536,
    webRequestTimeoutS: 30,
    webConnectionTimeoutS: 60,
    webKeepaliveTimeoutS: 75,
    startIdleMinutes: 30,
    startFailsafeHours: 3,
    startHardCapHours: 6,
    bootTimeoutMin: 25,
    unreachableDestroyMin: 15,
    reconcileGraceMin: 10,
    webDestroyRetries: 1,
    webDestroyBackoffS: 0,
    statusPollS: 1,
    generateMaxPromptChars: 50,
    generateTimeoutS: 600,
    startRateLimitPerHour: 2,
    webBodyLimitBytes: 4096,
    webJobCacheMax: 10,
    webJobTtlS: 3600,
    webExtendMaxMinutes: 120,
    webGenerateRateLimitPerHour: 50,
    secretNames: ["VAST_API_KEY"],
    ...opts.cfg,
  } as unknown as AppsConfig;

  const registry = new Registry(join(dir, "registry.json"), REGISTRY_SCHEMA);
  const vast = new FakeVast();
  const clock = { ms: NOW_S * 1000 };
  let n = 0;
  const lifecycle = new Lifecycle({
    cfg,
    vast,
    registry,
    agentFor: (r: InstanceRecord) => new AgentClient("127.0.0.1", cfg, r.agent_token, STATUS_SCHEMA),
    clock: () => clock.ms / 1000,
    tsAuthKey: async () => AUTH_KEY,
    newToken: () => TOKEN,
    newHostname: () => `vast-new${n++}`,
    sleep: async () => undefined,
  });
  if (opts.ready !== false) {
    await registry.begin({ created_at: NOW_S, profile: "image", agent_token: TOKEN, tailnet_hostname: HOST });
    await registry.update(HOST, { status: "ready", vast_instance_id: VAST_ID, vast_start_date: NOW_S });
    vast.instances.push({ id: VAST_ID, label: `vastcomfy:${HOST}`, actual_status: "running", start_date: NOW_S, dph_total: 0.3 });
  }
  const auth = createAuth(cfg, resolver, { onMisconfigured: () => undefined });
  const app = buildServer({
    cfg,
    auth,
    lifecycle,
    registry,
    comfyFor: () => new ComfyClient("127.0.0.1", cfg),
    profile,
    template,
    publicDir,
    secrets: () => [VAST_KEY, AUTH_KEY],
    now: () => clock.ms,
  });
  apps.push(app);
  await app.ready();
  return {
    app, vast, registry, dir, publicDir, clock,
    agentSeen: agent.seen,
    comfySeen: comfy.seen,
    setAgent: (fn) => (agentHandler = fn),
    setComfy: (fn) => (comfyHandler = fn),
  };
}

beforeEach(async () => {
  h = await harness();
});

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    s.close();
  }
});

type Method = "GET" | "POST";
async function call(method: Method, url: string, headers: Record<string, string> = {}, payload?: unknown) {
  return h.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
}
const post = (url: string, headers: Record<string, string>, payload: unknown = {}) => call("POST", url, headers, payload);

const okGen = { prompt: "a fox", preset: "preview", size: "1:1" };

function comfyDone(images: unknown[]): Handler {
  return (s, res) => {
    if (s.url === "/prompt") return json(res, 200, { prompt_id: "p-1" });
    if (s.url.startsWith("/history/")) {
      return json(res, 200, { "p-1": { outputs: { "10": { images } }, status: { completed: true, status_str: "success" } } });
    }
    if (s.url.startsWith("/view")) {
      res.writeHead(200, { "Content-Type": "image/png" });
      return res.end(PNG);
    }
    json(res, 404, {});
  };
}

// ---- tests ----

describe("auth gate", () => {
  it("401 without identity on every /api route, even unknown ones", async () => {
    const routes = registeredRoutes(h.app).filter((r) => r.url.startsWith("/api/"));
    expect(routes.length).toBeGreaterThan(5);
    for (const r of routes) {
      const url = r.url.replace(":id", "p-1").replace(":index", "0");
      const res = await call(r.method as Method, url, {}, r.method === "POST" ? {} : undefined);
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
      expect(res.json()).toEqual({ error: { code: "unauthenticated", message: expect.any(String) } });
    }
    expect((await call("GET", "/api/nope")).statusCode).toBe(401);
    expect((await call("GET", "/API/state")).statusCode).toBe(401);
  });

  it("401 for forged plain identity headers and for a user outside both groups (403)", async () => {
    const forged = await call("GET", "/api/state", { "x-authentik-username": "root", "x-authentik-groups": ADMIN_GROUP });
    expect(forged.statusCode).toBe(401);
    const outsider = await call("GET", "/api/state", await as("eve", ["authentik Read-only"]));
    expect(outsider.statusCode).toBe(403);
  });

  it("403 for a member on start, estimate, destroy, extend and destroy-unknown", async () => {
    const m = await member();
    const cases: [Method, string, unknown][] = [
      ["POST", "/api/start", { confirm: true }],
      ["GET", "/api/estimate", undefined],
      ["POST", "/api/destroy", {}],
      ["POST", "/api/extend", { kind: "idle", minutes: 10 }],
      ["POST", "/api/destroy-unknown", { vast_id: 5 }],
    ];
    for (const [method, url, body] of cases) {
      const res = await call(method, url, m, body);
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
    }
    expect(h.vast.creates).toBe(0);
    expect(h.agentSeen.filter((s) => s.url !== "/status")).toHaveLength(0);
  });

  it("unknown routes are 404 with a JSON error", async () => {
    const res = await call("GET", "/api/nope", await member());
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "not_found", message: "not found" } });
    const page = await call("GET", "/does-not-exist.html");
    expect(page.statusCode).toBe(404);
    expect(page.json().error.code).toBe("not_found");
    expect((await call("GET", "/../../etc/passwd")).statusCode).toBe(404);
  });
});

describe("healthz and static", () => {
  it("healthz needs no auth and returns only {ok: true}", async () => {
    const res = await call("GET", "/healthz");
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"ok":true}');
  });

  it("serves the public page with strict headers and tolerates an empty directory", async () => {
    const empty = await call("GET", "/");
    expect(empty.statusCode).toBe(404);
    writeFileSync(join(h.publicDir, "index.html"), "<!doctype html><title>x</title>");
    const page = await call("GET", "/");
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toMatch(/^text\/html/);
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["access-control-allow-origin"]).toBeUndefined();
    writeFileSync(join(h.dir, "secret.txt"), "nope");
    expect((await call("GET", "/%2e%2e/secret.txt")).statusCode).toBe(404);
    writeFileSync(join(h.publicDir, ".env"), "nope");
    expect((await call("GET", "/.env")).statusCode).toBe(404);
  });

  it("API responses carry no CORS headers and are not cacheable", async () => {
    const res = await call("GET", "/api/state", { ...(await member()), origin: "https://evil.example.test" }); // config-lint: ok (test fixture)
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.headers).filter((k) => k.startsWith("access-control-"))).toEqual([]);
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("request hygiene", () => {
  it("415 on a POST without application/json", async () => {
    const a = await admin();
    const res = await h.app.inject({ method: "POST", url: "/api/destroy", headers: { ...a, "content-type": "text/plain" }, payload: "{}" });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe("unsupported_media_type");
    const none = await h.app.inject({ method: "POST", url: "/api/destroy", headers: a });
    expect(none.statusCode).toBe(415);
    const form = await h.app.inject({
      method: "POST", url: "/api/generate", headers: { ...(await member()), "content-type": "application/x-www-form-urlencoded" }, payload: "prompt=x",
    });
    expect(form.statusCode).toBe(415);
    expect(h.comfySeen).toHaveLength(0);
  });

  it("refuses cross-site POSTs, oversized bodies, bad JSON and unknown fields", async () => {
    const a = await admin();
    expect((await post("/api/destroy", { ...a, "sec-fetch-site": "cross-site" })).statusCode).toBe(403);
    const big = await post("/api/generate", await member(), { ...okGen, prompt: "x".repeat(5000) });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe("body_too_large");
    const bad = await h.app.inject({ method: "POST", url: "/api/destroy", headers: { ...a, "content-type": "application/json" }, payload: "{oops" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("invalid_json");
    expect(bad.body).not.toMatch(/at .*\.ts/);
    const extra = await post("/api/start", a, { confirm: true, offer_id: 1 });
    expect(extra.statusCode).toBe(400);
    expect((await post("/api/start", a, { confirm: "true" })).statusCode).toBe(400);
    expect(h.vast.creates).toBe(0);
  });
});

describe("GET /api/state", () => {
  it("returns view, role, presets and sizes, and never a secret or the agent hostname", async () => {
    h.setAgent((s, res) =>
      json(res, 200, agentStatus("failed", {
        reason: `boot failed for ${HOST} token ${TOKEN} key ${AUTH_KEY}`,
        destroy: { pending: false, attempts: 1, last_error: `Bearer ${TOKEN} ${VAST_KEY}` },
      })),
    );
    h.vast.instances.push({ id: 77, label: "vastcomfy:vast-stray9", actual_status: "running", start_date: NOW_S, dph_total: 0.2 });
    for (const who of [await admin(), await member()]) {
      const res = await call("GET", "/api/state", who);
      expect(res.statusCode).toBe(200);
      for (const secret of [TOKEN, AUTH_KEY, VAST_KEY, HOST, "vast-stray9", "agent_token", "tailnet_hostname", "127.0.0.1"]) {
        expect(res.body).not.toContain(secret);
      }
      const body = res.json();
      expect(body.presets).toEqual(profile.generate.qualityPresets.map((p) => ({ name: p.name, steps: p.steps })));
      expect(body.sizes.map((s: { name: string }) => s.name)).toEqual(profile.generate.sizes.map((s) => s.name));
      expect(body.state).toBe("failed");
    }
    const adminBody = (await call("GET", "/api/state", await admin())).json();
    expect(adminBody.role).toBe("admin");
    expect(adminBody.unknown).toEqual([{ vast_instance_id: 77, actual_status: "running", start_date: NOW_S, dph: 0.2 }]);
    const memberBody = (await call("GET", "/api/state", await member())).json();
    expect(memberBody.role).toBe("member");
    expect(memberBody.unknown).toEqual([]);
  });

  it("redacts a Vast error that echoes the key", async () => {
    h.vast.listError = new Error(`401 from https://console.vast.ai/api/v0/?api_key=${VAST_KEY}`); // config-lint: ok (test fixture)
    const res = await call("GET", "/api/state", await admin());
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(VAST_KEY);
    expect(res.json().vast_error).toEqual(expect.any(String));
  });
});

describe("start, estimate, destroy, extend", () => {
  it("estimate and start work for an admin; start is rate limited with 429", async () => {
    h = await harness({ ready: false });
    const a = await admin();
    const est = await call("GET", "/api/estimate", a);
    expect(est.statusCode).toBe(200);
    expect(est.json()).toMatchObject({ offer_id: 11, dph: 0.3, horizon_hours: 3 });
    const first = await post("/api/start", a, { confirm: true });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: "booting", vast_instance_id: 1000, estimate: { offer_id: 11 } });
    for (const s of [TOKEN, AUTH_KEY, VAST_KEY, "vast-new0"]) expect(first.body).not.toContain(s);
    const second = await post("/api/start", a, { confirm: true });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("already_active");
    const third = await post("/api/start", a, { confirm: true });
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe("rate_limited");
    expect(h.vast.creates).toBe(1);
    h.clock.ms += 3_600_001;
    expect((await post("/api/start", a, { confirm: true })).statusCode).toBe(409);
  });

  it("start maps no offers to 503", async () => {
    h = await harness({ ready: false });
    h.vast.offers = [];
    const res = await post("/api/start", await admin(), { confirm: true });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("no_offers");
  });

  it("destroy calls the agent and Vast and reports the outcome", async () => {
    const res = await post("/api/destroy", await admin());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: "destroyed", agent_reached: true });
    expect(await h.registry.active()).toBeNull();
  });

  it("extend validates input and relays the agent refusal as 422", async () => {
    const a = await admin();
    for (const body of [{ kind: "hard_cap", minutes: 10 }, { kind: "idle", minutes: 0 }, { kind: "idle", minutes: 1.5 },
      { kind: "idle", minutes: "10" }, { kind: "idle", minutes: 121 }, { kind: "idle" }]) {
      expect((await post("/api/extend", a, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(h.agentSeen.filter((s) => s.url === "/extend")).toHaveLength(0);
    const ok = await post("/api/extend", a, { kind: "idle", minutes: 30 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ kind: "idle", deadline: NOW_S + 999 });
    h.setAgent((s, res) => {
      if (s.url === "/extend") return json(res, 400, { detail: { code: "beyond_hard_cap", message: "would pass the hard cap; at most 12 minutes left" } });
      json(res, 200, agentStatus("ready"));
    });
    const refused = await post("/api/extend", a, { kind: "failsafe", minutes: 60 });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toEqual({ error: { code: "extend_refused", message: "would pass the hard cap; at most 12 minutes left" } });
    expect(refused.body).not.toContain(TOKEN);
  });

  it("destroy-unknown validates the id and refuses non-project instances", async () => {
    const a = await admin();
    expect((await post("/api/destroy-unknown", a, { vast_id: "5" })).statusCode).toBe(400);
    expect((await post("/api/destroy-unknown", a, { vast_id: -1 })).statusCode).toBe(400);
    h.vast.instances.push({ id: 5, label: "someone-else", actual_status: "running", start_date: NOW_S, dph_total: 1 });
    h.vast.instances.push({ id: 6, label: "vastcomfy:vast-stray", actual_status: "running", start_date: NOW_S, dph_total: 1 });
    const refused = await post("/api/destroy-unknown", a, { vast_id: 5 });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("refused");
    expect((await post("/api/destroy-unknown", a, { vast_id: VAST_ID })).statusCode).toBe(409);
    const ok = await post("/api/destroy-unknown", a, { vast_id: 6 });
    expect(ok.json()).toEqual({ outcome: "destroyed" });
    // A plain failure is not a refusal: generic 502, no message relayed.
    h.vast.listError = new Error(`boom ${VAST_KEY}`);
    const failed = await post("/api/destroy-unknown", a, { vast_id: 6 });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error.code).toBe("vast_unavailable");
    expect(failed.body).not.toContain("boom");
  });
});

describe("generate", () => {
  it("rejects bad input with 400 and the service error code, never calling ComfyUI", async () => {
    const m = await member();
    const bad: [unknown, string][] = [
      [{ ...okGen, prompt: "" }, "invalid_prompt"],
      [{ ...okGen, prompt: "x".repeat(51) }, "prompt_too_long"],
      [{ ...okGen, preset: "ultra" }, "unknown_preset"],
      [{ ...okGen, size: "8000x8000" }, "unknown_size"],
      [{ ...okGen, seed: -1 }, "invalid_seed"],
      [{ ...okGen, seed: "1" }, "invalid_seed"],
      [{ ...okGen, workflow: {} }, "invalid_body"],
      [{ prompt: "x" }, "invalid_body"],
    ];
    for (const [body, code] of bad) {
      const res = await post("/api/generate", m, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe(code);
    }
    expect(h.comfySeen).toHaveLength(0);
  });

  it("409 when the instance is not ready (booting, or none)", async () => {
    h.setAgent((_s, res) => json(res, 200, agentStatus("downloading")));
    const res = await post("/api/generate", await member(), okGen);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("not_ready");
    h = await harness({ ready: false });
    expect((await post("/api/generate", await member(), okGen)).statusCode).toBe(409);
    expect(h.comfySeen).toHaveLength(0);
  });

  it("submits, polls lazily, returns indexes only, and serves the image without touching disk", async () => {
    h.setComfy(comfyDone([{ filename: "ComfyUI_0001.png", subfolder: "", type: "output" }]));
    const m = await member();
    const sub = await post("/api/generate", m, okGen);
    expect(sub.statusCode).toBe(202);
    expect(sub.json()).toEqual({ id: "p-1" });
    const sent = JSON.parse(h.comfySeen[0]!.body).prompt;
    expect(sent["5"].inputs.text).toBe("a fox");

    const before = snapshot([tmpdir(), h.dir]);
    const poll = await call("GET", "/api/generate/p-1", m);
    expect(poll.statusCode).toBe(200);
    expect(poll.json()).toEqual({ status: "done", images: [{ index: 0, url: "/api/image/p-1/0" }] });
    expect(poll.body).not.toContain("ComfyUI_0001");
    const img = await call("GET", "/api/image/p-1/0", m);
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.headers["cache-control"]).toBe("no-store");
    expect(img.rawPayload.equals(PNG)).toBe(true);
    expect(newFilesWith(before, [tmpdir(), h.dir], PNG)).toEqual([]);
    expect((await call("GET", "/api/image/p-1/1", m)).statusCode).toBe(404);
  });

  it("reports pending while ComfyUI has no history, and failed with a short message", async () => {
    let state: "pending" | "error" = "pending";
    h.setComfy((s, res) => {
      if (s.url === "/prompt") return json(res, 200, { prompt_id: "p-1" });
      if (state === "pending") return json(res, 200, {});
      json(res, 200, { "p-1": { outputs: {}, prompt: [`${HOST}`], status: { status_str: "error", messages: [["execution_error", {
        node_type: "KSampler", exception_message: `CUDA out of memory on ${HOST}`,
      }]] } } });
    });
    const m = await member();
    await post("/api/generate", m, okGen);
    expect((await call("GET", "/api/generate/p-1", m)).json()).toEqual({ status: "pending" });
    state = "error";
    const failed = await call("GET", "/api/generate/p-1", m);
    expect(failed.json()).toEqual({ status: "failed", message: expect.stringContaining("CUDA out of memory") });
    expect(failed.body).not.toContain(HOST);
  });

  it("times out a job that stays pending past GENERATE_TIMEOUT_S", async () => {
    h.setComfy((s, res) => (s.url === "/prompt" ? json(res, 200, { prompt_id: "p-1" }) : json(res, 200, {})));
    const m = await member();
    await post("/api/generate", m, okGen);
    h.clock.ms += 600_000;
    expect((await call("GET", "/api/generate/p-1", m)).json()).toEqual({ status: "failed", message: "generation timed out" });
  });

  it("maps an unreachable ComfyUI during a poll to 502 without internals", async () => {
    h.setComfy((s, res) => {
      if (s.url === "/prompt") return json(res, 200, { prompt_id: "p-1" });
      res.destroy();
    });
    const m = await member();
    await post("/api/generate", m, okGen);
    const res = await call("GET", "/api/generate/p-1", m);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: { code: "comfy_unavailable", message: "ComfyUI could not be reached" } });
  });

  it("another member cannot read someone else's job or image; an admin can", async () => {
    h.setComfy(comfyDone([{ filename: "a.png", subfolder: "", type: "output" }]));
    await post("/api/generate", await member("ayu"), okGen);
    const other = await member("budi");
    expect((await call("GET", "/api/generate/p-1", other)).statusCode).toBe(404);
    expect((await call("GET", "/api/image/p-1/0", other)).statusCode).toBe(404);
    expect((await call("GET", "/api/generate/p-1", await admin())).json().status).toBe("done");
    expect((await call("GET", "/api/image/p-1/0", other)).statusCode).toBe(404);
    expect((await call("GET", "/api/image/p-1/0", await member("ayu"))).statusCode).toBe(200);
  });

  it("rejects a traversal filename from a hostile ComfyUI history without fetching it", async () => {
    h.setComfy(comfyDone([{ filename: "../../../etc/passwd", subfolder: "", type: "output" }]));
    const m = await member();
    await post("/api/generate", m, okGen);
    expect((await call("GET", "/api/generate/p-1", m)).json().status).toBe("done");
    const res = await call("GET", "/api/image/p-1/0", m);
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("image_rejected");
    expect(res.body).not.toContain("passwd");
    expect(h.comfySeen.filter((s) => s.url.startsWith("/view"))).toHaveLength(0);
  });

  it("refuses to relay a non-image body from ComfyUI", async () => {
    h.setComfy((s, res) => {
      if (s.url.startsWith("/view")) {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end("<script>alert(1)</script>");
      }
      comfyDone([{ filename: "a.png", subfolder: "", type: "output" }])(s, res);
    });
    const m = await member();
    await post("/api/generate", m, okGen);
    await call("GET", "/api/generate/p-1", m);
    const res = await call("GET", "/api/image/p-1/0", m);
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain("<script>");
  });

  it("maps an oversized /view (honest content-length or endless chunked) to 502 image_too_large", async () => {
    const LIMIT = 65536;
    for (const mode of ["length", "chunked"] as const) {
      let written = 0;
      h.setComfy((s, res) => {
        if (!s.url.startsWith("/view")) return comfyDone([{ filename: "a.png", subfolder: "", type: "output" }])(s, res);
        res.writeHead(200, mode === "length"
          ? { "Content-Type": "image/png", "Content-Length": String(64 * 1024 * 1024) }
          : { "Content-Type": "image/png" });
        const chunk = Buffer.alloc(8192, 7);
        const timer = setInterval(() => {
          if (res.destroyed || written > 64 * 1024 * 1024) return clearInterval(timer);
          res.write(chunk);
          written += chunk.length;
        }, 1);
      });
      const m = await member();
      await post("/api/generate", m, okGen);
      await call("GET", "/api/generate/p-1", m);
      const res = await call("GET", "/api/image/p-1/0", m);
      expect(res.statusCode, mode).toBe(502);
      expect(res.json()).toEqual({ error: { code: "image_too_large", message: expect.any(String) } });
      await new Promise((r) => setTimeout(r, 50));
      const at = written;
      await new Promise((r) => setTimeout(r, 50));
      expect(written, `${mode}: server still writing`).toBe(at);
      expect(written).toBeLessThan(LIMIT * 4);
      h = await harness();
    }
  });

  it("maps an oversized /history to 502 upstream_too_large and fails the job", async () => {
    h.setComfy((s, res) =>
      s.url === "/prompt" ? json(res, 200, { prompt_id: "p-1" }) : json(res, 200, { "p-1": { junk: "x".repeat(70000) } }),
    );
    const m = await member();
    await post("/api/generate", m, okGen);
    const res = await call("GET", "/api/generate/p-1", m);
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("upstream_too_large");
    expect((await call("GET", "/api/generate/p-1", m)).json()).toEqual({ status: "failed", message: expect.any(String) });
  });

  it("rejects malformed job ids and image indexes", async () => {
    const m = await member();
    expect((await call("GET", "/api/generate/..%2F..%2Fetc", m)).statusCode).toBe(400);
    expect((await call("GET", "/api/image/p-1/-1", m)).statusCode).toBe(400);
  });
});

describe("server timeouts", () => {
  it("come from config", () => {
    expect(h.app.initialConfig).toMatchObject({ requestTimeout: 30_000, connectionTimeout: 60_000, keepAliveTimeout: 75_000 });
  });
});

describe("OpenAPI contract", () => {
  it("lists exactly the registered routes", () => {
    const doc = JSON.parse(readFileSync(OPENAPI, "utf8")) as { paths: Record<string, Record<string, unknown>> };
    const toOpenApi = (url: string) => url.replace(/:(\w+)/g, "{$1}").replace(/\*$/, "{path}");
    const registered = registeredRoutes(h.app).map((r) => `${r.method} ${toOpenApi(r.url)}`).sort();
    const documented = Object.entries(doc.paths)
      .flatMap(([path, ops]) => Object.keys(ops).filter((k) => k !== "parameters").map((m) => `${m.toUpperCase()} ${path}`))
      .sort();
    expect(documented).toEqual(registered);
  });
});

// ---- disk helpers: the image route must not write the image anywhere ----

function listFiles(root: string, depth = 2): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (dir: string, d: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(dir, name);
      try {
        const st = statSync(p);
        if (st.isFile()) out.set(p, st.mtimeMs);
        else if (st.isDirectory() && d > 0) walk(p, d - 1);
      } catch {
        // vanished between readdir and stat
      }
    }
  };
  walk(root, depth);
  return out;
}

function snapshot(roots: string[]): Map<string, number> {
  const all = new Map<string, number>();
  for (const r of roots) for (const [p, m] of listFiles(r)) all.set(p, m);
  return all;
}

/** Files that are new or changed since `before` and contain `marker`. */
function newFilesWith(before: Map<string, number>, roots: string[], marker: Buffer): string[] {
  const hits: string[] = [];
  for (const [p, m] of snapshot(roots)) {
    if (before.get(p) === m) continue;
    try {
      if (readFileSync(p).includes(marker)) hits.push(p);
    } catch {
      // unreadable or vanished
    }
  }
  return hits;
}
