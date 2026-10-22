import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppsConfig } from "../src/config.js";
import type { AgentStatus, VideoModelsStatus } from "../src/agent.js";
import { AgentError } from "../src/agent.js";
import { Unreachable } from "../src/http.js";
import { AlreadyActiveError, Registry, type InstanceRecord, type NewRecord } from "../src/registry.js";
import {
  CreateRejected,
  DestroyError,
  VastError,
  type CreateRequest,
  type DestroyOutcome,
  type Offer,
  type OfferFilters,
  type VastInstance,
} from "../src/vast.js";
import { StartFilterError } from "../src/offer-choice.js";
import { loadProfile, type ModelSpec } from "../src/profile.js";
import { TailscaleError } from "../src/tailscale.js";
import { UsageHistory, UsageStore, usageFileCap } from "../src/usage.js";
import {
  DestroyFailedError,
  GpuNotAllowedError,
  Lifecycle,
  NoGpuConfiguredError,
  NoOffersError,
  OfferGoneError,
  overallDownload,
  ONSTART_CMD,
  RefusedError,
  StartError,
  type AgentLike,
} from "../src/lifecycle.js";

const schema = fileURLToPath(new URL("../../../contracts/instance-registry.schema.json", import.meta.url));
const T0 = 1_800_000_000;
const AUTH_KEY = "tskey-auth-SECRETKEY0123456789";
const TOKEN = "agenttoken-SECRET-0123456789abcdef";
const HOST = "vast-abc123";

const cfg = {
  repoUrl: "https://example.invalid/repo.git", // config-lint: ok (test fixture)
  repoCommit: "deadbeef",
  profile: "image",
  vastImage: "vastai/comfy:v0.41.0-cuda-12.9-py312",
  vastDiskGb: 50,
  vastMinVramGb: 24,
  vastMaxDph: "0.50",
  vastMinDownloadMbps: 500,
  vastMinReliability: "0.98",
  vastAllowedGpus: ["RTX A5000", "RTX_3090", "RTX 4090"],
  comfyPort: 18188,
  agentPort: 8189,
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
  startOfferListMax: 3,
  unreachableDestroyMin: 15,
  reconcileGraceMin: 10,
  webDestroyRetries: 3,
  webDestroyBackoffS: 5,
  secretNames: [],
} as unknown as AppsConfig;

class FakeVast {
  calls: string[];
  offers: Offer[] = [{ id: 11, dph_total: 0.3, gpu_name: "RTX A5000", gpu_ram: 24564 }];
  instances: VastInstance[] = [];
  createImpl: (offerId: number, req: CreateRequest) => Promise<{ id: number }>;
  destroyQueue: (DestroyOutcome | Error)[] = [];
  listError: Error | null = null;
  requests: CreateRequest[] = [];
  searches: OfferFilters[] = [];
  createdOffers: number[] = [];
  searchError: Error | null = null;
  nextId = 900;

  constructor(calls: string[], private readonly clock: () => number) {
    this.calls = calls;
    this.createImpl = async (_offer, req) => {
      const id = this.nextId++;
      this.instances.push({ id, label: req.label, actual_status: "loading", start_date: this.clock(), dph_total: 0.3 });
      return { id };
    };
  }

  // Like a careless Vast: returns every offer whatever the gpu_name filter says.
  async searchOffers(filters: OfferFilters): Promise<Offer[]> {
    this.calls.push("vast.search");
    this.searches.push(filters);
    if (this.searchError) throw this.searchError;
    return this.offers;
  }
  async createInstance(offerId: number, req: CreateRequest): Promise<{ id: number }> {
    this.calls.push("vast.create");
    this.requests.push(req);
    this.createdOffers.push(offerId);
    return this.createImpl(offerId, req);
  }
  async listInstances(): Promise<VastInstance[]> {
    this.calls.push("vast.list");
    if (this.listError) throw this.listError;
    return this.instances.map((i) => ({ ...i }));
  }
  async destroyInstance(id: number): Promise<DestroyOutcome> {
    this.calls.push(`vast.destroy:${id}`);
    const next = this.destroyQueue.shift() ?? "destroyed";
    if (next instanceof Error) throw next;
    this.instances = this.instances.filter((i) => i.id !== id);
    return next;
  }
}

function status(state: string, over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    schema_version: 1,
    state,
    reason: null,
    progress: null,
    now: T0,
    boot_at: T0,
    uptime_s: 100,
    idle_destroy_at: T0 + 1800,
    failsafe_at: T0 + 3 * 3600,
    hard_cap_at: T0 + 6 * 3600,
    queue: { running: 0, pending: 0 },
    gpu: {},
    profile: "image",
    commit: "deadbeef",
    failsafe_alive: true,
    destroy: { pending: false, attempts: 0, last_error: null },
    ...over,
  };
}

class FakeAgent implements AgentLike {
  statusImpl: () => Promise<AgentStatus> = async () => status("ready");
  destroyCalls: string[] = [];
  destroyError: Error | null = null;
  extendImpl: (kind: string, minutes: number) => Promise<Record<string, unknown>> = async (kind, minutes) => ({
    kind,
    minutes,
  });
  constructor(private readonly calls: string[]) {}
  status(): Promise<AgentStatus> {
    this.calls.push("agent.status");
    return this.statusImpl();
  }
  async extend(kind: "idle" | "failsafe", minutes: number): Promise<Record<string, unknown>> {
    this.calls.push("agent.extend");
    return this.extendImpl(kind, minutes);
  }
  videoImpl: () => Promise<VideoModelsStatus> = async () => ({ state: "downloading", boot: false, bytes_done: 0, bytes_total: 50 });
  async startVideoModels(): Promise<VideoModelsStatus> {
    this.calls.push("agent.video");
    return this.videoImpl();
  }
  async destroy(reason: "manual" | "watchdog"): Promise<void> {
    this.calls.push(`agent.destroy:${reason}`);
    this.destroyCalls.push(reason);
    if (this.destroyError) throw this.destroyError;
  }
}

class TracingRegistry extends Registry {
  constructor(
    file: string,
    private readonly calls: string[],
  ) {
    super(file, schema);
  }
  override begin(record: NewRecord): Promise<InstanceRecord> {
    this.calls.push("registry.begin");
    return super.begin(record);
  }
}

function setup(
  over: Partial<{
    authKey: () => Promise<string>;
    cfg: Record<string, unknown>;
    models: readonly ModelSpec[];
    videoFiles: readonly string[];
    usage: UsageHistory;
  }> = {},
) {
  const calls: string[] = [];
  const time = { now: T0 };
  const clock = (): number => time.now;
  const dir = mkdtempSync(join(tmpdir(), "life-"));
  const file = join(dir, "registry.json");
  const registry = new TracingRegistry(file, calls);
  const vast = new FakeVast(calls, clock);
  const agent = new FakeAgent(calls);
  const sleeps: number[] = [];
  const logs: string[] = [];
  let hostCounter = 0;
  const life = new Lifecycle({
    log: (level, text) => void logs.push(`${level} ${text}`),
    cfg: { ...cfg, ...(over.cfg ?? {}) } as unknown as AppsConfig,
    vast,
    registry,
    agentFor: () => agent,
    clock,
    ...(over.models ? { profileModels: over.models } : {}),
    ...(over.videoFiles ? { videoModelFiles: over.videoFiles } : {}),
    ...(over.usage ? { usage: over.usage } : {}),
    tsAuthKey: over.authKey ?? (async () => AUTH_KEY),
    newToken: () => TOKEN,
    newHostname: () => (hostCounter++ === 0 ? HOST : `${HOST}-${hostCounter}`),
    sleep: async (s) => {
      sleeps.push(s);
    },
  });
  return { calls, time, registry, vast, agent, life, file, sleeps, logs };
}

async function errorOf(p: Promise<unknown>): Promise<Error> {
  return (await p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  )) as Error;
}

describe("Lifecycle.start", () => {
  it("begin happens before the first vast call", async () => {
    const { life, calls } = setup();
    await life.start();
    expect(calls.indexOf("registry.begin")).toBe(0);
    expect(calls.slice(0, 3)).toEqual(["registry.begin", "vast.search", "vast.create"]);
  });

  it("creates the instance per spec 7.2 and returns a booting record with the cost estimate", async () => {
    const { life, vast, registry } = setup();
    const out = await life.start();
    const req = vast.requests[0]!;
    expect(req.image).toBe("vastai/comfy:v0.41.0-cuda-12.9-py312");
    expect(req.disk).toBe(50);
    expect(req.onstart).toBe(ONSTART_CMD);
    expect(ONSTART_CMD).toBe(
      '{ [ -d /opt/vast-comfy/.git ] || git clone "$REPO_URL" /opt/vast-comfy; } && git -C /opt/vast-comfy checkout "$REPO_COMMIT" && bash /opt/vast-comfy/instance/onstart.sh || vastai destroy instance "$CONTAINER_ID" --api-key "$CONTAINER_API_KEY"', // config-lint: ok
    );
    expect(req.label).toBe(`vastcomfy:${HOST}`);
    expect(req.env).toEqual({
      AGENT_TOKEN: TOKEN,
      TS_AUTHKEY: AUTH_KEY,
      TS_HOSTNAME: HOST,
      REPO_URL: "https://example.invalid/repo.git", // config-lint: ok
      REPO_COMMIT: "deadbeef",
      PROFILE: "image",
      IDLE_MINUTES: "30",
      FAILSAFE_HOURS: "3",
      HARD_CAP_HOURS: "6",
      PORTAL_CONFIG: "localhost:8188:18188:/:ComfyUI", // config-lint: ok
      COMFYUI_ARGS: "--disable-auto-launch --port 18188",
      WORKSPACE: "/workspace", // config-lint: ok
      DATA_DIRECTORY: "/workspace/", // config-lint: ok
      NET_PROBE_BYTES: "25165824",
      NET_PROBE_MIN_MBPS: "20",
      DOWNLOAD_CONNECTIONS: "4",
    });
    expect(out.record.status).toBe("booting");
    expect(out.record.vast_instance_id).toBe(900);
    // Vast's own start timestamp is unknown until reconcile reads it from the list.
    expect(out.record.vast_start_date).toBeNull();
    expect(out.estimate).toEqual({ offer_id: 11, gpu_name: "RTX A5000", dph: 0.3, horizon_hours: 3, max_cost: 0.3 * 3, location: null, down_mbps: null });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect((await registry.active())?.agent_token).toBe(TOKEN);
  });

  it("passes the ComfyUI preview method to the instance when it is configured", async () => {
    const { life, vast } = setup({ cfg: { comfyPreviewMethod: "taesd" } });
    await life.start();
    expect(vast.requests[0]!.env["COMFY_PREVIEW_METHOD"]).toBe("taesd");
    expect(vast.requests[0]!.env["COMFYUI_ARGS"]).toBe("--disable-auto-launch --port 18188");
  });

  it("two concurrent starts create one instance", async () => {
    const { life, vast, registry } = setup();
    const [a, b] = await Promise.allSettled([life.start(), life.start()]);
    expect(vast.requests).toHaveLength(1);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");
    const all = await registry.all();
    expect(all.filter((r) => r.status !== "gone")).toHaveLength(1);
    // A later start while active is refused by the registry, before any Vast call.
    const before = vast.calls.length;
    await expect(life.start()).rejects.toBeInstanceOf(AlreadyActiveError);
    expect(vast.calls.slice(before).filter((c) => c.startsWith("vast."))).toEqual([]);
  });

  it("no offers marks the record gone", async () => {
    const { life, vast, registry } = setup();
    vast.offers = [];
    await expect(life.start()).rejects.toBeInstanceOf(NoOffersError);
    expect(vast.requests).toHaveLength(0);
    const all = await registry.all();
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe("gone");
    expect(await registry.active()).toBeNull();
  });

  it("a definite create refusal marks the record gone", async () => {
    const { life, vast, registry } = setup();
    vast.createImpl = async () => {
      throw new CreateRejected("create instance was refused (HTTP 400): no longer available");
    };
    const err = await errorOf(life.start());
    expect(err).toBeInstanceOf(StartError);
    expect((err as StartError).ambiguous).toBe(false);
    expect(await registry.active()).toBeNull();
  });

  it("an ambiguous create leaves the record creating and blocks another start", async () => {
    const { life, vast, registry } = setup();
    vast.createImpl = async () => {
      throw new VastError("Vast PUT /api/v0/asks/11/ timed out after 10000 ms");
    };
    const err = await errorOf(life.start());
    expect(err).toBeInstanceOf(StartError);
    expect((err as StartError).ambiguous).toBe(true);
    const rec = await registry.active();
    expect(rec?.status).toBe("creating");
    expect(rec?.vast_instance_id).toBeNull();
    await expect(life.start()).rejects.toBeInstanceOf(AlreadyActiveError);
  });

  it("an auth key failure marks gone and never reaches create", async () => {
    const { life, vast, registry } = setup({
      authKey: async () => {
        throw new Error("auth key file missing");
      },
    });
    await expect(life.start()).rejects.toBeInstanceOf(StartError);
    expect(vast.calls.filter((c) => c.startsWith("vast."))).toEqual([]);
    expect(await registry.active()).toBeNull();
  });

  it("secrets are absent from start errors", async () => {
    const { life, vast } = setup();
    vast.createImpl = async (_o, req) => {
      throw new VastError(`server echoed ${JSON.stringify(req.env)} Bearer ${TOKEN}`);
    };
    const err = await errorOf(life.start());
    expect(err.message).not.toContain(AUTH_KEY);
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain("[redacted]");

    const second = setup();
    second.vast.createImpl = async () => {
      throw new CreateRejected(`refused for key ${AUTH_KEY}`);
    };
    const err2 = await errorOf(second.life.start());
    expect(err2.message).not.toContain(AUTH_KEY);
  });

  it("a registry failure after create destroys the created instance", async () => {
    const { life, vast, registry } = setup();
    const orig = registry.update.bind(registry);
    let fail = true;
    registry.update = async (h, p) => {
      if (fail) {
        fail = false;
        throw new Error("disk full");
      }
      return orig(h, p);
    };
    const err = await errorOf(life.start());
    expect(err).toBeInstanceOf(StartError);
    expect(vast.calls).toContain("vast.destroy:900");
    expect(vast.instances).toHaveLength(0);
    expect(await registry.active()).toBeNull();
  });
});

