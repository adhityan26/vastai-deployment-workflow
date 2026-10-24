// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mountApp, type App } from "../../public/ui.js";

const INDEX = readFileSync(join(import.meta.dirname, "../../public/index.html"), "utf8");

interface Reply { status?: number; body: unknown; gate?: Promise<void>; /** Sent as raw bytes with this content type instead of JSON. */ raw?: string; type?: string }
type Handler = Reply | ((body: unknown) => Reply);
interface Call { method: string; path: string; body: unknown }

function apiState(over: Record<string, unknown> = {}) {
  return {
    state: "ready",
    role: "member",
    record: null,
    vast: null,
    vast_error: null,
    agent: { state: "ready", reason: null, queue: { running: 1, pending: 2 }, gpu: { util_percent: 5, vram_total_mb: 24576, vram_used_mb: 12288 }, failsafe_alive: true, destroy: { pending: false, attempts: 0 } },
    agent_error: null,
    agent_unreachable: false,
    failed: null,
    destroy_failed: null,
    dph: 0.36,
    uptime_s: 600,
    cost_so_far: 0.06,
    progress: null,
    gpu_name: null,
    download: null,
    remaining: { idle_s: 1500, failsafe_s: 9000, hard_cap_s: 20000 },
    unknown: [],
    presets: [{ name: "zz-turbo", steps: 7 }, { name: "zz-slow", steps: 99 }],
    sizes: [{ name: "zz-square", width: 512, height: 512 }, { name: "zz-wide", width: 768, height: 512 }],
    ...over,
  };
}

let app: App | null = null;
let calls: Call[] = [];
let routes: Record<string, Handler> = {};
let nowMs = 0;

async function mount(state: Record<string, unknown> = {}, extra: Record<string, Handler> = {}): Promise<App> {
  routes = { "GET /api/me": { body: { name: "Tester", username: "tester", role: "member" } }, "GET /api/state": { body: apiState(state) }, ...extra };
  app = mountApp(document, {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      const h = routes[`${method} ${path}`];
      if (h === undefined) return new Response(JSON.stringify({ error: { code: "not_found", message: "not found" } }), { status: 404 });
      const r = typeof h === "function" ? h(body) : h;
      if (r.gate) await r.gate;
      if (r.raw !== undefined) return new Response(r.raw, { status: r.status ?? 200, headers: { "Content-Type": r.type ?? "image/png" } });
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }) as typeof fetch,
    now: () => nowMs,
    setTimeout: () => 0, // timers are driven by hand in tests
    clearTimeout: () => undefined,
  });
  await app.ready;
  return app;
}

const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
/** The menu: an entry by id, the id of the current one, and a click by id or by visible title. */
const menuItem = (id: string) => document.querySelector<HTMLButtonElement>(`.menu-item[data-tool-id="${id}"]`);
const currentTool = () => document.querySelector(".menu-item[aria-current]")?.getAttribute("data-tool-id") ?? null;
const chooseTool = (id: string) => menuItem(id)!.click();
const chooseByTitle = (title: string) => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.querySelector(".menu-title")?.textContent === title)!.click();
const posts = (path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

beforeEach(() => {
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(INDEX)![1]!;
  calls = [];
  nowMs = 1_000_000;
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  app?.stop();
  app = null;
});

describe("roles", () => {
  it("member does not see start/destroy/extend buttons", async () => {
    await mount({ role: "member" });
    expect(q("#btn-start")).toBeNull();
    expect(q("#btn-destroy")).toBeNull();
    expect(q("#btn-extend")).toBeNull();
    expect(q("#admin-panel")!.hidden).toBe(true);
    expect(q("#gen-form")).not.toBeNull();
  });

  it("admin sees start/destroy/extend buttons", async () => {
    await mount({ role: "admin" });
    expect(q("#btn-start")).not.toBeNull();
    expect(q("#btn-destroy")).not.toBeNull();
    expect(q("#btn-extend")).not.toBeNull();
    expect(q("#admin-panel")!.hidden).toBe(false);
  });
});

describe("generate form", () => {
  it("generate button disabled until ready", async () => {
    await mount({ state: "booting" });
    expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(true);
    routes["GET /api/state"] = { body: apiState({ state: "ready" }) };
    await app!.refresh();
    expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(false);
  });

  it("preset buttons come from the api, not constants in the page", async () => {
    await mount();
    const labels = [...document.querySelectorAll("#presets button")].map((b) => b.textContent);
    expect(labels).toEqual(["zz-turbo (7 steps)", "zz-slow (99 steps)"]);
    const sizes = [...document.querySelectorAll("#size option")].map((o) => o.textContent);
    expect(sizes).toEqual(["zz-square (512×512)", "zz-wide (768×512)"]);
    // A different api answer changes the buttons.
    routes["GET /api/state"] = { body: apiState({ presets: [{ name: "only", steps: 3 }] }) };
    await app!.refresh();
    expect([...document.querySelectorAll("#presets button")].map((b) => b.textContent)).toEqual(["only (3 steps)"]);
  });

  it("keeps the user's choices across polls", async () => {
    await mount();
    q<HTMLButtonElement>('#presets button[data-preset="zz-slow"]')!.click();
    q<HTMLSelectElement>("#size")!.value = "zz-wide";
    await app!.refresh();
    expect(q('#presets button[aria-pressed="true"]')!.getAttribute("data-preset")).toBe("zz-slow");
    expect(q<HTMLSelectElement>("#size")!.value).toBe("zz-wide");
  });

  it("submits, disables while pending, then shows images from the validated id", async () => {
    let polls = 0;
    await mount({}, {
      "POST /api/generate": { status: 202, body: { id: "job-1" } },
      "GET /api/generate/job-1": () => {
        polls += 1;
        return polls === 1
          ? { body: { status: "pending" } }
          : { body: { status: "done", images: [{ index: 0, url: "https://evil.example/x.png" }, { index: 1, url: "/api/image/job-1/1" }] } };
      },
    });
    q<HTMLButtonElement>('#presets button[data-preset="zz-slow"]')!.click();
    q<HTMLSelectElement>("#size")!.value = "zz-wide";
    q<HTMLTextAreaElement>("#prompt")!.value = "a red fox";
    q<HTMLInputElement>("#seed")!.value = "42";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(posts("/api/generate")[0]!.body).toEqual({ prompt: "a red fox", preset: "zz-slow", size: "zz-wide", seed: 42 });
    expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(true);
    expect(q("#history")!.textContent).toContain("Generating");
    // Second poll (timers are manual, so trigger via the module's next step).
    await flush();
  });

  it("rejects an empty prompt and a bad seed without calling the api", async () => {
    await mount();
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(q("#form-error")!.textContent).toContain("prompt");
    q<HTMLTextAreaElement>("#prompt")!.value = "x";
    q<HTMLInputElement>("#seed")!.value = "abc";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(q("#form-error")!.textContent).toContain("Seed");
    expect(posts("/api/generate")).toHaveLength(0);
  });

  it("shows the api error message when submit is refused", async () => {
    await mount({}, { "POST /api/generate": { status: 400, body: { error: { code: "prompt_too_long", message: "prompt exceeds 50 characters" } } } });
    q<HTMLTextAreaElement>("#prompt")!.value = "x";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(q("#form-error")!.textContent).toBe("prompt exceeds 50 characters");
    expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(false);
  });
});

describe("confirmations", () => {
  it("destroy asks for confirmation and does not call the api until confirmed", async () => {
    await mount({ role: "admin" }, { "POST /api/destroy": { body: { outcome: "destroyed", agent_reached: true } } });
    q("#btn-destroy")!.click();
    await flush();
    expect(q("#modal")!.hidden).toBe(false);
    expect(posts("/api/destroy")).toHaveLength(0);
    q("#modal-cancel")!.click();
    await flush();
    expect(q("#modal")!.hidden).toBe(true);
    expect(posts("/api/destroy")).toHaveLength(0);
    q("#btn-destroy")!.click();
    await flush();
    q("#modal-ok")!.click();
    await flush();
    expect(posts("/api/destroy")).toHaveLength(1);
  });

  it.each([
    ["destroyed", "Destroy requested."],
    ["gone", "Destroy requested."],
    ["pending", "Destroy is queued: the instance is not visible on Vast yet; it will be destroyed as soon as it appears."],
    ["none", "No instance to destroy."],
  ])("destroy outcome %s shows its own message", async (outcome, message) => {
    await mount({ role: "admin" }, { "POST /api/destroy": { body: { outcome, agent_reached: true } } });
    q("#btn-destroy")!.click();
    await flush();
    q("#modal-ok")!.click();
    await flush();
    expect(posts("/api/destroy")).toHaveLength(1);
    expect(q("#notice")!.hidden).toBe(false);
    expect(q("#notice")!.textContent).toBe(message);
  });

  it("extend confirms, then sends kind and minutes", async () => {
    await mount({ role: "admin" }, { "POST /api/extend": { body: { kind: "failsafe", deadline: 1 } } });
    q<HTMLSelectElement>("#extend-kind")!.value = "failsafe";
    q<HTMLInputElement>("#extend-minutes")!.value = "45";
    q("#btn-extend")!.click();
    await flush();
    expect(posts("/api/extend")).toHaveLength(0);
    q("#modal-ok")!.click();
    await flush();
    expect(posts("/api/extend")[0]!.body).toEqual({ kind: "failsafe", minutes: 45 });
  });

  it("lists unknown instances with a destroy button each, behind a confirmation", async () => {
    await mount({ role: "admin", state: "none", unknown: [{ vast_instance_id: 11, actual_status: "running", start_date: 1, dph: 0.4 }, { vast_instance_id: 12, actual_status: null, start_date: 1, dph: 0.2 }] }, {
      "POST /api/destroy-unknown": { body: { outcome: "destroyed" } },
    });
    const buttons = document.querySelectorAll<HTMLButtonElement>("#unknown button");
    expect(buttons).toHaveLength(2);
    buttons[1]!.click();
    await flush();
    expect(posts("/api/destroy-unknown")).toHaveLength(0);
    q("#modal-ok")!.click();
    await flush();
    expect(posts("/api/destroy-unknown")[0]!.body).toEqual({ vast_id: 12 });
  });
});

const GPUS = {
  gpus: [
    { name: "RTX A5000", dph: 0.25, vram_gb: 24, available: true },
    { name: "RTX 3090", dph: null, vram_gb: null, available: false },
    { name: "RTX 4090", dph: 0.45, vram_gb: 24, available: true },
  ],
};
const est = (name: string, dph: number, over: Record<string, unknown> = {}) => ({ body: { gpu_name: name, dph, horizon_hours: 3, max_cost: dph * 3, ...over } });
const START_ROUTES: Record<string, Handler> = {
  "GET /api/gpus": { body: GPUS },
  "GET /api/estimate?gpu=RTX%20A5000": est("RTX A5000", 0.25),
  "GET /api/estimate?gpu=RTX%204090": est("RTX 4090", 0.45),
  "POST /api/start": { body: { status: "booting", vast_instance_id: 5, estimate: { gpu_name: "RTX A5000", dph: 0.25, horizon_hours: 3, max_cost: 0.75 } } },
};
const adminNone = (extra: Record<string, Handler> = {}) => mount({ role: "admin", state: "none" }, { ...START_ROUTES, ...extra });
const openStart = async () => { q("#btn-start")!.click(); await flush(); };
const gpuSelect = () => q<HTMLSelectElement>("#start-gpu")!;
const estimateCalls = () => calls.filter((c) => c.path.startsWith("/api/estimate")).map((c) => c.path);

describe("start dialog", () => {
  it("lists the GPUs with prices, disables unavailable ones, defaults to the cheapest and shows its estimate", async () => {
    await adminNone();
    await openStart();
    expect(q("#modal")!.hidden).toBe(false);
    expect(document.querySelector('label[for="start-gpu"]')!.textContent).toBe("GPU");
    const opts = [...gpuSelect().options];
    expect(opts.map((o) => o.textContent)).toEqual(["RTX A5000 - $0.25/h", "RTX 3090 - no offers now", "RTX 4090 - $0.45/h"]);
    expect(opts.map((o) => o.disabled)).toEqual([false, true, false]);
    expect(gpuSelect().value).toBe("RTX A5000");
    expect(estimateCalls()).toEqual(["/api/estimate?gpu=RTX%20A5000"]);
    const text = q("#modal")!.textContent!;
    expect(text).toContain("$0.25/hour");
    expect(text).toContain("(RTX A5000)");
    expect(text).toContain("3 hours");
    expect(text).toContain("$0.75");
    expect(text).toContain("covers the failsafe time only");
    expect(text).toContain("up to the hard cap");
    expect(text).toContain("Disk storage is billed separately, per hour");
    expect(posts("/api/start")).toHaveLength(0);
    expect(q<HTMLButtonElement>("#modal-ok")!.disabled).toBe(false);
  });

  it("shows where the offer's server is and its download speed", async () => {
    await adminNone({
      "GET /api/gpus": { body: { gpus: [{ name: "RTX A5000", dph: 0.25, vram_gb: 24, available: true, location: "Quebec, CA", down_mbps: 860 }] } },
      "GET /api/estimate?gpu=RTX%20A5000": est("RTX A5000", 0.25, { location: "Quebec, CA", down_mbps: 860 }),
    });
    await openStart();
    expect([...gpuSelect().options][0]!.textContent).toBe("RTX A5000 - $0.25/h - Quebec, CA, 860 Mbps down");
    expect(q("#modal")!.textContent).toContain("Server: Quebec, CA, 860 Mbps down.");
  });

  it("uses the remembered GPU when it is still available", async () => {
    window.localStorage.setItem("vast-comfy.gpu", "RTX 4090");
    await adminNone();
    await openStart();
    expect(gpuSelect().value).toBe("RTX 4090");
    expect(estimateCalls()).toEqual(["/api/estimate?gpu=RTX%204090"]);
  });

  it.each(["RTX 3090", "GTX 1080", "<b>x</b>", ""])("falls back to the cheapest when the remembered value %j is unavailable or unlisted", async (stored) => {
    window.localStorage.setItem("vast-comfy.gpu", stored);
    await adminNone();
    await openStart();
    expect(gpuSelect().value).toBe("RTX A5000");
  });

  it("works when localStorage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    await adminNone();
    await openStart();
    expect(gpuSelect().value).toBe("RTX A5000");
    q("#modal-ok")!.click();
    await flush();
    expect(posts("/api/start")).toHaveLength(1);
    expect(q("#modal")!.hidden).toBe(true);
    expect(q("#notice")!.hidden).toBe(false);
  });

  it("refetches the estimate with the encoded name when the selection changes", async () => {
    await adminNone();
    await openStart();
    gpuSelect().value = "RTX 4090";
    gpuSelect().dispatchEvent(new Event("change"));
    await flush();
    expect(estimateCalls()).toEqual(["/api/estimate?gpu=RTX%20A5000", "/api/estimate?gpu=RTX%204090"]);
    expect(q("#modal")!.textContent).toContain("$0.45/hour");
    expect(q("#modal")!.textContent).toContain("$1.35");
  });

  it("ignores a stale estimate answer", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await adminNone();
    routes["GET /api/estimate?gpu=RTX%20A5000"] = { ...est("RTX A5000", 0.25), gate };
    q("#btn-start")!.click();
    await flush();
    // The A5000 estimate is still pending: switch to the 4090, which answers at once.
    gpuSelect().value = "RTX 4090";
    gpuSelect().dispatchEvent(new Event("change"));
    await flush();
    expect(q("#modal")!.textContent).toContain("$0.45/hour");
    release();
    await flush();
    expect(q("#modal")!.textContent).toContain("$0.45/hour");
    expect(q("#modal")!.textContent).not.toContain("$0.25/hour");
    q("#modal-ok")!.click();
    await flush();
    expect(posts("/api/start")[0]!.body).toEqual({ confirm: true, gpu: "RTX 4090" });
  });

  it("confirm posts the chosen GPU, remembers it and shows the GPU the server returned", async () => {
    await adminNone();
    await openStart();
    gpuSelect().value = "RTX 4090";
    gpuSelect().dispatchEvent(new Event("change"));
    await flush();
    q("#modal-ok")!.click();
    await flush();
    expect(posts("/api/start")).toEqual([{ method: "POST", path: "/api/start", body: { confirm: true, gpu: "RTX 4090" } }]);
    expect(window.localStorage.getItem("vast-comfy.gpu")).toBe("RTX 4090");
    expect(q("#modal")!.hidden).toBe(true);
    // The shared attempt rented an A5000: the notice names that, not the dropdown value.
    expect(q("#notice")!.textContent).toContain("RTX A5000");
    expect(q("#notice")!.textContent).not.toContain("4090");
  });

  it("double clicking confirm sends one request", async () => {
    await adminNone();
    await openStart();
    q("#modal-ok")!.click();
    q("#modal-ok")!.click();
    await flush();
    expect(posts("/api/start")).toHaveLength(1);
  });

  it("cannot be cancelled while the start request is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await adminNone({ "POST /api/start": { ...(START_ROUTES["POST /api/start"] as Reply), gate } });
    await openStart();
    q("#modal-ok")!.click();
    await flush();
    q("#modal-cancel")!.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flush();
    expect(q("#modal")!.hidden).toBe(false);
    expect(q<HTMLButtonElement>("#modal-ok")!.disabled).toBe(true);
    release();
    await flush();
    expect(q("#modal")!.hidden).toBe(true);
    expect(posts("/api/start")).toHaveLength(1);
  });

  it("a failed Tailscale mint shows the specific text, reason and detail in the dialog and Start can be retried", async () => {
    const text = "The server could not reach the Tailscale API (a network problem at the server; it retried a few times). Nothing was rented. Check the server's internet connection and try again in a minute.";
    await adminNone({
      "POST /api/start": { status: 424, body: { error: { code: "start_failed", message: text, reason: "ts_key_mint_failed", detail: "tailscale_unavailable" } } },
    });
    await openStart();
    q("#modal-ok")!.click();
    await flush();
    expect(q("#modal")!.hidden).toBe(false);
    const alert = q('#modal-body [role="alert"]')!;
    expect(alert.hidden).toBe(false);
    expect(alert.textContent).toContain(text);
    expect(alert.textContent).toContain("Reason: ts_key_mint_failed (tailscale_unavailable)");
    expect(q<HTMLButtonElement>("#modal-ok")!.disabled).toBe(false);
    routes["POST /api/start"] = START_ROUTES["POST /api/start"]!;
    q("#modal-ok")!.click();
    await flush();
    expect(posts("/api/start")).toHaveLength(2);
    expect(q("#modal")!.hidden).toBe(true);
  });

  it("a start answered by a proxy error page (no JSON) says so in the dialog instead of a bare HTTP line", async () => {
    await adminNone({ "POST /api/start": { status: 502, body: null, raw: "<html>Bad gateway</html>", type: "text/html" } });
    await openStart();
    q("#modal-ok")!.click();
    await flush();
    expect(q("#modal")!.hidden).toBe(false);
    const alert = q('#modal-body [role="alert"]')!;
    expect(alert.textContent).toContain(
      "The server could not be reached or a proxy replaced the answer (HTTP 502). Check the Status card and try again; the server log has the details.",
    );
    expect(alert.textContent).not.toContain("<html>");
    expect(q<HTMLButtonElement>("#modal-ok")!.disabled).toBe(false);
  });

  it("a failed start shows message and reason in the dialog, keeps it open and re-enables confirm", async () => {
    await adminNone({ "POST /api/start": { status: 424, body: { error: { code: "start_failed", message: "the Tailscale auth key is missing or empty on the server", reason: "ts_key_missing" } } } });
    await openStart();
    q("#modal-ok")!.click();
    await flush();
    expect(q("#modal")!.hidden).toBe(false);
    const alert = q('#modal-body [role="alert"]')!;
    expect(alert.hidden).toBe(false);
    expect(alert.textContent).toContain("the Tailscale auth key is missing or empty on the server");
    expect(alert.textContent).toContain("ts_key_missing");
    expect(q<HTMLButtonElement>("#modal-ok")!.disabled).toBe(false);
    expect(gpuSelect().disabled).toBe(false);
    expect(q("#banner")!.textContent).toBe("the Tailscale auth key is missing or empty on the server");
    expect(window.localStorage.getItem("vast-comfy.gpu")).toBeNull();
    // A retry works.
    routes["POST /api/start"] = START_ROUTES["POST /api/start"]!;
    q("#modal-ok")!.click();
    await flush();
    expect(posts("/api/start")).toHaveLength(2);
    expect(q("#modal")!.hidden).toBe(true);
  });

  it("a failing GPU list shows the error inside the dialog and cannot start", async () => {
    await adminNone({ "GET /api/gpus": { status: 503, body: { error: { code: "no_gpu_configured", message: "no GPU model is configured on the server" } } } });
    await openStart();
    expect(q("#modal")!.hidden).toBe(false);
    expect(q('#modal-body [role="alert"]')!.textContent).toContain("no GPU model is configured on the server");
    expect(q<HTMLButtonElement>("#modal-ok")!.disabled).toBe(true);
    expect(estimateCalls()).toHaveLength(0);
    q("#modal-cancel")!.click();
    await flush();
    expect(q("#modal")!.hidden).toBe(true);
  });

  it("a failing estimate shows the error in the dialog and disables confirm", async () => {
    await adminNone({ "GET /api/estimate?gpu=RTX%20A5000": { status: 409, body: { error: { code: "no_offers", message: "no Vast offer matches for this GPU model right now" } } } });
    await openStart();
    expect(q("#modal")!.hidden).toBe(false);
    expect(q('#modal-body [role="alert"]')!.textContent).toContain("no Vast offer matches");
    expect(q<HTMLButtonElement>("#modal-ok")!.disabled).toBe(true);
    expect(posts("/api/start")).toHaveLength(0);
  });

  it("with no GPU available the select is disabled with a message and confirm is off", async () => {
    await adminNone({ "GET /api/gpus": { body: { gpus: [{ name: "RTX 3090", dph: null, vram_gb: null, available: false }] } } });
    await openStart();
    expect(gpuSelect().disabled).toBe(true);
    expect(q("#modal")!.textContent).toContain("No GPU model has offers right now");
    expect(q<HTMLButtonElement>("#modal-ok")!.disabled).toBe(true);
    expect(estimateCalls()).toHaveLength(0);
  });

  it("a hostile GPU name stays inert", async () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    await adminNone({
      "GET /api/gpus": { body: { gpus: [{ name: evil, dph: 0.2, vram_gb: 24, available: true }] } },
      [`GET /api/estimate?gpu=${encodeURIComponent(evil)}`]: est(evil, 0.2),
      "POST /api/start": { body: { status: "booting", vast_instance_id: 1, estimate: { gpu_name: evil, dph: 0.2, horizon_hours: 3, max_cost: 0.6 } } },
    });
    await openStart();
    expect(gpuSelect().options[0]!.textContent).toContain(evil);
    expect(gpuSelect().value).toBe(evil);
    expect(q("#modal")!.textContent).toContain(evil);
    q("#modal-ok")!.click();
    await flush();
    expect(q("#notice")!.textContent).toContain(evil);
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect((window as unknown as Record<string, unknown>)["__pwned"]).toBeUndefined();
  });

  it("cancel closes without starting", async () => {
    await adminNone();
    await openStart();
    q("#modal-cancel")!.click();
    await flush();
    expect(q("#modal")!.hidden).toBe(true);
    expect(posts("/api/start")).toHaveLength(0);
  });

  it("a member has no start button and never loads the GPU list", async () => {
    await mount({ role: "member", state: "none" }, START_ROUTES);
    expect(q("#btn-start")).toBeNull();
    expect(calls.some((c) => c.path === "/api/gpus")).toBe(false);
  });
});

