import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStatus } from "../src/agent.js";
import type { AppsConfig } from "../src/config.js";
import {
  STOP_REASONS,
  UsageHistory,
  UsageStore,
  inferStop,
  observationOf,
  usageFileCap,
  usageLimits,
  userLabel,
  type AgentObservation,
} from "../src/usage.js";

const T0 = 1_800_000_000;
const SLACK = 120;
const LIMITS = { maxEntries: 5, slackS: SLACK };

function obs(over: Partial<AgentObservation> = {}): AgentObservation {
  return {
    seen_at: T0,
    state: "ready",
    reason: null,
    idle_destroy_at: T0 + 1800,
    failsafe_at: T0 + 3 * 3600,
    hard_cap_at: T0 + 6 * 3600,
    destroy_pending: false,
    ...over,
  };
}

function status(state: string, over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    schema_version: 1, state, reason: null, progress: null, now: T0, boot_at: T0, uptime_s: 1,
    idle_destroy_at: T0 + 1800, failsafe_at: T0 + 3 * 3600, hard_cap_at: T0 + 6 * 3600,
    queue: { running: 0, pending: 0 }, gpu: {}, profile: "image", commit: "c", failsafe_alive: true,
    destroy: { pending: false, attempts: 0, last_error: null }, ...over,
  };
}

const dir = () => mkdtempSync(join(tmpdir(), "usage-"));

