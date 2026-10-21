// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mountApp, type App } from "../../public/ui.js";

// The server panel (right column from 1280 px, a right drawer below), the header pill and credit, the floating
// status widget and the boot log dialog. jsdom has no layout: the width is window.innerWidth, set per test.

const INDEX = readFileSync(join(import.meta.dirname, "../../public/index.html"), "utf8");
const CSS = readFileSync(join(import.meta.dirname, "../../public/style.css"), "utf8");

interface Reply { status?: number; body: unknown }
interface Call { method: string; path: string; body: unknown }

function apiState(over: Record<string, unknown> = {}) {
  return {
    state: "ready", role: "admin", record: null, vast: null, vast_error: null,
    agent: { state: "ready", reason: null, queue: { running: 0, pending: 0 }, gpu: { vram_total_mb: 24576, vram_used_mb: 12288 }, failsafe_alive: true, destroy: { pending: false, attempts: 0 } },
    agent_error: null, agent_unreachable: false, failed: null, destroy_failed: null, dph: 0.31, uptime_s: 4320, cost_so_far: 0.37,
    progress: null, gpu_name: "RTX 3090", download: null, remaining: { idle_s: 1450, failsafe_s: 9600, hard_cap_s: 20400 }, unknown: [],
    presets: [{ name: "zz-turbo", steps: 7 }], sizes: [{ name: "zz-square", width: 512, height: 512 }],
    ...over,
  };
}
const consoleBody = (over: Record<string, unknown> = {}) => ({
  generation: 1,
  instance: { state: "booting", ended: false, ended_reason: null },
  phases: [
    { id: "net_probe", name: "Network probe", status: "done" },
    { id: "models", name: "Download models", status: "running" },
    { id: "comfyui", name: "Start ComfyUI", status: "pending" },
  ],
  lines: [{ seq: 1, t: 3601, source: "agent", text: "line 1" }],
  last_seq: 1, truncated: false, source_error: null,
  ...over,
});

let app: App | null = null;
let calls: Call[] = [];
let routes: Record<string, Reply> = {};
let timers: { fn: () => void; ms: number }[] = [];

function setWidth(px: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: px });
}
function resize(px: number): void {
  setWidth(px);
  window.dispatchEvent(new Event("resize"));
}

async function mount(over: Record<string, unknown> = {}, extra: Record<string, Reply> = {}): Promise<App> {
  const s = apiState(over);
  routes = {
    "GET /api/me": { body: { name: "Ayu", username: "ayu", role: s.role } },
    "GET /api/state": { body: s },
    "GET /api/credit": { body: { credit: 4.54, as_of: 1 } },
    "GET /api/console?after=0": { body: consoleBody() },
    ...extra,
  };
  app = mountApp(document, {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, path, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      const r = routes[`${method} ${path}`] ?? (path.startsWith("/api/console") ? routes["GET /api/console?after=0"] : undefined);
      if (r === undefined) return new Response(JSON.stringify({ error: { code: "not_found", message: "not found" } }), { status: 404 });
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }) as typeof fetch,
    now: () => 1_000_000,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => undefined,
  });
  await app.ready;
  await flush();
  return app;
}

const q = <T extends Element = HTMLElement>(sel: string): T => {
  const n = document.querySelector<T>(sel);
  if (n === null) throw new Error(`no ${sel}`);
  return n;
};
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const key = (target: Element, k: string, shiftKey = false) => {
  const ev = new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return ev;
};
const panel = () => q("#status-panel");
const inPanel = (id: string) => panel().querySelector(`#${id}`) !== null;
const before = (a: string, b: string) => Boolean(q(`#${a}`).compareDocumentPosition(q(`#${b}`)) & Node.DOCUMENT_POSITION_FOLLOWING);

beforeEach(() => {
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(INDEX)![1]!;
  calls = [];
  timers = [];
  window.localStorage.clear();
  setWidth(1024);
});
afterEach(() => {
  vi.restoreAllMocks();
  app?.stop();
  app = null;
  setWidth(1024);
});