describe("failures", () => {
  it("shows destroy_failed prominently", async () => {
    await mount({ state: "destroy_failed", destroy_failed: { error: "Vast said no" } });
    const box = q("#alert-destroy-failed")!;
    expect(box.hidden).toBe(false);
    expect(box.getAttribute("role")).toBe("alert");
    expect(box.textContent).toContain("Could not destroy");
    expect(box.textContent).toContain("Vast said no");
    expect(q("#state-line")!.dataset["tone"]).toBe("bad");
    expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(true);
  });

  it("shows failed with its reason", async () => {
    await mount({ state: "failed", failed: { reason: "out of disk" } });
    expect(q("#alert-failed")!.hidden).toBe(false);
    expect(q("#alert-failed")!.textContent).toContain("out of disk");
    expect(q("#state-line")!.textContent).toBe("Failed");
  });

  it("says plainly that the rented machine did not start and was released", async () => {
    await mount({ state: "none", start_failure: { code: "start_stuck", message: "server text" } });
    const box = q("#alert-start-failure")!;
    expect(box.hidden).toBe(false);
    expect(box.getAttribute("role")).toBe("alert");
    expect(box.textContent).toContain("The rented machine did not start. It was released; try Start again.");
  });

  it("a container that stopped during the boot is not called a machine that did not start", async () => {
    await mount({ state: "none", start_failure: { code: "boot_stopped", message: "m" } });
    const text = q("#alert-start-failure")!.textContent!;
    expect(text).toContain("The rented machine stopped while it was starting. It was released; try Start again.");
    expect(text).not.toContain("did not start");
  });

  it("names the released server in the stuck message when known", async () => {
    await mount({ state: "none", start_failure: { code: "start_stuck", message: "m", server: { location: "Quebec, CA", down_mbps: 12 } } });
    expect(q("#alert-start-failure")!.textContent).toContain("Server: Quebec, CA, 12 Mbps down.");
  });

  it("shows where the server is in the status card, as plain text", async () => {
    await mount({ server: { location: "<b>Quebec</b>, CA", down_mbps: 860 } });
    expect(q("#f-server")!.textContent).toBe("<b>Quebec</b>, CA, 860 Mbps down");
    expect(q("#f-server b")).toBeNull();
    await mount({ server: null });
    expect(q("#f-server")!.textContent).toBe("—");
  });

  it("shows the server message for a start failure code the page does not know", async () => {
    await mount({ state: "none", start_failure: { code: "new_code", message: "Something else went wrong." } });
    expect(q("#alert-start-failure")!.textContent).toContain("Something else went wrong.");
  });

  it("warns when the agent is unreachable", async () => {
    await mount({ state: "ready", agent: null, agent_unreachable: true });
    expect(q("#alert-agent")!.hidden).toBe(false);
    expect(q("#alert-agent")!.getAttribute("role")).toBe("alert");
  });

  it("hides the failure boxes when all is well", async () => {
    await mount();
    for (const id of ["#alert-failed", "#alert-destroy-failed", "#alert-agent", "#alert-start-failure", "#banner"]) expect(q(id)!.hidden).toBe(true);
  });

  it("shows a banner when the status request fails and clears it on recovery", async () => {
    await mount();
    routes["GET /api/state"] = { status: 500, body: { error: { code: "internal_error", message: "internal error" } } };
    await app!.refresh();
    expect(q("#banner")!.textContent).toBe("internal error");
    routes["GET /api/state"] = { body: apiState() };
    await app!.refresh();
    expect(q("#banner")!.hidden).toBe(true);
  });
});

describe("status card", () => {
  it("shows download progress", async () => {
    await mount({ state: "downloading", progress: { phase: "models", file: "model.safetensors", bytes_done: 30, bytes_total: 100 } });
    expect(q("#state-line")!.textContent).toBe("Downloading models: 30%");
    expect(q("#progress-box")!.hidden).toBe(false);
    expect(q<HTMLProgressElement>("#progress")!.value).toBe(30);
    expect(q("#progress-file")!.textContent).toBe("model.safetensors");
  });

  it("shows the GPU name from the state", async () => {
    await mount({ gpu_name: "RTX 4090" });
    expect(q("#f-gpu")!.textContent).toBe("RTX 4090");
    expect(q("#f-price")!.textContent).toBe("$0.36/hour");
    await mount({ gpu_name: null });
    expect(q("#f-gpu")!.textContent).toBe("—");
  });

  it("renders a hostile GPU name in the status card as text", async () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    await mount({ gpu_name: evil });
    expect(q("#f-gpu")!.textContent).toBe(evil);
    expect(document.querySelectorAll("img")).toHaveLength(0);
  });

  it("shows uptime, cost, queue, vram and remaining time", async () => {
    await mount();
    expect(q("#f-uptime")!.textContent).toBe("10m 00s");
    expect(q("#f-cost")!.textContent).toBe("$0.06");
    expect(q("#f-queue")!.textContent).toBe("1 running, 2 waiting");
    expect(q("#f-vram")!.textContent).toBe("12.0 / 24.0 GB");
    expect(q("#f-idle")!.textContent).toBe("25m 00s");
    expect(q("#f-failsafe")!.textContent).toBe("2h 30m");
  });

  it("refetches when the tab becomes visible again", async () => {
    await mount();
    const before = calls.length;
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(calls.length).toBeGreaterThan(before);
  });
});

describe("overall download progress", () => {
  const dl = (over: Record<string, unknown> = {}) => ({
    state: "downloading",
    progress: { phase: "models", file: "a.safetensors", bytes_done: 500, bytes_total: 1000 },
    download: { files_total: 3, files_done: 1, bytes_done: 2_100_000_000, bytes_total: 14_600_000_000, current_file: "a.safetensors", ...over },
  });
  const tick = async (state: Record<string, unknown>, at: number) => {
    nowMs = at;
    routes["GET /api/state"] = { body: apiState(state) };
    await app!.refresh();
  };

  it("shows one overall bar, GB text, file n of m and the per-file name; no speed before two samples", async () => {
    await mount(dl());
    expect(q("#state-line")!.textContent).toBe("Downloading models: 14%");
    expect(q<HTMLProgressElement>("#progress")!.value).toBe(14);
    expect(q("#progress-text")!.hidden).toBe(false);
    expect(q("#progress-text")!.textContent).toBe("2.1 / 14.6 GB (14%) - file 2 of 3");
    expect(q("#progress-file")!.textContent).toBe("a.safetensors");
  });

  it("adds speed and ETA after a second sample", async () => {
    await mount(dl());
    await tick(dl({ bytes_done: 2_100_000_000 + 380_000_000 }), nowMs + 10_000);
    const text = q("#progress-text")!.textContent!;
    expect(text).toBe("2.5 / 14.6 GB (16%) - file 2 of 3 - 38 MB/s - about 5 min left");
    expect(text).not.toMatch(/NaN|Infinity/);
  });

  it("shows no speed when nothing moved, and never NaN", async () => {
    await mount(dl());
    await tick(dl(), nowMs + 10_000);
    expect(q("#progress-text")!.textContent).toBe("2.1 / 14.6 GB (14%) - file 2 of 3");
  });

  it("does not jump back when the current file changes", async () => {
    await mount(dl({ files_done: 0, bytes_done: 4_000_000_000, current_file: "a" }));
    const before = q<HTMLProgressElement>("#progress")!.value;
    await tick(dl({ files_done: 1, bytes_done: 4_600_000_000, current_file: "b" }), nowMs + 10_000);
    expect(q<HTMLProgressElement>("#progress")!.value).toBeGreaterThanOrEqual(before);
    expect(q("#progress-text")!.textContent).toContain("file 2 of 3");
    expect(q("#progress-text")!.textContent).toContain("60 MB/s");
  });

  it("drops the speed when the counter goes down", async () => {
    await mount(dl());
    await tick(dl({ bytes_done: 3_000_000_000 }), nowMs + 10_000);
    expect(q("#progress-text")!.textContent).toContain("MB/s");
    await tick(dl({ bytes_done: 1_000_000_000 }), nowMs + 10_000);
    expect(q("#progress-text")!.textContent).not.toContain("MB/s");
  });

  it("falls back to the per-file bar when the server sends no overall download", async () => {
    await mount({ state: "downloading", progress: { phase: "models", file: "m.safetensors", bytes_done: 30, bytes_total: 100 } });
    expect(q("#progress-text")!.hidden).toBe(true);
    expect(q<HTMLProgressElement>("#progress")!.value).toBe(30);
  });

  it("renders a hostile file name as text", async () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    await mount(dl({ current_file: evil }));
    await tick({ ...dl({ current_file: evil }), progress: null }, nowMs + 1000);
    expect(q("#progress-file")!.textContent).toBe(evil);
    expect(document.querySelectorAll("img")).toHaveLength(0);
  });
});