describe("inferStop: the reason of an instance that disappeared by itself", () => {
  it("no agent status ever seen: gone, ended when detected", () => {
    expect(inferStop(null, T0 + 50, SLACK)).toEqual({ reason: "gone", ended_at: T0 + 50 });
  });

  it("the agent said it was destroying itself: its exact reason wins over the deadlines", () => {
    const cases: [string, string | null, string][] = [
      ["stopping", "idle_timeout", "idle_timeout"],
      ["stopping", "failsafe_deadline", "failsafe_deadline"],
      ["stopping", "hard_cap", "hard_cap"],
      ["destroy_failed", "idle_timeout", "idle_timeout"],
      ["stopping", "manual", "destroy_button"],
      ["stopping", "download_failed", "boot_failed"],
      ["stopping", "tailscale_failed", "boot_failed"],
      ["stopping", "boot_failed", "boot_failed"],
      ["failed", "node_install_failed", "boot_failed"],
      ["failed", null, "boot_failed"],
    ];
    for (const [state, reason, want] of cases) {
      // The hard cap has passed too: the agent's own word still decides.
      const o = obs({ state, reason, hard_cap_at: T0 - 10 });
      expect(inferStop(o, T0 + 60, SLACK).reason, `${state}/${reason}`).toBe(want);
    }
  });

  it("a passed deadline is the reason; the earliest passed one wins", () => {
    expect(inferStop(obs({ idle_destroy_at: T0 + 10 }), T0 + 60, SLACK).reason).toBe("idle_timeout");
    expect(inferStop(obs({ idle_destroy_at: T0 + 50, failsafe_at: T0 + 20 }), T0 + 60, SLACK).reason).toBe("failsafe_deadline");
    expect(inferStop(obs({ idle_destroy_at: T0 + 50, failsafe_at: T0 + 40, hard_cap_at: T0 + 30 }), T0 + 60, SLACK).reason).toBe("hard_cap");
    // The failsafe deadline equals the hard cap: the hard cap fired.
    expect(inferStop(obs({ idle_destroy_at: null, failsafe_at: T0 + 30, hard_cap_at: T0 + 30 }), T0 + 60, SLACK).reason).toBe("hard_cap");
  });

  it("slack boundary: a deadline up to slack seconds after detection counts, one second more does not", () => {
    const at = T0 + 1000;
    expect(inferStop(obs({ idle_destroy_at: at }), at - SLACK, SLACK).reason).toBe("idle_timeout");
    expect(inferStop(obs({ idle_destroy_at: at }), at - SLACK - 1, SLACK).reason).toBe("gone");
    expect(inferStop(obs({ idle_destroy_at: at }), at - 1, 0).reason).toBe("gone");
    expect(inferStop(obs({ idle_destroy_at: at }), at, 0).reason).toBe("idle_timeout");
  });

  it("no deadline passed and no destroy state: gone (e.g. Vast removed it)", () => {
    expect(inferStop(obs(), T0 + 60, SLACK).reason).toBe("gone");
    expect(inferStop(obs({ state: "stopping", reason: "watchdog" }), T0 + 60, SLACK).reason).toBe("gone");
    expect(inferStop(obs({ state: "stopping", reason: "something_new" }), T0 + 60, SLACK).reason).toBe("gone");
    expect(inferStop(obs({ idle_destroy_at: null, failsafe_at: null, hard_cap_at: null }), T0 + 60, SLACK).reason).toBe("gone");
  });

  it("the failsafe was destroying (pending) before its deadline by our clock: failsafe_deadline", () => {
    expect(inferStop(obs({ destroy_pending: true }), T0 + 60, SLACK).reason).toBe("failsafe_deadline");
  });

  it("a deadline end is dated at the deadline, never before the last sighting nor after detection", () => {
    expect(inferStop(obs({ seen_at: T0, idle_destroy_at: T0 + 10 }), T0 + 5000, SLACK).ended_at).toBe(T0 + 10);
    expect(inferStop(obs({ seen_at: T0 + 30, idle_destroy_at: T0 + 10 }), T0 + 5000, SLACK).ended_at).toBe(T0 + 30);
    expect(inferStop(obs({ seen_at: T0, idle_destroy_at: T0 + 100 }), T0 + 50, SLACK).ended_at).toBe(T0 + 50);
  });

  it("an end by the agent's own reason or an unknown one is dated at the last sighting, never after detection", () => {
    expect(inferStop(obs({ seen_at: T0 + 30, state: "stopping", reason: "idle_timeout" }), T0 + 500, SLACK)).toEqual({ reason: "idle_timeout", ended_at: T0 + 30 });
    expect(inferStop(obs({ seen_at: T0 + 30 }), T0 + 500, SLACK)).toEqual({ reason: "gone", ended_at: T0 + 30 });
    expect(inferStop(obs({ seen_at: T0 + 30, destroy_pending: true }), T0 + 500, SLACK)).toEqual({ reason: "failsafe_deadline", ended_at: T0 + 30 });
    // A sighting dated after the detection (clock skew) is clamped to the detection.
    expect(inferStop(obs({ seen_at: T0 + 900 }), T0 + 500, SLACK).ended_at).toBe(T0 + 500);
  });

  it("observationOf keeps only what the inference needs", () => {
    const o = observationOf(status("stopping", { reason: "idle_timeout", destroy: { pending: true, attempts: 1 } }), T0 + 7);
    expect(o).toEqual({
      seen_at: T0 + 7, state: "stopping", reason: "idle_timeout", idle_destroy_at: T0 + 1800,
      failsafe_at: T0 + 3 * 3600, hard_cap_at: T0 + 6 * 3600, destroy_pending: true,
    });
  });
});

describe("userLabel", () => {
  it("keeps a plain user name, never an email address or odd characters", () => {
    expect(userLabel("root")).toBe("root");
    expect(userLabel("ayu.s")).toBe("ayu.s");
    expect(userLabel("someone@example.com")).toBe("someone");
    expect(userLabel("<b>x</b>")).toBe("bxb");
    expect(userLabel("x".repeat(100))).toBe("x".repeat(64));
    expect(userLabel("")).toBeNull();
    expect(userLabel("@example.com")).toBeNull();
    expect(userLabel(null)).toBeNull();
  });
});

