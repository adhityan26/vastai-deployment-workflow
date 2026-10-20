import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppsConfig } from "../src/config.js";
import type { AgentStatus } from "../src/agent.js";
import { Registry, type InstanceRecord } from "../src/registry.js";
import { VastError, type CreateRequest, type DestroyOutcome, type Offer, type VastInstance } from "../src/vast.js";
import { ConsoleStore, consoleFileCap } from "../src/console.js";
import { Lifecycle, type AgentLike } from "../src/lifecycle.js";

const schema = fileURLToPath(new URL("../../../contracts/instance-registry.schema.json", import.meta.url));
const T0 = 1_800_000_000;
const TOKEN = "agenttoken-SECRET-0123456789abcdef";
const AUTH_KEY = "tskey-auth-SECRETKEY0123456789";
const VAST_KEY = "vastkey-SECRET-abcdefghijklmnop";
const HOST = "vast-abc123";
const ID = 900;

const cfg = {
  repoUrl: "https://example.invalid/repo.git", // config-lint: ok (test fixture)
  repoCommit: "deadbeef",
  profile: "image",
  vastApiKey: VAST_KEY,
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
  vastBadMachineTtlMin: 60,
  unreachableDestroyMin: 15,
  reconcileGraceMin: 10,
  webDestroyRetries: 1,
  webDestroyBackoffS: 0,
  bootLogMaxLines: 500,
  bootLogMaxLineChars: 400,
  bootLogPollMinS: 5,
  bootLogWatchS: 60,
  bootLogTailLines: 300,
  secretNames: ["VAST_API_KEY"],
} as unknown as AppsConfig;

class FakeVast {
  instances: VastInstance[] = [];
  lists = 0;
  logCalls: { id: number; tail: number }[] = [];
  logText = "";
  logError: Error | null = null;
  listError: Error | null = null;
  nextId = ID + 1;
  async searchOffers(): Promise<Offer[]> {
    return [{ id: 11, dph_total: 0.3, gpu_name: "RTX A5000", gpu_ram: 24564 }];
  }
  async createInstance(_offer: number, req: CreateRequest): Promise<{ id: number }> {
    const id = this.nextId++;
    this.instances.push({ id, label: req.label, actual_status: "loading", start_date: T0, dph_total: 0.3, status_msg: null });
    return { id };
  }
  async listInstances(): Promise<VastInstance[]> {
    this.lists++;
    if (this.listError) throw this.listError;
    return this.instances.map((i) => ({ ...i }));
  }
  async destroyInstance(id: number): Promise<DestroyOutcome> {
    this.instances = this.instances.filter((i) => i.id !== id);
    return "destroyed";
  }
  async instanceLogs(id: number, tail: number): Promise<string> {
    this.logCalls.push({ id, tail });
    if (this.logError) throw this.logError;
    return this.logText;
  }
}

function agentStatus(state: string): AgentStatus {
  return {
    schema_version: 1, state, reason: null, progress: null, now: T0, boot_at: T0, uptime_s: 1,
    idle_destroy_at: null, failsafe_at: null, hard_cap_at: null, queue: null, gpu: {}, profile: "image",
    commit: "deadbeef", failsafe_alive: true, destroy: { pending: false, attempts: 0 },
  };
}

interface H {
  lc: Lifecycle;
  vast: FakeVast;
  registry: Registry;
  clock: { t: number };
  agent: { status: () => Promise<AgentStatus> };
  path: string;
}