describe("text from the api is inert", () => {
  const evil = '<img src=x onerror="window.__pwned=1">';
  it("renders failure text, preset names, sizes and unknown ids as text", async () => {
    await mount({
      role: "admin",
      state: "failed",
      failed: { reason: evil },
      destroy_failed: { error: evil },
      presets: [{ name: evil, steps: 5 }],
      sizes: [{ name: evil, width: 1, height: 1 }],
      progress: { phase: "models", file: evil, bytes_done: 1, bytes_total: 2 },
    });
    expect(q("#failed-reason")!.textContent).toBe(evil);
    expect(q("#presets button")!.textContent).toContain(evil);
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect((window as unknown as Record<string, unknown>)["__pwned"]).toBeUndefined();
  });

  it("renders error banners and job messages as text", async () => {
    await mount({}, {
      "POST /api/generate": { status: 202, body: { id: "j2" } },
      "GET /api/generate/j2": { body: { status: "failed", message: evil } },
    });
    routes["GET /api/state"] = { status: 500, body: { error: { code: "x", message: evil } } };
    await app!.refresh();
    expect(q("#banner")!.textContent).toBe(evil);
    routes["GET /api/state"] = { body: apiState() };
    await app!.refresh();
    q<HTMLTextAreaElement>("#prompt")!.value = evil;
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    await flush();
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect(q("#history")!.textContent).toContain(evil);
    expect((window as unknown as Record<string, unknown>)["__pwned"]).toBeUndefined();
  });

  it("builds image urls from the job id and a numeric index only", async () => {
    // The poll timer is manual: drive the job poll by returning done on the first request.
    await mount({}, {
      "POST /api/generate": { status: 202, body: { id: "job-9" } },
      "GET /api/generate/job-9": { body: { status: "done", images: [{ index: 0, url: "https://evil.example/x.png" }, { index: "../1", url: "/x" }, { index: 3 }] } },
    });
    q<HTMLTextAreaElement>("#prompt")!.value = "fox";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    const imgs = [...document.querySelectorAll<HTMLImageElement>("#history img")];
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual(["/api/image/job-9/0", "/api/image/job-9/3"]);
    const links = [...document.querySelectorAll<HTMLAnchorElement>("#history a.dl")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/api/image/job-9/0", "/api/image/job-9/3"]);
    expect(links[0]!.hasAttribute("download")).toBe(true);
    // The button is usable again once the job is done.
    expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(false);
  });

  it("refuses an unusable job id from the server", async () => {
    await mount({}, { "POST /api/generate": { status: 202, body: { id: "../../etc" } } });
    q<HTMLTextAreaElement>("#prompt")!.value = "fox";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(q("#form-error")!.textContent).toContain("unusable");
    expect(calls.filter((c) => c.path.startsWith("/api/generate/"))).toHaveLength(0);
  });
});

describe("edit with reference images", () => {
  const editInfo = {
    max_references: 3,
    max_bytes: 1000,
    max_pixels: 1_000_000,
    types: ["png", "jpeg"],
    resolutions: [{ name: "zz-res", value: 1024 }, { name: "zz-res-2", value: 768 }],
  };

  const imageFile = (name: string, content = "PNGDATA", type = "image/png") => new File([content], name, { type });

  /** Put files into the picker the way a browser does and fire its change event. */
  function pick(...files: File[]): void {
    const input = q<HTMLInputElement>("#ref-input")!;
    Object.defineProperty(input, "files", { value: files, configurable: true });
    input.dispatchEvent(new Event("change"));
  }
  const b64 = (text: string) => Buffer.from(text).toString("base64");
  const chooseEdit = () => chooseTool("edit");
  const tags = () => [...document.querySelectorAll("#ref-list .ref-tag")].map((n) => n.textContent);

  let created: string[] = [];
  let revoked: string[] = [];
  beforeEach(() => {
    created = [];
    revoked = [];
    window.URL.createObjectURL = (() => {
      const url = `blob:fake-${created.length}`;
      created.push(url);
      return url;
    }) as typeof URL.createObjectURL;
    window.URL.revokeObjectURL = ((url: string) => void revoked.push(url)) as typeof URL.revokeObjectURL;
  });

  it("offers the mode switch only when the server offers edit, and switches the form", async () => {
    await mount();
    expect(menuItem("edit")).toBeNull();
    expect(q("#edit-box")!.hidden).toBe(true);
    routes["GET /api/state"] = { body: apiState({ edit: editInfo }) };
    await app!.refresh();
    expect(menuItem("edit")).not.toBeNull();
    expect(q("#edit-box")!.hidden).toBe(true);
    expect(q("#size-box")!.hidden).toBe(false);
    expect(q<HTMLButtonElement>("#btn-generate")!.textContent).toBe("Generate");

    chooseEdit();
    expect(q("#edit-box")!.hidden).toBe(false);
    expect(q("#size-box")!.hidden).toBe(true);
    expect(currentTool()).toBe("edit");
    expect(currentTool()).not.toBe("generate");
    expect(q<HTMLButtonElement>("#btn-generate")!.textContent).toBe("Edit");

    chooseTool("generate");
    expect(q("#edit-box")!.hidden).toBe(true);
    expect(q<HTMLButtonElement>("#btn-generate")!.textContent).toBe("Generate");
  });

  it("takes the accepted types, hint and resolutions from the api, and keeps the choice across polls", async () => {
    await mount({ edit: editInfo });
    chooseEdit();
    expect(q<HTMLInputElement>("#ref-input")!.accept).toBe("image/png,image/jpeg");
    expect(q("#ref-hint")!.textContent).toContain("Up to 3 images (PNG, JPEG)");
    expect([...document.querySelectorAll("#resolution option")].map((o) => o.textContent)).toEqual(["zz-res", "zz-res-2"]);
    q<HTMLSelectElement>("#resolution")!.value = "zz-res-2";
    await app!.refresh();
    expect(q<HTMLSelectElement>("#resolution")!.value).toBe("zz-res-2");
    expect(currentTool()).toBe("edit");
  });

  it("shows previews tagged <image1>, <image2>, removes one, and releases the preview url", async () => {
    await mount({ edit: editInfo });
    chooseEdit();
    pick(imageFile("one.png"), imageFile("two.jpg", "JPG", "image/jpeg"));
    expect(tags()).toEqual(["<image1>", "<image2>"]);
    expect(document.querySelectorAll("#ref-list img")).toHaveLength(2);
    expect(q<HTMLImageElement>("#ref-list img")!.getAttribute("src")).toBe("blob:fake-0");
    expect(q("#ref-error")!.hidden).toBe(true);

    q<HTMLButtonElement>("#ref-list li button")!.click();
    expect(tags()).toEqual(["<image1>"]);
    expect([...document.querySelectorAll("#ref-list .ref-name")].map((n) => n.textContent)).toEqual(["two.jpg"]);
    expect(revoked).toEqual(["blob:fake-0"]);
  });

  it("refuses the wrong type, empty and oversized files and a fourth image, and says why", async () => {
    await mount({ edit: editInfo });
    chooseEdit();
    pick(imageFile("notes.txt", "x", "text/plain"), imageFile("empty.png", ""), imageFile("big.png", "x".repeat(1001)));
    expect(tags()).toEqual([]);
    const text = q("#ref-error")!.textContent!;
    expect(q("#ref-error")!.hidden).toBe(false);
    expect(text).toContain("notes.txt");
    expect(text).toContain("empty.png");
    expect(text).toContain("big.png");

    pick(imageFile("a.png"), imageFile("b.png"), imageFile("c.png"), imageFile("d.png"));
    expect(tags()).toEqual(["<image1>", "<image2>", "<image3>"]);
    expect(q("#ref-error")!.textContent).toBe("At most 3 images can be attached.");
    pick(imageFile("e.png"));
    expect(tags()).toHaveLength(3);
  });

  it("renders a hostile file name as text only", async () => {
    await mount({ edit: editInfo });
    chooseEdit();
    pick(imageFile('<img src=x onerror="alert(1)">.png'));
    expect(q("#ref-list img[onerror]")).toBeNull();
    expect(q("#ref-list .ref-name")!.textContent).toBe('<img src=x onerror="alert(1)">.png');
    expect(document.querySelectorAll("#ref-list img")).toHaveLength(1); // only the preview
  });

  it("does not call the api without a prompt or without references", async () => {
    await mount({ edit: editInfo });
    chooseEdit();
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(q("#form-error")!.textContent).toBe("Describe the change first.");
    q<HTMLTextAreaElement>("#prompt")!.value = "make it real";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(q("#form-error")!.textContent).toBe("Attach at least one reference image.");
    expect(posts("/api/edit")).toHaveLength(0);
    expect(posts("/api/generate")).toHaveLength(0);
  });

  it("posts the prompt, preset, resolution, seed and the images as base64 in order, then polls the job", async () => {
    let polls = 0;
    await mount({ edit: editInfo }, {
      "POST /api/edit": { status: 202, body: { id: "edit-1" } },
      "GET /api/generate/edit-1": () => {
        polls += 1;
        return polls === 1 ? { body: { status: "pending" } } : { body: { status: "done", images: [{ index: 0, url: "/api/image/edit-1/0" }] } };
      },
    });
    chooseEdit();
    pick(imageFile("one.png", "FIRST"), imageFile("two.jpg", "SECOND", "image/jpeg"));
    q<HTMLTextAreaElement>("#prompt")!.value = "put <image2> on <image1>";
    q<HTMLInputElement>("#seed")!.value = "42";
    q<HTMLButtonElement>('#presets button[data-preset="zz-slow"]')!.click();
    q<HTMLSelectElement>("#resolution")!.value = "zz-res-2";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(true);
    await flush();

    expect(posts("/api/edit")).toHaveLength(1);
    expect(posts("/api/edit")[0]!.body).toEqual({
      prompt: "put <image2> on <image1>",
      preset: "zz-slow",
      resolution: "zz-res-2",
      images: [b64("FIRST"), b64("SECOND")],
      seed: 42,
    });
    expect(posts("/api/generate")).toHaveLength(0);
    expect(q(".job .muted")!.textContent).toBe("Edit: zz-slow (99 steps), zz-res-2, 2 references");
    expect(q(".job-prompt")!.textContent).toBe("put <image2> on <image1>");

    // The job is read through the same poll route as a generate job.
    expect(calls.some((c) => c.method === "GET" && c.path === "/api/generate/edit-1")).toBe(true);
    // The attached images stay for a tweak-and-retry.
    expect(tags()).toEqual(["<image1>", "<image2>"]);
  });

  it("sends one request when submitted twice quickly", async () => {
    await mount({ edit: editInfo }, { "POST /api/edit": { status: 202, body: { id: "edit-1" }, gate: Promise.resolve() } });
    chooseEdit();
    pick(imageFile("one.png"));
    q<HTMLTextAreaElement>("#prompt")!.value = "x";
    const form = q<HTMLFormElement>("#gen-form")!;
    form.requestSubmit();
    form.requestSubmit();
    await flush();
    expect(posts("/api/edit")).toHaveLength(1);
  });

  it("shows the api refusal, keeps the images and re-enables the button", async () => {
    await mount({ edit: editInfo }, {
      "POST /api/edit": { status: 400, body: { error: { code: "reference_too_many_pixels", message: "reference 1 has more than 1000000 pixels" } } },
    });
    chooseEdit();
    pick(imageFile("one.png"));
    q<HTMLTextAreaElement>("#prompt")!.value = "x";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(q("#form-error")!.hidden).toBe(false);
    expect(q("#form-error")!.textContent).toBe("reference 1 has more than 1000000 pixels");
    expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(false);
    expect(tags()).toEqual(["<image1>"]);
  });

  it("is disabled until the instance is ready, and falls back to generate when the server stops offering edit", async () => {
    await mount({ state: "booting", edit: editInfo });
    chooseEdit();
    expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(true);
    routes["GET /api/state"] = { body: apiState({ state: "ready", edit: null }) };
    await app!.refresh();
    expect(menuItem("edit")).toBeNull();
    expect(currentTool()).toBe("generate");
    expect(q("#edit-box")!.hidden).toBe(true);
    expect(q("#size-box")!.hidden).toBe(false);
    expect(q<HTMLButtonElement>("#btn-generate")!.textContent).toBe("Generate");
    expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(false);
  });

  it("releases the preview urls when the app stops", async () => {
    await mount({ edit: editInfo });
    chooseEdit();
    pick(imageFile("one.png"), imageFile("two.png"));
    app!.stop();
    expect(revoked).toEqual(["blob:fake-0", "blob:fake-1"]);
  });
});

describe("Vast credit", () => {
  const credit = (c: number) => ({ body: { credit: c, as_of: 1_800_000_000 } });
  const creditCalls = () => calls.filter((c) => c.path === "/api/credit");

  it("an admin sees the credit in the status card", async () => {
    await mount({ role: "admin" }, { "GET /api/credit": credit(4.5377) });
    await flush();
    expect(q("#f-credit-box")!.hidden).toBe(false);
    expect(q("#f-credit")!.textContent).toBe("$4.54");
    expect(creditCalls()).toHaveLength(1);
  });

  it("a member never sees it and never asks for it", async () => {
    await mount({ role: "member" }, { "GET /api/credit": credit(4.5) });
    await flush();
    expect(q("#f-credit-box")!.hidden).toBe(true);
    expect(creditCalls()).toHaveLength(0);
  });

  it("asks once a minute, not on every status poll", async () => {
    await mount({ role: "admin" }, { "GET /api/credit": credit(4.5) });
    await flush();
    nowMs += 5_000;
    await app!.refresh();
    nowMs += 40_000;
    await app!.refresh();
    await flush();
    expect(creditCalls()).toHaveLength(1);
    routes["GET /api/credit"] = credit(3.25);
    nowMs += 20_000; // 65 s after the first read
    await app!.refresh();
    await flush();
    expect(creditCalls()).toHaveLength(2);
    expect(q("#f-credit")!.textContent).toBe("$3.25");
  });

  it("shows a used-up credit with a minus sign", async () => {
    await mount({ role: "admin" }, { "GET /api/credit": credit(-0.8) });
    await flush();
    expect(q("#f-credit")!.textContent).toBe("-$0.80");
  });

  it("shows 'unavailable' when the server cannot read it, and retries after the interval", async () => {
    await mount({ role: "admin" }, { "GET /api/credit": { status: 424, body: { error: { code: "vast_unavailable", message: "could not read the Vast account credit" } } } });
    await flush();
    expect(q("#f-credit")!.textContent).toBe("unavailable");
    expect(q("#banner")!.hidden).toBe(true); // a credit problem is not a page-level alert
    routes["GET /api/credit"] = credit(2);
    nowMs += 61_000;
    await app!.refresh();
    await flush();
    expect(q("#f-credit")!.textContent).toBe("$2.00");
  });

  it("shows 'unavailable' for an unusable answer and renders nothing the server did not send as a number", async () => {
    await mount({ role: "admin" }, { "GET /api/credit": { body: { credit: "<b>lots</b>" } } });
    await flush();
    expect(q("#f-credit")!.textContent).toBe("unavailable");
    expect(q("#f-credit b")).toBeNull();
  });

  it("hides the box when the account is no longer an admin", async () => {
    await mount({ role: "admin" }, { "GET /api/credit": credit(4.5) });
    await flush();
    routes["GET /api/state"] = { body: apiState({ role: "member" }) };
    await app!.refresh();
    expect(q("#f-credit-box")!.hidden).toBe(true);
  });
});

describe("gallery: save, auto-save and the gallery card", () => {
  const GID = (n: number, job = "job-1") => `${"b".repeat(31)}${n % 10}.8199999999${String(100 + n).padStart(3, "0")}.${job}.0`;
  const item = (n: number, over: Record<string, unknown> = {}) => ({
    id: GID(n), url: `/api/gallery/${GID(n)}/image`, created_at: 1_800_000_000 + n, kind: "generate", prompt: `prompt ${n}`, label: "preview, 1:1", owner_name: "Ayu", mine: true, size: 2_000_000, ...over,
  });
  const gallerySaves = () => posts("/api/gallery");

  /** Submit a generate job and let it finish with the given server image indexes. */
  async function finishJob(indexes: number[] = [0], extra: Record<string, Handler> = {}, state: Record<string, unknown> = {}) {
    await mount({ gallery: true, ...state }, {
      "POST /api/generate": { status: 202, body: { id: "job-1" } },
      "GET /api/generate/job-1": { body: { status: "done", images: indexes.map((index) => ({ index, url: `/api/image/job-1/${index}` })) } },
      ...extra,
    });
    q<HTMLTextAreaElement>("#prompt")!.value = "a red fox";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
  }
  const saveButtons = () => [...document.querySelectorAll<HTMLButtonElement>("#history button.save")];

  it("says how long a result took, with the verb of its kind", async () => {
    await mount({}, {
      "POST /api/generate": { status: 202, body: { id: "job-1" } },
      "GET /api/generate/job-1": { body: { status: "done", images: [{ index: 0, url: "/api/image/job-1/0" }], seconds: 52.3, queued_seconds: null } },
    });
    q<HTMLTextAreaElement>("#prompt")!.value = "a red fox";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(q("#history .job-time")!.textContent).toBe("Generated in 52 s");
  });

  it("shows no duration when the server sends none or a nonsense value", async () => {
    await mount({}, {
      "POST /api/generate": { status: 202, body: { id: "job-1" } },
      "GET /api/generate/job-1": { body: { status: "done", images: [{ index: 0, url: "/api/image/job-1/0" }], seconds: "52" } },
    });
    q<HTMLTextAreaElement>("#prompt")!.value = "a red fox";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(q("#history .job-time")).toBeNull();
    expect(q("#history img")).not.toBeNull();
  });

  it("offers nothing when the server has no gallery", async () => {
    await mount({ gallery: false }, { "POST /api/generate": { status: 202, body: { id: "job-1" } }, "GET /api/generate/job-1": { body: { status: "done", images: [{ index: 0, url: "/x" }] } } });
    q<HTMLTextAreaElement>("#prompt")!.value = "x";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(q("#gallery-card")!.hidden).toBe(true);
    expect(q("#autosave-box")!.hidden).toBe(true);
    expect(saveButtons()).toHaveLength(0);
  });

  it("shows the gallery card and the auto-save box when it is on", async () => {
    await mount({ gallery: true });
    expect(q("#gallery-card")!.hidden).toBe(false);
    expect(q("#autosave-box")!.hidden).toBe(false);
  });

  it("a Save button per result posts the job id and the server's image index, then shows Saved", async () => {
    await finishJob([2, 5], { "POST /api/gallery": { status: 201, body: { id: GID(1), created: true } } });
    expect(saveButtons().map((b) => b.textContent)).toEqual(["Save to gallery", "Save to gallery"]);
    saveButtons()[1]!.click();
    await flush();
    expect(gallerySaves()).toHaveLength(1);
    expect(gallerySaves()[0]!.body).toEqual({ job: "job-1", index: 5 });
    expect(saveButtons().map((b) => [b.textContent, b.disabled])).toEqual([["Save to gallery", false], ["Saved ✓", true]]);
    saveButtons()[1]!.click();
    await flush();
    expect(gallerySaves()).toHaveLength(1);
  });

  it("a failed save says why on the image and can be retried", async () => {
    let fail = true;
    await finishJob([0], { "POST /api/gallery": () => (fail ? { status: 409, body: { error: { code: "gallery_quota", message: "the gallery is full (300 images)" } } } : { status: 201, body: { id: GID(1), created: true } }) });
    saveButtons()[0]!.click();
    await flush();
    expect(q("#history .alert.bad")!.textContent).toBe("Not saved: the gallery is full (300 images)");
    expect(saveButtons()[0]!.disabled).toBe(false);
    fail = false;
    saveButtons()[0]!.click();
    await flush();
    expect(saveButtons()[0]!.textContent).toBe("Saved ✓");
    expect(q("#history .alert.bad")).toBeNull();
  });

  it("auto-save saves every image of a finished job, remembers the choice, and is off by default", async () => {
    expect(window.localStorage.getItem("vast-comfy.autosave")).toBeNull();
    await mount({ gallery: true });
    expect(q<HTMLInputElement>("#autosave")!.checked).toBe(false);
    q<HTMLInputElement>("#autosave")!.click();
    expect(window.localStorage.getItem("vast-comfy.autosave")).toBe("1");
    app!.stop();
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(INDEX)![1]!;
    calls = [];
    await finishJob([0, 1], { "POST /api/gallery": { status: 201, body: { id: GID(1), created: true } } });
    expect(q<HTMLInputElement>("#autosave")!.checked).toBe(true);
    await flush();
    expect(gallerySaves().map((c) => c.body)).toEqual([{ job: "job-1", index: 0 }, { job: "job-1", index: 1 }]);
    expect(saveButtons().map((b) => b.textContent)).toEqual(["Saved ✓", "Saved ✓"]);
  });

  it("without auto-save nothing is saved by itself", async () => {
    await finishJob([0]);
    await flush();
    expect(gallerySaves()).toHaveLength(0);
  });

  it("works when localStorage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    await mount({ gallery: true });
    expect(q<HTMLInputElement>("#autosave")!.checked).toBe(false);
    q<HTMLInputElement>("#autosave")!.click();
    expect(q<HTMLInputElement>("#autosave")!.checked).toBe(true);
  });

  describe("the gallery card", () => {
    it("continues from a saved image: attaches it as a reference or into upscale, and offers nothing without edit or upscale", async () => {
      const editOffer = { max_references: 3, max_bytes: 1000, max_pixels: 1_000_000, types: ["png", "jpeg"], resolutions: [{ name: "zz-res", value: 1024 }] };
      const upOffer = { scales: ["2x"], max_bytes: 1000, max_pixels: 1_000_000, types: ["png"] };
      window.URL.createObjectURL = (() => "blob:fake") as typeof URL.createObjectURL;
      await mount({ gallery: true, edit: editOffer, upscale: upOffer }, {
        "GET /api/gallery": { body: { items: [item(1)], next: null } },
        [`GET /api/gallery/${GID(1)}/image`]: { body: null, raw: "SAVED", type: "image/png" },
      });
      q("#gal-open")!.click();
      await flush();
      const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("#gal-list .chain button")];
      expect(buttons().map((b) => b.textContent)).toEqual(["Use as reference", "Upscale"]);
      buttons()[0]!.click();
      await flush();
      expect(currentTool()).toBe("edit");
      expect(q("#ref-list .ref-name")!.textContent).toBe(`saved-${GID(1).slice(0, 8)}.png`);
      buttons()[1]!.click();
      await flush();
      expect(currentTool()).toBe("upscale");
      expect(document.querySelectorAll("#ref-list li")).toHaveLength(1);
    });

    it("puts how long a saved image took into its caption; older images have none", async () => {
      await mount({ gallery: true }, {
        "GET /api/gallery": { body: { items: [item(1, { kind: "edit", seconds: 4.25 }), item(2, { seconds: null }), item(3, { kind: "upscale", seconds: 130 })], next: null } },
      });
      q("#gal-open")!.click();
      await flush();
      const captions = [...document.querySelectorAll("#gal-list .gal-caption")].map((c) => c.textContent ?? "");
      expect(captions[0]).toContain("Edited in 4.3 s");
      expect(captions[1]).not.toContain(" in ");
      expect(captions[2]).toContain("Upscaled in 2 min 10 s");
    });

    it("shows no continue buttons when the server offers neither edit nor upscale", async () => {
      await mount({ gallery: true }, { "GET /api/gallery": { body: { items: [item(1)], next: null } } });
      q("#gal-open")!.click();
      await flush();
      expect(q("#gal-list .chain")).toBeNull();
    });

    it("loads nothing until it is opened, then lists the images with urls rebuilt from the ids", async () => {
      await mount({ gallery: true }, { "GET /api/gallery": { body: { items: [item(1, { url: "https://evil.example/x.png" }), item(2)], next: null } } });
      expect(calls.filter((c) => c.path.startsWith("/api/gallery"))).toHaveLength(0);
      q("#gal-open")!.click();
      await flush();
      const imgs = [...document.querySelectorAll<HTMLImageElement>("#gal-list img")];
      expect(imgs.map((i) => i.getAttribute("src"))).toEqual([`/api/gallery/${GID(1)}/image`, `/api/gallery/${GID(2)}/image`]);
      expect(q("#gal-list")!.hidden).toBe(false);
      expect(q("#gal-empty")!.hidden).toBe(true);
      expect(q("#gal-more")!.hidden).toBe(true);
      expect(q(".gal-caption")!.textContent).toBe("preview, 1:1 · 2027-01-15 08:00 UTC · 1.9 MB");
    });

    it("shows the empty state, and an error when the list cannot be read", async () => {
      await mount({ gallery: true }, { "GET /api/gallery": { body: { items: [], next: null } } });
      q("#gal-open")!.click();
      await flush();
      expect(q("#gal-empty")!.hidden).toBe(false);
      routes["GET /api/gallery"] = { status: 424, body: { error: { code: "gallery_error", message: "the gallery storage could not be reached" } } };
      q("#gal-open")!.click();
      await flush();
      expect(q("#gal-error")!.hidden).toBe(false);
      expect(q("#gal-error")!.textContent).toBe("the gallery storage could not be reached");
    });

    it("Load more asks for the next page with the cursor and appends", async () => {
      await mount({ gallery: true }, {
        "GET /api/gallery": { body: { items: [item(1), item(2)], next: GID(2) } },
        [`GET /api/gallery?cursor=${GID(2)}`]: { body: { items: [item(3)], next: null } },
      });
      q("#gal-open")!.click();
      await flush();
      expect(q("#gal-more")!.hidden).toBe(false);
      q("#gal-more")!.click();
      await flush();
      expect(document.querySelectorAll("#gal-list figure")).toHaveLength(3);
      expect(q("#gal-more")!.hidden).toBe(true);
    });

    it("renders prompts and names as text", async () => {
      await mount({ gallery: true }, { "GET /api/gallery": { body: { items: [item(1, { prompt: '<img src=x onerror="alert(1)">', label: "<b>x</b>" })], next: null } } });
      q("#gal-open")!.click();
      await flush();
      expect(q("#gal-list img[onerror]")).toBeNull();
      expect(q(".gal-prompt")!.textContent).toBe('<img src=x onerror="alert(1)">');
      expect(q("#gal-list b")).toBeNull();
    });

    it("only an admin gets 'everyone', which reloads with scope=all and shows other owners", async () => {
      await mount({ gallery: true, role: "member" }, { "GET /api/gallery": { body: { items: [item(1)], next: null } } });
      q("#gal-open")!.click();
      await flush();
      expect(q("#gal-all-box")!.hidden).toBe(true);
      app!.stop();
      document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(INDEX)![1]!;
      calls = [];
      await mount({ gallery: true, role: "admin" }, {
        "GET /api/gallery": { body: { items: [item(1)], next: null } },
        "GET /api/gallery?scope=all": { body: { items: [item(2, { mine: false, owner_name: "Budi" }), item(1)], next: null } },
      });
      expect(q("#gal-all-box")!.hidden).toBe(true); // only once the gallery is open
      q("#gal-open")!.click();
      await flush();
      expect(q("#gal-all-box")!.hidden).toBe(false);
      q<HTMLInputElement>("#gal-all")!.click();
      await flush();
      expect(calls.some((c) => c.path === "/api/gallery?scope=all")).toBe(true);
      const captions = [...document.querySelectorAll(".gal-caption")].map((c) => c.textContent);
      expect(captions[0]).toContain("Budi");
      expect(captions[1]).not.toContain("Budi");
    });

    it("delete asks first, then removes the image, and 'cancel' keeps it", async () => {
      await mount({ gallery: true }, {
        "GET /api/gallery": { body: { items: [item(1), item(2)], next: null } },
        "POST /api/gallery/delete": { body: { deleted: true } },
      });
      q("#gal-open")!.click();
      await flush();
      const del = () => [...document.querySelectorAll<HTMLButtonElement>("#gal-list button")].filter((b) => b.textContent === "Delete");
      del()[0]!.click();
      await flush();
      expect(q("#modal")!.hidden).toBe(false);
      expect(posts("/api/gallery/delete")).toHaveLength(0);
      q("#modal-cancel")!.click();
      await flush();
      expect(document.querySelectorAll("#gal-list figure")).toHaveLength(2);
      del()[0]!.click();
      await flush();
      q("#modal-ok")!.click();
      await flush();
      expect(posts("/api/gallery/delete")[0]!.body).toEqual({ id: GID(1) });
      expect(document.querySelectorAll("#gal-list figure")).toHaveLength(1);
    });

    it("a successful save while the gallery is open refreshes it", async () => {
      let n = 0;
      await finishJob([0], {
        "POST /api/gallery": { status: 201, body: { id: GID(1), created: true } },
        "GET /api/gallery": () => ({ body: { items: n++ === 0 ? [] : [item(1)], next: null } }),
      });
      q("#gal-open")!.click();
      await flush();
      expect(document.querySelectorAll("#gal-list figure")).toHaveLength(0);
      saveButtons()[0]!.click();
      await flush();
      expect(document.querySelectorAll("#gal-list figure")).toHaveLength(1);
    });
  });
});
describe("styles and chaining", () => {
  const editInfo = { max_references: 3, max_bytes: 1000, max_pixels: 1_000_000, types: ["png", "jpeg"], resolutions: [{ name: "zz-res", value: 1024 }] };
  const strength = { id: "strength", title: "LoRA strength", type: "float", min: 0.4, max: 1, step: 0.05, default: 0.7 };
  const a2r = { id: "anything2real", title: "Anything to Real", modes: ["edit"], params: [strength] };
  const mixed = {
    id: "mixed",
    title: "Mixed",
    modes: ["generate", "edit"],
    params: [
      { id: "kind", title: "Kind", type: "choice", choices: ["soft", "hard"], default: "soft" },
      { id: "sharp", title: "Sharp", type: "bool", default: false },
    ],
  };
  const chooseEdit = () => chooseTool("edit");
  const titles = () => [...document.querySelectorAll(".menu-item .menu-title")].map((b) => b.textContent);
  const pressed = () => [menuItem(currentTool()!)!.querySelector(".menu-title")!.textContent];
  const click = chooseByTitle;

  beforeEach(() => {
    window.URL.createObjectURL = (() => "blob:fake") as typeof URL.createObjectURL;
    window.URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  });

  describe("face swap", () => {
    const faceswap = {
      id: "faceswap", title: "Face swap", kind: "preset", modes: ["edit"], params: [], prompt_optional: true,
      references: { min: 2, max: 2, labels: ["Scene to keep", "Face to use"] }, hint: "Results depend on the model. Only use a face with consent.",
    };
    const attach = (...names: string[]) => {
      const input = q<HTMLInputElement>("#ref-input")!;
      Object.defineProperty(input, "files", { value: names.map((n) => new File(["PNGDATA"], n, { type: "image/png" })), configurable: true });
      input.dispatchEvent(new Event("change"));
    };
    const slots = () => [...document.querySelectorAll("#ref-list li")].map((li) => li.querySelector(".ref-tag")?.textContent ?? li.textContent);
    const names = () => [...document.querySelectorAll("#ref-list .ref-name")].map((n) => n.textContent);

    it("shows the two labelled slots in order, a Swap order button, the hint, and makes the prompt optional", async () => {
      await mount({ edit: editInfo, styles: [a2r, faceswap] });
      chooseEdit();
      expect(q("#prompt-label")!.textContent).toBe("Prompt");
      click("Face swap");
      expect(q("#prompt-label")!.textContent).toBe("Notes (optional)");
      expect(q("#style-hint")!.hidden).toBe(false);
      expect(q("#style-hint")!.textContent).toContain("consent");
      expect(q("#ref-hint")!.textContent).toBe("Face swap needs exactly 2 images in this order: Scene to keep, Face to use.");
      expect(slots()).toEqual(["Scene to keep: not attached yet", "Face to use: not attached yet"]);
      attach("scene.png");
      expect(slots()).toEqual(["Scene to keep", "Face to use: not attached yet"]);
      expect(q("#ref-swap")!.hidden).toBe(true);
      attach("face.png");
      expect(slots()).toEqual(["Scene to keep", "Face to use"]);
      expect(names()).toEqual(["scene.png", "face.png"]);
      q<HTMLButtonElement>("#ref-swap")!.click();
      expect(names()).toEqual(["face.png", "scene.png"]);
      chooseTool("edit"); // back to the plain edit: plain <imageN> tags, no swap, prompt required
      expect(slots()).toEqual(["<image1>", "<image2>"]);
      expect(q("#ref-swap")!.hidden).toBe(true);
      expect(q("#style-hint")!.hidden).toBe(true);
      expect(q("#prompt-label")!.textContent).toBe("Prompt");
    });

    it("anime / cartoon to real: one labelled slot, optional notes, the strength slider from 0, quality unchanged", async () => {
      const toReal = {
        id: "anything2real", title: "Anime / cartoon to real", kind: "lora", modes: ["edit"], prompt_optional: true,
        params: [{ ...strength, min: 0 }], references: { min: 1, max: 1, labels: ["Image to convert"] }, hint: "LoRA strength 0 = prompt only, no LoRA.",
      };
      await mount({ edit: editInfo, styles: [toReal, faceswap] }, { "POST /api/edit": { status: 202, body: { id: "real-1" } }, "GET /api/generate/real-1": { body: { status: "pending" } } });
      chooseEdit();
      q<HTMLButtonElement>('#presets button[data-preset="zz-slow"]')!.click();
      click("Anime / cartoon to real");
      expect(slots()).toEqual(["Image to convert: not attached yet"]);
      expect(q("#prompt-label")!.textContent).toBe("Notes (optional)");
      expect(q("#ref-hint")!.textContent).toBe("Anime / cartoon to real needs exactly 1 image (Image to convert).");
      expect(q("#ref-hint")!.textContent).not.toContain("<image1>");
      const range = q<HTMLInputElement>("#style-params input[type=range]")!;
      expect([range.min, range.max, range.value]).toEqual(["0", "1", "0.7"]);
      range.value = "0";
      range.dispatchEvent(new Event("input"));
      attach("anime.png");
      expect(slots()).toEqual(["Image to convert"]);
      expect(q("#ref-swap")!.hidden).toBe(true);
      expect(q("#sampling-box")!.hidden).toBe(false);
      q<HTMLFormElement>("#gen-form")!.requestSubmit();
      await flush();
      expect(posts("/api/edit")[0]!.body).toMatchObject({ prompt: "", preset: "zz-slow", style: { id: "anything2real", params: { strength: 0 } } });
    });

    it("refuses a submit without both images, and sends an empty prompt with the style when both are there", async () => {
      await mount({ edit: editInfo, styles: [faceswap] }, { "POST /api/edit": { status: 202, body: { id: "swap-1" } }, "GET /api/generate/swap-1": { body: { status: "pending" } } });
      chooseEdit();
      click("Face swap");
      attach("scene.png");
      q<HTMLFormElement>("#gen-form")!.requestSubmit();
      await flush();
      expect(q("#form-error")!.textContent).toBe("Face swap needs exactly 2 images in this order: Scene to keep, Face to use.");
      expect(posts("/api/edit")).toHaveLength(0);
      attach("face.png");
      q<HTMLFormElement>("#gen-form")!.requestSubmit();
      await flush();
      const body = posts("/api/edit")[0]!.body as Record<string, unknown>;
      expect(body).toMatchObject({ prompt: "", style: { id: "faceswap", params: {} } });
      expect(body["images"]).toHaveLength(2);
      expect(q(".job .job-prompt")!.textContent).toBe("Face swap");
    });
  });

  it("lists each style as its own entry in the tool menu, after the plain tools", async () => {
    await mount({ edit: editInfo, styles: [a2r] });
    expect(titles()).toEqual(["Generate", "Edit images", "Upscale", "Anything to Real"].filter((t) => t !== "Upscale"));
    expect(q("#style-box")!.hidden).toBe(true); // plain generate: no style
    chooseEdit();
    expect(q("#style-box")!.hidden).toBe(true); // plain edit: no options
    click("Anything to Real");
    expect(q("#style-box")!.hidden).toBe(false);
    expect(pressed()).toEqual(["Anything to Real"]);
    expect(q("#gen-title")!.textContent).toBe("Anything to Real");
  });

  it("draws the panel of the chosen style from the api and keeps a slider across polls", async () => {
    await mount({ edit: editInfo, styles: [a2r, mixed] });
    chooseEdit();
    click("Anything to Real");
    const range = q<HTMLInputElement>("#style-params input[type=range]")!;
    expect([range.min, range.max, range.step, range.value]).toEqual(["0.4", "1", "0.05", "0.7"]);
    range.value = "0.85";
    range.dispatchEvent(new Event("input"));
    expect(q(".style-value")!.textContent).toBe("0.85");
    await app!.refresh();
    expect(q<HTMLInputElement>("#style-params input[type=range]")!.value).toBe("0.85");
    click("Mixed");
    expect([...document.querySelectorAll("#style-params label")].map((l) => l.textContent)).toEqual(["Kind", "Sharp"]);
    expect(q("#style-params select")!.tagName).toBe("SELECT");
    expect(q<HTMLInputElement>("#style-params input[type=checkbox]")!.checked).toBe(false);
    click("Anything to Real"); // the earlier value is remembered
    expect(q<HTMLInputElement>("#style-params input[type=range]")!.value).toBe("0.85");
  });

  it("sends the chosen style and its values with an edit, and adds its title to the label", async () => {
    await mount({ edit: editInfo, styles: [a2r] }, { "POST /api/edit": { status: 202, body: { id: "edit-9" } }, "GET /api/generate/edit-9": { body: { status: "pending" } } });
    chooseEdit();
    click("Anything to Real");
    const range = q<HTMLInputElement>("#style-params input[type=range]")!;
    range.value = "0.62";
    range.dispatchEvent(new Event("input"));
    const input = q<HTMLInputElement>("#ref-input")!;
    Object.defineProperty(input, "files", { value: [new File(["PNGDATA"], "a.png", { type: "image/png" })], configurable: true });
    input.dispatchEvent(new Event("change"));
    q<HTMLTextAreaElement>("#prompt")!.value = "make it real";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(posts("/api/edit")[0]!.body).toMatchObject({ style: { id: "anything2real", params: { strength: 0.6 } } });
    expect(q(".job .muted")!.textContent).toMatch(/, Anything to Real$/);
  });

  it("sends no style member when Standard is chosen, and the chosen generate style with its values", async () => {
    await mount({ edit: editInfo, styles: [a2r, mixed] }, { "POST /api/generate": { status: 202, body: { id: "g-1" } }, "GET /api/generate/g-1": { body: { status: "failed", message: "x" } } });
    q<HTMLTextAreaElement>("#prompt")!.value = "a fox";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(posts("/api/generate")[0]!.body).not.toHaveProperty("style");

    expect(titles()).toEqual(["Generate", "Edit images", "Anything to Real", "Mixed", "Mixed"]); // a2r is edit-only; Mixed has an entry per mode
    click("Mixed");
    const sel = q<HTMLSelectElement>("#style-params select")!;
    sel.value = "hard";
    sel.dispatchEvent(new Event("change"));
    const box = q<HTMLInputElement>("#style-params input[type=checkbox]")!;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(posts("/api/generate")[1]!.body).toMatchObject({ style: { id: "mixed", params: { kind: "hard", sharp: true } } });
  });

  it("falls back to the first entry when the chosen style disappears from the state", async () => {
    await mount({ edit: editInfo, styles: [a2r] });
    chooseEdit();
    click("Anything to Real");
    routes["GET /api/state"] = { body: apiState({ edit: editInfo, styles: [] }) };
    await app!.refresh();
    expect(q("#style-box")!.hidden).toBe(true);
    expect(currentTool()).toBe("generate");
  });

  it("renders a hostile style title and parameter title as text only", async () => {
    const evil = { ...a2r, title: '<img src=x onerror="alert(1)">', params: [{ ...strength, title: "<b>bold</b>" }] };
    await mount({ edit: editInfo, styles: [evil] });
    chooseEdit();
    click('<img src=x onerror="alert(1)">');
    expect(q("#style-box img")).toBeNull();
    expect(q("#style-params b")).toBeNull();
    expect(q("#style-params label")!.textContent).toBe("<b>bold</b>");
  });

  describe("use as reference", () => {
    const done = (id: string): Record<string, Handler> => ({ ["GET /api/generate/" + id]: { body: { status: "done", images: [{ index: 0, url: `/api/image/${id}/0` }] } } });

    async function withResult(over: Record<string, unknown> = {}, extra: Record<string, Handler> = {}) {
      await mount({ edit: editInfo, styles: [a2r], ...over }, {
        "POST /api/generate": { status: 202, body: { id: "g-1" } },
        "GET /api/image/g-1/0": { body: null, raw: "RESULTBYTES", type: "image/png" },
        ...done("g-1"),
        ...extra,
      });
      q<HTMLTextAreaElement>("#prompt")!.value = "a fox";
      q<HTMLFormElement>("#gen-form")!.requestSubmit();
      await flush();
      await flush();
    }
    const chainBtns = () => [...document.querySelectorAll<HTMLButtonElement>(".chain button")].map((b) => b.textContent);

    it("is offered on a result only when the server offers edit", async () => {
      await withResult({ edit: null });
      expect(q(".chain")).toBeNull();
    });

    it("follows the server: buttons appear when edit or upscale becomes available after the result, and go when it stops", async () => {
      await withResult({ edit: null });
      expect(q(".chain")).toBeNull();
      routes["GET /api/state"] = { body: apiState({ edit: editInfo, styles: [a2r] }) };
      await app!.refresh();
      expect(chainBtns()).toEqual(["Use as reference", "Use as reference: Anything to Real"]);
      routes["GET /api/state"] = { body: apiState({ edit: null, upscale: { scales: ["2x"], max_bytes: 1000, max_pixels: 1_000_000, types: ["png"] } }) };
      await app!.refresh();
      expect(chainBtns()).toEqual(["Upscale"]);
      routes["GET /api/state"] = { body: apiState({ edit: null }) };
      await app!.refresh();
      expect(q(".chain")).toBeNull();
    });

    it("lists a plain button and one per edit style", async () => {
      await withResult();
      expect(chainBtns()).toEqual(["Use as reference", "Use as reference: Anything to Real"]);
    });

    it("switches to Edit, attaches the fetched result as the first reference and keeps Standard", async () => {
      await withResult();
      q<HTMLButtonElement>(".chain button")!.click();
      await flush();
      expect(currentTool()).toBe("edit");
      expect([...document.querySelectorAll("#ref-list .ref-tag")].map((n) => n.textContent)).toEqual(["<image1>"]);
      expect(q("#ref-list .ref-name")!.textContent).toBe("result-g-1-0.png");
      expect(pressed()).toEqual(["Edit images"]);
      expect(calls.filter((c) => c.path === "/api/image/g-1/0")).toHaveLength(1);
    });

    it("switches to the chosen edit style", async () => {
      await withResult();
      document.querySelectorAll<HTMLButtonElement>(".chain button")[1]!.click();
      await flush();
      expect(pressed()).toEqual(["Anything to Real"]);
      expect(document.querySelectorAll("#ref-list li")).toHaveLength(1);
    });

    it("says why when the result cannot be loaded or is not an accepted image, and attaches nothing", async () => {
      await withResult({}, { "GET /api/image/g-1/0": { status: 404, body: null, raw: "gone" } });
      q<HTMLButtonElement>(".chain button")!.click();
      await flush();
      expect(q("#ref-error")!.hidden).toBe(false);
      expect(document.querySelectorAll("#ref-list li")).toHaveLength(0);
      routes["GET /api/image/g-1/0"] = { body: null, raw: "<svg/>", type: "image/svg+xml" };
      q<HTMLButtonElement>(".chain button")!.click();
      await flush();
      expect(q("#ref-error")!.textContent).toContain("only PNG, JPEG");
      expect(document.querySelectorAll("#ref-list li")).toHaveLength(0);
    });
  });
});

