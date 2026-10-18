// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mountApp, type App } from "../../public/ui.js";
import {
  HISTORY_COLLAPSED_KEY,
  historyRefreshDue,
  historyTime,
  parseHistory,
  stopReasonText,
} from "../../public/model.js";

const INDEX = readFileSync(join(import.meta.dirname, "../../public/index.html"), "utf8");
const T = 1_800_000_000;

function apiState(over: Record<string, unknown> = {}) {
  return {
    state: "ready", role: "admin", record: null, vast: null, vast_error: null, agent: null, agent_error: null,
    agent_unreachable: false, failed: null, destroy_failed: null, dph: 0.36, uptime_s: 60, cost_so_far: 0.01,
    progress: null, gpu_name: null, download: null, remaining: { idle_s: 1500, failsafe_s: 9000, hard_cap_s: 20000 },
    unknown: [], presets: [{ name: "p", steps: 7 }], sizes: [{ name: "s", width: 512, height: 512 }], ...over,
  };
}

function entry(over: Record<string, unknown> = {}) {
  return {
    vast_instance_id: 900, gpu_name: "RTX A5000", dph: 0.3, started_at: T, ready_at: T + 120, ended_at: T + 3600,
    duration_s: 3600, estimated_cost: 0.3, started_by: "root", reason: "destroy_button", stop_by: "ayu", active: false, ...over,
  };
}

let app: App | null = null;
let fetched: string[] = [];
let stateBody: Record<string, unknown> = {};
let historyBody: unknown = { entries: [] };
let historyStatus = 200;
let historyGate: Promise<void> | null = null;

async function mount(over: { state?: Record<string, unknown>; history?: unknown; status?: number } = {}): Promise<App> {
  stateBody = apiState(over.state);
  historyBody = over.history ?? { entries: [entry()] };
  historyStatus = over.status ?? 200;
  app = mountApp(document, {
    fetch: (async (input: RequestInfo | URL) => {
      const path = String(input);
      fetched.push(path);
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
      if (path === "/api/me") return json(200, { name: "T", username: "t", role: stateBody["role"] });
      if (path === "/api/state") return json(200, stateBody);
      if (path === "/api/history") {
        const body = historyBody; // the answer as it was when the request arrived
        if (historyGate) await historyGate;
        return json(historyStatus, body);
      }
      return json(404, { error: { code: "not_found", message: "no" } });
    }) as typeof fetch,
    now: () => 1_000_000,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  });
  await app.ready;
  await flush();
  return app;
}

const q = <T extends Element = HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const historyCalls = () => fetched.filter((p) => p === "/api/history").length;
const rows = () => [...document.querySelectorAll("#usage-list li")].map((n) => n.textContent ?? "");

beforeEach(() => {
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(INDEX)![1]!;
  fetched = [];
  historyGate = null;
  try { localStorage.clear(); } catch { /* none */ }
});
afterEach(() => {
  vi.restoreAllMocks();
  app?.stop();
  app = null;
});

describe("history model", () => {
  it("parses only a well formed list", () => {
    expect(parseHistory({ entries: [entry()] })).toHaveLength(1);
    // An older server without the location fields still parses; a bad location is refused.
    expect(parseHistory({ entries: [entry({ location: "Quebec, CA", down_mbps: 860 })] })![0]).toMatchObject({ location: "Quebec, CA", down_mbps: 860 });
    expect(parseHistory({ entries: [entry()] })![0]).toMatchObject({ location: null, down_mbps: null });
    expect(parseHistory({ entries: [entry({ location: 5 })] })).toBeNull();
    for (const bad of [null, {}, { entries: {} }, { entries: [{ ...entry(), started_at: "x" }] }, { entries: [{ ...entry(), active: "yes" }] }]) {
      expect(parseHistory(bad)).toBeNull();
    }
  });

  it("names every reason in plain words", () => {
    expect(stopReasonText("destroy_button", "ayu", false)).toBe("Destroy button (by ayu)");
    expect(stopReasonText("destroy_button", null, false)).toBe("Destroy button");
    expect(stopReasonText("idle_timeout", null, false)).toBe("Idle timeout");
    expect(stopReasonText("failsafe_deadline", null, false)).toBe("Failsafe deadline");
    expect(stopReasonText("hard_cap", null, false)).toBe("Hard cap");
    expect(stopReasonText("boot_failed", null, false)).toBe("Boot failed");
    expect(stopReasonText("agent_unreachable", null, false)).toBe("Agent unreachable");
    expect(stopReasonText("gone", null, false)).toBe("Disappeared");
    expect(stopReasonText("something_else", null, false)).toBe("Stopped");
    expect(stopReasonText(null, null, true)).toBe("Running");
  });

  it("refreshes on the first state and when the state changes to none or ready only", () => {
    expect(historyRefreshDue(null, "booting")).toBe(true);
    expect(historyRefreshDue("booting", "ready")).toBe(true);
    expect(historyRefreshDue("stopping", "none")).toBe(true);
    expect(historyRefreshDue("ready", "ready")).toBe(false);
    expect(historyRefreshDue("ready", "idle-warning")).toBe(false);
    expect(historyRefreshDue("none", "creating")).toBe(false);
  });

  it("shows the start as a local date and time", () => {
    const d = new Date(T * 1000);
    const two = (n: number) => String(n).padStart(2, "0");
    expect(historyTime(T)).toBe(`${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`);
  });
});