describe("Lifecycle.reconcile", () => {
  it("crash after vast create leaves a creating record that reconcile reports and handles", async () => {
    const { life, vast, registry, time, agent } = setup();
    // Simulate the process dying right after Vast created the instance: the create returns,
    // but the registry update never happens (crash), so the record stays creating.
    vast.createImpl = async (_o, req) => {
      vast.instances.push({ id: 901, label: req.label, actual_status: "running", start_date: T0, dph_total: 0.3 });
      throw new VastError("Vast PUT /api/v0/asks/11/ failed: socket hang up");
    };
    await life.start().catch(() => undefined);
    expect((await registry.active())?.status).toBe("creating");

    agent.statusImpl = async () => status("downloading");
    time.now = T0 + 60;
    const report = await life.reconcile();
    expect(report.linked).toEqual([{ tailnet_hostname: HOST, vast_instance_id: 901 }]);
    expect(report.unknown).toEqual([]);
    const rec = await registry.active();
    expect(rec?.status).toBe("booting");
    expect(rec?.vast_instance_id).toBe(901);

    // It never becomes ready: the boot timeout destroys it.
    time.now = T0 + 25 * 60;
    const later = await life.reconcile();
    expect(later.destroyed.map((d) => d.reason)).toEqual(["boot_timeout"]);
    expect(await registry.active()).toBeNull();
  });

  it("a crash after the booting write is enforced from the registry alone", async () => {
    const { life, registry, time, agent, vast } = setup();
    await life.start();
    // New process (fresh Lifecycle over the same registry file) after a homelab restart.
    const life2 = new Lifecycle({
      cfg,
      vast,
      registry,
      agentFor: () => agent,
      clock: () => time.now,
      tsAuthKey: async () => AUTH_KEY,
      newToken: () => TOKEN,
      newHostname: () => "vast-other",
      sleep: async () => undefined,
    });
    agent.statusImpl = async () => status("booting");
    time.now = T0 + 26 * 60;
    const report = await life2.reconcile();
    expect(report.destroyed).toEqual([
      { tailnet_hostname: HOST, vast_instance_id: 900, reason: "boot_timeout", outcome: "destroyed" },
    ]);
    expect(await registry.active()).toBeNull();
  });

  it("a creating record with no instance becomes gone only after the grace period", async () => {
    const { life, vast, registry, time } = setup();
    vast.createImpl = async () => {
      throw new VastError("timed out");
    };
    await life.start().catch(() => undefined);
    time.now = T0 + 5 * 60;
    expect((await life.reconcile()).gone).toEqual([]);
    expect((await registry.active())?.status).toBe("creating");
    time.now = T0 + 10 * 60;
    expect((await life.reconcile()).gone).toEqual([{ tailnet_hostname: HOST, reason: "never_created" }]);
    expect(await registry.active()).toBeNull();
  });

  it("unknown instance is reported and not adopted or destroyed", async () => {
    const { life, vast, registry } = setup();
    vast.instances.push(
      { id: 5, label: "vastcomfy", actual_status: "running", start_date: T0 - 9 * 3600, dph_total: 0.4 },
      { id: 6, label: "vastcomfy:vast-zzz", actual_status: "running", start_date: T0, dph_total: 0.4 },
      { id: 7, label: "someone-else", actual_status: "running", start_date: T0, dph_total: 0.4 },
    );
    const report = await life.reconcile();
    expect(report.unknown.map((u) => u.vast_instance_id)).toEqual([5, 6]);
    expect(report.destroyed).toEqual([]);
    expect(vast.calls.filter((c) => c.startsWith("vast.destroy"))).toEqual([]);
    expect(await registry.all()).toEqual([]);

    // Also while an instance of our own is active.
    await life.start();
    const again = await life.reconcile();
    expect(again.unknown.map((u) => u.vast_instance_id)).toEqual([5, 6]);
    expect(vast.calls.filter((c) => c.startsWith("vast.destroy"))).toEqual([]);
    expect((await registry.active())?.vast_instance_id).toBe(900);
  });

  it("an instance matching a gone record is unknown, not revived", async () => {
    const { life, vast, registry, time } = setup();
    vast.createImpl = async () => {
      throw new VastError("timed out");
    };
    await life.start().catch(() => undefined);
    time.now = T0 + 11 * 60;
    await life.reconcile(); // marks gone (never_created)
    vast.instances.push({ id: 950, label: `vastcomfy:${HOST}`, actual_status: "running", start_date: T0, dph_total: 0.3 });
    const report = await life.reconcile();
    expect(report.unknown.map((u) => u.vast_instance_id)).toEqual([950]);
    expect(report.linked).toEqual([]);
    expect(await registry.active()).toBeNull();
    expect(vast.calls.filter((c) => c.startsWith("vast.destroy"))).toEqual([]);
  });

  it("a record whose instance vanished becomes gone", async () => {
    const { life, vast, registry, time } = setup();
    await life.start();
    vast.instances = [];
    time.now = T0 + 60;
    expect((await life.reconcile()).gone).toEqual([]); // within grace: Vast may lag
    time.now = T0 + 11 * 60;
    expect((await life.reconcile()).gone).toEqual([]); // first miss: not yet confirmed
    expect((await registry.active())?.status).toBe("booting");
    time.now = T0 + 12 * 60;
    expect((await life.reconcile()).gone).toEqual([{ tailnet_hostname: HOST, reason: "vanished" }]);
    expect(await registry.active()).toBeNull();
  });

  it("one list without the instance does not mark gone; a reappearance resets the count", async () => {
    const { life, vast, registry, time } = setup();
    await life.start();
    const inst = vast.instances[0]!;
    time.now = T0 + 11 * 60;
    vast.instances = [];
    expect((await life.reconcile()).gone).toEqual([]);
    vast.instances = [inst]; // reappears
    time.now = T0 + 12 * 60;
    await life.reconcile();
    vast.instances = [];
    time.now = T0 + 13 * 60;
    expect((await life.reconcile()).gone).toEqual([]); // counter was reset: first miss again
    expect((await registry.active())?.status).not.toBe("gone");
    time.now = T0 + 14 * 60;
    expect((await life.reconcile()).gone.map((g) => g.reason)).toEqual(["vanished"]);
  });

  it("a failed Vast list never counts as a miss", async () => {
    const { life, vast, registry, time } = setup();
    await life.start();
    time.now = T0 + 11 * 60;
    vast.instances = [];
    expect((await life.reconcile()).gone).toEqual([]); // miss 1
    vast.listError = new VastError("list instances failed with HTTP 502");
    time.now = T0 + 12 * 60;
    expect((await life.reconcile()).vast_error).toMatch(/502/);
    time.now = T0 + 13 * 60;
    expect((await life.reconcile()).gone).toEqual([]);
    expect((await registry.active())?.status).toBe("booting");
    vast.listError = null;
    time.now = T0 + 14 * 60;
    expect((await life.reconcile()).gone.map((g) => g.reason)).toEqual(["vanished"]); // miss 2
  });

  it("the hard cap still applies when Vast reports no start_date", async () => {
    const { life, vast, registry, time } = setup();
    await life.start();
    vast.instances[0]!.start_date = 0;
    vast.instances[0]!.actual_status = "running";
    time.now = T0 + 60;
    expect((await life.reconcile()).destroyed).toEqual([]); // healthy and young: kept
    expect((await registry.active())?.status).toBe("ready");
    expect((await registry.active())?.vast_start_date).toBeNull();
    const v = await life.view();
    expect(v.remaining.hard_cap_s).toBe(6 * 3600 - 60);
    expect(v.uptime_s).toBe(60);
    time.now = T0 + 6 * 3600 - 1;
    expect((await life.reconcile()).destroyed).toEqual([]);
    time.now = T0 + 6 * 3600;
    expect((await life.reconcile()).destroyed.map((d) => d.reason)).toEqual(["hard_cap"]);
    expect(await registry.active()).toBeNull();
  });

  it("reconcile records Vast's own start_date", async () => {
    const { life, vast, registry, time } = setup();
    await life.start();
    vast.instances[0]!.start_date = T0 + 30;
    time.now = T0 + 60;
    await life.reconcile();
    expect((await registry.active())?.vast_start_date).toBe(T0 + 30);
  });

  it("the unreachable timer counts only while Vast says running", async () => {
    const { life, vast, registry, time, agent } = setup();
    await life.start();
    time.now = T0 + 30;
    await life.reconcile(); // ready, so the boot timeout is out of the picture
    agent.statusImpl = async () => {
      throw new Unreachable("down");
    };
    vast.instances[0]!.actual_status = "loading";
    time.now = T0 + 60;
    await life.reconcile();
    expect((await registry.active())?.unreachable_since ?? null).toBeNull();
    // A backdated timer from an earlier version is cleared while not running.
    await registry.update(HOST, { unreachable_since: T0 - 3600 });
    time.now = T0 + 120;
    await life.reconcile();
    expect((await registry.active())?.unreachable_since).toBeNull();
    // Image pull done after 14 minutes: the clock starts now, not at the first failure.
    vast.instances[0]!.actual_status = "running";
    time.now = T0 + 14 * 60;
    expect((await life.reconcile()).destroyed).toEqual([]);
    expect((await registry.active())?.unreachable_since).toBe(T0 + 14 * 60);
    time.now = T0 + 14 * 60 + 14 * 60;
    expect((await life.reconcile()).destroyed).toEqual([]);
    time.now = T0 + 14 * 60 + 15 * 60;
    expect((await life.reconcile()).destroyed.map((d) => d.reason)).toEqual(["unreachable"]);
  });

  it("boot timeout destroys", async () => {
    const { life, vast, registry, time, agent } = setup();
    await life.start();
    agent.statusImpl = async () => status("downloading");
    time.now = T0 + 24 * 60;
    expect((await life.reconcile()).destroyed).toEqual([]);
    time.now = T0 + 25 * 60;
    const report = await life.reconcile();
    expect(report.destroyed[0]?.reason).toBe("boot_timeout");
    expect(agent.destroyCalls).toEqual(["watchdog"]);
    expect(vast.calls).toContain("vast.destroy:900");
    expect(await registry.active()).toBeNull();
  });

  it("a ready instance is not destroyed by the boot timeout", async () => {
    const { life, registry, time } = setup();
    await life.start();
    time.now = T0 + 60;
    expect((await life.reconcile()).ready).toEqual([HOST]);
    time.now = T0 + 60 * 60;
    expect((await life.reconcile()).destroyed).toEqual([]);
    expect((await registry.active())?.status).toBe("ready");
  });

  it("unreachable beyond the limit destroys, within the limit does not", async () => {
    const { life, vast, registry, time, agent } = setup();
    await life.start();
    time.now = T0 + 60;
    await life.reconcile(); // ready
    vast.instances[0]!.actual_status = "running";
    agent.statusImpl = async () => {
      throw new Unreachable("GET /status timed out");
    };
    time.now = T0 + 120;
    let report = await life.reconcile();
    expect(report.unreachable_since).toBe(T0 + 120);
    expect((await registry.active())?.unreachable_since).toBe(T0 + 120);
    time.now = T0 + 120 + 14 * 60;
    report = await life.reconcile();
    expect(report.destroyed).toEqual([]);
    expect(report.unreachable_since).toBe(T0 + 120);
    time.now = T0 + 120 + 15 * 60;
    report = await life.reconcile();
    expect(report.destroyed.map((d) => d.reason)).toEqual(["unreachable"]);
    expect(await registry.active()).toBeNull();
  });

  it("a reachable agent clears the unreachable timer", async () => {
    const { life, vast, registry, time, agent } = setup();
    await life.start();
    vast.instances[0]!.actual_status = "running";
    time.now = T0 + 60;
    await life.reconcile();
    agent.statusImpl = async () => {
      throw new AgentError(500, "status failed with HTTP 500");
    };
    time.now = T0 + 120;
    await life.reconcile();
    expect((await registry.active())?.unreachable_since).toBe(T0 + 120);
    agent.statusImpl = async () => status("ready");
    time.now = T0 + 180;
    await life.reconcile();
    expect((await registry.active())?.unreachable_since).toBeNull();
    agent.statusImpl = async () => {
      throw new Unreachable("down");
    };
    time.now = T0 + 120 + 15 * 60;
    expect((await life.reconcile()).destroyed).toEqual([]); // timer restarted
  });

  it("unreachable does not destroy while Vast does not say running", async () => {
    const { life, vast, time, agent } = setup();
    await life.start();
    time.now = T0 + 60;
    await life.reconcile(); // ready
    vast.instances[0]!.actual_status = "loading";
    agent.statusImpl = async () => {
      throw new Unreachable("down");
    };
    time.now = T0 + 120;
    await life.reconcile();
    time.now = T0 + 120 + 20 * 60;
    expect((await life.reconcile()).destroyed).toEqual([]);
  });

  it("hard cap by start_date destroys", async () => {
    const { life, vast, registry, time } = setup();
    await life.start();
    time.now = T0 + 60;
    await life.reconcile(); // ready, agent fine
    // Vast's own start_date is the independent clock: older than the homelab record says.
    vast.instances[0]!.start_date = T0 - 5 * 3600;
    time.now = T0 + 59 * 60;
    expect((await life.reconcile()).destroyed).toEqual([]);
    time.now = T0 + 3600;
    const report = await life.reconcile();
    expect(report.destroyed.map((d) => d.reason)).toEqual(["hard_cap"]);
    expect(await registry.active()).toBeNull();
  });

  it("changes nothing when Vast cannot be listed", async () => {
    const { life, vast, registry, time } = setup();
    await life.start();
    vast.listError = new VastError("list instances failed with HTTP 502");
    time.now = T0 + 3 * 3600 * 24;
    const report = await life.reconcile();
    expect(report.vast_error).toMatch(/502/);
    expect(report.destroyed).toEqual([]);
    expect(report.gone).toEqual([]);
    expect((await registry.active())?.status).toBe("booting");
  });

  it("a destroy that failed is retried by reconcile", async () => {
    const { life, vast, registry, time } = setup();
    await life.start();
    vast.destroyQueue = [new DestroyError("HTTP 500"), new DestroyError("HTTP 500"), new DestroyError("HTTP 500")];
    await expect(life.destroy()).rejects.toBeInstanceOf(DestroyFailedError);
    expect((await registry.active())?.status).toBe("stopping");
    time.now = T0 + 60;
    const report = await life.reconcile();
    expect(report.destroyed.map((d) => d.reason)).toEqual(["destroy_retry"]);
    expect(await registry.active()).toBeNull();
  });
});

