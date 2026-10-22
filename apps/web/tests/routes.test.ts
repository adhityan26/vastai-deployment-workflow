import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJwt } from "jose";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import {
  AgentClient,
  ComfyClient,
  Gallery,
  Lifecycle,
  MemoryObjectStore,
  Registry,
  STOP_REASONS,
  TailscaleError,
  UsageHistory,
  loadProfile,
  type AppsConfig,
  type CreateRequest,
  type DestroyOutcome,
  type InstanceRecord,
  type Offer,
  type OfferFilters,
  type VastInstance,
} from "@vast-comfy/core";
import { createAuthStack } from "../src/auth.js";
import { LOGIN_ERROR_CODES } from "../src/auth-routes.js";
import { SESSION_COOKIE, TRANSACTION_COOKIE, cookieNames, type Sessions } from "../src/session.js";
import type { OidcIdentity } from "../src/oidc.js";
import { buildServer, registeredRoutes } from "../src/server.js";
import { CLIENT_ID, CLIENT_SECRET, startFakeIdp, type FakeIdp } from "./fake-idp.js";
import { JPEG, PNG_IMG, acceptWebSockets, previewFrame, textFrame, until, type Peer, type WsOptions } from "../../core/tests/fake-ws.js";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const REGISTRY_SCHEMA = repo("contracts/instance-registry.schema.json");
const STATUS_SCHEMA = repo("contracts/status.schema.json");
const OPENAPI = repo("contracts/web.openapi.json");
const profile = loadProfile(repo("instance/profiles/image.yaml"));
const template = JSON.parse(readFileSync(repo(`instance/workflows/${profile.generate.workflow}`), "utf8"));
const upscaleTemplate = JSON.parse(readFileSync(repo("instance/workflows/image-upscale.json"), "utf8"));
const editTemplate = JSON.parse(readFileSync(repo(`instance/workflows/${profile.edit!.workflow}`), "utf8"));
const videoTemplate = JSON.parse(readFileSync(repo("instance/workflows/video-ti2v.json"), "utf8"));

const PUBLIC_ORIGIN = "https://comfy.example.test"; // config-lint: ok (test fixture)
const SESSION_SECRET = "test-session-secret-0123456789abcdef";
const NAMES = cookieNames(true);
const ADMIN_GROUP = "authentik Admins";
const MEMBER_GROUP = "member";

const TOKEN = "agenttoken-SECRET-0123456789abcdef";
const AUTH_KEY = "tskey-auth-SECRETKEY0123456789";
const VAST_KEY = "fixturevastkeyaaaaaaaaaaaaaaaaaaa";
const HOST = "vast-abc123";
const VAST_ID = 900;
const NOW_S = 1_800_000_000;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("UNIQUE-IMAGE-MARKER-7f3a")]);

let idp: FakeIdp;
/** Every ID token the fake IdP minted in this file (they must never leave the server). */
const mintedTokens: string[] = [];

beforeAll(async () => {
  idp = await startFakeIdp();
});

afterAll(async () => {
  await idp.close();
});

// ---- login through the fake IdP (the real /auth/login and /auth/callback routes) ----

type Res = LightMyRequestResponse;

function setCookies(res: Res): string[] {
  const v = res.headers["set-cookie"];
  return v === undefined ? [] : [v].flat().map(String);
}
/** "name=value" of a Set-Cookie line. */
const pairOf = (line: string) => line.split(";")[0]!;
/** The session cookie a response sets (not a clearing one), or undefined. */
const sessionSet = (res: Res) => setCookies(res).find((c) => c.startsWith(`${NAMES.session}=`) && !c.startsWith(`${NAMES.session}=;`));

interface Flow { start: Res; cb: Res; tx: string; code: string; state: string }