describe("UsageHistory", () => {
  it("records a session from Start to the Destroy button, with who did what", () => {
    const logs: string[] = [];
    const h = new UsageHistory(LIMITS, null, (level, m) => logs.push(`${level} ${m}`));
    h.begin("vast-a", T0, "root@example.com");
    h.noteOffer("vast-a", "RTX A5000", 0.3);
    h.noteInstance("vast-a", 900);
    h.noteReady("vast-a", T0 + 300);
    h.noteReady("vast-a", T0 + 400); // the first time counts
    const live = h.list(T0 + 600);
    expect(live).toEqual([
      {
        instance_id: 900, gpu_name: "RTX A5000", dph: 0.3, started_at: T0, ready_at: T0 + 300, ended_at: null,
        duration_s: 600, estimated_cost: 0.05, started_by: "root", reason: null, stop_by: null, active: true,
        location: null, down_mbps: null,
      },
    ]);
    h.requestStop("vast-a", "destroy_button", "ayu");
    h.end("vast-a", T0 + 3600);
    const [done] = h.list(T0 + 9999);
    expect(done).toMatchObject({ ended_at: T0 + 3600, duration_s: 3600, reason: "destroy_button", stop_by: "ayu", active: false });
    expect(done!.estimated_cost).toBeCloseTo(0.3);
    expect(logs).toEqual(["info usage: start gpu=RTX A5000 dph=0.300 by=root", "info usage: stop reason=destroy_button duration_s=3600 by=ayu"]);
    expect(logs.join("\n")).not.toContain("vast-a");
  });

  it("the first stop request wins; a later end without a request infers from the agent", () => {
    const h = new UsageHistory(LIMITS, null);
    h.begin("vast-a", T0, "root");
    h.noteInstance("vast-a", 1);
    h.requestStop("vast-a", "hard_cap", null);
    h.requestStop("vast-a", "destroy_button", "root");
    h.end("vast-a", T0 + 10);
    expect(h.list(T0 + 10)[0]).toMatchObject({ reason: "hard_cap", stop_by: null });

    h.begin("vast-b", T0 + 20, "root");
    h.noteInstance("vast-b", 2);
    h.observe("vast-b", status("stopping", { reason: "idle_timeout" }), T0 + 30);
    h.end("vast-b", T0 + 40);
    expect(h.list(T0 + 40)[0]).toMatchObject({ reason: "idle_timeout", stop_by: null });
  });

  it("end and observe are no-ops on an ended or unknown entry", () => {
    const h = new UsageHistory(LIMITS, null);
    h.begin("vast-a", T0, null);
    h.requestStop("vast-a", "boot_failed", null);
    h.end("vast-a", T0 + 5);
    h.observe("vast-a", status("stopping", { reason: "idle_timeout" }), T0 + 6);
    h.requestStop("vast-a", "destroy_button", "x");
    h.end("vast-a", T0 + 100);
    h.end("vast-zzz", T0 + 100);
    expect(h.list(T0 + 200)).toEqual([
      expect.objectContaining({ reason: "boot_failed", ended_at: T0 + 5, duration_s: 5, estimated_cost: null, instance_id: null }),
    ]);
  });

  it("lists the newest first and evicts the oldest ended entries beyond the bound", () => {
    const h = new UsageHistory({ maxEntries: 3, slackS: SLACK }, null);
    for (let i = 0; i < 5; i++) {
      h.begin(`vast-${i}`, T0 + i * 100, null);
      if (i < 4) h.end(`vast-${i}`, T0 + i * 100 + 10);
    }
    const list = h.list(T0 + 1000);
    expect(list.map((e) => e.started_at)).toEqual([T0 + 400, T0 + 300, T0 + 200]);
    expect(list.map((e) => e.active)).toEqual([true, false, false]);
  });

  it("a Start while another entry is still open closes that one first (one active entry at most)", () => {
    const h = new UsageHistory(LIMITS, null);
    h.begin("vast-a", T0, null);
    h.begin("vast-b", T0 + 50, null);
    const [b, a] = h.list(T0 + 60);
    expect(b).toMatchObject({ active: true });
    expect(a).toMatchObject({ active: false, reason: "gone", ended_at: T0 + 50 });
    expect(h.openHostnames()).toEqual(["vast-b"]);
  });

  it("begin on an adopted entry only fills in who started it", () => {
    const h = new UsageHistory(LIMITS, null);
    h.adopt("vast-a", T0);
    h.adopt("vast-a", T0 + 99);
    h.begin("vast-a", T0 + 5, "root");
    expect(h.list(T0 + 10)).toEqual([expect.objectContaining({ started_at: T0, started_by: "root", active: true })]);
  });

  it("logs a start line for a Start that failed before the Vast create, so every stop has a start", () => {
    const logs: string[] = [];
    const h = new UsageHistory(LIMITS, null, (level, m) => logs.push(`${level} ${m}`));
    h.begin("vast-a", T0, "root");
    h.noteOffer("vast-a", "RTX A5000", 0.3);
    h.requestStop("vast-a", "boot_failed");
    h.end("vast-a", T0 + 3);
    expect(logs).toEqual(["info usage: start gpu=RTX A5000 dph=0.300 by=root", "info usage: stop reason=boot_failed duration_s=3"]);
  });

  it("ignores hostile numbers and keeps gpu names short and plain", () => {
    const h = new UsageHistory(LIMITS, null);
    h.begin("vast-a", T0, null);
    h.noteOffer("vast-a", "<script>alert(1)</script>" + "x".repeat(100), Number.NaN);
    h.noteDph("vast-a", -1);
    h.noteDph("vast-a", Number.POSITIVE_INFINITY);
    const [e] = h.list(T0);
    expect(e!.dph).toBeNull();
    expect(e!.gpu_name).not.toMatch(/[<>]/);
    expect(e!.gpu_name!.length).toBeLessThanOrEqual(64);
    h.noteDph("vast-a", 0.42);
    expect(h.list(T0)[0]!.dph).toBe(0.42);
  });
});

