// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mountApp, type App } from "../../public/ui.js";
import { CONSOLE_POLL_MS } from "../../public/model.js";

const INDEX = readFileSync(join(import.meta.dirname, "../../public/index.html"), "utf8");

interface Reply { status?: number; body: unknown; gate?: Promise<void> }
type Handler = Reply | ((n: number) => Reply);

function apiState(over: Record<string, unknown> = {}) {
  return {
    state: "booting", role: "admin", record: null, vast: null, vast_error: null, agent: null, agent_error: null,
    agent_unreachable: false, failed: null, destroy_failed: null, dph: 0.36, uptime_s: 60, cost_so_far: 0.01,
    progress: null, gpu_name: null, download: null, remaining: { idle_s: 1500, failsafe_s: 9000, hard_cap_s: 20000 },
    unknown: [], presets: [{ name: "p", steps: 7 }], sizes: [{ name: "s", width: 512, height: 512 }], ...over,
  };
}
const line = (seq: number, text = `line ${seq}`, source = "agent") => ({ seq, t: 3600 + seq, source, text });
function consoleBody(over: Record<string, unknown> = {}) {
  return {
    generation: 1,
    instance: { state: "booting", ended: false, ended_reason: null },
    phases: [
      { id: "install_tools", name: "Install tools", status: "done" },
      { id: "tailscale", name: "Join Tailscale", status: "running" },
      { id: "agent", name: "Start agent", status: "pending" },
      { id: "nodes", name: "Install nodes", status: "failed" },
    ],
    lines: [line(1), line(2)],
    last_seq: 2,
    truncated: false,
    source_error: null,
    ...over,
  };
}

let app: App | null = null;
let fetched: string[] = [];
let consoleReplies: Handler[] = [];
let consoleCalls = 0;
let timers: { fn: () => void; ms: number }[] = [];
let stateBody: Record<string, unknown> = {};

async function mount(over: { state?: Record<string, unknown>; console?: Handler[]; me?: Reply } = {}): Promise<App> {
  stateBody = apiState(over.state);
  consoleReplies = over.console ?? [{ body: consoleBody() }];
  consoleCalls = 0;
  app = mountApp(document, {
    fetch: (async (input: RequestInfo | URL) => {
      const path = String(input);
      fetched.push(path);
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
      if (path === "/api/me") return json(over.me?.status ?? 200, over.me?.body ?? { name: "T", username: "t", role: stateBody["role"] });
      if (path === "/auth/logout") return json(200, {});
      if (path === "/api/state") return json(200, stateBody);
      if (path.startsWith("/api/console")) {
        const h = consoleReplies[Math.min(consoleCalls, consoleReplies.length - 1)]!;
        consoleCalls++;
        const r = typeof h === "function" ? h(consoleCalls) : h;
        if (r.gate) await r.gate;
        return json(r.status ?? 200, r.body);
      }
      return json(404, { error: { code: "not_found", message: "no" } });
    }) as typeof fetch,
    now: () => 1_000_000,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => undefined,
  });
  await app.ready;
  await flush();
  return app;
}

const q = <T extends Element = HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const logLines = () => [...document.querySelectorAll("#console-log .cl")].map((n) => n.textContent);
const consolePaths = () => fetched.filter((p) => p.startsWith("/api/console"));
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
}

beforeEach(() => {
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(INDEX)![1]!;
  fetched = [];
  timers = [];
  setHidden(false);
});
afterEach(() => {
  vi.restoreAllMocks();
  app?.stop();
  app = null;
  setHidden(false);
});