/** Browser round trip: /auth/login -> (IdP) -> /auth/callback. `edit` may tamper with the callback. */
async function loginFlow(
  groups: string[],
  opts: { sub?: string; next?: string; claims?: Record<string, unknown>; edit?: (q: { code: string; state: string; cookie: string }) => { query: string; cookie?: string } } = {},
): Promise<Flow> {
  const sub = opts.sub ?? "user-1";
  const next = opts.next === undefined ? "" : `?next=${encodeURIComponent(opts.next)}`;
  const start = await h.app.inject({ method: "GET", url: `/auth/login${next}` });
  expect(start.statusCode).toBe(302);
  // A relative /?login_error=... here means the login could not reach the fake IdP (discovery).
  expect(String(start.headers.location ?? ""), "the /auth/login redirect must go to the fake IdP, not to an error page")
    .toMatch(new RegExp(`^${idp.base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`));
  const tx = pairOf(setCookies(start)[0] ?? "");
  const { code, state } = idp.authorize(String(start.headers.location), {}, {
    idToken: async (nonce) => {
      const t = await idp.mint({ nonce, sub, claims: { groups, preferred_username: sub, ...(opts.claims ?? {}) } });
      mintedTokens.push(t);
      return t;
    },
  });
  const edited = opts.edit?.({ code, state, cookie: tx });
  const query = edited?.query ?? `code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
  const cookie = edited ? edited.cookie : tx;
  const cb = await h.app.inject({ method: "GET", url: `/auth/callback?${query}`, headers: cookie === undefined ? {} : { cookie } });
  return { start, cb, tx, code, state };
}

type Creds = { cookie: string; origin: string };

/** Log in and return the headers a same-origin page request would carry. */
async function loginAs(groups: string[], sub = "user-1"): Promise<Creds> {
  const { cb } = await loginFlow(groups, { sub });
  const session = sessionSet(cb);
  if (session === undefined) throw new Error(`login failed: ${String(cb.headers.location)}`);
  return { cookie: pairOf(session), origin: PUBLIC_ORIGIN };
}
const as = (sub: string, groups: string[]) => loginAs(groups, sub);
const admin = () => as("root", [ADMIN_GROUP]);
const member = (sub = "ayu") => as(sub, [MEMBER_GROUP]);

/** A session cookie minted directly (for identities the login refuses, e.g. role none). */
async function cookieOf(groups: string[], sub = "user-1"): Promise<Creds> {
  const identity: OidcIdentity = { subject: sub, username: sub, name: null, email: null, groups };
  return { cookie: `${NAMES.session}=${await h.sessions!.issue(identity)}`, origin: PUBLIC_ORIGIN };
}

// ---- fake HTTP servers (agent and ComfyUI) ----

interface Seen { method: string; url: string; auth: string | undefined; body: string }
type Handler = (s: Seen, res: ServerResponse) => void;
const servers: Server[] = [];
/** Upgraded sockets are not closed with their server: every harness's peers, destroyed after each test. */
const wsPeerLists: Peer[][] = [];
const apps: FastifyInstance[] = [];
/** Per-harness temp directories, removed after each test (they used to pile up in the tmpdir). */
const tempDirs: string[] = [];

async function fakeServer(handler: () => Handler): Promise<{ port: number; seen: Seen[]; server: Server }> {
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
  return { port: (server.address() as AddressInfo).port, seen, server };
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
  offers: Offer[] = [{ id: 11, dph_total: 0.3, gpu_name: "RTX A5000", gpu_ram: 24564 }];
  instances: VastInstance[] = [];
  listError: Error | null = null;
  creates = 0;
  searches: OfferFilters[] = [];
  nextId = 1000;
  logText = "";
  logCalls = 0;
  async instanceLogs(): Promise<string> {
    this.logCalls++;
    return this.logText;
  }
  async searchOffers(filters: OfferFilters): Promise<Offer[]> {
    this.searches.push(filters);
    return this.offers;
  }
  createdOffers: number[] = [];
  async createInstance(offer: number, req: CreateRequest): Promise<{ id: number }> {
    this.creates++;
    this.createdOffers.push(offer);
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
  lifecycle: Lifecycle;
  dir: string;
  publicDir: string;
  agentSeen: Seen[];
  comfySeen: Seen[];
  setAgent(h: Handler): void;
  setComfy(h: Handler): void;
  clock: { ms: number };
  sessions: Sessions | null;
  logs: string[];
  creditReads: { n: number };
  galleryStore: MemoryObjectStore;
  /** Websocket peers of the fake ComfyUI (only progress-enabled harnesses open any). */
  comfyWs: { peers: Peer[]; nextPeer(): Promise<Peer> };
}

let h: Harness;

async function harness(
  opts: {
    ready?: boolean;
    cfg?: Record<string, unknown>;
    extraRoutes?: (app: FastifyInstance) => void;
    authKey?: () => Promise<string>;
    profile?: typeof profile;
    /** undefined keeps the shipped edit workflow; null turns edit off. */
    editTemplate?: unknown;
    /** The Vast credit source; null leaves it unconfigured. Defaults to a counting fake. */
    credit?: (() => Promise<number>) | null;
    /** null turns the gallery off; undefined gives an in-memory one with small limits. */
    gallery?: Gallery | null;
    /** How the fake ComfyUI answers websocket upgrades. */
    ws?: WsOptions;
    /** undefined: the shipped video workflow when the profile enables video; null turns video off. */
    videoTemplate?: unknown;
  } = {},
): Promise<Harness> {
  let agentHandler: Handler = (s, res) => {
    if (s.url === "/status") return json(res, 200, agentStatus("ready"));
    if (s.url === "/destroy") return json(res, 200, {});
    if (s.url === "/extend") return json(res, 200, { kind: "idle", deadline: NOW_S + 999 });
    json(res, 404, {});
  };
  let comfyHandler: Handler = (_s, res) => json(res, 500, {});
  const agent = await fakeServer(() => agentHandler);
  const comfy = await fakeServer(() => comfyHandler);
  const comfyWs = acceptWebSockets(comfy.server, opts.ws);
  wsPeerLists.push(comfyWs.peers);
  const dir = mkdtempSync(join(tmpdir(), "web-routes-"));
  tempDirs.push(dir);
  const publicDir = join(dir, "public");
  mkdirSync(publicDir);
  const cfg = {
    authentikIssuer: idp.issuer,
    authentikClientId: CLIENT_ID,
    authentikClientSecret: CLIENT_SECRET,
    webPublicUrl: PUBLIC_ORIGIN,
    webSessionSecret: SESSION_SECRET,
    webSessionTtlH: 8,
    webOidcSkewS: 0,
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
    startOfferListMax: 3,
    vastMinReliability: "0.98",
    vastAllowedGpus: ["RTX A5000", "RTX 3090", "RTX 4090"],
    comfyPort: comfy.port,
    agentPort: agent.port,
    // Generous: under a loaded full-suite run a short timeout made discovery to the fake IdP flaky.
    httpTimeoutSApps: 30,
    webJsonMaxBytes: 65536,
    webImageMaxBytes: 65536,
    webImageTimeoutS: 30, // generous for the same reason as httpTimeoutSApps
    webRequestTimeoutS: 30,
    webConnectionTimeoutS: 60,
    webKeepaliveTimeoutS: 75,
    startIdleMinutes: 30,
    startFailsafeHours: 3,
    startHardCapHours: 6,
    bootTimeoutMin: 25,
    vastStartStuckMin: 5,
    bootAgentGraceMin: 10,
    modelEtaMinObserveS: 120,
    bootMaxDownloadEtaMin: 20,
    netProbeBytes: 25165824,
    netProbeMinMbps: 20,
    downloadConnections: 4,
    vastBadMachineTtlMin: 60,
    unreachableDestroyMin: 15,
    reconcileGraceMin: 10,
    webDestroyRetries: 1,
    webDestroyBackoffS: 0,
    statusPollS: 1,
    generateMaxPromptChars: 50,
    generateMaxNegativePromptChars: 400,
    generateTimeoutS: 600,
    startRateLimitPerHour: 2,
    webBodyLimitBytes: 4096,
    webJobCacheMax: 10,
    webJobTtlS: 3600,
    webExtendMaxMinutes: 120,
    webGenerateRateLimitPerHour: 50,
    vastCreditCacheS: 60,
    gallerySaveRateLimitPerHour: 50,
    galleryMaxConcurrent: 4,
    editMaxReferences: 3,
    editReferenceMaxBytes: 4096,
    editReferenceMaxPixels: 1_000_000,
    editReferenceMaxSide: 8192,
    editReferenceTypes: ["png", "jpeg", "webp"],
    upscaleMaxOutputPixels: 100_000,
    upscaleMaxIntermediatePixels: 1_600_000,
    videoTimeoutS: 1800,
    videoMaxBytes: 65536,
    videoViewTimeoutS: 30,
    videoModelLinkHosts: ["huggingface.co"],
    vastVideoDiskGb: 80,
    bootLogMaxLines: 500,
    bootLogMaxLineChars: 400,
    bootLogPollMinS: 5,
    bootLogWatchS: 60,
    bootLogTailLines: 300,
    secretNames: ["VAST_API_KEY", "AUTHENTIK_CLIENT_SECRET", "WEB_SESSION_SECRET"],
    ...opts.cfg,
  } as unknown as AppsConfig;

  const registry = new Registry(join(dir, "registry.json"), REGISTRY_SCHEMA);
  const vast = new FakeVast();
  const clock = { ms: NOW_S * 1000 };
  const logs: string[] = [];
  let n = 0;
  const lifecycle = new Lifecycle({
    cfg,
    vast,
    registry,
    agentFor: (r: InstanceRecord) => new AgentClient("127.0.0.1", cfg, r.agent_token, STATUS_SCHEMA),
    clock: () => clock.ms / 1000,
    tsAuthKey: opts.authKey ?? (async () => AUTH_KEY),
    profileModels: profile.models,
    newToken: () => TOKEN,
    newHostname: () => `vast-new${n++}`,
    sleep: async () => undefined,
    usage: new UsageHistory({ maxEntries: 50, slackS: 120 }, null, (level, message) => void logs.push(`${level} ${message}`)),
  });
  if (opts.ready !== false) {
    await registry.begin({ created_at: NOW_S, profile: "image", agent_token: TOKEN, tailnet_hostname: HOST });
    await registry.update(HOST, { status: "ready", vast_instance_id: VAST_ID, vast_start_date: NOW_S });
    vast.instances.push({ id: VAST_ID, label: `vastcomfy:${HOST}`, actual_status: "running", start_date: NOW_S, dph_total: 0.3 });
  }
  const galleryStore = new MemoryObjectStore();
  const gallery =
    opts.gallery === undefined
      ? new Gallery(galleryStore, { maxImages: 3, maxBytes: 100_000, pageSize: 2, adminScanMax: 100, maxImageBytes: 65_536 })
      : (opts.gallery ?? undefined);
  const creditReads = { n: 0 };
  const credit = opts.credit === undefined ? async () => (creditReads.n++, 4.5377) : (opts.credit ?? undefined);
  const { auth, oidc, sessions } = createAuthStack(cfg, { onMisconfigured: (m) => logs.push(`error ${m}`), now: () => clock.ms });
  const app = buildServer({
    cfg,
    auth,
    login: { configured: auth.configured, oidc, sessions },
    lifecycle,
    registry,
    comfyFor: () => new ComfyClient("127.0.0.1", cfg),
    profile: opts.profile ?? profile,
    template,
    upscaleTemplate: opts.profile?.upscale ? upscaleTemplate : null,
    videoTemplate: opts.videoTemplate !== undefined ? opts.videoTemplate : opts.profile?.video ? videoTemplate : null,
    editTemplate: opts.editTemplate === undefined ? editTemplate : opts.editTemplate,
    credit,
    gallery,
    publicDir,
    secrets: () => [VAST_KEY, AUTH_KEY, CLIENT_SECRET, SESSION_SECRET],
    now: () => clock.ms,
    log: (level, message) => void logs.push(`${level} ${message}`),
  });
  apps.push(app);
  opts.extraRoutes?.(app);
  await app.ready();
  return {
    app, vast, registry, lifecycle, dir, publicDir, clock, sessions, logs, creditReads, galleryStore, comfyWs,
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
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const list of wsPeerLists.splice(0)) for (const p of list) p.socket.destroy();
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

  it("401 for forged identity headers (including a valid IdP JWT in the old X-authentik-jwt header)", async () => {
    const forged = await call("GET", "/api/state", { "x-authentik-username": "root", "x-authentik-groups": ADMIN_GROUP });
    expect(forged.statusCode).toBe(401);
    const jwt = await idp.mint({ claims: { groups: [ADMIN_GROUP] } });
    const attempts: Record<string, string>[] = [{ "x-authentik-jwt": jwt }, { authorization: `Bearer ${jwt}` }, { cookie: `${NAMES.session}=${jwt}` }];
    for (const headers of attempts) {
      expect((await call("GET", "/api/state", headers)).statusCode).toBe(401);
    }
  });

  it("403 on every /api route for a session whose groups map to role none", async () => {
    const outsider = await cookieOf(["authentik Read-only"], "eve");
    for (const r of registeredRoutes(h.app).filter((x) => x.url.startsWith("/api/"))) {
      const url = r.url.replace(":id", "p-1").replace(":index", "0");
      const res = await call(r.method as Method, url, outsider, r.method === "POST" ? {} : undefined);
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
    }
    expect(h.vast.creates).toBe(0);
  });

  it("403 for a member on start, estimate, destroy, extend and destroy-unknown", async () => {
    const m = await member();
    const cases: [Method, string, unknown][] = [
      ["POST", "/api/start", { confirm: true }],
      ["GET", "/api/estimate", undefined],
      ["GET", "/api/estimate?gpu=RTX%204090", undefined],
      ["GET", "/api/gpus", undefined],
      ["POST", "/api/start", { confirm: true, gpu: "RTX 4090" }],
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

describe("default deny follows the matched route, not the raw path", () => {
  it("an UNTAGGED /api route is member-gated, also when reached as /%61pi/...", async () => {
    h = await harness({
      extraRoutes: (app) => app.get("/api/untagged-probe", async () => ({ ok: "probe" })),
    });
    for (const url of ["/api/untagged-probe", "/%61pi/untagged-probe", "/%61%70%69/untagged-probe"]) {
      const anon = await call("GET", url);
      expect(anon.statusCode, url).toBe(401);
      expect(anon.body).not.toContain("probe");
      expect((await call("GET", url, await cookieOf(["staff"]))).statusCode, url).toBe(403);
      const ok = await call("GET", url, await member());
      expect(ok.statusCode, url).toBe(200);
      expect(ok.headers["cache-control"], url).toBe("no-store");
    }
    expect((await call("GET", "/%61pi/state")).statusCode).toBe(401);
    expect((await call("GET", "/%61pi/estimate", await member())).statusCode).toBe(403);
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
    const extra = await post("/api/start", a, { confirm: true, vast_offer: 1 });
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

  it("shows a stuck start as a fixed code and plain message, for admins and members", async () => {
    expect((await call("GET", "/api/state", await member())).json().start_failure).toBeNull();
    h = await harness({ ready: false });
    expect((await post("/api/start", await admin(), { confirm: true })).statusCode).toBe(200);
    h.setAgent((_s, res) => json(res, 503, { error: "not up" }));
    Object.assign(h.vast.instances[0]!, { actual_status: "created", intended_status: "stopped", last_started: null, machine_id: 45608 });
    h.clock.ms += 4 * 60_000;
    await h.lifecycle.reconcile();
    h.clock.ms += 60_000;
    expect((await h.lifecycle.reconcile()).destroyed.map((d) => d.reason)).toEqual(["start_stuck"]);
    const server = { location: null, down_mbps: null, up_mbps: null, reliability: null };
    for (const [who, expected] of [[await admin(), { ...server, machine_id: 45608 }], [await member(), server]] as const) {
      const res = await call("GET", "/api/state", who);
      expect(res.json().state).toBe("none");
      expect(res.json().start_failure).toEqual({
        code: "start_stuck",
        message: "The rented machine did not start. It was released; try Start again.",
        server: expected,
        measured_mb_s: null,
      });
    }
    expect((await call("GET", "/api/state", await member())).body).not.toContain("45608");
    const doc = JSON.parse(readFileSync(OPENAPI, "utf8"));
    expect(doc.components.schemas.State.required).toContain("start_failure");
    expect(doc.components.schemas.StartFailureCode.enum).toEqual(["start_stuck", "boot_stopped", "slow_boot", "slow_download", "boot_failed"]);
  });

  it("words slow_download with the measured speed (a number only)", async () => {
    const { startFailureMessage } = await import("../src/routes.js");
    expect(startFailureMessage("slow_download", 2.8)).toBe(
      "The rented machine's network is too slow (about 2.8 MB/s to the model host). It was released; try Start again, a different machine is chosen.",
    );
    expect(startFailureMessage("slow_download", null)).toBe(
      "The rented machine's network is too slow. It was released; try Start again, a different machine is chosen.",
    );
    expect(startFailureMessage("slow_boot", 2.8)).toBe(
      "The rented machine did not finish starting up in time. It was released; try Start again, a different machine is chosen.",
    );
    const schemaText = readFileSync(OPENAPI, "utf8");
    expect(schemaText).not.toContain("BOOT_AGENT_GRACE_MIN old");
    const doc = JSON.parse(readFileSync(OPENAPI, "utf8"));
    const sf = doc.components.schemas.State.properties.start_failure;
    expect(sf.required).toEqual(["code", "message", "server", "measured_mb_s"]);
    expect(sf.properties.measured_mb_s.type).toEqual(["number", "null"]);
  });

  it("shows where the server is: location and speeds for everyone, the machine id for admins only", async () => {
    Object.assign(h.vast.instances[0]!, { geolocation: "Quebec, CA", inet_down: 860, inet_up: 400, reliability2: 0.99, machine_id: 45608, host_id: 123 });
    const m = (await call("GET", "/api/state", await member())).json();
    expect(m.server).toEqual({ location: "Quebec, CA", down_mbps: 860, up_mbps: 400, reliability: 0.99 });
    const a = (await call("GET", "/api/state", await admin())).json();
    expect(a.server).toEqual({ location: "Quebec, CA", down_mbps: 860, up_mbps: 400, reliability: 0.99, machine_id: 45608 });
    const doc = JSON.parse(readFileSync(OPENAPI, "utf8"));
    expect(doc.components.schemas.State.required).toContain("server");
    expect(Object.keys(doc.components.schemas.ServerInfo.properties).sort()).toEqual(["down_mbps", "location", "machine_id", "reliability", "up_mbps"]);
  });

  it("has no server without an instance", async () => {
    h = await harness({ ready: false });
    expect((await call("GET", "/api/state", await admin())).json().server).toBeNull();
  });

  it("estimate, gpus and history carry the offer's location and download speed", async () => {
    h = await harness({ ready: false });
    h.vast.offers = [{ id: 11, dph_total: 0.3, gpu_name: "RTX A5000", gpu_ram: 24564, geolocation: "Quebec, CA", inet_down: 860, machine_id: 5 }];
    const a = await admin();
    expect((await call("GET", "/api/estimate", a)).json()).toMatchObject({ location: "Quebec, CA", down_mbps: 860 });
    const gpus = await call("GET", "/api/gpus", a);
    expect(gpus.json().gpus[0]).toMatchObject({ name: "RTX A5000", location: "Quebec, CA", down_mbps: 860 });
    expect(gpus.body).not.toContain("machine_id");
    expect((await post("/api/start", a, { confirm: true })).statusCode).toBe(200);
    const [e] = (await call("GET", "/api/history", a)).json().entries;
    expect(e).toMatchObject({ location: "Quebec, CA", down_mbps: 860 });
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
    // Offer ids stay inside the server.
    expect(est.json()).toEqual({ gpu_name: "RTX A5000", dph: 0.3, horizon_hours: 3, max_cost: 0.3 * 3, location: null, down_mbps: null });
    const first = await post("/api/start", a, { confirm: true });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: "booting", vast_instance_id: 1000, estimate: { gpu_name: "RTX A5000", dph: 0.3 } });
    expect(first.body).not.toContain("offer_id");
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

  it("start and estimate map no offers to 409", async () => {
    h = await harness({ ready: false });
    h.vast.offers = [];
    const a = await admin();
    const res = await post("/api/start", a, { confirm: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("no_offers");
    expect(h.logs).toContain("warn start failed: NoOffersError (internal: no_offers)");
    expect((await call("GET", "/api/estimate", a)).statusCode).toBe(409);
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
    expect(poll.json()).toMatchObject({ status: "done", images: [{ index: 0, url: "/api/image/p-1/0" }] });
    expect(poll.body).not.toContain("ComfyUI_0001");
    const img = await call("GET", "/api/image/p-1/0", m);
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.headers["cache-control"]).toBe("no-store");
    expect(img.rawPayload.equals(PNG)).toBe(true);
    expect(newFilesWith(before, [tmpdir(), h.dir], PNG)).toEqual([]);
    expect((await call("GET", "/api/image/p-1/1", m)).statusCode).toBe(404);
  }, 30_000); // walks the shared tmpdir twice; slow on a busy machine

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
    expect((await call("GET", "/api/generate/p-1", m)).json()).toEqual({ status: "pending", progress: null, preview_seq: 0 });
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

  it("says how long the image took: ComfyUI's execution time, and logs kind and seconds without the prompt", async () => {
    const images = [{ filename: "a.png", subfolder: "", type: "output" }];
    const messages = [["execution_start", { prompt_id: "p-1", timestamp: 1_000_000 }], ["execution_success", { prompt_id: "p-1", timestamp: 1_052_340 }]];
    h.setComfy((s, res) => {
      if (s.url === "/prompt") return json(res, 200, { prompt_id: "p-1" });
      json(res, 200, { "p-1": { outputs: { "10": { images } }, status: { completed: true, status_str: "success", messages } } });
    });
    const m = await member();
    await post("/api/generate", m, { ...okGen, prompt: "secret fox prompt" });
    h.clock.ms += 90_000; // the server's own clock does not matter when ComfyUI says how long it took
    const res = (await call("GET", "/api/generate/p-1", m)).json();
    expect(res).toEqual({ status: "done", images: [{ index: 0, url: "/api/image/p-1/0" }], seconds: 52.3, queued_seconds: null });
    expect((await call("GET", "/api/generate/p-1", m)).json().seconds).toBe(52.3);
    expect(h.logs.filter((l) => l.startsWith("info job done"))).toEqual(["info job done: kind=generate seconds=52.3"]);
    for (const l of h.logs) expect(l).not.toContain("secret fox");
  });

  it("falls back to the server's submit-to-done time when the history has no timestamps", async () => {
    h.setComfy(comfyDone([{ filename: "a.png", subfolder: "", type: "output" }]));
    const m = await member();
    await post("/api/generate", m, okGen);
    h.clock.ms += 41_250;
    expect((await call("GET", "/api/generate/p-1", m)).json()).toMatchObject({ status: "done", seconds: 41.3, queued_seconds: null });
  });

  it("documents seconds and queued_seconds on a finished job", () => {
    const doc = JSON.parse(readFileSync(OPENAPI, "utf8"));
    const done = doc.components.schemas.Job.oneOf.find((o: { properties: { status: { const: string } } }) => o.properties.status.const === "done");
    expect(done.required).toEqual(expect.arrayContaining(["status", "images", "seconds", "queued_seconds"]));
    expect(done.additionalProperties).toBe(false);
    expect(done.properties.seconds.type).toBe("number");
    expect(done.properties.queued_seconds.type).toEqual(["number", "null"]);
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

// ---- login, sessions, logout and CSRF ----

const location = (res: Res) => String(res.headers.location ?? "");
const loginError = (res: Res) => new URL(location(res), PUBLIC_ORIGIN).searchParams.get("login_error");

// ---- gallery: save to the object store, list, view, delete ----

describe("gallery", () => {
  const GPNG = () => pngOf(16, 16, "GALLERY-IMAGE-MARKER");

  /** A ComfyUI whose finished job p-1 has one PNG with a real header. */
  function comfyGallery(): Handler {
    return (s, res) => {
      if (s.url === "/prompt") return json(res, 200, { prompt_id: "p-1" });
      if (s.url.startsWith("/history/")) {
        return json(res, 200, { "p-1": { outputs: { "10": { images: [{ filename: "a.png", subfolder: "", type: "output" }] } }, status: { completed: true, status_str: "success" } } });
      }
      if (s.url.startsWith("/view")) {
        res.writeHead(200, { "Content-Type": "image/png" });
        return res.end(GPNG());
      }
      json(res, 404, {});
    };
  }

  /** Submit a job as `who` and poll it to done, so it can be saved. */
  async function finishedJob(who: Creds, body: Record<string, unknown> = okGen) {
    h.setComfy(comfyGallery());
    const sub = await post("/api/generate", who, body);
    expect(sub.statusCode).toBe(202);
    const poll = await call("GET", `/api/generate/${sub.json().id}`, who);
    expect(poll.json().status).toBe("done");
    return sub.json().id as string;
  }
  const save = (who: Creds, job: string, index = 0) => post("/api/gallery", who, { job, index });

  it("tells the page whether saving is available", async () => {
    expect((await call("GET", "/api/state", await member())).json().gallery).toBe(true);
    h = await harness({ gallery: null });
    expect((await call("GET", "/api/state", await member())).json().gallery).toBe(false);
  });

  it("saves a finished job's image from ComfyUI (the browser sends no image data) with the job's prompt and label", async () => {
    const m = await member("ayu");
    const job = await finishedJob(m, { ...okGen, prompt: "a red fox <b>" });
    const res = await save(m, job);
    expect(res.statusCode).toBe(201);
    const { id } = res.json();
    expect(res.json()).toEqual({ id: expect.stringMatching(/^[0-9a-f]{32}\.\d{13}\.p-1\.0$/), created: true });
    const key = h.galleryStore.keys()[0]!;
    expect(key.startsWith("u/")).toBe(true);
    expect(key).not.toContain("ayu");
    const head = await h.galleryStore.head(key);
    expect(head?.contentType).toBe("image/png");
    expect(decodeURIComponent(head!.metadata["prompt"]!)).toBe("a red fox <b>");
    expect(decodeURIComponent(head!.metadata["label"]!)).toBe("preview, 1:1");
    expect(head!.metadata["kind"]).toBe("generate");
    expect(res.body).not.toContain("GALLERY-IMAGE-MARKER");
    expect(id).toBe(res.json().id);
  });

  it("saving the same image twice keeps one object and answers 200 created:false", async () => {
    const m = await member();
    const job = await finishedJob(m);
    expect((await save(m, job)).statusCode).toBe(201);
    const again = await save(m, job);
    expect(again.statusCode).toBe(200);
    expect(again.json().created).toBe(false);
    expect(h.galleryStore.keys()).toHaveLength(1);
  });

  it("stores how long the image took and lists it; the documented item has seconds", async () => {
    const m = await member();
    const job = await finishedJob(m);
    expect((await save(m, job)).statusCode).toBe(201);
    const head = await h.galleryStore.head(h.galleryStore.keys()[0]!);
    expect(head!.metadata["seconds"]).toMatch(/^[0-9]+(\.[0-9])?$/);
    const item = (await call("GET", "/api/gallery", m)).json().items[0];
    expect(item.seconds).toBe(Number(head!.metadata["seconds"]));
    const doc = JSON.parse(readFileSync(OPENAPI, "utf8"));
    const schema = doc.paths["/api/gallery"].get.responses["200"].content["application/json"].schema.properties.items.items;
    expect(schema.required).toContain("seconds");
    expect(schema.properties.seconds.type).toEqual(["number", "null"]);
  });

  it("an edit job is saved with kind edit and its label", async () => {
    h.setComfy((s, res) => {
      if (s.url === "/upload/image") return json(res, 200, { name: /filename="([^"]+)"/.exec(s.body)![1]!, subfolder: "", type: "input" });
      if (s.url === "/prompt") return json(res, 200, { prompt_id: "p-edit" });
      if (s.url.startsWith("/history/")) return json(res, 200, { "p-edit": { outputs: { "9": { images: [{ filename: "e.png", subfolder: "", type: "output" }] } }, status: { completed: true, status_str: "success" } } });
      if (s.url.startsWith("/view")) { res.writeHead(200, { "Content-Type": "image/png" }); return res.end(GPNG()); }
      json(res, 404, {});
    });
    const m = await member();
    const sub = await post("/api/edit", m, okEdit);
    expect(sub.statusCode).toBe(202);
    await call("GET", "/api/generate/p-edit", m);
    expect((await save(m, "p-edit")).statusCode).toBe(201);
    const head = await h.galleryStore.head(h.galleryStore.keys()[0]!);
    expect(head!.metadata["kind"]).toBe("edit");
    expect(decodeURIComponent(head!.metadata["label"]!)).toBe("preview, 1024, 1 reference");
  });

  it("refuses a job that is not finished, someone else's job, an unknown image index and an unknown job", async () => {
    const m = await member("ayu");
    h.setComfy((s, res) => (s.url === "/prompt" ? json(res, 200, { prompt_id: "p-1" }) : json(res, 200, {})));
    await post("/api/generate", m, okGen);
    const early = await save(m, "p-1");
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe("job_not_done");
    h.setComfy(comfyGallery());
    await call("GET", "/api/generate/p-1", m);
    expect((await save(await member("budi"), "p-1")).statusCode).toBe(404);
    expect((await save(m, "p-1", 5)).statusCode).toBe(404);
    expect((await save(m, "nope")).statusCode).toBe(404);
    expect(h.galleryStore.keys()).toEqual([]);
  });

  it("410 when the instance that made the image is gone, and nothing is stored", async () => {
    const m = await member();
    const job = await finishedJob(m);
    await h.registry.update(HOST, { status: "gone" });
    const res = await save(m, job);
    expect(res.statusCode).toBe(410);
    expect(h.galleryStore.keys()).toEqual([]);
  });

  it("409 gallery_quota when the member's gallery is full, other members are unaffected", async () => {
    h = await harness({ gallery: new Gallery(new MemoryObjectStore(), { maxImages: 1, maxBytes: 100_000, pageSize: 2, adminScanMax: 100, maxImageBytes: 65_536 }) });
    const m = await member("ayu");
    const first = await finishedJob(m);
    expect((await save(m, first)).statusCode).toBe(201);
    h.setComfy((s, res) => (s.url === "/prompt" ? json(res, 200, { prompt_id: "p-2" }) : s.url.startsWith("/history/") ? json(res, 200, { "p-2": { outputs: { "10": { images: [{ filename: "b.png", subfolder: "", type: "output" }] } }, status: { completed: true, status_str: "success" } } }) : comfyGallery()(s, res)));
    await post("/api/generate", m, okGen);
    await call("GET", "/api/generate/p-2", m);
    const full = await save(m, "p-2");
    expect(full.statusCode).toBe(409);
    expect(full.json().error.code).toBe("gallery_quota");
    const other = await member("budi");
    await post("/api/generate", other, okGen);
    await call("GET", "/api/generate/p-2", other);
    expect((await save(other, "p-2")).statusCode).toBe(201);
  });

  it("429 rate_limited past GALLERY_SAVE_RATE_LIMIT_PER_HOUR saves per member, other members unaffected", async () => {
    h = await harness({ cfg: { gallerySaveRateLimitPerHour: 2, webJobTtlS: 7200 } });
    const m = await member("ayu");
    const job = await finishedJob(m);
    expect((await save(m, job)).statusCode).toBe(201);
    expect((await save(m, job)).statusCode).toBe(200);
    const third = await save(m, job);
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe("rate_limited");
    h.clock.ms += 3_600_000; // the window has passed
    expect((await save(m, job)).statusCode).toBe(200);
    // Counted per identity: another member saves freely (its job reuses the id p-1).
    const other = await member("budi");
    await post("/api/generate", other, okGen);
    await call("GET", "/api/generate/p-1", other);
    expect((await save(other, "p-1")).statusCode).toBe(201);
  });

  it("at most GALLERY_MAX_CONCURRENT gallery image reads run at once; the others wait and still succeed", async () => {
    let running = 0;
    let peak = 0;
    class SlowReads extends MemoryObjectStore {
      override async get(key: string, maxBytes: number) {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        return super.get(key, maxBytes);
      }
    }
    const store = new SlowReads();
    h = await harness({ cfg: { galleryMaxConcurrent: 1 }, gallery: new Gallery(store, { maxImages: 10, maxBytes: 1_000_000, pageSize: 5, adminScanMax: 100, maxImageBytes: 65_536 }) });
    const m = await member();
    const job = await finishedJob(m);
    const { id } = (await save(m, job)).json();
    const reads = await Promise.all([1, 2, 3].map(() => call("GET", `/api/gallery/${id}/image`, m)));
    expect(reads.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(peak).toBe(1);
  });

  it("502 gallery_error when the object store fails, with nothing from the store in the response or the logs", async () => {
    const broken = new MemoryObjectStore();
    broken.list = async () => { throw new (await import("@vast-comfy/core")).ObjectStoreError(`boom ${VAST_KEY} minio.internal`); };
    h = await harness({ gallery: new Gallery(broken, { maxImages: 3, maxBytes: 100_000, pageSize: 2, adminScanMax: 100, maxImageBytes: 65_536 }) });
    const m = await member();
    const job = await finishedJob(m);
    const res = await save(m, job);
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("gallery_error");
    for (const text of [res.body, h.logs.join("\n")]) {
      expect(text).not.toContain(VAST_KEY);
      expect(text).not.toContain("minio.internal");
    }
  });

  it("503 gallery_unavailable on every gallery route when saving is not set up", async () => {
    h = await harness({ gallery: null });
    const m = await member();
    for (const [method, url, body] of [
      ["POST", "/api/gallery", { job: "p-1", index: 0 }],
      ["GET", "/api/gallery", undefined],
      ["GET", "/api/gallery/00000000000000000000000000000000.0000000000000.p-1.0/image", undefined],
      ["POST", "/api/gallery/delete", { id: "00000000000000000000000000000000.0000000000000.p-1.0" }],
    ] as const) {
      const res = await call(method, url, m, body);
      expect(res.statusCode, url).toBe(503);
      expect(res.json().error.code).toBe("gallery_unavailable");
    }
  });

  it("validates the save body strictly", async () => {
    const m = await member();
    for (const body of [{}, { job: "p-1" }, { job: "p-1", index: -1 }, { job: "p-1", index: 1000 }, { job: "p-1", index: "0" }, { job: "../x", index: 0 }, { job: "p-1", index: 0, extra: 1 }]) {
      const res = await post("/api/gallery", m, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
  });

  describe("list, view and delete", () => {
    async function savedBy(who: Creds, n: number, prefix: string) {
      for (let i = 0; i < n; i++) {
        h.clock.ms += 1000;
        h.setComfy((s, res) => {
          if (s.url === "/prompt") return json(res, 200, { prompt_id: `${prefix}${i}` });
          if (s.url.startsWith("/history/")) return json(res, 200, { [`${prefix}${i}`]: { outputs: { "10": { images: [{ filename: "a.png", subfolder: "", type: "output" }] } }, status: { completed: true, status_str: "success" } } });
          if (s.url.startsWith("/view")) { res.writeHead(200, { "Content-Type": "image/png" }); return res.end(GPNG()); }
          json(res, 404, {});
        });
        await post("/api/generate", who, { ...okGen, prompt: `${prefix} prompt ${i}` });
        await call("GET", `/api/generate/${prefix}${i}`, who);
        expect((await save(who, `${prefix}${i}`)).statusCode).toBe(201);
      }
    }

    beforeEach(async () => {
      h = await harness({ gallery: new Gallery(new MemoryObjectStore(), { maxImages: 10, maxBytes: 1_000_000, pageSize: 2, adminScanMax: 100, maxImageBytes: 65_536 }) });
    });

    it("lists a member's own images newest first in pages, with image urls and no storage details", async () => {
      const ayu = await member("ayu");
      await savedBy(ayu, 3, "a");
      await savedBy(await member("budi"), 1, "b");
      const p1 = await call("GET", "/api/gallery", ayu);
      expect(p1.statusCode).toBe(200);
      const body = p1.json();
      expect(body.items.map((i: { prompt: string }) => i.prompt)).toEqual(["a prompt 2", "a prompt 1"]);
      expect(body.items[0]).toEqual({
        id: expect.stringMatching(/^[0-9a-f]{32}\.\d{13}\.a2\.0$/),
        url: expect.stringMatching(/^\/api\/gallery\/[0-9a-f]{32}\.\d{13}\.a2\.0\/image$/),
        created_at: expect.any(Number),
        kind: "generate",
        prompt: "a prompt 2",
        label: "preview, 1:1",
        owner_name: expect.any(String),
        mine: true,
        size: expect.any(Number),
        seconds: expect.any(Number),
      });
      expect(p1.body).not.toMatch(/"key"|vast-gallery|u\/[0-9a-f]{32}\//);
      expect(body.next).toBe(body.items[1].id);
      const p2 = await call("GET", `/api/gallery?cursor=${encodeURIComponent(body.next)}`, ayu);
      expect(p2.json().items.map((i: { prompt: string }) => i.prompt)).toEqual(["a prompt 0"]);
      expect(p2.json().next).toBeNull();
    });

    it("an admin can ask for everyone's images; a member cannot", async () => {
      const ayu = await member("ayu");
      await savedBy(ayu, 1, "a");
      await savedBy(await member("budi"), 1, "b");
      const root = await admin();
      const all = await call("GET", "/api/gallery?scope=all", root);
      expect(all.statusCode).toBe(200);
      expect(all.json().items.map((i: { prompt: string }) => i.prompt)).toEqual(["b prompt 0", "a prompt 0"]);
      expect(all.json().items.every((i: { mine: boolean }) => i.mine === false)).toBe(true);
      const denied = await call("GET", "/api/gallery?scope=all", ayu);
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe("forbidden");
      expect((await call("GET", "/api/gallery", root)).json().items).toEqual([]);
    });

    it("validates the query and refuses another member's cursor", async () => {
      const ayu = await member("ayu");
      await savedBy(ayu, 3, "a");
      const budi = await member("budi");
      await savedBy(budi, 1, "b");
      const cursor = (await call("GET", "/api/gallery", ayu)).json().next;
      expect((await call("GET", `/api/gallery?cursor=${encodeURIComponent(cursor)}`, budi)).statusCode).toBe(403);
      for (const q of ["?cursor=nonsense", "?scope=everything", "?limit=1000", "?cursor=" + "a".repeat(300)]) {
        const res = await call("GET", `/api/gallery${q}`, ayu);
        expect(res.statusCode, q).toBe(400);
      }
    });

    it("serves a stored image to its owner and to an admin, never to another member, with the stored type and no caching", async () => {
      const ayu = await member("ayu");
      await savedBy(ayu, 1, "a");
      const item = (await call("GET", "/api/gallery", ayu)).json().items[0];
      const own = await call("GET", item.url, ayu);
      expect(own.statusCode).toBe(200);
      expect(own.headers["content-type"]).toBe("image/png");
      expect(own.headers["cache-control"]).toBe("no-store");
      expect(own.headers["content-disposition"]).toMatch(/^inline; filename="gallery-image\.png"$/);
      expect(own.rawPayload.includes(Buffer.from("GALLERY-IMAGE-MARKER"))).toBe(true);
      expect((await call("GET", item.url, await admin())).statusCode).toBe(200);
      expect((await call("GET", item.url, await member("budi"))).statusCode).toBe(404);
      expect((await call("GET", "/api/gallery/not-an-id/image", ayu)).statusCode).toBe(400);
      expect((await call("GET", item.url.replace(/\.0\/image$/, ".7/image"), ayu)).statusCode).toBe(404);
    });

    it("deletes an own image (an admin: any), refuses another member, and is idempotent", async () => {
      const ayu = await member("ayu");
      await savedBy(ayu, 2, "a");
      const items = (await call("GET", "/api/gallery", ayu)).json().items;
      const budi = await member("budi");
      expect((await post("/api/gallery/delete", budi, { id: items[0].id })).statusCode).toBe(404);
      const del = await post("/api/gallery/delete", ayu, { id: items[0].id });
      expect(del.statusCode).toBe(200);
      expect(del.json()).toEqual({ deleted: true });
      expect((await post("/api/gallery/delete", ayu, { id: items[0].id })).statusCode).toBe(200);
      expect((await call("GET", items[0].url, ayu)).statusCode).toBe(404);
      expect((await post("/api/gallery/delete", await admin(), { id: items[1].id })).statusCode).toBe(200);
      expect((await call("GET", "/api/gallery", ayu)).json().items).toEqual([]);
      for (const body of [{}, { id: "x" }, { id: items[0].id, extra: 1 }]) expect((await post("/api/gallery/delete", ayu, body)).statusCode).toBe(400);
    });

    it("keeps the gates: 401 without a session, 403 for role none, 403 csrf on the state-changing routes", async () => {
      expect((await call("GET", "/api/gallery")).statusCode).toBe(401);
      expect((await post("/api/gallery", {}, { job: "p", index: 0 })).statusCode).toBe(401);
      const outsider = await cookieOf(["nobody"], "eve");
      expect((await call("GET", "/api/gallery", outsider)).statusCode).toBe(403);
      const m = await member();
      const cross = await post("/api/gallery/delete", { cookie: m.cookie, origin: "https://evil.example.test" }, { id: "x" }); // config-lint: ok (test fixture)
      expect(cross.statusCode).toBe(403);
      expect(cross.json().error.code).toBe("csrf");
    });
  });
});

// ---- Vast account credit ----

describe("GET /api/credit", () => {
  it("returns the credit and when it was read, for an admin only", async () => {
    const res = await call("GET", "/api/credit", await admin());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ credit: 4.5377, as_of: NOW_S });
    expect(res.headers["cache-control"]).toBe("no-store");
    const denied = await call("GET", "/api/credit", await member());
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("forbidden");
    expect((await call("GET", "/api/credit")).statusCode).toBe(401);
    expect(h.creditReads.n).toBe(1);
  });

  it("reads Vast once per VAST_CREDIT_CACHE_S, however many admins and tabs ask", async () => {
    const a = await admin();
    for (let i = 0; i < 5; i++) expect((await call("GET", "/api/credit", a)).statusCode).toBe(200);
    expect(h.creditReads.n).toBe(1);
    h.clock.ms += 59_000;
    await call("GET", "/api/credit", a);
    expect(h.creditReads.n).toBe(1);
    h.clock.ms += 2_000;
    const later = await call("GET", "/api/credit", a);
    expect(h.creditReads.n).toBe(2);
    expect(later.json().as_of).toBe(NOW_S + 61);
  });

  it("shares one in-flight read between simultaneous requests", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reads = 0;
    h = await harness({ credit: async () => (reads++, await gate, 7) });
    const a = await admin();
    const pending = [call("GET", "/api/credit", a), call("GET", "/api/credit", a), call("GET", "/api/credit", a)];
    await new Promise((r) => setTimeout(r, 20));
    release();
    for (const res of await Promise.all(pending)) expect(res.json().credit).toBe(7);
    expect(reads).toBe(1);
  });

  it("502 vast_unavailable when Vast fails, nothing leaks, and the failure is not cached", async () => {
    let fail = true;
    h = await harness({ credit: async () => { if (fail) throw new Error(`401 for ${VAST_KEY} owner@example.test`); return 3; } });
    const a = await admin();
    const bad = await call("GET", "/api/credit", a);
    expect(bad.statusCode).toBe(502);
    expect(bad.json().error.code).toBe("vast_unavailable");
    for (const text of [bad.body, h.logs.join("\n")]) {
      expect(text).not.toContain(VAST_KEY);
      expect(text).not.toContain("owner@example.test");
    }
    fail = false;
    expect((await call("GET", "/api/credit", a)).json().credit).toBe(3);
  });

  it("zero and negative credit are reported as they are", async () => {
    h = await harness({ credit: async () => -1.25 });
    expect((await call("GET", "/api/credit", await admin())).json().credit).toBe(-1.25);
  });

  it("404 credit_unavailable when no credit source is wired", async () => {
    h = await harness({ credit: null });
    const res = await call("GET", "/api/credit", await admin());
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("credit_unavailable");
  });

  it("is not part of /api/state", async () => {
    const body = (await call("GET", "/api/state", await admin())).body;
    expect(body).not.toContain("credit");
    expect(h.creditReads.n).toBe(0);
  });
});

// ---- edit with reference images ----

function pngOf(width: number, height: number, marker = "REF"): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.from(marker)]);
}
const REF_A = pngOf(64, 64, "REF-A-UNIQUE-MARKER");
const REF_B = pngOf(32, 48, "REF-B-UNIQUE-MARKER");
const okEdit = { prompt: "make it real", preset: "preview", resolution: "1024", images: [REF_A.toString("base64")] };

/** A ComfyUI that stores uploads as sent and accepts prompts; the edit workflow saves through node 9. */
function comfyEdit(images: unknown[] | null = null): Handler {
  return (s, res) => {
    if (s.url === "/upload/image") {
      const name = /filename="([^"]+)"/.exec(s.body)![1]!;
      return json(res, 200, { name, subfolder: "", type: "input" });
    }
    if (s.url === "/prompt") return json(res, 200, { prompt_id: "p-edit" });
    if (s.url.startsWith("/history/")) {
      if (images === null) return json(res, 200, {});
      return json(res, 200, { "p-edit": { outputs: { "9": { images } }, status: { completed: true, status_str: "success" } } });
    }
    if (s.url.startsWith("/view")) {
      res.writeHead(200, { "Content-Type": "image/png" });
      return res.end(PNG);
    }
    json(res, 404, {});
  };
}

/** Wrap a ComfyUI fake so /view answers with a PNG that has a real header (the gallery checks it). */
function realView(base: Handler): Handler {
  return (s, res) => {
    if (!s.url.startsWith("/view")) return base(s, res);
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(pngOf(16, 16, "SAVED-RESULT"));
  };
}

describe("edit with reference images", () => {
  it("is described in /api/state for every member, including the limits and resolutions", async () => {
    for (const who of [await member(), await admin()]) {
      const body = (await call("GET", "/api/state", who)).json();
      expect(body.edit).toEqual({
        max_references: 3,
        max_bytes: 4096,
        max_pixels: 1_000_000,
        types: ["png", "jpeg", "webp"],
        resolutions: [{ name: "1024", value: 1024 }],
        sizes: [
          { name: "1:1", width: 1024, height: 1024 },
          { name: "3:4", width: 896, height: 1152 },
          { name: "16:9", width: 1344, height: 768 },
          { name: "9:16", width: 768, height: 1344 },
        ],
      });
    }
  });

  it("uploads the references, submits the filled edit workflow, and polls with the edit template", async () => {
    h.setComfy(comfyEdit([{ filename: "edit_00001_.png", subfolder: "", type: "output" }]));
    const m = await member();
    const res = await post("/api/edit", m, { ...okEdit, seed: 12, images: [REF_A.toString("base64"), REF_B.toString("base64")] });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ id: "p-edit" });
    expect(h.comfySeen.map((s) => s.url)).toEqual(["/upload/image", "/upload/image", "/prompt"]);
    const names = h.comfySeen.slice(0, 2).map((s) => /filename="([^"]+)"/.exec(s.body)![1]!);
    for (const n of names) expect(n).toMatch(/^edit-[0-9a-f]{16}\.png$/);
    expect(names[0]).not.toBe(names[1]);
    const sent = JSON.parse(h.comfySeen[2]!.body).prompt;
    expect(sent["ref_1"]).toEqual({ class_type: "LoadImage", inputs: { image: names[0] } });
    expect(sent["ref_2"]).toEqual({ class_type: "LoadImage", inputs: { image: names[1] } });
    expect(sent["6"].inputs["images.image_1"]).toEqual(["ref_1", 0]);
    expect(sent["6"].inputs["images.image_2"]).toEqual(["ref_2", 0]);
    expect(sent["6"].inputs.prompt).toBe("make it real");
    expect(sent["7"].inputs).toMatchObject({ steps: 10, seed: 12 });

    // The edit job is polled against the edit workflow (SaveImage is node 9, not the generate template's 10).
    const poll = await call("GET", "/api/generate/p-edit", m);
    expect(poll.json()).toMatchObject({ status: "done", images: [{ index: 0, url: "/api/image/p-edit/0" }] });
    const img = await call("GET", "/api/image/p-edit/0", m);
    expect(img.statusCode).toBe(200);
    expect(img.rawPayload.equals(PNG)).toBe(true);
  });

  it("only the submitter (or an admin) can read an edit job", async () => {
    h.setComfy(comfyEdit([{ filename: "edit_00001_.png", subfolder: "", type: "output" }]));
    await post("/api/edit", await member("ayu"), okEdit);
    expect((await call("GET", "/api/generate/p-edit", await member("budi"))).statusCode).toBe(404);
    expect((await call("GET", "/api/generate/p-edit", await member("ayu"))).statusCode).toBe(200);
    expect((await call("GET", "/api/generate/p-edit", await admin())).statusCode).toBe(200);
  });

  it("accepts a body larger than the global limit but refuses one over the edit limit with 413", async () => {
    h.setComfy(comfyEdit());
    const m = await member();
    const big = pngOf(8, 8, "x".repeat(3000)); // ~4 KB of base64 per image, three of them: over WEB_BODY_LIMIT_BYTES (4096)
    const three = { ...okEdit, images: [big, big, big].map((b) => b.toString("base64")) };
    expect(JSON.stringify(three).length).toBeGreaterThan(4096);
    expect((await post("/api/edit", m, three)).statusCode).toBe(202);
    // The global limit still applies to every other route.
    expect((await post("/api/generate", m, { ...okGen, prompt: "x".repeat(5000) })).statusCode).toBe(413);
    // Past what three maximal images and the prompt can need.
    const huge = { ...okEdit, images: ["A".repeat(60_000)] };
    const over = await post("/api/edit", m, huge);
    expect(over.statusCode).toBe(413);
    expect(over.json().error.code).toBe("body_too_large");
  });

  const bad: [string, Record<string, unknown>, string][] = [
    ["empty prompt", { prompt: " " }, "invalid_prompt"],
    ["long prompt", { prompt: "x".repeat(51) }, "prompt_too_long"],
    ["unknown preset", { preset: "ultra" }, "unknown_preset"],
    ["unknown resolution", { resolution: "4096" }, "unknown_resolution"],
    ["bad seed", { seed: -1 }, "invalid_seed"],
    ["no images", { images: [] }, "no_references"],
    ["too many images", { images: [REF_A, REF_A, REF_A, REF_A].map((b) => b.toString("base64")) }, "too_many_references"],
    ["not base64", { images: ["not base64!!"] }, "invalid_reference"],
    ["not an image", { images: [Buffer.from("plain text, not an image").toString("base64")] }, "invalid_reference"],
    ["a gif", { images: [Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1").toString("base64")] }, "invalid_reference"],
    ["too many pixels", { images: [pngOf(5000, 5000).toString("base64")] }, "reference_too_many_pixels"],
    ["too large", { images: [pngOf(8, 8, "y".repeat(4100)).toString("base64")] }, "reference_too_large"],
  ];
  it.each(bad)("400 %s, with nothing sent to ComfyUI", async (_name, over, code) => {
    const res = await post("/api/edit", await member(), { ...okEdit, ...over });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(code);
    expect(h.comfySeen).toHaveLength(0);
  });

  it("400 invalid_body for a wrong shape: extra fields, a missing field, images that are not an array", async () => {
    const m = await member();
    for (const body of [
      { ...okEdit, filename: "../x.png" },
      { ...okEdit, name: "x" },
      { prompt: "x", preset: "preview", images: [] },
      { ...okEdit, images: "AAAA" },
      { ...okEdit, images: { 0: "AAAA" } },
    ]) {
      const res = await post("/api/edit", m, body);
      expect(res.statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
    expect(h.comfySeen).toHaveLength(0);
  });

  it("409 while the instance is not ready, and nothing is uploaded", async () => {
    h.setAgent((_s, res) => json(res, 200, agentStatus("downloading")));
    const res = await post("/api/edit", await member(), okEdit);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("not_ready");
    h = await harness({ ready: false });
    expect((await post("/api/edit", await member(), okEdit)).statusCode).toBe(409);
    expect(h.comfySeen).toHaveLength(0);
  });

  it("shares the per-identity generate rate limit", async () => {
    h = await harness({ cfg: { webGenerateRateLimitPerHour: 2 } });
    h.setComfy(comfyEdit());
    const m = await member();
    expect((await post("/api/edit", m, okEdit)).statusCode).toBe(202);
    expect((await post("/api/generate", m, okGen)).statusCode).toBe(202);
    const third = await post("/api/edit", m, okEdit);
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe("rate_limited");
  });

  it("502 when a reference cannot be uploaded, no job is created and nothing leaks", async () => {
    let uploads = 0;
    h.setComfy((s, res) => {
      if (s.url === "/upload/image" && ++uploads === 2) return json(res, 500, { error: `disk full on ${HOST} ${TOKEN}` });
      return comfyEdit()(s, res);
    });
    const m = await member();
    const res = await post("/api/edit", m, { ...okEdit, images: [REF_A, REF_B].map((b) => b.toString("base64")) });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("comfy_unavailable");
    for (const text of [res.body, h.logs.join("\n")]) {
      for (const secret of [HOST, TOKEN, "disk full", "REF-A-UNIQUE-MARKER"]) expect(text).not.toContain(secret);
    }
    expect(h.comfySeen.some((s) => s.url === "/prompt")).toBe(false);
    expect((await call("GET", "/api/generate/p-edit", m)).statusCode).toBe(404);
  });

  it("is off (404 edit_unavailable, edit null in the state) when the profile has no edit section or no template", async () => {
    for (const opts of [{ profile: { ...profile, edit: null } }, { editTemplate: null }]) {
      h = await harness(opts);
      const m = await member();
      expect((await call("GET", "/api/state", m)).json().edit).toBeNull();
      const res = await post("/api/edit", m, okEdit);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("edit_unavailable");
      expect(h.comfySeen).toHaveLength(0);
    }
  });

  it("500 profile_mismatch when the edit workflow lacks a mapped node", async () => {
    h = await harness({ editTemplate: { "1": { class_type: "KSampler", inputs: {} } } });
    h.setComfy(comfyEdit());
    const res = await post("/api/edit", await member(), okEdit);
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("profile_mismatch");
    expect(h.comfySeen).toHaveLength(0);
  });

  it("keeps the gates: 401 without a session, 403 for role none, 403 csrf, 415 for a non-JSON type", async () => {
    expect((await post("/api/edit", {}, okEdit)).statusCode).toBe(401);
    expect((await post("/api/edit", await cookieOf(["nobody"], "eve"), okEdit)).statusCode).toBe(403);
    const m = await member();
    const cross = await post("/api/edit", { cookie: m.cookie, origin: "https://evil.example.test" }, okEdit); // config-lint: ok (test fixture)
    expect(cross.statusCode).toBe(403);
    expect(cross.json().error.code).toBe("csrf");
    const plain = await h.app.inject({ method: "POST", url: "/api/edit", headers: { ...m, "content-type": "text/plain" }, payload: JSON.stringify(okEdit) });
    expect(plain.statusCode).toBe(415);
    expect(h.comfySeen).toHaveLength(0);
  });

  it("never logs prompts or image data", async () => {
    h.setComfy(comfyEdit());
    await post("/api/edit", await member(), { ...okEdit, prompt: "SECRET-PROMPT-TEXT" });
    const logs = h.logs.join("\n");
    expect(logs).not.toContain("SECRET-PROMPT-TEXT");
    expect(logs).not.toContain(REF_A.toString("base64").slice(0, 30));
  });
});

describe("login flow", () => {
  it("login -> callback -> cookie -> /api/state 200 with role; /api/me shows only name, username and role", async () => {
    expect((await call("GET", "/api/state")).statusCode).toBe(401);
    const { start, cb } = await loginFlow([ADMIN_GROUP, "staff"], { sub: "root", claims: { name: "Root User" } });
    // /auth/login: a redirect to the IdP's authorize endpoint and a short-lived transaction cookie
    expect(location(start).startsWith(`${idp.base}/application/o/authorize/?`)).toBe(true);
    expect(new URL(location(start)).searchParams.get("redirect_uri")).toBe(`${PUBLIC_ORIGIN}/auth/callback`);
    const txSet = setCookies(start);
    expect(txSet).toHaveLength(1);
    expect(txSet[0]!.startsWith(`${NAMES.transaction}=`)).toBe(true);
    expect(txSet[0]!.split("; ")).toEqual(expect.arrayContaining(["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=600"]));
    expect(start.headers["cache-control"]).toBe("no-store");
    expect(start.headers["referrer-policy"]).toBe("no-referrer");
    // /auth/callback: session cookie set, transaction cookie cleared, back to "/"
    expect(cb.statusCode).toBe(302);
    expect(location(cb)).toBe("/");
    expect(cb.headers["cache-control"]).toBe("no-store");
    const session = sessionSet(cb)!;
    expect(session.split("; ")).toEqual(expect.arrayContaining(["HttpOnly", "Secure", "SameSite=Lax", "Path=/", `Max-Age=${8 * 3600}`]));
    expect(session).not.toMatch(/Domain=/i);
    expect(setCookies(cb)).toContainEqual(expect.stringMatching(new RegExp(`^${NAMES.transaction}=; .*Max-Age=0`)));
    // Only the groups that map to a role are stored in the cookie.
    expect(decodeJwt(pairOf(session).split("=")[1]!).groups).toEqual([ADMIN_GROUP]);
    const headers = { cookie: pairOf(session) };
    const state = await call("GET", "/api/state", headers);
    expect(state.statusCode).toBe(200);
    expect(state.json().role).toBe("admin");
    const me = await call("GET", "/api/me", headers);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ name: "Root User", username: "root", role: "admin" });
    expect(h.logs).toContain("info login ok");
  });

  it("a member logs in too; a huge group list is filtered to the role groups", async () => {
    const many = Array.from({ length: 400 }, (_, i) => `group-with-a-long-name-${i}`);
    const { cb } = await loginFlow([...many, MEMBER_GROUP], { sub: "ayu" });
    expect(location(cb)).toBe("/");
    const me = await call("GET", "/api/me", { cookie: pairOf(sessionSet(cb)!) });
    expect(me.json()).toEqual({ name: "Ayu", username: "ayu", role: "member" });
  });

  it("a user whose groups map to no role is refused at the callback with access_denied and gets no session", async () => {
    const { cb } = await loginFlow(["authentik Read-only"]);
    expect(location(cb)).toBe("/?login_error=access_denied");
    expect(sessionSet(cb)).toBeUndefined();
    expect(h.logs).toContain("warn login failed: access_denied (internal: no_role_group)");
  });

  it("an over-size session is a clean session_too_large redirect with no cookie", async () => {
    const { cb } = await loginFlow([MEMBER_GROUP], { claims: { name: "n".repeat(4000) } });
    expect(cb.statusCode).toBe(302);
    expect(location(cb)).toBe("/?login_error=session_too_large");
    expect(sessionSet(cb)).toBeUndefined();
  });

  it("callback with wrong or missing state redirects with login_error and sets NO session cookie", async () => {
    idp.tokenRequests.length = 0;
    const tries: Array<(q: { code: string; state: string; cookie: string }) => { query: string; cookie?: string }> = [
      (q) => ({ query: `code=${q.code}&state=${q.state}x`, cookie: q.cookie }),
      (q) => ({ query: `code=${q.code}`, cookie: q.cookie }),
      (q) => ({ query: `code=${q.code}&state=`, cookie: q.cookie }),
      (q) => ({ query: `code=${q.code}&state=${q.state}&state=${q.state}`, cookie: q.cookie }),
      (q) => ({ query: `code=${q.code}&state=${q.state}` }), // no transaction cookie
    ];
    for (const edit of tries) {
      const { cb } = await loginFlow([ADMIN_GROUP], { edit });
      expect(cb.statusCode).toBe(302);
      expect(loginError(cb)).toBe("state_mismatch");
      expect(sessionSet(cb)).toBeUndefined();
      expect(setCookies(cb)).toEqual([expect.stringMatching(new RegExp(`^${NAMES.transaction}=; `))]);
      expect(location(cb)).toBe("/?login_error=state_mismatch");
    }
    expect(idp.tokenRequests).toHaveLength(0); // nothing was exchanged
  });

  it("maps a provider error param (after a valid state) without echoing it", async () => {
    let r = await loginFlow([ADMIN_GROUP], { edit: (q) => ({ query: `state=${q.state}&error=access_denied`, cookie: q.cookie }) });
    expect(location(r.cb)).toBe("/?login_error=access_denied");
    r = await loginFlow([ADMIN_GROUP], { edit: (q) => ({ query: `state=${q.state}&error=server_error&error_description=%3Cscript%3E`, cookie: q.cookie }) });
    expect(location(r.cb)).toBe("/?login_error=provider_error");
    expect(r.cb.body).toBe("");
    // A provider error with a wrong state is a state mismatch, not a trusted provider message.
    r = await loginFlow([ADMIN_GROUP], { edit: (q) => ({ query: `state=nope&error=access_denied`, cookie: q.cookie }) });
    expect(location(r.cb)).toBe("/?login_error=state_mismatch");
  });

  it("callback replay: with the cleared cookie it is a state mismatch; with a kept cookie the one-time code fails", async () => {
    const first = await loginFlow([ADMIN_GROUP]);
    expect(sessionSet(first.cb)).toBeDefined();
    const url = `/auth/callback?code=${encodeURIComponent(first.code)}&state=${encodeURIComponent(first.state)}`;
    const cleared = pairOf(setCookies(first.cb).find((c) => c.startsWith(`${NAMES.transaction}=`))!);
    const replayCleared = await h.app.inject({ method: "GET", url, headers: { cookie: cleared } });
    expect(loginError(replayCleared)).toBe("state_mismatch");
    expect(sessionSet(replayCleared)).toBeUndefined();
    const replayKept = await h.app.inject({ method: "GET", url, headers: { cookie: first.tx } });
    expect(loginError(replayKept)).toBe("exchange_failed");
    expect(sessionSet(replayKept)).toBeUndefined();
  });

  it("a transaction cookie from another login, a tampered one or a plain-name one creates no session", async () => {
    const other = await h.app.inject({ method: "GET", url: "/auth/login" });
    const otherTx = pairOf(setCookies(other)[0]!);
    const tampered = (q: { cookie: string }) => {
      const [name, value] = q.cookie.split("=");
      const [hd, p, sig] = value!.split(".");
      return `${name}=${hd}.${p!.slice(0, -2)}AA.${sig}`;
    };
    const variants: Array<(q: { code: string; state: string; cookie: string }) => { query: string; cookie?: string }> = [
      (q) => ({ query: `code=${q.code}&state=${q.state}`, cookie: otherTx }),
      (q) => ({ query: `code=${q.code}&state=${q.state}`, cookie: tampered(q) }),
      (q) => ({ query: `code=${q.code}&state=${q.state}`, cookie: q.cookie.replace(NAMES.transaction, TRANSACTION_COOKIE) }),
      (q) => ({ query: `code=${q.code}&state=${q.state}`, cookie: `${q.cookie}; ${otherTx}` }),
    ];
    for (const edit of variants) {
      const { cb } = await loginFlow([ADMIN_GROUP], { edit });
      expect(loginError(cb)).toBe("state_mismatch");
      expect(sessionSet(cb)).toBeUndefined();
    }
  });

  it("next open-redirect attempts all end at /; same-site paths are kept (percent-encoded)", async () => {
    const hostile = [
      "//evil.example", "https://evil.example/x", "/\\evil.example", "\\\\evil.example", "/..//evil.example",
      "/.//evil.example", "javascript:alert(1)", "evil.example", "/\t/evil.example", " /x", "http:/evil.example",
    ];
    for (const next of hostile) {
      const { cb } = await loginFlow([MEMBER_GROUP], { next });
      expect(location(cb), JSON.stringify(next)).toBe("/");
    }
    expect(location((await loginFlow([MEMBER_GROUP], { next: "/gallery?x=1#top" })).cb)).toBe("/gallery?x=1#top");
    expect(location((await loginFlow([MEMBER_GROUP], { next: "/中" })).cb)).toBe("/%E4%B8%AD");
    // A repeated next parameter is not a string: "/".
    const twice = await h.app.inject({ method: "GET", url: "/auth/login?next=/a&next=//evil.example" });
    const { code, state } = idp.authorize(location(twice));
    const cb = await h.app.inject({ method: "GET", url: `/auth/callback?code=${code}&state=${state}`, headers: { cookie: pairOf(setCookies(twice)[0]!) } });
    expect(location(cb)).toBe("/");
  });

  it("an unreachable IdP at /auth/login is a provider_error redirect, not an error page", async () => {
    idp.discovery = 503;
    h = await harness();
    const res = await h.app.inject({ method: "GET", url: "/auth/login" });
    expect(res.statusCode).toBe(302);
    expect(location(res)).toBe("/?login_error=provider_error");
    expect(sessionSet(res)).toBeUndefined();
    idp.discovery = {
      issuer: idp.issuer,
      authorization_endpoint: `${idp.base}/application/o/authorize/`,
      token_endpoint: `${idp.base}/application/o/token/`,
      jwks_uri: `${idp.issuer}jwks/`,
      code_challenge_methods_supported: ["plain", "S256"],
    };
  });

  it("the server log names the internal reason (fixed identifiers only); the URL keeps the coarse code", async () => {
    idp.discovery = 503;
    h = await harness();
    const down = await h.app.inject({ method: "GET", url: "/auth/login" });
    expect(location(down)).toBe("/?login_error=provider_error");
    expect(h.logs).toContain("warn login failed: provider_error (internal: discovery_failed)");
    idp.discovery = {
      issuer: idp.issuer,
      authorization_endpoint: `${idp.base}/application/o/authorize/`,
      token_endpoint: `${idp.base}/application/o/token/`,
      jwks_uri: `${idp.issuer}jwks/`,
      code_challenge_methods_supported: ["plain", "S256"],
    };
    h = await harness();
    mintedTokens.length = 0;
    const replay = await loginFlow([MEMBER_GROUP]);
    const url = `/auth/callback?code=${encodeURIComponent(replay.code)}&state=${encodeURIComponent(replay.state)}`;
    const again = await h.app.inject({ method: "GET", url, headers: { cookie: replay.tx } });
    expect(location(again)).toBe("/?login_error=exchange_failed");
    const stale = await h.app.inject({ method: "GET", url });
    expect(location(stale)).toBe("/?login_error=state_mismatch");
    expect(h.logs).toContain("warn login failed: exchange_failed");
    expect(h.logs).toContain("warn login failed: state_mismatch (internal: no_valid_transaction_cookie)");
    const text = h.logs.join("\n");
    for (const value of [CLIENT_SECRET, SESSION_SECRET, replay.code, replay.state, replay.tx.split("=")[1]!, ...mintedTokens]) {
      expect(text).not.toContain(value);
    }
    for (const line of h.logs.filter((l) => l.includes("login failed"))) {
      expect(line).toMatch(/^warn login failed: [a-z_]+( \(internal: [a-z_]+\))?$/);
    }
  });

  it("every login_error the server can emit is in the allowlist", async () => {
    const seen = h.logs.concat();
    for (const line of seen.filter((l) => l.startsWith("warn login failed: "))) {
      expect(LOGIN_ERROR_CODES).toContain(line.slice("warn login failed: ".length).split(" ")[0]);
    }
    expect(LOGIN_ERROR_CODES).toEqual(expect.arrayContaining(["access_denied", "state_mismatch", "session_too_large", "failed"]));
  });
});

describe("session cookie", () => {
  it("role matrix: admin, member, none", async () => {
    const a = await admin();
    const m = await member();
    const none = await cookieOf(["staff"]);
    expect((await call("GET", "/api/estimate", a)).statusCode).toBe(200);
    expect((await call("GET", "/api/estimate", m)).statusCode).toBe(403);
    expect((await call("GET", "/api/state", m)).statusCode).toBe(200);
    expect((await call("GET", "/api/me", none)).statusCode).toBe(403);
    expect((await call("GET", "/api/state", none)).statusCode).toBe(403);
  });

  it("tampered and expired session cookies are 401", async () => {
    const { cookie } = await member();
    const [name, value] = cookie.split("=");
    const [hd, p, sig] = value!.split(".");
    const payload = { ...JSON.parse(Buffer.from(p!, "base64url").toString()), groups: [ADMIN_GROUP] };
    const forged = `${name}=${hd}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`;
    expect((await call("GET", "/api/state", { cookie: forged })).statusCode).toBe(401);
    expect((await call("GET", "/api/state", { cookie: `${cookie}x` })).statusCode).toBe(401);
    expect((await call("GET", "/api/state", { cookie })).statusCode).toBe(200);
    h.clock.ms += 8 * 3_600_000 + 1000;
    expect((await call("GET", "/api/state", { cookie })).statusCode).toBe(401);
  });

  it("a plain-name session cookie is ignored in secure mode", async () => {
    const { cookie } = await admin();
    const plain = cookie.replace(NAMES.session, SESSION_COOKIE);
    expect(plain.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect((await call("GET", "/api/state", { cookie: plain })).statusCode).toBe(401);
  });

  it("logout clears both cookies with 204 (also without a session) and applies the Origin rule", async () => {
    const { cookie } = await member();
    const json = { "content-type": "application/json" };
    const ok = await h.app.inject({ method: "POST", url: "/auth/logout", headers: { ...json, cookie, origin: PUBLIC_ORIGIN }, payload: {} });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers["cache-control"]).toBe("no-store");
    const cleared = setCookies(ok);
    expect(cleared).toHaveLength(2);
    expect(cleared).toContainEqual(expect.stringMatching(new RegExp(`^${NAMES.session}=; .*Max-Age=0.*Secure`)));
    expect(cleared).toContainEqual(expect.stringMatching(new RegExp(`^${NAMES.transaction}=; .*Max-Age=0`)));
    const anon = await h.app.inject({ method: "POST", url: "/auth/logout", headers: { ...json, "sec-fetch-site": "same-origin" }, payload: {} });
    expect(anon.statusCode).toBe(204);
    for (const headers of [{ origin: "https://evil.example.test" }, {}, { "sec-fetch-site": "cross-site" }]) {
      const res = await h.app.inject({ method: "POST", url: "/auth/logout", headers: { ...json, cookie, ...headers }, payload: {} });
      expect(res.statusCode, JSON.stringify(headers)).toBe(403);
      expect(res.json().error.code).toBe("csrf");
      expect(setCookies(res)).toEqual([]);
    }
    const text = await h.app.inject({ method: "POST", url: "/auth/logout", headers: { cookie, origin: PUBLIC_ORIGIN, "content-type": "text/plain" }, payload: "x" });
    expect(text.statusCode).toBe(415);
  });
});

describe("CSRF: Origin and Sec-Fetch-Site on state-changing requests", () => {
  it("POST /api/start: cross-site Origin 403; matching Origin ok; no Origin + same-origin ok; anything else 403", async () => {
    h = await harness({ ready: false });
    const { cookie } = await admin();
    const start = (headers: Record<string, string>) =>
      h.app.inject({ method: "POST", url: "/api/start", headers: { cookie, "content-type": "application/json", ...headers }, payload: { confirm: true } });
    const refused: Record<string, string>[] = [
      { origin: "https://evil.example.test" },
      { origin: "null" },
      { origin: "https://sub.comfy.example.test" },
      { origin: "http://comfy.example.test" },
      { origin: `${PUBLIC_ORIGIN}:443x` },
      {},
      { "sec-fetch-site": "none" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "cross-site" },
      { origin: PUBLIC_ORIGIN, "sec-fetch-site": "cross-site" },
      { origin: "https://evil.example.test", "sec-fetch-site": "same-origin" },
    ];
    for (const headers of refused) {
      const res = await start(headers);
      expect(res.statusCode, JSON.stringify(headers)).toBe(403);
      expect(res.json().error.code).toBe("csrf");
    }
    expect(h.vast.creates).toBe(0);
    const matching = await start({ origin: PUBLIC_ORIGIN });
    expect(matching.statusCode).toBe(200);
    const sameOrigin = await start({ "sec-fetch-site": "same-origin" });
    expect(sameOrigin.statusCode).toBe(409); // passed the gate; refused only because one is active
    expect(h.vast.creates).toBe(1);
  });

  it("GET navigations are exempt; anonymous POSTs are still 401 first", async () => {
    expect((await call("GET", "/api/state", { ...(await member()), origin: "https://evil.example.test" })).statusCode).toBe(200);
    expect((await h.app.inject({ method: "GET", url: "/auth/login", headers: { "sec-fetch-site": "cross-site" } })).statusCode).toBe(302);
    expect((await post("/api/start", { origin: "https://evil.example.test" }, { confirm: true })).statusCode).toBe(401);
  });
});

describe("unconfigured auth fails closed", () => {
  for (const [label, over] of [
    ["client secret empty", { authentikClientSecret: "" }],
    ["issuer empty", { authentikIssuer: "" }],
    ["public URL empty", { webPublicUrl: "" }],
    ["session secret too short", { webSessionSecret: "too-short" }],
  ] as const) {
    it(`${label}: every /api route 401 (even with a cookie that would be valid), /auth/login 503`, async () => {
      const valid = (await admin()).cookie; // from the configured harness, same secret
      h = await harness({ cfg: over });
      expect(h.logs.filter((l) => l.includes("FAIL-CLOSED"))).toHaveLength(1);
      for (const r of registeredRoutes(h.app).filter((x) => x.url.startsWith("/api/"))) {
        const url = r.url.replace(":id", "p-1").replace(":index", "0");
        const res = await call(r.method as Method, url, { cookie: valid, origin: PUBLIC_ORIGIN }, r.method === "POST" ? {} : undefined);
        expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
      }
      for (const url of ["/auth/login", "/auth/callback?code=c&state=s"]) {
        const res = await h.app.inject({ method: "GET", url });
        expect(res.statusCode).toBe(503);
        expect(res.json()).toEqual({ error: { code: "auth_not_configured", message: expect.any(String) } });
        expect(res.headers["set-cookie"]).toBeUndefined();
      }
      expect((await call("GET", "/healthz")).statusCode).toBe(200);
      writeFileSync(join(h.publicDir, "index.html"), "<!doctype html><title>x</title>");
      expect((await call("GET", "/")).statusCode).toBe(200);
    });
  }
});

describe("secrecy across the login flow", () => {
  it("no secret, token, code, state or cookie value in any body, non-cookie header or log line", async () => {
    const seen: string[] = [];
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) => {
      const original = console[m];
      console[m] = (...args: unknown[]) => void seen.push(args.map(String).join(" "));
      return () => (console[m] = original);
    });
    try {
      mintedTokens.length = 0;
      const ok = await loginFlow([ADMIN_GROUP, MEMBER_GROUP], { sub: "root" });
      const bad = await loginFlow([ADMIN_GROUP], { edit: (q) => ({ query: `code=${q.code}&state=${q.state}x`, cookie: q.cookie }) });
      const session = pairOf(sessionSet(ok.cb)!);
      const headers = { cookie: session, origin: PUBLIC_ORIGIN };
      const responses = [
        ok.start, ok.cb, bad.start, bad.cb,
        await call("GET", "/api/state", headers),
        await call("GET", "/api/me", headers),
        await h.app.inject({ method: "POST", url: "/auth/logout", headers: { ...headers, "content-type": "application/json" }, payload: {} }),
      ];
      const sensitive = [
        CLIENT_SECRET, SESSION_SECRET, ok.code, bad.code, ...mintedTokens,
        session.split("=")[1]!, ok.tx.split("=")[1]!, bad.tx.split("=")[1]!, "fake-access-token",
      ];
      for (const res of responses) {
        const { "set-cookie": _cookies, location: loc, ...rest } = res.headers;
        const dump = `${res.body}\n${JSON.stringify(rest)}`;
        for (const value of sensitive) expect(dump).not.toContain(value);
        // Only the IdP redirect may carry state/nonce (by design); never a secret or a code.
        for (const value of [CLIENT_SECRET, SESSION_SECRET, ok.code, bad.code, ...mintedTokens]) expect(String(loc ?? "")).not.toContain(value);
      }
      const logText = `${h.logs.join("\n")}\n${seen.join("\n")}`;
      for (const value of [...sensitive, ok.state, bad.state]) expect(logText).not.toContain(value);
      for (const line of h.logs) expect(line.length).toBeLessThan(200);
    } finally {
      spies.forEach((restore) => restore());
    }
  });
});

describe("server timeouts", () => {
  it("come from config", () => {
    expect(h.app.initialConfig).toMatchObject({ requestTimeout: 30_000, connectionTimeout: 60_000, keepAliveTimeout: 75_000 });
  });
});

describe("GPU choice", () => {
  const P40: Offer = { id: 5, dph_total: 0.1, gpu_name: "Tesla P40", gpu_ram: 24576 };
  const A5000: Offer = { id: 11, dph_total: 0.3, gpu_name: "RTX A5000", gpu_ram: 24564 };
  const R4090: Offer = { id: 40, dph_total: 0.45, gpu_name: "RTX 4090", gpu_ram: 24564 };

  it("GET /api/gpus: 401 anonymous, 403 member, the allowed models with prices for an admin", async () => {
    h.vast.offers = [P40, A5000, R4090];
    expect((await call("GET", "/api/gpus")).statusCode).toBe(401);
    expect((await call("GET", "/api/gpus", await member())).statusCode).toBe(403);
    const res = await call("GET", "/api/gpus", await admin());
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({
      gpus: [
        { name: "RTX A5000", dph: 0.3, vram_gb: 24, available: true, location: null, down_mbps: null },
        { name: "RTX 3090", dph: null, vram_gb: null, available: false, location: null, down_mbps: null },
        { name: "RTX 4090", dph: 0.45, vram_gb: 24, available: true, location: null, down_mbps: null },
      ],
    });
    expect(res.body).not.toMatch(/P40|offer|"id"/);
    expect(h.vast.searches).toHaveLength(1);
  });

  it("GET /api/estimate?gpu=: restricted to the model, 400 outside the allow-list, 409 without offers", async () => {
    h.vast.offers = [P40, A5000, R4090];
    const a = await admin();
    const ok = await call("GET", "/api/estimate?gpu=RTX%204090", a);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ gpu_name: "RTX 4090", dph: 0.45, horizon_hours: 3, max_cost: 0.45 * 3, location: null, down_mbps: null });
    expect(h.vast.searches.at(-1)!.allowedGpus).toEqual(["RTX 4090"]);
    const before = h.vast.searches.length;
    const bad = await call("GET", "/api/estimate?gpu=Tesla%20P40", a);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("gpu_not_allowed");
    expect(h.vast.searches).toHaveLength(before);
    expect((await call("GET", "/api/estimate?gpu=RTX%203090", a)).json().error.code).toBe("no_offers");
    expect((await call("GET", "/api/estimate?gpu=RTX%203090", a)).statusCode).toBe(409);
    for (const q of ["gpu=a&gpu=b", "gpu=", `gpu=${"x".repeat(65)}`, "vast_offer=5"]) {
      const res = await call("GET", `/api/estimate?${q}`, a);
      expect(res.statusCode, q).toBe(400);
      expect(res.json().error.code, q).toBe("invalid_body");
    }
    expect(h.vast.searches).toHaveLength(before + 2);
  });

  it("POST /api/start {gpu}: validated by schema and allow-list before anything is rented", async () => {
    h = await harness({ ready: false, cfg: { startRateLimitPerHour: 50 } });
    h.vast.offers = [P40, A5000, R4090];
    const a = await admin();
    for (const body of [
      { confirm: true, gpu: 5 },
      { confirm: true, gpu: ["RTX 4090"] },
      { confirm: true, gpu: null },
      { confirm: true, gpu: "x".repeat(65) },
      { confirm: true, gpu: "RTX 4090", vast_offer: 40 },
      { confirm: true, gpu: "RTX 4090", host: "203.0.113.9" },
      { gpu: "RTX 4090" },
    ]) {
      const res = await post("/api/start", a, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
    const SNEAKY = "Tesla P40 vast-host Bearer sneaky-input-123";
    for (const gpu of ["Tesla P40", "rtx 4090", "RTX 4090,Tesla P40", SNEAKY]) {
      const res = await post("/api/start", a, { confirm: true, gpu });
      expect(res.statusCode, gpu).toBe(400);
      expect(res.json().error.code).toBe("gpu_not_allowed");
    }
    expect(h.logs.filter((l) => l === "warn start refused: gpu_not_allowed")).toHaveLength(4);
    // The user-supplied name never reaches a log line.
    for (const l of h.logs) expect(l).not.toMatch(/P40|rtx 4090|sneaky/);
    expect(h.vast.searches).toHaveLength(0);
    expect(h.vast.creates).toBe(0);
    expect(await h.registry.all()).toEqual([]);
    const none = await post("/api/start", a, { confirm: true, gpu: "RTX 3090" });
    expect(none.statusCode).toBe(409);
    expect(none.json().error.code).toBe("no_offers");
    const ok = await post("/api/start", a, { confirm: true, gpu: "RTX 4090" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().estimate).toEqual({ gpu_name: "RTX 4090", dph: 0.45, horizon_hours: 3, max_cost: 0.45 * 3, location: null, down_mbps: null });
    expect(h.vast.searches.map((f) => f.allowedGpus)).toEqual([["RTX 3090"], ["RTX 4090"]]);
    expect(h.vast.creates).toBe(1);
  });

  it("an empty allow-list fails closed with 503 no_gpu_configured on all three endpoints", async () => {
    h = await harness({ ready: false, cfg: { vastAllowedGpus: [] } });
    h.vast.offers = [P40];
    const a = await admin();
    for (const res of [
      await call("GET", "/api/gpus", a),
      await call("GET", "/api/estimate", a),
      await call("GET", "/api/estimate?gpu=RTX%20A5000", a),
      await post("/api/start", a, { confirm: true }),
      await post("/api/start", a, { confirm: true, gpu: "Tesla P40" }),
    ]) {
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("no_gpu_configured");
    }
    expect(h.logs.filter((l) => l === "warn start refused: no_gpu_configured")).toHaveLength(2);
    for (const l of h.logs) expect(l).not.toContain("P40");
    expect(h.vast.searches).toHaveLength(0);
    expect(h.vast.creates).toBe(0);
  });

  it("GET /api/state carries gpu_name and the overall download for members too", async () => {
    h.vast.instances[0]!["gpu_name"] = "RTX A5000";
    const [s1] = profile.models.map((m) => m.size_bytes) as [number];
    const total = profile.models.reduce((n, m) => n + m.size_bytes, 0);
    h.setAgent((s, res) =>
      json(res, 200, agentStatus("downloading", {
        progress: { phase: "models", file: "qwen3vl_8b_int8_convrot.safetensors", bytes_done: 1000, bytes_total: 9350798360 },
      })),
    );
    for (const who of [await admin(), await member()]) {
      const body = (await call("GET", "/api/state", who)).json();
      expect(body.gpu_name).toBe("RTX A5000");
      expect(body.download).toEqual({
        files_total: profile.models.length, files_done: 1, bytes_done: s1 + 1000, bytes_total: total, current_file: "qwen3vl_8b_int8_convrot.safetensors",
      });
    }
    h.setAgent((s, res) => json(res, 200, agentStatus("ready")));
    const ready = (await call("GET", "/api/state", await member())).json();
    expect(ready.download).toBeNull();
  });

  it("a failed start names a fixed reason in the log and the body, never a secret", async () => {
    for (const authKey of [async () => "", async () => Promise.reject(new Error(`ENOENT ${AUTH_KEY} ${VAST_KEY}`))]) {
      h = await harness({ ready: false, authKey });
      const res = await post("/api/start", await admin(), { confirm: true, gpu: "RTX A5000" });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({
        error: { code: "start_failed", reason: "ts_key_missing", message: "the Tailscale auth key is missing or empty on the server" },
      });
      expect(h.logs).toContain("warn start failed: StartError (internal: ts_key_missing)");
      for (const text of [res.body, h.logs.join("\n")]) {
        for (const secret of [AUTH_KEY, VAST_KEY, TOKEN, "ENOENT"]) expect(text).not.toContain(secret);
      }
      expect(h.vast.searches).toHaveLength(0);
    }
  });

  it("a failed OAuth key mint is start_failed with reason ts_key_mint_failed and a fixed English message", async () => {
    h = await harness({ ready: false, authKey: async () => Promise.reject(new TailscaleError("oauth_failed")) });
    const res = await post("/api/start", await admin(), { confirm: true, gpu: "RTX A5000" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: {
        code: "start_failed",
        reason: "ts_key_mint_failed",
        message: "a Tailscale auth key could not be created through the OAuth client; nothing was rented",
      },
    });
    expect(h.logs).toContain("warn start failed: StartError (internal: ts_key_mint_failed)");
    for (const text of [res.body, h.logs.join("\n")]) {
      for (const secret of [AUTH_KEY, VAST_KEY, TOKEN]) expect(text).not.toContain(secret);
    }
    expect(h.vast.searches).toHaveLength(0);
    const doc = JSON.parse(readFileSync(OPENAPI, "utf8")) as { components: { schemas: Record<string, { enum?: string[] }> } };
    expect(doc.components.schemas["StartFailReason"]?.enum).toContain("ts_key_mint_failed");
  });
});

describe("boot console route", () => {
  it("401 without a session, 403 for a member, 200 no-store for an admin", async () => {
    expect((await call("GET", "/api/console")).statusCode).toBe(401);
    const m = await member();
    const forbidden = await call("GET", "/api/console", m);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe("forbidden");
    expect(h.vast.logCalls).toBe(0);
    h.vast.logText = "[boot] step 1/8: install_tools\nhello\n";
    const res = await call("GET", "/api/console", await admin());
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["generation", "instance", "last_seq", "lines", "phases", "source_error", "truncated"]);
    expect(body.instance).toEqual({ state: "ready", ended: false, ended_reason: null });
    expect(body.lines.map((l: { text: string }) => l.text)).toEqual(["[boot] step 1/8: install_tools", "hello"]);
    expect(body.phases.map((p: { id: string }) => p.id)).toEqual([
      "image_pull", "net_probe", "install_tools", "failsafe", "tailscale", "agent", "nodes", "models", "comfyui", "ready",
    ]);
    expect(body.phases[2]).toEqual({ id: "install_tools", name: "Install tools", status: "running" });
  });

  it("validates after", async () => {
    const a = await admin();
    for (const q of ["abc", "-1", "1.5", "01", "1e3", "9007199254740992", "99999999999999999", "", "1&after=2", "1&x=1"]) {
      const res = await call("GET", `/api/console?after=${q}`, a);
      expect(res.statusCode, q).toBe(400);
    }
    for (const q of ["0", "7", "9007199254740991"]) expect((await call("GET", `/api/console?after=${q}`, a)).statusCode, q).toBe(200);
    expect((await call("GET", "/api/console", a)).statusCode).toBe(200);
  });

  it("never returns a secret or the instance hostname", async () => {
    h.vast.logText = [
      `key ${VAST_KEY}`,
      `token ${TOKEN}`,
      `auth ${AUTH_KEY}`,
      `secret ${CLIENT_SECRET} ${SESSION_SECRET}`,
      `joined as ${HOST}`,
      "Authorization: Bearer abc.def",
      "",
    ].join("\n");
    const res = await call("GET", "/api/console?after=0", await admin());
    expect(res.statusCode).toBe(200);
    for (const secret of [VAST_KEY, TOKEN, AUTH_KEY, CLIENT_SECRET, SESSION_SECRET, HOST, "abc.def", "SECRETKEY"]) {
      expect(res.body).not.toContain(secret);
    }
    expect(res.json().lines.map((l: { text: string }) => l.text)).toContain("joined as [host]");
  });

  it("matches the documented Console schema", async () => {
    const doc = JSON.parse(readFileSync(OPENAPI, "utf8"));
    const schema = doc.components.schemas.Console;
    const body = (await call("GET", "/api/console", await admin())).json();
    expect(Object.keys(body).sort()).toEqual([...schema.required].sort());
    expect(Object.keys(schema.properties.instance.properties).sort()).toEqual(Object.keys(body.instance).sort());
    expect(doc.components.schemas.ConsolePhase.properties.id.enum).toEqual(body.phases.map((p: { id: string }) => p.id));
    expect(doc.paths["/api/console"].get.parameters[0].name).toBe("after");
  });
});

describe("usage history route", () => {
  it("401 without a session, 403 for a member, 200 no-store for an admin", async () => {
    expect((await call("GET", "/api/history")).statusCode).toBe(401);
    const forbidden = await call("GET", "/api/history", await member());
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe("forbidden");
    const res = await call("GET", "/api/history", await admin());
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(res.json())).toEqual(["entries"]);
    // The harness's running instance predates the history: adopted, who started it is unknown.
    expect(res.json().entries).toEqual([expect.objectContaining({ active: true, started_by: null, vast_instance_id: VAST_ID })]);
  });

  it("records who started and who destroyed, newest first, with no hostname, token or email", async () => {
    h = await harness({ ready: false });
    const boss = await as("boss@example.com", [ADMIN_GROUP]);
    expect((await post("/api/start", boss, { confirm: true })).statusCode).toBe(200);
    h.clock.ms += 3_600_000;
    expect((await post("/api/destroy", await admin())).statusCode).toBe(200);
    const res = await call("GET", "/api/history", boss);
    const [e] = res.json().entries;
    expect(e).toMatchObject({
      vast_instance_id: 1000, gpu_name: "RTX A5000", dph: 0.3, started_at: NOW_S, ended_at: NOW_S + 3600,
      duration_s: 3600, started_by: "boss", reason: "destroy_button", stop_by: "root", active: false,
    });
    expect(e.estimated_cost).toBeCloseTo(0.3);
    for (const bad of ["vast-new", "example.com", TOKEN, AUTH_KEY, VAST_KEY]) expect(res.body).not.toContain(bad);
    expect(h.logs).toContain("info usage: start gpu=RTX A5000 dph=0.300 by=boss");
    expect(h.logs).toContain("info usage: stop reason=destroy_button duration_s=3600 by=root");
    for (const l of h.logs) expect(l).not.toMatch(/vast-new|example\.com/);
  });

  it("matches the documented History schema and the stop reason enum", async () => {
    const doc = JSON.parse(readFileSync(OPENAPI, "utf8"));
    const body = (await call("GET", "/api/history", await admin())).json();
    const entry = doc.components.schemas.HistoryEntry;
    expect(entry.additionalProperties).toBe(false);
    expect(Object.keys(body.entries[0]).sort()).toEqual([...entry.required].sort());
    expect(Object.keys(entry.properties).sort()).toEqual([...entry.required].sort());
    expect(doc.components.schemas.UsageStopReason.enum).toEqual([...STOP_REASONS]);
    expect(doc.paths["/api/history"].get.responses["200"].content["application/json"].schema.required).toEqual(["entries"]);
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
    for (const route of ["GET /auth/login", "GET /auth/callback", "POST /auth/logout", "GET /api/me"]) expect(documented).toContain(route);
  });

  it("documents the cookie scheme and exactly the allowlisted login_error codes", () => {
    const text = readFileSync(OPENAPI, "utf8");
    const doc = JSON.parse(text);
    expect(text).not.toMatch(/authentik-jwt|authentikJwt/i);
    expect(doc.components.securitySchemes.sessionCookie).toMatchObject({ type: "apiKey", in: "cookie", name: NAMES.session });
    expect(doc.components.schemas.LoginError.enum).toEqual([...LOGIN_ERROR_CODES]);
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

// ---- styles ----

describe("styles", () => {
  const LORA = "Qwen2.1_Anything2RealCharacters.safetensors";
  // The sample presets, on for the live test (presets: nothing to download).
  const SAMPLES = ["portrait_photo", "family_photo", "anime", "outfit_swap", "photo_restore", "to_anime"];

  /** The shipped profile with the Anything to Real style switched on (its LoRA among the models). */
  function styledProfile(mutate?: (doc: any) => void): typeof profile { // eslint-disable-line @typescript-eslint/no-explicit-any
    const doc = parseYaml(readFileSync(repo("instance/profiles/image.yaml"), "utf8"));
    doc.models = doc.models.filter((m: { file: string }) => m.file !== LORA);
    doc.models.push({ file: LORA, repo: "org/loras", revision: "a".repeat(40), dest: "models/loras/", size_bytes: 1000 });
    doc.styles[0].enabled = true;
    // The plain LoRA mechanism: without the shipped style's own prompt and one-image rule (tested on its own below).
    for (const key of ["prompt_template", "references", "hint"]) delete doc.styles[0][key];
    mutate?.(doc);
    const dir = mkdtempSync(join(tmpdir(), "styled-profile-"));
    tempDirs.push(dir);
    const path = join(dir, "image.yaml");
    writeFileSync(path, stringifyYaml(doc));
    return loadProfile(path);
  }

  const asked = { style: { id: "anything2real", params: { strength: 0.85 } } };

  it("lists the enabled styles in /api/state with their limits, and nothing about the LoRA file or the workflow nodes", async () => {
    h = await harness({ profile: styledProfile() });
    const body = (await call("GET", "/api/state", await member())).json();
    expect(body.styles.map((s: { id: string }) => s.id)).toEqual(["anything2real", "faceswap", ...SAMPLES]);
    expect(body.styles.slice(0, 2)).toEqual([
      {
        id: "anything2real",
        title: "Anime / cartoon to real",
        kind: "lora",
        modes: ["edit"],
        prompt_optional: false,
        references: null,
        hint: null,
        defaults: {},
        params: [{ id: "strength", title: "LoRA strength", type: "float", min: 0, max: 1, step: 0.05, default: 0.7 }],
      },
      {
        id: "faceswap",
        title: "Face swap",
        kind: "preset",
        modes: ["edit"],
        prompt_optional: true,
        references: { min: 2, max: 2, labels: ["Scene to keep", "Face to use"] },
        hint: expect.stringContaining("consent"),
        defaults: {},
        params: [],
      },
    ]);
    const text = JSON.stringify(body.styles);
    for (const secret of [LORA, "model_from", "model_to", '"lora":', "prompt_template", "target", "\"4\""]) expect(text).not.toContain(secret);
  });

  it("the shipped profile offers the style", async () => {
    expect((await call("GET", "/api/state", await member())).json().styles.map((s: { id: string }) => s.id)).toEqual(["anything2real", "faceswap", ...SAMPLES]);
  });

  it("with the style off, state.styles is empty and the style is refused as unknown", async () => {
    h = await harness({ profile: styledProfile((doc) => (doc.styles[0].enabled = false)) });
    const m = await member();
    expect((await call("GET", "/api/state", m)).json().styles.map((s: { id: string }) => s.id)).toEqual(["faceswap", ...SAMPLES]);
    h.setComfy(comfyEdit());
    const res = await post("/api/edit", m, { ...okEdit, style: { id: "anything2real" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("unknown_style");
    expect(h.comfySeen).toHaveLength(0);
  });

  it("an edit with a style submits the workflow with the LoRA loader at the asked strength", async () => {
    h = await harness({ profile: styledProfile() });
    h.setComfy(comfyEdit());
    const res = await post("/api/edit", await member(), { ...okEdit, ...asked });
    expect(res.statusCode).toBe(202);
    const sent = JSON.parse(h.comfySeen[h.comfySeen.length - 1]!.body).prompt;
    expect(sent["style_lora"].inputs).toEqual({ model: ["1", 0], lora_name: LORA, strength_model: 0.85 });
    expect(sent["4"].inputs.model).toEqual(["style_lora", 0]);
  });

  it("a styled job's label names the style, so a saved image says how it was made", async () => {
    h = await harness({ profile: styledProfile() });
    h.setComfy(realView(comfyEdit([{ filename: "e.png", subfolder: "", type: "output" }])));
    const m = await member("ayu");
    const res = await post("/api/edit", m, { ...okEdit, ...asked });
    expect(res.statusCode).toBe(202);
    expect((await call("GET", `/api/generate/${res.json().id}`, m)).json().status).toBe("done");
    expect((await post("/api/gallery", m, { job: res.json().id, index: 0 })).statusCode).toBe(201);
    const head = await h.galleryStore.head(h.galleryStore.keys()[0]!);
    expect(head!.metadata["kind"]).toBe("edit");
    expect(decodeURIComponent(head!.metadata["label"]!)).toBe("preview, 1024, 1 reference, Anime / cartoon to real");
    expect(decodeURIComponent(head!.metadata["prompt"]!)).toBe("make it real");
  });

  const bad: [string, "edit" | "generate", unknown, string][] = [
    ["an unknown style", "edit", { id: "nope" }, "unknown_style"],
    ["an edit-only style in generate", "generate", { id: "anything2real" }, "style_not_for_mode"],
    ["a strength out of range", "edit", { id: "anything2real", params: { strength: 3 } }, "invalid_style_param"],
    ["a strength off its step", "edit", { id: "anything2real", params: { strength: 0.72 } }, "invalid_style_param"],
    ["a text strength", "edit", { id: "anything2real", params: { strength: "0.7" } }, "invalid_style_param"],
    ["a param the style does not have", "edit", { id: "anything2real", params: { node: "4" } }, "unknown_style_param"],
    ["a style that is not an object", "edit", "anything2real", "invalid_style"],
    ["extra keys in the style", "edit", { id: "anything2real", lora: "x.safetensors" }, "invalid_style"],
  ];
  it.each(bad)("400 for %s, and nothing reaches ComfyUI", async (_name, mode, style, code) => {
    h = await harness({ profile: styledProfile() });
    h.setComfy(comfyEdit());
    const m = await member();
    const res = mode === "edit" ? await post("/api/edit", m, { ...okEdit, style }) : await post("/api/generate", m, { ...okGen, style });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(code);
    expect(h.comfySeen).toHaveLength(0);
  });

  it("500 profile_mismatch when the workflow does not have the nodes the style names", async () => {
    h = await harness({ profile: styledProfile((d) => (d.styles[0].lora.model_to.node = "99")) });
    h.setComfy(comfyEdit());
    const res = await post("/api/edit", await member(), { ...okEdit, ...asked });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("profile_mismatch");
    expect(h.comfySeen).toHaveLength(0);
  });
});

describe("upscale", () => {
  const MODEL = "4x-test.pth";
  function upscaleProfile(): typeof profile {
    const doc = parseYaml(readFileSync(repo("instance/profiles/image.yaml"), "utf8"));
    doc.models.push({ file: MODEL, repo: "org/up", revision: "a".repeat(40), dest: "models/upscale_models/", size_bytes: 1000 });
    doc.upscale.enabled = true;
    doc.upscale.model = MODEL;
    const dir = mkdtempSync(join(tmpdir(), "upscale-profile-"));
    tempDirs.push(dir);
    const path = join(dir, "image.yaml");
    writeFileSync(path, stringifyYaml(doc));
    return loadProfile(path);
  }
  const small = pngOf(100, 100, "UP").toString("base64");
  const ok = { image: small, scale: "2x" };
  /** The edit fake already stores uploads and accepts prompts; the upscale workflow saves through node 5. */
  const comfyUp = (images: unknown[] | null = null): Handler => {
    const base = comfyEdit(images);
    return (s, res) => (s.url.startsWith("/history/") && images ? json(res, 200, { [s.url.split("/")[2]!]: { outputs: { "5": { images } }, status: { completed: true, status_str: "success" } } }) : base(s, res));
  };

  it("is off without its workflow template: state.upscale is null and POST /api/upscale is 404 with nothing sent", async () => {
    const m = await member();
    expect((await call("GET", "/api/state", m)).json().upscale).toBeNull();
    h.setComfy(comfyUp());
    const res = await post("/api/upscale", m, ok);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("upscale_unavailable");
    expect(h.comfySeen).toHaveLength(0);
  });

  it("lists the scale names and image limits only, when enabled", async () => {
    h = await harness({ profile: upscaleProfile() });
    const body = (await call("GET", "/api/state", await member())).json();
    expect(body.upscale).toEqual({ scales: ["2x", "4x"], max_bytes: 4096, max_pixels: 1_000_000, types: ["png", "jpeg", "webp"] });
    expect(JSON.stringify(body.upscale)).not.toContain(MODEL);
  });

  it("uploads the image and submits the filled workflow, then serves the job through the generate poll", async () => {
    h = await harness({ profile: upscaleProfile() });
    h.setComfy(comfyUp([{ filename: "upscale_00001_.png", subfolder: "", type: "output" }]));
    const m = await member();
    const res = await post("/api/upscale", m, ok);
    expect(res.statusCode).toBe(202);
    const prompt = JSON.parse(h.comfySeen[h.comfySeen.length - 1]!.body).prompt;
    expect(prompt["2"].inputs.model_name).toBe(MODEL);
    expect(prompt["4"].inputs.scale_by).toBe(0.5);
    expect(prompt["1"].inputs.image).toMatch(/^upscale-[0-9a-f]+\.png$/);
    const poll = await call("GET", `/api/generate/${res.json().id}`, m);
    expect(poll.json().status).toBe("done");
  });

  const bad: [string, unknown, number, string][] = [
    ["an unknown scale", { ...ok, scale: "8x" }, 400, "unknown_scale"],
    ["a result over the pixel limit", { image: pngOf(300, 300, "BIG").toString("base64"), scale: "2x" }, 400, "upscale_too_large"],
    ["text that is not an image", { image: Buffer.from("hello").toString("base64"), scale: "2x" }, 400, "invalid_reference"],
    ["a missing scale", { image: small }, 400, "invalid_body"],
    ["an extra key", { ...ok, model: "x.pth" }, 400, "invalid_body"],
  ];
  it.each(bad)("400 for %s, and nothing reaches ComfyUI", async (_n, body, status, code) => {
    h = await harness({ profile: upscaleProfile() });
    h.setComfy(comfyUp());
    const res = await post("/api/upscale", await member(), body);
    expect(res.statusCode).toBe(status);
    expect(res.json().error.code).toBe(code);
    expect(h.comfySeen).toHaveLength(0);
  });

  it("400 when the x4 model's own image is over its bound although the 2x result is not", async () => {
    // 100x100 at 2x is a 40 000 pixel result, but ImageUpscaleWithModel first makes 400x400 = 160 000.
    h = await harness({ profile: upscaleProfile(), cfg: { upscaleMaxIntermediatePixels: 100_000 } });
    h.setComfy(comfyUp());
    const res = await post("/api/upscale", await member(), ok);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("upscale_too_large");
    expect(h.comfySeen).toHaveLength(0);
  });

  it("an upscale result can be saved: kind upscale, the scale and sizes as label, no prompt", async () => {
    h = await harness({ profile: upscaleProfile() });
    h.setComfy(realView(comfyUp([{ filename: "upscale_00001_.png", subfolder: "", type: "output" }])));
    const m = await member("ayu");
    const res = await post("/api/upscale", m, { image: pngOf(100, 50, "UP").toString("base64"), scale: "2x" });
    expect(res.statusCode).toBe(202);
    const id = res.json().id as string;
    expect((await call("GET", `/api/generate/${id}`, m)).json().status).toBe("done");
    const saved = await post("/api/gallery", m, { job: id, index: 0 });
    expect(saved.statusCode).toBe(201);
    const head = await h.galleryStore.head(h.galleryStore.keys()[0]!);
    expect(head!.metadata["kind"]).toBe("upscale");
    expect(decodeURIComponent(head!.metadata["label"]!)).toBe("Upscale: 2x, 100x50 to 200x100");
    expect(decodeURIComponent(head!.metadata["prompt"]!)).toBe("");
    const item = (await call("GET", "/api/gallery", m)).json().items[0];
    expect(item).toMatchObject({ kind: "upscale", label: "Upscale: 2x, 100x50 to 200x100", prompt: "" });
  });

  it("reads the pixel bounds at startup: a bad value stops the server, not a request", async () => {
    await expect(harness({ profile: upscaleProfile(), cfg: { upscaleMaxIntermediatePixels: 0 } })).rejects.toThrow("UPSCALE_MAX_INTERMEDIATE_PIXELS");
    await expect(harness({ profile: upscaleProfile(), cfg: { upscaleMaxOutputPixels: "x" } })).rejects.toThrow("UPSCALE_MAX_OUTPUT_PIXELS");
  });

  it("needs a session and a ready instance", async () => {
    h = await harness({ profile: upscaleProfile() });
    expect((await post("/api/upscale", {}, ok)).statusCode).toBe(401);
    h = await harness({ profile: upscaleProfile(), ready: false });
    expect((await post("/api/upscale", await member(), ok)).statusCode).toBe(409);
  });
});

describe("video", () => {
  /** The shipped profile (its video files are pinned) with VIDEO_ENABLED=true. */
  function videoProfile(): typeof profile {
    return loadProfile(repo("instance/profiles/image.yaml"), { videoEnabled: true });
  }
  /** An mp4 file start: a ftyp box of brand isom, then a marker. */
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom\0\0\x02\0isomiso2avc1mp41", "latin1"), Buffer.from("UNIQUE-VIDEO-MARKER")]);
  const FILE = { filename: "vastcomfy_00001_.mp4", subfolder: "video", type: "output" };
  /** A ComfyUI that stores uploads, accepts prompts, reports the SaveVideo file (node 11) and serves `body` from /view. */
  const comfyVideo = (done = true, body: Buffer = MP4, type = "video/mp4"): Handler => (s, res) => {
    if (s.url === "/upload/image") return json(res, 200, { name: /filename="([^"]+)"/.exec(s.body)![1], subfolder: "", type: "input" });
    if (s.url === "/prompt") return json(res, 200, { prompt_id: "p-vid" });
    if (s.url.startsWith("/history/")) {
      return json(res, 200, done ? { "p-vid": { outputs: { "11": { images: [FILE], animated: [true] } }, status: { completed: true, status_str: "success" } } } : {});
    }
    if (s.url.startsWith("/view")) {
      res.writeHead(200, { "Content-Type": type });
      return res.end(body);
    }
    json(res, 404, {});
  };
  const ok = { prompt: "a fox runs through snow", size: "Landscape", duration: "About 3 s" };
  const VM_READY = { state: "ready", boot: true, bytes_done: 50, bytes_total: 50, reason: null };
  /** The fake agent's answer with the instance's video models in `models` (null leaves them out). */
  const agentWith = (models: unknown): Handler => (s, res) => {
    if (s.url === "/status") return json(res, 200, agentStatus("ready", models === null ? {} : { video_models: models }));
    if (s.url === "/video-models") return json(res, 202, { state: "downloading", boot: false, bytes_done: 0, bytes_total: 50, reason: null });
    json(res, 404, {});
  };
  /** A harness whose instance has its video models (booted with them). */
  const vharness = async (opts: Parameters<typeof harness>[0]) => {
    const made = await harness(opts);
    made.setAgent(agentWith(VM_READY));
    return made;
  };
  const sentPrompt = () => JSON.parse(h.comfySeen.find((x) => x.url === "/prompt")!.body).prompt;

  it("is off with the shipped profile: state.video is null, the entry is unavailable and POST /api/video is 404 with nothing sent", async () => {
    const m = await member();
    const body = (await call("GET", "/api/state", m)).json();
    expect(body.video).toBeNull();
    expect(body.menu.items.find((i: { id: string }) => i.id === "video")).toMatchObject({ tool: "video", available: false });
    h.setComfy(comfyVideo());
    const res = await post("/api/video", m, ok);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("video_unavailable");
    expect(h.comfySeen).toHaveLength(0);
  });

  it("lists sizes, durations in seconds and the start image limits only, when enabled", async () => {
    h = await vharness({ profile: videoProfile() });
    const body = (await call("GET", "/api/state", await member())).json();
    expect(body.video).toEqual({
      sizes: [
        { name: "Landscape", width: 1280, height: 704 },
        { name: "Portrait", width: 704, height: 1280 },
        { name: "Landscape, faster", width: 832, height: 480 },
        { name: "Portrait, faster", width: 480, height: 832 },
      ],
      durations: [{ name: "About 3 s", seconds: 3 }, { name: "About 5 s", seconds: 5 }],
      download_bytes: 9_999_658_848 + 1_409_400_960 + 6_735_906_897, // the three pinned video files
      models: { state: "ready", bytes_done: 50, bytes_total: 50, percent: 100, reason: null },
      model: null,
      max_bytes: 4096,
      max_pixels: 1_000_000,
      types: ["png", "jpeg", "webp"],
    });
    expect(body.menu.items.find((i: { id: string }) => i.id === "video")).toMatchObject({ available: true, icon: "film", category: "create" });
    const text = JSON.stringify(body.video);
    for (const secret of ["safetensors", "frames", "\"node\"", "workflow", "73"]) expect(text).not.toContain(secret);
  });

  it("text to video: submits the filled workflow, polls to done and serves the mp4 checked by its first bytes", async () => {
    h = await vharness({ profile: videoProfile() });
    h.setComfy(comfyVideo());
    const m = await member();
    const res = await post("/api/video", m, { ...ok, seed: 9 });
    expect(res.statusCode).toBe(202);
    expect(h.comfySeen.map((x) => x.url)).toEqual(["/prompt"]);
    const prompt = sentPrompt();
    expect(prompt["5"].inputs.text).toBe(ok.prompt);
    expect(prompt["8"].inputs.seed).toBe(9);
    expect(prompt["7"].inputs).toMatchObject({ width: 1280, height: 704, length: 73 });
    expect(prompt["video_start"]).toBeUndefined();
    const id = res.json().id as string;
    const poll = (await call("GET", `/api/generate/${id}`, m)).json();
    expect(poll).toEqual({ status: "done", images: [], videos: [{ index: 0, url: `/api/video/${id}/0` }], seconds: expect.any(Number), queued_seconds: null });
    const file = await call("GET", `/api/video/${id}/0`, m);
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toBe("video/mp4");
    expect(file.headers["x-content-type-options"]).toBe("nosniff");
    expect(file.headers["cache-control"]).toBe("no-store");
    expect(file.headers["content-disposition"]).toBe('inline; filename="video-0.mp4"');
    expect(file.rawPayload.equals(MP4)).toBe(true);
    expect(file.body).not.toContain("vastcomfy_00001_");
    const view = h.comfySeen.find((x) => x.url.startsWith("/view"))!;
    expect(view.url).toContain("filename=vastcomfy_00001_.mp4");
  });

  it("image to video: uploads the one start image and wires a LoadImage node; the label says so", async () => {
    h = await vharness({ profile: videoProfile() });
    h.setComfy(comfyVideo());
    const m = await member("ayu");
    const res = await post("/api/video", m, { ...ok, size: "Portrait, faster", duration: "About 5 s", image: REF_A.toString("base64") });
    expect(res.statusCode).toBe(202);
    expect(h.comfySeen.map((x) => x.url)).toEqual(["/upload/image", "/prompt"]);
    const prompt = sentPrompt();
    expect(prompt["video_start"]).toEqual({ class_type: "LoadImage", inputs: { image: expect.stringMatching(/^video-[0-9a-f]+\.png$/) } });
    expect(prompt["7"].inputs).toMatchObject({ start_image: ["video_start", 0], width: 480, height: 832, length: 121 });
  });

  const bad: [string, unknown, string][] = [
    ["an unknown size", { ...ok, size: "8K" }, "unknown_size"],
    ["an unknown duration", { ...ok, duration: "1 h" }, "unknown_duration"],
    ["a blank prompt", { ...ok, prompt: " " }, "invalid_prompt"],
    ["a long prompt", { ...ok, prompt: "x".repeat(51) }, "prompt_too_long"],
    ["a bad seed", { ...ok, seed: "1" }, "invalid_seed"],
    ["two start images", { ...ok, image: [REF_A.toString("base64"), REF_B.toString("base64")] }, "invalid_reference"],
    ["text that is not an image", { ...ok, image: Buffer.from("<html>").toString("base64") }, "invalid_reference"],
    ["an image over the size limit", { ...ok, image: pngOf(64, 64, "x".repeat(4100)).toString("base64") }, "reference_too_large"],
    ["a missing duration", { prompt: "x", size: "Landscape" }, "invalid_body"],
    ["an extra key", { ...ok, frames: 999 }, "invalid_body"],
  ];
  it.each(bad)("400 for %s, and nothing reaches ComfyUI", async (_n, body, code) => {
    h = await vharness({ profile: videoProfile() });
    h.setComfy(comfyVideo());
    const res = await post("/api/video", await member(), body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(code);
    expect(h.comfySeen).toHaveLength(0);
  });

  it("refuses a result that is not an mp4 or WebM by its first bytes, whatever its content type says", async () => {
    for (const [body, type] of [[Buffer.from("<!doctype html><script>alert(1)</script>"), "video/mp4"], [pngOf(8, 8), "video/mp4"], [MP4.subarray(0, 8), "video/mp4"]] as const) {
      h = await vharness({ profile: videoProfile() });
      h.setComfy(comfyVideo(true, body, type));
      const m = await member();
      const id = (await post("/api/video", m, ok)).json().id as string;
      expect((await call("GET", `/api/generate/${id}`, m)).json().status).toBe("done");
      const file = await call("GET", `/api/video/${id}/0`, m);
      expect(file.statusCode).toBe(502);
      expect(file.json().error.code).toBe("video_rejected");
      expect(file.body).not.toContain("script");
    }
  });

  it("refuses a result over VIDEO_MAX_BYTES; images keep their own limit", async () => {
    h = await vharness({ profile: videoProfile(), cfg: { videoMaxBytes: 1024 } });
    h.setComfy(comfyVideo(true, Buffer.concat([MP4, Buffer.alloc(2000)])));
    const m = await member();
    const id = (await post("/api/video", m, ok)).json().id as string;
    await call("GET", `/api/generate/${id}`, m);
    const file = await call("GET", `/api/video/${id}/0`, m);
    expect(file.statusCode).toBe(502);
    expect(file.json().error.code).toBe("video_too_large");
  });

  it("a video job's file is never served as an image and cannot be saved to the gallery; an image job is no video", async () => {
    h = await vharness({ profile: videoProfile() });
    h.setComfy(comfyVideo());
    const m = await member();
    const id = (await post("/api/video", m, ok)).json().id as string;
    await call("GET", `/api/generate/${id}`, m);
    expect((await call("GET", `/api/image/${id}/0`, m)).statusCode).toBe(404);
    const saved = await post("/api/gallery", m, { job: id, index: 0 });
    expect(saved.statusCode).toBe(400);
    expect(saved.json().error.code).toBe("video_not_saveable");
    expect(h.galleryStore.keys()).toHaveLength(0);
    expect((await call("GET", `/api/video/${id}/1`, m)).statusCode).toBe(404);
    h.setComfy(comfyDone([{ filename: "a.png", subfolder: "", type: "output" }]));
    const img = (await post("/api/generate", m, okGen)).json().id as string;
    expect((await call("GET", `/api/generate/${img}`, m)).json().status).toBe("done");
    expect((await call("GET", `/api/video/${img}/0`, m)).statusCode).toBe(404);
  });

  it("only the owner (or an admin) can read a video job and its file", async () => {
    h = await vharness({ profile: videoProfile() });
    h.setComfy(comfyVideo());
    const id = (await post("/api/video", await member("ayu"), ok)).json().id as string;
    const other = await member("bob");
    expect((await call("GET", `/api/generate/${id}`, other)).statusCode).toBe(404);
    expect((await call("GET", `/api/video/${id}/0`, other)).statusCode).toBe(404);
    expect((await call("GET", `/api/generate/${id}`, await admin())).json().status).toBe("done");
    expect((await call("GET", `/api/video/${id}/0`, await admin())).statusCode).toBe(200);
  });

  it("410 for the file once the instance that made it is gone, and nothing is fetched", async () => {
    h = await vharness({ profile: videoProfile() });
    h.setComfy(comfyVideo());
    const m = await member();
    const id = (await post("/api/video", m, ok)).json().id as string;
    expect((await call("GET", `/api/generate/${id}`, m)).json().status).toBe("done");
    await h.registry.update(HOST, { status: "gone" });
    const res = await call("GET", `/api/video/${id}/0`, m);
    expect(res.statusCode).toBe(410);
    expect(h.comfySeen.some((x) => x.url.startsWith("/view"))).toBe(false);
  });

  it("a video job runs until VIDEO_TIMEOUT_S, not GENERATE_TIMEOUT_S", async () => {
    h = await vharness({ profile: videoProfile(), cfg: { generateTimeoutS: 600, videoTimeoutS: 1800 } });
    h.setComfy(comfyVideo(false));
    const m = await member();
    const id = (await post("/api/video", m, ok)).json().id as string;
    h.clock.ms += 1000 * 1000;
    expect((await call("GET", `/api/generate/${id}`, m)).json().status).toBe("pending");
    h.clock.ms += 800 * 1000;
    expect((await call("GET", `/api/generate/${id}`, m)).json()).toEqual({ status: "failed", message: "generation timed out" });
  });

  it("refuses to start with a video timeout not shorter than the job memory, or a workflow that does not match", async () => {
    await expect(harness({ profile: videoProfile(), cfg: { videoTimeoutS: 3600, webJobTtlS: 3600 } })).rejects.toThrow("VIDEO_TIMEOUT_S must be shorter than WEB_JOB_TTL_S");
    await expect(harness({ profile: videoProfile(), cfg: { videoMaxBytes: 0 } })).rejects.toThrow("VIDEO_MAX_BYTES");
    const broken = structuredClone(videoTemplate);
    broken["11"].class_type = "SaveImage";
    await expect(harness({ profile: videoProfile(), videoTemplate: broken })).rejects.toThrow(/SaveVideo/);
    // With video off nothing of it is read.
    await expect(harness({ cfg: { videoTimeoutS: 0, videoMaxBytes: "x" } })).resolves.toBeDefined();
  });

  it.each([
    ["not installed", { state: "not_installed", boot: false, bytes_done: 0, bytes_total: 3000, reason: null }, /not installed/],
    ["downloading", { state: "downloading", boot: false, bytes_done: 1500, bytes_total: 3000, reason: null }, /still downloading \(50%\)/],
    ["failed", { state: "failed", boot: false, bytes_done: 0, bytes_total: 3000, reason: "download failed" }, /download failed/],
    ["not reported", null, /does not report/],
  ])("refuses a video job while the video models are %s, and nothing reaches ComfyUI", async (_n, models, message) => {
    h = await harness({ profile: videoProfile() });
    h.setAgent(agentWith(models));
    h.setComfy(comfyVideo());
    const res = await post("/api/video", await member(), ok);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("video_models_not_ready");
    expect(res.json().error.message).toMatch(message);
    expect(h.comfySeen).toHaveLength(0);
  });

  it("shows the instance's video model state, its progress and a scrubbed reason; null when the agent does not say", async () => {
    h = await harness({ profile: videoProfile() });
    h.setAgent(agentWith({ state: "downloading", boot: false, bytes_done: 750, bytes_total: 3000, reason: null }));
    expect((await call("GET", "/api/state", await member())).json().video.models).toEqual({ state: "downloading", bytes_done: 750, bytes_total: 3000, percent: 25, reason: null });
    h.setAgent(agentWith({ state: "failed", boot: false, bytes_done: 0, bytes_total: 3000, reason: `download failed from https://hf.example/x on ${HOST}` }));
    const failed = (await call("GET", "/api/state", await member())).json().video.models;
    expect(failed.state).toBe("failed");
    expect(failed.reason).not.toContain(HOST);
    expect(failed.reason).not.toContain("https://");
    h.setAgent(agentWith(null));
    expect((await call("GET", "/api/state", await member())).json().video.models).toBeNull();
  });

  it("Download video models: admins only; it asks the agent and answers with the state", async () => {
    h = await harness({ profile: videoProfile() });
    h.setAgent(agentWith({ state: "not_installed", boot: false, bytes_done: 0, bytes_total: 3000, reason: null }));
    expect((await post("/api/video-models", await member(), {})).statusCode).toBe(403);
    const res = await post("/api/video-models", await admin(), {});
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ models: { state: "downloading", bytes_done: 0, bytes_total: 50, percent: 0, reason: null } });
    expect(h.agentSeen.some((x) => x.method === "POST" && x.url === "/video-models")).toBe(true);
    expect((await post("/api/video-models", await admin(), { now: true })).statusCode).toBe(400);
  });

  it("passes the agent's refusal (code and scrubbed text) and needs video and an instance", async () => {
    h = await harness({ profile: videoProfile() });
    h.setAgent((s, res) => {
      if (s.url === "/video-models") return json(res, 409, { detail: { code: "disk_insufficient", message: `too small on ${HOST}` } });
      return json(res, 200, agentStatus("ready"));
    });
    const res = await post("/api/video-models", await admin(), {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("disk_insufficient");
    expect(res.json().error.message).toMatch(/^too small on /);
    expect(res.body).not.toContain(HOST);
    h.setAgent((s, res2) => (s.url === "/video-models" ? json(res2, 500, { detail: "boom" }) : json(res2, 200, agentStatus("ready"))));
    expect((await post("/api/video-models", await admin(), {})).json().error.code).toBe("agent_unavailable");
    h = await harness(); // video off
    expect((await post("/api/video-models", await admin(), {})).json().error.code).toBe("video_unavailable");
    h = await harness({ profile: videoProfile(), ready: false });
    expect((await post("/api/video-models", await admin(), {})).json().error.code).toBe("no_instance");
  });

  it("Start with video_models: the larger disk and INCLUDE_VIDEO_MODELS; refused where video is off", async () => {
    h = await harness({ profile: videoProfile(), ready: false, cfg: { vastVideoDiskGb: 80 } });
    const a = await admin();
    expect((await call("GET", "/api/estimate?video_models=true", a)).statusCode).toBe(200);
    expect(h.vast.searches.at(-1)).toMatchObject({ diskGb: 80 });
    expect((await call("GET", "/api/estimate?video_models=yes", a)).statusCode).toBe(400);
    expect((await post("/api/start", a, { confirm: true, video_models: "true" })).statusCode).toBe(400);
    const started = await post("/api/start", a, { confirm: true, video_models: true });
    expect(started.statusCode).toBe(200);
    expect(h.vast.searches.at(-1)).toMatchObject({ diskGb: 80 });
    h = await harness({ ready: false });
    const off = await post("/api/start", await admin(), { confirm: true, video_models: true });
    expect(off.statusCode).toBe(400);
    expect(off.json().error.code).toBe("video_unavailable");
    expect(h.vast.creates).toBe(0);
    expect((await post("/api/start", await admin(), { confirm: true, video_models: false })).statusCode).toBe(200);
  });

  const LINK = "https://huggingface.co/someone/better-video/resolve/main/better_unet.safetensors"; // config-lint: ok (test fixture)
  const BAD_LINKS: [string, string][] = [
    ["http://huggingface.co/o/r/resolve/main/m.safetensors", "invalid_model_link"], // config-lint: ok (test fixture)
    ["https://user@huggingface.co/o/r/resolve/main/m.safetensors", "invalid_model_link"], // config-lint: ok (test fixture)
    ["https://169.254.169.254/o/r/resolve/main/m.safetensors", "invalid_model_link"], // config-lint: ok (test fixture)
    ["https://huggingface.co:8443/o/r/resolve/main/m.safetensors", "invalid_model_link"], // config-lint: ok (test fixture)
    ["https://huggingface.co.evil.com/o/r/resolve/main/m.safetensors", "model_link_host_not_allowed"], // config-lint: ok (test fixture)
    ["https://huggingface.co/o/r/resolve/main/%2e%2e/m.safetensors", "invalid_model_link"], // config-lint: ok (test fixture)
    ["https://huggingface.co/o/r/resolve/main/m.ckpt", "model_link_unsupported_type"], // config-lint: ok (test fixture)
  ];

  it.each(BAD_LINKS)("Start refuses the link %s (%s) before anything is rented", async (url, code) => {
    h = await harness({ profile: videoProfile(), ready: false });
    const res = await post("/api/start", await admin(), { confirm: true, video_models: true, video_model_url: url });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(code);
    expect(h.vast.creates).toBe(0);
    expect(h.vast.searches).toHaveLength(0);
  });

  it("Start takes a link only with the video models; an empty link is the pinned model", async () => {
    h = await harness({ profile: videoProfile(), ready: false });
    const a = await admin();
    const without = await post("/api/start", a, { confirm: true, video_model_url: LINK });
    expect(without.statusCode).toBe(400);
    expect(without.json().error.code).toBe("invalid_model_link");
    expect(h.vast.creates).toBe(0);
    const started = await post("/api/start", a, { confirm: true, video_models: true, video_model_url: LINK });
    expect(started.statusCode, started.body).toBe(200);
    expect(h.vast.creates).toBe(1);
    h = await harness({ profile: videoProfile(), ready: false });
    expect((await post("/api/start", await admin(), { confirm: true, video_models: true, video_model_url: "  " })).statusCode).toBe(200);
    expect((await post("/api/start", await admin(), { confirm: true, video_models: true, video_model_url: "x".repeat(3000) })).statusCode).toBe(400);
  });

  it("Download video models passes a checked link (as its resolve URL) to the agent", async () => {
    h = await harness({ profile: videoProfile() });
    h.setAgent(agentWith({ state: "not_installed", boot: false, bytes_done: 0, bytes_total: 3000, reason: null }));
    const res = await post("/api/video-models", await admin(), { url: `${LINK.replace("/resolve/", "/blob/")}?download=true` });
    expect(res.statusCode).toBe(202);
    const sent = h.agentSeen.find((x) => x.url === "/video-models")!;
    expect(JSON.parse(sent.body)).toEqual({ url: LINK });
    h.agentSeen.length = 0;
    expect((await post("/api/video-models", await admin(), { url: null })).statusCode).toBe(202);
    expect(JSON.parse(h.agentSeen.find((x) => x.url === "/video-models")!.body)).toEqual({});
  });

  it.each(BAD_LINKS)("Download video models refuses the link %s (%s) without asking the agent", async (url, code) => {
    h = await harness({ profile: videoProfile() });
    h.setAgent(agentWith({ state: "not_installed", boot: false, bytes_done: 0, bytes_total: 3000, reason: null }));
    const res = await post("/api/video-models", await admin(), { url });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(code);
    expect(h.agentSeen.some((x) => x.url === "/video-models")).toBe(false);
  });

  it("passes the agent's link refusals: 400 for the link itself, 409 for what its host answered", async () => {
    for (const [status, code] of [[400, "model_link_name_clash"], [409, "model_link_redirect_not_allowed"], [409, "model_link_too_large"]] as const) {
      h = await harness({ profile: videoProfile() });
      h.setAgent((s, res) => (s.url === "/video-models" ? json(res, status, { detail: { code, message: "refused" } }) : json(res, 200, agentStatus("ready"))));
      const res = await post("/api/video-models", await admin(), { url: LINK });
      expect(res.statusCode).toBe(status);
      expect(res.json().error.code).toBe(code);
    }
  });

  it("a video job after a linked download loads the linked file; admins see which model is in use", async () => {
    h = await harness({ profile: videoProfile() });
    const sha = "a".repeat(64);
    h.setAgent(agentWith({ ...VM_READY, model: { file: "better_unet.safetensors", linked: true, sha256: sha } }));
    h.setComfy(comfyVideo());
    expect((await call("GET", "/api/state", await admin())).json().video.model).toEqual({ file: "better_unet.safetensors", linked: true, sha256: sha });
    expect((await call("GET", "/api/state", await member())).json().video.model).toBeNull();
    expect((await post("/api/video", await member(), ok)).statusCode).toBe(202);
    const prompt = sentPrompt();
    expect(prompt["1"].inputs.unet_name).toBe("better_unet.safetensors");
    expect(JSON.stringify(prompt)).not.toContain("wan2.2_ti2v_5B_fp16");
  });

  it("a linked .gguf model is loaded with the GGUF loader", async () => {
    h = await harness({ profile: videoProfile() });
    h.setAgent(agentWith({ ...VM_READY, model: { file: "better-Q5_K_M.gguf", linked: true, sha256: null } }));
    h.setComfy(comfyVideo());
    expect((await post("/api/video", await member(), ok)).statusCode).toBe(202);
    expect(sentPrompt()["1"]).toEqual({ class_type: "UnetLoaderGGUF", inputs: { unet_name: "better-Q5_K_M.gguf" } });
  });

  it("refuses a video job when the instance reports an unusable linked model name", async () => {
    h = await harness({ profile: videoProfile() });
    h.setAgent(agentWith({ ...VM_READY, model: { file: "../evil.safetensors", linked: true, sha256: null } }));
    h.setComfy(comfyVideo());
    const res = await post("/api/video", await member(), ok);
    expect(res.statusCode).toBe(409);
    expect(h.comfySeen).toHaveLength(0);
  });

  it("needs a session and a ready instance; the page may play blob videos (CSP media-src)", async () => {
    h = await vharness({ profile: videoProfile() });
    expect((await post("/api/video", {}, ok)).statusCode).toBe(401);
    const page = await call("GET", "/api/state", await member());
    expect(String(page.headers["content-security-policy"])).toContain("media-src 'self' blob:");
    h = await vharness({ profile: videoProfile(), ready: false });
    expect((await post("/api/video", await member(), ok)).statusCode).toBe(409);
  });
});