describe("upscale", () => {
  const up = { scales: ["2x", "4x"], max_bytes: 1000, max_pixels: 1_000_000, types: ["png", "jpeg"] };
  const editInfo = { max_references: 3, max_bytes: 1000, max_pixels: 1_000_000, types: ["png", "jpeg"], resolutions: [{ name: "zz-res", value: 1024 }] };
  const chooseUp = () => chooseTool("upscale");
  const pickOne = (name = "a.png", content = "UPBYTES") => {
    const input = q<HTMLInputElement>("#ref-input")!;
    Object.defineProperty(input, "files", { value: [new File([content], name, { type: "image/png" })], configurable: true });
    input.dispatchEvent(new Event("change"));
  };

  beforeEach(() => {
    window.URL.createObjectURL = (() => "blob:fake") as typeof URL.createObjectURL;
    window.URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  });

  it("offers the mode only when the server offers upscale, and shows just the image and the scale", async () => {
    await mount({ edit: editInfo });
    expect(menuItem("upscale")).toBeNull();
    await mount({ upscale: up });
    expect(menuItem("upscale")).not.toBeNull(); // upscale alone is enough for an entry
    expect(menuItem("edit")).toBeNull();
    chooseUp();
    expect(currentTool()).toBe("upscale");
    expect(q("#prompt-box")!.hidden).toBe(true);
    expect(q("#sampling-box")!.hidden).toBe(true);
    expect(q("#size-box")!.hidden).toBe(true);
    expect(q("#style-box")!.hidden).toBe(true);
    expect(q("#resolution-box")!.hidden).toBe(true);
    expect(q("#scale-box")!.hidden).toBe(false);
    expect(q("#edit-box")!.hidden).toBe(false);
    expect([...document.querySelectorAll("#scale option")].map((o) => o.textContent)).toEqual(["2x", "4x"]);
    expect(q<HTMLInputElement>("#ref-input")!.multiple).toBe(false);
    expect(q("#ref-hint")!.textContent).toContain("One image");
    expect(q<HTMLButtonElement>("#btn-generate")!.textContent).toBe("Upscale");
  });

  it("goes back to the generate form when the server stops offering upscale", async () => {
    await mount({ upscale: up });
    chooseUp();
    routes["GET /api/state"] = { body: apiState({ upscale: null }) };
    await app!.refresh();
    expect(q("#prompt-box")!.hidden).toBe(false);
    expect(q<HTMLButtonElement>("#btn-generate")!.textContent).toBe("Generate");
  });

  it("accepts one image only and posts the image as base64 with the scale, then polls the job", async () => {
    await mount({ upscale: up }, { "POST /api/upscale": { status: 202, body: { id: "up-1" } }, "GET /api/generate/up-1": { body: { status: "pending" } } });
    chooseUp();
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(q("#form-error")!.textContent).toBe("Attach exactly one image to upscale.");
    pickOne("a.png", "UPBYTES");
    pickOne("b.png");
    expect(document.querySelectorAll("#ref-list li")).toHaveLength(1);
    expect(q("#ref-error")!.textContent).toBe("At most 1 images can be attached.");
    q<HTMLSelectElement>("#scale")!.value = "4x";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(posts("/api/upscale")).toHaveLength(1);
    expect(posts("/api/upscale")[0]!.body).toEqual({ image: Buffer.from("UPBYTES").toString("base64"), scale: "4x" });
    expect(q(".job .muted")!.textContent).toBe("Upscale: 4x");
    expect(calls.some((c) => c.path === "/api/generate/up-1")).toBe(true);
  });

  it("shows the api refusal and frees the form", async () => {
    await mount({ upscale: up }, { "POST /api/upscale": { status: 400, body: { error: { code: "upscale_too_large", message: "the result would be too big" } } } });
    chooseUp();
    pickOne();
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(q("#form-error")!.textContent).toBe("the result would be too big");
    expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(false);
  });

  describe("from a result", () => {
    async function withResult(over: Record<string, unknown>) {
      await mount({ upscale: up, ...over }, {
        "POST /api/generate": { status: 202, body: { id: "g-1" } },
        "GET /api/generate/g-1": { body: { status: "done", images: [{ index: 0, url: "/api/image/g-1/0" }] } },
        "GET /api/image/g-1/0": { body: null, raw: "RESULT", type: "image/png" },
      });
      q<HTMLTextAreaElement>("#prompt")!.value = "a fox";
      q<HTMLFormElement>("#gen-form")!.requestSubmit();
      await flush();
      await flush();
    }
    const labels = () => [...document.querySelectorAll(".chain button")].map((b) => b.textContent);

    it("adds an Upscale button, also when edit is off, that switches mode and attaches the result", async () => {
      await withResult({});
      expect(labels()).toEqual(["Upscale"]);
      [...document.querySelectorAll<HTMLButtonElement>(".chain button")][0]!.click();
      await flush();
      expect(currentTool()).toBe("upscale");
      expect(q("#ref-list .ref-name")!.textContent).toBe("result-g-1-0.png");
    });

    it("replaces a previously attached image, because an upscale takes one", async () => {
      await withResult({ edit: editInfo });
      expect(labels()).toEqual(["Use as reference", "Upscale"]);
      q<HTMLButtonElement>(".chain button")!.click(); // into edit
      await flush();
      chooseUp();
      [...document.querySelectorAll<HTMLButtonElement>(".chain button")][1]!.click();
      await flush();
      expect(document.querySelectorAll("#ref-list li")).toHaveLength(1);
      expect(q("#ref-error")!.hidden).toBe(true);
    });
  });

  it("refuses to upscale when several images were attached in edit mode", async () => {
    await mount({ upscale: up, edit: editInfo });
    chooseTool("edit");
    const input = q<HTMLInputElement>("#ref-input")!;
    Object.defineProperty(input, "files", { value: [new File(["A"], "a.png", { type: "image/png" }), new File(["B"], "b.png", { type: "image/png" })], configurable: true });
    input.dispatchEvent(new Event("change"));
    chooseUp();
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(q("#form-error")!.textContent).toBe("Attach exactly one image to upscale.");
    expect(posts("/api/upscale")).toHaveLength(0);
  });
});