describe("boot console: the summary in the server panel", () => {
  it("a member never sees the card and never calls the console endpoint", async () => {
    await mount({ state: { role: "member" } });
    expect(q("#boot-summary").hidden).toBe(true);
    await app!.pollConsole();
    expect(consolePaths()).toEqual([]);
  });

  it("an admin sees the stepper with a mark and a text label for every status", async () => {
    await mount();
    expect(q("#boot-summary").hidden).toBe(false);
    const items = [...document.querySelectorAll("#console-steps li")];
    expect(items.map((li) => (li as HTMLElement).dataset["status"])).toEqual(["done", "running", "pending", "failed"]);
    expect(items.map((li) => li.querySelector(".mark")!.textContent)).toEqual(["✓", "◐", "○", "✗"]);
    expect(items[1]!.textContent).toContain("Join Tailscale");
    expect(items[1]!.querySelector(".sr")!.textContent).toContain("running");
    expect(items[3]!.querySelector(".sr")!.textContent).toContain("failed");
  });

  it("the card stays hidden when there is no instance and nothing ended", async () => {
    await mount({ state: { state: "none" }, console: [{ body: consoleBody({ instance: { state: "none", ended: false, ended_reason: null }, phases: [], lines: [], last_seq: 0 }) }] });
    expect(q("#boot-summary").hidden).toBe(true);
  });

  it("renders lines with time and source tag, in order", async () => {
    await mount();
    expect(logLines()).toEqual(["01:00:01 [agent] line 1", "01:00:02 [agent] line 2"]);
    expect(consolePaths()).toEqual(["/api/console?after=0"]);
  });

  it("asks for lines after the last seq and never duplicates", async () => {
    await mount({ console: [{ body: consoleBody() }, { body: consoleBody({ lines: [line(2), line(3)], last_seq: 3 }) }] });
    await app!.pollConsole();
    expect(consolePaths()).toEqual(["/api/console?after=0", "/api/console?after=2"]);
    expect(logLines()).toHaveLength(3);
    expect(logLines()[2]).toBe("01:00:03 [agent] line 3");
  });

  it("a hostile line stays inert text", async () => {
    const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
    await mount({ console: [{ body: consoleBody({ lines: [line(1, evil, '<b>src</b>')], last_seq: 1 }) }] });
    expect(document.querySelector("#console-log img")).toBeNull();
    expect(document.querySelector("#console-log script")).toBeNull();
    expect(document.querySelector("#console-log b")).toBeNull();
    expect(q("#console-log .cx").textContent).toBe(evil);
    expect((window as unknown as Record<string, unknown>)["__pwned"]).toBeUndefined();
  });

  it("keeps polling on a timer while an instance exists", async () => {
    await mount();
    expect(timers.some((t) => t.ms === CONSOLE_POLL_MS)).toBe(true);
  });

  it("stops polling for good on 403 and hides the card", async () => {
    await mount({ console: [{ status: 403, body: { error: { code: "forbidden", message: "no" } } }] });
    expect(q("#boot-summary").hidden).toBe(true);
    expect(timers.some((t) => t.ms === CONSOLE_POLL_MS)).toBe(false);
    await app!.pollConsole();
    await app!.refresh();
    expect(consolePaths()).toHaveLength(1);
    expect(timers.some((t) => t.ms === CONSOLE_POLL_MS)).toBe(false);
  });

  it("a 401 sends the page to the login screen and stops", async () => {
    await mount({ console: [{ status: 401, body: {} }] });
    expect(q("#login-screen").hidden).toBe(false);
    await app!.pollConsole();
    expect(consolePaths()).toHaveLength(1);
  });

  it("does not poll while the tab is hidden and resumes when it shows", async () => {
    await mount();
    setHidden(true);
    await app!.pollConsole();
    expect(consolePaths()).toHaveLength(1);
    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(consolePaths().length).toBeGreaterThan(1);
  });

  it("backs off after errors and shows a short note", async () => {
    await mount({ console: [{ body: consoleBody() }, { status: 500, body: {} }, { status: 500, body: {} }] });
    timers = [];
    await app!.pollConsole();
    expect(q("#console-error").hidden).toBe(false);
    expect(timers.some((t) => t.ms === CONSOLE_POLL_MS * 2)).toBe(true);
    expect(logLines()).toHaveLength(2); // lines are kept
  });

  it("an ended instance shows the reason, keeps its lines and stops polling", async () => {
    const ended = { instance: { state: "none", ended: true, ended_reason: "boot_timeout" } };
    await mount({ state: { state: "none" }, console: [{ body: consoleBody(ended) }] });
    expect(q("#boot-summary").hidden).toBe(false);
    expect(q("#console-ended").hidden).toBe(false);
    expect(q("#console-ended").textContent).toContain("the boot took too long");
    expect(logLines()).toHaveLength(2);
    expect(timers.some((t) => t.ms === CONSOLE_POLL_MS)).toBe(false);
    await app!.refresh();
    expect(consolePaths()).toHaveLength(1);
  });

  it("a new Start (new generation) replaces the old lines", async () => {
    await mount({ console: [{ body: consoleBody() }, { body: consoleBody({ generation: 2, lines: [line(9, "fresh")], last_seq: 9 }) }] });
    await app!.pollConsole();
    expect(logLines()).toEqual(["01:00:09 [agent] fresh"]);
  });

  it("shows a note when earlier lines were dropped and keeps it for the generation", async () => {
    await mount({ console: [{ body: consoleBody({ truncated: true }) }, { body: consoleBody({ lines: [line(3)], last_seq: 3, truncated: false }) }, { body: consoleBody({ generation: 2, lines: [line(9)], last_seq: 9 }) }] });
    expect(q("#console-note").hidden).toBe(false);
    await app!.pollConsole();
    expect(q("#console-note").hidden).toBe(false);
    await app!.pollConsole(); // a new Start: the note goes away
    expect(q("#console-note").hidden).toBe(true);
  });

  it("an answer in flight at logout is discarded", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await mount({ console: [{ body: consoleBody() }, { body: consoleBody({ lines: [line(3)], last_seq: 3 }), gate }] });
    const inflight = app!.pollConsole();
    await flush();
    q<HTMLButtonElement>("#btn-logout").click();
    await flush();
    expect(q("#login-screen").hidden).toBe(false);
    release();
    await inflight;
    await flush();
    expect(q("#boot-summary").hidden).toBe(true);
    expect(logLines()).toEqual([]);
  });

  it("never overlaps two polls", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await mount({ console: [{ body: consoleBody() }, { body: consoleBody({ lines: [line(3)], last_seq: 3 }), gate }] });
    const first = app!.pollConsole();
    await flush();
    await app!.pollConsole(); // ignored: one is in flight
    expect(consolePaths()).toHaveLength(2);
    release();
    await first;
  });

  it("leaves no console timer behind after stop()", async () => {
    await mount();
    // The harness records timers; stop() must not leave a console poll that could still fire.
    const pending = timers.filter((t) => t.ms === CONSOLE_POLL_MS);
    expect(pending).toHaveLength(1);
    app!.stop();
    const before = consolePaths().length;
    pending[0]!.fn();
    await flush();
    expect(consolePaths()).toHaveLength(before);
  });
});