describe("history card", () => {
  it("a member never sees the card and never calls the history endpoint", async () => {
    await mount({ state: { role: "member" } });
    expect(q("#usage-card").hidden).toBe(true);
    expect(historyCalls()).toBe(0);
  });

  it("an admin sees recent sessions: start, duration, GPU, reason and estimated cost", async () => {
    await mount({ history: { entries: [entry({ active: true, ended_at: null, reason: null, stop_by: null, duration_s: 600, estimated_cost: 0.05 }), entry(), entry({ reason: "gone", stop_by: null, gpu_name: null, estimated_cost: null })] } });
    expect(q("#usage-card").hidden).toBe(false);
    const r = rows();
    expect(r).toHaveLength(3);
    expect(r[0]).toContain("Running");
    expect(r[0]).toContain("10m 00s");
    expect(r[1]).toContain(historyTime(T));
    expect(r[1]).toContain("1h 00m");
    expect(r[1]).toContain("RTX A5000");
    expect(r[1]).toContain("Destroy button (by ayu)");
    expect(r[1]).toContain("$0.30");
    expect(r[2]).toContain("Disappeared");
    expect(q("#usage-empty").hidden).toBe(true);
  });

  it("each session shows where its server was and its download speed, when known", async () => {
    await mount({ history: { entries: [entry({ location: "Quebec, CA", down_mbps: 860 }), entry({ vast_instance_id: 901 })] } });
    const [withServer, without] = rows();
    expect(withServer).toContain("Quebec, CA, 860 Mbps down");
    expect(without).not.toContain("Mbps");
  });

  it("an empty history says so", async () => {
    await mount({ history: { entries: [] } });
    expect(rows()).toEqual([]);
    expect(q("#usage-empty").hidden).toBe(false);
  });

  it("hostile text is inert (textContent only)", async () => {
    const evil = "<img src=x onerror=alert(1)>";
    await mount({ history: { entries: [entry({ gpu_name: evil, stop_by: evil, started_by: evil })] } });
    expect(document.querySelector("#usage-list img")).toBeNull();
    expect(rows()[0]).toContain(evil);
  });

  it("refreshes when the state becomes none or ready, not on every poll", async () => {
    const a = await mount({ state: { state: "booting" } });
    expect(historyCalls()).toBe(1);
    await a.refresh();
    await flush();
    expect(historyCalls()).toBe(1);
    stateBody = apiState({ state: "ready" });
    await a.refresh();
    await flush();
    expect(historyCalls()).toBe(2);
    await a.refresh();
    await flush();
    expect(historyCalls()).toBe(2);
    stateBody = apiState({ state: "none" });
    await a.refresh();
    await flush();
    expect(historyCalls()).toBe(3);
  });

  it("a change to none or ready during a read in flight reads once more afterwards", async () => {
    let release!: () => void;
    historyGate = new Promise<void>((r) => (release = r));
    const a = await mount({ state: { state: "booting" }, history: { entries: [entry({ active: true, ended_at: null, reason: null })] } });
    expect(historyCalls()).toBe(1); // still in flight
    historyBody = { entries: [entry()] };
    stateBody = apiState({ state: "none" });
    await a.refresh();
    await flush();
    expect(historyCalls()).toBe(1); // no second request while one is running
    historyGate = null;
    release();
    await flush();
    expect(historyCalls()).toBe(2);
    expect(rows()[0]).toContain("Destroy button (by ayu)");
    await a.refresh();
    await flush();
    expect(historyCalls()).toBe(2);
  });

  it("a failed read shows a short note and keeps the last list", async () => {
    const a = await mount();
    expect(rows()).toHaveLength(1);
    historyStatus = 500;
    historyBody = { error: { code: "history_unavailable", message: "x" } };
    stateBody = apiState({ state: "none" });
    await a.refresh();
    await flush();
    expect(rows()).toHaveLength(1);
    expect(q("#usage-error").hidden).toBe(false);
    expect(q("#banner").hidden).toBe(true);
  });

  it("is collapsible and remembers the choice", async () => {
    await mount();
    const toggle = q<HTMLButtonElement>("#usage-toggle");
    expect(q("#usage-body").hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    toggle.click();
    expect(q("#usage-body").hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toBe("Show history");
    expect(localStorage.getItem(HISTORY_COLLAPSED_KEY)).toBe("1");
    app!.stop();
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(INDEX)![1]!;
    await mount();
    expect(q("#usage-body").hidden).toBe(true);
    expect(q<HTMLButtonElement>("#usage-toggle").textContent).toBe("Show history");
  });

  it("works when storage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    await mount();
    expect(q("#usage-body").hidden).toBe(false);
    q<HTMLButtonElement>("#usage-toggle").click();
    expect(q("#usage-body").hidden).toBe(true);
  });
});