async function harness(opts: { active?: boolean; path?: string; status?: string; statusMsg?: string | null } = {}): Promise<H> {
  const dir = mkdtempSync(join(tmpdir(), "console-lc-"));
  const registry = new Registry(join(dir, "registry.json"), schema);
  const vast = new FakeVast();
  const clock = { t: T0 };
  const path = opts.path ?? join(dir, "boot-console.json");
  const agent = { status: async (): Promise<AgentStatus> => Promise.reject(new Error("unreachable")) };
  const agentLike: AgentLike = {
    status: () => agent.status(),
    extend: async () => ({}),
    destroy: async () => undefined,
  };
  let n = 0;
  const lc = new Lifecycle({
    cfg,
    vast,
    registry,
    agentFor: (_r: InstanceRecord) => agentLike,
    clock: () => clock.t,
    tsAuthKey: async () => AUTH_KEY,
    newToken: () => TOKEN,
    newHostname: () => (n++ === 0 ? "vast-next0" : `vast-next${n}`),
    sleep: async () => undefined,
    consoleStore: new ConsoleStore(path, consoleFileCap({ maxLines: 500, maxLineChars: 400, tailLines: 300 })),
  });
  if (opts.active !== false) {
    await registry.begin({ created_at: T0, profile: "image", agent_token: TOKEN, tailnet_hostname: HOST });
    await registry.update(HOST, { status: "booting", vast_instance_id: ID, vast_start_date: T0 });
    vast.instances.push({
      id: ID,
      label: `vastcomfy:${HOST}`,
      actual_status: opts.status ?? "running",
      start_date: T0,
      dph_total: 0.3,
      status_msg: opts.statusMsg ?? null,
    });
  }
  return { lc, vast, registry, clock, agent, path };
}

const texts = (p: { lines: { text: string }[] }) => p.lines.map((l) => l.text);