describe("boot console controls", () => {
  it("the log lives in a closed dialog: no fold toggle and nothing remembered", async () => {
    await mount();
    expect(document.querySelector("#console-toggle")).toBeNull();
    expect(document.querySelector("#console-body")).toBeNull();
    expect(q("#console-card").getAttribute("role")).toBe("dialog");
    expect(q("#console-card").hidden).toBe(true);
    expect(q("#console-card").contains(q("#console-log"))).toBe(true);
    expect(window.localStorage.getItem("vast-comfy.console-collapsed")).toBeNull();
  });

  it("Pause stops polling and Resume polls again", async () => {
    await mount();
    q<HTMLButtonElement>("#console-pause").click();
    expect(q("#console-pause").textContent).toBe("Pause"); // stable label, state in aria-pressed
    expect(q("#console-pause").getAttribute("aria-pressed")).toBe("true");
    const n = consolePaths().length;
    await app!.pollConsole();
    expect(consolePaths()).toHaveLength(n);
    q<HTMLButtonElement>("#console-pause").click();
    await flush();
    expect(consolePaths().length).toBe(n + 1);
    expect(q("#console-pause").getAttribute("aria-pressed")).toBe("false");
  });

  it("Copy writes the visible lines and Clear view hides the old ones", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
    await mount();
    q<HTMLButtonElement>("#console-copy").click();
    await flush();
    expect(writeText).toHaveBeenCalledWith("01:00:01 [agent] line 1\n01:00:02 [agent] line 2\n");
    q<HTMLButtonElement>("#console-clear").click();
    expect(logLines()).toEqual([]);
    q<HTMLButtonElement>("#console-copy").click();
    await flush();
    expect(writeText).toHaveBeenLastCalledWith("");
  });

  it("Copy survives a missing or failing clipboard", async () => {
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
    await mount();
    q<HTMLButtonElement>("#console-copy").click();
    await flush();
    expect(q("#console-status").textContent).toMatch(/could not copy/i);
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: undefined });
    q<HTMLButtonElement>("#console-copy").click();
    await flush();
    expect(q("#console-status").textContent).toMatch(/could not copy/i);
  });

  it("Download builds a text Blob from the visible lines", async () => {
    const blobs: Blob[] = [];
    const urlApi = window.URL as unknown as Record<string, unknown>;
    urlApi["createObjectURL"] = (b: Blob) => { blobs.push(b); return "blob:test"; };
    urlApi["revokeObjectURL"] = () => undefined;
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await mount();
    q("#console-clear").click();
    await app!.pollConsole();
    q("#console-download").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(q("#console-status").textContent).toBe("Downloaded.");
    expect(blobs).toHaveLength(1);
    expect(blobs[0]!.type).toContain("text/plain");
    expect(await blobs[0]!.text()).toBe("");
    expect(click).toHaveBeenCalled();
  });
});