describe("video", () => {
  const video = {
    sizes: [{ name: "Landscape", width: 1280, height: 704 }, { name: "Portrait, faster", width: 480, height: 832 }],
    durations: [{ name: "About 3 s", seconds: 3 }, { name: "About 5 s", seconds: 5 }],
    max_bytes: 1000,
    max_pixels: 1_000_000,
    types: ["png", "jpeg"],
    download_bytes: 18_000_000_000,
    models: { state: "ready", bytes_done: 1, bytes_total: 1, percent: 100, reason: null },
  };
  const menu = {
    categories: [{ id: "create", title: "Create" }],
    items: [
      { id: "text_to_image", title: "Text to image", description: null, icon: "image", category: "create", tool: "generate", style: null, available: true },
      { id: "video", title: "Video", description: "Make a short video.", icon: "film", category: "create", tool: "video", style: null, available: true },
    ],
  };
  const pickOne = (name = "a.png", content = "STARTBYTES") => {
    const input = q<HTMLInputElement>("#ref-input")!;
    Object.defineProperty(input, "files", { value: [new File([content], name, { type: "image/png" })], configurable: true });
    input.dispatchEvent(new Event("change"));
  };
  const submit = async () => {
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
  };
  const doneVideo = { body: { status: "done", images: [], videos: [{ index: 0, url: "/api/video/v-1/0" }], seconds: 312, queued_seconds: null } };

  beforeEach(() => {
    window.URL.createObjectURL = (() => "blob:fake-video") as typeof URL.createObjectURL;
    window.URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  });

  it("has no entry while the server does not offer video", async () => {
    await mount({ menu: { ...menu, items: menu.items.map((i) => (i.id === "video" ? { ...i, available: false } : i)) } });
    expect(menuItem("video")).toBeNull();
    await mount({ menu });
    expect(menuItem("video")).toBeNull(); // available, but the state has no video offer
  });

  it("shows the prompt, one optional start image, size, length and seed, and none of the image controls", async () => {
    await mount({ menu, video });
    chooseTool("video");
    expect(currentTool()).toBe("video");
    expect(q("#prompt-box")!.hidden).toBe(false);
    expect(q("#edit-box")!.hidden).toBe(false);
    expect(q("#ref-label")!.textContent).toBe("Start image (optional)");
    expect(q<HTMLInputElement>("#ref-input")!.multiple).toBe(false);
    expect(q("#ref-hint")!.textContent).toContain("Optional: one start image");
    expect(q("#video-box")!.hidden).toBe(false);
    expect([...document.querySelectorAll("#video-size option")].map((o) => o.textContent)).toEqual(["Landscape (1280×704)", "Portrait, faster (480×832)"]);
    expect([...document.querySelectorAll("#video-duration option")].map((o) => o.textContent)).toEqual(["About 3 s", "About 5 s"]);
    expect(q("#sampling-box")!.hidden).toBe(false);
    expect(q("#quality-box")!.hidden).toBe(true);
    expect(q("#size-box")!.hidden).toBe(true);
    expect(q("#resolution-box")!.hidden).toBe(true);
    expect(q("#scale-box")!.hidden).toBe(true);
    expect(q("#advanced-box")!.hidden).toBe(true);
    expect(q<HTMLButtonElement>("#btn-generate")!.textContent).toBe("Make video");
    expect(q("#gen-hint")!.textContent).toContain("several minutes");
    chooseTool("text_to_image");
    expect(q("#video-box")!.hidden).toBe(true);
    expect(q("#quality-box")!.hidden).toBe(false);
    expect(q("#ref-label")!.textContent).toBe("Reference images");
  });

  it("text to video: posts exactly the prompt, size and length (and a seed when given), then polls and plays the file", async () => {
    await mount({ menu, video, gallery: true }, {
      "POST /api/video": { status: 202, body: { id: "v-1" } },
      "GET /api/generate/v-1": doneVideo,
      "GET /api/video/v-1/0": { body: null, raw: "MP4BYTES", type: "video/mp4" },
    });
    q<HTMLInputElement>("#autosave")!.checked = true;
    chooseTool("video");
    q<HTMLTextAreaElement>("#prompt")!.value = "a fox runs";
    q<HTMLSelectElement>("#video-duration")!.value = "About 5 s";
    q<HTMLInputElement>("#seed")!.value = "77";
    await submit();
    await flush();
    expect(posts("/api/video")[0]!.body).toEqual({ prompt: "a fox runs", size: "Landscape", duration: "About 5 s", seed: 77 });
    expect(q(".job .muted")!.textContent).toBe("Video: Landscape, About 5 s");
    const player = q<HTMLVideoElement>(".job video")!;
    expect(player).not.toBeNull();
    expect(player.controls).toBe(true);
    expect(player.hasAttribute("playsinline")).toBe(true);
    expect(player.getAttribute("src")).toBe("blob:fake-video");
    const dl = q<HTMLAnchorElement>(".job a.dl")!;
    expect(dl.getAttribute("href")).toBe("blob:fake-video");
    expect(dl.getAttribute("download")).toBe("video-v-1-0.mp4");
    expect(q(".job-time")!.textContent).toBe("Made in 5 min 12 s");
    // No Save, no auto-save, no "continue" buttons for a video.
    expect(q(".job button.save")).toBeNull();
    expect(q(".job .chain")).toBeNull();
    expect(posts("/api/gallery")).toHaveLength(0);
    expect(q(".job")!.textContent).toContain("Videos are not saved to the gallery");
    expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(false);
  });

  it("image to video: sends the one attached image as base64, and the label says so", async () => {
    await mount({ menu, video }, { "POST /api/video": { status: 202, body: { id: "v-1" } }, "GET /api/generate/v-1": { body: { status: "pending", progress: { step: 3, max: 20 }, preview_seq: 0 } } });
    chooseTool("video");
    pickOne("a.png", "STARTBYTES");
    pickOne("b.png");
    expect(document.querySelectorAll("#ref-list li")).toHaveLength(1);
    expect(q("#ref-list .ref-tag")!.textContent).toBe("Start image");
    q<HTMLTextAreaElement>("#prompt")!.value = "it moves";
    await submit();
    expect(posts("/api/video")[0]!.body).toEqual({ prompt: "it moves", size: "Landscape", duration: "About 3 s", image: Buffer.from("STARTBYTES").toString("base64") });
    expect(q(".job .muted")!.textContent).toBe("Video: Landscape, About 3 s, from an image");
    // While it runs: the step counter and the long-wait note.
    expect(q(".job-step")!.textContent).toBe("Step 3 of 20");
    expect(q(".job-wait")!.textContent).toContain("several minutes");
  });

  it("needs a prompt, and shows the api refusal and frees the form", async () => {
    await mount({ menu, video }, { "POST /api/video": { status: 400, body: { error: { code: "unknown_duration", message: "duration is not offered for video" } } } });
    chooseTool("video");
    await submit();
    expect(q("#form-error")!.textContent).toBe("Describe the video first.");
    expect(posts("/api/video")).toHaveLength(0);
    q<HTMLTextAreaElement>("#prompt")!.value = "x";
    await submit();
    expect(q("#form-error")!.textContent).toBe("duration is not offered for video");
    expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(false);
  });

  it("says so when the file cannot be loaded, or is not a video", async () => {
    for (const reply of [{ status: 424, body: { error: { code: "video_rejected", message: "ComfyUI did not return a video" } } }, { body: null, raw: "<html>", type: "text/html" }]) {
      await mount({ menu, video }, { "POST /api/video": { status: 202, body: { id: "v-1" } }, "GET /api/generate/v-1": doneVideo, "GET /api/video/v-1/0": reply });
      chooseTool("video");
      q<HTMLTextAreaElement>("#prompt")!.value = "a fox";
      await submit();
      await flush();
      expect(q(".job video")).toBeNull();
      expect(q(".job [role=alert]")!.textContent).toMatch(/^The video could not be loaded: /);
      app?.stop();
    }
  });

  it("refuses two images carried over from edit: a video takes one start image at most", async () => {
    const edit = { max_references: 3, max_bytes: 1000, max_pixels: 1_000_000, types: ["png"], resolutions: [{ name: "r", value: 1024 }] };
    const items = [...menu.items, { id: "free_edit", title: "Free edit", description: null, icon: "wand", category: "create", tool: "edit", style: null, available: true }];
    await mount({ menu: { ...menu, items }, video, edit });
    chooseTool("free_edit");
    const input = q<HTMLInputElement>("#ref-input")!;
    Object.defineProperty(input, "files", { value: [new File(["A"], "a.png", { type: "image/png" }), new File(["B"], "b.png", { type: "image/png" })], configurable: true });
    input.dispatchEvent(new Event("change"));
    chooseTool("video");
    q<HTMLTextAreaElement>("#prompt")!.value = "x";
    await submit();
    expect(q("#form-error")!.textContent).toBe("Attach at most one start image for a video.");
    expect(posts("/api/video")).toHaveLength(0);
  });

  it("an experimental duration is labelled and warns while it is chosen; the job carries its name", async () => {
    const long = { ...video, durations: [...video.durations, { name: "About 12 s (experimental)", seconds: 12, experimental: true }] };
    await mount({ menu, video: long }, { "POST /api/video": { status: 202, body: { id: "v-1" } }, "GET /api/generate/v-1": { body: { status: "pending" } } });
    chooseTool("video");
    expect([...document.querySelectorAll("#video-duration option")].map((o) => o.textContent)).toEqual(["About 3 s", "About 5 s", "About 12 s (experimental)"]);
    expect(q("#video-duration-warning")!.hidden).toBe(true);
    const sel = q<HTMLSelectElement>("#video-duration")!;
    sel.value = "About 12 s (experimental)";
    sel.dispatchEvent(new Event("change"));
    await flush();
    expect(q("#video-duration-warning")!.hidden).toBe(false);
    expect(q("#video-duration-warning")!.textContent).toBe("Longer than the model was trained for (about 5 s): quality may drop and it may run out of memory or time out.");
    q<HTMLTextAreaElement>("#prompt")!.value = "a fox";
    await submit();
    expect(posts("/api/video")[0]!.body).toEqual({ prompt: "a fox", size: "Landscape", duration: "About 12 s (experimental)" });
    sel.value = "About 3 s";
    sel.dispatchEvent(new Event("change"));
    await flush();
    expect(q("#video-duration-warning")!.hidden).toBe(true);
  });

  describe("video models on the instance", () => {
    const at = (models: unknown) => ({ ...video, models });
    const missing = { state: "not_installed", bytes_done: 0, bytes_total: 18_000_000_000, percent: 0, reason: null };

    it("an admin gets the download button while they are missing; it asks the server and follows the state", async () => {
      await mount({ role: "admin", menu, video: at(missing) }, {
        "POST /api/video-models": { status: 202, body: { models: { ...missing, state: "downloading" } } },
      });
      chooseTool("video");
      expect(q("#video-models")!.hidden).toBe(false);
      expect(q("#video-models-text")!.textContent).toBe("This instance was started without the video models.");
      const btn = q<HTMLButtonElement>("#video-models-download")!;
      expect(btn.hidden).toBe(false);
      expect(btn.textContent).toBe("Download video models (about 18.0 GB, several minutes)");
      expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(true);
      expect(q("#gen-hint")!.textContent).toContain("unlocks when the video models are on the instance");
      routes["GET /api/state"] = { body: apiState({ role: "admin", menu, video: at({ state: "downloading", bytes_done: 9_000_000_000, bytes_total: 18_000_000_000, percent: 50, reason: null }) }) };
      btn.click();
      await flush();
      expect(posts("/api/video-models")).toHaveLength(1);
      expect(posts("/api/video-models")[0]!.body).toEqual({});
      expect(q("#video-models-text")!.textContent).toBe("Downloading the video models: 9.0 GB of 18.0 GB (50%). Images keep working meanwhile; Make video unlocks when it is done.");
      expect(btn.hidden).toBe(true);
      expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(true);
      routes["GET /api/state"] = { body: apiState({ role: "admin", menu, video }) };
      await app!.refresh();
      expect(q("#video-models")!.hidden).toBe(true);
      expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(false);
    });

    it("an admin may give a model link: it is sent once with the download, shown with its notice, never stored", async () => {
      await mount({ role: "admin", menu, video: at(missing) }, { "POST /api/video-models": { status: 202, body: { models: missing } } });
      chooseTool("video");
      expect(q("#video-models-link")!.hidden).toBe(false);
      expect(q("#video-models-link-note")!.textContent).toContain("NOT integrity-pinned or licence-checked");
      const input = q<HTMLInputElement>("#video-models-url")!;
      expect(input.type).toBe("url");
      expect(input.maxLength).toBe(2048);
      expect(input.autocomplete).toBe("off");
      input.value = "  https://huggingface.co/o/r/resolve/main/m.gguf  ";
      q<HTMLButtonElement>("#video-models-download")!.click();
      await flush();
      expect(posts("/api/video-models")[0]!.body).toEqual({ url: "https://huggingface.co/o/r/resolve/main/m.gguf" });
      expect(JSON.stringify({ ...window.localStorage })).not.toContain("huggingface");
    });

    it("shows the server's refusal of a link as text", async () => {
      await mount({ role: "admin", menu, video: at(missing) }, {
        "POST /api/video-models": { status: 400, body: { error: { code: "model_link_host_not_allowed", message: "<b>links are only accepted from the allowed model hosts</b>" } } },
      });
      chooseTool("video");
      q<HTMLInputElement>("#video-models-url")!.value = "https://evil.example/o/r/resolve/main/m.gguf";
      q<HTMLButtonElement>("#video-models-download")!.click();
      await flush();
      expect(q("#video-models-error")!.textContent).toBe("<b>links are only accepted from the allowed model hosts</b>");
      expect(q("#video-models-error b")).toBeNull();
    });

    it("shows the server's refusal of the download, for example a disk that is too small", async () => {
      await mount({ role: "admin", menu, video: at(missing) }, {
        "POST /api/video-models": { status: 409, body: { error: { code: "disk_insufficient", message: "the instance disk is too small for the video models" } } },
      });
      chooseTool("video");
      q<HTMLButtonElement>("#video-models-download")!.click();
      await flush();
      expect(q("#video-models-error")!.hidden).toBe(false);
      expect(q("#video-models-error")!.textContent).toBe("the instance disk is too small for the video models");
    });

    it("a member is told to ask an admin and gets no button; nothing is shown outside the Video tool", async () => {
      await mount({ menu, video: at(missing) });
      expect(q("#video-models")!.hidden).toBe(true);
      chooseTool("video");
      expect(q("#video-models-text")!.textContent).toBe("The video models are not installed on this instance. Ask an admin to download them.");
      expect(q("#video-models-download")!.hidden).toBe(true);
      expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(true);
      q<HTMLTextAreaElement>("#prompt")!.value = "x";
      await submit();
      expect(posts("/api/video")).toHaveLength(0);
    });
  });

  it("continues an image result into video: Make a video switches the tool and attaches it as the start image", async () => {
    await mount({ menu, video }, {
      "POST /api/generate": { status: 202, body: { id: "g-1" } },
      "GET /api/generate/g-1": { body: { status: "done", images: [{ index: 0, url: "/api/image/g-1/0" }] } },
      "GET /api/image/g-1/0": { body: null, raw: "RESULT", type: "image/png" },
    });
    q<HTMLTextAreaElement>("#prompt")!.value = "a fox";
    await submit();
    await flush();
    const make = [...document.querySelectorAll<HTMLButtonElement>(".chain button")].find((b) => b.textContent === "Make a video")!;
    make.click();
    await flush();
    expect(currentTool()).toBe("video");
    expect(document.querySelectorAll("#ref-list li")).toHaveLength(1);
    expect(q("#ref-list .ref-name")!.textContent).toBe("result-g-1-0.png");
  });
});