describe("Lifecycle.destroy", () => {
  it("destroy retries until vast confirms and only then marks gone", async () => {
    const { life, vast, registry, agent, calls, sleeps } = setup();
    await life.start();
    vast.destroyQueue = [new DestroyError("Failed with error 401"), new DestroyError("HTTP 503"), "destroyed"];
    const states: (string | undefined)[] = [];
    const origDestroy = vast.destroyInstance.bind(vast);
    vast.destroyInstance = async (id) => {
      states.push((await registry.active())?.status);
      return origDestroy(id);
    };
    const out = await life.destroy();
    expect(out.outcome).toBe("destroyed");
    expect(agent.destroyCalls).toEqual(["manual"]);
    const destroys = calls.filter((c) => c.startsWith("vast.destroy") || c.startsWith("agent.destroy"));
    expect(destroys).toEqual(["agent.destroy:manual", "vast.destroy:900", "vast.destroy:900", "vast.destroy:900"]);
    expect(states).toEqual(["stopping", "stopping", "stopping"]);
    expect(sleeps).toEqual([5, 5]);
    expect(await registry.active()).toBeNull();
  });

  it("destroy failure keeps the record non-gone and is reported", async () => {
    const { life, vast, registry } = setup();
    await life.start();
    vast.destroyQueue = [new DestroyError("a"), new DestroyError("b"), new DestroyError("c"), "destroyed"];
    const err = await errorOf(life.destroy());
    expect(err).toBeInstanceOf(DestroyFailedError);
    expect(err.message).toMatch(/after 3 attempts/);
    const rec = await registry.active();
    expect(rec?.status).toBe("stopping");
    const view = await life.view();
    expect(view.destroy_failed?.error).toMatch(/after 3 attempts/);
  });

  it("always calls Vast destroy even when the agent is unreachable", async () => {
    const { life, vast, registry, agent } = setup();
    await life.start();
    agent.destroyError = new Unreachable("POST /destroy failed");
    const out = await life.destroy();
    expect(out.outcome).toBe("destroyed");
    expect(out.agent_error).toMatch(/failed/);
    expect(vast.calls).toContain("vast.destroy:900");
    expect(await registry.active()).toBeNull();
  });

  it("an already gone instance counts as destroyed, and destroy is idempotent", async () => {
    const { life, vast, registry } = setup();
    await life.start();
    vast.destroyQueue = ["gone"];
    expect((await life.destroy()).outcome).toBe("gone");
    expect(await registry.active()).toBeNull();
    expect((await life.destroy()).outcome).toBe("none");
  });

  it("destroy of a creating record links it by label first, or waits when Vast does not list it", async () => {
    const { life, vast, registry } = setup();
    vast.createImpl = async (_o, req) => {
      vast.instances.push({ id: 902, label: req.label, actual_status: "loading", start_date: T0, dph_total: 0.3 });
      throw new VastError("timed out");
    };
    await life.start().catch(() => undefined);
    expect((await life.destroy()).outcome).toBe("destroyed");
    expect(vast.calls).toContain("vast.destroy:902");
    expect(await registry.active()).toBeNull();

    const second = setup();
    second.vast.createImpl = async () => {
      throw new VastError("timed out");
    };
    await second.life.start().catch(() => undefined);
    expect((await second.life.destroy()).outcome).toBe("pending");
    expect((await second.registry.active())?.status).toBe("creating");
  });

  it("a pending destroy is remembered and carried out when reconcile links the instance", async () => {
    const { life, vast, registry, time, agent } = setup();
    vast.createImpl = async () => {
      throw new VastError("timed out");
    };
    await life.start().catch(() => undefined);
    expect((await life.destroy()).outcome).toBe("pending");
    // The instance shows up on Vast later.
    vast.instances.push({ id: 903, label: `vastcomfy:${HOST}`, actual_status: "loading", start_date: T0, dph_total: 0.3 });
    time.now = T0 + 60;
    const report = await life.reconcile();
    expect(report.linked).toEqual([{ tailnet_hostname: HOST, vast_instance_id: 903 }]);
    expect(report.destroyed).toEqual([
      { tailnet_hostname: HOST, vast_instance_id: 903, reason: "destroy_requested", outcome: "destroyed" },
    ]);
    expect(report.unknown).toEqual([]);
    expect(agent.destroyCalls).toEqual(["manual"]);
    expect(vast.calls).toContain("vast.destroy:903");
    expect(await registry.active()).toBeNull();
  });

  it("without a pending destroy a linked instance is left booting", async () => {
    const { life, vast, registry, time, agent } = setup();
    vast.createImpl = async () => {
      throw new VastError("timed out");
    };
    await life.start().catch(() => undefined);
    agent.statusImpl = async () => status("downloading");
    vast.instances.push({ id: 904, label: `vastcomfy:${HOST}`, actual_status: "loading", start_date: T0, dph_total: 0.3 });
    time.now = T0 + 60;
    const report = await life.reconcile();
    expect(report.destroyed).toEqual([]);
    expect((await registry.active())?.status).toBe("booting");
  });

  it("destroyUnknown refuses foreign labels and the active record", async () => {
    const { life, vast } = setup();
    await life.start();
    vast.instances.push(
      { id: 5, label: "vastcomfy", actual_status: "running", start_date: T0, dph_total: 0.4 },
      { id: 7, label: "someone-else", actual_status: "running", start_date: T0, dph_total: 0.4 },
    );
    await expect(life.destroyUnknown(7)).rejects.toThrow(/project label/);
    await expect(life.destroyUnknown(7)).rejects.toBeInstanceOf(RefusedError);
    await expect(life.destroyUnknown(900)).rejects.toThrow(/active record/);
    await expect(life.destroyUnknown(900)).rejects.toBeInstanceOf(RefusedError);
    expect(await life.destroyUnknown(5)).toBe("destroyed");
    expect(vast.calls.filter((c) => c.startsWith("vast.destroy"))).toEqual(["vast.destroy:5"]);
  });
});

describe("Lifecycle.extend and view", () => {
  it("extend forwards to the agent and surfaces its refusal", async () => {
    const { life, agent } = setup();
    await expect(life.extend("idle", 30)).rejects.toThrow(/no active instance/);
    await life.start();
    expect(await life.extend("idle", 30)).toEqual({ kind: "idle", minutes: 30 });
    agent.extendImpl = async () => {
      throw new AgentError(409, "extend failed with HTTP 409: beyond hard_cap");
    };
    await expect(life.extend("failsafe", 600)).rejects.toThrow(/beyond hard_cap/);
  });

  it("view merges registry, Vast and agent with the running cost", async () => {
    const { life, vast, time, agent } = setup();
    await life.start();
    vast.instances[0]!.actual_status = "running";
    agent.statusImpl = async () => status("downloading", { progress: { phase: "models", file: "m", bytes_done: 1, bytes_total: 2 } });
    time.now = T0 + 1800;
    const v = await life.view();
    expect(v.state).toBe("downloading");
    expect(v.vast?.actual_status).toBe("running");
    expect(v.uptime_s).toBe(1800);
    expect(v.cost_so_far).toBeCloseTo(0.15);
    expect(v.progress?.bytes_total).toBe(2);
    expect(v.remaining).toEqual({ idle_s: 0, failsafe_s: 3 * 3600 - 1800, hard_cap_s: 6 * 3600 - 1800 });
    expect(JSON.stringify(v)).not.toContain(TOKEN);
  });

  it("view degrades to agent null when unreachable", async () => {
    const { life, vast, agent } = setup();
    await life.start();
    vast.instances[0]!.actual_status = "running";
    agent.statusImpl = async () => {
      throw new Unreachable(`GET /status failed Bearer ${TOKEN}`);
    };
    const v = await life.view();
    expect(v.agent).toBeNull();
    expect(v.agent_unreachable).toBe(true);
    expect(v.state).toBe("booting");
    expect(v.agent_error).not.toContain(TOKEN);
    expect(v.cost_so_far).toBe(0);
  });

  it("view survives Vast being down and reports failed and unknown", async () => {
    const { life, vast, agent } = setup();
    await life.start();
    vast.instances.push({ id: 5, label: "vastcomfy", actual_status: "running", start_date: T0, dph_total: 0.4 });
    agent.statusImpl = async () => status("failed", { reason: "download_failed" });
    let v = await life.view();
    expect(v.failed).toEqual({ reason: "download_failed" });
    expect(v.unknown.map((u) => u.vast_instance_id)).toEqual([5]);
    vast.listError = new VastError("HTTP 502");
    v = await life.view();
    expect(v.vast).toBeNull();
    expect(v.vast_error).toMatch(/502/);
    expect(v.state).toBe("failed");
  });

  it("view reports stopping while the destroy is in progress even if the agent still answers", async () => {
    const { life, vast, agent } = setup();
    await life.start();
    vast.destroyQueue = [new DestroyError("a"), new DestroyError("b"), new DestroyError("c")];
    await life.destroy().catch(() => undefined);
    agent.statusImpl = async () => status("ready");
    const v = await life.view();
    expect(v.state).toBe("stopping");
    expect(v.agent?.state).toBe("ready");
  });

  it("view with no instance", async () => {
    const { life } = setup();
    const v = await life.view();
    expect(v.state).toBe("none");
    expect(v.record).toBeNull();
    expect(v.agent).toBeNull();
  });

  it("secrets never reach the registry file in clear except the agent token field", async () => {
    const { life, file } = setup();
    await life.start();
    expect(readFileSync(file, "utf8")).not.toContain(AUTH_KEY);
  });
});

describe("Lifecycle.view scrubbing", () => {
  it("never returns secrets echoed in the agent's free-text status fields", async () => {
    const VAST_KEY = "fixturevastkeybbbbbbbbbbbbbbbbbbb";
    const calls: string[] = [];
    const clock = (): number => T0;
    const dir = mkdtempSync(join(tmpdir(), "life-scrub-"));
    const registry = new Registry(join(dir, "registry.json"), schema);
    const vast = new FakeVast(calls, clock);
    const agent = new FakeAgent(calls);
    const life = new Lifecycle({
      cfg: { ...cfg, vastApiKey: VAST_KEY, secretNames: ["VAST_API_KEY"] } as unknown as AppsConfig,
      vast, registry, agentFor: () => agent, clock,
      tsAuthKey: async () => AUTH_KEY, newToken: () => TOKEN, newHostname: () => HOST, sleep: async () => undefined,
    });
    await life.start();
    const echo = `token ${TOKEN} key ${AUTH_KEY} vast ${VAST_KEY} Bearer ${TOKEN}x`;
    for (const state of ["failed", "destroy_failed", "downloading"]) {
      agent.statusImpl = async () =>
        status(state, {
          reason: echo,
          progress: { phase: echo, file: echo, bytes_done: 1, bytes_total: 2 },
          profile: echo,
          commit: echo,
          destroy: { pending: true, attempts: 1, last_error: echo },
        });
      const out = JSON.stringify(await life.view());
      for (const secret of [TOKEN, AUTH_KEY, VAST_KEY]) expect(out, state).not.toContain(secret);
      expect(out).toContain("[redacted]");
    }
  });
});