describe("UsageHistory persistence", () => {
  function counting() {
    let saved: unknown = null;
    const store = { saves: 0, load: () => saved, save: (v: unknown) => { store.saves++; saved = structuredClone(v); } };
    return store;
  }

  it("saves an agent sighting only when the state or reason changes or a deadline moves earlier or by more than the slack", () => {
    const store = counting();
    const h = new UsageHistory(LIMITS, store);
    h.begin("vast-a", T0, null);
    h.observe("vast-a", status("ready"), T0); // first sighting
    const base = store.saves;
    // Busy queue: the idle deadline moves a little on every poll.
    for (let i = 1; i <= 10; i++) h.observe("vast-a", status("ready", { idle_destroy_at: T0 + 1800 + i * 10 }), T0 + i * 10);
    expect(store.saves).toBe(base + 0);
    h.observe("vast-a", status("ready", { idle_destroy_at: T0 + 1800 + SLACK + 1 }), T0 + 200); // beyond the slack
    expect(store.saves).toBe(base + 1);
    h.observe("vast-a", status("ready", { idle_destroy_at: T0 + 1800 + SLACK }), T0 + 210); // earlier: always saved
    expect(store.saves).toBe(base + 2);
    h.observe("vast-a", status("idle-warning", { idle_destroy_at: T0 + 1800 + SLACK }), T0 + 220);
    expect(store.saves).toBe(base + 3);
    h.observe("vast-a", status("idle-warning", { idle_destroy_at: null }), T0 + 230);
    expect(store.saves).toBe(base + 4);
  });

  it("a saved sighting that may be stale (by up to the slack) never names a deadline the exact rule would refuse", () => {
    const path = join(dir(), "usage.json");
    const D = T0 + 1800;
    const h = new UsageHistory(LIMITS, new UsageStore(path, 1 << 20));
    h.begin("vast-a", T0, null);
    h.observe("vast-a", status("ready", { idle_destroy_at: D }), T0); // saved
    h.observe("vast-a", status("ready", { idle_destroy_at: D + SLACK }), T0 + 60); // in memory only
    // In the same process the exact (in-memory) deadline is used with the slack.
    const det = D - SLACK / 2; // D + SLACK > det + SLACK: the exact rule says the deadline had not passed
    expect(inferStop(observationOf(status("ready", { idle_destroy_at: D + SLACK }), T0 + 60), det, SLACK).reason).toBe("gone");
    // After a restart only the saved (possibly stale) copy exists: no slack, so no wrong idle_timeout.
    const again = new UsageHistory(LIMITS, new UsageStore(path, 1 << 20));
    again.end("vast-a", det);
    expect(again.list(det)[0]!.reason).toBe("gone");
    // A deadline the stale copy shows as passed has passed for the exact rule too.
    const third = new UsageHistory(LIMITS, new UsageStore(join(dir(), "u.json"), 1 << 20));
    third.begin("vast-b", T0, null);
    third.observe("vast-b", status("ready", { idle_destroy_at: D }), T0);
    third.end("vast-b", det);
    // Same process, exact deadline: D - det = SLACK / 2 lies within the slack, so it counts.
    expect(third.list(det)[0]!.reason).toBe("idle_timeout");
  });

  it("round trips through the file, including the open entry and the last agent sighting", () => {
    const path = join(dir(), "usage.json");
    const store = new UsageStore(path, usageFileCap(LIMITS.maxEntries));
    const h = new UsageHistory(LIMITS, store);
    h.begin("vast-a", T0, "root");
    h.noteOffer("vast-a", "RTX A5000", 0.3);
    h.noteInstance("vast-a", 900);
    h.requestStop("vast-a", "destroy_button", "root");
    h.end("vast-a", T0 + 100);
    h.begin("vast-b", T0 + 200, "ayu");
    h.noteInstance("vast-b", 901);
    h.observe("vast-b", status("ready", { idle_destroy_at: T0 + 250 }), T0 + 210);

    const again = new UsageHistory(LIMITS, new UsageStore(path, usageFileCap(LIMITS.maxEntries)));
    expect(again.list(T0 + 300)).toEqual(h.list(T0 + 300));
    expect(again.openHostnames()).toEqual(["vast-b"]);
    // The persisted sighting still drives the inference after a restart.
    again.end("vast-b", T0 + 400);
    expect(again.list(T0 + 400)[0]).toMatchObject({ reason: "idle_timeout", ended_at: T0 + 250 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("a corrupt or foreign file starts empty; invalid entries are dropped one by one", () => {
    const d = dir();
    for (const body of ["{not json", "[]", '{"version":2,"entries":[]}', '{"version":1,"entries":{}}', "null"]) {
      const path = join(d, `f${Math.random()}.json`);
      writeFileSync(path, body);
      expect(new UsageHistory(LIMITS, new UsageStore(path, 1 << 20)).list(T0), body).toEqual([]);
    }
    const path = join(d, "mixed.json");
    const h = new UsageHistory(LIMITS, new UsageStore(path, 1 << 20));
    h.begin("vast-a", T0, "root");
    h.end("vast-a", T0 + 10);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    saved.entries.push({ ...saved.entries[0], hostname: "vast-b", reason: "made_up" });
    saved.entries.push({ ...saved.entries[0], hostname: "vast-c", started_at: "soon" });
    saved.entries.push({ ...saved.entries[0], hostname: "vast-d", extra: 1 });
    writeFileSync(path, JSON.stringify(saved));
    const again = new UsageHistory(LIMITS, new UsageStore(path, 1 << 20));
    expect(again.list(T0 + 20)).toHaveLength(1);
  });

  it("a deadline change that swaps the order of the deadlines is saved: the restart names the true earliest", () => {
    const path = join(dir(), "order.json");
    const H = T0 + 3600;
    const h = new UsageHistory(LIMITS, new UsageStore(path, 1 << 20));
    h.begin("vast-a", T0, null);
    h.observe("vast-a", status("ready", { idle_destroy_at: H - 60, failsafe_at: H + 999, hard_cap_at: H }), T0);
    // Moved later by exactly the slack (not more), but now after the hard cap.
    h.observe("vast-a", status("ready", { idle_destroy_at: H + 60, failsafe_at: H + 999, hard_cap_at: H }), T0 + 10);
    const again = new UsageHistory(LIMITS, new UsageStore(path, 1 << 20));
    again.end("vast-a", H + 30);
    expect(again.list(H + 30)[0]).toMatchObject({ reason: "hard_cap", ended_at: H });
  });

  it("the last sighting is saved about once per slack window, so a restart dates a gone end close to it", () => {
    const path = join(dir(), "seen.json");
    const h = new UsageHistory(LIMITS, new UsageStore(path, 1 << 20));
    h.begin("vast-a", T0, null);
    const last = T0 + 1000;
    for (let t = T0; t <= last; t += 10) h.observe("vast-a", status("ready", { idle_destroy_at: T0 + 9000 }), t);
    const again = new UsageHistory(LIMITS, new UsageStore(path, 1 << 20));
    again.end("vast-a", T0 + 5000);
    const [e] = again.list(T0 + 5000);
    expect(e!.reason).toBe("gone");
    expect(e!.ended_at!).toBeLessThanOrEqual(last);
    expect(last - e!.ended_at!).toBeLessThanOrEqual(SLACK);
  });

  it("a tampered file cannot smuggle odd characters into the names: those values are dropped", () => {
    const path = join(dir(), "tampered.json");
    const h = new UsageHistory(LIMITS, new UsageStore(path, 1 << 20));
    h.begin("vast-a", T0, "root");
    h.noteOffer("vast-a", "RTX A5000", 0.3);
    h.requestStop("vast-a", "destroy_button", "ayu");
    h.end("vast-a", T0 + 10);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    Object.assign(saved.entries[0], { started_by: "<img src=x>", stop_by: "a@b.c", gpu_name: "RTX\u0000<b>" });
    writeFileSync(path, JSON.stringify(saved));
    const [e] = new UsageHistory(LIMITS, new UsageStore(path, 1 << 20)).list(T0 + 20);
    expect(e).toMatchObject({ started_by: null, stop_by: null, gpu_name: null, reason: "destroy_button", dph: 0.3 });
  });

  it("a save failure never breaks the history (it stays in memory)", () => {
    const h = new UsageHistory(LIMITS, { load: () => null, save: () => { throw new Error("disk full"); } });
    h.begin("vast-a", T0, "root");
    expect(h.list(T0)).toHaveLength(1);
  });

  it("an oversized file is ignored, and the file cap holds for full entries", () => {
    const path = join(dir(), "big.json");
    writeFileSync(path, JSON.stringify({ version: 1, entries: [] }) + " ".repeat(5000));
    expect(new UsageStore(path, 1000).load()).toBeNull();
    const full = join(dir(), "full.json");
    const store = new UsageStore(full, usageFileCap(LIMITS.maxEntries));
    const h = new UsageHistory(LIMITS, store);
    for (let i = 0; i < LIMITS.maxEntries; i++) {
      h.begin(`vast-${"f".repeat(50)}${i}`, T0 + i, "é".repeat(80));
      h.noteOffer(`vast-${"f".repeat(50)}${i}`, "é".repeat(80), 1e300);
      h.observe(`vast-${"f".repeat(50)}${i}`, status("stopping", { reason: "r".repeat(64) }), T0);
      h.requestStop(`vast-${"f".repeat(50)}${i}`, "destroy_button", "é".repeat(80));
      h.end(`vast-${"f".repeat(50)}${i}`, T0 + i + 1);
    }
    expect(new UsageHistory(LIMITS, new UsageStore(full, usageFileCap(LIMITS.maxEntries))).list(T0 + 99)).toHaveLength(LIMITS.maxEntries);
  });
});

describe("usageLimits and the reason list", () => {
  it("reads the bound and the slack from config and refuses bad values", () => {
    expect(usageLimits({ usageLogMaxEntries: 200, usageReasonSlackS: 120, secretNames: [] } as unknown as AppsConfig)).toEqual({ maxEntries: 200, slackS: 120 });
    expect(() => usageLimits({ secretNames: [] } as unknown as AppsConfig)).toThrow(/USAGE_LOG_MAX_ENTRIES/);
    expect(() => usageLimits({ usageLogMaxEntries: 10, secretNames: [] } as unknown as AppsConfig)).toThrow(/USAGE_REASON_SLACK_S/);
    // One entry could not hold an adopted session next to the one it closes: at least two.
    expect(() => usageLimits({ usageLogMaxEntries: 1, usageReasonSlackS: 0, secretNames: [] } as unknown as AppsConfig)).toThrow(/USAGE_LOG_MAX_ENTRIES must be an integer >= 2/);
  });

  it("is the fixed enum", () => {
    expect([...STOP_REASONS]).toEqual(["destroy_button", "idle_timeout", "failsafe_deadline", "hard_cap", "boot_failed", "agent_unreachable", "gone"]);
  });
});

describe("UsageHistory server location", () => {
  it("keeps the offer's location and download speed, then Vast's own row, through the file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "usage-srv-")), "usage.json");
    const h = new UsageHistory(LIMITS, new UsageStore(path, usageFileCap(LIMITS.maxEntries)));
    h.begin("vast-a", T0, "root");
    h.noteOffer("vast-a", "RTX 3090", 0.2, { location: "Quebec, CA", down_mbps: 860 });
    expect(h.list(T0)[0]).toMatchObject({ location: "Quebec, CA", down_mbps: 860 });
    h.noteServer("vast-a", { location: "Montreal, CA", down_mbps: null });
    expect(h.list(T0)[0]).toMatchObject({ location: "Montreal, CA", down_mbps: 860 });
    const again = new UsageHistory(LIMITS, new UsageStore(path, usageFileCap(LIMITS.maxEntries)));
    expect(again.list(T0)[0]).toMatchObject({ location: "Montreal, CA", down_mbps: 860 });
  });

  it("an entry written before the location existed still loads, with null location", () => {
    const path = join(mkdtempSync(join(tmpdir(), "usage-old-")), "usage.json");
    const old = {
      hostname: "vast-old", instance_id: 900, gpu_name: "RTX A5000", dph: 0.3, started_at: T0, ready_at: null,
      ended_at: T0 + 60, started_by: null, reason: "gone", stop_by: null, pending_stop: null, last_agent: null,
    };
    writeFileSync(path, JSON.stringify({ version: 1, entries: [old] }));
    const h = new UsageHistory(LIMITS, new UsageStore(path, usageFileCap(LIMITS.maxEntries)));
    expect(h.list(T0 + 60)).toHaveLength(1);
    expect(h.list(T0 + 60)[0]).toMatchObject({ instance_id: 900, location: null, down_mbps: null });
  });

  it("keeps the server facts beside the sessions: every entry keeps exactly the older file format", () => {
    const path = join(mkdtempSync(join(tmpdir(), "usage-fmt-")), "usage.json");
    const h = new UsageHistory(LIMITS, new UsageStore(path, usageFileCap(LIMITS.maxEntries)));
    h.begin("vast-a", T0, "root");
    h.noteOffer("vast-a", "RTX 3090", 0.2, { location: "Quebec, CA", down_mbps: 860 });
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(file.entries[0]).sort()).toEqual([
      "dph", "ended_at", "gpu_name", "hostname", "instance_id", "last_agent", "pending_stop", "ready_at", "reason",
      "started_at", "started_by", "stop_by",
    ]);
    expect(file.servers).toEqual({ "vast-a": { location: "Quebec, CA", down_mbps: 860 } });
  });

  it("drops a bad server record on its own and keeps the session; drops records of sessions no longer kept", () => {
    const path = join(mkdtempSync(join(tmpdir(), "usage-bad-")), "usage.json");
    const e = (host: string) => ({
      hostname: host, instance_id: 900, gpu_name: null, dph: null, started_at: T0, ready_at: null, ended_at: T0 + 1,
      started_by: null, reason: "gone", stop_by: null, pending_stop: null, last_agent: null,
    });
    writeFileSync(path, JSON.stringify({ version: 1, entries: [e("vast-ok"), e("vast-a"), e("vast-b"), e("vast-c")], servers: {
      "vast-ok": { location: "Quebec, CA", down_mbps: 860 },
      "vast-a": { location: "<b>", down_mbps: 1 },
      "vast-b": { location: "x".repeat(65), down_mbps: 1 },
      "vast-c": { location: "Paris", down_mbps: -3 },
      "vast-gone": { location: "Oslo, NO", down_mbps: 5 },
    } }));
    const h = new UsageHistory(LIMITS, new UsageStore(path, usageFileCap(LIMITS.maxEntries)));
    expect(h.list(T0).map((i) => i.location)).toEqual([null, null, null, "Quebec, CA"]);
    h.begin("vast-new", T0 + 5, null); // persists
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).servers)).toEqual(["vast-ok"]);
  });
});