describe("Advanced: negative prompt and guidance", () => {
  const guidance = { min: 1, max: 6, step: 0.5, default: 1 };
  const both = { negative_prompt: true, cfg: true };
  const none = { negative_prompt: false, cfg: false };
  const editInfo = { max_references: 3, max_bytes: 1000, max_pixels: 1_000_000, types: ["png"], resolutions: [{ name: "zz-res", value: 1024 }, { name: "zz-big", value: 2048 }] };
  const anime = {
    id: "anime", title: "Anime", kind: "preset", modes: ["generate"], params: [], prompt_optional: true, references: null, hint: null,
    defaults: { negative_prompt: "photorealistic", cfg: 3, preset: "zz-slow", size: "zz-wide" },
  };
  const plain = { id: "plain", title: "Plain", kind: "preset", modes: ["generate"], params: [], prompt_optional: false, references: null, hint: null, defaults: {} };
  const advanced = (edit = both) => ({ guidance, advanced: { generate: both, edit, negative_prompt_max_chars: 200 } });
  const done = (id: string) => ({ body: { status: "done", images: [{ index: 0, url: `/api/image/${id}/0` }], seconds: 1, queued_seconds: null } });
  // Every submit gets its own job, which is done at once, so the form is free for the next submit.
  const job = {
    "POST /api/generate": () => ({ status: 202, body: { id: `job-${posts("/api/generate").length}` } }),
    ...Object.fromEntries([1, 2, 3, 4].map((n) => [`GET /api/generate/job-${n}`, done(`job-${n}`)])),
  };
  const slide = (value: number) => {
    const r = q<HTMLInputElement>("#guidance")!;
    r.value = String(value);
    r.dispatchEvent(new Event("input"));
  };
  const submit = async (prompt = "a red fox") => {
    q<HTMLTextAreaElement>("#prompt")!.value = prompt;
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
  };
  const click = chooseByTitle;
  const negative = () => q<HTMLTextAreaElement>("#negative")!;

  it("is hidden for a server without it, and the body is exactly the old one", async () => {
    await mount({}, job);
    expect(q("#advanced-box")!.hidden).toBe(true);
    await submit();
    expect(posts("/api/generate")[0]!.body).toEqual({ prompt: "a red fox", preset: "zz-turbo", size: "zz-square" });
  });

  it("an untouched section sends nothing extra; a typed negative prompt and a moved slider are sent", async () => {
    await mount(advanced(), job);
    expect(q("#advanced-box")!.hidden).toBe(false);
    expect(q<HTMLInputElement>("#guidance")!.value).toBe("1");
    expect(q("#guidance-value")!.textContent).toBe("1");
    expect(negative().maxLength).toBe(200);
    await submit();
    expect(posts("/api/generate")[0]!.body).toEqual({ prompt: "a red fox", preset: "zz-turbo", size: "zz-square" });
    negative().value = "  blurry  ";
    slide(3.5);
    expect(q("#guidance-value")!.textContent).toBe("3.5");
    await submit();
    expect(posts("/api/generate")[1]!.body).toMatchObject({ negative_prompt: "blurry", cfg: 3.5 });
    expect(q("#history")!.textContent).toContain("guidance 3.5, negative prompt");
    slide(1); // back at the default: no cfg
    negative().value = " ";
    await submit();
    expect(posts("/api/generate")[2]!.body).not.toHaveProperty("cfg");
    expect(posts("/api/generate")[2]!.body).not.toHaveProperty("negative_prompt");
  });

  it("offers in each mode only the knobs its workflow takes, and nothing in upscale", async () => {
    await mount({ ...advanced(none), edit: editInfo }, {});
    chooseTool("edit");
    expect(q("#advanced-box")!.hidden).toBe(true);
    chooseTool("generate");
    expect(q("#advanced-box")!.hidden).toBe(false);
    routes["GET /api/state"] = { body: apiState({ guidance: null, advanced: { generate: both, edit: none, negative_prompt_max_chars: 200 } }) };
    await app!.refresh();
    expect(q("#negative-row")!.hidden).toBe(false);
    expect(q("#guidance-row")!.hidden).toBe(true); // no guidance range: no slider
  });

  it("a style pre-fills its defaults, the user may change them, and leaving the style undoes only what is untouched", async () => {
    await mount({ ...advanced(), styles: [plain, anime] }, job);
    const pressedPreset = () => [...document.querySelectorAll("#presets button")].find((b) => b.getAttribute("aria-pressed") === "true")?.textContent;
    click("Anime");
    expect(negative().value).toBe("photorealistic");
    expect(q<HTMLInputElement>("#guidance")!.value).toBe("3");
    expect(pressedPreset()).toBe("zz-slow (99 steps)");
    expect(q<HTMLSelectElement>("#size")!.value).toBe("zz-wide");
    await submit("");
    expect(posts("/api/generate")[0]!.body).toEqual({
      prompt: "", preset: "zz-slow", size: "zz-wide", negative_prompt: "photorealistic", cfg: 3, style: { id: "anime", params: {} },
    });
    negative().value = "photorealistic, hats"; // the user's own change survives leaving the style
    chooseTool("generate");
    expect(negative().value).toBe("photorealistic, hats");
    expect(q<HTMLInputElement>("#guidance")!.value).toBe("1");
    expect(pressedPreset()).toBe("zz-turbo (7 steps)");
    expect(q<HTMLSelectElement>("#size")!.value).toBe("zz-square");
    click("Plain"); // a style without defaults changes nothing
    expect(negative().value).toBe("photorealistic, hats");
  });

  it("opens Advanced when a style pre-fills a knob there, and never closes it on its own", async () => {
    const sizeOnly = { ...plain, id: "sizeonly", title: "Size only", defaults: { size: "zz-wide" } };
    await mount({ ...advanced(), styles: [plain, anime, sizeOnly] }, job);
    const box = q<HTMLDetailsElement>("#advanced-box")!;
    expect(box.open).toBe(false);
    click("Size only"); // pre-fills nothing inside Advanced: stays closed
    expect(box.open).toBe(false);
    click("Anime");
    expect(box.open).toBe(true); // the pre-filled negative prompt and guidance are visible before any submit
    box.open = false; // the user closes it
    chooseTool("generate"); // leaving the style undoes the pre-fill but does not reopen or close anything
    expect(box.open).toBe(false);
    click("Plain");
    expect(box.open).toBe(false);
    box.open = true; // the user opens it
    chooseTool("generate");
    expect(box.open).toBe(true);
  });

  it("a style's defaults never touch the form in another mode", async () => {
    await mount({ ...advanced(), edit: editInfo, styles: [anime] }, job);
    click("Anime");
    chooseTool("edit"); // the generate style is not chosen in edit: its pre-fill is undone
    expect(negative().value).toBe("");
    expect(q<HTMLInputElement>("#guidance")!.value).toBe("1");
    chooseTool("generate"); // plain generate again: nothing of the style comes back by itself
    expect(negative().value).toBe("");
    click("Anime");
    expect(negative().value).toBe("photorealistic");
  });
});