describe("Lifecycle.console", () => {
  it("returns masked container log lines with the payload shape", async () => {
    const h = await harness();
    h.vast.logText = `Cloning into '/opt/vast-comfy'...\nHEAD is now at 1a2b3c4 x\nAGENT ${TOKEN}\nkey ${VAST_KEY}\nup ${AUTH_KEY}\nhost ${HOST} joined\n`;
    const p = await h.lc.console(0);
    expect(Object.keys(p).sort()).toEqual(["generation", "instance", "last_seq", "lines", "phases", "source_error", "truncated"]);
    expect(p.instance).toEqual({ state: "booting", ended: false, ended_reason: null });
    expect(texts(p)).toEqual([
      "Cloning into '/opt/vast-comfy'...",
      "HEAD is now at 1a2b3c4 x",
      "AGENT [redacted]",
      "key [redacted]",
      "up tskey-[redacted]", // not a known secret here (no Start in this process): the generic pattern
      "host [host] joined",
    ]);
    const body = JSON.stringify(p);
    for (const secret of [TOKEN, VAST_KEY, HOST, "SECRETKEY"]) expect(body).not.toContain(secret);
    expect(p.lines.every((l) => l.source === "vast_logs" && l.t === T0)).toBe(true);
    expect(p.last_seq).toBe(6);
    expect(p.truncated).toBe(false);
    expect(p.source_error).toBeNull();
    expect(h.vast.logCalls).toEqual([{ id: ID, tail: 300 }]);
    // after: only newer lines.
    expect(texts(await h.lc.console(5))).toEqual(["host [host] joined"]);
  });

  it("a boot that gave up with the probe's slow_network marker shows slow_download with the probe's speed", async () => {
    const h = await harness();
    Object.assign(h.vast.instances[0]!, { machine_id: 555 });
    h.vast.logText = [
      "[boot] step 1/9: net_probe",
      "[boot] net_probe: measured 3.1 MB/s (minimum 20 MB/s)",
      "[boot] net_probe: measured 2.8 MB/s (minimum 20 MB/s)",
      "[boot] FAILED: slow_network",
      "",
    ].join("\n");
    await h.lc.console(0);
    h.clock.t = T0 + 9 * 60;
    await h.lc.reconcile(); // the last row seen names the machine
    h.vast.instances = [];
    h.clock.t = T0 + 10 * 60;
    expect((await h.lc.reconcile()).gone).toEqual([]);
    h.clock.t = T0 + 11 * 60;
    expect((await h.lc.reconcile()).gone).toEqual([{ tailnet_hostname: HOST, reason: "vanished" }]);
    const failure = (await h.lc.view()).start_failure;
    expect(failure).toMatchObject({ code: "slow_download", measured_mb_s: 2.8 });
    expect(failure?.server?.machine_id).toBe(555);
    expect((await h.lc.console(0)).instance).toMatchObject({ ended: true, ended_reason: "vanished" });
  });

  it("another FAILED code after the probe is a plain boot_failed", async () => {
    const h = await harness();
    h.vast.logText = "[boot] net_probe: measured 2.8 MB/s (minimum 20 MB/s)\n[boot] step 4/9: tailscale\n[boot] FAILED: tailscale_failed\n";
    await h.lc.console(0);
    h.vast.instances = [];
    h.clock.t = T0 + 10 * 60;
    await h.lc.reconcile();
    h.clock.t = T0 + 11 * 60;
    await h.lc.reconcile();
    expect((await h.lc.view()).start_failure).toMatchObject({ code: "boot_failed", measured_mb_s: null });
  });

  it("reads Vast at most once per BOOT_LOG_POLL_MIN_S", async () => {
    const h = await harness();
    h.vast.logText = "a\n";
    await h.lc.console(0);
    h.clock.t = T0 + 4;
    await h.lc.console(0);
    expect(h.vast.logCalls).toHaveLength(1);
    expect(h.vast.lists).toBe(1);
    h.clock.t = T0 + 5;
    h.vast.logText = "a\nb\n";
    expect(texts(await h.lc.console(0))).toEqual(["a", "b"]);
    expect(h.vast.logCalls).toHaveLength(2);
  });

  it("concurrent calls share one Vast read", async () => {
    const h = await harness();
    h.vast.logText = "a\n";
    await Promise.all([h.lc.console(0), h.lc.console(0), h.lc.console(0)]);
    expect(h.vast.logCalls).toHaveLength(1);
  });

  it("the status poll reads Vast logs only while an admin watches the console", async () => {
    const h = await harness();
    h.vast.logText = "a\n";
    // Nobody has called console(): view() polls never ask for logs.
    await h.lc.view();
    await h.lc.flushConsole();
    h.clock.t += 10;
    await h.lc.view();
    await h.lc.flushConsole();
    expect(h.vast.logCalls).toHaveLength(0);
    // An admin watches: the status poll keeps the log fresh (rate rule still applies).
    await h.lc.console(0);
    expect(h.vast.logCalls).toHaveLength(1);
    h.clock.t += 10;
    h.vast.logText = "a\nb\n";
    await h.lc.view();
    await h.lc.flushConsole();
    expect(h.vast.logCalls).toHaveLength(2);
    h.clock.t += 1;
    await h.lc.view();
    await h.lc.flushConsole();
    expect(h.vast.logCalls).toHaveLength(2);
    // The admin left: past BOOT_LOG_WATCH_S nothing more is requested.
    h.clock.t += 61;
    await h.lc.view();
    await h.lc.flushConsole();
    expect(h.vast.logCalls).toHaveLength(2);
    expect(texts(await h.lc.console(0))).toEqual(["a", "b"]);
  });

  it("shows the docker pull from status_msg while loading and asks for no container log", async () => {
    const h = await harness({ status: "loading", statusMsg: "2fcf58654f0c: Verifying Checksum\n2fcf58654f0c: Download complete" });
    const p = await h.lc.console(0);
    expect(p.lines.map((l) => [l.source, l.text])).toEqual([
      ["vast_status", "2fcf58654f0c: Verifying Checksum"],
      ["vast_status", "2fcf58654f0c: Download complete"],
    ]);
    expect(p.phases[0]).toEqual({ id: "image_pull", name: "Pull image", status: "running" });
    expect(h.vast.logCalls).toHaveLength(0);
  });

  it("derives the phases from the markers, including a failed phase", async () => {
    const h = await harness();
    h.vast.logText = "[boot] step 1/8: install_tools\n[boot] step 2/8: failsafe\n[boot] step 3/8: tailscale\n[boot] FAILED: tailscale_up\n";
    const p = await h.lc.console(0);
    expect(Object.fromEntries(p.phases.map((x) => [x.id, x.status]))).toEqual({
      image_pull: "done",
      install_tools: "done",
      failsafe: "done",
      tailscale: "failed",
      agent: "pending",
      nodes: "pending",
      models: "pending",
      comfyui: "pending",
      ready: "pending",
    });
  });

  it("adds agent summaries from the status view", async () => {
    const h = await harness();
    h.agent.status = async () => ({ ...agentStatus("downloading"), progress: { phase: "models", file: "models/x.safetensors", bytes_done: 55, bytes_total: 100 } });
    await h.lc.view();
    await h.lc.view();
    const p = await h.lc.console(0);
    expect(p.lines.filter((l) => l.source === "agent").map((l) => l.text)).toEqual([
      "agent: state=downloading phase=models file=x.safetensors 50%",
    ]);
  });

  it("degrades to source_error when Vast fails, keeping the lines", async () => {
    const h = await harness();
    h.vast.logText = "kept\n";
    await h.lc.console(0);
    h.clock.t += 5;
    h.vast.logError = new VastError(`request logs failed with HTTP 500: ${VAST_KEY}`);
    const p = await h.lc.console(0);
    expect(p.source_error).toBe("vast_logs_unavailable");
    expect(texts(p)).toEqual(["kept"]);
    expect(JSON.stringify(p)).not.toContain(VAST_KEY);
    h.clock.t += 5;
    h.vast.logError = null;
    h.vast.listError = new Error("network down");
    expect((await h.lc.console(0)).source_error).toBe("vast_logs_unavailable");
    h.clock.t += 5;
    h.vast.listError = null;
    expect((await h.lc.console(0)).source_error).toBeNull();
  });

  it("keeps the lines after the instance ends, then a new Start clears them", async () => {
    const h = await harness();
    h.vast.logText = "[boot] step 1/8: install_tools\nlast words\n";
    const before = await h.lc.console(0);
    await h.lc.destroy();
    h.clock.t += 5;
    const calls = h.vast.logCalls.length;
    const ended = await h.lc.console(0);
    expect(ended.instance).toEqual({ state: "none", ended: true, ended_reason: "destroyed" });
    expect(texts(ended)).toEqual(["[boot] step 1/8: install_tools", "last words"]);
    expect(ended.phases).toEqual(before.phases);
    expect(ended.source_error).toBeNull();
    expect(h.vast.logCalls).toHaveLength(calls);

    h.vast.logText = "";
    await h.lc.start();
    const fresh = await h.lc.console(0);
    expect(fresh.generation).toBe(ended.generation + 1);
    expect(fresh.instance.ended).toBe(false);
    expect(fresh.lines).toEqual([]);
    expect(fresh.phases.every((x) => x.status === "pending" || x.id === "image_pull")).toBe(true);
    // Sequence numbers keep counting across the clear.
    h.clock.t += 5;
    h.vast.instances[0]!.actual_status = "running";
    h.vast.logText = "new boot\n";
    const next = await h.lc.console(ended.last_seq);
    expect(next.lines.map((l) => [l.seq, l.text])).toEqual([[ended.last_seq + 1, "new boot"]]);
  });

  it("ends with reason gone when the record disappears outside the lifecycle", async () => {
    const h = await harness();
    h.vast.logText = "x\n";
    await h.lc.console(0);
    await h.registry.markGone(HOST);
    const p = await h.lc.console(0);
    expect(p.instance).toEqual({ state: "none", ended: true, ended_reason: "gone" });
    expect(texts(p)).toEqual(["x"]);
  });

  it("ends with the reconcile reason when the instance vanishes", async () => {
    const h = await harness();
    h.vast.logText = "x\n";
    await h.lc.console(0);
    h.vast.instances = [];
    h.clock.t = T0 + 11 * 60;
    await h.lc.reconcile();
    await h.lc.reconcile();
    const p = await h.lc.console(0);
    expect(p.instance).toEqual({ state: "none", ended: true, ended_reason: "vanished" });
  });

  it("a failed Start keeps its console with reason start_failed", async () => {
    const h = await harness({ active: false });
    h.vast.searchOffers = async () => [];
    await expect(h.lc.start()).rejects.toThrow();
    const p = await h.lc.console(0);
    expect(p.instance).toEqual({ state: "none", ended: true, ended_reason: "start_failed" });
  });

  it("persists across a restart and ignores a corrupt file", async () => {
    const h = await harness();
    h.vast.logText = "persisted line\n";
    await h.lc.console(0);
    const again = await harness({ path: h.path });
    again.vast.logError = new Error("down");
    const restored = await again.lc.console(0);
    expect(texts(restored)).toEqual(["persisted line"]);

    writeFileSync(h.path, "{corrupt");
    const fresh = await harness({ path: h.path });
    fresh.vast.logText = "";
    const p = await fresh.lc.console(0);
    expect(p.lines).toEqual([]);
    expect(p.instance.ended).toBe(false);
  });

  it("masks a secret split across the tail overlap boundary", async () => {
    const h = await harness();
    h.vast.logText = `start\nexport X=${TOKEN.slice(0, 14)}`;
    await h.lc.console(0);
    h.clock.t += 5;
    h.vast.logText = `start\nexport X=${TOKEN}\n`;
    const p = await h.lc.console(0);
    expect(texts(p)).toEqual(["start", "export X=[redacted]"]);
    for (let k = 6; k <= TOKEN.length; k++) expect(JSON.stringify(p)).not.toContain(TOKEN.slice(0, k));
  });

  /** The next registry.active() reads now but answers only after `release()` (a request in flight). */
  function holdNextActive(registry: Registry): { release: () => void; reached: Promise<void> } {
    const original = registry.active.bind(registry);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const reachedP = new Promise<void>((r) => (reached = r));
    registry.active = async () => {
      registry.active = original;
      const value = await original();
      reached();
      await gate;
      return value;
    };
    return { release, reached: reachedP };
  }

  it("a view in flight across start() neither ends nor clears the new boot's console", async () => {
    const h = await harness({ active: false });
    const held = holdNextActive(h.registry);
    const view = h.lc.view(); // reads "no active record", then waits
    await held.reached;
    await h.lc.start();
    const fresh = await h.lc.console(0);
    held.release();
    await view;
    await h.lc.flushConsole();
    const p = await h.lc.console(0);
    expect(p.generation).toBe(fresh.generation);
    expect(p.instance.ended).toBe(false);
    expect(p.instance.ended_reason).toBeNull();
  });

  it("a console call in flight across destroy+Start does not wipe the new console", async () => {
    const h = await harness();
    h.vast.logText = "old boot\n";
    await h.lc.console(0);
    const held = holdNextActive(h.registry);
    h.clock.t += 5;
    const pending = h.lc.console(0); // reads the OLD record, then waits
    await held.reached;
    await h.lc.destroy();
    await h.lc.start();
    h.vast.instances[h.vast.instances.length - 1]!.actual_status = "running";
    h.vast.logText = "new boot\n";
    h.clock.t += 5;
    const fresh = await h.lc.console(0);
    expect(texts(fresh)).toEqual(["new boot"]);
    held.release();
    const stale = await pending;
    expect(stale.generation).toBe(fresh.generation);
    expect(stale.instance.ended).toBe(false);
    const p = await h.lc.console(0);
    expect(p.generation).toBe(fresh.generation);
    expect(texts(p)).toEqual(["new boot"]);
    expect(p.instance.ended).toBe(false);
  });

  it("validates after", async () => {
    const h = await harness();
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) await expect(h.lc.console(bad)).rejects.toThrow(RangeError);
    expect(h.vast.logCalls).toHaveLength(0);
  });
});
