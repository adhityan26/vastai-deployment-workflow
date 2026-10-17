import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppsConfig } from "../src/config.js";
import type { AgentStatus } from "../src/agent.js";
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
  type VastInstance,
} from "../src/vast.js";
import {
  DestroyFailedError,
  Lifecycle,
  NoOffersError,
  ONSTART_CMD,
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
  vastAllowedGpus: [],
  comfyPort: 18188,
  agentPort: 8189,
  startIdleMinutes: 30,
  startFailsafeHours: 3,
  startHardCapHours: 6,
  bootTimeoutMin: 25,
  unreachableDestroyMin: 15,
  reconcileGraceMin: 10,
  webDestroyRetries: 3,
  webDestroyBackoffS: 5,
  secretNames: [],
} as unknown as AppsConfig;

class FakeVast {
  calls: string[];
  offers: Offer[] = [{ id: 11, dph_total: 0.3, gpu_name: "RTX A5000" }];
  instances: VastInstance[] = [];
  createImpl: (offerId: number, req: CreateRequest) => Promise<{ id: number }>;
  destroyQueue: (DestroyOutcome | Error)[] = [];
  listError: Error | null = null;
  requests: CreateRequest[] = [];
  nextId = 900;

  constructor(calls: string[], private readonly clock: () => number) {
    this.calls = calls;
    this.createImpl = async (_offer, req) => {
      const id = this.nextId++;
      this.instances.push({ id, label: req.label, actual_status: "loading", start_date: this.clock(), dph_total: 0.3 });
      return { id };
    };
  }

  async searchOffers(): Promise<Offer[]> {
    this.calls.push("vast.search");
    return this.offers;
  }
  async createInstance(offerId: number, req: CreateRequest): Promise<{ id: number }> {
    this.calls.push("vast.create");
    this.requests.push(req);
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

function setup(over: Partial<{ authKey: () => Promise<string> }> = {}) {
  const calls: string[] = [];
  const time = { now: T0 };
  const clock = (): number => time.now;
  const dir = mkdtempSync(join(tmpdir(), "life-"));
  const file = join(dir, "registry.json");
  const registry = new TracingRegistry(file, calls);
  const vast = new FakeVast(calls, clock);
  const agent = new FakeAgent(calls);
  const sleeps: number[] = [];
  let hostCounter = 0;
  const life = new Lifecycle({
    cfg,
    vast,
    registry,
    agentFor: () => agent,
    clock,
    tsAuthKey: over.authKey ?? (async () => AUTH_KEY),
    newToken: () => TOKEN,
    newHostname: () => (hostCounter++ === 0 ? HOST : `${HOST}-${hostCounter}`),
    sleep: async (s) => {
      sleeps.push(s);
    },
  });
  return { calls, time, registry, vast, agent, life, file, sleeps };
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
    });
    expect(out.record.status).toBe("booting");
    expect(out.record.vast_instance_id).toBe(900);
    expect(out.record.vast_start_date).toBe(T0);
    expect(out.estimate).toEqual({ offer_id: 11, gpu_name: "RTX A5000", dph: 0.3, horizon_hours: 3, max_cost: 0.3 * 3 });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect((await registry.active())?.agent_token).toBe(TOKEN);
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
    expect((await life.reconcile()).gone).toEqual([{ tailnet_hostname: HOST, reason: "vanished" }]);
    expect(await registry.active()).toBeNull();
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

  it("destroyUnknown refuses foreign labels and the active record", async () => {
    const { life, vast } = setup();
    await life.start();
    vast.instances.push(
      { id: 5, label: "vastcomfy", actual_status: "running", start_date: T0, dph_total: 0.4 },
      { id: 7, label: "someone-else", actual_status: "running", start_date: T0, dph_total: 0.4 },
    );
    await expect(life.destroyUnknown(7)).rejects.toThrow(/project label/);
    await expect(life.destroyUnknown(900)).rejects.toThrow(/active record/);
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