describe("the server panel markup", () => {
  it("is an aside outside the page column, beside the tool menu, labelled by its heading", () => {
    const aside = panel();
    expect(aside.tagName).toBe("ASIDE");
    expect(aside.getAttribute("aria-labelledby")).toBe("status-title");
    expect(q("#status-title").getAttribute("tabindex")).toBe("-1");
    expect(aside.parentElement).toBe(q("#tool-nav").parentElement);
    expect(q("#page").contains(aside)).toBe(false);
  });

  it("holds every status element (they moved, their ids stayed)", async () => {
    await mount();
    for (const id of ["f-uptime", "f-cost", "f-price", "f-gpu", "f-server", "f-idle", "f-failsafe", "f-hardcap", "f-queue", "f-vram", "state-line",
      "progress-box", "alert-agent", "alert-start-failure", "alert-failed", "alert-destroy-failed", "admin-panel", "btn-start", "btn-extend",
      "btn-destroy", "extend-kind", "extend-minutes", "unknown", "console-steps", "boot-sentence", "console-ended", "console-open"]) {
      expect(inPanel(id), id).toBe(true);
    }
    expect(q("#main").querySelector("#state-line")).toBeNull();
    expect(q("#main").querySelector("#console-card")).toBeNull();
  });

  it("has exactly one live region: the state line", async () => {
    await mount();
    const live = [...panel().querySelectorAll("[aria-live]")];
    expect(live.map((n) => n.id)).toEqual(["state-line"]);
    expect(q("#state-line").getAttribute("aria-live")).toBe("polite");
    expect(panel().querySelectorAll('[role="status"], [role="log"]')).toHaveLength(0);
  });

  it("orders state, alerts, key figures, the main action, the boot summary, then the facts; the danger zone comes last", async () => {
    await mount();
    expect(before("state-line", "alert-failed")).toBe(true);
    expect(before("alert-failed", "progress-box")).toBe(true);
    expect(before("progress-box", "key-figures")).toBe(true);
    expect(before("key-figures", "admin-panel")).toBe(true);
    expect(before("admin-panel", "boot-summary")).toBe(true);
    expect(before("boot-summary", "facts")).toBe(true);
    expect(["f-uptime", "f-cost", "f-idle"].every((id) => q("#key-figures").querySelector(`#${id}`))).toBe(true);
    expect(["f-price", "f-gpu", "f-server", "f-failsafe", "f-hardcap", "f-queue", "f-vram"].every((id) => q("#facts").querySelector(`#${id}`))).toBe(true);
    expect(panel().lastElementChild!.id).toBe("danger-zone");
    expect(q("#danger-zone").querySelector("#btn-destroy")).not.toBeNull();
    expect(q("#danger-zone").querySelector("#unknown")).not.toBeNull();
    expect(q("#admin-panel").querySelector("#btn-destroy")).toBeNull();
    expect(q("#danger-zone").getAttribute("aria-labelledby")).toBe(q("#danger-zone h3").id);
  });

  it("an admin sees the main action, the boot summary and the danger zone; Destroy is never next to Extend", async () => {
    await mount();
    expect(q("#admin-panel").hidden).toBe(false);
    expect(q("#boot-summary").hidden).toBe(false);
    expect(q("#danger-zone").hidden).toBe(false);
    expect(q("#btn-destroy").textContent).toBe("Destroy instance…");
    expect(q("#btn-destroy").closest("#admin-panel")).toBeNull();
  });

  it("a member sees state, figures and facts but no action, boot summary or danger zone", async () => {
    await mount({ role: "member" });
    expect(q("#state-line").textContent).toBe("Ready");
    expect(q("#f-uptime").textContent).toBe("1h 12m");
    expect(q("#admin-panel").hidden).toBe(true);
    expect(q("#boot-summary").hidden).toBe(true);
    expect(q("#danger-zone").hidden).toBe(true);
    expect(document.querySelector("#btn-destroy")).toBeNull();
    expect(calls.some((c) => c.path.startsWith("/api/console"))).toBe(false);
  });

  it("an account that stops being an admin loses every action at once", async () => {
    await mount();
    expect(document.querySelector("#btn-destroy")).not.toBeNull();
    routes["GET /api/state"] = { body: apiState({ role: "member" }) };
    await app!.refresh();
    for (const id of ["btn-start", "btn-extend", "btn-destroy", "unknown"]) expect(document.querySelector(`#${id}`), id).toBeNull();
    expect(q("#danger-zone").hidden).toBe(true);
    expect(q("#danger-title").textContent).toBe("Danger zone");
  });

  it("Start shows only without an instance; Extend is a closed section unless the idle shutdown is near", async () => {
    await mount({ state: "none", uptime_s: null, cost_so_far: null, remaining: { idle_s: null, failsafe_s: null, hard_cap_s: null } });
    expect(q("#btn-start").hidden).toBe(false);
    expect(q("#extend-box").hidden).toBe(true);
    expect(q("#btn-destroy").hidden).toBe(true);
    routes["GET /api/state"] = { body: apiState() };
    await app!.refresh();
    expect(q("#btn-start").hidden).toBe(true);
    expect(q("#extend-box").hidden).toBe(false);
    expect(q<HTMLDetailsElement>("#extend-box").open).toBe(false);
    expect(q("#btn-extend").classList.contains("primary")).toBe(false);
    routes["GET /api/state"] = { body: apiState({ state: "idle-warning", remaining: { idle_s: 161, failsafe_s: 9600, hard_cap_s: 20400 } }) };
    await app!.refresh();
    expect(q<HTMLDetailsElement>("#extend-box").open).toBe(true);
    expect(q("#btn-extend").classList.contains("primary")).toBe(true);
    expect(q("#key-idle").dataset["tone"]).toBe("warn");
    routes["GET /api/state"] = { body: apiState({ state: "stopping" }) };
    await app!.refresh();
    expect(q("#btn-start").hidden).toBe(true);
    expect(q("#extend-box").hidden).toBe(true);
  });

  it("relabels Destroy as a retry after a failure and shows the failure reason first", async () => {
    await mount({ state: "failed", failed: { reason: "slow_download" } });
    expect(q("#btn-destroy").textContent).toBe("Destroy instance (retry)");
    expect(q("#alert-failed").hidden).toBe(false);
    routes["GET /api/state"] = { body: apiState({ state: "destroy_failed", destroy_failed: { error: "Vast said no" } }) };
    await app!.refresh();
    expect(q("#btn-destroy").textContent).toBe("Destroy instance (retry)");
  });

  it("the destroy confirmation names the cost so far and Cancel has the focus", async () => {
    await mount();
    q("#btn-destroy").click();
    await flush();
    expect(q("#modal").hidden).toBe(false);
    expect(q("#modal-body").textContent).toContain("Cost so far: $0.37.");
    expect(document.activeElement).toBe(q("#modal-cancel"));
    q("#modal-cancel").click();
  });

  it("lists untracked instances in a closed section with their count", async () => {
    await mount({ state: "none", uptime_s: null, unknown: [{ vast_instance_id: 11, actual_status: "running", start_date: 1, dph: 0.4 }] });
    expect(q("#danger-zone").hidden).toBe(false);
    expect(q<HTMLDetailsElement>("#unknown-box").open).toBe(false);
    expect(q("#unknown-box").hidden).toBe(false);
    expect(q("#unknown-box summary").textContent).toBe("Untracked instances on Vast (1)");
    routes["GET /api/state"] = { body: apiState({ state: "none", uptime_s: null }) };
    await app!.refresh();
    expect(q("#unknown-box").hidden).toBe(true);
    expect(q("#danger-zone").hidden).toBe(true); // nothing to destroy
  });

  it("does not set the same state text again (a screen reader announces each change)", async () => {
    await mount();
    const line = q("#state-line");
    let writes = 0;
    new MutationObserver((m) => { writes += m.length; }).observe(line, { childList: true, characterData: true, subtree: true });
    await app!.refresh();
    await app!.refresh();
    await flush();
    expect(writes).toBe(0);
  });
});