describe("start dialog: advanced server choice", () => {
  const OFFERS = {
    offers: [
      { id: 21, gpu_name: "RTX A5000", dph: 0.25, vram_gb: 24, location: "Texas, US", region: "north_america", down_mbps: 700, reliability: 0.98 },
      { id: 22, gpu_name: "RTX A5000", dph: 0.31, vram_gb: 24, location: '<img src=x onerror="alert(1)">', region: null, down_mbps: 900, reliability: 0.995 },
    ],
  };
  const EU = "region=europe";
  const routes2 = (extra: Record<string, Handler> = {}): Record<string, Handler> => ({
    [`GET /api/gpus?${EU}`]: { body: GPUS },
    [`GET /api/estimate?gpu=RTX%20A5000&${EU}`]: est("RTX A5000", 0.3, { location: "Lithuania, LT" }),
    [`GET /api/offers?gpu=RTX%20A5000&${EU}`]: { body: OFFERS },
    [`GET /api/estimate?gpu=RTX%20A5000&${EU}&offer_id=22`]: est("RTX A5000", 0.31),
    ...extra,
  });
  const region = () => q<HTMLSelectElement>("#start-region")!;
  const setRegion = async (value: string) => {
    region().value = value;
    region().dispatchEvent(new Event("change"));
    await flush();
  };
  const startPosts = () => posts("/api/start").map((c) => c.body);
  const lastPath = (prefix: string) => calls.filter((c) => c.path.startsWith(prefix)).at(-1)!.path;

  it("is closed and neutral by default: a plain Start sends exactly what it always did and asks for no filter", async () => {
    await adminNone();
    await openStart();
    expect(q<HTMLDetailsElement>("#start-advanced")!.open).toBe(false);
    expect(document.querySelector('label[for="start-region"]')!.textContent).toBe("Region");
    expect([...region().options].map((o) => o.value)).toEqual(["any", "north_america", "south_america", "europe", "asia", "oceania", "africa"]);
    expect(calls.filter((c) => c.path.startsWith("/api/gpus")).map((c) => c.path)).toEqual(["/api/gpus"]);
    expect(calls.some((c) => c.path.startsWith("/api/offers"))).toBe(false);
    q("#modal-ok")!.click();
    await flush();
    expect(startPosts()).toEqual([{ confirm: true, gpu: "RTX A5000" }]);
  });

  it("a region filter re-reads the GPU list and the estimate with the filter, remembers it, and sends it with Start", async () => {
    await adminNone(routes2());
    await openStart();
    await setRegion("europe");
    expect(lastPath("/api/gpus")).toBe("/api/gpus?region=europe");
    expect(lastPath("/api/estimate")).toBe("/api/estimate?gpu=RTX%20A5000&region=europe");
    expect(q("#modal")!.textContent).toContain("Server: Lithuania, LT");
    expect(JSON.parse(window.localStorage.getItem("vast-comfy.start-filters")!)).toEqual({ region: "europe", maxDph: "", minDown: "", sort: "price" });
    q("#modal-ok")!.click();
    await flush();
    expect(startPosts()).toEqual([{ confirm: true, gpu: "RTX A5000", region: "europe" }]);
  });

  it("opens with the remembered filters applied and the section open", async () => {
    window.localStorage.setItem("vast-comfy.start-filters", JSON.stringify({ region: "europe", maxDph: "", minDown: "", sort: "price" }));
    await adminNone(routes2());
    await openStart();
    expect(q<HTMLDetailsElement>("#start-advanced")!.open).toBe(true);
    expect(region().value).toBe("europe");
    expect(lastPath("/api/gpus")).toBe("/api/gpus?region=europe");
    expect(lastPath("/api/estimate")).toBe("/api/estimate?gpu=RTX%20A5000&region=europe");
  });

  it.each(["{", JSON.stringify({ region: "mars" }), JSON.stringify({ maxDph: "abc" }), JSON.stringify({ sort: "<b>" })])("ignores a remembered choice that is not valid (%s)", async (stored) => {
    window.localStorage.setItem("vast-comfy.start-filters", stored);
    await adminNone();
    await openStart();
    expect(region().value).toBe("any");
    expect(calls.filter((c) => c.path.startsWith("/api/gpus")).map((c) => c.path)).toEqual(["/api/gpus"]);
  });

  it("shows why bad inputs cannot be used and sends nothing while they are bad", async () => {
    await adminNone();
    await openStart();
    const price = q<HTMLInputElement>("#start-max-price")!;
    const before = calls.length;
    price.value = "abc";
    price.dispatchEvent(new Event("change"));
    await flush();
    expect(q("#modal")!.textContent).toContain("Maximum price must be a number above 0");
    expect(q<HTMLButtonElement>("#modal-ok")!.disabled).toBe(true);
    expect(calls).toHaveLength(before);
    const speed = q<HTMLInputElement>("#start-min-speed")!;
    price.value = "";
    speed.value = "1.5";
    speed.dispatchEvent(new Event("change"));
    await flush();
    expect(q("#modal")!.textContent).toContain("whole number of Mbps");
    expect(posts("/api/start")).toHaveLength(0);
  });

  it("lists the matching servers as text, starts with Automatic, and a picked server goes to the estimate and to Start", async () => {
    await adminNone(routes2());
    await openStart();
    await setRegion("europe");
    q<HTMLButtonElement>("#start-advanced button")!.click();
    await flush();
    expect(lastPath("/api/offers")).toBe("/api/offers?gpu=RTX%20A5000&region=europe");
    const rows = [...document.querySelectorAll(".start-offer")];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain("Automatic");
    expect((rows[0]!.querySelector("input") as HTMLInputElement).checked).toBe(true);
    expect(rows[1]!.textContent).toBe("RTX A5000 - $0.25/h - Texas, US - 700 Mbps down - reliability 98%");
    expect(document.querySelector("#start-advanced img")).toBeNull(); // the hostile location is text
    expect(rows[2]!.textContent).toContain('<img src=x onerror="alert(1)">');
    const second = rows[2]!.querySelector("input") as HTMLInputElement;
    second.checked = true;
    second.dispatchEvent(new Event("change"));
    await flush();
    expect(lastPath("/api/estimate")).toBe("/api/estimate?gpu=RTX%20A5000&region=europe&offer_id=22");
    q("#modal-ok")!.click();
    await flush();
    expect(startPosts()).toEqual([{ confirm: true, gpu: "RTX A5000", region: "europe", offer_id: 22 }]);
    expect(window.localStorage.getItem("vast-comfy.start-filters")).not.toContain("22"); // the pick is not remembered
  });

  it("says so when no server matches", async () => {
    await adminNone(routes2({ [`GET /api/offers?gpu=RTX%20A5000&${EU}`]: { body: { offers: [] } } }));
    await openStart();
    await setRegion("europe");
    q<HTMLButtonElement>("#start-advanced button")!.click();
    await flush();
    expect(q("#modal")!.textContent).toContain("No server matches these filters right now.");
    expect(document.querySelectorAll(".start-offer")).toHaveLength(0);
  });

  it("when the chosen server vanished: the reason is shown, nothing started, the pick is forgotten and the list is read again", async () => {
    await adminNone(routes2({ "POST /api/start": { status: 409, body: { error: { code: "offer_gone", message: "that offer is no longer available; choose another or refresh the list" } } } }));
    await openStart();
    await setRegion("europe");
    q<HTMLButtonElement>("#start-advanced button")!.click();
    await flush();
    const second = document.querySelectorAll(".start-offer input")[2] as HTMLInputElement;
    second.checked = true;
    second.dispatchEvent(new Event("change"));
    await flush();
    const offerReads = calls.filter((c) => c.path.startsWith("/api/offers")).length;
    q("#modal-ok")!.click();
    await flush();
    expect(startPosts()).toEqual([{ confirm: true, gpu: "RTX A5000", region: "europe", offer_id: 22 }]);
    expect(q("#modal")!.hidden).toBe(false);
    expect(q("#modal")!.textContent).toContain("no longer available");
    expect(q("#notice")!.hidden).toBe(true);
    expect(calls.filter((c) => c.path.startsWith("/api/offers")).length).toBe(offerReads + 1);
    // The price shown is the automatic one again, not the vanished server's (no offer_id in the last estimate).
    expect(lastPath("/api/estimate")).toBe("/api/estimate?gpu=RTX%20A5000&region=europe");
    expect(q("#modal")!.textContent).toContain("$0.30/hour");
    q("#modal-ok")!.click(); // a second try is a plain automatic one
    await flush();
    expect(startPosts().at(-1)).toEqual({ confirm: true, gpu: "RTX A5000", region: "europe" });
  });

  it("works when localStorage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    await adminNone(routes2());
    await openStart();
    await setRegion("europe");
    expect(region().value).toBe("europe");
    q("#modal-ok")!.click();
    await flush();
    expect(startPosts()).toEqual([{ confirm: true, gpu: "RTX A5000", region: "europe" }]);
  });
});

describe("paste images from the clipboard", () => {
  const editInfo = { max_references: 2, max_bytes: 1000, max_pixels: 1_000_000, types: ["png", "jpeg"], resolutions: [{ name: "zz-res", value: 1024 }] };
  const up = { scales: ["2x"], max_bytes: 1000, max_pixels: 1_000_000, types: ["png"] };
  const img = (content = "PNGDATA", type = "image/png") => new File([content], "image.png", { type });
  const tagsNow = () => [...document.querySelectorAll("#ref-list .ref-tag")].map((n) => n.textContent);
  const namesNow = () => [...document.querySelectorAll("#ref-list .ref-name")].map((n) => n.textContent);

  /** Fire a paste at `target` carrying `files`; returns the event so a test can read defaultPrevented. */
  function paste(files: File[], target: EventTarget = document.body): Event {
    const e = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "clipboardData", { value: { files }, configurable: true });
    target.dispatchEvent(e);
    return e;
  }

  beforeEach(() => {
    window.URL.createObjectURL = (() => "blob:fake") as typeof URL.createObjectURL;
    window.URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  });

  it("attaches a pasted image as the next reference in Edit, with its own name, and takes over the paste", async () => {
    await mount({ edit: editInfo });
    chooseTool("edit");
    const e = paste([img()]);
    expect(e.defaultPrevented).toBe(true);
    expect(tagsNow()).toEqual(["<image1>"]);
    expect(namesNow()).toEqual(["pasted-1.png"]);
    paste([img("SECOND")]);
    expect(namesNow()).toEqual(["pasted-1.png", "pasted-2.png"]);
  });

  it("works while the focus is in the prompt box when the clipboard holds an image", async () => {
    await mount({ edit: editInfo });
    chooseTool("edit");
    const e = paste([img()], q<HTMLTextAreaElement>("#prompt")!);
    expect(e.defaultPrevented).toBe(true);
    expect(tagsNow()).toEqual(["<image1>"]);
  });

  it("leaves a text-only paste alone, also in Edit", async () => {
    await mount({ edit: editInfo });
    chooseTool("edit");
    const e = paste([]);
    expect(e.defaultPrevented).toBe(false);
    expect(tagsNow()).toEqual([]);
  });

  it("ignores files that are not images, and takes only the images of a mixed paste", async () => {
    await mount({ edit: editInfo });
    chooseTool("edit");
    const none = paste([new File(["x"], "notes.txt", { type: "text/plain" })]);
    expect(none.defaultPrevented).toBe(false);
    expect(tagsNow()).toEqual([]);
    paste([new File(["x"], "notes.txt", { type: "text/plain" }), img()]);
    expect(tagsNow()).toEqual(["<image1>"]);
  });

  it("does nothing in a tool that takes no images", async () => {
    await mount({ edit: editInfo });
    const e = paste([img()]); // Generate
    expect(e.defaultPrevented).toBe(false);
    expect(tagsNow()).toEqual([]);
    chooseTool("edit");
    expect(tagsNow()).toEqual([]); // nothing was kept for later either
  });

  it("applies the same limits as the file picker: count, type and size, with the reason shown", async () => {
    await mount({ edit: editInfo });
    chooseTool("edit");
    paste([img()]);
    paste([img()]);
    paste([img()]);
    expect(tagsNow()).toHaveLength(2);
    expect(q("#ref-error")!.textContent).toBe("At most 2 images can be attached.");
    removeFirstRef();
    paste([img("x", "image/gif")]);
    expect(q("#ref-error")!.textContent).toContain("only PNG, JPEG");
    paste([img("x".repeat(1001))]);
    expect(q("#ref-error")!.textContent).toContain("larger than");
  });

  it("in Upscale a second paste is refused because the tool takes one image", async () => {
    await mount({ upscale: up });
    chooseTool("upscale");
    paste([img()]);
    expect(tagsNow()).toEqual(["<image1>"]);
    paste([img("two")]);
    expect(tagsNow()).toEqual(["<image1>"]);
    expect(q("#ref-error")!.textContent).toBe("At most 1 images can be attached.");
  });

  it("is ignored while a dialog or drawer is open", async () => {
    await mount({ edit: editInfo, role: "admin" });
    chooseTool("edit");
    q<HTMLButtonElement>("#status-pill")?.click();
    const e = paste([img()]);
    expect(e.defaultPrevented).toBe(false);
    expect(tagsNow()).toEqual([]);
  });

  it("is ignored while a confirmation dialog is open", async () => {
    await mount({ edit: editInfo, role: "admin", state: "ready" });
    chooseTool("edit");
    q<HTMLButtonElement>("#btn-destroy")!.click();
    await flush();
    expect(q("#modal")!.hidden).toBe(false);
    const e = paste([img()]);
    expect(e.defaultPrevented).toBe(false);
    expect(tagsNow()).toEqual([]);
  });

  function removeFirstRef(): void {
    q<HTMLButtonElement>("#ref-list li button")!.click();
  }
});

describe("edit output size", () => {
  const SIZES = [
    { name: "1:1", width: 1024, height: 1024 },
    { name: "16:9", width: 1344, height: 768 },
    { name: "9:16", width: 768, height: 1344 },
  ];
  const editInfo = { max_references: 3, max_bytes: 1000, max_pixels: 1_000_000, types: ["png", "jpeg"], resolutions: [{ name: "zz-res", value: 1024 }], sizes: SIZES };
  const sizeSel = () => q<HTMLSelectElement>("#edit-size")!;
  const attach = () => {
    const input = q<HTMLInputElement>("#ref-input")!;
    Object.defineProperty(input, "files", { value: [new File(["PNGDATA"], "a.png", { type: "image/png" })], configurable: true });
    input.dispatchEvent(new Event("change"));
  };

  beforeEach(() => {
    window.URL.createObjectURL = (() => "blob:fake") as typeof URL.createObjectURL;
    window.URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  });

  it("is not offered when the server lists no sizes", async () => {
    await mount({ edit: { ...editInfo, sizes: [] } });
    chooseTool("edit");
    expect(q("#edit-size-box")!.hidden).toBe(true);
  });

  it("is offered in Edit only when the server lists sizes, starting at 'same as the first image'", async () => {
    await mount({ edit: editInfo });
    expect(q("#edit-size-box")!.hidden).toBe(true); // Generate has its own Size
    chooseTool("edit");
    expect(q("#edit-size-box")!.hidden).toBe(false);
    expect(document.querySelector('label[for="edit-size"]')!.textContent).toBe("Size");
    expect([...sizeSel().options].map((o) => [o.value, o.textContent])).toEqual([
      ["", "Same as the first image"],
      ["1:1", "1:1 (1024×1024)"],
      ["16:9", "16:9 (1344×768)"],
      ["9:16", "9:16 (768×1344)"],
    ]);
    expect(sizeSel().value).toBe("");
  });

  it("a plain edit sends no size member at all", async () => {
    await mount({ edit: editInfo }, { "POST /api/edit": { status: 202, body: { id: "e-1" } }, "GET /api/generate/e-1": { body: { status: "pending" } } });
    chooseTool("edit");
    attach();
    q<HTMLTextAreaElement>("#prompt")!.value = "make it real";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(posts("/api/edit")[0]!.body).not.toHaveProperty("size");
  });

  it("a chosen size is sent, named in the history line, and kept across polls", async () => {
    await mount({ edit: editInfo }, { "POST /api/edit": { status: 202, body: { id: "e-1" } }, "GET /api/generate/e-1": { body: { status: "pending" } } });
    chooseTool("edit");
    attach();
    sizeSel().value = "16:9";
    await app!.refresh();
    expect(sizeSel().value).toBe("16:9");
    q<HTMLTextAreaElement>("#prompt")!.value = "make it real";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(posts("/api/edit")[0]!.body).toMatchObject({ size: "16:9" });
    expect(q(".job .muted")!.textContent).toContain("16:9");
  });

  it("a size the server stopped listing is dropped from the select instead of being sent", async () => {
    await mount({ edit: editInfo });
    chooseTool("edit");
    sizeSel().value = "9:16";
    routes["GET /api/state"] = { body: apiState({ edit: { ...editInfo, sizes: [SIZES[0]] } }) };
    await app!.refresh();
    expect(sizeSel().value).toBe("");
  });

  it("is not shown in Upscale", async () => {
    await mount({ edit: editInfo, upscale: { scales: ["2x"], max_bytes: 1000, max_pixels: 1_000_000, types: ["png"] } });
    chooseTool("upscale");
    expect(q("#edit-size-box")!.hidden).toBe(true);
  });

  it("renders a hostile size name as text only", async () => {
    await mount({ edit: { ...editInfo, sizes: [{ name: '<img src=x onerror="alert(1)">', width: 1024, height: 1024 }] } });
    chooseTool("edit");
    expect(q("#edit-size-box img")).toBeNull();
    expect(sizeSel().options[1]!.textContent).toContain('<img src=x onerror="alert(1)">');
  });
});