describe("live progress and previews", () => {
  const PROGRESS_CFG = { webProgressEnabled: true, webPreviewMaxBytes: 1024, webProgressMessageMaxBytes: 4096 };
  const step = (value: number, max: number, promptId = "p-1", node = "8") => textFrame({ type: "progress", data: { value, max, prompt_id: promptId, node } });

  /** A fake ComfyUI whose prompts finish when `done` holds their id; prompt ids are p-1, p-2, ... */
  function comfyJobs(done: Set<string>) {
    let n = 0;
    const clientIds: string[] = [];
    const handler: Handler = (s, res) => {
      if (s.url === "/prompt") {
        clientIds.push(JSON.parse(s.body).client_id);
        return json(res, 200, { prompt_id: `p-${++n}` });
      }
      const id = /^\/history\/(.+)$/.exec(s.url)?.[1];
      if (id !== undefined) {
        if (!done.has(id)) return json(res, 200, {});
        return json(res, 200, { [id]: { outputs: { "10": { images: [{ filename: "a.png", subfolder: "", type: "output" }] } }, status: { completed: true, status_str: "success" } } });
      }
      json(res, 404, {});
    };
    return { handler, clientIds };
  }

  async function pollUntil(id: string, who: Creds, check: (body: Record<string, unknown>) => boolean) {
    let body: Record<string, unknown> = {};
    const end = Date.now() + 3000;
    for (;;) {
      body = (await call("GET", `/api/generate/${id}`, who)).json();
      if (check(body)) return body;
      if (Date.now() > end) throw new Error(`job ${id} never reached the state: ${JSON.stringify(body)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it("shows the newest step and preview of a pending job, serves the preview to its owner only, and drops both when it is done", async () => {
    h = await harness({ cfg: PROGRESS_CFG });
    const done = new Set<string>();
    const fake = comfyJobs(done);
    h.setComfy(fake.handler);
    const m = await member();
    const peerP = h.comfyWs.nextPeer();
    expect((await post("/api/generate", m, okGen)).statusCode).toBe(202);
    const peer = await peerP;
    // The socket's client id is the prompt's client_id, fresh and random, never anything from the browser.
    expect(peer.clientId).toMatch(/^[0-9a-f]{32}$/);
    expect(fake.clientIds).toEqual([peer.clientId]);
    expect((await call("GET", "/api/generate/p-1/preview", m)).json().error.code).toBe("no_preview");

    h.clock.ms += 2_000;
    peer.send(textFrame({ type: "execution_start", data: { prompt_id: "p-1", timestamp: 1 } }));
    peer.send(step(3, 10));
    peer.send(step(4, 10, "p-1", "12")); // another node's progress (not the sampler) is not a step
    peer.send(previewFrame(JPEG("first")));
    peer.send(previewFrame(PNG_IMG("second"), 2));
    const pending = await pollUntil("p-1", m, (b) => b["preview_seq"] === 2);
    expect(pending).toEqual({ status: "pending", progress: { step: 3, max: 10 }, preview_seq: 2 });

    const img = await call("GET", "/api/generate/p-1/preview", m);
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.headers["cache-control"]).toBe("no-store");
    expect(img.headers["x-content-type-options"]).toBe("nosniff");
    expect(img.rawPayload.equals(PNG_IMG("second"))).toBe(true);
    expect((await call("GET", "/api/generate/p-1/preview", await member("budi"))).statusCode).toBe(404);
    expect((await call("GET", "/api/generate/p-1/preview", await admin())).statusCode).toBe(200);
    expect((await call("GET", "/api/generate/nope/preview", m)).json().error.code).toBe("not_found");

    done.add("p-1");
    const finished = (await call("GET", "/api/generate/p-1", m)).json();
    expect(finished).toMatchObject({ status: "done", queued_seconds: 2 });
    expect(finished).not.toHaveProperty("progress");
    await until(() => peer.frames().some((f) => f.op === 0x8)); // the socket was closed
    expect((await call("GET", "/api/generate/p-1/preview", m)).json().error.code).toBe("no_preview");
  });

  it("a job whose prompt finishes while the socket is open closes it, and the next job's previews do not mix", async () => {
    h = await harness({ cfg: PROGRESS_CFG });
    const done = new Set<string>();
    h.setComfy(comfyJobs(done).handler);
    const m = await member();
    const firstP = h.comfyWs.nextPeer();
    await post("/api/generate", m, okGen);
    const first = await firstP;
    first.send(previewFrame(JPEG("one")));
    await pollUntil("p-1", m, (b) => b["preview_seq"] === 1);
    first.send(textFrame({ type: "execution_success", data: { prompt_id: "p-1" } }));
    await until(() => first.frames().some((f) => f.op === 0x8));
    done.add("p-1");
    expect((await call("GET", "/api/generate/p-1", m)).json().status).toBe("done");

    const secondP = h.comfyWs.nextPeer();
    await post("/api/generate", m, okGen);
    const second = await secondP;
    expect(second.clientId).not.toBe(first.clientId);
    first.send(previewFrame(JPEG("late-from-the-first"))); // a closed job's socket is not read any more
    second.send(previewFrame(JPEG("two")));
    await pollUntil("p-2", m, (b) => b["preview_seq"] === 1);
    const img = await call("GET", "/api/generate/p-2/preview", m);
    expect(img.rawPayload.equals(JPEG("two"))).toBe(true);
    expect((await call("GET", "/api/generate/p-1/preview", m)).statusCode).toBe(404);
  });

  it("keeps working without previews: a socket that never connects, malformed and oversized frames", async () => {
    h = await harness({ cfg: PROGRESS_CFG, ws: { onUpgrade: () => false } });
    const done = new Set<string>();
    h.setComfy(comfyJobs(done).handler);
    const m = await member();
    const t0 = Date.now();
    expect((await post("/api/generate", m, okGen)).statusCode).toBe(202);
    expect(Date.now() - t0).toBeLessThan(2_500); // the wait for the socket is bounded
    expect((await call("GET", "/api/generate/p-1", m)).json()).toEqual({ status: "pending", progress: null, preview_seq: 0 });
    done.add("p-1");
    expect((await call("GET", "/api/generate/p-1", m)).json()).toMatchObject({ status: "done", queued_seconds: null });

    h = await harness({ cfg: PROGRESS_CFG });
    const done2 = new Set<string>();
    h.setComfy(comfyJobs(done2).handler);
    const m2 = await member();
    const peerP = h.comfyWs.nextPeer();
    await post("/api/generate", m2, okGen);
    const peer = await peerP;
    peer.send(textFrame("{broken"));
    peer.send(previewFrame(Buffer.from("GIF89a....")));
    peer.send(step(1, 5));
    await pollUntil("p-1", m2, (b) => (b["progress"] as { step?: number } | null)?.step === 1);
    peer.send(previewFrame(Buffer.concat([JPEG(), Buffer.alloc(2000)]))); // above WEB_PREVIEW_MAX_BYTES: the socket closes
    await until(() => peer.frames().some((f) => f.op === 0x8));
    expect((await call("GET", "/api/generate/p-1", m2)).json()).toEqual({ status: "pending", progress: { step: 1, max: 5 }, preview_seq: 0 });
    done2.add("p-1");
    expect((await call("GET", "/api/generate/p-1", m2)).json().status).toBe("done");
  });

  it("opens no socket when progress is off", async () => {
    h = await harness({ cfg: { webProgressEnabled: false } });
    h.setComfy(comfyJobs(new Set()).handler);
    await post("/api/generate", await member(), okGen);
    expect(JSON.parse(h.comfySeen.find((s) => s.url === "/prompt")!.body)).not.toHaveProperty("client_id");
    await new Promise((r) => setTimeout(r, 30));
    expect(h.comfyWs.peers).toHaveLength(0);
  });

  it("destroying the instance closes the open sockets", async () => {
    h = await harness({ cfg: PROGRESS_CFG });
    h.setComfy(comfyJobs(new Set()).handler);
    const peerP = h.comfyWs.nextPeer();
    await post("/api/generate", await member(), okGen);
    const peer = await peerP;
    expect((await post("/api/destroy", await admin())).statusCode).toBe(200);
    await until(() => peer.frames().some((f) => f.op === 0x8));
  });

  it("closes the sockets of jobs whose instance the registry shows gone (idle, failsafe, hard cap, stuck release)", async () => {
    h = await harness({ cfg: PROGRESS_CFG });
    h.setComfy(comfyJobs(new Set()).handler);
    const peerP = h.comfyWs.nextPeer();
    const m = await member();
    await post("/api/generate", m, okGen);
    const peer = await peerP;
    expect((await call("GET", "/api/state", m)).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(peer.frames().some((f) => f.op === 0x8)).toBe(false); // still the active instance: kept open
    await h.registry.update(HOST, { status: "gone" });
    await call("GET", "/api/state", m);
    await until(() => peer.frames().some((f) => f.op === 0x8));
  });

  it("documents the preview route and the pending fields", () => {
    const doc = JSON.parse(readFileSync(OPENAPI, "utf8"));
    const op = doc.paths["/api/generate/{id}/preview"].get;
    expect(Object.keys(op.responses["200"].content).sort()).toEqual(["image/jpeg", "image/png"]);
    const pending = doc.components.schemas.Job.oneOf.find((o: { properties: { status: { const: string } } }) => o.properties.status.const === "pending");
    expect(pending.required).toEqual(["status", "progress", "preview_seq"]);
    expect(pending.additionalProperties).toBe(false);
  });
});

describe("face swap preset", () => {
  const swap = (images: string[], prompt = "") => ({ ...okEdit, prompt, images, style: { id: "faceswap" } });
  const two = [REF_A.toString("base64"), REF_A.toString("base64")];

  it("refuses another number of references with a clear code and sends nothing", async () => {
    h = await harness({ cfg: { generateMaxPromptChars: 2000 } });
    h.setComfy(comfyEdit());
    const res = await post("/api/edit", await member(), swap([REF_A.toString("base64")]));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toEqual({ code: "style_reference_count", message: "this style needs exactly 2 reference images" });
    expect(h.comfySeen).toHaveLength(0);
  });

  it("submits the preset's own prompt with no LoRA, the prompt optional", async () => {
    h = await harness({ cfg: { generateMaxPromptChars: 2000 } });
    h.setComfy(comfyEdit([{ filename: "e.png", subfolder: "", type: "output" }]));
    const m = await member();
    const res = await post("/api/edit", m, swap(two));
    expect(res.statusCode).toBe(202);
    const sent = JSON.parse(h.comfySeen.at(-1)!.body).prompt;
    expect(sent["6"].inputs.prompt).toMatch(/^Edit <image1>: replace only the face .* exactly one person\.$/);
    expect(sent).not.toHaveProperty("style_lora");
    expect(sent["6"].inputs["images.image_2"]).toEqual(["ref_2", 0]);
  });

  it("the whole prompt must fit GENERATE_MAX_PROMPT_CHARS", async () => {
    const res = await post("/api/edit", await member(), swap(two)); // the default harness allows 50 characters
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("prompt_too_long");
  });
});

describe("anime / cartoon to real (a LoRA style with its own prompt)", () => {
  it("is listed with its one labelled reference and the prompt optional", async () => {
    const st = (await call("GET", "/api/state", await member())).json().styles.find((x: { id: string }) => x.id === "anything2real");
    expect(st).toMatchObject({
      title: "Anime / cartoon to real", kind: "lora", prompt_optional: true,
      references: { min: 1, max: 1, labels: ["Image to convert"] }, hint: expect.stringContaining("0 = prompt only, no LoRA"),
    });
    expect(st.params[0]).toMatchObject({ min: 0, max: 1, default: 0.7 });
    expect(JSON.stringify(st)).not.toContain("Convert this anime");
  });

  it("an edit with one image and no prompt sends the style's prompt; strength 0 adds no LoRA node", async () => {
    h = await harness({ cfg: { generateMaxPromptChars: 2000 } });
    h.setComfy(comfyEdit());
    const m = await member();
    const body = (strength: number) => ({ ...okEdit, prompt: "", style: { id: "anything2real", params: { strength } } });
    expect((await post("/api/edit", m, body(0.7))).statusCode).toBe(202);
    let sent = JSON.parse(h.comfySeen.at(-1)!.body).prompt;
    expect(sent["6"].inputs.prompt).toMatch(/^Convert this anime or cartoon illustration .* realistic lighting\.$/);
    expect(sent["style_lora"].inputs.strength_model).toBe(0.7);
    expect((await post("/api/edit", m, body(0))).statusCode).toBe(202);
    sent = JSON.parse(h.comfySeen.at(-1)!.body).prompt;
    expect(sent).not.toHaveProperty("style_lora");
    const two = await post("/api/edit", m, { ...body(0.7), images: [okEdit.images[0], okEdit.images[0]] });
    expect(two.json().error.code).toBe("style_reference_count");
  });
});

describe("negative prompt, guidance and style defaults (Advanced)", () => {
  const SAMPLES = ["portrait_photo", "family_photo", "anime", "outfit_swap", "photo_restore", "to_anime"];
  const sentPrompt = () => JSON.parse(h.comfySeen[h.comfySeen.length - 1]!.body).prompt;
  const t2i = JSON.parse(readFileSync(repo("instance/workflows/qwen-image-t2i.json"), "utf8"));

  /** The shipped profile after `change` (by default: every style switched on, as they ship since the live test). */
  function variant(change: (doc: Record<string, any>) => void = (d) => d.styles.forEach((s: { enabled: boolean }) => (s.enabled = true))): typeof profile { // eslint-disable-line @typescript-eslint/no-explicit-any
    const doc = parseYaml(readFileSync(repo("instance/profiles/image.yaml"), "utf8"));
    change(doc);
    const dir = mkdtempSync(join(tmpdir(), "advanced-profile-"));
    tempDirs.push(dir);
    const path = join(dir, "image.yaml");
    writeFileSync(path, stringifyYaml(doc));
    return loadProfile(path);
  }

  it("the shipped state: guidance, both knobs in both modes, the live styles without defaults, the samples with theirs, and no recipes", async () => {
    h = await harness();
    const body = (await call("GET", "/api/state", await member())).json();
    expect(body.guidance).toEqual({ min: 1, max: 6, step: 0.5, default: 1 });
    expect(body.advanced).toEqual({ generate: { negative_prompt: true, cfg: true }, edit: { negative_prompt: true, cfg: true }, negative_prompt_max_chars: 400 });
    expect(body.styles.map((s: { id: string }) => s.id)).toEqual(["anything2real", "faceswap", ...SAMPLES]);
    for (const st of body.styles.slice(0, 2)) expect(st.defaults).toEqual({});
    const defaults = Object.fromEntries(body.styles.slice(2).map((st: { id: string; defaults: Record<string, unknown> }) => [st.id, Object.keys(st.defaults).sort()]));
    expect(defaults).toEqual({
      portrait_photo: ["cfg", "negative_prompt"], family_photo: ["cfg", "negative_prompt"], anime: ["cfg", "negative_prompt"],
      outfit_swap: ["negative_prompt"], photo_restore: ["negative_prompt"], to_anime: ["negative_prompt"],
    });
    expect(body).not.toHaveProperty("recipes");
    expect(body).not.toHaveProperty("negative_prompt");
  });

  it("lists a style's defaults for the page to pre-fill, never its template", async () => {
    h = await harness({ profile: variant() });
    const styles = (await call("GET", "/api/state", await member())).json().styles;
    expect(styles.map((s: { id: string }) => s.id)).toEqual(["anything2real", "faceswap", ...SAMPLES]);
    const anime = styles.find((s: { id: string }) => s.id === "anime");
    expect(anime).toMatchObject({ kind: "preset", modes: ["generate"], prompt_optional: true, defaults: { cfg: 3, negative_prompt: expect.stringMatching(/^photorealistic/) } });
    expect(Object.keys(anime.defaults).sort()).toEqual(["cfg", "negative_prompt"]);
    expect(JSON.stringify(styles)).not.toContain("A high-quality anime illustration");
  });

  it("a plain request sends exactly the shipped workflow values; the knobs land where the profile maps them", async () => {
    h = await harness();
    h.setComfy(comfyDone([{ filename: "a.png", subfolder: "", type: "output" }]));
    const m = await member();
    expect((await post("/api/generate", m, { ...okGen, seed: 5 })).statusCode).toBe(202);
    expect(sentPrompt()["6"].inputs).toEqual(t2i["6"].inputs);
    expect(sentPrompt()["8"].inputs.cfg).toBe(t2i["8"].inputs.cfg);
    const res = await post("/api/generate", m, { ...okGen, negative_prompt: " hat ", cfg: 4.5 });
    expect(res.statusCode).toBe(202);
    expect(sentPrompt()["6"].inputs.text).toBe("hat");
    expect(sentPrompt()["8"].inputs.cfg).toBe(4.5);
  });

  it("edit takes the knobs too, together with a style", async () => {
    h = await harness({ cfg: { generateMaxPromptChars: 2000 } });
    h.setComfy(comfyEdit());
    const two = [REF_A.toString("base64"), REF_B.toString("base64")];
    const res = await post("/api/edit", await member(), { ...okEdit, prompt: "", images: two, style: { id: "faceswap" }, negative_prompt: "two faces", cfg: 2 });
    expect(res.statusCode).toBe(202);
    expect(sentPrompt()["6"].inputs.prompt).toMatch(/^Edit <image1>: replace only the face/);
    expect(sentPrompt()["6"].inputs.negative_prompt).toBe("two faces");
    expect(sentPrompt()["7"].inputs.cfg).toBe(2);
  });

  it("a saved image's label says which knobs were set; its metadata never holds the negative prompt text", async () => {
    h = await harness();
    h.setComfy(realView(comfyEdit([{ filename: "e.png", subfolder: "", type: "output" }])));
    const m = await member("ayu");
    const res = await post("/api/edit", m, { ...okEdit, negative_prompt: "secret words", cfg: 2 });
    expect(res.statusCode).toBe(202);
    expect((await call("GET", `/api/generate/${res.json().id}`, m)).json().status).toBe("done");
    expect((await post("/api/gallery", m, { job: res.json().id, index: 0 })).statusCode).toBe(201);
    const head = await h.galleryStore.head(h.galleryStore.keys()[0]!);
    expect(decodeURIComponent(head!.metadata["label"]!)).toBe("preview, 1024, 1 reference, guidance 2, negative prompt");
    expect(decodeURIComponent(head!.metadata["prompt"]!)).toBe("make it real");
    expect(JSON.stringify(head!.metadata)).not.toContain("secret");
  });

  it("a recipe field is no longer part of the API", async () => {
    h = await harness();
    h.setComfy(comfyEdit());
    for (const [url, body] of [["/api/generate", { ...okGen, recipe: "anime" }], ["/api/edit", { ...okEdit, recipe: "anime" }]] as const) {
      const res = await post(url, await member(), body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
    expect(h.comfySeen).toHaveLength(0);
  });

  const bad: [string, string, Record<string, unknown>, string][] = [
    ["a cfg off the grid", "/api/generate", { ...okGen, cfg: 2.25 }, "invalid_cfg"],
    ["a cfg above the range", "/api/generate", { ...okGen, cfg: 9 }, "invalid_cfg"],
    ["a cfg as text", "/api/edit", { ...okEdit, cfg: "2" }, "invalid_cfg"],
    ["a negative prompt over GENERATE_MAX_NEGATIVE_PROMPT_CHARS", "/api/generate", { ...okGen, negative_prompt: "x".repeat(401) }, "negative_prompt_too_long"],
    ["a non-text negative prompt", "/api/edit", { ...okEdit, negative_prompt: 5 }, "invalid_negative_prompt"],
  ];
  it.each(bad)("400 for %s, and nothing reaches ComfyUI", async (_n, url, body, code) => {
    h = await harness();
    h.setComfy(comfyEdit());
    const res = await post(url, await member(), body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(code);
    expect(h.comfySeen).toHaveLength(0);
  });

  it("a mode whose workflow maps no knob says so in the state and refuses them with a clear code", async () => {
    h = await harness({
      // The edit styles' knob defaults go with the mappings (an enabled style may not pre-fill an unmapped knob).
      profile: variant((d) => {
        delete d.edit.params.negative_prompt;
        delete d.edit.params.cfg;
        for (const st of d.styles) if (st.modes.includes("edit") && st.defaults) delete st.defaults.negative_prompt;
      }),
    });
    h.setComfy(comfyEdit());
    const m = await member();
    expect((await call("GET", "/api/state", m)).json().advanced.edit).toEqual({ negative_prompt: false, cfg: false });
    expect((await post("/api/edit", m, { ...okEdit, negative_prompt: "blurry" })).json().error.code).toBe("negative_prompt_unavailable");
    expect((await post("/api/edit", m, { ...okEdit, cfg: 2 })).json().error.code).toBe("cfg_unavailable");
    expect(h.comfySeen).toHaveLength(0);
    expect((await post("/api/edit", m, { ...okEdit, negative_prompt: "  " })).statusCode).toBe(202); // blank is "not set"
  });

  it("refuses to start when the guidance default is not the workflows' cfg, or a style default does not fit the limit", async () => {
    const hot = JSON.parse(readFileSync(repo("instance/workflows/qwen-image-edit.json"), "utf8"));
    hot["7"].inputs.cfg = 3;
    await expect(harness({ editTemplate: hot })).rejects.toThrow(/guidance default 1 differs from the edit workflow's cfg/);
    await expect(harness({ profile: variant() })).resolves.toBeDefined();
    await expect(harness({ profile: variant(), cfg: { generateMaxNegativePromptChars: 20 } })).rejects.toThrow(/style portrait_photo: its default negative prompt is longer than GENERATE_MAX_NEGATIVE_PROMPT_CHARS/);
  });

  it("the shipped OpenAPI document knows the knobs and no recipes", () => {
    const doc = JSON.parse(readFileSync(OPENAPI, "utf8"));
    for (const path of ["/api/generate", "/api/edit"]) {
      const props = doc.paths[path].post.requestBody.content["application/json"].schema.properties;
      expect(Object.keys(props)).toEqual(expect.arrayContaining(["negative_prompt", "cfg"]));
      expect(props).not.toHaveProperty("recipe");
      expect(doc.paths[path].post.responses["400"].description).toContain("negative_prompt_unavailable");
    }
    const state = doc.components.schemas.State;
    expect(state.required).toEqual(expect.arrayContaining(["guidance", "advanced"]));
    expect(state.properties).not.toHaveProperty("recipes");
    expect(state.properties.styles.items.required).toContain("defaults");
    expect(state.properties.styles.items.properties.defaults.additionalProperties).toBe(false);
  });
});

// ---- the tool menu ----

describe("menu", () => {
  const ITEM_KEYS = ["available", "category", "description", "icon", "id", "style", "title", "tool"];
  const items = (body: { menu: { items: { id: string; available: boolean }[] } }) => body.menu.items;
  const ids = (body: Parameters<typeof items>[0]) => items(body).map((i) => i.id);

  it("lists the categories and every entry in display order, with no template, node, file or LoRA detail", async () => {
    h = await harness({ profile });
    const body = (await call("GET", "/api/state", await member())).json();
    expect(body.menu.categories).toEqual([{ id: "create", title: "Create" }, { id: "edit", title: "Edit & combine" }, { id: "enhance", title: "Enhance" }]);
    expect(ids(body)).toEqual([
      "text_to_image", "portrait_photo", "family_photo", "anime",
      "video",
      "free_edit", "anything2real", "faceswap", "outfit_swap", "to_anime",
      "photo_restore", "upscale",
    ]);
    for (const item of body.menu.items) expect(Object.keys(item).sort()).toEqual(ITEM_KEYS);
    expect(body.menu.items[0]).toEqual({ id: "text_to_image", title: "Text to image", description: "Describe a picture and generate it.", icon: "image", category: "create", tool: "generate", style: null, available: true });
    expect(body.menu.items.find((i: { id: string }) => i.id === "photo_restore")).toMatchObject({ category: "enhance", tool: "edit", style: "photo_restore", icon: "restore", available: true });
    const text = JSON.stringify(body.menu);
    for (const secret of ["safetensors", "prompt_template", "model_from", "workflow", "Convert this anime", "\"node\"", "order"]) expect(text).not.toContain(secret);
  });

  it("marks the edit and upscale entries unavailable while that mode is off here; a disabled style has no entry", async () => {
    h = await harness({ editTemplate: null }); // edit off, and no upscale template (upscale off)
    const body = (await call("GET", "/api/state", await member())).json();
    const off = items(body).filter((i) => !i.available).map((i) => i.id);
    expect(off).toEqual(["video", "free_edit", "anything2real", "faceswap", "outfit_swap", "to_anime", "photo_restore", "upscale"]);
    expect(items(body).filter((i) => i.available).map((i) => i.id)).toEqual(["text_to_image", "portrait_photo", "family_photo", "anime"]);
    const doc = parseYaml(readFileSync(repo("instance/profiles/image.yaml"), "utf8"));
    doc.styles.find((s: { id: string }) => s.id === "anime").enabled = false;
    const dir = mkdtempSync(join(tmpdir(), "menu-profile-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "image.yaml"), stringifyYaml(doc));
    h = await harness({ profile: loadProfile(join(dir, "image.yaml")) });
    expect(ids((await call("GET", "/api/state", await member())).json())).not.toContain("anime");
  });

  it("is the same for admins and members, and the request shapes of generate, edit and upscale are unchanged", async () => {
    h = await harness({ profile });
    const a = (await call("GET", "/api/state", await admin())).json().menu;
    const m = (await call("GET", "/api/state", await member())).json().menu;
    expect(a).toEqual(m);
    const doc = JSON.parse(readFileSync(OPENAPI, "utf8"));
    for (const path of ["/api/generate", "/api/edit", "/api/upscale"]) {
      expect(doc.paths[path].post.requestBody.content["application/json"].schema.properties).not.toHaveProperty("menu");
    }
  });

  it("the OpenAPI document describes the menu strictly", async () => {
    const doc = JSON.parse(readFileSync(OPENAPI, "utf8"));
    const state = doc.components.schemas.State;
    expect(state.required).toContain("menu");
    const menu = state.properties.menu;
    expect(menu.additionalProperties).toBe(false);
    expect(menu.required).toEqual(["categories", "items"]);
    expect(menu.properties.categories.items.additionalProperties).toBe(false);
    expect(menu.properties.categories.items.required).toEqual(["id", "title"]);
    const item = menu.properties.items.items;
    expect(item.additionalProperties).toBe(false);
    expect([...item.required].sort()).toEqual(ITEM_KEYS);
    expect(Object.keys(item.properties).sort()).toEqual(ITEM_KEYS);
    expect(item.properties.tool.enum).toEqual(["generate", "edit", "upscale", "video"]);
    expect(item.properties.icon.enum).toEqual(["image", "wand", "user", "users", "swap", "shirt", "restore", "sparkles", "expand", "camera", "brush", "film"]);
    // What the server sends fits the document: the same keys, and every icon in the enum.
    h = await harness({ profile });
    const body = (await call("GET", "/api/state", await member())).json();
    for (const i of body.menu.items) expect(item.properties.icon.enum).toContain(i.icon);
    expect(Object.keys(body.menu).sort()).toEqual(["categories", "items"]);
  });
});

describe("advanced server choice (offers, filters, explicit offer)", () => {
  const rtx = (id: number, dph: number, geo: string, down: number, rel: number): Offer => ({
    id, dph_total: dph, gpu_name: "RTX A5000", gpu_ram: 24564, geolocation: geo, inet_down: down, reliability2: rel, machine_id: 7000 + id, host_id: 9, public_ipaddr: "203.0.113.9",
  });
  const offers = [
    rtx(1, 0.3, "Lithuania, LT", 600, 0.99),
    rtx(2, 0.4, "Quebec, CA", 900, 0.995),
    rtx(3, 0.25, "Texas, US", 700, 0.98),
    rtx(4, 0.45, "Tokyo, JP", 800, 0.999),
  ];
  beforeEach(async () => {
    h = await harness({ ready: false });
    h.vast.offers = offers;
  });

  it("GET /api/offers: 401 anonymous, 403 member, a bounded list in the public shape for an admin", async () => {
    expect((await call("GET", "/api/offers")).statusCode).toBe(401);
    expect((await call("GET", "/api/offers", await member())).statusCode).toBe(403);
    const res = await call("GET", "/api/offers", await admin());
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json().offers.map((o: { id: number }) => o.id)).toEqual([3, 1, 2]);
    expect(res.json().offers[0]).toEqual({ id: 3, gpu_name: "RTX A5000", dph: 0.25, vram_gb: 24, location: "Texas, US", region: "north_america", down_mbps: 700, reliability: 0.98 });
    for (const secret of ["machine", "host", "203.0.113.9", "7003"]) expect(res.body).not.toContain(secret);
  });

  it("GET /api/offers filters and sorts by the query", async () => {
    const a = await admin();
    const ids = async (q: string) => (await call("GET", `/api/offers?${q}`, a)).json().offers?.map((o: { id: number }) => o.id);
    expect(await ids("region=north_america")).toEqual([3, 2]);
    expect(await ids("max_dph=0.3")).toEqual([3, 1]);
    expect(await ids("min_down_mbps=800")).toEqual([2, 4]);
    expect(await ids("sort=speed")).toEqual([2, 4, 3]);
    expect(await ids("sort=reliability&region=asia")).toEqual([4]);
  });

  it.each([
    "region=mars", "max_dph=0", "max_dph=0.51", "max_dph=abc", "min_down_mbps=-1", "min_down_mbps=1.5", "sort=random", "offer_id=0", "host=1.2.3.4", "gpu=Tesla%20P40",
  ])("GET /api/offers?%s is refused with 400 and the list is not read", async (q) => {
    const before = h.vast.searches.length;
    const res = await call("GET", `/api/offers?${q}`, await admin());
    expect(res.statusCode).toBe(400);
    expect(h.vast.searches).toHaveLength(before);
  });

  it("estimate and gpus follow the filters", async () => {
    const a = await admin();
    expect((await call("GET", "/api/estimate?region=asia", a)).json()).toMatchObject({ dph: 0.45, location: "Tokyo, JP" });
    const gpus = (await call("GET", "/api/gpus?region=europe", a)).json().gpus;
    expect(gpus[0]).toMatchObject({ name: "RTX A5000", dph: 0.3, location: "Lithuania, LT" });
    expect((await call("GET", "/api/estimate?region=oceania", a)).statusCode).toBe(409);
  });

  it("start with filters rents the first of the filtered order; with offer_id exactly that offer", async () => {
    const a = await admin();
    expect((await post("/api/start", a, { confirm: true, region: "asia" })).statusCode).toBe(200);
    expect(h.vast.createdOffers).toEqual([4]);
    await post("/api/destroy", a);
    h.clock.ms += 3_600_001;
    h = await harness({ ready: false });
    h.vast.offers = offers;
    const res = await post("/api/start", await admin(), { confirm: true, offer_id: 2 });
    expect(res.statusCode).toBe(200);
    expect(h.vast.createdOffers).toEqual([2]);
    expect(res.body).not.toMatch(/offer_id|machine/);
  });

  it("start with an offer that vanished: 409 offer_gone, nothing rented and nothing billed", async () => {
    const a = await admin();
    h.vast.offers = offers.filter((o) => o.id !== 2);
    const res = await post("/api/start", a, { confirm: true, offer_id: 2 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("offer_gone");
    expect(h.vast.creates).toBe(0);
    expect((await h.registry.all()).every((r) => r.status === "gone")).toBe(true);
    expect((await post("/api/start", a, { confirm: true })).statusCode).toBe(200); // the next plain Start works
  });

  it.each<[string, Record<string, unknown>]>([
    ["an unknown region", { region: "mars" }],
    ["a price above VAST_MAX_DPH", { max_dph: 0.9 }],
    ["a text offer id", { offer_id: "2" }],
    ["an unknown member", { machine_id: 7002 }],
  ])("start with %s is 400 and creates nothing", async (_n, extra) => {
    const res = await post("/api/start", await admin(), { confirm: true, ...extra });
    expect(res.statusCode).toBe(400);
    expect(h.vast.creates).toBe(0);
  });

  it("an invalid request does not use up the Start rate limit", async () => {
    const a = await admin();
    for (let i = 0; i < 5; i++) expect((await post("/api/start", a, { confirm: true, region: "mars" })).statusCode).toBe(400);
    expect((await post("/api/start", a, { confirm: true })).statusCode).toBe(200);
  });

  it("a malformed VAST_MAX_DPH is a plain 502 config_invalid on the read routes and on Start, never a 500", async () => {
    h = await harness({ ready: false, cfg: { vastMaxDph: "abc" } });
    const a = await admin();
    for (const res of [await call("GET", "/api/offers", a), await call("GET", "/api/estimate", a), await post("/api/start", a, { confirm: true, region: "europe" })]) {
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe("config_invalid");
      expect(res.body).not.toContain("abc");
    }
    expect(h.vast.creates).toBe(0);
  });

  it("the shipped OpenAPI document describes the offers route and the new request members", () => {
    const doc = JSON.parse(readFileSync(OPENAPI, "utf8"));
    expect(doc.paths["/api/offers"].get).toBeDefined();
    const start = doc.paths["/api/start"].post.requestBody.content["application/json"].schema.properties;
    expect(Object.keys(start)).toEqual(expect.arrayContaining(["region", "max_dph", "min_down_mbps", "sort", "offer_id"]));
  });
});

describe("edit output size", () => {
  const sentPrompt = () => JSON.parse(h.comfySeen[h.comfySeen.length - 1]!.body).prompt;

  it("/api/state lists the sizes an edit may ask for, and nothing about the workflow node they feed", async () => {
    const body = (await call("GET", "/api/state", await member())).json();
    expect(body.edit.sizes).toEqual([
      { name: "1:1", width: 1024, height: 1024 },
      { name: "3:4", width: 896, height: 1152 },
      { name: "16:9", width: 1344, height: 768 },
      { name: "9:16", width: 768, height: 1344 },
    ]);
    expect(JSON.stringify(body.edit)).not.toContain("size_latent");
    expect(JSON.stringify(body.edit)).not.toContain("latent_image");
  });

  it("an edit with a size feeds the sampler an empty latent of that size, and the label names it", async () => {
    h.setComfy(comfyEdit());
    const res = await post("/api/edit", await member(), { ...okEdit, size: "9:16" });
    expect(res.statusCode).toBe(202);
    expect(sentPrompt()["edit_size_latent"].inputs).toEqual({ width: 768, height: 1344, batch_size: 1 });
    expect(sentPrompt()["7"].inputs.latent_image).toEqual(["edit_size_latent", 0]);
  });

  it("an edit without a size (or with null) is exactly the workflow as shipped", async () => {
    h.setComfy(comfyEdit());
    for (const extra of [{}, { size: null }]) {
      expect((await post("/api/edit", await member(), { ...okEdit, ...extra })).statusCode).toBe(202);
      expect(sentPrompt()["edit_size_latent"]).toBeUndefined();
      expect(sentPrompt()["7"].inputs.latent_image).toEqual(["6", 2]);
    }
  });

  it.each([["5:4"], [5], [""], [["1:1"]]])("400 unknown_size for %j, and nothing reaches ComfyUI", async (size) => {
    h.setComfy(comfyEdit());
    const res = await post("/api/edit", await member(), { ...okEdit, size });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("unknown_size");
    expect(h.comfySeen).toHaveLength(0);
  });

  it("the shipped OpenAPI document knows the size member and the sizes of the state", () => {
    const doc = JSON.parse(readFileSync(OPENAPI, "utf8"));
    const props = doc.paths["/api/edit"].post.requestBody.content["application/json"].schema.properties;
    expect(Object.keys(props)).toContain("size");
    const edit = doc.components.schemas.State.properties.edit;
    expect(JSON.stringify(edit)).toContain("sizes");
  });
});