describe("Lifecycle GPU choice", () => {
  const A5000: Offer = { id: 11, dph_total: 0.3, gpu_name: "RTX A5000", gpu_ram: 24564 };
  const A5000_CHEAP: Offer = { id: 12, dph_total: 0.25, gpu_name: "RTX A5000", gpu_ram: 24564 };
  const P40: Offer = { id: 5, dph_total: 0.1, gpu_name: "Tesla P40", gpu_ram: 24576 };
  const R4090: Offer = { id: 40, dph_total: 0.45, gpu_name: "RTX 4090", gpu_ram: 24564 };
  const ALLOWED = ["RTX A5000", "RTX 3090", "RTX 4090"];

  it("gpuOptions: one search over every allowed model, grouped by model in config order", async () => {
    const { life, vast } = setup();
    vast.offers = [P40, R4090, A5000, A5000_CHEAP];
    const options = await life.gpuOptions();
    expect(options).toEqual([
      { name: "RTX A5000", dph: 0.25, vram_gb: 24, available: true, location: null, down_mbps: null },
      { name: "RTX 3090", dph: null, vram_gb: null, available: false, location: null, down_mbps: null },
      { name: "RTX 4090", dph: 0.45, vram_gb: 24, available: true, location: null, down_mbps: null },
    ]);
    expect(vast.searches).toHaveLength(1);
    expect(vast.searches[0]!.allowedGpus).toEqual(ALLOWED);
    // The other filters still come from config.
    expect(vast.searches[0]).toMatchObject({ maxDph: 0.5, minReliability: 0.98, minDownloadMbps: 500, diskGb: 50, minVramGb: 24 });
    // A model Vast returned outside the allow-list never shows up.
    expect(JSON.stringify(options)).not.toContain("P40");
    expect(JSON.stringify(options)).not.toContain("offer");
  });

  it("start(gpu) searches only that model and creates on its offer", async () => {
    const { life, vast } = setup();
    vast.offers = [P40, A5000, R4090];
    const out = await life.start("RTX 4090");
    expect(vast.searches.map((f) => f.allowedGpus)).toEqual([["RTX 4090"]]);
    expect(vast.createdOffers).toEqual([40]);
    expect(out.estimate.gpu_name).toBe("RTX 4090");
  });

  it("start with a model outside the allow-list is refused before any record or Vast call", async () => {
    const { life, vast, registry, calls } = setup();
    for (const bad of ["Tesla P40", "rtx 4090", "RTX 4090 ", "", "RTX A5000,Tesla P40"]) {
      await expect(life.start(bad), bad).rejects.toBeInstanceOf(GpuNotAllowedError);
      await expect(life.estimate(bad), bad).rejects.toBeInstanceOf(GpuNotAllowedError);
    }
    expect(calls).toEqual([]);
    expect(vast.requests).toHaveLength(0);
    expect(await registry.all()).toEqual([]);
  });

  it("start without a model never picks one outside the allow-list", async () => {
    const { life, vast } = setup();
    vast.offers = [P40, A5000_CHEAP, A5000];
    const out = await life.start();
    expect(vast.searches[0]!.allowedGpus).toEqual(ALLOWED);
    expect(vast.createdOffers).toEqual([12]);
    expect(out.estimate.gpu_name).toBe("RTX A5000");

    const only = setup();
    only.vast.offers = [P40, { id: 6, dph_total: 0.05 }];
    await expect(only.life.start()).rejects.toBeInstanceOf(NoOffersError);
    expect(only.vast.requests).toHaveLength(0);
    await expect(only.life.estimate()).rejects.toBeInstanceOf(NoOffersError);
  });

  it("an empty allow-list fails closed for start, estimate and gpuOptions without calling Vast", async () => {
    const { life, vast, registry, calls } = setup({ cfg: { vastAllowedGpus: [] } });
    vast.offers = [P40, A5000];
    await expect(life.start()).rejects.toBeInstanceOf(NoGpuConfiguredError);
    await expect(life.start("RTX A5000")).rejects.toBeInstanceOf(NoGpuConfiguredError);
    await expect(life.estimate()).rejects.toBeInstanceOf(NoGpuConfiguredError);
    await expect(life.gpuOptions()).rejects.toBeInstanceOf(NoGpuConfiguredError);
    expect(calls).toEqual([]);
    expect(await registry.all()).toEqual([]);
  });

  it("names are normalised exactly like the offer query (underscore to space, case kept)", async () => {
    const { life, vast } = setup();
    vast.offers = [{ id: 30, dph_total: 0.2, gpu_name: "RTX 3090", gpu_ram: 24576 }];
    // Config says RTX_3090; the query and the option list say RTX 3090.
    expect((await life.gpuOptions())[1]).toEqual({ name: "RTX 3090", dph: 0.2, vram_gb: 24, available: true, location: null, down_mbps: null });
    expect((await life.estimate("RTX_3090")).gpu_name).toBe("RTX 3090");
    expect((await life.estimate("RTX 3090")).offer_id).toBe(30);
    expect(vast.searches.slice(1).map((f) => f.allowedGpus)).toEqual([["RTX 3090"], ["RTX 3090"]]);
    await expect(life.estimate("rtx 3090")).rejects.toBeInstanceOf(GpuNotAllowedError);
    await expect(life.estimate("RTX-3090")).rejects.toBeInstanceOf(GpuNotAllowedError);
  });

  it("estimate(gpu) is restricted to that model", async () => {
    const { life, vast } = setup();
    vast.offers = [A5000, R4090];
    expect(await life.estimate("RTX 4090")).toMatchObject({ offer_id: 40, gpu_name: "RTX 4090", dph: 0.45 });
    expect(await life.estimate("RTX 3090").catch((e: unknown) => e)).toBeInstanceOf(NoOffersError);
  });

  it("view exposes gpu_name from the Vast row, else from the offer chosen at start", async () => {
    const { life, vast } = setup();
    expect((await life.view()).gpu_name).toBeNull();
    vast.offers = [R4090];
    await life.start("RTX 4090");
    expect((await life.view()).gpu_name).toBe("RTX 4090");
    vast.instances[0]!["gpu_name"] = "RTX 4090 (row)";
    expect((await life.view()).gpu_name).toBe("RTX 4090 (row)");
  });
});

describe("Lifecycle re-checks every offer locally (Vast may ignore its filters)", () => {
  // cfg: VAST_MAX_DPH 0.50, VAST_MIN_VRAM_GB 24 (24000 MB, the query's unit).
  const ok: Offer = { id: 20, dph_total: 0.4, gpu_name: "RTX 4090", gpu_ram: 24564 };

  it("an allowed model above VAST_MAX_DPH is never created", async () => {
    const { life, vast, registry } = setup();
    vast.offers = [{ id: 21, dph_total: 0.51, gpu_name: "RTX 4090", gpu_ram: 24564 }];
    await expect(life.start("RTX 4090")).rejects.toBeInstanceOf(NoOffersError);
    await expect(life.estimate()).rejects.toBeInstanceOf(NoOffersError);
    expect(vast.requests).toHaveLength(0);
    expect(await registry.active()).toBeNull();
    expect((await life.gpuOptions())[2]).toEqual({ name: "RTX 4090", dph: null, vram_gb: null, available: false, location: null, down_mbps: null });
  });

  it("drops offers below VAST_MIN_VRAM_GB or without a usable price or VRAM", async () => {
    const bad: Offer[] = [
      { id: 22, dph_total: 0.1, gpu_name: "RTX 4090", gpu_ram: 23999 },
      { id: 23, dph_total: 0.1, gpu_name: "RTX 4090" },
      { id: 24, dph_total: 0.1, gpu_name: "RTX 4090", gpu_ram: Number.NaN },
      { id: 25, dph_total: Number.NaN, gpu_name: "RTX 4090", gpu_ram: 24564 },
      { id: 26, dph_total: 0, gpu_name: "RTX 4090", gpu_ram: 24564 },
      { id: 27, dph_total: -1, gpu_name: "RTX 4090", gpu_ram: 24564 },
      { id: 28, gpu_name: "RTX 4090", gpu_ram: 24564 } as unknown as Offer,
      { id: 29, dph_total: "0.1", gpu_name: "RTX 4090", gpu_ram: 24564 } as unknown as Offer,
    ];
    for (const offer of bad) {
      const { life, vast } = setup();
      vast.offers = [offer];
      await expect(life.start("RTX 4090"), String(offer.id)).rejects.toBeInstanceOf(NoOffersError);
      expect(vast.requests).toHaveLength(0);
      expect((await life.gpuOptions())[2]!.available, String(offer.id)).toBe(false);
    }
  });

  it("the cheapest valid offer wins over a cheaper invalid or a pricier one", async () => {
    const { life, vast } = setup();
    vast.offers = [
      { id: 30, dph_total: 0.9, gpu_name: "RTX 4090", gpu_ram: 24564 },
      { id: 31, dph_total: 0.05, gpu_name: "RTX 4090", gpu_ram: 12000 },
      ok,
    ];
    expect((await life.gpuOptions())[2]).toEqual({ name: "RTX 4090", dph: 0.4, vram_gb: 24, available: true, location: null, down_mbps: null });
    await life.start("RTX 4090");
    expect(vast.createdOffers).toEqual([20]);
  });

  it("a longer model name that merely starts with an allowed one is never created", async () => {
    const { life, vast } = setup();
    vast.offers = [{ id: 32, dph_total: 0.2, gpu_name: "RTX 3090 Ti", gpu_ram: 24564 }];
    await expect(life.start("RTX 3090")).rejects.toBeInstanceOf(NoOffersError);
    await expect(life.start()).rejects.toBeInstanceOf(NoOffersError);
    expect(vast.requests).toHaveLength(0);
  });
});

describe("Lifecycle start failure reasons", () => {
  it("an empty or unreadable Tailscale key file is ts_key_missing, before any Vast call", async () => {
    for (const authKey of [async () => "", async () => Promise.reject(new Error(`ENOENT ${AUTH_KEY}`))]) {
      const { life, vast, registry } = setup({ authKey });
      const err = await errorOf(life.start());
      expect(err).toBeInstanceOf(StartError);
      expect((err as StartError).reason).toBe("ts_key_missing");
      expect((err as StartError).ambiguous).toBe(false);
      expect(err.message).not.toContain(AUTH_KEY);
      expect(vast.calls.filter((c) => c.startsWith("vast."))).toEqual([]);
      expect(await registry.active()).toBeNull();
    }
  });

  it("a failed OAuth mint is ts_key_mint_failed, before any Vast call, with a fixed message", async () => {
    for (const code of ["oauth_failed", "key_rejected", "tailscale_unavailable", "invalid_response"] as const) {
      const { life, vast, registry } = setup({ authKey: async () => Promise.reject(new TailscaleError(code)) });
      const err = await errorOf(life.start());
      expect(err).toBeInstanceOf(StartError);
      expect((err as StartError).reason).toBe("ts_key_mint_failed");
      expect((err as StartError).ambiguous).toBe(false);
      expect(err.message).toBe(`start failed before create: the Tailscale auth key could not be minted (${code})`);
      expect(vast.calls.filter((c) => c.startsWith("vast."))).toEqual([]);
      expect(await registry.active()).toBeNull();
    }
    // Any other error from the source stays ts_key_missing (the key file path).
    const other = setup({ authKey: async () => Promise.reject(new Error(`boom ${AUTH_KEY}`)) });
    expect(((await errorOf(other.life.start())) as StartError).reason).toBe("ts_key_missing");
  });

  it("redacts each freshly minted key from start errors", async () => {
    let n = 0;
    const minted: string[] = [];
    const { life, vast } = setup({
      authKey: async () => {
        const key = `tskey-auth-fakeMINT${n++}-0123456789`;
        minted.push(key);
        return key;
      },
    });
    vast.createImpl = async (_offer, req) => {
      throw new CreateRejected(`bad env ${req.env["TS_AUTHKEY"]}`);
    };
    for (let i = 0; i < 2; i++) {
      const err = (await errorOf(life.start())) as StartError;
      expect(err.reason).toBe("vast_rejected");
      expect(err.message).toContain("[redacted]");
      for (const key of minted) expect(err.message).not.toContain(key);
    }
    expect(new Set(minted).size).toBe(2);
  });

  it("names the other cases it can tell apart", async () => {
    const search = setup();
    search.vast.searchError = new VastError("search offers failed with HTTP 500");
    const e1 = (await errorOf(search.life.start())) as StartError;
    expect([e1.name, e1.reason, e1.ambiguous]).toEqual(["StartError", "vast_unavailable", false]);
    expect(await search.registry.active()).toBeNull();

    const rejected = setup();
    rejected.vast.createImpl = async () => {
      throw new CreateRejected("create instance was refused (HTTP 400): no");
    };
    expect(((await errorOf(rejected.life.start())) as StartError).reason).toBe("vast_rejected");

    const uncertain = setup();
    uncertain.vast.createImpl = async () => {
      throw new VastError("timed out");
    };
    const e3 = (await errorOf(uncertain.life.start())) as StartError;
    expect([e3.reason, e3.ambiguous]).toEqual(["create_uncertain", true]);

    const reg = setup();
    reg.registry.update = async () => {
      throw new Error("disk full");
    };
    expect(((await errorOf(reg.life.start())) as StartError).reason).toBe("registry_failed");

    // A bad offer-filter setting is a configuration problem, not Vast being down.
    for (const bad of [{ vastMaxDph: "abc" }, { vastMinReliability: "1.5" }]) {
      const conf = setup({ cfg: bad });
      const e5 = (await errorOf(conf.life.start())) as StartError;
      expect([e5.reason, e5.ambiguous]).toEqual(["config_invalid", false]);
      expect(conf.vast.calls.filter((c) => c.startsWith("vast."))).toEqual([]);
      expect(await conf.registry.active()).toBeNull();
    }
  });
});

