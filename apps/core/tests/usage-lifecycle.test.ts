import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppsConfig } from "../src/config.js";
import type { AgentStatus } from "../src/agent.js";
import { Registry, type InstanceRecord, type NewRecord } from "../src/registry.js";
import { CreateRejected, DestroyError, type CreateRequest, type DestroyOutcome, type Offer, type VastInstance } from "../src/vast.js";
import { Lifecycle, type AgentLike } from "../src/lifecycle.js";
import { UsageHistory, UsageStore, usageFileCap } from "../src/usage.js";

const schema = fileURLToPath(new URL("../../../contracts/instance-registry.schema.json", import.meta.url));
const T0 = 1_800_000_000;
const TOKEN = "agenttoken-SECRET-0123456789abcdef";
const AUTH_KEY = "tskey-auth-SECRETKEY0123456789";
const HOST = "vast-abc123";
const ID = 900;
const GRACE_S = 600;

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
  vastAllowedGpus: ["RTX A5000"],
  comfyPort: 18188,
  startIdleMinutes: 30,
  startFailsafeHours: 3,
  startHardCapHours: 6,
  bootTimeoutMin: 25,
  vastStartStuckMin: 5,
  bootAgentGraceMin: 10,
  modelEtaMinObserveS: 120,
  bootMaxDownloadEtaMin: 20,
  bootMinDownloadMbS: 25,
  bootTimeoutMaxMin: 120,
  netProbeBytes: 25165824,
  netProbeMinMbps: 20,
  downloadConnections: 4,
  vastBadMachineTtlMin: 60,
  unreachableDestroyMin: 15,
  reconcileGraceMin: 10,
  webDestroyRetries: 1,
  webDestroyBackoffS: 0,
  usageLogMaxEntries: 50,
  usageReasonSlackS: 120,
  secretNames: [],
} as unknown as AppsConfig;

class FakeVast {
  instances: VastInstance[] = [];
  nextId = ID + 1;
  createImpl: ((req: CreateRequest) => Promise<{ id: number }>) | null = null;
  destroyQueue: (DestroyOutcome | Error)[] = [];
  offerOver: Record<string, unknown> = {};
  async searchOffers(): Promise<Offer[]> {
    return [{ id: 11, dph_total: 0.3, gpu_name: "RTX A5000", gpu_ram: 24564, ...this.offerOver }];
  }
  async createInstance(_offer: number, req: CreateRequest): Promise<{ id: number }> {
    if (this.createImpl) return this.createImpl(req);
    const id = this.nextId++;
    this.instances.push({ id, label: req.label, actual_status: "loading", start_date: T0, dph_total: 0.32 });
    return { id };
  }
  async listInstances(): Promise<VastInstance[]> {
    return this.instances.map((i) => ({ ...i }));
  }
  async destroyInstance(id: number): Promise<DestroyOutcome> {
    const next = this.destroyQueue.shift() ?? "destroyed";
    if (next instanceof Error) throw next;
    this.instances = this.instances.filter((i) => i.id !== id);
    return next;
  }
}

function status(state: string, over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    schema_version: 1, state, reason: null, progress: null, now: T0, boot_at: T0, uptime_s: 1,
    idle_destroy_at: T0 + 1800, failsafe_at: T0 + 3 * 3600, hard_cap_at: T0 + 6 * 3600,
    queue: { running: 0, pending: 0 }, gpu: {}, profile: "image", commit: "c", failsafe_alive: true,
    destroy: { pending: false, attempts: 0 }, ...over,
  };
}

/** A registry whose next begin() can be held at a gate (to race a Start against reads). */
class GatedRegistry extends Registry {
  beginGate: Promise<void> | null = null;
  /** Held after all() has read the file: the caller gets a snapshot older than the file. */
  allGate: Promise<void> | null = null;
  /** Held after markGone() wrote the file: the lifecycle has not reacted to the end yet. */
  markGoneGate: Promise<void> | null = null;
  markGoneReached: (() => void) | null = null;
  override async markGone(hostname: string): Promise<InstanceRecord> {
    const gone = await super.markGone(hostname);
    this.markGoneReached?.();
    if (this.markGoneGate) await this.markGoneGate;
    return gone;
  }
  override async all(): Promise<InstanceRecord[]> {
    const records = await super.all();
    if (this.allGate) await this.allGate;
    return records;
  }
  override async begin(record: NewRecord): Promise<InstanceRecord> {
    const created = await super.begin(record);
    if (this.beginGate) await this.beginGate;
    return created;
  }
}

interface H {
  lc: Lifecycle;
  vast: FakeVast;
  registry: GatedRegistry;
  usage: UsageHistory;
  clock: { t: number };
  agent: { status: () => Promise<AgentStatus>; destroys: string[] };
  dir: string;
  logs: string[];
}

