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
let nowMs = 1_000_000;

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
    now: () => nowMs,
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
  nowMs = 1_000_000;
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

describe("the header", () => {
  const tick = () => { const t = [...timers].reverse().find((x) => x.ms === 1_000)!; t.fn(); };

  it("has the title, a status pill that controls the panel, the name and a Logout button with an icon", async () => {
    await mount();
    const header = q("#page header");
    for (const id of ["menu-open", "status-pill", "f-credit-box", "user-name", "role", "btn-logout"]) expect(header.querySelector(`#${id}`), id).not.toBeNull();
    const pill = q<HTMLButtonElement>("#status-pill");
    expect(pill.type).toBe("button");
    expect(pill.getAttribute("aria-controls")).toBe("status-panel");
    expect(pill.hasAttribute("aria-expanded")).toBe(true);
    expect(pill.querySelector(".dot")!.getAttribute("aria-hidden")).toBe("true");
    expect(q("#status-pill-text").textContent).toBe("Ready");
    expect(pill.textContent).toBe("Server: Ready");
    expect(pill.dataset["tone"]).toBe("ok");
    expect(pill.hasAttribute("aria-live")).toBe(false);
    const logout = q<HTMLButtonElement>("#btn-logout");
    expect(logout.textContent).toBe("Logout");
    expect(logout.getAttribute("aria-label")).toBe("Logout");
    expect(logout.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    expect(q("#user-name").textContent).toBe("Ayu");
    expect(q("#main").querySelector("#btn-logout")).toBeNull();
  });

  it("the pill follows the state and counts the idle shutdown down", async () => {
    await mount({ state: "downloading", download: { files_total: 3, files_done: 1, bytes_done: 42, bytes_total: 100, current_file: "m.gguf" } });
    expect(q("#status-pill-text").textContent).toBe("Booting 42%");
    expect(q("#status-pill").dataset["tone"]).toBe("busy");
    routes["GET /api/state"] = { body: apiState({ state: "idle-warning", remaining: { idle_s: 181, failsafe_s: 9600, hard_cap_s: 20400 } }) };
    await app!.refresh();
    expect(q("#status-pill-text").textContent).toBe("Idle 4m");
    expect(q("#status-pill").dataset["tone"]).toBe("warn");
    nowMs += 2_000;
    tick();
    expect(q("#status-pill-text").textContent).toBe("Idle 3m");
    routes["GET /api/state"] = { body: apiState({ state: "none", uptime_s: null }) };
    await app!.refresh();
    expect(q("#status-pill-text").textContent).toBe("Stopped");
  });

  it("shows the admin's credit with a tone and a word, never colour alone", async () => {
    await mount({ dph: 0.6 }, { "GET /api/credit": { body: { credit: 1.1, as_of: 1 } } });
    expect(q("#f-credit-box").hidden).toBe(false);
    expect(q("#f-credit").textContent).toBe("$1.10");
    expect(q("#f-credit-box").dataset["tone"]).toBe("warn");
    expect(q("#f-credit-tone").textContent).toBe("low");
    expect(q("#f-credit-box").textContent).toBe("Vast credit $1.10 low");
    // The same line is the first thing in the panel on small phones.
    expect(q("#panel-credit").hidden).toBe(false);
    expect(panel().querySelector(".panel-body")!.firstElementChild!.id).toBe("panel-credit");
    expect(q("#panel-credit").textContent).toBe("Vast credit: $1.10 low");
    expect(q("#panel-credit").dataset["tone"]).toBe("warn");
  });

  it("a used-up credit is bad, a healthy one neutral-free ok, an unreadable one neutral without a word", async () => {
    await mount({}, { "GET /api/credit": { body: { credit: -0.2, as_of: 1 } } });
    expect(q("#f-credit-box").dataset["tone"]).toBe("bad");
    expect(q("#f-credit-tone").textContent).toBe("used up");
    app!.stop();
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(INDEX)![1]!;
    await mount();
    expect(q("#f-credit-box").dataset["tone"]).toBe("ok");
    expect(q("#f-credit-tone").textContent).toBe("");
    app!.stop();
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(INDEX)![1]!;
    await mount({}, { "GET /api/credit": { status: 502, body: { error: { code: "vast_unavailable", message: "no" } } } });
    expect(q("#f-credit").textContent).toBe("unavailable");
    expect(q("#f-credit-box").dataset["tone"]).toBe("neutral");
    expect(q("#f-credit-tone").textContent).toBe("");
  });

  it("the tone follows the price without a new credit read", async () => {
    await mount({ dph: 0.31 }, { "GET /api/credit": { body: { credit: 1.5, as_of: 1 } } });
    expect(q("#f-credit-box").dataset["tone"]).toBe("ok");
    routes["GET /api/state"] = { body: apiState({ dph: 0.9 }) };
    await app!.refresh();
    expect(calls.filter((c) => c.path === "/api/credit")).toHaveLength(1);
    expect(q("#f-credit-box").dataset["tone"]).toBe("warn");
  });

  it("a member sees no credit anywhere", async () => {
    await mount({ role: "member" });
    expect(q("#f-credit-box").hidden).toBe(true);
    expect(q("#panel-credit").hidden).toBe(true);
    expect(calls.some((c) => c.path === "/api/credit")).toBe(false);
  });

  it("logout from the header still posts {} and shows the login screen", async () => {
    await mount({}, { "POST /auth/logout": { body: { ok: true } } });
    q("#btn-logout").click();
    await flush();
    expect(calls.find((c) => c.method === "POST" && c.path === "/auth/logout")!.body).toEqual({});
    expect(q("#login-screen").hidden).toBe(false);
  });
});

/** z-index of the first rule whose selector list contains `selector` exactly. */
function zIndex(selector: string): number {
  for (const m of CSS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@media[^{]*\{/g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = m[1]!.split(",").map((x) => x.trim());
    const z = /z-index:\s*(\d+)/.exec(m[2]!);
    if (z && selectors.includes(selector)) return Number(z[1]);
  }
  throw new Error(`no z-index for ${selector}`);
}

describe("the panel as a right drawer (below 1280 px)", () => {
  const pill = () => q<HTMLButtonElement>("#status-pill");
  const isOpen = () => panel().classList.contains("open");

  it("starts closed and opens from the pill: backdrop, the page and the menu inert, focus on the panel heading", async () => {
    window.localStorage.setItem("vast-comfy.panel", "open");
    await mount();
    expect(isOpen()).toBe(false);
    expect(pill().getAttribute("aria-expanded")).toBe("false");
    pill().click();
    expect(isOpen()).toBe(true);
    expect(pill().getAttribute("aria-expanded")).toBe("true");
    expect(q("#panel-backdrop").hidden).toBe(false);
    expect(q("#page").hasAttribute("inert")).toBe(true);
    expect(q("#tool-nav").hasAttribute("inert")).toBe(true);
    expect(panel().hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(q("#status-title"));
    // Close is offered in the drawer; Hide belongs to the wide layout.
    expect(q("#panel-close").hidden).toBe(false);
    expect(q("#panel-hide").hidden).toBe(true);
  });

  it("closes with Escape, the backdrop and the close button, and gives the focus back to the pill", async () => {
    await mount();
    for (const close of [() => key(document.activeElement!, "Escape"), () => q("#panel-backdrop").click(), () => q("#panel-close").click()]) {
      pill().focus();
      pill().click();
      expect(isOpen()).toBe(true);
      close();
      expect(isOpen()).toBe(false);
      expect(q("#panel-backdrop").hidden).toBe(true);
      expect(q("#page").hasAttribute("inert")).toBe(false);
      expect(q("#tool-nav").hasAttribute("inert")).toBe(false);
      expect(pill().getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(pill());
    }
  });

  it("traps Tab and Shift+Tab inside the open drawer, skipping hidden controls and the inside of closed sections", async () => {
    await mount({ unknown: [{ vast_instance_id: 11, actual_status: "running", start_date: 1, dph: 0.4 }] });
    pill().click();
    const first = q("#panel-close");
    // The untracked list is a closed section: its summary is the last stop, not the Destroy button inside it.
    const last = q("#unknown-box summary");
    last.focus();
    expect(key(last, "Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(key(first, "Tab", true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    const mid = q("#console-open");
    mid.focus();
    expect(key(mid, "Tab").defaultPrevented).toBe(false);
    // Hidden controls are no stops either.
    q("#btn-destroy").hidden = true;
    q("#unknown-box").hidden = true;
    const lastNow = q("#console-open");
    lastNow.focus();
    expect(key(lastNow, "Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it("does not trap Tab while it is closed", async () => {
    await mount();
    const last = q("#btn-destroy");
    last.focus();
    expect(key(last, "Tab").defaultPrevented).toBe(false);
  });

  it("only one overlay at a time: opening the panel closes the menu drawer and back", async () => {
    setWidth(375);
    await mount();
    q("#menu-open").click();
    expect(q("#tool-nav").classList.contains("open")).toBe(true);
    pill().click();
    expect(q("#tool-nav").classList.contains("open")).toBe(false);
    expect(q("#menu-backdrop").hidden).toBe(true);
    expect(q("#menu-open").getAttribute("aria-expanded")).toBe("false");
    expect(isOpen()).toBe(true);
    q("#menu-open").click();
    expect(isOpen()).toBe(false);
    expect(q("#panel-backdrop").hidden).toBe(true);
    expect(q("#tool-nav").classList.contains("open")).toBe(true);
    expect(q("#page").hasAttribute("inert")).toBe(true);
    expect(q("#tool-nav").hasAttribute("inert")).toBe(false);
  });

  it("closes when the screen becomes wide (the panel is then a column)", async () => {
    await mount();
    pill().click();
    resize(1280);
    expect(isOpen()).toBe(false);
    expect(q("#page").hasAttribute("inert")).toBe(false);
    expect(pill().getAttribute("aria-expanded")).toBe("true");
    expect(q("#panel-hide").hidden).toBe(false);
    expect(q("#panel-close").hidden).toBe(true);
  });

  it("a confirmation opened from the drawer sits above it; Escape closes only the confirmation", async () => {
    await mount();
    pill().click();
    q("#btn-destroy").focus();
    q("#btn-destroy").click();
    await flush();
    expect(q("#modal").hidden).toBe(false);
    key(document.activeElement!, "Escape");
    await flush();
    expect(q("#modal").hidden).toBe(true);
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(q("#btn-destroy"));
    expect(zIndex(".modal")).toBeGreaterThan(zIndex(".status-panel"));
  });

  it("the stacking order: header 10, widget 12, backdrop 15, drawers 20, log dialog 25, confirmation 30", () => {
    expect(zIndex(".top")).toBe(10);
    expect(zIndex(".float-status")).toBe(12);
    expect(zIndex(".backdrop")).toBe(15);
    expect(zIndex(".status-panel")).toBe(20);
    expect(zIndex(".log-dialog")).toBe(25);
    expect(zIndex(".modal")).toBe(30);
  });
});

describe("the panel as a column (from 1280 px)", () => {
  it("the pill does not open a drawer: it brings the panel's heading into focus", async () => {
    setWidth(1280);
    await mount();
    const pill = q<HTMLButtonElement>("#status-pill");
    expect(pill.getAttribute("aria-expanded")).toBe("true");
    pill.click();
    expect(panel().classList.contains("open")).toBe(false);
    expect(q("#page").hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(q("#status-title"));
  });
});

describe("the floating status widget", () => {
  const widget = () => q<HTMLButtonElement>("#float-status");
  const tick = () => { const t = [...timers].reverse().find((x) => x.ms === 1_000)!; t.fn(); };

  it("is one button outside the page with a fixed name; its ticking numbers are hidden from screen readers and never live", async () => {
    await mount();
    const w = widget();
    expect(w.type).toBe("button");
    expect(q("#page").contains(w)).toBe(false);
    expect(w.getAttribute("aria-controls")).toBe("status-panel");
    expect(w.getAttribute("aria-label")).toBe("Server status, open panel");
    expect(w.hasAttribute("aria-live")).toBe(false);
    expect(w.querySelector("[aria-live]")).toBeNull();
    expect(w.getAttribute("role")).toBeNull();
    expect(q(".float-cells").getAttribute("aria-hidden")).toBe("true");
  });

  it("shows uptime, cost so far and idle shutdown while the panel is a closed drawer, and ticks", async () => {
    await mount();
    expect(widget().hidden).toBe(false);
    expect(q("#app").classList.contains("widget-on")).toBe(true);
    expect(q("#float-uptime").textContent).toBe("1h 12m");
    expect(q("#float-cost").textContent).toBe("$0.37");
    expect(q("#float-idle").textContent).toBe("24m 10s");
    expect(q("#float-idle-cell").hidden).toBe(false);
    expect(widget().dataset["tone"]).toBe("ok");
    nowMs += 5_000;
    tick();
    expect(q("#float-idle").textContent).toBe("24m 05s");
    expect(widget().getAttribute("aria-label")).toBe("Server status, open panel");
  });

  it("leaves the idle cell out when there is no idle shutdown, and hides without an uptime", async () => {
    await mount({ state: "booting", remaining: { idle_s: null, failsafe_s: 9600, hard_cap_s: 20400 } });
    expect(widget().hidden).toBe(false);
    expect(q("#float-idle-cell").hidden).toBe(true);
    routes["GET /api/state"] = { body: apiState({ state: "none", uptime_s: null, cost_so_far: null }) };
    await app!.refresh();
    expect(widget().hidden).toBe(true);
    expect(q("#app").classList.contains("widget-on")).toBe(false);
  });

  it("members see it too", async () => {
    await mount({ role: "member" });
    expect(widget().hidden).toBe(false);
  });

  it("is hidden while the panel is a column, and while a drawer, the menu or a confirmation is open", async () => {
    setWidth(375);
    await mount();
    expect(widget().hidden).toBe(false);
    q("#status-pill").click();
    expect(widget().hidden).toBe(true);
    expect(widget().hasAttribute("inert")).toBe(true);
    key(document.activeElement!, "Escape");
    expect(widget().hidden).toBe(false);
    expect(widget().hasAttribute("inert")).toBe(false);
    q("#menu-open").click();
    expect(widget().hidden).toBe(true);
    q("#menu-close").click();
    expect(widget().hidden).toBe(false);
    q("#btn-destroy").click();
    await flush();
    expect(widget().hidden).toBe(true);
    q("#modal-cancel").click();
    await flush();
    expect(widget().hidden).toBe(false);
    resize(1280);
    expect(widget().hidden).toBe(true);
    resize(1000);
    expect(widget().hidden).toBe(false);
  });

  it("opens the drawer and moves the focus to the panel heading; closing gives the focus back to it", async () => {
    await mount();
    widget().focus();
    widget().click();
    expect(panel().classList.contains("open")).toBe(true);
    expect(document.activeElement).toBe(q("#status-title"));
    q("#panel-close").click();
    expect(widget().hidden).toBe(false);
    expect(document.activeElement).toBe(widget());
  });

  it("the Start dialog hides it too", async () => {
    await mount({ state: "none", uptime_s: 30 }, { "GET /api/gpus": { body: { gpus: [] } } });
    expect(widget().hidden).toBe(false);
    q("#btn-start").click();
    await flush();
    expect(q("#modal").hidden).toBe(false);
    expect(widget().hidden).toBe(true);
    q("#modal-cancel").click();
    await flush();
    expect(widget().hidden).toBe(false);
  });
});

describe("hiding the panel column (from 1280 px), remembered", () => {
  const widget = () => q<HTMLButtonElement>("#float-status");
  const collapsed = () => q("#app").classList.contains("panel-collapsed");

  it("Hide collapses it, shows the widget and remembers; the pill or the widget bring it back", async () => {
    setWidth(1280);
    await mount();
    expect(collapsed()).toBe(false);
    expect(widget().hidden).toBe(true);
    q("#panel-hide").click();
    expect(collapsed()).toBe(true);
    expect(window.localStorage.getItem("vast-comfy.panel")).toBe("collapsed");
    expect(q("#status-pill").getAttribute("aria-expanded")).toBe("false");
    expect(widget().hidden).toBe(false);
    expect(document.activeElement).toBe(widget());
    q("#status-pill").click();
    expect(collapsed()).toBe(false);
    expect(window.localStorage.getItem("vast-comfy.panel")).toBe("open");
    expect(document.activeElement).toBe(q("#status-title"));
    expect(q("#page").hasAttribute("inert")).toBe(false);
    q("#panel-hide").click();
    widget().click();
    expect(collapsed()).toBe(false);
    expect(panel().classList.contains("open")).toBe(false); // no drawer at this width
    expect(document.activeElement).toBe(q("#status-title"));
  });

  it("starts collapsed when it was left collapsed, but only at the wide layout; drawers always start closed", async () => {
    window.localStorage.setItem("vast-comfy.panel", "collapsed");
    setWidth(1000);
    await mount();
    expect(collapsed()).toBe(false);
    expect(panel().classList.contains("open")).toBe(false);
    resize(1280);
    expect(collapsed()).toBe(true);
    expect(widget().hidden).toBe(false);
    resize(1279);
    expect(collapsed()).toBe(false);
  });

  it("any other stored value means open", async () => {
    window.localStorage.setItem("vast-comfy.panel", "<b>collapsed</b>");
    setWidth(1440);
    await mount();
    expect(collapsed()).toBe(false);
  });

  it("works without storage (reads and writes throw)", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    setWidth(1280);
    await mount();
    expect(collapsed()).toBe(false);
    q("#panel-hide").click();
    expect(collapsed()).toBe(true);
  });
});

describe("the boot log dialog", () => {
  const dialog = () => q("#console-card");
  const consoleCalls = () => calls.filter((c) => c.path.startsWith("/api/console")).length;

  it("the panel summary shows the stepper, the boot sentence and one View log button", async () => {
    await mount({ state: "downloading", agent_unreachable: true });
    expect(q("#boot-summary").hidden).toBe(false);
    expect([...document.querySelectorAll("#console-steps li")].map((li) => (li as HTMLElement).dataset["status"])).toEqual(["done", "running", "pending"]);
    expect(q("#boot-sentence").hidden).toBe(false);
    expect(q("#boot-sentence").textContent).toBe("Downloading models, this can take several minutes");
    const open = q<HTMLButtonElement>("#console-open");
    expect(open.textContent).toBe("View log");
    expect(open.getAttribute("aria-haspopup")).toBe("dialog");
    expect(q("#boot-summary").querySelectorAll("button")).toHaveLength(1);
  });

  it("opens as a modal dialog over everything else, with the focus inside", async () => {
    setWidth(1280);
    await mount();
    expect(dialog().hidden).toBe(true);
    expect(dialog().getAttribute("role")).toBe("dialog");
    expect(dialog().getAttribute("aria-modal")).toBe("true");
    expect(dialog().getAttribute("aria-labelledby")).toBe("console-title");
    q("#console-open").focus();
    q("#console-open").click();
    expect(dialog().hidden).toBe(false);
    expect(q("#console-backdrop").hidden).toBe(false);
    for (const id of ["page", "status-panel", "tool-nav"]) expect(q(`#${id}`).hasAttribute("inert"), id).toBe(true);
    expect(dialog().hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(q("#console-close"));
    expect(dialog().querySelector("#console-log .cl")!.textContent).toBe("01:00:01 [agent] line 1");
  });

  it("closes with Escape, the backdrop and the close button; the focus goes back to View log", async () => {
    setWidth(1280);
    await mount();
    for (const close of [() => key(document.activeElement!, "Escape"), () => q("#console-backdrop").click(), () => q("#console-close").click()]) {
      q("#console-open").focus();
      q("#console-open").click();
      expect(dialog().hidden).toBe(false);
      close();
      expect(dialog().hidden).toBe(true);
      expect(q("#console-backdrop").hidden).toBe(true);
      expect(q("#page").hasAttribute("inert")).toBe(false);
      expect(panel().hasAttribute("inert")).toBe(false);
      expect(document.activeElement).toBe(q("#console-open"));
    }
  });

  it("opened from the drawer it closes the drawer, and the focus goes back to the pill", async () => {
    setWidth(375);
    await mount();
    q("#status-pill").click();
    q("#console-open").click();
    expect(panel().classList.contains("open")).toBe(false);
    expect(dialog().hidden).toBe(false);
    expect(q<HTMLButtonElement>("#float-status").hidden).toBe(true);
    key(document.activeElement!, "Escape");
    expect(dialog().hidden).toBe(true);
    expect(document.activeElement).toBe(q("#status-pill"));
  });

  it("traps Tab inside the dialog", async () => {
    await mount();
    q("#console-open").click();
    const first = q("#console-close");
    const last = q("#console-download");
    last.focus();
    expect(key(last, "Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(key(first, "Tab", true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it("opening and closing does not change the polling", async () => {
    await mount();
    const n = consoleCalls();
    const pending = timers.filter((t) => t.ms === 3_000).length;
    q("#console-open").click();
    q("#console-close").click();
    await flush();
    expect(consoleCalls()).toBe(n);
    expect(timers.filter((t) => t.ms === 3_000).length).toBe(pending);
  });

  it("closes when the console stops being available (403); the focus falls back to the pill", async () => {
    setWidth(1280);
    await mount();
    q("#console-open").click();
    routes["GET /api/console?after=0"] = { status: 403, body: { error: { code: "forbidden", message: "no" } } };
    await app!.pollConsole();
    expect(dialog().hidden).toBe(true);
    expect(q("#boot-summary").hidden).toBe(true);
    expect(q("#page").hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(q("#status-pill")); // View log is hidden with the summary
  });

  it("closes on logout", async () => {
    await mount({}, { "POST /auth/logout": { body: { ok: true } } });
    q("#console-open").click();
    q<HTMLButtonElement>("#btn-logout").click(); // a test shortcut: the page is inert for a real user
    await flush();
    expect(q("#login-screen").hidden).toBe(false);
    expect(dialog().hidden).toBe(true);
    expect(q("#page").hasAttribute("inert")).toBe(false);
  });

  it("a member has no boot summary and never asks for the console", async () => {
    await mount({ role: "member", agent_unreachable: true });
    expect(q("#boot-summary").hidden).toBe(true);
    expect(dialog().hidden).toBe(true);
    expect(calls.some((c) => c.path.startsWith("/api/console"))).toBe(false);
  });
});