describe("overall download progress", () => {
  const shipped = fileURLToPath(new URL("../../../instance/profiles/image.yaml", import.meta.url));
  const models = loadProfile(shipped).models;
  const [s1, s2, s3] = models.map((m) => m.size_bytes) as [number, number, number];
  const total = models.reduce((n, m) => n + m.size_bytes, 0);
  const files = models.length;
  const prog = (file: string, bytes_done: number, phase = "models") => ({ phase, file, bytes_done, bytes_total: 1 });

  it("the TS profile loader reads models from the shipped profile", () => {
    expect(models).toEqual([
      { file: "qwen-image-2.1-UC-Q4_K_M.gguf", size_bytes: 4604558112 },
      { file: "text_encoders/qwen3vl_8b_int8_convrot.safetensors", size_bytes: 9350798360 },
      { file: "vae/qwen_image_2.1_vae_bf16.safetensors", size_bytes: 675509688 },
      { file: "Qwen2.1_Anything2RealCharacters.safetensors", size_bytes: 318820200 },
      { file: "RealESRGAN_x4plus.safetensors", size_bytes: 66857836 },
      { file: "split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors", size_bytes: 9999658848 },
      { file: "split_files/vae/wan2.2_vae.safetensors", size_bytes: 1409400960 },
      { file: "split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors", size_bytes: 6735906897 },
    ]);
  });

  it("an image-only boot of the shipped profile counts only the image files (about 15 GB), one with video all (about 33 GB)", async () => {
    const shippedProfile = loadProfile(shipped);
    const { life, vast, agent } = setup({ models: shippedProfile.models, videoFiles: shippedProfile.videoFiles });
    await life.start();
    vast.instances[0]!.actual_status = "running";
    const prog = { phase: "models", file: "qwen-image-2.1-UC-Q4_K_M.gguf", bytes_done: 5, bytes_total: 1 };
    agent.statusImpl = async () => status("downloading", { progress: prog });
    expect((await life.view()).download).toMatchObject({ files_total: 5, bytes_total: 15_016_544_196 });
    agent.statusImpl = async () => status("downloading", { progress: prog, video_models: { state: "not_installed", boot: true, bytes_done: 0, bytes_total: 1 } });
    expect((await life.view()).download).toMatchObject({ files_total: 8, bytes_total: 15_016_544_196 + 18_144_966_705 });
  });

  it("sums earlier files, the current file's bytes (clamped) and nothing after it", () => {
    const at = (file: string, done: number) => overallDownload("downloading", prog(file, done), models);
    expect(at("qwen-image-2.1-UC-Q4_K_M.gguf", 1_000_000_000)).toEqual({
      files_total: files, files_done: 0, bytes_done: 1_000_000_000, bytes_total: total, current_file: "qwen-image-2.1-UC-Q4_K_M.gguf",
    });
    // Between files: the second file just started (basename as the agent reports it).
    expect(at("qwen3vl_8b_int8_convrot.safetensors", 0)).toMatchObject({ files_done: 1, bytes_done: s1 });
    // The profile's own subpath form matches too.
    expect(at("text_encoders/qwen3vl_8b_int8_convrot.safetensors", 5)).toMatchObject({ files_done: 1, bytes_done: s1 + 5 });
    // An agent counter past the file size is clamped to it.
    expect(at("qwen_image_2.1_vae_bf16.safetensors", s3 + 999)).toEqual({
      files_total: files, files_done: 2, bytes_done: s1 + s2 + s3, bytes_total: total, current_file: "qwen_image_2.1_vae_bf16.safetensors",
    });
    // The last file, done: everything is counted.
    const last = models[files - 1]!;
    expect(at(last.file, last.size_bytes)).toMatchObject({ files_done: files - 1, bytes_done: total });
    expect(at("qwen_image_2.1_vae_bf16.safetensors", -5)).toMatchObject({ bytes_done: s1 + s2 });
  });

  it("degrades to null instead of guessing", () => {
    expect(overallDownload("downloading", prog("other.bin", 5), models)).toBeNull();
    expect(overallDownload("downloading", prog("", 5), models)).toBeNull();
    expect(overallDownload("downloading", prog("ComfyUI-GGUF", 5, "nodes"), models)).toBeNull();
    expect(overallDownload("downloading", null, models)).toBeNull();
    expect(overallDownload("ready", prog("qwen-image-2.1-UC-Q4_K_M.gguf", 5), models)).toBeNull();
    expect(overallDownload("downloading", prog("qwen-image-2.1-UC-Q4_K_M.gguf", 5), [])).toBeNull();
    expect(overallDownload("downloading", prog("qwen-image-2.1-UC-Q4_K_M.gguf", Number.NaN), models)).toBeNull();
    const twice = [...models, { file: "x/qwen-image-2.1-UC-Q4_K_M.gguf", size_bytes: 1 }];
    expect(overallDownload("downloading", prog("qwen-image-2.1-UC-Q4_K_M.gguf", 5), twice)).toBeNull();
  });

  it("view().download follows the agent's progress", async () => {
    const { life, vast, agent } = setup({ models });
    await life.start();
    vast.instances[0]!.actual_status = "running";
    agent.statusImpl = async () => status("downloading", { progress: prog("qwen3vl_8b_int8_convrot.safetensors", 7) });
    expect((await life.view()).download).toMatchObject({ files_done: 1, bytes_done: s1 + 7, bytes_total: total });
    agent.statusImpl = async () => status("downloading", { progress: prog("leejet/ComfyUI-GGUF", 7, "nodes") });
    expect((await life.view()).download).toBeNull();
    agent.statusImpl = async () => status("ready");
    expect((await life.view()).download).toBeNull();
  });
});

describe("Lifecycle stuck start (VAST_START_STUCK_MIN)", () => {
  const BAD = 45608;
  const GOOD = 777;
  const MIN = 60;
  // The row seen live on 2026-10-19: the image was pulled but the container never started.
  const stuckRow = {
    actual_status: "created",
    cur_state: "stopped",
    next_state: "stopped",
    intended_status: "stopped",
    last_started: null,
    status_msg: "Successfully loaded vastai/comfy:v0.41.0-cuda-12.9-py312",
    machine_id: BAD,
    geolocation: "Quebec, CA",
    inet_down: 860,
  };
  const runningRow = { actual_status: "running", cur_state: "running", intended_status: "running", last_started: T0 + 60 };

  function stuckSetup(over: Parameters<typeof setup>[0] = {}) {
    const s = setup(over);
    s.vast.offers = [
      { id: 11, dph_total: 0.2, gpu_name: "RTX 3090", gpu_ram: 24576, machine_id: BAD },
      { id: 12, dph_total: 0.3, gpu_name: "RTX 3090", gpu_ram: 24576, machine_id: GOOD },
    ];
    s.agent.statusImpl = async () => {
      throw new Unreachable("agent not reachable");
    };
    const at = async (t: number, row?: Record<string, unknown>, index = 0) => {
      if (row !== undefined) Object.assign(s.vast.instances[index]!, row);
      s.time.now = t;
      return s.life.reconcile();
    };
    return { ...s, at };
  }

  /** The live case: stuck on two reconciles in a row, the second past the stuck limit. */
  async function releaseStuck(s: ReturnType<typeof stuckSetup>, row: Record<string, unknown> = stuckRow) {
    expect((await s.at(T0 + 4 * MIN, row)).destroyed).toEqual([]);
    return s.at(T0 + 5 * MIN);
  }

  it("the live case: released after the stuck limit once it held on two reconciles, with a fixed failure", async () => {
    const s = stuckSetup();
    const { life, vast, registry, agent, logs } = s;
    await life.start();
    expect((await s.at(T0 + 4 * MIN, stuckRow)).destroyed).toEqual([]);
    expect((await life.view()).start_failure).toBeNull();
    const report = await s.at(T0 + 5 * MIN);
    expect(report.destroyed).toEqual([
      { tailnet_hostname: HOST, vast_instance_id: 900, reason: "start_stuck", outcome: "destroyed" },
    ]);
    expect(agent.destroyCalls).toEqual(["watchdog"]);
    expect(vast.calls).toContain("vast.destroy:900");
    expect(await registry.active()).toBeNull();
    const view = await life.view();
    expect(view.state).toBe("none");
    expect(view.start_failure).toEqual({
      code: "start_stuck",
      server: { location: "Quebec, CA", down_mbps: 860, up_mbps: null, reliability: null, machine_id: BAD },
      measured_mb_s: null,
    });
    const line = logs.find((l) => l.includes("start stuck"));
    expect(line).toContain("instance 900");
    expect(line).toContain(`machine ${BAD}`);
    expect(line).toContain("did not start");
    for (const l of logs) {
      expect(l).not.toContain(HOST);
      expect(l).not.toContain(TOKEN);
      expect(l).not.toContain(AUTH_KEY);
    }
    // The registry file never gets new keys (a rolled-back web must still load it).
    for (const r of await registry.all()) expect(Object.keys(r).sort()).toEqual(
      ["agent_token", "created_at", "profile", "status", "tailnet_hostname", "unreachable_since", "vast_instance_id", "vast_start_date"].filter((k) => k in r).sort(),
    );
    expect(readFileSync(s.file, "utf8")).not.toMatch(/stuck|machine/);
  });

  it("one stuck sample is never enough, and the second must come at least a minute after the first", async () => {
    const s = stuckSetup();
    await s.life.start();
    expect((await s.at(T0 + 5 * MIN, stuckRow)).destroyed).toEqual([]);
    expect((await s.at(T0 + 5 * MIN + 30)).destroyed).toEqual([]);
    expect((await s.at(T0 + 6 * MIN)).destroyed.map((d) => d.reason)).toEqual(["start_stuck"]);
  });

  it("two samples before the stuck limit wait for the limit", async () => {
    const s = stuckSetup();
    await s.life.start();
    expect((await s.at(T0 + 2 * MIN, stuckRow)).destroyed).toEqual([]);
    expect((await s.at(T0 + 3 * MIN)).destroyed).toEqual([]);
    expect((await s.at(T0 + 5 * MIN)).destroyed.map((d) => d.reason)).toEqual(["start_stuck"]);
  });

  it("counts a never-started created/stopped intent, stopped, exited and a stopped intent without status as stuck", async () => {
    const rows: Record<string, unknown>[] = [
      { actual_status: "created", intended_status: "stopped" },
      { actual_status: "created", intended_status: "running", cur_state: "stopped" },
      { actual_status: "stopped" },
      { actual_status: "exited" },
      { actual_status: null, intended_status: "stopped", last_started: null },
    ];
    for (const row of rows) {
      const s = stuckSetup();
      await s.life.start();
      expect((await releaseStuck(s, row)).destroyed.map((d) => d.reason)).toEqual(["start_stuck"]);
    }
  });

  it("created with a running intent is the normal moment before the start: only the boot timeout applies", async () => {
    const s = stuckSetup();
    await s.life.start();
    const created = { actual_status: "created", intended_status: "running", cur_state: "running", next_state: "running", last_started: null };
    for (const m of [5, 6, 10, 24]) expect((await s.at(T0 + m * MIN, created)).destroyed).toEqual([]);
    expect((await s.at(T0 + 25 * MIN)).destroyed.map((d) => d.reason)).toEqual(["boot_timeout"]);
  });

  it("a long pull, one created sample (running intent), then running: never released", async () => {
    const s = stuckSetup();
    await s.life.start();
    const loading = { actual_status: "loading", intended_status: "running", cur_state: "running", last_started: null };
    for (const m of [3, 6, 8]) expect((await s.at(T0 + m * MIN, loading)).destroyed).toEqual([]);
    expect((await s.at(T0 + 11 * MIN, { actual_status: "created", intended_status: "running", cur_state: "running" })).destroyed).toEqual([]);
    expect((await s.at(T0 + 14 * MIN, runningRow)).destroyed).toEqual([]);
    expect((await s.at(T0 + 17 * MIN)).destroyed).toEqual([]);
  });

  it("a single stopped sample followed by running resets the first sighting", async () => {
    const s = stuckSetup();
    await s.life.start();
    expect((await s.at(T0 + 5 * MIN, stuckRow)).destroyed).toEqual([]);
    expect((await s.at(T0 + 8 * MIN, { ...runningRow, last_started: null })).destroyed).toEqual([]);
    // Stuck again: counted from here, so one sample is not enough.
    expect((await s.at(T0 + 11 * MIN, stuckRow)).destroyed).toEqual([]);
    expect((await s.at(T0 + 12 * MIN)).destroyed.map((d) => d.reason)).toEqual(["start_stuck"]);
  });

  it("an agent that answers resets the first sighting too", async () => {
    const s = stuckSetup();
    await s.life.start();
    expect((await s.at(T0 + 5 * MIN, stuckRow)).destroyed).toEqual([]);
    s.agent.statusImpl = async () => status("booting");
    expect((await s.at(T0 + 6 * MIN)).destroyed).toEqual([]);
    s.agent.statusImpl = async () => {
      throw new Unreachable("down");
    };
    expect((await s.at(T0 + 7 * MIN)).destroyed).toEqual([]);
  });

  it("a failed Vast list is no sample and resets nothing", async () => {
    const s = stuckSetup();
    await s.life.start();
    expect((await s.at(T0 + 5 * MIN, stuckRow)).destroyed).toEqual([]);
    s.vast.listError = new VastError("down");
    expect((await s.at(T0 + 6 * MIN)).destroyed).toEqual([]);
    s.vast.listError = null;
    expect((await s.at(T0 + 7 * MIN)).destroyed.map((d) => d.reason)).toEqual(["start_stuck"]);
  });

  it("an image still loading is not stuck; it only hits the boot timeout", async () => {
    const s = stuckSetup();
    await s.life.start();
    const loading = { actual_status: "loading", intended_status: "stopped", last_started: null };
    for (const m of [5, 10, 24]) expect((await s.at(T0 + m * MIN, loading)).destroyed).toEqual([]);
    expect((await s.at(T0 + 25 * MIN)).destroyed.map((d) => d.reason)).toEqual(["boot_timeout"]);
    expect((await s.life.view()).start_failure).toBeNull();
  });

  it("running with the agent not answering yet is booting, not stuck", async () => {
    const s = stuckSetup();
    await s.life.start();
    for (const m of [5, 6, 10]) expect((await s.at(T0 + m * MIN, runningRow)).destroyed).toEqual([]);
  });

  it("a ready instance is never a stuck start", async () => {
    const s = stuckSetup();
    await s.life.start();
    s.agent.statusImpl = async () => status("ready");
    await s.at(T0 + 60);
    s.agent.statusImpl = async () => {
      throw new Unreachable("down");
    };
    for (const m of [5, 6, 10]) expect((await s.at(T0 + m * MIN, { actual_status: "exited" })).destroyed).toEqual([]);
  });

  it("a container that started and then stopped during the boot is released without blaming the machine", async () => {
    const s = stuckSetup();
    await s.life.start();
    const stopped = { actual_status: "exited", intended_status: "stopped", cur_state: "stopped", last_started: T0 + 3 * MIN, machine_id: BAD };
    expect((await releaseStuck(s, stopped)).destroyed.map((d) => d.reason)).toEqual(["boot_stopped"]);
    expect((await s.life.view()).start_failure).toMatchObject({ code: "boot_stopped" });
    const line = s.logs.find((l) => l.includes("boot stopped"));
    expect(line).toBeDefined();
    expect(s.logs.join("\n")).not.toContain("did not start");
    // The machine is not avoided: the cheapest offer is still its own.
    expect((await s.life.estimate()).offer_id).toBe(11);
  });

  it("the next Start does not pick the stuck machine even when it is the cheapest, until the TTL passes", async () => {
    const s = stuckSetup();
    const { life, vast, time } = s;
    await life.start();
    expect(vast.createdOffers).toEqual([11]);
    await releaseStuck(s);
    expect((await life.estimate()).offer_id).toBe(12);
    const second = await life.start();
    expect(vast.createdOffers).toEqual([11, 12]);
    expect(second.estimate.dph).toBe(0.3);
    expect((await life.view()).start_failure).toBeNull(); // a new Start clears the failure
    await life.destroy();
    time.now = T0 + 5 * MIN + 60 * MIN;
    expect((await life.estimate()).offer_id).toBe(11);
  });

  it("gpuOptions skips the stuck machine too", async () => {
    const s = stuckSetup();
    await s.life.start();
    await releaseStuck(s);
    const option = (await s.life.gpuOptions()).find((o) => o.name === "RTX 3090");
    expect(option?.dph).toBe(0.3);
  });

  it("uses the chosen offer's machine when Vast's row does not name one", async () => {
    const s = stuckSetup();
    await s.life.start();
    await releaseStuck(s, { actual_status: "created", intended_status: "stopped" });
    await s.life.start();
    expect(s.vast.createdOffers).toEqual([11, 12]);
  });

  it("the bad machine and the failure survive a web restart (kept in the usage file, not the registry)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stuck-usage-"));
    const usageFile = join(dir, "usage.json");
    const usage = () => new UsageHistory({ maxEntries: 20, slackS: 120 }, new UsageStore(usageFile, usageFileCap(20)));
    const s = stuckSetup({ usage: usage() });
    await s.life.start();
    await releaseStuck(s);
    const life2 = new Lifecycle({
      cfg,
      vast: s.vast,
      registry: s.registry,
      agentFor: () => s.agent,
      clock: () => s.time.now,
      tsAuthKey: async () => AUTH_KEY,
      newToken: () => TOKEN,
      newHostname: () => "vast-other",
      sleep: async () => undefined,
      usage: usage(),
    });
    expect((await life2.view()).start_failure).toEqual({
      code: "start_stuck",
      server: { location: "Quebec, CA", down_mbps: 860, up_mbps: null, reliability: null, machine_id: BAD },
      measured_mb_s: null,
    });
    await life2.start();
    expect(s.vast.createdOffers).toEqual([11, 12]);
  });

  it("the stuck sightings belong to one instance: a new Start never inherits the old one's", async () => {
    const s = stuckSetup();
    await s.life.start();
    // A is seen stuck once, then destroyed by hand; B is started on another machine.
    expect((await s.at(T0 + 4 * MIN, stuckRow)).destroyed).toEqual([]);
    await s.life.destroy();
    s.time.now = T0 + 4 * MIN + 10;
    const second = await s.life.start();
    expect(second.record.vast_instance_id).toBe(901);
    // B looks stuck and is already older than the stuck limit at its first sighting:
    // only the per-instance tracking keeps A's earlier sighting from counting for it.
    const b = s.vast.instances.findIndex((i) => i.id === 901);
    expect((await s.at(T0 + 10 * MIN, { ...stuckRow, machine_id: GOOD }, b)).destroyed).toEqual([]);
    expect(s.vast.calls).not.toContain("vast.destroy:901");
    expect((await s.registry.active())?.vast_instance_id).toBe(901);
    expect((await s.at(T0 + 11 * MIN)).destroyed.map((d) => d.vast_instance_id)).toEqual([901]);
  });

  it("a Start queued before the detection is refused while the stuck one is still active", async () => {
    const s = stuckSetup();
    await s.life.start();
    await s.at(T0 + 4 * MIN, stuckRow);
    s.time.now = T0 + 5 * MIN;
    const [startErr, report] = await Promise.all([errorOf(s.life.start()), s.life.reconcile()]);
    expect(startErr.name).toBe("AlreadyActiveError");
    expect(report.destroyed.map((d) => d.reason)).toEqual(["start_stuck"]);
  });

  it("a Start queued after the detection rents anew and is left alone", async () => {
    const s = stuckSetup();
    await s.life.start();
    await s.at(T0 + 4 * MIN, stuckRow);
    s.time.now = T0 + 5 * MIN;
    const [report, second] = await Promise.all([s.life.reconcile(), s.life.start()]);
    expect(report.destroyed.map((d) => d.vast_instance_id)).toEqual([900]);
    expect(second.record.vast_instance_id).toBe(901);
    expect(s.vast.calls).not.toContain("vast.destroy:901");
  });

  describe("advanced offer choice and the bad-machine list", () => {
    it("the offer list skips a stuck machine, and an explicit choice of one is refused before anything is created", async () => {
      const s = stuckSetup();
      await s.life.start();
      await releaseStuck(s);
      expect((await s.life.offers()).map((o) => o.id)).toEqual([12]);
      const before = s.vast.createdOffers.length;
      await expect(s.life.start(undefined, null, { offerId: 11 })).rejects.toBeInstanceOf(OfferGoneError);
      expect(s.vast.createdOffers).toHaveLength(before);
      expect((await s.registry.all()).filter((r) => r.status === "creating" || r.status === "booting")).toEqual([]);
    });
  });
});

