// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mountApp, type App } from "../../public/ui.js";
import * as model from "../../public/model.js";
import {
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

function setWidth(px: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: px });
}

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
      if (path === "/auth/logout") return json(200, {});
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
const dialog = () => q("#usage-card");
const openBtn = () => q<HTMLButtonElement>("#history-open");
const key = (target: Element, k: string, shiftKey = false) => {
  const ev = new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return ev;
};
async function openHistory(): Promise<void> {
  openBtn().focus();
  openBtn().click();
  await flush();
}
async function setState(a: App, over: Record<string, unknown>): Promise<void> {
  stateBody = apiState(over);
  await a.refresh();
  await flush();
}
const rows = () => [...document.querySelectorAll("#usage-list li")].map((n) => n.textContent ?? "");

beforeEach(() => {
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(INDEX)![1]!;
  fetched = [];
  historyGate = null;
  setWidth(1024);
  try { localStorage.clear(); } catch { /* none */ }
});
afterEach(() => {
  vi.restoreAllMocks();
  app?.stop();
  app = null;
  setWidth(1024);
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

describe("history dialog: markup and the History button", () => {
  it("is a modal dialog outside the main column, beside the boot log dialog, with no fold toggle", () => {
    const d = dialog();
    expect(q("#main").contains(d)).toBe(false);
    expect(q("#page").contains(d)).toBe(false);
    expect(d.parentElement).toBe(q("#console-card").parentElement);
    expect(d.getAttribute("role")).toBe("dialog");
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(d.getAttribute("aria-labelledby")).toBe("usage-title");
    expect(q("#usage-title").textContent).toBe("History");
    expect(d.hidden).toBe(true);
    expect(q("#history-backdrop").hidden).toBe(true);
    for (const id of ["usage-title", "usage-body", "usage-error", "usage-empty", "usage-list", "history-close"]) expect(d.querySelector(`#${id}`), id).not.toBeNull();
    expect(q("#usage-body").textContent).toContain("Costs are estimates");
    expect(document.querySelector("#usage-toggle")).toBeNull();
    expect("HISTORY_COLLAPSED_KEY" in model).toBe(false);
  });

  it("the History button sits in the server panel after the boot summary, above the danger zone, and opens a dialog", () => {
    const b = openBtn();
    expect(q("#status-panel").contains(b)).toBe(true);
    expect(b.textContent).toBe("History");
    expect(b.getAttribute("type")).toBe("button");
    expect(b.getAttribute("aria-haspopup")).toBe("dialog");
    expect(b.getAttribute("aria-controls")).toBe("usage-card");
    expect(Boolean(q("#boot-summary").compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(b.compareDocumentPosition(q("#danger-zone")) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(b.hidden).toBe(true); // nothing before the role is known
  });

  it("a member never sees the button or the dialog and never calls the history endpoint", async () => {
    const a = await mount({ state: { role: "member" } });
    expect(openBtn().hidden).toBe(true);
    expect(dialog().hidden).toBe(true);
    openBtn().click(); // even a scripted click on the hidden button does nothing
    await flush();
    expect(dialog().hidden).toBe(true);
    await setState(a, { role: "member", state: "none" });
    expect(historyCalls()).toBe(0);
  });

  it("an admin sees the button, also when no instance exists; no request until it is opened", async () => {
    const a = await mount({ state: { state: "none", uptime_s: null, cost_so_far: null } });
    expect(openBtn().hidden).toBe(false);
    expect(dialog().hidden).toBe(true);
    await setState(a, { state: "booting" });
    await setState(a, { state: "ready" });
    await setState(a, { state: "none" });
    expect(openBtn().hidden).toBe(false);
    expect(historyCalls()).toBe(0);
    expect(Object.keys(localStorage).filter((k) => k.includes("history"))).toEqual([]);
  });
});

describe("history dialog: opening, closing and focus", () => {
  it("opens over everything: backdrop, the page, panel, menu and widget inert, focus on Close", async () => {
    setWidth(1280);
    await mount();
    await openHistory();
    expect(dialog().hidden).toBe(false);
    expect(q("#history-backdrop").hidden).toBe(false);
    for (const id of ["page", "status-panel", "tool-nav", "float-status"]) expect(q(`#${id}`).hasAttribute("inert"), id).toBe(true);
    expect(dialog().hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(q("#history-close"));
    expect(historyCalls()).toBe(1);
  });

  it("closes with Escape, the backdrop and Close; the focus goes back to the History button", async () => {
    setWidth(1280);
    await mount();
    for (const close of [() => key(document.activeElement!, "Escape"), () => q("#history-backdrop").click(), () => q("#history-close").click()]) {
      await openHistory();
      expect(dialog().hidden).toBe(false);
      close();
      expect(dialog().hidden).toBe(true);
      expect(q("#history-backdrop").hidden).toBe(true);
      for (const id of ["page", "status-panel", "tool-nav"]) expect(q(`#${id}`).hasAttribute("inert"), id).toBe(false);
      expect(document.activeElement).toBe(openBtn());
    }
  });

  it("opened from the panel drawer it closes the drawer, and the focus goes back to the pill", async () => {
    setWidth(375);
    await mount();
    q("#status-pill").click();
    expect(q("#status-panel").classList.contains("open")).toBe(true);
    await openHistory();
    expect(q("#status-panel").classList.contains("open")).toBe(false);
    expect(q("#panel-backdrop").hidden).toBe(true);
    expect(dialog().hidden).toBe(false);
    key(document.activeElement!, "Escape");
    expect(dialog().hidden).toBe(true);
    expect(document.activeElement).toBe(q("#status-pill"));
  });

  it("traps Tab and Shift+Tab inside the dialog", async () => {
    await mount();
    await openHistory();
    const only = q("#history-close");
    expect(key(only, "Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(only);
    expect(key(only, "Tab", true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(only);
    q("#status-title").focus(); // the focus somehow outside: Tab brings it back in
    key(dialog(), "Tab");
    expect(document.activeElement).toBe(only);
  });

  it("one overlay at a time: it replaces the menu drawer and the boot log, and they replace it", async () => {
    await mount();
    q("#menu-open").click();
    expect(q("#tool-nav").classList.contains("open")).toBe(true);
    await openHistory();
    expect(q("#tool-nav").classList.contains("open")).toBe(false);
    expect(dialog().hidden).toBe(false);
    q("#console-open").click(); // scripted: the panel is inert for a real user
    expect(q("#console-card").hidden).toBe(false);
    expect(dialog().hidden).toBe(true);
    expect(q("#history-backdrop").hidden).toBe(true);
    await openHistory();
    expect(q("#console-card").hidden).toBe(true);
    expect(q("#console-backdrop").hidden).toBe(true);
    expect(dialog().hidden).toBe(false);
  });

  it("closes and clears when the account stops being an admin; the focus falls back to the pill", async () => {
    setWidth(1280);
    const a = await mount();
    await openHistory();
    expect(rows()).toHaveLength(1);
    await setState(a, { role: "member" });
    expect(dialog().hidden).toBe(true);
    expect(openBtn().hidden).toBe(true);
    expect(rows()).toEqual([]);
    expect(q("#page").hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(q("#status-pill"));
    await setState(a, { role: "member", state: "none" });
    expect(historyCalls()).toBe(1);
  });
});

describe("history dialog: content", () => {
  it("an admin sees recent sessions: start, duration, GPU, reason and estimated cost", async () => {
    await mount({ history: { entries: [entry({ active: true, ended_at: null, reason: null, stop_by: null, duration_s: 600, estimated_cost: 0.05 }), entry(), entry({ reason: "gone", stop_by: null, gpu_name: null, estimated_cost: null })] } });
    await openHistory();
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
    await openHistory();
    const [withServer, without] = rows();
    expect(withServer).toContain("Quebec, CA, 860 Mbps down");
    expect(without).not.toContain("Mbps");
  });

  it("an empty history says so, but only once it has been read", async () => {
    let release!: () => void;
    historyGate = new Promise<void>((r) => (release = r));
    await mount({ history: { entries: [] } });
    await openHistory();
    expect(q("#usage-empty").hidden).toBe(true); // still reading: not "no sessions" yet
    historyGate = null;
    release();
    await flush();
    expect(rows()).toEqual([]);
    expect(q("#usage-empty").hidden).toBe(false);
  });

  it("hostile text is inert (textContent only)", async () => {
    const evil = "<img src=x onerror=alert(1)>";
    await mount({ history: { entries: [entry({ gpu_name: evil, stop_by: evil, started_by: evil, location: evil })] } });
    await openHistory();
    expect(dialog().querySelector("img")).toBeNull();
    expect(rows()[0]).toContain(evil);
    expect(rows()[0]).toContain(`started by ${evil}`);
  });

  it("while open, refreshes when the state becomes none or ready, not on every poll", async () => {
    const a = await mount({ state: { state: "booting" } });
    expect(historyCalls()).toBe(0);
    await openHistory();
    expect(historyCalls()).toBe(1);
    await setState(a, { state: "booting" });
    expect(historyCalls()).toBe(1);
    await setState(a, { state: "ready" });
    expect(historyCalls()).toBe(2);
    await setState(a, { state: "ready" });
    expect(historyCalls()).toBe(2);
    await setState(a, { state: "none" });
    expect(historyCalls()).toBe(3);
  });

  it("reads again on every opening, and never while closed", async () => {
    const a = await mount({ state: { state: "booting" } });
    await openHistory();
    q("#history-close").click();
    await setState(a, { state: "ready" });
    await setState(a, { state: "none" });
    expect(historyCalls()).toBe(1);
    historyBody = { entries: [entry(), entry({ vast_instance_id: 901 })] };
    await openHistory();
    expect(historyCalls()).toBe(2);
    expect(rows()).toHaveLength(2);
  });

  it("a change to none or ready during a read in flight reads once more afterwards", async () => {
    let release!: () => void;
    historyGate = new Promise<void>((r) => (release = r));
    const a = await mount({ state: { state: "booting" }, history: { entries: [entry({ active: true, ended_at: null, reason: null })] } });
    await openHistory();
    expect(historyCalls()).toBe(1); // still in flight
    historyBody = { entries: [entry()] };
    await setState(a, { state: "none" });
    expect(historyCalls()).toBe(1); // no second request while one is running
    historyGate = null;
    release();
    await flush();
    expect(historyCalls()).toBe(2);
    expect(rows()[0]).toContain("Destroy button (by ayu)");
    await setState(a, { state: "none" });
    expect(historyCalls()).toBe(2);
  });

  it("a read still due when the dialog closes is dropped, not done in the background", async () => {
    let release!: () => void;
    historyGate = new Promise<void>((r) => (release = r));
    const a = await mount({ state: { state: "booting" } });
    await openHistory();
    await setState(a, { state: "ready" }); // due while the first read runs
    q("#history-close").click();
    historyGate = null;
    release();
    await flush();
    expect(historyCalls()).toBe(1);
  });

  it("an answer that arrives after the account lost admin is discarded", async () => {
    let release!: () => void;
    historyGate = new Promise<void>((r) => (release = r));
    const a = await mount();
    await openHistory();
    await setState(a, { role: "member" });
    historyGate = null;
    release();
    await flush();
    expect(rows()).toEqual([]);
    expect(dialog().hidden).toBe(true);
  });

  it("a failed read shows a short note in the dialog and keeps the last list", async () => {
    const a = await mount();
    await openHistory();
    expect(rows()).toHaveLength(1);
    historyStatus = 500;
    historyBody = { error: { code: "history_unavailable", message: "x" } };
    await setState(a, { state: "none" });
    expect(rows()).toHaveLength(1);
    expect(q("#usage-error").textContent).toBe("The history could not be loaded. Close it and open it again to retry.");
    expect(dialog().contains(q("#usage-error"))).toBe(true);
    q("#history-close").click();
    historyStatus = 200;
    historyBody = { entries: [entry(), entry({ vast_instance_id: 901 })] };
    await openHistory();
    expect(q("#usage-error").hidden).toBe(true);
    expect(rows()).toHaveLength(2);
    expect(q("#banner").hidden).toBe(true);
  });

  it("closes on logout", async () => {
    await mount();
    await openHistory();
    q("#btn-logout").click(); // scripted: the page is inert for a real user
    await flush();
    expect(q("#login-screen").hidden).toBe(false);
    expect(dialog().hidden).toBe(true);
    expect(q("#page").hasAttribute("inert")).toBe(false);
  });
});

describe("history dialog: style.css", () => {
  const CSS = readFileSync(join(import.meta.dirname, "../../public/style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  it("uses the log dialog's frame (z-index 25, a full phone screen) and scrolls its list", () => {
    expect(dialog().classList.contains("log-dialog")).toBe(true);
    expect(/\.history-dialog #usage-body\s*\{[^}]*overflow-y: auto/.test(CSS)).toBe(true);
    expect(/#history-open\s*\{[^}]*width: 100%/.test(CSS)).toBe(true);
  });
});