describe("boot console scrolling", () => {
  function geometry(el: HTMLElement, o: { top: number; client: number; height: number }) {
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => o.client });
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => o.height });
    el.scrollTop = o.top;
  }

  it("follows new lines at the bottom, stays put after scrolling up, and resumes at the bottom", async () => {
    await mount({ console: [{ body: consoleBody() }, { body: consoleBody({ lines: [line(3)], last_seq: 3 }) }, { body: consoleBody({ lines: [line(4)], last_seq: 4 }) }, { body: consoleBody({ lines: [line(5)], last_seq: 5 }) }] });
    const log = q("#console-log");
    geometry(log, { top: 400, client: 100, height: 500 });
    log.dispatchEvent(new Event("scroll"));
    await app!.pollConsole(); // at the bottom: follows
    expect(log.scrollTop).toBe(log.scrollHeight);
    geometry(log, { top: 0, client: 100, height: 600 });
    log.dispatchEvent(new Event("scroll"));
    await app!.pollConsole(); // scrolled up: not moved
    expect(log.scrollTop).toBe(0);
    geometry(log, { top: 500, client: 100, height: 600 });
    log.dispatchEvent(new Event("scroll"));
    await app!.pollConsole(); // back at the bottom: follows again
    expect(log.scrollTop).toBe(log.scrollHeight);
  });
});

describe("boot sentence", () => {
  it("replaces the agent warning while a boot phase is running", async () => {
    const phases = [{ id: "install_tools", name: "Install tools", status: "done" }, { id: "tailscale", name: "Join Tailscale", status: "running" }];
    await mount({ state: { agent_unreachable: true }, console: [{ body: consoleBody({ phases }) }] });
    expect(q("#alert-agent").hidden).toBe(true);
    expect(q("#boot-sentence").hidden).toBe(false);
    expect(q("#boot-sentence").textContent).toBe("Installing tools and joining Tailscale, usually 2-4 minutes");
  });

  it("keeps the old warning when no phase is running", async () => {
    await mount({ state: { agent_unreachable: true }, console: [{ body: consoleBody({ phases: [] }) }] });
    expect(q("#alert-agent").hidden).toBe(false);
    expect(q("#boot-sentence").hidden).toBe(true);
  });

  it("members keep the old warning", async () => {
    await mount({ state: { role: "member", agent_unreachable: true } });
    expect(q("#alert-agent").hidden).toBe(false);
    expect(q("#boot-sentence").hidden).toBe(true);
  });
});