describe("Lifecycle server location (where the rented machine is)", () => {
  const offer = (id: number, dph: number, over: Record<string, unknown> = {}): Offer => ({
    id, dph_total: dph, gpu_name: "RTX A5000", gpu_ram: 24564, ...over,
  });

  it("view shows Vast's row for the instance, else the chosen offer, field by field", async () => {
    const { life, vast } = setup();
    vast.offers = [offer(11, 0.3, { geolocation: "Quebec, CA", inet_down: 860, inet_up: 400, reliability2: 0.99, machine_id: 5 })];
    expect((await life.view()).server).toBeNull();
    await life.start();
    expect((await life.view()).server).toEqual({ location: "Quebec, CA", down_mbps: 860, up_mbps: 400, reliability: 0.99, machine_id: 5 });
    Object.assign(vast.instances[0]!, { geolocation: "Montreal, CA", inet_down: 700 });
    expect((await life.view()).server).toEqual({ location: "Montreal, CA", down_mbps: 700, up_mbps: 400, reliability: 0.99, machine_id: 5 });
  });

  it("view has no server when nothing is known", async () => {
    const { life } = setup();
    await life.start();
    expect((await life.view()).server).toBeNull();
  });

  it("gpuOptions and the estimate carry the cheapest offer's location and download speed", async () => {
    const { life, vast } = setup();
    vast.offers = [offer(11, 0.3, { geolocation: "Quebec, CA", inet_down: 860 }), offer(12, 0.4, { geolocation: "Paris, FR" })];
    const a5000 = (await life.gpuOptions()).find((g) => g.name === "RTX A5000");
    expect(a5000).toMatchObject({ dph: 0.3, location: "Quebec, CA", down_mbps: 860 });
    const missing = (await life.gpuOptions()).find((g) => g.name === "RTX 4090");
    expect(missing).toMatchObject({ available: false, location: null, down_mbps: null });
    expect(await life.estimate()).toMatchObject({ offer_id: 11, location: "Quebec, CA", down_mbps: 860 });
  });

  it("re-checks VAST_MIN_DOWNLOAD_MBPS locally: a slower offer is never rented, an unknown speed is kept", async () => {
    const { life, vast } = setup();
    vast.offers = [offer(11, 0.1, { inet_down: 499 }), offer(12, 0.2), offer(13, 0.3, { inet_down: 900 })];
    expect((await life.estimate()).offer_id).toBe(12);
    vast.offers = [offer(11, 0.1, { inet_down: 499 }), offer(13, 0.3, { inet_down: 500 })];
    await life.start();
    expect(vast.createdOffers).toEqual([13]);
  });
});