function makeUsage(dir: string, logs: string[]): UsageHistory {
  return new UsageHistory({ maxEntries: 50, slackS: 120 }, new UsageStore(join(dir, "usage.json"), usageFileCap(50)), (l, m) => logs.push(`${l} ${m}`));
}

async function harness(opts: { active?: boolean; dir?: string; registered?: boolean } = {}): Promise<H> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "usage-lc-"));
  const registry = new GatedRegistry(join(dir, "registry.json"), schema);
  const vast = new FakeVast();
  const clock = { t: T0 };
  const logs: string[] = [];
  const agent = { status: async (): Promise<AgentStatus> => status("ready"), destroys: [] as string[] };
  const agentLike: AgentLike = {
    status: () => agent.status(),
    extend: async () => ({}),
    destroy: async (reason) => void agent.destroys.push(reason),
  };
  let n = 0;
  const usage = makeUsage(dir, logs);
  const lc = new Lifecycle({
    cfg,
    vast,
    registry,
    agentFor: () => agentLike,
    clock: () => clock.t,
    tsAuthKey: async () => AUTH_KEY,
    newToken: () => TOKEN,
    newHostname: () => `vast-new${n++}`,
    sleep: async () => undefined,
    usage,
  });
  if (opts.active === true) {
    await registry.begin({ created_at: T0, profile: "image", agent_token: TOKEN, tailnet_hostname: HOST });
    await registry.update(HOST, { status: "ready", vast_instance_id: ID, vast_start_date: T0 });
    vast.instances.push({ id: ID, label: `vastcomfy:${HOST}`, actual_status: "running", start_date: T0, dph_total: 0.3 });
  }
  return { lc, vast, registry, usage, clock, agent, dir, logs };
}

/** Run reconcile until the vanished instance is confirmed gone (grace + two misses). */
async function confirmVanished(h: H): Promise<void> {
  h.clock.t = Math.max(h.clock.t, T0 + GRACE_S);
  await h.lc.reconcile();
  await h.lc.reconcile();
}