describe("UsageHistory stuck starts (kept next to the sessions, tolerant loader)", () => {
  const rec = (over: Record<string, unknown> = {}) => ({
    hostname: "vast-a", code: "start_stuck", at: T0, machine_id: 45608, location: "Quebec, CA", down_mbps: 860, ...over,
  });

  it("round trips through the file and keeps only the newest ones", () => {
    const path = join(mkdtempSync(join(tmpdir(), "usage-stuck-")), "usage.json");
    const h = new UsageHistory(LIMITS, new UsageStore(path, usageFileCap(LIMITS.maxEntries)));
    for (let i = 0; i < 20; i++) h.noteStuck(rec({ hostname: `vast-${i}`, at: T0 + i }) as never);
    const again = new UsageHistory(LIMITS, new UsageStore(path, usageFileCap(LIMITS.maxEntries)));
    const list = again.stuckStarts();
    expect(list).toHaveLength(16);
    expect(list.at(-1)).toEqual(rec({ hostname: "vast-19", at: T0 + 19, measured_mb_s: null }));
    expect(list[0]!.hostname).toBe("vast-4");
  });

  it("drops a bad stuck record and keeps the good ones and the sessions", () => {
    const path = join(mkdtempSync(join(tmpdir(), "usage-stuck-bad-")), "usage.json");
    const session = {
      hostname: "vast-old", instance_id: 900, gpu_name: null, dph: null, started_at: T0, ready_at: null, ended_at: T0 + 1,
      started_by: null, reason: "gone", stop_by: null, pending_stop: null, last_agent: null,
    };
    writeFileSync(path, JSON.stringify({ version: 1, entries: [session], stuck: [
      rec(), rec({ code: "other" }), rec({ machine_id: -1 }), rec({ location: "<b>" }), rec({ hostname: "bad host" }), rec({ extra: 1 }), 5,
      rec({ code: "slow_download", measured_mb_s: 2.8 }), rec({ code: "slow_download", measured_mb_s: -1 }),
      rec({ code: "slow_download", measured_mb_s: 2.85 }), rec({ code: "slow_boot", measured_mb_s: null }), rec({ code: "boot_failed" }),
    ] }));
    const h = new UsageHistory(LIMITS, new UsageStore(path, usageFileCap(LIMITS.maxEntries)));
    // A record written before measured_mb_s existed loads with it null.
    expect(h.stuckStarts()).toEqual([
      rec({ measured_mb_s: null }), rec({ code: "slow_download", measured_mb_s: 2.8 }),
      rec({ code: "slow_boot", measured_mb_s: null }), rec({ code: "boot_failed", measured_mb_s: null }),
    ]);
    expect(h.list(T0 + 1)).toHaveLength(1);
    writeFileSync(path, JSON.stringify({ version: 1, entries: [session], stuck: "nope" }));
    const g = new UsageHistory(LIMITS, new UsageStore(path, usageFileCap(LIMITS.maxEntries)));
    expect(g.stuckStarts()).toEqual([]);
    expect(g.list(T0 + 1)).toHaveLength(1);
  });

  it("a full file with the most stuck records still fits the file cap", () => {
    const path = join(mkdtempSync(join(tmpdir(), "usage-stuck-cap-")), "usage.json");
    const h = new UsageHistory(LIMITS, new UsageStore(path, usageFileCap(LIMITS.maxEntries)));
    const long = "x".repeat(63);
    for (let i = 0; i < 16; i++) h.noteStuck(rec({ hostname: `${long.slice(0, 60)}${i}`, location: "é".repeat(64) }) as never);
    expect(statSync(path).size).toBeLessThan(usageFileCap(LIMITS.maxEntries));
  });
});