describe("Lifecycle slow boot release (slow_boot, slow_download) and boots that vanished", () => {
  const BAD = 56685310;
  const GOOD = 777;
  const MIN = 60;
  const MB = 1_000_000;
  // About the shipped profile: 15 GB in three files, downloaded in this order.
  const models: ModelSpec[] = [
    { file: "a.gguf", size_bytes: 4_600 * MB },
    { file: "b.safetensors", size_bytes: 9_400 * MB },
    { file: "c.safetensors", size_bytes: 1_000 * MB },
  ];
  const runningRow = { actual_status: "running", cur_state: "running", intended_status: "running", last_started: T0 + 60, machine_id: BAD };

  function slowSetup(over: Parameters<typeof setup>[0] = {}) {
    const s = setup({ models, ...over });
    s.vast.offers = [
      { id: 11, dph_total: 0.2, gpu_name: "RTX A5000", gpu_ram: 24576, machine_id: BAD, geolocation: "Lithuania, LT", inet_down: 888 },
      { id: 12, dph_total: 0.3, gpu_name: "RTX A5000", gpu_ram: 24576, machine_id: GOOD },
    ];
    s.agent.statusImpl = async () => {
      throw new Unreachable("agent not reachable");
    };
    const at = async (t: number, row?: Record<string, unknown>) => {
      if (row !== undefined && s.vast.instances[0] !== undefined) Object.assign(s.vast.instances[0], row);
      s.time.now = t;
      return s.life.reconcile();
    };
    /** The agent reports the overall download at `bytes` (across the profile files, in order). */
    const downloading = (bytes: number) => {
      let before = 0;
      for (const m of models) {
        if (bytes < before + m.size_bytes || m === models.at(-1)) {
          const done = Math.min(bytes - before, m.size_bytes);
          s.agent.statusImpl = async () =>
            status("downloading", { progress: { phase: "models", file: m.file, bytes_done: done, bytes_total: m.size_bytes } });
          return;
        }
        before += m.size_bytes;
      }
    };
    return { ...s, at, downloading };
  }

  const reasons = (r: { destroyed: { reason: string }[] }) => r.destroyed.map((d) => d.reason);

  describe("slow_boot: Vast says running, the agent never answers", () => {
    it("the live case (stuck in install_tools): released once BOOT_AGENT_GRACE_MIN of silence held, machine avoided", async () => {
      const s = slowSetup();
      await s.life.start();
      expect(reasons(await s.at(T0 + 2 * MIN, { actual_status: "loading" }))).toEqual([]);
      expect(reasons(await s.at(T0 + 3 * MIN, runningRow))).toEqual([]); // first silent sighting
      for (const m of [5, 8, 12]) expect(reasons(await s.at(T0 + m * MIN))).toEqual([]);
      const report = await s.at(T0 + 13 * MIN);
      expect(reasons(report)).toEqual(["slow_boot"]);
      expect(s.agent.destroyCalls).toEqual(["watchdog"]);
      expect(s.vast.calls).toContain("vast.destroy:900");
      const view = await s.life.view();
      expect(view.state).toBe("none");
      expect(view.start_failure).toMatchObject({ code: "slow_boot", measured_mb_s: null });
      expect(view.start_failure?.server?.machine_id).toBe(BAD);
      expect((await s.life.estimate()).offer_id).toBe(12);
      const line = s.logs.find((l) => l.includes("slow boot"));
      expect(line).toContain(`machine ${BAD}`);
      expect(line).toContain("avoiding the machine for 60 min");
      for (const l of s.logs) {
        expect(l).not.toContain(HOST);
        expect(l).not.toContain(TOKEN);
        expect(l).not.toContain(AUTH_KEY);
      }
      // Well before BOOT_TIMEOUT_MIN (25).
      expect(s.time.now - T0).toBeLessThan(25 * MIN);
    });

    it("one silent sample is not enough, however late", async () => {
      const s = slowSetup({ cfg: { bootTimeoutMin: 60 } });
      await s.life.start();
      expect(reasons(await s.at(T0 + 20 * MIN, runningRow))).toEqual([]);
      expect(reasons(await s.at(T0 + 20 * MIN + 30))).toEqual([]);
      expect(reasons(await s.at(T0 + 30 * MIN))).toEqual(["slow_boot"]);
    });

    it("a long image pull does not count: silence is measured from the first running sighting", async () => {
      const s = slowSetup();
      await s.life.start();
      for (const m of [3, 6, 9, 12]) expect(reasons(await s.at(T0 + m * MIN, { actual_status: "loading" }))).toEqual([]);
      expect(reasons(await s.at(T0 + 13 * MIN, runningRow))).toEqual([]);
      expect(reasons(await s.at(T0 + 16 * MIN))).toEqual([]);
      expect(reasons(await s.at(T0 + 22 * MIN))).toEqual([]);
      expect(reasons(await s.at(T0 + 23 * MIN))).toEqual(["slow_boot"]);
    });

    it("an agent that answered once is never a slow boot (the unreachable rule covers it)", async () => {
      const s = slowSetup();
      await s.life.start();
      s.agent.statusImpl = async () => status("booting");
      expect(reasons(await s.at(T0 + 3 * MIN, runningRow))).toEqual([]);
      s.agent.statusImpl = async () => {
        throw new Unreachable("down");
      };
      // The unreachable timer starts at the first silent sighting (4 min) and runs UNREACHABLE_DESTROY_MIN (15).
      for (const m of [4, 10, 15, 18]) expect(reasons(await s.at(T0 + m * MIN))).toEqual([]);
      expect(reasons(await s.at(T0 + 19 * MIN))).toEqual(["unreachable"]);
      expect((await s.life.view()).start_failure).toBeNull();
    });

    it("a ready instance is never released as slow", async () => {
      const s = slowSetup();
      await s.life.start();
      s.agent.statusImpl = async () => status("ready");
      await s.at(T0 + 3 * MIN, runningRow);
      s.agent.statusImpl = async () => {
        throw new Unreachable("down");
      };
      for (const m of [4, 10, 14, 17]) expect(reasons(await s.at(T0 + m * MIN))).toEqual([]);
    });

    it("a failed Vast list is no sample and resets nothing", async () => {
      const s = slowSetup();
      await s.life.start();
      expect(reasons(await s.at(T0 + 3 * MIN, runningRow))).toEqual([]);
      s.vast.listError = new VastError("down");
      expect(reasons(await s.at(T0 + 8 * MIN))).toEqual([]);
      s.vast.listError = null;
      expect(reasons(await s.at(T0 + 13 * MIN))).toEqual(["slow_boot"]);
    });

    it("a web restart starts the sighting over: it only delays the release", async () => {
      const s = slowSetup();
      await s.life.start();
      expect(reasons(await s.at(T0 + 3 * MIN, runningRow))).toEqual([]);
      // The unreachable rule (kept in the registry) would fire at 18 min: move it out of the way.
      const life2 = new Lifecycle({
        cfg: { ...cfg, unreachableDestroyMin: 60 } as unknown as AppsConfig, vast: s.vast, registry: s.registry,
        agentFor: () => s.agent, clock: () => s.time.now, profileModels: models,
        tsAuthKey: async () => AUTH_KEY, newToken: () => TOKEN, newHostname: () => "vast-other", sleep: async () => undefined,
      });
      s.time.now = T0 + 13 * MIN;
      expect(reasons(await life2.reconcile())).toEqual([]);
      s.time.now = T0 + 22 * MIN;
      expect(reasons(await life2.reconcile())).toEqual([]);
      s.time.now = T0 + 23 * MIN;
      expect(reasons(await life2.reconcile())).toEqual(["slow_boot"]);
    });

    it("after a restart, an agent seen before (usage file) still counts as answered", async () => {
      const dir = mkdtempSync(join(tmpdir(), "slow-usage-"));
      const usageFile = join(dir, "usage.json");
      const usage = () => new UsageHistory({ maxEntries: 20, slackS: 120 }, new UsageStore(usageFile, usageFileCap(20)));
      const s = slowSetup({ usage: usage() });
      await s.life.start();
      s.agent.statusImpl = async () => status("booting");
      await s.at(T0 + 3 * MIN, runningRow);
      s.agent.statusImpl = async () => {
        throw new Unreachable("down");
      };
      const life2 = new Lifecycle({
        cfg, vast: s.vast, registry: s.registry, agentFor: () => s.agent, clock: () => s.time.now, profileModels: models,
        tsAuthKey: async () => AUTH_KEY, newToken: () => TOKEN, newHostname: () => "vast-other", sleep: async () => undefined,
        usage: usage(),
      });
      for (const m of [4, 9, 14]) {
        s.time.now = T0 + m * MIN;
        expect(reasons(await life2.reconcile())).toEqual([]);
      }
    });
  });

  describe("slow_download: the agent's download progress is too slow", () => {
    it("the live case (about 2.8 MB/s): released after two slow samples with the measured speed, machine avoided", async () => {
      const s = slowSetup();
      await s.life.start();
      s.downloading(0);
      expect(reasons(await s.at(T0 + 3 * MIN, runningRow))).toEqual([]); // window starts
      s.downloading(2.8 * MB * 60);
      expect(reasons(await s.at(T0 + 4 * MIN))).toEqual([]); // 60 s < MODEL_ETA_MIN_OBSERVE_S
      s.downloading(2.8 * MB * 120);
      expect(reasons(await s.at(T0 + 5 * MIN))).toEqual([]); // slow 1
      s.downloading(2.8 * MB * 180);
      expect(reasons(await s.at(T0 + 6 * MIN))).toEqual(["slow_download"]); // slow 2, a minute later
      const view = await s.life.view();
      expect(view.start_failure).toMatchObject({ code: "slow_download", measured_mb_s: 2.8 });
      expect(view.start_failure?.server).toMatchObject({ machine_id: BAD, location: "Lithuania, LT", down_mbps: 888 });
      expect((await s.life.estimate()).offer_id).toBe(12);
      const line = s.logs.find((l) => l.includes("slow download"));
      expect(line).toContain("about 2.8 MB/s");
      expect(line).toContain(`machine ${BAD}`);
      expect(s.logs.join("\n")).not.toContain(HOST);
    });

    it("a healthy download (about 55 MB/s, ETA about 5 min) is never released and boots to ready", async () => {
      const s = slowSetup();
      await s.life.start();
      let bytes = 0;
      s.downloading(bytes);
      await s.at(T0 + 2 * MIN, runningRow);
      for (let m = 3; m <= 6; m++) {
        bytes += 55 * MB * 60;
        s.downloading(bytes);
        expect(reasons(await s.at(T0 + m * MIN))).toEqual([]);
      }
      s.agent.statusImpl = async () => status("ready");
      expect((await s.at(T0 + 7 * MIN)).ready).toEqual([HOST]);
      expect((await s.life.view()).start_failure).toBeNull();
    });

    it("a speed just fast enough (15 GB left at 13 MB/s, about 19 min) is not released", async () => {
      const s = slowSetup();
      await s.life.start();
      let bytes = 0;
      s.downloading(bytes);
      await s.at(T0 + 3 * MIN, runningRow);
      for (let m = 4; m <= 9; m++) {
        bytes += 13 * MB * 60;
        s.downloading(bytes);
        expect(reasons(await s.at(T0 + m * MIN))).toEqual([]);
      }
    });

    it("a good sample resets the slow run, and a failed agent read is no sample", async () => {
      const s = slowSetup();
      await s.life.start();
      s.downloading(0);
      await s.at(T0 + 3 * MIN, runningRow);
      s.downloading(1 * MB * 120);
      expect(reasons(await s.at(T0 + 5 * MIN))).toEqual([]); // slow 1
      // A burst: the average since the window start is now fast enough.
      s.downloading(14_000 * MB);
      expect(reasons(await s.at(T0 + 6 * MIN))).toEqual([]); // good: resets
      s.downloading(14_000 * MB);
      expect(reasons(await s.at(T0 + 30 * MIN, undefined))).toEqual(["boot_timeout"]);
    });

    it("an agent read that fails between two slow samples does not break the run", async () => {
      const s = slowSetup();
      await s.life.start();
      s.downloading(0);
      await s.at(T0 + 3 * MIN, runningRow);
      s.downloading(1 * MB * 120);
      expect(reasons(await s.at(T0 + 5 * MIN))).toEqual([]); // slow 1
      s.agent.statusImpl = async () => {
        throw new Unreachable("blip");
      };
      expect(reasons(await s.at(T0 + 6 * MIN))).toEqual([]);
      s.downloading(1 * MB * 240);
      expect(reasons(await s.at(T0 + 7 * MIN))).toEqual(["slow_download"]);
      expect((await s.life.view()).start_failure).toMatchObject({ measured_mb_s: 1 });
    });

    it("fewer bytes than at the window start (a file restarted) starts a new window", async () => {
      const s = slowSetup();
      await s.life.start();
      s.downloading(5_000 * MB);
      await s.at(T0 + 3 * MIN, runningRow);
      s.downloading(5_000 * MB + MB);
      expect(reasons(await s.at(T0 + 5 * MIN))).toEqual([]); // slow 1
      s.downloading(4_600 * MB); // the second file starts over
      expect(reasons(await s.at(T0 + 6 * MIN))).toEqual([]); // new window
      s.downloading(4_600 * MB + MB);
      expect(reasons(await s.at(T0 + 7 * MIN))).toEqual([]); // 60 s: not judged yet
      expect(reasons(await s.at(T0 + 8 * MIN))).toEqual([]); // slow 1
      expect(reasons(await s.at(T0 + 9 * MIN))).toEqual(["slow_download"]);
    });

    it("bytes falling below the previous sample (a file restarted) open a new window; 18-20 MB/s is never released", async () => {
      const s = slowSetup();
      await s.life.start();
      s.downloading(5_000 * MB);
      await s.at(T0 + 3 * MIN, runningRow);
      s.downloading(6_100 * MB);
      expect(reasons(await s.at(T0 + 4 * MIN))).toEqual([]);
      // A retry restarted the second file: fewer bytes than the previous sample, still above the first.
      s.downloading(5_010 * MB);
      expect(reasons(await s.at(T0 + 5 * MIN))).toEqual([]);
      let bytes = 5_010 * MB;
      for (let m = 6; m <= 12; m++) {
        bytes += 19 * MB * 60;
        s.downloading(bytes);
        expect(reasons(await s.at(T0 + m * MIN))).toEqual([]);
      }
    });

    it("a download that would end after BOOT_TIMEOUT_MIN is released early even with an ETA under the limit", async () => {
      const s = slowSetup();
      await s.life.start();
      s.downloading(0);
      await s.at(T0 + 6 * MIN, runningRow); // a late agent: the window starts at 6 min
      s.downloading(12.6 * MB * 120);
      // ETA about 17.8 min (< 20), but 8 + 17.8 + the rest of the boot is past 25.
      expect(reasons(await s.at(T0 + 8 * MIN))).toEqual([]);
      s.downloading(12.6 * MB * 180);
      expect(reasons(await s.at(T0 + 9 * MIN))).toEqual(["slow_download"]);
      expect((await s.life.view()).start_failure).toMatchObject({ code: "slow_download", measured_mb_s: 12.6 });
    });

    it("no model list (no profile) never judges the download", async () => {
      const s = setup();
      s.agent.statusImpl = async () =>
        status("downloading", { progress: { phase: "models", file: "a.gguf", bytes_done: 0, bytes_total: 100 } });
      await s.life.start();
      for (const m of [3, 6, 9, 12]) {
        s.time.now = T0 + m * MIN;
        expect(reasons(await s.life.reconcile())).toEqual([]);
      }
    });
  });

  describe("a boot that vanished by itself (generic rule)", () => {
    async function vanish(s: ReturnType<typeof slowSetup>, from: number) {
      s.vast.instances = [];
      expect((await s.at(T0 + from * MIN)).gone).toEqual([]);
      return s.at(T0 + (from + 1) * MIN);
    }

    it("puts the machine on the bad list for the TTL and shows boot_failed", async () => {
      const s = slowSetup();
      await s.life.start();
      s.agent.statusImpl = async () => status("booting");
      await s.at(T0 + 3 * MIN, runningRow);
      const report = await vanish(s, 10);
      expect(report.gone).toEqual([{ tailnet_hostname: HOST, reason: "vanished" }]);
      expect((await s.life.view()).start_failure).toMatchObject({ code: "boot_failed", measured_mb_s: null });
      expect((await s.life.estimate()).offer_id).toBe(12);
      const line = s.logs.find((l) => l.includes("boot failed"));
      expect(line).toContain(`machine ${BAD}`);
      expect(line).toContain("disappeared during its boot");
      s.time.now = T0 + 11 * MIN + 60 * MIN;
      expect((await s.life.estimate()).offer_id).toBe(11);
    });

    it("never after the Destroy button (the record was stopping) or once the instance was ready", async () => {
      const s = slowSetup();
      await s.life.start();
      await s.at(T0 + 3 * MIN, runningRow);
      s.vast.destroyQueue = [new DestroyError("vast busy"), new DestroyError("vast busy"), new DestroyError("vast busy")];
      await expect(s.life.destroy("admin")).rejects.toThrow();
      expect((await s.registry.active())?.status).toBe("stopping");
      s.vast.instances = [];
      await s.at(T0 + 10 * MIN);
      await s.at(T0 + 11 * MIN);
      expect(await s.registry.active()).toBeNull();
      expect((await s.life.view()).start_failure).toBeNull();
      expect((await s.life.estimate()).offer_id).toBe(11);

      const r = slowSetup();
      await r.life.start();
      r.agent.statusImpl = async () => status("ready");
      await r.at(T0 + 3 * MIN, runningRow);
      await vanish(r, 10);
      expect((await r.life.view()).start_failure).toBeNull();
      expect((await r.life.estimate()).offer_id).toBe(11);
    });

    for (const reason of ["tailscale_failed", "download_failed", "node_install_failed", "node_import_failed", "comfyui_start_failed", "config_invalid", "boot_failed", "something_new"]) {
      it(`does not blame the machine for a boot that failed with ${reason} (service-wide or a code problem)`, async () => {
        const s = slowSetup();
        await s.life.start();
        s.agent.statusImpl = async () => status("failed", { reason });
        await s.at(T0 + 3 * MIN, runningRow);
        await vanish(s, 10);
        const failure = (await s.life.view()).start_failure;
        expect(failure).toMatchObject({ code: "boot_failed" });
        expect(failure?.server?.machine_id ?? null).toBeNull();
        expect((await s.life.estimate()).offer_id).toBe(11);
        expect(s.logs.find((l) => l.includes("boot failed"))).toContain("not blamed");
      });
    }

    it("blames the machine for disk_insufficient", async () => {
      const s = slowSetup();
      await s.life.start();
      s.agent.statusImpl = async () => status("failed", { reason: "disk_insufficient" });
      await s.at(T0 + 3 * MIN, runningRow);
      await vanish(s, 10);
      expect((await s.life.estimate()).offer_id).toBe(12);
    });

    it("never blames a machine whose Destroy was requested while its create was uncertain", async () => {
      const s = slowSetup();
      s.vast.createImpl = async () => {
        throw new Error("network timeout");
      };
      await expect(s.life.start()).rejects.toThrow();
      expect((await s.life.destroy("admin")).outcome).toBe("pending");
      await s.registry.update(HOST, { status: "booting", vast_instance_id: 900 });
      await vanish(s, 10);
      expect(await s.registry.active()).toBeNull();
      expect((await s.life.view()).start_failure).toBeNull();
      expect((await s.life.estimate()).offer_id).toBe(11);
    });

    it("never blames a machine whose stop the web had recorded (usage file)", async () => {
      const usage = new UsageHistory({ maxEntries: 20, slackS: 120 }, null);
      const s = slowSetup({ usage });
      await s.life.start();
      await s.at(T0 + 3 * MIN, runningRow);
      usage.requestStop(HOST, "hard_cap");
      await vanish(s, 10);
      expect(await s.registry.active()).toBeNull();
      expect((await s.life.view()).start_failure).toBeNull();
      expect((await s.life.estimate()).offer_id).toBe(11);
    });

    it("an unknown machine is not avoided (and nothing breaks)", async () => {
      const s = slowSetup();
      s.vast.offers = [{ id: 11, dph_total: 0.2, gpu_name: "RTX A5000", gpu_ram: 24576 }];
      await s.life.start();
      await s.at(T0 + 3 * MIN, { actual_status: "running" });
      await vanish(s, 10);
      const failure = (await s.life.view()).start_failure;
      expect(failure).toMatchObject({ code: "boot_failed" });
      expect(failure?.server?.machine_id ?? null).toBeNull();
      expect((await s.life.estimate()).offer_id).toBe(11);
      expect(s.logs.find((l) => l.includes("boot failed"))).toContain("nothing is avoided");
    });
  });
});