describe("usage history through the lifecycle", () => {
  it("Start to Destroy button: who, GPU, price, ready time, duration and cost", async () => {
    const h = await harness();
    await h.lc.start(undefined, "root@example.com");
    h.clock.t = T0 + 120;
    await h.lc.view(); // agent says ready
    h.clock.t = T0 + 3600;
    await h.lc.destroy("ayu");
    const [e] = await h.lc.history();
    expect(e).toEqual({
      instance_id: ID + 1, gpu_name: "RTX A5000", dph: 0.32, started_at: T0, ready_at: T0 + 120, ended_at: T0 + 3600,
      duration_s: 3600, estimated_cost: expect.closeTo(0.32, 6), started_by: "root", reason: "destroy_button", stop_by: "ayu", active: false,
      location: null, down_mbps: null,
    });
    expect(h.logs).toContain("info usage: start gpu=RTX A5000 dph=0.300 by=root");
    expect(h.logs).toContain("info usage: stop reason=destroy_button duration_s=3600 by=ayu");
    for (const l of h.logs) expect(l).not.toMatch(/vast-new|example\.com|SECRET/);
  });

  it("the active session is listed with its running duration and the active flag", async () => {
    const h = await harness();
    await h.lc.start(undefined, "root");
    h.clock.t = T0 + 600;
    const [e] = await h.lc.history();
    expect(e).toMatchObject({ active: true, ended_at: null, reason: null, duration_s: 600 });
  });

  it("Start failures are boot_failed, with no cost", async () => {
    const h = await harness();
    h.vast.createImpl = async () => Promise.reject(new CreateRejected("no"));
    await expect(h.lc.start(undefined, "root")).rejects.toThrow();
    const [e] = await h.lc.history();
    expect(e).toMatchObject({ reason: "boot_failed", active: false, instance_id: null, estimated_cost: null, started_by: "root" });
  });

  it("a stuck start (the container never started) is boot_failed, stopped by the web", async () => {
    const h = await harness();
    await h.lc.start(undefined, "root");
    h.agent.status = async () => Promise.reject(new Error("unreachable"));
    Object.assign(h.vast.instances[0]!, { actual_status: "created", intended_status: "stopped", last_started: null });
    h.clock.t = T0 + 4 * 60;
    expect((await h.lc.reconcile()).destroyed).toEqual([]);
    h.clock.t = T0 + 5 * 60;
    expect((await h.lc.reconcile()).destroyed.map((d) => d.reason)).toEqual(["start_stuck"]);
    expect((await h.lc.history())[0]).toMatchObject({ reason: "boot_failed", active: false, ended_at: T0 + 5 * 60, stop_by: null });
    expect(h.logs).toContain("info usage: stop reason=boot_failed duration_s=300");
  });

  it("each session keeps where the server was and its download speed", async () => {
    const h = await harness();
    h.vast.offerOver = { geolocation: "Quebec, CA", inet_down: 860 };
    await h.lc.start(undefined, "root");
    expect((await h.lc.history())[0]).toMatchObject({ location: "Quebec, CA", down_mbps: 860 });
    Object.assign(h.vast.instances[0]!, { geolocation: "Montreal, CA", inet_down: 650 });
    await h.lc.view();
    expect((await h.lc.history())[0]).toMatchObject({ location: "Montreal, CA", down_mbps: 650 });
  });

  it("an ambiguous create that never shows up is boot_failed (never created)", async () => {
    const h = await harness();
    h.vast.createImpl = async () => Promise.reject(new Error("socket hang up"));
    await expect(h.lc.start(undefined, "root")).rejects.toThrow();
    expect((await h.lc.history())[0]).toMatchObject({ active: true });
    h.clock.t = T0 + GRACE_S;
    await h.lc.reconcile();
    expect((await h.lc.history())[0]).toMatchObject({ reason: "boot_failed", active: false });
  });

  it("Destroy while the create is still ambiguous: destroy_button (by the user) once reconcile links and destroys it", async () => {
    const h = await harness();
    let created: CreateRequest | null = null;
    h.vast.createImpl = async (req) => {
      created = req;
      return Promise.reject(new Error("timeout"));
    };
    await expect(h.lc.start(undefined, "root")).rejects.toThrow();
    expect((await h.lc.destroy("ayu")).outcome).toBe("pending");
    h.vast.instances.push({ id: 777, label: created!.label, actual_status: "running", start_date: T0, dph_total: 0.3 });
    h.clock.t = T0 + 60;
    await h.lc.reconcile();
    expect((await h.lc.history())[0]).toMatchObject({ reason: "destroy_button", stop_by: "ayu", instance_id: 777 });
  });

  it("web watchdog reasons: hard cap, boot timeout and an unreachable agent", async () => {
    const hard = await harness({ active: true });
    hard.usage.adopt(HOST, T0);
    hard.clock.t = T0 + 6 * 3600;
    await hard.lc.reconcile();
    expect((await hard.lc.history())[0]).toMatchObject({ reason: "hard_cap" });

    const boot = await harness({ active: true });
    await boot.registry.update(HOST, { status: "booting" });
    boot.agent.status = async () => status("downloading");
    boot.clock.t = T0 + 25 * 60;
    await boot.lc.reconcile();
    expect((await boot.lc.history())[0]).toMatchObject({ reason: "boot_failed" });

    const lost = await harness({ active: true });
    lost.agent.status = async () => Promise.reject(new Error("unreachable"));
    lost.clock.t = T0 + 60;
    await lost.lc.reconcile();
    lost.clock.t = T0 + 60 + 15 * 60;
    await lost.lc.reconcile();
    expect((await lost.lc.history())[0]).toMatchObject({ reason: "agent_unreachable" });
  });

  it("a failed web destroy keeps its reason through the retries (and across a web restart)", async () => {
    const h = await harness({ active: true });
    h.usage.adopt(HOST, T0);
    h.vast.destroyQueue.push(new DestroyError("boom"));
    h.clock.t = T0 + 6 * 3600;
    await h.lc.reconcile(); // hard cap: destroy fails, record stays stopping
    expect((await h.lc.history())[0]).toMatchObject({ active: true });
    const again = await harness({ dir: h.dir });
    again.vast.instances = h.vast.instances;
    again.clock.t = T0 + 6 * 3600 + 60;
    await again.lc.reconcile(); // destroy_retry succeeds
    expect((await again.lc.history())[0]).toMatchObject({ reason: "hard_cap", active: false });
  });

  it("the instance destroys itself on idle: the agent's stopping state names the reason", async () => {
    const h = await harness();
    await h.lc.start(undefined, "root");
    h.agent.status = async () => status("stopping", { reason: "idle_timeout" });
    h.clock.t = T0 + 1800;
    await h.lc.view();
    h.vast.instances = [];
    await confirmVanished(h);
    expect((await h.lc.history())[0]).toMatchObject({ reason: "idle_timeout", active: false });
  });

  it("the instance vanished after its failsafe deadline (seen only by reconcile): failsafe_deadline", async () => {
    const h = await harness();
    await h.lc.start(undefined, "root");
    h.agent.status = async () => status("ready", { idle_destroy_at: T0 + 9 * 3600, failsafe_at: T0 + 700 });
    await h.lc.reconcile();
    h.vast.instances = [];
    h.clock.t = T0 + 700;
    await confirmVanished(h);
    expect((await h.lc.history())[0]).toMatchObject({ reason: "failsafe_deadline", ended_at: T0 + 700 });
  });

  it("the instance vanished with no deadline passed: gone", async () => {
    const h = await harness();
    await h.lc.start(undefined, "root");
    await h.lc.view();
    h.vast.instances = [];
    await confirmVanished(h);
    expect((await h.lc.history())[0]).toMatchObject({ reason: "gone" });
  });

  it("a web restart mid-session keeps the active entry", async () => {
    const h = await harness();
    await h.lc.start(undefined, "root");
    await h.lc.view();
    const again = await harness({ dir: h.dir });
    again.vast.instances = h.vast.instances;
    again.clock.t = T0 + 500;
    await again.lc.view();
    const list = await again.lc.history();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ active: true, started_by: "root", duration_s: 500 });
  });

  it("an entry whose instance is gone at startup is closed with gone", async () => {
    const h = await harness();
    await h.lc.start(undefined, "root");
    // While the web was down the record went gone (e.g. reconcile of another process, or by hand).
    await h.registry.markGone("vast-new0");
    const again = await harness({ dir: h.dir });
    again.clock.t = T0 + 900;
    const [e] = await again.lc.history();
    expect(e).toMatchObject({ active: false, reason: "gone", ended_at: T0 + 900 });
  });

  it("an active registry record without an entry (older version) is adopted, started_by unknown", async () => {
    const h = await harness({ active: true });
    h.clock.t = T0 + 30;
    await h.lc.view();
    expect(await h.lc.history()).toEqual([expect.objectContaining({ active: true, started_at: T0, started_by: null, instance_id: ID })]);
  });

  it("race: a status read that saw no record must not close the entry of a Start that began meanwhile", async () => {
    const h = await harness();
    let open!: () => void;
    h.registry.beginGate = new Promise<void>((r) => (open = r));
    const viewing = h.lc.view(); // reads registry.active() before the Start writes
    const starting = h.lc.start(undefined, "root");
    const listing = h.lc.history();
    await new Promise((r) => setTimeout(r, 10));
    open();
    await starting;
    await viewing;
    await listing;
    await h.lc.view();
    const list = await h.lc.history();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ active: true, started_by: "root" });
  });

  it("race: a slow registry read that predates a Start never closes the new session", async () => {
    const h = await harness();
    await h.lc.start(undefined, "root");
    await h.registry.markGone("vast-new0"); // its entry is still open: the next read closes it
    let open!: () => void;
    h.registry.allGate = new Promise<void>((r) => (open = r));
    const listing = h.lc.history(); // reads the registry (without vast-new1), then waits
    await new Promise((r) => setTimeout(r, 10));
    h.registry.allGate = null;
    await h.lc.start(undefined, "ayu"); // vast-new1 begins while that read is held
    open();
    await listing;
    const list = await h.lc.history();
    expect(list.map((e) => [e.started_by, e.active])).toEqual([["ayu", true], ["root", false]]);
  });

  it("race: a reader that sees the record gone before the Destroy finishes still records destroy_button", async () => {
    const h = await harness();
    await h.lc.start(undefined, "root");
    await h.lc.view(); // a plain "ready" sighting: an inference would say gone
    let release!: () => void;
    h.registry.markGoneGate = new Promise<void>((r) => (release = r));
    const reached = new Promise<void>((r) => (h.registry.markGoneReached = r));
    const destroying = h.lc.destroy("ayu");
    await reached; // the registry says gone; the lifecycle has not ended the entry yet
    h.registry.markGoneGate = null;
    const [seen] = await h.lc.history(); // this reader closes the entry itself
    release();
    await destroying;
    expect(seen).toMatchObject({ reason: "destroy_button", stop_by: "ayu", active: false });
    expect((await h.lc.history())[0]).toMatchObject({ reason: "destroy_button", stop_by: "ayu" });
  });

  it("without a usage history the lifecycle works as before and lists nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-none-"));
    const registry = new Registry(join(dir, "registry.json"), schema);
    const lc = new Lifecycle({
      cfg, vast: new FakeVast(), registry, agentFor: () => ({ status: async () => status("ready"), extend: async () => ({}), destroy: async () => undefined }),
      clock: () => T0, tsAuthKey: async () => AUTH_KEY, newToken: () => TOKEN, newHostname: () => "vast-x", sleep: async () => undefined,
    });
    await lc.start(undefined, "root");
    await lc.destroy("root");
    expect(await lc.history()).toEqual([]);
  });
});