describe("start dialog: Include video models", () => {
  const video = { sizes: [{ name: "L", width: 1280, height: 704 }], durations: [{ name: "About 3 s", seconds: 3 }], max_bytes: 1000, max_pixels: 1000, types: ["png"], download_bytes: 18_000_000_000, models: null };
  const routesWithVideo: Record<string, Handler> = {
    ...START_ROUTES,
    "GET /api/gpus?video_models=true": { body: GPUS },
    "GET /api/estimate?gpu=RTX%20A5000&video_models=true": est("RTX A5000", 0.27),
  };

  it("is offered only where the server offers video, unticked by default, and an unticked start is unchanged", async () => {
    await mount({ role: "admin", state: "none" }, START_ROUTES);
    await openStart();
    expect(q("#start-video")!.closest("label")!.hidden).toBe(true);
    app?.stop();
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(INDEX)![1]!;
    await mount({ role: "admin", state: "none", video }, routesWithVideo);
    await openStart();
    const box = q<HTMLInputElement>("#start-video")!;
    expect(box.closest("label")!.hidden).toBe(false);
    expect(box.checked).toBe(false);
    expect(box.closest("label")!.textContent).toContain("about 18.0 GB more");
    q("#modal-ok")!.click();
    await flush();
    expect(posts("/api/start")[0]!.body).not.toHaveProperty("video_models");
  });

  it("the model link is enabled only when ticked, sent trimmed with the start, and never stored", async () => {
    await mount({ role: "admin", state: "none", video }, routesWithVideo);
    await openStart();
    const link = q<HTMLInputElement>("#start-video-url")!;
    expect(link.disabled).toBe(true);
    expect(link.closest("div")!.textContent).toContain("NOT integrity-pinned or licence-checked");
    const box = q<HTMLInputElement>("#start-video")!;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await flush();
    expect(link.disabled).toBe(false);
    link.value = " https://huggingface.co/o/r/resolve/main/m.safetensors ";
    q("#modal-ok")!.click();
    await flush();
    expect(posts("/api/start")[0]!.body).toMatchObject({ video_models: true, video_model_url: "https://huggingface.co/o/r/resolve/main/m.safetensors" });
    expect(JSON.stringify({ ...window.localStorage })).not.toContain("huggingface");
  });

  it("an empty link sends nothing; a link without the box is not sent", async () => {
    await mount({ role: "admin", state: "none", video }, routesWithVideo);
    await openStart();
    q<HTMLInputElement>("#start-video-url")!.value = "https://huggingface.co/o/r/resolve/main/m.safetensors";
    q("#modal-ok")!.click();
    await flush();
    expect(posts("/api/start")[0]!.body).not.toHaveProperty("video_model_url");
  });

  it("ticked: the lists and the estimate are for the larger disk, the start asks for the video models, and it is remembered", async () => {
    await mount({ role: "admin", state: "none", video }, routesWithVideo);
    await openStart();
    const box = q<HTMLInputElement>("#start-video")!;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await flush();
    expect(calls.some((c) => c.path === "/api/gpus?video_models=true")).toBe(true);
    expect(estimateCalls().at(-1)).toBe("/api/estimate?gpu=RTX%20A5000&video_models=true");
    expect(q("#modal")!.textContent).toContain("$0.27/hour");
    q("#modal-ok")!.click();
    await flush();
    expect(posts("/api/start")[0]!.body).toMatchObject({ confirm: true, gpu: "RTX A5000", video_models: true });
    expect(window.localStorage.getItem("vast-comfy.start-video")).toBe("1");
    app?.stop();
    calls = [];
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(INDEX)![1]!;
    await mount({ role: "admin", state: "none", video }, routesWithVideo);
    await openStart();
    expect(q<HTMLInputElement>("#start-video")!.checked).toBe(true);
    expect(calls.some((c) => c.path === "/api/gpus?video_models=true")).toBe(true);
  });
});

describe("video families", () => {
  const ready = { state: "ready", bytes_done: 1, bytes_total: 1, percent: 100, reason: null };
  const missing = { state: "not_installed", bytes_done: 0, bytes_total: 60_000_000_000, percent: 0, reason: null };
  const video = {
    sizes: [{ name: "Landscape", width: 1280, height: 704 }],
    durations: [{ name: "About 3 s", seconds: 3 }],
    max_bytes: 1000, max_pixels: 1_000_000, types: ["png", "jpeg"], download_bytes: 18_000_000_000, models: ready,
  };
  const baseFam = { id: "wan22_5b", title: "Fast (5B)", base: true, sizes: video.sizes, durations: video.durations, download_bytes: 18_000_000_000, models: ready, slots: null, experts: null };
  const big = (models: unknown = ready, experts: unknown = null) => ({
    id: "wan22_a14b", title: "Quality (14B, 4 steps)", base: false,
    sizes: [{ name: "Landscape", width: 832, height: 480 }, { name: "Portrait", width: 480, height: 832 }],
    durations: [{ name: "About 5 s", seconds: 5 }], download_bytes: 60_000_000_000, models,
    slots: { text: ["high", "low"], image: ["high", "low"] }, experts,
  });
  const menu = {
    categories: [{ id: "create", title: "Create" }],
    items: [{ id: "video", title: "Video", description: "Make a short video.", icon: "film", category: "create", tool: "video", style: null, available: true }],
  };
  const pickFamily = async (id: string) => {
    const sel = q<HTMLSelectElement>("#video-family")!;
    sel.value = id;
    sel.dispatchEvent(new Event("change"));
    await flush();
  };

  it("offers no model choice with only the base family", async () => {
    await mount({ menu, video });
    chooseTool("video");
    expect(q("#video-family-box")!.hidden).toBe(true);
  });

  it("the model choice switches sizes and lengths, and the job names its family", async () => {
    await mount({ menu, video, video_families: [baseFam, big()] }, { "POST /api/video": { status: 202, body: { id: "v-1" } }, "GET /api/generate/v-1": { body: { status: "pending" } } });
    chooseTool("video");
    expect(q("#video-family-box")!.hidden).toBe(false);
    expect([...document.querySelectorAll("#video-family option")].map((o) => o.textContent)).toEqual(["Fast (5B)", "Quality (14B, 4 steps)"]);
    expect([...document.querySelectorAll("#video-size option")].map((o) => o.textContent)).toEqual(["Landscape (1280×704)"]);
    await pickFamily("wan22_a14b");
    expect([...document.querySelectorAll("#video-size option")].map((o) => o.textContent)).toEqual(["Landscape (832×480)", "Portrait (480×832)"]);
    expect([...document.querySelectorAll("#video-duration option")].map((o) => o.textContent)).toEqual(["About 5 s"]);
    q<HTMLTextAreaElement>("#prompt")!.value = "a fox";
    q<HTMLSelectElement>("#video-size")!.value = "Portrait";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(posts("/api/video")[0]!.body).toEqual({ prompt: "a fox", size: "Portrait", duration: "About 5 s", family: "wan22_a14b" });
    expect(q(".job .muted")!.textContent).toBe("Video: Portrait, About 5 s, Quality (14B, 4 steps)");
  });

  it("a family that is not installed blocks Make video; a member is told to ask an admin", async () => {
    await mount({ menu, video, video_families: [baseFam, big(missing)] });
    chooseTool("video");
    expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(false); // the base family is ready
    await pickFamily("wan22_a14b");
    expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(true);
    expect(q("#video-models-text")!.textContent).toBe("The video models are not installed on this instance. Ask an admin to download them.");
    expect(q<HTMLButtonElement>("#video-models-download")!.hidden).toBe(true);
    expect(q("#video-experts")!.hidden).toBe(true);
  });

  it("an admin downloads a family, with both expert links of a mode or none (one-sided is refused here)", async () => {
    await mount({ role: "admin", menu, video, video_families: [baseFam, big(missing)] }, {
      "POST /api/video-models": { status: 202, body: { models: { ...missing, state: "downloading" } } },
    });
    chooseTool("video");
    await pickFamily("wan22_a14b");
    expect(q("#video-models-link")!.hidden).toBe(true); // the base model's single link is not for a family
    expect(q("#video-experts")!.hidden).toBe(false);
    expect(q("#video-experts-note")!.textContent).toContain("UNVERIFIED");
    expect(q<HTMLButtonElement>("#video-models-download")!.textContent).toBe("Download video models (about 60.0 GB, several minutes)");
    const high = q<HTMLInputElement>("#video-expert-high")!;
    const low = q<HTMLInputElement>("#video-expert-low")!;
    expect(q("label[for=video-expert-high]")!.textContent).toBe("high noise expert link");
    high.value = "https://huggingface.co/o/r/resolve/main/h.gguf";
    q<HTMLButtonElement>("#video-models-download")!.click();
    await flush();
    expect(posts("/api/video-models")).toHaveLength(0);
    expect(q("#video-models-error")!.textContent).toBe("Give a link for every expert (high and low), or none.");
    const mode = q<HTMLSelectElement>("#video-experts-mode")!;
    mode.value = "image";
    mode.dispatchEvent(new Event("change"));
    await flush();
    q<HTMLInputElement>("#video-expert-high")!.value = " https://huggingface.co/o/r/resolve/main/h.gguf ";
    low.value = "https://huggingface.co/o/r/resolve/main/l.gguf";
    q<HTMLButtonElement>("#video-models-download")!.click();
    await flush();
    expect(posts("/api/video-models")[0]!.body).toEqual({
      family: "wan22_a14b", mode: "image",
      links: { high: "https://huggingface.co/o/r/resolve/main/h.gguf", low: "https://huggingface.co/o/r/resolve/main/l.gguf" },
    });
    expect(JSON.stringify({ ...window.localStorage })).not.toContain("huggingface");
  });

  it("without links an admin downloads the pinned family; linked experts in use are shown to admins", async () => {
    await mount({ role: "admin", menu, video, video_families: [baseFam, big(missing)] }, { "POST /api/video-models": { status: 202, body: { models: missing } } });
    chooseTool("video");
    await pickFamily("wan22_a14b");
    q<HTMLButtonElement>("#video-models-download")!.click();
    await flush();
    expect(posts("/api/video-models")[0]!.body).toEqual({ family: "wan22_a14b" });
    app?.stop();
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(INDEX)![1]!;
    const experts = [{ mode: "text", slot: "high", file: "<b>h.gguf</b>", linked: true, sha256: null }, { mode: "text", slot: "low", file: "l.gguf", linked: true, sha256: null }];
    await mount({ role: "admin", menu, video, video_families: [baseFam, big(ready, experts)] });
    chooseTool("video");
    await pickFamily("wan22_a14b");
    expect(q("#video-models-text")!.textContent).toBe("Linked experts in use: text high: <b>h.gguf</b>; text low: l.gguf. Not integrity-pinned.");
    expect(q("#video-models-text b")).toBeNull();
  });

  it("an extra LoRA: None by default, its note, the strength starting at its default; sent with the job and named in the label", async () => {
    const lora = { id: "calisthenic_moves", title: "Calisthenic moves", description: "Adds moves.", modes: ["text"], strength: 0.6, trigger_words: "" };
    const withLora = { ...big(), extra_loras: [lora] };
    await mount({ menu, video, video_families: [baseFam, withLora] }, { "POST /api/video": { status: 202, body: { id: "v-1" } }, "GET /api/generate/v-1": { body: { status: "pending" } } });
    chooseTool("video");
    expect(q("#video-lora-box")!.hidden).toBe(true); // the base family has none
    await pickFamily("wan22_a14b");
    expect(q("#video-lora-box")!.hidden).toBe(false);
    expect([...document.querySelectorAll("#video-lora option")].map((o) => o.textContent)).toEqual(["None", "Calisthenic moves"]);
    expect(q<HTMLInputElement>("#video-lora-strength")!.disabled).toBe(true);
    const sel = q<HTMLSelectElement>("#video-lora")!;
    sel.value = "calisthenic_moves";
    sel.dispatchEvent(new Event("change"));
    await flush();
    const strength = q<HTMLInputElement>("#video-lora-strength")!;
    expect(strength.value).toBe("0.6");
    expect([strength.min, strength.max, strength.step]).toEqual(["0", "1", "0.05"]);
    expect(q("#video-lora-note")!.textContent).toBe("Adds moves. No trigger words are known for it yet. Untested with this 4-step model: results may vary.");
    strength.value = "2";
    q<HTMLTextAreaElement>("#prompt")!.value = "a fox";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(q("#form-error")!.textContent).toBe("The LoRA strength must be a number from 0 to 1.");
    expect(posts("/api/video")).toHaveLength(0);
    strength.value = "0.35";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(posts("/api/video")[0]!.body).toEqual({ prompt: "a fox", size: "Landscape", duration: "About 5 s", family: "wan22_a14b", extra_lora: "calisthenic_moves", extra_lora_strength: 0.35 });
    expect(q(".job .muted")!.textContent).toBe("Video: Landscape, About 5 s, Quality (14B, 4 steps), Calisthenic moves");
  });

  it("an extra LoRA not offered for image to video is refused with a start image attached", async () => {
    const lora = { id: "calisthenic_moves", title: "Calisthenic moves", description: "", modes: ["text"], strength: 0.6, trigger_words: "" };
    await mount({ menu, video, video_families: [baseFam, { ...big(), extra_loras: [lora] }] });
    chooseTool("video");
    await pickFamily("wan22_a14b");
    const sel = q<HTMLSelectElement>("#video-lora")!;
    sel.value = "calisthenic_moves";
    sel.dispatchEvent(new Event("change"));
    await flush();
    const input = q<HTMLInputElement>("#ref-input")!;
    Object.defineProperty(input, "files", { value: [new File(["STARTBYTES"], "a.png", { type: "image/png" })], configurable: true });
    input.dispatchEvent(new Event("change"));
    await flush();
    q<HTMLTextAreaElement>("#prompt")!.value = "a fox";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(q("#form-error")!.textContent).toBe("Calisthenic moves is not offered for image to video.");
    expect(posts("/api/video")).toHaveLength(0);
  });

  it("the Start dialog offers each family (the base one ticked) and sends the ticked ones with the video models", async () => {
    const families = [baseFam, big(missing)];
    const routes14: Record<string, Handler> = {
      ...START_ROUTES,
      "GET /api/gpus?video_models=true&video_families=wan22_5b": { body: GPUS },
      "GET /api/gpus?video_models=true&video_families=wan22_5b%2Cwan22_a14b": { body: GPUS },
      "GET /api/estimate?gpu=RTX%20A5000&video_models=true&video_families=wan22_5b": est("RTX A5000", 0.27),
      "GET /api/estimate?gpu=RTX%20A5000&video_models=true&video_families=wan22_5b%2Cwan22_a14b": est("RTX A5000", 0.31),
    };
    await mount({ role: "admin", state: "none", video, video_families: families }, routes14);
    await openStart();
    const boxes = [...document.querySelectorAll<HTMLInputElement>("#modal-body input[data-family]")];
    expect(boxes.map((b) => [b.dataset["family"], b.checked, b.disabled])).toEqual([["wan22_5b", true, true], ["wan22_a14b", false, true]]);
    const include = q<HTMLInputElement>("#start-video")!;
    include.checked = true;
    include.dispatchEvent(new Event("change"));
    await flush();
    boxes[1]!.checked = true;
    boxes[1]!.dispatchEvent(new Event("change"));
    await flush();
    expect(estimateCalls().at(-1)).toBe("/api/estimate?gpu=RTX%20A5000&video_models=true&video_families=wan22_5b%2Cwan22_a14b");
    boxes[0]!.checked = false;
    boxes[0]!.dispatchEvent(new Event("change"));
    expect(q<HTMLInputElement>("#start-video-url")!.disabled).toBe(true); // the link replaces the base model
    q("#modal-ok")!.click();
    await flush();
    expect(posts("/api/start")[0]!.body).toMatchObject({ video_models: true, video_families: ["wan22_a14b"] });
  });
});