describe("Lifecycle advanced offer choice", () => {
  const rtx = (id: number, dph: number, geo: string, down: number, rel: number): Offer => ({
    id,
    dph_total: dph,
    gpu_name: "RTX 3090",
    gpu_ram: 24576,
    geolocation: geo,
    inet_down: down,
    reliability2: rel,
    machine_id: 1000 + id,
  });
  const offers = [
    rtx(1, 0.3, "Lithuania, LT", 600, 0.99),
    rtx(2, 0.4, "Quebec, CA", 900, 0.995),
    rtx(3, 0.25, "Texas, US", 700, 0.98),
    rtx(4, 0.45, "Tokyo, JP", 800, 0.999),
  ];
  function make() {
    const s = setup();
    s.vast.offers = offers;
    return s;
  }

  it("offers(): the filtered and sorted list, at most START_OFFER_LIST_MAX long, in the public shape", async () => {
    const { life } = make();
    expect((await life.offers()).map((o) => o.id)).toEqual([3, 1, 2]); // cheapest first, cut at 3
    expect((await life.offers(undefined, { sort: "speed" })).map((o) => o.id)).toEqual([2, 4, 3]);
    expect((await life.offers(undefined, { region: "north_america" })).map((o) => o.id)).toEqual([3, 2]);
    expect((await life.offers(undefined, { maxDph: 0.3 })).map((o) => o.id)).toEqual([3, 1]);
    expect((await life.offers(undefined, { minDownMbps: 800 })).map((o) => o.id)).toEqual([2, 4]);
    const first = (await life.offers())[0]!;
    expect(first).toEqual({ id: 3, gpu_name: "RTX 3090", dph: 0.25, vram_gb: 24, location: "Texas, US", region: "north_america", down_mbps: 700, reliability: 0.98 });
    expect(JSON.stringify(await life.offers())).not.toMatch(/machine|1003/);
  });

  it("offers(gpu) restricts to that model and refuses a model outside the allow-list", async () => {
    const { life } = make();
    await expect(life.offers("Tesla P40")).rejects.toBeInstanceOf(GpuNotAllowedError);
    expect((await life.offers("RTX 3090")).length).toBe(3);
  });

  it("start rents the first of the filtered order, not the cheapest overall", async () => {
    const { life, vast } = make();
    const out = await life.start(undefined, null, { region: "asia" });
    expect(vast.createdOffers).toEqual([4]);
    expect(out.estimate.offer_id).toBe(4);
    expect(out.estimate.location).toBe("Tokyo, JP");
  });

  it("start with sort=speed rents the fastest", async () => {
    const { life, vast } = make();
    await life.start(undefined, null, { sort: "speed" });
    expect(vast.createdOffers).toEqual([2]);
  });

  it("start with an explicit offer rents exactly that one, even when it is not the first", async () => {
    const { life, vast } = make();
    const out = await life.start(undefined, null, { offerId: 2 });
    expect(vast.createdOffers).toEqual([2]);
    expect(out.estimate.dph).toBe(0.4);
  });

  it("an offer that vanished (or no longer passes the filters) is a clear refusal: no record kept, nothing created", async () => {
    const { life, vast, registry } = make();
    expect((await life.offers()).map((o) => o.id)).toContain(2);
    vast.offers = offers.filter((o) => o.id !== 2); // gone between listing and renting
    await expect(life.start(undefined, null, { offerId: 2 })).rejects.toBeInstanceOf(OfferGoneError);
    await expect(life.start(undefined, null, { offerId: 4, region: "europe" })).rejects.toBeInstanceOf(OfferGoneError); // fails the filter
    await expect(life.estimate(undefined, { offerId: 2 })).rejects.toBeInstanceOf(OfferGoneError);
    expect(vast.createdOffers).toEqual([]);
    expect((await registry.all()).every((r) => r.status === "gone")).toBe(true);
    // The next plain Start still works.
    await life.start();
    expect(vast.createdOffers).toEqual([3]);
  });

  it("filters that match nothing are NoOffersError, for start and estimate", async () => {
    const { life, vast } = make();
    await expect(life.start(undefined, null, { region: "oceania" })).rejects.toBeInstanceOf(NoOffersError);
    await expect(life.estimate(undefined, { maxDph: 0.01 })).rejects.toBeInstanceOf(NoOffersError);
    expect(vast.createdOffers).toEqual([]);
  });

  it("estimate and gpuOptions follow the filters", async () => {
    const { life } = make();
    expect((await life.estimate(undefined, { region: "europe" })).offer_id).toBe(1);
    const options = await life.gpuOptions({ region: "asia" });
    expect(options.find((o) => o.name === "RTX 3090")).toMatchObject({ dph: 0.45, available: true, location: "Tokyo, JP" });
    expect(options.find((o) => o.name === "RTX 4090")).toMatchObject({ available: false });
  });

  it("the Vast query keeps the configured limits whatever the request says", async () => {
    const { life, vast } = make();
    await life.offers(undefined, { maxDph: 0.3, minDownMbps: 800 });
    expect(vast.searches[0]).toMatchObject({ maxDph: 0.5, minDownloadMbps: 500 });
  });

  it("parseFilters narrows only: a price above VAST_MAX_DPH is refused", () => {
    const { life } = make();
    expect(life.parseFilters({ max_dph: 0.5 })).toEqual({ maxDph: 0.5 });
    expect(() => life.parseFilters({ max_dph: 0.51 })).toThrow(StartFilterError);
    expect(life.parseFilters(undefined)).toEqual({});
  });
});


describe("video models at Start and on demand", () => {
  it("an image-only start is unchanged: VAST_DISK_GB, no INCLUDE_VIDEO_MODELS, VAST_VIDEO_DISK_GB not even read", async () => {
    const { life, vast } = setup({ cfg: { vastVideoDiskGb: "broken" } });
    await life.start();
    expect(vast.requests[0]!.disk).toBe(50);
    expect(vast.requests[0]!.env).not.toHaveProperty("INCLUDE_VIDEO_MODELS");
    expect(vast.searches[0]).toMatchObject({ diskGb: 50 });
  });

  it("a start that includes video rents and searches the larger disk and tells the instance", async () => {
    const { life, vast } = setup({ cfg: { vastVideoDiskGb: 80 } });
    await life.start(undefined, null, { videoModels: true });
    expect(vast.requests[0]!.disk).toBe(80);
    expect(vast.requests[0]!.env["INCLUDE_VIDEO_MODELS"]).toBe("true");
    expect(vast.searches[0]).toMatchObject({ diskGb: 80 });
    const big = setup({ cfg: { vastVideoDiskGb: 20, vastDiskGb: 60 } });
    await big.life.start(undefined, null, { videoModels: true });
    expect(big.vast.requests[0]!.disk).toBe(60); // never less than VAST_DISK_GB
  });

  it("a link travels as VIDEO_MODEL_URL with the video models only; VIDEO_ENABLED and the link rules with every start while video is on", async () => {
    const link = "https://huggingface.co/o/r/resolve/main/m.safetensors"; // config-lint: ok (test fixture)
    const rules = { videoEnabled: true, videoModelLinkHosts: ["huggingface.co"], videoModelLinkRedirectDomains: ["huggingface.co", "hf.co"], videoModelLinkMaxBytes: 1000 };
    const withVideo = setup({ cfg: { vastVideoDiskGb: 80, ...rules }, videoFiles: ["v.safetensors"] });
    await withVideo.life.start(undefined, null, { videoModels: true, videoModelUrl: link });
    expect(withVideo.vast.requests[0]!.env).toMatchObject({
      VIDEO_ENABLED: "true", VIDEO_MODEL_URL: link, VIDEO_MODEL_LINK_HOSTS: "huggingface.co", VIDEO_MODEL_LINK_REDIRECT_DOMAINS: "huggingface.co,hf.co", VIDEO_MODEL_LINK_MAX_BYTES: "1000",
    });
    const noVideoBox = setup({ cfg: rules, videoFiles: ["v.safetensors"] });
    await noVideoBox.life.start(undefined, null, { videoModelUrl: link });
    expect(noVideoBox.vast.requests[0]!.env).not.toHaveProperty("VIDEO_MODEL_URL");
    expect(noVideoBox.vast.requests[0]!.env).toMatchObject({ VIDEO_ENABLED: "true", VIDEO_MODEL_LINK_HOSTS: "huggingface.co" });
    const bad = setup({ cfg: { ...rules, videoModelLinkHosts: ["evil host"] }, videoFiles: ["v.safetensors"] });
    expect(((await errorOf(bad.life.start())) as StartError).reason).toBe("config_invalid");
  });

  it("with VIDEO_ENABLED off nothing about video reaches the instance, even with its files in the profile", async () => {
    for (const cfgOver of [{}, { videoEnabled: false }]) {
      const off = setup({ cfg: cfgOver, videoFiles: ["v.safetensors"] });
      await off.life.start();
      const env = off.vast.requests[0]!.env;
      expect(Object.keys(env).filter((k) => k.startsWith("VIDEO_") || k === "INCLUDE_VIDEO_MODELS")).toEqual([]);
    }
  });

  it("the estimate and the offer lists search the disk of the chosen boot", async () => {
    const { life, vast } = setup({ cfg: { vastVideoDiskGb: 80 } });
    await life.estimate(undefined, { videoModels: true });
    await life.offers(undefined, {});
    await life.gpuOptions({ videoModels: true });
    expect(vast.searches.map((f) => f.diskGb)).toEqual([80, 50, 80]);
  });

  it("the overall download of an image-only boot leaves the video files out", async () => {
    const models = [{ file: "a.bin", size_bytes: 10 }, { file: "sub/v.bin", size_bytes: 1000 }];
    const { life, vast, agent } = setup({ models, videoFiles: ["v.bin"], cfg: { videoModelLinkHosts: ["huggingface.co"], videoModelLinkRedirectDomains: ["hf.co"], videoModelLinkMaxBytes: 10 } });
    await life.start();
    vast.instances[0]!.actual_status = "running";
    agent.statusImpl = async () => status("downloading", { progress: { phase: "models", file: "a.bin", bytes_done: 5, bytes_total: 10 } });
    expect((await life.view()).download).toMatchObject({ files_total: 1, bytes_total: 10, bytes_done: 5 });
    agent.statusImpl = async () =>
      status("downloading", {
        progress: { phase: "models", file: "a.bin", bytes_done: 5, bytes_total: 10 },
        video_models: { state: "not_installed", boot: true, bytes_done: 0, bytes_total: 1000 },
      });
    expect((await life.view()).download).toMatchObject({ files_total: 2, bytes_total: 1010, bytes_done: 5 });
  });

  it("downloadVideoModels forwards to the active instance's agent, scrubbed, and needs an instance", async () => {
    const { life, agent, calls } = setup();
    await expect(life.downloadVideoModels()).rejects.toThrow(/no active instance/);
    await life.start();
    expect(await life.downloadVideoModels()).toEqual({ state: "downloading", boot: false, bytes_done: 0, bytes_total: 50 });
    expect(calls).toContain("agent.video");
    agent.videoImpl = async () => {
      throw new AgentError(409, `video models failed with HTTP 409: disk too small (${TOKEN})`, "disk_insufficient");
    };
    const err = (await errorOf(life.downloadVideoModels())) as AgentError;
    expect(err.code).toBe("disk_insufficient");
    expect(err.message).not.toContain(TOKEN);
  });
});
